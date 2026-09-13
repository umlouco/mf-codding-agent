import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Region, encodeRegion, runScanCommand, parseRegion } from './agentRegions';
import { NewTask, TaskQueue, Usage, Task } from './db';
import { getBridge } from '../mcpBridge';
import { runOnce, baseRounds } from './agentRuntime';
import { extractJson, isPlan, unwrapArray } from './agentJson';
import { AgentRunError, ActivityRecord } from './agentTypes';
import { workspaceRoot } from '../detect';
import { attemptHistory } from './agentHistory';
import { projectNotesContext, playwrightTestRegistration } from './prompts';
import { taskCognition } from './cognition';
import { preparePlanningGoal } from './testingEnvironment';
import { narrowPlanningRegions, targetApplicationRegions } from './planningScope';
import { getActiveQueue } from './registry';
import { requiresPlaywright } from './playwrightPolicy';

export const MAX_PHASES = 40;

export function languageSummary(languages: Record<string, number> | undefined): string {
  const entries = Object.entries(languages ?? {}).sort((a, b) => b[1] - a[1]);
  return entries.length ? `, ${entries.map(([lang, n]) => `${lang}:${n}`).join(' ')}` : '';
}

/**
 * Turns a goal into coarse phases, each scoped to one or more regions from a
 * prior `runScanCommand` — never into the finished task list itself.
 *
 * This is what replaces the old single-shot planner. The model reasons over a
 * compact structural summary (paths, file counts, language mix) instead of
 * exploring the tree, so this turn's cost stays flat as the workspace grows;
 * exploring each phase's own slice in depth is `expandPhase`'s job, one phase
 * at a time, later.
 */
export async function generatePhases(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  goal: string,
  regions: Region[],
  maxFilesPerRegion: number,
  onEvent?: (method: string, params: any) => void,
  onCancellable?: (cancel: () => void) => void,
  role: 'planner' | 'supervisor' = 'planner',
): Promise<NewTask[]> {
  const regionList = regions
    .map((r) => `- ${r.path}  (${r.fileCount} file(s)${languageSummary(r.languages)})`)
    .join('\n');

  // Tools VS Code itself provides to every agent in this run — see
  // McpBridge.toolsSummary. Named so the plan can lean on them, the way it
  // already leans on the file, search, shell and browser tools.
  const editorTools = getBridge().toolsSummary();
  const editorToolsNote = editorTools
    ? `\nVS CODE TOOLS every agent in this run also has, beyond files, search, shell and browser:\n${editorTools}\n`
    : '';

  const prompt = `You are planning an autonomous coding run over a large workspace. The workspace has
already been scanned and split into regions small enough for one agent to explore in a
single sitting — you are not exploring the tree yourself, you are deciding which regions
matter for the goal below and how to group them into phases. A later agent will explore
each phase's own region in depth and write its detailed tasks; your job stops at scoping.

GOAL
${goal}

REGIONS (path, file count, language mix — not file contents)
${regionList || '(none — the workspace appears to be empty)'}
${editorToolsNote}
Break the goal into at most ${MAX_PHASES} phases. Reply with ONE JSON array and nothing else.

Each element must be an object with exactly these keys:
  "title"        short imperative summary of this phase, under 80 characters
  "description"  what this phase covers and why it matters to the goal — the agent that
                 expands it later will see nothing else about the overall plan but this and
                 the goal above
  "regionPaths"  array of one or more paths taken VERBATIM from the REGIONS list above — the
                 exact slice of the workspace this phase is scoped to

Rules:
- Drop regions that have nothing to do with the goal — do not create a phase for them.
- A phase represents one observable outcome, even when it spans several directories.
  Region sizes (scan granularity ${maxFilesPerRegion}) guide selective inspection, not
  an obligation to audit every file. Do not create plugin or directory audits unless an
  observed dependency requires them to achieve the goal. Keep discovery with the outcome it serves.
- Order phases in the sequence they should be expanded and executed.
- Honor the owner's development workflow, external test location, and fixed testing settings.
  Required test infrastructure is a dependency of application work. For TDD, plan runnable
  baseline checks first and pair each new failing behavior assertion with its implementation
  in the same task; independent verification runs after that task reaches GREEN.
- Scope phases by requested outcomes, not by every directory that happens to exist. Vendor code,
  generated assets, backups and duplicate applications are context unless the goal changes them.
- Do not invent paths that are not in the REGIONS list.`;

  const draft = await runOnce(context, output, role, prompt, {
    planningOnly: true,
    maxIterations: baseRounds(),
    onEvent,
    onCancellable,
  });
  const { text } = await runOnce(context, output, role, `Review and finalize an autonomous phase plan.
The draft is a proposal, not authoritative task text. Return the complete corrected phase array.
Owner request and workflow:\n${goal}
Allowed region paths:\n${regionList}
Draft:\n${draft.text}

Check every phase against these execution facts:
- The host verifies tasks before any later sibling runs. A phase whose deliverable is failing
  tests alone cannot finish. For TDD, keep RED assertions AND their GREEN implementation within
  the SAME phase and task. Rewrite any separate "write failing tests" phase together with the
  behavior it tests. Never defer making its tests pass to a later phase.
- RED means a test asserts the DESIRED final behavior and fails before implementation. GREEN
  means that SAME assertion passes after implementation. Never assert the old/undesired state
  and call its success RED; never require opposite before/after assertions to both keep passing.
  Initial-state observations belong in the TDD execution record, not permanent contrary tests.
- If browser checks are required, bootstrap dependencies, configuration, authentication access,
  and first passing real tests as one verifiable outcome. An empty suite is not a passing baseline.
- Group by observable owner outcomes. Remove speculative directory/plugin audit phases unless
  an observed dependency requires them; keep necessary discovery with the change it supports.
- Preserve the requested target environment, external tests, reference appearance, and all
  substantive behavior. Do not replace migration or runtime checks with reports or static audits.
- For appearance matching, cover the header, hero/content sections, footer, typography, colors,
  images and responsive layout. Compare visible rendering and behavior at desktop and mobile
  sizes. A replacement template may have different DOM classes and selectors; do not require
  identical internal markup as a substitute for visual parity. Keep baseline smoke checks tied
  to actual page readiness, such as HTTP success and nonempty document title.
- Appearance acceptance must include executable screenshot comparisons or visual diffs against
  the read-only live reference at matched desktop/mobile viewport sizes, with documented
  tolerances and only justified masks for dynamic content. Collecting screenshots as artifacts,
  checking element presence, or a few computed style spot-checks alone does not establish parity.
  Define the comparisons in the corresponding implementation phases and retain a final full-page
  visual regression gate that fails on remaining material differences.
- Use only the allowed region paths. Keep the full goal covered and order prerequisites first.
Return ONE JSON array, at most ${MAX_PHASES} entries, each with exactly title, description,
regionPaths. No critique prose, PASS claim, task edits, or tools.`, {
    planningOnly: true, formatOnly: true, maxIterations: 1, onEvent, onCancellable,
  });
  output.appendLine(`[queue:${role}] raw phase reply is ${text.length} chars`);

  let parsed = extractJson<unknown>(text, isPlan);
  parsed = unwrapArray(parsed);
  if (!Array.isArray(parsed)) {
    const sample =
      typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500);
    output.appendLine(`[queue:planner] extracted ${typeof parsed} instead of array: ${sample}`);
    throw new AgentRunError('the planner returned JSON but not an array of phases');
  }

  const byPath = new Map(regions.map((r) => [r.path, r]));
  const raw = (parsed as any[]).filter(
    (p) => p && typeof p === 'object' && String(p.title ?? '').trim(),
  );

  const phases: NewTask[] = [];
  for (const p of raw.slice(0, MAX_PHASES)) {
    const title = String(p.title).trim().slice(0, 200);
    const description = String(p.description ?? '').trim();
    const paths: string[] = (Array.isArray(p.regionPaths) ? p.regionPaths : [])
      .map((s: unknown) => String(s).trim())
      .filter((s: string) => byPath.has(s));
    if (paths.length === 0) {
      continue; // no real region behind this phase — nothing to expand
    }

    // Preserve outcome ownership across directories. Duplicating one description
    // per region creates repeated whole-goal audits, not smaller deliverables.
    // Expansion and the scope supervisor partition actual work when needed.
    const totalFiles = paths.reduce((sum, path) => sum + (byPath.get(path)?.fileCount ?? 0), 0);
    phases.push({ title, description, kind: 'phase', region: encodeRegion({ paths, fileCount: totalFiles }) });
  }

  if (phases.length === 0) {
    throw new AgentRunError('the planner produced no usable phases');
  }
  phases.forEach((ph, i) => (ph.seq = i + 1));
  return phases;
}

/**
 * End-to-end entry point for both planning surfaces (the Task Queue sidebar
 * and the chat's Planner): scan the workspace, generate phases for `goal`,
 * and remember the goal itself so a later `expandPhase` call — which may
 * happen long after this one returns, and in a different process entirely —
 * still knows what the plan as a whole is for.
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
This is scope selection only, before phase planning. Return exactly {"paths":["listed/path"]}.
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
  });
  output.appendLine(`[queue:planner] scanned workspace into ${regions.length} region(s)`);
  const phases = await generatePhases(context, output, goal + '\n\n' + queue.contextInstructions, regions, maxPerRegion, onEvent, onCancellable,
    queue.list().length ? 'supervisor' : 'planner');
  queue.setMeta('goal', goal);
  return phases;
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
  const activeQueue = getActiveQueue?.();
  const bootstrap = phase.seq === 1 && activeQueue && requiresPlaywright(activeQueue) &&
    !fs.existsSync(path.join(process.env.MFAGENT_PLAYWRIGHT_ROOT || workspaceRoot(),
      'node_modules', '@playwright', 'test', 'package.json'));
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
${bootstrap ? `MANDATORY PLAYWRIGHT BOOTSTRAP
The configured browser suite is not installed. The host runs playwright_test after EVERY task.
Return exactly ONE task completing this entire bootstrap phase: dependencies, configuration,
and real baseline assertions using the configured URL and credentials. Pair RED and GREEN inside
that task. An empty suite or "no tests found" is a FAILURE, never a successful scaffold.
${playwrightTestRegistration}
Do not split setup from the first passing tests. No sibling task can unblock this task's gate.\n` : ''}
First explore the region above enough to ground the plan in what is actually there. Then
reply with ONE JSON array and nothing else, at most ${MAX_TASKS_PER_PHASE} elements.

Each element must be an object with exactly these keys:
  "title"                  short imperative summary, under 80 characters
  "description"            what to build, precise enough to act on with no other context:
                            name the files, functions and behaviour
  "solutionVerifyPrompt"   how a verifier confirms the behaviour is correct against what
                            the executor actually produced
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
  in the same task. Establish a runnable baseline suite first. Never leave the shared suite failing
  for a later sibling task to repair; independent verification runs after each completed task.
- Each task must be completable by one agent in a single sitting, touching a handful of files.
- Give each task one concrete outcome, relevant file paths, prerequisites, and observable acceptance
  criteria. Carry forward discovered commands and paths; later workers do not see this exploration.
- Separate implementation from independent verification instructions. State expected outputs and
  relevant failure or boundary cases. An unavailable runtime is a prerequisite to resolve, not a PASS.
- Every task must be independently verifiable. Prefer real commands (test runners, builds,
  linters) that already work in this repo — do not invent scripts that do not exist.
- Do not include a task for the phase itself.`;

  const { text, stopReason, usage } = await runOnce(context, output, 'supervisor', prompt, {
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

  if (bootstrap && (parsed.length !== 1 || parsed[0]?.kind === 'phase')) {
    const repaired = await runOnce(context, output, 'supervisor', `${prompt}
Your previous expansion cannot pass the mandatory per-task Playwright gate because it separates
the bootstrap into multiple runnable rows. Replan it as exactly ONE concrete task containing all
setup and first passing baseline tests. Preserve every substantive requirement of this phase.
Return the complete one-element JSON array; the host will not merge or edit your task text.
Previous expansion:\n${text}`, {
      planningOnly: true, maxIterations: baseRounds(), onActivity, onEvent, onAbort,
      cognition: taskCognition(phase, goal, 'supervisor'),
    });
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[key] = (usage[key] || 0) + (repaired.usage[key] || 0);
    parsed = unwrapArray(extractJson<unknown>(repaired.text, isPlan));
    if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.kind === 'phase')
      throw Object.assign(new AgentRunError('Playwright bootstrap requires one complete independently verifiable task; planner must revise its split.'), { usage });
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
