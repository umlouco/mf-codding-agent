// The tester's closing report is the only thing a run of GUI checks is judged by. A turn that ran
// real checks but ended in prose, or was cut off at its round budget, must get one tool-free chance
// to state its verdict from the evidence it observed. It must never be re-run from scratch (minutes
// of desktop automation) or have its whole narrative dumped into the "remaining" field.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

const USAGE = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 };
const TASK = { id: 1, seq: 1, title: 'Open the wizard', description: 'Open the merge wizard from the menu.',
  solutionVerifyPrompt: 'After clicking Configuration Merge the wizard window is listed.', status: 'VERIFYING',
  attempts: 1, maxAttempts: 3, createdAt: 1, output: '', supervisorFeedback: '', validationReport: '', splitScope: '' };
const report = (conclusion, extra = {}) => JSON.stringify({ validation: { conclusion, summary: 'Judged from the observed outcomes.',
  implementationEvidence: 'Read the source.', behaviorEvidence: 'Clicked the menu; the wizard window was listed.',
  checks: [{ kind: 'command', name: 'wizard listed', passed: true, evidence: 'window found' }], remaining: '', ...extra } });

test('a cut-off or prose-only tester turn gets one tool-free chance to state its verdict', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-tester-report-'));
  const host = await createHost({ workspace: root, log() {} });
  const runtime = host.load('src/queue/agentRuntime.ts');
  const tester = host.load('src/queue/tester.ts');
  const realRunOnce = runtime.runOnce;
  // Each scripted turn may emit tool events first, then returns its reply.
  const script = turns => {
    const calls = [];
    runtime.runOnce = async (_c, _o, _role, prompt, opts) => {
      const turn = turns[calls.length];
      calls.push({ prompt, opts });
      for (const tool of turn.tools ?? []) {
        opts.onEvent?.('stream/tool', { id: tool, name: tool, status: 'running', input: {} });
        opts.onEvent?.('stream/tool', { id: tool, name: tool, status: 'done', output: 'ok' });
      }
      return { text: turn.text, stopReason: turn.stopReason ?? 'end_turn', usage: USAGE };
    };
    return calls;
  };
  try {
    await t.test('cut off at the round budget: the verdict comes from a repair pass, not the narrative dump', async () => {
      const calls = script([
        { tools: ['run_shell', 'mcp__delphi_gui__click_menu_item'], text: '[cut off after 40 tool-calling rounds]\nEverything was observed.',
          stopReason: 'max_iterations' },
        { text: report('PASS') },
      ]);
      const outcome = await tester.runTester(host.context, host.output, TASK, 'goal', '');
      assert.equal(calls.length, 2, 'exactly one repair pass, never a second full verification');
      assert.equal(calls[1].opts.formatOnly, true, 'the repair has no tools');
      assert.equal(calls[1].opts.maxIterations, 1);
      assert.match(calls[1].prompt, /run out of rounds/);
      assert.equal(outcome.report.conclusion, 'PASS');
      assert.equal(outcome.report.remaining, '');
    });

    await t.test('cut off and the repair honestly says INCOMPLETE: the unmet criteria are named, not the whole dump', async () => {
      script([
        { tools: ['run_shell'], text: 'long progress note '.repeat(50), stopReason: 'max_iterations' },
        { text: report('INCOMPLETE', { remaining: 'The wizard window was never listed after the click.' }) },
      ]);
      const outcome = await tester.runTester(host.context, host.output, TASK, 'goal', '');
      assert.equal(outcome.report.conclusion, 'INCOMPLETE');
      assert.equal(outcome.report.remaining, 'The wizard window was never listed after the click.');
    });

    await t.test('prose instead of JSON is repaired once, and a PASS still needs an executed check', async () => {
      script([
        { tools: ['read_file'], text: 'Everything looks fine, I read the code.' },
        { text: report('PASS') },
      ]);
      const outcome = await tester.runTester(host.context, host.output, TASK, 'goal', '');
      assert.equal(outcome.report.conclusion, 'INCOMPLETE', 'a read is not an executed check');
      assert.match(outcome.report.remaining, /without executing/);
    });

    await t.test('a PASS whose remaining field only holds a caveat is settled by one repair, not a retest', async () => {
      const caveat = 'Nothing required by this ticket is outstanding. The wizard flow itself was deliberately not opened.';
      const calls = script([
        { tools: ['run_shell', 'mcp__delphi_gui__click_menu_item'], text: report('PASS', { remaining: caveat }) },
        { text: report('PASS', { summary: caveat }) },
      ]);
      const outcome = await tester.runTester(host.context, host.output, TASK, 'goal', '');
      assert.equal(calls.length, 2, 'one repair pass, not a second full verification');
      assert.match(calls[1].prompt, /concluded PASS but its "remaining" field says: Nothing required/);
      assert.equal(outcome.report.conclusion, 'PASS');
      assert.equal(outcome.report.remaining, '');
    });

    await t.test('a PASS whose remaining field names a real unmet criterion stays incomplete', async () => {
      script([
        { tools: ['run_shell', 'mcp__delphi_gui__click_menu_item'], text: report('PASS', { remaining: 'The wizard window was not listed.' }) },
        { text: report('INCOMPLETE', { remaining: 'The wizard window was not listed.' }) },
      ]);
      const outcome = await tester.runTester(host.context, host.output, TASK, 'goal', '');
      assert.equal(outcome.report.conclusion, 'INCOMPLETE');
      assert.match(outcome.report.remaining, /wizard window was not listed/);
    });

    await t.test('the report schema asks for unmet criteria only in remaining', () => {
      assert.match(tester.testerReportExample, /NOT complete/);
      assert.match(tester.testerReportExample, /notes and caveats in summary/i);
    });

    await t.test('a repair that fails or is itself halted leaves the original incomplete report in place', async () => {
      const calls = script([
        { tools: ['run_shell'], text: 'progress', stopReason: 'context_limit' },
        { text: 'still not json', stopReason: 'max_iterations' },
      ]);
      const outcome = await tester.runTester(host.context, host.output, TASK, 'goal', '');
      assert.equal(calls.length, 2);
      assert.equal(outcome.report.conclusion, 'INCOMPLETE');
      assert.match(outcome.report.summary, /stopped before it finished/);
    });

    await t.test('an ownership stop is not repaired: no repair pass can change what was refused', async () => {
      const calls = script([
        { tools: [], text: 'Execution stopped: queue ownership: validator ...', stopReason: 'supervisor_repair_required' },
      ]);
      await tester.runTester(host.context, host.output, TASK, 'goal', '');
      assert.equal(calls.length, 1);
    });
  } finally {
    runtime.runOnce = realRunOnce;
    await host.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
