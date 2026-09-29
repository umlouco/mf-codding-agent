const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare("select id, seq, status, title, attempts, started_at, finished_at, tokens_in, tokens_out from tasks order by seq").all();
for (const r of rows) {
  const started = r.started_at ? new Date(r.started_at).toISOString() : '-';
  const finished = r.finished_at ? new Date(r.finished_at).toISOString() : '-';
  console.log(`#${r.seq} [${r.status}] att=${r.attempts} tok=${r.tokens_in}/${r.tokens_out} start=${started} end=${finished}\n   ${r.title}`);
}
db.close();
