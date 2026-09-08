const { test } = require('node:test');
const { assert, loader, keep, split, part, fixture, drain, usage } = require('./queue-scope-helpers.cjs');
const { parseScopeAssessment, scopeBlocked } = loader()('src/queue/scopePlan.ts');
const { ScopeEvidence } = loader()('src/queue/scopeEvidence.ts');
const task = { solutionVerifyCommand: 'npm test' };
const plain = value => JSON.parse(JSON.stringify(value));

test('split plans are topologically sorted, complete and not silently capped at six parts', () => {
  const proposal = split('npm test');
  for (let i = 0; i < 100; i++) proposal.parts.push(part(`slice-${i}`, ['setup']));
  const plan = parseScopeAssessment(proposal, task);
  assert.equal(plan.parts.length, 103);
  assert.equal(plan.parts[0].key, 'setup');
  assert.equal(plan.parts.at(-1).key, 'integration');
  assert.equal(plan.parts.at(-1).solutionVerifyCommand, 'npm test');
});

test('invalid splits are rejected whole instead of dropping requirements or branches', () => {
  const corruptions = [
    p => { p.parts[0].dependsOn = ['missing']; },
    p => { p.parts[0].dependsOn = ['components']; },
    p => { p.parts[2].dependsOn = ['components']; },
    p => { p.parts[0].key = 'setup'; },
    p => { p.parts[0].implVerifyPrompt = ''; },
    p => { p.requirements.push({ key: 'forgotten', criterion: 'Preserve keyboard access.' }); },
    p => { p.parts[0].covers = ['invented']; },
    p => { p.parts[1].integration = false; },
    p => { p.parts[1].solutionVerifyCommand = 'echo PASS'; },
    p => { p.action = 'KEEP'; },
  ];
  for (const corrupt of corruptions) {
    const proposal = split('npm test'); corrupt(proposal);
    assert.throws(() => parseScopeAssessment(proposal, task));
  }
  assert.equal(parseScopeAssessment(keep('cohesive'), task).action, 'KEEP');
});

test('reads, writes, failures, patches and opaque shell commands remain distinct evidence', () => {
  const evidence = new ScopeEvidence();
  let id = 0;
  const tool = (name, input, status = 'ok') => {
    const key = String(++id);
    evidence.observe('stream/tool', { id: key, name, input, status: 'running' });
    evidence.observe('stream/tool', { id: key, status });
  };
  for (let i = 0; i < 120; i++) tool('read_file', { path: `src/View${i}.vue` });
  assert.equal(evidence.snapshot().distinctReadTargets, 120);
  assert.equal(evidence.snapshot().distinctEditTargets, 0);
  for (let i = 0; i < 8; i++) tool('write_file', { path: `src/View${i}.vue` });
  tool('edit_file', { path: './src/View0.vue' });
  tool('write_file', { path: 'failed.vue' }, 'error');
  tool('apply_patch', { patch: '*** Update File: src/A.vue\n*** Move to: src/B.vue\n*** Add File: src/C.vue' });
  tool('run_shell', { command: 'npm test' });
  assert.equal(evidence.snapshot().distinctEditTargets, 11);
  assert.equal(evidence.snapshot().opaqueTools, 1);
  assert.equal(evidence.snapshot().recentTools.length, 12);
  assert.equal(evidence.breadthSignal, true, 'an observation, not a permission denial');
});

test('preflight splits an existing oversized queue entry before any executor is launched', async t => {
  let executed = 0;
  const f = fixture(t, { executeTask: async () => { executed++; throw Error('must not run'); } });
  f.setReply(split());
  await f.runner.pump();
  assert.equal(executed, 0);
  assert.deepEqual(f.queue.list().map(t => t.title), ['setup', 'components', 'integration', 'Later work']);
  assert.ok(f.queue.list().every(t => t.status === 'PENDING'));
  assert.equal(f.queue.stats().usage.input, 1, 'supervisor cost is retained after replacing the parent');
});

test('a cohesive change may edit more than three files and still finish normally', async t => {
  const f = fixture(t, { executeTask: async (_, __, ___, ____, _____, activity, event) => {
    for (let i = 0; i < 8; i++) {
      event('stream/tool', { id: String(i), name: 'write_file', input: { path: `file${i}.ts` }, status: 'running' });
      event('stream/tool', { id: String(i), status: 'ok' });
    }
    return { text: 'Ready', notes: '', usage, completion: { status: 'READY_FOR_VALIDATION' } };
  } });
  f.setReply(keep('cohesive'));
  await f.runner.pump();
  assert.equal(f.queue.list().length, 2);
  assert.equal(f.queue.list()[0].status, 'VERIFYING');
  assert.equal(f.queue.list()[0].output, 'Ready');
});

test('live execution split archives handoffs, fences late results and preserves ordered barriers', async t => {
  let finish, stopped = 0;
  const f = fixture(t, { executeTask: async (_, __, ___, ____, _____, activity, event, abort) => {
    abort(() => { stopped++; });
    event('stream/tool', { id: 'write', name: 'write_file', input: { path: 'src/A.vue' }, status: 'running' });
    event('stream/tool', { id: 'write', status: 'ok' });
    return new Promise(resolve => { finish = resolve; });
  } });
  const running = f.runner.pump(); await drain();
  const original = f.queue.activeTask();
  f.queue.update(original.id, { output: 'Shared tokens already implemented.' });
  f.setReply(split());
  const scope = f.runner.executionScope; scope.lastReview = 0;
  await scope.check();
  assert.equal(stopped, 1);
  const rows = f.queue.list();
  const archive = JSON.parse(f.queue.getMeta(JSON.parse(rows[0].region).scopeSplit.archiveKey));
  assert.equal(archive.task.output, 'Shared tokens already implemented.');
  assert.ok(archive.events.some(e => e.kind === 'tool' && e.message.includes('src/A.vue')));
  assert.equal(scopeBlocked(rows[1], rows), true);
  assert.equal(scopeBlocked(rows[3], rows), true);
  f.queue.update(rows[0].id, { status: 'VERIFIED' });
  assert.equal(scopeBlocked(rows[1], f.queue.list()), false);
  finish({ text: 'late response', notes: '', usage, completion: { status: 'READY_FOR_VALIDATION' } });
  await running;
  assert.ok(f.queue.list().every(t => t.output !== 'late response'));
  assert.equal(f.queue.get(original.id), undefined);
});

test('a running verifier has an independent scope lane even while supervision is busy', async t => {
  const f = fixture(t);
  const current = f.queue.claimNext();
  f.queue.update(current.id, { status: 'VERIFYING' });
  f.runner.supervising = true;
  const scope = f.runner.scopeWatch(f.queue.get(current.id), 'validator', () => true, () => {});
  t.after(() => scope.close());
  assert.equal(await scope.preflight(), true);
  scope.observe('stream/thinking', { delta: 'Now manually checking 120 unrelated screens.' });
  const proposal = split(); proposal.execution = keep().execution;
  f.setReply(proposal); scope.lastReview = 0;
  await scope.check();
  assert.equal(f.queue.list().length, 4);
  assert.ok(f.calls[1][3].includes('WORKER: validator'));
  assert.equal(f.runner.supervising, false);
});

test('malformed preflight cannot launch work', async t => {
  let executed = 0;
  const f = fixture(t, { executeTask: async () => { executed++; } });
  f.setReply({ action: 'SPLIT', parts: [] });
  await f.runner.pump();
  assert.equal(executed, 0);
  assert.equal(f.calls.length, 2, 'one full-plan repair, then fail without inventing a plan');
  assert.equal(f.queue.list().length, 2);
  assert.equal(f.queue.list()[0].status, 'VERIFYING');
});

test('verification skips nested scope review and rejects reports after Stop', async t => {
  let finish, event, stopped = 0;
  const f = fixture(t, {}, { './verification': { runVerification: async (_, __, ___, ____, activity, onEvent, abort) => {
    event = onEvent; abort(() => { stopped++; });
    return new Promise(resolve => { finish = resolve; });
  } } });
  const original = f.queue.claimNext(); f.queue.update(original.id, { status: 'VERIFYING' });
  const review = { gen: 4, taskId: original.id, seq: original.seq, lastActivityAt: Date.now() };
  Object.assign(f.runner, { review, reviewGen: 4, supervising: true });
  const running = f.runner.verifyWithExecutor(f.queue.get(original.id), review); await drain();
  assert.equal(review.scope, undefined, 'validation does not launch another scope supervisor');
  assert.equal(f.calls.length, 0, 'no scope model was called');
  f.runner.stop();
  assert.equal(stopped, 1);
  assert.equal(f.queue.list().length, 2);
  event('stream/tool', { id: 'late', name: 'read_file', status: 'running', input: { path: 'late.vue' } });
  finish({ text: 'late PASS', validationReport: 'late PASS', usage });
  await running;
  assert.ok(f.queue.list().every(t => !t.validationReport));
});

test('stopping during scope preflight aborts its model and fences a late split', async t => {
  let resolveReview, aborted = 0, executed = 0;
  const f = fixture(t, { runOnce: async (_, __, ___, ____, opts) => {
    opts.onAbort(() => { aborted++; });
    return new Promise(resolve => { resolveReview = resolve; });
  }, executeTask: async () => { executed++; } });
  const running = f.runner.pump(); await drain();
  f.runner.stop();
  resolveReview({ text: JSON.stringify(split()), usage });
  await running;
  assert.equal(aborted, 1);
  assert.equal(executed, 0);
  assert.equal(f.queue.runState, 'STOPPED');
  assert.equal(f.queue.list().length, 2);
});

test('a changed task contract invalidates KEEP as well as SPLIT before execution', async t => {
  let resolveReview, executed = 0;
  const f = fixture(t, { runOnce: async () => new Promise(resolve => { resolveReview = resolve; }),
    executeTask: async () => { executed++; } });
  const running = f.runner.pump(); await drain();
  const original = f.queue.activeTask();
  f.queue.update(original.id, { description: 'Owner revised this task during review.' });
  resolveReview({ text: JSON.stringify(keep()), usage });
  await running;
  assert.equal(executed, 0);
  assert.equal(f.queue.get(original.id).description, 'Owner revised this task during review.');
  assert.ok(f.queue.get(original.id).errorLog.includes('Task contract changed'));
});

test('continuous mode cannot claim a task ahead of a split prerequisite', async t => {
  const f = fixture(t);
  const original = f.queue.claimNext();
  f.runner.applyScopeSplit(parseScopeAssessment(split(), original), original, () => true);
  const rows = f.queue.list();
  f.queue.update(rows[0].id, { status: 'VERIFYING' });
  Object.defineProperty(f.runner, 'mode', { value: 'continuous' });
  await f.runner.pump();
  assert.equal(f.queue.activeTask(), undefined);
  assert.equal(f.calls.length, 0);
});

test('breadth schedules judgment, while cohesive live work continues and unchanged evidence is not re-reviewed', async t => {
  const f = fixture(t);
  const original = f.queue.claimNext();
  const scope = f.runner.scopeWatch(original, 'executor', () => true, () => {});
  t.after(() => scope.close());
  f.setReply(keep('cohesive'));
  await scope.preflight();
  for (let i = 0; i < 6; i++) {
    scope.observe('stream/tool', { id: String(i), name: 'multi_edit', status: 'running', input: { path: `file${i}.ts` } });
    scope.observe('stream/tool', { id: String(i), status: 'ok' });
  }
  scope.lastReview = 0;
  await scope.check();
  assert.equal(f.calls.length, 2);
  assert.equal(f.queue.activeTask().id, original.id);
  assert.ok(f.calls[1][3].includes('"distinctEditTargets":6'));
  await scope.check();
  assert.equal(f.calls.length, 2, 'no repeated paid review without new evidence');
  scope.observe('stream/thinking', { delta: 'Finishing the coupled caller regression.' });
  await scope.check();
  assert.equal(f.calls.length, 2, 'fresh evidence still respects review rate limiting');
});

test('split metadata and original requirements survive a nested split', t => {
  const f = fixture(t);
  const original = f.queue.claimNext();
  f.runner.applyScopeSplit(parseScopeAssessment(split(), original), original, () => true);
  const child = f.queue.claimNext();
  const proposal = split(); proposal.parts.forEach(p => { p.key = `nested-${p.key}`;
    p.dependsOn = p.dependsOn.map(d => `nested-${d}`); });
  f.runner.applyScopeSplit(parseScopeAssessment(proposal, child), child, () => true);
  const rows = f.queue.list();
  assert.deepEqual(rows.map(t => t.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(scopeBlocked(rows[3], rows), true);
  assert.ok(rows[0].description.includes('Do not revert'));
  assert.ok(plain(rows[0]).region.includes('scopeSplit'));
});
