import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

/** Includes committed WAL rows; never opens the source through queue migrations. */
export async function importQueueSnapshot(source: string, destination: string): Promise<{
  taskCount: number; tasksUnchanged: boolean; tasksSha256: string;
}> {
  source = fs.realpathSync(source);
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw new Error('Destination already exists; refusing overwrite');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(source, { readOnly: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    db.prepare('VACUUM INTO ?').run(temporary);
    const copy = new DatabaseSync(temporary, { readOnly: true });
    let rows: any[];
    try { rows = copy.prepare('SELECT * FROM tasks ORDER BY seq, id').all(); }
    finally { copy.close(); }
    fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL);
    return { taskCount: rows.length, tasksUnchanged: true,
      tasksSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  } finally {
    db.close();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
