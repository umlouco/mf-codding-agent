import type { Task, TaskQueue } from './db';

const legacyTestGuard = /queue ownership:\s*the supervisor (?:must rewrite existing test|owns test rewrites)/i;
// Only the old installed core's wording qualifies. The current repair turn is
// deliberately confined to tests; its application-file refusal returns the task
// to its executor through repairTests, not through this migration.
const repairApplicationGuard = /queue ownership: supervisor test repair cannot rewrite application file[^\n]*preserving the original owner goal/i;

/** One migration retry for stopped workers from the old source/test ownership split. */
export function recoverOwnershipStop(queue: TaskQueue, task: Task): boolean {
  if (!['PENDING', 'VERIFYING'].includes(task.status)) return false;
  // A task waiting for its split is replaced by smaller tasks; migrating it back
  // to the executor would retry the stuck work instead.
  if (task.activityPhase.startsWith('decomposition_')) return false;
  const currentErrors = task.errorLog.split(/\n(?=\[attempt )/)
    .filter(entry => entry.startsWith(`[attempt ${task.attempts}]`)).join('\n');
  const marked = task.supervisorFeedback.startsWith('[SUPERVISOR_TEST_REPAIR]');
  if (marked && !legacyTestGuard.test(task.supervisorFeedback) && !repairApplicationGuard.test(task.supervisorFeedback)) return false;
  const obsolete = (currentErrors.includes('supervisor_repair_required') && legacyTestGuard.test(task.output)) ||
    (marked && legacyTestGuard.test(task.supervisorFeedback)) ||
    (repairApplicationGuard.test(currentErrors) && legacyTestGuard.test(currentErrors));
  if (!obsolete) return false;

  const key = `executorOwnershipMigration:${task.id}`;
  const previous = Number(queue.getMeta(key, '-1'));
  // Already returned at this attempt, but only for a row that actually left the
  // stop. An older build recorded this key after a write the decomposition
  // trigger had reverted; answering "handled" for a row still parked in
  // VERIFYING made every caller skip it, every tick, while its repair was
  // re-requested indefinitely.
  if (previous === task.attempts && task.status === 'PENDING') return true;
  // A stop at a later attempt means an old core stopped the executor again.
  const reason = previous >= 0 && previous !== task.attempts
    ? 'The installed core still uses the old test ownership guard. Install/reload the rebuilt extension before retrying.'
    : '';
  queue.update(task.id, {
    status: 'PENDING', finishedAt: null,
    activityPhase: 'executor_recovery',
    activityDetail: reason || 'Resuming the executor with source, tests, and configuration ownership.',
    supervisorFeedback: reason || 'The executor now owns in-scope source, existing tests, and configuration. ' +
      'Inspect preserved work, finish the original task, and rerun its checks; old test-ownership stops are obsolete.',
  });
  // The row is the evidence, not the call: tasks_decomposition_update silently
  // reverts a patch that moves a decomposition-bound row anywhere except
  // PENDING/executor_recovery. Record the migration only once it has landed.
  if (queue.get(task.id)?.status !== 'PENDING') return false;
  queue.setMeta(key, String(task.attempts));
  queue.log(task.id, 'system', 'executor-ownership-recovered', reason || 'Original task returned to executor; evidence and attempt budget preserved.');
  return true;
}
