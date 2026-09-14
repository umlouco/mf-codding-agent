import type { Task, TaskQueue } from './db';

const legacyTestGuard = /queue ownership:\s*the supervisor (?:must rewrite existing test|owns test rewrites)/i;
// Only the old installed core's wording qualifies. The current repair turn is
// deliberately confined to tests, and its application-file refusal must reach
// failure decomposition (SPLIT), not be migrated back to this executor.
const repairApplicationGuard = /queue ownership: supervisor test repair cannot rewrite application file[^\n]*preserving the original owner goal/i;

/** One migration retry for stopped workers from the old source/test ownership split. */
export function recoverOwnershipStop(queue: TaskQueue, task: Task): boolean {
  if (!['PENDING', 'VERIFYING'].includes(task.status)) return false;
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
  if (previous === task.attempts) return true;
  const reason = previous >= 0
    ? 'The installed core still uses the old test ownership guard. Install/reload the rebuilt extension before retrying.'
    : '';
  queue.update(task.id, {
    status: 'PENDING', finishedAt: null,
    activityPhase: 'executor_recovery',
    activityDetail: reason || 'Resuming the executor with source, tests, and configuration ownership.',
    supervisorFeedback: reason || 'The executor now owns in-scope source, existing tests, and configuration. ' +
      'Inspect preserved work, finish the original task, and rerun its checks; old test-ownership stops are obsolete.',
  });
  queue.setMeta(key, String(task.attempts));
  queue.log(task.id, 'system', 'executor-ownership-recovered', reason || 'Original task returned to executor; evidence and attempt budget preserved.');
  return true;
}
