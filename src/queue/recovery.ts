import { createHash } from 'crypto';
import type { Task, TaskQueue } from './db';
import { recoveryEvents } from './recoveryJournal';

/** A recovery budget belongs to unfinished work, not to a mutable description. */
export interface RecoveryState {
  version: 1;
  cursor: number;
  revision: number;
  seen: string[];
  repeats: number;
  recoveries: number;
  unchanged: number;
  checkpoint: number;
  lastStart?: number;
  saturated?: boolean;
  failures: Record<string, number>;
  blocked?: string;
  blockedContract?: string;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const recoveryKey = (task: Task) => `recovery:v1:${task.id}:${task.createdAt}`;
const contract = (task: Task) => digest(JSON.stringify([task.description, task.implVerifyPrompt,
  task.solutionVerifyPrompt, task.solutionVerifyCommand]));
const fresh = (): RecoveryState => ({ version: 1, cursor: 0, revision: 0, seen: [], repeats: 0,
  recoveries: 0, unchanged: 0, checkpoint: 0, failures: {} });

export function recoveryState(queue: TaskQueue, task: Task): RecoveryState {
  let state: RecoveryState;
  try {
    state = JSON.parse(queue.getMeta(recoveryKey(task)));
    if (state.version !== 1 || !Array.isArray(state.seen) || !state.failures ||
        ['cursor', 'revision', 'repeats', 'recoveries', 'unchanged', 'checkpoint'].some(key =>
          !Number.isSafeInteger((state as any)[key]) || (state as any)[key] < 0)) throw Error('Invalid ledger');
  } catch { state = fresh(); }
  // Once paused, only an operator can edit the contract. Automatic rewrites before
  // the pause never renew this budget; neither does reloading or clicking Start.
  if (state.blocked && state.blockedContract !== contract(task)) state = fresh();
  return state;
}

export function saveRecovery(queue: TaskQueue, task: Task, state: RecoveryState): void {
  queue.setMeta(recoveryKey(task), JSON.stringify(state));
}

/** Distinguish new observations from replay. Novelty is NOT acceptance evidence.
 * Journal excerpts are bounded; the ledger remembers outcomes across attempts.
 * Tool starts that might mutate/test protect an in-flight result, but read starts
 * and heartbeat/thinking records cannot make a repeated inspection look new.
 */
export function recoveryEvidence(queue: TaskQueue, task: Task): RecoveryState {
  const state = recoveryState(queue, task);
  const seen = new Set(state.seen);
  const through = queue.latestWorkerToolEventId?.(task.id) ?? 0;
  while (state.cursor < through) {
    const events = recoveryEvents(queue, task.id, state.cursor, through);
    if (!events.length) { state.cursor = through; break; }
    for (const event of events) {
      state.cursor = event.id;
      if (/→ start$/.test(event.message)) {
        if (!/^(?:[\w-]+__)*(?:read\w*|Read|search\w*|list\w*|glob|grep)\(/i.test(event.message)) state.lastStart = event.id;
        continue;
      }
      const normalized = event.message.replace(/ in \d+(?:\.\d+)?ms(?=\n|$)/g, '').trim();
      const signature = digest(`${event.actor}:${normalized}`);
      if (seen.has(signature)) state.repeats++;
      else if (seen.size < 4096) { state.revision = event.id; state.repeats = 0; seen.add(signature); }
      else state.saturated = true; // Never evict old outcomes and mistake a long replay for novelty.
    }
  }
  state.seen = [...seen];
  saveRecovery(queue, task, state);
  return state;
}

/** New opaque/mutating tool starts still invalidate an older destructive review.
 * The completed-outcome repetition gate runs before another review can be issued.
 */
export function decisionEvidence(queue: TaskQueue, task: Task): number {
  const state = recoveryEvidence(queue, task);
  return Math.max(state.revision, state.lastStart ?? 0);
}

export function recoveryRequest(queue: TaskQueue, task: Task): string {
  const state = recoveryEvidence(queue, task);
  if (state.blocked) return state.blocked;
  state.recoveries++;
  state.unchanged = state.checkpoint === state.revision ? state.unchanged + 1 : 0;
  state.checkpoint = state.revision;
  saveRecovery(queue, task, state);
  if (state.unchanged >= 3) return 'Three recovery requests without a new completed tool outcome.';
  if (state.recoveries >= 6) return 'Six recovery requests on the same unfinished task, including rewrites and verification retries.';
  return '';
}

export function recoveryFailure(queue: TaskQueue, task: Task, lane: string): string {
  const state = recoveryState(queue, task);
  state.failures[lane] = (state.failures[lane] ?? 0) + 1;
  saveRecovery(queue, task, state);
  return state.failures[lane] >= 3 ? `Three unsuccessful ${lane} decisions; retrying the supervisor unchanged is not recovery.` : '';
}

export function recoverySucceeded(queue: TaskQueue, task: Task, lane: string): void {
  const state = recoveryState(queue, task);
  delete state.failures[lane];
  saveRecovery(queue, task, state);
}

export function blockRecovery(queue: TaskQueue, task: Task, reason: string): void {
  const state = recoveryState(queue, task);
  state.blocked = reason;
  state.blockedContract = contract(task);
  saveRecovery(queue, task, state);
}

export function recoveryContext(queue: TaskQueue, task: Task): string {
  const state = recoveryEvidence(queue, task);
  return `DURABLE RECOVERY LEDGER: ${JSON.stringify({ recoveries: state.recoveries,
    unchangedRecoveries: state.unchanged, repeatedToolOutcomes: state.repeats, reviewFailures: state.failures })}\n` +
    'Heartbeats, rereads, rewritten prose and resetting attempts are not progress. Identify the next bounded outcome, ' +
    'what new observation would change the diagnosis, and how to verify that outcome. If independent outcomes remain, ' +
    'request decomposition, not another project-wide rewrite. Preserve completed changes. Never infer completion from this ledger.';
}
