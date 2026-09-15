const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('official WordPress context and paged references work through the production core', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-wordpress-context-'));
  const host = await createHost({ workspace: root, log() {} });
  const { CoreClient } = host.load('src/core.ts');
  const core = new CoreClient(host.context, host.output);
  try {
    await core.start();
    await core.initialize({ disableTools: true, memoryEnabled: false, editorTerminal: false });
    const context = task => core.request('skills/context', { task });
    const unrelated = await context('Fix a REST endpoint in this VS Code extension');
    assert.equal(unrelated.text, '');
    const selected = await context('Fix a WordPress REST endpoint permission_callback');
    assert(selected.matches.some(match => match.name === 'wp-rest-api' && match.loaded));
    assert(selected.bytes <= 12000);
    assert.match(selected.text, /# WP REST API/);
    assert.doesNotMatch(selected.text, /# WP Block Themes/);
    assert.deepEqual(await context('Fix a WordPress REST endpoint permission_callback'), selected);
    assert.equal((await context('Correct a spelling mistake in README.md')).text, '');
    const tools = await core.request('tools/list');
    assert(tools.some(tool => tool.name === 'wordpress_skill'));
    const read = input => core.request('tools/invoke', { name: 'wordpress_skill', input });
    const catalog = await read({});
    assert.equal(catalog.isError, false, catalog.output);
    assert.match(catalog.output, /wp-plugin-development/);
    assert.doesNotMatch(catalog.output, /## Procedure/);
    const reference = await read({ skill: 'wp-plugin-development', file: 'references/security.md' });
    assert.equal(reference.isError, false, reference.output);
    assert.match(reference.output, /[Nn]once/);
    const script = await read({ skill: 'wp-project-triage', file: 'scripts/detect_wp_project.mjs' });
    assert.equal(script.isError, false, script.output);
    assert.match(script.output, /offset=6000/);
    assert.equal((await read({ skill: 'wp-plugin-development', file: '../../LICENSE' })).isError, true);

    // The execution host must route on this task, not its larger goal or notes.
    const runtime = host.load('src/queue/agentRuntime.ts');
    const execution = host.load('src/queue/agentExecution.ts');
    const original = runtime.runOnce;
    let captured;
    runtime.runOnce = async (_context, _output, _role, _prompt, options) => {
      captured = options.skillTask;
      return { text: host.load('src/queue/prompts.ts').executorExample, stopReason: 'end_turn', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    };
    try {
      host.queue.insert({ title: 'Correct spelling', description: 'Fix the README typo.', solutionVerifyPrompt: 'Check spelling.' }, 1);
      await execution.executeTask(host.context, host.output, host.queue.list()[0], 'History: WordPress REST block theme.', 'Wider goal: build a WordPress plugin');
      assert.match(captured, /Fix the README typo/);
      assert.doesNotMatch(captured, /WordPress|Wider goal|History/);
    } finally { runtime.runOnce = original; }
    t.diagnostic(`Loaded wp-rest-api only: ${selected.bytes} bytes; official references and script paging verified.`);
  } finally {
    core.dispose();
    await host.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
