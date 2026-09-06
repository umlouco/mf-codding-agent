const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
function load(file) {
 const exports = {};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
 }).outputText,{exports,process,URL,__dirname,require});
 return exports;
}
const {TaskQueue}=load('src/queue/db.ts');
const api=load('src/queue/testingEnvironment.ts');
function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mf-testing-env-'));
 const queue=TaskQueue.open(path.join(directory,'queue.db'));
 const secretMap=new Map();
 const context={secrets:{get:async key=>secretMap.get(key),store:async(key,value)=>secretMap.set(key,value)}};
 t.after(()=>{queue.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('mf-testing-env-'));fs.rmSync(directory,{recursive:true,force:true});});
 return {queue,secretMap,context};
}
test('fixed target persists but credentials stay out of the database and model context',async t=>{
 const {queue,secretMap,context}=fixture(t);
 await api.saveTestingEnvironment(context,queue,{url:'https://app.example.test/project/',credentials:[{name:'password',value:'supplied-test-secret'}],remove:[]});
 assert.equal(queue.testingUrl,'https://app.example.test/project/');
 assert.deepEqual(Array.from(queue.testingCredentialNames),['password']);
 assert.match(queue.contextInstructions,/OWNER-CONFIGURED TESTING ENVIRONMENT/);
 assert.doesNotMatch(queue.contextInstructions,/supplied-test-secret/);
 assert.ok(!fs.readFileSync(queue.path).includes(Buffer.from('supplied-test-secret')));
 assert.equal(secretMap.size,1);
 const testing=await api.loadTestingEnvironment(context,queue);
 assert.equal(testing.credentials.password,'supplied-test-secret');
 assert.equal(api.testingProcessEnvironment(testing).MFAGENT_CREDENTIAL_PASSWORD,'supplied-test-secret');
 const other=await api.loadTestingEnvironment(context,{path:queue.path+'-other',testingUrl:''});
 assert.equal(Object.keys(other.credentials).length,0);
});
test('terminal projects can retain, replace and remove credentials without a URL',async t=>{
 const {queue,context}=fixture(t);
 for (const value of ['terminal-token','']) await api.saveTestingEnvironment(context,queue,{url:'',credentials:[{name:'token',value}],remove:[]});
 assert.equal((await api.loadTestingEnvironment(context,queue)).credentials.token,'terminal-token');
 assert.match(queue.contextInstructions,/terminal credentials without a URL/);
 await api.saveTestingEnvironment(context,queue,{url:'',credentials:[{name:'token',value:'replacement-token'}],remove:[]});
 assert.equal((await api.loadTestingEnvironment(context,queue)).credentials.token,'replacement-token');
 await api.saveTestingEnvironment(context,queue,{url:'',credentials:[],remove:['token']});
 assert.equal(Object.keys((await api.loadTestingEnvironment(context,queue)).credentials).length,0);
});
test('invalid configuration cannot partially overwrite a working environment',async t=>{
 const {queue,context}=fixture(t);
 await api.saveTestingEnvironment(context,queue,{url:'https://app.example.test/',credentials:[{name:'password',value:'original-secret'}],remove:[]});
 for (const change of [
  {url:'file:///tmp/test'}, {url:'https://user:secret@example.test/'},
  {credentials:[{name:'bad-name',value:'new-secret'}]},
  {credentials:[{name:'token',value:'one'},{name:'TOKEN',value:'two'}]},
 ]) await assert.rejects(api.saveTestingEnvironment(context,queue,{url:'https://other.example.test/',credentials:[],remove:[],...change}));
 assert.equal(queue.testingUrl,'https://app.example.test/');
 assert.equal((await api.loadTestingEnvironment(context,queue)).credentials.password,'original-secret');
});
test('legacy prompt credentials become references, including escaped values',()=>{
 const testing={url:'',credentials:{password:'a"b\\c'}};
 const prompt=api.testingPrompt('Login using a"b\\c',testing);
 assert.match(prompt,/MFAGENT_CREDENTIAL_PASSWORD/);
 assert.equal(api.redactTestingSecrets('a"b\\c',testing),'[REDACTED]');
});


test('copied queues fail visibly when host secrets are missing and can restore them through the same settings',async t=>{
 const {queue,secretMap,context}=fixture(t);
 await api.saveTestingEnvironment(context,queue,{url:'',credentials:[{name:'token',value:'original-token'}],remove:[]});
 secretMap.clear();
 await assert.rejects(api.loadTestingEnvironment(context,queue),/credentials unavailable/);
 await assert.rejects(api.saveTestingEnvironment(context,queue,{url:'',credentials:[{name:'token',value:''}],remove:[]}),/Supply or explicitly remove/);
 await api.saveTestingEnvironment(context,queue,{url:'',credentials:[{name:'token',value:'restored-token'}],remove:[]});
 assert.equal((await api.loadTestingEnvironment(context,queue)).credentials.token,'restored-token');
});
