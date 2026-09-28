const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const t = db.prepare("select id, title, status, attempts, max_attempts, supervisor_feedback, validation_report, error_log from tasks where seq = 1").get();
console.log('=== validation_report (FULL) ===');
try {
  const vr = JSON.parse(t.validation_report);
  for (const k of Object.keys(vr)) {
    const v = typeof vr[k] === 'string' ? vr[k] : JSON.stringify(vr[k]);
    console.log(`\n--- ${k} ---\n${v}`);
  }
} catch (e) { console.log(t.validation_report); }
console.log('\n=== error_log (FULL) ===');
console.log(t.error_log);
db.close();
