import type { Task, TaskEvent } from './db';
import { attemptsExhausted } from './agentReviewSupport';
import { parseCompletionClaim, storedValidationProblem, type CompletionClaim } from './validation';

/**
 * OBSERVE: the durable facts one supervision decision is allowed to depend on.
 *
 * This module is the "observe" stage of OBSERVE → UPDATE → DERIVE. It reads the
 * task row and its journal and returns facts, never opinions: it does not decide
 * whether work is good, whether a claim is believable, or whether an approach is
 * a rabbit hole. Those are the remaining judgement calls, and they are the only
 * thing left for the model. Everything that *can* be established by reading the
 * database is established here, once, so it cannot silently reset each review.
 *
 * Nothing here reads a clock or touches the database directly — the caller
 * supplies `now`, `silentMs` and the already-fetched events, which is what makes
 * the result reproducible from a journal and safe to audit offline.
 */

export type SupervisionPhase = 'executing' | 'stopped';

export interface JournalFacts {
  /** Completed tool outcomes recorded in the excerpt. */
  completedTools: number;
  /** Completed outcomes whose status reports an error or interruption. */
  failedTools: number;
  /** Distinct tools whose most recent recorded outcome is a failure. */
  unresolvedTools: string[];
  /** Fingerprints observed more than once (identical call and result). */
  repeatedObservations: number;
  /** Outcome-bearing entries, in the order recorded. */
  outcomes: number;
}

export interface SupervisorFacts {
  taskId: number;
  seq: number;
  title: string;
  phase: SupervisionPhase;
  attempts: number;
  maxAttempts: number;
  exhausted: boolean;
  /** Milliseconds since the worker last wrote, or null while it is stopped. */
  silenceMs: number | null;
  /** Recorded inactivity beyond the workspace's silent window. */
  silent: boolean;
  /** The executor's own closing claim, labelled as a claim. */
  completionClaim: CompletionClaim;
  hasValidationReport: boolean;
  /** Why a stored PASS is not acceptable as evidence, or empty. */
  validationProblem: string;
  failedValidations: number;
  failedRepairs: number;
  /** The core stopped the turn for a reason a plain CONTINUE would repeat. */
  needsRecovery: boolean;
  localScope: boolean;
  testingUrl: string;
  /** Task text still targets loopback while a deployed origin is configured. */
  testingTargetDrift: boolean;
  journal: JournalFacts;
}

const RECOVERY_STOP_REASONS = [
  'supervisor_repair_required',
  'testing_target_blocked',
  'repeated_tool_error',
  'unchanged_tool_loop',
] as const;

const LOCAL_HOST = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?=[/\s'"`]|$)/i;

/** The same marker `monitor.ts` reads, exported so fact derivation stays pure. */
export function recoveryStopRecorded(task: Pick<Task, 'status' | 'attempts' | 'errorLog'>): boolean {
  if (task.status === 'EXECUTING') {
    return false;
  }
  return RECOVERY_STOP_REASONS.some(reason =>
    task.errorLog.includes(`[attempt ${task.attempts}] the core stopped the turn (${reason})`));
}

function outcomeStatus(message: string): string | undefined {
  const match = /→\s*([\w-]+)/.exec(message);
  return match?.[1];
}

function isFailedStatus(status: string | undefined): boolean {
  return !!status && /error|fail|timeout|cancel|abort|blocked/i.test(status);
}

/**
 * Reduces the journal excerpt to counts. Oldest first so "most recent outcome
 * for a tool" is the last one seen, not whichever happened to sort first.
 */
export function observeJournal(events: readonly TaskEvent[]): JournalFacts {
  const chronological = [...events].sort((a, b) => a.id - b.id);
  const lastStatus = new Map<string, string>();
  const fingerprints = new Map<string, number>();
  let completedTools = 0;
  let failedTools = 0;

  for (const event of chronological) {
    if (event.kind !== 'tool') {
      continue;
    }
    const message = event.message;
    const nameMatch = /^([^\s(]+)\(/.exec(message);
    const name = nameMatch?.[1];
    if (!name) {
      continue;
    }
    const fingerprint = /\[outcome:([0-9a-f]+)\]/.exec(message)?.[1];
    if (!fingerprint) {
      continue; // this is the "... → start" line, not a completed outcome
    }
    const status = outcomeStatus(message);
    completedTools++;
    if (isFailedStatus(status)) {
      failedTools++;
    }
    lastStatus.set(name, status ?? 'ok');
    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
  }

  const unresolvedTools = [...lastStatus.entries()]
    .filter(([, status]) => isFailedStatus(status))
    .map(([name]) => name)
    .sort();

  let repeatedObservations = 0;
  for (const count of fingerprints.values()) {
    if (count >= 2) {
      repeatedObservations += count - 1;
    }
  }

  return { completedTools, failedTools, unresolvedTools, repeatedObservations, outcomes: completedTools };
}

/** True when the task text still names loopback while a deployed origin is set. */
export function testingTargetDrift(task: Pick<Task, 'description' | 'solutionVerifyPrompt' | 'splitScope'>, testingUrl: string): boolean {
  if (!testingUrl) {
    return false;
  }
  let target: URL;
  try {
    target = new URL(testingUrl);
  } catch {
    return false;
  }
  if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(target.hostname)) {
    return false;
  }
  return ['description', 'solutionVerifyPrompt', 'splitScope'].some(field => LOCAL_HOST.test(task[field as 'description'] || ''));
}

export interface ObserveInput {
  task: Task;
  events: readonly TaskEvent[];
  failedValidations: number;
  failedRepairs: number;
  testingUrl: string;
  now: number;
  silentMs: number;
  localScope: boolean;
}

export function observeSupervisorFacts(input: ObserveInput): SupervisorFacts {
  const { task, events, testingUrl, now, silentMs } = input;
  const phase: SupervisionPhase = task.status === 'EXECUTING' ? 'executing' : 'stopped';
  const lastWrite = task.lastActivityAt ?? task.startedAt ?? null;
  const silenceMs = phase === 'executing' && lastWrite !== null ? Math.max(0, now - lastWrite) : null;

  return {
    taskId: task.id,
    seq: task.seq,
    title: task.title,
    phase,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    exhausted: attemptsExhausted(task),
    silenceMs,
    // A missed probe is not death: only recorded inactivity beyond the silent
    // window counts, and the watchdog is what actually requeues on it.
    silent: silenceMs !== null && silenceMs >= silentMs,
    completionClaim: parseCompletionClaim(task.output),
    hasValidationReport: !!task.validationReport.trim(),
    validationProblem: task.validationReport.trim() ? storedValidationProblem(task.validationReport) : '',
    failedValidations: input.failedValidations,
    failedRepairs: input.failedRepairs,
    needsRecovery: recoveryStopRecorded(task),
    localScope: input.localScope,
    testingUrl,
    testingTargetDrift: testingTargetDrift(task, testingUrl),
    journal: observeJournal(events),
  };
}
