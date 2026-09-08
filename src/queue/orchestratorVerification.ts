import { superviseTask, SupervisorDecision } from './agents';
import { Task } from './db';
import { LiveLog } from './liveLog';
import { shellWaitViolation, VALIDATION_FAILED } from './monitor';
import { OrchestratorScope } from './orchestratorScope';
import { scopeBlocked } from './scopePlan';
import { appendAttempt, Review } from './orchestratorState';
import { runVerification } from './verification';
import { recoveryFailure, recoverySucceeded, recoveryContext } from './recovery';
import { completeRecoveryJob } from './recoverySchedule';
import { storedValidationProblem } from './validation';
import { boundedTask } from './scopeBoundary';
import { verdictReplacementTasks } from './scopeVerdict';
import { isLocalScope } from './scopeContract';
import { verificationAuthority } from './verificationAuthority';
import { implementationRetryProblem } from './verificationRecovery';
import { decompositionFamily, requiresDecomposition } from './recoveryDecomposition';

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
    if (!sameVerificationSnapshot(this.queue.get(task.id), task) || review.gen !== this.reviewGen) return;
    if (requiresDecomposition(task)) return;
    if (scopeBlocked(task, this.queue.list())) return;
    if (this.correctTestingTarget(task)) return;
    if (this.queue.countEvents(task.id, 'verification-pass', true) >= 2) {
      this.requestFailureDecomposition(task, 'Two verification passes did not establish completion. ' +
        (task.supervisorFeedback || task.validationReport || 'See the validator journal for the missing check.'));
      return;
    }
    this.queue.log(task.id, 'validator', 'verification-pass', 'Focused independent verification; at most two passes per task.');
    completeRecoveryJob(this.queue, task);
    const ownerContext = JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
      this.queue.testingContext, this.queue.instructions]);
    const accepts = () => review.gen === this.reviewGen &&
      ownerContext === JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
        this.queue.testingContext, this.queue.instructions]) &&
      sameVerificationSnapshot(this.queue.get(task.id), task);
    if (!accepts()) return;
    this.log(`task ${task.seq} — supervisor started independent verification`);
    this.queue.log(task.id, 'supervisor', 'validation-started', 'delegated to execution LLM');
    const journal = this.streamJournal(task.id, 'validator', accepts);
    try {
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
          if (accepts()) { journal.onEvent(method, params); }
        },
        (abort) => {
          if (!accepts()) { abort(); return; }
          review.abort = abort;
        },
        this.queue.testingContext + this.queue.instructions,
        verificationAuthority(this.queue, task),
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
      this.queue.setMeta(`verificationAccepted:${task.id}`,
        JSON.stringify([this.verificationIdentity(task), result.validationReport]));
      this.queue.log(task.id, 'validator', 'response', result.text.slice(0, 8000));
      this.queue.log(task.id, 'validator', 'validation', result.validationReport.slice(0, 8000));
      this.log(`task ${task.seq} — independent verification response stored`);
    } catch (error: any) {
      journal.flush();
      if (!accepts()) return;
      if (error?.usage) {
        this.queue.addUsage(task.id, error.usage);
        delete error.usage;
      }
      if (typeof error?.validationReport === 'string' && error.validationReport.trim()) {
        this.queue.update(task.id, { validationReport: error.validationReport });
      }
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
      if (!error?.validationReport) this.queue.update(task.id, { validationReport: JSON.stringify({ conclusion: 'INCOMPLETE',
        summary: message, implementationEvidence: '', behaviorEvidence: '', checks: [], remaining: message }) });
      this.queue.setMeta(`verificationAccepted:${task.id}`,
        JSON.stringify([this.verificationIdentity(task), this.queue.get(task.id)!.validationReport]));

    } finally {
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

  private verificationIdentity(task: Task): string {
    return JSON.stringify([task.createdAt, task.startedAt, task.attempts, task.title, task.kind, task.region, task.splitScope, task.description,
      task.implVerifyPrompt, task.solutionVerifyPrompt, task.solutionVerifyCommand, task.output,
      this.queue.getMeta('goal'), this.queue.contextInstructions, this.queue.testingContext, this.queue.instructions]);
  }

  protected currentHostVerification(task: Task): boolean {
    return this.queue.getMeta(`verificationAccepted:${task.id}`) ===
      JSON.stringify([this.verificationIdentity(task), task.validationReport]);
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
    if (requiresDecomposition(task)) return;
    if (!storedValidationProblem(task.validationReport) && this.currentHostVerification(task)) {
      this.queue.update(task.id, { status: 'VERIFIED', finishedAt: Date.now(),
        supervisorFeedback: 'Independent verification passed the assigned checks.' });
      completeRecoveryJob(this.queue, task);
      this.queue.log(task.id, 'supervisor', 'verdict:VERIFIED', 'Accepted current host-backed independent verification.');
      this.changed();
      this.wakeAfterHandoff();
      return;
    }
    if (this.queue.countEvents(task.id, 'verification-decision', true) >= 2) {
      this.requestFailureDecomposition(task, 'Verification recovery did not resolve the task after two decisions. ' +
        (task.supervisorFeedback || task.validationReport));
      return;
    }
    this.queue.log(task.id, 'supervisor', 'verification-decision', 'Review only the unresolved verification result.');
    this.log(`supervising task ${task.seq} — ${task.title}`);

    // From here until the verdict lands there is a turn running that only this
    // record can account for — see sweepSilentReview.
    const gen = ++this.reviewGen;
    const ownerContext = JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
      this.queue.testingContext, this.queue.instructions]);
    const accepts = () => gen === this.reviewGen &&
      ownerContext === JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
        this.queue.testingContext, this.queue.instructions]) &&
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
          projectNotes: this.queue.testingContext + this.queue.instructions,
          failedRepairs: this.queue.countEvents(task.id, 'test-repair-halted'),
          recoveryContext: recoveryContext(this.queue, task),
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
    const retryProblem = ['RETRY', 'RESET_FROM'].includes(decision.verdict) ? implementationRetryProblem(task) : '';
    if (retryProblem) {
      this.queue.log(task.id, 'supervisor', 'retry-evidence-rejected', decision.feedback);
      decision = { ...decision, verdict: 'REVERIFY', feedback: retryProblem, taskEdits: [], splitInto: undefined, escalated: false };
    }
    // Keep the diagnosis and any admitted correction even when the next action
    // needs scheduled recovery. Previously the sixth correction was discarded.
    this.queue.log(task.id, 'supervisor', `verdict:${decision.verdict}`, decision.feedback);
    if (decision.verdict !== 'SPLIT') {
      this.applyTaskEdits(decision, task.seq);
      task = this.queue.get(task.id) ?? task;
    }
    if (['RETRY', 'REVERIFY', 'RESET_FROM'].includes(decision.verdict) &&
        !await this.allowRecovery(task, decision.verdict)) return;
    if (!accepts()) return;
    if (decision.verdict === 'SPLIT') {
      // A supplied plan has already been decided. Asking another planner whether
      // to split discards that decision and can leave the original runnable forever.
      // Edits accompanying SPLIT are deliberately ignored: this transition only
      // replaces the reviewed row, and sequence numbers move when it commits.
      if (!decision.splitInto?.length) {
        await this.replanOrPause(task, decision.feedback || 'Supervisor requested decomposition');
      } else {
        try { this.applyVerdictSplit(task, decision, accepts); }
        catch (error: any) {
          if (accepts()) this.requestFailureDecomposition(task, `Replacement plan could not be committed: ${error?.message ?? error}`);
        }
      }
      this.changed();
      return;
    }
    switch (decision.verdict) {
      case 'REPAIR_TESTS':
        await this.repairTests(task, decision.feedback);
        break;
      case 'REVERIFY': {
        this.queue.update(task.id, {
          finishedAt: null, supervisorFeedback: decision.feedback,
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

  /** Persist all replacements before retiring callbacks; SQL failure keeps the parent intact. */
  protected applyVerdictSplit(snapshot: Task, decision: SupervisorDecision, current: () => boolean): boolean {
    const task = this.queue.get(snapshot.id);
    if (!task || !current() || this.disposed || this.queue.runState !== 'RUNNING' ||
      !sameVerificationSnapshot(task, snapshot)) return false;
    const archiveKey = `scopeSplit:${task.id}:${task.startedAt ?? task.createdAt}:verdict:` +
      this.queue.countEvents(task.id, 'verdict:SPLIT');
    const parts = verdictReplacementTasks(decision.splitInto!, task, archiveKey);
    if (requiresDecomposition(task)) for (const part of parts) {
      part.region = JSON.stringify({ ...JSON.parse(part.region || '{}'), failureFamily: decompositionFamily(task) });
    }
    // A rolled-back replacement may leave an unused archive, never a missing
    // original handoff. splitTask inserts every child and deletes the parent in one transaction.
    this.queue.setMeta(archiveKey, JSON.stringify({ task, decision,
      ownerContext: JSON.stringify([this.queue.getMeta('goal'), this.queue.testingContext + this.queue.instructions]),
      events: this.queue.events(task.id, -1), archivedAt: Date.now() }));
    if (this.queue.splitTask(task.id, parts) !== parts.length) throw Error('The original task no longer accepts this replacement.');
    const active = this.queue.activeTask();
    if (active && active.seq > task.seq) this.abandonExecution();
    this.abandonReview();
    this.reviewed.delete(task.id);
    this.queue.log(null, 'supervisor', 'scope-split', `${archiveKey}: committed ${parts.length} ordered replacement tasks`);
    this.log(`task ${task.seq} retired and replaced by ${parts.length} tasks; existing work preserved`);
    this.changed();
    this.wakeAfterHandoff();
    return true;
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
      if (decision.verdict === 'REVERIFY') {
        this.queue.log(target.id, 'supervisor', isLocalScope(target) ? 'scope-edit-rejected' : 'verification-edit-rejected',
          'Verification adapts a disposable host plan, never the stored task contract or required command.');
        continue;
      }
      if (isLocalScope(target)) {
        this.queue.log(target.id, 'supervisor', 'scope-edit-rejected',
          'The replacement contract is fixed. Use feedback to change the implementation approach, not its assigned outcome or checks.');
        this.log(`task ${target.seq}: retained its assigned replacement contract instead of re-authoring it`);
        continue;
      }
      const description = edit.description?.trim() || target.description;
      const patch = {
        description,
        implVerifyPrompt: edit.implVerifyPrompt ?? target.implVerifyPrompt,
        solutionVerifyPrompt: edit.solutionVerifyPrompt ?? target.solutionVerifyPrompt,
        solutionVerifyCommand: edit.solutionVerifyCommand ?? target.solutionVerifyCommand,
      };
      if (!Object.entries(patch).some(([key,value]) => target[key as keyof Task] !== value)) continue;
      this.stopForDecision(target, {...patch,validationReport:'',finishedAt:null,
        ...(target.status === 'EXECUTING' ? {status:'PENDING' as const} : {})});
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
