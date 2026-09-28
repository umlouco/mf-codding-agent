const { DatabaseSync } = require('node:sqlite');
const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const taskSeq = parseInt(process.argv[3] || '1', 10);
const limit = parseInt(process.argv[4] || '20', 10);

const cols = db.prepare("pragma table_info(tasks)").all().map(c => c.name);
const task = db.prepare("select * from tasks where seq = ?").get(taskSeq);
if (task) {
  for (const c of cols) {
    const v = task[c];
    if (v === null || v === undefined) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    console.log(`== ${c} ==\n${s.length > 4000 ? s.slice(0, 4000) + `\n...[truncated ${s.length} chars]` : s}\n`);
  }
} else { console.log('no task with seq', taskSeq); }

const evCols = db.prepare("pragma table_info(task_events)").all().map(c => c.name);
console.log('--- task_events cols:', evCols.join(','));
let events;
try {
  events = db.prepare("select * from task_events where task_id = ? order by rowid desc limit ?").all(task.id, limit);
} catch (e) {
  try { events = db.prepare("select * from task_events where seq = ? order by rowid desc limit ?").all(taskSeq, limit); }
  catch (e2) { console.log('event query failed:', e2.message); events = []; }
}
for (const ev of events.reverse()) {
  const parts = [];
  for (const c of evCols) {
    if (c === 'id' || c === 'task_id' || c === 'seq') continue;
    const v = ev[c];
    if (v === null || v === undefined || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${c}: ${s.length > 1500 ? s.slice(0, 1500) + '...' : s}`);
  }
  console.log(`---- event ----\n${parts.join('\n')}\n`);
}

const logCols = db.prepare("pragma table_info(agent_logs)").all().map(c => c.name);
console.log('--- agent_logs cols:', logCols.join(','));
let logs;
try {
  logs = db.prepare("select * from agent_logs where task_id = ? order by rowid desc limit ?").all(task.id, limit);
} catch (e) { console.log('log query failed:', e.message); logs = []; }
for (const l of logs.reverse()) {
  const parts = [];
  for (const c of logCols) {
    const v = l[c];
    if (v === null || v === undefined || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${c}: ${s.length > 1200 ? s.slice(0, 1200) + '...' : s}`);
  }
  console.log(`---- log ----\n${parts.join('\n')}\n`);
}
db.close();
