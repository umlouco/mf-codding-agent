import * as vscode from 'vscode';
import { Detected, clearLanguageCache, detect, detectLanguages } from '../detect';
import { PROVIDERS, providerOrFallback } from '../providers/catalog';
import { ModelList, ModelRegistry } from '../providers/models';
import { ROLES, ROLE_LABELS, Role, ProfileStore } from '../providers/store';
import { testClaudeCliBinary } from '../queue/claudeCli';

/**
 * The MF Agent settings page.
 *
 * One place to set up providers, models and roles, so that configuring the
 * extension never means hand-editing JSON. Model lists come from the providers
 * themselves and API keys go to the OS keychain; nothing on this page is
 * mirrored into `settings.json`.
 *
 * Same house style as the chat and queue views: a plain webview, hand-written
 * HTML/CSS/JS, no framework.
 */
export class SettingsPanel {
  public static readonly viewType = 'mfagent.settings';
  private static current: SettingsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private chromium: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly store: ProfileStore,
    private readonly models: ModelRegistry,
    private readonly output: vscode.OutputChannel,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
    panel.webview.html = this.html(panel.webview);
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      // Anything that changes the config elsewhere (a migration, another
      // window) should be reflected here rather than silently diverge.
      store.onDidChange(() => void this.pushState()),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(
    context: vscode.ExtensionContext,
    store: ProfileStore,
    models: ModelRegistry,
    output: vscode.OutputChannel,
    chromium?: string,
  ): SettingsPanel {
    if (SettingsPanel.current) {
      SettingsPanel.current.chromium = chromium ?? SettingsPanel.current.chromium;
      SettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return SettingsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'MF Agent Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SettingsPanel.current = new SettingsPanel(panel, context, store, models, output);
    SettingsPanel.current.chromium = chromium;
    return SettingsPanel.current;
  }

  /** Lets `activate` hand over the Chromium path once auto-detection finishes. */
  static setChromium(path: string | undefined): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.chromium = path;
      void SettingsPanel.current.pushState();
    }
  }

  dispose(): void {
    SettingsPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ---- messages --------------------------------------------------------

  private async onMessage(msg: any): Promise<void> {
    try {
      switch (msg?.type) {
        case 'ready':
          await this.pushState();
          void this.warmModelLists();
          break;

        case 'addProfile': {
          const profile = await this.store.addProfile(String(msg.providerId));
          await this.pushState(profile.id);
          void this.loadModels(profile.id, false);
          break;
        }
        case 'updateProfile': {
          const patch = msg.patch ?? {};
          await this.store.updateProfile(String(msg.id), patch);
          // Retargeting the endpoint invalidates the model list; a rename does
          // not, so only re-fetch when it can actually have changed.
          if ('providerId' in patch || 'baseURL' in patch) {
            void this.loadModels(String(msg.id), false);
          }
          break;
        }
        case 'duplicateProfile': {
          const copy = await this.store.duplicateProfile(String(msg.id));
          await this.pushState(copy?.id);
          break;
        }
        case 'removeProfile': {
          const profile = this.store.profile(String(msg.id));
          const pick = await vscode.window.showWarningMessage(
            `Delete the provider "${profile?.name ?? msg.id}"?`,
            { modal: true, detail: 'Its API key is removed from the keychain too.' },
            'Delete',
          );
          if (pick === 'Delete') {
            await this.store.removeProfile(String(msg.id));
            await this.pushState();
          }
          break;
        }

        case 'setApiKey':
          await this.store.setApiKey(String(msg.id), String(msg.key ?? ''));
          await this.pushState(String(msg.id));
          void this.loadModels(String(msg.id), true);
          break;

        case 'testProfile': {
          const profile = this.store.profile(String(msg.id));
          if (!profile) {
            break;
          }
          const def = providerOrFallback(profile.providerId);
          this.post({ type: 'testing', profileId: profile.id });
          // Not an HTTP endpoint — nothing to ping. The one thing that
          // actually varies machine-to-machine is whether the binary
          // resolves at all.
          const result =
            def.kind === 'claude-cli'
              ? await testClaudeCliBinary(profile.extra?.cliPath)
              : await this.models.test(profile.providerId, profile.baseURL, await this.store.effectiveApiKey(profile.id, def));
          this.post({ type: 'testResult', profileId: profile.id, ...result });
          break;
        }

        case 'refreshModels':
          await this.loadModels(String(msg.id), true);
          break;

        case 'setRole':
          await this.store.setRole(String(msg.role) as Role, {
            profileId: String(msg.profileId ?? ''),
            model: String(msg.model ?? ''),
            effort: String(msg.effort ?? ''),
          });
          break;

        case 'setLanguages':
          await this.store.update({
            languages: {
              auto: !!msg.auto,
              list: Array.isArray(msg.list) ? msg.list.map(String) : [],
            },
          });
          break;

        case 'addSkill': {
          const skill = await this.store.addSkill(String(msg.name ?? ''));
          await this.pushState(undefined, skill.id);
          break;
        }
        case 'updateSkill':
          await this.store.updateSkill(String(msg.id), msg.patch ?? {});
          await this.pushState();
          break;
        case 'removeSkill': {
          const skill = this.store.skill(String(msg.id));
          const pick = await vscode.window.showWarningMessage(
            `Delete the skill "${skill?.name ?? msg.id}"?`,
            { modal: true, detail: 'It is also removed from any skill group that includes it.' },
            'Delete',
          );
          if (pick === 'Delete') {
            await this.store.removeSkill(String(msg.id));
            await this.pushState();
          }
          break;
        }

        case 'addSkillGroup':
          await this.store.addSkillGroup(String(msg.name ?? ''));
          await this.pushState();
          break;
        case 'updateSkillGroup':
          await this.store.updateSkillGroup(String(msg.id), msg.patch ?? {});
          await this.pushState();
          break;
        case 'removeSkillGroup':
          await this.store.removeSkillGroup(String(msg.id));
          await this.pushState();
          break;

        case 'addMcpServer': {
          const server = await this.store.addMcpServer(String(msg.name ?? ''));
          await this.pushState(undefined, undefined, server.id);
          break;
        }
        case 'updateMcpServer':
          await this.store.updateMcpServer(String(msg.id), msg.patch ?? {});
          await this.pushState();
          break;
        case 'removeMcpServer': {
          const server = this.store.mcpServer(String(msg.id));
          const pick = await vscode.window.showWarningMessage(
            `Delete the MCP server "${server?.name ?? msg.id}"?`,
            { modal: true, detail: 'Its key is removed from the keychain too.' },
            'Delete',
          );
          if (pick === 'Delete') {
            await this.store.removeMcpServer(String(msg.id));
            await this.pushState();
          }
          break;
        }
        case 'setMcpKey':
          await this.store.setMcpKey(String(msg.id), String(msg.key ?? ''));
          await this.pushState(undefined, undefined, String(msg.id));
          break;

        case 'setHeadless':
          await this.store.update({ browser: { headless: !!msg.headless } });
          break;

        case 'rescanLanguages':
          clearLanguageCache();
          await this.pushState();
          this.toast('info', 'Rescanned the workspace.');
          break;

        case 'export':
          await this.exportSettings();
          break;
        case 'import':
          await this.importSettings();
          break;

        case 'openExternal':
          await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
          break;
        case 'openVsSettings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@ext:mflores.mf-agent',
          );
          break;
        case 'restartCore':
          await vscode.commands.executeCommand('mfagent.restartCore');
          this.toast('info', 'Core restarted.');
          break;
        case 'showLog':
          this.output.show();
          break;
      }
    } catch (e: any) {
      this.output.appendLine(`[settings] ${msg?.type} failed: ${e?.message ?? e}`);
      this.toast('error', String(e?.message ?? e));
    }
  }

  // ---- state -----------------------------------------------------------

  private async pushState(
    selectProfileId?: string,
    selectSkillId?: string,
    selectMcpId?: string,
  ): Promise<void> {
    const settings = this.store.settings;
    const detectedLanguages = await detectLanguages();
    const detected: Detected = await detect(this.context, detectedLanguages, this.chromium);

    this.post({
      type: 'state',
      settings,
      selectProfileId,
      selectSkillId,
      selectMcpId,
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        group: p.group,
        kind: p.kind,
        defaultBaseURL: p.defaultBaseURL,
        baseURLEditable: p.baseURLEditable,
        baseURLRequired: !!p.baseURLRequired,
        apiKey: p.apiKey,
        apiKeyEnv: p.apiKeyEnv ?? [],
        listStyle: p.listStyle,
        serves: p.serves,
        rolesAllowed: p.rolesAllowed,
        extraFields: p.extraFields ?? [],
        docsURL: p.docsURL,
        notes: p.notes,
      })),
      roles: ROLES.map((r) => ({ id: r, ...ROLE_LABELS[r] })),
      keyStatus: await this.store.keyStatus(),
      mcpKeyStatus: await this.store.mcpKeyStatus(),
      cachedModels: Object.fromEntries(
        settings.profiles.map((p) => [
          p.id,
          this.models.peek(p.providerId, p.baseURL) ?? { models: [], fetchedAt: 0 },
        ]),
      ),
      detected,
    });
  }

  /** Fetch model lists for every configured profile, pushing each as it lands. */
  private async warmModelLists(): Promise<void> {
    await Promise.all(this.store.profiles.map((p) => this.loadModels(p.id, false)));
  }

  private async loadModels(profileId: string, force: boolean): Promise<void> {
    const profile = this.store.profile(profileId);
    if (!profile) {
      return;
    }
    const def = providerOrFallback(profile.providerId);
    // A provider that needs a key it does not have will only ever 401; say so
    // instead of burning a request and showing a confusing HTTP error.
    if (def.apiKey === 'required') {
      const key = await this.store.effectiveApiKey(profile.id, def);
      if (!key) {
        this.post({
          type: 'models',
          profileId,
          list: { models: [], fetchedAt: 0, error: 'Add an API key to list models.' },
        });
        return;
      }
    }

    this.post({ type: 'modelsLoading', profileId });
    const key = await this.store.effectiveApiKey(profile.id, def);
    const list: ModelList = await this.models.list(profile.providerId, profile.baseURL, key, force);
    this.post({ type: 'models', profileId, list });
  }

  // ---- export / import -------------------------------------------------

  private async exportSettings(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Without API keys', detail: 'Safe to commit or share.', keys: false },
        { label: 'With API keys', detail: 'Treat the file as a secret.', keys: true },
      ],
      { title: 'Export MF Agent provider setup' },
    );
    if (!pick) {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: 'Export MF Agent provider setup',
      defaultUri: vscode.Uri.file('mfagent-providers.json'),
      filters: { JSON: ['json'] },
    });
    if (!target) {
      return;
    }
    const json = await this.store.exportJson(pick.keys);
    await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
    this.toast('info', `Exported to ${target.fsPath}`);
  }

  private async importSettings(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: 'Import MF Agent provider setup',
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    const file = picked?.[0];
    if (!file) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      'Replace the current provider setup with the imported one?',
      { modal: true, detail: 'Existing profiles and role assignments are overwritten.' },
      'Import',
    );
    if (confirm !== 'Import') {
      return;
    }
    const raw = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    await this.store.importJson(raw);
    await this.pushState();
    void this.warmModelLists();
    this.toast('info', 'Imported.');
  }

  // ---- plumbing --------------------------------------------------------

  private toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.post({ type: 'toast', level, text });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'settings.css'),
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'settings.js'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
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
<title>MF Agent Settings</title>
</head>
<body>
  <div id="toast" hidden></div>

  <header class="page">
    <div>
      <h1>MF Agent</h1>
      <p class="sub">Providers, models and roles. Nothing here is stored in <code>settings.json</code>.</p>
    </div>
    <div class="head-actions">
      <button id="exportBtn" class="ghost">Export…</button>
      <button id="importBtn" class="ghost">Import…</button>
    </div>
  </header>

  <nav id="tabs">
    <button class="tab active" data-tab="providers">Providers</button>
    <button class="tab" data-tab="roles">Roles</button>
    <button class="tab" data-tab="skills">Skills</button>
    <button class="tab" data-tab="mcp">MCP Servers</button>
    <button class="tab" data-tab="workspace">Workspace</button>
    <button class="tab" data-tab="detected">Detected</button>
  </nav>

  <section class="panel" data-panel="providers">
    <div class="split">
      <aside class="list-col">
        <div id="profileList" class="profile-list"></div>
        <div class="add-row">
          <select id="addProvider" aria-label="Provider to add"></select>
          <button id="addBtn">Add</button>
        </div>
      </aside>
      <div id="profileEditor" class="editor-col"></div>
    </div>
  </section>

  <section class="panel" data-panel="roles" hidden>
    <p class="hint">
      Each role picks a provider and a model. Leave a role on <em>Same as Coding</em>
      to follow the coding model. Embedding is the exception — it needs a real
      embeddings model, so it never inherits.
    </p>
    <div id="roleList" class="role-list"></div>
  </section>

  <section class="panel" data-panel="skills" hidden>
    <p class="hint">
      A skill is a block of instruction text the agent can be given — conventions, a
      checklist, domain knowledge for one kind of project. Group skills and pick which
      groups apply to a project from the Task Queue view's Context tab.
    </p>
    <div class="split">
      <aside class="list-col">
        <div id="skillList" class="profile-list"></div>
        <div class="add-row">
          <button id="addSkillBtn">Add skill</button>
        </div>
      </aside>
      <div id="skillEditor" class="editor-col"></div>
    </div>
    <div id="skillGroups" class="skill-groups"></div>
  </section>

  <section class="panel" data-panel="mcp" hidden>
    <p class="hint">
      An MCP server defined here can carry an API key: the key goes to the OS keychain and is put
      back into the server's environment or headers only when the server starts — never into a
      file. Servers from your VS Code user <code>mcp.json</code> and the <code>mfagent.mcpServers</code>
      setting are picked up as well. Every server is offered to the agent core and published to
      VS Code's own MCP engine; choose which are active for a project from the Task Queue view's
      Context tab.
    </p>
    <div class="split">
      <aside class="list-col">
        <div id="mcpList" class="profile-list"></div>
        <div class="add-row">
          <button id="addMcpBtn">Add server</button>
        </div>
      </aside>
      <div id="mcpEditor" class="editor-col"></div>
    </div>
  </section>

  <section class="panel" data-panel="workspace" hidden>
    <div id="workspacePanel"></div>
  </section>

  <section class="panel" data-panel="detected" hidden>
    <p class="hint">
      Worked out automatically from the workspace and the installed extension.
      These are not settings — there is nothing to fill in.
    </p>
    <div id="detectedPanel"></div>
  </section>

  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
