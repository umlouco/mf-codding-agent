import type { Driver } from './dbDriver';
import { COLUMNS, Task } from './dbModel';
import { installDecompositionInvariant } from './dbRecovery';

export class QueueStorage {
  protected readonly db: Driver;
  readonly impl: string;
  readonly path: string;

  protected constructor(db: Driver, impl: string, file: string) {
    this.db = db;
    this.impl = impl;
    this.path = file;
  }

  protected migrate(): void {
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
    this.addColumn('split_scope', "TEXT NOT NULL DEFAULT ''");

    // A database written before this build may still carry `no_report_streak`.
    // Nothing reads it: a worker that dies without reporting now goes to the
    // supervisor on the first occurrence, so there is no streak to count. The
    // column is left where it is rather than dropped — it is NOT NULL with a
    // default, so an INSERT that ignores it is valid, and rewriting the table
    // to remove one dead integer is not worth the risk to a live queue.

    // Where the independent verification agent's findings land — see the
    // Task.validationReport doc comment.
    this.addColumn('validation_report', "TEXT NOT NULL DEFAULT ''");
    installDecompositionInvariant(this.db);
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
  protected tx<T>(fn: () => T): T {
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

  list(): Task[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM tasks ORDER BY seq ASC, id ASC`).all();
  }

  get(id: number): Task | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id);
  }

  log(taskId: number | null, actor: string, kind: string, message = ''): void {
    this.db
      .prepare(
        'INSERT INTO task_events (task_id, actor, kind, message, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, actor, kind, message.slice(0, 8000), Date.now());
  }

}
