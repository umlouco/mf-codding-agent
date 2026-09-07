import { attemptsExhausted } from './agents';
import { Task } from './db';
import { LiveLog } from './liveLog';
import { JOURNAL_EVENTS, ProgressDecision, reviewProgress, VALIDATION_FAILED } from './monitor';
import { Review } from './orchestratorState';
import { OrchestratorRemediation } from './orchestratorRemediation';
import { decisionEvidence, recoveryContext, recoveryEvidence, recoveryFailure, recoverySucceeded, recoveryReplayLimit } from './recovery';
import { isLocalScope } from './scopeContract';

export abstract class OrchestratorProgress extends OrchestratorRemediation {

  /**
   * How often the supervisor may look in on a task that is still executing.
   *
   * Separate from the cron interval, and much longer than it. The cron exists to
   * notice things quickly — a finished task, a dead worker — and a minute is
   * right for that. A live agent is a different subject: reviewing it is a full
   * model turn over its journal, and a task that now legitimately runs for
   * hours does not change its mind every minute. Judging it on every tick
   * mostly re-reads evidence the supervisor already ruled on.
   */
  protected get reviewIntervalMs(): number {
    return Math.max(30, this.cfg<number>('queue.reviewIntervalSeconds', 300)) * 1000;
  }

  /**
   * Whether looking in on this task again would show the supervisor anything.
   *
   * A live task needs both halves: enough time since the last look, and new
   * evidence since the last look. Either alone is not enough — an agent that
   * has written nothing has nothing new to judge no matter how long it has
   * been, and an agent mid-tool-call has not finished the thought that the last
   * review was already reading.
   *
   * A task that has *stopped* is not a poll at all. Nothing further will be
   * written to its journal, and the queue does not move until someone decides
   * what happens next, so that decision is never delayed or skipped.
   */
  protected shouldReview(task: Task, latestEventId: number): boolean {
    if (task.status !== 'EXECUTING') {
      return true;
    }
    const last = this.reviewed.get(task.id);
    // A fresh attempt is a fresh subject: whatever was judged last time was
    // judged about a worker that is no longer running.
    if (!last || last.attempt !== task.attempts) {
      return true;
    }
    return Date.now() - last.at >= this.reviewIntervalMs && latestEventId > last.eventId;
  }

  /** Lets the supervisor judge live work and choose one fixed control action. */
  protected async reviewWork(task: Task): Promise<void> {
    const state = recoveryEvidence(this.queue, task);
    const replayLimit = state.blocked || recoveryReplayLimit(state);
    if (replayLimit) {
      await this.replanOrPause(task, replayLimit);
      return;
    }
    const evidenceEventId = decisionEvidence(this.queue, task);
    const events = this.queue.events(task.id, JOURNAL_EVENTS, true);
    const latestEventId = events.find(event => event.actor !== 'supervisor')?.id ?? 0;
    if (!this.shouldReview(task, latestEventId)) {
      return;
    }
    // Recorded before the turn, not after: this is a rate, and a review that
    // fails or is abandoned still means the supervisor has just looked.
    this.reviewed.set(task.id, { attempt: task.attempts, at: Date.now(), eventId: latestEventId });

    this.log(`reviewing live work on task ${task.seq} — ${task.title}`);
    const gen = ++this.reviewGen;
    const review: Review = { taskId: task.id, seq: task.seq, gen, lastActivityAt: Date.now(), evidenceEventId };
    this.review = review;
    // The supervisor's reasoning streams to the view like everyone else's —
    // into the live table only, never into the journal it will read next time.
    const live = new LiveLog(this.queue, task.id, 'supervisor');

    try {
      const decision = await reviewProgress(
        this.context,
        this.output,
        task,
        events,
        this.queue.countEvents(task.id, VALIDATION_FAILED),
        {
          projectNotes: this.queue.contextInstructions,
          recoveryContext: recoveryContext(this.queue, task),
          testingUrl: this.queue.testingUrl,
          ownerInstructions: this.queue.testingContext + this.queue.instructions,
          refreshProgress: () => {
            if (gen !== this.reviewGen) throw new Error('Progress review was superseded.');
            const current = this.queue.get(task.id);
            if (!current || !['EXECUTING', 'VERIFYING'].includes(current.status) ||
                current.attempts !== task.attempts || current.startedAt !== task.startedAt ||
                current.description !== task.description || current.implVerifyPrompt !== task.implVerifyPrompt ||
                current.solutionVerifyPrompt !== task.solutionVerifyPrompt || current.solutionVerifyCommand !== task.solutionVerifyCommand) {
              throw new Error('Task contract changed during requirements comparison; obtain a fresh review.');
            }
            task = current;
            review.evidenceEventId = decisionEvidence(this.queue, task);
            return { task, events: this.queue.events(task.id, JOURNAL_EVENTS, true),
              failedValidations: this.queue.countEvents(task.id, VALIDATION_FAILED) };
          },
          onAbort: (abort) => {
            if (gen !== this.reviewGen) { abort(); return; }
            review.abort = abort;
          },
          onEvent: this.observerEvents(task.id, 'supervisor', live, () => gen === this.reviewGen),
          onActivity: (activity) => {
            if (gen !== this.reviewGen) return;
            review.lastActivityAt = activity.at;
            live.activity(activity);
            // On the row as well, as supervise() does — but only for a task
            // that has stopped. A running executor's own records are what
            // the silent-worker sweep reads, and a review must not refresh
            // them on a worker that is actually gone.
            if (
              task.status !== 'EXECUTING' &&
              this.queue.recordActivity(task.id, activity.phase, activity.detail, 'supervisor')
            ) {
              this.changed();
            }
          },
        },
        this.queue.getMeta('goal'),
      );
      if (gen !== this.reviewGen) {
        this.log(`task ${task.seq} — abandoned progress decision ignored`);
        return;
      }
      this.queue.addUsage(task.id, decision.usage);
      await this.applyProgressDecision(task, decision, review);
      if (this.queue.get(task.id)) recoverySucceeded(this.queue, task, 'progress-review');
    } catch (error: any) {
      if (gen !== this.reviewGen) {
        this.log(`task ${task.seq} — abandoned progress review error ignored`);
        return;
      }
      const message = String(error?.message ?? error);
      this.queue.log(task.id, 'supervisor', 'monitor-error', message);
      // In the row and the terminal too: a supervisor that fails on every
      // tick otherwise looks, from the list, exactly like one that never ran.
      if (task.status !== 'EXECUTING') {
        this.queue.recordActivity(task.id, 'error', `supervisor: ${message}`, 'supervisor');
        this.changed();
      }
      live.note('error', `supervisor failed: ${message}`);
      this.log(`task ${task.seq} — progress review failed: ${message}; execution preserved`);
      const limit = recoveryFailure(this.queue, task, 'progress-review');
      if (limit) await this.replanOrPause(task, limit);
    } finally {
      live.close();
      if (this.review === review) {
        this.review = null;
      }
    }
  }

  protected async applyProgressDecision(
    snapshot: Task,
    decision: ProgressDecision,
    review: Review,
  ): Promise<void> {
    const task = this.queue.get(snapshot.id);
    if (!task || !['EXECUTING', 'VERIFYING'].includes(task.status) ||
        task.status !== snapshot.status || task.startedAt !== snapshot.startedAt || task.attempts !== snapshot.attempts ||
        task.description !== snapshot.description || task.implVerifyPrompt !== snapshot.implVerifyPrompt ||
        task.solutionVerifyPrompt !== snapshot.solutionVerifyPrompt ||
        task.solutionVerifyCommand !== snapshot.solutionVerifyCommand) {
      this.log(`task ${snapshot.seq} moved while its progress was reviewed; action ignored`);
      return;
    }

    // A queued local review can take minutes while its worker edits or tests.
    // Unchanged task instructions do not make that older evidence current.
    // Preserve the worker and ask again with its new results; heartbeat-only
    // activity must not invalidate a useful review of slow, ongoing inference.
    if (review.evidenceEventId !== undefined &&
        decisionEvidence(this.queue, task) > review.evidenceEventId) {
      this.queue.log(task.id, 'supervisor', 'review-outdated',
        'A novel completed tool outcome or a potentially mutating/test tool start arrived during review. Decision discarded; execution preserved.');
      this.reviewed.delete(task.id);
      this.log(`task ${task.seq} has newer tool evidence; obtain a fresh progress review`);
      return;
    }

    if (decision.action === 'STOP_AND_DECOMPOSE_TASK') {
      await this.replanOrPause(task, decision.reason);
      return;
    }
    if (isLocalScope(task) && decision.action.startsWith('STOP_AND_REWRITE')) {
      throw new Error('Recovery cannot change the accepted scope of a committed child task. Supply local execution guidance instead.');
    }
    const retry = decision.action.startsWith('STOP_AND_REWRITE') ||
      (decision.action === 'CONTINUE_EXECUTION' && task.status === 'VERIFYING' && !task.validationReport.trim()) ||
      (decision.action === 'START_VALIDATION' && this.queue.countEvents(task.id, VALIDATION_FAILED) > 0);
    if (retry && !await this.allowRecovery(task, decision.action)) return;
    this.queue.log(task.id, 'supervisor', `action:${decision.action}`, decision.reason);
    switch (decision.action) {
      case 'CONTINUE_EXECUTION':
        if (task.status === 'VERIFYING' && !task.validationReport.trim()) {
          this.queue.update(task.id, {
            status: 'PENDING', finishedAt: null, supervisorFeedback: decision.guidance || decision.reason,
            ...(attemptsExhausted(task) ? { attempts: 0 } : {}),
          });
          this.queue.log(task.id, 'supervisor', 'continued', decision.reason);
          this.log(`task ${task.seq} will resume from its handoff with the same requirements`);
        } else {
          if (decision.guidance && decision.guidance !== task.supervisorFeedback) {
            this.queue.update(task.id, { supervisorFeedback: decision.guidance });
            const gen = this.executionGen;
            let accepted = false;
            try { accepted = await this.executionSteer?.(decision.guidance) ?? false; } catch { /* Retained for the next handoff. */ }
            if (gen === this.executionGen && this.queue.get(task.id)?.startedAt === task.startedAt) {
              this.queue.log(task.id, 'supervisor', accepted ? 'guidance-queued' : 'guidance-saved',
                `${accepted ? 'Queued for the next model round' : 'Saved for the next worker handoff'}: ${decision.guidance}`);
            }
          }
          this.log(`task ${task.seq} is progressing in the right direction; continuing`);
        }
        return;

      case 'STOP_AND_REWRITE_TASK': {
        const description = decision.rewrittenDescription?.trim();
        if (!description || description.trim() === task.description.trim()) {
          throw new Error('The supervisor requested a task rewrite without supplying changed requirements. Preserve the task and request a complete decision; do not verify the rejected approach.');
        }

        if (!this.stopForDecision(task, {
          status: 'PENDING',
          description,
          implVerifyPrompt: decision.implVerifyPrompt ?? task.implVerifyPrompt,
          solutionVerifyPrompt: decision.solutionVerifyPrompt ?? task.solutionVerifyPrompt,
          solutionVerifyCommand: decision.solutionVerifyCommand ?? task.solutionVerifyCommand,
          validationReport: '',
          finishedAt: null,
          supervisorFeedback: decision.reason,
          ...(attemptsExhausted(task) ? { attempts: 0 } : {}),
        })) {
          return;
        }
        this.queue.log(task.id, 'supervisor', 'task-edited', description.slice(0, 8000));
        this.log(`task ${task.seq} stopped and rewritten from live quality evidence`);
        return;
      }

      case 'STOP_AND_REWRITE_VALIDATION': {
        const hasRewrite = (['implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand'] as const)
          .some((field) => decision[field] !== undefined && decision[field]!.trim() !== task[field].trim());
        if (!hasRewrite) {
          throw new Error('The supervisor requested a validation rewrite without changed checks. Preserve the task and request a complete decision; do not run the rejected checks.');
        }

        if (!this.stopForDecision(task, {
          status: 'PENDING',
          implVerifyPrompt: decision.implVerifyPrompt ?? task.implVerifyPrompt,
          solutionVerifyPrompt: decision.solutionVerifyPrompt ?? task.solutionVerifyPrompt,
          solutionVerifyCommand: decision.solutionVerifyCommand ?? task.solutionVerifyCommand,
          validationReport: '',
          finishedAt: null,
          supervisorFeedback: decision.reason,
          ...(attemptsExhausted(task) ? { attempts: 0 } : {}),
        })) {
          return;
        }
        this.queue.log(task.id, 'supervisor', 'validation-edited', decision.reason.slice(0, 8000));
        this.log(`task ${task.seq} stopped and its validation contract was rewritten`);
        return;
      }

      case 'START_VALIDATION':
        if (!this.stopForDecision(task, {
          status: 'VERIFYING',
          validationReport: '',
          finishedAt: null,
          supervisorFeedback: decision.reason,
        })) {
          return;
        }
        await this.verifyWithExecutor(this.queue.get(task.id) ?? task, review);
        return;
    }
  }

  /** Fences a running executor before killing it, so its late result cannot land. */
  protected stopForDecision(task: Task, patch: Partial<Task>): boolean {
    if (task.status === 'EXECUTING') {
      if (!this.queue.finishExecution(task.id, task.attempts, patch)) {
        return false;
      }
      this.executionScope?.close();
      this.executionScope = undefined;
      this.executionGen = (this.executionGen ?? 0) + 1;
      const abort = this.executionAbort;
      this.executionAbort = null;
      try {
        abort?.();
      } catch {
        /* the executor already stopped after the supervisor's snapshot */
      }
      return true;
    }
    this.queue.update(task.id, patch);
    return true;
  }
}
