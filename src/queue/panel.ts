import * as vscode from 'vscode';
import { scheduleRestart } from '../coreRestart';
import { mcpConnection } from '../coreStatus';
import { discoverMcpServers } from '../mcp';
import { getBridge } from '../mcpBridge';
import { getStore } from '../providers/instance';
import type { Skill } from '../providers/store';
import { discoverInstalledSkills } from '../skills';
import { editTasks, planGoal } from './agents';
import { Task, TaskQueue, taskEditSummary } from './db';
import { LiveLog } from './liveLog';
import { Orchestrator } from './orchestrator';
import { notifySkillsChanged, onDidChangeSkills } from './registry';

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
    view.webview.html = this.html(view.webview);
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
  generateFromCommand(goal: string): void {
    void this.generate(goal, false);
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
          await this.setMcpKey(String(msg.name ?? ''));
          break;

        // A terminal being opened asks for what it missed: the newest rows of
        // its own stream, replacing whatever the webview buffered.
        case 'logTail': {
          const taskId = msg.id === null || msg.id === undefined ? null : Number(msg.id);
          this.post({ type: 'logs', rows: queue.logsTail(taskId, 300), reset: true, taskId });
          break;
        }

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

  private async generate(goal: string, append: boolean): Promise<void> {
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

    // Planning has no task yet, so its stream is the queue's own — the
    // Planner terminal on the Plan tab.
    const live = new LiveLog(queue, null, 'planner');
    live.note('plan', `planning: ${goal.trim()}`);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning the workspace and scoping a plan…' },
        async (progress) => {
          const phases = await planGoal(
            this.context,
            this.output,
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
      this.generating = false;
      this.render();
    }
  }

  /**
   * Edits, adds to, or removes from the existing task list from a free-text
   * instruction — as opposed to `generate`, which only ever produces a brand
   * new list. The planner proposes changes against a captured task snapshot;
   * the database resolves those references to stable IDs and commits the whole
   * revision together. Only the committed receipt is reported as completed work.
   */
  private async applyTaskEditPrompt(instruction: string): Promise<void> {
    const queue = this.queue;
    if (!queue) {
      void vscode.window.showWarningMessage(
        `The task queue is unavailable: ${this.problem ?? 'not open'}`,
      );
      return;
    }
    if (!instruction.trim()) {
      void vscode.window.showInformationMessage('Describe the change to make first.');
      return;
    }
    if (this.generating) {
      return;
    }
    this.generating = true;
    this.render();

    const live = new LiveLog(queue, null, 'planner');
    live.note('plan', `editing the task list: ${instruction.trim()}`);
    try {
      const snapshot = queue.list();
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Editing the task list…' },
        () => editTasks(this.context, this.output, snapshot, instruction, { onEvent: live.onEvent }),
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
      this.generating = false;
      this.render();
    }
  }

  /**
   * Gives one discovered MCP server a key of its own, without touching the
   * file it came from.
   *
   * A server from VS Code's user `mcp.json` or the `mfagent.mcpServers`
   * setting carries whatever credential is written there, and when the
   * server rejects it the only remedy used to be editing that file by hand —
   * with a key in cleartext. This instead makes a copy on the settings page
   * under the same name, which is what wins at discovery time, and files the
   * key in the OS keychain where the copy's key belongs. The file is left as
   * it is. A server that already lives on the settings page just gets its
   * key replaced.
   */
  private async setMcpKey(name: string): Promise<void> {
    const store = getStore();
    const found = discoverMcpServers(this.context, store).find((s) => s.name === name);
    if (!found) {
      return;
    }
    const http = !!found.url;
    let def = found.source === 'store' && found.id ? store.mcpServer(found.id) : undefined;
    if (!def) {
      const created = await store.addMcpServer(name);
      await store.updateMcpServer(created.id, {
        name,
        transport: http ? 'http' : 'stdio',
        url: found.url,
        headers: found.headers ? { ...found.headers } : undefined,
        command: found.command,
        args: found.args ? [...found.args] : undefined,
        env: found.env ? { ...found.env } : undefined,
        enabled: true,
        // The scheme the server itself names in its challenge. The key
        // written at connect time replaces any header of the same name the
        // copy inherited, which is the whole point when that one was wrong.
        keyName: http ? 'Authorization' : '',
        keyPrefix: http ? 'Bearer ' : undefined,
      });
      def = store.mcpServer(created.id);
    }
    if (!def) {
      return;
    }

    let keyName = def.keyName?.trim() ?? '';
    if (!keyName) {
      const typed = await vscode.window.showInputBox({
        title: `Key for MCP server "${name}"`,
        prompt: http ? 'Which header carries the key?' : 'Which environment variable carries the key?',
        value: http ? 'Authorization' : '',
        placeHolder: http ? 'Authorization' : 'API_KEY',
        ignoreFocusOut: true,
      });
      keyName = typed?.trim() ?? '';
      if (!keyName) {
        return;
      }
      await store.updateMcpServer(def.id, {
        keyName,
        keyPrefix: http && /^authorization$/i.test(keyName) ? (def.keyPrefix || 'Bearer ') : def.keyPrefix,
      });
      def = store.mcpServer(def.id) ?? def;
    }

    const typedKey = await vscode.window.showInputBox({
      title: `Key for MCP server "${name}"`,
      prompt: `Stored in the OS keychain and sent as ${keyName}${def.keyPrefix ? ` (${def.keyPrefix.trim()} …)` : ''}. Leave empty to clear.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (typedKey === undefined) {
      return;
    }
    let key = typedKey.trim();
    // A key pasted with its scheme — "Bearer xyz" — would be sent as
    // "Bearer Bearer xyz" once the prefix is added; keep just the key.
    const prefix = def.keyPrefix?.trim();
    if (prefix && key.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      key = key.slice(prefix.length).trim();
    }
    await store.setMcpKey(def.id, key);
    // The store's change event restarts the core, which is what tries the
    // key; the row shows the result once that core has reported in.
    this.render();
  }

  // ---- confirmations ---------------------------------------------------

  /**
   * An autonomous run approves every tool call, including shell commands, with
   * nobody watching. That is a real decision and it gets asked once per start.
   */
  private async confirmAutonomy(queue: TaskQueue): Promise<boolean> {
    const stats = queue.stats();
    const pending = stats.byStatus.PENDING + stats.byStatus.PAUSED;
    // A task awaiting verification is work too — the supervisor's — and the
    // supervisor only ticks while the run is going. So is a task left
    // EXECUTING by a process that no longer exists, which start() sends to
    // verification. Counting only PENDING here refused to start a queue whose
    // last task was VERIFYING, which left it with no way to ever finish.
    const verifying = stats.byStatus.VERIFYING + stats.byStatus.EXECUTING;
    if (pending + verifying === 0) {
      void vscode.window.showInformationMessage(
        'Nothing to run — no PENDING tasks and nothing awaiting verification.',
      );
      return false;
    }
    const title =
      pending > 0
        ? `Start the autonomous run over ${pending} task(s)` +
          (verifying > 0 ? `, with ${verifying} awaiting verification?` : '?')
        : `Resume supervision of ${verifying} task(s) awaiting verification?`;
    const pick = await vscode.window.showWarningMessage(
      title,
      {
        modal: true,
        detail:
          'Execution and Supervisor agents will edit files and run shell commands in this ' +
          'workspace without asking for confirmation — a task the supervisor sends back is ' +
          'executed again. Only do this in a workspace you trust, and with your work committed.',
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
    const disabledMcp = new Set(queue.disabledMcpServers);
    const enabledSkillGroups = new Set(queue.enabledSkillGroups);

    this.post({
      type: 'state',
      tasks: queue.list() as Task[],
      stats: queue.stats(),
      status: orch.status(),
      generating: this.generating,
      dbPath: queue.path,
      driver: queue.impl,
      instructions: queue.instructions,
      models: { planner: '', supervisor: '', executor: '' },
      mcpServers: discoverMcpServers(this.context, getStore()).map((s) => ({
        name: s.name,
        source: s.source,
        configured: !!(s.command || s.url),
        enabled: !disabledMcp.has(s.name),
        // The server's own switch, from the settings page — separate from
        // this workspace's pick above.
        serverEnabled: s.enabled !== false,
        problem: s.problem,
        // What the last core start made of it — see coreStatus.ts.
        connection: mcpConnection(s.name),
        canSetKey: !!(s.url || s.command),
      })),
      editorTools: getBridge().tree(),
      skillGroups: [
        ...getStore().settings.skillGroups.map((g) => ({
          id: g.id,
          name: g.name,
          enabled: enabledSkillGroups.has(g.id),
          source: 'authored' as const,
          // The skills themselves, so a group can be unfolded rather than
          // taken on trust from a count.
          skills: g.skillIds
            .map((id) => getStore().settings.skills.find((s) => s.id === id))
            .filter((s): s is Skill => !!s)
            .map((s) => ({ name: s.name, description: s.description ?? '' })),
        })),
        ...discoverInstalledSkills(vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []).map((d) => ({
          id: d.group.id,
          name: d.group.name,
          enabled: enabledSkillGroups.has(d.group.id),
          source: 'installed' as const,
          skills: [{ name: d.skill.name, description: d.skill.description ?? '' }],
        })),
      ],
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
    <button class="tab" data-pane="context">Context</button>
  </nav>

  <section id="pane-context" class="pane" hidden>
    <div class="picker-bar">
      <input id="ctxFilter" class="picker-search" type="search" placeholder="Filter tools, servers and skills…" aria-label="Filter the context list" />
      <span id="ctxCount" class="picker-count" title="Everything switched on for this workspace">0 selected</span>
    </div>
    <p class="hint">What is checked here is what every agent in this workspace gets, in Chat and in every Task Queue run alike. Check a group to take all of it.</p>

    <h3 class="section-title">
      Tools
      <button id="ctxDefaults" class="ghost hdr-action" title="Back to the built-in edit, execute, read and search sets">Restore defaults</button>
    </h3>
    <p class="hint">Everything <code>vscode.lm.tools</code> offers, grouped by where it comes from. A checked tool reaches the agent as <code>editor__&lt;name&gt;</code> and the editor runs it. <code>edit</code>, <code>execute</code>, <code>read</code> and <code>search</code> start on; the rest is opt-in, because every definition travels with every request.</p>
    <div id="editorToolTree" class="tree"></div>

    <h3 class="section-title">MCP servers</h3>
    <p class="hint">Servers the agent's core dials itself, separately from the editor — from your VS Code user <code>mcp.json</code> and the <code>mfagent.mcpServers</code> setting.</p>
    <div id="mcpList" class="tree"></div>

    <h3 class="section-title">Skill groups</h3>
    <p class="hint">Injected into the agent's system prompt; unfold a group to read what it carries. Author them in Settings, or use "MF Agent: Install Skill Pack" (<code>npx skills add &lt;repo&gt; -g -a &lt;agent&gt;</code>) — installed packs appear here on their own.</p>
    <div id="skillGroupList" class="tree"></div>
  </section>

  <section id="pane-plan" class="pane" hidden>
    <label class="lbl" for="goal">What should the agents build?</label>
    <textarea id="goal" rows="6" placeholder="e.g. Add a REST API for invoices with auth, validation and integration tests."></textarea>
    <div class="row">
      <label class="chk"><input id="append" type="checkbox" /> Append to queue</label>
    </div>
    <button id="generate" class="primary">Generate plan</button>
    <p class="hint">The workspace is scanned and split into regions first, then the planner scopes phases over them — each phase is explored and turned into verifiable tasks with a test command once you press Start, so planning stays fast no matter how large the project is.</p>
    <details class="termwrap" open>
      <summary class="lbl">Planner output</summary>
      <pre id="plannerTerm" class="term"></pre>
    </details>

    <label class="lbl" for="editInstruction">Edit the existing tasks</label>
    <textarea id="editInstruction" rows="4" placeholder="e.g. Drop the caching task, and add integration tests for the new endpoint."></textarea>
    <button id="applyEdit">Apply edit</button>
    <p class="hint">The planner reads the current task list and your instruction, then edits, adds or removes tasks in place — nothing already VERIFIED is touched.</p>

    <label class="lbl" for="instructions">Project notes (sent to every task)</label>
    <textarea id="instructions" rows="6" placeholder="e.g. Use Go with Wails; test with Playwright.&#10;The class list lives in classes.md.&#10;Build with build.ps1."></textarea>
    <p class="hint">Every task otherwise runs in its own process with no memory of any other — this is the one thing every execution agent sees regardless. Start it with standing conventions for the project; it also grows on its own as agents report durable facts worth keeping, so a fact task 1 establishes can reach task 3 without task 3 rediscovering it.</p>
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

/**
 * A webview message's list of names, taken as read but not on faith: the
 * picker sends one name for a leaf and every name under a group for a parent,
 * and either way the strings land in a database write.
 */
function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === 'string' && v.length > 0) as string[];
}
