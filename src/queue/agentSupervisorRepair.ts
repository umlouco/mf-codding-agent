import * as vscode from 'vscode';
import { Task, NewTask, Usage } from './db';
import { ReviewOptions, NO_USAGE, AgentRunError } from './agentTypes';
import { attemptHistory } from './agentHistory';
import { originalGoalContext, projectNotesContext, recoveryRules } from './prompts';
import { SupervisorDecision, isReview } from './agentReviewSupport';
import { parseSupervisorSplit } from './agentSplit';
import { runOnce, supervisorRounds } from './agentRuntime';
import { extractJson } from './agentJson';

/**
 * The demand made of a supervisor whose task has spent its attempt budget.
 *
 * `demandRewrite` asks for the one thing a RETRY owes and did not deliver. This
 * asks a harder question and offers a way out that one does not: three attempts
 * against a single description have failed, so the description is the suspect,
 * and the supervisor either breaks the task up or rebuilds it from the
 * objective the plan was generated from. Re-wording is explicitly off the
 * table, because re-wording is what the last three attempts were.
 *
 * A reply with fewer than two parts and no rewrite is a refusal, and the caller
 * treats it as one; nothing here fabricates a split to force the shape.
 */
export async function escalate(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  goal: string,
  feedback: string,
  opts: ReviewOptions,
): Promise<{
  splitInto: NewTask[];
  description: string;
  implVerifyPrompt: string;
  solutionVerifyPrompt: string;
  solutionVerifyCommand: string;
  feedback: string;
  usage: Usage;
}> {
  const prompt = `Task ${task.seq} has now used all ${task.maxAttempts} attempts its plan allowed, and you asked
for another one without restructuring it. That is the one answer this task cannot take: the
previous attempts each ran a description you had already corrected, and each failed anyway.

TASK ${task.seq}: ${task.title}

The description that has failed ${task.attempts} times:
${task.description}

${task.splitScope || ''}

What you said was wrong with the last attempt:
${feedback || '(nothing recorded)'}

How the attempts ended:
${attemptHistory(task)}
${originalGoalContext(goal)}

${projectNotesContext(opts.projectNotes)}

Decide which of the two failures this is, and answer with ONE JSON object and nothing else.

If the task is TOO BIG — the work is several distinct pieces and no single agent turn can carry
all of it — split it:
{
  "splitInto": [{ "title": "...", "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }],
  "feedback": "why the scope was the obstacle"
}
Give every required part, at least two, in execution order, each independently doable and
independently verifiable. Together they must cover everything the original asked for and nothing
more.

Otherwise rewrite the recovery instructions using the diagnosed failure:
${recoveryRules}
{
  "description": "Full self-contained task: required behavior, confirmed files, completed work, and next concrete steps.",
  "implVerifyPrompt": "a replacement implementation inspection that can actually be performed",
  "solutionVerifyPrompt": "a replacement behavioural success condition that can actually be met",
  "solutionVerifyCommand": "",
  "feedback": "what was wrong with the premise, in one or two sentences"
}

Send one shape or the other, not both. Do not return a lightly edited version of the text above —
change the failed approach while preserving the goal. An empty solutionVerifyCommand keeps the
current command; otherwise provide the complete replacement command.`;

  const { text, usage } = await runOnce(context, output, 'supervisor', prompt, {
    maxIterations: supervisorRounds(),
    ...opts,
  });
  const d = extractJson<any>(text);
  const hasSplit = d?.splitInto !== undefined && !(Array.isArray(d.splitInto) && !d.splitInto.length);
  const splitInto = hasSplit ? parseSupervisorSplit(d.splitInto) : [];
  if (!splitInto.length && (typeof d?.description !== 'string' || !d.description.trim())) {
    throw new AgentRunError('Escalation supplied neither a complete split nor a rewritten task. Original task preserved.');
  }
  return {
    splitInto,
    description: String(d?.description ?? '').trim(),
    implVerifyPrompt: String(d?.implVerifyPrompt ?? '').trim(),
    solutionVerifyPrompt: String(d?.solutionVerifyPrompt ?? '').trim(),
    solutionVerifyCommand: String(d?.solutionVerifyCommand ?? '').trim(),
    feedback: String(d?.feedback ?? '').trim(),
    usage,
  };
}

/**
 * Asks the supervisor to restate its own last reply as the required JSON
 * object, without reconsidering what it concluded.
 *
 * A reply that reads as a real conclusion in plain prose — "the work is
 * complete and correct" — is not evidence the task failed; it is evidence the
 * model forgot the JSON envelope. Treating every unparseable reply as a
 * disguised RETRY, the way the fallback below has to, throws that conclusion
 * away and replaces it with a manufactured "did not return a parseable
 * verdict" note — which then goes on to look like negative feedback on a task
 * that may well have just been verified. This asks for nothing but the
 * format fix, so whatever verdict comes back — VERIFIED included — is the
 * model's real judgement, not a guess this code made on its behalf.
 *
 * Deliberately not `demandRewrite`: that prompt is built on the premise that
 * the model already asked for another attempt and only forgot the rewrite.
 * Handing it a reply that was never a RETRY in the first place — most often
 * exactly this "it's already done" case — asks the model to justify a
 * decision it never made, which produces a second reply no more trustworthy
 * than the first.
 */
export async function reformatVerdict(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  rawReply: string,
  goal: string,
  opts: ReviewOptions,
): Promise<{ decision?: Partial<SupervisorDecision>; usage: Usage }> {
  const prompt = `Your last reply about task ${task.seq} was not returned as the required JSON object, so it
could not be read as a verdict. Here is exactly what you wrote:

${rawReply.slice(0, 4000)}

${originalGoalContext(goal)}

${projectNotesContext(opts.projectNotes)}

Restate the SAME judgement — do not reconsider it, do not change your mind, just put it in the
required shape — as ONE JSON object and nothing else:
{
  "verdict": "RETRY",
  "feedback": "what you found, and for a retry exactly what to do differently",
  "splitInto": [{ "title": "...", "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }],
  "taskEdits": [{ "seq": ${task.seq}, "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }]
}

Set verdict to VERIFIED, REVERIFY, RETRY, SPLIT, or REPAIR_TESTS to match the original conclusion. Use empty arrays for
splitInto and taskEdits when they do not apply. Return valid JSON, without code fences.

If your reply above reached a clear conclusion — the work is correct, it needs another attempt,
it is too big to finish in one sitting — that conclusion,
and nothing else, is what "verdict" should say. If it was VERIFIED, say so; do not turn a pass
into a retry just because the first reply was not formatted correctly. If your conclusion really
was that this task needs another attempt, "taskEdits" must include a rewritten "description" for
task ${task.seq} — the same requirement the original instructions gave you.`;

  try {
    const { text, usage } = await runOnce(context, output, 'supervisor', prompt, {
      maxIterations: Math.min(supervisorRounds(), 12),
      ...opts,
    });
    return { decision: extractJson<Partial<SupervisorDecision>>(text, isReview), usage };
  } catch {
    return { usage: { ...NO_USAGE } };
  }
}

/**
 * Asks the supervisor for the one thing it owed and did not deliver.
 *
 * This is a second turn, so it is not free, and it only happens when the first
 * reply broke the contract. It is worth the spend: the alternative is an
 * attempt that was decided before it started.
 */
export async function demandRewrite(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  feedback: string,
  rawReply: string,
  goal: string,
  opts: ReviewOptions,
): Promise<{
  description: string;
  implVerifyPrompt: string;
  solutionVerifyPrompt: string;
  solutionVerifyCommand: string;
  feedback: string;
  usage: Usage;
}> {
  const prompt = `You judged task ${task.seq} and asked for another attempt, but you did not supply the
rewritten description that a retry requires. Supply it now.

${originalGoalContext(goal)}

${projectNotesContext(opts.projectNotes)}

The executor is a fresh agent. Provide self-contained recovery instructions; it does not see
your full conversation. It receives the task, recent failure history, and supervisor feedback.

${recoveryRules}

TASK ${task.seq}: ${task.title}

The description the last attempt was given, which did not work:
${task.description}

${task.splitScope || ''}

What you said was wrong with the attempt:
${feedback || '(you did not say)'}
${rawReply ? `\nYour reply, for reference:\n${rawReply.slice(0, 1500)}` : ''}

How the attempts on this task have gone, oldest first:
${attemptHistory(task)}

Reply with ONE JSON object and nothing else:
{
  "description": "Full task with confirmed files, required behavior, completed work, and the next concrete correction.",
  "implVerifyPrompt": "a precise replacement implementation inspection",
  "solutionVerifyPrompt": "a precise replacement behavioral success condition",
  "solutionVerifyCommand": "",
  "feedback": "one or two sentences of standing instruction for the executor"
}
Use an empty solutionVerifyCommand to keep the current command, or supply the complete replacement.`;

  try {
    const { text, usage } = await runOnce(context, output, 'supervisor', prompt, {
      maxIterations: Math.min(supervisorRounds(), 12),
      ...opts,
    });
    const d = extractJson<any>(text);
    return {
      description: String(d?.description ?? '').trim(),
      implVerifyPrompt: String(d?.implVerifyPrompt ?? '').trim(),
      solutionVerifyPrompt: String(d?.solutionVerifyPrompt ?? '').trim(),
      solutionVerifyCommand: String(d?.solutionVerifyCommand ?? '').trim(),
      feedback: String(d?.feedback ?? '').trim(),
      usage,
    };
  } catch {
    return {
      description: '',
      implVerifyPrompt: '',
      solutionVerifyPrompt: '',
      solutionVerifyCommand: '',
      feedback: '',
      usage: { ...NO_USAGE },
    };
  }
}
