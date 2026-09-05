import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Skill, SkillGroup } from './providers/store';

/** Skills installed globally or in the explicitly supplied workspace folders. */
export interface DiscoveredSkill {
  skill: Skill;
  group: SkillGroup;
  /** Absolute path to the skill's folder, for the UI to show where it came from. */
  dir: string;
  scope: 'user' | 'workspace';
  workspaceRoot?: string;
}

export const SKILL_INSTALL_AGENTS: readonly { id: string; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'continue', label: 'Continue' },
];

function globalSkillsDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.mfagent', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.cursor', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.continue', 'skills'),
  ];
}

/**
 * Pulls `name` and `description` out of a SKILL.md's YAML frontmatter.
 *
 * Deliberately not a YAML parser: the CLI's own schema only ever needs two
 * flat scalar fields here (see its README), so a small line-based reader
 * avoids taking on a dependency for a format this extension does not need to
 * round-trip or validate.
 */
function parseSkillMd(raw: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) {
    return { body: raw.trim() };
  }
  const [, front, body] = m;
  const fields: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    const [, key, value] = kv;
    const trimmed = value.trim();
    fields[key] = /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  }
  return { name: fields.name, description: fields.description, body: body.trim() };
}

export function discoverInstalledSkills(workspaceRoots: readonly string[] = []): DiscoveredSkill[] {
  const found = new Map<string, DiscoveredSkill>();

  const roots = [
    ...workspaceRoots.flatMap(workspaceRoot =>
      ['.agents', '.mfagent', '.claude', '.cursor', '.codex', '.opencode', '.continue', '.github'].map(agent => ({
        root: path.join(workspaceRoot, agent, 'skills'), scope: 'workspace' as const, workspaceRoot,
      }))),
    ...globalSkillsDirs().map(root => ({ root, scope: 'user' as const, workspaceRoot: undefined })),
  ];
  for (const { root, scope, workspaceRoot } of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const key = workspaceRoot ? `workspace:${encodeURIComponent(path.resolve(workspaceRoot))}:${entry.name}` : entry.name;
      const id = `installed-skill:${key}`;
      if (found.has(id)) {
        continue;
      }
      const dir = path.join(root, entry.name);
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }

      const { name, description, body } = parseSkillMd(raw);
      const skill: Skill = { id, name: name || entry.name, description, content: body };
      found.set(id, {
        skill,
        group: { id: `installed-group:${key}`, name: skill.name, skillIds: [skill.id] },
        dir, scope, workspaceRoot,
      });
    }
  }

  return [...found.values()];
}
