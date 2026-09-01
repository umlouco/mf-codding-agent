import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  encodeRegion,
  executeTask,
  expandPhase,
  parseRegion,
  PhaseExpansion,
  Region,
  runScanCommand,
  superviseTask,
  SupervisorDecision,
  withinRegion,
} from './agents';
import { NewTask, QueueStats, Task, TaskQueue } from './db';

/**
 * The cron engine.
 *
 * Two independent pumps share the database and never talk to each other:
 *
 *   execution pump   claims one PENDING task, runs a throwaway worker on it,
 *                    writes the result back, and stops. Spawning the next
 *                    worker is a fresh process with a fresh context window.
 *
 *   supervision pump fires on the cron interval, reads executor validation
 *                    reports from rows sitting in VERIFYING, and rules on them.
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
/** Trims a value to `max` chars once stringified, for a log line that stays scannable. */
function briefJson(value: unknown, max: number): string {
  if (value === undefined) {
    return '';
  }
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * One line describing a finished executor tool call. It is retained as a
 * durable diagnostic trail, unlike liveness pings, which carry no content.
 */
function formatToolEvent(
  name: string,
  input: unknown,
  status: string,
  output: unknown,
  elapsedMs: unknown,
): string {
  const args = briefJson(input, 300);
  const result = briefJson(output, 1500);
  const timing = typeof elapsedMs === 'number' ? ` in ${elapsedMs}ms` : '';
  return `${name}(${args}) → ${status || 'ok'}${timing}${result ? `\n${result}` : ''}`;
}

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
  private supervising = false;
  private review: Review | null = null;
  private reviewGen = 0;
  /**
   * Kills the execution worker currently in flight, if any.
   *
   * This is the one thing about a running worker that genuinely cannot live
   * in the database: an OS process handle. Everything else — whether a
   * worker is running, which task, whether its last write-back still counts —
   * is decided by reading the `tasks` row itself (see claimNext, activeTask,
   * finishExecution in db.ts), not by anything kept here.
   */
  private executionAbort: (() => void) | null = null;
  /** Which supervision cycle owns `supervising`; see tick and sweepSilentReview. */
  private cycle = 0;
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

  private changed(): void {
    this._onDidChange.fire();
  }

  private log(msg: string): void {
    this.output.appendLine(`[queue] ${msg}`);
  }

  // ---- controls --------------------------------------------------------

  /**
   * Recovers tasks left EXECUTING by a process that no longer exists —
   * a crashed core, or a window that reloaded mid-run. Called from `start()`
   * and also directly on activation, before the run may even be RUNNING, so
   * a workspace that was left orphaned is fixed before anyone reads it.
   *
   * Uses `noReportEscalateAfter`: this is the actual crash-recovery moment,
   * so a task that keeps ending up here is a task whose worker keeps dying
   * before writing anything, and it is escalated to the supervisor rather
   * than silently requeued again — see requeueStale.
   */
  recoverOrphaned(): number {
    const recovered = this.queue.requeueStale(0, this.noReportEscalateAfter);
    if (recovered > 0) {
      this.log(`recovered ${recovered} orphaned task(s) from a previous session`);
    }
    return recovered;
  }

  start(): void {
    if (this.queue.runState === 'RUNNING' && this.timer) {
      return;
    }
    // Anything left EXECUTING belongs to a process that no longer exists.
    this.recoverOrphaned();
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
   * How many consecutive times a task's worker may fail to report back at
   * all — go silent, or the process (or the host around it) die outright —
   * before the task is routed to the supervisor instead of requeued again
   * with nobody looking at it. See requeueStale's `escalateAfter` and
   * sweepSilentWorkers below; this is the threshold both apply.
   */
  private get noReportEscalateAfter(): number {
    return Math.max(1, this.cfg<number>('queue.noReportEscalateAfter', 2));
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

  /**
   * Kills the execution worker in flight, if any, and puts its task back in
   * the database right away rather than waiting for that turn to settle on
   * its own — which, on a slow model, can be many minutes away.
   *
   * This is `requeueStale(0)`, the same recovery a reload uses for a worker
   * that died outright: whatever is EXECUTING right now has no live process
   * behind it, because the line above just killed it. Nothing here needs to
   * remember which task that was or compare generations — the next claimNext
   * (or the next requeueStale, if the process took a moment to actually die)
   * reads the database and finds the truth on its own. If the killed worker's
   * `pump()` call is still awaiting the request when it rejects, its
   * write-back targets a row that is no longer EXECUTING and finishExecution
   * silently drops it — see pump().
   */
  private abandonExecution(): void {
    const abort = this.executionAbort;
    this.executionAbort = null;
    try {
      abort?.();
    } catch {
      /* the core was already gone */
    }
    const recovered = this.queue.requeueStale(0);
    if (recovered > 0) {
      this.log(`stopped mid-execution; ${recovered} task(s) returned to PENDING`);
    }
  }

  private sweepSilentWorkers(): void {
    const silentMs = this.silentMs;
    const escalateAfter = this.noReportEscalateAfter;
    for (const task of this.queue.silentWorkers(silentMs)) {
      const quiet = Math.round((Date.now() - (task.lastActivityAt ?? task.startedAt ?? 0)) / 60_000);
      const note =
        `the worker went silent for ${quiet} minute(s) while ${task.activityPhase || 'starting up'}` +
        (task.activityDetail ? ` (${task.activityDetail})` : '');

      // A dead process is not evidence that the task is wrong, so on its own
      // this requeues without asking the supervisor to rewrite anything —
      // unlike a worker that died with a message, this one never said
      // goodbye, and there is no report to judge. But enough of them in a row
      // (a phase never counts — see TaskKind) is itself evidence the
      // supervisor has never had a chance to see: a task whose worker cannot
      // even finish one attempt, over and over, may simply be too big for one
      // sitting. Past `escalateAfter`, it goes to VERIFYING instead — the
      // same route a task takes when it genuinely finishes — so the
      // supervisor can retry it with better instructions, split it, or roll
      // it back, rather than it spinning forever with nobody looking.
      const streak = task.kind === 'task' ? task.noReportStreak + 1 : task.noReportStreak;
      if (task.kind === 'task' && streak >= escalateAfter) {
        this.queue.update(task.id, {
          status: 'VERIFYING',
          finishedAt: null,
          noReportStreak: 0,
          errorLog: appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] ${note}. This is the ${streak}th time in a row a worker has ` +
              'failed to even finish this task — escalating to the supervisor instead of retrying blindly.',
          ),
        });
        this.queue.log(task.id, 'system', 'escalated', `${note}; ${streak} consecutive no-report failures`);
        this.log(`task ${task.seq} — ${note}; escalated to the supervisor after ${streak} silent attempt(s)`);
      } else {
        this.queue.update(task.id, {
          status: 'PENDING',
          errorLog: appendAttempt(task.errorLog, `[attempt ${task.attempts}] ${note}.`),
          finishedAt: null,
          ...(task.kind === 'task' ? { noReportStreak: streak } : {}),
        });
        this.queue.log(task.id, 'system', 'silent', note);
        this.log(`task ${task.seq} — ${note}; requeued`);
      }
      this.changed();
    }
  }

  /** Runs the full verification pass for one task and applies the verdict. */
  private async supervise(task: Task): Promise<void> {
    this.log(`supervising task ${task.seq} — ${task.title}`);

    // From here until the verdict lands there is a turn running that only this
    // record can account for — see sweepSilentReview.
    const gen = ++this.reviewGen;
    const review: Review = { taskId: task.id, seq: task.seq, gen, lastActivityAt: Date.now() };
    this.review = review;

    let decision: SupervisorDecision;
    try {
      decision = await superviseTask(this.context, this.output, task, this.rewrites(task), {
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
        const exhausted = task.attempts >= Math.max(1, task.maxAttempts);
        this.queue.update(task.id, {
          status: exhausted ? 'FAILED' : 'PENDING',
          supervisorFeedback: decision.feedback,
          errorLog: appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] ${decision.feedback}`,
          ),
          finishedAt: exhausted ? Date.now() : null,
        });
        if (exhausted) {
          this.disarm();
          this.queue.setRunState('STOPPED');
          this.log(`task ${task.seq} FAILED after ${task.attempts} attempts; run stopped for review`);
        } else {
          this.log(`task ${task.seq} back to PENDING for attempt ${task.attempts + 1}`);
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
   * later executors may run ahead while conclusion checks follow behind.
   *
   * "At most one worker at a time" is not enforced here. `claimNext` refuses
   * to hand out a task while any row is EXECUTING, so calling this twice at
   * once — the cron tick and the watchdog firing together, say — costs a
   * wasted query on the loser, never a second worker. That is also what makes
   * this call safe to repeat after a stop-and-restart: whatever the database
   * says about the previous attempt is what decides whether this one may
   * proceed, not anything remembered from before the restart.
   */
  private async pump(): Promise<void> {
    if (this.disposed || this.queue.runState !== 'RUNNING') {
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

    // The fencing token: claimNext bumped this when it claimed the row, and
    // finishExecution below will only write back while both this number and
    // 'EXECUTING' still match what is actually in the database. A turn
    // abandonExecution has since given up on — the queue was stopped, this
    // very task was reclaimed by a fresh attempt — fails that match and its
    // write is silently dropped, no in-memory bookkeeping required.
    const attempt = task.attempts;
    this.changed();

    // A phase is a coarse slice of the plan awaiting expansion into real
    // tasks, not work to execute — see TaskKind. It shares this same claim so
    // that everything below (the cron ordering, requeueStale, silentWorkers,
    // the watchdog) covers phase-expansion crashes for free.
    if (task.kind === 'phase') {
      await this.runExpansion(task, attempt);
      if (this.mode === 'continuous') {
        void this.pump();
      }
      return;
    }

    this.log(`executing task ${task.seq} — ${task.title} (attempt ${task.attempts})`);

    // stream/tool fires twice per call — once on "running" (carries the
    // input, not the output), once on completion (carries the output, not
    // the input) — matched by id. Correlating them here is what turns the
    // liveness pings elsewhere into a diagnostic trail with actual content:
    // which file, which command, and what came back.
    const pendingTools = new Map<string, { name: string; input: unknown }>();

    try {
      // Every record the worker writes lands in the database as it happens, so
      // the run is legible while it is still going and survives the process
      // that produced it. This is also the only thing keeping the task off the
      // silent list — see sweepSilentWorkers.
      const res = await executeTask(
        this.context,
        this.output,
        task,
        (a) => {
          if (this.queue.recordActivity(task.id, a.phase, a.detail)) {
            this.changed();
          }
        },
        (method, params) => {
          if (method !== 'stream/tool' || !params?.id) {
            return;
          }
          if (params.status === 'running') {
            pendingTools.set(params.id, { name: String(params.name ?? 'tool'), input: params.input });
            return;
          }
          const started = pendingTools.get(params.id);
          pendingTools.delete(params.id);
          this.queue.log(
            task.id,
            'executor',
            'tool',
            formatToolEvent(
              started?.name ?? String(params.name ?? 'tool'),
              started?.input,
              String(params.status ?? ''),
              params.output,
              params.elapsedMs,
            ),
          );
        },
        (abort) => {
          this.executionAbort = abort;
        },
      );

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
      const applied = this.queue.finishExecution(task.id, attempt, {
        status: 'VERIFYING',
        output: res.text,
        // This is the hand-off contract: verification evidence crosses the
        // executor/supervisor boundary only through the queue database.
        validationReport: res.validationReport,
        // The worker reported, whatever it reported — see noReportStreak.
        noReportStreak: 0,
        ...(cutOffNote ? { errorLog: cutOffNote } : {}),
      });
      if (!applied) {
        this.log(`task ${task.seq} — result arrived after the run moved past this attempt; discarding it`);
      } else {
        this.queue.log(
          task.id,
          'executor',
          res.cutOff ? 'cut-off' : 'completed',
          res.text.slice(0, 4000),
        );
        this.queue.log(task.id, 'executor', 'validation', res.validationReport.slice(0, 8000));
        this.log(
          res.cutOff
            ? `task ${task.seq} cut off after ${res.rounds} rounds; awaiting supervision`
            : `task ${task.seq} done; awaiting supervision`,
        );
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // A worker that died mid-turn — a dropped connection, a crashed core, or
      // abandonExecution killing it on purpose — still edited real files. Send
      // it to the supervisor with an empty validation report. The supervisor
      // cannot inspect the workspace, so it will reject the missing evidence
      // and use the journal/error history to shape the next attempt.
      const applied = this.queue.finishExecution(task.id, attempt, {
        status: 'VERIFYING',
        output: '',
        // The supervisor is about to look at this attempt directly, so it is
        // not the kind of unseen failure the streak exists to catch.
        noReportStreak: 0,
        errorLog: appendAttempt(
          task.errorLog,
          `[attempt ${task.attempts}] the worker stopped before reporting: ${msg}. ` +
            "Whatever it changed is still on disk — read the files, and read this task's " +
            'activity log, rather than assuming nothing happened.',
        ),
      });
      if (applied) {
        this.queue.recordActivity(task.id, 'stopped', msg);
        this.queue.log(task.id, 'executor', 'stopped', msg);
        this.log(`task ${task.seq} stopped without reporting: ${msg}; awaiting supervision`);
      } else {
        this.log(`task ${task.seq} — its worker stopped after the run moved past this attempt; ignoring it`);
      }
    } finally {
      this.executionAbort = null;
      this.changed();
    }

    // Continuous mode keeps going without waiting for the cron. pump() will
    // no-op on its own if the database says there is nothing left to claim.
    if (this.mode === 'continuous') {
      void this.pump();
    }
  }

  /**
   * Expands one phase into the tasks — or, occasionally, the smaller phases —
   * it should have been.
   *
   * Unlike a task's result this never enters VERIFYING: a planning decision
   * is not a functional check, so success replaces the phase row outright via
   * `expandTask`, and failure puts it straight back to PENDING, the same as a
   * worker that stopped mid-turn in `pump()` above.
   */
  private async runExpansion(task: Task, attempt: number): Promise<void> {
    this.log(`expanding phase ${task.seq} — ${task.title} (attempt ${task.attempts})`);
    const goal = this.queue.getMeta('goal');

    let result: PhaseExpansion;
    try {
      result = await expandPhase(
        this.context,
        this.output,
        task,
        goal,
        (a) => {
          if (this.queue.recordActivity(task.id, a.phase, a.detail)) {
            this.changed();
          }
        },
        undefined,
        (abort) => {
          this.executionAbort = abort;
        },
      );
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const applied = this.queue.finishExecution(task.id, attempt, {
        status: 'PENDING',
        finishedAt: null,
        errorLog: appendAttempt(
          task.errorLog,
          `[attempt ${task.attempts}] the expansion agent stopped before reporting: ${msg}.`,
        ),
      });
      if (applied) {
        this.queue.recordActivity(task.id, 'stopped', msg);
        this.queue.log(task.id, 'planner', 'stopped', msg);
        this.log(`phase ${task.seq} stopped without reporting: ${msg}; awaiting another attempt`);
      } else {
        this.log(`phase ${task.seq} — its worker stopped after the run moved past this attempt; ignoring it`);
      }
      this.executionAbort = null;
      this.changed();
      return;
    }

    this.executionAbort = null;
    this.queue.addUsage(task.id, result.usage);

    // The expander itself may flag a slice of its own region as still too
    // broad once it has actually explored it — code, not the model, decides
    // how much smaller that slice really needs to be. See resplitPhaseRegion.
    const resolvedSplits: NewTask[] = [];
    for (const req of result.splitRequests) {
      const parts = await this.resplitPhaseRegion(
        task,
        req.path,
        req.title || task.title,
        req.description || task.description,
      );
      resolvedSplits.push(...parts);
    }

    let parts: NewTask[] = [...result.tasks, ...resolvedSplits];

    if (parts.length === 0 && result.cutOff) {
      // The round budget ran out before anything usable came back — a size
      // signal, not just "it failed" — so code tries to shrink the phase
      // itself rather than asking an identically-scoped retry to hit the
      // same wall again.
      parts = await this.resplitPhaseRegion(task, undefined, task.title, task.description);
    }

    if (parts.length > 0) {
      const applied = this.queue.expandTask(task.id, attempt, parts);
      if (applied > 0) {
        this.queue.log(task.id, 'planner', 'expanded', `${applied} row(s)`);
        this.log(`phase ${task.seq} expanded into ${applied} row(s)`);
      } else {
        this.log(`phase ${task.seq} — result arrived after the run moved past this attempt; discarding it`);
      }
      this.changed();
      return;
    }

    // Nothing usable, and nothing left for code to try splitting further —
    // the same shape as a task RETRY: back to PENDING with a note, no attempt
    // limit that ends this phase.
    const note = result.cutOff
      ? 'cut off before producing a usable task list, and the region could not be split any further'
      : 'produced no usable tasks';
    const applied = this.queue.finishExecution(task.id, attempt, {
      status: 'PENDING',
      finishedAt: null,
      errorLog: appendAttempt(task.errorLog, `[attempt ${task.attempts}] ${note}.`),
    });
    if (applied) {
      this.queue.log(task.id, 'planner', 'retry', note);
      this.log(`phase ${task.seq} ${note}; awaiting another attempt`);
    }
    this.changed();
  }

  /**
   * Deterministically re-derives smaller regions for (part of) a phase's own
   * territory and turns each into a fresh phase row.
   *
   * Two callers, two shapes of the same idea. A phase that merged several
   * scanned regions un-merges back into one phase per region — always a real
   * reduction in scope, and no rescan is needed to know that. A phase over a
   * single region (or a sub-slice the expander itself named) gets that one
   * path rescanned at half the usual ceiling, which only produces more than
   * one region if there is real subdirectory structure to divide it by.
   * Either way, size comes from a fresh count of files, never from the
   * model's own say-so.
   */
  private async resplitPhaseRegion(
    phase: Task,
    narrowToPath: string | undefined,
    title: string,
    description: string,
  ): Promise<NewTask[]> {
    const region = parseRegion(phase.region);
    const maxPerRegion = Math.max(1, this.cfg<number>('queue.maxFilesPerRegion', 150));

    if (!narrowToPath && region.paths.length > 1) {
      const parts: NewTask[] = [];
      for (const p of region.paths) {
        const fileCount = await this.regionFileCount(p, maxPerRegion);
        parts.push({
          title: `${title} — ${p}`,
          description,
          kind: 'phase',
          region: encodeRegion({ paths: [p], fileCount }),
        });
      }
      return parts;
    }

    const target = narrowToPath && withinRegion(narrowToPath, region.paths) ? narrowToPath : region.paths[0];
    if (!target) {
      return [];
    }

    const forced = Math.max(1, Math.ceil(maxPerRegion / 2));
    let sub: Region[];
    try {
      sub = await runScanCommand(this.context, path.join(this.workspaceRoot, target), forced);
    } catch (e: any) {
      this.log(`could not re-scan ${target} while splitting phase ${phase.seq}: ${e?.message ?? e}`);
      return [];
    }
    if (sub.length <= 1) {
      // No further directory structure to divide on — nothing more code can
      // try; the caller falls back to a plain retry.
      return [];
    }
    return sub.map((r) => {
      const joined = r.path === '.' ? target : `${target}/${r.path}`;
      return {
        title: `${title} — ${joined}`,
        description,
        kind: 'phase' as const,
        region: encodeRegion({ paths: [joined], fileCount: r.fileCount }),
      };
    });
  }

  /** The real file count behind one already-known region path, via a fresh scan. */
  private async regionFileCount(relPath: string, ceiling: number): Promise<number> {
    try {
      const regions = await runScanCommand(this.context, path.join(this.workspaceRoot, relPath), ceiling);
      return regions.reduce((sum, r) => sum + r.fileCount, 0);
    } catch {
      return 0;
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
  private notify(event: string, stats: QueueStats): void {
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

  /**
   * The last line: if the queue is running and nothing at all is happening,
   * make something happen.
   *
   * Every stall this has had looked the same from outside — RUNNING in the
   * database, an idle cron, and a task that no longer belonged to anyone. Each
   * had its own cause and each cause has its own fix above, and none of that is
   * worth much at four in the morning, because the next stall will have a cause
   * nobody has thought of yet. This does not care why: it asks whether the queue
   * claims to be running while there is still work open, and if so it nudges
   * the pump.
   *
   * `this.supervising` is the only in-memory check left — a cheap way to skip
   * a nudge that is almost certainly pointless, since something is visibly
   * being reviewed. It is not load-bearing: pump() decides for itself, from
   * the database, whether a worker may actually start, so a nudge sent while
   * one is genuinely still running costs one wasted query and nothing else.
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
    if (this.supervising) {
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
    this.abandonExecution();
    this._onDidChange.dispose();
  }
}
