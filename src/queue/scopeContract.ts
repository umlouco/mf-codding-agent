import type { Task, TaskEvent, TaskQueue } from './db';
import { replacementTasks } from './scopePlan';
import { verdictReplacementTasks } from './scopeVerdict';

export const scopeContractFields = ['description', 'solutionVerifyPrompt'] as const;
export type LocalContract = Pick<Task, typeof scopeContractFields[number]>;

function parse(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

function assignment(task: Task): any {
  const split = parse(task.region || '')?.scopeSplit;
  return split && typeof split.archiveKey === 'string' && split.archiveKey.trim() &&
    typeof split.key === 'string' && split.key.trim() && typeof split.integration === 'boolean'
    ? split : undefined;
}

export function isLocalScope(task: Task): boolean {
  return assignment(task)?.integration === false;
}

export function contractOf(task: LocalContract): LocalContract {
  return Object.fromEntries(scopeContractFields.map(field => [field, task[field]])) as LocalContract;
}

function validContract(value: any): value is LocalContract {
  return !!value && scopeContractFields.every(field => typeof value[field] === 'string');
}

function admittedContract(queue: TaskQueue, task: Task): {
  contract: LocalContract; archiveKey: string; key: string; ownerContext?: string; legacy: boolean;
} | undefined {
  const split = assignment(task);
  if (!split) return undefined;
  const archive = parse(queue.getMeta(split.archiveKey));
  if (!archive?.task || !Number.isSafeInteger(archive.task.id) ||
      archive.task.id === task.id || !validContract(archive.task)) return undefined;
  const ownerContext = JSON.stringify([queue.getMeta('goal'), queue.testingContext + queue.instructions]);
  if (typeof archive.ownerContext === 'string' && archive.ownerContext !== ownerContext) return undefined;
  let index = -1;
  if (Array.isArray(archive.assessment?.parts)) {
    index = archive.assessment.parts.findIndex((part: any) => part.key === split.key && part.integration === split.integration);
  } else if (Array.isArray(archive.decision?.splitInto) && split.source === 'supervisor-verdict' && !split.integration) {
    index = archive.decision.splitInto.findIndex((_: unknown, i: number) => split.key === `verdict-${i + 1}`);
  }
  if (index < 0) return undefined;
  let contract = split.contract;
  if (!validContract(contract)) {
    try { contract = archive.assessment
      ? replacementTasks(archive.assessment, archive.task, split.archiveKey)[index]
      : verdictReplacementTasks(archive.decision.splitInto, archive.task, split.archiveKey)[index]; }
    catch { return undefined; }
  }
  if (!validContract(contract)) return undefined;
  return { contract: contractOf(contract), archiveKey: split.archiveKey, key: split.key,
    ownerContext: archive.ownerContext, legacy: !validContract(split.contract) };
}

/** Allocation is admitted once; a later progress review cannot redefine its acceptance. */
export function scopedContract(queue: TaskQueue, task: Task): ReturnType<typeof admittedContract> {
  return isLocalScope(task) ? admittedContract(queue, task) : undefined;
}

/** A marker is not proof: preflight reuse requires the exact admitted contract. */
export function hasAdmittedScope(queue: TaskQueue, task: Task): boolean {
  const admitted = admittedContract(queue, task);
  return !!admitted && scopeContractFields.every(field => task[field] === admitted.contract[field]);
}

/** Read complete JSON objects from retained response chunks, never natural-language guesses. */
function* responseObjects(text: string): Generator<any> {
  // The retained stream may begin halfway through an old response or include
  // an abandoned malformed turn. Neither can swallow later complete decisions.
  const starts = /\{(?=\s*"(?:compatible|action|reason|description|rewrittenDescription)")/g;
  for (const match of [...text.matchAll(starts)].reverse()) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = match.index!; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && !--depth) {
        const value = parse(text.slice(match.index!, index + 1));
        if (value) yield value;
        break;
      }
    }
  }
}

function rewriteProof(queue: TaskQueue, task: Task, events: TaskEvent[]): TaskEvent | undefined {
  const rewrite = events.find(event => event.actor === 'supervisor' &&
    ['action:STOP_AND_REWRITE_TASK', 'action:STOP_AND_REWRITE_VALIDATION'].includes(event.kind));
  if (!rewrite || events.some(event => event.actor === 'user' &&
    ['task-edited', 'contract-edited', 'task-updated'].includes(event.kind))) return undefined;
  const appliedKind = rewrite.kind === 'action:STOP_AND_REWRITE_TASK' ? 'task-edited' : 'validation-edited';
  if (!events.some(event => event.id > rewrite.id && event.actor === 'supervisor' && event.kind === appliedKind)) return undefined;
  // Old manual task edits were not journalled. Absence of a user event is not proof.
  // Require the exact current contract to match a complete, actually-applied model response.
  const text = queue.logsTail(task.id, -1).filter(log => log.actor === 'supervisor' && log.kind === 'response')
    .map(log => log.chunk).join('');
  const sources = [...events.filter(event => event.actor === 'supervisor' && event.kind === 'response')
    .map(event => event.message), text];
  for (const source of sources) for (const candidate of responseObjects(source)) {
    if (typeof candidate.reason !== 'string' || candidate.reason.trim() !== rewrite.message.trim()) continue;
    if (candidate.compatible !== false && `action:${candidate.action}` !== rewrite.kind) continue;
    const contract = { ...candidate, description: candidate.rewrittenDescription ?? candidate.description };
    if (validContract(contract) && scopeContractFields.every(field => contract[field].trim() === task[field])) return rewrite;
  }
  return undefined;
}

/** Explicit Start can repair an extension-authored rewrite, not an operator's task edits. */
export function restoreScopedContracts(queue: TaskQueue): number {
  let restored = 0;
  for (const task of queue.list()) {
    if (task.status === 'VERIFIED' || task.status === 'EXECUTING') continue;
    const admitted = scopedContract(queue, task);
    if (!admitted || scopeContractFields.every(field => task[field] === admitted.contract[field])) continue;
    const proof = rewriteProof(queue, task, queue.events(task.id, -1));
    if (!proof) continue;
    const archiveKey = `${admitted.archiveKey}:contract-restore:${task.id}:` +
      (queue.countEvents(task.id, 'scope-contract-restored') + 1);
    queue.setMeta(archiveKey, JSON.stringify({ task, restoredContract: admitted.contract,
      sourceRewriteEvent: proof.id, archivedAt: Date.now() }));
    queue.update(task.id, { ...admitted.contract, validationReport: '',
      supervisorFeedback: 'The extension removed its own scope-expanding contract rewrite. Continue the admitted ' +
        'local outcome using existing work and evidence; sibling work remains assigned to separate tickets.' });
    queue.log(task.id, 'system', 'scope-contract-restored', JSON.stringify({ archiveKey,
      sourceRewriteEvent: proof.id, reason: 'Restored the admitted local contract, preserving task progress and archived reports.' }));
    restored++;
  }
  return restored;
}
