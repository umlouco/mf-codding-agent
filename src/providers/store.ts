import * as vscode from 'vscode';
import { ProviderDef, effectiveBaseURL, providerOrFallback } from './catalog';

/**
 * Where MF Agent's LLM configuration actually lives.
 *
 * Deliberately *not* in `settings.json`. Provider setup is a list of objects
 * with secrets in it — VS Code's settings editor renders that as a raw JSON
 * blob, which means the only way to change a model is to hand-edit a file. So
 * profiles live in `globalState`, API keys live in the OS keychain via
 * `SecretStorage`, and the settings webview is the way you edit both. What
 * remains in `settings.json` is the handful of plain scalars the settings
 * editor is genuinely good at.
 *
 * Export/import covers the one thing settings.json gave us for free: moving a
 * setup to another machine.
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

/** Roles that fall back to `coding` when left unset. */
const INHERITS_CODING: ReadonlySet<Role> = new Set<Role>([
  'vision',
  'planner',
  'supervisor',
  'executor',
]);

export const ROLE_LABELS: Record<Role, { title: string; blurb: string }> = {
  coding: {
    title: 'Coding',
    blurb: 'Chat and code generation. Everything else falls back to this.',
  },
  vision: {
    title: 'Vision',
    blurb: 'Image understanding — screenshots, mockups, diagrams.',
  },
  embedding: {
    title: 'Embedding',
    blurb: 'Vectors for hybrid graph-memory search. Needs an embeddings model.',
  },
  planner: {
    title: 'Queue · Planner',
    blurb: 'Turns a goal into a task list. Reasoning matters more than speed.',
  },
  supervisor: {
    title: 'Queue · Supervisor',
    blurb: 'Verifies finished tasks. Use your strongest model.',
  },
  executor: {
    title: 'Queue · Executor',
    blurb: 'Does the work, one task per process. A fast local model fits well.',
  },
};

/** A saved provider connection. The API key is *not* here — see SecretStorage. */
export interface Profile {
  id: string;
  name: string;
  /** Catalog provider id. */
  providerId: string;
  /** Overrides the catalog default; ignored when the provider pins its URL. */
  baseURL?: string;
  /** Provider-specific extra fields, keyed by `ExtraField.key`. */
  extra?: Record<string, string>;
}

/** Which profile and model serve a role. An empty profileId means "inherit". */
export interface RoleBinding {
  profileId: string;
  model: string;
}

export interface AgentSettings {
  version: 2;
  profiles: Profile[];
  roles: Record<Role, RoleBinding>;
  /** Auto-detect the workspace languages, or use the explicit list. */
  languages: { auto: boolean; list: string[] };
  browser: { headless: boolean };
}

/** A role resolved all the way down to something the Go core can dial. */
export interface ResolvedRole {
  role: Role;
  profile?: Profile;
  def?: ProviderDef;
  /** 'anthropic' or 'openai-compatible' — what the core switches on. */
  kind: string;
  model: string;
  baseURL: string;
  apiKey: string;
  /** True when this role borrowed the coding role's binding. */
  inherited: boolean;
}

const STATE_KEY = 'mfagent.settings.v2';
const SECRET_PREFIX = 'mfagent.apiKey.';
const MIGRATED_KEY = 'mfagent.migratedFromSettings';

function emptyRoles(): Record<Role, RoleBinding> {
  return Object.fromEntries(ROLES.map((r) => [r, { profileId: '', model: '' }])) as Record<
    Role,
    RoleBinding
  >;
}

export function defaultSettings(): AgentSettings {
  return {
    version: 2,
    profiles: [],
    roles: emptyRoles(),
    languages: { auto: true, list: [] },
    browser: { headless: false },
  };
}

export class ProfileStore {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when anything the core needs to be restarted for has changed. */
  readonly onDidChange = this.changed.event;

  private cache: AgentSettings;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.cache = normalise(context.globalState.get<AgentSettings>(STATE_KEY));
  }

  get settings(): AgentSettings {
    return this.cache;
  }

  get profiles(): Profile[] {
    return this.cache.profiles;
  }

  profile(id: string): Profile | undefined {
    return this.cache.profiles.find((p) => p.id === id);
  }

  private async write(next: AgentSettings): Promise<void> {
    this.cache = normalise(next);
    await this.context.globalState.update(STATE_KEY, this.cache);
    this.changed.fire();
  }

  /** Applies a patch to the settings object and persists it. */
  async update(patch: Partial<AgentSettings>): Promise<void> {
    await this.write({ ...this.cache, ...patch });
  }

  // ---- profiles --------------------------------------------------------

  async addProfile(providerId: string, name?: string): Promise<Profile> {
    const def = providerOrFallback(providerId);
    const profile: Profile = {
      id: newId(),
      name: uniqueName(this.cache.profiles, name || def.label),
      providerId: def.id,
    };
    const profiles = [...this.cache.profiles, profile];

    // The first profile is almost always meant to be the coding one; wiring it
    // up saves a step and stops the extension booting with nothing bound.
    const roles = { ...this.cache.roles };
    if (profiles.length === 1 && !roles.coding.profileId) {
      roles.coding = { profileId: profile.id, model: '' };
    }

    await this.write({ ...this.cache, profiles, roles });
    return profile;
  }

  async updateProfile(id: string, patch: Partial<Omit<Profile, 'id'>>): Promise<void> {
    const profiles = this.cache.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
    await this.write({ ...this.cache, profiles });
  }

  async duplicateProfile(id: string): Promise<Profile | undefined> {
    const src = this.profile(id);
    if (!src) {
      return undefined;
    }
    const copy: Profile = {
      ...src,
      id: newId(),
      name: uniqueName(this.cache.profiles, `${src.name} copy`),
      extra: src.extra ? { ...src.extra } : undefined,
    };
    await this.write({ ...this.cache, profiles: [...this.cache.profiles, copy] });
    // Secrets are per-profile, so a copy has to carry the key across too.
    const key = await this.getApiKey(id);
    if (key) {
      await this.setApiKey(copy.id, key);
    }
    return copy;
  }

  async removeProfile(id: string): Promise<void> {
    const profiles = this.cache.profiles.filter((p) => p.id !== id);
    // Any role pointing at the deleted profile is unbound rather than left
    // dangling — an unbound role falls back, a dangling one just fails.
    const roles = { ...this.cache.roles };
    for (const r of ROLES) {
      if (roles[r].profileId === id) {
        roles[r] = { profileId: '', model: '' };
      }
    }
    await this.context.secrets.delete(SECRET_PREFIX + id);
    await this.write({ ...this.cache, profiles, roles });
  }

  // ---- secrets ---------------------------------------------------------

  async getApiKey(profileId: string): Promise<string> {
    return (await this.context.secrets.get(SECRET_PREFIX + profileId)) ?? '';
  }

  async setApiKey(profileId: string, key: string): Promise<void> {
    if (key) {
      await this.context.secrets.store(SECRET_PREFIX + profileId, key);
    } else {
      await this.context.secrets.delete(SECRET_PREFIX + profileId);
    }
    this.changed.fire();
  }

  /** The stored key, or the first provider env var that is set. */
  async effectiveApiKey(profileId: string, def: ProviderDef): Promise<string> {
    const stored = await this.getApiKey(profileId);
    if (stored) {
      return stored;
    }
    for (const name of def.apiKeyEnv ?? []) {
      const v = process.env[name];
      if (v) {
        return v;
      }
    }
    return '';
  }

  /** Which profiles have a usable key, for the settings UI's status pills. */
  async keyStatus(): Promise<Record<string, 'stored' | 'env' | 'missing' | 'not-needed'>> {
    const out: Record<string, 'stored' | 'env' | 'missing' | 'not-needed'> = {};
    for (const p of this.cache.profiles) {
      const def = providerOrFallback(p.providerId);
      if (def.apiKey === 'none') {
        out[p.id] = 'not-needed';
        continue;
      }
      if (await this.getApiKey(p.id)) {
        out[p.id] = 'stored';
        continue;
      }
      const fromEnv = (def.apiKeyEnv ?? []).some((n) => !!process.env[n]);
      out[p.id] = fromEnv ? 'env' : def.apiKey === 'optional' ? 'not-needed' : 'missing';
    }
    return out;
  }

  // ---- roles -----------------------------------------------------------

  async setRole(role: Role, binding: RoleBinding): Promise<void> {
    await this.write({
      ...this.cache,
      roles: { ...this.cache.roles, [role]: binding },
    });
  }

  /**
   * Resolves a role to a concrete endpoint.
   *
   * `vision` and the three queue roles inherit the coding binding when unset,
   * which is what you want — one configured model makes the whole extension
   * work. `embedding` deliberately does not: a chat model silently standing in
   * for an embeddings endpoint produces confusing 404s rather than an honest
   * "not configured".
   */
  async resolve(role: Role): Promise<ResolvedRole> {
    const own = this.cache.roles[role] ?? { profileId: '', model: '' };
    let profileId = own.profileId;
    let model = own.model;
    let inherited = false;

    if (!profileId && INHERITS_CODING.has(role)) {
      // Provider and model are inherited separately, so you can point a role
      // at a different model on the same account without duplicating the
      // profile — the common case for a cheap executor next to a strong
      // supervisor.
      profileId = this.cache.roles.coding.profileId;
      inherited = !!profileId;
      if (!model) {
        model = this.cache.roles.coding.model;
      }
    }

    const profile = profileId ? this.profile(profileId) : undefined;
    if (!profile) {
      return { role, kind: 'openai-compatible', model, baseURL: '', apiKey: '', inherited: false };
    }

    const def = providerOrFallback(profile.providerId);
    return {
      role,
      profile,
      def,
      kind: def.kind,
      model,
      baseURL: effectiveBaseURL(profile.providerId, profile.baseURL),
      apiKey: await this.effectiveApiKey(profile.id, def),
      inherited,
    };
  }

  async resolveAll(): Promise<Record<Role, ResolvedRole>> {
    const entries = await Promise.all(ROLES.map(async (r) => [r, await this.resolve(r)] as const));
    return Object.fromEntries(entries) as Record<Role, ResolvedRole>;
  }

  // ---- export / import -------------------------------------------------

  /** A portable snapshot. Keys are included only on request. */
  async exportJson(includeSecrets: boolean): Promise<string> {
    const payload: any = { ...this.cache, exportedAt: new Date().toISOString() };
    if (includeSecrets) {
      payload.apiKeys = Object.fromEntries(
        await Promise.all(
          this.cache.profiles.map(async (p) => [p.id, await this.getApiKey(p.id)] as const),
        ),
      );
    }
    return JSON.stringify(payload, null, 2);
  }

  async importJson(raw: string): Promise<void> {
    const parsed = JSON.parse(raw);
    const next = normalise(parsed);
    await this.write(next);
    const keys = parsed?.apiKeys;
    if (keys && typeof keys === 'object') {
      for (const [id, key] of Object.entries(keys)) {
        if (typeof key === 'string' && key) {
          await this.context.secrets.store(SECRET_PREFIX + id, key);
        }
      }
    }
  }

  // ---- migration -------------------------------------------------------

  /**
   * Moves a pre-webview `settings.json` setup into the store, once.
   *
   * Returns the obsolete configuration keys that were found, so the caller can
   * offer to delete them — leaving them behind means VS Code flags them as
   * unknown settings forever.
   */
  async migrateFromSettings(): Promise<string[]> {
    if (this.context.globalState.get<boolean>(MIGRATED_KEY)) {
      return [];
    }
    const cfg = vscode.workspace.getConfiguration('mfagent');
    const legacy = cfg.get<any[]>('providers', []) ?? [];

    const stale: string[] = [];
    for (const key of [
      'providers',
      'coding',
      'vision',
      'embedding',
      'queue.planner',
      'queue.supervisor',
      'queue.executor',
      'memory.path',
      'queue.dbPath',
      'browser.executable',
      'languages',
      'autoApprove',
    ]) {
      const info = cfg.inspect(key);
      if (
        info?.globalValue !== undefined ||
        info?.workspaceValue !== undefined ||
        info?.workspaceFolderValue !== undefined
      ) {
        stale.push(`mfagent.${key}`);
      }
    }

    if (legacy.length > 0) {
      const profiles: Profile[] = [];
      const secrets: [string, string][] = [];
      const byLegacyId = new Map<string, string>();

      for (const p of legacy) {
        const legacyId = String(p?.id ?? '');
        const profile: Profile = {
          id: newId(),
          name: uniqueName(profiles, String(p?.label || p?.id || 'Imported')),
          providerId: guessProviderId(String(p?.type ?? ''), String(p?.baseURL ?? '')),
          baseURL: String(p?.baseURL ?? '') || undefined,
        };
        profiles.push(profile);
        byLegacyId.set(legacyId, profile.id);
        if (p?.apiKey) {
          secrets.push([profile.id, String(p.apiKey)]);
        }
      }

      const roles = emptyRoles();
      const bind = (role: Role, from: any) => {
        const pid = byLegacyId.get(String(from?.providerId ?? ''));
        if (pid) {
          roles[role] = { profileId: pid, model: String(from?.model ?? '') };
        }
      };
      bind('coding', cfg.get<any>('coding'));
      bind('vision', cfg.get<any>('vision'));
      bind('embedding', cfg.get<any>('embedding'));
      bind('planner', cfg.get<any>('queue.planner'));
      bind('supervisor', cfg.get<any>('queue.supervisor'));
      bind('executor', cfg.get<any>('queue.executor'));

      const languages = cfg.get<string[]>('languages', []) ?? [];

      await this.write({
        version: 2,
        profiles,
        roles,
        languages: { auto: languages.length === 0, list: languages },
        browser: { headless: cfg.get<boolean>('browser.headless', false) },
      });

      for (const [id, key] of secrets) {
        await this.context.secrets.store(SECRET_PREFIX + id, key);
      }
    }

    await this.context.globalState.update(MIGRATED_KEY, true);
    return stale;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

// ---- helpers -------------------------------------------------------------

/** Maps a legacy free-text `type` onto a catalog provider id. */
function guessProviderId(type: string, baseURL: string): string {
  const t = type.toLowerCase();
  const u = baseURL.toLowerCase();
  const direct = [
    'anthropic',
    'openrouter',
    'deepseek',
    'mistral',
    'groq',
    'together',
    'fireworks',
    'cerebras',
    'ollama',
    'lmstudio',
    'voyage',
    'openai',
  ];
  for (const id of direct) {
    if (t.includes(id) || u.includes(id)) {
      return id === 'lmstudio' ? 'lmstudio' : id;
    }
  }
  if (u.includes('localhost:1234')) {
    return 'lmstudio';
  }
  if (u.includes('11434')) {
    return 'ollama';
  }
  if (t.includes('chatgpt')) {
    return 'openai';
  }
  return 'openai-compatible';
}

function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueName(existing: Profile[], want: string): string {
  const taken = new Set(existing.map((p) => p.name));
  if (!taken.has(want)) {
    return want;
  }
  for (let i = 2; ; i++) {
    const candidate = `${want} ${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Coerces anything read from disk or an import file into a valid settings object. */
function normalise(raw: unknown): AgentSettings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const r = raw as Partial<AgentSettings>;

  const profiles: Profile[] = Array.isArray(r.profiles)
    ? r.profiles
        .filter((p): p is Profile => !!p && typeof p === 'object' && typeof p.id === 'string')
        .map((p) => ({
          id: p.id,
          name: String(p.name ?? 'Unnamed'),
          providerId: String(p.providerId ?? 'openai-compatible'),
          baseURL: p.baseURL ? String(p.baseURL) : undefined,
          extra: p.extra && typeof p.extra === 'object' ? { ...p.extra } : undefined,
        }))
    : [];

  const known = new Set(profiles.map((p) => p.id));
  const roles = emptyRoles();
  for (const role of ROLES) {
    const b = (r.roles as any)?.[role];
    const profileId = String(b?.profileId ?? '');
    roles[role] = {
      profileId: known.has(profileId) ? profileId : '',
      model: String(b?.model ?? ''),
    };
  }

  return {
    version: 2,
    profiles,
    roles,
    languages: {
      auto: r.languages?.auto !== false,
      list: Array.isArray(r.languages?.list) ? r.languages!.list.map(String) : [],
    },
    browser: { headless: !!r.browser?.headless },
  };
}
