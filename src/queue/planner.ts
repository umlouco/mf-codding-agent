import type * as vscode from 'vscode';
import type { NewTask } from './db';
import type { Region } from './agentRegions';
import { runOnce, baseRounds } from './agentRuntime';
import { extractJson, isPlan, unwrapArray } from './agentJson';
import { AgentRunError } from './agentTypes';

/**
 * The planner: goal → ordered task list, in one planning turn.
 *
 * This replaces both earlier shapes. The phase pipeline (planner → up to 40
 * phases → a supervisor turn per phase to expand it) cost a model call per
 * phase before any code was written, and it threw on an empty workspace because
 * every phase had to cite a scanned region. The single-task "direct run" that
 * was bolted on to avoid that skipped the planner altogether. Here the planner
 * always runs, on any workspace, and writes the executable tasks itself.
 *
 * The list is sized to the goal, from one task for a trivial change up to
 * MAX_PLAN_TASKS for a system built from scratch. Each task is one coder session
 * with one observable outcome and acceptance criteria the independent tester
 * can execute, because that is the unit the supervisor orchestrates.
 */

export const MAX_PLAN_TASKS = 100;

export interface PlannedTask {
  title: string;
  description: string;
  acceptance: string;
}

function regionCatalog(regions: Region[]): string {
  if (!regions.length) {
    return '(the workspace is empty — this is a from-scratch build; the first task creates the project)';
  }
  return regions.slice(0, 200).map(r => `- ${r.path} (${r.fileCount} file(s))`).join('\n');
}

export function plannerPrompt(goal: string, ownerContext: string, regions: Region[]): string {
  return `You are the planner of an autonomous coding queue. Turn the owner's request into the
ordered task list that a coder agent will implement one task at a time. After each task an
independent tester agent verifies it with real tools (tests, a served page, a browser), and a
supervisor agent reviews progress and decides retries, rewrites and splits.

OWNER REQUEST
${goal.trim()}
END OWNER REQUEST
${ownerContext.trim() ? `\nOWNER CONTEXT\n${ownerContext.trim()}\nEND OWNER CONTEXT\n` : ''}
WORKSPACE (paths and file counts from a scan, not contents)
${regionCatalog(regions)}

Use the read-only tools to look at existing code only when it changes the plan. Then reply
with ONE JSON object and nothing else:
{"tasks":[{"title":"...","description":"...","acceptance":"..."}]}

Sizing — this matters more than anything else:
- One task = one coder session of a few minutes that ends in one observable, testable outcome.
- Size the list to the request, between 1 and ${MAX_PLAN_TASKS} tasks. A small program is a
  handful of tasks; a full application built from scratch can need dozens. Never pad the
  list with audits, "set up tooling" chores, or documentation nobody asked for, and never
  cram unrelated features into one task to keep the list short.
- Every task must leave the project in a runnable state.

Each task:
- "title": imperative, under 80 characters.
- "description": self-contained instructions for a coder who sees only this task and the
  owner request: files to create or change, functions and data, behavior, and how it builds
  on earlier tasks. Name concrete paths. For a from-scratch build, the first task creates
  the project skeleton and states how it is run.
- "acceptance": the checks the tester will execute: commands to run and their expected
  result, or pages to open and interactions to perform with the expected visible outcome.
  Concrete and observable, never "works correctly".

Order by dependency. When the request asks for testing (for example "test it in the
browser"), put those checks into the acceptance of the tasks that deliver the behavior, and
end with a task whose acceptance exercises the complete deliverable end to end the way the
request describes. Keep automated tests next to the code they test, in the same task.`;
}

function field(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** Validates the planner's reply into tasks, or explains why it cannot. */
export function parsePlan(text: string): PlannedTask[] {
  const parsed = unwrapArray(extractJson<unknown>(text, isPlan));
  if (!Array.isArray(parsed)) {
    throw new AgentRunError('the planner did not return a task array');
  }
  const tasks: PlannedTask[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const title = field(item.title, 200);
    const description = field(item.description, 12000);
    const acceptance = field(item.acceptance ?? item.solutionVerifyPrompt, 6000);
    if (!title || !description) continue;
    tasks.push({ title, description, acceptance: acceptance || `Establish that "${title}" works as described.` });
    if (tasks.length === MAX_PLAN_TASKS) break;
  }
  if (!tasks.length) {
    throw new AgentRunError('the planner returned no usable tasks');
  }
  return tasks;
}

export function toNewTasks(planned: PlannedTask[]): NewTask[] {
  return planned.map((t, i) => ({
    seq: i + 1,
    title: t.title,
    description: t.description,
    solutionVerifyPrompt: t.acceptance,
    kind: 'task',
  }));
}

/**
 * Runs the planner. A reply that cannot be parsed gets one format-only repair
 * turn with the draft attached, rather than a second full planning session.
 */
export async function planTasks(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  goal: string,
  ownerContext: string,
  regions: Region[],
  onEvent?: (method: string, params: any) => void,
  onCancellable?: (cancel: () => void) => void,
): Promise<NewTask[]> {
  const draft = await runOnce(context, output, 'planner', plannerPrompt(goal, ownerContext, regions), {
    skillTask: goal,
    planningOnly: true,
    maxIterations: baseRounds(),
    onEvent,
    onCancellable,
  });
  output.appendLine(`[queue:planner] plan reply is ${draft.text.length} chars`);
  try {
    return toNewTasks(parsePlan(draft.text));
  } catch (error) {
    output.appendLine(`[queue:planner] plan did not parse (${String(error)}); asking for the JSON only`);
  }
  const repaired = await runOnce(context, output, 'planner',
    `Return the task list below as ONE JSON object {"tasks":[{"title","description","acceptance"}]}, ` +
    `at most ${MAX_PLAN_TASKS} tasks, keeping every task's content. No prose, no fences.\n\nDRAFT:\n${draft.text.slice(-60000)}`,
    { planningOnly: true, formatOnly: true, maxIterations: 1, onEvent, onCancellable });
  return toNewTasks(parsePlan(repaired.text));
}
