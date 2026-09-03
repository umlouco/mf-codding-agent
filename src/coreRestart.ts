import * as vscode from 'vscode';

/**
 * A debounced request to restart the core, for callers outside `extension.ts`
 * that need one — the Task Queue's MCP/skill-group toggles, chiefly.
 *
 * `extension.ts` keeps its own debounce for provider and `settings.json`
 * changes, serialized through its bootstrap chain; this is a separate, smaller
 * one so a burst of checkbox clicks in the Context tab restarts the core once,
 * not once per click, without reaching into that private state.
 */

let timer: NodeJS.Timeout | undefined;

export function scheduleRestart(why: string, output: vscode.OutputChannel): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    output.appendLine(`[ext] ${why}; restarting core`);
    void vscode.commands.executeCommand('mfagent.restartCore');
  }, 600);
}
