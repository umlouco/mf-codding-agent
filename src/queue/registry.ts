import { TaskQueue } from './db';

/**
 * The task queue open in this window, if any.
 *
 * A handful of places outside the queue module itself — `buildCoreConfig`,
 * chiefly — need to read the workspace's per-queue picks (which MCP servers
 * and skill groups are switched on) without depending on `extension.ts`'s
 * private module state. This is that handle, following the same "live behind
 * an explicit init" pattern as `providers/instance.ts`.
 */

let active: TaskQueue | undefined;

export function setActiveQueue(q: TaskQueue | undefined): void {
  active = q;
}

export function getActiveQueue(): TaskQueue | undefined {
  return active;
}
