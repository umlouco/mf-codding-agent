import * as vscode from 'vscode';
import { detectLanguages, memoryDbPath, workspaceRoot } from '../detect';
import { isAvailable as isTerminalAvailable } from '../editorTerminal';
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
  /** Reasoning-effort hint, or '' to use the provider's own default. */
  effort: string;
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
  /** When true, the model receives no tool definitions. */
  disableTools: boolean;
  /** Tool-calling rounds per turn. 0 leaves the core on its own default. */
  maxIterations: number;
  /** Seconds a reply may deliver nothing before the connection counts as dropped. */
  llmIdleSeconds: number;
  /** How often a waiting turn writes an activity record. */
  activitySeconds: number;
  languages: string[];
  mcpServers: any[];
  browserExecutable: string;
  browserHeadless: boolean;
  /**
   * Whether run_shell should run in a VS Code terminal rather than a process
   * the core spawns. Only the extension host can tell whether this VS Code has
   * the shell-integration API at all, so the core takes this as given — see
   * src/editorTerminal.ts and Config.EditorTerminal in the core.
   */
  editorTerminal: boolean;
}

export async function buildCoreConfig(store: ProfileStore): Promise<CoreConfig> {
  const cfg = vscode.workspace.getConfiguration('mfagent');
  const root = workspaceRoot();
  const resolved = await store.resolveAll();

  const providers = new Map<string, CoreProvider>();

  /** Registers the role's provider (once) and returns the core-side binding. */
  const bind = (r: ResolvedRole): CoreRole => {
    if (!r.profile) {
      return { providerId: '', model: '', effort: '' };
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
    return { providerId: r.profile.id, model: r.model, effort: r.effort };
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
    disableTools: false,
    // The chat keeps the core's default round ceiling: a person is watching and
    // can say "continue". Queue workers override it per role in queue/agents.ts.
    maxIterations: 0,
    llmIdleSeconds: Math.max(1, cfg.get<number>('llm.idleMinutes', 30)) * 60,
    activitySeconds: Math.max(5, cfg.get<number>('activityIntervalSeconds', 30)),
    languages,
    mcpServers: cfg.get<any[]>('mcpServers', []) ?? [],
    browserExecutable: '',
    browserHeadless: store.settings.browser.headless || !!vscode.env.remoteName,
    editorTerminal:
      isTerminalAvailable() && cfg.get<boolean>('shell.useTerminal', true),
  };
}
