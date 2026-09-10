// Minimal editor services for source execution. Queue, providers and tools remain production code.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const repo = path.resolve(__dirname, '..');

class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const emptyEvent = () => ({ dispose() {} });

function fileServices() {
  const documents = new Map();
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  class WorkspaceEdit {
    changes = [];
    replace(uri, range, text) { this.changes.push({ uri, range, text }); }
  }
  const workspace = {
    // No editor buffers exist in the source runner. Reads always start from disk.
    textDocuments: [],
    fs: { createDirectory: uri => fs.promises.mkdir(uri.fsPath, { recursive: true }),
      writeFile: (uri, content) => fs.promises.writeFile(uri.fsPath, content) },
    async openTextDocument(uri) {
      let content = await fs.promises.readFile(uri.fsPath, 'utf8');
      const document = { uri, getText: () => content,
        positionAt(offset) {
          const lines = content.slice(0, offset).split('\n');
          return new Position(lines.length - 1, lines.at(-1).length);
        },
        offsetAt(position) {
          const lines = content.split('\n');
          return lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
        },
        setText: value => { content = value; },
        save: async () => { await fs.promises.writeFile(uri.fsPath, content); return true; } };
      documents.set(uri.fsPath, document);
      return document;
    },
    async applyEdit(edit) {
      const changes = new Map();
      for (const change of edit.changes) {
        const document = documents.get(change.uri.fsPath);
        if (!document) return false;
        if (!changes.has(document)) changes.set(document, []);
        changes.get(document).push({ start: document.offsetAt(change.range.start),
          end: document.offsetAt(change.range.end), text: change.text });
      }
      for (const [document, replacements] of changes) {
        let text = document.getText();
        for (const change of replacements.sort((a, b) => b.start - a.start))
          text = text.slice(0, change.start) + change.text + text.slice(change.end);
        document.setText(text);
      }
      return true;
    },
  };
  return { workspace, Position, Range, WorkspaceEdit };
}

function sourceLoader(vscode) {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(repo, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const localRequire = createRequire(absolute);
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: absolute,
    }).outputText;
    const requireSource = name => {
      if (name === 'vscode') return vscode;
      if (name.startsWith('.')) {
        const target = path.resolve(path.dirname(absolute), name);
        if (fs.existsSync(target + '.ts')) return load(target + '.ts');
      }
      return localRequire(name);
    };
    new vm.Script(`(function(require,module,exports,__filename,__dirname){${source}\n})`, { filename: absolute })
      .runInThisContext()(requireSource, module, module.exports, absolute, path.dirname(absolute));
    return module.exports;
  }
  return load;
}

async function createHost(options) {
  const workspace = fs.realpathSync(options.workspace);
  const values = { 'queue.cronIntervalSeconds': 10, 'queue.reviewIntervalSeconds': 300,
    'queue.claudeCli.maxBudgetUsd': 0, 'llm.idleMinutes': 0, ...options.settings };
  const output = { appendLine: line => (options.log || console.error)(line), dispose() {} };
  const files = fileServices();
  const vscode = {
    EventEmitter,
    Position: files.Position, Range: files.Range, WorkspaceEdit: files.WorkspaceEdit,
    Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    workspace: { ...files.workspace, workspaceFolders: [{ uri: { fsPath: workspace } }],
      getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback }),
      onDidChangeConfiguration: emptyEvent },
    lm: { tools: [], onDidChangeChatModels: emptyEvent, onDidChangeTools: emptyEvent,
      registerMcpServerDefinitionProvider: emptyEvent },
    window: { showInformationMessage: async text => output.appendLine(text),
      showWarningMessage: async text => output.appendLine(text), showErrorMessage: async text => output.appendLine(text) },
    Uri: { file: file => ({ fsPath: file, scheme: 'file' }) },
    env: { appName: 'MF Agent source runner' },
  };
  const state = new Map(), secrets = new Map();
  const memento = { get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
    update: async (key, value) => { state.set(key, value); } };
  const context = { extensionPath: repo, subscriptions: [], globalState: memento, workspaceState: memento,
    globalStorageUri: { fsPath: path.join(workspace, '.mfagent', 'headless') },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); } } };
  const load = sourceLoader(vscode);
  const { store } = load('src/providers/instance.ts').initProviders(context, output);
  const { ROLES } = load('src/providers/store.ts');
  await store.update({ profiles: [{ id: 'headless-claude', name: 'Claude CLI', providerId: 'claude-cli',
    extra: options.cli ? { cliPath: options.cli } : {} }],
    roles: Object.fromEntries(ROLES.filter(role => role !== 'embedding').map(role =>
      [role, { profileId: 'headless-claude', model: options.model || 'sonnet', effort: options.effort || 'medium' }])),
    browser: { headless: true }, languages: { auto: false, list: [] } });
  if (options.workerUrl || options.workerModel) {
    if (!options.workerUrl || !options.workerModel) throw Error('Both worker URL and model are required.');
    const workerURL = new URL(options.workerUrl);
    if (!['http:', 'https:'].includes(workerURL.protocol) || workerURL.username || workerURL.password || workerURL.search || workerURL.hash)
      throw Error('Worker URL must be an HTTP(S) API base without embedded credentials or query parameters.');
    await store.update({ profiles: [...store.profiles, { id: 'headless-worker', name: 'HTTP workers',
      providerId: 'openai-compatible', baseURL: options.workerUrl }],
      roles: { ...store.settings.roles, ...Object.fromEntries(['coding', 'executor', 'supervisor', 'vision'].map(role =>
        [role, { profileId: 'headless-worker', model: options.workerModel, effort: options.workerEffort || '' }])) } });
    await store.setApiKey('headless-worker', options.workerApiKey || process.env.MFAGENT_WORKER_API_KEY || '');
  }
  const router = load('src/llm/router.ts').initRouter(context, output);
  const bridge = load('src/mcpBridge.ts').initBridge(context, store, output);
  const queue = load('src/queue/db.ts').TaskQueue.open(path.join(workspace, '.mfagent', 'queue.db'));
  load('src/queue/registry.ts').setActiveQueue(queue);
  const testing = load('src/queue/testingEnvironment.ts');
  const credentials = options.credentials || Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith('MFAGENT_CREDENTIAL_'))
    .map(([key, value]) => [key.slice('MFAGENT_CREDENTIAL_'.length).toLowerCase(), value]));
  if (options.url || Object.keys(credentials).length) {
    await testing.saveTestingEnvironment(context, queue, { url: options.url || queue.testingUrl,
      credentials: Object.entries(credentials).map(([name, value]) => ({ name, value })), remove: [] });
  }
  let runner;
  return { workspace, context, output, store, queue, load,
    get runner() {
      return runner ||= new (load('src/queue/orchestrator.ts').Orchestrator)(context, output, queue);
    },
    async close() {
      runner?.dispose();
      await runner?.drain();
      bridge.dispose(); router.dispose();
      for (const subscription of context.subscriptions) subscription.dispose();
      queue.close(); secrets.clear();
    } };
}
module.exports = { createHost };
