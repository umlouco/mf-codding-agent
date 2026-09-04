import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Skill, SkillGroup } from './providers/store';

/**
 * Skill packs installed with the `npx skills` CLI
 * (https://github.com/vercel-labs/skills), e.g.
 *
 *   npx skills add WordPress/agent-skills --skill wp-plugin-development -g -a claude-code
 *
 * The `-g` there is load-bearing: without it the CLI writes into the current
 * project's `.../skills/`, visible only to that one workspace. This only reads
 * global, cross-project locations — `~/<agent>/skills/<name>/SKILL.md` —
 * because that is the one place a skill can live once and be available to
 * every workspace, which is the whole point of installing it this way instead
 * of authoring it in the Settings webview.
 *
 * Nothing here writes to any of these directories; installing and updating
 * skill packs stays the CLI's job. This only turns whatever it finds into the
 * same `Skill`/`SkillGroup` shape hand-authored skills use, discovered fresh
 * on every read — mirroring how `discoverMcpServers` (mcp.ts) treats its own
 * external source of truth.
 */
export interface DiscoveredSkill {
  skill: Skill;
  group: SkillGroup;
  /** Absolute path to the skill's folder, for the UI to show where it came from. */
  dir: string;
}

/**
 * Every global skills folder this extension reads from, in priority order —
 * the first directory a given skill name turns up in wins if it appears in
 * more than one, which just means the same pack was installed for several
 * agents.
 *
 * `add` needs a real `-a <agent>` from the CLI's own fixed list — it has no
 * generic or custom install target — so `.mfagent/skills` is here for a
 * manual drop (or a future CLI version that does add one) rather than
 * anything the CLI writes to today. The rest are read regardless of whether
 * that agent's own software is actually installed: these are just folders of
 * markdown, and scanning several instead of only Claude Code's means this
 * extension has no dependency on any one of those tools being present —
 * whichever folders exist are used, and a machine with none of them just
 * shows an empty list.
 */
/**
 * The subset of `globalSkillsDirs()` that are real `npx skills add -a <id>`
 * targets, for a picker that installs rather than just reads. `.mfagent` is
 * left out: nothing installs there yet (see `globalSkillsDirs`), so offering
 * it as an install target would just fail.
 */
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

/**
 * Scans every folder from `globalSkillsDirs()` for installed packs, each
 * becoming one read-only `Skill` plus a single-skill `SkillGroup` of the same
 * identity — so it shows up in the Task Queue's "Skill groups" picker
 * exactly like a hand-authored group, with its own enable/disable checkbox,
 * per workspace.
 *
 * IDs are derived from the folder name rather than generated, so a
 * workspace's choice to enable one survives across window reloads and
 * re-installs of the same pack.
 */
export function discoverInstalledSkills(): DiscoveredSkill[] {
  const found = new Map<string, DiscoveredSkill>();

  for (const root of globalSkillsDirs()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const id = `installed-skill:${entry.name}`;
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
        group: { id: `installed-group:${entry.name}`, name: skill.name, skillIds: [skill.id] },
        dir,
      });
    }
  }

  return [...found.values()];
}
