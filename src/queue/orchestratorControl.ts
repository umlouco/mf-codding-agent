import * as cp from 'child_process';
import * as vscode from 'vscode';
import { QueueStats } from './db';
import { OrchestratorState, OrchestratorStatus, RunMode, WATCHDOG_MS } from './orchestratorState';
import { recoveryKey, resumeRecovery } from './recovery';
import { restoreScopedContracts } from './scopeContract';
import { hasOutstandingRecovery, recoveryJobKey } from './recoverySchedule';
import { requiresDecomposition } from './recoveryDecomposition';

export abstract class OrchestratorControl extends OrchestratorState {
  private ownedWork?: Set<Promise<void>>;

  // ---- configuration ---------------------------------------------------

  protected cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('mfagent').get<T>(key, fallback);
  }

  /** What `settings.json` asks for, when the queue has no interval of its own. */
  get settingIntervalSeconds(): number {
    return Math.max(10, this.cfg<number>('queue.cronIntervalSeconds', 60));
  }

  get intervalMs(): number {
    const own = this.queue.cronIntervalSeconds;
    return (own > 0 ? own : this.settingIntervalSeconds) * 1000;
  }

  /**
   * Sets this queue's supervisor interval and re-arms the cron immediately, so
   * a slower pace takes effect without waiting out the tick you are shortening.
   * Pass 0 to fall back to the global setting.
   */
  setCronInterval(seconds: number): void {
    this.queue.setCronIntervalSeconds(seconds);
    this.log(
      `supervisor interval → ${Math.round(this.intervalMs / 1000)}s` +
        (this.queue.cronIntervalSeconds > 0 ? ' (this queue)' : ' (from settings)'),
    );
    this.reschedule();
    this.changed();
  }

  get mode(): RunMode {
    return this.cfg<RunMode>('queue.mode', 'lockstep');
  }

  protected get workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  status(): OrchestratorStatus {
    // "Is a worker doing useful work" is answered by reading the row
    // claimNext wrote, not by a flag mirrored here — see activeTask.
    const active = this.queue.activeTask();
    return {
      running: this.queue.runState === 'RUNNING',
      executing: !!active,
      supervising: this.supervising,
      currentTaskId: active?.id ?? null,
      nextTickAt: this.nextTickAt,
      intervalMs: this.intervalMs,
      intervalOwn: this.queue.cronIntervalSeconds > 0,
      settingIntervalSeconds: this.settingIntervalSeconds,
      mode: this.mode,
    };
  }

  protected changed(): void {
    this._onDidChange.fire();
  }

  protected log(msg: string): void {
    this.output.appendLine(`[queue] ${msg}`);
  }

  /**
   * Runs work launched by a timer without creating an unhandled rejection.
   *
   * The cron and watchdog are deliberately fire-and-forget: the extension
   * host must keep serving the editor while a model turn is in flight. A
   * rejected promise from one of those callbacks used to be invisible to the
   * queue and could leave the UI showing RUNNING with no useful work. Keep the
   * timer alive and leave a durable breadcrumb in the output channel instead.
   */
  protected schedule(label: string, work: () => void | Promise<void>): void {
    try {
      const result = work();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        const pending = (result as Promise<void>).catch((error: any) => {
          this.log(`${label} failed: ${error?.message ?? error}`);
        }).finally(() => this.ownedWork?.delete(pending));
        (this.ownedWork ??= new Set()).add(pending);
      }
    } catch (error: any) {
      this.log(`${label} failed: ${error?.message ?? error}`);
    }
  }

  /** Call after dispose to keep storage alive until cancelled turns settle. */
  async drain(): Promise<void> {
    while (this.ownedWork?.size) await Promise.allSettled([...this.ownedWork]);
  }

  // ---- controls --------------------------------------------------------

  /**
   * Recovers tasks left EXECUTING by a process that no longer exists —
   * a crashed core, or a window that reloaded mid-run. Called from `start()`
   * and also directly on activation, before the run may even be RUNNING, so
   * a workspace that was left orphaned is fixed before anyone reads it.
   *
   * Escalates rather than requeuing: this is the actual crash-recovery moment,
   * and a worker that died before writing anything is the one failure the
   * supervisor cannot otherwise see. It goes to VERIFYING with no report, which
   * the tick reads as "review this from the journal" — see requeueStale.
   */
  recoverOrphaned(): number {
    const recovered = this.queue.requeueStale(0, true);
    if (recovered > 0) {
      this.log(`recovered ${recovered} orphaned task(s) from a previous session`);
    }
    return recovered;
  }

  start(): void {
    if (this.queue.runState === 'RUNNING' && this.timer) {
      return;
    }
    // Activation/configuration restoration calls start only for RUNNING queues.
    // Explicit Start resumes operator controls. Legacy pauses become scheduled
    // recovery; new recovery deadlines and failure histories are never reset.
    if (this.queue.runState !== 'RUNNING') {
      const restored = restoreScopedContracts(this.queue);
      if (restored) this.log(`restored ${restored} admitted local contract(s) expanded by earlier supervisor rewrites`);
      for (const task of this.queue.list()) {
        if (requiresDecomposition(task)) continue;
        if (resumeRecovery(this.queue, task)) this.reviewed.delete(task.id);
      }
    }
    // Anything left EXECUTING belongs to a process that no longer exists.
    this.recoverOrphaned();
    this.rollbacks = 0;
    if (this.queue.runState === 'PAUSED') {
      this.queue.resumePaused();
    } else {
      this.queue.setRunState('RUNNING');
    }

    this.arm();
    // Deliberately not cleared by stop or pause: those set the run state, and
    // the watchdog reads the run state, so leaving it running costs one cheap
    // query a minute and means no code path can switch the safety net off.
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.schedule('watchdog check', () => this.kick()), WATCHDOG_MS);
    }
    this.changed();
    this.log(`started — cron every ${Math.round(this.intervalMs / 1000)}s, mode ${this.mode}`);
    // A task already waiting on the supervisor should not sit out a whole
    // interval before the first tick — a start is the one moment nobody minds
    // a review running straight away, and in lockstep nothing else can move
    // until it has. The tick pumps for itself when it ends, so it replaces
    // the pump below rather than doubling it.
    //
    // Deferred, not inline: start() also runs from activation, when a run
    // was in progress before the window reloaded, and a review builds its
    // prompt synchronously before the first await. Whatever that costs, it
    // must be paid after activate() has returned, not inside it.
    if (this.queue.awaitingVerification().length > 0) {
      setTimeout(() => {
        this.schedule('initial supervisor check', () => {
          if (!this.disposed && this.queue.runState === 'RUNNING') return this.tick();
          return Promise.resolve();
        });
      }, 1000);
      return;
    }
    this.schedule('initial execution pump', () => this.pump());
  }

  stop(): void {
    this.disarm();
    // A review or an execution still in flight would otherwise keep running
    // in the background after the queue claims to be stopped — see
    // abandonReview and abandonExecution.
    this.abandonReview();
    this.abandonExecution();
    this.queue.setRunState('STOPPED');
    this.changed();
    this.log('stopped');
  }

  pause(): void {
    this.disarm();
    this.abandonReview();
    this.abandonExecution();
    this.queue.pauseOpen();
    this.changed();
    this.log('paused');
  }

  reset(): void {
    this.disarm();
    this.abandonReview();
    this.abandonExecution();
    this.queue.resetAll();
    for (const task of this.queue.list()) {
      this.queue.setMeta(recoveryKey(task), '');
      this.queue.setMeta(recoveryJobKey(task), '');
    }
    // resetAll zeroes `attempts`, so a stale entry here would read as a review
    // of the attempt about to start rather than of the run just thrown away.
    this.reviewed.clear();
    this.changed();
    this.log('reset — every task back to PENDING');
  }

  /** Re-arms the cron after a settings change without disturbing the run. */
  reschedule(): void {
    if (this.queue.runState === 'RUNNING') {
      this.arm();
      this.changed();
    }
  }

  protected arm(): void {
    this.disarm();
    const ms = this.intervalMs;
    this.nextTickAt = Date.now() + ms;
    this.timer = setInterval(() => this.schedule('cron supervisor check', () => this.tick()), ms);
  }

  protected disarm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.nextTickAt = null;
  }

  /** Runs one supervision cycle now instead of waiting for the next tick. */
  async runNow(): Promise<void> {
    await this.tick();
  }

  protected finish(): void {
    if (!this.queue.isComplete() || hasOutstandingRecovery(this.queue)) return;
    this.disarm();
    this.queue.setRunState('IDLE');
    this.changed();

    const s = this.queue.stats();
    this.log(`run complete — ${s.byStatus.VERIFIED} verified`);
    void vscode.window.showInformationMessage(
      `MF Agent queue finished: ${s.byStatus.VERIFIED} tasks verified.`,
    );
    this.notify('finished', s);
  }

  /**
   * Runs the user's notify command, if any, with a JSON summary as its one
   * argument — modelled on Codex's `notify` hook, for the same reason: an
   * unattended run this long-lived has nobody watching the editor when it
   * finally finishes, and the in-editor toast above is silent to them.
   *
   * Best-effort and never awaited: a broken or slow notify command must not
   * hold up the queue, which is exactly the thing this run was trying not to
   * need a babysitter for.
   */
  protected notify(event: string, stats: QueueStats): void {
    const command = this.cfg<string>('queue.notifyCommand', '').trim();
    if (!command) {
      return;
    }
    const payload = JSON.stringify({
      event,
      workspaceRoot: this.workspaceRoot,
      verified: stats.byStatus.VERIFIED,
      total: stats.total,
      usage: stats.usage,
      at: Date.now(),
    });
    try {
      const child = cp.spawn(command, [payload], {
        shell: true,
        windowsHide: true,
        stdio: 'ignore',
        cwd: this.workspaceRoot,
      });
      child.on('error', (e) => this.log(`notify command failed to start: ${e.message}`));
      child.unref();
    } catch (e: any) {
      this.log(`notify command failed: ${e?.message ?? e}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.abandonReview();
    this.abandonExecution();
    this._onDidChange.dispose();
  }
}
