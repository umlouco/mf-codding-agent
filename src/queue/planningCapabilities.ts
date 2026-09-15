import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CoreClient } from '../core';
import { getStore } from '../providers/instance';
import { buildSkillsText } from '../providers/payload';
import { discoverInstalledSkills } from '../skills';
import { getActiveQueue } from './registry';

interface Capability {
  name: string;
  description: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

interface ToolResult { output: string; isError: boolean }

/** Read host facts before the first model request, including CLI and format-only planning. */
export async function planningCapabilities(client: Pick<CoreClient, 'request'>, includeSkillInstructions: boolean): Promise<string> {
  const tools = await client.request<Capability[]>('tools/list');
  if (!Array.isArray(tools) || !tools.length || tools.some(tool =>
    typeof tool.name !== 'string' || typeof tool.description !== 'string')) {
    throw new Error('Cannot plan without the workspace host tool registry. Restart or reinstall MF Agent.');
  }
  const inspect = async (name: string): Promise<string> => {
    if (!tools.some(tool => tool.name === name)) return `${name}: unavailable (not registered on this host).`;
    const result = await client.request<ToolResult>('tools/invoke', { name, input: {} });
    if (!result || typeof result.output !== 'string' || typeof result.isError !== 'boolean') {
      throw new Error(`Cannot establish planning capabilities: ${name} returned an invalid result.`);
    }
    return `${result.isError ? 'Unavailable: ' : ''}${result.output}`;
  };
  const [playwright, wordpress] = await Promise.all([
    inspect('playwright_status'), inspect('wordpress_skill'),
  ]);
  const catalog = tools.map(tool => {
    const required = new Set(tool.inputSchema?.required ?? []);
    const args = Object.keys(tool.inputSchema?.properties ?? {})
      .map(name => name + (required.has(name) ? '' : '?')).join(', ');
    return `- ${tool.name}(${args}): ${tool.description.replace(/\s+/g, ' ').slice(0, 400)}`;
  }).join('\n');

  const installed = discoverInstalledSkills(vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []);
  const store = getStore();
  const skills = [...store.settings.skills, ...installed.map(item => item.skill)];
  const groups = [...store.settings.skillGroups, ...installed.map(item => item.group)];
  const enabled = new Set(getActiveQueue()?.enabledSkillGroups ?? []);
  const enabledIds = new Set(groups.filter(group => enabled.has(group.id)).flatMap(group => group.skillIds));
  const selected = skills.filter(skill => enabledIds.has(skill.id) && skill.content.trim());
  const skillCatalog = selected.map(skill => {
    const local = installed.find(item => item.skill.id === skill.id);
    return `- ${skill.name}: ${skill.description || 'Enabled workspace instructions'}` +
      (local ? `; read ${path.join(local.dir, 'SKILL.md')}` : '');
  }).join('\n');
  const cliHome = process.env.MFAGENT_PLAYWRIGHT_HOME;
  const cliSkill = cliHome && path.join(cliHome, 'cli', '.claude', 'skills', 'playwright-cli', 'SKILL.md');
  const playwrightSkill = cliSkill && fs.existsSync(cliSkill)
    ? `Official Playwright CLI skill is bundled: ${cliSkill}. Native workers read it with playwright_skill; CLI planners can Read this path and its linked references.`
    : 'Official Playwright CLI skill file is unavailable on this host; report an extension installation problem if needed.';

  return `HOST CAPABILITIES FOR PLANNING
These facts were collected on the workspace host before this model request. Over SSH this is
the remote host, not the desktop. Use them when drafting, reviewing, repairing or expanding a plan.
The registry describes tools available to native execution workers. It does not grant this
planner extra tools: use only the inspection tools exposed by your current transport; a
format-only turn uses these supplied facts without tool calls. RPC tool names are not shell commands.

REGISTERED WORKER TOOLS (arguments ending in ? are optional)
${catalog}

PLAYWRIGHT ON THIS HOST
${playwright}

AVAILABLE SKILLS
${playwrightSkill}
${wordpress}
Enabled workspace/user skills:
${skillCatalog || '(none enabled)'}
Relevant WordPress skill bodies are selected separately from the current assignment; references
are read on demand. Skill availability does not require a task to install or recreate the skill.
${includeSkillInstructions && selected.length ? '\nENABLED SKILL INSTRUCTIONS\n' + buildSkillsText(skills, groups, enabled) + '\n' : ''}
PLANNING RULES FOR THE PROVIDED RUNTIME
- MF Agent supplies the Playwright runner, interactive CLI and skills. An absent project
  node_modules, package.json or Playwright config does not mean the runtime needs installing.
- Do not add a Playwright installation, tool setup, or generic browser-harness phase/task merely
  to prepare MF Agent. Do not copy another plugin's npm setup or pin a guessed Playwright version.
- Reuse the detected runtime and any existing suite. Put necessary application-specific specs,
  config, authentication and the first passing checks in the implementation task they verify.
  A separate reusable harness is a deliverable only when the owner explicitly requests one.
  A previous planner's setup phase or task description is not an explicit owner request.
- Missing browsers or host libraries are runtime prerequisites diagnosed from the status above;
  use the extension's setup/recovery tools when needed, not a speculative application setup task.
  Missing bundled packages are an extension installation problem, not a request to npm install
  Playwright into the application. Never describe an unprobed or failed browser as ready.
- Preserve owner-selected external test directories, target URLs and credential references.
  Use playwright_test with the selected cwd for required suite checks. No tests found, skipped
  checks, screenshots alone or an empty scaffold do not establish a passing suite.
- For TDD, keep each failing assertion and the implementation that makes it pass together.
  Existing draft setup tasks are proposals: revise them using these host facts and owner intent.
END HOST CAPABILITIES`;
}
