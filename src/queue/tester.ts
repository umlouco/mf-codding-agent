import type * as vscode from 'vscode';
import type { Task, Usage } from './db';
import { ActivityRecord, coreHalted, runOnce } from './agents';
import { testerRounds } from './agentRuntime';
import { taskCognition } from './cognition';
import { originalGoalContext, projectNotesContext } from './prompts';
import { ExecutorValidation, parseExecutorValidation, serializeValidation } from './validation';

/**
 * The tester: an independent agent that verifies one task by running checks.
 *
 * It replaces the plan-then-host-executes verifier for the queue. That design
 * asked a model for a one-shot plan, ran the plan's steps in the host, and asked
 * again for a verdict — which could not drive a browser interactively, react to
 * what a check showed, or start the server a page needed. The tester is a normal
 * tool-using turn on its own provider binding (the Tester role, e.g. NVIDIA
 * Nemotron), confined by the core's validator role to read-only work: reads,
 * checks, background servers and the browser, never edits.
 *
 * Its PASS is not taken on trust. `evidenceProblem` is the Hermes-style
 * completion gate: it reads the tool outcomes the host observed during *this*
 * turn — captured from the live event stream, not from truncated journal lines —
 * and refuses a PASS that executed nothing, or that claims a user-interface
 * behavior without a single successful browser action.
 */

export interface TesterOutcome {
  report: ExecutorValidation;
  /** The report as stored in task.validationReport. */
  serialized: string;
  text: string;
  usage: Usage;
  /** Successful executed checks the host observed, by tool name. */
  executed: string[];
}

export interface TesterHooks {
  onActivity?: (activity: ActivityRecord) => void;
  onEvent?: (method: string, params: any) => void;
  onAbort?: (abort: () => void) => void;
}

/** Tools whose success is an executed check, not a read. */
const EXECUTED = /^(run_shell|unix|shell_wait_for_http|playwright_[a-z_]+|browser_(?!close)[a-z_]+)$/;
const BROWSER = /^(playwright_[a-z_]+|browser_(?!close)[a-z_]+)$/;
/** The task text itself names a user-facing, rendered deliverable. */
const UI_CONTRACT = /\b(browser|web ?page|html|canvas|playwright|render(?:s|ed|ing)?|screenshot|click|keyboard|ui)\b/i;

export const testerReportExample = JSON.stringify({
  validation: {
    conclusion: 'PASS | FAIL | INCOMPLETE',
    summary: 'What was tested and what the results show.',
    implementationEvidence: 'Files and code paths inspected, with what they contain.',
    behaviorEvidence: 'Commands run / pages driven and their observed output.',
    checks: [{ kind: 'command | test | browser | inspection', name: 'the check', passed: true, evidence: 'observed output' }],
    remaining: 'Required checks not completed, empty when none.',
  },
}, null, 2);

/** Names of successful executed checks in one turn's observed tool outcomes. */
export function executedChecks(outcomes: readonly { name: string; ok: boolean; input: unknown }[]): string[] {
  const names: string[] = [];
  for (const o of outcomes) {
    if (!o.ok) continue;
    if (o.name === 'run_script') {
      // A successful batch ran every step; count the steps it carried. The
      // input comes from the live event, complete, not a 300-char journal line.
      const steps = (o.input as { steps?: { tool?: unknown }[] } | undefined)?.steps;
      for (const step of Array.isArray(steps) ? steps : []) {
        if (typeof step?.tool === 'string' && EXECUTED.test(step.tool)) names.push(step.tool);
      }
      continue;
    }
    if (EXECUTED.test(o.name)) names.push(o.name);
  }
  return names;
}

/**
 * Why a PASS is not supported by what the tester actually executed, or '' when
 * it is. Reads only the task's own contract text, never boilerplate, so a task
 * that has nothing to do with a browser is never asked for browser evidence.
 */
export function evidenceProblem(task: Pick<Task, 'description' | 'solutionVerifyPrompt'>, executed: string[]): string {
  if (!executed.length) {
    return 'The tester reported PASS without executing a single check (no successful command, test or browser action was observed).';
  }
  if (UI_CONTRACT.test(`${task.description}\n${task.solutionVerifyPrompt}`) && !executed.some(name => BROWSER.test(name))) {
    return 'The task describes browser-visible behavior, but the tester recorded no successful browser or Playwright action.';
  }
  return '';
}

export function testerPrompt(task: Task, goal: string, projectNotes: string): string {
  return [
    originalGoalContext(goal),
    projectNotesContext(projectNotes),
    `TASK ${task.seq}: ${task.title}\n${task.description}`,
    task.splitScope || '',
    `ACCEPTANCE CRITERIA — every one must be supported by a check you execute:\n${task.solutionVerifyPrompt || 'Exercise the described behavior.'}`,
    task.supervisorFeedback ? `SUPERVISOR NOTE FOR THIS VERIFICATION:\n${task.supervisorFeedback}` : '',
    `CODER HANDOFF — claims to check, not evidence:\n${task.output.slice(-4000) || '(none)'}`,
    task.validationReport ? `YOUR PREVIOUS REPORT ON THIS TASK (history; files may have changed since):\n${task.validationReport.slice(-4000)}` : '',
    `Test this task now with your tools, then end with this JSON report and nothing after it:\n${testerReportExample}`,
  ].filter(part => part.trim()).join('\n\n');
}

export async function runTester(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  goal: string,
  projectNotes: string,
  hooks: TesterHooks = {},
): Promise<TesterOutcome> {
  const started = new Map<string, { name: string; input: unknown }>();
  const outcomes: { name: string; ok: boolean; input: unknown }[] = [];
  const observe = (method: string, params: any) => {
    if (method === 'stream/tool' && params?.id) {
      const previous = started.get(params.id);
      const name = String(params.name || previous?.name || '');
      const input = params.input ?? previous?.input ?? {};
      started.set(params.id, { name, input });
      if (['ok', 'done'].includes(params.status)) outcomes.push({ name, ok: true, input });
      else if (params.status === 'error') outcomes.push({ name, ok: false, input });
    }
    hooks.onEvent?.(method, params);
  };

  const res = await runOnce(context, output, 'executor', testerPrompt(task, goal, projectNotes), {
    providerRole: 'tester',
    verificationOnly: true,
    verificationStage: 'agent',
    skillTask: `${task.title}\n${task.description}\n${task.solutionVerifyPrompt}`,
    cognition: taskCognition(task, goal, 'verifier'),
    maxIterations: testerRounds(),
    onActivity: hooks.onActivity,
    onEvent: observe,
    onAbort: hooks.onAbort,
  });

  const report = parseExecutorValidation(res.text, coreHalted(res.stopReason));
  const executed = executedChecks(outcomes);
  if (report.conclusion === 'PASS') {
    const problem = evidenceProblem(task, executed);
    if (problem) {
      report.conclusion = 'INCOMPLETE';
      report.remaining = [report.remaining, problem].filter(Boolean).join('\n');
    }
  }
  output.appendLine(`[queue:tester] task ${task.seq}: ${report.conclusion} after ${outcomes.length} tool outcome(s), ` +
    `${executed.length} executed check(s)`);
  return { report, serialized: serializeValidation(report), text: res.text, usage: res.usage, executed };
}
