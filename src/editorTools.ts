/**
 * Grouping for the language-model tools this editor registers.
 *
 * `vscode.lm.tools` is a flat list, and on a machine with a few MCP servers
 * installed it is a *long* flat list — the Context tab used to render one
 * checkbox per entry, which meant a hundred-odd boxes to tick before an agent
 * could do anything. The editor's own "Configure Tools" picker solves this by
 * showing a tree: one row per source (built-in, or an MCP server), expandable
 * to the individual tools, with a tri-state box that switches the whole group.
 * This module builds that tree.
 *
 * The API gives us a name, a description and some tags — not the extension a
 * tool came from — so every rule here is a heuristic over those three, and
 * anything unrecognised lands in a plainly named "other" set rather than being
 * hidden. Nothing depends on the classification being right: it decides how
 * rows are grouped and which ones a fresh workspace starts with, and the
 * actual switch is still per tool underneath.
 */

/** The subset of `vscode.lm.tools` this module reads, so it stays testable. */
export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/** One tool, as a leaf of the picker tree. */
export interface ToolLeaf {
  name: string;
  description: string;
  enabled: boolean;
}

/** A branch: the built-in category, one of its capability sets, or one server. */
export interface ToolGroup {
  id: string;
  label: string;
  /** Dim text after the label — a set's purpose, or a server's own id. */
  hint: string;
  kind: 'builtin' | 'set' | 'mcp' | 'extension';
  groups: ToolGroup[];
  tools: ToolLeaf[];
}

/**
 * The built-in capability sets, in the order the editor's own picker lists
 * them, each with the rule that claims a tool for it.
 *
 * Order is the whole classifier: a tool is claimed by the first set that
 * matches, so the specific sets come before the broad ones — `searchExtensions`
 * is a `vscode` tool before it is a `search` one, and `getTerminalOutput` is
 * `execute` before it is `read`.
 */
const SETS: { id: string; hint: string; match: RegExp }[] = [
  {
    id: 'agent',
    hint: 'Delegate tasks to other agents',
    match: /agent|subagent|delegate|handoff|\bthink\b|\bplan\b/,
  },
  { id: 'todo', hint: 'Manage and track todo items for task planning', match: /todo|task[_\- ]?list/ },
  {
    id: 'browser',
    hint: 'Open and interact with integrated browser pages',
    match: /browser|playwright|screenshot|page[_\- ]?(click|type|navigate|snapshot)/,
  },
  { id: 'web', hint: 'Fetch information from the web', match: /web|fetch|http|url|internet/ },
  {
    id: 'vscode',
    hint: 'Use VS Code features',
    match: /vscode|extension|marketplace|setting|keybinding|workspace[_\- ]?(new|create)|\bapi\b/,
  },
  {
    id: 'search',
    hint: 'Search files in your workspace',
    match: /search|find|grep|query|codebase|symbol|usages|references/,
  },
  {
    id: 'edit',
    hint: 'Edit files in your workspace',
    match: /edit|create|write|insert|replace|patch|apply|rename|move|delete|format|refactor/,
  },
  {
    id: 'execute',
    hint: 'Execute code and applications on your machine',
    match: /run|exec|terminal|shell|command|task|test|build|debug|launch|process|install/,
  },
  {
    id: 'read',
    hint: 'Read files in your workspace',
    match: /read|get|list|open|file|director|folder|problem|error|diagnostic|output|notebook|usage/,
  },
];

const OTHER_SET = { id: 'other', hint: 'Everything else registered in this editor' };

/**
 * The sets a workspace that has never picked starts with — the four that make
 * an agent able to work on a codebase at all. Everything else, including every
 * MCP-backed tool, stays off until someone asks for it: each definition rides
 * along in every request the agent makes, so the default is the useful
 * minimum rather than the full list.
 */
export const DEFAULT_SETS: ReadonlySet<string> = new Set(['edit', 'execute', 'read', 'search']);

/** Name prefixes the editor and its chat use for tools of its own. */
const BUILTIN_NAMESPACES = new Set(['copilot', 'vscode', 'github', 'core', 'editor', 'chat']);

// VS Code exposes these without a namespace. Their first word is an action,
// not an extension ID (https://github.com/microsoft/vscode).
const BROWSER_TOOLS = new Set([
  'open_browser_page', 'click_element', 'screenshot_page', 'navigate_page',
  'read_page', 'hover_element', 'drag_element', 'type_in_page',
  'handle_dialog', 'run_playwright_code',
]);

/** Mirrors `sanitize` in core/cmd/mfcore/main.go and mcpBridge.ts. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Everything a rule may look at, lowercased once. */
function haystacks(t: ToolInfo): { id: string; text: string } {
  return {
    id: `${t.name} ${t.tags.join(' ')}`.toLowerCase(),
    text: t.description.toLowerCase(),
  };
}

/** Which capability set a built-in tool belongs to. */
export function setOf(t: ToolInfo): string {
  if (BROWSER_TOOLS.has(t.name)) return 'browser';
  const { id, text } = haystacks(t);
  // The name and tags are the tool's own vocabulary; the description is prose
  // that mentions half the verbs in the list. Only fall back to it.
  for (const s of SETS) {
    if (s.match.test(id)) {
      return s.id;
    }
  }
  for (const s of SETS) {
    if (s.match.test(text)) {
      return s.id;
    }
  }
  return OTHER_SET.id;
}

/**
 * The MCP server behind a tool, or ''. VS Code names an MCP tool
 * `mcp_<server>_<tool>` with the server label sanitised, which is ambiguous
 * once the label itself contains an underscore — so the known server names are
 * tried first, and only then the first segment.
 */
export function serverOf(t: ToolInfo, servers: readonly string[]): string {
  for (const name of servers) {
    if (t.name.toLowerCase().startsWith(`mcp_${sanitize(name).toLowerCase()}_`)) {
      return name;
    }
  }
  const m = /^mcp_([^_]+)_/.exec(t.name);
  if (m) {
    return m[1];
  }
  // Some servers are surfaced with a tag instead of a prefix.
  const tagged = t.tags.find((tag) => /^mcp[-_:]/i.test(tag));
  return tagged ? tagged.slice(4) : '';
}

/** The extension namespace of a non-MCP tool (`myext_doThing` → `myext`), or ''. */
function namespaceOf(t: ToolInfo): string {
  if (BROWSER_TOOLS.has(t.name)) return '';
  const m = /^([A-Za-z0-9]+)_/.exec(t.name);
  if (!m || BUILTIN_NAMESPACES.has(m[1].toLowerCase())) {
    return '';
  }
  return m[1];
}

/** The tools a workspace gets before anyone has made a pick of its own. */
export function defaultEnabledTools(tools: readonly ToolInfo[], servers: readonly string[] = []): string[] {
  return tools
    .filter((t) => !serverOf(t, servers) && !namespaceOf(t) && DEFAULT_SETS.has(setOf(t)))
    .map((t) => t.name);
}

function leaf(t: ToolInfo, enabled: ReadonlySet<string>): ToolLeaf {
  return {
    name: t.name,
    description: t.description.replace(/\s+/g, ' ').trim(),
    enabled: enabled.has(t.name),
  };
}

/**
 * The picker tree: `Built-In` with its capability sets, then one group per
 * extension namespace, then one per MCP server the editor runs.
 *
 * `servers` are the MCP servers this extension knows about, used only to
 * label a group with the name a person configured rather than the sanitised
 * prefix baked into its tools' names.
 */
export function buildToolTree(
  tools: readonly ToolInfo[],
  enabled: ReadonlySet<string>,
  servers: readonly string[] = [],
): ToolGroup[] {
  const sets = new Map<string, ToolLeaf[]>();
  const byNamespace = new Map<string, ToolLeaf[]>();
  const byServer = new Map<string, ToolLeaf[]>();

  for (const t of tools) {
    const server = serverOf(t, servers);
    if (server) {
      push(byServer, server, leaf(t, enabled));
      continue;
    }
    const ns = namespaceOf(t);
    if (ns) {
      push(byNamespace, ns, leaf(t, enabled));
      continue;
    }
    push(sets, setOf(t), leaf(t, enabled));
  }

  const out: ToolGroup[] = [];

  const setOrder = [...SETS.map((s) => s.id), OTHER_SET.id];
  const setGroups = setOrder
    .filter((id) => sets.has(id))
    .map<ToolGroup>((id) => ({
      id: `set:${id}`,
      label: id,
      hint: (SETS.find((s) => s.id === id) ?? OTHER_SET).hint,
      kind: 'set',
      groups: [],
      tools: sortTools(sets.get(id) ?? []),
    }));
  if (setGroups.length) {
    out.push({ id: 'builtin', label: 'Built-In', hint: '', kind: 'builtin', groups: setGroups, tools: [] });
  }

  for (const ns of [...byNamespace.keys()].sort(collate)) {
    out.push({
      id: `ext:${ns}`,
      label: ns,
      hint: 'extension tools',
      kind: 'extension',
      groups: [],
      tools: sortTools(byNamespace.get(ns) ?? []),
    });
  }

  for (const name of [...byServer.keys()].sort(collate)) {
    out.push({
      id: `mcp:${name}`,
      label: name,
      hint: 'MCP server run by VS Code',
      kind: 'mcp',
      groups: [],
      tools: sortTools(byServer.get(name) ?? []),
    });
  }

  return out;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function collate(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function sortTools(list: ToolLeaf[]): ToolLeaf[] {
  return list.sort((a, b) => collate(a.name, b.name));
}

/** Every tool name under a group, its subgroups included. */
export function toolNames(group: ToolGroup): string[] {
  return [...group.tools.map((t) => t.name), ...group.groups.flatMap(toolNames)];
}
