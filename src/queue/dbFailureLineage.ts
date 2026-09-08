import { createHash } from 'crypto';
import type { Task, TaskQueue } from './db';

type FamilyStore = Pick<TaskQueue, 'list' | 'getMeta' | 'setMeta'>;

/** Read only the inherited host lineage; a replacement cannot choose a fresh family. */
export function persistedFailureFamily(task: Pick<Task, 'region'>): string | undefined {
  try {
    const family = JSON.parse(task.region || '{}').failureFamily;
    if (typeof family === 'string' && family) return family;
  } catch { /* Ordinary tasks need no lineage. */ }
  return undefined;
}

export function decompositionFamily(task: Task): string {
  return persistedFailureFamily(task) || `${task.id}:${task.createdAt}`;
}

/** Bound recursive task multiplication, not productive execution. Only verified family work replenishes it. */
export function admitDecompositionFamily(queue: FamilyStore, task: Task): boolean {
  const family = decompositionFamily(task);
  const key = `failureDecompositionFamily:v1:${family}`;
  const proofs = queue.list().filter(row => row.status === 'VERIFIED' &&
    decompositionFamily(row) === family).map(row => createHash('sha256').update(JSON.stringify([row.id, row.validationReport])).digest('hex'));
  let state: { proofs: string[]; splits: number } = { proofs: [], splits: 0 };
  const saved = queue.getMeta(key);
  if (saved) {
    try { state = JSON.parse(saved); if (!Array.isArray(state.proofs) ||
      !Number.isSafeInteger(state.splits) || state.splits < 0) return false; }
    catch { return false; }
  }
  const fresh = proofs.filter(proof => !state.proofs.includes(proof));
  if (fresh.length) state = { proofs: [...state.proofs, ...fresh], splits: 0 };
  if (state.splits >= 32) return false;
  // splitTask calls this inside its write transaction, so admission and replacement commit together.
  state.splits++;
  queue.setMeta(key, JSON.stringify(state));
  return true;
}
