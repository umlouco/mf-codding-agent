import * as vscode from 'vscode';
import type { Task, TaskEvent, Usage } from './db';
import { extractJson, runOnce, RunOptions } from './agents';
import { completionForSupervisor, parseCompletionClaim } from './validation';

/**
 * Journal kind recording an independent validation run that did not finish.
 *
 * Counted rather than capped. There is no attempt ceiling anywhere in this
 * design, and adding one here would be the same mistake in a new place — but a
 * supervisor that cannot see it has already failed twice will keep sending the
 * same validator at the same wall. The count is evidence; what to do about it
 * stays a decision.
 */
export const VALIDATION_FAILED = 'validation-failed';

export const SUPERVISOR_ACTIONS = [
  'CONTINUE_EXECUTION',
  'STOP_AND_REWRITE_TASK',
  'STOP_AND_REWRITE_VALIDATION',
  'START_VALIDATION',
] as const;

export type SupervisorAction = typeof SUPERVISOR_ACTIONS[number];

export interface ProgressDecision {
  action: SupervisorAction;
  reason: string;
  rewrittenDescription?: string;
  implVerifyPrompt?: string;
  solutionVerifyPrompt?: string;
  solutionVerifyCommand?: string;
  usage: Usage;
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function isDecision(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return SUPERVISOR_ACTIONS.includes((value as any).action);
}

/**
 * Journal entries one review is shown.
 *
 * The whole journal is not the point — the recent shape of the work is. A task
 * running for hours accumulates thousands of entries, and this prompt is sent
 * again every review, so what is not bounded here is paid for repeatedly.
 */
export const JOURNAL_EVENTS = 40;
const JOURNAL_ENTRY_CHARS = 1500;
const JOURNAL_TOTAL_CHARS = 24_000;
/** Enough of the closing response to judge it; a report is not a transcript. */
const OUTPUT_CHARS = 8000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The recent journal, oldest first, inside a fixed character budget.
 *
 * `events` arrives newest-first and the budget is spent in that order, because
 * when a task has been busy enough to overflow it the entries worth keeping are
 * the ones describing what it is doing *now*. The result is then reversed, so
 * the supervisor still reads it forwards.
 */
function journal(events: TaskEvent[]): string {
  const lines: string[] = [];
  let budget = JOURNAL_TOTAL_CHARS;

  for (const event of events) {
    const stamp = new Date(event.at).toISOString();
    const line = `${stamp} ${event.actor}/${event.kind}: ${clip(event.message, JOURNAL_ENTRY_CHARS)}`;
    if (line.length > budget) {
      lines.push(`(${events.length - lines.length} older entry(ies) omitted)`);
      break;
    }
    budget -= line.length;
    lines.push(line);
  }

  return lines.reverse().join('\n') || '(no journal entries yet)';
}

function normalize(raw: any, usage: Usage): ProgressDecision {
  const action = SUPERVISOR_ACTIONS.includes(raw?.action)
    ? raw.action as SupervisorAction
    : 'CONTINUE_EXECUTION';
  return {
    action,
    reason: String(raw?.reason ?? '').trim() || 'The supervisor supplied no reason.',
    rewrittenDescription: String(raw?.rewrittenDescription ?? '').trim() || undefined,
    implVerifyPrompt: String(raw?.implVerifyPrompt ?? '').trim() || undefined,
    solutionVerifyPrompt: String(raw?.solutionVerifyPrompt ?? '').trim() || undefined,
    solutionVerifyCommand: String(raw?.solutionVerifyCommand ?? '').trim() || undefined,
    usage,
  };
}

/** Reviews live database evidence and chooses one action from a fixed protocol. */
export async function reviewProgress(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  events: TaskEvent[],
  failedValidations: number,
  opts: Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort'> = {},
): Promise<ProgressDecision> {
  const state = task.status === 'EXECUTING'
    ? 'The execution agent is still running.'
    : 'The execution agent has stopped and formal validation has not run yet.';
  const validationHistory = failedValidations > 0
    ? `Independent validation has already been started ${failedValidations} time(s) on this task ` +
      'and did not complete. Starting it again unchanged is very likely to fail the same way: ' +
      'either fix what it runs against with STOP_AND_REWRITE_VALIDATION, or send the work back ' +
      'with CONTINUE_EXECUTION. Choose START_VALIDATION again only if the journal shows the cause ' +
      'was transient.'
    : 'Independent validation has not failed on this task.';
  const prompt = `You supervise a coding agent by reading its durable database journal.
You have no tools. Judge direction and work quality, not elapsed time, token use, round count,
or attempt count. A task may legitimately take hours. Intervene only when the evidence shows a
rabbit hole, a wrong premise, invalid verification, or work ready for independent validation.

TASK ${task.seq}: ${task.title}
${task.description}

IMPLEMENTATION VERIFICATION: ${task.implVerifyPrompt || '(not specified)'}
BEHAVIOR VERIFICATION: ${task.solutionVerifyPrompt || '(not specified)'}
COMMAND: ${task.solutionVerifyCommand || '(none)'}

CURRENT STATE: ${state}
CURRENT ACTIVITY: ${task.activityPhase || '(none)'} — ${task.activityDetail || '(none)'}
VALIDATION HISTORY: ${validationHistory}

THE EXECUTION AGENT'S OWN COMPLETION CLAIM (a claim about its work, not evidence
about it — the agent cannot verify itself, which is why you decide):
${completionForSupervisor(parseCompletionClaim(task.output))}

EXECUTION RESPONSE STORED IN DATABASE:
${clip(task.output, OUTPUT_CHARS) || '(the agent has not produced a closing response)'}

RECENT DATABASE JOURNAL:
${journal(events)}

Choose exactly one hard-coded action:
- CONTINUE_EXECUTION: evidence shows useful forward progress. If the agent already stopped, resume
  it from the work on disk because the task is not ready for validation.
- STOP_AND_REWRITE_TASK: direction or premise is wrong. Supply a complete rewrittenDescription.
- STOP_AND_REWRITE_VALIDATION: implementation may be sound but the checks are ambiguous, invalid,
  contradictory, or test the wrong thing. Supply corrected verification fields.
- START_VALIDATION: implementation evidence is sufficient to stop/resume no further work and
  delegate formal verification to a fresh execution LLM.

Reply with one JSON object. This protocol is fixed:
{
  "action": "CONTINUE_EXECUTION" | "STOP_AND_REWRITE_TASK" |
            "STOP_AND_REWRITE_VALIDATION" | "START_VALIDATION",
  "reason": "quality-based evidence for the decision",
  "rewrittenDescription": "required only for STOP_AND_REWRITE_TASK",
  "implVerifyPrompt": "replacement when rewriting validation",
  "solutionVerifyPrompt": "replacement when rewriting validation",
  "solutionVerifyCommand": "replacement when rewriting validation"
}`;

  const first = await runOnce(context, output, 'supervisor', prompt, {
    maxIterations: -1,
    ...opts,
  });
  const usage = { ...first.usage };
  try {
    return normalize(extractJson(first.text, isDecision), usage);
  } catch {
    const formatPrompt = `Restate the decision below as the required JSON object. Do not reconsider it.

${first.text.slice(0, 6000)}

Allowed action values: ${SUPERVISOR_ACTIONS.join(', ')}.`;
    try {
      const second = await runOnce(context, output, 'supervisor', formatPrompt, {
        maxIterations: -1,
        ...opts,
      });
      addUsage(usage, second.usage);
      return normalize(extractJson(second.text, isDecision), usage);
    } catch {
      return {
        action: 'START_VALIDATION',
        reason: 'The supervisor response was unreadable; running verification is the safe action when work is already done.',
        usage: usage ?? emptyUsage(),
      };
    }
  }
}
