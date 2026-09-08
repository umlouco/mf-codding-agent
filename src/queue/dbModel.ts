export const TASK_STATUSES = [
  'PENDING',
  'EXECUTING',
  'VERIFYING',
  'VERIFIED',
  'PAUSED',
] as const;

// FAILED is accepted only as legacy input; storage converts it to required decomposition.
export type TaskStatus = (typeof TASK_STATUSES)[number] | 'FAILED';

/**
 * A `task` row is real, executable work. A `phase` row is a coarse slice of
 * the plan awaiting expansion into `task` rows by the queue orchestrator — see
 * `expandTask` and the orchestrator's `runExpansion`. Both share every other
 * column and the same PENDING → EXECUTING state machine, which is what lets
 * the existing claim/cron/watchdog/requeueStale machinery cover phase
 * expansion crash-safety without any changes of its own.
 */
export type TaskKind = 'task' | 'phase';

export interface Task {
  /** Durable scope of a split implementation step; only the queue creates it. */
  splitScope?: string;
  id: number;
  title: string;
  description: string;
  /** 'task' unless this row is a phase awaiting expansion — see TaskKind. */
  kind: TaskKind;
  /**
   * Phase rows only: JSON `{ paths: string[], fileCount: number }` naming the
   * deterministically-sized slice of the workspace the expansion agent must
   * stay within. Empty for ordinary tasks.
   */
  region: string;
  /** How the Supervisor should check the code and files actually exist as described. */
  implVerifyPrompt: string;
  /** How the Supervisor should judge that the solution behaves correctly. */
  solutionVerifyPrompt: string;
  /** Shell command whose exit code decides the functional check. */
  solutionVerifyCommand: string;
  status: TaskStatus;
  /** 1-based execution order. Gaps are allowed; the queue always sorts by this. */
  seq: number;
  /** Whatever the Execution agent reported back on its last run. */
  output: string;
  /**
   * Structured evidence from the independent verification agent the supervisor
   * started on this task — never from the agent that did the work.
   *
   * Empty is meaningful, and it is the difference between the two things the
   * supervisor can be asked to do: an empty report means nothing has been
   * verified yet, so the task gets a progress review; a filled one means there
   * is a finding to rule on. See the orchestrator's tick.
   */
  validationReport: string;
  errorLog: string;
  supervisorFeedback: string;
  attempts: number;
  maxAttempts: number;
  /**
   * When the worker on this task last wrote anything at all.
   *
   * This is what replaces a timeout. A worker waiting on a slow model keeps
   * writing, so a stale timestamp means the process is gone — not that the work
   * is taking too long, which is never by itself a reason to stop it.
   */
  lastActivityAt: number | null;
  /** What it was doing when it last wrote: see the core's activity phases. */
  activityPhase: string;
  activityDetail: string;
  /** Tokens this task has cost so far, summed over every attempt and review. */
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Fields accepted when creating a task; everything else is defaulted. */
export type NewTask = Pick<Task, 'title' | 'description'> &
  Partial<
    Pick<
      Task,
      | 'implVerifyPrompt'
      | 'solutionVerifyPrompt'
      | 'solutionVerifyCommand'
      | 'seq'
      | 'maxAttempts'
      | 'status'
      | 'kind'
      | 'region'
    >
  >;

export type TaskEditFields = Pick<Task,
  'title' | 'description' | 'implVerifyPrompt' | 'solutionVerifyPrompt' | 'solutionVerifyCommand'>;

/** A planner proposal refers to positions in the snapshot it was given. */
export interface TaskEditPlan {
  edits: ({ seq: number } & Partial<TaskEditFields>)[];
  deletes: number[];
  adds: NewTask[];
}

/** Counts come from the committed transaction, never from a model's summary. */
export interface TaskEditReceipt {
  edited: number;
  deleted: number;
  added: number;
  remaining: number;
}

export function taskEditSummary(receipt: TaskEditReceipt): string {
  if (receipt.edited + receipt.deleted + receipt.added === 0) {
    return `No tasks changed. ${receipt.remaining} tasks remain.`;
  }
  return `Saved queue changes: removed ${receipt.deleted}, updated ${receipt.edited}, ` +
    `added ${receipt.added}. ${receipt.remaining} tasks remain.`;
}

export type RunState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED';

/** Token counts as the core reports them. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface QueueStats {
  total: number;
  byStatus: Record<TaskStatus, number>;
  runState: RunState;
  /** What the whole queue has cost so far. */
  usage: Usage;
}

export interface TaskEvent {
  id: number;
  taskId: number | null;
  actor: string;
  kind: string;
  message: string;
  at: number;
}

/** One piece of an agent's live output — see the agent_logs table. */
export interface LogRow {
  id: number;
  taskId: number | null;
  actor: string;
  kind: string;
  chunk: string;
  at: number;
}

export const COLUMNS = `
  id, title, description,
  impl_verify_prompt      AS implVerifyPrompt,
  solution_verify_prompt  AS solutionVerifyPrompt,
  solution_verify_command AS solutionVerifyCommand,
  split_scope AS splitScope,
  status, seq, output,
  validation_report AS validationReport,
  error_log           AS errorLog,
  supervisor_feedback AS supervisorFeedback,
  attempts, max_attempts AS maxAttempts,
  last_activity_at AS lastActivityAt,
  activity_phase   AS activityPhase,
  activity_detail  AS activityDetail,
  tokens_in          AS tokensIn,
  tokens_out         AS tokensOut,
  tokens_cache_read  AS tokensCacheRead,
  tokens_cache_write AS tokensCacheWrite,
  created_at  AS createdAt,
  updated_at  AS updatedAt,
  started_at  AS startedAt,
  finished_at AS finishedAt,
  kind, region
`;
