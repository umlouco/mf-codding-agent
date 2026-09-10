import * as vscode from 'vscode';
import type { Task, TaskQueue } from './db';
import { VerificationPlanError } from './verificationPlan';

/** Counts request/response exchanges, never tokens, transport chunks or time. */
export class VerificationBudget {
  readonly limit: number;
  private localUsed = 0;

  constructor(configured: number, private readonly queue?: TaskQueue, private readonly task?: Task) {
    this.limit = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 4;
  }

  get used(): number {
    return this.queue && this.task ? this.queue.countEvents(this.task.id, 'verification-interaction') : this.localUsed;
  }

  get exhausted(): boolean { return this.used >= this.limit; }
  get reason(): string {
    return `Verification LLM interaction budget exhausted (${this.used}/${this.limit}). ` +
      'Preserve recorded checks and completed implementation; split only the remaining verification work into smaller tasks.';
  }

  consume(stage: string): void {
    if (this.exhausted) throw new VerificationPlanError(this.reason, 'interaction_budget');
    if (this.queue && this.task) {
      if (this.queue.reserveVerificationInteraction(this.task.id, this.limit, stage) === undefined) {
        throw new VerificationPlanError(this.exhausted ? this.reason : 'Verification was superseded before model dispatch.',
          this.exhausted ? 'interaction_budget' : 'cancelled');
      }
    } else this.localUsed++;
  }
}

export function verificationBudget(queue?: TaskQueue, task?: Task): VerificationBudget {
  return new VerificationBudget(vscode.workspace.getConfiguration('mfagent')
    .get<number>('queue.verificationMaxInteractions', 4), queue, task);
}
