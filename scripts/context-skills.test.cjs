const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, dependencies = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, { exports, process, __dirname, require: name => dependencies[name] ?? {} });
  return exports;
}

test('integrated browser actions share one optional group; MCP and extension ownership stays intact', () => {
  const { buildToolTree, defaultEnabledTools } = load('src/editorTools.ts');
  const names = ['open_browser_page', 'click_element', 'screenshot_page', 'navigate_page',
    'read_page', 'hover_element', 'drag_element', 'type_in_page', 'handle_dialog', 'run_playwright_code'];
  const tools = [...names, 'mcp_browser_click_element', 'custom_click_element'].map(name => ({ name, description: '', tags: [] }));
  const tree = buildToolTree(tools, new Set(['click_element']), ['browser']);
  const browser = tree.find(g => g.id === 'builtin').groups.find(g => g.id === 'set:browser');
  assert.equal(browser.tools.length, names.length);
  assert.equal(browser.tools.find(t => t.name === 'click_element').enabled, true);
  assert.equal(browser.tools.find(t => t.name === 'read_page').enabled, false);
  assert.equal(tree.find(g => g.id === 'mcp:browser').tools.length, 1);
  assert.equal(tree.find(g => g.id === 'ext:custom').tools.length, 1);
  assert.equal(defaultEnabledTools(tools).length, 0);
});

test('discovers canonical global skills and symlinks, deduplicates and skips broken links', () => {
  const home = path.resolve('test-user');
  const entry = (name, link = false) => ({ name, isDirectory: () => !link, isSymbolicLink: () => link });
  const dirs = new Map([
    [path.join(home, '.agents', 'skills'), [entry('shared')]],
    [path.join(home, '.claude', 'skills'), [entry('shared', true), entry('linked', true), entry('broken', true)]],
  ]);
  const { discoverInstalledSkills } = load('src/skills.ts', {
    os: { homedir: () => home }, path,
    fs: {
      readdirSync: root => dirs.get(root) ?? [],
      readFileSync: file => {
        if (file.includes('broken')) throw new Error('ENOENT');
        return '---\nname: Example\ndescription: An installed skill\n---\nInstructions';
      },
    },
  });
  const found = discoverInstalledSkills();
  assert.equal(found.length, 2);
  assert.equal(found[0].dir, path.join(home, '.agents', 'skills', 'shared'));
  assert.equal(found[1].skill.id, 'installed-skill:linked');
  assert.equal(found[1].skill.content, 'Instructions');
  assert.equal(found[1].group.skillIds[0], found[1].skill.id);
});

test('project installs are discovered only in supplied workspaces and have distinct identities', () => {
  const home = path.resolve('test-user');
  const first = path.resolve('project-one');
  const second = path.resolve('project-two');
  const roots = new Set([home, first, second].map(root => path.join(root, '.agents', 'skills')));
  const { discoverInstalledSkills } = load('src/skills.ts', {
    os: { homedir: () => home }, path,
    fs: {
      readdirSync: root => roots.has(root) ? [{ name: 'wp-plugin-development', isDirectory: () => true }] : [],
      readFileSync: () => '---\nname: wp-plugin-development\n---\nBuild WordPress plugins.',
    },
  });
  const a = discoverInstalledSkills([first]);
  const b = discoverInstalledSkills([second]);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal(a[0].scope, 'workspace');
  assert.equal(a[0].workspaceRoot, first);
  assert.notEqual(a[0].group.id, b[0].group.id);
  assert.equal(a[1].group.id, b[1].group.id);
  assert.equal(a.some(d => d.workspaceRoot === second), false);
  assert.equal(discoverInstalledSkills().length, 1);
});

test('two project queues retain independent skill selections across reopen', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-skills-test-'));
  const { TaskQueue } = load('src/queue/db.ts', { fs, path, 'node:sqlite': require('node:sqlite') });
  const firstPath = path.join(root, 'first', 'queue.db');
  const secondPath = path.join(root, 'second', 'queue.db');
  const a = TaskQueue.open(firstPath);
  const b = TaskQueue.open(secondPath);
  try {
    a.setSkillGroupEnabled(['installed-group:wp-plugin-development'], true);
    b.setSkillGroupEnabled(['installed-group:another-skill'], true);
    assert.equal(a.enabledSkillGroups.includes('installed-group:wp-plugin-development'), true);
    assert.equal(b.enabledSkillGroups.includes('installed-group:wp-plugin-development'), false);
    const reopened = TaskQueue.open(firstPath);
    try {
      assert.equal(reopened.enabledSkillGroups.includes('installed-group:wp-plugin-development'), true);
      assert.equal(reopened.enabledSkillGroups.includes('installed-group:another-skill'), false);
    } finally { reopened.close(); }
  } finally {
    a.close(); b.close();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('mf-skills-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
