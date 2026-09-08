import type { Task } from './db';
import type { SupervisorDecision } from './agents';
import type { Review } from './orchestratorState';
import { OrchestratorRecovery } from './orchestratorRecovery';
import { decideFailureDecomposition } from './failureDecomposition';
import { LiveLog } from './liveLog';
import { completeRecoveryJob } from './recoverySchedule';
import { decisionEvidence } from './recovery';
import { admitDecomposition, decompositionAncestry, decompositionDigest,
  decompositionWorkspaceRevision, readDecomposition, requiresDecomposition,
  saveDecomposition, scheduleDecomposition } from './recoveryDecomposition';

// Changing this is a host-strategy change, not new workspace evidence. It
// grants one newly bounded replacement-planning lane after a deployed parser
// or prompt repair, while preserving all prior rejected plans and their spend.
const DECOMPOSITION_STRATEGY = 'failure-decomposition-v2';

/** A rejected/exhausted task has only one exit: commit its complete replacement and retire its row. */
export abstract class OrchestratorDecomposition extends OrchestratorRecovery {
  protected abstract applyVerdictSplit(task: Task, decision: SupervisorDecision, current: () => boolean): boolean;

  protected requestFailureDecomposition(snapshot: Task, reason: string): void {
    const task = this.queue.get(snapshot.id);
    if (!task || task.status === 'VERIFIED' || this.disposed || this.queue.runState !== 'RUNNING') return;
    const existing = readDecomposition(this.queue, task);
    if (!this.stopForDecision(task, { status: 'VERIFYING', finishedAt: null,
      activityPhase: 'decomposition_required', activityDetail: reason.slice(0, 4000) })) return;
    // Fence this task's callback without releasing the cycle into a concurrent provider call.
    if (this.review?.taskId === task.id) {
      const old = this.review;
      this.review = null; this.reviewGen++;
      try { old.abort?.(); } catch { /* The completed/rejected turn may already be gone. */ }
    }
    scheduleDecomposition(this.queue, task, reason);
    completeRecoveryJob(this.queue, task);
    if (!existing) this.log(`task ${task.seq}: supervisor must replace this task with smaller work: ${reason}`);
    this.changed();
    if (!existing) this.wakeAfterHandoff();
  }

  protected decompositionWorkspaceRevision(): string {
    return decompositionWorkspaceRevision(this.workspaceRoot);
  }

  protected async serviceFailureDecomposition(snapshot: Task): Promise<boolean> {
    let task = this.queue.get(snapshot.id);
    if (!task || !requiresDecomposition(task)) return false;
    if (this.disposed || this.queue.runState !== 'RUNNING') return true;
    if (!readDecomposition(this.queue, task)) this.requestFailureDecomposition(task,
      task.activityDetail || task.supervisorFeedback || task.errorLog || 'Legacy failed task requires replacement.');
    task = this.queue.get(task.id)!;
    const job = readDecomposition(this.queue, task)!;
    const owner = () => JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
      this.queue.testingContext, this.queue.instructions]);
    const ownerAtStart = owner();
    const workspace = this.decompositionWorkspaceRevision();
    const evidence = decisionEvidence(this.queue, task);
    const contract = (row: Task) => JSON.stringify([row.createdAt, row.startedAt, row.attempts, row.title,
      row.description, row.implVerifyPrompt, row.solutionVerifyPrompt, row.solutionVerifyCommand,
      row.region, row.splitScope, row.output, row.validationReport]);
    const contractAtStart = contract(task);
    const fingerprint = decompositionDigest([DECOMPOSITION_STRATEGY, ownerAtStart, contractAtStart, workspace, evidence]);
    if (!admitDecomposition(this.queue, task, job, fingerprint)) {
      // A crash on the last admitted call must not leave a row claiming to be planning forever.
      if ((job.inputs[fingerprint] ?? 0) >= 3 && task.activityPhase !== 'decomposition_waiting') {
        this.queue.recordActivity(task.id, 'decomposition_waiting',
          'Decomposition allowance exhausted for unchanged input. Waiting for a changed workspace, owner requirement, or observed evidence.', 'supervisor');
        this.changed();
      }
      return true;
    }
    const review: Review = { taskId: task.id, seq: task.seq, gen: ++this.reviewGen, lastActivityAt: Date.now() };
    this.review = review;
    const accepts = () => {
      const current = this.queue.get(task!.id);
      return !this.disposed && this.queue.runState === 'RUNNING' && this.reviewGen === review.gen &&
        !!current && current.status === 'VERIFYING' && requiresDecomposition(current) &&
        contract(current) === contractAtStart && owner() === ownerAtStart &&
        decisionEvidence(this.queue, current) <= evidence;
    };
    this.queue.recordActivity(task.id, 'decomposition_planning',
      'Supervisor is replacing the rejected task; the original cannot execute again.', 'supervisor');
    const live = new LiveLog(this.queue, task.id, 'supervisor');
    this.changed();
    try {
      const decision = await decideFailureDecomposition(this.context, this.output, task, {
        goal: this.queue.getMeta('goal'),
        ownerInstructions: this.queue.contextInstructions + '\n' + this.queue.testingContext + this.queue.instructions,
        evidence: JSON.stringify({ reason: job.reason, errorLog: task.errorLog, report: task.validationReport.slice(0, 16000),
          events: this.queue.events(task.id, 16, true).map(event => ({ actor: event.actor, kind: event.kind, message: event.message.slice(0, 1500) })),
          remainingQueue: this.queue.list().filter(row => row.id !== task!.id)
            .map(row => ({ title: row.title, status: row.status })) }),
        handoff: task.output.slice(0, 8000), ancestry: decompositionAncestry(this.queue, task).map(parent => ({
          title: parent.title, description: parent.description, implVerifyPrompt: parent.implVerifyPrompt,
          solutionVerifyPrompt: parent.solutionVerifyPrompt, solutionVerifyCommand: parent.solutionVerifyCommand })),
        previousInvalidPlan: job.invalidPlan, previousError: job.lastError,
      }, {
        onAbort: abort => { if (!accepts()) abort(); else review.abort = abort; },
        onEvent: this.observerEvents(task.id, 'supervisor', live, accepts),
        onActivity: activity => { if (accepts()) { review.lastActivityAt = activity.at; live.activity(activity); } },
      });
      if (!accepts()) return true;
      this.queue.addUsage(task.id, decision.usage);
      if (this.decompositionWorkspaceRevision() !== workspace) throw Error('Workspace changed while replacement was planned; reassess current work.');
      if (!this.applyVerdictSplit(this.queue.get(task.id)!, decision, accepts)) {
        throw Error('Replacement was superseded before commit; no parent was deleted.');
      }
    } catch (error: any) {
      if (!accepts()) return true;
      if (error?.usage) this.queue.addUsage(task.id, error.usage);
      job.lastError = String(error?.message ?? error);
      job.invalidPlan = typeof error?.invalidPlan === 'string' ? error.invalidPlan : job.invalidPlan;
      job.awaitingChange = error?.invalidDecomposition === true || typeof error?.invalidPlan === 'string' || job.inputs[fingerprint] >= 3;
      saveDecomposition(this.queue, task, job);
      const next = job.awaitingChange ? 'Waiting for changed workspace, owner requirements, or observed evidence; no unchanged model retry.' :
        `Provider/commit retry after ${new Date(job.dueAt).toISOString()}.`;
      this.queue.recordActivity(task.id, 'decomposition_waiting', `${job.lastError} ${next}`, 'supervisor');
      this.queue.log(task.id, 'supervisor', 'decomposition-deferred', `${job.lastError} ${next}`);
      this.log(`task ${task.seq}: replacement not committed; original evidence retained. ${next}`);
    } finally {
      live.close();
      if (this.review === review) this.review = null;
      this.changed();
    }
    return true;
  }
}
