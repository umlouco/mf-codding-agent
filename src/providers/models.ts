import * as vscode from 'vscode';
import { getRouter } from '../llm/router';
import {
  ListStyle,
  ProviderDef,
  effectiveBaseURL,
  looksLikeEmbeddingModel,
  looksLikeVisionModel,
  providerOrFallback,
  trimBase,
} from './catalog';

/**
 * Live model discovery.
 *
 * Every model list in this extension is fetched from the provider, never
 * hard-coded — a checked-in list is stale the week after it ships, and a stale
 * list is exactly the kind of thing you end up editing JSON to work around.
 * Results are cached per profile so opening the settings page is instant, with
 * an explicit refresh for when you have just pulled a new local model.
 */

export interface ModelInfo {
  id: string;
  /** Human label when the provider gives one; otherwise the id. */
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** USD per million input / output tokens, when the provider publishes it. */
  inputPrice?: number;
  outputPrice?: number;
  vision?: boolean;
  embedding?: boolean;
  description?: string;
}

export interface ModelList {
  models: ModelInfo[];
  fetchedAt: number;
  /** Set when the last fetch failed; the cached models (if any) still stand. */
  error?: string;
  /** True when the list came from the catalog rather than the network. */
  fallback?: boolean;
}

const CACHE_PREFIX = 'mfagent.models.';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** Cache key. Includes the URL so retargeting a local server refetches. */
function cacheKey(providerId: string, baseURL: string): string {
  return `${CACHE_PREFIX}${providerId}:${baseURL}`;
}

export class ModelRegistry {
  private inflight = new Map<string, Promise<ModelList>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Cached list without touching the network. */
  peek(providerId: string, baseURLOverride: string | undefined): ModelList | undefined {
    const base = effectiveBaseURL(providerId, baseURLOverride);
    return this.context.globalState.get<ModelList>(cacheKey(providerId, base));
  }

  /**
   * Returns the model list, fetching when the cache is cold, stale or when
   * `force` is set. A failed fetch never throws: the caller gets whatever was
   * cached plus an `error`, because a settings page that goes blank when the
   * network hiccups is worse than one showing a slightly old list.
   */
  async list(
    providerId: string,
    baseURLOverride: string | undefined,
    apiKey: string,
    force = false,
  ): Promise<ModelList> {
    const def = providerOrFallback(providerId);
    if (def.kind === 'vscode-lm') {
      return this.listEditorModels(force);
    }
    const base = effectiveBaseURL(providerId, baseURLOverride);
    const key = cacheKey(providerId, base);

    const cached = this.context.globalState.get<ModelList>(key);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.models.length) {
      return cached;
    }

    // Collapse concurrent requests — the settings page asks for several roles
    // on the same provider at once.
    const running = this.inflight.get(key);
    if (running && !force) {
      return running;
    }

    const task = this.fetchList(def, base, apiKey)
      .then(async (models) => {
        const result: ModelList = { models, fetchedAt: Date.now() };
        await this.context.globalState.update(key, result);
        return result;
      })
      .catch(async (e: unknown) => {
        const message = describeError(e);
        this.output.appendLine(`[models] ${def.id}: ${message}`);
        const result: ModelList = {
          models: cached?.models?.length ? cached.models : staticList(def),
          fetchedAt: cached?.fetchedAt ?? 0,
          error: message,
          fallback: !cached?.models?.length,
        };
        return result;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, task);
    return task;
  }

  /**
   * A one-shot reachability check for the settings page's Test button. Uses the
   * same listing call, so a green result means the credentials and the URL are
   * both good for real traffic.
   */
  async test(
    providerId: string,
    baseURLOverride: string | undefined,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }> {
    const def = providerOrFallback(providerId);
    if (def.kind === 'vscode-lm') {
      return getRouter().testAccess();
    }
    const base = effectiveBaseURL(providerId, baseURLOverride);
    if (def.listStyle === 'none') {
      return {
        ok: true,
        message: `${def.label} publishes no model list; credentials are checked on first use.`,
      };
    }
    try {
      const models = await this.fetchList(def, base, apiKey);
      return { ok: true, message: `Connected — ${models.length} model(s) available.` };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  /**
   * The editor's models, straight from `vscode.lm`. Never cached in
   * globalState: the API is local and already knows when its set changes
   * (the router listens for that), so a stale copy could only mislead.
   */
  private async listEditorModels(force: boolean): Promise<ModelList> {
    try {
      const models = await getRouter().listModels(force);
      return {
        models: models.map((m) => ({
          id: m.id,
          name: m.name && m.name !== m.id ? m.name : undefined,
          contextWindow: m.maxInputTokens > 0 ? m.maxInputTokens : undefined,
          vision: looksLikeVisionModel(m.id) || looksLikeVisionModel(m.family),
          embedding: false,
          description: [m.vendor, m.family].filter(Boolean).join(' · '),
        })),
        fetchedAt: Date.now(),
        error: models.length
          ? undefined
          : 'No language models are available in this VS Code. Install and sign in to a provider such as GitHub Copilot.',
      };
    } catch (e) {
      return { models: [], fetchedAt: 0, error: describeError(e) };
    }
  }

  private async fetchList(def: ProviderDef, base: string, apiKey: string): Promise<ModelInfo[]> {
    if (def.listStyle === 'none') {
      return staticList(def);
    }
    if (def.baseURLRequired && !base) {
      throw new Error('No base URL set for this provider.');
    }

    const url = def.listURL ? def.listURL(base) : `${trimBase(base)}/models`;
    const body = await getJson(url, headersFor(def.listStyle, apiKey));
    const models = parseList(def.listStyle, body);

    if (models.length === 0) {
      throw new Error(`${url} returned no models.`);
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }
}

function staticList(def: ProviderDef): ModelInfo[] {
  return (def.staticModels ?? []).map((id) => ({
    id,
    embedding: looksLikeEmbeddingModel(id),
    vision: looksLikeVisionModel(id),
  }));
}

function headersFor(style: ListStyle, apiKey: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (style === 'anthropic') {
    if (apiKey) {
      h['x-api-key'] = apiKey;
    }
    h['anthropic-version'] = '2023-06-01';
    return h;
  }
  if (apiKey) {
    h.Authorization = `Bearer ${apiKey}`;
  }
  return h;
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300).trim();
      throw new Error(`HTTP ${res.status} from ${url}${text ? ` — ${text}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseList(style: ListStyle, body: any): ModelInfo[] {
  switch (style) {
    case 'openrouter':
      return asArray(body?.data).map(parseOpenRouterModel).filter(hasId);
    case 'ollama':
      return asArray(body?.models)
        .map((m: any) => {
          const id = String(m?.name ?? m?.model ?? '');
          return {
            id,
            embedding: looksLikeEmbeddingModel(id),
            vision: looksLikeVisionModel(id),
            description: m?.details?.parameter_size
              ? `${m.details.parameter_size}${m.details.quantization_level ? ` · ${m.details.quantization_level}` : ''}`
              : undefined,
          } satisfies ModelInfo;
        })
        .filter(hasId);
    case 'anthropic':
      return asArray(body?.data)
        .map((m: any) => {
          const id = String(m?.id ?? '');
          return {
            id,
            name: m?.display_name ? String(m.display_name) : undefined,
            vision: true,
            embedding: false,
          } satisfies ModelInfo;
        })
        .filter(hasId);
    default:
      // The OpenAI shape. Providers bolt their own extras onto it, so read the
      // fields we understand and ignore the rest.
      return asArray(body?.data ?? body?.models)
        .map((m: any) => {
          const id = String(m?.id ?? m?.name ?? '');
          const ctx = num(m?.context_window ?? m?.context_length ?? m?.max_context_length);
          return {
            id,
            name: m?.display_name ? String(m.display_name) : undefined,
            contextWindow: ctx,
            maxOutputTokens: num(m?.max_output_tokens ?? m?.max_completion_tokens),
            embedding: looksLikeEmbeddingModel(id),
            vision: looksLikeVisionModel(id),
          } satisfies ModelInfo;
        })
        .filter(hasId);
  }
}

function parseOpenRouterModel(m: any): ModelInfo {
  const id = String(m?.id ?? '');
  const modalities: string[] = asArray(m?.architecture?.input_modalities).map(String);
  // Prices come back as USD per token in a string; per-million reads better.
  const perMillion = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n * 1_000_000 : undefined;
  };
  return {
    id,
    name: m?.name ? String(m.name) : undefined,
    contextWindow: num(m?.context_length),
    maxOutputTokens: num(m?.top_provider?.max_completion_tokens),
    inputPrice: perMillion(m?.pricing?.prompt),
    outputPrice: perMillion(m?.pricing?.completion),
    vision: modalities.includes('image') || looksLikeVisionModel(id),
    embedding: looksLikeEmbeddingModel(id),
    description: m?.description ? String(m.description).slice(0, 300) : undefined,
  };
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function hasId(m: ModelInfo): boolean {
  return !!m.id;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) {
    return 'The request timed out.';
  }
  // Node's fetch hides the real cause one level down.
  const cause = (e as any)?.cause;
  if (cause?.code === 'ECONNREFUSED') {
    return 'Connection refused — is the server running?';
  }
  if (cause?.code === 'ENOTFOUND') {
    return 'Host not found — check the base URL.';
  }
  return msg;
}
