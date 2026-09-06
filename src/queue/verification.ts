import * as vscode from 'vscode';
import type { Task, Usage } from './db';
import { ActivityRecord, coreHalted, runOnce, RunOptions, workerRounds } from './agents';
import { parseExecutorValidation, serializeValidation } from './validation';
import { browserEvidence, verificationExample, reportContract, originalGoalContext } from './prompts';
import { taskCognition } from './cognition';

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
): Promise<VerificationOutcome> {
  const prompt = `You are the independent verification execution agent. Do not redo the task and
do not trust the implementation agent's claims. Read the current workspace, inspect the actual
changes, and run the required checks. Do not edit production files, test fixtures, tests, or expected
results. If a harness needs correction, report the exact problem for the executor to fix.
Use existing checks and browser tools; normal generated test output is allowed.

${originalGoalContext(goal)}

Independently interpret the original requirements relevant to this task. Compare them with the
implementation AND the supplied checks: a narrowed task or passing script cannot override the
client's requested behavior. Report FAIL for an observed violation, or INCOMPLETE for material
ambiguity or missing evidence, and explain the mismatch and required follow-up in remaining.
Do not claim that this task's PASS establishes delivery of the entire original request.

TASK ${task.seq}: ${task.title}
${task.description}

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

  const result = await runOnce(context, output, 'executor', prompt, {
    cognition: taskCognition(task, goal, 'verifier'),
    memoryQuery: `${task.title || ''}\n${task.description}`,
    maxIterations: workerRounds(),
    onActivity,
    onEvent,
    onAbort,
  } as RunOptions);
  const interrupted = coreHalted(result.stopReason);
  return {
    text: result.text,
    validationReport: serializeValidation(parseExecutorValidation(result.text, interrupted)),
    stopReason: result.stopReason,
    usage: result.usage,
  };
}
