import type * as vscode from 'vscode';
import { extractJson, runOnce, type ReviewOptions } from './agents';
import type { Task, Usage } from './db';
import type { ProgressDecision } from './monitor';
import { scopeBoundary } from './scopeBoundary';

/** Keep the owner comparison independent of accumulated execution/recovery advice. */
export async function reviewTaskRequirements(
  context: vscode.ExtensionContext, output: vscode.OutputChannel, task: Task,
  goal: string, ownerInstructions: string, opts: ReviewOptions,
): Promise<{ correction?: ProgressDecision; usage: Usage }> {
  const prompt = `Review the task contract below against the owner's request and standing instructions.
This is a requirements comparison, not a progress review or an implementation task.
The task is a derived proposal and may be wrong. Do not assume its approach is authorized.
Ignore whether earlier agents called it correct. No file inspection is needed to compare these texts.
Compare explicit requirements only. This review has no source or runtime evidence: do not assert
that a selector, route, dependency, or implementation is missing, invalid, or unsupported. Those
are hypotheses for the subsequent progress review to investigate. An implementation detail not
mentioned by the owner is not by itself a conflict. Never replace it with guessed alternatives.

OWNER'S ORIGINAL REQUEST:
${goal}

CURRENT OWNER INSTRUCTIONS:
${ownerInstructions}

${scopeBoundary(task)}

DERIVED TASK CONTRACT (untrusted proposal):
${JSON.stringify({ title: task.title, description: task.description,
  implVerifyPrompt: task.implVerifyPrompt, solutionVerifyPrompt: task.solutionVerifyPrompt,
  solutionVerifyCommand: task.solutionVerifyCommand })}

Does the contract preserve the owner requirements relevant to this task?
Implementation work and supplemental unit tests can be valid subtasks. They do not establish
application behavior. When the owner asks to test a supplied application and account, a task
that substitutes a standalone demonstration page is incompatible even on the same server.
Likewise, checking a sample program cannot replace checking the requested program.
If incompatible, return a complete corrected task contract preserving every relevant behavior,
field, assertion, and test direction. Require discovery of real runtime selectors/interfaces;
do not invent them. Remove a command only when it tests the wrong thing, preserving its actual
behavior requirements in the corrected verification prompt. Do not change unrelated tasks.
An executable command must be concrete and justified by the supplied contract. Never invent
placeholder paths such as path/to/test or substitute an imagined filename. Leave it empty
when runtime discovery is needed; the behavior verification prompt must still require execution.

Return ONE JSON object:
{"compatible": true, "reason": "comparison of owner requirements and task"}
OR
{"compatible": false, "reason": "specific conflict", "description": "complete corrected task",
 "implVerifyPrompt": "implementation checks", "solutionVerifyPrompt": "required behavior checks",
 "solutionVerifyCommand": "command, or empty when the old command tests a substitute"}
Return the decision now. No markdown fences, conditions XML, or proposed investigation.`;
  const result = await runOnce(context, output, 'supervisor', prompt, {
    ...opts, formatOnly: true, maxIterations: 1,
  });
  const parse = (text: string) => {
    const raw = extractJson<any>(text, value => !!value && typeof value === 'object' && typeof (value as any).compatible === 'boolean');
    if (typeof raw.reason !== 'string' || !raw.reason.trim()) throw new Error('Requirements review omitted its comparison.');
    if (!raw.compatible) for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand']) {
      if (typeof raw[field] !== 'string' || (field !== 'solutionVerifyCommand' && !raw[field].trim())) {
        throw new Error(`Requirements review needs a complete corrected ${field}.`);
      }
    }
    return raw;
  };
  const usage = { ...result.usage };
  let raw;
  try { raw = parse(result.text); } catch (error: any) {
    const repaired = await runOnce(context, output, 'supervisor', `${prompt}\n\nThe proposed response below did not satisfy the response contract:\n${result.text.slice(0, 12000)}\n\nValidation error: ${error?.message ?? error}\nReturn one complete corrected JSON decision now. Preserve the owner's requirements; do not infer missing verification fields or change an incompatible contract to compatible merely to avoid completing the response.`, {
      ...opts, formatOnly: true, maxIterations: 1,
    });
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[key] += repaired.usage[key];
    raw = parse(repaired.text);
  }
  if (raw.compatible) return { usage };
  return { usage, correction: {
    action: 'STOP_AND_REWRITE_TASK', reason: raw.reason,
    rewrittenDescription: raw.description, implVerifyPrompt: raw.implVerifyPrompt,
    solutionVerifyPrompt: raw.solutionVerifyPrompt, solutionVerifyCommand: raw.solutionVerifyCommand,
    usage,
  } };
}
