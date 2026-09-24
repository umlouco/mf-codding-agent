const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHost } = require('./headless-host.cjs');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mf codex cli '));
}

function fakeCodex(dir) {
  const script = path.join(dir, 'fake-codex.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-test 1.0\\n'); process.exit(0); }
if (args[0] !== 'exec') process.exit(2);
const output = args[args.indexOf('-o') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), 'capture.json'), JSON.stringify({ args, prompt }));
  const answer = JSON.stringify({ ok: true, role: process.env.MFAGENT_QUEUE_ROLE });
  fs.writeFileSync(output, answer);
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: answer } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10,
    cached_input_tokens: 4, output_tokens: 7, reasoning_output_tokens: 3 } }) + '\\n');
  if (prompt.includes('Force failure')) process.exitCode = 7;
});
`);
  if (process.platform === 'win32') {
    const wrapper = path.join(dir, 'fake-codex.cmd');
    fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return wrapper;
  }
  const wrapper = path.join(dir, 'fake-codex');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

test('Codex CLI profile is usable only by planner and supervisor', async () => {
  const workspace = scratch();
  const host = await createHost({ workspace, log: () => {} });
  try {
    const { providerOrFallback } = host.load('src/providers/catalog.ts');
    const def = providerOrFallback('codex-cli');
    assert.deepEqual(def.rolesAllowed, ['planner', 'supervisor']);
    const profile = await host.store.addProfile('codex-cli');
    await host.store.setRole('planner', { profileId: profile.id, model: 'default', effort: '' });
    await host.store.setRole('supervisor', { profileId: profile.id, model: 'default', effort: '' });
    await host.store.setRole('executor', { profileId: profile.id, model: 'default', effort: '' });
    assert.equal((await host.store.resolve('planner')).kind, 'codex-cli');
    assert.equal((await host.store.resolve('supervisor')).kind, 'codex-cli');
    assert.equal((await host.store.resolve('executor')).profile, undefined);
    assert.equal(host.store.settings.roles.coding.profileId, '', 'a planner-only provider must not become Coding');
  } finally {
    await host.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Codex CLI turn uses the configured command and preserves usage without double-counting reasoning', async () => {
  const workspace = scratch();
  const bin = fakeCodex(workspace);
  const host = await createHost({ workspace, log: () => {} });
  try {
    const profile = { id: 'codex-test', name: 'Codex CLI', providerId: 'codex-cli', extra: { cliPath: bin } };
    const resolved = { role: 'supervisor', profile, kind: 'codex-cli', model: 'default',
      effort: 'xhigh', baseURL: '', apiKey: '', inherited: false };
    const { testCodexCliBinary, runCodexCliTurn } = host.load('src/queue/codexCli.ts');
    assert.equal((await testCodexCliBinary(bin)).ok, true);
    const events = [];
    const turn = await runCodexCliTurn(host.output, 'supervisor', resolved, 'Review the evidence.', {
      onEvent: (method, params) => events.push({ method, params }),
    });
    const capture = JSON.parse(fs.readFileSync(path.join(workspace, 'capture.json'), 'utf8'));
    assert.equal(capture.args.includes('--json'), true);
    assert.equal(capture.args[capture.args.indexOf('-s') + 1], 'read-only');
    assert.equal(capture.args.includes('-m'), false, 'default model should remain Codex-owned');
    assert.equal(capture.args[capture.args.indexOf('-c') + 1], 'model_reasoning_effort=xhigh');
    assert.match(capture.prompt, /engineering supervisor/);
    assert.match(capture.prompt, /Review the evidence/);
    assert.equal(JSON.parse(turn.text).role, 'supervisor');
    assert.deepEqual(turn.usage, { input: 6, output: 7, cacheRead: 4, cacheWrite: 0 });
    assert.equal(events.some(event => event.method === 'stream/text'), true);
    await assert.rejects(
      () => runCodexCliTurn(host.output, 'supervisor', resolved, 'Force failure.', {}),
      /codex CLI exited with code 7/,
      'a nonzero exit must not be accepted merely because an agent message was written',
    );
  } finally {
    await host.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
