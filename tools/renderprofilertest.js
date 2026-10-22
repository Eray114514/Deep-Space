import assert from 'node:assert/strict';
import { RenderProfiler } from '../src/render-profiler.js';

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
  const calls=[],listeners=new Map();
  const context={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,
    getExtension:()=>supported?ext:null,isContextLost:()=>contextLost,getParameter:()=>false,
    getQuery:()=>{calls.push('getQuery');return query;},
    createQuery:()=>{calls.push('createQuery');return {};},
    beginQuery:(_target,q)=>{calls.push('beginQuery');assert.equal(query,null);query=q;started++;},
    endQuery:()=>{
      assert.equal(contextLost,false);calls.push('endQuery');assert.ok(query);query=null;ended++;
      if(loseAfterEnd){contextLost=true;listeners.get('webglcontextlost')?.();}
    },
    deleteQuery:()=>{assert.equal(contextLost,false,'Never delete queries after context loss');calls.push('deleteQuery');},
    getQueryParameter:()=>false};
  const profiler=new RenderProfiler({getContext:()=>context,domElement:{
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}},
  {every,maxPending:16,now:()=>time});
  profiler.beginFrame();
  return {p:profiler,calls,advance(ms){time+=ms;},get query(){return query;},set query(value){query=value;},
    lose(){contextLost=true;query=null;listeners.get('webglcontextlost')?.();},
    loseOnEnd(){loseAfterEnd=true;},
    get started(){return started;},get ended(){return ended;}};
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
console.log('PASS: bounded nonblocking GPU query ownership, CPU-only inclusive parents and independent children, nested ownership, overflow, external timer, disjoint, context restore, exceptions, synchronous in-draw disposal and disposal during context loss.');
