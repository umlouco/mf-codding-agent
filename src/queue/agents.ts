import * as cp from 'child_process';
import * as vscode from 'vscode';
import { CoreClient, CoreConfig } from '../core';
import { getStore } from '../providers/instance';
import { NewTask, Task } from './db';

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
async function overridesFor(
  role: Role,
  maxIterations = 0,
  maxDurationSeconds = 0,
): Promise<Partial<CoreConfig>> {
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
    maxDurationSeconds,
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

export class AgentRunError extends Error {
  /** True when the hard timeout killed the turn, so real work may be on disk. */
  constructor(message: string, readonly timedOut = false) {
    super(message);
  }
}

/**
 * The deadline the core is given, derived from the hard timeout that will kill
 * it. The gap between the two is the margin a worker needs to notice its
 * deadline between rounds, finish the tool call already in flight, and write a
 * handoff report. When the hard timeout wins that race instead, the process is
 * killed mid-turn and the attempt leaves nothing behind but whichever files it
 * happened to have written — which is how a retry ends up repeating work that
 * was already done.
 */
function softDeadlineSeconds(hardMs: number): number {
  const margin = Math.max(5 * 60_000, hardMs * 0.25);
  return Math.max(60, Math.round((hardMs - margin) / 1000));
}

/**
 * Spawns a throwaway core on `role`'s model, sends one prompt, and tears the
 * process down — including when the turn throws or times out.
 */
interface TurnResult {
  text: string;
  /** `max_iterations` means the worker was cut off, not that it finished. */
  stopReason: string;
}

async function runOnce(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  role: Role,
  prompt: string,
  timeoutMs: number,
  onEvent?: (method: string, params: any) => void,
  onCancellable?: (cancel: () => void) => void,
  maxIterations = 0,
): Promise<TurnResult> {
  const client = new CoreClient(context, output);
  if (onEvent) {
    client.onNotification(onEvent);
  }
  // An unattended core must never block on a permission round-trip.
  client.onRequest('permission/request', async () => ({ approved: true, alwaysAllow: true }));

  const started = Date.now();
  const deadline = softDeadlineSeconds(timeoutMs);
  try {
    await client.start();
    const init = await client.initialize(await overridesFor(role, maxIterations, deadline));
    output.appendLine(
      `[queue:${role}] core ready on ${init.model} (${init.provider})` +
        (maxIterations > 0 ? `, ${maxIterations} rounds` : '') +
        `, reports at ${Math.round(deadline / 60)}m of ${Math.round(timeoutMs / 60_000)}m`,
    );

    const sessionId = `queue-${role}-${Date.now()}`;
    // The caller can only stop the turn once the core is up and the session is
    // named, so the handle is handed over here rather than at call time.
    onCancellable?.(() => {
      void client.request('chat/cancel', { sessionId }).catch(() => undefined);
    });
    const turn = withTimeout(
      client.request<{ text: string; stopReason: string }>('chat/send', {
        sessionId,
        text: prompt,
      }),
      timeoutMs,
      () => {
        void client.request('chat/cancel', { sessionId }).catch(() => undefined);
      },
    );

    const res = await turn;
    output.appendLine(
      `[queue:${role}] turn finished in ${Math.round((Date.now() - started) / 1000)}s ` +
        `(${res?.stopReason ?? 'unknown'})`,
    );
    return { text: res?.text ?? '', stopReason: res?.stopReason ?? '' };
  } finally {
    client.dispose();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new AgentRunError(`agent exceeded its ${Math.round(ms / 1000)}s budget`, true));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---- JSON extraction ---------------------------------------------------

/**
 * Pulls the first JSON value out of a model reply.
 *
 * Local models in particular wrap JSON in prose or fences and sometimes emit a
 * trailing comma, so this scans for the first balanced `[`/`{` — quote- and
 * escape-aware — rather than trusting the whole reply to parse.
 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], text] : [text];

  for (const c of candidates) {
    const start = c.search(/[[{]/);
    if (start < 0) {
      continue;
    }
    const open = c[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = start; i < c.length; i++) {
      const ch = c[i];
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
          const slice = c.slice(start, i + 1);
          try {
            return JSON.parse(slice) as T;
          } catch {
            // Retry once without trailing commas, the usual local-model slip.
            try {
              return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) as T;
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  throw new AgentRunError('the model did not return parseable JSON');
}

// ---- planner -----------------------------------------------------------

const MAX_TASKS = 100;

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

  const { text } = await runOnce(
    context, output, 'planner', prompt, minutes(15), onEvent, onCancellable, baseRounds(),
  );
  const raw = extractJson<any[]>(text);
  if (!Array.isArray(raw)) {
    throw new AgentRunError('the planner returned JSON but not an array of tasks');
  }

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
  /** The worker hit a budget; `text` is a partial-progress report, not a result. */
  cutOff: boolean;
  /** `max_iterations`, `max_duration`, or the model's own reason for stopping. */
  stopReason: string;
  /** Rounds this attempt was allowed, for the log. */
  rounds: number;
  /** Wall-clock minutes this attempt was allowed, for the log. */
  budgetMinutes: number;
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
If an attempt ran out of rounds or time rather than getting something wrong, the
task is too big for the budget: do the part that unblocks everything else first,
and report precisely where you stopped.

Supervisor feedback on the last attempt — treat this as binding:
${task.supervisorFeedback.trim() || '(none)'}
`;
}

export async function executeTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
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

  const budget = vscode.workspace
    .getConfiguration('mfagent')
    .get<number>('queue.taskTimeoutMinutes', 20);

  // Give a retry more room than the attempt that ran out, but cap it so token
  // usage does not explode across attempts.
  //
  // Rounds and wall-clock time escalate by the same factor, because raising one
  // alone does not buy the retry any more work — it just moves where the
  // attempt dies. Extra rounds inside a fixed timeout means permission to start
  // work there is no time to finish, so a task that was cut off by the round
  // ceiling comes back and is killed by the clock instead.
  const scale = Math.min(1 + 0.5 * Math.max(0, task.attempts - 1), 3);
  const rounds = Math.round(baseRounds() * scale);
  const budgetMinutes = Math.round(Math.max(1, budget) * scale);

  const { text, stopReason } = await runOnce(
    context, output, 'executor', prompt, minutes(budgetMinutes), onEvent, undefined, rounds,
  );
  return {
    text,
    ok: text.trim().length > 0,
    cutOff: stopReason === 'max_iterations' || stopReason === 'max_duration',
    stopReason,
    rounds,
    budgetMinutes,
  };
}

// ---- functional check --------------------------------------------------

export interface CommandResult {
  ran: boolean;
  code: number | null;
  output: string;
}

/**
 * Runs a task's verification command and reports the exit code.
 *
 * This runs here rather than inside the Supervisor's turn on purpose: an exit
 * code is objective, and asking a model to both run and judge the check invites
 * it to report a pass it never observed.
 */
export function runVerifyCommand(command: string, cwd: string, timeoutMs: number): CommandResult {
  if (!command.trim()) {
    return { ran: false, code: null, output: '' };
  }
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];

  const res = cp.spawnSync(shell, args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });

  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return {
    ran: true,
    code: res.status,
    output: out.length > 12000 ? `${out.slice(0, 12000)}\n… (truncated)` : out,
  };
}

// ---- supervisor --------------------------------------------------------

export type Verdict = 'VERIFIED' | 'RETRY' | 'SPLIT' | 'RESET_FROM' | 'FAIL';

/** Upper bound on the pieces one oversized task may be replaced with. */
const MAX_SPLIT_PARTS = 6;

export interface SupervisorDecision {
  verdict: Verdict;
  feedback: string;
  /** Only meaningful for RESET_FROM: the sequence number to roll back to. */
  resetFromSeq?: number;
  /** Only meaningful for SPLIT: the tasks that replace this one, in order. */
  splitInto?: NewTask[];
  /** Optional edits the supervisor wants applied to upcoming tasks. */
  taskEdits?: { seq: number; description?: string; solutionVerifyCommand?: string }[];
}

export async function superviseTask(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  task: Task,
  check: CommandResult,
  onEvent?: (method: string, params: any) => void,
): Promise<SupervisorDecision> {
  const checkReport = check.ran
    ? `The verification command \`${task.solutionVerifyCommand}\` exited with code ${check.code}.

Output:
${check.output || '(no output)'}`
    : 'No verification command was configured for this task, so you must verify by inspection.';

  const prompt = `You are the supervisor of an autonomous coding run. Judge one completed task and decide what happens next.

TASK ${task.seq}: ${task.title}
Attempt ${task.attempts} of ${task.maxAttempts}.

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
  "verdict": "VERIFIED" | "RETRY" | "SPLIT" | "RESET_FROM" | "FAIL",
  "feedback": "what you found, and for a retry exactly what to do differently",
  "resetFromSeq": <number, only with RESET_FROM>,
  "splitInto": [{ "title": "...", "description": "...", "implVerifyPrompt": "...",
                  "solutionVerifyPrompt": "...", "solutionVerifyCommand": "..." }],
  "taskEdits": [{ "seq": <number>, "description": "...", "solutionVerifyCommand": "..." }]
}

Choose:
- VERIFIED   the work is done and correct.
- RETRY      this task alone needs another attempt; put the fix instructions in "feedback".
              ALSO include this task's seq in "taskEdits" with a rewritten "description"
              that tells the executor exactly what to do differently — the old description
              was wrong and will cause the same failure again.
- SPLIT      the approach is right but the task is too big to finish in one sitting.
              Choose this when attempts keep being cut off by the round or time budget
              rather than getting the work wrong — another identical attempt will be cut
              off in the same place. "splitInto" replaces this task with the steps it
              should have been.
- RESET_FROM the project went in a wrong direction and earlier work must be redone from "resetFromSeq".
- FAIL       this cannot succeed by retrying and a human should look.

Retrying an oversized task until its attempts run out is the failure mode to avoid.
If the history above shows the executor being cut off more than once, prefer SPLIT
over RETRY.

For SPLIT: give two to ${MAX_SPLIT_PARTS} parts, in execution order, each completable by one
agent in one sitting and independently verifiable. Do not include work the earlier
attempts already finished on disk — start from where they actually stopped, and say
in "feedback" what you confirmed was already done.

"taskEdits" is optional — use it to correct upcoming tasks when you have learned
something that makes them wrong. When verdict is RETRY, you MUST also edit the
current task (seq ${task.seq}) with a corrected description.`;

  const budget = vscode.workspace
    .getConfiguration('mfagent')
    .get<number>('queue.supervisorTimeoutMinutes', 15);

  const { text } = await runOnce(
    context, output, 'supervisor', prompt, minutes(budget), onEvent, undefined, supervisorRounds(),
  );

  let d: SupervisorDecision;
  try {
    d = extractJson<SupervisorDecision>(text);
  } catch {
    // A supervisor that cannot be parsed must not silently pass the task.
    return {
      verdict: 'RETRY',
      feedback:
        'The supervisor did not return a parseable verdict. Raw reply:\n' + text.slice(0, 2000),
    };
  }

  const named = String(d.verdict ?? '').toUpperCase() as Verdict;
  const verdict = (['VERIFIED', 'RETRY', 'SPLIT', 'RESET_FROM', 'FAIL'] as string[]).includes(named)
    ? named
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

  return {
    // A split into fewer than two usable parts is not a split. Fall back to the
    // retry it amounts to rather than replacing the task with a copy of itself.
    verdict: verdict === 'SPLIT' && splitInto.length < 2 ? 'RETRY' : verdict,
    feedback: String(d.feedback ?? '').trim(),
    resetFromSeq: typeof d.resetFromSeq === 'number' ? d.resetFromSeq : undefined,
    splitInto: splitInto.length >= 2 ? splitInto : undefined,
    taskEdits: Array.isArray(d.taskEdits) ? d.taskEdits : undefined,
  };
}

function minutes(n: number): number {
  return Math.max(1, n) * 60_000;
}
