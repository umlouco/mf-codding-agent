import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createWriteStream, promises as fsp } from 'fs';
import { get } from 'https';
import { pipeline } from 'stream/promises';

const CACHE_DIR = 'chromium';
const KNOWN_PATHS_LINUX = [
  'chromium-browser',
  'chromium',
  'google-chrome',
  'google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
];

/**
 * Playwright downloads Chromium into a per-user cache. On the Linux servers
 * this extension is used on over SSH, a project with Playwright installed has
 * already paid for that download — reusing it beats a second copy, and means
 * the agent drives the same build the project's own tests run against.
 */
function findPlaywrightChromium(output: vscode.OutputChannel): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')
      : process.platform === 'darwin'
        ? process.env.HOME && path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright')
        : process.env.HOME && path.join(process.env.HOME, '.cache', 'ms-playwright'),
  ].filter((r): r is string => !!r);

  const executables =
    process.platform === 'win32'
      ? [path.join('chrome-win64', 'chrome.exe'), path.join('chrome-win', 'chrome.exe')]
      : process.platform === 'darwin'
        ? [path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
        : [path.join('chrome-linux64', 'chrome'), path.join('chrome-linux', 'chrome')];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    // Highest build number wins — Playwright keeps old revisions around.
    const builds = entries
      .filter((e) => e.startsWith('chromium-'))
      .sort((a, b) => (parseInt(b.slice(9), 10) || 0) - (parseInt(a.slice(9), 10) || 0));
    for (const b of builds) {
      for (const exe of executables) {
      const p = path.join(root, b, exe);
      if (fs.existsSync(p)) {
        output.appendLine(`[chromium] reusing Playwright's Chromium: ${p}`);
        return p;
      }
      }
    }
  }
  return undefined;
}
const KNOWN_PATHS_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : '',
  process.env.ProgramFiles
    ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : '',
  process.env['ProgramFiles(x86)']
    ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
    : '',
  // Edge ships with Windows, so it is the fallback that always exists. Chrome
  // is preferred only because it is what most web work is checked against.
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/**
 * Finds or downloads a Chromium binary suitable for the Go core's chromedp
 * driver. On a local workspace Chrome is almost certainly present; on a
 * remote Linux server we attempt apt, then fall back to downloading from the
 * Chromium snapshot API (same source Puppeteer uses).
 *
 * Returns the resolved executable path, or undefined if nothing worked.
 *
 * There is no setting for this. Finding a browser is something the machine can
 * answer better than a person can, so the only override is the
 * `MFAGENT_CHROME_PATH` environment variable, for the rare case detection
 * picks the wrong one.
 */
export async function resolveChromium(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<string | undefined> {
  const fromEnv = process.env.MFAGENT_CHROME_PATH?.trim();
  if (fromEnv) {
    output.appendLine(`[chromium] using MFAGENT_CHROME_PATH: ${fromEnv}`);
    return fromEnv;
  }

  const isWin = process.platform === 'win32';

  // 1. Try known system paths.
  const found = findOnPath(isWin ? KNOWN_PATHS_WIN : KNOWN_PATHS_LINUX);
  if (found) {
    output.appendLine(`[chromium] found ${found}`);
    return found;
  }

  // 2. Reuse a Playwright download if the project already has one.
  const fromPlaywright = findPlaywrightChromium(output);
  if (fromPlaywright) {
    return fromPlaywright;
  }

  // 3. On Linux remotes, try apt install.
  if (process.platform === 'linux') {
    const apt = await tryAptInstall(output);
    if (apt) {
      return apt;
    }
  }

  // 3. Download a Chromium snapshot to the extension's global cache.
  const cached = await downloadChromium(context, output);
  if (cached) {
    return cached;
  }

  output.appendLine('[chromium] could not locate or download Chromium — browser tools disabled');
  return undefined;
}

function findOnPath(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes('/') || c.includes('\\')) {
      if (fs.existsSync(c)) return c;
    } else {
      try {
        const which = cp.execFileSync('which', [c], { encoding: 'utf8', timeout: 5000 }).trim();
        if (which && fs.existsSync(which)) return which;
      } catch {
        // which not available or binary not on PATH.
      }
    }
  }
  return undefined;
}

async function tryAptInstall(output: vscode.OutputChannel): Promise<string | undefined> {
  // Over SSH there is no way to answer a password prompt, so a bare `sudo`
  // blocks until the timeout and reports nothing useful. Use the privilege we
  // already have: none at all if we are not root and sudo needs a password.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  let prefix = '';
  if (!isRoot) {
    try {
      cp.execSync('sudo -n true', { timeout: 5000, stdio: 'pipe' });
      prefix = 'sudo -n ';
    } catch {
      output.appendLine('[chromium] not root and passwordless sudo unavailable — skipping apt');
      return undefined;
    }
  }

  output.appendLine('[chromium] trying apt-get install chromium-browser...');
  try {
    cp.execSync(
      `${prefix}apt-get update -qq && ${prefix}apt-get install -y -qq chromium-browser`,
      {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: 'pipe',
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      },
    );
    const paths = ['/usr/bin/chromium-browser', '/usr/bin/chromium'];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        output.appendLine(`[chromium] installed via apt: ${p}`);
        return p;
      }
    }
  } catch (e: any) {
    output.appendLine(`[chromium] apt install failed: ${String(e.stderr ?? e.message).slice(0, 300)}`);
  }
  return undefined;
}

/**
 * The Chromium snapshot bucket keys builds by an exact prefix — `Linux_x64`,
 * not `Linux`. Getting this wrong 404s, which is how the download fallback
 * silently never worked on the Linux servers this runs on over SSH. There are
 * no linux-arm64 snapshots published, so that case has to fail honestly.
 */
function snapshotTarget(): { prefix: string; archive: string; dir: string } | undefined {
  if (process.platform === 'win32') {
    return { prefix: 'Win_x64', archive: 'chrome-win.zip', dir: 'chrome-win' };
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? { prefix: 'Mac_Arm', archive: 'chrome-mac.zip', dir: 'chrome-mac' }
      : { prefix: 'Mac', archive: 'chrome-mac.zip', dir: 'chrome-mac' };
  }
  if (process.platform === 'linux' && process.arch !== 'arm64') {
    return { prefix: 'Linux_x64', archive: 'chrome-linux.zip', dir: 'chrome-linux' };
  }
  return undefined;
}

async function downloadChromium(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<string | undefined> {
  const target = snapshotTarget();
  if (!target) {
    output.appendLine(
      `[chromium] no Chromium snapshot is published for ${process.platform}/${process.arch} — ` +
        'install Chrome or Edge, or set MFAGENT_CHROME_PATH',
    );
    return undefined;
  }

  const baseCache = vscode.Uri.joinPath(context.globalStorageUri, CACHE_DIR);
  const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const extractDir = path.join(baseCache.fsPath, target.prefix);
  const exePath = path.join(extractDir, target.dir, exeName);

  if (fs.existsSync(exePath)) {
    output.appendLine(`[chromium] using cached ${exePath}`);
    return exePath;
  }

  output.appendLine(`[chromium] downloading latest Chromium for ${target.prefix}...`);

  try {
    const rev = await fetchLatestRevision(target.prefix);
    if (!rev) {
      output.appendLine('[chromium] could not determine latest Chromium revision');
      return undefined;
    }

    output.appendLine(`[chromium] revision ${rev}, downloading...`);

    const url = `https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/${target.prefix}%2F${rev}%2F${target.archive}?alt=media`;

    await fsp.mkdir(baseCache.fsPath, { recursive: true });
    const zipPath = path.join(baseCache.fsPath, target.archive);

    await downloadFile(url, zipPath, output);

    output.appendLine('[chromium] extracting...');
    await extractZip(zipPath, extractDir);

    // Clean up the zip.
    try { await fsp.unlink(zipPath); } catch { /* ok */ }

    // The archives wrap their payload in a directory (chrome-linux/ and so
    // on), but be tolerant of a flat layout too.
    const possible = [
      path.join(extractDir, target.dir, exeName),
      path.join(extractDir, exeName),
      // Mac nests the binary inside the .app bundle.
      path.join(extractDir, target.dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    for (const p of possible) {
      if (fs.existsSync(p)) {
        // The zip loses the executable bit on Unix, so restore it or the
        // launch fails with EACCES.
        if (process.platform !== 'win32') {
          try { await fsp.chmod(p, 0o755); } catch { /* best effort */ }
        }
        output.appendLine(`[chromium] ready at ${p}`);
        return p;
      }
    }

    output.appendLine('[chromium] extracted but could not find chrome binary inside');
    return undefined;
  } catch (e: any) {
    output.appendLine(`[chromium] download failed: ${String(e?.message ?? e).slice(0, 300)}`);
    return undefined;
  }
}

async function fetchLatestRevision(prefix: string): Promise<string | undefined> {
  const url = `https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/${prefix}%2FLAST_CHANGE?alt=media`;
  try {
    const body = await httpGet(url);
    return body.trim();
  } catch {
    return undefined;
  }
}

function downloadFile(url: string, dest: string, output: vscode.OutputChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        get(res.headers.location, (r2) => {
          const ws = createWriteStream(dest);
          pipeline(r2, ws).then(resolve, reject);
        }).on('error', reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ws = createWriteStream(dest);
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total % (5 * 1024 * 1024) < (chunk.length || 0)) {
          output.appendLine(`[chromium] downloaded ${Math.round(total / (1024 * 1024))}MB...`);
        }
      });
      pipeline(res, ws).then(resolve, reject);
    }).on('error', reject);
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function extractZip(zipPath: string, dest: string): Promise<void> {
  // Unzip is available on most Linux systems and on Windows via tar (Windows 10
  // build 17063+). Fall back to a Node-based approach if neither is present.
  try {
    cp.execSync(`unzip -o -q "${zipPath}" -d "${dest}"`, { timeout: 120_000, stdio: 'pipe' });
    return;
  } catch {
    // unzip not available, try 7z.
  }
  try {
    cp.execSync(`7z x "${zipPath}" -o"${dest}" -y`, { timeout: 120_000, stdio: 'pipe' });
    return;
  } catch {
    // 7z not available.
  }

  // Minimal server images often ship neither unzip nor 7z, but almost all of
  // them have python3, and Windows 10+ has bsdtar. Both read zip natively.
  for (const cmd of [
    `python3 -m zipfile -e "${zipPath}" "${dest}"`,
    `tar -xf "${zipPath}" -C "${dest}"`,
  ]) {
    try {
      fs.mkdirSync(dest, { recursive: true });
      cp.execSync(cmd, { timeout: 120_000, stdio: 'pipe' });
      return;
    } catch {
      // Try the next one.
    }
  }

  // Last resort: built-in Node unzip via zlib. Node's built-in unzip can
  // handle the zip format since Node 16, but we use a raw approach here since
  // stream/promises + zlib can decode deflate. This is a known limitation:
  // the full ZIP central directory parsing is complex — we rely on unzip/7z
  // being present on the system, which is true for any dev machine.
  throw new Error('unzip and 7z are not available — cannot extract Chromium');
}
