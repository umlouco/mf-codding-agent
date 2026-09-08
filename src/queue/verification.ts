import type * as vscode from 'vscode';
import type { Task, Usage } from './db';
import { ActivityRecord, coreHalted, runOnce, RunOptions } from './agents';
import { parseExecutorValidation, serializeValidation, ToolObservation } from './validation';
import { verificationExample, reportContract, originalGoalContext, projectNotesContext } from './prompts';
import { taskCognition } from './cognition';
import { VerificationSession } from './verificationPlanRunner';
import { parseVerificationPlan, VerificationPlanError, VerificationReceipt } from './verificationPlan';
import type { VerificationAuthority } from './verificationAuthority';

export { VerificationPlanError } from './verificationPlan';
export interface VerificationOutcome {
  text: string;
  validationReport: string;
  stopReason: string;
  usage: Usage;
}

/** A check has a finite lifetime even if the model keeps emitting reasoning. */
export async function runVerification(
  context: vscode.ExtensionContext, output: vscode.OutputChannel, task: Task, goal: string,
  onActivity?: (activity: ActivityRecord) => void, onEvent?: (method: string, params: any) => void,
  onAbort?: (abort: () => void) => void, projectNotes = '', authority?: VerificationAuthority,
): Promise<VerificationOutcome> {
  let abort: (() => void) | undefined;
  let ended = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verificationPass(context, output, task, goal,
        a => { if (!ended) onActivity?.(a); },
        (method, params) => { if (!ended) onEvent?.(method, params); },
        stop => { abort = stop; onAbort?.(stop); if (ended) stop(); }, projectNotes, authority),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => {
        ended = true;
        abort?.();
        reject(new VerificationPlanError('Verification exceeded its ten-minute pass limit. Review the captured checks and exact remaining work.', 'capability'));
      }, 600_000); }),
    ]);
  } finally { ended = true; if (deadline) clearTimeout(deadline); }
}

/** Reason about requirements, execute typed checks in the host, then judge receipts. */
async function verificationPass(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  goal: string,
  onActivity?: (activity: ActivityRecord) => void,
  onEvent?: (method: string, params: any) => void,
  onAbort?: (abort: () => void) => void,
  projectNotes = '',
  authority?: VerificationAuthority,
): Promise<VerificationOutcome> {
  const admittedAuthority = authority?.source === 'extension-generated' && authority.adapter === task.solutionVerifyCommand
    ? authority : undefined;
  const effectiveCommand = admittedAuthority ? admittedAuthority.originalCommand : task.solutionVerifyCommand;
  const observations: ToolObservation[] = [];
  const started = new Map<string, { name: string; input: unknown }>();
  const observe = (method: string, params: any) => {
    if (method === 'stream/tool' && params?.id) {
      const previous = started.get(params.id);
      const name = String(params.name || previous?.name || '');
      const input = params.input ?? previous?.input ?? {};
      started.set(params.id, { name, input });
      if (['ok', 'done', 'error'].includes(params.status)) observations.push({ name,
        status: params.status, input: JSON.stringify(input), output: String(params.output ?? '').slice(0, 12000) });
    }
    onEvent?.(method, params);
  };
  const session = new VerificationSession(context, output, observe, onActivity);
  let aborted = false;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const recordUsage = (value?: Usage) => {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[key] += value?.[key] || 0;
  };
  let receipts: VerificationReceipt[] = [];
  let checkpoint: any;
  let stopModel: (() => void) | undefined;
  onAbort?.(() => { aborted = true; stopModel?.(); session.stop(); });
  const checkActive = () => { if (aborted) throw new VerificationPlanError('Verification cancelled.', 'cancelled'); };
  const options: RunOptions = {
    verificationOnly: true, cognition: taskCognition(task, goal, 'verifier'), formatOnly: true, maxIterations: 1,
    onActivity, onEvent: observe,
    onAbort: abort => { stopModel = abort; if (aborted) abort(); },
  };
  const requirements = `${originalGoalContext(goal)}\n\n${projectNotesContext(projectNotes)}
TASK ${task.seq}: ${task.title}
Assigned requirements (this task's share, not unfinished sibling work):
${task.description}
${task.splitScope || ''}
Required implementation inspection:
${task.implVerifyPrompt || 'Inspect the actual implementation and diff.'}
Required behavioral verification:
${task.solutionVerifyPrompt || 'Exercise the assigned behavior.'}
Saved check adapter (may itself be defective; never substitute its literal syntax for the requirements):
${effectiveCommand || '(none)'}
${admittedAuthority ? `HOST-PROVEN ADAPTER PROVENANCE (not additional acceptance requirements):\n${JSON.stringify(admittedAuthority)}\n` +
  'This extension-generated adapter was added after the assignment. Its extra checks are not owner\n' +
  'requirements. Diagnose its failure, but verify only the assigned description and acceptance checks.\n' +
  'Do not copy parent or sibling work out of this obsolete adapter into the verification plan.' : ''}
Supervisor follow-up:
${task.supervisorFeedback || '(none)'}
Executor handoff, UNVERIFIED CLAIMS only:
${task.output?.slice(-4000) || '(none)'}
Previous verification checkpoint (history, not proof of current state):
${task.validationReport?.slice(-8000) || '(none)'}
Use the previous host receipts to continue unfinished checks or diagnose a failed invocation.
Do not repeat the same failed invocation without a specific changed cause. If the executor changed
files since those receipts, recheck the affected behavior; historical PASS is not current proof.`;
  try {
    await session.start(context);
    checkActive();
    let planning = await runOnce(context, output, 'executor', `You are the independent verification planner.
Produce an executable plan, not claims that checks already passed. The HOST executes every step;
you cannot create observations by describing them. Do not edit production files, fixtures, tests,
expected output, requirements, or task rows. Normal build/test output is allowed.
If a test file needs rewriting, report its concrete defect for supervisor-owned repair;
the implementation executor must not rewrite the tests used to check its work.
A passing script cannot override the client's requested behavior. Keep checks INCOMPLETE for material
ambiguity or missing evidence instead of silently narrowing the owner's requirements.

${requirements}

Actual registered tool capabilities and their exact JSON input schemas:
${JSON.stringify(session.capabilities)}

Use kind shell for portable POSIX command text. Tool names are RPC capabilities, NOT shell
executables. Use kind tool with its registered name and JSON input for browser, inspection, and
other tools. Keep browser calls separate from shell text. Preserve valid saved shell commands intact.
The portable shell is already selected: do not wrap it in cmd /c or PowerShell.
Use registered background-process tools for persistent services, never a foreground dev server or
an unowned '&' shell job. Use an HTTP readiness tool rather than arbitrary sleep durations.
If a saved adapter has wrong quoting, conflates capabilities with shell executables, or encodes the
opposite success condition, adapt the invocation and explicitly explain every preserved assertion.
An absence check must distinguish 'no match' from an actual execution error; state its expected exit
code explicitly. Never turn an error into success using unconditional echo, true, or swallowed errors.
Express machine-checkable results with expect.jsonEquals, expect.includes, or expect.excludes.
For shell commands record expectExitCode; for browser assertions prefer an actual JSON expected value.
Every browser_eval used as a behavior assertion MUST supply expect.jsonEquals. Observation-only
evaluations are allowed for diagnosis, but tool success without an expectation cannot prove behavior.
Steps default to 120000ms; set timeoutMs explicitly from 1000 through 600000 for legitimate longer
tests. Deadlines bound a single invocation, not the autonomous queue's lifetime.
Include actual implementation inspection AND runtime checks whenever behavior is required.
Only use existing tools/scripts; do not invent executable names, input fields, paths, or data.
Unknown prerequisites require inspection first; list dependent unplanned work in remaining rather
than guessing or dropping it. A failed prerequisite blocks only its explicit dependants.
Do not re-run a failed exact invocation without a changed cause. No source edits, fabricated
evidence files, paid external operations unrelated to verification, or changes to user requirements.

Return ONE JSON object. At most 24 steps per round; remaining explicitly names every deferred check.
commandDisposition is retained (saved command intact), adapted (diagnosed harness correction), or
none (no saved command exists). Each step maps to a substantive assigned requirement.
For THIS task an authoritative saved command is ${effectiveCommand?.trim() ? 'PRESENT: none is INVALID; use retained or adapted.' : 'ABSENT: use none.'}
{
  "version": 1,
  "commandDisposition": "none",
  "reason": "No saved shell command exists; inspect current files and exercise required behavior.",
  "preservedAssertions": ["The assigned behavior and all acceptance conditions remain unchanged."],
  "steps": [{"id": "inspect", "requirement": "Inspect the implementation", "kind": "tool",
    "name": "read_file", "input": {"path": "confirmed/path"}, "dependsOn": []}],
  "remaining": []
}
Shell step shape: {"id":"check","requirement":"required behavior","kind":"shell",
"command":"existing check command","expectExitCode":0,"dependsOn":[]}
Tool assertion shape: {"id":"state","requirement":"required state","kind":"tool",
"name":"registered_tool","input":{},"expect":{"jsonEquals":true},"dependsOn":["inspect"]}`, options);
    recordUsage(planning.usage);
    stopModel = undefined;
    checkActive();
    if (coreHalted(planning.stopReason)) throw new VerificationPlanError('Verification planner did not finish its plan.', 'planning');
    let plan;
    try { plan = parseVerificationPlan(planning.text, effectiveCommand, session.capabilities); }
    catch (error: any) {
      // Invalid plans have executed nothing. One bounded correction is cheaper
      // than launching another verifier with the same malformed instructions.
      observe('verification/plan-rejected', { taskId: task.id, problem: String(error?.message ?? error), rejectedPlan: planning.text });
      planning = await runOnce(context, output, 'executor', `Repair a rejected verification plan, not the task.
The host rejected the complete plan BEFORE any step executed. No observations were produced.
Exact validation error: ${String(error?.message ?? error)}
${requirements}
Registered capabilities and input schemas: ${JSON.stringify(session.capabilities)}
Rejected plan: ${planning.text}
Return a complete corrected version-1 plan in the SAME JSON shape, with all original checks retained.
For a nonempty saved command use retained with its intact shell invocation, or adapted with a
concrete defect diagnosis and all preservedAssertions. Use none ONLY when no saved command exists.
Separate RPC tools from shell commands; use actual tool schemas. Correct unsupported fields and
exit expectations; do not waive checks, edit requirements, or fabricate observations. At most 24
steps; list all deferred work in remaining. Do not return commentary or a second unchanged plan.`, options);
      recordUsage(planning.usage);
      checkActive();
      if (coreHalted(planning.stopReason)) throw new VerificationPlanError('Plan correction did not finish.', 'planning');
      plan = parseVerificationPlan(planning.text, effectiveCommand, session.capabilities);
    }
    observe('verification/plan', { taskId: task.id, sourceCommand: task.solutionVerifyCommand, plan });
    checkpoint = { ...plan, sourceCommand: task.solutionVerifyCommand, effectiveCommand, commandAuthority: admittedAuthority };
    receipts = await session.execute(plan);
    checkActive();
    const result = await runOnce(context, output, 'executor', `You are the independent verification reporter.
${originalGoalContext(goal)}
CURRENT TASK ${task.seq}: ${task.title}
${task.description}
Implementation check: ${task.implVerifyPrompt || "Inspect the assigned deliverable."}
Behavior check: ${task.solutionVerifyPrompt || "Check the assigned outcome."}
${task.splitScope || ''}
${projectNotesContext(projectNotes)}

The following plan and execution receipts were captured by the HOST in this verification attempt.
ONLY these receipts establish observations. Executor handoffs, prior reports and your earlier text
are claims, not evidence. No tools are enabled in this reporting turn. Do not invent additional
command results, browser interactions, screenshots, files, or observations.
Receipt passed means the invocation and declared expectations succeeded, NOT that the user requirement
is satisfied. assertion=unasserted means only an observation was collected; it is not a passing assertion.
For example, an executed search that returned matches cannot establish absence. A boolean false from
an evaluation is still false even when the tool completed successfully. Never invert these observations.

PLAN:
${JSON.stringify(plan)}
HOST RECEIPTS:
${JSON.stringify(receipts)}

Inspect the substantive requirements and adapter correctness as well as result statuses. A tool
that ran successfully may still demonstrate a requirement failure. An adapted harness must preserve
every acceptance condition. Report FAIL for an observed violation; INCOMPLETE for an invalid harness,
missing steps, truncated evidence that cannot establish the assertion, or any unverified requirement.
PASS requires actual implementation AND relevant behavior evidence; no receipt means no evidence.
Each check object MUST include stepId, exactly matching its corresponding host receipt stepId.
Use kind command/test only for real executed commands/test tools, never source inspection.
Each check's evidence must cite its corresponding receipt stepId. Preserve remaining from the plan
and add every check not independently established. Never claim this local task delivers its siblings.

The queue report schema below controls the final response.
${reportContract}
Return ONE JSON object.
${verificationExample.replace(/"kind":/g, '"stepId": "receipt-id", "kind":')}`, options);
    recordUsage(result.usage);
    stopModel = undefined;
    checkActive();
    const report = parseExecutorValidation(result.text, coreHalted(result.stopReason));
    const missing = receiptProblems(receipts, plan.remaining);
    for (const check of report.checks) {
      const receipt = receipts.find(value => value.stepId === check.stepId);
      if (!receipt) missing.push(`Check ${check.name} has no exact host receipt binding.`);
      else if (['command', 'test'].includes(check.kind) && receipt.kind !== 'shell' && !/(?:^|_)test$/.test(receipt.name)) {
        missing.push(`Check ${check.name} claims runtime execution but binds only an inspection tool.`);
      }
      else if (check.kind === 'browser' && !/(?:browser_|playwright_)/.test(receipt.name)) {
        missing.push(`Browser check ${check.name} is not bound to a browser execution receipt.`);
      }
      else if (check.kind === 'browser' && receipt.name === 'browser_eval' && receipt.assertion !== 'passed') {
        missing.push(`Browser check ${check.name} has no successfully evaluated machine expectation; tool execution alone is not an assertion.`);
      }
    }
    if (report.conclusion === 'PASS' && missing.length) {
      report.conclusion = 'INCOMPLETE';
      report.remaining = [report.remaining, ...missing].filter(Boolean).join(' ');
    }
    const claimedBrowser = report.checks.some(check => check.kind === 'browser') ||
      /\b(browser|screenshot|rendered DOM)\b/i.test(report.behaviorEvidence);
    if (report.conclusion === 'PASS' && claimedBrowser && !receipts.some(receipt =>
      receipt.passed && /(?:browser_|playwright_)/.test(receipt.name))) {
      report.conclusion = 'INCOMPLETE';
      report.remaining = 'Browser behavior was claimed without any successful host browser receipt.';
    }
    return { text: result.text, validationReport: serializeValidation({ ...report,
      observedTools: observations, verificationPlan: checkpoint,
      verificationReceipts: receipts } as typeof report), stopReason: result.stopReason, usage };
  } catch (cause: any) {
    const error = cause instanceof VerificationPlanError ? cause : new VerificationPlanError(String(cause?.message ?? cause), aborted ? 'cancelled' : 'planning');
    error.usage = usage;
    if (receipts.length) error.validationReport = JSON.stringify({ conclusion: 'INCOMPLETE',
      summary: 'Verification reporting did not finish; host execution receipts are preserved.',
      implementationEvidence: '', behaviorEvidence: '', checks: [], remaining: error.message,
      observedTools: observations, verificationPlan: checkpoint, verificationReceipts: receipts });
    throw error;
  } finally { stopModel = undefined; recordUsage(session.usage); session.stop(); }
}

export function receiptProblems(receipts: VerificationReceipt[], remaining: string[]): string[] {
  const missing = [...remaining];
  if (!receipts.length) missing.push('No host execution receipts were produced; narrative cannot prove verification.');
  for (const receipt of receipts) if (!receipt.passed) missing.push(`${receipt.stepId}: ${receipt.problem}`);
  return missing;
}
