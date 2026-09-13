// Regression coverage for the source runner's role binding.
//
// The bug this locks down: headless-host used to bind every role to the Claude
// CLI provider, but that provider only serves planner/supervisor
// (catalog.ts rolesAllowed). The executor and verifier therefore resolved to no
// provider at all and every run died with "No supported provider is configured
// for the executor role" while the supervisor rewrote the same task forever.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('./headless-host.cjs');
const { preflight } = require('./queue-runner.cjs');

const MESSAGE = 'No supported provider is configured for the executor role. Select a provider for this role in MF Agent settings.';

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mf-provider-'));
}

function savedEnv() {
  const keys = ['MFAGENT_WORKER_URL', 'MFAGENT_WORKER_MODEL', 'MFAGENT_WORKER_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'];
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const usable = role => resolved => {
  const r = resolved[role];
  return !!r && !!r.profile && (r.kind !== 'openai-compatible' || !!r.baseURL);
};

test('a missing provider is a configuration error, not an outage', async () => {
  const workspace = scratch();
  const host = await createHost({ workspace, log: () => {} });
  try {
    const { providerConfigurationError, providerUnavailable } = host.load('src/queue/recovery.ts');
    assert.equal(providerConfigurationError(MESSAGE), true);
    assert.equal(providerUnavailable(MESSAGE), false, 'offline backoff must not swallow a config fault');
    assert.equal(providerConfigurationError('the model returned unparseable JSON'), false);
    assert.equal(providerUnavailable('http 402 from https://openrouter.ai/api/v1: requires more credits'), true,
      'a billing refusal is a provider outage, not a task defect');
    assert.equal(providerConfigurationError('http 401 from https://openrouter.ai/api/v1: No cookie auth credentials found'), true,
      'a missing/invalid key must stop the run so it can be fixed');
  } finally { await host.close(); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('without a worker the executor is unusable and preflight refuses to start', async () => {
  const saved = savedEnv();
  for (const key of Object.keys(saved)) delete process.env[key];
  const workspace = scratch();
  try {
    const host = await createHost({ workspace, log: () => {} });
    try {
      const resolved = await host.store.resolveAll();
      assert.equal(usable('planner')(resolved), true, 'planner keeps Claude CLI');
      assert.equal(usable('supervisor')(resolved), true, 'supervisor keeps Claude CLI');
      assert.equal(usable('executor')(resolved), false, 'executor must not silently inherit Claude CLI');
      await assert.rejects(() => preflight(host), /No usable provider for role\(s\): executor/);
    } finally { await host.close(); }
  } finally { restoreEnv(saved); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('an explicit worker bounds the executor while planner stays on Claude CLI', async () => {
  const saved = savedEnv();
  for (const key of Object.keys(saved)) delete process.env[key];
  const workspace = scratch();
  try {
    const host = await createHost({ workspace, log: () => {}, workerUrl: 'http://127.0.0.1:9/v1', workerModel: 'test-worker' });
    try {
      const resolved = await host.store.resolveAll();
      assert.equal(usable('planner')(resolved), true);
      assert.equal(usable('executor')(resolved), true);
      assert.equal(resolved.executor.baseURL, 'http://127.0.0.1:9/v1');
      await preflight(host);
    } finally { await host.close(); }
  } finally { restoreEnv(saved); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('an explicit OpenRouter worker URL picks up OPENROUTER_API_KEY', async () => {
  const saved = savedEnv();
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.OPENROUTER_API_KEY = 'test-key';
  const workspace = scratch();
  try {
    const host = await createHost({ workspace, log: () => {}, workerUrl: 'https://openrouter.ai/api/v1',
      workerModel: 'anthropic/claude-sonnet-4.6' });
    try {
      const resolved = await host.store.resolveAll();
      assert.equal(usable('executor')(resolved), true);
      assert.equal(resolved.executor.apiKey, 'test-key', 'the URL-specific env key must be attached');
    } finally { await host.close(); }
  } finally { restoreEnv(saved); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('--worker-all binds planner and supervisor to the HTTP worker too', async () => {
  const saved = savedEnv();
  for (const key of Object.keys(saved)) delete process.env[key];
  const workspace = scratch();
  try {
    const host = await createHost({ workspace, log: () => {}, workerUrl: 'http://127.0.0.1:9/v1',
      workerModel: 'worker-model', workerAll: true });
    try {
      const resolved = await host.store.resolveAll();
      for (const role of ['planner', 'supervisor', 'executor', 'coding']) {
        assert.equal(usable(role)(resolved), true, `${role} should be on the worker`);
        assert.equal(resolved[role].baseURL, 'http://127.0.0.1:9/v1');
      }
      await preflight(host);
    } finally { await host.close(); }
  } finally { restoreEnv(saved); fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('OPENROUTER_API_KEY is auto-detected as the worker provider', async () => {
  const saved = savedEnv();
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.MFAGENT_WORKER_MODEL = 'anthropic/claude-sonnet-4.5';
  const workspace = scratch();
  try {
    const host = await createHost({ workspace, log: () => {} });
    try {
      const resolved = await host.store.resolveAll();
      assert.equal(usable('executor')(resolved), true);
      assert.equal(resolved.executor.baseURL, 'https://openrouter.ai/api/v1');
      assert.equal(resolved.executor.model, 'anthropic/claude-sonnet-4.5');
      await preflight(host);
    } finally { await host.close(); }
  } finally { restoreEnv(saved); fs.rmSync(workspace, { recursive: true, force: true }); }
});
