import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // The VS Code API is injected by the host, never bundled. better-sqlite3 is
  // a native addon and node:sqlite is a runtime builtin — both are resolved at
  // run time by src/queue/db.ts, so neither may be pulled into the bundle.
  external: ['vscode', 'better-sqlite3', 'node:sqlite'],
  sourcemap: !watch ? false : 'inline',
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching…');
} else {
  await esbuild.build(options);
}
