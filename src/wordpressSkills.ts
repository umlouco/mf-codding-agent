import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

/** Only locations cross into worker configuration; skill bodies never do. */
export function activateWordPressSkills(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  process.env.MFAGENT_WORDPRESS_SKILLS_BUNDLED = path.join(context.extensionPath, 'runtime', 'wordpress');
  process.env.MFAGENT_WORDPRESS_SKILLS_HOME = path.join(context.globalStorageUri.fsPath, 'wordpress-skills');
  output.appendLine('[wordpress] official skills use deterministic task routing and bounded on-demand references');
}

export async function updateWordPressSkills(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const home = path.join(context.globalStorageUri.fsPath, 'wordpress-skills');
  const script = path.join(context.extensionPath, 'support', 'wordpress-skills.mjs');
  const manifest = await new Promise<{ revision: string; skills: unknown[] }>((resolve, reject) => {
    cp.execFile('node', [script, home, 'latest'], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr.trim() || error.message)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('The WordPress updater returned an invalid manifest.')); }
    });
  });
  output.appendLine(`[wordpress] updated ${manifest.skills.length} skills to ${manifest.revision}; new turns use this revision`);
  void vscode.window.showInformationMessage(`WordPress skills updated: ${manifest.skills.length} skills (${manifest.revision.slice(0, 12)}). Used from the next agent turn.`);
}
