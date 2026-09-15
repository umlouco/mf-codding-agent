import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY, updatePack } from '../support/wordpress-skills.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lockPath = path.join(root, 'data', 'wordpress-skills.lock.json');
const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
const update = process.argv.includes('--update');
const sourceArg = process.argv.find(arg => arg.startsWith('--source='));
const manifest = await updatePack({ home: path.join(root, 'runtime', 'wordpress'),
  revision: update ? 'latest' : lock.revision,
  source: sourceArg ? path.resolve(sourceArg.slice('--source='.length)) : undefined });
if (update) await fs.writeFile(lockPath, JSON.stringify({ repository: REPOSITORY, revision: manifest.revision }, null, 2) + '\n');
// The build ships only its selected revision. User-installed packs retain old
// versions in global storage; this cleanup is confined to generated build files.
const bundleHome = path.join(root, 'runtime', 'wordpress');
for (const entry of await fs.readdir(bundleHome, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9]{40}$/.test(entry.name) || entry.name === manifest.revision) continue;
  const obsolete = path.resolve(bundleHome, entry.name);
  if (path.dirname(obsolete) !== bundleHome) throw new Error('Invalid bundle cleanup path');
  await fs.rm(obsolete, { recursive: true, force: true });
}
console.log(`[wordpress] bundled ${manifest.skills.length} official skills at ${manifest.revision}`);
