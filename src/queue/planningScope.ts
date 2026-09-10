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

export function selectPlanningRegions(regions: Region[], catalog: Region[], selected: unknown): Region[] {
  if (!Array.isArray(selected) || !selected.length || selected.some(value =>
    typeof value !== 'string' || !catalog.some(region => region.path === value))) {
    throw new Error('The scope planner selected an empty or unlisted directory.');
  }
  return regions.filter(region => selected.some(prefix => region.path === prefix ||
    prefix !== '.' && region.path.startsWith(prefix + '/')));
}

export async function narrowPlanningRegions(regions: Region[], select: (catalog: Region[]) => Promise<unknown>): Promise<Region[]> {
  for (let round = 0; round < 3 && regions.length > 120; round++) {
    const catalog = planningCatalog(regions);
    const selected = selectPlanningRegions(regions, catalog, await select(catalog));
    if (selected.length === regions.length) return selected;
    regions = selected;
  }
  return regions;
}
