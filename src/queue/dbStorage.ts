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
        CHECK (status IN ('PENDING','EXECUTING','VERIFYING','VERIFIED','FAILED','PAUSED','BLOCKED'))
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_seq ON tasks(status, seq);
      CREATE INDEX IF NOT EXISTS idx_tasks_seq        ON tasks(seq);

      -- Append-only audit trail. The supervisor reads this to understand how a
      -- task got into its current state, not just what that state is. No FK
      -- to tasks(id): task_id names the task an event happened to, including
      -- one since replaced or deleted, on purpose — a row's whole iteration
      -- history is exactly the record a real "append-only" trail keeps.
      CREATE TABLE IF NOT EXISTS task_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
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
    this.allowBlockedStatus();
    this.dropTaskEventsCascade();
    installDecompositionInvariant(this.db);
  }

  /**
   * A database written before BLOCKED existed carries a CHECK constraint that
   * rejects it, so the terminal block would throw at the one moment it must
   * commit. SQLite cannot widen a CHECK in place, so the table is rebuilt once
   * with the same columns and a constraint that allows BLOCKED; existing rows
   * are copied across unchanged. No-op on a database that already allows it.
   *
   * Foreign keys are disabled for the rebuild and re-enabled after, so
   * agent_logs' cascade reference to tasks(id) survives the drop/rename. The
   * decomposition triggers are dropped with the old table and recreated by
   * installDecompositionInvariant at the end of migrate().
   */
  private allowBlockedStatus(): void {
    const row = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
      .get() as { sql?: string } | undefined;
    if (!row?.sql || row.sql.includes("'BLOCKED'")) {
      return;
    }
    // PRAGMA foreign_keys is a no-op inside a transaction, so it brackets it.
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.tx(() => {
        this.db.exec(`
          CREATE TABLE tasks_rebuild (
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
            last_activity_at        INTEGER,
            activity_phase          TEXT NOT NULL DEFAULT '',
            activity_detail         TEXT NOT NULL DEFAULT '',
            tokens_in               INTEGER NOT NULL DEFAULT 0,
            tokens_out              INTEGER NOT NULL DEFAULT 0,
            tokens_cache_read       INTEGER NOT NULL DEFAULT 0,
            tokens_cache_write      INTEGER NOT NULL DEFAULT 0,
            kind                    TEXT NOT NULL DEFAULT 'task',
            region                  TEXT NOT NULL DEFAULT '',
            split_scope             TEXT NOT NULL DEFAULT '',
            CHECK (status IN ('PENDING','EXECUTING','VERIFYING','VERIFIED','FAILED','PAUSED','BLOCKED'))
          );
          INSERT INTO tasks_rebuild (
            id, title, description, impl_verify_prompt, solution_verify_prompt,
            solution_verify_command, status, seq, output, validation_report, error_log,
            supervisor_feedback, attempts, max_attempts, created_at, updated_at, started_at,
            finished_at, last_activity_at, activity_phase, activity_detail, tokens_in,
            tokens_out, tokens_cache_read, tokens_cache_write, kind, region, split_scope)
          SELECT
            id, title, description, impl_verify_prompt, solution_verify_prompt,
            solution_verify_command, status, seq, output, validation_report, error_log,
            supervisor_feedback, attempts, max_attempts, created_at, updated_at, started_at,
            finished_at, last_activity_at, activity_phase, activity_detail, tokens_in,
            tokens_out, tokens_cache_read, tokens_cache_write, kind, region, split_scope
          FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_rebuild RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_status_seq ON tasks(status, seq);
          CREATE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(seq);
        `);
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
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

  /**
   * A database written before this build still cascade-deletes task_events
   * when its task is replaced or removed, silently erasing exactly the
   * "how did it get into this state" trail the table exists to keep. SQLite
   * cannot drop a foreign key in place, so a still-cascading table is rebuilt
   * without one; every existing row is preserved, tagged with whatever
   * task_id it always had, findable by that id even after the task it names
   * is long gone. A no-op once already rebuilt.
   */
  private dropTaskEventsCascade(): void {
    const row = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_events'`)
      .get() as { sql?: string } | undefined;
    if (!row?.sql || !/ON DELETE CASCADE/.test(row.sql)) {
      return;
    }
    this.tx(() => {
      this.db.exec(`
        CREATE TABLE task_events_norefs (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER,
          actor   TEXT NOT NULL,
          kind    TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          at      INTEGER NOT NULL
        );
        INSERT INTO task_events_norefs (id, task_id, actor, kind, message, at)
          SELECT id, task_id, actor, kind, message, at FROM task_events;
        DROP TABLE task_events;
        ALTER TABLE task_events_norefs RENAME TO task_events;
        CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);
      `);
    });
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
