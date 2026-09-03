import * as vscode from 'vscode';
import type { Task, Usage } from './db';
import { ActivityRecord, coreHalted, runOnce, RunOptions } from './agents';
import { parseExecutorValidation, serializeValidation } from './validation';

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
  onActivity?: (activity: ActivityRecord) => void,
  onEvent?: (method: string, params: any) => void,
  onAbort?: (abort: () => void) => void,
): Promise<VerificationOutcome> {
  const prompt = `You are the independent verification execution agent. Do not redo the task and
do not trust the implementation agent's claims. Read the current workspace, inspect the actual
changes, and run every applicable verification. You may make only minimal test-harness corrections;
do not change production behavior to force a pass.

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

Finish with one JSON object:
{
  "report": "verification summary",
  "validation": {
    "conclusion": "PASS" | "FAIL" | "INCOMPLETE",
    "summary": "overall conclusion",
    "implementationEvidence": "observed implementation evidence",
    "behaviorEvidence": "observed behavior and command output",
    "checks": [{ "kind": "inspection" | "command" | "test" | "browser" | "other",
                 "name": "check", "passed": true, "evidence": "exact observed evidence" }],
    "remaining": "anything unverified; empty only when nothing remains"
  }
}`;

  const result = await runOnce(context, output, 'executor', prompt, {
    maxIterations: -1,
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
