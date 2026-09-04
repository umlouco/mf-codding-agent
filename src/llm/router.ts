import * as vscode from 'vscode';
import type { ResolvedRole } from '../providers/store';
import { LmProxy } from './lmProxy';

/**
 * Where a role's model traffic goes.
 *
 * The profile store answers *which* provider and model a role is bound to;
 * this answers *how* a turn on it is carried. There are three transports and
 * only one of them is new here:
 *
 *   core        an HTTP provider the Go core dials itself — Anthropic or
 *               anything speaking `/v1/chat/completions`. The store's
 *               resolution is passed through untouched.
 *   vscode-lm   one of the editor's own models, reached through `vscode.lm`.
 *               The core cannot call that API, so the role is handed the
 *               loopback proxy in lmProxy.ts and dials it exactly as it would
 *               an OpenAI-compatible server. This is the primary transport:
 *               it needs no key, no endpoint, and no account beyond the one
 *               VS Code already has.
 *   claude-cli  the Claude Code CLI as a subprocess, for the roles that run
 *               one turn at a time — see queue/claudeCli.ts.
 *
 * Model selection per task type is the Roles tab: each queue role — planner,
 * supervisor, executor — binds its own provider and model, and an editor model
 * is picked there like any other.
 */

export interface LmModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
}

export type Transport = 'core' | 'claude-cli';

/** What the Go core is told to dial for a role. */
export interface CoreEndpoint {
  /** 'anthropic' or 'openai-compatible' — the two clients the core has. */
  type: string;
  baseURL: string;
  apiKey: string;
}

export class LLMRouter implements vscode.Disposable {
  private readonly proxy: LmProxy;
  private models: LmModelInfo[] | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** The set of editor models changed — a provider signed in, or out. */
  readonly onDidChangeModels = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ) {
    this.proxy = new LmProxy(output);
    this.subs.push(
      vscode.lm.onDidChangeChatModels(() => {
        this.models = undefined;
        this.changed.fire();
      }),
    );
  }

  /** Every chat model VS Code currently offers, cached until the set changes. */
  async listModels(force = false): Promise<LmModelInfo[]> {
    if (!force && this.models) {
      return this.models;
    }
    const found = await vscode.lm.selectChatModels();
    this.models = found.map((m) => ({
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      family: m.family,
      version: m.version,
      maxInputTokens: m.maxInputTokens,
    }));
    return this.models;
  }

  transportFor(kind: string): Transport {
    return kind === 'claude-cli' ? 'claude-cli' : 'core';
  }

  /**
   * Translates a resolved role into what the core dials. For an editor
   * model that means starting the proxy if it is not up yet, so the base URL
   * handed out is one that already answers.
   */
  async endpointFor(r: Pick<ResolvedRole, 'kind' | 'baseURL' | 'apiKey'>): Promise<CoreEndpoint> {
    if (r.kind !== 'vscode-lm') {
      return { type: r.kind, baseURL: r.baseURL, apiKey: r.apiKey };
    }
    const ep = await this.proxy.endpoint();
    return { type: 'openai-compatible', baseURL: ep.baseURL, apiKey: ep.apiKey };
  }

  /**
   * The settings page's Test button for the editor provider.
   *
   * There is no endpoint to ping. What varies is whether VS Code has any
   * models at all, and whether this extension has been granted access to
   * them — consent is asked on the first request, and only in response to a
   * user action, which this button is. So when no model has been granted yet
   * the test sends one tiny request, which is what makes the consent prompt
   * appear; from then on every core turn is allowed through.
   */
  async testAccess(): Promise<{ ok: boolean; message: string }> {
    let models: vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels();
    } catch (e) {
      return { ok: false, message: describe(e) };
    }
    if (models.length === 0) {
      return {
        ok: false,
        message:
          'No language models are available in this VS Code. Install and sign in to a provider ' +
          'such as GitHub Copilot, then refresh.',
      };
    }
    const access = this.context.languageModelAccessInformation;
    const granted = models.filter((m) => access.canSendRequest(m) === true).length;
    const denied = models.filter((m) => access.canSendRequest(m) === false).length;
    if (granted > 0) {
      return {
        ok: true,
        message:
          `${models.length} model(s) available, ${granted} with access granted` +
          (denied ? `, ${denied} denied` : '') +
          '.',
      };
    }
    const probe = models[0];
    try {
      const res = await probe.sendRequest(
        [vscode.LanguageModelChatMessage.User('Reply with the single word OK.')],
        { justification: 'MF Agent is checking that it may use the language models available in VS Code.' },
      );
      for await (const _ of res.text) {
        // Drained: the reply itself is not the point, the granted access is.
      }
      return { ok: true, message: `${models.length} model(s) available; access to ${probe.name} confirmed.` };
    } catch (e) {
      return { ok: false, message: describe(e) };
    }
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.proxy.dispose();
    this.changed.dispose();
  }
}

function describe(e: unknown): string {
  if (e instanceof vscode.LanguageModelError) {
    return `${e.message || e.code} (${e.code})`;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---- process-wide handle -------------------------------------------------
//
// Created once in `activate` and read from the provider payload, the queue's
// role config and the model registry — the same "live behind an explicit
// init" pattern as providers/instance.ts, for the same reason.

let router: LLMRouter | undefined;

export function initRouter(context: vscode.ExtensionContext, output: vscode.OutputChannel): LLMRouter {
  router = new LLMRouter(context, output);
  return router;
}

export function getRouter(): LLMRouter {
  if (!router) {
    throw new Error('MF Agent: the LLM router was read before activation finished.');
  }
  return router;
}
