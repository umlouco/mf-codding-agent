import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoreClient, InitResult } from './core';
import { registerEditorFsHandlers } from './editorFs';
import { disposeTerminal, registerEditorTerminalHandlers } from './editorTerminal';
import { ChatPanel } from './panel';
import { queueDbPath, resolveMcpBinary } from './detect';
import { registerMcpProvider, writeProjectMcpJson, writeUserMcpJson } from './mcp';
import { TaskQueue } from './queue/db';
import { Orchestrator } from './queue/orchestrator';
import { QueueViewProvider } from './queue/panel';
import { setActiveQueue } from './queue/registry';
import { SKILL_INSTALL_AGENTS } from './skills';
import { resolveChromium } from './chromium';
import { getModelRegistry, getStore, initProviders } from './providers/instance';
import { ProfileStore } from './providers/store';
import { SettingsPanel } from './settings/panel';

let core: CoreClient;
let chat: ChatPanel | undefined;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let queue: TaskQueue | undefined;
let orch: Orchestrator | undefined;
let queueView: QueueViewProvider | undefined;
let store: ProfileStore;
/** Resolved once at activation and reused for every core (re)start. */
let chromiumPath: string | undefined;
/** The "no model configured" prompt is worth showing once, not every restart. */
let nudgedAboutSetup = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('MF Agent');
  context.subscriptions.push(output);

  store = initProviders(context, output).store;
  await migrateLegacySettings(store);

  core = new CoreClient(context, output);
  context.subscriptions.push(core);
  registerEditorFsHandlers(core);
  registerEditorTerminalHandlers(core);
  // The agent's terminal belongs to this activation, not to the workspace: a
  // stale one left behind on deactivate would still be sitting there, detached
  // from any core, the next time the extension started.
  context.subscriptions.push({ dispose: disposeTerminal });

  chat = ChatPanel.createOrShow(context, core, output);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'mfagent.focusChat';
  status.text = '$(sparkle) MF Agent';
  status.tooltip = 'MF Agent — click to open the chat';
  status.show();
  context.subscriptions.push(status);

  registerCommands(context);
  registerTaskQueue(context);
  registerMcpProvider(context);
  registerUserMcpJson(context);

  // The browser path is worked out, never configured. On remote workspaces
  // this may download Chromium into the extension cache.
  chromiumPath = await resolveChromium(context, output);
  SettingsPanel.setChromium(chromiumPath);

  // Editing a provider on the settings page fires per keystroke on some
  // fields, so coalesce before paying for a core restart.
  context.subscriptions.push(
    store.onDidChange(() =>
      scheduleRestart('provider settings changed'),
    ),
  );

  // The few plain values still in settings.json also belong to the core.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('mfagent.memory.enabled') ||
        e.affectsConfiguration('mfagent.mcpServers')
      ) {
        scheduleRestart('configuration changed');
      }
    }),
  );

  bootstrapChain = bootstrap(false, chromiumPath);
  await bootstrapChain;
}

let restartTimer: NodeJS.Timeout | undefined;
/** Bootstraps run one at a time; a restart must not interleave with a start. */
let bootstrapChain: Promise<void> = Promise.resolve();

function scheduleRestart(why: string): void {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    output.appendLine(`[ext] ${why}; restarting core`);
    bootstrapChain = bootstrapChain.then(() => bootstrap(true, chromiumPath));
  }, 600);
}

/**
 * Moves a pre-0.2 `settings.json` setup into the profile store.
 *
 * Awaited, because the core is initialised from the store moments later. The
 * notification that follows is deliberately *not* awaited — activation must not
 * sit behind a dialog waiting to be dismissed.
 */
async function migrateLegacySettings(s: ProfileStore): Promise<void> {
  let stale: string[] = [];
  try {
    stale = await s.migrateFromSettings();
  } catch (e: any) {
    output.appendLine(`[ext] settings migration failed: ${e?.message ?? e}`);
    return;
  }
  if (stale.length === 0) {
    return;
  }
  output.appendLine(`[ext] migrated legacy settings: ${stale.join(', ')}`);
  void offerToCleanUp(stale);
}

/**
 * The old keys are no longer contributed, so leaving them behind means VS Code
 * marks them as unknown settings forever. Removing them is the user's call, so
 * we offer rather than delete.
 */
async function offerToCleanUp(stale: string[]): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    'MF Agent now keeps providers and models on its own settings page, with API keys in the OS keychain. Your old configuration was imported.',
    'Open settings page',
    'Remove old entries',
  );
  if (pick === 'Open settings page') {
    await vscode.commands.executeCommand('mfagent.openSettings');
  } else if (pick === 'Remove old entries') {
    const cfg = vscode.workspace.getConfiguration();
    for (const key of stale) {
      for (const target of [
        vscode.ConfigurationTarget.Global,
        vscode.ConfigurationTarget.Workspace,
        vscode.ConfigurationTarget.WorkspaceFolder,
      ]) {
        try {
          await cfg.update(key, undefined, target);
        } catch {
          // Not set at that scope, or the scope does not exist here.
        }
      }
    }
    void vscode.window.showInformationMessage(`Removed ${stale.length} obsolete MF Agent setting(s).`);
  }
}

async function bootstrap(restart: boolean, chromiumPath?: string): Promise<void> {
  try {
    status.text = '$(loading~spin) MF Agent';

    let init: InitResult;
    if (restart) {
      init = await core.restart(
        chromiumPath ? { browserExecutable: chromiumPath } : {},
      );
    } else {
      await core.start();
      init = await core.initialize(
        chromiumPath ? { browserExecutable: chromiumPath } : {},
      );
    }
    chat?.setInit(init);
    status.text = '$(sparkle) MF Agent';
    status.tooltip = new vscode.MarkdownString(
      [
        `**MF Agent** ${init.version}`,
        '',
        `Model: \`${init.model}\` (${init.provider})`,
        `Tools: ${init.tools.length}`,
        `Graph memory: ${init.memory ? 'on' : 'off'}`,
        init.mcp?.length ? `MCP: ${init.mcp.join(', ')}` : 'MCP: none',
        init.visionModel ? `Vision: \`${init.visionModel}\`` : '',
        init.embeddingModel ? `Embedding: \`${init.embeddingModel}\`` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    output.appendLine(
      `[ext] core ${init.version} ready — ${init.tools.length} tools, model ${init.model || '(none)'}` +
      (init.embeddingModel ? `, embedding ${init.embeddingModel}` : ''),
    );
    for (const w of init.warnings ?? []) {
      output.appendLine(`[ext] warning: ${w}`);
    }

    // A core with no model starts cleanly and then fails on the first message.
    // Say so now, once, with the way to fix it.
    if (!init.model) {
      status.text = '$(warning) MF Agent';
      if (!nudgedAboutSetup) {
        nudgedAboutSetup = true;
        void vscode.window
          .showWarningMessage(
            'MF Agent has no coding model yet. Add a provider and bind it to the Coding role.',
            'Open Settings',
          )
          .then((pick) => {
            if (pick) {
              void vscode.commands.executeCommand('mfagent.openSettings');
            }
          });
      }
    }
  } catch (e: any) {
    status.text = '$(error) MF Agent';
    status.tooltip = String(e?.message ?? e);
    output.appendLine(`[ext] startup failed: ${e?.message ?? e}`);
    const pick = await vscode.window.showErrorMessage(
      `MF Agent could not start: ${e?.message ?? e}`,
      'Open Settings',
      'Show Log',
    );
    if (pick === 'Show Log') {
      output.show();
    } else if (pick === 'Open Settings') {
      await vscode.commands.executeCommand('mfagent.openSettings');
    }
  }
}

/**
 * Registers the task-queue MCP server in VS Code's own per-user `mcp.json`,
 * so it shows up there even on a VS Code build too old for
 * `registerMcpProvider`'s dynamic API (which silently no-ops below 1.99).
 * Best-effort: a machine with no workspace open yet, a read-only `User`
 * folder, or a not-yet-built `mfagent-mcp` binary should not stop the rest of
 * activation.
 */
function registerUserMcpJson(context: vscode.ExtensionContext): void {
  try {
    const bin = resolveMcpBinary(context);
    if (!bin) {
      return;
    }
    const file = writeUserMcpJson(context, bin);
    output.appendLine(`[ext] registered MCP server in ${file}`);
  } catch (e: any) {
    output.appendLine(`[ext] could not register user mcp.json: ${e?.message ?? e}`);
  }
}

/**
 * Brings up the autonomous task queue.
 *
 * The queue is per-workspace and lives in a SQLite file, so it survives window
 * reloads and crashes — a run that was interrupted is picked back up from the
 * database rather than restarted. Failing to open it must not take the chat
 * down with it, so everything here is guarded.
 */
function registerTaskQueue(context: vscode.ExtensionContext): void {
  // The view provider is registered unconditionally. A contributed webview view
  // whose provider never registers shows an endless spinner, so bailing out here
  // turns "no folder open" or "no SQLite driver" — both ordinary on a remote
  // host — into a UI that looks hung and reports nothing.
  queueView = new QueueViewProvider(context, output, () => openTaskQueue(context));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QueueViewProvider.viewType, queueView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Changing the cron interval should take effect without a restart.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mfagent.queue.cronIntervalSeconds')) {
        orch?.reschedule();
      }
      queueView?.render();
    }),
  );

  // Opening a folder into an empty remote window is the usual fix for the
  // commonest failure, so take it as it happens rather than asking for a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!queue) {
        void openTaskQueue(context);
      }
    }),
  );

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  /** Commands must exist even with no queue behind them, or they error as unknown. */
  const withQueue = (fn: (o: Orchestrator) => unknown) => async () => {
    if (!orch) {
      const pick = await vscode.window.showWarningMessage(
        `MF Agent task queue is unavailable: ${queueProblem ?? 'not open'}`,
        'Show Log',
      );
      if (pick) {
        output.show();
      }
      return;
    }
    return fn(orch);
  };

  // `mfagent.queue.focus` is not registered here: VS Code creates a
  // `<viewId>.focus` command for every contributed view, and declaring our own
  // would collide with it.
  reg('mfagent.queue.start', withQueue((o) => o.start()));
  reg('mfagent.queue.pause', withQueue((o) => o.pause()));
  reg('mfagent.queue.stop', withQueue((o) => o.stop()));
  reg('mfagent.queue.checkNow', withQueue((o) => o.runNow()));

  reg(
    'mfagent.queue.reset',
    withQueue(async (o) => {
      const pick = await vscode.window.showWarningMessage(
        'Reset every task to PENDING?',
        { modal: true, detail: 'Outputs, error logs and supervisor feedback are cleared.' },
        'Reset',
      );
      if (pick === 'Reset') {
        o.reset();
      }
    }),
  );

  reg(
    'mfagent.queue.generate',
    withQueue(async () => {
      const goal = await vscode.window.showInputBox({
        prompt: 'What should the agents build?',
        placeHolder: 'e.g. Add a REST API for invoices with auth, validation and integration tests.',
      });
      if (!goal) {
        return;
      }
      await vscode.commands.executeCommand('mfagent.queue.focus');
      queueView?.generateFromCommand(goal);
    }),
  );

  void openTaskQueue(context);
}

/** Why the queue is unavailable, for the commands that cannot show the view. */
let queueProblem: string | undefined;

/**
 * Opens the queue database and attaches it to the view.
 *
 * Safe to call again: the Retry button in the view and a folder being opened
 * both land here, and a queue that is already open is left alone.
 */
async function openTaskQueue(context: vscode.ExtensionContext): Promise<void> {
  if (queue) {
    queueView?.render();
    return;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    queueProblem =
      'No folder is open in this window. The queue is stored per workspace, in .mfagent/queue.db — open the folder you want the agents to work in.';
    output.appendLine('[queue] no workspace folder open; task queue disabled');
    queueView?.fail(queueProblem);
    return;
  }

  const dbPath = queueDbPath(root);
  try {
    queue = TaskQueue.open(dbPath);
    queueProblem = undefined;
    output.appendLine(`[queue] opened ${dbPath} via ${queue.impl}`);
  } catch (e: any) {
    queueProblem = String(e?.message ?? e);
    output.appendLine(`[queue] disabled: ${queueProblem}`);
    queueView?.fail(`${queueProblem}\n\nTried to open ${dbPath}`);
    return;
  }

  const q = queue;
  // Read by buildCoreConfig so both Chat and every queue worker see this
  // workspace's own picks — see queue/registry.ts.
  setActiveQueue(q);
  orch = new Orchestrator(context, output, q);
  context.subscriptions.push(orch);
  context.subscriptions.push({
    dispose: () => {
      setActiveQueue(undefined);
      q.close();
    },
  });

  // The chat's Planner agent writes into this same queue, so the sidebar has to
  // hear about it. Static on the panel: the chat can be closed and reopened,
  // the queue cannot.
  ChatPanel.bindQueue(q, () => queueView?.render());

  queueView?.attach(q, orch);

  // A run interrupted by a reload left tasks marked EXECUTING with no process
  // behind them; put them back in the queue before anyone reads it. Routed
  // through the orchestrator rather than the queue directly so a task that
  // keeps ending up orphaned gets escalated to the supervisor — see
  // Orchestrator.recoverOrphaned.
  if (orch.recoverOrphaned() > 0) {
    queueView?.render();
  }

  // RUNNING is stored in the database, not in this process, so a window that
  // reloads mid-run comes back saying the queue is running — and until this
  // call, saying it was the only thing it did. The cron lives in the extension
  // host and died with the old one, so nothing was armed, nothing pumped, and a
  // task left in VERIFYING sat there under a green light. Re-arm instead:
  // RUNNING means running, and the state was written precisely so an unattended
  // run could survive the host that started it.
  if (q.runState === 'RUNNING') {
    output.appendLine('[queue] a run was in progress before this window reloaded; resuming it');
    orch.start();
    queueView?.render();
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('mfagent.focusChat', () => {
    chat = ChatPanel.createOrShow(context, core, output);
  });
  reg('mfagent.newSession', () => chat?.newSession());
  reg('mfagent.openSettings', () => {
    SettingsPanel.show(context, getStore(), getModelRegistry(), output, chromiumPath);
  });
  reg('mfagent.restartCore', () => bootstrap(true, chromiumPath));

  reg('mfagent.askAboutSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Select some code first.');
      return;
    }
    const question = await vscode.window.showInputBox({
      prompt: 'What do you want to know about the selection?',
      placeHolder: 'e.g. what does this do, and where is it called from?',
    });
    if (question === undefined) {
      return;
    }
    chat = ChatPanel.createOrShow(context, core, output);
    await chat.sendPrompt(question || 'Explain the selected code.');
  });

  reg('mfagent.editSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Select the code to change first.');
      return;
    }
    const instruction = await vscode.window.showInputBox({
      prompt: 'Describe the change to make to the selection',
      placeHolder: 'e.g. extract this into a helper and add error handling',
    });
    if (!instruction) {
      return;
    }
    chat = ChatPanel.createOrShow(context, core, output);
    await chat.sendPrompt(
      `Apply this change to the selected code, editing the file directly: ${instruction}`,
    );
  });

  reg('mfagent.explainError', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file first.');
      return;
    }
    const diags = vscode.languages.getDiagnostics(editor.document.uri);
    if (diags.length === 0) {
      void vscode.window.showInformationMessage('No problems reported in this file.');
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const list = diags
      .slice(0, 25)
      .map(
        (d) =>
          `- ${rel}:${d.range.start.line + 1} [${severityName(d.severity)}] ${d.message}` +
          (d.source ? ` (${d.source})` : ''),
      )
      .join('\n');
    chat = ChatPanel.createOrShow(context, core, output);
    await chat.sendPrompt(
      `Fix the problems reported in ${rel}. Diagnostics:\n\n${list}\n\n` +
        `Read the file, work out the real cause, and apply the fix.`,
    );
  });

  reg('mfagent.openPreview', async () => {
    const url = await vscode.window.showInputBox({
      prompt: 'URL to open in the Simple Browser',
      value: 'http://localhost:3000',
      validateInput: (v) => (/^https?:\/\//.test(v) ? undefined : 'Must start with http:// or https://'),
    });
    if (!url) {
      return;
    }
    await vscode.commands.executeCommand('simpleBrowser.show', url);
  });

  reg('mfagent.showMemory', async () => {
    try {
      const stats: any = await core.request('memory/stats');
      if (!stats || stats.enabled === false) {
        void vscode.window.showInformationMessage(
          'Graph memory is disabled. Enable mfagent.memory.enabled to turn it on.',
        );
        return;
      }
      const graph: any = await core.request('memory/graph', { limit: 200 });
      const panel = vscode.window.createWebviewPanel(
        'mfagent.memory',
        'MF Agent — Graph Memory',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = memoryHtml(stats, graph);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not read memory: ${e?.message ?? e}`);
    }
  });

  reg('mfagent.searchMemory', async () => {
    const query = await vscode.window.showInputBox({
      prompt: 'Search the graph memory',
      placeHolder: 'e.g. authentication, why we chose X, payment flow',
    });
    if (!query) {
      return;
    }
    try {
      const hits: any[] = (await core.request('memory/search', { query, limit: 20 })) ?? [];
      if (hits.length === 0) {
        void vscode.window.showInformationMessage('Nothing in memory matches that.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        hits.map((h) => ({
          label: `$(symbol-structure) ${h.node.name}`,
          description: h.node.kind,
          detail: h.node.summary || h.why,
          hit: h,
        })),
        { title: `Graph memory — ${hits.length} result(s)`, matchOnDetail: true },
      );
      if (pick) {
        chat = ChatPanel.createOrShow(context, core, output);
        await chat.sendPrompt(
          `Use memory_trace on the entity "${pick.hit.node.name}" and explain what you find.`,
        );
      }
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Search failed: ${e?.message ?? e}`);
    }
  });

  reg('mfagent.showMcpStatus', async () => {
    try {
      const list: any[] = (await core.request('mcp/status')) ?? [];
      if (list.length === 0) {
        void vscode.window.showInformationMessage(
          'No MCP servers configured. Add them under mfagent.mcpServers.',
        );
        return;
      }
      await vscode.window.showQuickPick(
        list.map((s) => ({
          label: s.error ? `$(error) ${s.name}` : `$(check) ${s.name}`,
          description: s.error ? s.error : `${(s.tools ?? []).length} tools`,
          detail: (s.tools ?? []).join(', '),
        })),
        { title: 'MCP servers' },
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Could not read MCP status: ${e?.message ?? e}`);
    }
  });

  reg('mfagent.registerMcpServers', async () => {
    const mcpBin = resolveMcpBinary(context);
    if (!mcpBin) {
      void vscode.window.showErrorMessage(
        `mfagent-mcp binary not found. Build it first: cd core && go build -o ../bin/ ./cmd/mfagent-mcp`,
      );
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      void vscode.window.showErrorMessage('Open a workspace folder first — registration is project-scoped.');
      return;
    }

    // The project-root `.mcp.json` is the shared standard: Claude Code, Cursor
    // and the VS Code Agent Host all read it natively, so writing it here (and
    // merging with anything already in it) covers every JSON-configured client
    // without depending on a CLI being on PATH. VS Code itself sees the server
    // through `registerMcpProvider` at activation, so this file is only for
    // tools outside the editor.
    const file = writeProjectMcpJson(folder, mcpBin);

    // Codex keeps its MCP servers in ~/.codex/config.toml, which has no JSON
    // equivalent, so it still gets its own `codex mcp add` line. Running it in
    // a visible terminal means an uninstalled CLI just prints "command not
    // found" instead of this command having to guess at PATH resolution.
    const term = vscode.window.createTerminal({
      name: 'MF Agent: MCP Setup',
      cwd: folder,
      iconPath: new vscode.ThemeIcon('plug'),
    });
    term.show();
    term.sendText(`codex mcp add mfagent-task-queue -- "${mcpBin}" --workspace "${folder}"`);

    void vscode.window.showInformationMessage(
      `Wrote ${vscode.workspace.asRelativePath(file)} — Claude Code, Cursor and other .mcp.json tools ` +
        'will offer "mfagent-task-queue" (approve it once when prompted). A "codex mcp add" command was ' +
        'sent to the terminal for Codex. VS Code and Copilot Chat see the server automatically.',
    );
  });

  reg('mfagent.copyMcpConfig', async () => {
    const mcpBin = resolveMcpBinary(context);
    if (!mcpBin) {
      const searched = [
        path.join(context.extensionPath, 'bin', process.platform === 'win32' ? 'mfagent-mcp.exe' : 'mfagent-mcp'),
        path.join(context.extensionPath, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'mfagent-mcp.exe' : 'mfagent-mcp'),
      ];
      void vscode.window.showErrorMessage(
        `mfagent-mcp binary not found. Build it first: cd core && go build -o ../bin/ ./cmd/mfagent-mcp\n\nSearched:\n${searched.join('\n')}`,
      );
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '${workspaceFolder}';
    const config = {
      mcpServers: {
        'mfagent-task-queue': {
          type: 'stdio',
          command: mcpBin,
          args: ['--workspace', workspaceRoot],
        },
      },
    };

    const json = JSON.stringify(config, null, 2);
    await vscode.env.clipboard.writeText(json);

    const pick = await vscode.window.showInformationMessage(
      'Task Queue MCP JSON copied. VS Code and Copilot Chat already see this server automatically; ' +
        'use this for a JSON-configured MCP client (e.g. Kilo/other) or to hand-edit a .mcp.json / ' +
        '.vscode/mcp.json file.',
      'Show config',
    );
    if (pick === 'Show config') {
      const doc = await vscode.workspace.openTextDocument({
        content: `// Any JSON-configured MCP client (e.g. Kilo) — or paste into
// .mcp.json (project root) or .vscode/mcp.json.
//
// If the workspace path changes per project, remove the --workspace arg
// and the server will use the current working directory.
//
// Claude Code / Cursor read the project-root .mcp.json that
// "MF Agent: Register Task Queue MCP Server" writes for you; VS Code and
// Copilot Chat see the server automatically at activation.

${json}
`,
        language: 'jsonc',
      });
      await vscode.window.showTextDocument(doc);
    }
  });

  reg('mfagent.installSkillPack', async () => {
    const repo = await vscode.window.showInputBox({
      prompt: 'Skill pack to install (GitHub shorthand or URL)',
      placeHolder: 'e.g. WordPress/agent-skills',
      validateInput: (v) => (v.trim() ? undefined : 'Required'),
    });
    if (!repo) {
      return;
    }
    const skill = await vscode.window.showInputBox({
      prompt: 'Specific skill to install (optional — leave blank to pick interactively in the terminal)',
      placeHolder: 'e.g. wp-plugin-development',
    });

    // The CLI has no generic or MF-Agent-specific install target — it only
    // writes to one of its own known agents' folders (see SKILL_INSTALL_AGENTS
    // and the matching read side, globalSkillsDirs, in skills.ts) — so this
    // extension has to name one. Asking rather than hardcoding claude-code
    // means installing a skill pack never implies Claude Code has to be on
    // this machine.
    const agent = await vscode.window.showQuickPick(
      SKILL_INSTALL_AGENTS.map((a) => ({ label: a.label, id: a.id })),
      { title: 'Install for which agent? (any is discovered the same way afterward)' },
    );
    if (!agent) {
      return;
    }

    // -g is what puts it in that agent's *global* skills folder rather than
    // this workspace's own — the one discoverInstalledSkills() (src/skills.ts)
    // reads, which is what makes it show up, with its own checkbox, in every
    // workspace's Task Queue. -y is only added once a specific skill is
    // named: with a bare repo, the CLI's own interactive picker is how you
    // choose among a multi-skill pack.
    let cmd = `npx skills add "${repo.trim()}" -g -a ${agent.id}`;
    if (skill?.trim()) {
      cmd += ` --skill "${skill.trim()}" -y`;
    }

    const term = vscode.window.createTerminal({
      name: 'MF Agent: Install Skill',
      iconPath: new vscode.ThemeIcon('gift'),
    });
    term.show();
    term.sendText(cmd);

    void vscode.window.showInformationMessage(
      "Once it finishes, open the Task Queue's Context tab — installed skill packs appear there automatically with their own checkbox, no reload needed.",
    );
  });

  reg('mfagent.generateDocumentation', async () => {
    const scope = await vscode.window.showQuickPick(
      [
        { label: 'Whole project', description: 'Document the entire workspace' },
        { label: 'Specific module', description: 'Document a subdirectory or module' },
      ],
      { title: 'Generate Documentation — choose scope' },
    );
    if (!scope) {
      return;
    }

    let projectPath: string | undefined;
    if (scope.label === 'Specific module') {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        void vscode.window.showErrorMessage('No workspace folder is open.');
        return;
      }
      const root = folders[0].uri.fsPath;
      const uri = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(root),
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Select module to document',
      });
      if (!uri || uri.length === 0) {
        return;
      }
      projectPath = uri[0].fsPath;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating documentation…',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Analysing project and generating markdown…' });

          const input: any = {};
          if (projectPath) {
            input.project_path = projectPath;
          }

          const result: any = await core.request('tools/invoke', {
            name: 'docgen_generate',
            input,
          });

          if (result.isError) {
            void vscode.window.showErrorMessage(
              `Documentation generation failed: ${result.output}`,
            );
            return;
          }

          progress.report({ message: 'Assembling .docx…' });

          const folders = vscode.workspace.workspaceFolders;
          if (!folders || folders.length === 0) {
            void vscode.window.showErrorMessage('No workspace folder is open.');
            return;
          }

          const root = folders[0].uri.fsPath;
          const manifestPath = path.join(root, '.mfagent', 'docgen', 'manifest.json');
          const docxPath = path.join(root, '.mfagent', 'docgen', 'documentation.docx');

          const scriptsDir = path.join(context.extensionPath, 'scripts');
          const docxGenScript = path.join(scriptsDir, 'docx-gen.py');

          await new Promise<void>((resolve, reject) => {
            const child = cp.spawn('python', [docxGenScript, '--manifest', manifestPath, '--output', docxPath], {
              cwd: root,
              env: { ...process.env },
              windowsHide: true,
            });

            let stderr = '';
            child.stderr.on('data', (d: Buffer) => {
              stderr += d.toString();
            });

            child.on('error', (err) => {
              reject(new Error(`Could not start python: ${err.message}`));
            });

            child.on('exit', (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(
                  new Error(
                    `docx-gen.py exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`,
                  ),
                );
              }
            });
          });

          const docxUri = vscode.Uri.file(docxPath);
          await vscode.env.openExternal(docxUri);

          void vscode.window.showInformationMessage(
            `Documentation saved to ${docxPath}`,
          );
        },
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(
        `Documentation generation failed: ${e?.message ?? e}`,
      );
    }
  });
}

function severityName(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A read-only view of what the agent has learned about this workspace. */
function memoryHtml(stats: any, graph: any): string {
  const byKind = Object.entries(stats.byKind ?? {})
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="n">${v}</td></tr>`)
    .join('');
  const byRel = Object.entries(stats.byRel ?? {})
    .map(([k, v]) => `<tr><td><code>${escapeHtml(k)}</code></td><td class="n">${v}</td></tr>`)
    .join('');

  const nodeName = new Map<number, string>(
    (graph.nodes ?? []).map((n: any) => [n.id, n.name]),
  );
  const edges = (graph.edges ?? [])
    .map(
      (e: any) =>
        `<tr><td>${escapeHtml(nodeName.get(e.src) ?? String(e.src))}</td>` +
        `<td><code>${escapeHtml(e.rel)}</code></td>` +
        `<td>${escapeHtml(nodeName.get(e.dst) ?? String(e.dst))}</td></tr>`,
    )
    .join('');

  const nodes = (graph.nodes ?? [])
    .map(
      (n: any) =>
        `<tr><td><span class="kind">${escapeHtml(n.kind)}</span></td>` +
        `<td><strong>${escapeHtml(n.name)}</strong></td>` +
        `<td>${escapeHtml(n.summary ?? '')}</td>` +
        `<td class="n">${n.hits ?? 0}</td></tr>`,
    )
    .join('');

  return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 16px 20px; line-height: 1.5; }
  h1 { font-size: 1.3em; margin: 0 0 4px; }
  h2 { font-size: 1em; margin: 22px 0 6px; color: var(--vscode-descriptionForeground);
       text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 4px; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 4px; }
  .card { background: var(--vscode-editorWidget-background);
          border: 1px solid var(--vscode-panel-border); border-radius: 6px;
          padding: 10px 14px; min-width: 96px; }
  .card .v { font-size: 1.5em; font-weight: 600; }
  .card .l { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td, th { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border);
           text-align: left; vertical-align: top; }
  td.n { text-align: right; color: var(--vscode-descriptionForeground); width: 1%; }
  code { font-family: var(--vscode-editor-font-family); font-size: .92em;
         background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .kind { font-size: 10px; padding: 1px 6px; border-radius: 9px;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
          white-space: nowrap; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; }
  .wrap { overflow-x: auto; }
</style></head><body>
  <h1>Graph memory</h1>
  <div class="sub"><code>${escapeHtml(stats.path ?? '')}</code></div>

  <div class="cards">
    <div class="card"><div class="v">${stats.nodes ?? 0}</div><div class="l">entities</div></div>
    <div class="card"><div class="v">${stats.edges ?? 0}</div><div class="l">relations</div></div>
    <div class="card"><div class="v">${stats.observations ?? 0}</div><div class="l">observations</div></div>
    <div class="card"><div class="v">${Math.round((stats.sizeBytes ?? 0) / 1024)}</div><div class="l">KiB on disk</div></div>
  </div>

  <div class="grid">
    <div>
      <h2>By entity kind</h2>
      <div class="wrap"><table>${byKind || '<tr><td class="empty">nothing yet</td></tr>'}</table></div>
    </div>
    <div>
      <h2>By relation</h2>
      <div class="wrap"><table>${byRel || '<tr><td class="empty">nothing yet</td></tr>'}</table></div>
    </div>
  </div>

  <h2>Relations</h2>
  <div class="wrap"><table>${edges || '<tr><td class="empty">no relations recorded yet</td></tr>'}</table></div>

  <h2>Entities</h2>
  <div class="wrap"><table>
    <tr><th>kind</th><th>name</th><th>summary</th><th class="n">hits</th></tr>
    ${nodes || '<tr><td class="empty" colspan="4">no entities recorded yet</td></tr>'}
  </table></div>
</body></html>`;
}

export function deactivate(): void {
  core?.dispose();
}
