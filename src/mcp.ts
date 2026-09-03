import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveMcpBinary } from './detect';

/** Must match the `mcpServerDefinitionProviders` entry in package.json. */
export const MCP_PROVIDER_ID = 'mf-agent.mcp-servers';
export const MCP_SERVER_LABEL = 'MF Agent Task Queue';
export const MCP_SERVER_NAME = 'mfagent-task-queue';

/**
 * Makes the task-queue MCP server visible to VS Code's native MCP system: the
 * Extensions view "MCP SERVERS" list, GitHub Copilot Chat, and any extension
 * that reads the editor's MCP registry. This is the mechanism the VS Code
 * "MCP developer guide" prescribes for extensions.
 *
 * Standalone tools (Claude Code, Cursor, etc.) do not read VS Code's registry,
 * so they are covered separately by a project-root `.mcp.json` — see
 * `writeProjectMcpJson`.
 *
 * `registerMcpServerDefinitionProvider` shipped in VS Code 1.99; on older
 * editors the whole registration is skipped and only the JSON-based paths
 * remain.
 */
export function registerMcpProvider(context: vscode.ExtensionContext): void {
  const register = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof register !== 'function') {
    return;
  }

  context.subscriptions.push(
    register(MCP_PROVIDER_ID, {
      provideMcpServerDefinitions: (): vscode.McpServerDefinition[] => {
        const bin = resolveMcpBinary(context);
        if (!bin) {
          return [];
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const def = new vscode.McpStdioServerDefinition(
          MCP_SERVER_LABEL,
          bin,
          root ? ['--workspace', root] : [],
          undefined,
          '0.1.0',
        );
        if (root) {
          def.cwd = vscode.Uri.file(root);
        }
        return [def];
      },
    }),
  );
}

// ---- discovery -----------------------------------------------------------

/** One MCP server as the Go core's config expects it, plus where it came from. */
export interface DiscoveredMcpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 'user' = VS Code's own per-user mcp.json; 'settings' = mfagent.mcpServers. */
  source: 'user' | 'settings';
}

/**
 * VS Code's own per-user MCP registry file — the one edited from the command
 * palette's "MCP: Open User Configuration", shared with Copilot Chat and any
 * other MCP-aware extension.
 *
 * There is no VS Code API that hands back this path directly, so it is derived
 * from `globalStorageUri` instead of assuming "Code" anywhere in it — that
 * uri is always `<user dir>/globalStorage/<extension id>`, so two levels up is
 * the `User` folder, whether this is Code, Insiders, or a portable build.
 */
export function userMcpJsonPath(context: vscode.ExtensionContext): string {
  return path.resolve(context.globalStorageUri.fsPath, '..', '..', 'mcp.json');
}

/**
 * Reads VS Code's user `mcp.json`. Its schema is `{ "servers": { "<name>": {
 * "type": "stdio"|"http"|"sse", "command"?, "args"?, "env"?, "url"?,
 * "headers"? } } }` — the same shape as a project's `.vscode/mcp.json`.
 *
 * A missing file or unreadable JSON is not an error here: most workspaces
 * will not have one, and a core that never sees these entries is exactly what
 * an absent or broken file should produce.
 */
export function readUserMcpServers(context: vscode.ExtensionContext): DiscoveredMcpServer[] {
  const file = userMcpJsonPath(context);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const doc = JSON.parse(raw);
    const servers = doc?.servers;
    if (!servers || typeof servers !== 'object') {
      return [];
    }
    return Object.entries(servers as Record<string, any>).map(([name, s]) => ({
      name,
      command: s?.command ? String(s.command) : undefined,
      args: Array.isArray(s?.args) ? s.args.map(String) : undefined,
      env: s?.env && typeof s.env === 'object' ? s.env : undefined,
      url: s?.url ? String(s.url) : undefined,
      headers: s?.headers && typeof s.headers === 'object' ? s.headers : undefined,
      source: 'user' as const,
    }));
  } catch {
    return [];
  }
}

/**
 * The full set of MCP servers this extension knows about: VS Code's user
 * `mcp.json` merged with the `mfagent.mcpServers` setting. A name present in
 * both is taken from the setting, since that is this extension's own explicit
 * configuration for it.
 *
 * Per-server enable/disable is layered on top of this by the caller (see
 * `buildCoreConfig` in providers/payload.ts) — this function only says what
 * servers exist, not which are currently switched on for a given workspace.
 */
export function discoverMcpServers(context: vscode.ExtensionContext): DiscoveredMcpServer[] {
  const merged = new Map<string, DiscoveredMcpServer>();
  for (const s of readUserMcpServers(context)) {
    merged.set(s.name, s);
  }
  const fromSettings = vscode.workspace.getConfiguration('mfagent').get<any[]>('mcpServers', []) ?? [];
  for (const s of fromSettings) {
    const name = String(s?.name ?? '').trim();
    if (!name) {
      continue;
    }
    merged.set(name, {
      name,
      command: s.command ? String(s.command) : undefined,
      args: Array.isArray(s.args) ? s.args.map(String) : undefined,
      env: s.env && typeof s.env === 'object' ? s.env : undefined,
      url: s.url ? String(s.url) : undefined,
      headers: s.headers && typeof s.headers === 'object' ? s.headers : undefined,
      source: 'settings',
    });
  }
  return [...merged.values()];
}

/**
 * Merge-writes this server into VS Code's own per-user `mcp.json`
 * (`userMcpJsonPath`), so it is registered before `registerMcpProvider`'s
 * dynamic path even applies — that API needs VS Code ≥1.99 and silently
 * no-ops otherwise, so this file is the one thing that reaches every VS Code
 * version. Called once at activation; safe to call again; existing servers
 * and unrelated content are preserved.
 *
 * Deliberately does not pin `--workspace`: unlike the project-root
 * `.mcp.json` below, this file is not tied to any one folder, so it cannot
 * know which workspace will be open when VS Code eventually launches the
 * process. The binary defaults `--workspace` to its own cwd when the flag is
 * omitted (see `core/cmd/mfagent-mcp/main.go`), which is the best a
 * workspace-agnostic registration can do.
 */
export function writeUserMcpJson(context: vscode.ExtensionContext, bin: string): string {
  const file = userMcpJsonPath(context);

  let doc: any = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      doc = {};
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    doc = {};
  }

  // VS Code's own mcp.json keys servers under "servers", not "mcpServers" —
  // see the schema note on readUserMcpServers above.
  const servers =
    doc.servers && typeof doc.servers === 'object' && !Array.isArray(doc.servers) ? doc.servers : {};
  servers[MCP_SERVER_NAME] = { type: 'stdio', command: bin, args: [] };
  doc.servers = servers;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}

/**
 * Writes (or merges into) the workspace-root `.mcp.json`. This is the file
 * Claude Code, Cursor and the VS Code Agent Host read natively for MCP
 * configuration, so a single write covers every JSON-configured client.
 * Existing servers and unrelated top-level keys are preserved.
 */
export function writeProjectMcpJson(root: string, bin: string): string {
  const file = path.join(root, '.mcp.json');

  let doc: any = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      doc = {};
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    doc = {};
  }

  const servers =
    doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)
      ? doc.mcpServers
      : {};
  servers[MCP_SERVER_NAME] = {
    type: 'stdio',
    command: bin,
    args: ['--workspace', root],
  };
  doc.mcpServers = servers;

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}
