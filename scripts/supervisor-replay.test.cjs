const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { parseArgs, sourceReceipt } = require('./supervisor-replay.cjs');
const { resolveSupervisor, sanitized } = require('./supervisor-replay-core.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-replay-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('mf-replay-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('replay CLI cannot overwrite the source workspace or an existing report', t => {
  const root = fixture(t);
  const args = ['--workspace', root, '--seq', '7'];
  assert.equal(parseArgs(args).seq, 7);
  assert.throws(() => parseArgs([...args, '--report', path.join(root, 'report.json')]), /NEW file outside/);
  const sibling = fixture(t);
  const report = path.join(sibling, 'existing.json');
  fs.writeFileSync(report, '{}');
  assert.throws(() => parseArgs([...args, '--report', report]), /NEW file outside/);
  assert.throws(() => parseArgs([...args, '--seq', '8']), /Duplicate/);
  assert.throws(() => parseArgs(['--workspace', root, '--seq', '0']), /positive integer/);
  assert.throws(() => parseArgs([...args, '--rewrite-task', 'true']), /Usage/);
});

test('source receipts observe actual tasks without creating or modifying the database', t => {
  const root = fixture(t);
  const file = path.join(root, 'queue.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, seq INTEGER, description TEXT); INSERT INTO tasks VALUES (1, 7, 'Unchanged requirement');");
  db.close();
  const before = fs.readFileSync(file);
  const first = sourceReceipt(file);
  const second = sourceReceipt(file);
  assert.equal(first.taskCount, 1);
  assert.equal(first.taskListHash, second.taskListHash);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => sourceReceipt(path.join(root, 'absent.db')));
  assert.equal(fs.existsSync(path.join(root, 'absent.db')), false);
});

test('the configured Supervisor role resolves independently from coding and never exposes secrets', t => {
  const root = fixture(t);
  const stateFile = path.join(root, 'state.vscdb');
  const db = new DatabaseSync(stateFile);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const settings = { profiles: [
    { id: 'coding', providerId: 'openai-compatible', baseURL: 'https://coding.example.test/v1' },
    { id: 'supervisor', providerId: 'openai-compatible', baseURL: 'https://review.example.test/v1' },
  ], roles: { coding: { profileId: 'coding', model: 'coding-model', effort: 'low' },
    supervisor: { profileId: 'supervisor', model: 'review-model', effort: 'high' } } };
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('mflores.mf-agent',
    JSON.stringify({ 'mfagent.settings.v2': settings }));
  db.close();
  const resolved = resolveSupervisor({ MFAGENT_REPLAY_STATE_DB: stateFile });
  assert.equal(resolved.model, 'review-model');
  assert.equal(resolved.baseURL, 'https://review.example.test/v1');
  assert.equal(resolved.effort, 'high');
  assert.equal(resolved.source, 'VS Code Supervisor role');
  const override = resolveSupervisor({ MFAGENT_REPLAY_BASE_URL: 'https://override.example.test/v1',
    MFAGENT_REPLAY_MODEL: 'different-model', MFAGENT_REPLAY_API_KEY: 'private-key' });
  assert.equal(override.model, 'different-model');
  assert.equal(sanitized(Error('private-key leaked\nfull private prompt'), override.apiKey), '[redacted] leaked');
  assert.throws(() => resolveSupervisor({ MFAGENT_REPLAY_BASE_URL: 'https://user:secret@example.test/v1',
    MFAGENT_REPLAY_MODEL: 'model' }), /without embedded credentials/);
});
