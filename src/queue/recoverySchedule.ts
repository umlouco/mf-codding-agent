import { createHash } from 'crypto';
import type { Task, TaskQueue } from './db';

/** Recovery is scheduled work, never a queue-wide stop or evidence of success. */
export interface RecoveryJob {
  version: 1;
  active: boolean;
  reason: string;
  dueAt: number;
  attempts: number;
  failedStrategies: string[];
  lastError: string;
  updatedAt: number;
  /** The most recently proposed strategy fingerprint and how many consecutive
   * attempts — accepted or rejected — have now proposed that same one. See
   * strategyStreak: an unbroken run means the supervisor's decision has
   * stopped changing, which backoff alone cannot fix. */
  lastStrategy: string;
  lastStrategyStreak: number;
}

export type RecoveryOutcome = { status: 'applied' } |
  { status: 'deferred'; reason: string; retryAfterMs?: number; strategy?: string };

export const recoveryJobKey = (task: Task) => `recoveryJob:v1:${task.id}:${task.createdAt}`;
export const recoveryStrategyFingerprint = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : JSON.stringify(value)).digest('hex');

export function readRecoveryJob(queue: TaskQueue, task: Task): RecoveryJob | undefined {
  const raw = queue.getMeta(recoveryJobKey(task));
  if (!raw) return undefined;
  try {
    const job = JSON.parse(raw);
    if (job.version !== 1 || typeof job.active !== 'boolean' || typeof job.reason !== 'string' ||
        !Number.isSafeInteger(job.attempts) || job.attempts < 0 ||
        !Number.isSafeInteger(job.dueAt) || job.dueAt < 0 || !Array.isArray(job.failedStrategies) ||
        !job.failedStrategies.every((s: unknown) => typeof s === 'string')) throw Error('Invalid recovery job');
    // Older persisted jobs predate this streak tracking; default them in rather
    // than treating an otherwise-valid in-flight job as corrupt.
    if (typeof job.lastStrategy !== 'string') job.lastStrategy = '';
    if (!Number.isSafeInteger(job.lastStrategyStreak) || job.lastStrategyStreak < 0) job.lastStrategyStreak = 0;
    return job;
  } catch {
    // Corrupt scheduling data cannot authorize an unchanged worker launch.
    return { version: 1, active: true, reason: 'Repair unreadable recovery scheduling metadata.',
      dueAt: 0, attempts: 0, failedStrategies: [], lastError: raw.slice(0, 1000), updatedAt: 0,
      lastStrategy: '', lastStrategyStreak: 0 };
  }
}

function save(queue: TaskQueue, task: Task, job: RecoveryJob): RecoveryJob {
  job.updatedAt = Date.now();
  queue.setMeta(recoveryJobKey(task), JSON.stringify(job));
  return job;
}

export function scheduleRecoveryJob(queue: TaskQueue, task: Task, reason: string): RecoveryJob {
  const previous = readRecoveryJob(queue, task);
  if (previous?.active) return previous; // A tick or reload must not postpone or renew a budget.
  const job: RecoveryJob = { version: 1, active: true, reason, dueAt: Date.now(),
    attempts: previous?.attempts ?? 0, failedStrategies: previous?.failedStrategies ?? [],
    lastError: '', updatedAt: Date.now(),
    lastStrategy: previous?.lastStrategy ?? '', lastStrategyStreak: previous?.lastStrategyStreak ?? 0 };
  queue.log(task.id, 'supervisor', 'recovery-scheduled', JSON.stringify(job));
  return save(queue, task, job);
}

export function recoveryBackoff(attempt: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
}

/** Persist the next retry before awaiting a provider: a crash cannot buy a free retry. */
export function beginRecoveryAttempt(queue: TaskQueue, task: Task, now = Date.now()): RecoveryJob | undefined {
  const job = readRecoveryJob(queue, task);
  if (!job?.active || now < job.dueAt) return undefined;
  job.attempts++;
  job.dueAt = now + recoveryBackoff(job.attempts);
  queue.log(task.id, 'supervisor', 'recovery-attempt', JSON.stringify({ attempt: job.attempts, reason: job.reason }));
  return save(queue, task, job);
}

/** Claim a strategy before acting; retain fingerprints across retries, reloads and Start. */
export function rememberRecoveryStrategy(queue: TaskQueue, task: Task, strategy: string): boolean {
  const job = readRecoveryJob(queue, task);
  if (!job || job.failedStrategies.includes(strategy) || job.failedStrategies.length >= 4096) return false;
  job.failedStrategies.push(strategy);
  save(queue, task, job);
  return true;
}

/**
 * How many consecutive attempts — accepted or rejected — have now proposed this
 * exact strategy fingerprint. Resets the moment a different one is proposed.
 *
 * Backoff alone bounds how OFTEN autonomous recovery retries, not whether each
 * retry is capable of reaching a different outcome. Once rememberRecoveryStrategy
 * starts rejecting a strategy as already-tried, nothing about waiting five more
 * minutes and asking again changes the evidence the supervisor sees, so it keeps
 * proposing the identical operation and getting the identical rejection — an
 * unbroken streak this counts. The caller escalates once that streak is long
 * enough that continuing to defer cannot plausibly help.
 */
export function strategyStreak(queue: TaskQueue, task: Task, strategy: string): number {
  const job = readRecoveryJob(queue, task);
  if (!job) return 1;
  const streak = job.lastStrategy === strategy ? job.lastStrategyStreak + 1 : 1;
  save(queue, task, { ...job, lastStrategy: strategy, lastStrategyStreak: streak });
  return streak;
}

export function deferRecoveryJob(queue: TaskQueue, task: Task, reason: string,
  retryAfterMs?: number, strategy?: string): RecoveryJob {
  const job = readRecoveryJob(queue, task) ?? scheduleRecoveryJob(queue, task, reason);
  if (strategy && !job.failedStrategies.includes(strategy) && job.failedStrategies.length < 4096) job.failedStrategies.push(strategy);
  job.active = true;
  job.lastError = reason;
  const requested = Number.isFinite(retryAfterMs) ? Math.max(0, Math.floor(retryAfterMs!)) : 0;
  job.dueAt = Math.max(job.dueAt, Date.now() + recoveryBackoff(job.attempts), Date.now() + Math.min(requested, 3_600_000));
  queue.log(task.id, 'supervisor', 'recovery-deferred', JSON.stringify({ reason, dueAt: job.dueAt, attempts: job.attempts }));
  return save(queue, task, job);
}

export function completeRecoveryJob(queue: TaskQueue, task: Task): void {
  const job = readRecoveryJob(queue, task);
  if (!job) return;
  job.active = false;
  save(queue, task, job);
  queue.log(task.id, 'supervisor', 'recovery-applied', 'A changed, bounded strategy was admitted; acceptance remains unproven.');
}

export function hasRecoveryJob(queue: TaskQueue, task: Task): boolean {
  return readRecoveryJob(queue, task)?.active === true;
}

export function hasOutstandingRecovery(queue: TaskQueue): boolean {
  return queue.list().some(task => hasRecoveryJob(queue, task));
}
