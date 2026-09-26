import { OrchestratorControl } from './orchestratorControl';
import { appendAttempt } from './orchestratorState';

export abstract class OrchestratorWatchdog extends OrchestratorControl {

  // The cron tick — the supervisor cycle — lives in OrchestratorPipeline.

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

  protected sweepSilentWorkers(): void {
    const silentMs = this.silentMs;
    for (const task of this.queue.silentWorkers(silentMs)) {
      const quiet = Math.round((Date.now() - (task.lastActivityAt ?? task.startedAt ?? 0)) / 60_000);
      const note =
        `the worker went silent for ${quiet} minute(s) while ${task.activityPhase || 'starting up'}` +
        (task.activityDetail ? ` (${task.activityDetail})` : '');
      const errorLog = appendAttempt(
        task.errorLog,
        `[attempt ${task.attempts}] ${note}. The keep-alive supervisor returned it to the queue.`,
      );
      this.stopForDecision(task, { status: 'PENDING', finishedAt: null,
        activityPhase: 'executor_recovery', activityDetail: note, errorLog });
      this.queue.log(task.id, 'system', 'silent', `${note}; requeued by the keep-alive supervisor`);
      this.log(`task ${task.seq}: ${note}; requeued`);
      this.changed();
    }
  }

  /** Explicit scoped repairs remain ordered; obsolete ownership stops were recovered above. */
  protected async serviceTestRepairs(): Promise<void> {
    const rows = this.queue.list();
    const task = rows.find(t => t.status !== 'VERIFIED');
    if (!task || task.status !== 'VERIFYING' || !task.supervisorFeedback.startsWith('[SUPERVISOR_TEST_REPAIR]')) {
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
      // A task is waiting on the tester or a supervisor decision. Run the
      // supervisor cycle, which pumps when it ends, so a lost cron cannot leave
      // it waiting forever.
      this.schedule('watchdog supervisor check', () => this.tick());
      return;
    }
    if (s.byStatus.EXECUTING === 0) {
      this.log(`${open} pending task(s); checking the execution pump`);
    }
    this.schedule('watchdog execution pump', () => this.pump());
  }
}
