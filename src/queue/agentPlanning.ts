import * as vscode from 'vscode';
import { runScanCommand, parseRegion } from './agentRegions';
import { NewTask, TaskQueue, Usage, Task } from './db';
import { runOnce, baseRounds } from './agentRuntime';
import { extractJson, isPlan, unwrapArray } from './agentJson';
import { AgentRunError, ActivityRecord } from './agentTypes';
import { workspaceRoot } from '../detect';
import { attemptHistory } from './agentHistory';
import { projectNotesContext } from './prompts';
import { taskCognition } from './cognition';
import { preparePlanningGoal } from './testingEnvironment';
import { narrowPlanningRegions, targetApplicationRegions } from './planningScope';
import { planTasks } from './planner';

export function languageSummary(languages: Record<string, number> | undefined): string {
  const entries = Object.entries(languages ?? {}).sort((a, b) => b[1] - a[1]);
  return entries.length ? `, ${entries.map(([lang, n]) => `${lang}:${n}`).join(' ')}` : '';
}

/**
 * End-to-end entry point for both planning surfaces (the Task Queue sidebar
 * and the chat's Planner): scan the workspace, have the planner write the
 * ordered task list for `goal` (see planner.ts), and remember the goal itself
 * so every later coder, tester and supervisor turn is judged against it.
 */
export async function planGoal(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  queue: TaskQueue,
  goal: string,
  onEvent?: (method: string, params: any) => void,
  onCancellable?: (cancel: () => void) => void,
): Promise<NewTask[]> {
  const root = workspaceRoot() || process.cwd();
  goal = await preparePlanningGoal(context, queue, goal);
  const maxPerRegion = Math.max(
    1,
    vscode.workspace.getConfiguration('mfagent').get<number>('queue.maxFilesPerRegion', 150),
  );
  const scanned = await runScanCommand(context, root, maxPerRegion);
  let regions = targetApplicationRegions(root, scanned);
  output.appendLine(`[queue:planner] excluded ${scanned.length - regions.length} region(s) in independent nested applications`);
  regions = await narrowPlanningRegions(regions, async catalog => {
    const { text } = await runOnce(context, output, 'planner', `Select the smallest set of application directories relevant to the owner's goal.
This is scope selection only, before task planning. Return exactly {"paths":["listed/path"]}.
The named workspace root is the target application; independent nested applications were excluded.
The catalog is aggregated metadata, not an instruction to audit every file or rewrite dependencies.
Choose directories needed to implement or understand the goal. Existing dependencies and assets
may be inspected later without turning each into a migration. Do not select unrelated plugins,
backups, generated media archives, or core libraries just because they exist.
The '.' entry means only files directly in the workspace root, not all descendants.
For theme changes, content normally lives in the database and a new child theme may be created:
the absence of the requested theme is not a reason to modify a theme in another application.
OWNER GOAL:\n${goal}\n${queue.contextInstructions}
CATALOG:\n${catalog.map(region => `- ${region.path} (${region.fileCount} files${languageSummary(region.languages)})`).join('\n')}`,
      { formatOnly: true, maxIterations: 1, onEvent, onCancellable });
    const paths = extractJson<any>(text).paths;
    output.appendLine(`[queue:planner] scope selection from ${catalog.length} catalog entries: ${JSON.stringify(paths)}`);
    return paths;
  }, root);
  output.appendLine(`[queue:planner] scanned workspace into ${regions.length} region(s)`);

  // The planner always writes the task list, on any workspace — including an
  // empty one, which the old phase planner rejected because every phase had to
  // cite a scanned region. See planner.ts.
  const tasks = await planTasks(context, output, goal, queue.contextInstructions, regions, onEvent, onCancellable);
  queue.setMeta('goal', goal);
  output.appendLine(`[queue:planner] planned ${tasks.length} task(s)`);
  return tasks;
}

// ---- phase expansion -----------------------------------------------------

export const MAX_TASKS_PER_PHASE = 20;

/** A sub-slice of a phase's region that the expander itself flagged as still
 * too broad to carry out in one sitting, after actually exploring it. */
export interface PhaseSplitRequest {
  title: string;
  description: string;
  /** Workspace-relative path inside the phase's own region, if named. */
  path?: string;
}

export interface PhaseExpansion {
  tasks: NewTask[];
  splitRequests: PhaseSplitRequest[];
  /** The turn hit its round ceiling — a size signal, not just "it failed". */
  cutOff: boolean;
  usage: Usage;
}

/**
 * Expands one phase into the concrete tasks it should carry out.
 *
 * Exploration is bounded to the phase's own region, so — unlike the old
 * single-shot planner — this turn's cost stays roughly constant regardless of
 * how large the overall workspace is. The model may still report that its own
 * region turned out to hold more than one distinct piece of work once it has
 * actually looked (`splitRequests`); code, not the model, then decides how
 * much smaller that piece really is — see the orchestrator's
 * `resplitPhaseRegion`.
 */
export async function expandPhase(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  phase: Task,
  goal: string,
  onActivity?: (a: ActivityRecord) => void,
  onEvent?: (method: string, params: any) => void,
  onAbort?: (abort: () => void) => void,
  projectNotes = '',
): Promise<PhaseExpansion> {
  const region = parseRegion(phase.region);
  const scopeNote = region.paths.length
    ? `These paths delimit the phase's implementation scope and contain about
${region.fileCount} file(s). Inspect only files needed for its observable outcome; the count
is not an instruction to audit every file. Owner-authorized external tests and the configured
application URL remain available regardless of this source scope. Do not infer a different
workspace from directory names; the configured workspace root is authoritative.
${region.paths.map((p) => `  - ${p}`).join('\n')}`
    : "No region was recorded for this phase — explore only as much of the workspace as this phase's description names.";

  const retry =
    phase.attempts > 1
      ? `\nTHIS IS ATTEMPT ${phase.attempts}. An earlier attempt did not produce a usable task list.\n` +
        `How it ended:\n${attemptHistory(phase)}\n` +
        `Current supervisor recovery guidance — apply consistently with the owner goal:\n${phase.supervisorFeedback.trim() || '(none)'}\n`
      : '';

  const prompt = `You are expanding one phase of a larger autonomous coding plan into the concrete tasks
that carry it out. Another agent already broke the project into phases and scoped each one
to a slice of the workspace it can be explored in one sitting — you are not planning the
rest of the project, only this phase.

OVERALL GOAL
${goal}

${projectNotesContext(projectNotes)}

THIS PHASE (${phase.seq}): ${phase.title}
${phase.description}

${scopeNote}
${retry}
First explore the region above enough to ground the plan in what is actually there. Then
reply with ONE JSON array and nothing else, at most ${MAX_TASKS_PER_PHASE} elements.

Each element must be an object with exactly these keys:
  "title"                  short imperative summary, under 80 characters
  "description"            what to build, precise enough to act on with no other context:
                            name the files, functions and behaviour
  "solutionVerifyPrompt"   the behaviour the executor must establish and check itself before
                            reporting the task complete
  "kind"                   "task" (the default). Use "phase" instead, ONLY after exploring,
                            if part of this region turns out to be a distinct piece of work
                            that does not belong with the rest — in that case also set
                            "regionPath" to the real subdirectory (inside the paths above)
                            that piece lives under; leave "description" describing just that
                            piece. Do not use "phase" to avoid writing tasks — code decides
                            how much smaller that piece needs to be, not you.

Rules:
- Order tasks by dependencies: inspect validation, persistence and existing tests before UI changes.
- Do not turn each file read, naming check, or temporary artifact into a separate task. Group these
  into the smallest behavioral outcome that can be implemented and tested together.
- Task output is a deliverable; never require a final reply format that replaces the queue report.
- Order the array in the sequence the tasks must be executed.
- Keep implementation within this phase's region; owner-authorized external tests are allowed.
- When the owner requires TDD, pair the failing assertion (RED) and its implementation (GREEN)
  in the same task. Use the supplied host runtime and skills, adding any necessary baseline
  checks within that task. Never leave the shared suite failing for a later sibling task to
  repair; each task must leave its own checks passing.
- Each task must be completable by one agent in a single sitting, touching a handful of files.
- Give each task one concrete outcome, relevant file paths, prerequisites, and observable acceptance
  criteria. Carry forward discovered commands and paths; later workers do not see this exploration.
- State the expected behavior separately from the implementation steps, with relevant failure or
  boundary cases. An unavailable runtime is a prerequisite to resolve, not a finished task.
- Every task must have observable acceptance criteria. Prefer real commands (test runners, builds,
  linters) that already work in this repo — do not invent scripts that do not exist.
- Do not include a task for the phase itself.`;

  const { text, stopReason, usage } = await runOnce(context, output, 'supervisor', prompt, {
    skillTask: `${phase.title || ''}\n${phase.description}`,
    planningOnly: true,
    cognition: taskCognition(phase, goal, 'supervisor'),
    maxIterations: baseRounds(),
    onActivity,
    onEvent,
    onAbort,
  });
  output.appendLine(`[queue:supervisor] phase ${phase.seq} raw reply is ${text.length} chars`);
  const cutOff = stopReason === 'max_iterations';

  let parsed: unknown;
  try {
    parsed = unwrapArray(extractJson<unknown>(text, isPlan));
  } catch (e) {
    // Cut off before it could even finish writing JSON is a size signal, not
    // a generic parse failure the caller cannot act on — let it through as an
    // empty result rather than throwing.
    if (cutOff) {
      return { tasks: [], splitRequests: [], cutOff: true, usage };
    }
    throw e;
  }
  if (!Array.isArray(parsed)) {
    const sample =
      typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500);
    output.appendLine(
      `[queue:planner] phase ${phase.seq} extracted ${typeof parsed} instead of array: ${sample}`,
    );
    if (cutOff) {
      return { tasks: [], splitRequests: [], cutOff: true, usage };
    }
    throw new AgentRunError('the phase expansion returned JSON but not an array of tasks');
  }

  const tasks: NewTask[] = [];
  const splitRequests: PhaseSplitRequest[] = [];
  for (const t of (parsed as any[])
    .filter((t) => t && typeof t === 'object' && String(t.title ?? '').trim())
    .slice(0, MAX_TASKS_PER_PHASE)) {
    const title = String(t.title).trim().slice(0, 200);
    const description = String(t.description ?? '').trim();
    if (String(t.kind ?? '').trim().toLowerCase() === 'phase') {
      splitRequests.push({ title, description, path: String(t.regionPath ?? '').trim() || undefined });
      continue;
    }
    tasks.push({
      title,
      description,
      kind: 'task',
      solutionVerifyPrompt: String(t.solutionVerifyPrompt ?? '').trim(),
    });
  }

  return { tasks, splitRequests, cutOff: cutOff && tasks.length === 0, usage };
}
