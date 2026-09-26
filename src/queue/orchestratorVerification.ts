import { SupervisorDecision } from './agents';
import { Task } from './db';
import { OrchestratorScope } from './orchestratorScope';
import { verdictReplacementTasks } from './scopeVerdict';
import { decompositionFamily, requiresDecomposition } from './recoveryDecomposition';

/** A verdict belongs to one claim, contract and report, not merely a row ID. */
function sameVerificationSnapshot(current: Task | undefined, snapshot: Task): boolean {
  return !!current && current.status === 'VERIFYING' && current.status === snapshot.status &&
    (['createdAt', 'startedAt', 'attempts', 'seq', 'title', 'kind', 'region',
      'description', 'solutionVerifyPrompt',
      'output', 'validationReport'] as const)
      .every(key => current[key] === snapshot[key]);
}

export abstract class OrchestratorVerification extends OrchestratorScope {

  protected verificationIdentity(task: Task): string {
    return JSON.stringify([task.createdAt, task.startedAt, task.attempts, task.title, task.kind, task.region, task.splitScope, task.description,
      task.solutionVerifyPrompt, task.output,
      this.queue.getMeta('goal'), this.queue.contextInstructions, this.queue.testingContext, this.queue.instructions]);
  }

  protected currentHostVerification(task: Task): boolean {
    return this.queue.getMeta(`verificationAccepted:${task.id}`) ===
      JSON.stringify([this.verificationIdentity(task), task.validationReport]);
  }

  /** Completed stages should not wait for the periodic liveness scan. */
  protected wakeAfterHandoff(): void {
    setTimeout(() => {
      this.schedule('handoff supervisor check', () => {
        if (!this.disposed && this.queue.runState === 'RUNNING') return this.tick();
        return Promise.resolve();
      });
    }, 0);
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
    // original handoff. splitTask inserts every child and deletes the parent in
    // one transaction. Its task_events no longer cascade away with it (see
    // dbStorage's task_events schema) and stay queryable by this id, so this
    // snapshot only needs the contract and verdict, not a duplicate journal.
    this.queue.setMeta(archiveKey, JSON.stringify({ task, decision,
      ownerContext: JSON.stringify([this.queue.getMeta('goal'), this.queue.testingContext + this.queue.instructions]),
      events: this.queue.events(task.id, -1), archivedAt: Date.now() }));
    if (this.queue.splitTask(task.id, parts) !== parts.length) throw Error('The original task no longer accepts this replacement.');
    // The replacement is committed and the original row is gone. Stop anything
    // still running on it — a split must never leave the old worker editing the
    // workspace after its task no longer exists — then fence the review.
    const active = this.queue.activeTask();
    if (task.status === 'EXECUTING' || (active && active.seq > task.seq)) this.abandonExecution();
    this.abandonReview();
    this.reviewed.delete(task.id);
    this.queue.log(null, 'supervisor', 'scope-split', `${archiveKey}: committed ${parts.length} ordered replacement tasks`);
    this.log(`task ${task.seq} retired and replaced by ${parts.length} tasks; existing work preserved`);
    this.changed();
    this.wakeAfterHandoff();
    return true;
  }
}
