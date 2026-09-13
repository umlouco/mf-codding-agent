const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('DeepSeek V4.1 Flash is discoverable without replacing saved model selections', async t => {
  const scratch = path.resolve(__dirname, '../.mfagent/scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'deepseek-models-'));
  const host = await createHost({ workspace: root, log() {} });
  const { ModelRegistry } = host.load('src/providers/models.ts');
  const { getProvider } = host.load('src/providers/catalog.ts');
  const registry = new ModelRegistry(host.context, host.output);
  const key = 'mfagent.models.deepseek:https://api.deepseek.com/v1';
  const originalFetch = global.fetch;
  const flash = models => models.find(model => model.id === 'deepseek-flash');
  try {
    await t.test('cold settings show a labeled multimodal model without a request', () => {
      assert.equal(getProvider('deepseek').serves.vision, true);
      const list = registry.peek('deepseek');
      assert.equal(list.fallback, true);
      assert.equal(flash(list.models).name, 'DeepSeek V4.1 Flash');
      assert.equal(flash(list.models).vision, true);
      assert(!list.models.some(model => /beepseek|deepseek-v4\.1-flash/.test(model.id)));
    });
    await t.test('a warm old cache does not hide the new release or overwrite stored data', async () => {
      const cached = { models: [{ id: 'deepseek-v4-pro', name: 'Saved Pro' }], fetchedAt: Date.now() };
      await host.context.globalState.update(key, cached);
      global.fetch = async () => { throw new Error('Warm cache should not fetch'); };
      assert(flash(registry.peek('deepseek').models));
      const list = await registry.list('deepseek', undefined, '');
      assert(flash(list.models));
      assert(list.models.some(model => model.id === 'deepseek-v4-pro'));
      assert.deepEqual(host.context.globalState.get(key), cached);
    });
    await t.test('live discovery keeps API IDs and deduplicates the canonical model', async () => {
      global.fetch = async url => {
        assert.equal(url, 'https://api.deepseek.com/v1/models');
        return { ok: true, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'future-model' }] }) };
      };
      const list = await registry.list('deepseek', undefined, '', true);
      assert.equal(list.models.filter(model => model.id === 'deepseek-flash').length, 1);
      assert.equal(flash(list.models).name, 'DeepSeek V4.1 Flash');
      assert.equal(flash(list.models).vision, true);
      assert(list.models.some(model => model.id === 'future-model'));
      assert.equal(list.error, undefined);
    });
    await t.test('failed discovery shows the model but does not claim a successful connection', async () => {
      await host.context.globalState.update(key, undefined);
      global.fetch = async () => { throw new Error('offline fixture'); };
      const list = await registry.list('deepseek', undefined, '', true);
      assert(flash(list.models));
      assert.equal(list.fallback, true);
      assert.match(list.error, /offline fixture/);
      assert.equal((await registry.test('deepseek', undefined, '')).ok, false);
    });
    await t.test('custom DeepSeek endpoints do not inherit unsupported hosted model IDs', async () => {
      assert.equal(registry.peek('deepseek', 'https://custom.invalid/v1'), undefined);
      global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'private-model' }] }) });
      const list = await registry.list('deepseek', 'https://custom.invalid/v1', '', true);
      assert.deepEqual(list.models.map(model => model.id), ['private-model']);
    });
    await t.test('generic provider listings are not modified', async () => {
      const list = await registry.list('openai-compatible', 'https://custom.invalid/v1', '', true);
      assert.deepEqual(list.models.map(model => model.id), ['private-model']);
    });
  } finally {
    global.fetch = originalFetch;
    await host.close();
    assert(root.startsWith(scratch + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
