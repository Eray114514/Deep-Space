// Actual bounded preparation queue with CPU frame/RAF doubles. No renderer,
// native completion, shader readiness or player-performance claim is made.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {GpuPreparationQueue} from '../src/gpu-preparation-queue.js';

const files=['src/gpu-preparation-queue.js','tools/gpupreparationqueuetest.js'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozen=new Map(await Promise.all(files.map(async path=>[path,await readFile(path)])));
const out=`test-results/gpu-preparation-queue/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[],fixtures=[];
const microtasks=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const observe=promise=>{const state={status:'pending'};promise.then(value=>{state.status='resolved';state.value=value;},error=>{state.status='rejected';state.error=error;});return state;};
async function test(name,work) {
  const before=fixtures.length;
  try {await work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),stack:error?.stack});}
  finally {for(const f of fixtures.slice(before))f.queue.dispose();await microtasks();}
}
function fixture(options={}) {
  const listeners=new Map(),scheduled=new Map(),callbacks=[],events=[];let next=0,submits=0,busy=false,submitError,throws=false,scopeError,scopeFailed=false;
  const forbidden=()=>assert.fail('The preparation queue cannot query, poll or synchronize native GL');
  const renderer={getContext:forbidden,domElement:{
    addEventListener(name,work){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(work);},
    removeEventListener(name,work){listeners.get(name)?.delete(work);},
  }};
  const draw=options=>{events.push(['draw',options]);return true;};let queue;
  const driver={
    schedule(work){const id=++next;callbacks.push(work);scheduled.set(id,work);return id;},
    cancel(id){scheduled.delete(id);},
    submit(){submits++;if(throws)throw submitError;if(busy)return false;
      const ticket=queue.runNext(draw);events.push(['scope-end']);queue.finish(ticket,{failed:scopeFailed,error:scopeError});return true;},
    ...options,
  };
  queue=new GpuPreparationQueue(renderer,driver);
  const f={queue,renderer,events,draw,driver,scheduled,callbacks,
    get submits(){return submits;},set busy(value){busy=value;},
    setSubmitError(error){throws=true;submitError=error;},setScopeError(error){scopeFailed=true;scopeError=error;},
    tick(){const batch=[...scheduled];scheduled.clear();for(const [,work] of batch)work();},
    emit(name){for(const work of [...(listeners.get(name)||[])])work();},
    get listeners(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);},
    run(){const ticket=queue.runNext(draw);queue.finish(ticket);return ticket;},
  };fixtures.push(f);return f;
}

await test('jobs are deferred, FIFO, one per synchronous scope and forwarded the exact draw capability',async()=>{
  const f=fixture(),calls=[],a=observe(f.queue.enqueue(draw=>{assert.equal(draw,f.draw);draw({private:true});calls.push('a');return 7;})),
    b=observe(f.queue.enqueue(()=>{calls.push('b');return 8;}));
  assert.deepEqual(calls,[]);assert.equal(f.scheduled.size,1);assert.equal(f.queue.hasQueued,true);
  f.tick();await microtasks();assert.deepEqual(calls,['a']);assert.equal(a.value,7);assert.equal(b.status,'pending');
  f.tick();await microtasks();assert.deepEqual(calls,['a','b']);assert.equal(b.value,8);assert.equal(f.queue.snapshot().pending,0);
  assert.equal(f.queue.hasQueued,false);assert.equal(f.scheduled.size,0);
});
await test('result readiness never holds the submission scope or blocks the next queued job',async()=>{
  const f=fixture(),ready=deferred(),a=observe(f.queue.enqueue(()=>ready.promise)),b=observe(f.queue.enqueue(()=>2));
  f.tick();await microtasks();assert.equal(a.status,'pending');assert.equal(f.queue.snapshot().active,false);
  assert.equal(f.queue.snapshot().waiting,1);f.tick();await microtasks();assert.equal(b.value,2);
  ready.resolve(1);await microtasks();assert.equal(a.value,1);
});
await test('a job cannot resolve until the enclosing target restoration and completion scope finishes',async()=>{
  const f=fixture(),state=observe(f.queue.enqueue(()=>42)),ticket=f.queue.runNext(f.draw);
  await microtasks();assert.equal(state.status,'pending');assert.equal(f.queue.snapshot().active,true);
  f.queue.finish(ticket);await microtasks();assert.equal(state.value,42);assert.equal(f.queue.snapshot().active,false);
});
await test('wrong or repeated finish cannot end a different active scope',async()=>{
  const f=fixture(),a=observe(f.queue.enqueue(()=>1)),first=f.queue.runNext(f.draw);
  f.queue.finish({});assert.equal(f.queue.snapshot().active,true);f.queue.finish(first);await microtasks();assert.equal(a.value,1);
  const b=observe(f.queue.enqueue(()=>2)),second=f.queue.runNext(f.draw);f.queue.finish(first);
  assert.equal(f.queue.snapshot().active,true);f.queue.finish(second);await microtasks();assert.equal(b.value,2);
});
await test('foreground attempts make the pump yield and foreground draining cancels unnecessary maintenance RAFs',async()=>{
  const f=fixture(),state=observe(f.queue.enqueue(()=>5));
  f.queue.noteForeground();f.tick();assert.equal(f.submits,0);assert.equal(f.queue.snapshot().stats.yielded,1);
  f.queue.noteForeground();f.run();await microtasks();assert.equal(state.value,5);assert.equal(f.submits,0);assert.equal(f.scheduled.size,0);
});
await test('when foreground frames stop, a single later maintenance opportunity can make progress',async()=>{
  const f=fixture(),state=observe(f.queue.enqueue(()=>5));f.queue.noteForeground();f.tick();assert.equal(state.status,'pending');
  f.tick();await microtasks();assert.equal(state.value,5);assert.equal(f.submits,1);
});
await test('busy maintenance never invokes preparation and retries on a later RAF without spinning',async()=>{
  const f=fixture();let work=0;f.busy=true;const state=observe(f.queue.enqueue(()=>++work));
  for(let i=0;i<4;i++){f.tick();assert.equal(work,0);assert.equal(f.scheduled.size,1);}
  assert.equal(f.submits,4);assert.equal(state.status,'pending');f.busy=false;f.tick();await microtasks();assert.equal(state.value,1);
});
await test('queued and submitted-but-not-ready jobs share the capacity bound',async()=>{
  const f=fixture({maxPending:1}),ready=deferred(),state=observe(f.queue.enqueue(()=>ready.promise));f.run();
  const rejected=observe(f.queue.enqueue(()=>assert.fail('Overflow cannot execute')));await microtasks();assert.equal(rejected.error.code,'capacity');
  assert.equal(state.status,'pending');assert.equal(f.queue.snapshot().pending,1);ready.resolve();await microtasks();
  const next=observe(f.queue.enqueue(()=>9));f.run();await microtasks();assert.equal(next.value,9);assert.equal(f.queue.snapshot().stats.overflow,1);
});
await test('queued abort removes work and its scheduled callback before any lease is borrowed',async()=>{
  const f=fixture(),abort=new AbortController(),state=observe(f.queue.enqueue(()=>assert.fail('Aborted work executed'),{signal:abort.signal}));
  const stale=f.callbacks[0];abort.abort();await microtasks();assert.equal(state.error.code,'aborted');assert.equal(f.scheduled.size,0);
  stale();assert.equal(f.submits,0);assert.equal(f.queue.hasQueued,false);
});
await test('already aborted signals do not enter the queue driver',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();const state=observe(f.queue.enqueue(()=>assert.fail('Already aborted'),{signal:abort.signal}));
  await microtasks();assert.equal(state.error.code,'aborted');assert.equal(f.submits,0);assert.equal(f.scheduled.size,0);
});
await test('cancelled active results consume late rejects without ending or publishing a GPU scope',async()=>{
  const f=fixture(),abort=new AbortController(),ready=deferred(),state=observe(f.queue.enqueue(()=>{abort.abort();return ready.promise;},{signal:abort.signal}));
  const ticket=f.queue.runNext(f.draw);assert.equal(f.queue.snapshot().active,true);assert.equal(f.queue.runNext(f.draw),null);
  ready.reject(Error('late compiler error'));await microtasks();assert.equal(state.error.code,'aborted');assert.equal(f.queue.snapshot().active,true);
  f.queue.finish(ticket);assert.equal(f.queue.snapshot().active,false);assert.equal(f.queue.snapshot().stats.resolved,0);
});
await test('cancellation after submission cannot resurrect success or pin the capacity',async()=>{
  const f=fixture({maxPending:1}),abort=new AbortController(),ready=deferred(),state=observe(f.queue.enqueue(()=>ready.promise,{signal:abort.signal}));
  f.run();abort.abort();ready.resolve(99);await microtasks();assert.equal(state.error.code,'aborted');assert.equal(f.queue.snapshot().pending,0);
  const next=observe(f.queue.enqueue(()=>1));f.run();await microtasks();assert.equal(next.value,1);
});
await test('changed sources are rejected at execution while later valid FIFO work can still run',async()=>{
  const f=fixture();let current=true,work=0;
  const a=observe(f.queue.enqueue(()=>assert.fail('Obsolete source'),{isCurrent:()=>current})),b=observe(f.queue.enqueue(()=>++work));
  current=false;f.run();await microtasks();assert.equal(a.error.code,'obsolete');assert.equal(b.value,1);assert.equal(work,1);
});
await test('readiness success revalidates the source instead of publishing an old compilation',async()=>{
  const f=fixture(),ready=deferred();let current=true;
  const state=observe(f.queue.enqueue(()=>ready.promise,{isCurrent:()=>current}));f.run();current=false;ready.resolve();await microtasks();
  assert.equal(state.error.code,'obsolete');assert.equal(f.queue.snapshot().stats.resolved,0);
});
await test('scope completion revalidates synchronous work after callbacks change its source',async()=>{
  const f=fixture();let current=true;const state=observe(f.queue.enqueue(()=>4,{isCurrent:()=>current})),ticket=f.queue.runNext(f.draw);
  current=false;f.queue.finish(ticket);await microtasks();assert.equal(state.error.code,'obsolete');
});
await test('a synchronous source switch rejects pending compiler readiness at scope release rather than at its deadline',async()=>{
  const f=fixture({maxPending:1}),ready=deferred();let current=true;
  const state=observe(f.queue.enqueue(()=>{current=false;return ready.promise;},{isCurrent:()=>current})),ticket=f.queue.runNext(f.draw);
  f.queue.finish(ticket);await microtasks();assert.equal(state.status,'rejected');assert.equal(state.error.code,'obsolete');
  assert.equal(f.queue.snapshot().pending,0);const next=observe(f.queue.enqueue(()=>7));f.run();await microtasks();assert.equal(next.value,7);
  ready.reject(Error('obsolete compiler completion'));await microtasks();assert.equal(state.error.code,'obsolete');
});
for(const error of [Error('submit'),null,undefined,false,0,''])await test(`work failure retains its original ${String(error)} without throwing through the frame`,async()=>{
  const f=fixture(),state=observe(f.queue.enqueue(()=>{throw error;}));const ticket=f.queue.runNext(f.draw);
  assert.ok(ticket);assert.equal(state.status,'pending');f.queue.finish(ticket);await microtasks();assert.equal(state.status,'rejected');assert.equal(state.error,error);
  const next=observe(f.queue.enqueue(()=>3));f.run();await microtasks();assert.equal(next.value,3);
});
for(const error of [Error('frame-end'),null,undefined,false,0,''])await test(`scope finalization failure prevents readiness success with ${String(error)}`,async()=>{
  const f=fixture(),ready=deferred(),state=observe(f.queue.enqueue(()=>ready.promise)),ticket=f.queue.runNext(f.draw);
  f.queue.finish(ticket,{failed:true,error});ready.resolve(5);await microtasks();assert.equal(state.status,'rejected');assert.equal(state.error,error);
});
await test('the original work exception wins over a later unrelated scope failure',async()=>{
  const f=fixture(),state=observe(f.queue.enqueue(()=>{throw null;})),ticket=f.queue.runNext(f.draw);
  f.queue.finish(ticket,{failed:true,error:Error('frame')});await microtasks();assert.equal(state.error,null);
});
await test('a throwing then getter is a consumed readiness rejection',async()=>{
  const f=fixture(),value=Object.defineProperty({},'then',{get(){throw null;}}),state=observe(f.queue.enqueue(()=>value));
  f.run();await microtasks();assert.equal(state.status,'rejected');assert.equal(state.error,null);
});
await test('a throwing validity predicate rejects only its own job and does not borrow state',async()=>{
  const f=fixture();let shouldThrow=false;const error=Error('validity'),state=observe(f.queue.enqueue(()=>assert.fail('Invalid predicate work'),
    {isCurrent:()=>{if(shouldThrow)throw error;return true;}}));shouldThrow=true;f.run();await microtasks();assert.equal(state.error,error);
});
await test('invalid validity values and invalid jobs fail explicitly',async()=>{
  const f=fixture(),a=observe(f.queue.enqueue(()=>1,{isCurrent:()=>undefined})),b=observe(f.queue.enqueue(null)),c=observe(f.queue.enqueue(()=>1,{isCurrent:7}));
  await microtasks();for(const state of [a,b,c])assert.ok(state.error instanceof TypeError);assert.equal(f.submits,0);assert.equal(f.queue.hasQueued,false);
});
await test('work-enqueued jobs and nested drains cannot extend the current scope',async()=>{
  const f=fixture(),calls=[];let second;
  const first=observe(f.queue.enqueue(()=>{calls.push('a');second=observe(f.queue.enqueue(()=>calls.push('b')));assert.equal(f.queue.runNext(f.draw),null);}));
  f.run();await microtasks();assert.equal(first.status,'resolved');assert.deepEqual(calls,['a']);f.run();await microtasks();assert.equal(second.status,'resolved');assert.deepEqual(calls,['a','b']);
});
await test('a predicate cannot reenter a drain during enqueue or execution validation',async()=>{
  const f=fixture();let current=true,work=0;
  const state=observe(f.queue.enqueue(()=>++work,{isCurrent:()=>{assert.equal(f.queue.runNext(f.draw),null);return current;}}));
  assert.equal(work,0);current=false;assert.equal(f.queue.runNext(f.draw),null);await microtasks();assert.equal(state.error.code,'obsolete');assert.equal(work,0);
});
await test('predicate-enqueued replacements wait for another scope even when they cancel the rest of the original FIFO',async()=>{
  const f=fixture(),abort=new AbortController();let executing=false,newState,work=0;
  const a=observe(f.queue.enqueue(()=>assert.fail('Old source'),{isCurrent:()=>{
    if(executing){abort.abort();newState=observe(f.queue.enqueue(()=>++work));return false;}return true;
  }})),b=observe(f.queue.enqueue(()=>assert.fail('Cancelled source'),{signal:abort.signal}));
  executing=true;assert.equal(f.queue.runNext(f.draw),null);await microtasks();
  assert.equal(a.error.code,'obsolete');assert.equal(b.error.code,'aborted');assert.equal(work,0);assert.equal(newState.status,'pending');
  f.run();await microtasks();assert.equal(newState.value,1);
});
await test('context loss rejects queued and readiness work, leaves old scope held, and restores a fresh epoch',async()=>{
  const f=fixture(),ready=deferred(),a=observe(f.queue.enqueue(()=>ready.promise)),ticket=f.queue.runNext(f.draw),b=observe(f.queue.enqueue(()=>assert.fail('Old queued')));
  f.emit('webglcontextlost');await microtasks();assert.equal(a.error.code,'context-lost');assert.equal(b.error.code,'context-lost');assert.equal(f.queue.snapshot().active,true);
  const lost=observe(f.queue.enqueue(()=>assert.fail('Lost')));await microtasks();assert.equal(lost.error.code,'context-lost');
  f.emit('webglcontextrestored');const current=observe(f.queue.enqueue(()=>7));assert.equal(f.queue.runNext(f.draw),null);
  f.queue.finish(ticket);ready.resolve(77);f.run();await microtasks();assert.equal(current.value,7);assert.equal(a.status,'rejected');
});
await test('unexpected restoration also invalidates in-flight identities',async()=>{
  const f=fixture(),ready=deferred(),state=observe(f.queue.enqueue(()=>ready.promise));f.run();f.emit('webglcontextrestored');ready.resolve(3);
  await microtasks();assert.equal(state.error.code,'context-restored');assert.equal(f.queue.snapshot().epoch,1);
});
await test('dispose permanently rejects all work, removes listeners and makes stale RAFs harmless',async()=>{
  const f=fixture(),state=observe(f.queue.enqueue(()=>assert.fail('Disposed'))),stale=f.callbacks[0];f.queue.dispose();f.queue.dispose();
  stale();f.emit('webglcontextrestored');const later=observe(f.queue.enqueue(()=>1));await microtasks();
  assert.equal(state.error.code,'disposed');assert.equal(later.error.code,'disposed');assert.equal(f.listeners,0);assert.equal(f.submits,0);assert.equal(f.scheduled.size,0);
});
await test('submission errors fail waiting work without native access and future explicit jobs can recover',async()=>{
  const error=Error('admission'),f=fixture();f.setSubmitError(error);const a=observe(f.queue.enqueue(()=>assert.fail('Cannot submit')));f.tick();await microtasks();
  assert.equal(a.error,error);assert.equal(f.queue.snapshot().pending,0);assert.equal(f.queue.snapshot().fault,'submission-failed');
  const b=observe(f.queue.enqueue(()=>9));f.run();await microtasks();assert.equal(b.value,9);
});
await test('explicit fail preserves a falsy failure and consumes late readiness',async()=>{
  const f=fixture(),ready=deferred(),a=observe(f.queue.enqueue(()=>ready.promise));f.run();const b=observe(f.queue.enqueue(()=>1));
  f.queue.fail(undefined);ready.reject(Error('late'));await microtasks();assert.equal(a.status,'rejected');assert.equal(a.error,undefined);assert.equal(b.error,undefined);
});
await test('scheduler exceptions cannot strand a returned promise',async()=>{
  const error=Error('schedule'),f=fixture({schedule(){throw error;}}),state=observe(f.queue.enqueue(()=>assert.fail('Scheduler failed')));
  await microtasks();assert.equal(state.error,error);assert.equal(f.queue.snapshot().pending,0);assert.equal(f.queue.snapshot().fault,'scheduler-failed');
});
await test('a synchronous scheduler is rejected rather than recursively pumping',async()=>{
  const f=fixture({schedule(work){work();return 4;}}),state=observe(f.queue.enqueue(()=>assert.fail('Synchronous scheduler')));
  await microtasks();assert.equal(state.error.code,'scheduler-synchronous');assert.equal(f.submits,0);assert.equal(f.queue.snapshot().pending,0);
});
await test('a throwing cancel callback cannot hide job cancellation or resurrect its stale pump',async()=>{
  const f=fixture({cancel(){throw Error('cancel callback');}}),abort=new AbortController(),state=observe(f.queue.enqueue(()=>assert.fail('Cancelled'),{signal:abort.signal}));
  const stale=f.callbacks[0];abort.abort();stale();await microtasks();assert.equal(state.error.code,'aborted');assert.equal(f.queue.snapshot().fault,'scheduler-cancel-failed');assert.equal(f.submits,0);
});
await test('snapshot performs no scheduler, callback, predicate or native operations',async()=>{
  const f=fixture();let predicates=0;observe(f.queue.enqueue(()=>1,{isCurrent:()=>{predicates++;return true;}}));
  const before=predicates,scheduled=f.scheduled.size;for(let i=0;i<10;i++)f.queue.snapshot();
  assert.equal(predicates,before);assert.equal(f.scheduled.size,scheduled);assert.equal(f.submits,0);
});

const sources=[];
for(const [path,bytes] of frozen){const after=await readFile(path);sources.push({path,bytes:bytes.length,sha256:sha(bytes),stable:sha(bytes)===sha(after)});}
const result={kind:'cpu-contracts',scope:'Actual preparation queue, synchronous submission/RAF doubles; no GPU or performance acceptance',
  passed:cases.filter(c=>c.passed).length,total:cases.length,sources,cases};
await writeFile(`${out}/report.json`,`${JSON.stringify(result,null,2)}\n`);
console.log(JSON.stringify({out,passed:result.passed,total:result.total,failures:cases.filter(c=>!c.passed)},null,2));
assert.ok(sources.every(s=>s.stable),'Preparation queue inputs changed during execution');assert.equal(result.passed,result.total);
