import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CoreClient } from './core';

/**
 * The Playwright runtime shipped inside the extension.
 *
 * Every project used to need its own `npm install -D @playwright/test` before
 * a single browser check could run, which made the first step of any web task
 * a dependency-management problem in someone else's repository — a WordPress
 * document root, a deployment target, a tree the agent has no business adding
 * a package.json to. The runtime belongs to the tool, not to the project under
 * test, so it ships with the tool.
 *
 * `runtime/node_modules/@playwright/test` is produced at package time by
 * scripts/bundle-playwright.mjs and is not in source control.
 */
const RUNTIME_DIR = 'runtime';

export interface RuntimeStatus {
  /** Directory whose node_modules holds the runtime, or undefined when absent. */
  home?: string;
  version?: string;
}

/**
 * Resolves the bundled runtime and exports it to every process the extension
 * starts.
 *
 * The core, the queue workers and the headless host all inherit this
 * environment rather than being handed the path individually: they are spawned
 * from several places, and one of them silently missing the variable is
 * exactly the kind of difference that only shows up at 4am on a remote host.
 */
export function activatePlaywrightRuntime(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): RuntimeStatus {
  const home = path.join(context.extensionUri.fsPath, RUNTIME_DIR);
  const pkg = path.join(home, 'node_modules', '@playwright', 'test');

  if (!fs.existsSync(pkg)) {
    // Worth saying out loud. Without it the tools still work against a project
    // that owns Playwright, so the failure would otherwise appear only as an
    // agent mysteriously being told to install things.
    output.appendLine(
      `[playwright] no bundled runtime at ${pkg} — projects without their own ` +
        '@playwright/test will report a blocked environment. Run `npm run build:playwright`.',
    );
    return {};
  }

  let version: string | undefined;
  try {
    version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  } catch {
    // A readable directory with an unreadable manifest still runs.
  }

  process.env.MFAGENT_PLAYWRIGHT_HOME = home;
  output.appendLine(`[playwright] bundled runtime ready: @playwright/test ${version ?? 'unknown'} at ${home}`);
  return { home, version };
}

/**
 * Registers `browser/show`, the last rung of the browser fallback ladder.
 *
 * VS Code's Simple Browser is a sandboxed webview: pointing it at a URL is the
 * entire API. There is no DOM, no input, no screenshot. So this shows a page to
 * the person watching and returns nothing — the core's browser_show tool is
 * explicit that its result is not evidence, and this end must not imply
 * otherwise by succeeding quietly.
 */
export function registerBrowserShowHandler(client: CoreClient): void {
  client.onRequest('browser/show', async (params) => {
    const url = String((params as { url?: unknown })?.url ?? '').trim();
    if (!url) throw new Error('browser/show requires a url');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`browser/show received a malformed URL: ${url}`);
    }
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      throw new Error(`browser/show refuses the ${parsed.protocol} scheme`);
    }
    await vscode.commands.executeCommand('simpleBrowser.show', parsed.toString());
    return { shown: true, evidence: false };
  });
}
