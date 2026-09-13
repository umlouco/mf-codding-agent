#!/usr/bin/env node
// Deterministic local-WordPress bootstrap for the XAMPP-style stack at C:\www.
//
// The point is to take the fragile, knowledge-heavy part of "install WordPress
// and test my plugin" away from the model. An experienced developer would just
// create the database, point wp-config at the local root account, run the
// installer, make an admin and some posts, activate the plugin, and open the
// page. This script does exactly that with the local PHP/MySQL binaries and
// prints a JSON summary the agent (and its verifier) can read.
//
// Commands:
//   probe    --site <path> [--url <url>]
//   bootstrap --site <path> [--url <url>] [--title t] [--admin-user u]
//             [--admin-pass p] [--admin-email e] [--posts n]
//   activate --site <path> (--plugin <slug> | --plugin-file <rel/path.php>)
//   deactivate --site <path> --plugin-file <rel/path.php>
//
// Credentials: the DB uses the local root account with no password. The WP admin
// password comes from --admin-pass, else MFAGENT_CREDENTIAL_PASSWORD, else a
// generated one written to <site>/.mfagent/wp-admin.json (never printed).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULTS = {
  php: 'C:\\www\\php\\php.exe',
  mysql: 'C:\\www\\mysql\\bin\\mysql.exe',
  db: 'damicheleusa', dbUser: 'root', dbPass: '', dbHost: 'localhost', prefix: 'wp_',
  url: 'http://localhost/damicheleusa',
};

function parseArgv(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key || !key.startsWith('--')) throw Error(`Unexpected argument ${key}`);
    options[key.slice(2)] = rest[i + 1];
  }
  return { command, options };
}

function readConfig(site) {
  const file = path.join(site, 'wp-config.php');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* fresh install */ }
  const grab = (re, fallback) => { const m = re.exec(text); return m ? m[1] : fallback; };
  return {
    db: grab(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]*)['"]/, DEFAULTS.db),
    dbUser: DEFAULTS.dbUser,
    dbPass: DEFAULTS.dbPass,
    dbHost: grab(/define\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]*)['"]/, DEFAULTS.dbHost),
    prefix: grab(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/, DEFAULTS.prefix),
  };
}

function run(file, args, opts = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Error(`${path.basename(file)} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(-800)}`);
  }
  return result.stdout || '';
}

function ensureDatabase(mysql, config) {
  run(mysql, ['-u' + config.dbUser, config.dbPass ? '-p' + config.dbPass : '', '-e',
    `CREATE DATABASE IF NOT EXISTS \`${config.db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`]
    .filter(Boolean));
}

function salts() {
  // No $ or quotes: the salt is emitted inside a PHP double-quoted string, and a
  // literal $ there becomes an interpolation and an undefined-variable warning.
  const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#%^&*()-_[]{}<>~+=,.;:/?|';
  const one = () => Array.from({ length: 64 }, () => pool[crypto.randomInt(pool.length)]).join('');
  return ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
    'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'].map(key => [key, one()]);
}

function writeConfig(site, config, url) {
  const lines = [
    '<?php',
    `define('DB_NAME', ${JSON.stringify(config.db)});`,
    `define('DB_USER', ${JSON.stringify(config.dbUser)});`,
    `define('DB_PASSWORD', ${JSON.stringify(config.dbPass)});`,
    `define('DB_HOST', ${JSON.stringify(config.dbHost)});`,
    "define('DB_CHARSET', 'utf8mb4');",
    "define('DB_COLLATE', '');",
    ...salts().map(([key, value]) => `define('${key}', ${JSON.stringify(value)});`),
    `$table_prefix = ${JSON.stringify(config.prefix)};`,
    "define('WP_DEBUG', false);",
    `define('WP_HOME', ${JSON.stringify(url)});`,
    `define('WP_SITEURL', ${JSON.stringify(url)});`,
    "if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }",
    "require_once ABSPATH . 'wp-settings.php';",
    '',
  ];
  fs.writeFileSync(path.join(site, 'wp-config.php'), lines.join('\n'));
}

function runPhp(site, php, body, env = {}) {
  const file = path.join(site, '.mfagent-wp-bootstrap.php');
  fs.writeFileSync(file, body);
  try {
    const out = run(php, [file], { cwd: site, env: { ...process.env, ...env } });
    const start = out.indexOf('{');
    if (start < 0) throw Error(`installer returned no JSON: ${out.slice(-600)}`);
    return JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const INSTALLER = `<?php
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);
define('WP_INSTALLING', true);
require __DIR__ . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
global $wpdb;
$title = getenv('WPB_TITLE'); $user = getenv('WPB_USER'); $email = getenv('WPB_EMAIL');
$pass = getenv('WPB_PASS'); $url = getenv('WPB_URL'); $posts = (int) getenv('WPB_POSTS');
$out = ['freshInstall' => false, 'tables' => 0];
$tables = $wpdb->get_col('SHOW TABLES');
$out['tables'] = count($tables);
if (!in_array($wpdb->prefix . 'options', $tables, true)) {
  $result = wp_install($title, $user, $email, true, '', $pass);
  $out['freshInstall'] = true;
  $out['userId'] = $result['user_id'] ?? null;
}
$existing = get_user_by('login', $user);
if (!$existing) {
  $id = wp_create_user($user, $pass, $email);
  if (!is_wp_error($id)) { (new WP_User($id))->set_role('administrator'); $existing = get_user_by('id', $id); }
} else {
  wp_set_password($pass, $existing->ID);
  (new WP_User($existing->ID))->set_role('administrator');
}
update_option('siteurl', $url); update_option('home', $url); update_option('blogname', $title);
update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules(false);
$published = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status='publish' AND post_type='post'");
for ($i = 1; $i <= $posts; $i++) {
  $marker = "mfagent-sample-$i";
  $found = $wpdb->get_var($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE post_type='post' AND post_name=%s LIMIT 1", $marker));
  if ($found) continue;
  wp_insert_post(['post_title' => "Sample Post $i", 'post_name' => $marker,
    'post_content' => "Sample content $i for the newsletter picker.", 'post_status' => 'publish', 'post_type' => 'post']);
}
$out['posts'] = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status='publish' AND post_type='post'");
$out['adminUser'] = $user; $out['siteUrl'] = get_option('siteurl');
echo json_encode($out);
`;

const PLUGIN_INSTALLER = `<?php
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);
require __DIR__ . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$target = (string) getenv('WPB_PLUGIN_FILE');
$active = (array) get_option('active_plugins', []);
$out = ['active' => in_array($target, $active, true), 'target' => $target, 'plugins' => []];
if ($target && getenv('WPB_ACTIVATE') === '1' && !$out['active']) {
  $result = activate_plugin($target);
  $out['error'] = is_wp_error($result) ? $result->get_error_message() : '';
}
if ($target && getenv('WPB_DEACTIVATE') === '1') { deactivate_plugins($target); }
$out['active'] = in_array($target, (array) get_option('active_plugins', []), true);
foreach ((array) get_option('active_plugins', []) as $plugin) $out['plugins'][] = $plugin;
echo json_encode($out);
`;

function findPluginFile(site, slug) {
  const dir = path.join(site, 'wp-content', 'plugins', slug);
  if (!fs.existsSync(dir)) throw Error(`Plugin directory not found: ${dir}`);
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.name.endsWith('.php')) continue;
      const head = fs.readFileSync(full, 'utf8').slice(0, 8000);
      // WordPress reads the header from the first 8 KB; accept the usual
      // "/*", "//", "#" and "* Plugin Name:" comment forms.
      if (/(?:^|\s|\*|\/)Plugin Name\s*:/i.test(head)) {
        return path.relative(path.join(site, 'wp-content', 'plugins'), full).split(path.sep).join('/');
      }
    }
  }
  throw Error(`No plugin main file with a "Plugin Name:" header under ${dir}`);
}

async function probe(url) {
  const started = Date.now();
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  return { url, status: response.status, bytes: Buffer.byteLength(body), ms: Date.now() - started,
    wordpress: /wp-content|wp-includes/i.test(body), title: (/<title>([^<]*)<\/title>/i.exec(body) || [, ''])[1] };
}

async function main(argv) {
  const { command, options } = parseArgv(argv);
  const site = options.site && path.resolve(options.site);
  if (!site) throw Error('--site is required.');
  const php = options.php || DEFAULTS.php;
  const mysql = options.mysql || DEFAULTS.mysql;
  const url = options.url || DEFAULTS.url;
  const config = readConfig(site);

  if (command === 'probe') { console.log(JSON.stringify(await probe(url))); return; }

  if (command === 'bootstrap') {
    const user = options['admin-user'] || process.env.MFAGENT_CREDENTIAL_USERNAME || 'mfagent';
    let pass = options['admin-pass'] || process.env.MFAGENT_CREDENTIAL_PASSWORD || '';
    let generated = false;
    if (!pass) { pass = crypto.randomBytes(18).toString('base64url'); generated = true; }
    ensureDatabase(mysql, config);
    writeConfig(site, config, url);
    const result = runPhp(site, php, INSTALLER, {
      WPB_TITLE: options.title || 'Local WordPress', WPB_USER: user,
      WPB_EMAIL: options['admin-email'] || 'admin@example.test', WPB_PASS: pass, WPB_URL: url,
      WPB_POSTS: options.posts || '3',
    });
    if (generated) {
      const dir = path.join(site, '.mfagent'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'wp-admin.json'), JSON.stringify({ user, pass, url }, null, 2));
    }
    const status = await probe(url);
    console.log(JSON.stringify({ ...result, adminPasswordSource: generated ? '.mfagent/wp-admin.json' : 'provided', probe: status }, null, 2));
    if (status.status !== 200 || status.bytes === 0) throw Error(`WordPress still not serving: HTTP ${status.status}, ${status.bytes} bytes`);
    return;
  }

  if (command === 'activate' || command === 'deactivate') {
    let file = options['plugin-file'];
    if (!file && options.plugin) file = findPluginFile(site, options.plugin);
    if (!file) throw Error('Provide --plugin <slug> or --plugin-file <relative.php>.');
    const result = runPhp(site, php, PLUGIN_INSTALLER, { WPB_PLUGIN_FILE: file,
      WPB_ACTIVATE: command === 'activate' ? '1' : '', WPB_DEACTIVATE: command === 'deactivate' ? '1' : '' });
    console.log(JSON.stringify({ ...result, file }, null, 2));
    if (result.error) throw Error(result.error);
    return;
  }

  throw Error(`Unknown command ${command}; use bootstrap, activate, deactivate or probe.`);
}

/**
 * Authoritative, host-verified facts about the local stack, for injection into
 * the planner/supervisor/executor prompts. This is the part a capable developer
 * would not have to think about: exact binaries, the fact the site already
 * serves, the admin user, and the one helper to call instead of guessing.
 */
function environmentBriefing(site, url, repo) {
  if (!site || !fs.existsSync(path.join(site, 'wp-load.php'))) return '';
  let user = process.env.MFAGENT_CREDENTIAL_USERNAME || 'mfagent';
  try { user = JSON.parse(fs.readFileSync(path.join(site, '.mfagent', 'wp-admin.json'), 'utf8')).user || user; } catch { /* keep default */ }
  const helper = path.join(repo, 'scripts', 'wp-xampp.cjs');
  return [
    'LOCAL ENVIRONMENT (host-verified; use these exact facts, do not re-derive them):',
    `- XAMPP-style stack under C:\\www. Apache and MariaDB are already running.`,
    `- PHP: ${DEFAULTS.php} (PHP 8.2). MySQL client: ${DEFAULTS.mysql} (user root, NO password). Do not use the "mysql" on PATH; it is a different server.`,
    `- WordPress is installed at ${site} and serves at ${url}. Verify with the probe below; do not reinstall, and only rewrite wp-config if the probe fails.`,
    `- Use this host helper for local setup instead of hand-rolling it:`,
    `    node "${helper}" bootstrap --site "${site}" --url "${url}"   (idempotent: creates the DB, fixes wp-config, installs only when empty, ensures the admin user and sample posts)`,
    `    node "${helper}" probe     --site "${site}" --url "${url}"   (HTTP status, page bytes, title, WordPress marker)`,
    `    node "${helper}" activate   --site "${site}" --plugin <slug> (or --plugin-file <relative.php>)`,
    `    node "${helper}" deactivate --site "${site}" --plugin-file <relative.php>`,
    `- WordPress admin user: ${user}. The password is in ${site}\\.mfagent\\wp-admin.json and in MFAGENT_CREDENTIAL_PASSWORD; never print it.`,
    `- Build plugins under ${site}\\wp-content\\plugins. Keep tests and Playwright artifacts OUTSIDE the site.`,
  ].join('\n');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, probe, findPluginFile, environmentBriefing };
