const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const id = Number(process.argv[3]);
const note = process.argv[4] || '';

const before = db.prepare(
  'SELECT id, seq, status, attempts, max_attempts, activity_phase, length(supervisor_feedback) AS fb_len FROM tasks WHERE id = ?'
).get(id);
console.log('before:', JSON.stringify(before));

const sibling = db.prepare(
  "SELECT DISTINCT activity_phase FROM tasks WHERE id <> ? AND status = 'PENDING' LIMIT 1"
).get(id);
const phase = sibling && sibling.activity_phase ? sibling.activity_phase : '';

const merged = note
  ? db.prepare('SELECT supervisor_feedback FROM tasks WHERE id = ?').get(id).supervisor_feedback + '\n\n[OWNER NOTE ' + new Date().toISOString() + ']\n' + note
  : undefined;

db.prepare(
  'UPDATE tasks SET attempts = 0, status = ?, activity_phase = ?, supervisor_feedback = ?, updated_at = ? WHERE id = ?'
).run('PENDING', phase, merged ?? '', Math.floor(Date.now() / 1000), id);

const after = db.prepare(
  'SELECT id, seq, status, attempts, max_attempts, activity_phase, length(supervisor_feedback) AS fb_len FROM tasks WHERE id = ?'
).get(id);
console.log('after: ', JSON.stringify(after));
