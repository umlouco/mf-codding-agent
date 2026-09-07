// Exercise the real supervisor parser/repair pipeline with deterministic provider replies.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadQueueAgents } = require('./queue-agent-loader.cjs');

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const task = { id: 1, seq: 45, createdAt: 1, startedAt: 2, title: 'Migrate all interfaces',
  description: 'Migrate all interfaces and preserve the original acceptance criteria.',
  implVerifyPrompt: 'Inspect implementation', solutionVerifyPrompt: 'Exercise requested behavior',
  solutionVerifyCommand: '', attempts: 3, maxAttempts: 3, region: '',
  errorLog: '', supervisorFeedback: '', output: '', validationReport: '' };
const part = i => ({ title: `Migrate interface ${i}`, description: `Implement migration for discovered interface ${i}.`,
  implVerifyPrompt: `Inspect migrated interface ${i}.`, solutionVerifyPrompt: `Exercise interface ${i}.`,
  solutionVerifyCommand: '' });
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(replies) {
  const agents = loadQueueAgents({
    vscode: { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } },
  });
  const prompts = [];
  agents.setTestRunner(async (_context, _output, _role, prompt) => {
    prompts.push(prompt);
    assert.ok(replies.length, 'must not synthesize another model retry for a malformed split');
    const reply = replies.shift();
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), usage, stopReason: 'end_turn' };
  });
  return { agents, prompts, review: (current = task) => agents.superviseTask({}, {}, current, 0, task.description) };
}

test('direct SPLIT preserves every one of 27 complete parts and full titles', async () => {
  const splitInto = Array.from({ length: 27 }, (_, index) => part(index));
  splitInto[26].title = 'Final integration and acceptance '.repeat(12).trim();
  const f = fixture([{ verdict: 'SPLIT', feedback: 'Independent discovered units', splitInto }]);
  const decision = await f.review();
  assert.equal(decision.verdict, 'SPLIT');
  assert.deepEqual(plain(decision.splitInto), splitInto);
  assert.equal(f.prompts.length, 1);
});

test('attempt-ceiling escalation also preserves the complete 27-part replacement', async () => {
  const splitInto = Array.from({ length: 27 }, (_, index) => part(index));
  const f = fixture([{ verdict: 'RETRY', feedback: 'Several independent unfinished units' }, { splitInto }]);
  const decision = await f.review();
  assert.equal(decision.verdict, 'SPLIT');
  assert.deepEqual(plain(decision.splitInto), splitInto);
  assert.equal(f.prompts.length, 2);
  assert.doesNotMatch(f.prompts[1], /between 2 and 6/);
});

for (const [label, splitInto] of [
  ['missing array', undefined], ['empty array', []], ['one child', [part(0)]],
  ['not an array', {}], ['invalid late branch', [...Array.from({ length: 25 }, (_, i) => part(i)), null]],
  ['empty late title', [...Array.from({ length: 25 }, (_, i) => part(i)), { ...part(25), title: '' }]],
  ['missing description', [part(0), { ...part(1), description: undefined }]],
  ['missing implementation checks', [part(0), { ...part(1), implVerifyPrompt: undefined }]],
  ['missing behavior checks', [part(0), { ...part(1), solutionVerifyPrompt: undefined }]],
  ['missing command field', [part(0), { ...part(1), solutionVerifyCommand: undefined }]],
]) {
  test(`malformed direct SPLIT is rejected intact, never RETRY: ${label}`, async () => {
    const f = fixture([{ verdict: 'SPLIT', splitInto }]);
    await assert.rejects(f.review(), /Invalid supervisor SPLIT/);
    assert.equal(f.prompts.length, 1);
  });
}

test('malformed escalation split cannot drop a branch then turn into a synthesized rewrite', async () => {
  const f = fixture([{ verdict: 'RETRY' }, { splitInto: [part(0), part(1), null] }]);
  await assert.rejects(f.review(), /Invalid supervisor SPLIT/);
  assert.equal(f.prompts.length, 2);
});

test('missing escalation replacement is rejected without manufacturing a task correction', async () => {
  const f = fixture([{ verdict: 'RETRY' }, { splitInto: [] }]);
  await assert.rejects(f.review(), /neither a complete split nor a rewritten task/);
});

test('accepted local child retries use feedback, not a rewritten parent or fresh task budget', async () => {
  const local = { ...task, region: JSON.stringify({ scopeSplit: {
    archiveKey: 'scopeSplit:parent:1', key: 'interface-one', integration: false,
  } }) };
  const f = fixture([{ verdict: 'RETRY', feedback: 'Correct the observed event binding for this interface.',
    taskEdits: [{ seq: local.seq, description: 'Migrate and verify every interface in the entire project again.' }] }]);
  const decision = await f.review(local);
  assert.equal(decision.verdict, 'RETRY');
  assert.deepEqual(plain(decision.taskEdits), []);
  assert.equal(decision.escalated, false);
  assert.equal(f.prompts.length, 1, 'no demandRewrite or escalation call');
  assert.match(f.prompts[0], /accepted local slice/);
});
