const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function queueHtml() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/queue/panelHtml.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: () => ({ Uri: { joinPath: (...parts) => parts.join('/') } }) });
  return exports.renderQueueHtml({ extensionUri: 'extension' }, {
    asWebviewUri: value => `vscode-resource:/${value}`, cspSource: 'vscode-resource:',
  });
}

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.value = '';
    this.hidden = false;
    this.scrollHeight = this.scrollTop = this.clientHeight = 0;
    this.classList = { add: name => { this.className += ` ${name}`; }, toggle() {} };
  }
  get options() { return this.children; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) { for (const callback of this.listeners[name] || []) callback(event); }
  querySelector(selector) {
    const element = new Element(selector);
    this.appendChild(element);
    return element;
  }
  querySelectorAll() { return this.children; }
}

function mount() {
  const html = queueHtml();
  const elements = new Map(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => [match[1], new Element(match[1])]));
  elements.get('cron').appendChild(new Element('option'));
  const messages = [], listeners = {}, tabs = new Element('tabs');
  const window = { addEventListener: (type, callback) => { listeners[type] = callback; } };
  const document = {
    getElementById: id => { assert.ok(elements.has(id), `missing actual HTML element ${id}`); return elements.get(id); },
    createElement: tag => new Element(tag),
    querySelectorAll: () => [], querySelector: () => tabs,
  };
  const context = vm.createContext({ window, document, setInterval() {},
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }) });
  const scripts = Array.from(html.matchAll(/<script nonce="([^"]+)" src="[^"]*\/([^/]+\.js)"><\/script>/g));
  for (const script of scripts) vm.runInContext(fs.readFileSync(path.join(__dirname, '../media', script[2]), 'utf8'), context);
  return { html, scripts, elements, messages, state: data => listeners.message({ data: { type: 'state', ...data } }) };
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

test('queue view loads scoped helpers under the same nonce before initialization', () => {
  const view = mount();
  assert.deepEqual(view.scripts.map(script => script[2]), ['queue-terminal.js', 'queue-context.js', 'queue-tasks.js', 'queue.js']);
  assert.equal(new Set(view.scripts.map(script => script[1])).size, 1);
  assert.match(view.html, /script-src 'nonce-/);
  assert.equal(view.messages.at(-1).type, 'ready');
  assert.ok(view.messages.some(message => message.type === 'logTail' && message.id === null));
});

test('task actions and summary cannot select or advertise terminal FAILED status', () => {
  const view = mount();
  view.state({ tasks: [{ id: 45, seq: 45, title: 'Replace rejected task', kind: 'task', status: 'VERIFYING',
    activityPhase: 'decomposition_required', activityDetail: 'Supervisor is preparing replacement tasks', attempts: 1, maxAttempts: 3 }],
    status: { running: true, mode: 'autonomous', intervalMs: 60_000, settingIntervalSeconds: 60 },
    stats: { runState: 'RUNNING', byStatus: { VERIFYING: 1, FAILED: 3 } },
    models: {}, testingCredentialNames: [], editorTools: [], mcpServers: [], skillGroups: [] });
  assert.doesNotMatch(view.elements.get('counts').innerHTML, /FAILED/);
  assert.match(view.elements.get('counts').innerHTML, /VERIFYING 1/);
  const options = descendants(view.elements.get('tasks')).filter(element => element.tagName === 'option');
  assert.deepEqual(options.map(option => option.value), ['PENDING', 'EXECUTING', 'VERIFYING', 'VERIFIED', 'PAUSED']);
  view.elements.get('pause').fire('click');
  assert.equal(view.messages.at(-1).type, 'pause', 'explicit owner controls remain wired after extraction');
  assert.ok(descendants(view.elements.get('tasks')).some(element => element.textContent.includes('Supervisor is preparing replacement tasks')));
});
