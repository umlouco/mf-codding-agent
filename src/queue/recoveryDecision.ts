import type * as vscode from 'vscode';
import type { NewTask, Task, Usage } from './db';
import { extractJson, runOnce, RunOptions } from './agents';
import { verdictReplacementTasks } from './scopeVerdict';

export interface RecoveryDecision {
  action: 'EXECUTE' | 'VERIFY' | 'SPLIT' | 'WAIT';
  reason: string;
  guidance: string;
  nextOperation?: { tool: string; input: Record<string, unknown> };
  splitInto?: NewTask[];
  retryAfterMs?: number;
}

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

/** No default retry, partial split, invented success, or queue-stop action. */
export function parseRecoveryDecision(text: string, task: Task): RecoveryDecision {
  const value = extractJson<any>(text);
  if (!object(value) || !['EXECUTE', 'VERIFY', 'SPLIT', 'WAIT'].includes(value.action) ||
      !nonempty(value.reason) || !nonempty(value.guidance)) {
    throw Error('Recovery requires one explicit action, observed diagnosis, and concrete guidance.');
  }
  const decision: RecoveryDecision = { action: value.action, reason: value.reason.trim(), guidance: value.guidance.trim() };
  if (task.kind === 'phase' && decision.action === 'VERIFY') {
    throw Error('An unexpanded phase has no implementation to verify. Recover its expansion or split its remaining work.');
  }
  if (value.action === 'SPLIT') {
    // The same validator used by the atomic replacement; never silently drop a part.
    verdictReplacementTasks(value.splitInto, task, 'recovery-plan-validation');
    decision.splitInto = value.splitInto;
  } else if (value.action !== 'WAIT') {
    if (!object(value.nextOperation) || !nonempty(value.nextOperation.tool) || !object(value.nextOperation.input)) {
      throw Error('Changed recovery needs a concrete next tool operation, not another paraphrase of the task.');
    }
    decision.nextOperation = { tool: value.nextOperation.tool.trim(), input: value.nextOperation.input };
  }
  if (value.action === 'WAIT') {
    if (!Number.isFinite(value.retryAfterSeconds) || value.retryAfterSeconds < 5 || value.retryAfterSeconds > 3600) {
      throw Error('WAIT requires a bounded automatic retry in 5 through 3600 seconds.');
    }
    decision.retryAfterMs = value.retryAfterSeconds * 1000;
  }
  return decision;
}

/** Stable operational identity: wording and JSON key order do not buy another attempt. */
export function recoveryOperation(decision: RecoveryDecision): unknown {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) :
    object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return canonical({ action: decision.action, operation: decision.nextOperation,
    replacements: decision.splitInto?.map(part => [part.description, part.implVerifyPrompt,
      part.solutionVerifyPrompt, part.solutionVerifyCommand]) });
}

/** One bounded, evidence-fed decision. Bad output is deferred by the scheduler, not retried here. */
export async function decideRecovery(context: vscode.ExtensionContext, output: vscode.OutputChannel,
  task: Task, evidence: string, opts: RunOptions): Promise<{ decision: RecoveryDecision; usage: Usage }> {
  const result = await runOnce(context, output, 'supervisor', `An autonomous run needs a DIFFERENT recovery approach.
The queue remains RUNNING. You cannot stop it, declare success, erase history, or weaken requirements.
Diagnose captured failures rather than inventing a psychological explanation or repeating reassuring prose.
Tool receipts outrank every agent narrative. A command containing RPC tool names is not an executable shell check.
An invalid verification harness is not proof that the product needs rewriting.
If the host supplies checkAuthority provenance, its generated adapter is NOT owner acceptance.
Do not require obsolete adapter-only assertions or unfinished sibling work to pass this task.

ASSIGNED TASK (immutable acceptance; unfinished siblings are not this task):
${JSON.stringify({ kind: task.kind, title: task.title, description: task.description, implementation: task.implVerifyPrompt,
    behavior: task.solutionVerifyPrompt, savedCheckAdapter: task.solutionVerifyCommand })}

HOST EVIDENCE AND RECOVERY HISTORY:
${evidence}

Choose one action:
VERIFY: A missing observation, incorrect tool invocation, or incomplete report needs host-executed verification.
EXECUTE: An OBSERVED implementation/test-setup defect needs a focused code change. Preserve working changes.
SPLIT: Scope contains independent unfinished outcomes. Supply ALL complete ordered replacements in this decision;
the host commits them and deletes the original atomically. Never append children while keeping the parent runnable.
WAIT: Only a concrete transient dependency/capability prevents a useful action now. State what will be rechecked
automatically and retryAfterSeconds (5..3600). This schedules work; it never requires pressing Start again.
For kind phase, EXECUTE retries expansion with concrete changed planning guidance, not product execution.
An unexpanded phase has no implementation to VERIFY; use EXECUTE, a complete SPLIT, or WAIT.

Do not choose the same unsuccessful operation with a new explanation. For EXECUTE or VERIFY, provide the
specific next tool and JSON arguments that will change the implementation or obtain the missing observation.
This is a next-step prescription, not a claim that you ran a tool. Verification compiles it against actual tool
schemas and invokes checks itself. Do not bundle browser RPC calls into shell command strings.
No taskEdits, acceptance rewrites, reset counters, rollback, or PASS action exists in this protocol.
Reply ONE JSON object:
{"action":"VERIFY","reason":"specific observed failure","guidance":"self-contained changed approach",
 "nextOperation":{"tool":"actual tool name","input":{}},"splitInto":[],"retryAfterSeconds":30}
For SPLIT each entry needs title, description, implVerifyPrompt, solutionVerifyPrompt, solutionVerifyCommand
(possibly empty). Preserve all substantive acceptance conditions and any owner-required command.`,
  { ...opts, formatOnly: true, maxIterations: 1 });
  try { return { decision: parseRecoveryDecision(result.text, task), usage: result.usage }; }
  catch (error) {
    // Invalid JSON still consumed a provider turn; do not hide that cost.
    throw Object.assign(error as Error, { usage: result.usage });
  }
}
