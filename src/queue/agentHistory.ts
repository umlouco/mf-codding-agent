import { Task } from './db';
import { parseCompletionClaim, completionForSupervisor, parseExecutorValidation } from './validation';

export const MAX_LOG_ENTRIES = 4;

export const MAX_LOG_ENTRY_CHARS = 800;

export const MAX_LOG_CHARS = 4000;

export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}

/** Splits an accumulated error log back into its per-attempt entries. */
export function splitAttempts(log: string): string[] {
  return log
    .split(/\n(?=\[(?:attempt \d+|recovered)\])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when an entry says nothing the newer feedback does not already say. */
export function coveredBy(entry: string, feedback: string): boolean {
  if (!feedback) {
    return false;
  }
  const body = squash(entry.replace(/^\[[^\]]+\]\s*/, ''));
  return body.length > 0 && squash(feedback).includes(body);
}

/**
 * A short account of how the previous attempts ended, with whatever the current
 * supervisor feedback already says stripped out of it.
 */
export function attemptHistory(task: Task): string {
  const feedback = task.supervisorFeedback.trim();
  const history = splitAttempts(task.errorLog)
    .filter((e) => !coveredBy(e, feedback))
    .slice(-MAX_LOG_ENTRIES)
    .map((e) => clip(e, MAX_LOG_ENTRY_CHARS));
  return history.length ? clip(history.join('\n'), MAX_LOG_CHARS) : '(nothing recorded)';
}

/**
 * The briefing a retry opens with.
 *
 * `supervisorFeedback` is also the newest entry in `errorLog`, so printing both
 * verbatim handed the executor the same paragraphs twice — and the log grows
 * without bound across attempts, which buries the one instruction that still
 * matters in the middle of a wall of stale text. Keep the current feedback
 * whole and last, where it reads as the standing order, and keep the earlier
 * attempts as a short deduplicated tail: enough for the executor to know what
 * has already been tried, not enough to drown the instruction.
 */
export function retryBriefing(task: Task): string {
  const previous = task.output?.trim() || '';
  if (task.attempts <= 1 && !task.errorLog.trim() && !task.supervisorFeedback.trim() && !previous) {
    return '';
  }
  const claim = parseCompletionClaim(previous);
  const handoff = !previous ? '(no prior report recorded)'
    : claim.status !== 'UNSTATED' ? completionForSupervisor(claim)
    : JSON.stringify(parseExecutorValidation(previous, false));
  return `
THIS IS ATTEMPT ${task.attempts} of the current attempt budget. Earlier work did not pass verification.

How the earlier attempts ended, oldest first:
${attemptHistory(task)}

PREVIOUS WORKER HANDOFF (reported observations, not independently established facts):
${clip(handoff, 8000)}

Read the files before redoing any of that — an attempt that was cut off still
left its edits on disk, and repeating them is how the next attempt runs out too.
If an attempt was interrupted, inspect its completed changes before continuing.
An interruption alone does not prove the task is too large or the code is wrong.
Finish the missing work, or report the concrete blocker and next useful step.

Supervisor feedback on the last attempt — apply it consistently with the original user request:
${task.supervisorFeedback.trim() || '(none)'}
`;
}
