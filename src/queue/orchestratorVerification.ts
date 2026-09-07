import { superviseTask, SupervisorDecision } from './agents';
import { Task } from './db';
import { LiveLog } from './liveLog';
import { shellWaitViolation, VALIDATION_FAILED } from './monitor';
import { OrchestratorScope } from './orchestratorScope';
import { scopeBlocked } from './scopePlan';
import { appendAttempt, Review } from './orchestratorState';
import { runVerification } from './verification';
import { recoveryFailure, recoveryState, recoverySucceeded } from './recovery';
import { boundedTask } from './scopeBoundary';

/** A verdict belongs to one claim, contract and report, not merely a row ID. */
function sameVerificationSnapshot(current: Task | undefined, snapshot: Task): boolean {
  return !!current && current.status === 'VERIFYING' && current.status === snapshot.status &&
    (['createdAt', 'startedAt', 'attempts', 'seq', 'title', 'kind', 'region',
      'description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
      'output', 'validationReport'] as const)
      .every(key => current[key] === snapshot[key]);
}

export abstract class OrchestratorVerification extends OrchestratorScope {

  /** Delegates formal verification to a fresh execution LLM and persists its response. */
  protected async verifyWithExecutor(task: Task, review: Review): Promise<void> {
    const accepts = () => review.gen === this.reviewGen &&
      sameVerificationSnapshot(this.queue.get(task.id), task);
    if (!accepts()) return;
    if (scopeBlocked(task, this.queue.list())) return;
    const blocked = recoveryState(this.queue, task).blocked;
    if (blocked) { this.pauseForRecovery(task, blocked); return; }
    this.log(`task ${task.seq} — supervisor started independent verification`);
    this.queue.log(task.id, 'supervisor', 'validation-started', 'delegated to execution LLM');
    const journal = this.streamJournal(task.id, 'validator', accepts);
    const scope = this.scopeWatch(task, 'validator', accepts, (phase, detail, at) => {
        if (!accepts()) return;
        review.lastActivityAt = at;
        this.queue.recordActivity(task.id, phase, detail, 'supervisor');
      });
    review.scope = scope;
    try {
      if (!await scope.preflight() || !accepts()) return;
      const result = await runVerification(
        this.context,
        this.output,
        boundedTask(task),
        this.queue.getMeta('goal'),
        (activity) => {
          if (!accepts()) return;
          review.lastActivityAt = activity.at;
          review.validationToolViolation = shellWaitViolation(activity.phase, activity.detail) || undefined;
          journal.live.activity(activity);
          if (this.queue.recordActivity(task.id, activity.phase, activity.detail, 'validator')) {
            this.changed();
          }
        },
        (method, params) => {
          if (accepts()) { journal.onEvent(method, params); scope.observe(method, params); }
        },
        (abort) => {
          if (!accepts()) { abort(); return; }
          review.abort = abort;
        },
        this.queue.contextInstructions,
      );
      journal.flush();
      if (!accepts()) {
        this.log(`task ${task.seq} moved while validation ran; validator response ignored`);
        return;
      }
      this.queue.addUsage(task.id, result.usage);
      this.queue.update(task.id, {
        validationReport: result.validationReport,
        finishedAt: Date.now(),
      });
      this.queue.log(task.id, 'validator', 'response', result.text.slice(0, 8000));
      this.queue.log(task.id, 'validator', 'validation', result.validationReport.slice(0, 8000));
      this.log(`task ${task.seq} — independent verification response stored`);
    } catch (error: any) {
      journal.flush();
      if (!accepts()) return;
      const message = String(error?.message ?? error);
      // Recorded twice on purpose, because two different readers need it. The
      // journal entry is what `failedValidations` counts, so the next progress
      // review knows this has already been tried; the error log is what
      // `attemptHistory` shows a later supervision verdict, which never sees
      // the journal at all. Without either, a validator that fails the same way
      // every time is re-launched forever by a supervisor with no way to know.
      this.queue.log(task.id, 'validator', VALIDATION_FAILED, message);
      const current = this.queue.get(task.id);
      if (current) {
        this.queue.update(task.id, {
          errorLog: appendAttempt(
            current.errorLog,
            `[attempt ${current.attempts}] independent validation did not complete: ${message}.`,
          ),
          activityPhase: 'needs_review',
        });
      }
      this.log(`task ${task.seq} — validator stopped: ${message}; supervisor will reassess`);
    } finally {
      scope.close();
      journal.live.close();
      // Both paths above have written to the task -- tokens at least, usually
      // a report as well -- and neither had any other reason to redraw. The
      // executor fires this from its own finally (see runExecution) and
      // supervise() ends with it, so a validator that stayed silent was the
      // one turn whose cost and verdict reached the database without ever
      // reaching the view.
      this.changed();
    }
  }

  /** Runs the full verification pass for one task and applies the verdict. */
  protected async startIndependentVerification(task: Task): Promise<void> {
    const review: Review = { taskId: task.id, seq: task.seq, gen: ++this.reviewGen, lastActivityAt: Date.now() };
    this.review = review;
    try {
      await this.verifyWithExecutor(task, review);
    } finally {
      if (this.review === review) this.review = null;
    }
  }

  /** Completed stages should not wait for the periodic liveness scan. */
  protected wakeAfterHandoff(): void {
    setTimeout(() => {
      if (!this.disposed && this.queue.runState === 'RUNNING') void this.tick();
    }, 0);
  }

  /** Runs the full verification pass for one task and applies the verdict. */
  protected async supervise(task: Task): Promise<void> {
    if (!sameVerificationSnapshot(this.queue.get(task.id), task)) return;
    this.log(`supervising task ${task.seq} — ${task.title}`);

    // From here until the verdict lands there is a turn running that only this
    // record can account for — see sweepSilentReview.
    const gen = ++this.reviewGen;
    const accepts = () => gen === this.reviewGen &&
      sameVerificationSnapshot(this.queue.get(task.id), task);
    const review: Review = { taskId: task.id, seq: task.seq, gen, lastActivityAt: Date.now() };
    this.review = review;

    // See reviewWork: the verdict is watchable while it is being reached.
    const live = new LiveLog(this.queue, task.id, 'supervisor');
    let decision: SupervisorDecision;
    try {
      // The goal is what the plan was generated from; on every review the
      // supervisor rebuilds the task against it rather than against the text
      // that has been failing. See ceilingNotice.
      decision = await superviseTask(
        this.context,
        this.output,
        boundedTask(task),
        this.rewrites(task),
        this.queue.getMeta('goal'),
        {
          projectNotes: this.queue.contextInstructions,
          onAbort: (abort) => {
            if (!accepts()) { abort(); return; }
            review.abort = abort;
          },
          onEvent: this.observerEvents(task.id, 'supervisor', live, accepts),
          onActivity: (a) => {
            if (!accepts()) return;
            review.lastActivityAt = a.at;
            live.activity(a);
            if (this.queue.recordActivity(task.id, a.phase, a.detail, 'supervisor')) {
              this.changed();
            }
          },
        },
      );
    } catch (e: any) {
      if (!accepts()) return;
      const message = String(e?.message ?? e);
      this.log(`supervisor failed on task ${task.seq}: ${message}`);
      this.queue.log(task.id, 'supervisor', 'error', message);
      // See reviewWork: the failure has to reach the row, not just the log.
      this.queue.recordActivity(task.id, 'error', `supervisor: ${message}`, 'supervisor');
      live.note('error', `supervisor failed: ${message}`);
      this.changed();
      const limit = recoveryFailure(this.queue, task, 'verification-review');
      if (limit) await this.replanOrPause(task, limit);
      // Leave it in VERIFYING; the next tick tries again.
      return;
    } finally {
      live.close();
      if (this.review === review) {
        this.review = null;
      }
    }

    // A review the sweep already gave up on has no say: the task may have been
    // reviewed again, or reset, since this turn stopped writing.
    if (!accepts()) {
      this.log(`task ${task.seq} — a verdict arrived from an abandoned review; ignoring it`);
      return;
    }

    this.queue.addUsage(task.id, decision.usage);
    recoverySucceeded(this.queue, task, 'verification-review');
    if (['RETRY', 'REVERIFY', 'RESET_FROM'].includes(decision.verdict) &&
        !await this.allowRecovery(task, decision.verdict)) return;
    if (!accepts()) return;
    this.queue.log(task.id, 'supervisor', `verdict:${decision.verdict}`, decision.feedback);
    this.applyTaskEdits(decision, task.seq);

    switch (decision.verdict) {
      case 'REVERIFY': {
        this.queue.update(task.id, {
          validationReport: '', finishedAt: null, supervisorFeedback: decision.feedback,
        });
        const verification: Review = {
          taskId: task.id, seq: task.seq, gen: ++this.reviewGen, lastActivityAt: Date.now(),
        };
        this.review = verification;
        try {
          await this.verifyWithExecutor(this.queue.get(task.id) ?? task, verification);
        } finally {
          if (this.review === verification) this.review = null;
        }
        if (this.queue.get(task.id)?.validationReport.trim()) this.wakeAfterHandoff();
        break;
      }
      case 'VERIFIED':
        this.queue.update(task.id, {
          status: 'VERIFIED',
          supervisorFeedback: decision.feedback,
          finishedAt: Date.now(),
        });
        this.log(`task ${task.seq} VERIFIED`);
        break;

      case 'SPLIT': {
        await this.replanOrPause(task, decision.feedback || 'Supervisor requested decomposition');
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
        // `attempts` counts attempts against the task as currently written, not
        // against the row. An escalated rewrite is a different task in all but
        // its id — the supervisor produced it knowing the budget was spent, and
        // working from the run's original goal rather than from the text that
        // kept failing — so the budget starts again with it. Without this reset
        // the counter runs past the ceiling it is displayed against and stops
        // meaning anything, which is what "attempt 7 of 3" was.
        const restart = decision.escalated === true;
        this.queue.update(task.id, {
          status: 'PENDING',
          supervisorFeedback: decision.feedback,
          errorLog: appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] ${decision.feedback}`,
          ),
          finishedAt: null,
          ...(restart ? { attempts: 0 } : {}),
        });
        this.log(
          restart
            ? `task ${task.seq} spent its ${task.maxAttempts} attempts and was rebuilt by the ` +
              'supervisor; back to PENDING with a fresh budget'
            : `task ${task.seq} rewritten by the supervisor; ` +
              `back to PENDING for attempt ${task.attempts + 1}`,
        );
        break;
      }
    }
    this.changed();
  }

  /** How many times the supervisor has already rewritten this task. */
  protected rewrites(task: Task): number {
    return this.queue.countEvents(task.id, 'task-edited');
  }

  /**
   * Applies the supervisor's rewrites.
   *
   * Edits are matched by `seq`, which is the number the supervisor was shown and
   * the only handle it has on a task. A rewrite that lands nowhere is worth
   * saying out loud: on the current task it is the difference between a retry
   * with new instructions and the same attempt run twice.
   */
  protected applyTaskEdits(decision: SupervisorDecision, currentSeq?: number): void {
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
        implVerifyPrompt: edit.implVerifyPrompt ?? target.implVerifyPrompt,
        solutionVerifyPrompt: edit.solutionVerifyPrompt ?? target.solutionVerifyPrompt,
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
}
