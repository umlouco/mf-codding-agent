import * as vscode from 'vscode';
import { discoverMcpServers } from '../mcp';
import { getStore } from '../providers/instance';
import type { Task, TaskQueue } from './db';

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
export async function setMcpKey(context: vscode.ExtensionContext, name: string): Promise<void> {
  const store = getStore();
  const found = discoverMcpServers(context, store).find((s) => s.name === name);
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
}

// ---- confirmations ---------------------------------------------------

/**
 * An autonomous run approves every tool call, including shell commands, with
 * nobody watching. That is a real decision and it gets asked once per start.
 */
export async function confirmAutonomy(queue: TaskQueue): Promise<boolean> {
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
export async function confirmDelete(task: Task): Promise<boolean> {
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

export async function confirmReset(): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(
    'Reset runnable tasks to PENDING?',
    { modal: true, detail: 'Progress, outputs, error logs and supervisor feedback are cleared. The tasks themselves are kept. Tasks requiring decomposition retain their failure evidence and cannot be restarted unchanged.' },
    'Reset',
  );
  return pick === 'Reset';
}

export async function confirmClear(): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(
    'Delete the whole task queue?',
    { modal: true, detail: 'Every task and its history is removed. This cannot be undone.' },
    'Delete all',
  );
  return pick === 'Delete all';
}
