import type { Task, TaskQueue } from './db';
import { scopedContract, scopeContractFields } from './scopeContract';

/** Provenance changes how an adapter is interpreted, never the assigned requirements. */
export interface VerificationAuthority {
  source: 'extension-generated';
  originalCommand: '';
  adapter: string;
  eventId: number;
  originEventId?: number;
  reason: string;
}

/** A narrow host proof, not a model guess: the latest admitted adapter has an exact
 * correction chain rooted in an empty check. Owner commands and ambiguous history remain authoritative.
 * This function only reads metadata and events; it cannot repair or weaken a task.
 */
export function verificationAuthority(queue: TaskQueue, task: Task): VerificationAuthority | undefined {
  const admitted = scopedContract(queue, task);
  if (!admitted || !task.solutionVerifyCommand.trim() ||
      !scopeContractFields.every(field => task[field] === admitted.contract[field])) return undefined;
  const events = queue.events(task.id, -1);
  let expected = task.solutionVerifyCommand;
  let latestId: number | undefined;
  let originId: number | undefined;
  for (const event of events) {
    if (event.actor === 'user' &&
        ['task-edited', 'contract-edited', 'task-updated', 'validation-edited', 'check-fixed'].includes(event.kind)) {
      return undefined; // Neither later nor intervening owner edits may be skipped.
    }
    if (event.actor !== 'supervisor' || event.kind !== 'check-fixed') continue;
    latestId ??= event.id;
    let proof: any;
    try { proof = JSON.parse(event.message); } catch { return undefined; }
    if (proof?.source !== 'scoped-reverify-command' || typeof proof.oldCommand !== 'string' ||
        proof.newCommand !== expected) return undefined;
    if (proof.oldCommand === '') { originId = event.id; break; }
    expected = proof.oldCommand;
  }
  if (latestId === undefined || originId === undefined) return undefined;
  return { source: 'extension-generated', originalCommand: '', adapter: task.solutionVerifyCommand,
    eventId: latestId, originEventId: originId,
    reason: 'The host journal proves that the extension generated this saved adapter from an empty command. ' +
      'It is a generated checking approach, not an owner-authored acceptance requirement. The assigned description, ' +
      'implementation checks and behavioral checks remain authoritative in full. Do not promote adapter-only ' +
      'assertions or unfinished sibling work into this task\'s acceptance. Adapt the checking approach to measure ' +
      'the assigned requirements without changing task rows or weakening any actual owner requirement.' };
}
