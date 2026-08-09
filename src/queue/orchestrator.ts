import * as vscode from 'vscode';
import {
  AgentRunError,
  CommandResult,
  executeTask,
  runVerifyCommand,
  superviseTask,
  SupervisorDecision,
} from './agents';
import { Task, TaskQueue } from './db';

/**
 * The cron engine.
 *
 * Two independent pumps share the database and never talk to each other:
 *
 *   execution pump   claims one PENDING task, runs a throwaway worker on it,
 *                    writes the result back, and stops. Spawning the next
 *                    worker is a fresh process with a fresh context window.
 *
 *   supervision pump fires on the cron interval, inspects everything sitting in
 *                    VERIFYING, and rules on it. It owns every transition out
 *                    of VERIFYING, including rolling the queue backwards.
 *
 * Neither pump holds state between ticks — if the window reloads mid-run, the
 * database still knows exactly what was happening, and `requeueStale` recovers
 * whatever was orphaned.
 */

export type RunMode = 'lockstep' | 'continuous';

export interface OrchestratorStatus {
  running: boolean;
  executing: boolean;
  supervising: boolean;
  currentTaskId: number | null;
  nextTickAt: number | null;
  intervalMs: number;
  /** True when the interval above is this queue's own, not the global setting. */
  intervalOwn: boolean;
  /** What the global setting says, so the UI can label the inherit option. */
  settingIntervalSeconds: number;
  mode: RunMode;
}

export class Orchestrator implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private executing = false;
  private supervising = false;
  private currentTaskId: number | null = null;
  private nextTickAt: number | null = null;
  private disposed = false;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the queue or run state moves, so the UI can re-render. */
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly queue: TaskQueue,
  ) {}

  // ---- configuration ---------------------------------------------------

  private cfg<T>(key: string, fallback: T): T {
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

  private get workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  status(): OrchestratorStatus {
    return {
      running: this.queue.runState === 'RUNNING',
      executing: this.executing,
      supervising: this.supervising,
      currentTaskId: this.currentTaskId,
      nextTickAt: this.nextTickAt,
      intervalMs: this.intervalMs,
      intervalOwn: this.queue.cronIntervalSeconds > 0,
      settingIntervalSeconds: this.settingIntervalSeconds,
      mode: this.mode,
    };
  }

  private changed(): void {
    this._onDidChange.fire();
  }

  private log(msg: string): void {
    this.output.appendLine(`[queue] ${msg}`);
  }

  // ---- controls --------------------------------------------------------

  start(): void {
    if (this.queue.runState === 'RUNNING' && this.timer) {
      return;
    }
    // Anything left EXECUTING belongs to a process that no longer exists.
    const recovered = this.queue.requeueStale(0);
    if (recovered > 0) {
      this.log(`recovered ${recovered} orphaned task(s) from a previous session`);
    }
    if (this.queue.runState === 'PAUSED') {
      this.queue.resumePaused();
    } else {
      this.queue.setRunState('RUNNING');
    }

    this.arm();
    this.changed();
    this.log(`started — cron every ${Math.round(this.intervalMs / 1000)}s, mode ${this.mode}`);
    void this.pump();
  }

  stop(): void {
    this.disarm();
    this.queue.setRunState('STOPPED');
    this.changed();
    this.log('stopped');
  }

  pause(): void {
    this.disarm();
    this.queue.pauseOpen();
    this.changed();
    this.log('paused');
  }

  reset(): void {
    this.disarm();
    this.queue.resetAll();
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

  private arm(): void {
    this.disarm();
    const ms = this.intervalMs;
    this.nextTickAt = Date.now() + ms;
    this.timer = setInterval(() => void this.tick(), ms);
  }

  private disarm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.nextTickAt = null;
  }

  // ---- the cron tick ---------------------------------------------------

  /** One supervision cycle. Skips itself if the previous one is still running. */
  private async tick(): Promise<void> {
    this.nextTickAt = Date.now() + this.intervalMs;
    if (this.disposed || this.queue.runState !== 'RUNNING') {
      return;
    }
    if (this.supervising) {
      this.log('supervisor still busy; skipping this tick');
      return;
    }

    this.supervising = true;
    this.changed();
    try {
      const pending = this.queue.awaitingVerification();
      for (const task of pending) {
        if (this.disposed || this.queue.runState !== 'RUNNING') {
          break;
        }
        await this.supervise(task);
      }

      if (this.queue.isComplete()) {
        this.finish();
        return;
      }
    } catch (e: any) {
      this.log(`supervision cycle failed: ${e?.message ?? e}`);
    } finally {
      this.supervising = false;
      this.changed();
    }

    // The supervisor decides when the next worker starts.
    void this.pump();
  }

  /** Runs the full verification pass for one task and applies the verdict. */
  private async supervise(task: Task): Promise<void> {
    this.log(`supervising task ${task.seq} — ${task.title}`);

    let check: CommandResult = { ran: false, code: null, output: '' };
    if (task.solutionVerifyCommand) {
      const budget = this.cfg<number>('queue.verifyCommandTimeoutSeconds', 300) * 1000;
      check = runVerifyCommand(task.solutionVerifyCommand, this.workspaceRoot, budget);
      this.queue.log(
        task.id,
        'supervisor',
        'verify-command',
        `exit ${check.code}: ${check.output.slice(0, 2000)}`,
      );
    }

    let decision: SupervisorDecision;
    try {
      decision = await superviseTask(this.context, this.output, task, check);
    } catch (e: any) {
      this.log(`supervisor failed on task ${task.seq}: ${e?.message ?? e}`);
      this.queue.log(task.id, 'supervisor', 'error', String(e?.message ?? e));
      // Leave it in VERIFYING; the next tick tries again.
      return;
    }

    this.queue.log(task.id, 'supervisor', `verdict:${decision.verdict}`, decision.feedback);
    this.applyTaskEdits(decision);

    switch (decision.verdict) {
      case 'VERIFIED':
        this.queue.update(task.id, {
          status: 'VERIFIED',
          supervisorFeedback: decision.feedback,
          finishedAt: Date.now(),
        });
        this.log(`task ${task.seq} VERIFIED`);
        break;

      case 'SPLIT': {
        // The parts inherit this task's place in the queue, so the run carries
        // on from here instead of restarting the work that already landed.
        const n = this.queue.splitTask(task.id, decision.splitInto ?? []);
        if (n === 0) {
          // Nothing usable came back; treat it as the retry it amounts to
          // rather than leaving the task stuck in VERIFYING forever.
          this.queue.update(task.id, { status: 'PENDING', supervisorFeedback: decision.feedback });
          this.log(`task ${task.seq} split produced no usable parts; retrying instead`);
          break;
        }
        this.log(`task ${task.seq} was too big — split into ${n} task(s)`);
        break;
      }

      case 'RESET_FROM': {
        const from = decision.resetFromSeq ?? task.seq;
        const n = this.queue.resetFrom(from, decision.feedback);
        this.log(`rolling back to task ${from} (${n} task(s) reset)`);
        break;
      }

      case 'FAIL':
        this.queue.update(task.id, {
          status: 'FAILED',
          supervisorFeedback: decision.feedback,
          finishedAt: Date.now(),
        });
        this.queue.setRunState('STOPPED');
        this.disarm();
        this.log(`task ${task.seq} FAILED — queue stopped`);
        break;

      case 'RETRY':
      default: {
        const exhausted = task.attempts >= task.maxAttempts;
        this.queue.update(task.id, {
          status: exhausted ? 'FAILED' : 'PENDING',
          supervisorFeedback: decision.feedback,
          errorLog: `${task.errorLog}\n[attempt ${task.attempts}] ${decision.feedback}`.trim(),
          finishedAt: exhausted ? Date.now() : null,
        });
        this.log(
          exhausted
            ? `task ${task.seq} FAILED after ${task.attempts} attempt(s)`
            : `task ${task.seq} back to PENDING for another attempt`,
        );
        break;
      }
    }
    this.changed();
  }

  /** The supervisor may rewrite tasks it has not reached yet. */
  private applyTaskEdits(decision: SupervisorDecision): void {
    for (const edit of decision.taskEdits ?? []) {
      const target = this.queue.list().find((t) => t.seq === edit.seq);
      if (!target || target.status === 'VERIFIED') {
        continue;
      }
      this.queue.update(target.id, {
        description: edit.description ?? target.description,
        solutionVerifyCommand: edit.solutionVerifyCommand ?? target.solutionVerifyCommand,
      });
      this.queue.log(target.id, 'supervisor', 'task-edited', `seq ${edit.seq} rewritten`);
      this.log(`supervisor rewrote task ${edit.seq}`);
    }
  }

  // ---- the execution pump ----------------------------------------------

  /**
   * Starts a worker on the next PENDING task, if one should start now.
   *
   * In lockstep mode nothing starts while a task is awaiting verification, so
   * task N+1 is never built on top of unverified task N. Continuous mode lets
   * the queue run ahead and the supervisor audit behind it.
   */
  private async pump(): Promise<void> {
    if (this.disposed || this.executing || this.queue.runState !== 'RUNNING') {
      return;
    }
    if (this.mode === 'lockstep' && this.queue.awaitingVerification().length > 0) {
      return;
    }
    // A failed task must stop the whole run — never claim the next one.
    if (this.queue.anyFailed()) {
      this.queue.setRunState('STOPPED');
      this.log('stopped — a task is FAILED; no further tasks will start');
      this.changed();
      return;
    }

    const task = this.queue.claimNext();
    if (!task) {
      if (this.queue.isComplete()) {
        this.finish();
      }
      return;
    }

    this.executing = true;
    this.currentTaskId = task.id;
    this.changed();
    this.log(`executing task ${task.seq} — ${task.title} (attempt ${task.attempts})`);

    try {
      const res = await executeTask(this.context, this.output, task);

      // A cut-off worker reports partial progress, not a finished task. Record
      // that in the error log: the retry prompt feeds it back, so the next
      // attempt continues from what was built instead of starting over. Which
      // budget ran out matters to the supervisor — being cut off twice is the
      // signal that the task is too big and should be split rather than retried.
      const ranOut =
        res.stopReason === 'max_duration'
          ? `its ${res.budgetMinutes}-minute budget`
          : `its ${res.rounds} tool-calling rounds`;
      const cutOffNote = res.cutOff
        ? `${task.errorLog}\n[attempt ${task.attempts}] cut off — ran out of ${ranOut}. ` +
          `The report is partial progress, not a finished task.`
        : undefined;

      this.queue.update(task.id, {
        status: 'VERIFYING',
        output: res.text,
        ...(cutOffNote ? { errorLog: cutOffNote.trim() } : {}),
      });
      this.queue.log(
        task.id,
        'executor',
        res.cutOff ? 'cut-off' : 'completed',
        res.text.slice(0, 4000),
      );
      this.log(
        res.cutOff
          ? `task ${task.seq} cut off — ran out of ${ranOut}; awaiting supervision`
          : `task ${task.seq} done; awaiting supervision`,
      );
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const timedOut = e instanceof AgentRunError && e.timedOut;

      if (timedOut) {
        // The core is supposed to stop and report before this fires, so getting
        // here means the worker was killed mid-turn — but its edits are still on
        // disk. Send it to the supervisor, which verifies by reading the
        // workspace rather than by trusting a report: bouncing it straight back
        // to PENDING spends another whole attempt with no idea what the last one
        // built, which is how three attempts produce nothing.
        this.queue.update(task.id, {
          status: 'VERIFYING',
          output: '',
          errorLog:
            `${task.errorLog}\n[attempt ${task.attempts}] ${msg}, and was killed mid-turn ` +
            `before it could report. Whatever it changed is still on disk — read the files ` +
            `rather than assuming nothing happened.`.trim(),
        });
        this.queue.log(task.id, 'executor', 'timeout', msg);
        this.log(`task ${task.seq} timed out with no report; awaiting supervision`);
      } else {
        const exhausted = task.attempts >= task.maxAttempts;
        this.queue.update(task.id, {
          status: exhausted ? 'FAILED' : 'PENDING',
          errorLog: `${task.errorLog}\n[attempt ${task.attempts}] worker error: ${msg}`.trim(),
          finishedAt: exhausted ? Date.now() : null,
        });
        this.queue.log(task.id, 'executor', 'error', msg);
        this.log(`task ${task.seq} errored: ${msg}`);
      }
    } finally {
      this.executing = false;
      this.currentTaskId = null;
      this.changed();
    }

    // Stop right here if the executor exhausted this task to FAILED.
    if (this.queue.anyFailed()) {
      this.queue.setRunState('STOPPED');
      this.log('stopped — the task reached FAILED; no further tasks will start');
      return;
    }

    // Continuous mode keeps going without waiting for the cron.
    if (this.mode === 'continuous') {
      void this.pump();
    }
  }

  /** Runs one supervision cycle now instead of waiting for the next tick. */
  async runNow(): Promise<void> {
    await this.tick();
  }

  private finish(): void {
    this.disarm();
    this.queue.setRunState('IDLE');
    this.changed();

    const s = this.queue.stats();
    const failed = s.byStatus.FAILED;
    this.log(`run complete — ${s.byStatus.VERIFIED} verified, ${failed} failed`);
    void vscode.window.showInformationMessage(
      failed > 0
        ? `MF Agent queue finished: ${s.byStatus.VERIFIED} verified, ${failed} failed.`
        : `MF Agent queue finished: all ${s.byStatus.VERIFIED} tasks verified.`,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
    this._onDidChange.dispose();
  }
}
