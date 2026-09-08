import * as fs from 'fs';
import * as path from 'path';
import { openDriver } from './dbDriver';
import { QueuePlans } from './dbPlans';
import { COLUMNS, Task } from './dbModel';
export * from './dbModel';

/** Shared durable queue; implementation is grouped by storage responsibility. */
export class TaskQueue extends QueuePlans {
  /** Opens (creating if needed) the queue database for a workspace. */
  static open(file: string): TaskQueue {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { db, impl } = openDriver(file);
    const q = new TaskQueue(db, impl, file);
    try {
      q.migrate();
      return q;
    } catch (error) {
      q.close();
      throw error;
    }
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
             AND activity_phase NOT GLOB 'decomposition_*'
             AND NOT EXISTS (SELECT 1 FROM tasks WHERE status = 'EXECUTING')
           ORDER BY seq ASC, id ASC LIMIT 1`,
        )
        .get() as Task | undefined;
      if (!row) {
        return undefined;
      }
      const now = Math.max(Date.now(), (row.startedAt ?? 0) + 1);
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
      // Return the committed claim, including its new start identity and cleared
      // validation report. The pre-update row belongs to the previous attempt.
      return this.get(row.id);
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

  /** Legacy compatibility; failed attempts are represented as decomposition work. */
  anyFailed(): boolean { return false; }

  /** Unresolved failures and required decompositions never count as complete. */
  isComplete(): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks
      WHERE status IN ('PENDING','EXECUTING','VERIFYING','FAILED')
        OR activity_phase GLOB 'decomposition_*'`).get();
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

  /** Compatibility hook for callers from older builds; never requeues a failed parent. */
  reviveFailed(): number {
    const result = this.db.prepare(`UPDATE tasks SET status = 'VERIFYING',
      activity_phase = 'decomposition_required', finished_at = NULL WHERE status = 'FAILED'`).run();
    return result.changes;
  }

  /** Resets runnable work; required decomposition retains its complete identity/evidence. */
  resetAll(): void {
    this.tx(() => {
      this.db.exec(`
        UPDATE tasks SET status = 'PENDING', attempts = 0, output = '', validation_report = '',
          error_log = '', supervisor_feedback = '', started_at = NULL,
          finished_at = NULL, last_activity_at = NULL, activity_phase = '',
          activity_detail = '', tokens_in = 0, tokens_out = 0,
          tokens_cache_read = 0, tokens_cache_write = 0,
          updated_at = ${Date.now()}
        WHERE activity_phase NOT GLOB 'decomposition_*'
      `);
      this.db.exec(`DELETE FROM agent_logs WHERE task_id IS NULL OR task_id NOT IN
        (SELECT id FROM tasks WHERE activity_phase GLOB 'decomposition_*')`);
      this.setMeta('runState', 'IDLE');
      this.log(null, 'system', 'reset', 'runnable tasks returned to PENDING; required decomposition retained');
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
           WHERE seq >= ? AND activity_phase NOT GLOB 'decomposition_*'`,
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
