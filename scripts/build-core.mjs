// Builds the Go core into bin/. Pass --all to cross-compile for every target
// the extension ships (Windows, macOS Intel + Apple Silicon, Linux) — Go does
// this without a toolchain per platform because nothing here uses cgo.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
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

const hostMcpExe = process.platform === 'win32' ? 'mfagent-mcp.exe' : 'mfagent-mcp';

const targets = all
  ? [
      { goos: 'windows', goarch: 'amd64', dir: 'win32-x64', exe: 'mfcore.exe', mcpExe: 'mfagent-mcp.exe' },
      { goos: 'windows', goarch: 'arm64', dir: 'win32-arm64', exe: 'mfcore.exe', mcpExe: 'mfagent-mcp.exe' },
      { goos: 'darwin', goarch: 'amd64', dir: 'darwin-x64', exe: 'mfcore', mcpExe: 'mfagent-mcp' },
      { goos: 'darwin', goarch: 'arm64', dir: 'darwin-arm64', exe: 'mfcore', mcpExe: 'mfagent-mcp' },
      { goos: 'linux', goarch: 'amd64', dir: 'linux-x64', exe: 'mfcore', mcpExe: 'mfagent-mcp' },
      { goos: 'linux', goarch: 'arm64', dir: 'linux-arm64', exe: 'mfcore', mcpExe: 'mfagent-mcp' },
    ]
  : [{ goos: '', goarch: '', dir: '', exe: hostExe, mcpExe: hostMcpExe }];

if (!existsSync(coreDir)) {
  console.error(`No core/ directory at ${coreDir}`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

for (const t of targets) {
  const outDir = t.dir ? path.join(binDir, t.dir) : binDir;
  mkdirSync(outDir, { recursive: true });

  const env = { ...process.env, CGO_ENABLED: '0' };
  if (t.goos) env.GOOS = t.goos;
  if (t.goarch) env.GOARCH = t.goarch;
  const label = t.dir || `${process.platform}-${process.arch}`;

  // ---- mfcore ----
  const coreOut = path.join(outDir, t.exe);
  process.stdout.write(`building core for ${label}… `);
  try {
    execFileSync(
      'go',
      ['build', '-trimpath', '-ldflags', ldflags, '-o', coreOut, './cmd/mfcore'],
      { cwd: coreDir, env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    console.error(String(e.stderr ?? e.message));
    process.exit(1);
  }

  // ---- mfagent-mcp ----
  const mcpOut = path.join(outDir, t.mcpExe);
  process.stdout.write(`building mcp   for ${label}… `);
  try {
    execFileSync(
      'go',
      ['build', '-trimpath', '-ldflags', ldflags, '-o', mcpOut, './cmd/mfagent-mcp'],
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

/*
 * Windows refuses to overwrite a running executable, and both of these are
 * long-lived: the core is spawned by the extension, and the MCP server is
 * registered with VS Code and Claude Code, so it is running essentially
 * always. That made `build:core --all` fail with EBUSY every time.
 *
 * Windows does allow *renaming* a running image, though — the lock is on the
 * path, not the bytes. So move the live one aside and copy into the freed
 * name.
 *
 * The displaced file goes to the temp dir, never beside its replacement:
 * `.vscodeignore` force-includes `bin/**` with a negation that later patterns
 * cannot undo, so anything left in bin/ ships inside the VSIX as a second,
 * stale copy of a 7-20MB binary.
 */
function parkPath(to) {
  return path.join(tmpdir(), `mfagent-parked-${Date.now()}-${path.basename(to)}`);
}

function syncBinary(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });

  // Sweep up anything an older build left in bin/ before this moved to tmp.
  const legacyPark = `${to}.old`;
  if (existsSync(legacyPark)) {
    try {
      rmSync(legacyPark, { force: true });
    } catch {
      // Still held by a running process; try again next build.
    }
  }

  try {
    copyFileSync(from, to);
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;

    let parked = parkPath(to);
    try {
      renameSync(to, parked); // Permitted on Windows even while running.
    } catch (e2) {
      if (e2.code !== 'EXDEV') throw e2;
      // Temp is on another volume; fall back to a sibling and delete it now
      // that we know it is only the *destination* name that is locked.
      parked = legacyPark;
      renameSync(to, parked);
    }
    copyFileSync(from, to);
    console.log(
      `  (${path.basename(to)} was in use — parked the running copy; ` +
        `restart the extension to pick up the new build)`,
    );
    try {
      rmSync(parked, { force: true });
    } catch {
      // Expected while the old process lives; it is outside bin/, so it
      // cannot end up in the VSIX either way.
    }
  }
  console.log(`synced ${path.relative(root, to)} from ${path.relative(root, from)}`);
}

syncBinary(from, to);

const hostMcpPlatformCopy = path.join(binDir, hostDir, hostMcpExe);
const hostMcpRootCopy = path.join(binDir, hostMcpExe);
const [mcpFrom, mcpTo] = all ? [hostMcpPlatformCopy, hostMcpRootCopy] : [hostMcpRootCopy, hostMcpPlatformCopy];

syncBinary(mcpFrom, mcpTo);

console.log(`core version ${pkgVersion}+${stamp}`);
