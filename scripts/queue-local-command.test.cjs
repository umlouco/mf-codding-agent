const { test } = require('node:test');
const { assert, fixture, usage } = require('./queue-scope-helpers.cjs');

const oldCommand = 'npm run test -- --old-flag';
const newCommand = 'npm run test -- --correct-flag';
const part = title => ({ title, description: `Complete only ${title}.`, implVerifyPrompt: `Inspect ${title}.`,
  solutionVerifyPrompt: `Observe ${title}'s behavior.`, solutionVerifyCommand: oldCommand });

async function local(t) {
  let reply = { verdict: 'SPLIT', feedback: 'Independent work.', splitInto: [part('First'), part('Second')], usage };
  const validated = [];
  const f = fixture(t, { superviseTask: async () => reply }, { './verification': {
    runVerification: async (_, __, task) => {
      validated.push(task);
      return { text: 'Independent check completed.', validationReport: 'New independent evidence.', usage };
    },
  } });
  const parent = f.queue.claimNext();
  f.queue.update(parent.id, { status: 'VERIFYING', validationReport: 'Independent findings.' });
  await f.runner.supervise(f.queue.get(parent.id));
  const claimed = f.queue.claimNext();
  f.queue.update(claimed.id, { status: 'VERIFYING', validationReport: 'The command has an unsupported flag.' });
  return { ...f, task: f.queue.get(claimed.id), validated, setReply: value => { reply = value; } };
}

test('local REVERIFY leaves saved and admitted commands immutable while host verification adapts its own plan', async t => {
  const f = await local(t);
  f.setReply({ verdict: 'REVERIFY', feedback: 'Correct the unsupported test-runner flag; retain the same required checks.',
    taskEdits: [{ seq: f.task.seq, solutionVerifyCommand: newCommand }], usage });
  const updates = [], update = f.queue.update.bind(f.queue);
  f.queue.update = (id, patch) => { updates.push({ id, patch }); return update(id, patch); };
  await f.runner.supervise(f.task);
  const current = f.queue.get(f.task.id);
  const { scopedContract, hasAdmittedScope } = f.load('src/queue/scopeContract.ts');
  assert.equal(current.solutionVerifyCommand, oldCommand);
  assert.equal(scopedContract(f.queue, current).contract.solutionVerifyCommand, oldCommand);
  assert.equal(hasAdmittedScope(f.queue, current), true);
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'region']) {
    assert.equal(current[field], f.task[field]);
  }
  assert.ok(updates.every(({ patch }) => !('solutionVerifyCommand' in patch) && !('region' in patch)),
    'runtime verification must not rewrite the persistent acceptance adapter or admitted baseline');
  assert.equal(f.validated.length, 1);
  assert.equal(f.validated[0].solutionVerifyCommand, oldCommand);
  assert.equal(current.validationReport, 'New independent evidence.');
  assert.equal(f.queue.countEvents(current.id, 'check-fixed'), 0);
  assert.equal(f.queue.countEvents(current.id, 'scope-edit-rejected'), 1);
  assert.equal(f.queue.list()[1].solutionVerifyCommand, oldCommand);
});

test('local command recovery rejects RETRY, empty commands, prose edits, siblings and drifted baselines', async t => {
  const cases = [
    { verdict: 'RETRY', fields: { solutionVerifyCommand: newCommand } },
    { verdict: 'REVERIFY', fields: { solutionVerifyCommand: '' } },
    { verdict: 'REVERIFY', fields: { solutionVerifyCommand: newCommand, description: 'Broaden acceptance.' } },
    { verdict: 'REVERIFY', fields: { solutionVerifyCommand: newCommand }, wrongCurrent: true },
    { verdict: 'REVERIFY', fields: { solutionVerifyCommand: newCommand }, drift: true },
  ];
  for (const scenario of cases) {
    const f = await local(t);
    if (scenario.drift) f.queue.update(f.task.id, { description: 'A different, unadmitted acceptance contract.' });
    const before = f.queue.get(f.task.id);
    f.runner.applyTaskEdits({ verdict: scenario.verdict, feedback: 'Do not waive checks.',
      taskEdits: [{ seq: f.task.seq, ...scenario.fields }], usage },
    scenario.wrongCurrent ? f.task.seq + 1 : f.task.seq);
    const after = f.queue.get(f.task.id);
    for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand', 'region']) {
      assert.equal(after[field], before[field]);
    }
    assert.equal(f.queue.countEvents(f.task.id, 'scope-edit-rejected'), 1);
    assert.equal(f.queue.countEvents(f.task.id, 'check-fixed'), 0);
  }
});

test('the real supervisor parser cannot launder broad REVERIFY edits into a command-only contract rewrite', async t => {
  const f = await local(t);
  const { loadQueueAgents } = require('./queue-agent-loader.cjs');
  const agents = loadQueueAgents({ vscode: { workspace: {
    getConfiguration: () => ({ get: (_, fallback) => fallback }),
  } } });
  agents.setTestRunner(async () => ({ text: JSON.stringify({ verdict: 'REVERIFY',
    feedback: 'Correct the failed checking tool.', taskEdits: [{ seq: f.task.seq,
      description: 'Broaden this child to include sibling work.', solutionVerifyCommand: newCommand }] }),
    stopReason: 'end_turn', usage }));
  const decision = await agents.superviseTask({}, { appendLine() {} }, f.task, 0, 'Keep the assigned outcome.');
  assert.equal(decision.verdict, 'REVERIFY');
  assert.equal(decision.taskEdits.length, 0);
});
