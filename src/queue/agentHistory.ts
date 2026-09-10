import { Task } from './db';
import { parseCompletionClaim, completionForSupervisor, parseExecutorValidation } from './validation';
import { getActiveQueue } from './registry';
import { extractJson } from './agentJson';

export const MAX_LOG_ENTRIES = 4;

export const MAX_LOG_ENTRY_CHARS = 800;

export const MAX_LOG_CHARS = 4000;

export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}

/** A decision from another role cannot describe the executor's completed work. */
export function decisionOnlyReport(text: string): boolean {
  if (parseCompletionClaim(text).status !== 'UNSTATED') return false;
  try {
    return !!extractJson(text, value => {
      if (!value || typeof value !== 'object') return false;
      const report = value as any;
      return typeof report.verdict === 'string' ||
        typeof report.validation?.conclusion === 'string' ||
        (typeof report.commandDisposition === 'string' && Array.isArray(report.steps) &&
          (report.version === 1 || (Array.isArray(report.preservedAssertions) && Array.isArray(report.remaining)))) ||
        (typeof report.conclusion === 'string' && Array.isArray(report.checks));
    });
  } catch { return false; }
}

function rejectedHandoff(text: string): string {
  const notice = 'The previous worker returned a supervisor/verifier-only decision, not an execution handoff. Inspect current files to establish completed work; no implementation claim was supplied.';
  // Older workers used the validation schema. Keep their concrete observations
  // and unfinished checks without copying decision schemas or role-setting prose.
  try {
    const envelope = extractJson<any>(text, value => !!value && typeof value === 'object' &&
      (typeof (value as any).validation?.conclusion === 'string' ||
        (typeof (value as any).conclusion === 'string' && Array.isArray((value as any).checks))));
    const report = envelope.validation || envelope;
    const evidence: Record<string, unknown> = Object.fromEntries(['implementationEvidence', 'behaviorEvidence', 'remaining']
      .filter(key => typeof report[key] === 'string' || Array.isArray(report[key]))
      .map(key => [key, clip(Array.isArray(report[key])
        ? report[key].filter((value: unknown) => typeof value === 'string').join('\n') : report[key], 800)]));
    if (Array.isArray(report.checks)) {
      evidence.checks = report.checks.slice(0, 4).map((check: any) =>
        ({ name: clip(String(check?.name || ''), 120), evidence: clip(String(check?.evidence || ''), 300) }));
      if (report.checks.length > 4) evidence.additionalChecks = report.checks.length - 4;
    }
    return `${notice}\nReported observations and unfinished checks (unverified):\n${JSON.stringify(evidence)}`;
  } catch { return notice; }
}

/** Supply the retired worker's report directly; workers need no SQLite access. */
export function replacementHandoff(task: Task): string {
  if (!task.region) return '';
  let key: unknown;
  try { key = JSON.parse(task.region).scopeSplit?.archiveKey; } catch { return ''; }
  if (typeof key !== 'string' || !key.startsWith('scopeSplit:')) return '';
  let parent: any;
  try { parent = JSON.parse(getActiveQueue?.()?.getMeta(key) || '{}').task; } catch { /* Missing archive is explicit below. */ }
  return `\nARCHIVED PARENT HANDOFF (reports are claims, not proof):
${parent ? JSON.stringify({ title: parent.title,
    output: decisionOnlyReport(String(parent.output || '')) ? rejectedHandoff(String(parent.output))
      : clip(String(parent.output || '(no prior work reported)'), 8000),
    validationReport: clip(String(parent.validationReport || '(none)'), 4000),
    errorLog: clip(String(parent.errorLog || '(none)'), 2000) }) : '(archive unavailable; inspect current files and report any material uncertainty)'}
The host supplied the handoff above; do not query or modify the queue database.
Inspect current files to establish what exists, then complete this task's remaining work.\n`;
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
    : decisionOnlyReport(previous) ? rejectedHandoff(previous)
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
