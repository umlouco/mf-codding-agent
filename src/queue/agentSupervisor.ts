import * as vscode from 'vscode';
import { Task, NewTask } from './db';
import { ReviewOptions, AgentRunError } from './agentTypes';
import { SupervisorDecision, attemptsExhausted, ceilingNotice, rewriteNotice, isReview, addUsage, Verdict, rewritten, appendCorrection } from './agentReviewSupport';
import { parseSupervisorSplit } from './agentSplit';
import { isLocalScope } from './scopeContract';
import { taskCognition } from './cognition';
import { originalGoalContext, projectNotesContext, recoveryRules } from './prompts';
import { validationForSupervisor, storedValidationProblem } from './validation';
import { attemptHistory } from './agentHistory';
import { runOnce, supervisorRounds } from './agentRuntime';
import { extractJson } from './agentJson';
import { reformatVerdict, escalate, demandRewrite } from './agentSupervisorRepair';

export async function superviseTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  /** How many times this task has already been rewritten — see rewriteNotice. */
  rewrites: number,
  /** The prompt the whole plan was generated from — see ceilingNotice. */
  goal: string,
  opts: ReviewOptions = {},
): Promise<SupervisorDecision> {
  opts = { ...opts, cognition: taskCognition(task, goal, 'supervisor') };
  const exhausted = attemptsExhausted(task);
  const prompt = `You are the supervisor of an autonomous coding run. First establish this task's
share of the original user goal and owner project notes. Then judge its implementation and
verification evidence. A rewritten task and a passing report can both be wrong about the goal.

The report below is from an independent verification agent, not the implementation agent.

Check the requirements before the supplied report. Tool definitions are omitted to keep the context compact;
registered tools remain callable when you need additional observations to make the decision.
Check whether the conclusion is consistent with concrete evidence for each requirement.
Your own tool use does not replace the independent verification report required for completion.

A task is never terminally failed. When the evidence is not sufficient, make exactly one
recovery decision: REVERIFY for a missing/invalid check or report without an observed code defect,
RETRY for an observed implementation or test setup defect that needs editing, or
SPLIT into several smaller ordered tasks. Use SPLIT only when scope is the obstacle; use RETRY
for a focused correction that requires changes to code or test setup.
Whether the work passes is decided by the evidence alone and never by how many attempts it took.

${originalGoalContext(goal)}

${projectNotesContext(opts.projectNotes)}

${isLocalScope(task) ? `This task is an accepted local slice of a split, not the whole parent objective.
Its description and acceptance checks remain fixed. Unfinished sibling work is not a defect in
this slice. For RETRY, put a different concrete recovery approach in feedback; do not rewrite
this task or expand it to the whole parent. SPLIT may replace only this slice's remaining work.` : ''}

${ceilingNotice(task)}

${recoveryRules}

Judge the structured current-attempt evidence, not its presentation. A successful command check
with concrete output does not need the same command duplicated verbatim in another evidence field.
An allowed-value list does not mean every allowed value must occur unless the requirement explicitly
says so. Do not reject current exact checks solely because an older attempt reported different data.

TASK ${task.seq}: ${task.title}
${rewriteNotice(rewrites)}
Requirements:
${task.description}

Required implementation check:
${task.implVerifyPrompt || 'the described code exists and is coherent'}

Required behaviour check:
${task.solutionVerifyPrompt || 'the described behaviour works'}
${task.solutionVerifyCommand ? `Required command: ${task.solutionVerifyCommand}` : ''}

INDEPENDENT VERIFICATION AGENT'S REPORT, READ FROM THE DATABASE:
${validationForSupervisor(task.validationReport)}

The observedTools field, when present, is captured by the host from the current verifier's tool
calls. Compare its inputs, outputs, and statuses with the verifier's claims. Creating a report,
reading source, or running an unrelated command cannot prove a required test executed. An observed
tool result outranks a conflicting narrative. Reject claimed runtime results absent from those
observations. Compare the task with the original request and owner notes before accepting a narrowed
check; earlier task rewrites and earlier PASS labels are not authority to discard requirements.

Earlier attempt outcomes:
${attemptHistory(task)}

Reply with ONE JSON object and nothing else:
{
  "verdict": "RETRY",
  "feedback": "why the stored validation is or is not sufficient",
  "splitInto": [{ "title": "...", "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }],
  "taskEdits": [{ "seq": ${task.seq}, "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }]
}

Set verdict to VERIFIED, REVERIFY, RETRY, or SPLIT. Use empty splitInto unless splitting; use empty taskEdits
unless making edits. Replace example strings with concrete instructions, not placeholders.
In feedback, state the original requirement this task covers and why the actual evidence satisfies
it or what remains missing. Never accept report formatting or a demonstration as a replacement for
the requested application behavior. If the task itself drifted, correct it through RETRY or SPLIT;
REVERIFY alone cannot fix a task that now requires testing the wrong thing.

Choose VERIFIED only when the verification agent concluded PASS and its database report contains
concrete implementation and behaviour evidence plus successful required commands/tests. Do not
independently repeat the checks. Choose REVERIFY when the verifier must finish checks, correct its invocation, authenticate at the
supplied URL, or complete its report. Put the exact missing checks in feedback and leave splitInto
empty. If the saved command itself has invalid syntax or quoting, REVERIFY may include one taskEdits
entry for this task containing ONLY a complete nonempty solutionVerifyCommand replacement. Preserve
every assertion and the same success conditions. Saved commands run in the portable POSIX shell on
all hosts. Never waive a required command by saying to ignore it, or replace assertions with echo PASS.
For other REVERIFY decisions leave taskEdits empty. Preserve implementation and acceptance criteria. A report format problem
must not be converted into new product requirements, a tool-call quota, or a requirement to
produce a particular table. Choose RETRY when evidence identifies changes the executor must make;
include a materially rewritten description for task ${task.seq}. Choose SPLIT when
the remaining work is more than one agent can hold at once — a report that reads as several
unfinished threads rather than one unfinished thing. For an unsuccessful task these are the available
decisions: reverify it, correct it, or split it. There is no fail or give-up verdict.`;

  const { text, usage } = await runOnce(context, output, 'supervisor', prompt, {
    maxIterations: supervisorRounds(),
    ...opts,
  });
  const total = { ...usage };

  let d: Partial<SupervisorDecision> = {};
  try {
    d = extractJson<SupervisorDecision>(text, isReview);
  } catch {
    // The model may well have reached a real conclusion — "the work is
    // correct", say — and simply forgotten the JSON envelope. Ask it to
    // restate that same judgement in the required shape before this code
    // assumes anything on its behalf; see reformatVerdict for why that is not
    // the same repair demandRewrite does.
    const reformatted = await reformatVerdict(context, output, task, text, goal, opts);
    addUsage(total, reformatted.usage);
    if (reformatted.decision) {
      d = reformatted.decision;
    } else {
      throw new AgentRunError('The supervisor supplied no readable verdict after reformatting. Preserve the task and reassess; a formatting failure is not an implementation defect.');
    }
  }

  const named = String(d.verdict ?? '').toUpperCase();
  // FAIL is no longer in the protocol. A model that has seen it elsewhere still
  // emits it, and it means "I have run out of ideas" — which is a reason to
  // rewrite the task, never a reason to end the run.
  let verdict: Verdict = (['VERIFIED', 'REVERIFY', 'RETRY', 'SPLIT'] as string[]).includes(named)
    ? (named as Verdict)
    : 'RETRY';

  const evidenceProblem = verdict === 'VERIFIED' ? storedValidationProblem(task.validationReport) : '';
  if (evidenceProblem) verdict = 'REVERIFY';

  const splitInto = verdict === 'SPLIT' ? parseSupervisorSplit(d.splitInto) : [];
  const settled = verdict;
  const feedback = evidenceProblem || String(d.feedback ?? '').trim();
  const taskEdits = (Array.isArray(d.taskEdits) ? d.taskEdits : []).filter(
    (e: any) => e && typeof e === 'object' && typeof e.seq === 'number',
  );

  const decision: SupervisorDecision = {
    verdict: settled,
    feedback,
    resetFromSeq: typeof d.resetFromSeq === 'number' ? d.resetFromSeq : undefined,
    splitInto: splitInto.length >= 2 ? splitInto : undefined,
    taskEdits,
    usage: total,
  };

  if (settled !== 'RETRY') {
    if (settled === 'REVERIFY' || settled === 'VERIFIED') {
      decision.taskEdits = settled === 'REVERIFY' && named === 'REVERIFY'
        ? taskEdits.filter(e => e.seq === task.seq && typeof e.solutionVerifyCommand === 'string' &&
          e.solutionVerifyCommand.trim() && e.solutionVerifyCommand.trim() !== task.solutionVerifyCommand.trim())
          .slice(0, 1).map(e => ({ seq: task.seq, solutionVerifyCommand: e.solutionVerifyCommand!.trim() }))
        : [];
      decision.splitInto = undefined;
    }
    return decision;
  }

  if (isLocalScope(task)) {
    return { ...decision, taskEdits: [], escalated: false };
  }

  // ---- the invariant -----------------------------------------------------
  //
  // A RETRY must change the instructions. Everything above asks the model for
  // that; this is what makes it true. Without it a supervisor that returns a
  // bare {"verdict":"RETRY"} — the single most common malformed reply there is
  // — re-runs the identical description, and the task fails identically, for as
  // long as anyone lets it.
  //
  // At the ceiling that is no longer enough on its own. The previous attempts
  // each changed the description too, so `escalated` is the claim being made
  // here: this rewrite was produced by a supervisor that was told the budget
  // was spent and given the objective the plan came from. That is what buys
  // the replacement a fresh budget in the orchestrator.
  const own = decision.taskEdits!.find((e) => e.seq === task.seq);
  if (rewritten(own?.description, task.description)) {
    return { ...decision, escalated: exhausted };
  }

  // Below the ceiling the model owes a rewrite and nothing more. At it, the
  // demand is the harder one, and splitting is on the table — see `escalate`.
  const repair = exhausted
    ? await escalate(context, output, task, goal, feedback, opts)
    : {
        ...(await demandRewrite(context, output, task, feedback, text, goal, opts)),
        splitInto: [] as NewTask[],
      };
  addUsage(total, repair.usage);

  if (repair.splitInto.length >= 2) {
    return {
      ...decision,
      verdict: 'SPLIT',
      splitInto: repair.splitInto,
      feedback: repair.feedback || feedback,
      // The row is about to be replaced by its parts, so an edit aimed at it
      // has nowhere to land.
      taskEdits: decision.taskEdits!.filter((e) => e.seq !== task.seq),
      escalated: true,
      usage: total,
    };
  }

  if (rewritten(repair.description, task.description)) {
    const rest = decision.taskEdits!.filter((e) => e.seq !== task.seq);
    return {
      ...decision,
      feedback: repair.feedback || feedback,
      taskEdits: [
        ...rest,
        {
          seq: task.seq,
          description: repair.description,
          implVerifyPrompt: repair.implVerifyPrompt || own?.implVerifyPrompt,
          solutionVerifyPrompt: repair.solutionVerifyPrompt || own?.solutionVerifyPrompt,
          solutionVerifyCommand: repair.solutionVerifyCommand || own?.solutionVerifyCommand,
        },
      ],
      escalated: exhausted,
      usage: total,
    };
  }

  // Both passes declined to write one. The executor still must not be handed
  // the same page twice, so the correction goes in as its own section: less
  // considered than a real rewrite, but it is new information, prominently
  // placed, and it is what the supervisor actually said to do.
  //
  // This still counts as the escalation at the ceiling, and deliberately so.
  // The alternative is a task whose budget is spent, whose supervisor twice
  // refused to restructure it, and which therefore has no state left to be in
  // — the counter climbs past its own limit again and we are back to "attempt
  // 7 of 3". A weak restructuring that is honestly bounded beats an unbounded
  // one, and the next review starts from a description it has not seen.
  return {
    ...decision,
    taskEdits: [
      ...decision.taskEdits!.filter((e) => e.seq !== task.seq),
      {
        seq: task.seq,
        description: appendCorrection(task, feedback || repair.feedback),
        solutionVerifyCommand: own?.solutionVerifyCommand,
      },
    ],
    escalated: exhausted,
    usage: total,
  };
}
