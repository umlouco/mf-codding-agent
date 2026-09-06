// Run with: node --test scripts/queue-tools.test.cjs
// Exercise real role overrides and initialization without starting workers or VS Code.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, dependencies = {}, extra = '') {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    Buffer,
    require: (name) => dependencies[name] ?? {},
  }, { filename: file });
  return exports;
}

for (const [role, omitDefinitions] of [
  ['supervisor', true], ['executor', false], ['planner', false],
]) {
  for (const memoryEnabled of [true, false]) {
    test(`${role} preserves configured MCP tools and memoryEnabled=${memoryEnabled}`, async () => {
      const resolved = { model: 'configured-model', effort: 'high' };
      const store = {
        resolve: async (requestedRole) => {
          assert.equal(requestedRole, role);
          return resolved;
        },
      };
      const { overridesFor } = load('src/queue/agents.ts', {
        '../providers/instance': { getStore: () => store },
        '../providers/payload': { contextCeiling: () => 128000 },
        '../llm/router': {
          getRouter: () => ({ endpointFor: async (requested) => {
            assert.equal(requested, resolved);
            return { type: 'openai-compatible', baseURL: 'http://model.test', apiKey: '' };
          } }),
        },
        vscode: { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } },
      }, '\nexport { overridesFor };');

      const overrides = await overridesFor(role, 12);
      assert.equal(overrides.disableTools, omitDefinitions);
      const mcpServers = [{ name: 'workspace-tools', url: 'http://tools.test/mcp', enabled: true }];
      const payload = { providers: [], memoryEnabled, mcpServers };
      const { CoreClient } = load('src/core.ts', {
        './providers/payload': { buildCoreConfig: async () => payload },
        './providers/instance': { getStore: () => store },
      });
      const core = Object.create(CoreClient.prototype);
      core.request = async (method, config) => {
        assert.equal(method, 'initialize');
        return config;
      };

      const config = await core.initialize(overrides);
      assert.equal(config.memoryEnabled, memoryEnabled, 'role preserves the configured memory setting');
      assert.equal(config.mcpServers, mcpServers, 'role preserves the configured MCP servers');
      assert.equal(config.disableTools, omitDefinitions, 'definition omission survives initialization');
      assert.equal(config.coding.model, 'configured-model');
      assert.equal(config.coding.providerId, `queue-${role}`);
      assert.equal(config.maxIterations, 12);
      assert.equal(config.maxContextTokens, 128000);
    });
  }
}
