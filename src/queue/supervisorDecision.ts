import type * as vscode from 'vscode';
import type { Task, Usage } from './db';
import { runOnce } from './agentRuntime';
import { extractJson } from './agentJson';
import { attemptsExhausted } from './agentReviewSupport';
import { attemptHistory } from './agentHistory';
import { taskCognition } from './cognition';
import { isLocalScope } from './scopeContract';
import { originalGoalContext, projectNotesContext } from './prompts';
import { completionForSupervisor, parseCompletionClaim, validationForSupervisor } from './validation';
import { isCompleteSplitPart } from './supervisorGraph';

/**
 * The supervisor's decision after the tester reports anything but a supported
 * PASS. This is the one judgement node in the post-test half of the graph:
 *
 *   tester report ──PASS + executed evidence──▶ VERIFIED            (code, no model)
 *                 └─FAIL / INCOMPLETE──▶ decide ──▶ RETRY | REWRITE | SPLIT | RETEST | REPAIR_TESTS
 *
 * `allowedVerdicts` prunes the vocabulary from recorded facts before the model
 * is asked (attempt budget, retest count, repair history, committed scope), and
 * `verdictViolation` rejects a reply that names a pruned or malformed action.
 * A decision that still cannot be obtained falls back deterministically, so a
 * flaky supervisor model can slow the queue down but never stall it.
 */

export const VERDICT_ACTIONS = ['RETRY', 'REWRITE', 'SPLIT', 'RETEST', 'REPAIR_TESTS'] as const;
export type VerdictAction = (typeof VERDICT_ACTIONS)[number];

export interface SplitPart {
  title: string;
  description: string;
  solutionVerifyPrompt: string;
}

export interface TestVerdict {
  action: VerdictAction;
  reason: string;
  /** For the coder (RETRY/REWRITE) or the tester (RETEST); self-contained. */
  guidance: string;
  rewrittenDescription?: string;
  solutionVerifyPrompt?: string;
  splitInto?: SplitPart[];
  usage: Usage;
  /** True when no valid model decision was obtained and the fallback applied. */
  fallback?: boolean;
}

export interface VerdictFacts {
  exhausted: boolean;
  retests: number;
  maxRetests: number;
  failedRepairs: number;
  localScope: boolean;
}

export function verdictFacts(task: Task, retests: number, failedRepairs: number, maxRetests = 2): VerdictFacts {
  return { exhausted: attemptsExhausted(task), retests, maxRetests, failedRepairs, localScope: isLocalScope(task) };
}

export function allowedVerdicts(facts: VerdictFacts): VerdictAction[] {
  return VERDICT_ACTIONS.filter(action =>
    !(action === 'RETRY' && facts.exhausted) &&
    !(action === 'RETEST' && facts.retests >= facts.maxRetests) &&
    !(action === 'REPAIR_TESTS' && facts.failedRepairs > 0) &&
    !(action === 'REWRITE' && facts.localScope));
}

/** Why a raw reply cannot be applied, or '' when it can. */
export function verdictViolation(raw: any, task: Pick<Task, 'description' | 'solutionVerifyPrompt'>, allowed: readonly VerdictAction[]): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'The reply is not a JSON object.';
  if (!allowed.includes(raw.action)) return `action must be one of: ${allowed.join(', ')}.`;
  if (!String(raw.reason ?? '').trim()) return 'reason is required.';
  if (raw.action === 'REWRITE') {
    const description = String(raw.rewrittenDescription ?? '').trim();
    const acceptance = String(raw.solutionVerifyPrompt ?? '').trim();
    const changed = (description && description !== task.description.trim()) ||
      (acceptance && acceptance !== task.solutionVerifyPrompt.trim());
    if (!changed) return 'REWRITE needs a changed rewrittenDescription or solutionVerifyPrompt.';
  }
  if (raw.action === 'SPLIT' && (!Array.isArray(raw.splitInto) || raw.splitInto.length < 2 ||
      !raw.splitInto.every((part: unknown) => isCompleteSplitPart(part as any)))) {
    return 'SPLIT needs splitInto with at least two parts, each with title, description and solutionVerifyPrompt.';
  }
  if (['RETRY', 'RETEST'].includes(raw.action) && !String(raw.guidance ?? '').trim()) {
    return `${raw.action} needs concrete guidance.`;
  }
  return '';
}

function toVerdict(raw: any, usage: Usage): TestVerdict {
  return {
    action: raw.action,
    reason: String(raw.reason).trim().slice(0, 4000),
    guidance: String(raw.guidance ?? '').trim().slice(0, 8000),
    rewrittenDescription: String(raw.rewrittenDescription ?? '').trim() || undefined,
    solutionVerifyPrompt: String(raw.solutionVerifyPrompt ?? '').trim() || undefined,
    splitInto: raw.action === 'SPLIT' ? raw.splitInto.map((p: any) => ({
      title: String(p.title).trim(), description: String(p.description).trim(),
      solutionVerifyPrompt: String(p.solutionVerifyPrompt).trim(),
    })) : undefined,
    usage,
  };
}

/**
 * What happens when no valid decision could be obtained. Retrying with the
 * tester's own findings is the least destructive move while attempts remain;
 * after that the task is split by the planner-backed decomposition path.
 */
export function fallbackVerdict(task: Task, allowed: readonly VerdictAction[], usage: Usage, why: string): TestVerdict {
  const report = validationForSupervisor(task.validationReport);
  if (allowed.includes('RETRY')) {
    return { action: 'RETRY', reason: `Supervisor decision unavailable (${why}); returning the tester's findings to the coder.`,
      guidance: `The independent tester did not pass this task. Fix what its report names, then re-run those checks yourself:\n${report.slice(0, 6000)}`,
      usage, fallback: true };
  }
  return { action: 'SPLIT', reason: `Supervisor decision unavailable (${why}) and the attempt budget is spent.`,
    guidance: report.slice(0, 6000), usage, fallback: true };
}

export function verdictPrompt(task: Task, siblings: readonly Pick<Task, 'seq' | 'title' | 'status'>[], goal: string,
  projectNotes: string, allowed: readonly VerdictAction[], facts: VerdictFacts): string {
  return [
    originalGoalContext(goal),
    projectNotesContext(projectNotes),
    `TASK LIST (alignment check — does this sequence still deliver the original request?):\n` +
      siblings.map(t => `${t.seq === task.seq ? '▶' : ' '} ${t.seq}. [${t.status}] ${t.title}`).join('\n'),
    `CURRENT TASK ${task.seq}: ${task.title}  (attempt ${task.attempts} of ${task.maxAttempts})\n${task.description}`,
    task.splitScope || '',
    `ACCEPTANCE CRITERIA:\n${task.solutionVerifyPrompt}`,
    `CODER'S CLAIM:\n${completionForSupervisor(parseCompletionClaim(task.output))}`,
    `INDEPENDENT TESTER REPORT (the evidence):\n${validationForSupervisor(task.validationReport).slice(0, 12000)}`,
    `EARLIER ATTEMPTS:\n${attemptHistory(task) || '(none)'}`,
    `The tester did not establish PASS. Decide the next step. Allowed actions: ${allowed.join(', ')}.
- RETRY: the report shows an implementation defect. guidance names the failing behavior, the
  observed evidence, and the concrete fix for the coder.
- REWRITE: the task text or acceptance is wrong, ambiguous, or drifted from the original request.
  Supply the complete corrected rewrittenDescription and/or solutionVerifyPrompt. Resets attempts.
- SPLIT: the task is too large to pass in one coder session. splitInto: 2+ ordered parts, each
  {title, description, solutionVerifyPrompt}; they replace this task.
- RETEST: the tester's own invocation failed (server did not start, wrong command, tool error)
  and the implementation may be fine. guidance tells the tester what to do differently.
  Retests used this attempt: ${facts.retests} of ${facts.maxRetests}.
- REPAIR_TESTS: a test file or harness is itself defective; guidance names the defect for a
  separate test-repair worker.
Reply with ONE JSON object, no fences:
{"action":"RETRY","reason":"requirement + decisive evidence","guidance":"...","rewrittenDescription":"","solutionVerifyPrompt":"","splitInto":[]}`,
  ].filter(part => part.trim()).join('\n\n');
}

export async function decideAfterTest(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  siblings: readonly Pick<Task, 'seq' | 'title' | 'status'>[],
  goal: string,
  projectNotes: string,
  facts: VerdictFacts,
  hooks: { onEvent?: (method: string, params: any) => void; onAbort?: (abort: () => void) => void } = {},
): Promise<TestVerdict> {
  const allowed = allowedVerdicts(facts);
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const add = (u?: Usage) => { for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[k] += u?.[k] || 0; };
  const options = {
    formatOnly: true, maxIterations: 1, cognition: taskCognition(task, goal, 'supervisor'),
    onEvent: hooks.onEvent, onAbort: hooks.onAbort,
  };
  let prompt = verdictPrompt(task, siblings, goal, projectNotes, allowed, facts);
  let problem = '';
  for (let turn = 0; turn < 2; turn++) {
    let text = '';
    try {
      const res = await runOnce(context, output, 'supervisor', prompt, options);
      add(res.usage);
      text = res.text;
      const raw = extractJson<any>(text, v => !!v && typeof v === 'object' && !Array.isArray(v) && 'action' in (v as object));
      problem = verdictViolation(raw, task, allowed);
      if (!problem) return toVerdict(raw, usage);
    } catch (error: any) {
      problem = String(error?.message ?? error);
      if (/cancel/i.test(problem)) throw error;
    }
    output.appendLine(`[queue:supervisor] task ${task.seq} decision rejected: ${problem}`);
    prompt = `${verdictPrompt(task, siblings, goal, projectNotes, allowed, facts)}\n\nYOUR PREVIOUS REPLY WAS REJECTED: ${problem}\n` +
      `Previous reply:\n${text.slice(0, 4000)}\nReturn a corrected JSON decision.`;
  }
  return fallbackVerdict(task, allowed, usage, problem);
}
