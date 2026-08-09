import * as vscode from 'vscode';
import { CoreClient, InitResult } from './core';
import { generateTasks } from './queue/agents';
import { TaskQueue } from './queue/db';

/** Which agent handles the next message from the composer. */
export type ChatAgent = 'coder' | 'planner';

/** How many tasks the chat planner asks for; the sidebar has its own control. */
const PLAN_LIMIT = 20;

/**
 * ChatPanel renders the agent conversation in a full editor tab. It uses a
 * plain webview with hand-written HTML/CSS/JS — no framework — so the whole
 * UI ships in a few kilobytes.
 *
 * Two agents answer from the same composer. The Coder is this panel's own core:
 * one long-lived process, one conversation, tools that edit the workspace as you
 * talk. The Planner is the queue's planner model on a throwaway core — it reads
 * the workspace, writes a task list, and the answer lands in the Task Queue
 * rather than in the conversation.
 */
export class ChatPanel {
  public static readonly viewType = 'mfagent.chat';

  private static current: ChatPanel | undefined;

  /**
   * Set once the workspace's task queue is open. Static because the panel can
   * be closed and rebuilt, and the queue outlives it.
   */
  private static plan: { queue: TaskQueue; changed: () => void } | undefined;

  private panel: vscode.WebviewPanel;
  private sessionId = 's1';
  private busy = false;
  private init?: InitResult;
  /** True from the moment a planner turn is accepted until it settles. */
  private planning = false;
  /** Stops the planner's turn. Only available once its core has come up. */
  private cancelPlan: (() => void) | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly core: CoreClient,
    private readonly output: vscode.OutputChannel,
  ) {
    this.panel = panel;
    core.onNotification((method, params) => this.onCoreNotification(method, params));

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media'),
        ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
      ],
    };
    panel.webview.html = this.html(panel.webview);

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this.postStatus();
          break;
        case 'send':
          await this.send(msg.text, false, msg.agent === 'planner' ? 'planner' : 'coder');
          break;
        case 'stop':
          // A planner turn belongs to its own core; the chat session must not
          // be cancelled on its behalf, even in the moment before its core is
          // up and there is nothing yet to cancel.
          if (this.planning) {
            this.cancelPlan?.();
          } else {
            await this.core.request('chat/cancel', { sessionId: this.sessionId });
          }
          break;
        case 'openQueue':
          await vscode.commands.executeCommand('mfagent.queue.focus');
          break;
        case 'newSession':
          await this.newSession();
          break;
        case 'openFile':
          await this.openFile(msg.path, msg.line);
          break;
        case 'openUrl':
          await vscode.commands.executeCommand('simpleBrowser.show', msg.url);
          break;
        case 'showLog':
          this.output.show();
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('mfagent.openSettings');
          break;
      }
    });

    panel.onDidDispose(() => {
      ChatPanel.current = undefined;
    });
  }

  /** Creates a new panel in the editor area, or reveals the existing one. */
  static createOrShow(
    context: vscode.ExtensionContext,
    core: CoreClient,
    output: vscode.OutputChannel,
  ): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ChatPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'Chat',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
        ],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');

    ChatPanel.current = new ChatPanel(panel, context, core, output);
    return ChatPanel.current;
  }

  /** Returns the current panel if it exists, undefined otherwise. */
  static get currentPanel(): ChatPanel | undefined {
    return ChatPanel.current;
  }

  setInit(init: InitResult): void {
    this.init = init;
    this.postStatus();
    if (init.warnings?.length) {
      for (const w of init.warnings) {
        this.post({ type: 'system', text: w, level: 'warn' });
      }
    }
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
  }

  async newSession(): Promise<void> {
    await this.core.request('chat/reset', { sessionId: this.sessionId });
    this.sessionId = 's' + Date.now();
    this.post({ type: 'clear' });
    this.postStatus();
    this.reveal();
  }

  /**
   * Send a prompt, optionally prefilled from a command rather than the box.
   *
   * Commands always mean the Coder: "explain this selection" is a question for
   * the conversation, whatever the composer's selector happens to be set to.
   */
  async sendPrompt(text: string): Promise<void> {
    this.reveal();
    this.post({ type: 'user', text });
    await this.send(text, true, 'coder');
  }

  private async send(
    text: string,
    alreadyEchoed = false,
    agent: ChatAgent = 'coder',
  ): Promise<void> {
    if (!text?.trim() || this.busy) {
      return;
    }
    if (!alreadyEchoed) {
      this.post({ type: 'user', text });
    }
    if (agent === 'planner') {
      await this.plan(text);
      return;
    }

    this.busy = true;
    this.post({ type: 'busy', busy: true });

    const editor = vscode.window.activeTextEditor;
    const openFiles = vscode.workspace.textDocuments
      .filter((d) => d.uri.scheme === 'file')
      .slice(0, 12)
      .map((d) => vscode.workspace.asRelativePath(d.uri));

    let selection = '';
    let selectionPath = '';
    if (editor && !editor.selection.isEmpty) {
      selection = editor.document.getText(editor.selection);
      const start = editor.selection.start.line + 1;
      const end = editor.selection.end.line + 1;
      selectionPath = `${vscode.workspace.asRelativePath(editor.document.uri)}:${start}-${end}`;
      if (selection.length > 20000) {
        selection = selection.slice(0, 20000) + '\n… (selection truncated)';
      }
    }

    try {
      await this.core.request('chat/send', {
        sessionId: this.sessionId,
        text,
        openFiles,
        selection,
        selectionPath,
      });
    } catch (e: any) {
      this.post({ type: 'system', text: String(e?.message ?? e), level: 'error' });
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  // ---- planner ---------------------------------------------------------

  /** Hands the chat planner somewhere to put its plan. */
  static bindQueue(queue: TaskQueue, changed: () => void): void {
    ChatPanel.plan = { queue, changed };
  }

  /**
   * Runs the planner model on a goal and writes the result into the task queue.
   *
   * The planner burns a throwaway core on its own model, so nothing it reads
   * enters the coder's context window and nothing the coder said steers it. Its
   * tool calls stream into the chat because watching it explore is the only way
   * to judge whether the plan is grounded — but its answer is JSON, so the plan
   * itself is rendered from the parsed tasks instead of the raw reply.
   */
  private async plan(goal: string): Promise<void> {
    const target = ChatPanel.plan;
    if (!target) {
      this.post({
        type: 'system',
        text: 'The task queue is not open in this window, so a plan has nowhere to go. Open a folder and reload.',
        level: 'error',
      });
      return;
    }

    // Held across the confirmation too, so a second message cannot start a
    // second planner while the dialog is open.
    this.busy = true;
    this.planning = true;
    this.post({ type: 'busy', busy: true });

    const existing = target.queue.stats().total;
    let append = false;
    if (existing > 0) {
      const pick = await vscode.window.showWarningMessage(
        `The task queue already holds ${existing} task(s).`,
        {
          modal: true,
          detail:
            'Replace clears those tasks and their history. Append keeps them and adds the new plan after them.',
        },
        'Replace',
        'Append',
      );
      if (!pick) {
        this.busy = false;
        this.planning = false;
        this.post({ type: 'busy', busy: false });
        return;
      }
      append = pick === 'Append';
    }

    this.post({
      type: 'system',
      text: 'Planning — the planner model reads the workspace before it writes the task list.',
    });

    let cancelled = false;
    try {
      const tasks = await generateTasks(
        this.context,
        this.output,
        goal,
        PLAN_LIMIT,
        (method, params) => this.onPlannerEvent(method, params),
        (cancel) => {
          this.cancelPlan = () => {
            cancelled = true;
            cancel();
          };
        },
      );

      const n = append ? target.queue.addAll(tasks) : target.queue.replaceAll(tasks);
      target.changed();
      this.post({ type: 'done' });
      this.post({
        type: 'plan',
        total: n,
        appended: append,
        tasks: tasks.map((t) => ({
          seq: t.seq ?? 0,
          title: t.title,
          command: t.solutionVerifyCommand ?? '',
        })),
      });
      this.output.appendLine(`[chat:planner] ${append ? 'appended' : 'wrote'} ${n} task(s)`);
    } catch (e: any) {
      this.post({ type: 'done' });
      this.post({
        type: 'system',
        text: cancelled ? 'Planning stopped.' : `Planning failed: ${e?.message ?? e}`,
        level: cancelled ? 'warn' : 'error',
      });
    } finally {
      this.cancelPlan = undefined;
      this.planning = false;
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  /**
   * Streams the planner's turn into the chat, minus its final reply — that is
   * the JSON array, and the rendered plan says the same thing legibly.
   */
  private onPlannerEvent(method: string, params: any): void {
    if (method === 'stream/text' || method === 'stream/done') {
      return;
    }
    this.onCoreNotification(method, params);
  }

  private onCoreNotification(method: string, params: any): void {
    switch (method) {
      case 'stream/text':
        this.post({ type: 'assistantDelta', delta: params.delta });
        break;
      case 'stream/thinking':
        this.post({ type: 'thinkingDelta', delta: params.delta });
        break;
      case 'stream/tool':
        this.post({
          type: 'tool',
          id: params.id,
          name: params.name,
          status: params.status,
          input: params.input,
          output: params.output,
          elapsedMs: params.elapsedMs,
          meta: params.meta,
          screenshot: this.toWebviewUri(params.meta?.screenshot),
        });
        break;
      case 'stream/event':
        if (params.kind === 'screenshot') {
          this.post({ type: 'image', src: this.toWebviewUri(params.payload?.path) });
        }
        break;
      case 'stream/done':
        this.post({
          type: 'done',
          stopReason: params.stopReason,
          usage: params.usage,
          error: params.error,
        });
        break;
      case 'file/changed':
        if (params?.path) {
          void vscode.workspace.fs.stat(vscode.Uri.file(params.path)).then(undefined, () => {
            /* deleted; nothing to refresh */
          });
        }
        break;
      case 'log':
        this.output.appendLine(`[core:${params.level}] ${params.message}`);
        break;
    }
  }

  private toWebviewUri(fsPath?: string): string | undefined {
    if (!fsPath) {
      return undefined;
    }
    try {
      return this.panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString();
    } catch {
      return undefined;
    }
  }

  private postStatus(): void {
    this.post({
      type: 'status',
      model: this.init?.model ?? '—',
      provider: this.init?.provider ?? '—',
      memory: this.init?.memory ?? false,
      tools: this.init?.tools?.length ?? 0,
      mcp: this.init?.mcp ?? [],
      session: this.sessionId,
    });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async openFile(rel: string, line?: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const uri = vscode.Uri.joinPath(folder.uri, rel);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${rel}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'),
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'),
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
<title>MF Agent</title>
</head>
<body>
  <header id="status">
    <span id="model">starting…</span>
    <span class="spacer"></span>
    <span id="badges"></span>
    <button id="settingsBtn" class="icon" title="Settings">&#9881;</button>
  </header>

  <main id="log" role="log" aria-live="polite"></main>

  <footer>
    <div id="usage"></div>
    <div class="composer">
      <div class="composer-bar">
        <select id="agent" title="Which agent handles this message">
          <option value="coder" selected>Coder</option>
          <option value="planner">Planner</option>
        </select>
        <span id="agentHint" class="agenthint"></span>
      </div>
      <div class="composer-row">
        <textarea id="input" rows="2" placeholder="Ask, or describe a change… (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="actions">
          <button id="send" title="Send">Send</button>
          <button id="stop" title="Stop" hidden>Stop</button>
        </div>
      </div>
    </div>
  </footer>

  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
