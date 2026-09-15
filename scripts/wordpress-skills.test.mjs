import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { updatePack } from '../support/wordpress-skills.mjs';

test('skill updates are pinned, complete, inert, reusable offline and atomic on failure', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-wp-updater-test-'));
  const source = path.join(scratch, 'source');
  const home = path.join(scratch, 'installed');
  try {
    await fs.mkdir(source);
    for (const name of ['wordpress-router', 'wp-project-triage', 'wp-plugin-development']) {
      const dir = path.join(source, 'skills', name);
      await fs.mkdir(path.join(dir, 'references'), { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# Official fixture ${name}`);
      await fs.writeFile(path.join(dir, 'references', 'details.md'), 'On-demand reference');
    }
    await fs.mkdir(path.join(source, 'shared', 'scripts'), { recursive: true });
    await fs.writeFile(path.join(source, 'shared', 'scripts', 'skillpack-build.mjs'), 'throw new Error("upstream scripts must not run");');
    await fs.writeFile(path.join(source, 'LICENSE'), 'GPL-2.0-or-later fixture');
    await fs.writeFile(path.join(source, 'README.md'), 'Upstream attribution fixture');
    const git = args => execFileSync('git', args, { cwd: source, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--quiet']);
    git(['add', '.']);
    git(['-c', 'user.name=Skill test', '-c', 'user.email=skill-test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const revision = git(['rev-parse', 'HEAD']);
    const first = await updatePack({ home, source, revision });
    assert.equal(first.revision, revision);
    assert.equal(first.skills.length, 3);
    const before = await fs.readFile(path.join(home, 'active.json'), 'utf8');
    assert.equal(JSON.parse(before).revision, revision);
    assert.equal(await fs.readFile(path.join(home, revision, 'skills', 'wp-plugin-development', 'references', 'details.md'), 'utf8'), 'On-demand reference');
    assert.equal(await fs.readFile(path.join(home, revision, 'LICENSE'), 'utf8'), 'GPL-2.0-or-later fixture');
    assert.deepEqual(await updatePack({ home, source: 'nonexistent-offline-source', revision }), first);
    await fs.rm(path.join(source, 'skills', 'wp-plugin-development', 'SKILL.md'));
    await assert.rejects(updatePack({ home, source, revision: 'latest' }));
    assert.equal(await fs.readFile(path.join(home, 'active.json'), 'utf8'), before, 'failed update changed the active pointer');
    assert(!(await fs.readdir(home)).some(name => name.startsWith('.staging-')), 'failed update left staging content');
    await assert.rejects(updatePack({ home, source, revision: '../escape' }), /Revision must/);
  } finally {
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
});
