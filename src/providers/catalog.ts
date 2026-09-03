/**
 * The catalog of LLM providers MF Agent knows how to talk to.
 *
 * A provider entry is *description only* — it says where the endpoint lives,
 * which credentials it needs and how to list its models. Nothing here is user
 * state; what the user picked lives in the profile store. Keeping the two apart
 * is what lets the settings UI show real fields per provider instead of asking
 * for a free-text blob.
 *
 * `kind` is the only thing the Go core cares about: it maps onto the two
 * transports the core implements — the Anthropic SDK, and anything speaking
 * `/v1/chat/completions`.
 */

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'claude-cli';

/**
 * The six things a profile can be bound to. Lives here rather than in
 * `store.ts` because a `ProviderDef` needs to say which of them it may serve
 * (`rolesAllowed`) — and `store.ts` already imports from this module, so the
 * dependency can only run one way. `store.ts` re-exports both names so every
 * existing `import { Role } from '../providers/store'` keeps working.
 */
export const ROLES = [
  'coding',
  'vision',
  'embedding',
  'planner',
  'supervisor',
  'executor',
] as const;

export type Role = (typeof ROLES)[number];

/** How to discover the models a provider offers. */
export type ListStyle =
  /** GET {baseURL}/models — the OpenAI shape, `{ data: [{ id }] }`. */
  | 'openai'
  /** GET {baseURL}/models with `x-api-key` + `anthropic-version`. */
  | 'anthropic'
  /** GET {baseURL}/models — OpenRouter's shape, with pricing and modalities. */
  | 'openrouter'
  /** GET {host}/api/tags — Ollama's native listing. */
  | 'ollama'
  /** No listing endpoint; use `staticModels`. */
  | 'none';

/** An extra credential or endpoint field a provider needs beyond key + URL. */
export interface ExtraField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  description?: string;
}

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Grouping in the provider dropdown. */
  group: 'Hosted' | 'Router' | 'Local' | 'Embeddings' | 'Custom' | 'CLI';

  /** Base URL used when the profile does not override it. */
  defaultBaseURL: string;
  /** True when the endpoint is the point of the provider (self-hosted, proxies). */
  baseURLEditable: boolean;
  /** True when the profile is useless without an explicit base URL. */
  baseURLRequired?: boolean;

  apiKey: 'required' | 'optional' | 'none';
  /** Environment variables checked when the profile has no stored key. */
  apiKeyEnv?: string[];
  apiKeyHelp?: string;

  listStyle: ListStyle;
  /** Absolute URL for listing when it is not `{baseURL}/models`. */
  listURL?: (baseURL: string) => string;
  /** Shown when listing is unavailable or has not run yet. */
  staticModels?: string[];

  /** Roles this provider can serve. Drives filtering in the settings UI. */
  serves: { chat: boolean; vision: boolean; embedding: boolean };
  /**
   * Which of the six roles this provider may be bound to, beyond the
   * chat/vision/embedding capability triple above. Absent means every
   * chat-capable role — only a provider that is not a plain HTTP endpoint
   * (see `kind: 'claude-cli'`) needs this.
   */
  rolesAllowed?: Role[];

  extraFields?: ExtraField[];
  docsURL?: string;
  notes?: string;
}

/** Strip a trailing slash so `${base}/models` never double-slashes. */
export function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    group: 'Hosted',
    defaultBaseURL: 'https://api.anthropic.com',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    listStyle: 'anthropic',
    listURL: (b) => `${trimBase(b)}/v1/models`,
    staticModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    serves: { chat: true, vision: true, embedding: false },
    docsURL: 'https://console.anthropic.com/settings/keys',
    notes: 'Anthropic has no embeddings endpoint — pick another provider for the embedding role.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    group: 'Hosted',
    defaultBaseURL: 'https://api.openai.com/v1',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['OPENAI_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    docsURL: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    group: 'Router',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    baseURLEditable: false,
    apiKey: 'required',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    listStyle: 'openrouter',
    serves: { chat: true, vision: true, embedding: false },
    docsURL: 'https://openrouter.ai/keys',
    notes: 'Model listing works without a key, so you can browse before signing up.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    kind: 'openai-compatible',
    group: 'Hosted',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseURLEditable: false,
    apiKey: 'required',
    apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    docsURL: 'https://aistudio.google.com/apikey',
    notes: 'Uses the OpenAI-compatible Gemini endpoint.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    group: 'Hosted',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: false, embedding: false },
    docsURL: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai-compatible',
    group: 'Hosted',
    defaultBaseURL: 'https://api.mistral.ai/v1',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['MISTRAL_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    docsURL: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    group: 'Hosted',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    baseURLEditable: false,
    apiKey: 'required',
    apiKeyEnv: ['GROQ_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: false },
    docsURL: 'https://console.groq.com/keys',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai-compatible',
    group: 'Hosted',
    defaultBaseURL: 'https://api.x.ai/v1',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['XAI_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: false },
    docsURL: 'https://console.x.ai',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai-compatible',
    group: 'Router',
    defaultBaseURL: 'https://api.together.xyz/v1',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['TOGETHER_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    docsURL: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai-compatible',
    group: 'Router',
    defaultBaseURL: 'https://api.fireworks.ai/inference/v1',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['FIREWORKS_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    docsURL: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai-compatible',
    group: 'Hosted',
    defaultBaseURL: 'https://api.cerebras.ai/v1',
    baseURLEditable: true,
    apiKey: 'required',
    apiKeyEnv: ['CEREBRAS_API_KEY'],
    listStyle: 'openai',
    serves: { chat: true, vision: false, embedding: false },
    docsURL: 'https://cloud.cerebras.ai',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'openai-compatible',
    group: 'Local',
    defaultBaseURL: 'http://localhost:11434/v1',
    baseURLEditable: true,
    apiKey: 'none',
    listStyle: 'ollama',
    // Ollama's OpenAI shim lives at /v1 but the model list is on the native API.
    listURL: (b) => `${trimBase(b).replace(/\/v1$/, '')}/api/tags`,
    serves: { chat: true, vision: true, embedding: true },
    notes: 'Runs locally. Start it with `ollama serve`; no API key needed.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai-compatible',
    group: 'Local',
    defaultBaseURL: 'http://localhost:1234/v1',
    baseURLEditable: true,
    apiKey: 'none',
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    notes: 'Start the local server from the Developer tab in LM Studio.',
  },
  {
    id: 'vllm',
    label: 'vLLM / llama.cpp',
    kind: 'openai-compatible',
    group: 'Local',
    defaultBaseURL: 'http://localhost:8000/v1',
    baseURLEditable: true,
    baseURLRequired: true,
    apiKey: 'optional',
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    notes: 'Any self-hosted server exposing /v1/chat/completions.',
  },
  {
    id: 'voyage',
    label: 'Voyage AI',
    kind: 'openai-compatible',
    group: 'Embeddings',
    defaultBaseURL: 'https://api.voyageai.com/v1',
    baseURLEditable: false,
    apiKey: 'required',
    apiKeyEnv: ['VOYAGE_API_KEY'],
    listStyle: 'none',
    staticModels: ['voyage-3-large', 'voyage-3', 'voyage-3-lite', 'voyage-code-3'],
    serves: { chat: false, vision: false, embedding: true },
    docsURL: 'https://dash.voyageai.com',
    notes: 'Embeddings only — use it for the embedding role.',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI Compatible (custom)',
    kind: 'openai-compatible',
    group: 'Custom',
    defaultBaseURL: '',
    baseURLEditable: true,
    baseURLRequired: true,
    apiKey: 'optional',
    listStyle: 'openai',
    serves: { chat: true, vision: true, embedding: true },
    notes: 'Point this at any endpoint that speaks the OpenAI API.',
  },
  {
    id: 'claude-cli',
    label: 'Claude CLI',
    kind: 'claude-cli',
    group: 'CLI',
    defaultBaseURL: '',
    baseURLEditable: false,
    apiKey: 'none',
    listStyle: 'none',
    staticModels: ['default', 'opus', 'sonnet', 'haiku', 'fable'],
    serves: { chat: true, vision: false, embedding: false },
    // Not an HTTP endpoint the Go core can dial — it's spawned as a
    // subprocess directly by queue/agents.ts's runOnce, bypassing the core
    // entirely, so it only makes sense for the two roles that run one
    // ephemeral turn at a time.
    rolesAllowed: ['planner', 'supervisor'],
    extraFields: [
      {
        key: 'cliPath',
        label: 'CLI command or path',
        placeholder: 'claude',
        required: false,
        description: 'Leave blank to use "claude" on PATH.',
      },
    ],
    docsURL: 'https://docs.claude.com/en/docs/claude-code',
    notes:
      'Runs the claude CLI as a subprocess, using whatever login it already has (subscription or ' +
      'API key) — install and sign in with claude first. Planner and Supervisor only.',
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDef | undefined {
  return BY_ID.get(id);
}

/**
 * Resolves a provider by id, falling back to the generic OpenAI-compatible
 * entry. A profile saved against a provider that a later version dropped must
 * still load rather than crash the settings page.
 */
export function providerOrFallback(id: string): ProviderDef {
  return BY_ID.get(id) ?? BY_ID.get('openai-compatible')!;
}

/** The effective base URL for a profile: its override, else the catalog default. */
export function effectiveBaseURL(providerId: string, override?: string): string {
  const def = providerOrFallback(providerId);
  const chosen = def.baseURLEditable && override?.trim() ? override : def.defaultBaseURL;
  return trimBase(chosen);
}

/**
 * Model ids that look like embedding models.
 *
 * Almost no provider marks this in its listing, so the settings UI filters the
 * embedding role's suggestions by name. It is a hint, not a gate — the user can
 * always type an id we did not recognise.
 */
const EMBEDDING_HINT =
  /(^|[-_/])(embed|embedding|embeddings)|text-embedding|voyage-|bge-|gte-|nomic-embed|mxbai-embed|(^|[-_/])e5-/i;

export function looksLikeEmbeddingModel(id: string): boolean {
  return EMBEDDING_HINT.test(id);
}

/**
 * Model ids that are very likely to accept images, used only when the provider
 * gives us no modality metadata of its own.
 */
const VISION_HINT =
  /(gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude-|gemini-|llava|bakllava|qwen.*-vl|pixtral|llama-?3\.2-vision|internvl|minicpm-v|moondream|grok-.*vision|-vl\b)/i;

export function looksLikeVisionModel(id: string): boolean {
  return VISION_HINT.test(id);
}
