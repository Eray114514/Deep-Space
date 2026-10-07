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
console.log('PASS: bounded nonblocking GPU query ownership, overflow, external timer, disjoint, context restore, exceptions and disposal.');
