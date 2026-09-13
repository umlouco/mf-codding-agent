import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { SupervisorDecision } from './agents';
import { NewTask, QueueStats, Task, TaskQueue } from './db';
import { LiveLog } from './liveLog';
import { ProgressDecision } from './monitor';

/**
 * The cron engine.
 *
 * Two independent pumps share the database and never talk to each other:
 *
 *   execution pump   claims one PENDING task, runs a throwaway worker on it,
 *                    writes the result back, and stops. Spawning the next
 *                    worker is a fresh process with a fresh context window.
 *
 *   supervision pump fires on the cron interval and does two different jobs,
 *                    told apart by whether a row has a validation report yet.
 *                    With none, nothing has been verified: it reviews the work
 *                    from the journal and picks a control action — carry on,
 *                    rewrite the task, rewrite the checks, or start an
 *                    independent verification agent on it. With one, there is a
 *                    finding to rule on, and it returns a verdict.
 *
 * Neither pump holds state between ticks — if the window reloads mid-run, the
 * database still knows exactly what was happening, and `requeueStale` recovers
 * whatever was orphaned. The one exception is `reviewed`, which decides only how
 * often to spend money looking, never what happens to a task.
 */

export type RunMode = 'lockstep' | 'continuous';

export interface OrchestratorStatus {
  running: boolean;
  executing: boolean;
  supervising: boolean;
  currentTaskId: number | null;
  nextTickAt: number | null;
  intervalMs: number;
  /** True when the interval above is this queue's own, not the global setting. */
  intervalOwn: boolean;
  /** What the global setting says, so the UI can label the inherit option. */
  settingIntervalSeconds: number;
  mode: RunMode;
}

/** A supervision turn in flight, and everything needed to give up on it. */
export interface Review {
  scope?: { close(): void };
  taskId: number;
  seq: number;
  /** Bumped for every review; a superseded one's verdict is discarded. */
  gen: number;
  /** Last time this review's core said anything — its liveness, as above. */
  lastActivityAt: number;
  /** When this review began; unlike lastActivityAt, never overwritten — see DECOMPOSITION_TOTAL_CEILING_MS. */
  startedAt?: number;
  /** Replacement planning: transport heartbeats do not count as model output. */
  lastModelOutputAt?: number;
  /** Worker evidence available when this review's prompt was assembled. */
  evidenceEventId?: number;
  /** Set only by a validator when its shell tool exceeds the tool's own bound. */
  validationToolViolation?: string;
  /** Kills the core process, which rejects the request wedged on it. */
  abort?: () => void;
}

/** How often the watchdog asks whether the run is actually moving. */
export const WATCHDOG_MS = 60_000;

/**
 * Attempts kept in a task's error log.
 *
 * `maxAttempts` bounds how long one formulation of a task is retried, but a
 * task escalated repeatedly still accumulates history without limit, and the
 * row is written back on every attempt. Older than this and the entries are
 * ones nobody will read, sitting in front of the one the next executor needs.
 */
const KEEP_ATTEMPTS = 6;

/**
 * Appends one attempt's note, keeping only the recent ones.
 *
 * Entries are delimited by the `[attempt N]` prefix every writer uses, so this
 * splits on the same boundary `attemptHistory` reads back.
 */
/** Trims a value to `max` chars once stringified, for a log line that stays scannable. */
export function briefJson(value: unknown, max: number): string {
  if (value === undefined) {
    return '';
  }
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * One line describing a finished executor tool call. It is retained as a
 * durable diagnostic trail, unlike liveness pings, which carry no content.
 */
export function formatToolEvent(
  name: string,
  input: unknown,
  status: string,
  output: unknown,
  elapsedMs: unknown,
): string {
  const args = briefJson(input, 300);
  const result = briefJson(output, 1500);
  const timing = typeof elapsedMs === 'number' ? ` in ${elapsedMs}ms` : '';
  // The human-readable excerpt stays small, but novelty must include changed
  // content beyond that excerpt. Timing is deliberately not part of identity.
  const fingerprint = createHash('sha256').update(JSON.stringify([name, input, status || 'ok', output])).digest('hex');
  return `${name}(${args}) → ${status || 'ok'}${timing}\n[outcome:${fingerprint}]${result ? `\n${result}` : ''}`;
}

export function appendAttempt(log: string, entry: string): string {
  const all = `${log}\n${entry}`
    .split(/\n(?=\[(?:attempt \d+|recovered)\])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return all.slice(-KEEP_ATTEMPTS).join('\n');
}
export abstract class OrchestratorState {

  protected timer: NodeJS.Timeout | undefined;

  protected watchdog: NodeJS.Timeout | undefined;

  /** Rollbacks taken this run — see the RESET_FROM branch. */
  protected rollbacks = 0;

  protected supervising = false;

  protected review: Review | null = null;

  protected reviewGen = 0;

  /**
   * The last time each task's live work was reviewed, and how far the journal
   * had got when it was — see shouldReview.
   *
   * In memory rather than in the row on purpose: it decides how often to spend
   * money looking, and losing it on a reload costs one extra review, not
   * correctness. Everything that decides what actually *happens* to a task
   * still comes off the row.
   */
  protected readonly reviewed = new Map<number, { attempt: number; at: number; eventId: number }>();

  /**
   * Kills the execution worker currently in flight, if any.
   *
   * This is the one thing about a running worker that genuinely cannot live
   * in the database: an OS process handle. Everything else — whether a
   * worker is running, which task, whether its last write-back still counts —
   * is decided by reading the `tasks` row itself (see claimNext, activeTask,
   * finishExecution in db.ts), not by anything kept here.
   */
  protected executionAbort: (() => void) | null = null;
  protected executionScope?: { close(): void };

  protected executionSteer: ((text: string) => Promise<boolean>) | null = null;

  protected executionGen = 0;

  /** Which supervision cycle owns `supervising`; see tick and sweepSilentReview. */
  protected cycle = 0;

  protected nextTickAt: number | null = null;

  protected disposed = false;

  protected readonly _onDidChange = new vscode.EventEmitter<void>();

  /** Fires whenever the queue or run state moves, so the UI can re-render. */
  readonly onDidChange = this._onDidChange.event;

  constructor(
    protected readonly context: vscode.ExtensionContext,
    protected readonly output: vscode.OutputChannel,
    protected readonly queue: TaskQueue,
  ) {}
  protected abstract cfg<T>(key: string, fallback: T): T;
  abstract get settingIntervalSeconds(): number;
  abstract get intervalMs(): number;
  abstract setCronInterval(seconds: number): void;
  abstract get mode(): RunMode;
  protected abstract get workspaceRoot(): string;
  abstract status(): OrchestratorStatus;
  protected abstract changed(): void;
  protected abstract log(msg: string): void;
  abstract recoverOrphaned(): number;
  abstract start(): void;
  abstract stop(): void;
  abstract pause(): void;
  abstract reset(): void;
  abstract reschedule(): void;
  protected abstract arm(): void;
  protected abstract disarm(): void;
  protected abstract tick(): Promise<void>;
  protected abstract get silentMs(): number;
  protected abstract sweepSilentReview(): void;
  protected abstract abandonReview(): void;
  protected abstract abandonExecution(): void;
  protected abstract sweepSilentWorkers(): void;
  protected abstract get reviewIntervalMs(): number;
  protected abstract shouldReview(task: Task, latestEventId: number): boolean;
  protected abstract correctTestingTarget(task: Task): boolean;
  protected abstract repairTests(task: Task, reason: string): Promise<void>;
  /**
   * A task the queue cannot complete is replaced by the configured planner: the
   * supervisor requests its complete replacement, which is committed atomically
   * and retires the original row — see orchestratorDecomposition.
   */
  protected abstract requestFailureDecomposition(task: Task, reason: string): void;
  /**
   * Terminal exit for a run-wide condition no replacement can fix: the row is
   * marked BLOCKED and the run continues with the remaining list.
   */
  protected abstract blockForHuman(task: Task, reason: string): void;
  protected abstract serviceFailureDecomposition(task: Task): Promise<boolean>;
  protected abstract reviewWork(task: Task): Promise<void>;
  protected abstract pauseForRecovery(task: Task, reason: string): void;
  protected abstract serviceRecovery(task: Task): Promise<boolean>;
  protected abstract applyProgressDecision(
    snapshot: Task,
    decision: ProgressDecision,
    review: Review,
  ): Promise<void>;
  protected abstract stopForDecision(task: Task, patch: Partial<Task>): boolean;
  protected abstract observerEvents(taskId: number, actor: string, live: LiveLog, accepts?: () => boolean): (method: string, params: any) => void;
  protected abstract streamJournal(taskId: number, actor: 'executor' | 'validator', accepts?: () => boolean): { flush: () => void; onEvent: (method: string, params: any) => void; live: LiveLog };
  protected abstract verifyWithExecutor(task: Task, review: Review): Promise<void>;
  protected abstract startIndependentVerification(task: Task): Promise<void>;
  protected abstract currentHostVerification(task: Task): boolean;
  protected abstract wakeAfterHandoff(): void;
  protected abstract supervise(task: Task): Promise<void>;
  protected abstract rewrites(task: Task): number;
  protected abstract applyTaskEdits(decision: SupervisorDecision, currentSeq?: number): void;
  protected abstract pump(): Promise<void>;
  protected abstract runExpansion(task: Task, attempt: number, gen: number, current: () => boolean): Promise<void>;
  protected abstract resplitPhaseRegion(
    phase: Task,
    narrowToPath: string | undefined,
    title: string,
    description: string,
  ): Promise<NewTask[]>;
  protected abstract regionFileCount(relPath: string, ceiling: number): Promise<number>;
  abstract runNow(): Promise<void>;
  protected abstract finish(): void;
  protected abstract notify(event: string, stats: QueueStats): void;
  protected abstract kick(): void;
  abstract dispose(): void;
}
