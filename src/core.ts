import * as path from 'path';
import * as vscode from 'vscode';
import { resolveCoreBinary } from './detect';
import { buildCoreConfig, CoreConfig } from './providers/payload';
import { getStore } from './providers/instance';
import { getActiveQueue } from './queue/registry';
import { CoreTransport } from './runtime/coreTransport';

export type { CoreConfig };
export interface InitResult {
  version: string;
  provider: string;
  model: string;
  tools: string[];
  memory: boolean;
  memoryPath?: string;
  visionModel?: string;
  embeddingModel?: string;
  mcp?: string[];
  warnings?: string[];
}

/** Editor configuration adapter; subprocess ownership lives in the shared runtime. */
export class CoreClient extends CoreTransport {
  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;
  private shuttingDown = false;
  constructor(context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    const binary = () => {
      const found = resolveCoreBinary(context);
      if (found.path) return found.path;
      throw new Error(`Could not find mfcore. Looked in:\n${found.searched.join('\n')}\nBuild with npm run build:core`);
    };
    super({ binary, cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(binary()), output });
    this.onDidExit.event(code => {
      if (this.shuttingDown || code === 0) return;
      if (this.restartAttempts++ < 3) {
        this.restartTimer = setTimeout(() => {
          if (!this.shuttingDown) void this.start().catch(error => output.appendLine(`[core] restart failed: ${error}`));
        }, 750);
      } else {
        void vscode.window.showErrorMessage('The MF Agent core keeps exiting. See the log for details.', 'Show Log')
          .then(pick => { if (pick) output.show(); });
      }
    });
  }
  async initialize(overrides: Partial<CoreConfig> = {}): Promise<InitResult> {
    this.restartAttempts = 0;
    // A queue worker is bound to the fixed testing target and cannot work
    // without signing in, so it must refuse to start without the credentials.
    // The editor core is not: a queue database copied to another host or
    // profile names credentials whose values never left the original secret
    // storage, and failing the window's startup over them left the user with
    // no way to open the settings page the error points at.
    const allowMissingCredentials = !overrides.queueRole;
    const payload = await buildCoreConfig(getStore(), { allowMissingCredentials });
    if (allowMissingCredentials) {
      const missing = (getActiveQueue()?.testingCredentialNames ?? [])
        .filter(name => !payload.testingEnvironment.credentials[name]);
      if (missing.length) {
        this.output.appendLine(
          `[ext] testing credentials unavailable on this host/profile: ${missing.join(', ')} — ` +
          'chat starts without them; configure Task Queue > Plan > Testing environment before running tasks',
        );
      }
    }
    const providers = new Map(payload.providers.map(provider => [provider.id, provider]));
    for (const provider of overrides.providers ?? []) providers.set(provider.id, provider);
    return this.request<InitResult>('initialize', { ...payload, ...overrides, providers: [...providers.values()] });
  }
  async restart(overrides: Partial<CoreConfig> = {}): Promise<InitResult> {
    this.stop();
    await this.start();
    return this.initialize(overrides);
  }
  override stop(): void { clearTimeout(this.restartTimer); super.stop(); }
  override dispose(): void { this.shuttingDown = true; this.stop(); super.dispose(); }
}
