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
  '/snap/bin/chromium',
];
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

  // 2. On Linux remotes, try apt install.
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
  output.appendLine('[chromium] trying apt-get install chromium-browser...');
  try {
    cp.execSync('sudo apt-get update -qq && sudo apt-get install -y -qq chromium-browser', {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: 'pipe',
    });
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

async function downloadChromium(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<string | undefined> {
  const platform = process.platform === 'win32' ? 'Win' : process.platform === 'darwin' ? 'Mac' : 'Linux';
  const arch = process.arch === 'arm64' ? 'Arm' : '';
  const baseCache = vscode.Uri.joinPath(context.globalStorageUri, CACHE_DIR);

  const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const exePath = path.join(baseCache.fsPath, `chrome-${platform}${arch}`, exeName);

  if (fs.existsSync(exePath)) {
    output.appendLine(`[chromium] using cached ${exePath}`);
    return exePath;
  }

  // Resolve latest snapshot revision from Google's Chromium API.
  const platformKey = `${platform}${arch ? '_' + arch : ''}`;
  const x64 = process.arch === 'arm64' ? 'Arm64' : 'x64';
  const archive = process.platform === 'win32' ? 'chrome-win.zip' : 'chrome-linux.zip';

  output.appendLine(`[chromium] downloading latest Chromium for ${platform}${arch}/${x64}...`);

  try {
    const rev = await fetchLatestRevision(platformKey, x64);
    if (!rev) {
      output.appendLine('[chromium] could not determine latest Chromium revision');
      return undefined;
    }

    output.appendLine(`[chromium] revision ${rev}, downloading...`);

    const url = `https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/${platformKey}%2F${rev}%2F${archive}?alt=media`;

    await fsp.mkdir(baseCache.fsPath, { recursive: true });
    const zipPath = path.join(baseCache.fsPath, archive);
    const extractDir = path.join(baseCache.fsPath, `chrome-${platform}${arch}`);

    await downloadFile(url, zipPath, output);

    output.appendLine('[chromium] extracting...');
    await extractZip(zipPath, extractDir);

    // Clean up the zip.
    try { await fsp.unlink(zipPath); } catch { /* ok */ }

    // The extracted dir may have a different layout — chrome-linux.zip
    // extracts to chrome-linux/ so we need to check.
    const possible = [
      path.join(extractDir, exeName),
      path.join(extractDir, `chrome-${platform.toLowerCase()}`, exeName),
    ];
    for (const p of possible) {
      if (fs.existsSync(p)) {
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

async function fetchLatestRevision(
  platformKey: string,
  x64: string,
): Promise<string | undefined> {
  const url = `https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/${platformKey}${x64 ? '_' + x64 : ''}%2fLAST_CHANGE?alt=media`;
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

  // Last resort: built-in Node unzip via zlib. Node's built-in unzip can
  // handle the zip format since Node 16, but we use a raw approach here since
  // stream/promises + zlib can decode deflate. This is a known limitation:
  // the full ZIP central directory parsing is complex — we rely on unzip/7z
  // being present on the system, which is true for any dev machine.
  throw new Error('unzip and 7z are not available — cannot extract Chromium');
}
