import type { Task } from './db';
import { OrchestratorRecovery } from './orchestratorRecovery';
import { requiresDecomposition } from './recoveryDecomposition';

/**
 * Terminal failure policy.
 *
 * A task the queue cannot complete is BLOCKED for a person. It is never split
 * into smaller tasks: splitting a verification failure turned one read-only
 * "inspect the checklist" task into ~50 generations of "verify the previous
 * verification" children, because a smaller verification task is harder to
 * satisfy than its parent, not easier. Decomposition now happens only at plan
 * time (phase expansion, orchestratorExpansion); a failure is a stop, not a
 * multiplication.
 *
 * The whole failure-decomposition planner (failureDecomposition.ts), its
 * retry/stall lineage accounting, and the verdict/scope split entry points on
 * this path have been removed.
 */
export abstract class OrchestratorDecomposition extends OrchestratorRecovery {

  /** Bootstrap repair no longer decomposes; the supervisor handles the task directly. */
  protected requireBootstrapRepair(_task: Task): boolean {
    return false;
  }

  /** The one exit for a task the queue cannot complete: block it for a person. */
  protected blockForHuman(snapshot: Task, reason: string): void {
    this.blockTask(snapshot, reason);
  }

  /**
   * Legacy compatibility only. Rows still marked `decomposition_*` by an older
   * build (or forced into that phase by the SQL invariant in dbRecovery) are
   * blocked for a human instead of being replanned into more tasks.
   */
  protected async serviceFailureDecomposition(snapshot: Task): Promise<boolean> {
    const task = this.queue.get(snapshot.id);
    if (!task || !requiresDecomposition(task)) return false;
    this.blockTask(task,
      task.activityDetail || task.supervisorFeedback || task.errorLog ||
      'This task was marked as requiring decomposition by an older build. Automatic ' +
      'decomposition on failure is disabled; it needs a human decision (reset, edit or delete).');
    return true;
  }
}
