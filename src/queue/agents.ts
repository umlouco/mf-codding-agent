import * as cp from 'child_process';
import * as vscode from 'vscode';
import { CoreClient, CoreConfig } from '../core';
import { resolveCoreBinary } from '../detect';
import { getStore } from '../providers/instance';
import { NewTask, Task, Usage } from './db';

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
}

/**
 * Resolves a queue role to an endpoint.
 *
 * The store already knows how to fall back to the coding role, so this is a
 * thin adapter down to the four fields the core needs.
 */
export async function roleConfig(role: Role): Promise<RoleConfig> {
  const r = await getStore().resolve(role);
  return {
    provider: r.kind,
    model: r.model,
    baseURL: r.baseURL,
    apiKey: r.apiKey,
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
    coding: { providerId: `queue-${role}`, model: rc.model },
    autoApprove: ['*'],
    maxIterations,
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
interface TurnResult {
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
async function runOnce(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  role: Role,
  prompt: string,
  opts: RunOptions = {},
): Promise<TurnResult> {
  const client = new CoreClient(context, output);
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
  // An unattended core must never block on a permission round-trip.
  client.onRequest('permission/request', async () => ({ approved: true, alwaysAllow: true }));

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

// ---- planner -----------------------------------------------------------

const MAX_TASKS = 100;

/** True for a value the planner can turn into tasks. */
function isPlan(value: unknown): boolean {
  const list = unwrapArray(value);
  return Array.isArray(list) && list.length > 0;
}

export async function generateTasks(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  goal: string,
  limit: number,
  onEvent?: (method: string, params: any) => void,
  onCancellable?: (cancel: () => void) => void,
): Promise<NewTask[]> {
  const n = Math.min(Math.max(limit || 20, 1), MAX_TASKS);
  const prompt = `You are planning an autonomous coding run. Break the goal below into at most ${n} tasks.

GOAL
${goal}

First explore the workspace enough to ground the plan in what is actually there — read the files you need. Then reply with ONE JSON array and nothing else.

Each element must be an object with exactly these keys:
  "title"                  short imperative summary, under 80 characters
  "description"            what to build, precise enough to act on with no other context: name the files, functions and behaviour
  "implVerifyPrompt"       how a reviewer confirms the code and files exist as described
  "solutionVerifyPrompt"   how a reviewer confirms the behaviour is correct
  "solutionVerifyCommand"  a single shell command that exits 0 on success and non-zero on failure, or "" if none applies

Rules:
- Order the array in the sequence the tasks must be executed.
- Each task must be completable by one agent in a single sitting, touching a handful of files.
- Every task must be independently verifiable. Prefer real commands (test runners, builds, linters) that already work in this repo — do not invent scripts that do not exist.
- Do not include a task for the plan itself.`;

  const { text } = await runOnce(context, output, 'planner', prompt, {
    maxIterations: baseRounds(),
    onEvent,
    onCancellable,
  });
  output.appendLine(`[queue:planner] raw reply is ${text.length} chars`);
  // A plan is a non-empty array, or an envelope around one. Saying so is what
  // stops a stray `[ ]` in the planner's own narration from being read as a
  // plan with no tasks in it.
  let parsed = extractJson<unknown>(text, isPlan);
  parsed = unwrapArray(parsed);
  if (!Array.isArray(parsed)) {
    // Log the type and a sample of what was actually returned so the user can
    // diagnose the failure without having to re-run the planner.
    const sample =
      typeof parsed === 'string'
        ? parsed.slice(0, 500)
        : JSON.stringify(parsed).slice(0, 500);
    output.appendLine(
      `[queue:planner] extracted ${typeof parsed} instead of array: ${sample}`,
    );
    throw new AgentRunError('the planner returned JSON but not an array of tasks');
  }
  const raw = parsed as any[];

  const tasks: NewTask[] = raw
    .filter((t) => t && typeof t === 'object' && String(t.title ?? '').trim())
    .slice(0, n)
    .map((t, i) => ({
      title: String(t.title).trim().slice(0, 200),
      description: String(t.description ?? '').trim(),
      implVerifyPrompt: String(t.implVerifyPrompt ?? '').trim(),
      solutionVerifyPrompt: String(t.solutionVerifyPrompt ?? '').trim(),
      solutionVerifyCommand: String(t.solutionVerifyCommand ?? '').trim(),
      seq: i + 1,
    }));

  if (tasks.length === 0) {
    throw new AgentRunError('the planner produced no usable tasks');
  }
  return tasks;
}

// ---- executor ----------------------------------------------------------

export interface ExecutionOutcome {
  text: string;
  ok: boolean;
  /** The worker hit the round ceiling; `text` is partial progress, not a result. */
  cutOff: boolean;
  /** `max_iterations`, or the model's own reason for stopping. */
  stopReason: string;
  /** Rounds this attempt was allowed, for the log. */
  rounds: number;
  /** What this attempt cost, spent whether or not it produced anything. */
  usage: Usage;
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
  if (task.attempts <= 1) {
    return '';
  }
  return `
THIS IS ATTEMPT ${task.attempts}. Earlier attempts did not pass verification.

How the earlier attempts ended, oldest first:
${attemptHistory(task)}

Read the files before redoing any of that — an attempt that was cut off still
left its edits on disk, and repeating them is how the next attempt runs out too.
If an attempt ran out of rounds rather than getting something wrong, the task is
too big to finish in one sitting: do the part that unblocks everything else
first, and report precisely where you stopped.

Supervisor feedback on the last attempt — treat this as binding:
${task.supervisorFeedback.trim() || '(none)'}
`;
}

export async function executeTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  onActivity?: (a: ActivityRecord) => void,
  onEvent?: (method: string, params: any) => void,
): Promise<ExecutionOutcome> {
  const retry = retryBriefing(task);

  const prompt = `You are an execution agent. Complete exactly one task, then stop.

TASK ${task.seq}: ${task.title}

${task.description}
${retry}
This is how your work will be checked, so satisfy it directly:
- Implementation check: ${task.implVerifyPrompt || 'the described code exists and is coherent'}
- Behaviour check: ${task.solutionVerifyPrompt || 'the described behaviour works'}
${task.solutionVerifyCommand ? `- This command must exit 0: \`${task.solutionVerifyCommand}\`` : ''}

Rules:
- Do the work. Read what you need, then edit the files for real — do not describe changes you have not made.
- Stay inside this task. Do not start the next one, and do not refactor unrelated code.
- If the task turns out to be impossible or already done, say so plainly and explain why.
- Finish with a short report: what you changed, which files, and anything the reviewer should know.`;

  // Rounds are the only budget an attempt has, and a retry gets more of them —
  // capped so token spend cannot run away across attempts. How long those
  // rounds take is not this code's business.
  const scale = Math.min(1 + 0.5 * Math.max(0, task.attempts - 1), 3);
  const rounds = Math.round(baseRounds() * scale);

  const { text, stopReason, usage } = await runOnce(context, output, 'executor', prompt, {
    maxIterations: rounds,
    onActivity,
    onEvent,
  });
  return {
    text,
    ok: text.trim().length > 0,
    cutOff: stopReason === 'max_iterations',
    stopReason,
    rounds,
    usage,
  };
}

// ---- functional check --------------------------------------------------

export interface CommandResult {
  ran: boolean;
  code: number | null;
  output: string;
  /**
   * The command never ran: a syntax error, or a program that does not exist.
   *
   * This is the distinction the whole check depends on. A command that runs and
   * exits non-zero is evidence about the code. A command that could not run is
   * evidence about the command — and blaming the executor for it is how a task
   * fails forever over a check that was never valid.
   */
  invalid: boolean;
  timedOut: boolean;
  /** Why it could not run, when it could not run. */
  error: string;
}

const NOT_RUN: CommandResult = {
  ran: false,
  code: null,
  output: '',
  invalid: false,
  timedOut: false,
  error: '',
};

function clampOutput(s: string): string {
  return s.length > 12000 ? `${s.slice(0, 12000)}\n… (truncated)` : s;
}

/**
 * Runs a task's verification command and reports what happened.
 *
 * This runs here rather than inside the Supervisor's turn on purpose: an exit
 * code is objective, and asking a model to both run and judge the check invites
 * it to report a pass it never observed.
 *
 * It goes through `mfcore sh` — the same portable POSIX interpreter the agent's
 * `unix` tool runs on — for one reason: a check has to mean the same thing as
 * the work it is checking. When this spawned PowerShell directly, an executor
 * would satisfy a task with `cd core && go build ./...`, and the check would
 * then report exit 1 because PowerShell 5.1 has no `&&`. The code was fine and
 * the task failed anyway, which is the worst failure this system can have: the
 * supervisor is handed false evidence and acts on it.
 *
 * The script travels on stdin and the result comes back as JSON, so there is no
 * command line for anything to re-parse and no exit code doing double duty.
 */
export async function runVerifyCommand(
  context: vscode.ExtensionContext,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  if (!command.trim()) {
    return NOT_RUN;
  }

  const bin = resolveCoreBinary(context).path;
  if (!bin) {
    return {
      ...NOT_RUN,
      ran: true,
      invalid: true,
      error: 'the mfcore binary could not be found, so no verification command can run',
    };
  }

  return new Promise<CommandResult>((resolve) => {
    const child = cp.spawn(
      bin,
      ['sh', '--json', '--dir', cwd, '--timeout', `${Math.max(1, Math.round(timeoutMs / 1000))}s`],
      { cwd, windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killer);
      resolve(r);
    };

    // `mfcore sh` enforces its own deadline, so this only fires if the core
    // itself is the thing that hung. Nothing in a queue run may block forever,
    // least of all a call that used to run synchronously on the extension host
    // and took the whole window down with it.
    const killer = setTimeout(() => {
      killTree(child.pid);
      done({
        ...NOT_RUN,
        ran: true,
        timedOut: true,
        output: clampOutput(`${stdout}${stderr}`.trim()),
        error: `the verification command was still running after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs + 15_000);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('error', (e) =>
      done({ ...NOT_RUN, ran: true, invalid: true, error: `could not start mfcore sh: ${e.message}` }),
    );

    child.on('close', () => {
      try {
        const env = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
        done({
          ran: true,
          code: typeof env.code === 'number' ? env.code : null,
          output: clampOutput(String(env.output ?? '')),
          invalid: Boolean(env.invalid),
          timedOut: Boolean(env.timedOut),
          error: String(env.error ?? ''),
        });
      } catch {
        // No envelope means the core never got as far as producing one.
        done({
          ...NOT_RUN,
          ran: true,
          invalid: true,
          output: clampOutput(`${stdout}${stderr}`.trim()),
          error: 'mfcore sh did not return a result',
        });
      }
    });

    child.stdin.on('error', () => {
      /* the child died before taking the script; `close` reports it */
    });
    child.stdin.end(command);
  });
}

/**
 * Kills a process and everything it started.
 *
 * A build spawns compilers and test runners, and killing only the process we
 * launched leaves those holding the pipes — which is how a "timed out" command
 * goes on consuming the machine after the queue has moved on.
 */
function killTree(pid: number | undefined): void {
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
    /* already gone */
  }
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
  taskEdits?: { seq: number; description?: string; solutionVerifyCommand?: string }[];
  /** What the review itself cost — part of the task's bill like any other run. */
  usage: Usage;
}

export async function superviseTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  check: CommandResult,
  /** How many times this task has already been rewritten — see rewriteNotice. */
  rewrites: number,
  opts: Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort'> = {},
): Promise<SupervisorDecision> {
  const checkReport = !check.ran
    ? 'No verification command was configured for this task, so you must verify by inspection.'
    : check.invalid || check.timedOut
      ? `The verification command \`${task.solutionVerifyCommand}\` DID NOT RUN.

${check.error}
${check.output ? `\nOutput before it stopped:\n${check.output}` : ''}

This says nothing about the code. It is a defect in the task's own check, and
it is yours to fix: put a corrected "solutionVerifyCommand" in "taskEdits" for
seq ${task.seq}. Commands run under a POSIX shell that works the same on every
platform, so \`&&\`, \`||\`, pipes and quoting are all available — but the
programs themselves still have to exist in this repo. Then judge the task on
what you find in the files, not on this.`
      : `The verification command \`${task.solutionVerifyCommand}\` exited with code ${check.code}.

Output:
${check.output || '(no output)'}`;

  const prompt = `You are the supervisor of an autonomous coding run. Judge one completed task and decide what happens next.

TASK ${task.seq}: ${task.title}
This is attempt ${task.attempts}.
${rewriteNotice(rewrites)}
What the task required:
${task.description}

Implementation check to apply:
${task.implVerifyPrompt || 'confirm the described code exists and is coherent'}

Behaviour check to apply:
${task.solutionVerifyPrompt || 'confirm the described behaviour works'}

What the execution agent reported:
${task.output || '(nothing reported)'}

How the earlier attempts on this task ended, oldest first:
${attemptHistory(task)}

${checkReport}

Now verify this yourself. Read the files that were supposed to change and confirm they really did — the agent's report is a claim, not evidence. Check the diff for regressions and for damage outside the task's scope.

Then reply with ONE JSON object and nothing else:
{
  "verdict": "VERIFIED" | "RETRY" | "SPLIT" | "RESET_FROM",
  "feedback": "what you found, and for a retry exactly what to do differently",
  "resetFromSeq": <number, only with RESET_FROM>,
  "splitInto": [{ "title": "...", "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }],
  "taskEdits": [{ "seq": <number>, "description": "...", "solutionVerifyCommand": "..." }]
}

Choose:
- VERIFIED   the work is done and correct.
- RETRY      this task needs another attempt. You MUST also include seq ${task.seq} in
              "taskEdits" with a REWRITTEN "description". This is not optional and it
              is not a formality: the executor is a fresh agent with no memory of this
              conversation, and the description is nearly everything it will see. Send
              back the same description and you have ordered an identical attempt that
              will fail in the identical way. Write the description you wish the task
              had started with — name the files, the functions, the exact change, and
              what the last attempt got wrong.
- SPLIT      the approach is right but the task is too big to finish in one sitting.
              Choose this when attempts keep running out of tool-calling rounds rather
              than getting the work wrong — another identical attempt will be cut off in
              the same place. "splitInto" replaces this task with the steps it should
              have been.
- RESET_FROM the project went in a wrong direction and earlier work must be redone from
              "resetFromSeq". Use this sparingly: it throws away finished work, and
              choosing it repeatedly is how a run makes no progress at all.

There is no verdict for giving up, and there is no attempt limit that ends this task.
The run does not stop until every task is VERIFIED, so a task you cannot pass is a task
whose instructions are still wrong — that is the thing you have the power to change.
Each time you send RETRY, the executor gets whatever description you write and nothing
else, so make each one different from the last in a way that matters.

If the same approach has now failed twice, do not send a third variation of it. Change
what the task asks for: SPLIT it into steps, replace the technique, or fix a premise
that turned out to be false — including the verification command, if that is what is
actually wrong.

For SPLIT: give two to ${MAX_SPLIT_PARTS} parts, in execution order, each completable by one
agent in one sitting and independently verifiable. Do not include work the earlier
attempts already finished on disk — start from where they actually stopped, and say
in "feedback" what you confirmed was already done.

Use "taskEdits" for upcoming tasks too, whenever you learn something that makes them
wrong — a corrected "solutionVerifyCommand" for a check that could not run, or a
"description" that assumed something you now know is false.`;

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
    // A supervisor that cannot be parsed must not silently pass the task — but
    // it must not silently retry it either, because a retry with no rewrite is
    // the same attempt again. Fall through to the repair pass below.
    parsed = false;
    d = {
      verdict: 'RETRY',
      feedback:
        'The supervisor did not return a parseable verdict. Raw reply:\n' + text.slice(0, 2000),
    };
  }

  const named = String(d.verdict ?? '').toUpperCase();
  // FAIL is no longer in the protocol. A model that has seen it elsewhere still
  // emits it, and it means "I have run out of ideas" — which is a reason to
  // rewrite the task, never a reason to end the run.
  const verdict: Verdict = (['VERIFIED', 'RETRY', 'SPLIT', 'RESET_FROM'] as string[]).includes(named)
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
  const own = decision.taskEdits!.find((e) => e.seq === task.seq);
  if (rewritten(own?.description, task.description)) {
    return decision;
  }

  const repair = await demandRewrite(context, output, task, feedback, parsed ? text : '', opts);
  addUsage(total, repair.usage);
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
          solutionVerifyCommand: repair.solutionVerifyCommand || own?.solutionVerifyCommand,
        },
      ],
      usage: total,
    };
  }

  // Both passes declined to write one. The executor still must not be handed
  // the same page twice, so the correction goes in as its own section: less
  // considered than a real rewrite, but it is new information, prominently
  // placed, and it is what the supervisor actually said to do.
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
    usage: total,
  };
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
): Promise<{ description: string; solutionVerifyCommand: string; feedback: string; usage: Usage }> {
  const prompt = `You judged task ${task.seq} and asked for another attempt, but you did not supply the
rewritten description that a retry requires. Supply it now.

The executor is a fresh agent. It will not see this conversation, your reasoning, or
your feedback — it sees the description and little else. If the description does not
change, nothing changes.

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
  "description": "the full replacement description — self-contained, naming the files,
                  functions and exact changes, and stating what the previous attempt got
                  wrong so it is not repeated. Not a diff or a note: the whole thing.",
  "solutionVerifyCommand": "a corrected check command, or \\"\\" to keep the current one",
  "feedback": "one or two sentences of standing instruction for the executor"
}`;

  try {
    const { text, usage } = await runOnce(context, output, 'supervisor', prompt, {
      maxIterations: Math.min(supervisorRounds(), 12),
      ...opts,
    });
    const d = extractJson<any>(text);
    return {
      description: String(d?.description ?? '').trim(),
      solutionVerifyCommand: String(d?.solutionVerifyCommand ?? '').trim(),
      feedback: String(d?.feedback ?? '').trim(),
      usage,
    };
  } catch {
    return { description: '', solutionVerifyCommand: '', feedback: '', usage: { ...NO_USAGE } };
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

${CORRECTION_MARK} ${task.attempts} (this is binding and overrides anything above) ---
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
and the attempt above used your latest version and still did not pass. Whatever you told the
executor to do differently, it was not enough. Do not send a third phrasing of the same idea —
change the plan, split the task, or correct the premise that is actually wrong.
`;
}
