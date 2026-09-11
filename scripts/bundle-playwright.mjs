// Builds the Playwright runtime that ships inside the VSIX.
//
// The agent must never have to install Playwright into the project it is
// testing. That project is frequently something like a WordPress document
// root: adding a package.json and a node_modules to it is not setup, it is
// damage, and the one night this was left to the agent it spent entirely on
// an `npm install` that a queue guardrail would never have let through.
//
// So the runtime is a build artifact of the extension. It is installed here,
// at package time, into runtime/node_modules, and shipped as-is.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime');

// Pinned deliberately. A floating range would mean two builds of the same
// extension commit shipping different Playwright versions, and a spec that
// passes for one person failing for the next with no diff to point at.
const VERSION = '1.55.0';

const force = process.argv.includes('--force');

function installed() {
  const manifest = join(runtime, 'node_modules', '@playwright', 'test', 'package.json');
  if (!existsSync(manifest)) return undefined;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return undefined;
  }
}

const current = installed();
if (current === VERSION && !force) {
  console.log(`[playwright] runtime already at ${VERSION}`);
  process.exit(0);
}
if (current) {
  console.log(`[playwright] replacing ${current} with ${VERSION}`);
  rmSync(join(runtime, 'node_modules'), { recursive: true, force: true });
}

mkdirSync(runtime, { recursive: true });

// A private manifest of its own keeps npm from walking up and treating the
// extension's own dependencies as this install's context.
writeFileSync(
  join(runtime, 'package.json'),
  JSON.stringify(
    {
      name: 'mf-agent-playwright-runtime',
      version: '1.0.0',
      private: true,
      description:
        'Playwright runtime shipped inside the MF Agent extension so no project under test needs its own install.',
      dependencies: { '@playwright/test': VERSION },
    },
    null,
    2,
  ) + '\n',
);

console.log(`[playwright] installing @playwright/test@${VERSION} into runtime/`);
const windows = process.platform === 'win32';
execFileSync(
  windows ? 'npm.cmd' : 'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
  {
    cwd: runtime,
    stdio: 'inherit',
    // Node 20 refuses to spawn a .cmd without a shell (EINVAL), and npm on
    // Windows is a .cmd. Every argument here is a fixed literal, so there is
    // nothing for the shell to reinterpret.
    shell: windows,
    // Browser binaries are per-host and far too large to ship. They are
    // fetched on the workspace host by playwright_install, and on most servers
    // they are already in ~/.cache/ms-playwright before we ever ask.
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  },
);

// Trim what a runtime never reads. This is ~40% of the tree and all of it is
// dead weight inside a VSIX that is already large.
const DROP = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github', 'man']);
const DROP_FILE = /\.(md|markdown|map|ts\.map|flow)$|^(?:AUTHORS|CHANGELOG|CONTRIBUTING|HISTORY|README)/i;

async function prune(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Never prune inside Playwright's own bundled browser support code: it
      // ships fixtures and .md files that its injected scripts actually read.
      if (full.includes(join('playwright-core', 'lib'))) continue;
      // A directory with a package.json is a package, whatever it is called.
      // The package we are shipping is named `test` — deleting it as though it
      // were a test folder is exactly the kind of thing this script must not do.
      if (existsSync(join(full, 'package.json'))) {
        removed += await prune(full);
        continue;
      }
      if (DROP.has(entry.name.toLowerCase())) {
        const { size } = await du(full);
        await rm(full, { recursive: true, force: true });
        removed += size;
        continue;
      }
      removed += await prune(full);
    } else if (DROP_FILE.test(entry.name) && !entry.name.startsWith('LICENSE')) {
      const info = await stat(full).catch(() => undefined);
      await rm(full, { force: true });
      removed += info?.size ?? 0;
    }
  }
  return removed;
}

async function du(dir) {
  let size = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) size += (await du(full)).size;
    else size += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return { size };
}

const saved = await prune(join(runtime, 'node_modules'));
const total = (await du(join(runtime, 'node_modules'))).size;

const final = installed();
if (final !== VERSION) {
  console.error(`[playwright] install did not produce ${VERSION} (found ${final ?? 'nothing'})`);
  process.exit(1);
}
console.log(
  `[playwright] runtime ready: @playwright/test ${final}, ` +
    `${(total / 1024 / 1024).toFixed(1)}MB shipped (${(saved / 1024 / 1024).toFixed(1)}MB pruned)`,
);
console.log(`[playwright] location: ${relative(root, runtime)}`);
