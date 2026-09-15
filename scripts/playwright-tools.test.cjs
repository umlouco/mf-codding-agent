const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('Playwright tools and recovery use the production core registry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-playwright-tools-'));
  const host = await createHost({ workspace: root, log() {} });
  const { VerificationSession } = host.load('src/queue/verificationPlanRunner.ts');
  const session = new VerificationSession(host.context, host.output, () => {});
  const agents = host.load('src/queue/agentRuntime.ts');
  const originalRun = agents.runOnce;
  try {
    await session.start(host.context);
    const invoke = (name, input) => session.client.request('tools/invoke', { name, input });
    for (const name of ['playwright_skill', 'playwright_cli', 'playwright_status', 'playwright_install', 'playwright_test', 'run_shell']) {
      assert(session.capabilities.some(tool => tool.name === name), `${name} missing from actual registry`);
    }
    const skill = await invoke('playwright_skill', {});
    assert.equal(skill.isError, false, skill.output);
    assert.match(skill.output, /# Browser Automation with playwright-cli/);
    assert.match(skill.output, /"args":\["click","e15"\]/);
    const reference = skill.output.match(/references\/[\w-]+\.md/)[0];
    const guide = await invoke('playwright_skill', { reference });
    assert.equal(guide.isError, false, guide.output);
    assert.equal((await invoke('playwright_skill', { reference: '../package.json' })).isError, true);
    const help = await invoke('playwright_cli', { args: ['--help'] });
    assert.equal(help.isError, false, help.output);
    assert.match(help.output, /snapshot/);
    assert.equal(help.meta.exitCode, 0);
    const invalid = await invoke('playwright_cli', { args: ['no-such-playwright-command'] });
    assert.equal(invalid.isError, true, invalid.output);
    assert.notEqual(invalid.meta.exitCode, 0);
    if (process.env.MFAGENT_BROWSER_SMOKE === '1') {
      // Exercise the actual CLI/browser transport; this fixture tests the
      // extension tool itself, not the owner's remote application.
      const install = await invoke('playwright_cli', { args: ['install-browser', 'chromium'], timeout_seconds: 600 });
      assert.equal(install.isError, false, install.output);
      try {
        const url = 'data:text/html,' + encodeURIComponent('<title>MF Agent CLI smoke</title><label>Name<input></label><button onclick="document.title=document.querySelector(\'input\').value">Save</button>');
        const opened = await invoke('playwright_cli', { args: ['open', url] });
        assert.equal(opened.isError, false, opened.output);
        const code = 'async page => { await page.getByRole("textbox").fill("spaces & quotes \\\" work"); await page.getByRole("button", {name:"Save"}).click(); return await page.title(); }';
        const interacted = await invoke('playwright_cli', { args: ['run-code', code] });
        assert.equal(interacted.isError, false, interacted.output);
        assert.match(interacted.output, /spaces & quotes/);
        const snapshot = await invoke('playwright_cli', { args: ['snapshot'] });
        assert.equal(snapshot.isError, false, snapshot.output);
        assert.match(snapshot.output, /Snapshot/);
        const shot = await invoke('playwright_cli', { args: ['screenshot', '--filename=smoke.png'] });
        assert.equal(shot.isError, false, shot.output);
        assert(fs.statSync(path.join(root, 'smoke.png')).size > 100);
        t.diagnostic('Real headless Chromium: install, open, fill, click, snapshot and screenshot passed through tools/invoke.');
      } finally { await invoke('playwright_cli', { args: ['close'] }); }
      const suite = path.join(root, 'tests', 'e2e');
      fs.mkdirSync(suite, { recursive: true });
      fs.writeFileSync(path.join(suite, 'playwright.config.cjs'), `
module.exports = { projects: [
  { name: 'desktop', use: { headless: true, viewport: { width: 1280, height: 800 } } },
  { name: 'mobile', use: { headless: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
] };`);
      fs.writeFileSync(path.join(suite, 'browser.spec.cjs'), `
const { test, expect } = require('@playwright/test');
test('host browser transport', async ({ page }) => {
  await page.setContent('<label>Name<input></label><button>Save</button>');
  await page.getByRole('textbox').fill('host browser works');
  await expect(page.getByRole('textbox')).toHaveValue('host browser works');
});`);
      // Empty input exercises the mandatory verifier's conventional-suite discovery.
      const suiteResult = await invoke('playwright_test', {});
      assert.equal(suiteResult.isError, false, suiteResult.output);
      assert.match(suiteResult.output, /2 passed, 0 failed/);
      const status = await invoke('playwright_status', { cwd: 'tests/e2e' });
      assert.match(status.output, /Headless Chromium launch passed/);
      t.diagnostic('Real nested suite: desktop/mobile both passed; suite runtime headless launch probe passed.');
    }

    host.queue.insert({ title: 'Repair Playwright setup', description: 'Install missing Chromium.', solutionVerifyPrompt: 'Run real tests.' }, 1);
    const task = host.queue.list()[0];
    const { decideRecovery, parseRecoveryDecision } = host.load('src/queue/recoveryDecision.ts');
    const operation = { action: 'EXECUTE', reason: 'Missing executable', guidance: 'Install suite browser.',
      nextOperation: { tool: 'playwright_install', input: { with_deps: false, cwd: 'tests/e2e' } } };
    let captured = '';
    agents.runOnce = async (_context, _output, _role, prompt) => {
      captured = prompt;
      return { text: JSON.stringify(operation), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    };
    const result = await decideRecovery(host.context, host.output, task, 'Missing Chromium executable', {});
    assert.equal(result.decision.nextOperation.tool, 'playwright_install');
    assert.match(captured, /REGISTERED NEXT-STEP TOOLS/);
    assert.match(captured, /"name":"run_shell"/);
    assert.match(captured, /"with_deps":\{"description"|"with_deps":\{"type"/);
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...operation,
      nextOperation: { tool: 'terminal', input: {} } }), task, session.capabilities), /unregistered tool/);
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...operation,
      nextOperation: { tool: 'playwright_cli', input: { args: 'open' } } }), task, session.capabilities), /type array/);
    t.diagnostic('Official skill, references, CLI help/error receipts, real schemas and recovery rejection verified.');
  } finally {
    agents.runOnce = originalRun;
    session.stop();
    await host.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
