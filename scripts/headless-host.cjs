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

// Compiles the workspace globs detect.ts uses (nested extensions and bare filenames) to a regexp.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + pattern + '$', process.platform === 'win32' ? 'i' : '');
}

/** The subset of `vscode.workspace.findFiles` that detection needs: bounded, skip-heavy walks. */
function findFilesUnder(root, include, maxResults = 1) {
  const regex = globToRegExp(String(include || '**/*'));
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv',
    '__pycache__', 'vendor', '.mfagent', '.vscode', '.kilo', '.claude', '.idea']);
  const found = [];
  const stack = [root];
  let visited = 0;
  while (stack.length && found.length < maxResults && visited < 100000) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited++;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (regex.test(rel)) {
        found.push({ fsPath: abs });
        if (found.length >= maxResults) break;
      }
    }
  }
  return Promise.resolve(found);
}

function validateWorkerUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error('Worker URL must be an HTTP(S) API base without embedded credentials or query parameters.');
  return value;
}

/**
 * Worker roles (coding/executor/vision) need an OpenAI-compatible HTTP
 * provider; the Claude CLI provider can only serve planner/supervisor (see
 * catalog.ts's rolesAllowed). Binding every role to claude-cli, as this host
 * used to do, left the executor unresolvable and every run failed before it
 * could do a single turn. Resolve one worker from explicit arguments or the
 * environment, or leave worker roles unbound so a real preflight can say so.
 */
/** Pick the API key that belongs to this base URL when none was named explicitly. */
function keyForWorker(baseURL) {
  const host = new URL(baseURL).hostname.toLowerCase();
  if (/(^|\.)openrouter\.ai$/.test(host)) return process.env.OPENROUTER_API_KEY || '';
  if (/(^|\.)openai\.com$/.test(host)) return process.env.OPENAI_API_KEY || '';
  if (/(^|\.)nvidia\.com$/.test(host)) return process.env.NVIDIA_API_KEY || '';
  return '';
}

function resolveWorker(options) {
  if (options.workerUrl || options.workerModel) {
    if (!options.workerUrl || !options.workerModel) throw Error('Both worker URL and model are required.');
    const baseURL = validateWorkerUrl(options.workerUrl);
    return { providerId: 'openai-compatible', name: 'HTTP workers', baseURL, model: options.workerModel,
      apiKey: options.workerApiKey || process.env.MFAGENT_WORKER_API_KEY || keyForWorker(baseURL) };
  }
  const url = process.env.MFAGENT_WORKER_URL, model = process.env.MFAGENT_WORKER_MODEL;
  if (url && model) return { providerId: 'openai-compatible', name: 'HTTP workers', baseURL: validateWorkerUrl(url),
    model, apiKey: process.env.MFAGENT_WORKER_API_KEY || keyForWorker(url) };
  if (process.env.OPENROUTER_API_KEY) return { providerId: 'openai-compatible', name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1', model: model || 'anthropic/claude-sonnet-4.6',
    apiKey: process.env.OPENROUTER_API_KEY };
  if (process.env.OPENAI_API_KEY) return { providerId: 'openai-compatible', name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1', model: model || 'gpt-4o', apiKey: process.env.OPENAI_API_KEY };
  return null;
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
      findFiles: (include, _exclude, maxResults) => findFilesUnder(workspace, include, maxResults),
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
  const context = { extensionPath: repo, extensionUri: { fsPath: repo }, subscriptions: [], globalState: memento, workspaceState: memento,
    globalStorageUri: { fsPath: path.join(workspace, '.mfagent', 'headless') },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); } } };
  const load = sourceLoader(vscode);
  const { store } = load('src/providers/instance.ts').initProviders(context, output);
  const { ROLES } = load('src/providers/store.ts');
  const worker = resolveWorker(options);
  // --worker-all keeps every role on the HTTP worker, so a run never depends on
  // the Claude CLI account (its monthly spend limit stops planner/supervisor
  // mid-run). Default keeps the strong CLI planner/supervisor.
  const claudeRoles = options.workerAll ? [] : ['planner', 'supervisor'];
  const workerRoles = options.workerAll
    ? ROLES.filter(role => role !== 'embedding')
    : ['coding', 'coder', 'vision'];
  const roles = {};
  for (const role of ROLES) {
    if (role === 'embedding' || !claudeRoles.includes(role)) continue;
    roles[role] = { profileId: 'headless-claude', model: options.model || 'sonnet', effort: options.effort || 'medium' };
  }
  const profiles = [{ id: 'headless-claude', name: 'Claude CLI', providerId: 'claude-cli',
    extra: options.cli ? { cliPath: options.cli } : {} }];
  if (worker) {
    profiles.push({ id: 'headless-worker', name: worker.name, providerId: worker.providerId, baseURL: worker.baseURL });
    for (const role of workerRoles) {
      roles[role] = { profileId: 'headless-worker', model: worker.model, effort: options.workerEffort || '' };
    }
  }
  // The embedding role is separate from the chat workers by design: graph memory
  // needs a real embeddings endpoint. Bind it from an explicit URL/model or the
  // environment so a headless run gets hybrid recall instead of keyword-only.
  const embeddingUrl = options.embeddingUrl || process.env.MFAGENT_EMBEDDING_URL;
  const embeddingModel = options.embeddingModel || process.env.MFAGENT_EMBEDDING_MODEL;
  const embeddingKey = options.embeddingApiKey || process.env.MFAGENT_EMBEDDING_API_KEY || '';
  if (embeddingUrl && embeddingModel) {
    const baseURL = validateWorkerUrl(embeddingUrl);
    profiles.push({ id: 'headless-embedding', name: 'Embeddings', providerId: 'openai-compatible', baseURL });
    roles.embedding = { profileId: 'headless-embedding', model: embeddingModel, effort: '' };
  }
  // The Tester role is split from the Coder on purpose: bind it to its own
  // endpoint so verification can run on a different model (NVIDIA Nemotron by
  // default). Falls back to the worker binding when unset.
  const testerUrl = options.testerUrl || process.env.MFAGENT_TESTER_URL;
  const testerModel = options.testerModel || process.env.MFAGENT_TESTER_MODEL;
  const testerKey = options.testerApiKey || process.env.MFAGENT_TESTER_API_KEY || process.env.NVIDIA_API_KEY || '';
  if (testerUrl && testerModel) {
    const baseURL = validateWorkerUrl(testerUrl);
    profiles.push({ id: 'headless-tester', name: 'Tester', providerId: 'openai-compatible', baseURL });
    roles.tester = { profileId: 'headless-tester', model: testerModel, effort: options.testerEffort || '' };
  }
  await store.update({ profiles, roles, browser: { headless: true }, languages: { auto: false, list: [] } });
  if (worker) await store.setApiKey('headless-worker', worker.apiKey);
  if (testerUrl && testerModel) await store.setApiKey('headless-tester', testerKey);
  if (embeddingUrl && embeddingModel) await store.setApiKey('headless-embedding', embeddingKey);
  if (options.provider) {
    // Bind planner/supervisor/coder/tester to a real HTTP provider, mirroring
    // the roles the extension has stored. Configured before initRouter so the
    // router reads these bindings, not the default claude-cli profile.
    const p = options.provider;
    const id = p.id || 'headless-provider';
    const providerId = p.providerId || 'openai-compatible';
    await store.update({
      profiles: [...store.profiles.filter(x => x.id !== id),
        { id, name: p.name || 'Headless provider', providerId, baseURL: p.baseURL }],
      roles: { ...store.settings.roles,
        coding:     { profileId: id, model: p.codingModel || p.executorModel || p.plannerModel, effort: p.effort || '' },
        planner:    { profileId: id, model: p.plannerModel, effort: p.effort || '' },
        supervisor: { profileId: id, model: p.supervisorModel || p.plannerModel, effort: p.effort || '' },
        coder:      { profileId: id, model: p.coderModel || p.executorModel || p.plannerModel, effort: p.effort || '' },
        tester:     { profileId: id, model: p.testerModel || p.executorModel || p.plannerModel, effort: p.effort || '' },
      },
    });
    await store.setApiKey(id, p.apiKey || '');
  }
  // A providers file exported from the settings page (version 2) is the
  // authoritative configuration when supplied: it carries the profiles, role
  // bindings, MCP servers and API keys a real editor run would use. Applied
  // last, after the built-in headless defaults and any single --provider, so a
  // run can be reproduced from exactly what the user exported.
  if (options.providersFile) {
    const doc = JSON.parse(fs.readFileSync(path.resolve(options.providersFile), 'utf8'));
    const patch = {};
    for (const key of ['profiles', 'roles', 'languages', 'browser', 'skills', 'skillGroups', 'mcpServers']) {
      if (doc[key] !== undefined) patch[key] = doc[key];
    }
    await store.update(patch);
    for (const [profileId, key] of Object.entries(doc.apiKeys || {})) {
      if (typeof key === 'string' && key.trim()) await store.setApiKey(profileId, key.trim());
    }
  }
  const router = load('src/llm/router.ts').initRouter(context, output);
  load('src/playwrightRuntime.ts').activatePlaywrightRuntime(context, output);
  load('src/wordpressSkills.ts').activateWordPressSkills(context, output);
  const bridge = load('src/mcpBridge.ts').initBridge(context, store, output);
  // queuePath lets a run use a snapshot of a live queue while the workspace
  // still points at the real files. Default is the workspace's own queue.
  const queuePath = options.queuePath ? path.resolve(options.queuePath) : path.join(workspace, '.mfagent', 'queue.db');
  const queue = load('src/queue/db.ts').TaskQueue.open(queuePath);
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
