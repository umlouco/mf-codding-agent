import { NewTask, Usage, Task } from './db';
import * as vscode from 'vscode';
import { RunOptions, AgentRunError } from './agentTypes';
import { runOnce } from './agentRuntime';

// ---- task editing ----------------------------------------------------

export interface TaskEditResult {
  summary: string;
  edits: {
    seq: number;
    title?: string;
    description?: string;
    solutionVerifyPrompt?: string;
  }[];
  deletes: number[];
  adds: NewTask[];
  usage: Usage;
}

/**
 * Turns a free-text instruction plus the queue's current tasks into a set of
 * edits, deletions and additions validated against the supplied task snapshot.
 * The caller owns committing this proposal to the queue and reporting what
 * actually changed. Existing task-list rewrites always use the supervisor.
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

Propose the complete set of queue changes for the extension to commit. Your reply does not
itself change the queue. Include every affected sequence number, even for a large revision.
Reply with ONE JSON object and nothing else:
{
  "summary": "one sentence describing the proposed changes",
  "edits": [{ "seq": 1, "title": "...", "description": "...", "solutionVerifyPrompt": "..." }],
  "deletes": [],
  "adds": [{ "title": "...", "description": "...", "solutionVerifyPrompt": "..." }]
}

Only include fields you are actually changing on an "edits" entry; omit a field to leave it as-is.
Replace example sequence numbers with actual queue sequence numbers. deletes is an array of
positive integer sequence numbers. Do not edit and delete the same task in one proposal.
Preserve VERIFIED tasks: this queue editing interface does not modify or delete finished work.
Tasks in "adds" are appended after the current end of the queue, in the order given. Leave any of
the three arrays empty when the instruction does not call for that kind of change. All three
arrays and the summary are required. For no change, return three empty arrays and explain why
in summary. Use only the fields shown above; adds require title and description strings.`;

  const { text, usage, stopReason } = await runOnce(context, output, 'supervisor', prompt, opts);
  const reason = String(stopReason ?? '').trim().toLowerCase();
  if (!['', 'end_turn', 'stop', 'stop_sequence', 'completed'].includes(reason)) {
    throw new AgentRunError(`Task edit planning did not complete (${reason}). No task edit proposal was accepted.`);
  }
  return parseTaskEditResult(text, tasks, usage);
}

/** Validate the complete proposal before any queue mutation; never apply a filtered prefix. */
export function parseTaskEditResult(text: string, tasks: Task[], usage: Usage): TaskEditResult {
  const fail = (detail: string): never => { throw new Error(`Invalid task edit proposal: ${detail}`); };
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    return value as Record<string, unknown>;
  };
  const keys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(`${label} contains unsupported field "${key}".`);
    }
  };
  const string = (value: unknown, label: string): string => {
    if (typeof value !== 'string') fail(`${label} must be a string.`);
    return (value as string).trim();
  };
  const known = new Set(tasks.map(task => task.seq));
  const sequence = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      fail(`${label} must be a positive integer sequence number.`);
    }
    if (!known.has(value as number)) fail(`${label} refers to unknown task #${value}.`);
    return value as number;
  };
  const fields = ['title', 'description', 'solutionVerifyPrompt'] as const;
  // A discarded draft may precede the actual proposal in accumulated model
  // output. Accept one complete envelope, never an earlier parseable fragment.
  const source = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
  let decoded: unknown;
  try {
    decoded = JSON.parse(fenced ? fenced[1] : source);
  } catch {
    fail('reply must contain one complete JSON object, optionally inside a single JSON fence.');
  }
  const parsed = object(decoded, 'reply');
  keys(parsed, ['summary', 'edits', 'deletes', 'adds'], 'reply');
  const summary = string(parsed.summary, 'summary');
  if (!summary) fail('summary must explain the proposed changes or why no changes are needed.');
  for (const name of ['edits', 'deletes', 'adds']) {
    if (!Array.isArray(parsed[name])) fail(`${name} must be an array, including when it is empty.`);
  }

  const edits = new Map<number, TaskEditResult['edits'][number]>();
  for (const [index, value] of (parsed.edits as unknown[]).entries()) {
    const label = `edits[${index}]`;
    const edit = object(value, label);
    keys(edit, ['seq', ...fields], label);
    const seq = sequence(edit.seq, `${label}.seq`);
    const merged = { ...(edits.get(seq) ?? { seq }) };
    let changes = 0;
    for (const field of fields) {
      if (!(field in edit)) continue;
      const next = string(edit[field], `${label}.${field}`);
      if (merged[field] !== undefined && merged[field] !== next) {
        fail(`task #${seq} has conflicting edits to ${field}.`);
      }
      merged[field] = next;
      changes++;
    }
    if (!changes) fail(`${label} must include at least one field to change.`);
    edits.set(seq, merged);
  }

  const deletes = new Set<number>();
  for (const [index, value] of (parsed.deletes as unknown[]).entries()) {
    const seq = sequence(value, `deletes[${index}]`);
    if (edits.has(seq)) fail(`task #${seq} cannot be both edited and deleted.`);
    deletes.add(seq);
  }

  const adds = (parsed.adds as unknown[]).map((value, index): NewTask => {
    const label = `adds[${index}]`;
    const add = object(value, label);
    keys(add, fields, label);
    const task: NewTask = {
      title: string(add.title, `${label}.title`),
      description: string(add.description, `${label}.description`),
    };
    if (!task.title) fail(`${label}.title must not be empty.`);
    for (const field of fields.slice(2)) {
      if (field in add) task[field] = string(add[field], `${label}.${field}`);
    }
    return task;
  });
  return { summary, edits: [...edits.values()], deletes: [...deletes], adds, usage };
}
