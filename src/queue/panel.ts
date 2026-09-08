import * as vscode from 'vscode';
import { scheduleRestart } from '../coreRestart';
import { getBridge } from '../mcpBridge';
import { getStore } from '../providers/instance';
import { TASK_STATUSES, TaskQueue } from './db';
import { Orchestrator } from './orchestrator';
import { notifySkillsChanged, onDidChangeSkills } from './registry';
import { saveTestingEnvironment } from './testingEnvironment';
import { renderQueueHtml } from './panelHtml';
import { PlanningHost, generatePlan, applyTaskEditPrompt } from './panelPlanning';
import { confirmAutonomy, confirmDelete, confirmReset, confirmClear, setMcpKey } from './panelPrompts';
import { queueViewState } from './panelState';

/**
 * The Task Queue sidebar.
 *
 * Two panes behind one view: a generator that turns a goal into a plan, and a
 * control panel over the run itself. Like the chat view it is hand-written
 * HTML/CSS/JS with no framework, and it renders straight from the database so
 * what you see is the actual state the agents are reading.
 *
 * The provider is registered even when the queue could not be opened, and says
 * why. VS Code renders a contributed webview view as an endless spinner until
 * *something* resolves it, so failing to register is indistinguishable from
 * hanging — which is exactly how a missing SQLite driver or an unwritable
 * workspace used to present itself on a remote host.
 *
 * Two feeds reach the webview. A full `state` push whenever the orchestrator
 * says something changed shape — a status, the task list, the run — which
 * rebuilds the view. And, while the view is visible, a 200 ms poll of the
 * `agent_logs` table (see liveLog.ts) that streams each agent's output into
 * the per-task terminals and pulses each live row's activity and token
 * counts in place, so the interface keeps moving for as long as an agent is
 * working, and a reply that takes a minute reads as a minute of text arriving
 * rather than a minute of nothing.
 */
export class QueueViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mfagent.queue';

  /** How often the live table is read while the view is showing. */
  private static readonly STREAM_MS = 200;

  private view?: vscode.WebviewView;
  private generating = false;
  private queue?: TaskQueue;
  private orch?: Orchestrator;
  /** Why the queue is unavailable, when it is. */
  private problem?: string;
  /** The newest agent_logs row the webview has been sent. */
  private lastLogId = 0;
  private streamTimer?: NodeJS.Timeout;
  /** What the last pulse said, so an unchanged one is not sent again. */
  private pulseSig = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    /** Re-runs the open attempt; resolves once `attach` or `fail` has been called. */
    private readonly reopen: () => Promise<void>,
  ) {
    context.subscriptions.push(onDidChangeSkills(() => this.render()));
  }

  /** The queue opened: wire it up and drop any previous failure. */
  attach(queue: TaskQueue, orch: Orchestrator): void {
    this.queue = queue;
    this.orch = orch;
    this.problem = undefined;
    // Start streaming from now: what came before is fetched per terminal as
    // it is opened, not replayed wholesale into a view that just appeared.
    this.lastLogId = queue.latestLogId();
    orch.onDidChange(() => this.render());
    this.render();
    this.syncStreaming();
  }

  /** The queue could not be opened. The view says so instead of spinning. */
  fail(reason: string): void {
    this.queue = undefined;
    this.orch = undefined;
    this.problem = reason;
    this.render();
    this.syncStreaming();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = renderQueueHtml(this.context, view.webview);
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    // A hidden view has nobody reading it; the poll stops with it and picks
    // up where the table is when it shows again.
    view.onDidChangeVisibility(() => this.syncStreaming());
    view.onDidDispose(() => {
      this.view = undefined;
      this.syncStreaming();
    });
    this.syncStreaming();
  }

  // ---- the live stream ---------------------------------------------------

  private syncStreaming(): void {
    const want = !!this.view?.visible && !!this.queue;
    if (want && !this.streamTimer) {
      this.streamTimer = setInterval(() => this.pumpLive(), QueueViewProvider.STREAM_MS);
    } else if (!want && this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }
  }

  /**
   * One poll: new log rows since the last one, and a pulse of what each live
   * task is doing. Both are cheap indexed reads, and both are skipped when
   * there is nothing new, so an idle queue costs a query per tick and nothing
   * on the wire.
   */
  private pumpLive(): void {
    const queue = this.queue;
    if (!queue || !this.view) {
      return;
    }
    try {
      const rows = queue.logsSince(this.lastLogId, 400);
      if (rows.length) {
        this.lastLogId = rows[rows.length - 1].id;
        this.post({ type: 'logs', rows });
      }
      const status = this.orch?.status();
      const tasks = queue
        .list()
        .filter((t) => t.status === 'EXECUTING' || t.status === 'VERIFYING')
        .map((t) => ({
          id: t.id,
          status: t.status,
          activityPhase: t.activityPhase,
          activityDetail: t.activityDetail,
          lastActivityAt: t.lastActivityAt,
          tokensIn: t.tokensIn,
          tokensOut: t.tokensOut,
          tokensCacheRead: t.tokensCacheRead,
        }));
      const sig = JSON.stringify([tasks, status?.executing, status?.supervising, status?.nextTickAt]);
      if (sig !== this.pulseSig) {
        this.pulseSig = sig;
        this.post({ type: 'pulse', tasks, status });
      }
    } catch (e: any) {
      this.output.appendLine(`[queue:ui] live poll failed: ${e?.message ?? e}`);
    }
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${QueueViewProvider.viewType}.focus`);
  }

  /** Entry point for the `Generate Task Queue` command palette action. */
  generateFromCommand(goal: string): Promise<void> {
    return this.generate(goal, false);
  }

  // ---- messages --------------------------------------------------------

  private async onMessage(msg: any): Promise<void> {
    try {
      // Answerable with no queue behind the view.
      switch (msg.type) {
        case 'ready':
          this.render();
          return;
        case 'showLog':
          this.output.show();
          return;
        case 'retry':
          await this.reopen();
          return;
        case 'openFolder':
          await vscode.commands.executeCommand('vscode.openFolder');
          return;
        case 'openSettings':
          // The queue's models live on the MF Agent settings page; its timings
          // are plain scalars and stay in the VS Code settings editor.
          await vscode.commands.executeCommand('mfagent.openSettings');
          return;
      }

      const queue = this.queue;
      const orch = this.orch;
      if (!queue || !orch) {
        this.render();
        return;
      }

      switch (msg.type) {
        case 'setTestingEnvironment': {
          await this.configureTestingEnvironment(msg);
          break;
        }
        case 'generate':
          await this.generate(msg.goal, !!msg.append);
          break;
        case 'editTasks':
          await this.applyTaskEditPrompt(String(msg.instruction ?? ''));
          break;
        case 'setInstructions': {
          const text = String(msg.text ?? '');
          queue.setInstructions(text);
          queue.log(null, 'user', 'instructions-set', text.trim() ? `${text.trim().length} char(s)` : 'cleared');
          this.render();
          break;
        }

        // Both toggles restart the core (debounced) so the change reaches the
        // long-lived Chat session too, not just the next ephemeral queue run —
        // that one rebuilds its config fresh every time regardless.
        //
        // Each carries a list, not a single name: the Context tab's picker
        // switches a whole group — a capability set, an MCP server's tools —
        // from one parent checkbox, and that has to be one write and one
        // restart rather than forty.
        case 'setMcpEnabled':
          queue.setMcpServerEnabled(names(msg.names), !!msg.enabled);
          this.render();
          scheduleRestart('MCP server toggled from the Task Queue', this.output);
          break;
        case 'setSkillGroupEnabled':
          queue.setSkillGroupEnabled(names(msg.ids), !!msg.enabled);
          notifySkillsChanged();
          this.render();
          scheduleRestart('skill group toggled from the Task Queue', this.output);
          break;
        case 'setEditorToolEnabled': {
          // The baseline is what is *in force*, which for a workspace that has
          // never picked is the defaults — so switching one tool off keeps the
          // other three sets on instead of wiping them.
          const next = new Set(getBridge().enabledToolNames());
          for (const name of names(msg.names)) {
            if (msg.enabled) {
              next.add(name);
            } else {
              next.delete(name);
            }
          }
          queue.setEditorTools([...next]);
          this.render();
          scheduleRestart('editor tool toggled from the Task Queue', this.output);
          break;
        }
        case 'resetEditorTools':
          queue.setEditorTools(getBridge().defaultToolNames());
          this.render();
          scheduleRestart('editor tools reset from the Task Queue', this.output);
          break;
        case 'setMcpKey':
          await setMcpKey(this.context, String(msg.name ?? ''));
          this.render();
          break;

        // A terminal being opened asks for what it missed: the newest rows of
        // its own stream, replacing whatever the webview buffered.
        case 'logTail': {
          const taskId = msg.id === null || msg.id === undefined ? null : Number(msg.id);
          this.post({ type: 'logs', rows: queue.logsTail(taskId, 300), reset: true, taskId });
          break;
        }

        case 'start':
          if (await confirmAutonomy(queue)) {
            orch.start();
          }
          break;
        case 'stop':
          orch.stop();
          break;
        case 'pause':
          orch.pause();
          break;
        case 'reset':
          if (await confirmReset()) {
            orch.reset();
          }
          break;
        case 'runNow':
          await orch.runNow();
          break;
        case 'setInterval':
          orch.setCronInterval(Number(msg.seconds));
          break;

        case 'updateTask':
          if (msg.patch?.status !== undefined && !TASK_STATUSES.includes(msg.patch.status)) {
            throw new Error('Unsupported task status.');
          }
          queue.update(Number(msg.id), msg.patch);
          this.render();
          break;
        case 'setStatus': {
          if (!TASK_STATUSES.includes(msg.status)) throw new Error('Unsupported task status.');
          const task = queue.get(Number(msg.id));
          if (task?.activityPhase.startsWith('decomposition_')) {
            void vscode.window.showWarningMessage('This task requires replacement by smaller tasks. Its failure cannot be cleared by changing status.');
            break;
          }
          queue.update(Number(msg.id), { status: msg.status });
          queue.log(Number(msg.id), 'user', 'status-set', msg.status);
          this.render();
          break;
        }
        case 'deleteTask': {
          const task = queue.get(Number(msg.id));
          if (task && msg.confirm && !(await confirmDelete(task))) {
            break;
          }
          queue.remove(Number(msg.id));
          queue.log(null, 'user', 'task-deleted', task ? `${task.seq}: ${task.title}` : '');
          this.render();
          break;
        }
        case 'reorder':
          queue.reorder((msg.ids as unknown[]).map(Number));
          this.render();
          break;
        case 'addTask':
          queue.addAll([{ title: 'New task', description: '' }]);
          this.render();
          break;
        case 'clearQueue':
          if (await confirmClear()) {
            queue.replaceAll([]);
            this.render();
          }
          break;

        case 'generateDocs':
          await vscode.commands.executeCommand('mfagent.generateDocumentation');
          break;

        case 'showEvents':
          this.post({ type: 'events', events: queue.events(Number(msg.id) || null, 60) });
          break;
      }
    } catch (e: any) {
      this.output.appendLine(`[queue:ui] ${e?.message ?? e}`);
      void vscode.window.showErrorMessage(`Task queue: ${e?.message ?? e}`);
      this.render();
    }
  }

  private planningHost(): PlanningHost {
    return { context: this.context, output: this.output, queue: this.queue,
      problem: this.problem, generating: this.generating,
      setGenerating: value => { this.generating = value; }, render: () => this.render() };
  }

  private generate(goal: string, append: boolean): Promise<void> {
    return generatePlan(this.planningHost(), goal, append);
  }

  private applyTaskEditPrompt(instruction: string): Promise<void> {
    return applyTaskEditPrompt(this.planningHost(), instruction);
  }

  // ---- rendering -------------------------------------------------------

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  async configureTestingEnvironment(msg: { url?: unknown; credentials?: unknown; remove?: unknown }): Promise<void> {
    const queue = this.queue, orch = this.orch;
    if (!queue || !orch) throw new Error("Open a task queue workspace first.");
    await saveTestingEnvironment(this.context, queue, msg);
    const prior = queue.runState;
    orch.stop();
    for (const task of queue.list()) {
      if (task.status === 'VERIFYING') queue.update(task.id, {
        validationReport: '', activityPhase: 'requirements_changed',
        supervisorFeedback: 'The owner changed the fixed testing environment. Reconcile the task and its checks with the configured target and credentials before proceeding.',
      });
    }
    queue.log(null, 'user', 'testing-environment-set', `Testing URL ${queue.testingUrl ? 'configured' : 'not set'}; ${queue.testingCredentialNames.length} named credential(s). Active workers will use the new environment.`);
    scheduleRestart('Testing environment changed', this.output);
    if (prior === 'RUNNING') orch.start();
    else if (prior === 'PAUSED') queue.setRunState('PAUSED');
    this.post({ type: 'testingEnvironmentSaved' });
    this.render();
  }

  render(): void {
    if (!this.view) {
      return;
    }
    const queue = this.queue;
    const orch = this.orch;
    if (!queue || !orch) {
      this.post({
        type: 'unavailable',
        reason: this.problem ?? 'The task queue is not open in this window.',
        host: `${vscode.env.remoteName ? `remote: ${vscode.env.remoteName} · ` : ''}Node ${process.versions.node}`,
        needsFolder: !vscode.workspace.workspaceFolders?.length,
      });
      return;
    }
    this.post(queueViewState(this.context, queue, orch, this.generating));
    // Role models come from the profile store, which is async. Push them as a
    // follow-up so the rest of the view is not held up by a keychain read.
    void this.postRoleModels();
  }

  private async postRoleModels(): Promise<void> {
    const store = getStore();
    const [planner, supervisor, executor] = await Promise.all([
      store.resolve('planner'),
      store.resolve('supervisor'),
      store.resolve('executor'),
    ]);
    this.post({
      type: 'models',
      models: {
        planner: planner.model,
        supervisor: supervisor.model,
        executor: executor.model,
      },
    });
  }


}

/**
 * A webview message's list of names, taken as read but not on faith: the
 * picker sends one name for a leaf and every name under a group for a parent,
 * and either way the strings land in a database write.
 */
function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === 'string' && v.length > 0) as string[];
}
