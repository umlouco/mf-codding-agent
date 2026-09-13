import { createHash } from 'crypto';
import { TaskQueue, Task } from '../queue/db';
import { openDriver } from '../queue/dbDriver';

function contract(task: Task): string {
  return JSON.stringify([task.id, task.seq, task.title, task.description, task.kind,
    task.region, task.solutionVerifyPrompt]);
}
export function contractHash(task: Task): string {
  return createHash('sha256').update(contract(task)).digest('hex');
}
/** Explicit opt-in for a COPY only. Imported completion is historical, not replay evidence. */
export function prepareReplay(queue: TaskQueue): void {
  const { db } = openDriver(queue.path);
  try {
    db.exec('BEGIN IMMEDIATE');
    if (db.prepare("SELECT value FROM queue_meta WHERE key='headless.originals'").get()) {
      throw new Error('Replay already prepared');
    }
    const originals = queue.list().map(task => ({ id: task.id, hash: contractHash(task) }));
    const insert = db.prepare('INSERT INTO queue_meta(key,value) VALUES(?,?)');
    insert.run('headless.originals', JSON.stringify(originals));
    insert.run('headless.originalStatuses', JSON.stringify(queue.list().map(t => [t.id, t.status])));
    // A copied decomposition guard deliberately vetoes ordinary bulk resets.
    // Suspend ONLY these known guards inside this explicit snapshot-reset transaction,
    // restoring their exact definitions before any other connection can see a change.
    const guards = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('tasks_decomposition_insert','tasks_decomposition_update')").all();
    db.exec('DROP TRIGGER IF EXISTS tasks_decomposition_insert; DROP TRIGGER IF EXISTS tasks_decomposition_update;');
    db.exec(`UPDATE tasks SET status='PENDING', attempts=0, output='', validation_report='',
      supervisor_feedback='', error_log='', started_at=NULL, finished_at=NULL,
      last_activity_at=NULL, activity_phase='', activity_detail='';
      INSERT INTO queue_meta(key,value) VALUES('runState','IDLE')
        ON CONFLICT(key) DO UPDATE SET value='IDLE';`);
    for (const guard of guards) db.exec(guard.sql);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
export function assertReplayContract(queue: TaskQueue): void {
  const raw = queue.getMeta('headless.originals');
  if (!raw) throw new Error('Prepare an imported queue copy before running replay');
  const originals: { id: number; hash: string }[] = JSON.parse(raw);
  const verified: number[] = JSON.parse(queue.getMeta('headless.verified', '[]'));
  for (const original of originals) {
    const task = queue.get(original.id);
    if (!task || contractHash(task) !== original.hash) {
      throw new Error(`Original task contract changed or disappeared: ${original.id}`);
    }
  }
  for (const task of queue.list()) {
    if ((task.status === 'VERIFIED') !== verified.includes(task.id)) {
      throw new Error(`Task ${task.id} verified status conflicts with its replay receipt`);
    }
  }
}

/** Status and host-owned approval receipt commit together, including across process crashes. */
export function commitReplayVerified(queue: TaskQueue, id: number, review: string): void {
  const { db } = openDriver(queue.path);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare("SELECT value FROM queue_meta WHERE key='headless.verified'").get();
    const verified: number[] = JSON.parse(row?.value ?? '[]');
    if (!verified.includes(id)) verified.push(id);
    db.prepare("INSERT INTO queue_meta(key,value) VALUES('headless.verified',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(verified));
    const changed = db.prepare("UPDATE tasks SET status='VERIFIED', finished_at=?, updated_at=?, supervisor_feedback=? WHERE id=? AND status='VERIFYING'")
      .run(Date.now(), Date.now(), review, id);
    if (changed.changes !== 1) throw new Error('Stale replay verification cannot commit');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
