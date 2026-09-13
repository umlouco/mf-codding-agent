// Coverage for the deterministic local-WordPress helper the agent is told to
// call. It is what removes "figure out XAMPP" from the model's job.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { environmentBriefing, findPluginFile } = require('./wp-xampp.cjs');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mf-wp-'));
}

test('no briefing is produced for a non-WordPress workspace', () => {
  const site = scratch();
  try { assert.equal(environmentBriefing(site, 'http://localhost/x', process.cwd()), ''); }
  finally { fs.rmSync(site, { recursive: true, force: true }); }
});

test('the briefing names the exact binaries, site, and helper commands', () => {
  const site = scratch();
  fs.writeFileSync(path.join(site, 'wp-load.php'), '<?php');
  try {
    const text = environmentBriefing(site, 'http://localhost/damicheleusa', process.cwd());
    assert.match(text, /C:\\www\\php\\php\.exe/);
    assert.match(text, /C:\\www\\mysql\\bin\\mysql\.exe/);
    assert.ok(text.includes(site), 'names the site path');
    assert.match(text, /wp-xampp\.cjs" bootstrap/);
    assert.match(text, /wp-xampp\.cjs" probe/);
    assert.match(text, /Do not use the "mysql" on PATH/);
  } finally { fs.rmSync(site, { recursive: true, force: true }); }
});

test('findPluginFile locates a plugin by its Plugin Name header', () => {
  const site = scratch();
  const plugin = path.join(site, 'wp-content', 'plugins', 'mf-newsletter');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'mf-newsletter.php'), '<?php\n/* Plugin Name: MF Newsletter */\n');
  try {
    assert.equal(findPluginFile(site, 'mf-newsletter'), 'mf-newsletter/mf-newsletter.php');
    assert.throws(() => findPluginFile(site, 'not-there'), /Plugin directory not found/);
  } finally { fs.rmSync(site, { recursive: true, force: true }); }
});
