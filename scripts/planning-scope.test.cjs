const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

function region(filePath, fileCount = 1, languages = { php: fileCount }) {
  return { path: filePath, fileCount, languages };
}

// The catalog shown to the scope planner aggregates directories to stay small.
// On a large WordPress install it lists `wp-content/plugins` where the scan
// itself returned `wp-content/plugins/pxrms`. A goal that names the plugin made
// the planner select that precise path, and validating only against the
// aggregated catalog rejected it — so planning failed before it began.
test('a scope selection may name a real scanned directory the catalog aggregated away', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-planning-scope-'));
  const host = await createHost({ workspace: root, log() {} });
  try {
    const { selectPlanningRegions } = host.load('src/queue/planningScope.ts');
    const regions = [
      region('.', 4, { php: 4 }),
      region('wp-content/plugins/pxrms', 12, { php: 12 }),
      region('wp-content/plugins/pxrms/src', 8, { php: 8 }),
      region('wp-content/plugins/other', 5, { php: 5 }),
      region('wp-content/themes/site', 20, { php: 20 }),
    ];
    const catalog = [
      region('.', 4, { php: 4 }),
      region('wp-content/plugins', 17, { php: 17 }),
      region('wp-content/themes', 20, { php: 20 }),
    ];

    const selected = selectPlanningRegions(regions, catalog, ['wp-content/plugins/pxrms', '.']);
    assert.deepEqual(selected.map(r => r.path), [
      '.',
      'wp-content/plugins/pxrms',
      'wp-content/plugins/pxrms/src',
    ]);
    assert.ok(!selected.some(r => r.path.includes('other')),
      'the unrelated plugin must not be selected');

    const absolute = selectPlanningRegions(regions, catalog,
      [`${root}/wp-content/plugins/pxrms`.replace(/\\/g, '/')], root);
    assert.deepEqual(absolute.map(r => r.path), ['wp-content/plugins/pxrms', 'wp-content/plugins/pxrms/src']);

    assert.throws(() => selectPlanningRegions(regions, catalog, ['wp-content/plugins/does-not-exist']),
      /not in this workspace/);
    assert.throws(() => selectPlanningRegions(regions, catalog, []),
      /selected no directories/);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
