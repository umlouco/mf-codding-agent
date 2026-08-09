// Builds the Go core into bin/. Pass --all to cross-compile for every target
// the extension ships (Windows, macOS Intel + Apple Silicon, Linux) — Go does
// this without a toolchain per platform because nothing here uses cgo.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const coreDir = path.join(root, 'core');
const binDir = path.join(root, 'bin');

const all = process.argv.includes('--all');

const hostDir = `${process.platform}-${process.arch}`;
const hostExe = process.platform === 'win32' ? 'mfcore.exe' : 'mfcore';

/*
 * Stamp the build into the binary's version string.
 *
 * src/detect.ts prefers `bin/<exe>` over `bin/<platform>-<arch>/<exe>`, and the
 * two used to be written by different commands — so whichever you ran, the
 * other location kept an older core, and the *preferred* one could be months
 * stale without a single visible symptom. The stamp makes that legible: the
 * extension logs `core <version> ready` on every start, so the binary in use
 * identifies itself.
 */
const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const ldflags = `-s -w -X main.version=${pkgVersion}+${stamp}`;

const targets = all
  ? [
      { goos: 'windows', goarch: 'amd64', dir: 'win32-x64', exe: 'mfcore.exe' },
      { goos: 'windows', goarch: 'arm64', dir: 'win32-arm64', exe: 'mfcore.exe' },
      { goos: 'darwin', goarch: 'amd64', dir: 'darwin-x64', exe: 'mfcore' },
      { goos: 'darwin', goarch: 'arm64', dir: 'darwin-arm64', exe: 'mfcore' },
      { goos: 'linux', goarch: 'amd64', dir: 'linux-x64', exe: 'mfcore' },
      { goos: 'linux', goarch: 'arm64', dir: 'linux-arm64', exe: 'mfcore' },
    ]
  : [{ goos: '', goarch: '', dir: '', exe: hostExe }];

if (!existsSync(coreDir)) {
  console.error(`No core/ directory at ${coreDir}`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

for (const t of targets) {
  const outDir = t.dir ? path.join(binDir, t.dir) : binDir;
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, t.exe);

  const env = { ...process.env, CGO_ENABLED: '0' };
  if (t.goos) env.GOOS = t.goos;
  if (t.goarch) env.GOARCH = t.goarch;

  const label = t.dir || `${process.platform}-${process.arch}`;
  process.stdout.write(`building core for ${label}… `);
  try {
    execFileSync(
      'go',
      ['build', '-trimpath', '-ldflags', ldflags, '-o', out, './cmd/mfcore'],
      { cwd: coreDir, env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    console.error(String(e.stderr ?? e.message));
    process.exit(1);
  }
}

/*
 * Keep `bin/<exe>` and `bin/<host>/<exe>` in lockstep, whichever mode ran.
 *
 * These are the first two candidates in resolveCoreBinary, in that order, so
 * leaving one behind means the extension can spawn a core that does not match
 * the source it was built from — which is invisible until an old code path
 * shows up in an agent's report.
 */
const hostPlatformCopy = path.join(binDir, hostDir, hostExe);
const hostRootCopy = path.join(binDir, hostExe);
const [from, to] = all ? [hostPlatformCopy, hostRootCopy] : [hostRootCopy, hostPlatformCopy];

if (existsSync(from)) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`synced ${path.relative(root, to)} from ${path.relative(root, from)}`);
}

console.log(`core version ${pkgVersion}+${stamp}`);
