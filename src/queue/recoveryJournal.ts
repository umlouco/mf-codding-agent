import * as path from 'path';
import type { TaskEvent, TaskQueue } from './db';

/** Page the durable tool trail, not the UI excerpt. A separate short-lived
 * read-only connection avoids coupling recovery state to the queue's private driver.
 */
export function recoveryEvents(queue: TaskQueue, taskId: number, after: number, through: number): TaskEvent[] {
  if (!queue.path) return queue.events(taskId, -1).filter(e => e.id > after && e.id <= through &&
    ['executor', 'validator'].includes(e.actor) && e.kind === 'tool').reverse().slice(0, 512);
  let db: any;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(queue.path, { readOnly: true });
  } catch {
    const BetterSqlite = require('better-sqlite3');
    const binding = path.join(__dirname, '..', 'bin', `${process.platform}-${process.arch}`, 'better_sqlite3.node');
    try { db = new BetterSqlite(queue.path, { readonly: true, fileMustExist: true, nativeBinding: binding }); }
    catch { db = new BetterSqlite(queue.path, { readonly: true, fileMustExist: true }); }
  }
  try {
    return db.prepare(`SELECT id, task_id AS taskId, actor, kind, message, at FROM task_events
      WHERE task_id = ? AND id > ? AND id <= ? AND actor IN ('executor','validator') AND kind = 'tool'
      ORDER BY id ASC LIMIT 512`).all(taskId, after, through);
  } finally { db.close(); }
}
