import * as vscode from 'vscode';
import { resolveCoreBinary } from '../detect';
import { AgentRunError } from './agentTypes';
import * as cp from 'child_process';
import { killTree } from './agentRuntime';

// ---- workspace scan ------------------------------------------------------

/**
 * One deterministically-sized slice of the workspace, as reported by
 * `mfcore scan` — see core/internal/tools/scan.go. No LLM is involved in
 * producing this: it exists so "is this slice small enough to explore in one
 * turn" is a file count code already checked, not a question the planner or
 * an expansion agent has to size up on its own.
 */
export interface Region {
  path: string;
  fileCount: number;
  languages: Record<string, number>;
}

/**
 * Runs the deterministic workspace scan and returns the regions it found.
 *
 * This is a plain subprocess call, not an agent turn — there is nothing here
 * for a model to get wrong or take a long time over, which is the point:
 * sizing the plan happens before any LLM is involved.
 */
export async function runScanCommand(
  context: vscode.ExtensionContext,
  root: string,
  maxPerRegion: number,
): Promise<Region[]> {
  const bin = resolveCoreBinary(context).path;
  if (!bin) {
    throw new AgentRunError('the mfcore binary could not be found, so the workspace cannot be scanned');
  }

  const timeoutMs = 30_000;
  return new Promise<Region[]>((resolve, reject) => {
    const child = cp.spawn(
      bin,
      ['scan', '--json', '--dir', root, '--max-per-region', String(Math.max(1, Math.round(maxPerRegion)))],
      { cwd: root, windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killer);
      fn();
    };

    const killer = setTimeout(() => {
      killTree(child.pid);
      finish(() =>
        reject(new AgentRunError(`the workspace scan was still running after ${Math.round(timeoutMs / 1000)}s`)),
      );
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) =>
      finish(() => reject(new AgentRunError(`could not start mfcore scan: ${e.message}`))),
    );
    child.on('close', () => {
      finish(() => {
        try {
          const env = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
          if (env.error) {
            reject(new AgentRunError(`workspace scan failed: ${env.error}`));
            return;
          }
          resolve(Array.isArray(env.regions) ? env.regions : []);
        } catch {
          reject(
            new AgentRunError(`mfcore scan did not return a result: ${(stderr || stdout).slice(0, 500)}`),
          );
        }
      });
    });
  });
}

/** What a phase's `region` column carries — see TaskKind. */
export interface RegionInfo {
  paths: string[];
  fileCount: number;
}

export const EMPTY_REGION: RegionInfo = { paths: [], fileCount: 0 };

export function parseRegion(raw: string): RegionInfo {
  if (!raw) {
    return EMPTY_REGION;
  }
  try {
    const d = JSON.parse(raw);
    return {
      paths: Array.isArray(d.paths) ? d.paths.map((p: unknown) => String(p)) : [],
      fileCount: Number(d.fileCount) || 0,
    };
  } catch {
    return EMPTY_REGION;
  }
}

export function encodeRegion(r: RegionInfo): string {
  return JSON.stringify(r);
}

/** True when `candidate` is `region.paths[i]` itself or somewhere under it. */
export function withinRegion(candidate: string, paths: string[]): boolean {
  const norm = candidate.trim().replace(/\\/g, '/').replace(/^\.\/?/, '');
  return paths.some((p) => {
    const base = p.trim().replace(/\\/g, '/').replace(/^\.\/?/, '');
    return norm !== '' && (norm === base || norm.startsWith(`${base}/`));
  });
}
