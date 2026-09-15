import { createHash } from 'crypto';
import type { NewTask, Task } from './db';

/**
 * How a failed task becomes smaller tasks.
 *
 * A split is the queue's answer to failure (an executor that stopped working,
 * or one the supervisor found looping or down a rabbit hole), so it has to land
 * every time. Nothing here refuses a plan for being imperfect: incomplete and
 * duplicate entries are dropped, oversized file lists are partitioned, and the
 * original acceptance check rides on the last replacement. When no usable plan
 * exists at all, mechanicalSplit divides the task deterministically.
 */

/** A proposed replacement task, as a planner or an executor wrote it. */
export interface SplitProposal {
  title: string;
  description: string;
  solutionVerifyPrompt?: string;
  targets?: string[];
}

type SplitSource = Pick<Task, 'title' | 'description' | 'solutionVerifyPrompt'>;

/** Files one replacement may edit; a longer list is partitioned by the host. */
export const TARGET_FILE_LIMIT = 3;
/** Steps a mechanical split produces at most; any step can be split again. */
const MECHANICAL_PARTS = 3;

const PROVENANCE = /\r?\n\r?\n(?:Progress-preserving handoff from (?:retired )?task \d+:|Parent acceptance criteria \()/i;
const HOST_BLOCKS = /\r?\n\r?\n(?:Progress-preserving handoff from (?:retired )?task \d+:|Parent acceptance criteria \(|Assigned files for this replacement)/i;

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const canonical = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** Titles, punctuation, case, or verification paraphrases do not disguise the same work. */
export function failureScopeFingerprint(task: Pick<Task, 'description'>): string {
  // The host appends provenance after admitting a split. Different archive ids
  // must not make the same executable scope look like a new task next time.
  const scope = task.description.normalize('NFKC').split(PROVENANCE)[0];
  return createHash('sha256').update(canonical(scope)).digest('hex');
}

/**
 * Turns a proposed list of smaller tasks into a split the queue can commit.
 *
 * Entries without a title or description, and copies of the original, an
 * ancestor, or a sibling, are dropped instead of failing the whole plan. A
 * replacement listing more than TARGET_FILE_LIMIT files becomes one task per
 * group of files. The last replacement also runs the original acceptance check,
 * so work a proposal forgot surfaces as that check failing, and that task is
 * split in turn. Only a proposal left with fewer than two tasks is refused.
 */
export function normalizeSplitParts(raw: unknown, parent: SplitSource,
  ancestry: Pick<Task, 'description'>[] = []): NewTask[] {
  if (!Array.isArray(raw)) throw Error('splitInto must be a list of smaller tasks.');
  const seen = new Set([parent, ...ancestry].map(failureScopeFingerprint));
  const parts: NewTask[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const title = text(entry.title);
    const description = text(entry.description);
    if (!title || !description) continue;
    const identity = failureScopeFingerprint({ description });
    if (seen.has(identity)) continue;
    seen.add(identity);
    const verify = text(entry.solutionVerifyPrompt) || 'Show that the change this task describes is in place and working.';
    const targets = Array.isArray(entry.targets) ? [...new Set(entry.targets.map(text).filter(Boolean))] as string[] : [];
    const groups: string[][] = [];
    for (let i = 0; i < targets.length; i += TARGET_FILE_LIMIT) groups.push(targets.slice(i, i + TARGET_FILE_LIMIT));
    if (!groups.length) groups.push([]);
    groups.forEach((files, index) => parts.push({
      title: groups.length > 1 ? `${title} (files ${index + 1} of ${groups.length})` : title,
      description: description + (files.length
        ? `\n\nAssigned files for this replacement (host-enforced limit: ${TARGET_FILE_LIMIT}): ${files.join(', ')}` +
          (groups.length > 1 ? '. The other files of this change belong to its sibling tasks.' : '')
        : ''),
      solutionVerifyPrompt: groups.length > 1 && index < groups.length - 1
        ? `Show that these files contain this task's change and the project still builds: ${files.join(', ')}.`
        : verify,
    }));
  }
  if (parts.length < 2) {
    throw Error('A split needs at least two smaller tasks, each with a title and a description that differs from the original.');
  }
  const titles = new Map<string, number>();
  for (const part of parts) {
    const key = canonical(part.title);
    const count = (titles.get(key) ?? 0) + 1;
    titles.set(key, count);
    if (count > 1) part.title = `${part.title} (${count})`;
  }
  const acceptance = parent.solutionVerifyPrompt.trim();
  const last = parts[parts.length - 1];
  if (acceptance && !last.solutionVerifyPrompt!.includes(acceptance)) {
    last.solutionVerifyPrompt = `${last.solutionVerifyPrompt}\n\nThis is the last task replacing "${parent.title}"; ` +
      `also run its original acceptance check: ${acceptance}`;
  }
  return parts;
}

/**
 * The deterministic split used when there is no usable proposal: the planner
 * failed, gave no answer in time, or could not be reached. It cannot fail. The
 * description's own list items or sentences become ordered steps; a task too
 * small to divide becomes "fix what stopped the last attempt", then "finish".
 */
export function mechanicalSplit(task: SplitSource, reason: string): NewTask[] {
  const scope = task.description.normalize('NFKC').split(HOST_BLOCKS)[0].trim() || task.title;
  const acceptance = task.solutionVerifyPrompt.trim() || 'Establish that the described behavior works.';
  const units = workUnits(scope);
  if (units.length < 2) {
    return [{
      title: clip(`Fix what stopped the last attempt: ${task.title}`, 160),
      description: `The previous attempt at "${task.title}" did not finish. The host recorded: ` +
        `${clip(reason.trim() || 'the executor stopped without completing the task', 1500)}\n` +
        'Reproduce that failure, find its cause, and fix only that cause. Do not do the rest of the task in this step.' +
        `\n\nTASK THIS STEP UNBLOCKS (context only):\n${scope}`,
      solutionVerifyPrompt: 'Rerun the command or check that exposed the recorded failure and show that it now succeeds.',
    }, {
      title: clip(`Finish: ${task.title}`, 160),
      description: `${scope}\n\nThe previous step fixed what stopped the last attempt. Inspect the current files ` +
        'first and do only the work that is still missing.',
      solutionVerifyPrompt: acceptance,
    }];
  }
  const count = Math.min(MECHANICAL_PARTS, units.length);
  const groups = Array.from({ length: count }, (_, i) =>
    units.slice(Math.floor(i * units.length / count), Math.floor((i + 1) * units.length / count)));
  return groups.map((group, i) => {
    const step = group.join(' ');
    return {
      title: clip(`Step ${i + 1}/${count}: ${group[0]}`, 160),
      description: `Step ${i + 1} of ${count} of "${task.title}". Do only this step; the other steps are separate tasks` +
        (i ? ', and the earlier ones ran before this one, so inspect their changes first.' : '.') +
        `\n\nTHIS STEP:\n${step}\n\nWHOLE TASK (context only; do not do the other steps):\n${scope}`,
      solutionVerifyPrompt: i === count - 1 ? acceptance : `Show that this step is done and working: ${clip(step, 600)}`,
    };
  });
}

/** The units of work a description already names, in order. */
function workUnits(scope: string): string[] {
  const lines = scope.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const items = lines.filter(line => /^(?:[-*•]|\d+[.)])\s+/.test(line));
  if (items.length >= 2) return items.map(line => line.replace(/^(?:[-*•]|\d+[.)])\s+/, ''));
  const sentences = scope.replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(\[])/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
  // A short fragment ("Then build it.") belongs to the sentence before it.
  return sentences.reduce<string[]>((units, sentence) => {
    if (units.length && sentence.length < 40) units[units.length - 1] += ` ${sentence}`;
    else units.push(sentence);
    return units;
  }, []);
}
