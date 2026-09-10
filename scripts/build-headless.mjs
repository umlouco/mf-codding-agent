import { build } from 'esbuild';
await build({ entryPoints: ['src/headless.ts'], outfile: 'out/headless.cjs',
  platform: 'node', target: 'node22', format: 'cjs', bundle: true,
  external: ['better-sqlite3', 'node:sqlite'], logLevel: 'info',
  plugins: [{ name: 'no-editor-dependency', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ errors: [{ text: 'Headless runtime must not depend on VS Code' }] }));
  } }],
});
