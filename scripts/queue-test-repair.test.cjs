const { fs, os, path, vm, assert, test, ts, load, vscode, prompts, validation, cognition, TaskQueue, LiveLog, usage, output, notes, goal, report, task, agents, fixture, orchestrator } = require('./queue-progress-helpers.cjs');
const { verificationDependencies, verificationPlanReply } = require('./queue-verification-helpers.cjs');

test('test rewrites stop the executor and run on the supervisor before independent validation',async t=>{
  const queue=fixture(t);
  queue.update(queue.list()[0].id,{solutionVerifyCommand:'node --check form.spec.js'});
  const current=queue.claimNext();
  let stopped=false;let repaired=false;let validated=false;
  const runner=orchestrator(queue,{'./command':{runVerificationCommand:async()=>{
    assert.equal(stopped,true);return 'exit=1 SyntaxError at form.spec.js:96';
  }},'./agents':{
    coreHalted:()=>false,
    runOnce:async(_context,_output,role,prompt,opts)=>{
      assert.equal(stopped,true,'executor must stop before editing supervisor starts');
      assert.equal(role,'supervisor');assert.equal(opts.allowTestEdits,true);
      assert.match(prompt,/own test repairs/);
      assert.match(prompt,/exit=1 SyntaxError at form.spec.js:96/,'supervisor receives the actual pre-repair failure');
      assert.equal(queue.get(current.id).status,'VERIFYING');
      repaired=true;
      return {text:'Repaired syntax in the test; parsing check passed.',usage,stopReason:'end_turn'};
    },
  }});
  runner.executionAbort=()=>{stopped=true;};
  runner.verifyWithExecutor=async()=>{assert.equal(repaired,true);validated=true;};
  await runner.applyProgressDecision(current,{action:'STOP_AND_REWRITE_TESTS',reason:'Broken test syntax',usage},{gen:0});
  assert.equal(validated,true);
  assert.equal(queue.get(current.id).status,'VERIFYING','supervisor cannot approve its own repair');
  assert.equal(queue.countEvents(current.id,'test-repair-finished'),1);
});

test('stopping supervisor test repair prevents its late handoff from starting validation',async t=>{
  const queue=fixture(t);const current=queue.claimNext();
  let finish;
  const runner=orchestrator(queue,{'./agents':{coreHalted:()=>false,runOnce:()=>new Promise(resolve=>{finish=resolve;})}});
  runner.verifyWithExecutor=()=>assert.fail('cancelled supervisor repair started validation');
  const pending=runner.applyProgressDecision(current,{action:'STOP_AND_REWRITE_TESTS',reason:'Repair test',usage},{gen:0});
  // Recovery admission now precedes starting the dedicated repair process.
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  runner.reviewGen++;
  finish({text:'Late repair report',usage,stopReason:'end_turn'});
  await pending;
  assert.equal(queue.get(current.id).output,'');
});

test('a host-blocked executor test rewrite goes straight to supervisor repair',async t=>{
  const queue=fixture(t);const current=queue.claimNext();
  queue.update(current.id,{status:'VERIFYING',errorLog:'[attempt 1] the core stopped the turn (supervisor_repair_required).',output:'Execution stopped: queue ownership: the supervisor must rewrite existing test form.spec.js.'});
  const runner=orchestrator(queue,{});let repaired=false;
  runner.repairTests=async(row,reason)=>{assert.equal(row.id,current.id);assert.match(reason,/supervisor-owned test/);repaired=true;};
  await runner.reviewWork(queue.get(current.id));
  assert.equal(repaired,true);
});

test('failed required command preserves host evidence for supervision without permitting verifier edits',async()=>{
  const command = 'node --check form.spec.js';
  let calls = 0;
  const verifier=load('src/queue/verification.ts',{
    ...verificationDependencies({result:()=>({output:'exit=1 SyntaxError: missing )',isError:true,meta:{exitCode:1}})}),
    './validation':validation,'./prompts':prompts,'./cognition':cognition,
    './agents':{coreHalted:()=>false,runOnce:async(_c,_o,_role,_prompt,opts)=>{
      assert.equal(opts.verificationOnly,true);
      assert.equal(opts.formatOnly,true,'planning/reporting cannot rewrite the failed test');
      return {text:JSON.stringify(++calls===1 ? verificationPlanReply(command) : {...report(),conclusion:'INCOMPLETE',
        behaviorEvidence:'Host receipt states: exit=1 SyntaxError: missing )',remaining:'Supervisor must repair the test syntax.'}),usage,stopReason:'end_turn'};
    }}});
  const result=await verifier.runVerification({},output,{...task,solutionVerifyCommand:command},goal);
  const evidence=JSON.parse(result.validationReport);
  assert.equal(evidence.conclusion,'INCOMPLETE');
  assert.equal(evidence.observedTools[0].status,'error');
  assert.match(evidence.behaviorEvidence,/SyntaxError/);
  assert.equal(evidence.verificationReceipts[0].passed,false);
  assert.equal(calls,2,'host planning and evidence reporting retain the new verification workflow');
});

test('a supervisor verdict cannot approve a contract changed while its model was running',async t=>{
  const queue=fixture(t);const current=queue.claimNext();
  queue.update(current.id,{status:'VERIFYING',validationReport:JSON.stringify(report())});
  let finish;
  const runner=orchestrator(queue,{'./agents':{superviseTask:()=>new Promise(r=>{finish=r;})}});
  const pending=runner.supervise(queue.get(current.id));
  queue.update(current.id,{solutionVerifyPrompt:'Also check the new required boundary'});
  finish({verdict:'VERIFIED',feedback:'Old checks passed',usage});await pending;
  assert.equal(queue.get(current.id).status,'VERIFYING');
  assert.equal(queue.countEvents(current.id,'verdict:VERIFIED'),0);
});

test('task rewrites fence an active executor and invalidate its old validation',t=>{
  const queue=fixture(t);const current=queue.claimNext();
  queue.update(current.id,{validationReport:JSON.stringify(report())});
  const runner=orchestrator(queue,{});let stopped=false;runner.executionAbort=()=>{stopped=true;};
  runner.applyTaskEdits({taskEdits:[{seq:current.seq,solutionVerifyCommand:'run corrected check'}]},current.seq);
  assert.equal(stopped,true);
  assert.equal(queue.get(current.id).status,'PENDING');
  assert.equal(queue.get(current.id).validationReport,'');
});

test('supervisor test repair receives the rewritten contract and cannot reuse its old PASS',async t=>{
  const queue=fixture(t);const current=queue.claimNext();
  queue.update(current.id,{status:'VERIFYING',validationReport:JSON.stringify(report())});
  const runner=orchestrator(queue,{'./agents':{superviseTask:async()=>({verdict:'REPAIR_TESTS',feedback:'Correct the test',usage,
    taskEdits:[{seq:current.seq,description:'Repair the real selector from observed DOM',solutionVerifyCommand:'run corrected check'}]})}});
  let repaired=false;runner.repairTests=async row=>{
    assert.equal(row.description,'Repair the real selector from observed DOM');
    assert.equal(row.solutionVerifyCommand,'run corrected check');
    assert.equal(row.validationReport,'');repaired=true;
  };
  await runner.supervise(queue.get(current.id));assert.equal(repaired,true);
});

test('a halted supervisor repair requests decomposition instead of validating partial work',async t=>{
  const queue=fixture(t);const current=queue.claimNext();
  const runner=orchestrator(queue,{'./agents':{coreHalted:()=>true,runOnce:async()=>({text:'Partial repair',stopReason:'repeated_tool_error',usage})}});
  let replacement='';runner.requestFailureDecomposition=(_task,reason)=>{replacement=reason;};
  runner.verifyWithExecutor=async()=>assert.fail('halted repair was validated instead of replaced');
  await runner.repairTests(current,'Fix the test syntax');
  assert.match(replacement,/repeated_tool_error/);assert.equal(queue.countEvents(current.id,'test-repair-halted'),1);
  assert.match(queue.get(current.id).errorLog,/supervisor test repair halted/);
  assert.ok(!queue.get(current.id).supervisorFeedback.startsWith('[SUPERVISOR_TEST_REPAIR]'));
});

test('repeated halted repairs require a new supervisor plan instead of an identical third repair',async()=>{
  const module=agents();let calls=0;
  module.setTestRunner(async(_c,_o,role,prompt)=>{
    assert.equal(role,'supervisor');calls++;
    if(calls===1)return {text:JSON.stringify({verdict:'REPAIR_TESTS',feedback:'Repair the same broken spec',taskEdits:[]}),usage};
    assert.match(prompt,/Supervisor test repair has halted 2 times/);
    return {text:JSON.stringify({splitInto:[
      {title:'Repair parser failure',description:'Correct the reported unmatched delimiter',implVerifyPrompt:'Inspect the delimiter correction',solutionVerifyPrompt:'The test parses',solutionVerifyCommand:'node --check form.spec.js'},
      {title:'Repair navigation',description:'Use the observed public login route',implVerifyPrompt:'Inspect the navigation target',solutionVerifyPrompt:'Actual browser login succeeds',solutionVerifyCommand:''}
    ],feedback:'Complete parsing before browser navigation'}),usage};
  });
  const result=await module.superviseTask({},output,{...task,status:'VERIFYING',validationReport:JSON.stringify({...report(),conclusion:'INCOMPLETE'})},0,goal,{failedRepairs:2});
  assert.equal(result.verdict,'SPLIT');assert.equal(result.splitInto.length,2);assert.equal(calls,2);
});

test('a cancelled final supervisor error cannot overwrite the replacement worker activity',async t=>{
  const queue=fixture(t);const current=queue.claimNext();queue.update(current.id,{status:'VERIFYING',validationReport:JSON.stringify(report())});
  let reject;
  const runner=orchestrator(queue,{'./agents':{superviseTask:()=>new Promise((_r,j)=>{reject=j;})}});
  const pending=runner.supervise(queue.get(current.id));runner.reviewGen++;
  queue.recordActivity(current.id,'model_wait','replacement supervisor is alive','supervisor');
  reject(new Error('old process exited'));await pending;
  assert.equal(queue.get(current.id).activityDetail,'replacement supervisor is alive');
  assert.equal(queue.countEvents(current.id,'error'),0);
});
