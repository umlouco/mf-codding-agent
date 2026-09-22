import { createHash } from 'crypto';
import type { Task, TaskQueue } from './db';

interface ScopeRetry {
  fingerprint: string;
  failures: number;
  dueAt: number;
  reason: string;
}

export const scopeRetryKey = (task: Task): string => `scopeRetry:v1:${task.id}:${task.createdAt}`;

function fingerprint(queue: TaskQueue, task: Task): string {
  // Claims and heartbeat timestamps must not buy a fresh retry. A changed
  // contract or owner context may, without waiting for the old deadline.
  return createHash('sha256').update(JSON.stringify([task.title, task.description,
    task.solutionVerifyPrompt, task.output, task.region, task.splitScope,
    queue.getMeta('goal'), queue.contextInstructions])).digest('hex');
}

export function readScopeRetry(queue: TaskQueue, task: Task): ScopeRetry | undefined {
  try {
    const value = JSON.parse(queue.getMeta(scopeRetryKey(task)));
    if (value.fingerprint === fingerprint(queue, task) &&
        Number.isSafeInteger(value.failures) && value.failures > 0 &&
        Number.isFinite(value.dueAt) && typeof value.reason === 'string') return value;
  } catch { /* No retry is scheduled. */ }
  return undefined;
}

export function scopeRetryReady(queue: TaskQueue, task: Task, now = Date.now()): boolean {
  return (readScopeRetry(queue, task)?.dueAt ?? 0) <= now;
}

/** Preflight never started an executor. Retry discovery with a fresh assessment,
 * not an immediate claim of the same task and the same cached exception.
 */
export function deferScopeRetry(queue: TaskQueue, task: Task, reason: string, now = Date.now()): ScopeRetry {
  const failures = (readScopeRetry(queue, task)?.failures ?? 0) + 1;
  const retry = { fingerprint: fingerprint(queue, task), failures,
    dueAt: now + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)),
    reason: reason.slice(0, 4000) };
  queue.setMeta(scopeRetryKey(task), JSON.stringify(retry));
  return retry;
}

export function clearScopeRetry(queue: TaskQueue, task: Task): void {
  queue.setMeta(scopeRetryKey(task), '');
}
