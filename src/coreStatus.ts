import type { InitResult } from './core';

/**
 * What the last core start reported about its MCP servers, kept where the
 * Task Queue view can read it.
 *
 * The core connects every server at `initialize` and says, per server, either
 * that it is up or why it is not — a 401 from a server whose key is wrong,
 * a command that is not on PATH. Until now that verdict went to the output
 * channel and nowhere else, so the Context tab, where a server is switched on
 * or off, showed a checkbox and no sign of whether checking it did anything.
 * This is the one place that verdict is remembered between the core start
 * that produced it and the view that needs it.
 */

export interface McpConnection {
  status: 'connected' | 'failed';
  /** The core's own account of the failure, verbatim. */
  error?: string;
}

let connections = new Map<string, McpConnection>();
let reported = false;

/** Warnings look like `MCP server "name" (from …): initialize: http 401: …`. */
const WARNING = /^MCP server "([^"]+)"(?: \([^)]*\))?: ([\s\S]*)$/;

export function recordCoreInit(init: InitResult): void {
  const next = new Map<string, McpConnection>();
  for (const name of init.mcp ?? []) {
    next.set(name, { status: 'connected' });
  }
  for (const warning of init.warnings ?? []) {
    const m = WARNING.exec(warning);
    if (m) {
      next.set(m[1], { status: 'failed', error: m[2].trim() });
    }
  }
  connections = next;
  reported = true;
}

/** Undefined until a core has started, and for a server it was never given. */
export function mcpConnection(name: string): McpConnection | undefined {
  return reported ? connections.get(name) : undefined;
}
