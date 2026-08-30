import * as fs from 'fs';
import * as path from 'path';

/**
 * The task queue is the single source of truth for autonomous runs.
 *
 * Nothing is passed between agents in memory: the Supervisor and every
 * Execution worker read and write this file, so a worker can be killed mid-run
 * and the next one picks up exactly where the database says it should. Status
 * transitions are the whole protocol.
 *
 *   PENDING ──claim──▶ EXECUTING ──worker done──▶ VERIFYING
 *      ▲                   │                          │
 *      │                   └── died with a message ───┤
 *      │                   │                          │
 *      ├── went silent ◀───┘                          │
 *      │                                              │
 *      ├── supervisor resets ◀── FAILED ◀── checks fail
 *      └── VERIFIED ◀── checks pass
 *
 * PAUSED is a user-driven halt that survives a window reload.
 *
 * Nothing leaves EXECUTING because it took too long. A worker is judged by what
 * it writes: it records what it is doing as it goes, and only the absence of
 * those records — never their content, and never the clock — marks it as gone.
 * See recordActivity and silentWorkers.
 */

// ---- driver ------------------------------------------------------------

interface RunInfo {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface Stmt {
  run(...params: unknown[]): RunInfo;
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

interface Driver {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}

/**
 * Loads better-sqlite3 when it is present, otherwise falls back to Node's
 * built-in `node:sqlite`.
 *
 * better-sqlite3 is a native addon and has to match the Electron ABI of the
 * running VS Code, which breaks on host upgrades; `node:sqlite` ships with the
 * runtime and needs no build step. Both expose the same prepare/run/get/all
 * shape, so the rest of this file does not care which one it got. Every query
 * below uses positional `?` parameters, which are the only binding style both
 * drivers agree on.
 */
function openDriver(file: string): { db: Driver; impl: string } {
  // Both are marked external in esbuild.mjs, so these stay real runtime
  // requires in the bundle and either one is allowed to be absent.
  try {
    const BetterSqlite3 = require('better-sqlite3');
    return { db: new BetterSqlite3(file) as Driver, impl: 'better-sqlite3' };
  } catch {
    /* not installed, or built against a different ABI — fall through */
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    return { db: new DatabaseSync(file) as Driver, impl: 'node:sqlite' };
  } catch (e: any) {
    // Name the host: this is the failure a remote extension host hits, where
    // the server's Node is not the Electron runtime the same VS Code uses
    // locally, and `node:sqlite` needs Node 22.13 or newer.
    const host =
      `Node ${process.versions.node}` +
      (process.versions.electron ? `, Electron ${process.versions.electron}` : '');
    throw new Error(
      `No SQLite driver available on this host (${host}). better-sqlite3 is not ` +
        'bundled with the extension, and node:sqlite requires Node 22.13 or newer. ' +
        `(${e?.message ?? e})`,
    );
  }
}

// ---- model -------------------------------------------------------------

export const TASK_STATUSES = [
  'PENDING',
  'EXECUTING',
  'VERIFYING',
  'VERIFIED',
  'FAILED',
  'PAUSED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

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

const COLUMNS = `
  id, title, description,
  impl_verify_prompt      AS implVerifyPrompt,
  solution_verify_prompt  AS solutionVerifyPrompt,
  solution_verify_command AS solutionVerifyCommand,
  status, seq, output,
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

// ---- store -------------------------------------------------------------

export class TaskQueue {
  private readonly db: Driver;
  readonly impl: string;
  readonly path: string;

  private constructor(db: Driver, impl: string, file: string) {
    this.db = db;
    this.impl = impl;
    this.path = file;
  }

  /** Opens (creating if needed) the queue database for a workspace. */
  static open(file: string): TaskQueue {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { db, impl } = openDriver(file);
    const q = new TaskQueue(db, impl, file);
    q.migrate();
    return q;
  }

  private migrate(): void {
    // WAL lets the supervisor read while a worker writes; NORMAL sync is the
    // right trade for a queue we can always rebuild.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS tasks (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        title                   TEXT    NOT NULL,
        description             TEXT    NOT NULL DEFAULT '',
        impl_verify_prompt      TEXT    NOT NULL DEFAULT '',
        solution_verify_prompt  TEXT    NOT NULL DEFAULT '',
        solution_verify_command TEXT    NOT NULL DEFAULT '',
        status                  TEXT    NOT NULL DEFAULT 'PENDING',
        seq                     INTEGER NOT NULL,
        output                  TEXT    NOT NULL DEFAULT '',
        error_log               TEXT    NOT NULL DEFAULT '',
        supervisor_feedback     TEXT    NOT NULL DEFAULT '',
        attempts                INTEGER NOT NULL DEFAULT 0,
        max_attempts            INTEGER NOT NULL DEFAULT 3,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        started_at              INTEGER,
        finished_at             INTEGER,
        CHECK (status IN ('PENDING','EXECUTING','VERIFYING','VERIFIED','FAILED','PAUSED'))
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_seq ON tasks(status, seq);
      CREATE INDEX IF NOT EXISTS idx_tasks_seq        ON tasks(seq);

      -- Append-only audit trail. The supervisor reads this to understand how a
      -- task got into its current state, not just what that state is.
      CREATE TABLE IF NOT EXISTS task_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        actor   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);

      CREATE TABLE IF NOT EXISTS queue_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Liveness lives on the task rather than in a separate table: it is read on
    // every cron tick and written constantly, so it wants to be one cheap
    // UPDATE next to the status it qualifies.
    this.addColumn('last_activity_at', 'INTEGER');
    this.addColumn('activity_phase', "TEXT NOT NULL DEFAULT ''");
    this.addColumn('activity_detail', "TEXT NOT NULL DEFAULT ''");

    // Token spend accumulates per task across every agent run it causes —
    // each execution attempt and each supervisor pass. Kept here rather than
    // derived from the event log because a retry must add to the bill, not
    // replace it: what a task cost is the sum of everything it took.
    for (const c of ['tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write']) {
      this.addColumn(c, 'INTEGER NOT NULL DEFAULT 0');
    }

    // See TaskKind — a phase row shares this table and this state machine
    // rather than living in one of its own.
    this.addColumn('kind', "TEXT NOT NULL DEFAULT 'task'");
    this.addColumn('region', "TEXT NOT NULL DEFAULT ''");
  }

  /** Adds a column to `tasks` if this database predates it. */
  private addColumn(name: string, decl: string): void {
    const has = (this.db.prepare('PRAGMA table_info(tasks)').all() as any[]).some(
      (c) => c.name === name,
    );
    if (!has) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${decl}`);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** Runs `fn` inside a transaction, rolling back if it throws. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw e;
    }
  }

  // ---- meta ------------------------------------------------------------

  getMeta(key: string, fallback = ''): string {
    const row = this.db.prepare('SELECT value FROM queue_meta WHERE key = ?').get(key);
    return row?.value ?? fallback;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO queue_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /**
   * The supervisor's wake-up interval for *this* queue, in seconds. Zero means
   * the queue has no opinion and the global setting applies.
   *
   * It lives in `queue_meta` rather than `settings.json` because it belongs to
   * the plan: a queue of long migrations wants a slower cron than one of small
   * edits, and the choice has to survive a window reload along with the run it
   * was made for. `replaceAll` clears tasks and events but not meta, so
   * regenerating a plan keeps the pace you picked for it.
   */
  get cronIntervalSeconds(): number {
    const n = Number(this.getMeta('cronIntervalSeconds', '0'));
    return Number.isFinite(n) && n > 0 ? Math.max(10, Math.floor(n)) : 0;
  }

  /** Pass 0 (or less) to hand this queue back to the global setting. */
  setCronIntervalSeconds(seconds: number): void {
    const n =
      Number.isFinite(seconds) && seconds > 0 ? Math.max(10, Math.floor(seconds)) : 0;
    this.setMeta('cronIntervalSeconds', String(n));
    this.log(null, 'user', 'cron-interval', n > 0 ? `${n}s` : 'inherit setting');
  }

  get runState(): RunState {
    return this.getMeta('runState', 'IDLE') as RunState;
  }

  setRunState(state: RunState): void {
    this.setMeta('runState', state);
    this.log(null, 'system', 'run-state', state);
  }

  // ---- reads -----------------------------------------------------------

  list(): Task[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM tasks ORDER BY seq ASC, id ASC`).all();
  }

  get(id: number): Task | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id);
  }

  stats(): QueueStats {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
      .all();
    const byStatus = Object.fromEntries(
      TASK_STATUSES.map((s) => [s, 0]),
    ) as Record<TaskStatus, number>;
    let total = 0;
    for (const r of rows) {
      byStatus[r.status as TaskStatus] = r.n;
      total += r.n;
    }

    const u = this.db
      .prepare(
        `SELECT COALESCE(SUM(tokens_in), 0)          AS input,
                COALESCE(SUM(tokens_out), 0)         AS output,
                COALESCE(SUM(tokens_cache_read), 0)  AS cacheRead,
                COALESCE(SUM(tokens_cache_write), 0) AS cacheWrite
           FROM tasks`,
      )
      .get();

    return { total, byStatus, runState: this.runState, usage: u as Usage };
  }

  /**
   * Adds one agent run's token usage to a task's running total.
   *
   * Every run counts, including the ones that produced nothing: a worker that
   * was cut off or died still spent the tokens, and hiding that would make the
   * expensive failures look free.
   */
  addUsage(taskId: number, usage: Partial<Usage> | undefined): void {
    if (!usage) {
      return;
    }
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = usage;
    if (!(input || output || cacheRead || cacheWrite)) {
      return;
    }
    this.db
      .prepare(
        `UPDATE tasks SET
           tokens_in          = tokens_in + ?,
           tokens_out         = tokens_out + ?,
           tokens_cache_read  = tokens_cache_read + ?,
           tokens_cache_write = tokens_cache_write + ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(input, output, cacheRead, cacheWrite, Date.now(), taskId);
  }

  events(taskId: number | null, limit = 100): TaskEvent[] {
    const sql =
      taskId === null
        ? `SELECT id, task_id AS taskId, actor, kind, message, at
             FROM task_events ORDER BY id DESC LIMIT ?`
        : `SELECT id, task_id AS taskId, actor, kind, message, at
             FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    return taskId === null ? stmt.all(limit) : stmt.all(taskId, limit);
  }

  log(taskId: number | null, actor: string, kind: string, message = ''): void {
    this.db
      .prepare(
        'INSERT INTO task_events (task_id, actor, kind, message, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, actor, kind, message.slice(0, 8000), Date.now());
  }

  /**
   * Appends one timestamped line of worker activity and refreshes the task's
   * liveness in the same transaction.
   *
   * Both halves matter and they answer different questions. The event row is
   * the transcript — what the worker was doing, in order, kept after the
   * process is gone. The column is the index into it: the single timestamp the
   * cron tick reads to decide whether anyone is still home.
   *
   * Returns true when this record changed the phase, which is the caller's cue
   * to refresh the view. A heartbeat that repeats the current phase is worth
   * storing but not worth redrawing for — the panel rebuilds every row, and
   * doing that twice a minute would fight anyone editing a task.
   *
   * `actor` is on the event row rather than assumed, because a supervisor's
   * review is a turn against the same model on the same task and goes just as
   * silent when its core wedges — the transcript has to say which of the two
   * stopped writing.
   */
  recordActivity(taskId: number, phase: string, detail: string, actor = 'executor'): boolean {
    const now = Date.now();
    return this.tx(() => {
      const before = this.db
        .prepare('SELECT activity_phase AS phase FROM tasks WHERE id = ?')
        .get(taskId);
      this.db
        .prepare(
          'INSERT INTO task_events (task_id, actor, kind, message, at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(taskId, actor, `activity:${phase}`, detail.slice(0, 8000), now);
      this.db
        .prepare(
          `UPDATE tasks SET last_activity_at = ?, activity_phase = ?, activity_detail = ?
             WHERE id = ?`,
        )
        .run(now, phase, detail.slice(0, 500), taskId);
      return (before?.phase ?? '') !== phase;
    });
  }

  /**
   * Tasks that are supposedly EXECUTING but have not written for `silentMs`.
   *
   * This is the only "the worker is gone" test in the system, and it is a
   * statement about evidence rather than about elapsed time: a live worker
   * writes while it waits on the model and while a long build runs, so silence
   * here means the process died, not that the work is slow. A task claimed but
   * still silent — no activity at all yet — is measured from when it started.
   */
  silentWorkers(silentMs: number): Task[] {
    const cutoff = Date.now() - silentMs;
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM tasks
         WHERE status = 'EXECUTING'
           AND COALESCE(last_activity_at, started_at, 0) < ?
         ORDER BY seq ASC`,
      )
      .all(cutoff);
  }

  // ---- writes ----------------------------------------------------------

  /**
   * Replaces the queue with a freshly generated task list. Used by the
   * generation UI, which produces a whole plan at once rather than appending.
   */
  replaceAll(tasks: NewTask[]): number {
    return this.tx(() => {
      this.db.exec('DELETE FROM tasks');
      this.db.exec('DELETE FROM task_events');
      let n = 0;
      for (const t of tasks) {
        this.insert(t, ++n);
      }
      this.setMeta('runState', 'IDLE');
      this.log(null, 'system', 'queue-generated', `${n} task(s)`);
      return n;
    });
  }

  addAll(tasks: NewTask[]): number {
    return this.tx(() => {
      let seq = this.maxSeq();
      let n = 0;
      for (const t of tasks) {
        this.insert(t, t.seq ?? ++seq);
        n++;
      }
      return n;
    });
  }

  private maxSeq(): number {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM tasks').get().m as number;
  }

  private insert(t: NewTask, seq: number): number {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO tasks (
           title, description, impl_verify_prompt, solution_verify_prompt,
           solution_verify_command, status, seq, max_attempts, created_at, updated_at,
           kind, region
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.title,
        t.description ?? '',
        t.implVerifyPrompt ?? '',
        t.solutionVerifyPrompt ?? '',
        t.solutionVerifyCommand ?? '',
        t.status ?? 'PENDING',
        t.seq ?? seq,
        t.maxAttempts ?? 3,
        now,
        now,
        t.kind ?? 'task',
        t.region ?? '',
      );
    return Number(info.lastInsertRowid);
  }

  private static readonly COLUMN_MAP: Record<string, string> = {
    title: 'title',
    description: 'description',
    implVerifyPrompt: 'impl_verify_prompt',
    solutionVerifyPrompt: 'solution_verify_prompt',
    solutionVerifyCommand: 'solution_verify_command',
    status: 'status',
    seq: 'seq',
    output: 'output',
    errorLog: 'error_log',
    supervisorFeedback: 'supervisor_feedback',
    attempts: 'attempts',
    maxAttempts: 'max_attempts',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    kind: 'kind',
    region: 'region',
  };

  /** Builds a `col = ?` list and its bound values for a partial task patch. */
  private buildSet(
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
  ): { sets: string[]; args: unknown[] } {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = TaskQueue.COLUMN_MAP[k];
      if (col && v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(v);
      }
    }
    return { sets, args };
  }

  update(id: number, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): void {
    const { sets, args } = this.buildSet(patch);
    if (sets.length === 0) {
      return;
    }
    sets.push('updated_at = ?');
    args.push(Date.now(), id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /**
   * Writes back an execution result, but only if this is still the attempt
   * that produced it.
   *
   * `claimNext` hands out `attempts` as a fencing token along with the task —
   * the two travel together through the whole life of one worker run. A
   * worker the orchestrator has since given up on (the queue was stopped, the
   * task was reclaimed by a fresh attempt after being reset) is writing into a
   * row that either is no longer EXECUTING or has moved on to a later
   * attempt, and this update matches neither, so it silently does nothing
   * instead of overwriting whatever is true now. No in-memory bookkeeping is
   * needed to tell a live result from a stale one — the row itself is the
   * only witness that has to agree.
   *
   * Returns whether the write actually landed.
   */
  finishExecution(
    id: number,
    attempt: number,
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
  ): boolean {
    const { sets, args } = this.buildSet(patch);
    if (sets.length === 0) {
      return false;
    }
    sets.push('updated_at = ?');
    args.push(Date.now());
    const info = this.db
      .prepare(
        `UPDATE tasks SET ${sets.join(', ')}
           WHERE id = ? AND attempts = ? AND status = 'EXECUTING'`,
      )
      .run(...args, id, attempt);
    return info.changes > 0;
  }

  /**
   * Deletes a task and closes the gap it leaves.
   *
   * Renumbering matters more than it looks: `seq` is what the supervisor names
   * in a RESET_FROM, and what the panel shows as the task's identity. Leaving
   * holes in it would make "roll back to task 4" mean something different
   * before and after a deletion.
   */
  remove(id: number): void {
    this.tx(() => {
      const task = this.get(id);
      if (!task) {
        return;
      }
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      this.db
        .prepare('UPDATE tasks SET seq = seq - 1, updated_at = ? WHERE seq > ?')
        .run(Date.now(), task.seq);
    });
  }

  /**
   * Replaces one task with the smaller tasks it should have been.
   *
   * Everything after it shifts down to make room, so the queue keeps a dense
   * ordering and a later `resetFrom(seq)` still means what it says. The original
   * row is deleted rather than kept as a parent: the queue is a flat list, and a
   * container task left behind would sit there unverifiable forever.
   *
   * Returns the number of tasks inserted.
   */
  splitTask(id: number, parts: NewTask[]): number {
    return this.tx(() => {
      const task = this.get(id);
      if (!task || parts.length < 2) {
        return 0;
      }
      const shift = parts.length - 1;
      this.db
        .prepare('UPDATE tasks SET seq = seq + ?, updated_at = ? WHERE seq > ?')
        .run(shift, Date.now(), task.seq);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

      parts.forEach((p, i) => {
        const newId = this.insert(
          { ...p, seq: task.seq + i, maxAttempts: p.maxAttempts ?? task.maxAttempts },
          task.seq + i,
        );
        // What the original cost was really spent, so it moves to the first
        // part rather than disappearing with the row. Attributing all of it to
        // one part is imprecise, but the queue total stays honest, and that is
        // the number anyone is actually reading.
        if (i === 0) {
          this.addUsage(newId, {
            input: task.tokensIn,
            output: task.tokensOut,
            cacheRead: task.tokensCacheRead,
            cacheWrite: task.tokensCacheWrite,
          });
        }
        this.log(newId, 'supervisor', 'split-from', `task ${task.seq}: ${task.title}`);
      });
      this.log(
        null,
        'supervisor',
        'split',
        `task ${task.seq} (${task.title}) replaced by ${parts.length} tasks`,
      );
      return parts.length;
    });
  }

  /**
   * Replaces a phase with the tasks (or, occasionally, smaller sub-phases) it
   * expanded into.
   *
   * This is `splitTask`'s twin for the planning side rather than the
   * execution side: a phase expanding into exactly one task is a normal,
   * unremarkable outcome — not the "nothing usable came back" case
   * `splitTask`'s `>= 2` guard exists to catch — so `parts.length >= 1` is
   * enough here.
   *
   * `attempt` is the same fencing token `finishExecution` checks: an
   * expansion worker the orchestrator has since given up on — the queue was
   * stopped, this phase was reclaimed by a fresh attempt — is writing into a
   * row that no longer matches, so the write is silently dropped rather than
   * corrupting whatever is true now.
   *
   * Returns the number of rows inserted, or 0 if the write did not land.
   */
  expandTask(id: number, attempt: number, parts: NewTask[]): number {
    return this.tx(() => {
      const task = this.get(id);
      if (!task || task.status !== 'EXECUTING' || task.attempts !== attempt || parts.length < 1) {
        return 0;
      }
      const shift = parts.length - 1;
      if (shift > 0) {
        this.db
          .prepare('UPDATE tasks SET seq = seq + ?, updated_at = ? WHERE seq > ?')
          .run(shift, Date.now(), task.seq);
      }
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

      parts.forEach((p, i) => {
        const newId = this.insert(
          { ...p, seq: task.seq + i, maxAttempts: p.maxAttempts ?? task.maxAttempts },
          task.seq + i,
        );
        if (i === 0) {
          this.addUsage(newId, {
            input: task.tokensIn,
            output: task.tokensOut,
            cacheRead: task.tokensCacheRead,
            cacheWrite: task.tokensCacheWrite,
          });
        }
        this.log(newId, 'planner', 'expanded-from', `phase ${task.seq}: ${task.title}`);
      });
      this.log(
        null,
        'planner',
        'expanded',
        `phase ${task.seq} (${task.title}) expanded into ${parts.length} row(s)`,
      );
      return parts.length;
    });
  }

  /** Renumbers `seq` to 1..n in the given id order. Used by drag-to-reorder. */
  reorder(idsInOrder: number[]): void {
    this.tx(() => {
      const stmt = this.db.prepare('UPDATE tasks SET seq = ?, updated_at = ? WHERE id = ?');
      const now = Date.now();
      idsInOrder.forEach((id, i) => stmt.run(i + 1, now, id));
    });
  }

  // ---- state machine ---------------------------------------------------

  /**
   * Atomically claims the lowest-seq PENDING task and marks it EXECUTING.
   *
   * "At most one worker at a time" is enforced right here with the `NOT
   * EXISTS`, not by a flag the orchestrator keeps in memory. `BEGIN
   * IMMEDIATE` (see `tx`) takes the write lock before either statement runs,
   * so two callers racing on the same queue — two ticks in one process, or
   * two windows open on the same workspace — cannot both see no task
   * EXECUTING and both proceed to claim one: whichever transaction commits
   * first is the one the other's `NOT EXISTS` sees.
   */
  claimNext(): Task | undefined {
    return this.tx(() => {
      const row = this.db
        .prepare(
          `SELECT ${COLUMNS} FROM tasks WHERE status = 'PENDING'
             AND NOT EXISTS (SELECT 1 FROM tasks WHERE status = 'EXECUTING')
           ORDER BY seq ASC, id ASC LIMIT 1`,
        )
        .get() as Task | undefined;
      if (!row) {
        return undefined;
      }
      const now = Date.now();
      // Liveness starts at the claim, not at the first thing the worker says:
      // spawning a core and loading a local model can take a while, and that
      // gap must not read as a worker that never showed up.
      this.db
        .prepare(
          `UPDATE tasks SET status = 'EXECUTING', attempts = attempts + 1,
             started_at = ?, updated_at = ?, last_activity_at = ?,
             activity_phase = 'claimed', activity_detail = ''
           WHERE id = ?`,
        )
        .run(now, now, now, row.id);
      this.log(row.id, 'executor', 'claimed', `attempt ${row.attempts + 1}`);
      return {
        ...row,
        status: 'EXECUTING' as TaskStatus,
        attempts: row.attempts + 1,
        lastActivityAt: now,
        activityPhase: 'claimed',
      };
    });
  }

  /** Tasks the supervisor should inspect this cycle. */
  awaitingVerification(): Task[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM tasks WHERE status = 'VERIFYING' ORDER BY seq ASC`)
      .all();
  }

  /**
   * The task a worker is currently on, if any — read fresh from the row
   * `claimNext` wrote, not from anything the orchestrator remembers about its
   * own pump. This is what the status panel and the watchdog ask instead of
   * keeping a parallel "am I executing" flag that can drift from what the
   * database actually says happened.
   */
  activeTask(): Task | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM tasks WHERE status = 'EXECUTING' ORDER BY seq ASC LIMIT 1`)
      .get();
  }

  /** True when at least one task is in FAILED state, blocking the queue. */
  anyFailed(): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'FAILED'")
      .get();
    return (row.n as number) > 0;
  }

  /**
   * True when the run is genuinely over: every task VERIFIED, or the only ones
   * left are PAUSED because someone asked for that.
   *
   * FAILED is counted as open on purpose. Nothing produces it any more, but a
   * database written by an older build can still contain it, and treating it as
   * finished is how a queue reports success with work outstanding.
   */
  isComplete(): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE status IN ('PENDING','EXECUTING','VERIFYING','FAILED')`,
      )
      .get();
    return (row.n as number) === 0;
  }

  /**
   * Recovers tasks orphaned by a crashed worker or a window reload. Anything
   * still EXECUTING at startup has no live process behind it.
   */
  requeueStale(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    // `<=` rather than `<`: with olderThanMs of 0 the caller means "everything
    // currently EXECUTING", and a task claimed in the same millisecond as the
    // sweep would slip through a strict comparison.
    const stale: Task[] = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM tasks
         WHERE status = 'EXECUTING' AND COALESCE(started_at, 0) <= ?`,
      )
      .all(cutoff);
    for (const t of stale) {
      // Unconditionally requeued. A window that reloaded says nothing about
      // whether the task can be done, so counting it against the task and
      // retiring it on the attempt count would strand work for a reason that
      // has nothing to do with the work.
      this.update(t.id, {
        status: 'PENDING',
        errorLog: `${t.errorLog}\n[recovered] worker did not report back; task was left EXECUTING.`.trim(),
      });
      this.log(t.id, 'system', 'recovered', 'requeued');
    }
    return stale.length;
  }

  /**
   * Returns tasks retired by an earlier version, or by a run that still had a
   * failure state, to the queue.
   *
   * FAILED is no longer reachable: a task that cannot pass is a task whose
   * instructions the supervisor has not fixed yet, and the run continues until
   * every task is VERIFIED. Rows left in that state by an older build would
   * otherwise sit there while `isComplete` counted them as finished business.
   */
  reviveFailed(): number {
    const failed: Task[] = this.db
      .prepare(`SELECT ${COLUMNS} FROM tasks WHERE status = 'FAILED'`)
      .all();
    for (const t of failed) {
      this.update(t.id, { status: 'PENDING', finishedAt: null });
      this.log(t.id, 'system', 'revived', 'returned to the queue; tasks are no longer retired');
    }
    return failed.length;
  }

  /** Clears all progress and returns every task to the start of the pipeline. */
  resetAll(): void {
    this.tx(() => {
      this.db.exec(`
        UPDATE tasks SET status = 'PENDING', attempts = 0, output = '',
          error_log = '', supervisor_feedback = '', started_at = NULL,
          finished_at = NULL, last_activity_at = NULL, activity_phase = '',
          activity_detail = '', tokens_in = 0, tokens_out = 0,
          tokens_cache_read = 0, tokens_cache_write = 0,
          updated_at = ${Date.now()}
      `);
      this.setMeta('runState', 'IDLE');
      this.log(null, 'system', 'reset', 'all tasks returned to PENDING');
    });
  }

  /** Resets this task and every task after it — the supervisor's rollback. */
  resetFrom(seq: number, feedback: string): number {
    return this.tx(() => {
      const info = this.db
        .prepare(
          `UPDATE tasks SET status = 'PENDING', attempts = 0, output = '',
             started_at = NULL, finished_at = NULL,
             supervisor_feedback = ?, updated_at = ?
           WHERE seq >= ?`,
        )
        .run(feedback, Date.now(), seq);
      this.log(null, 'supervisor', 'reset-from', `seq >= ${seq}: ${feedback}`);
      return info.changes;
    });
  }

  /** Pauses every task that has not finished, so a resume is a clean restart. */
  pauseOpen(): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'PAUSED', updated_at = ?
         WHERE status IN ('PENDING','EXECUTING')`,
      )
      .run(Date.now());
    this.setRunState('PAUSED');
  }

  resumePaused(): void {
    this.db
      .prepare(`UPDATE tasks SET status = 'PENDING', updated_at = ? WHERE status = 'PAUSED'`)
      .run(Date.now());
    this.setRunState('RUNNING');
  }
}
