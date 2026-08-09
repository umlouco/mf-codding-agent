import * as vscode from 'vscode';
import { detectLanguages, memoryDbPath, workspaceRoot } from '../detect';
import { ProfileStore, ResolvedRole } from './store';

/**
 * Translation from the profile store to the payload the Go core expects.
 *
 * The core keeps a flat provider list plus a role → (providerId, model) map,
 * which is a different shape from the store's profiles-and-bindings. Doing the
 * conversion in one place means the core's wire format can stay as it is while
 * the UI models the problem the way a person thinks about it.
 *
 * Only providers a role actually points at are sent. An unused profile is a
 * credential the core has no reason to hold.
 */

export interface CoreProvider {
  id: string;
  label: string;
  type: string;
  apiKey: string;
  baseURL: string;
  models: string[];
  reasoning: boolean;
  enabled: boolean;
}

export interface CoreRole {
  providerId: string;
  model: string;
}

/** The initialize payload the Go core expects. */
export interface CoreConfig {
  workspaceRoot: string;
  providers: CoreProvider[];
  coding: CoreRole;
  vision: CoreRole;
  embedding: CoreRole;
  memoryEnabled: boolean;
  memoryPath: string;
  autoApprove: string[];
  /** Tool-calling rounds per turn. 0 leaves the core on its own default. */
  maxIterations: number;
  /** Seconds a turn may run before the core stops and reports. 0 means no limit. */
  maxDurationSeconds: number;
  languages: string[];
  mcpServers: any[];
  browserExecutable: string;
  browserHeadless: boolean;
}

export async function buildCoreConfig(store: ProfileStore): Promise<CoreConfig> {
  const cfg = vscode.workspace.getConfiguration('mfagent');
  const root = workspaceRoot();
  const resolved = await store.resolveAll();

  const providers = new Map<string, CoreProvider>();

  /** Registers the role's provider (once) and returns the core-side binding. */
  const bind = (r: ResolvedRole): CoreRole => {
    if (!r.profile) {
      return { providerId: '', model: '' };
    }
    let entry = providers.get(r.profile.id);
    if (!entry) {
      entry = {
        id: r.profile.id,
        label: r.profile.name,
        type: r.kind,
        apiKey: r.apiKey,
        baseURL: r.baseURL,
        models: [],
        reasoning: r.kind === 'anthropic',
        enabled: true,
      };
      providers.set(r.profile.id, entry);
    }
    if (r.model && !entry.models.includes(r.model)) {
      entry.models.push(r.model);
    }
    return { providerId: r.profile.id, model: r.model };
  };

  const coding = bind(resolved.coding);
  const vision = bind(resolved.vision);
  const embedding = bind(resolved.embedding);

  const languages = store.settings.languages.auto
    ? await detectLanguages(root)
    : store.settings.languages.list;

  return {
    workspaceRoot: root,
    providers: [...providers.values()],
    coding,
    vision,
    embedding,
    memoryEnabled: cfg.get<boolean>('memory.enabled', true),
    memoryPath: memoryDbPath(root),
    // Unattended edits are gated by the queue's own supervisor rather than a
    // per-tool prompt; this preserves the behaviour the core already had.
    autoApprove: ['*'],
    // The chat keeps the core's defaults: a person is watching, can say
    // "continue", and can stop a turn that is taking too long. Queue workers
    // override both per role in queue/agents.ts.
    maxIterations: 0,
    maxDurationSeconds: 0,
    languages,
    mcpServers: cfg.get<any[]>('mcpServers', []) ?? [],
    browserExecutable: '',
    browserHeadless: store.settings.browser.headless || !!vscode.env.remoteName,
  };
}
