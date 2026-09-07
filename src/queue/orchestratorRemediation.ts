import type { Task } from './db';
import type { SupervisorDecision } from './agents';
import { OrchestratorRecovery } from './orchestratorRecovery';
import type { Review } from './orchestratorState';
import { LiveLog } from './liveLog';
import { decideRecovery, recoveryOperation } from './recoveryDecision';
import { decisionEvidence, recoveryContext, recoveryEvidence } from './recovery';
import { readRecoveryJob, RecoveryOutcome, recoveryStrategyFingerprint, rememberRecoveryStrategy } from './recoverySchedule';
import { boundedTask } from './scopeBoundary';
import { verificationAuthority } from './verificationAuthority';
import { implementationRetryProblem } from './verificationRecovery';

/** Recovery changes the next operation, not the owner's task or its acceptance criteria. */
export abstract class OrchestratorRemediation extends OrchestratorRecovery {
  protected abstract verifyWithExecutor(task: Task, review: Review): Promise<void>;
  protected abstract applyVerdictSplit(task: Task, decision: SupervisorDecision, current: () => boolean): boolean;

  protected async performRecovery(task: Task, reason: string): Promise<RecoveryOutcome> {
    const review = this.review;
    if (!review || review.taskId !== task.id) throw Error('Recovery has no fenced review owner.');
    const ownerContext = () => JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
      this.queue.testingContext, this.queue.instructions]);
    const owner = ownerContext();
    const evidenceAtDecision = decisionEvidence(this.queue, task);
    const accepts = () => {
      const current = this.queue.get(task.id);
      return !this.disposed && this.queue.runState === 'RUNNING' && review.gen === this.reviewGen &&
        current?.status === 'VERIFYING' && owner === ownerContext() &&
        decisionEvidence(this.queue, task) <= evidenceAtDecision &&
        (['createdAt', 'attempts', 'startedAt', 'description', 'implVerifyPrompt', 'solutionVerifyPrompt',
          'solutionVerifyCommand', 'region', 'output', 'validationReport'] as const).every(key => current[key] === task[key]);
    };
    const live = new LiveLog(this.queue, task.id, 'supervisor');
    try {
      const evidence = JSON.stringify({ reason, ledger: recoveryContext(this.queue, task),
        checkAuthority: verificationAuthority(this.queue, task),
        scheduled: readRecoveryJob(this.queue, task), ownerGoal: this.queue.getMeta('goal'),
        ownerNotes: this.queue.contextInstructions, report: recoveryReport(task.validationReport),
        history: this.queue.events(task.id, 48, true)
          .filter(event => event.actor !== 'supervisor' || /error|failed|recovery-|check-fixed|scope-edit-rejected/.test(event.kind))
          .map(event => ({ id: event.id, actor: event.actor, kind: event.kind, message: event.message.slice(0, 2400) })),
        executorHandoff: task.output.slice(0, 4000) });
      const result = await decideRecovery(this.context, this.output, boundedTask(task), evidence, {
        onAbort: abort => { if (!accepts()) abort(); else review.abort = abort; },
        onEvent: (method, params) => { if (accepts()) live.onEvent(method, params); },
        onActivity: activity => { if (accepts()) { review.lastActivityAt = activity.at; live.activity(activity); } },
      });
      if (!accepts()) return { status: 'deferred', reason: 'Recovery was superseded; discard its decision.' };
      this.queue.addUsage(task.id, result.usage);
      const decision = result.decision;
      this.queue.log(task.id, 'supervisor', 'recovery-decision', JSON.stringify(decision));
      if (decision.action === 'WAIT') return { status: 'deferred', reason: decision.reason + '\n' + decision.guidance,
        retryAfterMs: decision.retryAfterMs };
      const retryProblem = decision.action === 'EXECUTE' ? implementationRetryProblem(task) : '';
      if (retryProblem) return { status: 'deferred', reason: retryProblem };
      // A genuinely changed tool outcome can justify repeating a check after a
      // repair. Attempts, waiting, new prose, and reloads cannot change this key.
      const strategy = recoveryStrategyFingerprint({ operation: recoveryOperation(decision),
        evidenceRevision: recoveryEvidence(this.queue, task).revision });
      if (!rememberRecoveryStrategy(this.queue, task, strategy)) return { status: 'deferred',
        reason: 'The proposed operation already failed or was admitted. Obtain a different observation or approach.', strategy };
      if (decision.action === 'SPLIT') {
        if (!this.applyVerdictSplit(task, { verdict: 'SPLIT', feedback: decision.reason,
          splitInto: decision.splitInto, usage: result.usage }, accepts)) throw Error('Replacement was superseded before commit.');
        return { status: 'applied' };
      }
      const feedback = `Recovery diagnosis: ${decision.reason}\nNext approach: ${decision.guidance}\n` +
        `Next operation: ${JSON.stringify(decision.nextOperation)}\nRetain all assigned requirements and existing successful work.`;
      // Retain the old report until a new verifier or worker actually produces evidence.
      this.queue.update(task.id, { supervisorFeedback: feedback,
        ...(decision.action === 'EXECUTE' ? { status: 'PENDING' as const, finishedAt: null, activityPhase: 'recovery_execution' } : {}) });
      if (decision.action === 'VERIFY') {
        await this.verifyWithExecutor(this.queue.get(task.id)!, review);
        if (review.gen !== this.reviewGen || this.queue.runState !== 'RUNNING' || owner !== ownerContext()) {
          return { status: 'deferred', reason: 'Verification superseded.' };
        }
        const current = this.queue.get(task.id);
        if (!current?.validationReport || current.validationReport === task.validationReport) {
          return { status: 'deferred', reason: 'Verification produced no new host report. Diagnose the captured invocation failure.', strategy };
        }
      }
      this.wakeAfterHandoff();
      return { status: 'applied' };
    } catch (error: any) {
      if (accepts() && error?.usage) {
        this.queue.addUsage(task.id, error.usage);
        // This layer owns the planner's usage. The scheduler must not count it twice.
        delete error.usage;
      }
      throw error;
    } finally { live.close(); }
  }
}

/** The diagnosis needs captured failures, not pages of the previous model's self-praise. */
function recoveryReport(serialized: string): unknown {
  try {
    const report = JSON.parse(serialized);
    return { conclusion: report.conclusion, remaining: report.remaining,
      claimedChecks: report.checks, observedTools: report.observedTools,
      verificationPlan: report.verificationPlan, verificationReceipts: report.verificationReceipts };
  } catch { return serialized.slice(0, 8000); }
}
