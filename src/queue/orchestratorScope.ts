import type { Task } from './db';
import { OrchestratorJournal } from './orchestratorJournal';
import { replacementTasks, ScopeAssessment, ScopeRole } from './scopePlan';
import { ScopeSupervisor } from './scopeSupervisor';

export abstract class OrchestratorScope extends OrchestratorJournal {
  protected scopeWatch(task: Task, role: ScopeRole, current: () => boolean,
    activity: (phase: string, detail: string, at: number) => void): ScopeSupervisor {
    return new ScopeSupervisor({ context: this.context, output: this.output, queue: this.queue,
      task, role, current, intervalMs: this.reviewIntervalMs, preflightActivity: activity,
      split: (assessment, snapshot) => this.applyScopeSplit(assessment, snapshot, current) });
  }

  protected applyScopeSplit(assessment: ScopeAssessment, snapshot: Task, current: () => boolean): boolean {
    const task = this.queue.get(snapshot.id);
    if (!current() || this.disposed || this.queue.runState !== 'RUNNING' || !task ||
      task.status !== snapshot.status || task.startedAt !== snapshot.startedAt || task.attempts !== snapshot.attempts ||
      (['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand'] as const)
        .some(key => task[key] !== snapshot[key])) return false;

    // Archive before the transaction deletes the original row and its journal. A failed
    // split may leave an unused archive, never lose the only handoff or original contract.
    const archiveKey = `scopeSplit:${task.id}:${task.startedAt ?? task.createdAt}`;
    this.queue.setMeta(archiveKey, JSON.stringify({ task, assessment,
      events: this.queue.events(task.id, -1), archivedAt: Date.now() }));
    const parts = replacementTasks(assessment, task, archiveKey);
    const count = this.queue.splitTask(task.id, parts);
    if (!count) return false;

    // Persist replacement rows first, then fence callbacks and cancel affected workers.
    // No rollback, git reset, or deletion of workspace changes is part of a scope split.
    const active = this.queue.activeTask();
    if (task.status === 'EXECUTING' || (active && active.seq > task.seq)) this.abandonExecution();
    this.abandonReview();
    this.reviewed.delete(task.id);
    this.queue.log(null, 'supervisor', 'scope-split', `${archiveKey}: ${assessment.reason}; ${count} ordered tasks`);
    this.log(`task ${task.seq} split into ${count} dependency-ordered tasks; existing changes preserved`);
    this.changed();
    this.wakeAfterHandoff();
    return true;
  }
}
