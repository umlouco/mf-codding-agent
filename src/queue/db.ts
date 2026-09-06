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
 * Opens the database on better-sqlite3, or on Node's built-in `node:sqlite`
 * when no native build for this host exists.
 *
 * better-sqlite3 is a native addon and has to match the Electron ABI of the
 * running VS Code, which its published prebuilds do not always cover: a fresh
 * Electron can ship before a prebuild for it does, and this extension is not
 * going to compile C++ on a user's machine. `node:sqlite` is the same SQLite
 * library, shipped inside the runtime, with no build step. Both expose the
 * same prepare/run/get/all shape and both run WAL, so the rest of this file
 * does not care which one it got. Every query below uses positional `?`
 * parameters, the one binding style both drivers agree on.
 *
 * A build made for this platform can be shipped in the extension's `bin/`
 * folder next to the Go binaries, as `bin/<platform>-<arch>/better_sqlite3.node`;
 * it is preferred over whatever `node_modules` holds, which is what lets a
 * packaged extension carry the native driver without carrying node_modules.
 */
function openDriver(file: string): { db: Driver; impl: string } {
  // Both are marked external in esbuild.mjs, so these stay real runtime
  // requires in the bundle and either one is allowed to be absent.
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const shipped = path.join(
      __dirname,
      '..',
      'bin',
      `${process.platform}-${process.arch}`,
      'better_sqlite3.node',
    );
    const options = fs.existsSync(shipped) ? { nativeBinding: shipped } : undefined;
    return { db: new BetterSqlite3(file, options) as Driver, impl: 'better-sqlite3' };
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

type TaskEditFields = Pick<Task,
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

const COLUMNS = `
  id, title, description,
  impl_verify_prompt      AS implVerifyPrompt,
  solution_verify_prompt  AS solutionVerifyPrompt,
  solution_verify_command AS solutionVerifyCommand,
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
        validation_report       TEXT    NOT NULL DEFAULT '',
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

      -- The live stream. Every agent's text, reasoning and tool calls land
      -- here in pieces small enough to show as they arrive, which is what the
      -- Task Queue view polls every 200 ms (see queue/panel.ts). task_events
      -- above is the durable journal the supervisor reads; this is the
      -- terminal, and it is pruned per task as it grows — see appendLog.
      CREATE TABLE IF NOT EXISTS agent_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        actor   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        chunk   TEXT NOT NULL DEFAULT '',
        at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_logs_task ON agent_logs(task_id, id);
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

    // A database written before this build may still carry `no_report_streak`.
    // Nothing reads it: a worker that dies without reporting now goes to the
    // supervisor on the first occurrence, so there is no streak to count. The
    // column is left where it is rather than dropped — it is NOT NULL with a
    // default, so an INSERT that ignores it is valid, and rewriting the table
    // to remove one dead integer is not worth the risk to a live queue.

    // Where the independent verification agent's findings land — see the
    // Task.validationReport doc comment.
    this.addColumn('validation_report', "TEXT NOT NULL DEFAULT ''");
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

  /**
   * Free-text project conventions and facts, prepended to every executor's
   * prompt — see executeTask in agents.ts.
   *
   * This is the one deliberate exception to task isolation: every task
   * otherwise runs in a fresh process with no memory of any other task (see
   * the doc comment atop agents.ts), so a fact task 1 establishes — where
   * something lives, what stack or test framework to use, how to build —
   * would otherwise never reach task 3 except by task 3 rediscovering it on
   * disk. Starts with whatever is typed into the Plan tab; grows on its own
   * as executors report durable facts worth keeping, via appendInstruction.
   *
   * Lives in queue_meta rather than settings.json because it is project
   * knowledge that accumulates over a run, not a preference — and unlike
   * `tasks`, replaceAll leaves queue_meta alone, so it survives regenerating
   * the plan.
   */
  get instructions(): string {
    return this.getMeta('instructions', '');
  }

  setInstructions(text: string): void {
    this.setMeta('instructions', text.trim());
  }

  /**
   * Appends one more fact, for an executor that learns something every later
   * task should know. A no-op for a blank line, so a task with nothing to add
   * can pass one through unconditionally.
   */
  appendInstruction(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const current = this.instructions;
    this.setInstructions(current ? `${current}\n${trimmed}` : trimmed);
  }

  /** Parses a `queue_meta` value as a JSON string array, tolerating garbage. */
  private metaList(key: string): string[] {
    try {
      const arr = JSON.parse(this.getMeta(key, '[]'));
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }

  /**
   * MCP server names explicitly switched off for this workspace's agent
   * runs — see `discoverMcpServers` in mcp.ts and `buildCoreConfig` in
   * providers/payload.ts, which is where this is actually applied.
   *
   * Opt-out on purpose: absence from this set means enabled, matching the Go
   * core's own `MCPServer.IsEnabled()` default. A server neither this queue
   * nor anyone else has an opinion on should just work, including one
   * discovered for the first time after this queue was created.
   */
  get disabledMcpServers(): string[] {
    return this.metaList('mcpDisabledServers');
  }

  setMcpServerEnabled(names: string[], enabled: boolean): void {
    const set = new Set(this.disabledMcpServers);
    for (const name of names) {
      if (enabled) {
        set.delete(name);
      } else {
        set.add(name);
      }
    }
    this.setMeta('mcpDisabledServers', JSON.stringify([...set]));
    this.log(null, 'user', 'mcp-server', `${names.join(', ')} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Skill group ids switched on for this workspace's agent runs — see
   * `Skill`/`SkillGroup` in providers/store.ts.
   *
   * Opt-in, unlike the MCP list above: a skill group is shared, global
   * content someone wrote for a particular kind of project, and it should not
   * start reaching every prompt in every workspace just because it exists in
   * the library. A newly created group has to be picked here before it does
   * anything.
   */
  get enabledSkillGroups(): string[] {
    return this.metaList('enabledSkillGroups');
  }

  setSkillGroupEnabled(ids: string[], enabled: boolean): void {
    const set = new Set(this.enabledSkillGroups);
    for (const id of ids) {
      if (enabled) {
        set.add(id);
      } else {
        set.delete(id);
      }
    }
    this.setMeta('enabledSkillGroups', JSON.stringify([...set]));
    this.log(null, 'user', 'skill-group', `${ids.join(', ')} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * `vscode.lm.tools` names switched on for this workspace's agent runs —
   * see McpBridge.enabledToolNames in mcpBridge.ts, which is what actually
   * reads this and is the only thing that should: an empty list here means
   * "nothing switched on", while a *missing* one means "never asked", and
   * only that method knows the difference (see `hasEditorToolChoice`).
   */
  get enabledEditorTools(): string[] {
    return this.metaList('enabledEditorTools');
  }

  /**
   * Whether this workspace has ever made a pick of its own.
   *
   * Until it has, the built-in read/search/edit/execute sets are in force —
   * an agent that can do nothing until someone has ticked a hundred boxes is
   * no use, and those four are what "can work on a codebase" means. The first
   * toggle writes the whole resulting list, defaults included, so from then on
   * the stored pick is the entire truth and switching the last tool off means
   * off rather than back to the defaults.
   */
  get hasEditorToolChoice(): boolean {
    return this.getMeta('enabledEditorTools', '') !== '';
  }

  /** Replaces the pick outright — group toggles and per-tool ones alike. */
  setEditorTools(names: string[]): void {
    const set = new Set(names);
    this.setMeta('enabledEditorTools', JSON.stringify([...set]));
    this.log(null, 'user', 'editor-tool', `${set.size} tool(s) enabled`);
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

  /**
   * How many times `kind` was recorded against a task, over its whole life.
   *
   * Counting these off the end of `events` instead only works while the journal
   * is short. It is not: a worker streams its reasoning and every tool call into
   * the same table, so the handful of entries anyone counts — rewrites, say —
   * fall out of any fixed window within one long attempt, and the count quietly
   * reads zero. `idx_events_task` makes asking the database cheaper than the
   * window scan was anyway.
   */
  countEvents(taskId: number, kind: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = ?')
      .get(taskId, kind);
    return row.n as number;
  }

  log(taskId: number | null, actor: string, kind: string, message = ''): void {
    this.db
      .prepare(
        'INSERT INTO task_events (task_id, actor, kind, message, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, actor, kind, message.slice(0, 8000), Date.now());
  }

  // ---- live output -----------------------------------------------------

  /**
   * Appends one piece of an agent's live output and, every so often, trims
   * that stream back to `keep` rows. A `taskId` of null is the queue's own
   * stream — planning from the Plan tab, which has no task yet.
   */
  appendLog(taskId: number | null, actor: string, kind: string, chunk: string, keep: number): number {
    const info = this.db
      .prepare('INSERT INTO agent_logs (task_id, actor, kind, chunk, at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, actor, kind, chunk.slice(0, 8000), Date.now());
    const id = Number(info.lastInsertRowid);
    // Pruning on every insert would cost a scan per chunk; every hundredth
    // keeps the table within sight of `keep`, which is all it needs to be.
    if (id % 100 === 0) {
      this.pruneLogs(taskId, keep);
    }
    return id;
  }

  /** Drops everything but the newest `keep` rows of one stream. */
  pruneLogs(taskId: number | null, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM agent_logs WHERE task_id IS ? AND id <= (
           SELECT id FROM agent_logs WHERE task_id IS ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(taskId, taskId, Math.max(1, Math.floor(keep)));
  }

  /** Rows written after `afterId`, oldest first — what the view polls for. */
  logsSince(afterId: number, limit = 500): LogRow[] {
    return this.db
      .prepare(
        `SELECT id, task_id AS taskId, actor, kind, chunk, at
           FROM agent_logs WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit);
  }

  /** The newest `limit` rows of one stream, oldest first — for a terminal just opened. */
  logsTail(taskId: number | null, limit = 300): LogRow[] {
    const rows: LogRow[] = this.db
      .prepare(
        `SELECT id, task_id AS taskId, actor, kind, chunk, at
           FROM agent_logs WHERE task_id IS ? ORDER BY id DESC LIMIT ?`,
      )
      .all(taskId, limit);
    return rows.reverse();
  }

  latestLogId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM agent_logs').get();
    return Number(row?.m ?? 0);
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
      this.db.exec('DELETE FROM agent_logs');
      let n = 0;
      for (const t of tasks) {
        this.insert(t, ++n);
      }
      this.setMeta('runState', 'IDLE');
      this.log(null, 'system', 'queue-generated', `${n} task(s)`);
      return n;
    });
  }

  /**
   * Appends a plan after everything already queued.
   *
   * A `seq` carried on an incoming task is a *relative* ordering within its
   * own batch — the planner numbers its phases 1..n without knowing, or being
   * able to know, what is already in the queue (see planGoal) — so it says
   * nothing about where those rows belong in this table. Honouring it
   * literally wrote the new plan straight on top of the old one: two lists
   * sharing one seq space, which `claimNext` then interleaves by `ORDER BY
   * seq, id` and, on a tie, resolves *towards the older row*. Appending a
   * second list that way meant the next worker picked up the previous plan's
   * task instead of the new plan's first one.
   *
   * Appending therefore always allocates fresh numbers after `maxSeq()`, in
   * the order the caller supplied — the same contract `WritePlan` applies on
   * the Go side.
   */
  addAll(tasks: NewTask[]): number {
    return this.tx(() => {
      let seq = this.maxSeq();
      let n = 0;
      for (const t of tasks) {
        this.insert(t, ++seq);
        n++;
      }
      return n;
    });
  }

  private maxSeq(): number {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM tasks').get().m as number;
  }

  /**
   * Inserts one row at `seq`, which is the position this table has decided on
   * — never `t.seq`. Every caller works out the absolute position first
   * (`replaceAll` renumbers from 1, `addAll` continues past the end,
   * `splitTask` and `expandTask` place parts at the row they replace), and a
   * `t.seq` left over from whoever built the object is at best a duplicate of
   * that and at worst a number from an unrelated plan.
   */
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
        seq,
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
    validationReport: 'validation_report',
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
   * Applies one proposal to the exact task identities the planner inspected.
   * Validation, writes, ordering and the factual audit commit together. A
   * concurrent reorder is harmless; replacing or rewriting a target is not.
   */
  applyTaskEdits(snapshot: Task[], plan: TaskEditPlan): TaskEditReceipt {
    const fields: (keyof TaskEditFields)[] = [
      'title', 'description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    ];
    const identityFields: (keyof Task)[] = [
      'id', 'createdAt', ...fields, 'status', 'attempts', 'maxAttempts', 'kind', 'region',
    ];
    if (!Array.isArray(plan.edits) || !Array.isArray(plan.deletes) || !Array.isArray(plan.adds)) {
      throw new Error('A task edit proposal must contain edits, deletes and adds arrays.');
    }
    const bySeq = new Map<number, Task>();
    const ambiguous = new Set<number>();
    for (const task of snapshot) {
      if (bySeq.has(task.seq)) ambiguous.add(task.seq);
      bySeq.set(task.seq, task);
    }
    const resolve = (seq: number): Task => {
      if (!Number.isSafeInteger(seq) || seq < 1 || ambiguous.has(seq)) {
        throw new Error(`Task selector #${seq} is invalid or ambiguous in the planner snapshot.`);
      }
      const target = bySeq.get(seq);
      if (!target) throw new Error(`Task #${seq} was not in the planner snapshot.`);
      return target;
    };
    const deletions = [...new Set(plan.deletes)].map(resolve);
    const deleting = new Set(deletions.map(task => task.id));
    const editing = new Set<number>();
    const edits = plan.edits.map(edit => {
      const target = resolve(edit.seq);
      if (editing.has(target.id) || deleting.has(target.id)) {
        throw new Error(`Task #${edit.seq} has duplicate or conflicting edit/delete operations.`);
      }
      editing.add(target.id);
      const patch: Partial<TaskEditFields> = {};
      for (const field of fields) {
        if (edit[field] === undefined) continue;
        if (typeof edit[field] !== 'string') throw new Error(`Task #${edit.seq} has a non-text ${field}.`);
        patch[field] = edit[field];
      }
      return { target, patch };
    });
    for (const task of plan.adds) {
      if (!task || typeof task.title !== 'string' || !task.title.trim()) {
        throw new Error('Every added task must have a nonempty title.');
      }
    }

    return this.tx(() => {
      const targets = [...deletions, ...edits.map(edit => edit.target)];
      for (const target of targets) {
        const current = this.get(target.id);
        if (!current || identityFields.some(field => current[field] !== target[field])) {
          throw new Error(`Task #${target.seq} changed or was replaced while the planner was working. No changes were saved.`);
        }
        if (current.status === 'VERIFIED' || current.status === 'EXECUTING' || current.status === 'VERIFYING') {
          throw new Error(`Task #${target.seq} is ${current.status} and cannot be changed by this planner edit. No changes were saved.`);
        }
      }
      const receipt: TaskEditReceipt = { edited: 0, deleted: 0, added: 0, remaining: 0 };
      for (const { target, patch } of edits) {
        const changed: Partial<TaskEditFields> = {};
        for (const field of fields) {
          if (patch[field] !== undefined && patch[field] !== target[field]) changed[field] = patch[field];
        }
        if (Object.keys(changed).length === 0) continue;
        const { sets, args } = this.buildSet(changed);
        const info = this.db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...args, Date.now(), target.id);
        if (info.changes !== 1) throw new Error(`Task #${target.seq} could not be updated.`);
        receipt.edited += info.changes;
        this.log(target.id, 'user', 'task-edited', JSON.stringify({ source: 'planner-proposal', changes: changed }));
      }
      for (const target of deletions) {
        const info = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(target.id);
        if (info.changes !== 1) throw new Error(`Task #${target.seq} could not be deleted.`);
        receipt.deleted += info.changes;
        // Deleted-task foreign keys cascade. A queue-level receipt retains the
        // original identity and title after the task itself is gone.
        this.log(null, 'user', 'task-deleted', JSON.stringify({
          source: 'planner-proposal', id: target.id, seq: target.seq, title: target.title,
        }));
      }
      if (deletions.length) {
        const reorder = this.db.prepare('UPDATE tasks SET seq = ?, updated_at = ? WHERE id = ?');
        const now = Date.now();
        this.list().forEach((task, index) => reorder.run(index + 1, now, task.id));
      }
      let seq = this.maxSeq();
      for (const task of plan.adds) {
        const id = this.insert(task, ++seq);
        receipt.added++;
        this.log(id, 'user', 'task-added', JSON.stringify({ source: 'planner-proposal', seq, title: task.title }));
      }
      receipt.remaining = this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n as number;
      this.log(null, 'user', 'tasks-edited-by-prompt', taskEditSummary(receipt));
      return receipt;
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
             activity_phase = 'claimed', activity_detail = '', validation_report = ''
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
   *
   * `escalate` says what an orphan means. A crash during a deliberate stop or
   * pause says nothing about the work — the extension killed the process — so
   * that caller passes `false` and the task simply goes back to PENDING. A
   * crash nobody asked for is different: it is the one thing the supervisor
   * cannot see, because there is no report to read, so the task goes to
   * VERIFYING instead — the same route it takes when it genuinely finishes —
   * and the supervisor decides what to do from the journal.
   *
   * This is deliberately not counted. Requiring a task to die twice before
   * anyone looks at it is an attempt limit wearing a different hat, and the one
   * thing it reliably buys is a second identical crash.
   *
   * A phase (see TaskKind) is never escalated: it carries no report to judge
   * and no verification contract to rewrite, so it just goes back in the queue.
   */
  requeueStale(olderThanMs: number, escalate = false): number {
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
      const note = `${t.errorLog}\n[recovered] worker did not report back; task was left EXECUTING.`.trim();
      // Attempts still count against the task the same as any other requeue —
      // see `attempts` on Task — so this only changes where it lands, not
      // whether it is retried at all.
      if (escalate && t.kind === 'task') {
        this.update(t.id, {
          status: 'VERIFYING',
          finishedAt: null,
          // Nothing verified anything: the worker died before it could. An
          // empty report is what routes this to a progress review rather than
          // to a verdict — see the orchestrator's tick.
          validationReport: '',
          errorLog:
            `${note} No report was produced, so there is nothing to judge — the supervisor ` +
            'must decide the next action from the journal.',
        });
        this.log(t.id, 'system', 'escalated', 'worker died without reporting; sent to supervisor');
      } else {
        this.update(t.id, { status: 'PENDING', errorLog: note });
        this.log(t.id, 'system', 'recovered', 'requeued');
      }
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
        UPDATE tasks SET status = 'PENDING', attempts = 0, output = '', validation_report = '',
          error_log = '', supervisor_feedback = '', started_at = NULL,
          finished_at = NULL, last_activity_at = NULL, activity_phase = '',
          activity_detail = '', tokens_in = 0, tokens_out = 0,
          tokens_cache_read = 0, tokens_cache_write = 0,
          updated_at = ${Date.now()}
      `);
      this.db.exec('DELETE FROM agent_logs');
      this.setMeta('runState', 'IDLE');
      this.log(null, 'system', 'reset', 'all tasks returned to PENDING');
    });
  }

  /** Resets this task and every task after it — the supervisor's rollback. */
  resetFrom(seq: number, feedback: string): number {
    return this.tx(() => {
      const info = this.db
        .prepare(
          `UPDATE tasks SET status = 'PENDING', attempts = 0, output = '', validation_report = '',
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
