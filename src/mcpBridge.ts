import * as vscode from 'vscode';
import type { CoreClient } from './core';
import { resolveMcpBinary } from './detect';
import { buildToolTree, defaultEnabledTools, ToolGroup } from './editorTools';
import {
  DiscoveredMcpServer,
  discoverMcpServers,
  MCP_PROVIDER_ID,
  MCP_SERVER_LABEL,
  readUserMcpServers,
} from './mcp';
import type { ProfileStore } from './providers/store';
import { getActiveQueue } from './queue/registry';

/**
 * The bridge between this extension's MCP world and VS Code's.
 *
 * It runs in both directions.
 *
 * Outward, every MCP server this extension knows about — the bundled task
 * queue server, the ones defined on the settings page, the `mfagent.mcpServers`
 * setting — is published to the editor through
 * `vscode.lm.registerMcpServerDefinitionProvider`, so VS Code's own MCP
 * engine can run them: they appear in the MCP Servers view, Copilot Chat can
 * use their tools, and their tools land in `vscode.lm.tools` like any other.
 * A server that keeps its API key in the keychain gets it injected in
 * `resolveMcpServerDefinition`, which the editor calls only when it is about
 * to start the process — the key never sits in the listing.
 *
 * Inward, `vscode.lm.tools` — every language-model tool registered by any
 * extension, MCP-backed or not — is offered to the Go core. The core cannot
 * see that API, so the tool *definitions* travel in its initialize payload
 * (see providers/payload.ts) and each *call* comes back here over JSON-RPC
 * as `lm/invokeTool`, the same way file writes and terminal commands already
 * do. Which tools a workspace's agents get is chosen on the Task Queue's
 * Context tab, from the grouped picker editorTools.ts builds — the editor can
 * offer a hundred of them, and every definition a workspace switches on is
 * paid for in every request its agents make, so the picker starts from the
 * four built-in sets an agent actually needs (read, search, edit, execute)
 * and leaves the rest to be asked for.
 */

export interface EditorToolDef {
  name: string;
  description: string;
  inputSchema: object;
  tags: string[];
}


/** Task-queue server version, bumped when its tools change shape. */
const QUEUE_SERVER_VERSION = '0.2.0';

export class McpBridge implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subs: vscode.Disposable[] = [];
  /** The servers behind the definitions last handed out, by label. */
  private published = new Map<string, DiscoveredMcpServer>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ProfileStore,
    private readonly output: vscode.OutputChannel,
  ) {
    this.subs.push(
      vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: this.changed.event,
        provideMcpServerDefinitions: () => this.definitions(),
        resolveMcpServerDefinition: (server) => this.resolve(server),
      }),
      store.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mfagent.mcpServers')) {
          this.changed.fire();
        }
      }),
      this.changed,
    );
  }

  // ---- outward: servers for the editor ---------------------------------

  private definitions(): vscode.McpServerDefinition[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const out: vscode.McpServerDefinition[] = [];
    this.published = new Map();

    const bin = resolveMcpBinary(this.context);
    if (bin) {
      const def = new vscode.McpStdioServerDefinition(
        MCP_SERVER_LABEL,
        bin,
        root ? ['--workspace', root] : [],
        undefined,
        QUEUE_SERVER_VERSION,
      );
      if (root) {
        def.cwd = vscode.Uri.file(root);
      }
      out.push(def);
    }

    // The user's own mcp.json is already VS Code's: republishing those would
    // run every one of them twice, and so would publishing a server defined
    // here under the same name — the settings page's copy of a file server,
    // made to give it a key, is for the core, not for the editor.
    const editorHas = new Set(readUserMcpServers(this.context).map((s) => s.name));
    for (const s of discoverMcpServers(this.context, this.store)) {
      if (s.source === 'user' || editorHas.has(s.name) || s.enabled === false) {
        continue;
      }
      if (s.command) {
        const def = new vscode.McpStdioServerDefinition(s.name, s.command, s.args ?? [], s.env ?? {});
        if (root) {
          def.cwd = vscode.Uri.file(root);
        }
        out.push(def);
        this.published.set(s.name, s);
      } else if (s.url) {
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(s.url, true);
        } catch {
          this.output.appendLine(`[mcp] skipping ${s.name}: "${s.url}" is not a valid URL`);
          continue;
        }
        out.push(new vscode.McpHttpServerDefinition(s.name, uri, s.headers ?? {}));
        this.published.set(s.name, s);
      }
    }
    return out;
  }

  /**
   * Puts a keychain key where its server expects it, right before the editor
   * starts that server. Every other definition is returned as it was.
   */
  private async resolve(server: vscode.McpServerDefinition): Promise<vscode.McpServerDefinition> {
    const src = this.published.get(server.label);
    const def = src?.source === 'store' && src.id ? this.store.mcpServer(src.id) : undefined;
    const keyName = def?.keyName?.trim();
    if (!def || !keyName) {
      return server;
    }
    const key = await this.store.getMcpKey(def.id);
    if (!key) {
      return server;
    }
    if (server instanceof vscode.McpHttpServerDefinition) {
      server.headers = { ...server.headers, [keyName]: `${def.keyPrefix ?? ''}${key}` };
    } else {
      server.env = { ...server.env, [keyName]: key };
    }
    return server;
  }

  // ---- inward: editor tools for the core -------------------------------

  /**
   * The tool names in force for the active workspace: the pick stored on its
   * queue, or — while it has never made one — the defaults from editorTools.ts,
   * so a fresh workspace's agents can read, search, edit and run without
   * anyone visiting the Context tab first.
   */
  enabledToolNames(): string[] {
    const queue = getActiveQueue();
    if (queue?.hasEditorToolChoice) {
      return queue.enabledEditorTools;
    }
    return defaultEnabledTools(vscode.lm.tools, this.serverNames());
  }

  /** Everything `vscode.lm.tools` offers, grouped for the Context tab's picker. */
  tree(): ToolGroup[] {
    return buildToolTree(vscode.lm.tools, new Set(this.enabledToolNames()), this.serverNames());
  }

  /** The pick a workspace starts with, for the picker's "Defaults" button. */
  defaultToolNames(): string[] {
    return defaultEnabledTools(vscode.lm.tools, this.serverNames());
  }

  /** The names of the MCP servers this extension knows about, for group labels. */
  private serverNames(): string[] {
    try {
      return discoverMcpServers(this.context, this.store).map((s) => s.name);
    } catch {
      return [];
    }
  }

  /** The tools the active workspace has switched on, as the core's config wants them. */
  editorToolDefs(): EditorToolDef[] {
    const enabled = new Set(this.enabledToolNames());
    if (enabled.size === 0) {
      return [];
    }
    return vscode.lm.tools
      .filter((t) => enabled.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        tags: [...t.tags],
      }));
  }

  /**
   * A compact account of the editor tools an agent will have, for a planning
   * prompt: enough to plan around them, not enough to crowd out the plan.
   */
  toolsSummary(limit = 40): string {
    const defs = this.editorToolDefs();
    if (defs.length === 0) {
      return '';
    }
    const lines = defs.slice(0, limit).map((t) => `- editor__${sanitize(t.name)}: ${clip(t.description, 140)}`);
    if (defs.length > limit) {
      lines.push(`- (${defs.length - limit} more)`);
    }
    return lines.join('\n');
  }

  /** Registers the callback a core uses to run one of those tools. */
  attach(client: CoreClient): void {
    client.onRequest('lm/invokeTool', async (params: { name?: string; input?: unknown }) => {
      const name = String(params?.name ?? '');
      const input = params?.input && typeof params.input === 'object' ? params.input : {};
      try {
        const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
        return { output: flatten(result), isError: false };
      } catch (e: unknown) {
        return { output: `${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    });
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
  }
}

/** Mirrors `sanitize` in core/cmd/mfcore/main.go, so a name shown here is the name the model sees. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** A tool result as text — the only form the core's tool protocol carries. */
function flatten(result: vscode.LanguageModelToolResult): string {
  const bits: string[] = [];
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      bits.push(part.value);
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (/^(text\/|application\/json)/.test(part.mimeType)) {
        bits.push(Buffer.from(part.data).toString('utf8'));
      } else {
        bits.push(`[${part.mimeType}, ${part.data.byteLength} bytes]`);
      }
    } else if (part instanceof vscode.LanguageModelPromptTsxPart) {
      bits.push(JSON.stringify(part.value));
    } else if (part !== undefined && part !== null) {
      bits.push(typeof part === 'string' ? part : JSON.stringify(part));
    }
  }
  return bits.join('\n');
}

// ---- process-wide handle -------------------------------------------------

let bridge: McpBridge | undefined;

export function initBridge(
  context: vscode.ExtensionContext,
  store: ProfileStore,
  output: vscode.OutputChannel,
): McpBridge {
  bridge = new McpBridge(context, store, output);
  return bridge;
}

export function getBridge(): McpBridge {
  if (!bridge) {
    throw new Error('MF Agent: the MCP bridge was read before activation finished.');
  }
  return bridge;
}
