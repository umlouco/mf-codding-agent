import { QueueWrites } from './dbWrites';
import { admitDecompositionFamily, decompositionFamily, persistedFailureFamily } from './dbFailureLineage';
import { NewTask, Task, TaskEditFields, TaskEditPlan, TaskEditReceipt, taskEditSummary } from './dbModel';

export class QueuePlans extends QueueWrites {
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
  splitTask(id: number, parts: NewTask[], hasFinalAcceptance = false): number {
    return this.tx(() => {
      const task = this.get(id);
      if (!task || task.status === 'VERIFIED' || parts.length < 2) {
        return 0;
      }
      if (parts.some(p => !p || !p.title?.trim() || !p.description?.trim() ||
          (!p.solutionVerifyPrompt?.trim() && !p.solutionVerifyCommand?.trim()))) {
        throw new Error('Every split part needs a title, a complete description, and its own behavior check. No parts were changed.');
      }
      // All split entry points share the same lineage and atomic recursion bound.
      // A normal scope/progress split of a failure child cannot start a new family.
      const family = persistedFailureFamily(task) ||
        (task.activityPhase.startsWith('decomposition_') || task.status === 'FAILED' ? decompositionFamily(task) : undefined);
      if (family && !admitDecompositionFamily(this, task)) {
        throw Object.assign(new Error('Repeated decomposition has produced no new verified family outcome. ' +
          'The original task is retained; wait for new verified progress instead of multiplying unfinished tasks.'),
        { invalidDecomposition: true });
      }
      const replacements = family ? parts.map(part => ({ ...part,
        region: JSON.stringify({ ...JSON.parse(part.region || '{}'), failureFamily: family }) })) : parts;
      // Preserve the complete acceptance contract and journal before removing
      // the parent. Splitting is recovery, never a way to erase failed evidence.
      this.db.prepare(`INSERT INTO task_events (task_id, actor, kind, message, at)
        VALUES (NULL, 'supervisor', 'split-archive', ?, ?)`).run(
        JSON.stringify({ task, events: this.events(id, -1) }), Date.now());
      const shift = parts.length - 1;
      this.db
        .prepare('UPDATE tasks SET seq = seq + ?, updated_at = ? WHERE seq > ?')
        .run(shift, Date.now(), task.seq);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

      replacements.forEach((p, i) => {
        const newId = this.insert(
          { ...p, status: 'PENDING', kind: 'task', seq: task.seq + i, maxAttempts: p.maxAttempts ?? task.maxAttempts },
          task.seq + i,
        );
        if (hasFinalAcceptance && i < parts.length - 1) {
          this.db.prepare('UPDATE tasks SET split_scope = ? WHERE id = ?').run(
            `QUEUE-ASSIGNED SPLIT STEP ${i + 1} OF ${parts.length - 1}\n` +
            `Parent: ${task.title}. A separate final acceptance task retains the full parent requirements.\n` +
            `Complete and verify ONLY this step's assigned scope. Requirements assigned to sibling steps or final acceptance are not missing work in this step. Do not expand this step into the whole project or replace its focused check with full-site validation.\n` +
            `Assigned contract: ${JSON.stringify({title:p.title,description:p.description,
              implVerifyPrompt:p.implVerifyPrompt,solutionVerifyPrompt:p.solutionVerifyPrompt,
              solutionVerifyCommand:p.solutionVerifyCommand})}\nEND SPLIT STEP SCOPE`, newId);
        }
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

}
