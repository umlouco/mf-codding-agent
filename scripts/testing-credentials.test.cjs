const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

// A queue database copied to another host or profile keeps the credential
// *names* but not the values, which stay in the original profile's secret
// storage. The editor core used to fail startup on that mismatch, so the
// window could not open the Testing environment page the error pointed at and
// the failure repeated. Queue workers must still refuse: they cannot sign in.
test('the editor core starts without testing credentials; a queue worker does not', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-testing-credentials-'));
  const host = await createHost({ workspace: root, log() {} });
  try {
    host.queue.setMeta('testingCredentialNames', JSON.stringify(['password', 'username']));
    host.queue.setMeta('testingUrl', 'https://staging.example.com/');
    const { buildCoreConfig } = host.load('src/providers/payload.ts');

    await assert.rejects(
      () => buildCoreConfig(host.store, { allowMissingCredentials: false }),
      /Testing credentials unavailable on this host\/profile: password, username/,
    );
    await assert.rejects(
      () => buildCoreConfig(host.store),
      /Testing credentials unavailable/,
      'omitting the option must stay strict for queue workers',
    );

    const editor = await buildCoreConfig(host.store, { allowMissingCredentials: true });
    assert.deepEqual(editor.testingEnvironment.credentials, {});
    assert.equal(editor.testingEnvironment.url, 'https://staging.example.com/');
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
