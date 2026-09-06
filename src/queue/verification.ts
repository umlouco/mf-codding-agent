import * as vscode from 'vscode';
import type { Task, Usage } from './db';
import { ActivityRecord, coreHalted, runOnce, RunOptions, workerRounds } from './agents';
import { parseExecutorValidation, serializeValidation, ToolObservation } from './validation';
import { browserEvidence, verificationExample, reportContract, originalGoalContext, projectNotesContext } from './prompts';
import { taskCognition } from './cognition';
import { runVerificationCommand } from './command';

export interface VerificationOutcome {
  text: string;
  validationReport: string;
  stopReason: string;
  usage: Usage;
}

/** Runs formal verification in a fresh execution-agent process. */
export async function runVerification(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  goal: string,
  onActivity?: (activity: ActivityRecord) => void,
  onEvent?: (method: string, params: any) => void,
  onAbort?: (abort: () => void) => void,
  projectNotes = '',
): Promise<VerificationOutcome> {
  let prompt = `You are the independent verification execution agent. Do not redo the task and
do not trust the implementation agent's claims. Read the current workspace, inspect the actual
changes, and run the required checks. Do not edit production files, test fixtures, tests, or expected
results. If a harness needs correction, report the exact problem for the executor to fix.
Use existing checks and browser tools; normal generated test output is allowed.

${originalGoalContext(goal)}

${projectNotesContext(projectNotes)}

Independently interpret the original requirements relevant to this task. Compare them with the
implementation AND the supplied checks: a narrowed task or passing script cannot override the
client's requested behavior. Report FAIL for an observed violation, or INCOMPLETE for material
ambiguity or missing evidence, and explain the mismatch and required follow-up in remaining.
Do not claim that this task's PASS establishes delivery of the entire original request.

TASK ${task.seq}: ${task.title}
${task.description}

Supervisor's verification follow-up (preserve the original requirements and project notes):
${task.supervisorFeedback || '(none)'}

Executor handoff (claims to independently check):
${task.output?.slice(0, 8000) || '(no handoff)'}

Required implementation inspection:
${task.implVerifyPrompt || 'Inspect the final implementation and diff for coherence.'}

Required behavioral verification:
${task.solutionVerifyPrompt || 'Exercise the described behavior.'}
${task.solutionVerifyCommand ? `Required command: ${task.solutionVerifyCommand}` : ''}

The response is stored verbatim in the queue database and judged by a separate supervisor LLM.
Support that judgement with concrete observed evidence. In each check, "passed" means the stated
requirement was satisfied; an absence requirement passes when the value is confirmed absent.

Check each acceptance criterion against current observations. Record command, working directory,
exit code, and relevant output for command checks. For behavioral checks record expected and actual
values. A successful inspection does not substitute for a required runtime check.
Tool previews and partial file reads may omit content. A truncated preview does not establish that
the source file or test is incomplete. Inspect the remaining lines or saved report before claiming
required code or check results are missing; keep an uninspected check INCOMPLETE.
Execute a supplied Required command intact as the command argument of unix, run_shell, or the
CLI's Bash tool. For browser tests launched through a shell use kind test. Merely
reading or creating its input file does not execute it. Tool observations are independently recorded
and compared with your report. Do not generate an expected-output file to stand in for observations.
Choose FAIL when a valid check demonstrates a requirement is violated. Otherwise choose INCOMPLETE
when a required check could not run or evidence is missing. Choose PASS only when every required
criterion has passing evidence. List unverified checks in remaining, even if another check failed.

${browserEvidence}

Your final response must be ONE valid JSON object, without a code fence or trailing prose.
${reportContract}
Set conclusion to PASS, FAIL, or INCOMPLETE. Fill checks with one object per check, using keys kind,
name, passed, and evidence. kind is inspection, command, test, browser, or other; passed is a JSON
boolean. For an unperformed required check use passed false and explain the blocker in evidence.
Replace this example's values with observations; leave remaining empty only when nothing is unverified:
${verificationExample}`;

  const tools = new Map<string, { name: string; input: unknown }>();
  const observations: ToolObservation[] = [];
  let observedCommand = false;
  let observedBrowser = false;
  let observedRequiredCommand = false;
  const normalizeCommand = (command: string) => command.replace(/\r\n/g, '\n').trim();
  const observe = (method: string, params: any) => {
      if (method === 'stream/tool' && params?.id) {
        const started = tools.get(params.id);
        const name = String(params.name || started?.name || '');
        const input = params.input ?? started?.input;
        tools.set(params.id, { name, input });
        if (params.status === 'ok' || params.status === 'done') {
          observedCommand ||= /(?:run_shell|unix|posix|playwright_test|terminal|exec_command|Bash)$/i.test(name);
          observedBrowser ||= /(?:browser_|playwright_)/.test(name);
        }
        if (['ok', 'done', 'error'].includes(params.status)) {
          let args: any = input;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          if (/(?:^|__)(?:unix|run_shell|Bash)$/i.test(name) && typeof args?.command === 'string' &&
            !!task.solutionVerifyCommand?.trim() && normalizeCommand(args.command) === normalizeCommand(task.solutionVerifyCommand)) {
            observedRequiredCommand = params.status !== 'error';
          }
          observations.push({ name, status: params.status,
            input: (typeof input === 'string' ? input : JSON.stringify(input ?? {})).slice(0, 4000),
            output: String(params.output ?? '').slice(0, 4000) });
        }
      }
      onEvent?.(method, params);
    };
  let aborted = false;
  let stopCurrent: (() => void) | undefined;
  onAbort?.(() => { aborted = true; stopCurrent?.(); });
  const registerAbort = (abort: () => void) => { stopCurrent = abort; if (aborted) abort(); };
  let requiredCommandObservation: ToolObservation | undefined;
  if (task.solutionVerifyCommand?.trim()) {
    const evidence = await runVerificationCommand(context, task.solutionVerifyCommand, observe, registerAbort, onActivity);
    requiredCommandObservation = observations.at(-1);
    stopCurrent = undefined;
    prompt += `\n\nHOST-EXECUTED REQUIRED COMMAND (current verification attempt):\n${evidence}\n` +
      `The host already ran the required command intact. Use this observed result; do not translate\n` +
      `the script into another language or repeat it merely to fix your report. If it failed, inspect\n` +
      `the relevant input once if needed and report the actual defect or blocker. Do not change\n` +
      `fixtures or expected results. Continue only the other required checks that can provide new evidence.`;
  }
  if (aborted) throw new Error('Verification aborted before the model turn.');
  const result = await runOnce(context, output, 'executor', prompt, {
    cognition: taskCognition(task, goal, 'verifier'),
    memoryQuery: `${task.title || ''}\n${task.description}`,
    maxIterations: workerRounds(),
    onActivity,
    onEvent: observe,
    onAbort: registerAbort,
  } as RunOptions);
  const interrupted = coreHalted(result.stopReason);
  const report = parseExecutorValidation(result.text, interrupted);
  // This field comes only from this process's tool events, never model JSON.
  // Keep it bounded, with recent outcomes favored, for the independent reviewer.
  report.observedTools = observations.slice(-20);
  if (requiredCommandObservation && !report.observedTools.includes(requiredCommandObservation)) {
    report.observedTools = [requiredCommandObservation, ...observations.slice(-19)];
  }
  // A model's prose can claim a script passed after only reading a file. Require
  // actual tool execution in this verifier turn before accepting that account.
  if (report.conclusion === 'PASS') {
    const needsCommand = !!task.solutionVerifyCommand?.trim() ||
      report.checks.some(check => check.kind === 'command' || check.kind === 'test');
    const needsBrowser = report.checks.some(check => check.kind === 'browser');
    const missing = [
      task.solutionVerifyCommand?.trim() && !observedRequiredCommand
        ? 'The supplied required command was not observed completing successfully with its exact command text. Reading or creating an input file is not execution of the check.' : '',
      needsCommand && !observedCommand ? 'No successful command/test tool result was observed in this verification turn.' : '',
      needsBrowser && !observedBrowser ? 'No successful browser tool result was observed in this verification turn.' : '',
    ].filter(Boolean);
    if (missing.length) {
      report.conclusion = 'INCOMPLETE';
      report.remaining = [report.remaining, ...missing].filter(Boolean).join(' ');
    }
  }
  return {
    text: result.text,
    validationReport: serializeValidation(report),
    stopReason: result.stopReason,
    usage: result.usage,
  };
}
