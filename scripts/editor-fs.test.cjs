// Run with: node --test scripts/editor-fs.test.cjs
// Exercise the registered RPC handler with a byte-preserving editor double.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'core/internal/tools/testdata/edit_cases.json'), 'utf8'));

function editor(text) {
  let content = text, saved = text, applies = 0, saves = 0, lastChanges = [];
  class Position {
    constructor(line, character) { this.line = line; this.character = character; }
  }
  class Range {
    constructor(start, end) { this.start = start; this.end = end; }
  }
  class WorkspaceEdit {
    changes = [];
    replace(uri, range, value) { this.changes.push({ range, value }); }
  }
  const document = {
    getText: () => content,
    positionAt(offset) {
      const lines = content.slice(0, offset).split('\n');
      return new Position(lines.length - 1, lines.at(-1).length);
    },
    offsetAt(position) {
      const lines = content.split('\n');
      return lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
    },
    async save() { saves++; saved = content; return true; },
  };
  const vscode = {
    Position, Range, WorkspaceEdit,
    Uri: { file: fsPath => ({ fsPath, scheme: 'file' }) },
    workspace: {
      async openTextDocument() { return document; },
      async applyEdit(edit) {
        applies++;
        lastChanges = edit.changes.map(({ range, value }) => ({
          start: document.offsetAt(range.start), end: document.offsetAt(range.end), value,
        }));
        for (const { start, end, value } of [...lastChanges].sort((a, b) => b.start - a.start)) {
          content = content.slice(0, start) + value + content.slice(end);
        }
        return true;
      },
    },
  };
  function load(file) {
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
      exports, process, Buffer,
      require(name) {
        if (name === 'vscode') return vscode;
        if (name === './core') return {};
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
        return require(name);
      },
    }, { filename: file });
    return exports;
  }
  const handlers = {};
  load(path.join(root, 'src/editorFs.ts')).registerEditorFsHandlers({
    onRequest: (name, handler) => { handlers[name] = handler; },
  });
  return {
    edit: edits => handlers['fs/edit']({ path: path.join(root, 'fixture.txt'), edits }),
    state: () => ({ content, saved, applies, saves, lastChanges }),
  };
}

for (const tc of cases) {
  test(tc.name, async () => {
    const host = editor(tc.text);
    if (tc.error) {
      await assert.rejects(host.edit(tc.edits), error => error.message.includes(tc.error));
      assert.equal(host.state().content, tc.text);
      assert.equal(host.state().saved, tc.text);
      assert.equal(host.state().applies, 0);
      assert.equal(host.state().saves, 0);
    } else {
      const result = await host.edit(tc.edits);
      assert.equal(result.replacements, tc.count);
      assert.equal(host.state().content, tc.want);
      assert.equal(host.state().saved, tc.want);
      assert.equal(host.state().applies, 1);
      assert.equal(host.state().saves, 1);
      if (tc.edits.length === 1) {
        const changes = host.state().lastChanges;
        assert.equal(changes.length, tc.count);
        for (const change of changes) {
          assert.equal(tc.text.slice(change.start, change.end).replace(/\r\n/g, '\n'),
            tc.edits[0].old_string.replace(/\r\n/g, '\n'), 'edit must target only the original matched range');
        }
      }
    }
  });
}
