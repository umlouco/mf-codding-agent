import { createHash } from 'crypto';
import type { Task, TaskQueue } from './db';
import { recoveryEvents } from './recoveryJournal';
import { readRecoveryJob, recoveryJobKey, scheduleRecoveryJob } from './recoverySchedule';

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
  remedy?: { recoveries: number; revision: number; cursor: number; repeats: number };
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const recoveryKey = (task: Task) => `recovery:v1:${task.id}:${task.createdAt}`;

/**
 * A transport/provider outage is not evidence about the task — it says nothing
 * about whether the work is right, and it resolves itself once the provider
 * answers again. Matches the Go core's dial-failure wrapper ("cannot reach
 * <url>: <net error>", see core/internal/llm/openai.go), the OS/DNS failure
 * text it wraps (Windows and POSIX spellings), and a provider-side quota or
 * rate-limit refusal. Callers that would otherwise count a failed attempt as
 * grounds to retry-with-judgment, spend a decomposition attempt, or replace a
 * task must check this first and back off instead — see supervise() and
 * verifyWithExecutor() in orchestratorVerification.ts, and
 * serviceFailureDecomposition() in orchestratorDecomposition.ts.
 */
export function providerUnavailable(message: string): boolean {
  return /^cannot reach |dial tcp|lookup [\w.-]+:|no such host|connectex:|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|network is unreachable|fetch failed|socket hang up|spend limit|rate.?limit|\btoo many requests\b|\b429\b|\b529\b|\boverloaded\b|payment required|insufficient (?:credit|credits|funds|quota|balance)|requires more credits|\b402\b/i
    .test(message);
}

/**
 * A role bound to no usable provider (or one that cannot serve it) is an
 * environment fault, not a transient outage and not evidence about the task.
 * Retrying it just repeats the same error, and treating it as a failed
 * verification earns a decomposition — which is how one misconfigured run
 * rewrote the same task forever. Callers must stop the run and say what to
 * configure instead.
 */
export function providerConfigurationError(message: string): boolean {
  return /no supported provider is configured for the .* role|select a provider for this role|http 401\b|unauthori[sz]ed|invalid api key|no cookie auth credentials/i
    .test(message);
}
const contract = (task: Task) => digest(JSON.stringify([task.description,
  task.solutionVerifyPrompt]));
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
  // Changes to prose, process restarts and Start do not erase failed strategies.
  return state;
}

export function saveRecovery(queue: TaskQueue, task: Task, state: RecoveryState): void {
  queue.setMeta(recoveryKey(task), JSON.stringify(state));
}

/** Migrate a legacy automatic pause into scheduled work, without renewing its budget. */
export function resumeRecovery(queue: TaskQueue, task: Task): boolean {
  const state = recoveryState(queue, task);
  if (!state.blocked || task.status === 'VERIFIED' || readRecoveryJob(queue, task)) return false;
  const archiveKey = `${recoveryKey(task)}:resume:${queue.countEvents(task.id, 'recovery-resumed') + 1}`;
  queue.setMeta(archiveKey, JSON.stringify(state));
  scheduleRecoveryJob(queue, task, state.blocked);
  queue.log(task.id, 'system', 'recovery-resumed', JSON.stringify({ archiveKey, jobKey: recoveryJobKey(task),
    reason: 'Legacy recovery pause migrated to autonomous scheduled work. Failed strategies and task evidence retained.' }));
  queue.recordActivity(task.id, 'recovery_waiting', 'Autonomous recovery scheduled; existing evidence retained.', 'system');
  return true;
}

/** Only admitting a changed recovery strategy establishes a new observation checkpoint.
 * Cumulative counters and fingerprints remain intact; waiting or restarting never does this.
 */
export function acknowledgeRecovery(queue: TaskQueue, task: Task): void {
  const state = recoveryEvidence(queue, task);
  state.blocked = undefined;
  state.blockedContract = undefined;
  state.remedy = { recoveries: state.recoveries, revision: state.revision, cursor: state.cursor, repeats: state.repeats };
  saveRecovery(queue, task, state);
}

export function recoveryReplayLimit(state: RecoveryState): string {
  const previous = state.remedy;
  const repeats = previous && state.revision <= previous.revision ? state.repeats - previous.repeats : state.repeats;
  if (state.saturated && (!previous || state.cursor - previous.cursor >= 6)) {
    return 'The observation ledger is full; obtain a bounded new recovery strategy without forgetting prior outcomes.';
  }
  return repeats >= 6 ? 'Six repeated completed tool outcomes without a new observation.' : '';
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
  const requests = state.recoveries - (state.remedy?.recoveries ?? 0);
  if (Math.min(state.unchanged, requests) >= 3) return 'Three recovery requests without a new completed tool outcome.';
  if (requests >= 6) return 'Six recovery requests on the same unfinished task, including rewrites and verification retries.';
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
