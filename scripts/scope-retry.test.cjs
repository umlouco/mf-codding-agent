const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('scope discovery failures recover without a cached-error claim loop', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-scope-retry-'));
  fs.writeFileSync(path.join(root, 'source.md'), 'The supplied source sentence.');
  const host = await createHost({ workspace: root, log() {} });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const { indexRepository } = host.load('src/queue/workInventory.ts');
  const { readScopeRetry, scopeRetryKey } = host.load('src/queue/scopeRetry.ts');
  const runtime = host.load('src/queue/agentRuntime.ts');
  const executor = host.load('src/queue/agentExecution.ts');
  const originalRun = runtime.runOnce, originalExecute = executor.executeTask, realNow = Date.now;
  let now = realNow(), serial = 0;
  Date.now = () => now;
  const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
  const answer = value => ({ text: JSON.stringify(value), usage });
  const blocked = { strategy: 'blocked', reason: 'OWNER CONTEXT is empty; source text is missing.' };
  const atomic = { strategy: 'atomic', reason: 'One document with a supplied sentence.' };
  const keep = { action: 'KEEP', reason: 'One document.',
    execution: { shape: 'focused', reason: 'One output.' },
    verification: { shape: 'focused', reason: 'One document check.' } };
  const setup = (mode = 'lockstep') => {
    const queue = TaskQueue.open(path.join(root, '.mfagent', `scope-${++serial}.db`));
    queue.setRunState('RUNNING');
    queue.setMeta('goal', 'Create one document per sentence in the following text.');
    queue.insert({ title: 'Refresh a document', description: 'Use the sentence in source.md.',
      solutionVerifyPrompt: 'Compare the document with source.md.', maxAttempts: 3 }, 1);
    queue.insert({ title: 'Later task', description: 'Do later work.' }, 2);
    const runner = new Orchestrator(host.context, host.output, queue);
    runner.cfg = (key, fallback) => key === 'queue.mode' ? mode : fallback;
    runner.correctTestingTarget = () => false;
    runner.schedule = () => {};
    let wakes = 0;
    runner.wakeAfterHandoff = () => { wakes++; };
    return { queue, runner, task: queue.list()[0], wakes: () => wakes };
  };

  try {
    for (const mode of ['lockstep', 'continuous']) {
      await t.test(`${mode}: old blocked cache is reassessed, then retry survives reload`, async () => {
        const { queue, runner, task, wakes } = setup(mode);
        let reopened;
        const repository = indexRepository(root);
        const key = 'workInventory:' + createHash('sha256').update(JSON.stringify([
          task.id, task.createdAt, task.description, task.solutionVerifyPrompt,
          JSON.stringify([queue.getMeta('goal'), queue.contextInstructions]), repository.fingerprint,
        ])).digest('hex');
        queue.setMeta(key, JSON.stringify({ ...blocked, collections: [], units: [],
          repositoryFingerprint: repository.fingerprint }));
        let discoveries = 0, executions = 0;
        runtime.runOnce = async (_context, _output, role, prompt) => {
          assert.equal(role, 'supervisor');
          assert.match(prompt, /CURRENT TASK/);
          assert.match(prompt, /source\.md/);
          assert.match(prompt, /PREVIOUS DISCOVERY FAILURE/);
          discoveries++;
          return answer(blocked);
        };
        executor.executeTask = async () => { executions++; throw Error('Executor must not start.'); };
        try {
          await runner.pump();
          assert.equal(discoveries, 1, 'a legacy blocked result must not be replayed');
          assert.equal(queue.getMeta(key), '', 'blocked results are not admission cache entries');
          assert.equal(queue.get(task.id).status, 'PENDING');
          assert.equal(queue.get(task.id).activityPhase, 'scope_waiting');
          assert.equal(readScopeRetry(queue, task).dueAt, now + 30_000);
          for (let i = 0; i < 20; i++) await runner.pump();
          assert.equal(queue.claimNext(), undefined, 'direct claims cannot bypass the deadline');
          assert.equal(queue.get(task.id).attempts, 1);
          assert.equal(queue.list()[1].attempts, 0, 'later work cannot skip an unresolved task');
          assert.equal(discoveries, 1);
          assert.equal(executions, 0);
          assert.equal(wakes(), 0, 'preflight failures do not schedule an immediate handoff');
          assert.equal(queue.runState, 'RUNNING');
          assert.equal(queue.events(task.id, -1).filter(e => e.kind === 'stopped').length, 0);
          runner.dispose();
          queue.close();
          reopened = TaskQueue.open(queue.path);
          assert.equal(reopened.claimNext(), undefined, 'reload preserves the retry deadline');
          now += 30_000;
          assert.equal(reopened.claimNext().id, task.id, 'normal retry becomes eligible at its deadline');
        } finally {
          if (reopened) reopened.close();
          else { runner.dispose(); queue.close(); }
        }
      });
    }

    await t.test('a fresh discovery after file-content changes admits real execution', async () => {
      const { queue, runner, task } = setup();
      fs.writeFileSync(path.join(root, 'source.md'), 'incomplete');
      const before = indexRepository(root).fingerprint;
      let discoveries = 0, executions = 0;
      runtime.runOnce = async (_context, _output, _role, prompt) => {
        if (!prompt.includes('You are the discovery stage')) return answer(keep);
        discoveries++;
        return answer(fs.readFileSync(path.join(root, 'source.md'), 'utf8') === 'complete' ? atomic : blocked);
      };
      executor.executeTask = async () => {
        executions++;
        return { ok: true, cutOff: false, text: 'Done', notes: '', usage,
          completion: { status: 'READY_FOR_VALIDATION', summary: 'Document checked.',
            filesChanged: [], developmentChecks: [] } };
      };
      try {
        await runner.pump();
        fs.writeFileSync(path.join(root, 'source.md'), 'complete');
        assert.equal(indexRepository(root).fingerprint, before, 'membership alone does not reflect repaired content');
        now = readScopeRetry(queue, task).dueAt;
        await runner.pump();
        assert.equal(discoveries, 2);
        assert.equal(executions, 1);
        assert.equal(queue.get(task.id).status, 'VERIFIED');
        assert.equal(queue.get(task.id).attempts, 2);
        assert.equal(readScopeRetry(queue, task), undefined, 'admission clears old retry history');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('persistent preflight errors back off and owner corrections permit reassessment', async () => {
      const { queue, runner, task } = setup();
      runtime.runOnce = async () => { throw Error('Discovery transport failed.'); };
      try {
        for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
          const started = now;
          await runner.pump();
          const retry = readScopeRetry(queue, task);
          assert.equal(retry.dueAt - started, delay);
          assert.equal(queue.claimNext(), undefined);
          now = retry.dueAt;
        }
        now--;
        queue.setInstructions('Read source.md for the original input.');
        const claim = queue.claimNext();
        assert.equal(claim.id, task.id, 'new owner context need not wait for an obsolete failure');
        assert.equal(readScopeRetry(queue, claim), undefined);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a cancelled preflight cannot defer a replacement claim', async () => {
      const { queue, runner, task } = setup();
      runtime.runOnce = async () => {
        queue.update(task.id, { status: 'PENDING' });
        const replacement = queue.claimNext();
        assert.equal(replacement.attempts, 2);
        throw Error('Late discovery failure.');
      };
      try {
        await runner.pump();
        assert.equal(queue.get(task.id).status, 'EXECUTING');
        assert.equal(queue.get(task.id).attempts, 2);
        assert.equal(queue.getMeta(scopeRetryKey(task)), '');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('an explicit reset clears the discovery delay', async () => {
      const { queue, runner, task } = setup();
      runtime.runOnce = async () => answer(blocked);
      try {
        await runner.pump();
        assert.equal(queue.claimNext(), undefined);
        queue.resetAll();
        assert.equal(readScopeRetry(queue, task), undefined);
        assert.equal(queue.claimNext().id, task.id);
      } finally { runner.dispose(); queue.close(); }
    });
  } finally {
    runtime.runOnce = originalRun;
    executor.executeTask = originalExecute;
    Date.now = realNow;
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
