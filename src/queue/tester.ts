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
const NATIVE_EXECUTED = /^(run_shell|unix|shell_wait_for_http|playwright_[a-z_]+|browser_(?!close)[a-z_]+)$/;
/**
 * MCP tools that build, run, query or drive the product under test. Their success is an
 * observation of behavior (a build log, a database row, a window and its controls), unlike a
 * ticket lookup or a document search, so a PASS resting on them is not a PASS on reads alone.
 */
const MCP_CHECK = /^mcp__[a-z0-9_-]+__[a-z0-9_]*?(build|run|check|select|query|click|fill|send|trigger|press|type|hover|drag|drop|capture|inspect|read_control|find_delphi|list_delphi|wait_for|debug|leak)[a-z0-9_]*$/;
const EXECUTED = { test: (name: string): boolean => NATIVE_EXECUTED.test(name) || MCP_CHECK.test(name) };
const BROWSER = /^(playwright_[a-z_]+|browser_(?!close)[a-z_]+)$/;
/** A desktop GUI automation action observed through an MCP server. */
const GUI_ACTION = /^mcp__[a-z0-9_-]+__(click[a-z_]*|fill[a-z_]*|select[a-z_]*|send[a-z_]*|trigger[a-z_]*|press[a-z_]*|type[a-z_]*|hover[a-z_]*|drag[a-z_]*|drop[a-z_]*|focus_and_capture_window)$/;
/** The task text itself names a user-facing, rendered deliverable. */
const UI_CONTRACT = /\b(browser|web ?page|html|canvas|playwright|render(?:s|ed|ing)?|screenshot|click|keyboard|ui)\b/i;
/**
 * Report summaries that name a transport or format failure, not a finding.
 * The checks may have run; only the closing JSON did not parse. Those are
 * re-asked once for the same evidence in valid form, never counted as an
 * incomplete verification of the product.
 */
/** The core ended the turn because it ran out of rounds or context, not because a guard refused a tool. */
const CUT_OFF_REASONS = new Set(['max_iterations', 'context_limit']);
/** validation.ts's wording when it downgrades a PASS that still lists unfinished work. */
const REMAINING_PREFIX = 'Required verification remains unfinished: ';
const PARSE_ARTIFACTS = new Set([
  'The verification agent did not return a structured validation object.',
  'The verification reply could not be parsed as structured validation.',
]);

export const testerReportExample = JSON.stringify({
  validation: {
    conclusion: 'PASS | FAIL | INCOMPLETE',
    summary: 'What was tested and what the results show.',
    implementationEvidence: 'Files and code paths inspected, with what they contain.',
    behaviorEvidence: 'Commands run / pages driven and their observed output.',
    checks: [{ kind: 'command | test | browser | inspection', name: 'the check', passed: true, evidence: 'observed output' }],
    remaining: 'Acceptance criteria you did NOT complete; an empty string when every criterion was checked. Put notes and caveats in summary, never here.',
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
    return 'The tester reported PASS without executing a single check (no successful command, test, browser or GUI action was observed).';
  }
  if (UI_CONTRACT.test(`${task.description}\n${task.solutionVerifyPrompt}`)
    && !executed.some(name => BROWSER.test(name) || GUI_ACTION.test(name))) {
    return 'The task describes user-interface behavior, but the tester recorded no successful browser, Playwright or GUI automation action.';
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
    `VERIFICATION SCOPE AND ROLE:
- Judge only the ACCEPTANCE CRITERIA and the owner instructions above. Never add acceptance elements of your own, and never demand evidence, artifacts, or re-observations that they do not require.
- You are read-only for workspace files: never rewrite product, test, or queue files. Helper scripts (credential injection, window capture, probes) may only be written under .mfagent/scratch/.
- MCP tools are permitted, including GUI automation (e.g. delphi-gui) and launching the built artifact. When the criteria require observing live behavior, re-drive the flow yourself; the coder's handoff and its artifacts are claims and inputs, not evidence.
- Never rebuild or replace the artifact under verification; verify it exactly as it exists on disk. Only if the criteria explicitly assign the build to this verification may you build it. If a check needs a fresh build that is not assigned here, report it as remaining.
- A check that cannot be executed is reported as remaining, not as a new requirement on the implementation.
- Be economical: you have about ${testerRounds()} tool rounds. Cover each acceptance criterion once, in order, batching independent read-only probes into one run_script call, and stop as soon as every criterion has evidence. Do not repeat a probe or re-derive a fact you can confirm in one call; a turn that runs out of rounds ends without a verdict.
- Keep the summary to a few sentences. End with the JSON report and nothing after it.`,
    `Test this task now with your tools, then end with this JSON report and nothing after it:\n${testerReportExample}`,
  ].filter(part => part.trim()).join('\n\n');
}

/**
 * One tool-free turn that re-emits the validation report from evidence this
 * turn already observed. Used only when the first reply's closing JSON failed
 * to parse: the verdict must come from the checks listed below, never from
 * new investigation.
 */
function reportRepairPrompt(task: Task, rawText: string, outcomes: readonly { name: string; ok: boolean; input: unknown }[],
  passedWithRemaining = ''): string {
  const lines: string[] = [];
  let budget = 6000;
  for (const o of outcomes.slice(-40)) {
    let input = '';
    try { input = JSON.stringify(o.input); } catch { input = String(o.input); }
    const line = `- ${o.ok ? 'ok' : 'FAILED'} ${o.name}: ${input.slice(0, 240)}`;
    if (lines.length + line.length > budget) break;
    lines.push(line);
    budget -= line.length;
  }
  return [
    `TASK ${task.seq}: ${task.title}`,
    `ACCEPTANCE CRITERIA:\n${task.solutionVerifyPrompt || 'Exercise the described behavior.'}`,
    (passedWithRemaining
      ? `Your report concluded PASS but its "remaining" field says: ${passedWithRemaining.slice(0, 1500)}\n` +
        `"remaining" lists acceptance criteria that were NOT completed, and the host cannot accept a PASS that also lists unfinished work. ` +
        `If every acceptance criterion is supported by an observation, return PASS with remaining empty and move that commentary into summary. ` +
        `If a criterion is genuinely unmet, return INCOMPLETE and name exactly those criteria. `
      : `Your previous verification turn executed the checks below and ended without a parseable JSON report ` +
        `(it may have run out of rounds and closed with a progress note). `) +
    `Do not re-run anything and do not investigate. Judge only the acceptance criteria from this observed evidence: ` +
    `conclude PASS only when every criterion has a supporting observation in the outcomes or your earlier notes below; ` +
    `if a criterion was not completed, conclude INCOMPLETE and list exactly those criteria in remaining.`,
    `OBSERVED TOOL OUTCOMES (this turn, name and input only):\n${lines.join('\n') || '(none)'}`,
    `PREVIOUS REPLY (untrusted draft, for reference):\n${rawText.slice(-4000)}`,
    `Reply with the JSON report only, no prose and no fences:\n${testerReportExample}`,
  ].join('\n\n');
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

  let text = res.text;
  let usage = res.usage;
  let report = parseExecutorValidation(text, coreHalted(res.stopReason));
  const executed = executedChecks(outcomes);
  // A parse artifact is a transport failure, not a finding: the checks ran,
  // only the closing JSON did not parse. Re-ask once, tool-free, for the same
  // evidence in valid form. The re-ask may only restate what this turn
  // observed, so it cannot invent a verdict.
  // A turn that ran out of rounds or context has the same shape: real checks ran and the closing
  // report is prose (or a partial-progress note), not the JSON. The narrative often already holds
  // every observation the criteria need, and only the verdict is missing.
  const cutOff = CUT_OFF_REASONS.has(res.stopReason);
  // A PASS whose "remaining" field is not empty is downgraded by the host, but models use that field
  // for caveats ("nothing required is outstanding; the wizard flow itself was not opened"). The verdict
  // was reached and only its bookkeeping contradicts it. One repair pass settles which it was.
  const passedWithRemaining = report.conclusion === 'INCOMPLETE' && !coreHalted(res.stopReason) &&
    report.remaining.startsWith(REMAINING_PREFIX) ? report.remaining.slice(REMAINING_PREFIX.length) : '';
  if (PARSE_ARTIFACTS.has(report.summary) || cutOff || passedWithRemaining) {
    const why = passedWithRemaining ? 'PASS listed unfinished work'
      : cutOff ? `turn was cut off (${res.stopReason})` : `report did not parse (${report.summary})`;
    output.appendLine(`[queue:tester] task ${task.seq}: ${why}; re-asking once for the same evidence`);
    try {
      const repair = await runOnce(context, output, 'executor', reportRepairPrompt(task, text, outcomes, passedWithRemaining), {
        providerRole: 'tester',
        formatOnly: true,
        maxIterations: 1,
        verificationOnly: true,
        verificationStage: 'agent',
        cognition: taskCognition(task, goal, 'verifier'),
        onActivity: hooks.onActivity,
        onEvent: observe,
        onAbort: hooks.onAbort,
      });
      const repaired = parseExecutorValidation(repair.text, coreHalted(repair.stopReason));
      if (!PARSE_ARTIFACTS.has(repaired.summary) && !coreHalted(repair.stopReason)) {
        text = repair.text;
        usage = { input: usage.input + repair.usage.input, output: usage.output + repair.usage.output,
          cacheRead: usage.cacheRead + repair.usage.cacheRead, cacheWrite: usage.cacheWrite + repair.usage.cacheWrite };
        report = repaired;
      }
    } catch (error) {
      output.appendLine(`[queue:tester] task ${task.seq}: report re-ask failed: ${String((error as Error)?.message ?? error)}`);
    }
  }
  if (report.conclusion === 'PASS') {
    const problem = evidenceProblem(task, executed);
    if (problem) {
      report.conclusion = 'INCOMPLETE';
      report.remaining = [report.remaining, problem].filter(Boolean).join('\n');
    }
  }
  output.appendLine(`[queue:tester] task ${task.seq}: ${report.conclusion} after ${outcomes.length} tool outcome(s), ` +
    `${executed.length} executed check(s)`);
  return { report, serialized: serializeValidation(report), text, usage, executed };
}
