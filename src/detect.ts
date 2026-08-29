import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Everything MF Agent works out for itself.
 *
 * None of this belongs in `settings.json`: a database path derived from the
 * workspace root, the languages a repo is obviously written in, and the
 * location of a binary we ship are all facts, not preferences. They are
 * computed here and *shown* on the settings page so you can see what was found
 * without being asked to maintain it.
 *
 * Each has an environment-variable escape hatch for the rare case detection is
 * wrong, which keeps the override out of the UI where it would read as
 * something you are expected to fill in.
 */

export interface CoreBinary {
  path?: string;
  source: 'env' | 'bundled' | 'platform-dir' | 'repo';
  searched: string[];
}

export interface Detected {
  workspaceRoot: string;
  languages: string[];
  memoryDb: string;
  queueDb: string;
  screenshotDir: string;
  core: CoreBinary;
  chromium?: string;
  remote?: string;
}

// ---- paths ---------------------------------------------------------------

export function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

/** The per-workspace state directory. Everything we write lives under it. */
export function stateDir(root = workspaceRoot()): string {
  return root ? path.join(root, '.mfagent') : '';
}

export function memoryDbPath(root = workspaceRoot()): string {
  return root ? path.join(stateDir(root), 'memory.db') : '';
}

export function queueDbPath(root = workspaceRoot()): string {
  return root ? path.join(stateDir(root), 'queue.db') : '';
}

export function screenshotDir(root = workspaceRoot()): string {
  return root ? path.join(stateDir(root), 'screenshots') : '';
}

// ---- core binary ---------------------------------------------------------

/**
 * Locates the compiled Go core. Packaged builds carry it in `bin/`; a dev
 * checkout may have it one level up or in a per-platform subdirectory.
 */
export function resolveCoreBinary(context: vscode.ExtensionContext): CoreBinary {
  const fromEnv = process.env.MFAGENT_CORE_PATH?.trim();
  if (fromEnv) {
    return { path: fs.existsSync(fromEnv) ? fromEnv : undefined, source: 'env', searched: [fromEnv] };
  }

  const exe = process.platform === 'win32' ? 'mfcore.exe' : 'mfcore';
  const candidates: [string, CoreBinary['source']][] = [
    [path.join(context.extensionPath, 'bin', exe), 'bundled'],
    [
      path.join(context.extensionPath, 'bin', `${process.platform}-${process.arch}`, exe),
      'platform-dir',
    ],
    [path.join(context.extensionPath, '..', 'bin', exe), 'repo'],
  ];

  for (const [candidate, source] of candidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, source, searched: candidates.map(([c]) => c) };
    }
  }
  return { source: 'bundled', searched: candidates.map(([c]) => c) };
}

/**
 * Locates the MCP server binary (mfagent-mcp), using the same candidate
 * directories as the core binary.
 */
export function resolveMcpBinary(context: vscode.ExtensionContext): string | undefined {
  const exe = process.platform === 'win32' ? 'mfagent-mcp.exe' : 'mfagent-mcp';
  const candidates = [
    path.join(context.extensionPath, 'bin', exe),
    path.join(context.extensionPath, 'bin', `${process.platform}-${process.arch}`, exe),
    path.join(context.extensionPath, '..', 'bin', exe),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

// ---- languages -----------------------------------------------------------

/**
 * Marker globs, most specific first. A language is claimed on the first file
 * that matches, so `composer.json` and `*.php` both mean PHP but only cost one
 * hit between them.
 */
const MARKERS: { language: string; globs: string[] }[] = [
  { language: 'PHP', globs: ['**/composer.json', '**/*.php'] },
  { language: 'TypeScript', globs: ['**/tsconfig.json', '**/*.ts', '**/*.tsx'] },
  { language: 'JavaScript', globs: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'] },
  { language: 'Go', globs: ['**/go.mod', '**/*.go'] },
  { language: 'Delphi/Object Pascal', globs: ['**/*.dpr', '**/*.dproj', '**/*.pas', '**/*.lpr'] },
  { language: 'Python', globs: ['**/pyproject.toml', '**/requirements.txt', '**/*.py'] },
  { language: 'Rust', globs: ['**/Cargo.toml', '**/*.rs'] },
  { language: 'C#', globs: ['**/*.csproj', '**/*.sln', '**/*.cs'] },
  { language: 'Java', globs: ['**/pom.xml', '**/build.gradle', '**/*.java'] },
  { language: 'Kotlin', globs: ['**/*.kt', '**/*.kts'] },
  { language: 'Ruby', globs: ['**/Gemfile', '**/*.rb'] },
  { language: 'C/C++', globs: ['**/CMakeLists.txt', '**/*.cpp', '**/*.cc', '**/*.c', '**/*.h'] },
  { language: 'Swift', globs: ['**/Package.swift', '**/*.swift'] },
  { language: 'Dart/Flutter', globs: ['**/pubspec.yaml', '**/*.dart'] },
  { language: 'Vue', globs: ['**/*.vue'] },
  { language: 'Svelte', globs: ['**/*.svelte'] },
  { language: 'SQL', globs: ['**/*.sql'] },
  { language: 'Shell', globs: ['**/*.sh', '**/*.bash'] },
  { language: 'PowerShell', globs: ['**/*.ps1', '**/*.psm1'] },
  { language: 'HTML/CSS', globs: ['**/*.html', '**/*.scss', '**/*.css'] },
];

const EXCLUDE =
  '{**/node_modules/**,**/vendor/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/target/**,**/.venv/**,**/__pycache__/**}';

let cached: { root: string; languages: string[] } | undefined;

/**
 * Works out which languages the workspace is written in.
 *
 * Result is memoised per root — a language set does not change often enough to
 * justify re-globbing on every core restart, and `Rescan` on the settings page
 * clears it when it does.
 */
export async function detectLanguages(root = workspaceRoot()): Promise<string[]> {
  if (!root) {
    return [];
  }
  if (cached?.root === root) {
    return cached.languages;
  }

  const hits = await Promise.all(
    MARKERS.map(async ({ language, globs }) => {
      for (const glob of globs) {
        const found = await vscode.workspace.findFiles(glob, EXCLUDE, 1);
        if (found.length > 0) {
          return language;
        }
      }
      return undefined;
    }),
  );

  const languages = hits.filter((l): l is string => !!l);
  cached = { root, languages };
  return languages;
}

export function clearLanguageCache(): void {
  cached = undefined;
}

// ---- report --------------------------------------------------------------

/** The read-only summary the settings page renders under "Detected". */
export async function detect(
  context: vscode.ExtensionContext,
  languages: string[],
  chromium?: string,
): Promise<Detected> {
  const root = workspaceRoot();
  return {
    workspaceRoot: root,
    languages,
    memoryDb: memoryDbPath(root),
    queueDb: queueDbPath(root),
    screenshotDir: screenshotDir(root),
    core: resolveCoreBinary(context),
    chromium,
    remote: vscode.env.remoteName,
  };
}
