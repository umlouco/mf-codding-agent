import { CompletionClaim, parseCompletionClaim, extractExecutorNotes } from './validation';
import { Usage, Task } from './db';
import * as vscode from 'vscode';
import { ActivityRecord, RunOptions } from './agentTypes';
import { decisionOnlyReport } from './agentHistory';
import { buildExecutorPrompt } from './executorPrompt';
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
  const prompt = buildExecutorPrompt(task, instructions, goal);

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
