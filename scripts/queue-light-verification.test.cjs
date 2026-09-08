const { test } = require('node:test');
const { assert, fixture, orchestrator, usage, report, load } = require('./queue-progress-helpers.cjs');

function ready(queue) {
  const task = queue.claimNext();
  queue.update(task.id, {status:'VERIFYING', output:'Current implementation handoff'});
  return queue.get(task.id);
}
const monitor = { VALIDATION_FAILED:'validation-failed', shellWaitViolation:()=>'' };

test('supported current verification advances directly with no scope or verdict model', async t => {
  const queue = fixture(t);
  queue.addAll([{title:'Next task',description:'Independent next task'}]);
  const task = ready(queue);
  const runner = orchestrator(queue, {'./monitor':monitor, './agents':{
    superviseTask:()=>assert.fail('Passing checks must not spawn another judge'),
  }, './verification':{runVerification:async()=>({text:'Observed PASS',validationReport:JSON.stringify(report()),usage})}});
  runner.scopeWatch=()=>assert.fail('No nested scope reviewer during validation');
  await runner.startIndependentVerification(task);
  await runner.supervise(queue.get(task.id));
  assert.equal(queue.get(task.id).status,'VERIFIED');
  assert.equal(queue.get(task.id).output,task.output);
  assert.equal(queue.claimNext().seq,2);
});

test('two failed passes retire the task without fabricating success or losing the handoff', async t => {
  const queue=fixture(t); const task=ready(queue); let calls=0;
  queue.addAll([{title:'Next task',description:'Independent work'}]);
  const incomplete={...report(),conclusion:'INCOMPLETE',remaining:'Authentication failed on supplied target'};
  const runner=orchestrator(queue,{'./monitor':monitor,'./verification':{runVerification:async()=>{
    calls++;return {text:'Authentication failed',validationReport:JSON.stringify(incomplete),usage};
  }}});
  for(let i=0;i<3;i++) await runner.startIndependentVerification(queue.get(task.id));
  assert.equal(calls,2);
  assert.equal(queue.get(task.id).status,'FAILED');
  assert.equal(queue.get(task.id).output,task.output);
  assert.equal(JSON.parse(queue.get(task.id).validationReport).conclusion,'INCOMPLETE');
  assert.equal(queue.claimNext().seq,2);
});

test('two unreadable supervisor decisions cannot keep a task in VERIFYING forever',async t=>{
  const queue=fixture(t);const task=ready(queue);let calls=0;
  queue.update(task.id,{validationReport:JSON.stringify({...report(),conclusion:'INCOMPLETE'})});
  const runner=orchestrator(queue,{'./agents':{superviseTask:async()=>{calls++;throw Error('Unreadable decision');}}});
  for(let i=0;i<3;i++) await runner.supervise(queue.get(task.id));
  assert.equal(calls,2);assert.equal(queue.get(task.id).status,'FAILED');
  assert.equal(queue.isComplete(),true);assert.equal(queue.anyFailed(),true);
});

test('a changed contract cannot reuse an earlier host-backed PASS',async t=>{
  const queue=fixture(t);const task=ready(queue);let reviews=0;
  const runner=orchestrator(queue,{'./monitor':monitor,'./agents':{superviseTask:async()=>{
    reviews++;return {verdict:'REVERIFY',feedback:'Check new owner requirement',usage};
  }},'./verification':{runVerification:async()=>({text:'PASS',validationReport:JSON.stringify(report()),usage})}});
  await runner.startIndependentVerification(task);
  assert.equal(runner.currentHostVerification(queue.get(task.id)),true);
  queue.update(task.id,{solutionVerifyPrompt:'A new required outcome'});
  assert.equal(runner.currentHostVerification(queue.get(task.id)),false);
  // The cron must get new evidence; an old PASS is not its fast path.
  assert.equal(reviews,0);assert.equal(queue.get(task.id).status,'VERIFYING');
});

test('manual retry resets only that task allowance and retains all previous events',t=>{
  const queue=fixture(t);const task=ready(queue);
  queue.addAll([{title:'Other',description:'Other'}]);const other=queue.list()[1];
  for(const id of [task.id,other.id]) for(let i=0;i<2;i++)queue.log(id,'validator','verification-pass','Old pass');
  queue.log(task.id,'user','verification-retry','Owner requested another attempt');
  assert.equal(queue.countEvents(task.id,'verification-pass',true),0);
  assert.equal(queue.countEvents(other.id,'verification-pass',true),2);
  assert.equal(queue.countEvents(task.id,'verification-pass'),2);
});

test('a failed split prerequisite still blocks dependent work',t=>{
  const queue=fixture(t);const task=ready(queue);
  queue.update(task.id,{status:'FAILED',region:JSON.stringify({scopeSplit:{key:'first'}})});
  queue.addAll([{title:'Dependent',description:'Uses first outcome'}]);
  const {scopeBlocked}=load('src/queue/scopePlan.ts');
  assert.equal(scopeBlocked(queue.list()[1],queue.list()),true);
  assert.equal(queue.isComplete(),false);
});
