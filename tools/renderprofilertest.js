import assert from 'node:assert/strict';
import { RenderProfiler } from '../src/render-profiler.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';

let clock=0,current=null,available=false,disjoint=false,lost=false,reads=0,deletes=0,begins=0;
const ext={TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2},events=new Map();
const gl={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,
  getExtension:()=>ext,isContextLost:()=>lost,getParameter:()=>disjoint,
  getQuery:()=>current,createQuery:()=>({}),
  beginQuery:(_target,q)=>{assert.equal(current,null);current=q;begins++;},
  endQuery:()=>{current=null;},deleteQuery:()=>{deletes++;},
  getQueryParameter:(_q,kind)=>{
    if(kind===4)return available;
    assert.equal(available,true,'Result reads must never wait on an unavailable query');reads++;return 2500000;
  }};
const renderer={getContext:()=>gl,domElement:{
  addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)}};
const p=new RenderProfiler(renderer,{every:1,maxPending:2,history:10,now:()=>clock});
p.beginFrame();assert.equal(p.run('opaque',()=>{clock+=4;return 7;}),7);
p.run('air',()=>{clock+=1;});p.run('overflow',()=>{});
assert.equal(begins,2);assert.equal(p.snapshot().pending,2);assert.equal(reads,0);
available=true;
assert.equal(p.snapshot().records[0].gpuMs,2.5);assert.equal(deletes,2);
assert.equal(p.snapshot().records[0].cpuMs,4);
current={external:true};p.beginFrame();p.run('external-owner',()=>{clock++;});
assert.equal(begins,2);assert.deepEqual(current,{external:true});current=null;
available=false;p.run('new',()=>{});disjoint=true;p.poll();
assert.equal(p.pending.length,0);assert.equal(p.discarded,1);assert.equal(reads,2);
disjoint=false;p.run('lost',()=>{});lost=true;events.get('webglcontextlost')();
assert.equal(p.pending.length,0);assert.equal(p.discarded,2);
lost=false;events.get('webglcontextrestored')();p.beginFrame();p.run('restored',()=>{});
assert.throws(()=>p.run('exception',()=>{throw Error('draw');}),/draw/);
assert.equal(current,null,'Throwing draw must release its timer scope');
p.dispose();assert.equal(events.size,0);assert.equal(p.pending.length,0);
const before=begins;p.run('disposed',()=>{});assert.equal(begins,before);

function fixture({supported=true,every=1}={}) {
  let time=0,query=null,started=0,ended=0,contextLost=false,loseAfterEnd=false;
  let epoch=0,restoreAfterEnd=false,available=false,readAction=null;
  const calls=[],listeners=new Map();
  const lose=()=>{contextLost=true;epoch++;query=null;listeners.get('webglcontextlost')?.();};
  const restore=()=>{contextLost=false;listeners.get('webglcontextrestored')?.();};
  const valid=q=>assert.equal(q.epoch,epoch,'Never touch a query from an earlier native context');
  const context={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,
    getExtension:()=>supported?ext:null,isContextLost:()=>contextLost,getParameter:()=>false,
    getQuery:()=>{calls.push('getQuery');return query;},
    createQuery:()=>{calls.push('createQuery');return {epoch};},
    beginQuery:(_target,q)=>{calls.push('beginQuery');assert.equal(query,null);query=q;started++;},
    endQuery:()=>{
      assert.equal(contextLost,false);calls.push('endQuery');assert.ok(query);valid(query);query=null;ended++;
      if(loseAfterEnd){lose();if(restoreAfterEnd)restore();}
    },
    deleteQuery:q=>{assert.equal(contextLost,false,'Never delete queries after context loss');valid(q);calls.push('deleteQuery');},
    getQueryParameter:(q,kind)=>{
      assert.equal(contextLost,false);valid(q);calls.push(kind===4?'available':'result');
      const action=readAction;if(action?.kind===kind){readAction=null;action.work();}
      return kind===4?available:2500000;
    }};
  const profiler=new RenderProfiler({getContext:()=>context,domElement:{
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}},
  {every,maxPending:16,now:()=>time});
  profiler.beginFrame();
  return {p:profiler,calls,advance(ms){time+=ms;},get query(){return query;},set query(value){query=value;},
    lose,restore,setAvailable(value){available=value;},
    onRead(kind,work){readAction={kind,work};},
    loseOnEnd({restore=false}={}){loseAfterEnd=true;restoreAfterEnd=restore;},
    get started(){return started;},get ended(){return ended;},get listenerCount(){return listeners.size;}};
}

const f=fixture(),skipped=f.p.skipped;
assert.equal(f.p.run('cpu-only',()=>{assert.equal(f.p.active,false);f.advance(2);return 11;},{gpu:false}),11);
assert.deepEqual(f.calls,[],'CPU-only scopes must not query or alter the GPU timer owner');
assert.equal(f.p.skipped,skipped);assert.equal(f.p.active,false);
assert.deepEqual(f.p.records[0],{frame:1,name:'cpu-only',cpuMs:2,gpuMs:null,scope:'cpu',cpuInclusive:true});
f.p.run('inclusive-parent',()=>{
  f.advance(1);
  f.p.run('first-draw',()=>f.advance(2));
  f.p.run('cpu-child',()=>f.p.run('second-draw',()=>f.advance(3)),{gpu:false});
  f.advance(4);
},{gpu:false});
assert.deepEqual(f.p.records.slice(1).map(row=>[row.name,row.scope,row.cpuMs]),[
  ['inclusive-parent','cpu',10],['first-draw','gpu',2],['cpu-child','cpu',3],['second-draw','gpu',3]]);
assert.equal(f.started,2);assert.equal(f.ended,2);assert.equal(f.p.skipped,0);
assert.equal(f.p.records.find(row=>row.name==='inclusive-parent').gpuMs,null);
assert.equal(f.p.active,false);f.p.dispose();

const nested=fixture();
nested.p.run('gpu-parent',()=>{
  assert.equal(nested.p.active,true);
  nested.p.run('cpu-child-blocked',()=>nested.p.run('gpu-grandchild-blocked',()=>nested.advance(1)),{gpu:false});
  assert.equal(nested.p.active,true,'A CPU child must not clear its GPU ancestor ownership');
});
assert.deepEqual(nested.p.records.map(row=>row.name),['gpu-parent']);
assert.equal(nested.started,1);assert.equal(nested.ended,1);nested.p.dispose();

const failure=fixture();
assert.throws(()=>failure.p.run('cpu-parent-throws',()=>{
  failure.p.run('throwing-draw',()=>{failure.advance(3);throw Error('child draw');});
},{gpu:false}),/child draw/);
assert.equal(failure.p.active,false);assert.equal(failure.query,null);
assert.equal(failure.started,1);assert.equal(failure.ended,1);
assert.equal(failure.p.records[0].cpuMs,3);assert.equal(failure.p.records[0].gpuMs,null);
const queryCalls=failure.calls.length;
assert.throws(()=>failure.p.run('cpu-only-throws',()=>{throw Error('CPU');},{gpu:false}),/CPU/);
assert.equal(failure.calls.length,queryCalls);assert.equal(failure.p.active,false);failure.p.dispose();

const external=fixture(),owner={external:true};external.query=owner;
external.p.run('cpu-under-external',()=>external.p.run('draw-under-external',()=>{}),{gpu:false});
assert.equal(external.query,owner);assert.equal(external.started,0);assert.equal(external.ended,0);
assert.equal(external.p.skipped,1,'Only the GPU child counts an unavailable timer');
assert.deepEqual(external.calls,['getQuery']);external.query=null;external.p.dispose();

const unsupported=fixture({supported:false});
unsupported.p.run('cpu-without-extension',()=>unsupported.p.run('draw-without-extension',()=>{}),{gpu:false});
assert.equal(unsupported.p.skipped,1);assert.deepEqual(unsupported.calls,[]);unsupported.p.dispose();
const unsampled=fixture({every:2});
unsampled.p.run('unsampled-parent',()=>unsampled.p.run('unsampled-draw',()=>{}),{gpu:false});
assert.deepEqual(unsampled.p.records,[]);assert.deepEqual(unsampled.calls,[]);unsampled.p.dispose();

// Reproduce synchronous stop/dispose inside a running query. The owner is
// already retired when finally ends the active query, so nobody will poll a
// newly appended pending record. It must instead release that query directly.
for(const throws of [false,true])for(const losesContext of [false,true]) {
  const retired=fixture();retired.p.run('earlier-pending',()=>{});
  const disposeInsideDraw=()=>retired.p.run('inclusive-retiring-parent',()=>retired.p.run('retiring-draw',()=>{
    retired.advance(3);if(losesContext)retired.lose();retired.p.dispose();
    if(throws)throw Error('dispose during draw');return 23;
  }),{gpu:false});
  if(throws)assert.throws(disposeInsideDraw,/dispose during draw/);
  else assert.equal(disposeInsideDraw(),23);
  assert.equal(retired.p.disposed,true);assert.equal(retired.p.active,false);assert.equal(retired.query,null);
  assert.equal(retired.p.pending.length,0,'A disposed profiler must never acquire another pending query');
  assert.equal(retired.started,2);assert.equal(retired.ended,losesContext?1:2);
  assert.equal(retired.calls.filter(call=>call==='deleteQuery').length,losesContext?0:2,
    'Release both old pending and newly ended queries only while the context is live');
  if(!losesContext)assert.deepEqual(retired.calls.slice(-2),['endQuery','deleteQuery'],
    'Finish the owned interval before deleting it');
  const count=retired.calls.length;retired.p.dispose();retired.p.run('already-retired',()=>{});
  assert.equal(retired.calls.length,count,'Repeated disposal and later work must not touch query ownership');
}
const lossAtEnd=fixture();
lossAtEnd.p.run('retire-before-loss-in-end',()=>{lossAtEnd.p.dispose();lossAtEnd.loseOnEnd();});
assert.equal(lossAtEnd.ended,1);assert.equal(lossAtEnd.p.pending.length,0);
assert.equal(lossAtEnd.calls.includes('deleteQuery'),false,'Context loss while ending a retired query also forbids deletion');

// Keep the owner alive: loss from endQuery must not append the now-invalid
// handle after onLost has already drained pending. Include an immediate
// restoration, whose live context must not make the old handle valid again.
for(const restore of [false,true])for(const throws of [false,true]) {
  const live=fixture();live.p.run('older-pending',()=>{});
  const draw=()=>live.p.run('live-owner-loss-at-end',()=>{
    live.loseOnEnd({restore});if(throws)throw Error('draw loses context');return 31;
  });
  if(throws)assert.throws(draw,/draw loses context/);else assert.equal(draw(),31);
  assert.equal(live.ended,2);assert.equal(live.p.pending.length,0);assert.equal(live.p.discarded,2);
  assert.equal(live.calls.includes('deleteQuery'),false);assert.equal(live.p.active,false);
  if(!restore)live.restore();live.p.poll();assert.equal(live.p.pending.length,0);
  live.p.dispose();assert.equal(live.calls.includes('available'),false,'Restoration must not poll old handles');
}
for(const dispose of [false,true])for(const throws of [false,true]) {
  const roundtrip=fixture();
  const draw=()=>roundtrip.p.run('lose-restore-before-finally',()=>{
    roundtrip.lose();roundtrip.restore();if(dispose)roundtrip.p.dispose();
    if(throws)throw Error('restored draw');return 37;
  });
  if(throws)assert.throws(draw,/restored draw/);else assert.equal(draw(),37);
  assert.equal(roundtrip.ended,0,'A live replacement context cannot end the old context interval');
  assert.equal(roundtrip.p.pending.length,0);assert.equal(roundtrip.p.discarded,1);
  assert.equal(roundtrip.calls.includes('deleteQuery'),false);assert.equal(roundtrip.p.active,false);
  if(!dispose) {
    roundtrip.p.beginFrame();roundtrip.p.run('new-epoch',()=>{});roundtrip.setAvailable(true);roundtrip.p.poll();
    assert.equal(roundtrip.p.records.at(-1).gpuMs,2.5);assert.equal(roundtrip.ended,1);
  }
  roundtrip.p.dispose();
}
for(const restore of [false,true])for(const atEnd of [false,true]) {
  const retired=fixture();
  retired.p.run('dispose-before-context-change',()=>{
    retired.p.dispose();
    if(atEnd)retired.loseOnEnd({restore});
    else {retired.lose();if(restore)retired.restore();}
  });
  assert.equal(retired.p.pending.length,0);assert.equal(retired.p.active,false);
  assert.equal(retired.ended,atEnd?1:0);assert.equal(retired.p.discarded,1);
  assert.equal(retired.listenerCount,0,'Deferred context subscriptions must be released by the active scope finally');
  assert.equal(retired.calls.includes('deleteQuery'),false);
  const before=retired.calls.length;retired.p.poll();retired.p.run('retired',()=>{});
  assert.equal(retired.calls.length,before,'Finalized retired owners must perform no later GPU operations');
}
// Availability/result reads may be instrumented by diagnostics. Synchronous
// loss/restore or owner disposal there must not resurrect the detached list.
for(const kind of [4,5])for(const action of ['loss','roundtrip','dispose','dispose-roundtrip']) {
  const polling=fixture();polling.p.run('first',()=>{});polling.p.run('second',()=>{});polling.setAvailable(true);
  polling.onRead(kind,()=>{
    if(action.startsWith('dispose'))polling.p.dispose();
    if(action!=='dispose'){polling.lose();if(action!=='loss')polling.restore();}
  });
  polling.p.poll();assert.equal(polling.p.pending.length,0);assert.equal(polling.p.records.every(row=>row.gpuMs===null),true);
  assert.equal(polling.calls.filter(call=>call==='deleteQuery').length,action==='dispose'?2:0);
  if(action==='loss')polling.restore();polling.p.poll();polling.p.dispose();assert.equal(polling.listenerCount,0);
}

// GPU_DISJOINT_EXT is consumed by a read. Both timer owners must reject old
// queries even when only the first poll observes true from the native flag.
{
  let current=null,disjoint=false,available=false,reads=0,deletes=0,begins=0,ends=0;
  const listeners=new Map(),gl={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,
    getExtension:()=>ext,isContextLost:()=>false,getQuery:()=>current,
    getParameter:()=>{const value=disjoint;disjoint=false;return value;},
    createQuery:()=>({}),beginQuery:(_target,query)=>{assert.equal(current,null);current=query;begins++;},
    endQuery:()=>{assert.ok(current);current=null;ends++;},deleteQuery:()=>deletes++,
    getQueryParameter:(_query,kind)=>{if(kind===4)return available;reads++;return 2500000;}};
  const renderer={getContext:()=>gl,domElement:{
    addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)}};
  const a=new RenderProfiler(renderer,{every:1}),b=new RenderProfiler(renderer,{every:1});
  a.beginFrame();a.run('owner-a',()=>{});b.beginFrame();b.run('owner-b',()=>{});
  available=true;disjoint=true;a.poll();assert.equal(disjoint,false);b.poll();
  for(const owner of [a,b]) {
    assert.equal(owner.pending.length,0);assert.equal(owner.discarded,1);assert.equal(owner.records[0].gpuMs,null);
  }
  assert.equal(reads,0);assert.equal(deletes,2);
  a.beginFrame();a.run('fresh-after-disjoint',()=>{});a.poll();assert.equal(a.records.at(-1).gpuMs,2.5);
  a.run('disjoint-during-work',()=>{disjoint=true;readGpuDisjointEpoch(gl,ext);});
  assert.equal(a.pending.length,0);assert.equal(a.discarded,2);assert.equal(current,null);
  assert.equal(begins,ends,'Disjoint timing still closes the live context interval');
  a.dispose();b.dispose();assert.equal([...listeners.values()].every(set=>set.size===0),true);
}

// An unconsumed native disjoint flag can appear while fetching AVAILABLE or
// RESULT, after the poll's initial check. Do not publish that result or leave
// an earlier unavailable query behind in the requeued list.
function lateDisjoint({trigger=5,consume=false,action=null}={}) {
  let current=null,flag=false,next=0,epoch=0,lost=false,reads=0,owner;
  const deleted=[],listeners=new Map();
  const lose=()=>{lost=true;epoch++;current=null;listeners.get('webglcontextlost')?.();};
  const restore=()=>{lost=false;listeners.get('webglcontextrestored')?.();};
  const context={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,
    getExtension:()=>ext,isContextLost:()=>lost,getQuery:()=>current,
    getParameter:()=>{
      const value=flag;flag=false;
      if(value&&action) {
        if(action.startsWith('dispose'))owner.dispose();
        if(action!=='dispose'){lose();if(action!=='loss')restore();}
      }
      return value;
    },
    createQuery:()=>({id:next++,epoch}),beginQuery:(_target,query)=>{assert.equal(current,null);current=query;},
    endQuery:()=>{assert.ok(current);current=null;},
    deleteQuery:query=>{assert.equal(lost,false);assert.equal(query.epoch,epoch);deleted.push(query.id);},
    getQueryParameter:(query,kind)=>{
      assert.equal(lost,false);assert.equal(query.epoch,epoch);
      if(query.id===1&&kind===trigger){flag=true;if(consume)readGpuDisjointEpoch(context,ext);}
      if(kind===4)return query.id!==0;
      reads++;return 2500000;
    }};
  owner=new RenderProfiler({getContext:()=>context,domElement:{
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}},{every:1});
  owner.beginFrame();for(const name of ['unavailable-before','new-disjoint','available-after'])owner.run(name,()=>{});
  owner.poll();
  assert.equal(owner.pending.length,0);assert.equal(owner.records.every(row=>row.gpuMs===null),true);
  assert.equal(reads,1,'Do not read or publish the remaining old range after late disjoint');
  if(!action) {
    assert.equal(owner.discarded,3);assert.deepEqual([...deleted].sort(),[0,1,2]);
    owner.beginFrame();owner.run('new-disjoint-generation',()=>{});owner.poll();
    assert.equal(owner.records.at(-1).gpuMs,2.5,'Fresh queries after the invalid range remain usable');
  } else assert.equal(deleted.length,action==='dispose'?3:action==='dispose-roundtrip'?1:0);
  if(lost)restore();owner.dispose();assert.equal(listeners.size,0);
}
for(const trigger of [4,5])for(const consume of [false,true])lateDisjoint({trigger,consume});
for(const action of ['loss','roundtrip','dispose','dispose-roundtrip'])lateDisjoint({action});
console.log('PASS: bounded nonblocking query ownership, inclusive CPU-only parents, external timer, shared disjoint epochs and post-result validation, context epochs through end/poll/restore, exceptions and synchronous disposal.');
