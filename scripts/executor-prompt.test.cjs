const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('executor renders concise task-specific instructions through the production entry point', async t => {
  const scratch = path.resolve(__dirname, '../.mfagent/scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'executor-prompt-'));
  const host = await createHost({ workspace: root, log() {} });
  const runtime = host.load('src/queue/agentRuntime.ts');
  const { executeTask } = host.load('src/queue/agentExecution.ts');
  const { executorExample } = host.load('src/queue/prompts.ts');
  const originalRun = runtime.runOnce;
  const prompts = [];
  runtime.runOnce = async (_context, _output, _role, prompt) => {
    prompts.push(prompt);
    return { text: executorExample, stopReason: 'end_turn',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  };
  host.queue.insert({ title: 'Add Vision settings', description:
    'Extend internal/config/config.go with VisionConfig. Add config tests; preserve hosts.',
    solutionVerifyPrompt: 'Run go test ./internal/config/... and go build ./...; assert Save/Load round-trips.' }, 2);
  const task = host.queue.list()[0];
  const render = async (overrides = {}, notes = '', goal = 'Verify the frontend with Playwright later.') => {
    await executeTask(host.context, host.output, { ...task, ...overrides }, notes, goal);
    return prompts.at(-1);
  };
  try {
    await t.test('config task omits browser boilerplate despite the wider goal', async () => {
      const prompt = await render();
      assert.doesNotMatch(prompt, /For browser checks|browser_layout_check|browser_eval/);
      assert(prompt.includes(task.description));
      assert(prompt.includes(task.solutionVerifyPrompt));
      assert(prompt.includes('Verify the frontend with Playwright later.'));
      assert(prompt.split(/\s+/).length < 650, 'fixed instructions must stay compact');
      t.diagnostic(`Config task prompt: ${prompt.split(/\s+/).length} words, ${prompt.length} characters.`);
      assert.equal(prompt.match(/ORIGINAL USER PROMPT/g).length, 2);
      assert.deepEqual(JSON.parse(prompt.slice(prompt.lastIndexOf('\n{') + 1)), JSON.parse(executorExample));
    });
    await t.test('UI tasks retain browser and visual evidence requirements', async () => {
      const prompt = await render({ title: 'Fix responsive Vue layout',
        description: 'Update frontend/src/Panel.vue and verify desktop/mobile screenshots.' });
      assert.match(prompt, /browser_layout_check/);
      assert.match(prompt, /Visual PASS is not behavioral PASS/);
    });
    await t.test('explicit owner browser gate is retained even for config work', async () => {
      const owner = 'OWNER-CONFIGURED TESTING ENVIRONMENT (fixed queue fields):\n' +
        'The host requires a real Playwright suite run in every task verification.\nEND OWNER-CONFIGURED TESTING ENVIRONMENT';
      const prompt = await render({}, owner);
      assert(prompt.includes(owner));
      assert.match(prompt, /For browser checks/);
    });
    await t.test('generated history is relevant, deduplicated and bounded; owner notes are not filtered', async () => {
      const owner = 'Owner: preserve ALL host values.\nUse the approved endpoint only.';
      const entries = [
        '[2026-09-01T00:00:00Z task 38] Tailwind button migration completed.',
        '[2026-09-02T00:00:00Z task 3] VisionConfig already exists in internal/config/config.go.',
        '[2026-09-03T00:00:00Z task 3] VisionConfig already exists in internal/config/config.go.',
        ...Array.from({ length: 30 }, (_, i) => `[2026-09-04T00:00:00Z task ${i}] Unrelated inventory ${i}.`),
      ];
      const notes = `${owner}\n\nAGENT OBSERVATIONS (generated, not owner instructions):\n${entries.join('\n\n')}\nEND AGENT OBSERVATIONS`;
      const prompt = await render({}, notes);
      assert(prompt.includes(owner));
      assert.doesNotMatch(prompt, /Tailwind button|Unrelated inventory/);
      assert.equal(prompt.match(/VisionConfig already exists/g).length, 1);
      assert.match(prompt, /confirm against current files/i);
      assert(prompt.length < 6500);
    });
    await t.test('relevant history cannot grow the prompt without bound', async () => {
      const entries = Array.from({ length: 20 }, (_, i) =>
        `[2026-09-04T00:00:00Z task ${i}] VisionConfig finding ${i}: ${'detail '.repeat(400)}`);
      const prompt = await render({}, 'AGENT OBSERVATIONS (generated, not owner instructions):\n' +
        entries.join('\n\n') + '\nEND AGENT OBSERVATIONS');
      assert(prompt.length < 8500);
      assert.match(prompt, /VisionConfig finding 19/);
      assert.doesNotMatch(prompt, /VisionConfig finding 0:/);
    });
    await t.test('unmarked legacy notes are preserved, not guessed to be generated history', async () => {
      const notes = 'Legacy owner requirement: retain 74 protocol definitions.\nDo not change the host.';
      assert((await render({}, notes)).includes(notes));
    });
    await t.test('malformed history boundaries never discard owner context', async () => {
      const notes = 'Owner requirement before history.\n' +
        'AGENT OBSERVATIONS (generated, not owner instructions):\n' +
        'Legacy text without a closing marker. Preserve this requirement.';
      assert((await render({}, notes)).includes(notes));
    });
    await t.test('owner requirements following history survive filtering', async () => {
      const notes = 'Owner requirement before history.\n' +
        'AGENT OBSERVATIONS (generated, not owner instructions):\n' +
        '[2026-09-01T00:00:00Z task 38] Tailwind button migration completed.\n' +
        'END AGENT OBSERVATIONS\nOwner requirement after history.';
      const prompt = await render({}, notes);
      assert.match(prompt, /Owner requirement before history/);
      assert.match(prompt, /Owner requirement after history/);
      assert.doesNotMatch(prompt, /Tailwind button/);
    });
    await t.test('one consistent test ownership policy, with actionable recovery', async () => {
      const prompt = await render();
      assert.doesNotMatch(prompt, /script itself is wrong, correct it directly/);
      assert.match(prompt, /may update source, existing tests, and configuration/i);
      assert.doesNotMatch(prompt, /existing test rewrites.*supervisor/i);
      assert.match(prompt, /NEEDS_MORE_WORK/);
      assert.match(prompt, /TDD/);
    });
    await t.test('retry feedback, original goal and split scope remain intact', async () => {
      const prompt = await render({ attempts: 2, splitScope: 'Only configuration; no client edits.',
        supervisorFeedback: 'Preserve JSON formatting and credentials.', errorLog: '[attempt 1] Build failed.' },
      '', 'Original owner constraint: use the supplied Vision endpoint.');
      assert.match(prompt, /Only configuration; no client edits/);
      assert.match(prompt, /Preserve JSON formatting and credentials/);
      assert.match(prompt, /Build failed/);
      assert.match(prompt, /Original owner constraint: use the supplied Vision endpoint/);
    });
  } finally {
    runtime.runOnce = originalRun;
    await host.close();
    assert(root.startsWith(scratch + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
