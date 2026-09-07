import { VALIDATION_FAILED } from './monitor';
import { OrchestratorControl } from './orchestratorControl';
import { appendAttempt } from './orchestratorState';
import { scopeBlocked } from './scopePlan';

export abstract class OrchestratorWatchdog extends OrchestratorControl {

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
  protected async tick(): Promise<void> {
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

      const active = this.queue.activeTask();
      if (active?.kind === 'task' && active.activityPhase !== 'scope_review') {
        await this.reviewWork(active);
      }

      const pending = this.queue.awaitingVerification();
      for (const task of pending) {
        if (this.disposed || this.queue.runState !== 'RUNNING' || this.cycle !== cycle) {
          break;
        }
        let current = this.queue.get(task.id);
        if (!current || current.status !== 'VERIFYING' || scopeBlocked(current, this.queue.list())) {
          continue;
        }
        if (!current.validationReport.trim()) {
          if (current.activityPhase === 'ready_for_validation') {
            await this.startIndependentVerification(current);
          } else {
            await this.reviewWork(current);
          }
          current = this.queue.get(task.id);
        }
        if (current?.status === 'VERIFYING' && current.validationReport.trim()) {
          await this.supervise(current);
        }
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
  protected get silentMs(): number {
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
  protected sweepSilentReview(): void {
    const r = this.review;
    if (!this.supervising || !r) {
      return;
    }
    if (r.validationToolViolation) {
      const note = r.validationToolViolation;
      this.queue.log(r.taskId, 'validator', VALIDATION_FAILED, note);
      const current = this.queue.get(r.taskId);
      if (current?.status === 'VERIFYING') {
        this.queue.update(r.taskId, {
          errorLog: appendAttempt(current.errorLog, `[attempt ${current.attempts}] independent validation did not complete: ${note}`),
        });
      }
      this.log(`task ${r.seq} — recovering validator: ${note}`);
      this.abandonReview();
      this.changed();
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

      if (task.kind === 'task') {
        this.stopForDecision(task, {
          status: 'VERIFYING',
          finishedAt: null,
          validationReport: '',
          errorLog: appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] ${note}. The supervisor must decide the next action from the journal.`,
          ),
        });
        this.queue.log(task.id, 'system', 'silent', `${note}; sent to supervisor`);
        this.log(`task ${task.seq} — ${note}; sent directly to the supervisor`);
      } else {
        this.queue.update(task.id, {
          status: 'PENDING',
          errorLog: appendAttempt(task.errorLog, `[attempt ${task.attempts}] ${note}.`),
          finishedAt: null,
        });
        this.queue.log(task.id, 'system', 'silent', note);
        this.log(`task ${task.seq} — ${note}; requeued`);
      }
      this.changed();
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
    const open = s.byStatus.PENDING + s.byStatus.EXECUTING + s.byStatus.VERIFYING;
    if (open === 0) {
      return;
    }
    if (s.byStatus.EXECUTING === 0 && s.byStatus.VERIFYING === 0) {
      this.log(`${open} pending task(s); checking the execution pump`);
    }
    void this.pump();
  }
}
