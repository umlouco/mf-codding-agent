import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
// Type-only: mcp.ts is imported by providers/payload.ts, so a value import of
// the store here would close a cycle.
import type { ProfileStore } from './providers/store';

/**
 * MCP server discovery: what servers exist, and where each came from.
 *
 * Publishing them to VS Code's own MCP engine, and pulling the editor's tools
 * back into the core, both live in mcpBridge.ts. Registering with standalone
 * tools that never read the editor's registry — Claude Code, Cursor — is the
 * project-root `.mcp.json` written by `writeProjectMcpJson` below.
 */

/** Must match the `mcpServerDefinitionProviders` entry in package.json. */
export const MCP_PROVIDER_ID = 'mf-agent.mcp-servers';
export const MCP_SERVER_LABEL = 'MF Agent Task Queue';
export const MCP_SERVER_NAME = 'mfagent-task-queue';

// ---- discovery -----------------------------------------------------------

/** One MCP server as the Go core's config expects it, plus where it came from. */
export interface DiscoveredMcpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /**
   * 'user' = VS Code's own per-user mcp.json; 'settings' = mfagent.mcpServers;
   * 'store' = defined in the settings page's MCP Servers tab, which is the only
   * source that can carry an API key without writing it to a file.
   */
  source: 'user' | 'settings' | 'store';
  /** Store-defined servers only: the id their key is filed under. */
  id?: string;
  /** Store-defined servers only: false when switched off in the editor. */
  enabled?: boolean;
  /**
   * Why this server cannot be connected as configured: a `${input:…}` or
   * `${command:…}` reference in VS Code's mcp.json, which only the editor can
   * resolve. Shown on the Context tab; a server carrying one is never handed
   * to the core, since the literal text would reach the server as a nonsense
   * header or argument.
   */
  problem?: string;
}

/**
 * Expands the variables VS Code allows in an mcp.json value.
 *
 * `${env:NAME}`, `${workspaceFolder}` and `${userHome}` are plain facts this
 * process knows as well as the editor does. `${input:id}` is a value VS Code
 * prompted for and keeps in its own secret storage, and `${command:id}` is
 * whatever some extension command returns — neither is reachable from here,
 * so the reference is reported instead of expanded.
 *
 * A bare `${NAME}` is Claude Code's spelling of the same environment
 * reference, and a server block is often copied between the two files; it
 * is honoured when a variable of that name exists, and reported otherwise
 * rather than sent to a server as literal text.
 */
function expandVariables(value: string, root: string): { value: string; unresolved?: string } {
  let unresolved: string | undefined;
  const out = value.replace(/\$\{([^}]+)\}/g, (whole, inner: string) => {
    if (inner.startsWith('env:')) {
      return process.env[inner.slice(4)] ?? '';
    }
    if (inner === 'workspaceFolder' || inner.startsWith('workspaceFolder:')) {
      return root;
    }
    if (inner === 'userHome') {
      return os.homedir();
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) && process.env[inner] !== undefined) {
      return process.env[inner] ?? '';
    }
    unresolved = unresolved ?? whole;
    return whole;
  });
  return { value: out, unresolved };
}

/**
 * VS Code's own per-user MCP registry file — the one edited from the command
 * palette's "MCP: Open User Configuration", shared with Copilot Chat and any
 * other MCP-aware extension. Read so the Go core can connect to the same
 * servers the editor does; never written.
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
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return Object.entries(servers as Record<string, any>).map(([name, s]) => {
      const problems: string[] = [];
      const expand = (v: unknown): string => {
        const r = expandVariables(String(v), root);
        if (r.unresolved) {
          problems.push(r.unresolved);
        }
        return r.value;
      };
      const expandMap = (m: unknown): Record<string, string> | undefined =>
        m && typeof m === 'object'
          ? Object.fromEntries(Object.entries(m as Record<string, unknown>).map(([k, v]) => [k, expand(v)]))
          : undefined;
      const server: DiscoveredMcpServer = {
        name,
        command: s?.command ? expand(s.command) : undefined,
        args: Array.isArray(s?.args) ? s.args.map((a: unknown) => expand(a)) : undefined,
        env: expandMap(s?.env),
        url: s?.url ? expand(s.url) : undefined,
        headers: expandMap(s?.headers),
        source: 'user',
      };
      if (problems.length) {
        server.problem =
          `uses ${[...new Set(problems)].join(', ')}, which only VS Code can resolve — define the ` +
          'server on the MF Agent settings page (MCP Servers tab) to give the agent its own key';
      }
      return server;
    });
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
export function discoverMcpServers(
  context: vscode.ExtensionContext,
  store?: ProfileStore,
): DiscoveredMcpServer[] {
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
  // Last, so a server you edited on the MCP Servers tab wins over one of the
  // same name in either file: that tab is where you went to change it.
  for (const s of store?.mcpServers ?? []) {
    const name = s.name.trim();
    if (!name) {
      continue;
    }
    merged.set(name, {
      name,
      command: s.transport === 'stdio' && s.command ? s.command : undefined,
      args: s.transport === 'stdio' && s.args?.length ? [...s.args] : undefined,
      env: s.transport === 'stdio' && s.env ? { ...s.env } : undefined,
      url: s.transport === 'http' && s.url ? s.url : undefined,
      headers: s.transport === 'http' && s.headers ? { ...s.headers } : undefined,
      source: 'store',
      id: s.id,
      enabled: s.enabled,
    });
  }
  return [...merged.values()];
}

/**
 * `discoverMcpServers` with each store-defined server's key put back where the
 * server expects it — an env var for stdio, a header for http.
 *
 * Kept apart from discovery because reading the keychain is async and most
 * callers only want to *list* servers. The key exists in this process for the
 * length of one core handshake and is never written to any file; the settings
 * page shows only whether one is stored, never its value.
 */
export async function resolveMcpServers(
  context: vscode.ExtensionContext,
  store: ProfileStore,
): Promise<DiscoveredMcpServer[]> {
  const out: DiscoveredMcpServer[] = [];
  for (const server of discoverMcpServers(context, store)) {
    const def = server.source === 'store' && server.id ? store.mcpServer(server.id) : undefined;
    const keyName = def?.keyName?.trim();
    if (!def || !keyName) {
      out.push(server);
      continue;
    }
    const key = await store.getMcpKey(def.id);
    if (!key) {
      out.push(server);
      continue;
    }
    out.push(
      def.transport === 'http'
        ? { ...server, headers: { ...(server.headers ?? {}), [keyName]: `${def.keyPrefix ?? ''}${key}` } }
        : { ...server, env: { ...(server.env ?? {}), [keyName]: key } },
    );
  }
  return out;
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
