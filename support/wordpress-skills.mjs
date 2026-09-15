// Shared by the VSIX builder and the editor's explicit Update WordPress Skills command.
// Upstream content is copied verbatim. Updates never execute upstream scripts.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'https://github.com/WordPress/agent-skills.git';
const revisionPattern = /^[a-f0-9]{40}$/;

async function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('WordPress skill download timed out. The previous pack remains active.')); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Git is required to update WordPress skills: ${error.message}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args[0]} failed: ${stderr}`)); });
  });
}

async function copyTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Skill pack contains a symlink: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of (await fs.readdir(source)).sort()) await copyTree(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) {
    if (stat.size > 4 * 1024 * 1024) throw new Error(`Unexpectedly large skill resource: ${source}`);
    await fs.copyFile(source, destination);
  } else throw new Error(`Unsupported skill resource: ${source}`);
}

export async function describePack(root, revision) {
  if (!revisionPattern.test(revision)) throw new Error('Expected an exact upstream commit SHA.');
  await fs.access(path.join(root, 'LICENSE'));
  const skills = [];
  for (const name of (await fs.readdir(path.join(root, 'skills'))).sort()) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
    const file = path.join(root, 'skills', name, 'SKILL.md');
    const body = await fs.readFile(file, 'utf8');
    if (!body.startsWith('---') || !body.includes(`name: ${name}`)) throw new Error(`Invalid skill metadata: ${name}`);
    skills.push({ name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
  }
  for (const name of ['wordpress-router', 'wp-project-triage', 'wp-plugin-development']) {
    if (!skills.some(skill => skill.name === name)) throw new Error(`Required upstream skill missing: ${name}`);
  }
  return { version: 1, repository: REPOSITORY, revision, license: 'GPL-2.0-or-later', skills };
}

async function activate(home, revision) {
  const temporary = path.join(home, `active-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(temporary, JSON.stringify({ revision }) + '\n');
  await fs.rename(temporary, path.join(home, 'active.json'));
}

export async function updatePack({ home, revision = 'latest', source }) {
  home = path.resolve(home);
  await fs.mkdir(home, { recursive: true });
  if (revision !== 'latest' && !revisionPattern.test(revision)) throw new Error('Revision must be latest or a 40-character commit SHA.');
  if (revision !== 'latest') {
    const existing = path.join(home, revision);
    try {
      const manifest = await describePack(existing, revision);
      const recorded = JSON.parse(await fs.readFile(path.join(existing, 'manifest.json'), 'utf8'));
      if (JSON.stringify(manifest) !== JSON.stringify(recorded)) throw new Error('Cached skill pack differs from its recorded source hashes.');
      await activate(home, revision);
      return manifest;
    } catch { /* Build a complete staged replacement before changing the pointer. */ }
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mf-wordpress-skills-'));
  try {
    if (!source) {
      source = path.join(scratch, 'upstream');
      await fs.mkdir(source);
      await git(['init', '--quiet'], source);
      await git(['fetch', '--depth=1', REPOSITORY, revision === 'latest' ? 'HEAD' : revision], source);
      await git(['-c', 'core.autocrlf=false', 'checkout', '--detach', '--quiet', 'FETCH_HEAD'], source);
    }
    const commit = await git(['rev-parse', 'HEAD'], source);
    if (!revisionPattern.test(commit) || revision !== 'latest' && commit !== revision) throw new Error('Upstream checkout does not match the requested revision.');
    const staged = path.join(home, `.staging-${process.pid}-${Date.now()}`);
    await fs.mkdir(staged);
    try {
      for (const name of ['skills', 'shared', 'LICENSE', 'README.md']) await copyTree(path.join(source, name), path.join(staged, name));
      const manifest = await describePack(staged, commit);
      await fs.writeFile(path.join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      const destination = path.join(home, commit);
      try { await fs.rename(staged, destination); }
      catch (error) {
        // Concurrent updates of the same immutable commit may race to publish.
        const existing = await describePack(destination, commit).catch(() => undefined);
        if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw error;
      }
      await activate(home, commit);
      return manifest;
    } finally {
      if (path.dirname(path.resolve(staged)) !== home) throw new Error('Invalid staging cleanup path');
      await fs.rm(staged, { recursive: true, force: true });
    }
  } finally {
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir())) throw new Error('Invalid download cleanup path');
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.argv[2];
  if (!home) throw new Error('Usage: node wordpress-skills.mjs <storage-directory> [latest|commit]');
  const result = await updatePack({ home, revision: process.argv[3] || 'latest' });
  console.log(JSON.stringify(result));
}
