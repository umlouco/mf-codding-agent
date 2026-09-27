import * as fs from 'fs';
import * as path from 'path';
import type { Region } from './agentRegions';

/** Independent WordPress installs are separate applications, not target theme assets. */
export function targetApplicationRegions(root: string, regions: Region[]): Region[] {
  const isWordPress = (directory: string) => fs.existsSync(path.join(directory, 'wp-load.php')) &&
    fs.existsSync(path.join(directory, 'wp-includes'));
  if (!isWordPress(root)) return regions;
  const nested = new Map<string, boolean>();
  return regions.filter(region => {
    const parts = region.path.replace(/\\/g, '/').split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      if (prefix === '.') continue;
      if (!nested.has(prefix)) nested.set(prefix, isWordPress(path.join(root, prefix)));
      if (nested.get(prefix)) return false;
    }
    return true;
  });
}

/** A structural selection pass prevents thousands of irrelevant leaf directories
 * from consuming the planner's context before it can reason about the goal. */
export function planningCatalog(regions: Region[]): Region[] {
  for (let depth = 3; depth >= 1; depth--) {
    const grouped = new Map<string, Region>();
    for (const region of regions) {
      const prefix = region.path.split('/').slice(0, depth).join('/');
      const group = grouped.get(prefix) ?? { path: prefix, fileCount: 0, languages: {} };
      group.fileCount += region.fileCount;
      for (const [language, count] of Object.entries(region.languages ?? {})) {
        group.languages[language] = (group.languages[language] || 0) + count;
      }
      grouped.set(prefix, group);
    }
    if (grouped.size <= 120) return [...grouped.values()];
  }
  throw new Error('The workspace has more than 120 top-level regions; select a narrower application root before planning.');
}

export function selectPlanningRegions(regions: Region[], catalog: Region[], selected: unknown, root = ''): Region[] {
  if (!Array.isArray(selected) || !selected.length) {
    throw new Error('The scope planner selected no directories.');
  }
  const listed = new Set(catalog.map(region => region.path));
  const chosen: string[] = [];
  const unknown: string[] = [];
  for (const value of selected) {
    const prefix = typeof value === 'string' ? normalizeSelection(value, root) : '';
    if (!prefix) continue;
    // The catalog is an aggregation of `regions`, not a second source of
    // truth: a 200-file `wp-content/plugins` is listed where the scan itself
    // returned `wp-content/plugins/pxrms`. A selection naming the actual
    // plugin — the directory the owner's goal named — is more precise than the
    // aggregation, not unlisted, so accept anything the scan really contains.
    if (!listed.has(prefix) && !matchesScannedRegion(regions, prefix)) {
      unknown.push(prefix);
      continue;
    }
    if (!chosen.includes(prefix)) chosen.push(prefix);
  }
  if (unknown.length) {
    throw new Error(`The scope planner selected directories that are not in this workspace: ${unknown.join(', ')}.`);
  }
  if (!chosen.length) {
    throw new Error('The scope planner selected no usable directory.');
  }
  return regions.filter(region => chosen.some(prefix => region.path === prefix ||
    prefix !== '.' && region.path.startsWith(prefix + '/')));
}

function matchesScannedRegion(regions: Region[], prefix: string): boolean {
  return regions.some(region => region.path === prefix || region.path.startsWith(prefix + '/'));
}

/** Accepts the workspace-relative forms a model returns, including a goal's absolute path. */
function normalizeSelection(value: string, root: string): string {
  let text = value.trim().replace(/\\/g, '/');
  if (!text) return '';
  if (root && path.isAbsolute(text)) text = path.relative(root, text).replace(/\\/g, '/');
  text = text.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return text === '' ? '.' : text;
}

export async function narrowPlanningRegions(regions: Region[], select: (catalog: Region[]) => Promise<unknown>, root = ''): Promise<Region[]> {
  for (let round = 0; round < 3 && regions.length > 120; round++) {
    const catalog = planningCatalog(regions);
    const selected = selectPlanningRegions(regions, catalog, await select(catalog), root);
    if (selected.length === regions.length) return selected;
    regions = selected;
  }
  return regions;
}
