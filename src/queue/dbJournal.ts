import { QueueMetadata } from './dbMetadata';
import { COLUMNS, TASK_STATUSES, Task, QueueStats, TaskStatus, Usage, TaskEvent, LogRow } from './dbModel';

export class QueueJournal extends QueueMetadata {
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

  /** Worker tool starts/results, excluding supervisor reads and liveness pings. */
  latestWorkerToolEventId(taskId: number): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM task_events
      WHERE task_id = ? AND actor <> 'supervisor' AND kind = 'tool'`).get(taskId);
    return row.id as number;
  }

  events(taskId: number | null, limit = 100, forReview = false): TaskEvent[] {
    // Heartbeats must neither evict tool evidence nor trigger another paid review.
    // Current-attempt executor evidence starts at its latest claim; recovery history
    // remains available in errorLog and supervisor decisions.
    if (forReview && taskId !== null) {
      return this.db.prepare(`SELECT id, task_id AS taskId, actor, kind, message, at
        FROM task_events WHERE task_id = ? AND kind NOT LIKE 'activity:%'
        AND kind NOT IN ('response', 'reasoning')
        AND NOT (kind = 'tool' AND message LIKE '%() → start')
        AND (kind <> 'cognition' OR id = (SELECT MAX(id) FROM task_events
          WHERE task_id = ? AND kind = 'cognition'))
        AND (actor <> 'executor' OR id >= COALESCE(
          (SELECT MAX(id) FROM task_events WHERE task_id = ? AND kind = 'claimed'), 0))
        ORDER BY id DESC LIMIT ?`).all(taskId, taskId, taskId, limit);
    }
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
  countEvents(taskId: number, kind: string, sinceUserRetry = false): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = ?
        AND (? = 0 OR id > COALESCE((SELECT MAX(id) FROM task_events
          WHERE task_id = ? AND actor = 'user' AND kind = 'verification-retry'), 0))`)
      .get(taskId, kind, sinceUserRetry ? 1 : 0, taskId);
    return row.n as number;
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

}
