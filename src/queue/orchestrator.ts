import * as vscode from 'vscode';
import {
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

/** A supervision turn in flight, and everything needed to give up on it. */
interface Review {
  taskId: number;
  seq: number;
  /** Bumped for every review; a superseded one's verdict is discarded. */
  gen: number;
  /** Last time this review's core said anything — its liveness, as above. */
  lastActivityAt: number;
  /** Kills the core process, which rejects the request wedged on it. */
  abort?: () => void;
}

/** How often the watchdog asks whether the run is actually moving. */
const WATCHDOG_MS = 60_000;

/**
 * Attempts kept in a task's error log.
 *
 * With no attempt ceiling this is the only thing bounding the column. A task
 * that has been retried forty times has thirty-six entries nobody will read and
 * one the next executor needs, and the row is written back on every attempt.
 */
const KEEP_ATTEMPTS = 6;

/**
 * Appends one attempt's note, keeping only the recent ones.
 *
 * Entries are delimited by the `[attempt N]` prefix every writer uses, so this
 * splits on the same boundary `attemptHistory` reads back.
 */
function appendAttempt(log: string, entry: string): string {
  const all = `${log}\n${entry}`
    .split(/\n(?=\[(?:attempt \d+|recovered)\])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return all.slice(-KEEP_ATTEMPTS).join('\n');
}

export class Orchestrator implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  /** Rollbacks taken this run — see the RESET_FROM branch. */
  private rollbacks = 0;
  private executing = false;
  private supervising = false;
  private review: Review | null = null;
  private reviewGen = 0;
  /** Which supervision cycle owns `supervising`; see tick and sweepSilentReview. */
  private cycle = 0;
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
    const revived = this.queue.reviveFailed();
    if (revived > 0) {
      this.log(`returned ${revived} task(s) retired by an earlier run to the queue`);
    }
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
      this.watchdog = setInterval(() => this.kick(), WATCHDOG_MS);
    }
    this.changed();
    this.log(`started — cron every ${Math.round(this.intervalMs / 1000)}s, mode ${this.mode}`);
    void this.pump();
  }

  stop(): void {
    this.disarm();
    // A review still in flight would otherwise hold `supervising` past the next
    // start, and the run would come back up already blocked.
    this.abandonReview();
    this.queue.setRunState('STOPPED');
    this.changed();
    this.log('stopped');
  }

  pause(): void {
    this.disarm();
    this.abandonReview();
    this.queue.pauseOpen();
    this.changed();
    this.log('paused');
  }

  reset(): void {
    this.disarm();
    this.abandonReview();
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

  /**
   * One supervision cycle. Skips itself if the previous one is still running.
   *
   * A cycle can also be *superseded*: `sweepSilentReview` hands ownership to the
   * next tick while this one is still parked on a turn that will never answer.
   * Everything below therefore checks `this.cycle` before acting, so an
   * abandoned cycle that finally wakes up cannot supervise a second task,
   * declare the run finished, or take the flag back off its successor.
   */
  private async tick(): Promise<void> {
    this.nextTickAt = Date.now() + this.intervalMs;
    if (this.disposed || this.queue.runState !== 'RUNNING') {
      return;
    }
    // Before the busy check, never after: a review that has gone silent is the
    // reason the busy check would be true, so testing it second means never
    // testing it at all.
    this.sweepSilentReview();
    if (this.supervising) {
      this.log('supervisor still busy; skipping this tick');
      return;
    }

    const cycle = ++this.cycle;
    this.supervising = true;
    this.changed();
    try {
      this.sweepSilentWorkers();

      const pending = this.queue.awaitingVerification();
      for (const task of pending) {
        if (this.disposed || this.queue.runState !== 'RUNNING' || this.cycle !== cycle) {
          break;
        }
        await this.supervise(task);
      }

      if (this.cycle === cycle && this.queue.isComplete()) {
        this.finish();
        return;
      }
    } catch (e: any) {
      this.log(`supervision cycle failed: ${e?.message ?? e}`);
    } finally {
      if (this.cycle === cycle) {
        this.supervising = false;
        this.changed();
      }
    }

    if (this.cycle !== cycle) {
      return;
    }
    // The supervisor decides when the next worker starts.
    void this.pump();
  }

  /**
   * Finds workers that have gone quiet and stops pretending they are running.
   *
   * This is the whole of the "is it stuck" test, and it deliberately says
   * nothing about how long the task has taken. A worker on a slow local model
   * writes an activity record every half minute while it waits, and writes
   * again through a build that takes an hour, so any task that has been silent
   * for longer than that window is not slow — its process is gone.
   *
   * Erring long is cheap here. A live worker that is merely between records
   * gets picked up on the next tick; a dead one waited a few extra minutes to
   * be noticed. The reverse mistake, deciding a working agent is dead, is the
   * one that throws away hours of work.
   */
  private get silentMs(): number {
    return Math.max(1, this.cfg<number>('queue.workerSilentMinutes', 10)) * 60_000;
  }

  /**
   * The same test as sweepSilentWorkers, applied to the supervisor.
   *
   * A review is a turn against a model like any other and wedges the same way,
   * but it is not a row in the queue — it is one in-flight promise plus the
   * `supervising` flag guarding the tick. So when a review's core goes silent,
   * nothing above notices: the flag stays set, every later tick skips itself,
   * and the task sits in VERIFYING for as long as the window stays open. That
   * is not a slow supervisor, it is a run that has stopped.
   *
   * Recovery is to kill the core, which rejects the request waiting on it and
   * lets `supervise` finish and log. The flag is released here rather than
   * waiting for that, because a process that ignores its stdin may well ignore
   * its own death too, and the whole point is not to be held hostage by it. The
   * generation counter is what keeps a late verdict from that turn out of the
   * database.
   */
  private sweepSilentReview(): void {
    const r = this.review;
    if (!this.supervising || !r) {
      return;
    }
    const quiet = Date.now() - r.lastActivityAt;
    if (quiet < this.silentMs) {
      return;
    }

    const note = `the supervisor went silent for ${Math.round(quiet / 60_000)} minute(s)`;
    this.queue.log(r.taskId, 'supervisor', 'silent', `${note}; abandoning the review`);
    this.log(`task ${r.seq} — ${note}; abandoning the review and retrying next tick`);
    // The task stays in VERIFYING on purpose: nothing was judged, so the next
    // tick reviews it again from scratch.
    this.abandonReview();
    this.changed();
  }

  /**
   * Drops the review in flight and frees the tick parked on it.
   *
   * Both counters move: the cycle so the abandoned tick cannot resume as if it
   * still owned the run, the review generation so a verdict that arrives after
   * this point is discarded rather than written.
   */
  private abandonReview(): void {
    const r = this.review;
    this.review = null;
    this.reviewGen++;
    this.cycle++;
    this.supervising = false;
    try {
      r?.abort?.();
    } catch {
      /* the core was already gone; releasing the tick is what mattered */
    }
  }

  private sweepSilentWorkers(): void {
    const silentMs = this.silentMs;
    for (const task of this.queue.silentWorkers(silentMs)) {
      const quiet = Math.round((Date.now() - (task.lastActivityAt ?? task.startedAt ?? 0)) / 60_000);
      const note =
        `the worker went silent for ${quiet} minute(s) while ${task.activityPhase || 'starting up'}` +
        (task.activityDetail ? ` (${task.activityDetail})` : '');

      // Straight back to PENDING rather than to the supervisor: unlike a worker
      // that died with a message, this one never said goodbye, and there is no
      // report to judge. The journal is still there for the next attempt. A dead
      // process is also not evidence that the task is wrong, so this is the one
      // path that requeues without asking the supervisor to rewrite anything.
      this.queue.update(task.id, {
        status: 'PENDING',
        errorLog: appendAttempt(task.errorLog, `[attempt ${task.attempts}] ${note}.`),
        finishedAt: null,
      });
      this.queue.log(task.id, 'system', 'silent', note);
      this.log(`task ${task.seq} — ${note}; requeued`);
      this.changed();
    }
  }

  /** Runs the full verification pass for one task and applies the verdict. */
  private async supervise(task: Task): Promise<void> {
    this.log(`supervising task ${task.seq} — ${task.title}`);

    let check: CommandResult = {
      ran: false,
      code: null,
      output: '',
      invalid: false,
      timedOut: false,
      error: '',
    };
    if (task.solutionVerifyCommand) {
      const budget = this.cfg<number>('queue.verifyCommandTimeoutSeconds', 300) * 1000;
      check = await runVerifyCommand(
        this.context,
        task.solutionVerifyCommand,
        this.workspaceRoot,
        budget,
      );
      this.queue.log(
        task.id,
        'supervisor',
        'verify-command',
        check.invalid || check.timedOut
          ? `did not run — ${check.error}: ${check.output.slice(0, 2000)}`
          : `exit ${check.code}: ${check.output.slice(0, 2000)}`,
      );
    }

    // From here until the verdict lands there is a turn running that only this
    // record can account for — see sweepSilentReview.
    const gen = ++this.reviewGen;
    const review: Review = { taskId: task.id, seq: task.seq, gen, lastActivityAt: Date.now() };
    this.review = review;

    let decision: SupervisorDecision;
    try {
      decision = await superviseTask(this.context, this.output, task, check, this.rewrites(task), {
        onAbort: (abort) => {
          review.abort = abort;
        },
        onActivity: (a) => {
          review.lastActivityAt = a.at;
          if (this.queue.recordActivity(task.id, a.phase, a.detail, 'supervisor')) {
            this.changed();
          }
        },
      });
    } catch (e: any) {
      this.log(`supervisor failed on task ${task.seq}: ${e?.message ?? e}`);
      this.queue.log(task.id, 'supervisor', 'error', String(e?.message ?? e));
      // Leave it in VERIFYING; the next tick tries again.
      return;
    } finally {
      if (this.review === review) {
        this.review = null;
      }
    }

    // A review the sweep already gave up on has no say: the task may have been
    // reviewed again, or reset, since this turn stopped writing.
    if (gen !== this.reviewGen) {
      this.log(`task ${task.seq} — a verdict arrived from an abandoned review; ignoring it`);
      return;
    }

    this.queue.addUsage(task.id, decision.usage);
    this.queue.log(task.id, 'supervisor', `verdict:${decision.verdict}`, decision.feedback);
    this.applyTaskEdits(decision, task.seq);

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
        // A rollback throws away finished work, so it has to be the supervisor's
        // considered judgement and not a reflex it can repeat forever. Past the
        // limit the task is retried on its own instead — the queue keeps moving
        // either way.
        const from = decision.resetFromSeq ?? task.seq;
        const budget = Math.max(0, this.cfg<number>('queue.maxRollbacks', 3));
        if (this.rollbacks >= budget) {
          this.queue.update(task.id, {
            status: 'PENDING',
            supervisorFeedback: decision.feedback,
            errorLog: `${task.errorLog}\n[attempt ${task.attempts}] ${decision.feedback}`.trim(),
            finishedAt: null,
          });
          this.log(
            `task ${task.seq} asked to roll back to ${from}, but ${this.rollbacks} rollback(s) ` +
              'have already happened; retrying this task alone instead',
          );
          break;
        }
        this.rollbacks++;
        const n = this.queue.resetFrom(from, decision.feedback);
        this.log(`rolling back to task ${from} (${n} task(s) reset)`);
        break;
      }

      case 'RETRY':
      default: {
        // No exhaustion branch, and no terminal state. `attempts` still counts —
        // the supervisor is told the number and is expected to change tactics as
        // it climbs — but it is not a countdown to giving up. The task goes back
        // to PENDING with instructions that differ from the ones that just
        // failed, which superviseTask guarantees.
        this.queue.update(task.id, {
          status: 'PENDING',
          supervisorFeedback: decision.feedback,
          errorLog: appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] ${decision.feedback}`,
          ),
          finishedAt: null,
        });
        this.log(`task ${task.seq} back to PENDING for attempt ${task.attempts + 1}`);
        // maxAttempts no longer retires anything; it marks the point where a
        // task has taken longer than the plan expected. Nothing changes, but an
        // unattended run should still say out loud which task it is grinding on.
        if (task.attempts >= task.maxAttempts) {
          this.log(
            `note: task ${task.seq} has now taken ${task.attempts} attempts. It will keep ` +
              'being retried with rewritten instructions; stop the queue if that is not what you want.',
          );
        }
        break;
      }
    }
    this.changed();
  }

  /** How many times the supervisor has already rewritten this task. */
  private rewrites(task: Task): number {
    return this.queue.events(task.id, 200).filter((e) => e.kind === 'task-edited').length;
  }

  /**
   * Applies the supervisor's rewrites.
   *
   * Edits are matched by `seq`, which is the number the supervisor was shown and
   * the only handle it has on a task. A rewrite that lands nowhere is worth
   * saying out loud: on the current task it is the difference between a retry
   * with new instructions and the same attempt run twice.
   */
  private applyTaskEdits(decision: SupervisorDecision, currentSeq?: number): void {
    for (const edit of decision.taskEdits ?? []) {
      const target = this.queue.list().find((t) => t.seq === edit.seq);
      if (!target || target.status === 'VERIFIED') {
        if (edit.seq === currentSeq) {
          this.log(`supervisor's rewrite of task ${edit.seq} could not be applied`);
        }
        continue;
      }
      const description = edit.description?.trim() || target.description;
      this.queue.update(target.id, {
        description,
        solutionVerifyCommand: edit.solutionVerifyCommand ?? target.solutionVerifyCommand,
      });
      if (description !== target.description) {
        this.queue.log(target.id, 'supervisor', 'task-edited', description.slice(0, 8000));
        this.log(`supervisor rewrote task ${edit.seq}`);
      }
      if (edit.solutionVerifyCommand && edit.solutionVerifyCommand !== target.solutionVerifyCommand) {
        this.queue.log(
          target.id,
          'supervisor',
          'check-fixed',
          `${target.solutionVerifyCommand} → ${edit.solutionVerifyCommand}`,
        );
        this.log(`supervisor fixed the check for task ${edit.seq}`);
      }
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
      // Every record the worker writes lands in the database as it happens, so
      // the run is legible while it is still going and survives the process
      // that produced it. This is also the only thing keeping the task off the
      // silent list — see sweepSilentWorkers.
      const res = await executeTask(this.context, this.output, task, (a) => {
        if (this.queue.recordActivity(task.id, a.phase, a.detail)) {
          this.changed();
        }
      });

      // A cut-off worker reports partial progress, not a finished task. Record
      // that in the error log: the retry prompt feeds it back, so the next
      // attempt continues from what was built instead of starting over. Being
      // cut off twice is the supervisor's signal that the task is too big and
      // should be split rather than retried.
      const cutOffNote = res.cutOff
        ? appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] cut off — used all ${res.rounds} tool-calling rounds. ` +
              'The report is partial progress, not a finished task.',
          )
        : undefined;

      this.queue.addUsage(task.id, res.usage);
      this.queue.update(task.id, {
        status: 'VERIFYING',
        output: res.text,
        ...(cutOffNote ? { errorLog: cutOffNote } : {}),
      });
      this.queue.log(
        task.id,
        'executor',
        res.cutOff ? 'cut-off' : 'completed',
        res.text.slice(0, 4000),
      );
      this.log(
        res.cutOff
          ? `task ${task.seq} cut off after ${res.rounds} rounds; awaiting supervision`
          : `task ${task.seq} done; awaiting supervision`,
      );
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // A worker that died mid-turn — a dropped connection, a crashed core —
      // still edited real files. Send it to the supervisor, which verifies by
      // reading the workspace rather than by trusting a report; bouncing it
      // straight back to PENDING spends another whole attempt with no idea what
      // the last one built. The journal it wrote on the way down says how far
      // it got.
      this.queue.update(task.id, {
        status: 'VERIFYING',
        output: '',
        errorLog: appendAttempt(
          task.errorLog,
          `[attempt ${task.attempts}] the worker stopped before reporting: ${msg}. ` +
            "Whatever it changed is still on disk — read the files, and read this task's " +
            'activity log, rather than assuming nothing happened.',
        ),
      });
      this.queue.recordActivity(task.id, 'stopped', msg);
      this.queue.log(task.id, 'executor', 'stopped', msg);
      this.log(`task ${task.seq} stopped without reporting: ${msg}; awaiting supervision`);
    } finally {
      this.executing = false;
      this.currentTaskId = null;
      this.changed();
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

  /**
   * The last line: if the queue is running and nothing at all is happening,
   * make something happen.
   *
   * Every stall this has had looked the same from outside — RUNNING in the
   * database, an idle cron, and a task that no longer belonged to anyone. Each
   * had its own cause and each cause has its own fix above, and none of that is
   * worth much at four in the morning, because the next stall will have a cause
   * nobody has thought of yet. This does not care why: it asks whether the queue
   * claims to be running while no worker and no review is in flight and there is
   * still work to do, and if so it starts the pump again.
   *
   * A pump that was not actually stuck returns immediately on its own guards, so
   * running this every tick costs nothing and needs no judgement about whether a
   * stall is "real".
   */
  private kick(): void {
    // Runs on its own timer, independent of the cron, and reads the run state
    // from the database rather than from this object — so it still works when
    // what broke is this object.
    if (this.disposed || this.queue.runState !== 'RUNNING') {
      return;
    }

    if (this.timer === undefined) {
      this.log('the cron was not armed while the queue was running; re-arming');
      this.arm();
    }
    if (this.executing || this.supervising) {
      return;
    }

    const s = this.queue.stats();
    const open = s.byStatus.PENDING + s.byStatus.EXECUTING + s.byStatus.VERIFYING;
    if (open === 0) {
      return;
    }
    this.log(`nothing in flight with ${open} task(s) still open; restarting the pump`);
    void this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.abandonReview();
    this._onDidChange.dispose();
  }
}
