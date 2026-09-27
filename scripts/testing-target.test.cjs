const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

// A goal that names a loopback address is asking for the work to be served
// there. Adopting it as the owner's fixed testing environment made the core
// refuse the coder's own server (testing_target_blocked) with nothing else able
// to serve that address, so the run could not recover.
test('planning goals only adopt a remote URL as the fixed testing target', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-testing-target-'));
  const host = await createHost({ workspace: root, log() {} });
  const { preparePlanningGoal, isLoopbackTarget } = host.load('src/queue/testingEnvironment.ts');
  const reset = async () => {
    await host.load('src/queue/testingEnvironment.ts')
      .saveTestingEnvironment(host.context, host.queue, { url: '', credentials: [], remove: [] });
  };
  try {
    await t.test('a loopback goal URL leaves the target unset', async () => {
      await reset();
      await preparePlanningGoal(host.context, host.queue,
        'Build a Pac-Man game and test it with Playwright at http://localhost:8123');
      assert.equal(host.queue.testingUrl, '');
    });

    await t.test('a deployed goal URL is still adopted', async () => {
      await reset();
      await preparePlanningGoal(host.context, host.queue,
        'Fix the checkout page and test it at https://staging.example.com/shop');
      assert.equal(host.queue.testingUrl, 'https://staging.example.com/shop');
    });

    await t.test('credentials in a goal are still captured and redacted', async () => {
      await reset();
      const safe = await preparePlanningGoal(host.context, host.queue,
        'Log in at http://127.0.0.1:8080 with username: admin and password: hunter2 then fix the form');
      assert.equal(host.queue.testingUrl, '');
      assert.deepEqual(host.queue.testingCredentialNames, ['password', 'username']);
      assert.ok(!safe.includes('hunter2'), `the password survived into the goal: ${safe}`);
    });

    await t.test('a target the owner configured by hand is preserved', async () => {
      await reset();
      await host.load('src/queue/testingEnvironment.ts')
        .saveTestingEnvironment(host.context, host.queue, { url: 'http://localhost:8123', credentials: [], remove: [] });
      await preparePlanningGoal(host.context, host.queue, 'Add a scoreboard to the game');
      assert.equal(host.queue.testingUrl, 'http://localhost:8123/');
    });

    await t.test('loopback detection covers the forms a goal uses', () => {
      for (const url of ['http://localhost:8123', 'http://127.0.0.1:5173/game', 'http://0.0.0.0:8080', 'http://[::1]:3000'])
        assert.equal(isLoopbackTarget(url), true, url);
      for (const url of ['https://example.com', 'http://localhost.example.com', 'nonsense'])
        assert.equal(isLoopbackTarget(url), false, url);
    });
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
