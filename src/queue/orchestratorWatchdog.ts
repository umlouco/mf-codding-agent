import { OrchestratorControl } from './orchestratorControl';
import { hasOutstandingRecovery } from './recoverySchedule';
import { recoverOwnershipStop } from './ownershipRecovery';
import { requiresDecomposition } from './recoveryDecomposition';

export abstract class OrchestratorWatchdog extends OrchestratorControl {

  // ---- the cron tick ---------------------------------------------------

  /**
   * One supervision cycle. It keeps the run moving, reads a running executor's
   * journal for a loop or a rabbit hole, and replaces every failed task with
   * smaller ones before the pump starts the next worker. Everything below still
   * checks `this.cycle` before acting, so a superseded cycle cannot declare the
   * run finished or take the busy flag off its successor.
   */
  protected async tick(): Promise<void> {
    this.nextTickAt = Date.now() + this.intervalMs;
    if (this.disposed || this.queue.runState !== 'RUNNING') {
      return;
    }
    // The run-wide backstop runs before anything else: if the run has spent too
    // much, produced too many rows, or run too long, stop it now rather than
    // start another worker.
    if (this.runBreakerTripped()) {
      return;
    }
    if (this.supervising) {
      this.log('supervisor still busy; skipping this tick');
      return;
    }

    const cycle = ++this.cycle;
    this.supervising = true;
    this.changed();
    try {
      // A worker that went quiet, one whose journal shows a loop or a rabbit
      // hole, and a halted repair all end as a failed task, and serviceSplits
      // replaces a failed task with smaller ones before any later work starts.
      this.sweepSilentWorkers();
      for (const task of this.queue.list()) recoverOwnershipStop(this.queue, task);
      this.queue.drainVerification();
      await this.serviceTestRepairs();
      await this.watchExecution();
      await this.serviceSplits();

      if (this.cycle === cycle && this.queue.isComplete() && !hasOutstandingRecovery(this.queue)) {
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
    this.schedule('execution pump after supervision', () => this.pump());
  }

  /**
   * How long a worker may be silent before it counts as having stopped working,
   * which fails its task: the task is split into smaller tasks.
   *
   * This is the whole of the "has it stopped" test, and it deliberately says
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
  protected get silentMs(): number {
    return Math.max(1, this.cfg<number>('queue.workerSilentMinutes', 10)) * 60_000;
  }

  /**
   * Drops the review in flight and frees the tick parked on it.
   *
   * Both counters move: the cycle so the abandoned tick cannot resume as if it
   * still owned the run, the review generation so a verdict that arrives after
   * this point is discarded rather than written.
   */
  protected abandonReview(): void {
    const r = this.review;
    r?.scope?.close();
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
  protected abandonExecution(): void {
    this.executionScope?.close();
    this.executionScope = undefined;
    this.executionGen = (this.executionGen ?? 0) + 1;
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

  /** A worker that stopped working failed its task, and a failed task is split. */
  protected sweepSilentWorkers(): void {
    const silentMs = this.silentMs;
    for (const task of this.queue.silentWorkers(silentMs)) {
      const quiet = Math.round((Date.now() - (task.lastActivityAt ?? task.startedAt ?? 0)) / 60_000);
      const note =
        `the worker went silent for ${quiet} minute(s) while ${task.activityPhase || 'starting up'}` +
        (task.activityDetail ? ` (${task.activityDetail})` : '');
      this.queue.log(task.id, 'system', 'silent', `${note}; the task is split into smaller tasks`);
      this.log(`task ${task.seq}: ${note}; splitting it into smaller tasks`);
      this.requestFailureDecomposition(task, `The executor stopped working: ${note}.`);
    }
  }

  /** Explicit scoped repairs remain ordered; obsolete ownership stops were recovered above. */
  protected async serviceTestRepairs(): Promise<void> {
    const rows = this.queue.list();
    const task = rows.find(t => t.status !== 'VERIFIED');
    // A task waiting for its split belongs to serviceSplits even if a repair
    // marker is still on it: re-requesting its repair is how a halted repair
    // once looped on every tick.
    if (!task || task.status !== 'VERIFYING' || requiresDecomposition(task) ||
        !task.supervisorFeedback.startsWith('[SUPERVISOR_TEST_REPAIR]')) {
      return;
    }
    const reason = task.supervisorFeedback;
    this.log(`task ${task.seq} — supervisor test repair requested; running the repair turn`);
    this.queue.log(task.id, 'supervisor', 'test-repair-requested', reason);
    await this.repairTests(task, reason);
    this.changed();
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
  protected kick(): void {
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
    const open = s.byStatus.PENDING + s.byStatus.EXECUTING + s.byStatus.VERIFYING + s.byStatus.BLOCKED;
    if (open === 0) {
      return;
    }
    if (s.byStatus.VERIFYING > 0) {
      // A task waiting for its split or a repair, or a legacy review row. The
      // tick splits, repairs, or settles it and then pumps, so a lost cron
      // cannot leave it untouched forever.
      this.log(`${s.byStatus.VERIFYING} task(s) awaiting a split, repair, or settlement; running the supervisor`);
      this.schedule('watchdog settle check', () => this.tick());
      return;
    }
    if (s.byStatus.EXECUTING === 0) {
      this.log(`${open} pending task(s); checking the execution pump`);
    }
    this.schedule('watchdog execution pump', () => this.pump());
  }
}
