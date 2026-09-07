import * as vscode from 'vscode';
import { Region, encodeRegion, runScanCommand, parseRegion } from './agentRegions';
import { NewTask, TaskQueue, Usage, Task } from './db';
import { getBridge } from '../mcpBridge';
import { runOnce, baseRounds } from './agentRuntime';
import { extractJson, isPlan, unwrapArray } from './agentJson';
import { AgentRunError, ActivityRecord } from './agentTypes';
import { workspaceRoot } from '../detect';
import { attemptHistory } from './agentHistory';
import { projectNotesContext } from './prompts';
import { taskCognition } from './cognition';

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
- Keep each region in its own phase unless a few small, closely related regions clearly
  belong together. Do not merge a region whose file count alone is already close to
  ${maxFilesPerRegion} — that phase would not fit its own exploration in one sitting.
- Order phases in the sequence they should be expanded and executed.
- Do not invent paths that are not in the REGIONS list.`;

  const { text } = await runOnce(context, output, 'planner', prompt, {
    maxIterations: baseRounds(),
    onEvent,
    onCancellable,
  });
  output.appendLine(`[queue:planner] raw phase reply is ${text.length} chars`);

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

    // Code decides size, not the model's choice of what to merge: a phase
    // whose combined region file count is still too big for one sitting is
    // split back into one phase per region instead of trusting the merge.
    const totalFiles = paths.reduce((sum, path) => sum + (byPath.get(path)?.fileCount ?? 0), 0);
    if (paths.length > 1 && totalFiles > maxFilesPerRegion) {
      for (const path of paths) {
        const r = byPath.get(path)!;
        phases.push({
          title: `${title} — ${path}`,
          description,
          kind: 'phase',
          region: encodeRegion({ paths: [path], fileCount: r.fileCount }),
        });
      }
    } else {
      phases.push({
        title,
        description,
        kind: 'phase',
        region: encodeRegion({ paths, fileCount: totalFiles }),
      });
    }
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
  const maxPerRegion = Math.max(
    1,
    vscode.workspace.getConfiguration('mfagent').get<number>('queue.maxFilesPerRegion', 150),
  );
  const regions = await runScanCommand(context, root, maxPerRegion);
  output.appendLine(`[queue:planner] scanned workspace into ${regions.length} region(s)`);
  const phases = await generatePhases(context, output, goal, regions, maxPerRegion, onEvent, onCancellable);
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
  const region = parseRegion(phase.region);
  const scopeNote = region.paths.length
    ? `Explore ONLY these paths — they were chosen because together they hold about
${region.fileCount} file(s), small enough to cover in this one sitting. Do not read or plan
for anything outside them:
${region.paths.map((p) => `  - ${p}`).join('\n')}`
    : "No region was recorded for this phase — explore only as much of the workspace as this phase's description names.";

  const retry =
    phase.attempts > 1
      ? `\nTHIS IS ATTEMPT ${phase.attempts}. An earlier attempt did not produce a usable task list.\n` +
        `How it ended:\n${attemptHistory(phase)}\n`
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
  "implVerifyPrompt"       how a reviewer confirms the code and files exist as described
  "solutionVerifyPrompt"   how a reviewer confirms the behaviour is correct
  "solutionVerifyCommand"  a portable POSIX shell command (the unix tool on every host) that exits 0 on success and non-zero on
                            failure, or "" if none applies
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
- Stay inside this phase's region. Do not propose work on files outside it.
- Each task must be completable by one agent in a single sitting, touching a handful of files.
- Give each task one concrete outcome, relevant file paths, prerequisites, and observable acceptance
  criteria. Carry forward discovered commands and paths; later workers do not see this exploration.
- Separate implementation from independent verification instructions. State expected outputs and
  relevant failure or boundary cases. An unavailable runtime is a prerequisite to resolve, not a PASS.
- Every task must be independently verifiable. Prefer real commands (test runners, builds,
  linters) that already work in this repo — do not invent scripts that do not exist.
- Do not include a task for the phase itself.`;

  const { text, stopReason, usage } = await runOnce(context, output, 'planner', prompt, {
    cognition: taskCognition(phase, goal, 'planner'),
    maxIterations: baseRounds(),
    onActivity,
    onEvent,
    onAbort,
  });
  output.appendLine(`[queue:planner] phase ${phase.seq} raw reply is ${text.length} chars`);
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
      implVerifyPrompt: String(t.implVerifyPrompt ?? '').trim(),
      solutionVerifyPrompt: String(t.solutionVerifyPrompt ?? '').trim(),
      solutionVerifyCommand: String(t.solutionVerifyCommand ?? '').trim(),
    });
  }

  return { tasks, splitRequests, cutOff: cutOff && tasks.length === 0, usage };
}
