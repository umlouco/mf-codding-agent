import * as vscode from 'vscode';
import { editTasks, planGoal } from './agents';
import { TaskQueue, taskEditSummary } from './db';
import { LiveLog } from './liveLog';

export interface PlanningHost {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  queue?: TaskQueue;
  problem?: string;
  generating: boolean;
  setGenerating(value: boolean): void;
  render(): void;
}

export async function generatePlan(host: PlanningHost, goal: string, append: boolean): Promise<void> {
  const queue = host.queue;
  if (!queue) {
    void vscode.window.showWarningMessage(
      `The task queue is unavailable: ${host.problem ?? 'not open'}`,
    );
    return;
  }
  if (!goal?.trim()) {
    void vscode.window.showInformationMessage('Describe what you want built first.');
    return;
  }
  if (host.generating) {
    return;
  }
  host.setGenerating(true);
  host.render();

  // Planning has no task yet, so its stream is the queue's own — the
  // Planner terminal on the Plan tab.
  const live = new LiveLog(queue, null, 'planner');
  live.note('plan', `planning: ${goal.trim()}`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Scanning the workspace and scoping a plan…' },
      async (progress) => {
        const phases = await planGoal(
          host.context,
          host.output,
          queue,
          goal,
          (method, params) => {
            live.onEvent(method, params);
            if (method === 'stream/tool' && params?.status === 'running') {
              progress.report({ message: params.name });
            }
          },
        );
        const n = append ? queue.addAll(phases) : queue.replaceAll(phases);
        live.note('plan', `${n} phase(s) written to the queue`);
        void vscode.window.showInformationMessage(
          `Generated ${n} phase(s). Press Start to expand and run them.`,
        );
      },
    );
  } catch (e: any) {
    live.note('error', `planning failed: ${e?.message ?? e}`);
    void vscode.window.showErrorMessage(`Could not generate a plan: ${e?.message ?? e}`);
  } finally {
    live.close();
    host.setGenerating(false);
    host.render();
  }
}

/**
 * Edits, adds to, or removes from the existing task list from a free-text
 * instruction — as opposed to `generate`, which only ever produces a brand
 * new list. The supervisor proposes changes against a captured task snapshot;
 * the database resolves those references to stable IDs and commits the whole
 * revision together. Only the committed receipt is reported as completed work.
 */
export async function applyTaskEditPrompt(host: PlanningHost, instruction: string): Promise<void> {
  const queue = host.queue;
  if (!queue) {
    void vscode.window.showWarningMessage(
      `The task queue is unavailable: ${host.problem ?? 'not open'}`,
    );
    return;
  }
  if (!instruction.trim()) {
    void vscode.window.showInformationMessage('Describe the change to make first.');
    return;
  }
  if (host.generating) {
    return;
  }
  host.setGenerating(true);
  host.render();

  const live = new LiveLog(queue, null, 'supervisor');
  live.note('plan', `editing the task list: ${instruction.trim()}`);
  try {
    const snapshot = queue.list();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Editing the task list…' },
      () => editTasks(host.context, host.output, snapshot, instruction, { onEvent: live.onEvent }),
    );

    const receipt = queue.applyTaskEdits(snapshot, result);
    const summary = taskEditSummary(receipt);
    live.note('plan', summary);
    void vscode.window.showInformationMessage(summary);
  } catch (e: any) {
    live.note('error', `edit failed: ${e?.message ?? e}`);
    void vscode.window.showErrorMessage(`Could not edit tasks: ${e?.message ?? e}`);
  } finally {
    live.close();
    host.setGenerating(false);
    host.render();
  }
}
