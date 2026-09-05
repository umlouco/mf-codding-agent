import * as cp from 'child_process';
import * as vscode from 'vscode';
import { CoreClient, CoreConfig } from '../core';
import { resolveCoreBinary, workspaceRoot } from '../detect';
import { registerEditorFsHandlers } from '../editorFs';
import { getRouter } from '../llm/router';
import { getBridge } from '../mcpBridge';
import { getStore } from '../providers/instance';
import { contextCeiling } from '../providers/payload';
import { runClaudeCliTurn } from './claudeCli';
import { NewTask, Task, TaskQueue, Usage } from './db';
import { browserEvidence, codingWorkflow, executorExample, recoveryRules } from './prompts';
import {
  CompletionClaim,
  extractExecutorNotes,
  parseCompletionClaim,
  validationForSupervisor,
} from './validation';

/**
 * Agent runners for autonomous runs.
 *
 * Every run here is *ephemeral*: spawn a core process, initialise it on the
 * model for that role, send exactly one turn, kill the process. The Go core
 * binds one LLM provider for its whole lifetime, so a separate Supervisor and
 * Execution model has to mean a separate process — and that constraint gives
 * us the isolated context window the design wants for free. A worker cannot
 * leak state into the next task because there is no next task for it.
 */

export type Role = 'planner' | 'supervisor' | 'executor';

export interface RoleConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  effort: string;
}

/**
 * Resolves a queue role to an endpoint.
 *
 * The store already knows how to fall back to the coding role, so this is a
 * thin adapter down to the fields the core needs.
 */
export async function roleConfig(role: Role): Promise<RoleConfig> {
  const r = await getStore().resolve(role);
  // The router decides what the core actually dials: a role on one of the
  // editor's own models gets the loopback proxy, every other kind is what the
  // store already said — see llm/router.ts.
  const ep = await getRouter().endpointFor(r);
  return {
    provider: ep.type,
    model: r.model,
    baseURL: ep.baseURL,
    apiKey: ep.apiKey,
    effort: r.effort,
  };
}

/**
 * Rewrites the core config so an ephemeral worker binds this role's model as
 * its coding provider — the core only ever drives one model per process.
 */
async function overridesFor(role: Role, maxIterations = 0): Promise<Partial<CoreConfig>> {
  const rc = await roleConfig(role);
  return {
    providers: [{
      id: `queue-${role}`,
      label: `Queue ${role}`,
      type: rc.provider,
      apiKey: rc.apiKey,
      baseURL: rc.baseURL,
      models: rc.model ? [rc.model] : [],
      reasoning: rc.provider === 'anthropic',
      enabled: true,
    }],
    coding: { providerId: `queue-${role}`, model: rc.model, effort: rc.effort },
    // Supervisors only validate the executor's persisted conclusion. They are
    // intentionally unable to inspect files, execute commands, or drive a browser.
    disableTools: role === 'supervisor',
    ...(role === 'supervisor' ? { memoryEnabled: false, mcpServers: [] } : {}),
    // Queue workers spawn their own core processes and run unattended, often
    // several at once. The editor terminal is a single visible tab shared by
    // everything in the window: handing it to background work would steal focus
    // from whatever the user is doing and interleave several agents' output in
    // one scrollback. They spawn their own shell instead.
    editorTerminal: false,
    maxIterations,
    // An executor turn runs with no round ceiling (see executeTask), so this is
    // the only limit the core itself still applies. It is not a work budget:
    // past this point the next request is about to be refused for its size, and
    // stopping just short of that is the difference between a handoff report
    // the supervisor can act on and an API error that loses the whole turn.
    maxContextTokens: contextCeiling(),
  };
}

/** Base tool-calling rounds for one unattended executor turn. */
function baseRounds(): number {
  return Math.max(
    10,
    vscode.workspace.getConfiguration('mfagent').get<number>('queue.maxRounds', 80),
  );
}

/** Tool-calling rounds for the supervisor — shorter by default. */
function supervisorRounds(): number {
  return Math.max(
    10,
    vscode.workspace.getConfiguration('mfagent').get<number>('queue.supervisorMaxRounds', 40),
  );
}

export class AgentRunError extends Error {}

/**
 * One timestamped line of what a worker is doing, on its way to the journal.
 */
export interface ActivityRecord {
  phase: string;
  detail: string;
  at: number;
}

/**
 * Spawns a throwaway core on `role`'s model, sends one prompt, and tears the
 * process down — including when the turn throws.
 */
export interface TurnResult {
  text: string;
  /** `max_iterations` means the worker was cut off, not that it finished. */
  stopReason: string;
  /** Tokens this turn spent, cumulative over its rounds. */
  usage: Usage;
}

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface RunOptions {
  maxIterations?: number;
  onEvent?: (method: string, params: any) => void;
  onCancellable?: (cancel: () => void) => void;
  /**
   * Hands back a hard stop: kills the core process rather than asking it to
   * stop. `onCancellable` goes through the core, so it is worth nothing against
   * a core that has stopped reading its own stdin — and that is the only case
   * anyone needs to abort a turn from the outside. Killing the process is what
   * rejects the in-flight request, which is what un-wedges the caller.
   */
  onAbort?: (abort: () => void) => void;
  /** Where the worker's activity records go. */
  onActivity?: (a: ActivityRecord) => void;
}

/** Stops a spawned command and its descendants. */
export function killTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // The process already exited.
  }
}

/*
There is no timeout here, and adding one back would be a mistake.

A turn takes as long as the model takes, and on a local model that can be hours
for a single reply. Killing it on a clock cannot tell the difference between
that and a hang, and it destroys the one thing that made the attempt worth
something: what the worker had already learned and written. The core reports its
own liveness instead — see onActivity — so a caller that needs to know whether
anyone is still working reads the journal rather than a stopwatch.

What does still end a turn: the core dropping a connection that has gone silent,
the core process dying (the request rejects), or an explicit cancel.
*/
export async function runOnce(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  role: Role,
  prompt: string,
  opts: RunOptions = {},
): Promise<TurnResult> {
  // Claude CLI is a complete agent on its own — its own tool loop, its own
  // permission handling — so it is never routed through mfcore's agent loop
  // the way an HTTP provider is; see providers/store.ts's rolesAllowed guard
  // for why this can only be planner/supervisor. Branching here, before the
  // core is even spawned, means every caller downstream (orchestrator.ts,
  // monitor.ts, every prompt builder in this file) needs no changes: they
  // only ever see RunOptions in, TurnResult out.
  const resolved = await getStore().resolve(role);
  if (resolved.kind === 'claude-cli') {
    return runClaudeCliTurn(output, role, resolved, prompt, opts);
  }

  const client = new CoreClient(context, output);
  registerEditorFsHandlers(client);
  getBridge().attach(client);
  const { maxIterations = 0, onEvent, onCancellable, onAbort, onActivity } = opts;

  client.onNotification((method, params) => {
    if (method === 'agent/activity' && onActivity) {
      onActivity({
        phase: String(params?.phase ?? ''),
        detail: String(params?.detail ?? ''),
        at: Number(params?.at) || Date.now(),
      });
    }
    onEvent?.(method, params);
  });

  const started = Date.now();
  try {
    await client.start();
    // Available from the moment there is a process to kill — a core that wedges
    // during `initialize` needs aborting exactly as much as one that wedges
    // mid-turn.
    onAbort?.(() => client.stop());
    const init = await client.initialize(await overridesFor(role, maxIterations));
    output.appendLine(
      `[queue:${role}] core ready on ${init.model} (${init.provider})` +
        (maxIterations > 0 ? `, ${maxIterations} rounds` : ''),
    );

    const sessionId = `queue-${role}-${Date.now()}`;
    // The caller can only stop the turn once the core is up and the session is
    // named, so the handle is handed over here rather than at call time.
    onCancellable?.(() => {
      void client.request('chat/cancel', { sessionId }).catch(() => undefined);
    });

    const res = await client.request<{ text: string; stopReason: string; usage?: Usage }>(
      'chat/send',
      { sessionId, text: prompt },
    );
    const usage = { ...NO_USAGE, ...(res?.usage ?? {}) };
    output.appendLine(
      `[queue:${role}] turn finished in ${Math.round((Date.now() - started) / 1000)}s ` +
        `(${res?.stopReason ?? 'unknown'}, ${usage.input} in / ${usage.output} out)`,
    );
    return { text: res?.text ?? '', stopReason: res?.stopReason ?? '', usage };
  } finally {
    client.dispose();
  }
}

// ---- JSON extraction ---------------------------------------------------

/**
 * Pulls a usable JSON value out of a model reply.
 *
 * Local models wrap JSON in prose, fences, or thinking blocks and sometimes emit
 * trailing commas, single quotes, or unquoted keys — so this scans for balanced
 * `[`/`{` rather than trusting the whole reply to parse, and repairs common
 * formatting issues before handing off to JSON.parse.
 *
 * `want` is what makes it reliable now that a turn's result carries every
 * round's text and not just the last one (see agent.go). The reply is prose
 * *then* JSON, and prose is full of brackets: a file name in square brackets, a
 * markdown checklist, a quoted line of code. Taking the first bracket that
 * parses is how `- [ ] read the core` becomes an empty task list, and giving up
 * when it does not parse is how `[package.json]` loses the plan that follows it.
 * So every bracket in the reply is tried, and the caller says which value it can
 * actually use.
 */
export function extractJson<T>(text: string, want?: (value: unknown) => boolean): T {
  // Try every markdown fence — some models nest JSON inside prose or multiple
  // fences, so the last fence often wins for a model that thinks before writing.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fenced: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text)) !== null) {
    fenced.push(fm[1]);
  }
  const candidates = fenced.length > 0 ? [...fenced, text] : [text];

  for (const c of candidates) {
    // Some models emit a thinking block before the JSON. Strip it so the
    // balanced-bracket scan does not start inside a prose paragraph.
    const stripped = c.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    for (const parsed of jsonValues(stripped)) {
      if (!want || want(parsed)) {
        return parsed as T;
      }
    }
  }
  throw new AgentRunError('the model did not return parseable JSON');
}

/**
 * Every bracket position worth trying in one candidate.
 *
 * Capped because matching a bracket costs a scan, and an executor report that
 * quotes a diff can carry hundreds of them. The answer is near the front of any
 * reply that has one.
 */
const MAX_BRACKETS = 400;

/** Parseable JSON values in `src`, in the order they appear. */
function* jsonValues(src: string): Generator<unknown> {
  let seen = 0;
  for (let start = 0; start < src.length; start++) {
    const ch = src[start];
    if (ch !== '[' && ch !== '{') {
      continue;
    }
    if (++seen > MAX_BRACKETS) {
      return;
    }
    const end = matchingBracket(src, start);
    if (end < 0) {
      continue;
    }
    const parsed = tryParse(src.slice(start, end + 1));
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

/**
 * Index of the bracket closing the one at `start`, or -1 when nothing does.
 *
 * Quote- and escape-aware, so a brace inside a description string does not open
 * a level that never closes.
 */
function matchingBracket(src: string, start: number): number {
  const open = src[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Attempts to parse a JSON slice, repairing common model formatting errors.
 *
 * Returns undefined when every attempt fails, so the caller can try the next
 * candidate rather than throwing immediately.
 */
function tryParse(slice: string): unknown {
  // 1. Strict parse — most replies pass on the first try.
  try {
    return JSON.parse(slice);
  } catch { /* fall through */ }

  // 2. Trailing commas before ] or }. DeepSeek and kimi do this regularly.
  try {
    return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
  } catch { /* fall through */ }

  // 3. Single-quoted keys and strings. Convert them to double quotes,
  //    being careful not to touch quotes that are already inside strings.
  try {
    const dq = slice.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
    return JSON.parse(dq);
  } catch { /* fall through */ }

  // 4. Unquoted keys (identifier-like). Prepend a quote before the first `:`
  //    on each line that starts bare. Crude but covers the commonest case.
  try {
    const uq = slice.replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');
    return JSON.parse(uq);
  } catch { /* fall through */ }

  // 5. Combined: trailing commas + unquoted keys + single quotes.
  try {
    const combined = slice
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');
    return JSON.parse(combined);
  } catch { /* fall through */ }

  return undefined;
}

/**
 * If `parsed` is an object with exactly one property whose value is an array,
 * return that array. Otherwise return `parsed` unchanged.
 *
 * This handles the common pattern where models wrap their task list in an
 * envelope like `{"tasks": [...]}` or `{"plan": [...]}`.
 */
export function unwrapArray(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length === 1) {
    const val = (parsed as Record<string, unknown>)[keys[0]];
    if (Array.isArray(val)) {
      return val;
    }
  }
  // Multiple keys — scan for any array-valued property.
  for (const k of keys) {
    const val = (parsed as Record<string, unknown>)[k];
    if (Array.isArray(val)) {
      return val;
    }
  }
  return parsed;
}

// ---- workspace scan ------------------------------------------------------

/**
 * One deterministically-sized slice of the workspace, as reported by
 * `mfcore scan` — see core/internal/tools/scan.go. No LLM is involved in
 * producing this: it exists so "is this slice small enough to explore in one
 * turn" is a file count code already checked, not a question the planner or
 * an expansion agent has to size up on its own.
 */
export interface Region {
  path: string;
  fileCount: number;
  languages: Record<string, number>;
}

/**
 * Runs the deterministic workspace scan and returns the regions it found.
 *
 * This is a plain subprocess call, not an agent turn — there is nothing here
 * for a model to get wrong or take a long time over, which is the point:
 * sizing the plan happens before any LLM is involved.
 */
export async function runScanCommand(
  context: vscode.ExtensionContext,
  root: string,
  maxPerRegion: number,
): Promise<Region[]> {
  const bin = resolveCoreBinary(context).path;
  if (!bin) {
    throw new AgentRunError('the mfcore binary could not be found, so the workspace cannot be scanned');
  }

  const timeoutMs = 30_000;
  return new Promise<Region[]>((resolve, reject) => {
    const child = cp.spawn(
      bin,
      ['scan', '--json', '--dir', root, '--max-per-region', String(Math.max(1, Math.round(maxPerRegion)))],
      { cwd: root, windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killer);
      fn();
    };

    const killer = setTimeout(() => {
      killTree(child.pid);
      finish(() =>
        reject(new AgentRunError(`the workspace scan was still running after ${Math.round(timeoutMs / 1000)}s`)),
      );
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) =>
      finish(() => reject(new AgentRunError(`could not start mfcore scan: ${e.message}`))),
    );
    child.on('close', () => {
      finish(() => {
        try {
          const env = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
          if (env.error) {
            reject(new AgentRunError(`workspace scan failed: ${env.error}`));
            return;
          }
          resolve(Array.isArray(env.regions) ? env.regions : []);
        } catch {
          reject(
            new AgentRunError(`mfcore scan did not return a result: ${(stderr || stdout).slice(0, 500)}`),
          );
        }
      });
    });
  });
}

/** What a phase's `region` column carries — see TaskKind. */
export interface RegionInfo {
  paths: string[];
  fileCount: number;
}

const EMPTY_REGION: RegionInfo = { paths: [], fileCount: 0 };

export function parseRegion(raw: string): RegionInfo {
  if (!raw) {
    return EMPTY_REGION;
  }
  try {
    const d = JSON.parse(raw);
    return {
      paths: Array.isArray(d.paths) ? d.paths.map((p: unknown) => String(p)) : [],
      fileCount: Number(d.fileCount) || 0,
    };
  } catch {
    return EMPTY_REGION;
  }
}

export function encodeRegion(r: RegionInfo): string {
  return JSON.stringify(r);
}

/** True when `candidate` is `region.paths[i]` itself or somewhere under it. */
export function withinRegion(candidate: string, paths: string[]): boolean {
  const norm = candidate.trim().replace(/\\/g, '/').replace(/^\.\/?/, '');
  return paths.some((p) => {
    const base = p.trim().replace(/\\/g, '/').replace(/^\.\/?/, '');
    return norm !== '' && (norm === base || norm.startsWith(`${base}/`));
  });
}

// ---- planner -----------------------------------------------------------

/** True for a value the planner can turn into tasks. */
function isPlan(value: unknown): boolean {
  const list = unwrapArray(value);
  return Array.isArray(list) && list.length > 0;
}

const MAX_PHASES = 40;

function languageSummary(languages: Record<string, number> | undefined): string {
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

// ---- task editing ----------------------------------------------------

/** Upper bound on how much one edit prompt may touch in a single pass. */
const MAX_TASK_EDIT_ITEMS = 40;

export interface TaskEditResult {
  summary: string;
  edits: {
    seq: number;
    title?: string;
    description?: string;
    implVerifyPrompt?: string;
    solutionVerifyPrompt?: string;
    solutionVerifyCommand?: string;
  }[];
  deletes: number[];
  adds: NewTask[];
  usage: Usage;
}

/** True for a value shaped like a task-edit reply rather than something quoted along the way. */
function isTaskEditResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return 'edits' in v || 'deletes' in v || 'adds' in v || 'summary' in v;
}

/**
 * Turns a free-text instruction plus the queue's current tasks into a set of
 * edits, deletions and additions, applied by the caller through the same
 * `TaskQueue.update`/`remove`/`addAll` primitives the supervisor's own
 * `taskEdits` already use (see orchestrator.ts's `applyTaskEdits`) — this
 * just supplies a second way to produce that same shape, from a prompt
 * instead of a verification report. Runs through `runOnce('planner', ...)`,
 * so it works identically whichever provider Planner is bound to.
 */
export async function editTasks(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  tasks: Task[],
  instruction: string,
  opts: Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort'> = {},
): Promise<TaskEditResult> {
  const list = tasks
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((t) => `#${t.seq} [${t.status}] ${t.title}\n${t.description}`)
    .join('\n\n');

  const prompt = `You are the planner for an autonomous task queue. The queue currently has ${tasks.length} task(s):

${list || '(no tasks yet)'}

The user asked for this change:
"""
${instruction}
"""

Reply with ONE JSON object and nothing else:
{
  "summary": "one sentence describing what you changed",
  "edits": [{ "seq": 1, "title": "...", "description": "...", "implVerifyPrompt": "...",
              "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }],
  "deletes": [],
  "adds": [{ "title": "...", "description": "...", "implVerifyPrompt": "...",
             "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }]
}

Only include fields you are actually changing on an "edits" entry; omit a field to leave it as-is.
Replace example sequence numbers with actual queue sequence numbers. deletes is an array of numbers.
Do not edit or delete a VERIFIED task unless the instruction explicitly asks to redo finished work.
Tasks in "adds" are appended after the current end of the queue, in the order given. Leave any of
the three arrays empty when the instruction does not call for that kind of change.`;

  const { text, usage } = await runOnce(context, output, 'planner', prompt, opts);
  const parsed = extractJson<Partial<TaskEditResult>>(text, isTaskEditResult);

  const edits = (Array.isArray(parsed.edits) ? parsed.edits : [])
    .filter((e: any) => e && typeof e === 'object' && typeof e.seq === 'number')
    .slice(0, MAX_TASK_EDIT_ITEMS)
    .map((e: any) => ({
      seq: e.seq,
      title: typeof e.title === 'string' ? e.title.trim() : undefined,
      description: typeof e.description === 'string' ? e.description.trim() : undefined,
      implVerifyPrompt: typeof e.implVerifyPrompt === 'string' ? e.implVerifyPrompt.trim() : undefined,
      solutionVerifyPrompt:
        typeof e.solutionVerifyPrompt === 'string' ? e.solutionVerifyPrompt.trim() : undefined,
      solutionVerifyCommand:
        typeof e.solutionVerifyCommand === 'string' ? e.solutionVerifyCommand.trim() : undefined,
    }));

  const deletes = (Array.isArray(parsed.deletes) ? parsed.deletes : [])
    .filter((s: any) => typeof s === 'number')
    .slice(0, MAX_TASK_EDIT_ITEMS);

  const adds: NewTask[] = (Array.isArray(parsed.adds) ? parsed.adds : [])
    .filter((a: any) => a && typeof a === 'object' && String(a.title ?? '').trim())
    .slice(0, MAX_TASK_EDIT_ITEMS)
    .map((a: any) => ({
      title: String(a.title).trim().slice(0, 200),
      description: String(a.description ?? '').trim(),
      implVerifyPrompt: String(a.implVerifyPrompt ?? '').trim(),
      solutionVerifyPrompt: String(a.solutionVerifyPrompt ?? '').trim(),
      solutionVerifyCommand: String(a.solutionVerifyCommand ?? '').trim(),
    }));

  return {
    summary: String(parsed.summary ?? '').trim() || 'Applied the requested changes.',
    edits,
    deletes,
    adds,
    usage,
  };
}

// ---- phase expansion -----------------------------------------------------

const MAX_TASKS_PER_PHASE = 20;

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
  "solutionVerifyCommand"  a single shell command that exits 0 on success and non-zero on
                            failure, or "" if none applies
  "kind"                   "task" (the default). Use "phase" instead, ONLY after exploring,
                            if part of this region turns out to be a distinct piece of work
                            that does not belong with the rest — in that case also set
                            "regionPath" to the real subdirectory (inside the paths above)
                            that piece lives under; leave "description" describing just that
                            piece. Do not use "phase" to avoid writing tasks — code decides
                            how much smaller that piece needs to be, not you.

Rules:
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
  return stopReason === 'repeated_tool_error' || stopReason === 'context_limit';
}

const MAX_LOG_ENTRIES = 4;
const MAX_LOG_ENTRY_CHARS = 800;
const MAX_LOG_CHARS = 4000;

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}

/** Splits an accumulated error log back into its per-attempt entries. */
function splitAttempts(log: string): string[] {
  return log
    .split(/\n(?=\[(?:attempt \d+|recovered)\])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when an entry says nothing the newer feedback does not already say. */
function coveredBy(entry: string, feedback: string): boolean {
  if (!feedback) {
    return false;
  }
  const body = squash(entry.replace(/^\[[^\]]+\]\s*/, ''));
  return body.length > 0 && squash(feedback).includes(body);
}

/**
 * A short account of how the previous attempts ended, with whatever the current
 * supervisor feedback already says stripped out of it.
 */
function attemptHistory(task: Task): string {
  const feedback = task.supervisorFeedback.trim();
  const history = splitAttempts(task.errorLog)
    .filter((e) => !coveredBy(e, feedback))
    .slice(-MAX_LOG_ENTRIES)
    .map((e) => clip(e, MAX_LOG_ENTRY_CHARS));
  return history.length ? clip(history.join('\n'), MAX_LOG_CHARS) : '(nothing recorded)';
}

/**
 * The briefing a retry opens with.
 *
 * `supervisorFeedback` is also the newest entry in `errorLog`, so printing both
 * verbatim handed the executor the same paragraphs twice — and the log grows
 * without bound across attempts, which buries the one instruction that still
 * matters in the middle of a wall of stale text. Keep the current feedback
 * whole and last, where it reads as the standing order, and keep the earlier
 * attempts as a short deduplicated tail: enough for the executor to know what
 * has already been tried, not enough to drown the instruction.
 */
function retryBriefing(task: Task): string {
  if (task.attempts <= 1 && !task.errorLog.trim() && !task.supervisorFeedback.trim()) {
    return '';
  }
  return `
THIS IS ATTEMPT ${task.attempts} of the current attempt budget. Earlier work did not pass verification.

How the earlier attempts ended, oldest first:
${attemptHistory(task)}

Read the files before redoing any of that — an attempt that was cut off still
left its edits on disk, and repeating them is how the next attempt runs out too.
If an attempt was interrupted, inspect its completed changes before continuing.
An interruption alone does not prove the task is too large or the code is wrong.
Finish the missing work, or report the concrete blocker and next useful step.

Supervisor feedback on the last attempt — treat this as binding:
${task.supervisorFeedback.trim() || '(none)'}
`;
}

export async function executeTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  /** TaskQueue.instructions — see its doc comment for why this crosses the
   * task-isolation boundary when nothing else does. */
  instructions: string,
  onActivity?: (a: ActivityRecord) => void,
  onEvent?: (method: string, params: any) => void,
  onAbort?: (abort: () => void) => void,
): Promise<ExecutionOutcome> {
  const retry = retryBriefing(task);
  const notes = instructions.trim()
    ? `PROJECT NOTES — standing conventions and facts for this whole project, written by the
project owner and by earlier tasks. Apply these to your work:
${instructions.trim()}

`
    : '';

  const prompt = `You are an execution agent. Complete exactly one task, then stop.

${notes}TASK ${task.seq}: ${task.title}

${task.description}
${retry}
Own the implementation. Run ordinary development checks while you work, but do
not make the final verification decision. A supervisor watches your database
journal and will start a separate execution LLM to perform formal verification.

Verification requirements:
- Implementation check: ${task.implVerifyPrompt || 'the described code exists and is coherent'}
- Behaviour check: ${task.solutionVerifyPrompt || 'the described behaviour works'}
${task.solutionVerifyCommand ? `- This command must exit 0: \`${task.solutionVerifyCommand}\`` : ''}

Rules:
${codingWorkflow}

${browserEvidence}

- Stay inside this task. Do not start the next one, and do not refactor unrelated code.
- If the task turns out to be impossible or already done, say so plainly and explain why.
- Inspect the final code and diff yourself. Run useful development checks. For UI/browser work,
  use the browser tools when needed and record what happened.
- If you learned something every later task should know — where something lives, a convention
  to follow, how to build or test this project — put it in "notes" below. This is the only way
  that fact reaches later tasks: they run with no memory of this attempt. Leave "notes" empty if
  there is nothing new, and do not repeat what PROJECT NOTES above already says.
- Your final response must be ONE valid JSON object, without a code fence or trailing prose.
  Use status READY_FOR_VALIDATION only when implementation is complete and development checks
  support handing it to the verifier. Otherwise use NEEDS_MORE_WORK. Neither status is a formal PASS.
  Populate filesChanged and developmentChecks with strings describing actual files and results.
  Use an empty notes string when there is no new durable fact. Replace this example's values:
${executorExample}`;

  const { text, stopReason, usage } = await runOnce(context, output, 'executor', prompt, {
    // Negative means the core runs until the model finishes or the supervisor
    // stops it based on work quality. Time and round counts are not verdicts.
    maxIterations: -1,
    onActivity,
    onEvent,
    onAbort,
  });
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

// ---- supervisor --------------------------------------------------------

/**
 * There is deliberately no failure verdict.
 *
 * A run that can declare a task impossible will declare a task impossible, and
 * the queue then stops with work outstanding and nobody watching — which is the
 * one outcome an unattended overnight run must not have. Every path out of a
 * failed attempt goes back through the supervisor rewriting the task.
 */
export type Verdict = 'VERIFIED' | 'RETRY' | 'SPLIT' | 'RESET_FROM';

/** Upper bound on the pieces one oversized task may be replaced with. */
const MAX_SPLIT_PARTS = 6;

/** How much of the original planning goal the supervisor is shown at the ceiling. */
const MAX_GOAL_CHARS = 2000;

/**
 * Whether this task has spent the attempt budget its plan gave it.
 *
 * `maxAttempts` is not a countdown to giving up — nothing here can fail a task,
 * and f9f496c's version, which did, is not what came back. It is a boundary on
 * how long one *formulation* of a task may be retried. Without one the count
 * only climbed, which is both a display defect (a row reading "attempt 7 of 3")
 * and the thing that defect was reporting: a supervisor free to send a fourth,
 * fifth and sixth phrasing of an instruction that has already failed three
 * times. At the boundary the choice narrows to the two decisions that change
 * something — split it, or rebuild it — and the budget then starts over on
 * whatever comes out. See `escalate` and the RETRY case in the orchestrator.
 */
export function attemptsExhausted(task: Task): boolean {
  return task.attempts >= Math.max(1, task.maxAttempts);
}

/**
 * What the attempt budget means to this particular review.
 *
 * Below the ceiling the count is context and nothing else: a task on its second
 * attempt is judged on its evidence exactly as the first was, because rejecting
 * work for being late is how a correct implementation gets thrown away. At the
 * ceiling it becomes an instruction, because by then the count *is* evidence —
 * three failures against one description are not three accidents.
 */
function ceilingNotice(task: Task, goal: string): string {
  if (!attemptsExhausted(task)) {
    return `This is attempt ${task.attempts} of ${task.maxAttempts}. Judge the recorded work on its own
merits — the count is context here, not a reason to accept or reject anything.`;
  }
  const objective = goal.trim().slice(0, MAX_GOAL_CHARS);
  return `ATTEMPT BUDGET SPENT: this is attempt ${task.attempts} of ${task.maxAttempts}, the last one this
task gets in its current form. Diagnose the recorded failure: it may be a tool invocation,
environment problem, model mistake, or task ambiguity. Preserve the required acceptance criteria;
do not weaken them to obtain a PASS. Repeating the same failed approach is not a recovery.
If the evidence is not sufficient, choose exactly one:
 - SPLIT, when scope is the obstacle: the report reads as several unfinished threads rather than
   one unfinished thing, or no single agent can hold all of this at once. Return the ordered
   smaller tasks that replace it.
 - RETRY, for a code defect, broken tool invocation, environment problem, missing evidence, or
   unclear requirement. Preserve the goal and required behavior. Write a self-contained task
   using the observed failures, completed work, and a concrete different approach.
Whichever you choose, the replacement starts again with a full attempt budget, so it is worth
getting right.${
    objective
      ? `

THE ORIGINAL OBJECTIVE THIS WHOLE PLAN WAS BUILT FROM — a rebuilt task must still serve it, and
must not drift into work some other task in the plan already owns:
${objective}`
      : ''
  }`;
}

/**
 * True for a value that is the supervisor's verdict rather than something it
 * quoted on the way to reaching one — a JSON snippet from a file it read, or an
 * example in its own reasoning.
 */
function isReview(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return 'verdict' in v || 'feedback' in v || 'taskEdits' in v || 'splitInto' in v;
}

export interface SupervisorDecision {
  verdict: Verdict;
  feedback: string;
  /** Only meaningful for RESET_FROM: the sequence number to roll back to. */
  resetFromSeq?: number;
  /** Only meaningful for SPLIT: the tasks that replace this one, in order. */
  splitInto?: NewTask[];
  /** Optional edits the supervisor wants applied to upcoming tasks. */
  taskEdits?: {
    seq: number;
    description?: string;
    implVerifyPrompt?: string;
    solutionVerifyPrompt?: string;
    solutionVerifyCommand?: string;
  }[];
  /**
   * This decision was made at the attempt ceiling, so what it replaces the task
   * with is a restructuring rather than another pass at the same one — which is
   * what entitles it to a fresh attempt budget. Only meaningful for RETRY; a
   * SPLIT replaces the row outright and its parts start at zero regardless.
   */
  escalated?: boolean;
  /** What the review itself cost — part of the task's bill like any other run. */
  usage: Usage;
}

export async function superviseTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  /** How many times this task has already been rewritten — see rewriteNotice. */
  rewrites: number,
  /** The prompt the whole plan was generated from — see ceilingNotice. */
  goal: string,
  opts: Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort'> = {},
): Promise<SupervisorDecision> {
  const exhausted = attemptsExhausted(task);
  const prompt = `You are the supervisor of an autonomous coding run. Make a lightweight
accept/reject decision from the validation report stored in the queue database.

The report below is from an independent verification agent, not the implementation agent.

You have no tools and must not inspect files, execute commands, rerun tests, or drive a browser.
Check whether its conclusion is consistent with concrete evidence for each requirement.

A task is never terminally failed. When the evidence is not sufficient, make exactly one
recovery decision: RETRY with a materially rewritten task description and verification, or
SPLIT into several smaller ordered tasks. Use SPLIT only when scope is the obstacle; use RETRY
for a focused correction to code, tool use, setup, requirements, or missing verification.
Whether the work passes is decided by the evidence alone and never by how many attempts it took.

${ceilingNotice(task, goal)}

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

Set verdict to VERIFIED, RETRY, or SPLIT. Use empty splitInto unless splitting; use empty taskEdits
unless making edits. Replace example strings with concrete instructions, not placeholders.

Choose VERIFIED only when the verification agent concluded PASS and its database report contains
concrete implementation and behaviour evidence plus successful required commands/tests. Do not
independently repeat the checks. Choose RETRY for FAIL, INCOMPLETE, contradictory conclusions, or
missing evidence; include a materially rewritten description for task ${task.seq}. Choose SPLIT when
the remaining work is more than one agent can hold at once — a report that reads as several
unfinished threads rather than one unfinished thing. For an unsuccessful task these are the only two
decisions: rewrite it or split it. There is no fail or give-up verdict.`;

  const { text, usage } = await runOnce(context, output, 'supervisor', prompt, {
    maxIterations: supervisorRounds(),
    ...opts,
  });
  const total = { ...usage };

  let d: Partial<SupervisorDecision> = {};
  let parsed = true;
  try {
    d = extractJson<SupervisorDecision>(text, isReview);
  } catch {
    // The model may well have reached a real conclusion — "the work is
    // correct", say — and simply forgotten the JSON envelope. Ask it to
    // restate that same judgement in the required shape before this code
    // assumes anything on its behalf; see reformatVerdict for why that is not
    // the same repair demandRewrite does.
    const reformatted = await reformatVerdict(context, output, task, text, opts);
    addUsage(total, reformatted.usage);
    if (reformatted.decision) {
      d = reformatted.decision;
    } else {
      // Still nothing usable. A supervisor that cannot be understood must not
      // silently pass the task — but it must not silently retry it either,
      // because a retry with no rewrite is the same attempt again. Fall
      // through to the demandRewrite repair pass below.
      parsed = false;
      d = {
        verdict: 'RETRY',
        feedback:
          "The supervisor's reply could not be understood as a verdict, even after being asked " +
          'to restate it. Raw reply:\n' + text.slice(0, 2000),
      };
    }
  }

  const named = String(d.verdict ?? '').toUpperCase();
  // FAIL is no longer in the protocol. A model that has seen it elsewhere still
  // emits it, and it means "I have run out of ideas" — which is a reason to
  // rewrite the task, never a reason to end the run.
  const verdict: Verdict = (['VERIFIED', 'RETRY', 'SPLIT'] as string[]).includes(named)
    ? (named as Verdict)
    : 'RETRY';

  const splitInto = (Array.isArray(d.splitInto) ? d.splitInto : [])
    .filter((p: any) => p && typeof p === 'object' && String(p.title ?? '').trim())
    .slice(0, MAX_SPLIT_PARTS)
    .map((p: any) => ({
      title: String(p.title).trim().slice(0, 200),
      description: String(p.description ?? '').trim(),
      implVerifyPrompt: String(p.implVerifyPrompt ?? '').trim(),
      solutionVerifyPrompt: String(p.solutionVerifyPrompt ?? '').trim(),
      solutionVerifyCommand: String(p.solutionVerifyCommand ?? '').trim(),
    }));

  // A split into fewer than two usable parts is not a split. Fall back to the
  // retry it amounts to rather than replacing the task with a copy of itself.
  const settled: Verdict = verdict === 'SPLIT' && splitInto.length < 2 ? 'RETRY' : verdict;
  const feedback = String(d.feedback ?? '').trim();
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
    return decision;
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
        ...(await demandRewrite(context, output, task, feedback, parsed ? text : '', opts)),
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
async function escalate(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  goal: string,
  feedback: string,
  opts: Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort'>,
): Promise<{
  splitInto: NewTask[];
  description: string;
  implVerifyPrompt: string;
  solutionVerifyPrompt: string;
  solutionVerifyCommand: string;
  feedback: string;
  usage: Usage;
}> {
  const empty = {
    splitInto: [] as NewTask[],
    description: '',
    implVerifyPrompt: '',
    solutionVerifyPrompt: '',
    solutionVerifyCommand: '',
    feedback: '',
    usage: { ...NO_USAGE },
  };

  const objective = goal.trim().slice(0, MAX_GOAL_CHARS);
  const prompt = `Task ${task.seq} has now used all ${task.maxAttempts} attempts its plan allowed, and you asked
for another one without restructuring it. That is the one answer this task cannot take: the
previous attempts each ran a description you had already corrected, and each failed anyway.

TASK ${task.seq}: ${task.title}

The description that has failed ${task.attempts} times:
${task.description}

What you said was wrong with the last attempt:
${feedback || '(nothing recorded)'}

How the attempts ended:
${attemptHistory(task)}
${
  objective
    ? `
The objective this whole plan was generated from. A rebuilt task must still serve it, and must not
absorb work that belongs to a different task in the plan:
${objective}
`
    : ''
}
Decide which of the two failures this is, and answer with ONE JSON object and nothing else.

If the task is TOO BIG — the work is several distinct pieces and no single agent turn can carry
all of it — split it:
{
  "splitInto": [{ "title": "...", "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }],
  "feedback": "why the scope was the obstacle"
}
Give between 2 and ${MAX_SPLIT_PARTS} parts, in execution order, each independently doable and
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

  try {
    const { text, usage } = await runOnce(context, output, 'supervisor', prompt, {
      maxIterations: supervisorRounds(),
      ...opts,
    });
    const d = extractJson<any>(text);
    const splitInto = (Array.isArray(d?.splitInto) ? d.splitInto : [])
      .filter((p: any) => p && typeof p === 'object' && String(p.title ?? '').trim())
      .slice(0, MAX_SPLIT_PARTS)
      .map((p: any) => ({
        title: String(p.title).trim().slice(0, 200),
        description: String(p.description ?? '').trim(),
        implVerifyPrompt: String(p.implVerifyPrompt ?? '').trim(),
        solutionVerifyPrompt: String(p.solutionVerifyPrompt ?? '').trim(),
        solutionVerifyCommand: String(p.solutionVerifyCommand ?? '').trim(),
      }));
    return {
      splitInto,
      description: String(d?.description ?? '').trim(),
      implVerifyPrompt: String(d?.implVerifyPrompt ?? '').trim(),
      solutionVerifyPrompt: String(d?.solutionVerifyPrompt ?? '').trim(),
      solutionVerifyCommand: String(d?.solutionVerifyCommand ?? '').trim(),
      feedback: String(d?.feedback ?? '').trim(),
      usage,
    };
  } catch {
    return empty;
  }
}

/** True when `next` is a real rewrite rather than a blank or a copy. */
function rewritten(next: string | undefined, current: string): boolean {
  const n = squash(String(next ?? ''));
  return n.length >= 40 && n !== squash(current);
}

function addUsage(into: Usage, add: Usage): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
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
async function reformatVerdict(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  rawReply: string,
  opts: Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort'>,
): Promise<{ decision?: Partial<SupervisorDecision>; usage: Usage }> {
  const prompt = `Your last reply about task ${task.seq} was not returned as the required JSON object, so it
could not be read as a verdict. Here is exactly what you wrote:

${rawReply.slice(0, 4000)}

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

Set verdict to VERIFIED, RETRY, or SPLIT to match the original conclusion. Use empty arrays for
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
async function demandRewrite(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  feedback: string,
  rawReply: string,
  opts: Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort'>,
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

The executor is a fresh agent. Provide self-contained recovery instructions; it does not see
your full conversation. It receives the task, recent failure history, and supervisor feedback.

${recoveryRules}

TASK ${task.seq}: ${task.title}

The description the last attempt was given, which did not work:
${task.description}

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

const CORRECTION_MARK = '--- CORRECTION AFTER ATTEMPT';

/**
 * The last-resort rewrite: the original task with the supervisor's correction
 * bolted on as an instruction the executor cannot miss.
 *
 * Any correction from an earlier attempt is stripped first. Stacking them would
 * grow the description without bound — and worse, would hand the executor a
 * stack of superseded instructions with the current one buried at the end,
 * which is the opposite of what this is for.
 */
function appendCorrection(task: Task, feedback: string): string {
  const note =
    feedback.trim() ||
    'The previous attempt did not pass verification and the supervisor did not say why. ' +
      'Read the files this task names before changing anything, confirm what is already ' +
      'there, and report precisely what you find.';
  const base = task.description.split(CORRECTION_MARK)[0].trimEnd();
  return `${base}

${CORRECTION_MARK} ${task.attempts} (apply while preserving required behavior and acceptance criteria) ---
${note}`;
}

/**
 * Tells the supervisor how many times it has already rewritten this task.
 *
 * Without it every review looks like the first one. The supervisor reads a
 * description, does not recognise it as its own work, and writes the same
 * correction again — which is what an infinite loop looks like from the inside.
 */
function rewriteNotice(rewrites: number): string {
  if (rewrites <= 0) {
    return '';
  }
  return `
The description below is not the original: you have already rewritten this task ${rewrites} time(s),
and the latest attempt still did not pass. Compare the current evidence with earlier failures.
Preserve what works and change the failed approach. Do not assume the requirements are wrong
merely because a worker failed to satisfy them.
`;
}
