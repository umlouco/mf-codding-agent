import type { Task } from './db';
import { OrchestratorWatchdog } from './orchestratorWatchdog';
import type { ScopeRole } from './scopePlan';
import type { ScopeSupervisor } from './scopeSupervisor';
import { blockRecovery, recoveryRequest, recoveryState } from './recovery';

/** One bounded re-plan, then a durable stop. Never erase or declare work done. */
export abstract class OrchestratorRecovery extends OrchestratorWatchdog {
  protected abstract scopeWatch(task: Task, role: ScopeRole, current: () => boolean,
    activity: (phase: string, detail: string, at: number) => void): ScopeSupervisor;

  protected async allowRecovery(task: Task, reason: string): Promise<boolean> {
    const limit = recoveryRequest(this.queue, task);
    if (!limit) return true;
    await this.replanOrPause(task, `${limit} Proposed action: ${reason}`);
    return false;
  }

  protected pauseForRecovery(task: Task, reason: string): void {
    const message = `${reason} Work and verification evidence are preserved. ` +
      'Edit this task into a bounded, materially different contract or explicitly reset it before restarting.';
    blockRecovery(this.queue, task, message);
    this.queue.log(task.id, 'supervisor', 'recovery-blocked', message);
    this.pause();
    this.queue.update(task.id, { supervisorFeedback: message, activityPhase: 'recovery_blocked', activityDetail: message });
    this.log(`task ${task.seq}: ${message}`);
    this.changed();
  }

  protected async replanOrPause(snapshot: Task, reason: string): Promise<void> {
    let task = this.queue.get(snapshot.id);
    if (!task || this.disposed || this.queue.runState !== 'RUNNING') return;
    const blocked = recoveryState(this.queue, task).blocked;
    if (blocked) { this.pauseForRecovery(task, blocked); return; }
    // Freeze the work before planning so a replaying worker cannot veto every split
    // as stale. Existing source edits, handoff, reports and journal stay intact.
    this.stopForDecision(task, { status: 'VERIFYING', activityPhase: 'needs_review' });
    this.abandonReview();
    task = this.queue.get(snapshot.id)!;
    const frozen = task;
    const ownerContext = JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions]);
    const gen = ++this.reviewGen;
    const review = { taskId: task.id, seq: task.seq, gen, lastActivityAt: Date.now(),
      scope: undefined as ScopeSupervisor | undefined };
    this.review = review;
    this.supervising = true;
    // Persist BEFORE awaiting the planner: a crash cannot buy another recovery.
    blockRecovery(this.queue, task, `${reason} Automatic scope re-plan was already requested.`);
    this.queue.log(task.id, 'supervisor', 'recovery-replan', reason);
    const current = () => {
      const latest = this.queue.get(frozen.id);
      return gen === this.reviewGen && latest?.status === 'VERIFYING' &&
        (['startedAt', 'attempts', 'description', 'implVerifyPrompt', 'solutionVerifyPrompt',
          'solutionVerifyCommand', 'validationReport', 'region'] as const).every(key => latest[key] === frozen[key]) &&
        ownerContext === JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions]);
    };
    const scope = this.scopeWatch(task, 'executor', current, (phase, detail, at) => {
        if (!current()) return;
        review.lastActivityAt = at;
        this.queue.recordActivity(task!.id, phase, detail, 'supervisor');
      });
    review.scope = scope;
    try {
      await scope.preflight();
      if (!current()) return; // Split applied, contract edited or user stopped.
      this.pauseForRecovery(task, `${reason} Scope review did not produce a complete, safe replacement plan.`);
    } catch (error: any) {
      if (current()) {
        this.pauseForRecovery(task, `${reason} Re-plan failed: ${error?.message ?? error}`);
      }
    } finally {
      scope.close();
      if (this.review === review) { this.review = null; this.supervising = false; }
    }
  }
}
