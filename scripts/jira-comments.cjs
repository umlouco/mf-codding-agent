const fs = require('node:fs');
const doc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const comments = (doc.fields && doc.fields.comment && doc.fields.comment.comments) || [];
console.log(`ISSUE: ${doc.key} — ${doc.fields.summary}`);
console.log(`STATUS: ${doc.fields.status.name}`);
console.log(`COMMENTS: ${comments.length}\n`);
function adfText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(adfText).join(node.type === 'text' ? '' : (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock' ? '\n' : ''));
  return '';
}
for (const c of comments) {
  const author = c.author && (c.author.displayName || c.author.name);
  const created = c.created;
  const body = adfText(c.body).trim();
  const hasMedia = JSON.stringify(c.body).includes('"media"');
  console.log(`===== [${c.id}] ${author} @ ${created} ${hasMedia ? '[HAS IMAGES]' : ''}`);
  console.log(body.length > 3500 ? body.slice(0, 3500) + `\n...[truncated ${body.length}]` : body);
  console.log('');
}
