import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {installFoundationFirstDrawProbe} from './foundation-first-draw-probe.js';
import {instrumentFoundationFirstDraw,installFoundationMainResponse} from './foundation-first-draw-route.js';

let passed = 0;
function test(name, work) { work(); passed++; }
function fixture() {
  let clock = 2, ready = false, drawError = null, tailError = null, blocked = false, calls = 0;
  const tasks = new Map(); let taskId = 0;
  const renderer = {info: {render: {calls: 0}}, getContext() { throw Error('No GL access allowed'); },
    renderBufferDirect(...args) { assert.equal(this, renderer); calls++;if(drawError)throw drawError;
      assert.equal(args.length, 6);this.info.render.calls++;return 'draw-result'; }};
  const cloud = {defines: {CLOUD_FAR_VIEW: 1}};
  const volume = {render(material = cloud) { return renderer.renderBufferDirect(null, null, null, material, null, null); }};
  const pipeline = {renderer, volumePass: volume, frameState: {sequence: 0},
    submitFrame(work) { assert.equal(this, pipeline);
      work(function () { if(blocked)return false;volume.render();pipeline.frameState.sequence++;return true; });
      if(tailError)throw tailError;return true; }};
  const originals = {submit: pipeline.submitFrame, volume: volume.render, direct: renderer.renderBufferDirect};
  const host = {setTimeout(fn) {tasks.set(++taskId, fn);return taskId;}, clearTimeout(id) {tasks.delete(id);}};
  const context = vm.createContext({window: host, performance: {timeOrigin: 10000, now: () => clock}});
  vm.runInContext(`(${installFoundationFirstDrawProbe})()`, context);
  const probe = host.__foundationFirstDrawProbe;
  const attach = () => probe.attach(pipeline, () => ready);
  const submit = () => pipeline.submitFrame(function (draw) {assert.equal(this, undefined);return draw();});
  return {pipeline, volume, renderer, originals, host, probe, tasks, attach, submit,
    tick() { const list = [...tasks.values()];tasks.clear();for(const fn of list)fn(); },
    set time(value) {clock = value;},set ready(value) {ready = value;},set error(value) {drawError = value;},
    set tailError(value) {tailError = value;},set blocked(value) {blocked = value;},get calls() {return calls;}};
}
test('navigation deadline is independent of ready marker and later observation', () => {
  const f=fixture();f.attach();f.time=100;f.probe.noteReady();f.ready=true;f.time=154000;f.submit();f.time=154010;f.tick();
  const s=f.probe.snapshot();assert.equal(s.readyObservedAtMs,100);assert.equal(s.firstReadyCloudWorld.endedAtMs,154000);
  assert.equal(s.deadline.passed,false);assert.equal(s.deadline.failure,'cloud-world-return-after-deadline');
  f.time=300000;f.probe.endStartup();assert.equal(f.probe.snapshot().deadline.passed,false);
});
test('auxiliary draw and pre-ready world do not satisfy the ready cloud gate', () => {
  const f=fixture();f.attach();f.pipeline.submitFrame(()=>f.volume.render());f.time=50;f.submit();
  let s=f.probe.snapshot();assert.equal(s.counts.auxiliaryOnly,1);assert.equal(s.firstWorld.endedAtMs,50);
  assert.equal(s.firstReadyCloudWorld,null);assert.equal(s.firstPostCloudTaskAtMs,null);assert.equal(f.tasks.size,0);
  f.ready=true;f.time=70;f.submit();f.time=71;f.tick();s=f.probe.snapshot();assert.equal(s.deadline.passed,true);
  assert.equal(s.firstReadyCloudWorld.volumeReturns,1);assert.equal(s.firstReadyCloudWorld.cloudDraws,1);
  assert.equal(s.firstPostCloudTaskAtMs,71);assert.equal(f.calls,3);
});
test('ordinary world without cloud draw is not cloud-first acceptance', () => {
  const f=fixture();f.volume.render=()=>f.renderer.renderBufferDirect(null,null,null,{defines:{}},null,null);
  f.attach();f.ready=true;f.submit();f.tick();const s=f.probe.snapshot();
  assert.ok(s.firstReadyWorld);assert.equal(s.firstReadyCloudWorld,null);assert.equal(s.deadline.passed,false);
});
test('cloud method returning without native draw count is not an actual cloud draw', () => {
  const f=fixture();f.renderer.renderBufferDirect=()=>{};f.attach();f.ready=true;f.submit();
  assert.equal(f.probe.snapshot().firstCloudWorld,null);
});
test('blocked, draw-failed and post-draw failed submissions never publish first world', () => {
  const f=fixture();f.attach();f.ready=true;f.blocked=true;f.submit();f.blocked=false;
  const error=new Error('draw');f.error=error;assert.throws(f.submit,e=>e===error);f.error=null;
  f.tailError=error;assert.throws(f.submit,e=>e===error);const s=f.probe.snapshot();
  assert.equal(s.counts.blockedWorld,1);assert.equal(s.counts.failedSubmissions,2);assert.equal(s.firstWorld,null);
  assert.equal(f.tasks.size,0);f.tailError=null;f.submit();f.tick();assert.equal(f.probe.snapshot().deadline.passed,true);
});
test('response task retains the original deadline even when draw was in time', () => {
  const f=fixture();f.attach();f.ready=true;f.time=119999;f.submit();f.time=120001;f.tick();
  assert.equal(f.probe.snapshot().deadline.failure,'post-cloud-task-after-deadline');
});
test('startup seal rejects later fixture draws and cannot overwrite initial evidence', () => {
  const f=fixture();f.attach();f.ready=true;f.time=25;f.probe.endStartup();f.time=26;f.submit();f.tick();
  assert.equal(f.probe.snapshot().firstWorld,null);assert.equal(f.probe.snapshot().deadline.passed,false);
});
test('dispose restores exact own methods, cancels task and returns snapshots by value', () => {
  const f=fixture();f.attach();f.ready=true;f.submit();const s=f.probe.snapshot();s.counts.submissions=77;
  assert.equal(f.probe.snapshot().counts.submissions,1);assert.equal(f.tasks.size,1);f.probe.dispose();f.probe.dispose();
  assert.equal(f.pipeline.submitFrame,f.originals.submit);assert.equal(f.volume.render,f.originals.volume);
  assert.equal(f.renderer.renderBufferDirect,f.originals.direct);assert.equal(f.tasks.size,0);assert.equal(f.probe.snapshot().restored,true);
});
test('foreign wrapper replacement survives disposal and blocks clean-observer acceptance', () => {
  const f=fixture();f.attach();const foreign=()=>{};f.volume.render=foreign;f.probe.dispose();
  assert.equal(f.volume.render,foreign);assert.equal(f.probe.snapshot().restored,false);assert.equal(f.probe.snapshot().faults.length,1);
});
test('partial attachment failure restores already wrapped methods', () => {
  const f=fixture();Object.defineProperty(f.volume,'render',{value:f.volume.render,writable:false,configurable:false});
  assert.throws(f.attach);assert.equal(f.renderer.renderBufferDirect,f.originals.direct);
});
test('inherited methods remain inherited after restoration', () => {
  const f=fixture();const method=f.pipeline.submitFrame;
  delete f.pipeline.submitFrame;Object.setPrototypeOf(f.pipeline,{submitFrame:method});
  f.attach();f.probe.dispose();assert.equal(Object.hasOwn(f.pipeline,'submitFrame'),false);
  assert.equal(f.pipeline.submitFrame,method);
});
test('falsy callback throws retain identity and do not publish a world', () => {
  for(const error of [null,0,false]) {
    const f=fixture();f.attach();let caught=false;
    try {f.pipeline.submitFrame(()=>{throw error;});}catch(actual){assert.equal(actual,error);caught=true;}
    assert.ok(caught);assert.equal(f.probe.snapshot().firstWorld,null);
    assert.equal(f.probe.snapshot().counts.failedSubmissions,1);f.probe.dispose();
  }
});
test('outer observers can restore in reverse order without changing original descriptors', () => {
  const f=fixture();f.attach();const submit=f.pipeline.submitFrame,render=f.volume.render;
  f.pipeline.submitFrame=function(...args){return submit.apply(this,args);};
  f.volume.render=function(...args){return render.apply(this,args);};
  f.ready=true;f.submit();f.tick();f.volume.render=render;f.pipeline.submitFrame=submit;f.probe.dispose();
  assert.equal(f.probe.snapshot().restored,true);assert.equal(f.probe.snapshot().deadline.passed,true);
});
const source=await readFile('src/main.js','utf8');
const served=instrumentFoundationFirstDraw(source);
assert.equal(served.replace('\nwindow.__foundationFirstDrawProbe.attach(nodePipeline, () => loadingCleared);',''),source);
assert.throws(()=>instrumentFoundationFirstDraw(source.replace('\nframe();\n','\nframe(1);\n')));
assert.throws(()=>instrumentFoundationFirstDraw(source+'\nframe();\n\n// ---- debug / test API'));
test('local response delegates non-main requests to the exact original receiver and preserves later listeners', () => {
  const server=new EventEmitter(),received=[];
  const original=function(...args){assert.equal(this,server);received.push(args);};server.on('request',original);
  const responder=installFoundationMainResponse(server,'observed');
  const request={url:'/src/main.js-extra'},response={};server.emit('request',request,response);
  assert.equal(received[0][0],request);assert.equal(received[0][1],response);
  const later=()=>{};server.on('request',later);responder.restore();responder.restore();
  assert.deepEqual(server.rawListeners('request'),[original,later]);assert.equal(responder.snapshot().restored,true);
});
test('local response rejects ambiguous handlers and preserves foreign replacements', () => {
  const server=new EventEmitter(),original=()=>{};assert.throws(()=>installFoundationMainResponse(server,''));
  server.on('request',original);const responder=installFoundationMainResponse(server,'');
  server.removeAllListeners('request');const foreign=()=>{};server.on('request',foreign);responder.restore();
  assert.deepEqual(server.rawListeners('request'),[foreign]);assert.equal(responder.snapshot().restoreConflict,true);
});
const {server,port}=await startServer(0);let response;
try {
  response=installFoundationMainResponse(server,served);
  const main=await fetch(`http://127.0.0.1:${port}/src/main.js?v=0.38.0`);
  assert.equal(main.status,200);assert.equal(main.headers.get('cache-control'),'no-store');
  assert.equal(await main.text(),served);
  const other=await fetch(`http://127.0.0.1:${port}/src/rng.js`);
  assert.equal(await other.text(),await readFile('src/rng.js','utf8'));
  const miss=await fetch(`http://127.0.0.1:${port}/src/main.js-extra`);assert.equal(miss.status,404);
  response.restore();assert.equal(await (await fetch(`http://127.0.0.1:${port}/src/main.js`)).text(),source);
  assert.equal(response.snapshot().matchedRequests,1);assert.equal(response.snapshot().delegatedRequests,2);
} finally {response?.restore();await new Promise(resolve=>server.close(resolve));}
console.log(`PASS: ${passed} passive first-draw contracts, exact served-main transformation and real local HTTP isolation; no GPU invoked.`);
