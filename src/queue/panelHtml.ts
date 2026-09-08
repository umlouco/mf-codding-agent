import * as vscode from 'vscode';

export function renderQueueHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
  const css = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'queue.css'),
  );
  const scripts = ['queue-terminal.js', 'queue-context.js', 'queue-tasks.js', 'queue.js']
    .map(file => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', file)));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${css}" rel="stylesheet" />
<title>MF Agent — Task Queue</title>
</head>
<body>
  <section id="pane-unavailable" class="pane unavailable" hidden>
  <h2>Task queue unavailable</h2>
  <p id="reason" class="reason"></p>
  <p id="host" class="hint"></p>
  <div class="row">
    <button id="retry" class="primary">Retry</button>
    <button id="openFolder" class="ghost" hidden>Open Folder</button>
    <button id="showLog2" class="ghost">Show log</button>
  </div>
  </section>

  <nav class="tabs">
  <button class="tab active" data-pane="run">Run</button>
  <button class="tab" data-pane="plan">Plan</button>
  <button class="tab" data-pane="context">Context</button>
  </nav>

  <section id="pane-context" class="pane" hidden>
  <div class="picker-bar">
    <input id="ctxFilter" class="picker-search" type="search" placeholder="Filter tools, servers and skills…" aria-label="Filter the context list" />
    <span id="ctxCount" class="picker-count" title="Everything switched on for this workspace">0 selected</span>
  </div>
  <p class="hint">What is checked here is what every agent in this workspace gets, in Chat and in every Task Queue run alike. Check a group to take all of it.</p>

  <h3 class="section-title">
    Tools
    <button id="ctxDefaults" class="ghost hdr-action" title="Back to the built-in edit, execute, read and search sets">Restore defaults</button>
  </h3>
  <p class="hint">Everything <code>vscode.lm.tools</code> offers, grouped by where it comes from. A checked tool reaches the agent as <code>editor__&lt;name&gt;</code> and the editor runs it. <code>edit</code>, <code>execute</code>, <code>read</code> and <code>search</code> start on; the rest is opt-in, because every definition travels with every request.</p>
  <div id="editorToolTree" class="tree"></div>

  <h3 class="section-title">MCP servers</h3>
  <p class="hint">Servers the agent's core dials itself, separately from the editor — from your VS Code user <code>mcp.json</code> and the <code>mfagent.mcpServers</code> setting.</p>
  <div id="mcpList" class="tree"></div>

  <h3 class="section-title">Skill groups</h3>
  <p class="hint">Injected into the agent's system prompt; unfold a group to read what it carries. Author them in Settings, or use "MF Agent: Install Skill Pack" (<code>npx skills add &lt;repo&gt; -g -a &lt;agent&gt;</code>) — installed packs appear here on their own.</p>
  <div id="skillGroupList" class="tree"></div>
  </section>

  <section id="pane-plan" class="pane" hidden>
  <label class="lbl" for="goal">What should the agents build?</label>
  <textarea id="goal" rows="6" placeholder="e.g. Add a REST API for invoices with auth, validation and integration tests."></textarea>
  <div class="row">
    <label class="chk"><input id="append" type="checkbox" /> Append to queue</label>
  </div>
  <button id="generate" class="primary">Generate plan</button>
  <p class="hint">The workspace is scanned and split into regions first, then the planner scopes phases over them — each phase is explored and turned into verifiable tasks with a test command once you press Start, so planning stays fast no matter how large the project is.</p>
  <details class="termwrap" open>
    <summary class="lbl">Planning and task editing output</summary>
    <pre id="plannerTerm" class="term"></pre>
  </details>

  <label class="lbl" for="editInstruction">Edit the existing tasks</label>
  <textarea id="editInstruction" rows="4" placeholder="e.g. Drop the caching task, and add integration tests for the new endpoint."></textarea>
  <button id="applyEdit">Apply edit</button>
  <p class="hint">The supervisor reads the current task list and your instruction, then edits, adds or removes tasks in place — nothing already VERIFIED is touched.</p>

  <fieldset id="testingEnvironment">
    <legend>Testing environment — applies to every task</legend>
    <label class="lbl" for="testingUrl">Testing URL</label>
    <input id="testingUrl" type="url" placeholder="https://your-application.example/path/" />
    <p class="hint">Agents must use this application instead of creating another test server. Leave blank for projects that only need terminal access.</p>
    <label class="lbl">Credentials</label>
    <div id="testingCredentials"></div>
    <button id="addTestingCredential" type="button">Add credential</button>
    <button id="saveTestingEnvironment" type="button">Save testing environment</button>
    <p class="hint">Use names such as username, password, token, or database_password. Values stay in secure storage and are available to browser and terminal tools. Leave a saved value blank to keep it. Saving restarts active workers with these settings.</p>
    <p id="testingSaved" class="hint" role="status"></p>
  </fieldset>
  <label class="lbl" for="instructions">Project notes (sent to every task)</label>
  <textarea id="instructions" rows="6" placeholder="e.g. Use Go with Wails; test with Playwright.&#10;The class list lives in classes.md.&#10;Build with build.ps1."></textarea>
  <p class="hint">Your standing instructions reach execution, verification and supervisor reviews. Agents record their findings separately below; those findings cannot change your requirements or test environment.</p>
  <details class="termwrap">
    <summary class="lbl">Agent findings (confirm before relying on them)</summary>
    <pre id="agentObservations" class="term"></pre>
  </details>
  </section>

  <section id="pane-run" class="pane">
  <div id="controls" class="row">
    <button id="start" class="primary" title="Start the autonomous run">Start</button>
    <button id="pause" title="Pause after the current task">Pause</button>
    <button id="stop" title="Stop the run">Stop</button>
    <button id="reset" title="Return every task to PENDING">Reset</button>
    <span class="spacer"></span>
    <button id="runNow" class="ghost" title="Run a supervision cycle now">Check now</button>
  </div>

  <div class="row">
    <label class="lbl" for="cron">Supervisor checks</label>
    <select id="cron" title="How often the supervisor wakes up to verify finished tasks. Saved with this task list.">
      <option value="0">Use setting</option>
      <option value="30">every 30 seconds</option>
      <option value="60">every 60 seconds</option>
      <option value="120">every 2 minutes</option>
      <option value="300">every 5 minutes</option>
      <option value="600">every 10 minutes</option>
      <option value="900">every 15 minutes</option>
      <option value="1800">every 30 minutes</option>
    </select>
  </div>

  <div id="runbar"></div>
  <div id="counts" class="counts"></div>
  <div id="tasks" class="tasks"></div>

  <div class="row foot">
    <button id="addTask" class="ghost">Add task</button>
    <button id="clearQueue" class="ghost">Clear queue</button>
    <span class="spacer"></span>
    <button id="genDocs" class="ghost">Generate Docs</button>
    <span class="spacer"></span>
    <button id="openSettings" class="ghost">Settings</button>
    <button id="showLog" class="ghost">Log</button>
  </div>
  <p id="dbinfo" class="hint"></p>
  </section>

  ${scripts.map(src => `<script nonce="${nonce}" src="${src}"></script>`).join("\n")}
</body>
</html>`;
}
