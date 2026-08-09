import * as vscode from 'vscode';
import { getStore } from '../providers/instance';
import { generateTasks } from './agents';
import { Task, TaskQueue } from './db';
import { Orchestrator } from './orchestrator';

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
 */
export class QueueViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mfagent.queue';

  private view?: vscode.WebviewView;
  private generating = false;
  private queue?: TaskQueue;
  private orch?: Orchestrator;
  /** Why the queue is unavailable, when it is. */
  private problem?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    /** Re-runs the open attempt; resolves once `attach` or `fail` has been called. */
    private readonly reopen: () => Promise<void>,
  ) {}

  /** The queue opened: wire it up and drop any previous failure. */
  attach(queue: TaskQueue, orch: Orchestrator): void {
    this.queue = queue;
    this.orch = orch;
    this.problem = undefined;
    orch.onDidChange(() => this.render());
    this.render();
  }

  /** The queue could not be opened. The view says so instead of spinning. */
  fail(reason: string): void {
    this.queue = undefined;
    this.orch = undefined;
    this.problem = reason;
    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${QueueViewProvider.viewType}.focus`);
  }

  /** Entry point for the `Generate Task Queue` command palette action. */
  generateFromCommand(goal: string): void {
    void this.generate(goal, 20, false);
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
        case 'generate':
          await this.generate(msg.goal, Number(msg.limit) || 20, !!msg.append);
          break;

        case 'start':
          if (await this.confirmAutonomy(queue)) {
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
          if (await this.confirmReset()) {
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
          queue.update(Number(msg.id), msg.patch);
          this.render();
          break;
        case 'setStatus':
          queue.update(Number(msg.id), { status: msg.status });
          queue.log(Number(msg.id), 'user', 'status-set', msg.status);
          this.render();
          break;
        case 'deleteTask': {
          const task = queue.get(Number(msg.id));
          if (task && msg.confirm && !(await this.confirmDelete(task))) {
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
          if (await this.confirmClear()) {
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

  private async generate(goal: string, limit: number, append: boolean): Promise<void> {
    const queue = this.queue;
    if (!queue) {
      void vscode.window.showWarningMessage(
        `The task queue is unavailable: ${this.problem ?? 'not open'}`,
      );
      return;
    }
    if (!goal?.trim()) {
      void vscode.window.showInformationMessage('Describe what you want built first.');
      return;
    }
    if (this.generating) {
      return;
    }
    this.generating = true;
    this.render();

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Generating task list…' },
        async (progress) => {
          const tasks = await generateTasks(
            this.context,
            this.output,
            goal,
            limit,
            (method, params) => {
              if (method === 'stream/tool' && params?.status === 'running') {
                progress.report({ message: params.name });
              }
            },
          );
          const n = append ? queue.addAll(tasks) : queue.replaceAll(tasks);
          void vscode.window.showInformationMessage(`Generated ${n} task(s).`);
        },
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not generate tasks: ${e?.message ?? e}`);
    } finally {
      this.generating = false;
      this.render();
    }
  }

  // ---- confirmations ---------------------------------------------------

  /**
   * An autonomous run approves every tool call, including shell commands, with
   * nobody watching. That is a real decision and it gets asked once per start.
   */
  private async confirmAutonomy(queue: TaskQueue): Promise<boolean> {
    const stats = queue.stats();
    const runnable = stats.byStatus.PENDING + stats.byStatus.PAUSED;
    if (runnable === 0) {
      void vscode.window.showInformationMessage('Nothing to run — no PENDING tasks in the queue.');
      return false;
    }
    const pick = await vscode.window.showWarningMessage(
      `Start the autonomous run over ${runnable} task(s)?`,
      {
        modal: true,
        detail:
          'Execution and Supervisor agents will edit files and run shell commands in this ' +
          'workspace without asking for confirmation. Only do this in a workspace you trust, ' +
          'and with your work committed.',
      },
      'Start run',
    );
    return pick === 'Start run';
  }

  /**
   * Asked only for a task that has already cost something. Deleting is not
   * undoable and takes its attempts, output and token spend with it, which is
   * worth one dialog — but a task nobody has run yet is not.
   */
  private async confirmDelete(task: Task): Promise<boolean> {
    const spent = task.tokensIn + task.tokensCacheRead + task.tokensOut;
    const detail = [
      task.attempts > 0 ? `${task.attempts} attempt(s)` : '',
      spent > 0 ? `${spent.toLocaleString()} tokens` : '',
    ]
      .filter(Boolean)
      .join(' and ');

    const pick = await vscode.window.showWarningMessage(
      `Remove task ${task.seq}: ${task.title}?`,
      {
        modal: true,
        detail: detail
          ? `This task has ${detail} behind it. Removing it discards its output and history, and cannot be undone.`
          : 'This cannot be undone.',
      },
      'Remove',
    );
    return pick === 'Remove';
  }

  private async confirmReset(): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
      'Reset every task to PENDING?',
      { modal: true, detail: 'Progress, outputs, error logs and supervisor feedback are cleared. The tasks themselves are kept.' },
      'Reset',
    );
    return pick === 'Reset';
  }

  private async confirmClear(): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
      'Delete the whole task queue?',
      { modal: true, detail: 'Every task and its history is removed. This cannot be undone.' },
      'Delete all',
    );
    return pick === 'Delete all';
  }

  // ---- rendering -------------------------------------------------------

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
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
    this.post({
      type: 'state',
      tasks: queue.list() as Task[],
      stats: queue.stats(),
      status: orch.status(),
      generating: this.generating,
      dbPath: queue.path,
      driver: queue.impl,
      models: { planner: '', supervisor: '', executor: '' },
    });
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

  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'queue.css'),
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'queue.js'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${css}" rel="stylesheet" />
<title>MF Agent — Task Queue</title>
</head>
<body>
  <section id="pane-unavailable" class="pane unavailable" hidden>
    <h2>Task queue unavailable</h2>
    <p id="reason" class="reason"></p>
    <p id="host" class="hint"></p>
    <div class="row">
      <button id="retry" class="primary">Retry</button>
      <button id="openFolder" class="ghost" hidden>Open Folder</button>
      <button id="showLog2" class="ghost">Show log</button>
    </div>
  </section>

  <nav class="tabs">
    <button class="tab active" data-pane="run">Run</button>
    <button class="tab" data-pane="plan">Plan</button>
  </nav>

  <section id="pane-plan" class="pane" hidden>
    <label class="lbl" for="goal">What should the agents build?</label>
    <textarea id="goal" rows="6" placeholder="e.g. Add a REST API for invoices with auth, validation and integration tests."></textarea>
    <div class="row">
      <label class="lbl" for="limit">Max tasks</label>
      <input id="limit" type="number" min="1" max="100" value="20" />
      <label class="chk"><input id="append" type="checkbox" /> Append to queue</label>
    </div>
    <button id="generate" class="primary">Generate task list</button>
    <p class="hint">The planner model reads the workspace, then writes a numbered plan with a verification step and test command per task.</p>
  </section>

  <section id="pane-run" class="pane">
    <div id="controls" class="row">
      <button id="start" class="primary" title="Start the autonomous run">Start</button>
      <button id="pause" title="Pause after the current task">Pause</button>
      <button id="stop" title="Stop the run">Stop</button>
      <button id="reset" title="Return every task to PENDING">Reset</button>
      <span class="spacer"></span>
      <button id="runNow" class="ghost" title="Run a supervision cycle now">Check now</button>
    </div>

    <div class="row">
      <label class="lbl" for="cron">Supervisor checks</label>
      <select id="cron" title="How often the supervisor wakes up to verify finished tasks. Saved with this task list.">
        <option value="0">Use setting</option>
        <option value="30">every 30 seconds</option>
        <option value="60">every 60 seconds</option>
        <option value="120">every 2 minutes</option>
        <option value="300">every 5 minutes</option>
        <option value="600">every 10 minutes</option>
        <option value="900">every 15 minutes</option>
        <option value="1800">every 30 minutes</option>
      </select>
    </div>

    <div id="runbar"></div>
    <div id="counts" class="counts"></div>
    <div id="tasks" class="tasks"></div>

    <div class="row foot">
      <button id="addTask" class="ghost">Add task</button>
      <button id="clearQueue" class="ghost">Clear queue</button>
      <span class="spacer"></span>
      <button id="genDocs" class="ghost">Generate Docs</button>
      <span class="spacer"></span>
      <button id="openSettings" class="ghost">Settings</button>
      <button id="showLog" class="ghost">Log</button>
    </div>
    <p id="dbinfo" class="hint"></p>
  </section>

  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
