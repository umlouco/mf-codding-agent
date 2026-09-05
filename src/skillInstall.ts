import * as vscode from 'vscode';

/** Run in a visible task terminal so completion has an observable exit code. */
export async function runSkillInstall(command: string, env: Record<string, string>): Promise<number | undefined> {
  const windows = process.platform === 'win32';
  const definition = { type: 'mfagent-skill-install', id: `${Date.now()}-${Math.random()}` };
  const task = new vscode.Task(
    definition,
    vscode.workspace.workspaceFolders?.[0] ?? vscode.TaskScope.Global,
    'Install skill', 'MF Agent',
    new vscode.ShellExecution(windows ? `${command}; exit $LASTEXITCODE` : command, {
      executable: windows ? 'powershell.exe' : '/bin/sh',
      shellArgs: windows ? ['-NoProfile', '-Command'] : ['-c'],
      env,
    }),
    [],
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.New, focus: true };
  return new Promise((resolve, reject) => {
    const listener = vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution.task.definition.id !== definition.id) return;
      listener.dispose();
      resolve(event.exitCode);
    });
    void vscode.tasks.executeTask(task).then(undefined, (error: unknown) => { listener.dispose(); reject(error); });
  });
}
