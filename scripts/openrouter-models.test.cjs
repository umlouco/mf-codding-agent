const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('OpenRouter models come from the live catalog and list without a key', async t => {
  const scratch = path.resolve(__dirname, '../.mfagent/scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'openrouter-models-'));
  const host = await createHost({ workspace: root, log() {} });
  const { ModelRegistry } = host.load('src/providers/models.ts');
  const { getProvider } = host.load('src/providers/catalog.ts');
  const registry = new ModelRegistry(host.context, host.output);
  const originalFetch = global.fetch;
  try {
    await t.test('the public catalog is advertised as keyless to browse', () => {
      const def = getProvider('openrouter');
      assert.equal(def.apiKey, 'required', 'inference still needs a key');
      assert.equal(def.listWithoutKey, true);
    });

    await t.test('discovery hits the live endpoint without an Authorization header', async () => {
      let seen;
      global.fetch = async (url, init) => {
        seen = { url, auth: init?.headers?.Authorization };
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: '~anthropic/claude-sonnet-latest',
                name: 'Anthropic: Claude Sonnet Latest',
                context_length: 1000000,
                architecture: { input_modalities: ['text', 'image'] },
                pricing: { prompt: '0.000003', completion: '0.000015' },
                top_provider: { max_completion_tokens: 128000 },
              },
              { id: 'brand/new-model', name: 'Brand New' },
            ],
          }),
        };
      };
      const list = await registry.list('openrouter', undefined, '', true);
      assert.equal(seen.url, 'https://openrouter.ai/api/v1/models');
      assert.equal(seen.auth, undefined, 'a keyless listing must not send a bearer token');
      assert(list.models.some(model => model.id === 'brand/new-model'));
      const sonnet = list.models.find(model => model.id === '~anthropic/claude-sonnet-latest');
      assert.equal(sonnet.name, 'Anthropic: Claude Sonnet Latest');
      assert.equal(sonnet.contextWindow, 1000000);
      assert.equal(sonnet.maxOutputTokens, 128000);
      assert.equal(sonnet.vision, true);
      assert.equal(sonnet.inputPrice, 3);
      assert.equal(sonnet.outputPrice, 15);
      assert.equal(list.error, undefined);
    });

    await t.test('an authenticated profile still sends its key', async () => {
      let auth;
      global.fetch = async (_url, init) => {
        auth = init?.headers?.Authorization;
        return { ok: true, json: async () => ({ data: [{ id: 'openai/gpt-5' }] }) };
      };
      await registry.list('openrouter', undefined, 'sk-or-test', true);
      assert.equal(auth, 'Bearer sk-or-test');
    });
  } finally {
    global.fetch = originalFetch;
    await host.close();
    assert(root.startsWith(scratch + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
