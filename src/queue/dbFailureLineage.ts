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

/**
 * These three exact phrasings are host-generated (verificationBudget.ts and
 * orchestratorVerification.ts), never model prose, so matching them is a reliable
 * signal that a decomposition was forced because independent verification could
 * not conclude within its bounded interactions/passes/decisions — not because an
 * implementation defect, or genuine excess scope, was ever actually observed.
 */
export function verificationStallReason(reason: string): boolean {
  return reason.includes('Verification LLM interaction budget exhausted') ||
    reason.includes('Two verification passes did not establish completion') ||
    reason.includes('Verification recovery did not resolve the task after two decisions');
}

/**
 * Consecutive decompositions in this family caused only by verification never
 * concluding, never by an observed defect. Splitting narrower cannot fix a
 * verifier that cannot converge on the current shape of the task — it only
 * hands the identical wall to a smaller task, which is exactly how one analysis
 * task upstream of this counter turned into 30+ generations of "verify/inventory/
 * reconcile a prior verification attempt" over several days without ever getting
 * an implementation defect, a genuine scope finding, or a single VERIFIED proof.
 * Resets on any new verified family proof (same rule as admitDecompositionFamily,
 * so real progress elsewhere in the family is never held against it) and on any
 * decomposition requested for a different reason.
 */
export function verificationStallStreak(queue: FamilyStore, task: Task, reason: string): number {
  const family = decompositionFamily(task);
  const key = `verificationStall:v1:${family}`;
  const proofs = queue.list().filter(row => row.status === 'VERIFIED' &&
    decompositionFamily(row) === family).map(row => createHash('sha256').update(JSON.stringify([row.id, row.validationReport])).digest('hex'));
  let state: { proofs: string[]; streak: number } = { proofs: [], streak: 0 };
  const saved = queue.getMeta(key);
  if (saved) {
    try {
      state = JSON.parse(saved);
      if (!Array.isArray(state.proofs) || !Number.isSafeInteger(state.streak) || state.streak < 0) state = { proofs: [], streak: 0 };
    } catch { state = { proofs: [], streak: 0 }; }
  }
  const fresh = proofs.filter(proof => !state.proofs.includes(proof));
  if (fresh.length) state = { proofs: [...state.proofs, ...fresh], streak: 0 };
  state.streak = verificationStallReason(reason) ? state.streak + 1 : 0;
  queue.setMeta(key, JSON.stringify(state));
  return state.streak;
}
