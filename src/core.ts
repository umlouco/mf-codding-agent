import * as path from 'path';
import * as vscode from 'vscode';
import { resolveCoreBinary } from './detect';
import { buildCoreConfig, CoreConfig } from './providers/payload';
import { getStore } from './providers/instance';
import { CoreTransport } from './runtime/coreTransport';

export type { CoreConfig };
export type NotificationHandler = (method: string, params: any) => void;
export type RequestHandler = (params: any) => Promise<any>;
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
  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
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
    const payload = await buildCoreConfig(getStore());
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
