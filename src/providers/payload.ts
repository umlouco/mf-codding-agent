import * as vscode from 'vscode';
import { detectLanguages, memoryDbPath, workspaceRoot } from '../detect';
import { getRouter } from '../llm/router';
import { resolveMcpServers } from '../mcp';
import { EditorToolDef, getBridge } from '../mcpBridge';
import { getActiveQueue } from '../queue/registry';
import { discoverInstalledSkills } from '../skills';
import { ProfileStore, ResolvedRole, Skill, SkillGroup } from './store';
import { getContext } from './instance';

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
  /** Omit tool definitions to save context; registered tools remain callable. */
  disableTools: boolean;
  /**
   * Tool-calling rounds per turn. 0 leaves the core on its own default, and a
   * negative number removes the ceiling for a turn something else ends.
   */
  maxIterations: number;
  /**
   * Context tokens one round may carry before the core stops the tool loop and
   * asks for a handoff report. 0 leaves the core on its own default, negative
   * disables it. This is what bounds a turn that has no round ceiling.
   */
  maxContextTokens: number;
  /** Seconds a reply may deliver nothing before the connection counts as dropped. */
  llmIdleSeconds: number;
  /** How often a waiting turn writes an activity record. */
  activitySeconds: number;
  languages: string[];
  mcpServers: any[];
  /**
   * The `vscode.lm.tools` the active workspace has switched on, registered by
   * the core as `editor__<name>` and run by the editor on request — see
   * mcpBridge.ts and registerEditorTools in the core.
   */
  editorTools: EditorToolDef[];
  /**
   * Pre-formatted skill content, spliced into the system prompt like project
   * instructions — see the core's PromptInput.Skills. Built from whichever
   * skill groups the active workspace's task queue has switched on; empty
   * when no queue is open yet or nothing is enabled.
   */
  skillsText: string;
  browserExecutable: string;
  browserHeadless: boolean;
  /**
   * Whether run_shell should run in a VS Code terminal rather than a process
   * the core spawns — the `mfagent.shell.useTerminal` setting, which only the
   * extension host can read. See src/editorTerminal.ts and
   * Config.EditorTerminal in the core.
   */
  editorTerminal: boolean;
}

/**
 * The context ceiling every core process gets, chat and queue alike.
 *
 * It is the same number everywhere on purpose. This is not a work budget to be
 * tuned per role — it is the point past which a conversation is about to be
 * refused by the provider, which is a property of the model, not of the job.
 * Pass a negative value to switch it off for a model whose window is genuinely
 * larger than the agent will ever fill.
 */
export function contextCeiling(): number {
  return vscode.workspace
    .getConfiguration('mfagent')
    .get<number>('llm.maxContextTokens', 200_000);
}

/**
 * Concatenates the skills belonging to `enabledGroupIds`, in group order,
 * each skill counted once even if more than one enabled group includes it.
 * Blank-content skills are dropped rather than sent as an empty section.
 */
function buildSkillsText(
  skills: Skill[],
  groups: SkillGroup[],
  enabledGroupIds: ReadonlySet<string>,
): string {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const g of groups) {
    if (!enabledGroupIds.has(g.id)) {
      continue;
    }
    for (const skillId of g.skillIds) {
      if (seen.has(skillId)) {
        continue;
      }
      const skill = byId.get(skillId);
      if (!skill || !skill.content.trim()) {
        continue;
      }
      seen.add(skillId);
      parts.push(`## ${skill.name}\n\n${skill.content.trim()}`);
    }
  }
  return parts.length ? `# Skills\n\n${parts.join('\n\n')}` : '';
}

export async function buildCoreConfig(store: ProfileStore): Promise<CoreConfig> {
  const cfg = vscode.workspace.getConfiguration('mfagent');
  const root = workspaceRoot();
  const resolved = await store.resolveAll();
  const activeQueue = getActiveQueue();

  const providers = new Map<string, CoreProvider>();
  const router = getRouter();

  /** Registers the role's provider (once) and returns the core-side binding. */
  const bind = async (r: ResolvedRole): Promise<CoreRole> => {
    if (!r.profile) {
      return { providerId: '', model: '', effort: '' };
    }
    let entry = providers.get(r.profile.id);
    if (!entry) {
      // The router decides what the core actually dials: an editor model
      // becomes the loopback proxy, everything else is the store's own answer.
      const ep = await router.endpointFor(r);
      entry = {
        id: r.profile.id,
        label: r.profile.name,
        type: ep.type,
        apiKey: ep.apiKey,
        baseURL: ep.baseURL,
        models: [],
        reasoning: ep.type === 'anthropic',
        enabled: true,
      };
      providers.set(r.profile.id, entry);
    }
    if (r.model && !entry.models.includes(r.model)) {
      entry.models.push(r.model);
    }
    return { providerId: r.profile.id, model: r.model, effort: r.effort };
  };

  const coding = await bind(resolved.coding);
  const vision = await bind(resolved.vision);
  const embedding = await bind(resolved.embedding);

  const languages = store.settings.languages.auto
    ? await detectLanguages(root)
    : store.settings.languages.list;

  const disabledMcp = new Set(activeQueue?.disabledMcpServers ?? []);
  // resolveMcpServers, not discoverMcpServers: this is the one place the keys
  // are needed, and it is the last step before the config reaches the core.
  // A server the editor alone can resolve (see DiscoveredMcpServer.problem)
  // is left out rather than sent with a placeholder where its key should be.
  const mcpServers = (await resolveMcpServers(getContext(), store))
    .filter((s) => !s.problem)
    .map((s) => ({
      ...s,
      // Two independent switches. `s.enabled` is the server's own, from the
      // MCP Servers tab; `disabledMcp` is this workspace's, from the Context tab.
      enabled: s.enabled !== false && !disabledMcp.has(s.name),
    }));

  const installed = discoverInstalledSkills(vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []);
  const skills = [...store.settings.skills, ...installed.map((d) => d.skill)];
  const skillGroups = [...store.settings.skillGroups, ...installed.map((d) => d.group)];
  const enabledSkillGroups = new Set(activeQueue?.enabledSkillGroups ?? []);
  const skillsText = buildSkillsText(skills, skillGroups, enabledSkillGroups);

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
    maxContextTokens: contextCeiling(),
    llmIdleSeconds: Math.max(1, cfg.get<number>('llm.idleMinutes', 30)) * 60,
    activitySeconds: Math.max(5, cfg.get<number>('activityIntervalSeconds', 30)),
    languages,
    mcpServers,
    editorTools: getBridge().editorToolDefs(),
    skillsText,
    browserExecutable: '',
    browserHeadless: store.settings.browser.headless || !!vscode.env.remoteName,
    editorTerminal: cfg.get<boolean>('shell.useTerminal', true),
  };
}
