import type { Task } from './db';
import { OrchestratorWatchdog } from './orchestratorWatchdog';
import type { Review } from './orchestratorState';
import { acknowledgeRecovery, recoveryRequest, recoveryState } from './recovery';
import { beginRecoveryAttempt, completeRecoveryJob, deferRecoveryJob, hasRecoveryJob,
  readRecoveryJob, RecoveryOutcome, scheduleRecoveryJob } from './recoverySchedule';

/** Exhausted strategies become durable scheduled work. Only the operator stops a run. */
export abstract class OrchestratorRecovery extends OrchestratorWatchdog {
  protected abstract performRecovery(task: Task, reason: string): Promise<RecoveryOutcome>;

  protected async allowRecovery(task: Task, reason: string): Promise<boolean> {
    if (hasRecoveryJob(this.queue, task)) return false;
    const limit = recoveryRequest(this.queue, task);
    if (!limit) return true;
    await this.replanOrPause(task, `${limit} Proposed action: ${reason}`);
    return false;
  }

  /** Compatibility entry point for old call sites; this never calls pause/stop. */
  protected pauseForRecovery(snapshot: Task, reason: string): void {
    const task = this.queue.get(snapshot.id);
    if (!task || task.status === 'VERIFIED' || this.disposed || this.queue.runState !== 'RUNNING') return;
    const existed = hasRecoveryJob(this.queue, task);
    if (!this.stopForDecision(task, { status: 'VERIFYING', activityPhase: 'recovery_waiting' })) return;
    if (this.review?.taskId === task.id) this.abandonReview();
    const current = this.queue.get(task.id)!;
    const job = scheduleRecoveryJob(this.queue, current, reason);
    const detail = `${job.lastError || job.reason} Autonomous recovery is scheduled for ${new Date(job.dueAt).toISOString()}; ` +
      'the queue remains running and all work, requirements and verification evidence are retained.';
    this.queue.recordActivity(task.id, 'recovery_waiting', detail, 'supervisor');
    if (!existed) this.log(`task ${task.seq}: recovery scheduled, not paused: ${reason}`);
    this.changed();
    if (!existed) this.wakeAfterHandoff();
  }

  protected async replanOrPause(task: Task, reason: string): Promise<void> {
    this.pauseForRecovery(task, reason);
  }

  /** Called before either review lane. No provider call occurs before persisted dueAt. */
  protected async serviceRecovery(snapshot: Task): Promise<boolean> {
    let task = this.queue.get(snapshot.id);
    if (!task) return false;
    const blocked = recoveryState(this.queue, task).blocked;
    if (blocked && !hasRecoveryJob(this.queue, task)) this.pauseForRecovery(task, blocked);
    const pending = readRecoveryJob(this.queue, task);
    if (!pending?.active) return false;
    if (this.disposed || this.queue.runState !== 'RUNNING') return true;
    const job = beginRecoveryAttempt(this.queue, task);
    if (!job) return true;
    // A PENDING/EXECUTING legacy row must not be claimed while diagnosis is in flight.
    this.stopForDecision(task, { status: 'VERIFYING', activityPhase: 'recovery_diagnosing' });
    task = this.queue.get(task.id)!;
    const frozen = task;
    const ownerContext = JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
      this.queue.testingContext, this.queue.instructions]);
    const unchanged = () => {
      const current = this.queue.get(frozen.id);
      return current && (['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand', 'region'] as const)
        .every(key => current[key] === frozen[key]) &&
        ownerContext === JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
          this.queue.testingContext, this.queue.instructions]);
    };
    const review: Review = { taskId: task.id, seq: task.seq, gen: ++this.reviewGen, lastActivityAt: Date.now() };
    this.review = review;
    this.supervising = true;
    this.queue.recordActivity(task.id, 'recovery_diagnosing', `Bounded recovery attempt ${job.attempts}: ${job.reason}`, 'supervisor');
    this.changed();
    try {
      const result = await this.performRecovery(task, job.lastError ? `${job.reason}\nLast recovery failure: ${job.lastError}` : job.reason);
      if (this.disposed || this.queue.runState !== 'RUNNING') return true;
      const current = this.queue.get(task.id);
      if (!current || review.gen !== this.reviewGen) return true;
      if (result.status === 'applied') {
        acknowledgeRecovery(this.queue, current);
        completeRecoveryJob(this.queue, current);
        this.reviewed.delete(task.id);
      } else {
        if (!unchanged()) return true;
        const deferred = deferRecoveryJob(this.queue, current, result.reason, result.retryAfterMs, result.strategy);
        this.queue.recordActivity(task.id, 'recovery_waiting', `${result.reason} Next autonomous recovery: ${new Date(deferred.dueAt).toISOString()}.`, 'supervisor');
      }
    } catch (error: any) {
      if (!this.disposed && this.queue.runState === 'RUNNING' && review.gen === this.reviewGen && unchanged()) {
        const reason = String(error?.message ?? error);
        const deferred = deferRecoveryJob(this.queue, task, reason);
        this.queue.recordActivity(task.id, 'recovery_waiting', `${reason} Next autonomous recovery: ${new Date(deferred.dueAt).toISOString()}.`, 'supervisor');
        this.log(`task ${task.seq}: recovery deferred after error; queue remains running: ${reason}`);
      }
    } finally {
      if (this.review === review) this.review = null;
      this.changed();
    }
    return true;
  }
}
