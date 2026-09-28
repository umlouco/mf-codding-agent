const { DatabaseSync } = require('node:sqlite');
const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map(r => r.name);
console.log('TABLES:', tables.join(', '));
try {
  const tasks = db.prepare("select id, seq, status, title, substr(description,1,120) as desc_head from tasks order by seq").all();
  console.log(`\nTASKS (${tasks.length}):`);
  for (const t of tasks) console.log(`#${t.seq} [${t.status}] ${t.title}`);
} catch (e) { console.log('tasks error:', e.message); }
try {
  const run = db.prepare("select * from run_state limit 1").all();
  if (run.length) console.log('\nRUN_STATE:', JSON.stringify(run[0]));
} catch (e) { /* no run_state table */ }
try {
  const byStatus = db.prepare("select status, count(*) c from tasks group by status").all();
  console.log('\nBY_STATUS:', JSON.stringify(byStatus));
} catch (e) { console.log('byStatus error:', e.message); }
try {
  const stats = db.prepare("select * from stats limit 5").all();
  if (stats.length) console.log('STATS:', JSON.stringify(stats));
} catch (e) { /* no stats table */ }
db.close();
