import * as vscode from 'vscode';
import { mcpConnection } from '../coreStatus';
import { discoverMcpServers } from '../mcp';
import { getBridge } from '../mcpBridge';
import { getStore } from '../providers/instance';
import type { Skill } from '../providers/store';
import { discoverInstalledSkills } from '../skills';
import type { TaskQueue } from './db';
import type { Orchestrator } from './orchestrator';

export function queueViewState(context: vscode.ExtensionContext, queue: TaskQueue, orch: Orchestrator, generating: boolean): unknown {
  const disabledMcp = new Set(queue.disabledMcpServers);
  const enabledSkillGroups = new Set(queue.enabledSkillGroups);

  return {
    type: 'state',
    tasks: queue.list(),
    stats: queue.stats(),
    status: orch.status(),
    generating,
    dbPath: queue.path,
    driver: queue.impl,
    instructions: queue.instructions,
    testingUrl: queue.testingUrl,
    testingCredentialNames: queue.testingCredentialNames,
    agentObservations: queue.agentObservations,
    models: { planner: '', supervisor: '', executor: '' },
    mcpServers: discoverMcpServers(context, getStore()).map((s) => ({
      name: s.name,
      source: s.source,
      configured: !!(s.command || s.url),
      enabled: !disabledMcp.has(s.name),
      // The server's own switch, from the settings page — separate from
      // this workspace's pick above.
      serverEnabled: s.enabled !== false,
      problem: s.problem,
      // What the last core start made of it — see coreStatus.ts.
      connection: mcpConnection(s.name),
      canSetKey: !!(s.url || s.command),
    })),
    editorTools: getBridge().tree(),
    skillGroups: [
      ...getStore().settings.skillGroups.map((g) => ({
        id: g.id,
        name: g.name,
        enabled: enabledSkillGroups.has(g.id),
        source: 'authored' as const,
        // The skills themselves, so a group can be unfolded rather than
        // taken on trust from a count.
        skills: g.skillIds
          .map((id) => getStore().settings.skills.find((s) => s.id === id))
          .filter((s): s is Skill => !!s)
          .map((s) => ({ name: s.name, description: s.description ?? '' })),
      })),
      ...discoverInstalledSkills(vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? []).map((d) => ({
        id: d.group.id,
        name: d.group.name,
        enabled: enabledSkillGroups.has(d.group.id),
        source: 'installed' as const,
        skills: [{ name: d.skill.name, description: d.skill.description ?? '' }],
      })),
    ],
  };
}
