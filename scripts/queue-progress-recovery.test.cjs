const { fs, os, path, vm, assert, test, ts, load, vscode, prompts, validation, cognition, TaskQueue, LiveLog, usage, output, notes, goal, report, task, agents, fixture, orchestrator } = require('./queue-progress-helpers.cjs');
const { verificationDependencies, verificationPlanReply } = require('./queue-verification-helpers.cjs');


test('cancellation during asynchronous startup never restarts a disposed worker', async () => {
  let release;
  let resolving = false;
  let stop;
  let initialized = 0;
  class CoreClient {
    onNotification() {}
    async start() {}
    async initialize() { initialized++; return { model: 'test', provider: 'test' }; }
    stop() {}
    dispose() {}
  }
  let resolves = 0;
  const module = agents({
    '../core': { CoreClient }, '../editorFs': { registerEditorFsHandlers() {} },
    '../mcpBridge': { getBridge: () => ({ attach() {} }) },
    '../providers/instance': { getStore: () => ({ resolve: async () => {
      if (++resolves === 1) return { kind: 'http' };
      resolving = true;
      return new Promise(resolve => release = resolve);
    } }) },
    '../providers/payload': { contextCeiling: () => 128000 },
    '../llm/router': { getRouter: () => ({ endpointFor: async () => ({ type: 'openai-compatible' }) }) },
  });
  const work = module.runOnce({}, output, 'executor', 'Work', { onAbort: abort => stop = abort });
  while (!resolving) await new Promise(resolve => setTimeout(resolve, 0));
  stop();
  release({ kind: 'http', model: 'test' });
  await assert.rejects(work, /aborted/);
  assert.equal(initialized, 0);
});


test('continuing a productive handoff resumes execution without rewriting or premature validation', async t => {
  const queue = fixture(t);
  const claimed = queue.claimNext();
  queue.update(claimed.id, { status: 'VERIFYING', output: 'Handler fixed; next check is the deployed form.' });
  const runner = orchestrator(queue, { './agents': agents() });
  runner.verifyWithExecutor = () => assert.fail('A continuation must not start validation');
  const snapshot = queue.get(claimed.id);
  await runner.applyProgressDecision(snapshot, { action: 'CONTINUE_EXECUTION', reason: 'Finish the remaining development check' }, {});
  assert.equal(queue.get(claimed.id).status, 'PENDING');
  assert.equal(queue.get(claimed.id).description, snapshot.description);
  assert.equal(queue.get(claimed.id).output, snapshot.output);
});


test('a live review cannot resume a worker that completed while the review was pending', async t => {
  const queue = fixture(t);
  const snapshot = queue.claimNext();
  queue.update(snapshot.id, { status: 'VERIFYING', output: 'Ready for verification' });
  const runner = orchestrator(queue, { './agents': agents() });
  await runner.applyProgressDecision(snapshot, { action: 'CONTINUE_EXECUTION', reason: 'Still working at snapshot time' }, {});
  assert.equal(queue.get(snapshot.id).status, 'VERIFYING');
  assert.equal(queue.get(snapshot.id).output, 'Ready for verification');
});


test('a three-task queue reaches completion after a verification retry without rerunning implementation', async t => {
  const queue = fixture(t);
  queue.addAll([{ title: 'Second task', description: 'Check second field.' },
    { title: 'Third task', description: 'Check third field.' }]);
  const module = agents();
  let executions = 0, verifications = 0, verdicts = 0, preliminaryReviews = 0;
  const run = async (_, __, role, prompt, opts) => {
    assert.ok(prompt.includes(notes), 'actual orchestrator forwards notes at every stage');
    let reply;
    if (prompt.startsWith('You are an execution agent.')) {
      executions++;
      reply = { report: 'Implementation ready', completion: {
        status: 'READY_FOR_VALIDATION', summary: 'Inspect the deployed form', filesChanged: [], developmentChecks: [],
      } };
    } else if (prompt.startsWith('You are the independent verification planner.')) {
      reply = verificationPlanReply('', true);
    } else if (prompt.startsWith('You are the independent verification')) {
      verifications++;
      reply = { validation: verifications === 1
        ? { ...report(), conclusion: 'INCOMPLETE', remaining: 'The hide transition was not checked' } : report() };
      reply.validation.checks = reply.validation.checks.map(check => ({ ...check, stepId: 'states' }));
    } else if (prompt.startsWith('You supervise a coding agent')) {
      preliminaryReviews++;
      reply = { action: 'START_VALIDATION', reason: 'Implementation ready' };
    } else {
      verdicts++;
      reply = verdicts === 1 ? { verdict: 'REVERIFY', feedback: 'Run the missing hide transition at the supplied URL' }
        : { verdict: 'VERIFIED', feedback: 'All requested checks passed' };
    }
    return { text: JSON.stringify(reply), stopReason: 'end_turn', usage };
  };
  module.setTestRunner(run);
  const deps = { ...verificationDependencies(), './agents': { ...module, runOnce: run }, './validation': validation,
    './prompts': prompts, './cognition': cognition };
  const monitor = load('src/queue/monitor.ts', deps);
  const verifier = load('src/queue/verification.ts', deps);
  const runner = orchestrator(queue, { './agents': module, './monitor': monitor, './verification': verifier });
  runner.finish = () => queue.setRunState('IDLE');
  await runner.pump();
  for (let i = 0; i < 10 && !queue.isComplete(); i++) {
    await runner.tick();
    // pump starts asynchronously at the end of a tick.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(queue.isComplete(), true);
  assert.ok(queue.list().every(row => row.status === 'VERIFIED'));
  assert.equal(executions, 3, 'verification retry does not rerun implementation');
  assert.equal(verifications, 4, 'only the missing verification is repeated');
  assert.equal(verdicts, 1, 'only the unsuccessful report needs a supervisor decision');
  assert.equal(preliminaryReviews, 0, 'a normal ready handoff goes directly to independent verification, still followed by a verdict');
  assert.ok(queue.list().every(row => row.output.includes('Implementation ready')), 'keep executor handoffs');
  assert.equal(queue.countEvents(queue.list()[0].id, 'task-edited'), 0);
});


test('handoffs wake supervision immediately while stopped queues stay stopped', async t => {
  const queue = fixture(t);
  const runner = orchestrator(queue, {});
  delete runner.wakeAfterHandoff;
  let ticks = 0;
  runner.tick = async () => { ticks++; };
  runner.wakeAfterHandoff();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ticks, 1);
  queue.setRunState('STOPPED');
  runner.wakeAfterHandoff();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ticks, 1);
});


test('streamed prose and tool-start announcements cannot evict completed source evidence', t => {
  const queue = fixture(t);
  const current = queue.claimNext();
  queue.log(current.id, 'executor', 'tool', 'read_file({"path":"src/handler.go"}) → ok\nActual source content');
  for (let i = 0; i < 200; i++) {
    queue.log(current.id, 'executor', 'response', 'Earlier invocation failed; I will try again.');
    queue.log(current.id, 'executor', 'reasoning', 'Inspecting the same thing.');
    queue.log(current.id, 'executor', 'tool', 'read_file() → start');
    queue.log(current.id, 'executor', 'cognition', `snapshot ${i}`);
  }
  const events = queue.events(current.id, 40, true);
  assert.ok(events.some(event => event.message.includes('Actual source content')));
  assert.equal(events.filter(event => event.kind === 'cognition').length, 1);
  assert.ok(!events.some(event => ['response', 'reasoning'].includes(event.kind)));
});



test('fixed testing target requires an explicit scope comparison and rejects a contradictory continue decision', async () => {
 const url='https://application.example.test/project/';let calls=0;
 const module=agents();
 const monitor=load('src/queue/monitor.ts', {
  './agents': {...module,runOnce:async(...args)=>{calls++;if(calls===2){assert.equal(args[4].formatOnly,true);assert.equal(args[4].maxIterations,1)}return {text:JSON.stringify({action:'CONTINUE_EXECUTION',reason:'Same host',targetCheck:{configuredUrl:url,requiredWork:'Authenticate and test the supplied app',observedWork:'Copied demonstration page',preservesOwnerScope:false}}),usage}}},
  './validation':validation,'./prompts':prompts,'./cognition':cognition,
 });
 await assert.rejects(monitor.reviewProgress({},output,task,[],0,{projectNotes:notes,testingUrl:url},goal),/no readable decision/);
 assert.equal(calls,2);
});



test('one progress decision checks the current task against owner requirements', async () => {
 let calls = 0;
 const monitor = load('src/queue/monitor.ts', {
  './agents': {...agents(), runOnce: async (_, __, ___, prompt) => {
   calls++; assert.match(prompt, /You supervise a coding agent/); assert.ok(prompt.includes(notes));
   return {text: JSON.stringify({action:'STOP_AND_REWRITE_TASK', reason:'Use the supplied application.',
    rewrittenDescription:'Authenticate and inspect the actual form.', solutionVerifyCommand:''}), usage};
  }}, './validation':validation, './prompts':prompts, './cognition':cognition,
 });
 const result = await monitor.reviewProgress({}, output, task, [], 0, {ownerInstructions:notes}, goal);
 assert.equal(calls, 1); assert.equal(result.action, 'STOP_AND_REWRITE_TASK');
 assert.match(result.rewrittenDescription, /actual form/);
});

test('progress uses a fresh journal without a preliminary requirements model turn', async () => {
 let refreshed = false;
 const monitor=load('src/queue/monitor.ts', {
  './agents':{...agents(),runOnce:async(_,__,___,prompt)=>{
   assert.ok(refreshed);assert.match(prompt,/new successful build/);
   return {text:JSON.stringify({action:'START_VALIDATION',reason:'Fresh build supports verification.'}),usage};
  }}, './requirements':{reviewTaskRequirements:()=>assert.fail('No nested requirements review')},
  './validation':validation,'./prompts':prompts,'./cognition':cognition,
 });
 await monitor.reviewProgress({},output,task,[],0,{ownerInstructions:notes,refreshProgress:()=>{
  refreshed=true;
  return {task,events:[{id:1,at:Date.now(),actor:'executor',kind:'tool',message:'new successful build'}],failedValidations:0};
 }},goal);
});

test('an incomplete requirements correction gets one repair with owner constraints retained', async () => {
 let calls=0;
 const complete={compatible:false,reason:'A fixture substitutes for the actual application.',description:task.description,implVerifyPrompt:task.implVerifyPrompt,solutionVerifyPrompt:task.solutionVerifyPrompt,solutionVerifyCommand:''};
 const requirements=load('src/queue/requirements.ts',{'./agents':{...agents(),runOnce:async(_context,_output,_role,prompt,opts)=>{
  calls++;assert.equal(opts.formatOnly,true);assert.ok(prompt.includes(notes));
  if(calls===1){const incomplete={...complete};delete incomplete.solutionVerifyPrompt;return {text:JSON.stringify(incomplete),usage};}
  assert.match(prompt,/Validation error: Requirements review needs a complete corrected solutionVerifyPrompt/);
  return {text:JSON.stringify(complete),usage};
 }}});
 const result=await requirements.reviewTaskRequirements({},output,task,goal,notes,{});
 assert.equal(calls,2);assert.equal(result.correction.action,'STOP_AND_REWRITE_TASK');assert.equal(result.correction.solutionVerifyPrompt,task.solutionVerifyPrompt);assert.equal(result.usage.input,2);
});


test('an incomplete rewrite can never fall through to verification of the rejected contract', async t=>{
 const queue=fixture(t);const current=queue.claimNext();queue.update(current.id,{status:'VERIFYING'});
 const runner=orchestrator(queue,{});let verified=false;runner.verifyWithExecutor=async()=>{verified=true};
 for(const action of ['STOP_AND_REWRITE_TASK','STOP_AND_REWRITE_VALIDATION']) await assert.rejects(runner.applyProgressDecision(queue.get(current.id),{action,reason:'Wrong approach',usage},{}),/requested.*rewrite/);
 assert.equal(verified,false);assert.equal(queue.get(current.id).status,'VERIFYING');
});
