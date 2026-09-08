import { createHash } from 'crypto';
import { statSync } from 'fs';
import { join } from 'path';
import type { Task, TaskQueue } from './db';
import { indexRepository } from './workInventory';

export interface DecompositionJob {
  version: 1;
  reason: string;
  inputs: Record<string, number>;
  fingerprint: string;
  dueAt: number;
  awaitingChange: boolean;
  lastError: string;
  invalidPlan: string;
}

export const decompositionKey = (task: Task) => `failureDecomposition:v1:${task.id}:${task.createdAt}`;
export const requiresDecomposition = (task: Task) => task.status === 'FAILED' ||
  task.activityPhase?.startsWith('decomposition_') === true;
export const decompositionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function readDecomposition(queue: TaskQueue, task: Task): DecompositionJob | undefined {
  const text = queue.getMeta(decompositionKey(task));
  if (!text) return;
  try {
    const job = JSON.parse(text);
    if (job.version !== 1 || !job.inputs || typeof job.inputs !== 'object' || Array.isArray(job.inputs) ||
        Object.values(job.inputs).some(n => !Number.isSafeInteger(n) || (n as number) < 0) ||
        !Number.isSafeInteger(job.dueAt) || job.dueAt < 0 || typeof job.reason !== 'string' ||
        typeof job.fingerprint !== 'string' || typeof job.awaitingChange !== 'boolean' ||
        typeof job.lastError !== 'string' || typeof job.invalidPlan !== 'string') throw Error('Invalid decomposition journal');
    return job;
  } catch {
    // Unreadable accounting is not a fresh allowance to spend on the same task.
    return { version: 1, reason: 'Repair unreadable decomposition accounting.', inputs: {},
      fingerprint: '', dueAt: 0, awaitingChange: true, lastError: 'Decomposition metadata is unreadable.', invalidPlan: text };
  }
}

export function saveDecomposition(queue: TaskQueue, task: Task, job: DecompositionJob): void {
  queue.setMeta(decompositionKey(task), JSON.stringify(job));
}

export function scheduleDecomposition(queue: TaskQueue, task: Task, reason: string): DecompositionJob {
  const previous = readDecomposition(queue, task);
  if (previous) return previous;
  const job: DecompositionJob = { version: 1, reason, inputs: {}, fingerprint: '', dueAt: 0,
    awaitingChange: false, lastError: '', invalidPlan: '' };
  saveDecomposition(queue, task, job);
  queue.log(task.id, 'supervisor', 'decomposition-required', reason);
  return job;
}

/** No clock, heartbeat, sequence number, or model-generated explanation counts as changed evidence. */
export function decompositionWorkspaceRevision(root: string): string {
  const index = indexRepository(root);
  return decompositionDigest([index.fingerprint, index.problems, index.files.map(file => {
    try { const stat = statSync(join(root, file)); return [file, stat.size, stat.mtimeMs]; }
    catch { return [file, 'unavailable']; }
  })]);
}

/** Persist before the provider starts; reloads and A -> B -> A input changes cannot renew a spent allowance. */
export function admitDecomposition(queue: TaskQueue, task: Task, job: DecompositionJob,
  fingerprint: string, now = Date.now()): boolean {
  if (job.awaitingChange && (!job.fingerprint || job.fingerprint === fingerprint)) return false;
  const attempts = job.inputs[fingerprint] ?? 0;
  if (attempts >= 3 || Object.keys(job.inputs).length >= 128 && !(fingerprint in job.inputs)) return false;
  if (fingerprint === job.fingerprint && now < job.dueAt) return false;
  job.inputs[fingerprint] = attempts + 1;
  job.fingerprint = fingerprint;
  job.awaitingChange = false;
  job.dueAt = now + Math.min(300_000, 15_000 * 2 ** attempts);
  saveDecomposition(queue, task, job);
  return true;
}

export function decompositionAncestry(queue: TaskQueue, task: Task): Task[] {
  const ancestors: Task[] = [];
  const seen = new Set<number>([task.id]);
  let current = task;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const key = JSON.parse(current.region || '{}').scopeSplit?.archiveKey;
      if (!key) break;
      const parent = JSON.parse(queue.getMeta(key)).task as Task;
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id); ancestors.push(parent); current = parent;
    } catch { break; }
  }
  return ancestors;
}

export { decompositionFamily, admitDecompositionFamily } from './dbFailureLineage';
