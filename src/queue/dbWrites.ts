import { QueueJournal } from './dbJournal';
import type { NewTask, Task } from './dbModel';

export class QueueWrites extends QueueJournal {
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

  protected maxSeq(): number {
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
  protected insert(t: NewTask, seq: number): number {
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
    splitScope: 'split_scope',
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
    activityPhase: 'activity_phase',
    activityDetail: 'activity_detail',
    kind: 'kind',
    region: 'region',
  };

  /** Builds a `col = ?` list and its bound values for a partial task patch. */
  protected buildSet(
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
  ): { sets: string[]; args: unknown[] } {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = QueueWrites.COLUMN_MAP[k];
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

}
