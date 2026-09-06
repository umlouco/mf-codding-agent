// Run with: node --test scripts/task-edit-panel.test.cjs
// Exercise Edit Tasks through the real panel and SQLite persistence boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, dependencies = {}) {
  const absolute = path.join(__dirname, '..', file);
  const { outputText } = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, __dirname: path.dirname(absolute), process, Buffer,
    require: name => dependencies[name] ?? {},
  }, { filename: absolute });
  return exports;
}

const database = load('src/queue/db.ts', { fs, path, 'node:sqlite': require('node:sqlite') });

function fixture(t, runPlanner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-edit-panel-'));
  const file = path.join(root, 'queue.db');
  const queue = database.TaskQueue.open(file);
  const info = [], errors = [], notes = [];
  const vscode = {
    ProgressLocation: { Notification: 1 },
    window: {
      withProgress: async (_, work) => work(),
      showInformationMessage: message => info.push(message),
      showErrorMessage: message => errors.push(message),
    },
  };
  const panel = load('src/queue/panel.ts', {
    vscode, './db': database,
    './agents': { editTasks: (...args) => runPlanner(queue, ...args) },
    './registry': { onDidChangeSkills: () => ({ dispose() {} }) },
    './liveLog': { LiveLog: class {
      onEvent() {}
      note(kind, text) { notes.push({ kind, text }); }
      close() {}
    } },
  });
  const provider = new panel.QueueViewProvider({ subscriptions: [] }, { appendLine() {} }, async () => {});
  provider.queue = queue;
  provider.render = () => {};
  t.after(() => {
    queue.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('mf-edit-panel-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { queue, file, provider, info, errors, notes };
}

test('Edit Tasks removes all 251 requested rows and reports the committed result after reopen', async t => {
  const f = fixture(t, async (_, context, output, tasks) => ({
    summary: 'Planner says everything is already removed.',
    edits: [{ seq: 252, description: 'Use only the LMS-side API.' }],
    deletes: tasks.filter(task => task.seq <= 251).map(task => task.seq),
    adds: [{ title: 'Package-agnostic no-skip behavior', description: 'Enforce first-watch behavior in the LMS.' }],
  }));
  f.queue.addAll([
    ...Array.from({ length: 251 }, (_, i) => ({ title: `Unwanted package patch ${i}`, description: 'Do not keep.' })),
    { title: 'SCORM API runtime', description: 'Keep and revise.' },
  ]);
  await f.provider.applyTaskEditPrompt('Remove all package-patching tasks and replace them with LMS behavior.');
  assert.deepEqual(f.errors, []);
  assert.equal(f.queue.list().length, 2);
  assert.equal(f.info.length, 1);
  assert.match(f.info[0], /removed 251, updated 1, added 1/);
  assert.equal(f.notes.some(note => note.text === 'Planner says everything is already removed.'), false);
  const reopened = database.TaskQueue.open(f.file);
  try {
    assert.deepEqual(Array.from(reopened.list(), task => task.title), ['SCORM API runtime', 'Package-agnostic no-skip behavior']);
    assert.equal(reopened.list()[0].description, 'Use only the LMS-side API.');
    assert.equal(reopened.events(null, 5).find(event => event.kind === 'tasks-edited-by-prompt').message, f.info[0]);
  } finally { reopened.close(); }
});

test('Edit Tasks applies sequence references to the snapshot shown to the planner', async t => {
  const f = fixture(t, async (queue, context, output, tasks) => {
    queue.reorder([tasks[1].id, tasks[0].id]);
    return { summary: 'Removed all 251 tasks.', edits: [], deletes: [tasks[0].seq], adds: [] };
  });
  f.queue.addAll([{ title: 'Remove this task', description: '' }, { title: 'Keep this task', description: '' }]);
  await f.provider.applyTaskEditPrompt('Remove the first task.');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(Array.from(f.queue.list(), task => task.title), ['Keep this task']);
  assert.match(f.info[0], /removed 1, updated 0, added 0/);
  assert.equal(f.info[0].includes('251'), false);
});

test('Edit Tasks reports a rejected revision without claiming any deletion succeeded', async t => {
  const f = fixture(t, async (queue, context, output, tasks) => {
    queue.update(tasks[1].id, { description: 'Changed while the planner was thinking.' });
    return { summary: 'Removed both tasks.', edits: [], deletes: tasks.map(task => task.seq), adds: [] };
  });
  f.queue.addAll([{ title: 'First', description: '' }, { title: 'Second', description: '' }]);
  await f.provider.applyTaskEditPrompt('Remove both tasks.');
  assert.equal(f.queue.list().length, 2);
  assert.deepEqual(f.info, []);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /Could not edit tasks/);
  assert.equal(f.notes.some(note => note.text === 'Removed both tasks.'), false);
  assert.equal(f.notes.some(note => note.kind === 'error'), true);
  assert.equal(f.provider.generating, false);
});
