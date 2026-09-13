import { CompletionClaim, parseCompletionClaim, extractExecutorNotes } from './validation';
import { Usage, Task } from './db';
import * as vscode from 'vscode';
import { ActivityRecord, RunOptions } from './agentTypes';
import { retryBriefing, replacementHandoff, decisionOnlyReport } from './agentHistory';
import { projectNotesContext, originalGoalContext, codingWorkflow, browserEvidence, reportContract, executorExample } from './prompts';
import { runOnce, workerRounds } from './agentRuntime';
import { taskCognition } from './cognition';

// ---- executor ----------------------------------------------------------

export interface ExecutionOutcome {
  text: string;
  /**
   * What the agent says about its own work — see parseCompletionClaim. A claim,
   * not evidence: it feeds the supervisor's decision, it never makes one.
   */
  completion: CompletionClaim;
  ok: boolean;
  /** The core stopped the turn itself; the supervisor must decide what follows. */
  cutOff: boolean;
  /** The model/core reason for stopping. */
  stopReason: string;
  /** What this attempt cost, spent whether or not it produced anything. */
  usage: Usage;
  /**
   * A durable fact this task wants every later task to know, straight from
   * its own JSON report — see TaskQueue.appendInstruction. Empty when the
   * executor had nothing to add.
   */
  notes: string;
}

/**
 * Stop reasons that mean the core ended the turn, not the model.
 *
 * `repeated_tool_error` is a call failing the same way three times over;
 * `context_limit` is the conversation growing to the point where the next
 * request would be refused for its size. Both come back with a real handoff
 * report rather than a canned line (see finalReport in the core), and both mean
 * the same thing to the queue: the text describes partial progress, and it is
 * the supervisor's job to say whether that progress continues, gets rewritten,
 * or is ready to validate.
 */
export function coreHalted(stopReason: string): boolean {
  return stopReason === 'supervisor_repair_required' || stopReason === 'testing_target_blocked' || stopReason === 'tool_protocol_error' || stopReason === 'repeated_tool_error' || stopReason === 'unchanged_tool_loop' || stopReason === 'context_limit' || stopReason === 'max_iterations';
}

export async function executeTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  /** TaskQueue.instructions — see its doc comment for why this crosses the
   * task-isolation boundary when nothing else does. */
  instructions: string,
  goal: string,
  onActivity?: (a: ActivityRecord) => void,
  onEvent?: (method: string, params: any) => void,
  onAbort?: (abort: () => void) => void,
  onSteerable?: RunOptions['onSteerable'],
): Promise<ExecutionOutcome> {
  const retry = retryBriefing(task);
  const notes = projectNotesContext(instructions);

  const prompt = `You are an execution agent. Complete exactly one task, then stop.

${originalGoalContext(goal)}

Compare this task with the original request before implementing. Treat the task and recovery
feedback as working interpretations, not replacements for the user's requirements. If evidence
shows the approach is wrong, revise your approach within this task. If correcting it requires
changing scope or resolving material ambiguity, report NEEDS_MORE_WORK with the conflict,
confirmed evidence, and proposed correction or precise question for supervisor recovery.

${notes}TASK ${task.seq}: ${task.title}

${task.description}

${task.splitScope || ''}
${replacementHandoff(task)}
${retry}
Own the implementation. Run ordinary development checks while you work, but do
not make the final verification decision. A supervisor watches your database
journal and will start a separate execution LLM to perform formal verification.

Expected behaviour (the verifier will test this against what you actually produced):
${task.solutionVerifyPrompt || 'the described behaviour works'}

Rules:
${codingWorkflow}

${browserEvidence}

- Stay inside this task. Do not start the next one, and do not refactor unrelated code.
- The supervisor owns rewrites of existing tests, test fixtures and validation scripts.
  Do not rewrite those files to repair a failed check. Report the exact test defect and request
  supervisor test repair in your handoff. Implement application fixes when the test is valid.
- If the task turns out to be impossible or already done, say so plainly and explain why.
- Inspect the final code and diff yourself. Run useful development checks. For UI/browser work,
  use the browser tools when needed and record what happened.
- Use the shared graph memory when available: recall relevant decisions, requirements, and past
  failures before broad exploration. Persist useful discoveries with memory_remember, including
  reasons, affected entities, and supporting evidence. Distinguish hypotheses from observations;
  do not record unverified work as verified. Fresh sessions share the workspace graph.
- Put concise project-wide conventions in "notes" below as well when later tasks need them.
  Notes complement the graph and the task handoff. Leave notes empty when there is nothing new.
- Your final response must be ONE valid JSON object, without a code fence or trailing prose.
${reportContract}
  Use status READY_FOR_VALIDATION only when implementation is complete and development checks
  support handing it to the verifier. Otherwise use NEEDS_MORE_WORK. Neither status is a formal PASS.
  Populate filesChanged and developmentChecks with strings describing actual files and results.
  Use an empty notes string when there is no new durable fact. Replace this example's values:
${executorExample}`;

  const options: RunOptions = {
    cognition: taskCognition(task, goal, 'executor'),
    memoryQuery: `${task.title || ''}\n${task.description}`,
    maxIterations: workerRounds(),
    onActivity,
    onEvent,
    onAbort,
    onSteerable,
  };
  let result = await runOnce(context, output, 'executor', prompt, options);
  if (!coreHalted(result.stopReason) && decisionOnlyReport(result.text)) {
    output.appendLine('[queue:executor] supervisor/verifier-only report received; requesting one execution-role correction');
    const spent = result.usage;
    try {
      result = await runOnce(context, output, 'executor', `${prompt}\n\nROLE CORRECTION:
Your previous response returned a supervisor-only verdict, verification plan, or verifier-only report instead of an execution report.
You are the EXECUTOR. Perform the assigned implementation yourself using the available tools,
inspect existing work first, follow the owner's TDD instructions, and report the actual result
using the completion schema above. Do not tell a future worker to do your task or return a verdict.
If a concrete blocker prevents implementation, report NEEDS_MORE_WORK with observed evidence.`, options);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const partial = (failure as any).usage || {};
      (failure as any).usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite']
        .map(key => [key, (spent as any)[key] + (partial[key] || 0)]));
      throw failure;
    }
    result.usage = { ...result.usage };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) result.usage[key] += spent[key];
  }
  const { text, stopReason, usage } = result;
  return {
    text,
    completion: parseCompletionClaim(text),
    ok: text.trim().length > 0,
    cutOff: coreHalted(stopReason),
    stopReason,
    usage,
    notes: extractExecutorNotes(text),
  };
}
