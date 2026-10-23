// Actual forecast-stream state with a controllable FIFO Worker. No worker
// generation, WebGL, GPU timing or real forecast-throughput acceptance.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlanetWeatherStream } from '../src/cloud/planet-weather-stream.js';
import { captureWeatherSources, weatherSourcesCurrent } from '../src/cloud/weather-sources.js';

const originalWorker=globalThis.Worker,workers=[],results=[],fixtures=[];
class WorkerFixture {
  constructor(){this.messages=[];this.queue=[];this.terminated=false;workers.push(this);}
  postMessage(message) {
    if(this.throwNext){this.throwNext=false;throw Error('postMessage fixture failure');}
    assert.equal(this.terminated,false);this.messages.push(message);
    if(message.type==='frame')this.queue.push(message);
  }
  terminate(){this.terminated=true;this.queue=[];}
  emit(data){this.onmessage?.({data});}
  reply(options={}) {
    const job=this.queue.shift();assert.ok(job,'A reply requires an actually posted job');
    const data=options.error?{token:job.token,hours:job.hours,error:options.error}:frame(job,options.offset||0);
    this.emit(data);return {job,data};
  }
  fail(message='worker fixture failure'){this.onerror?.({message});}
}
function frame(job,offset=0) {
  const values=factor=>Float32Array.from({length:16},(_,index)=>job.hours*factor+index+offset);
  return {token:job.token,hours:job.hours,width:2,height:2,wind:values(1),low:values(2),high:values(4),bounds:values(3)};
}
function fixture({withBounds=false}={}) {
  const firstWorker=workers.length;
  const texture=()=>{
    const result=new THREE.DataTexture(new Float32Array(16),2,2,THREE.RGBAFormat,THREE.FloatType);
    result.userData.weatherAtlas={width:2,height:2,data:new Float32Array(16),scale:1};return result;
  };
  const p={weatherHours:0,cloudAtlasWidth:2,cloudShadowTex:texture(),cloudWeatherHiTex:texture(),
    weatherField:{windRadiansPerHour:1,namespace:'queue-fixture',streamDescriptor:{},surfaceRangeMeters:1,
      bindWind(){},bindAtlases(){}},stellarDirectionsAt:hours=>[{x:hours,y:1,z:0}]};
  if(withBounds)p.cloudBoundsTex=texture();
  const stream=new PlanetWeatherStream(p);p.weatherStream=stream;
  const f={p,initial:stream,F:stream.frameHours,
    get stream(){return p.weatherStream;},get worker(){return p.weatherStream.worker;},
    get instances(){return workers.slice(firstWorker);},
    update(hours,force=false){p.weatherHours=hours;this.stream.update(hours,force);return this.stream;},
    posts(){return this.instances.flatMap(worker=>worker.messages.filter(message=>message.type==='frame'));},
    bounded(){assert.ok(this.stream.pending.size<=1,'Only one posted forecast may be pending');
      for(const worker of this.instances)assert.ok(worker.queue.length<=1,'Worker FIFO must never hold a backlog');},
    drain(limit=8){let count=0;while(this.worker.queue.length){assert.ok(count++<limit);this.worker.reply();this.bounded();}},
    versions(){return [p.cloudShadowTex.version,p.cloudWeatherHiTex.version];},
    close(){p.weatherStream.dispose();stream.dispose();p.cloudShadowTex.dispose();p.cloudWeatherHiTex.dispose();p.cloudBoundsTex?.dispose();
      assert.ok(this.instances.every(worker=>worker.terminated));}};
  fixtures.push(f);return f;
}
function test(name,run) {
  const first=fixtures.length;let failure;
  try {run();} catch(error){failure={message:error.message,stack:error.stack};}
  finally {for(const f of fixtures.slice(first))try{f.close();}catch(error){failure||={message:error.message,stack:error.stack};}}
  results.push({name,passed:!failure,...failure&&{failure}});
}
globalThis.Worker=WorkerFixture;
try {
  test('a/b/c drain in absolute-hour order with one posted frame and unchanged request payloads',()=>{
    const f=fixture();f.update(0);f.bounded();assert.deepEqual(f.stream.desired,[0,f.F,2*f.F]);
    assert.deepEqual(f.posts().map(job=>job.hours),[0]);assert.equal(f.stream.ready,false);
    f.worker.reply();f.bounded();assert.deepEqual(f.posts().map(job=>job.hours),[0,f.F]);assert.equal(f.stream.ready,false);
    f.worker.reply();assert.equal(f.stream.ready,true);const versions=f.versions();f.worker.reply();
    assert.equal(f.stream.pending.size,0);assert.deepEqual(f.versions(),versions);
    assert.deepEqual(f.posts().map(job=>job.hours),[0,f.F,2*f.F]);
    assert.equal(new Set(f.posts().map(job=>job.token)).size,3);
    for(const job of f.posts()) {
      assert.equal(job.width,2);assert.equal(job.surfaceRange,1);assert.equal(job.frameHours,f.F);
      assert.deepEqual(job.stellarDirections,[{x:job.hours,y:1,z:0}]);
    }
  });

  test('ordinary clock steps replace desired hours without enqueuing expired work',()=>{
    const f=fixture();f.update(0);
    for(let tick=1;tick<=320;tick++){f.update(tick*f.F/4);f.bounded();}
    assert.equal(f.instances.length,1);assert.equal(f.posts().length,1);
    assert.deepEqual(f.stream.desired,[80*f.F,81*f.F,82*f.F]);f.worker.reply();f.bounded();
    assert.deepEqual(f.posts().map(job=>job.hours),[0,80*f.F]);
    assert.equal(f.stream.frames.has(0),false,'An obsolete completed job must not reinsert an expired frame');
    f.drain();assert.equal(f.stream.ready,true);assert.equal(f.stream.frames.has(f.F),false);
  });

  test('a short forward jump skips never-posted b/c and completes the new real bracket',()=>{
    const f=fixture();f.update(0);f.update(2.1*f.F);f.worker.reply();f.drain();
    assert.equal(f.instances.length,1);assert.deepEqual(f.posts().map(job=>job.hours),[0,2*f.F,3*f.F,4*f.F]);
    assert.equal(f.stream.ready,true);assert.ok(f.stream.frames.has(2*f.F)&&f.stream.frames.has(3*f.F));
  });

  test('a distant jump retires its active worker and ignores its late response',()=>{
    const f=fixture();f.update(0);const old=f.worker,job=old.queue[0],source=captureWeatherSources(f.stream,[0]);
    f.update(8.1*f.F);assert.notEqual(f.stream,f.initial);assert.equal(old.terminated,true);f.bounded();
    const active=f.worker.queue[0];old.emit(frame(job,99));
    assert.equal(f.stream.frames.size,0);assert.equal(f.worker.queue[0],active);assert.equal(weatherSourcesCurrent(source,f.stream),false);
    f.drain();assert.equal(f.stream.ready,true);assert.deepEqual(f.stream.desired,[8*f.F,9*f.F,10*f.F]);
  });

  test('a short backward jump reuses exact cached endpoints and does not queue its obsolete future',()=>{
    const f=fixture();f.update(0);f.drain();const first=f.stream.frames.get(0),revision=f.stream.revisionAt(0);
    f.update(1.1*f.F);assert.equal(f.worker.queue[0].hours,3*f.F);f.update(.2*f.F);
    assert.equal(f.stream.ready,true);const versions=f.versions();f.worker.reply();
    assert.equal(f.instances.length,1);assert.equal(f.stream.pending.size,0);assert.deepEqual(f.versions(),versions);
    assert.equal(f.stream.frames.get(0),first);assert.equal(f.stream.revisionAt(0),revision);
    assert.deepEqual(f.stream.desired,[0,f.F,2*f.F]);
  });

  test('a distant backward jump also retires the old absolute-time transaction',()=>{
    const f=fixture();f.update(10*f.F);const old=f.worker,job=old.queue[0];f.update(0);
    assert.equal(old.terminated,true);assert.equal(f.instances.length,2);old.emit(frame(job));
    assert.equal(f.stream.frames.size,0);f.drain();assert.equal(f.stream.ready,true);
  });

  test('a distant jump with no active job reuses the initialized worker and drops obsolete frames',()=>{
    const f=fixture();f.update(0);f.drain();const worker=f.worker;f.update(8*f.F);
    assert.equal(f.instances.length,1);assert.equal(f.worker,worker);assert.equal(f.stream.frames.size,0);
    assert.equal(f.stream.ready,false);assert.equal(f.worker.queue[0].hours,8*f.F);f.drain();assert.equal(f.stream.ready,true);
  });

  test('a frame error advances other desired work, retries only on external update, and rejects a stale retry token',()=>{
    const f=fixture();f.update(0);const old=f.worker.reply({error:'frame fixture failure'}).job;
    f.bounded();assert.equal(f.stream.ready,false);assert.deepEqual(f.posts().map(job=>job.hours),[0,f.F]);
    f.drain();assert.equal(f.posts().length,3);assert.equal(f.stream.pending.size,0);assert.equal(f.stream.frames.has(0),false);
    f.update(0,true);const retry=f.worker.queue[0];assert.equal(retry.hours,0);assert.notEqual(retry.token,old.token);
    f.worker.emit(frame(old,99));assert.equal(f.worker.queue[0],retry);assert.equal(f.stream.frames.has(0),false);
    f.worker.reply();assert.equal(f.stream.ready,true);assert.equal(f.stream.error,null);
  });

  test('an error-only batch becomes idle instead of spinning on its own failed completions',()=>{
    const f=fixture();f.update(0);
    for(let count=0;count<3;count++){f.worker.reply({error:'all failed'});f.bounded();}
    assert.equal(f.worker.queue.length,0);assert.equal(f.posts().length,3);assert.equal(f.stream.ready,false);
    f.update(0);assert.equal(f.posts().length,4);assert.equal(f.worker.queue[0].hours,0);
  });

  test('an unrelated or wrong-token response cannot complete another in-flight request',()=>{
    const f=fixture();f.update(0);const job=f.worker.queue[0];
    f.worker.emit(frame({...job,hours:99}));f.worker.emit(frame({...job,token:job.token-1}));
    assert.equal(f.stream.frames.size,0);assert.equal(f.stream.pending.size,1);assert.equal(f.worker.queue[0],job);
    f.worker.reply();assert.equal(f.stream.frames.has(0),true);f.bounded();
  });

  test('a terminal worker error rebuilds once on external update and ignores retired-instance events',()=>{
    const f=fixture();f.update(0);const old=f.worker,job=old.queue[0];old.fail();
    assert.equal(old.terminated,true);assert.equal(f.stream.pending.size,0);assert.equal(f.stream.ready,false);
    assert.equal(f.instances.length,1);f.update(0);assert.equal(f.instances.length,2);f.bounded();
    const retry=f.worker.queue[0];old.emit(frame(job,99));old.fail('late retired error');
    assert.equal(f.worker.queue[0],retry);assert.equal(f.worker.terminated,false);f.drain();assert.equal(f.stream.ready,true);
  });

  test('a failed worker cannot replace cached frames or overwrite its terminal error before restart',()=>{
    const f=fixture();f.update(0);f.drain();const worker=f.worker,token=f.stream.token,previous=f.stream.frames.get(0);
    worker.fail('terminal failure');const versions=f.versions();
    worker.emit(frame({token,hours:0},99));worker.fail('late failure');
    assert.equal(f.stream.frames.get(0),previous);assert.equal(f.stream.error,'terminal failure');
    assert.deepEqual(f.versions(),versions);assert.equal(f.stream.pending.size,0);
  });

  test('the real worker untokened init-error response retires its instance instead of retrying uninitialized frame jobs',()=>{
    const f=fixture();f.update(0);const worker=f.worker,job=worker.queue[0];
    worker.emit({error:'initialization fixture failure'});
    assert.equal(worker.terminated,true);assert.equal(f.stream.pending.size,0);assert.equal(f.stream.ready,false);
    assert.equal(f.stream.error,'initialization fixture failure');f.update(0);assert.equal(f.instances.length,2);
    const active=f.worker.queue[0];worker.emit({token:job.token,hours:job.hours,error:'late uninitialized frame error'});
    assert.equal(f.worker.queue[0],active);f.drain();assert.equal(f.stream.ready,true);
  });

  test('a postMessage exception releases the slot and can recover on the next external update',()=>{
    const f=fixture();f.worker.throwNext=true;f.update(0);
    assert.equal(f.stream.pending.size,0);assert.match(f.stream.error,/postMessage fixture failure/);
    f.update(0);f.bounded();f.drain();assert.equal(f.stream.ready,true);
  });

  test('dispose clears desired/in-flight state and rejects all late worker activity',()=>{
    const f=fixture();f.update(0);const worker=f.worker,job=worker.queue[0];f.stream.dispose();
    worker.emit(frame(job));worker.fail();f.stream.update(f.F);f.stream.dispose();
    assert.equal(worker.terminated,true);assert.equal(f.stream.pending.size,0);assert.equal(f.stream.frames.size,0);
    assert.deepEqual(f.stream.desired,[]);assert.equal(f.stream.inFlight,null);assert.equal(f.stream.ready,false);
  });

  test('failed c never forges a missing bracket but preserves a still-valid existing pair',()=>{
    const f=fixture();f.update(0);f.worker.reply();f.worker.reply();assert.equal(f.stream.ready,true);
    f.worker.reply({error:'forecast c failed'});assert.equal(f.stream.ready,true);assert.equal(f.stream.frames.has(2*f.F),false);
    f.update(f.F);assert.equal(f.stream.ready,false);assert.equal(f.worker.queue[0].hours,2*f.F);
    f.worker.reply();assert.equal(f.stream.ready,true);
  });

  test('same-hour replacement refreshes revision without releasing a different active job',()=>{
    const f=fixture();f.update(0);f.worker.reply();const job=f.worker.queue[0],before=f.stream.revisionAt(0);
    f.worker.emit(frame({token:job.token,hours:0},4));assert.notEqual(f.stream.revisionAt(0),before);
    assert.equal(f.stream.pending.size,1);assert.equal(f.worker.queue[0],job);assert.equal(f.posts().length,2);
    f.worker.reply();assert.equal(f.stream.ready,true);f.bounded();
  });

  test('a drained frozen bracket neither reposts nor dirties its exact published transaction',()=>{
    const f=fixture();f.update(.25*f.F);f.drain();const versions=f.versions(),sources=captureWeatherSources(f.stream,[0,f.F]);
    for(let count=0;count<500;count++){f.update(.25*f.F,true);f.bounded();}
    assert.equal(f.posts().length,3);assert.equal(f.stream.pending.size,0);assert.deepEqual(f.versions(),versions);
    assert.equal(weatherSourcesCurrent(sources,f.stream),true);
  });

  test('forecast leases accept only object/function owners and fixed two-or-three-step requests',()=>{
    const f=fixture(),owner={},fn=()=>{};
    assert.equal(f.stream.forecastSteps,2);assert.ok(f.stream.forecastRequests instanceof Map);
    for(const invalid of [null,undefined,0,1,'owner',false,Symbol('owner')])
      assert.throws(()=>f.stream.retainForecast(invalid,3));
    for(const invalid of [0,1,4,-1,2.5,NaN,Infinity,'3',null])
      assert.throws(()=>f.stream.retainForecast(owner,invalid));
    assert.equal(f.stream.forecastRequests.size,0);assert.equal(f.stream.forecastSteps,2);
    assert.equal(f.stream.retainForecast(owner,2),true);assert.equal(f.stream.forecastSteps,2);
    assert.equal(f.stream.retainForecast(fn),true);assert.equal(f.stream.forecastSteps,3);
    assert.equal(f.stream.releaseForecast(fn),true);assert.equal(f.stream.forecastSteps,2);
  });

  test('multiple lease owners take a bounded maximum and release only their own request',()=>{
    const f=fixture(),a={},b={},c=()=>{};
    f.stream.retainForecast(a,3);f.stream.retainForecast(b,2);f.stream.retainForecast(c,3);
    assert.equal(f.stream.forecastRequests.size,3);assert.equal(f.stream.forecastSteps,3);
    f.stream.retainForecast(a,2);assert.equal(f.stream.forecastRequests.size,3);assert.equal(f.stream.forecastSteps,3);
    assert.equal(f.stream.releaseForecast({}),false);assert.equal(f.stream.releaseForecast(c),true);
    assert.equal(f.stream.forecastSteps,2);assert.equal(f.stream.forecastRequests.size,2);
    assert.equal(f.stream.releaseForecast(c),false);f.stream.releaseForecast(a);f.stream.releaseForecast(b);
    assert.equal(f.stream.forecastRequests.size,0);assert.equal(f.stream.forecastSteps,2);
  });

  test('retain/release only change demand metadata until an external update or worker completion',()=>{
    const f=fixture(),owner={};f.update(0);f.drain();const desired=[...f.stream.desired],versions=f.versions();
    f.stream.retainForecast(owner,3);assert.equal(f.stream.forecastSteps,3);
    assert.deepEqual(f.stream.desired,desired);assert.equal(f.posts().length,3);assert.equal(f.stream.pending.size,0);
    f.stream.releaseForecast(owner);assert.deepEqual(f.stream.desired,desired);assert.equal(f.posts().length,3);
    f.stream.retainForecast(owner,3);f.update(0);f.bounded();assert.equal(f.worker.queue[0].hours,3*f.F);
    assert.deepEqual(f.versions(),versions);
  });

  test('a retained third forecast step posts exactly a/b/c/d without changing the frame payload protocol',()=>{
    const f=fixture(),owner={};f.stream.retainForecast(owner,3);f.update(0);f.drain();
    assert.deepEqual(f.posts().map(job=>job.hours),[0,f.F,2*f.F,3*f.F]);
    assert.deepEqual(f.stream.desired,[0,f.F,2*f.F,3*f.F]);assert.equal(f.stream.frames.size,4);
    assert.equal(f.stream.pending.size,0);assert.equal(new Set(f.posts().map(job=>job.token)).size,4);
    const d=f.posts().at(-1);assert.equal(d.frameHours,f.F);assert.deepEqual(d.stellarDirections,[{x:3*f.F,y:1,z:0}]);
  });

  test('d completion preserves current a/b bytes, texture versions and revision witnesses',()=>{
    const f=fixture({withBounds:true}),owner={};f.stream.retainForecast(owner,3);f.update(0);
    f.worker.reply();f.worker.reply();f.worker.reply();assert.equal(f.worker.queue[0].hours,3*f.F);
    const sources=captureWeatherSources(f.stream,[0,f.F]),versions=[...f.versions(),f.p.cloudBoundsTex.version];
    const bytes=[f.p.cloudShadowTex.image.data.slice(),f.p.cloudWeatherHiTex.image.data.slice(),f.p.cloudBoundsTex.image.data.slice()];
    const first=f.stream.committedFirst,second=f.stream.committedSecond;f.worker.reply();
    assert.deepEqual([...f.versions(),f.p.cloudBoundsTex.version],versions);
    assert.deepEqual([f.p.cloudShadowTex.image.data,f.p.cloudWeatherHiTex.image.data,f.p.cloudBoundsTex.image.data],bytes);
    assert.equal(f.stream.committedFirst,first);assert.equal(f.stream.committedSecond,second);
    assert.equal(weatherSourcesCurrent(sources,f.stream),true);assert.notEqual(f.stream.revisionAt(3*f.F),null);
    assert.equal(f.stream.ready,true);
  });

  test('release before c completes prevents the unposted d from entering the worker FIFO',()=>{
    const f=fixture(),owner={};f.stream.retainForecast(owner,3);f.update(0);f.worker.reply();f.worker.reply();
    assert.equal(f.worker.queue[0].hours,2*f.F);f.stream.releaseForecast(owner);f.worker.reply();
    assert.equal(f.stream.forecastSteps,2);assert.deepEqual(f.posts().map(job=>job.hours),[0,f.F,2*f.F]);
    assert.equal(f.stream.pending.size,0);assert.deepEqual(f.stream.desired,[0,f.F,2*f.F]);
  });

  test('releasing one owner preserves d while another owner still requests the extended window',()=>{
    const f=fixture(),a={},b={};f.stream.retainForecast(a,3);f.stream.retainForecast(b,3);f.update(0);
    f.worker.reply();f.worker.reply();f.stream.releaseForecast(a);f.worker.reply();
    assert.equal(f.stream.forecastSteps,3);assert.equal(f.worker.queue[0].hours,3*f.F);f.drain();
  });

  test('release does not revoke an already posted d or corrupt the current pair when its response arrives',()=>{
    const f=fixture(),owner={};f.stream.retainForecast(owner,3);f.update(0);
    f.worker.reply();f.worker.reply();f.worker.reply();const d=f.worker.queue[0],versions=f.versions();
    f.stream.releaseForecast(owner);assert.equal(f.stream.forecastSteps,2);assert.equal(f.worker.queue[0],d);
    f.worker.reply();assert.equal(f.stream.pending.size,0);assert.equal(f.posts().length,4);
    assert.deepEqual(f.stream.desired,[0,f.F,2*f.F]);assert.deepEqual(f.versions(),versions);
  });

  test('ordinary extended-window stepping keeps at most five raw frame objects and one worker job',()=>{
    const f=fixture(),owner={};f.stream.retainForecast(owner,3);f.update(0);f.drain();
    for(let interval=1;interval<=24;interval++) {
      f.update(interval*f.F);f.drain();f.bounded();assert.equal(f.stream.desired.length,4);
      assert.ok(f.stream.frames.size<=5);
      for(const hour of f.stream.frames.keys())assert.ok(hour>=f.stream.anchor-f.F&&hour<=f.stream.anchor+3*f.F);
    }
    assert.equal(f.instances.length,1);assert.equal(f.posts().length,28);
  });

  test('jump-created streams start with default demand and require a fresh owner lease',()=>{
    const f=fixture(),owner={};f.stream.retainForecast(owner,3);f.update(0);
    const old=f.stream,worker=f.worker,job=worker.queue[0];f.update(8*f.F);
    assert.notEqual(f.stream,old);assert.equal(old.forecastRequests.size,0);assert.equal(f.stream.forecastSteps,2);
    assert.deepEqual(f.stream.desired,[8*f.F,9*f.F,10*f.F]);assert.equal(f.stream.forecastRequests.size,0);
    f.stream.retainForecast(owner,3);assert.equal(old.releaseForecast(owner),false);assert.equal(f.stream.forecastSteps,3);
    worker.emit(frame(job,99));assert.equal(f.stream.frames.size,0);f.update(8*f.F);f.drain();
    assert.deepEqual(f.stream.desired,[8*f.F,9*f.F,10*f.F,11*f.F]);assert.equal(f.stream.frames.size,4);
  });

  test('dispose clears owner references and makes late retain/release incapable of creating work',()=>{
    const f=fixture(),owner={};f.stream.retainForecast(owner,3);f.update(0);const worker=f.worker,job=worker.queue[0];
    f.stream.dispose();assert.equal(f.stream.forecastRequests.size,0);assert.equal(f.stream.forecastSteps,2);
    assert.equal(f.stream.retainForecast({},3),false);assert.equal(f.stream.releaseForecast(owner),false);
    worker.emit(frame(job));f.stream.update(0);assert.equal(f.stream.frames.size,0);assert.equal(f.stream.pending.size,0);
    assert.equal(f.posts().length,1);
  });

  test('extended-window errors remain bounded and releasing demand prevents a failed d retry',()=>{
    const f=fixture(),owner={};f.stream.retainForecast(owner,3);f.update(0);
    f.worker.reply();f.worker.reply();f.worker.reply();const failed=f.worker.reply({error:'d fixture failure'}).job;
    assert.equal(f.stream.ready,true);assert.equal(f.stream.frames.has(3*f.F),false);assert.equal(f.stream.pending.size,0);
    f.stream.releaseForecast(owner);f.update(0);assert.equal(f.posts().length,4);assert.equal(f.stream.pending.size,0);
    f.stream.retainForecast(owner,3);f.update(0);const retry=f.worker.queue[0];assert.notEqual(retry.token,failed.token);
    f.worker.emit(frame(failed,99));assert.equal(f.stream.frames.has(3*f.F),false);assert.equal(f.worker.queue[0],retry);
    f.worker.reply();assert.equal(f.stream.ready,true);assert.notEqual(f.stream.revisionAt(3*f.F),null);
  });

  test('jump pruning releases old published-frame comparison references without changing published bytes',()=>{
    const f=fixture({withBounds:true}),owner={};f.stream.retainForecast(owner,3);f.update(0);f.drain();
    const stream=f.stream,first=stream.frames.get(0),second=stream.frames.get(f.F);
    assert.equal(stream.committedFirst,first);assert.equal(stream.committedSecond,second);
    assert.equal(stream.boundsFirst,first);assert.equal(stream.boundsSecond,second);
    const versions=[...f.versions(),f.p.cloudBoundsTex.version],lastUpdate=stream.lastUpdate;
    const bytes=[f.p.cloudShadowTex.image.data.slice(),f.p.cloudWeatherHiTex.image.data.slice(),f.p.cloudBoundsTex.image.data.slice(),stream.windData.slice()];
    f.update(8*f.F);assert.equal(f.stream,stream);assert.equal(stream.ready,false);
    for(const key of ['committedFirst','committedSecond','boundsFirst','boundsSecond'])assert.equal(stream[key],null);
    assert.equal(stream.frames.has(0),false);assert.equal(stream.frames.has(f.F),false);assert.equal(stream.lastUpdate,lastUpdate);
    assert.deepEqual([...f.versions(),f.p.cloudBoundsTex.version],versions);
    assert.deepEqual([f.p.cloudShadowTex.image.data,f.p.cloudWeatherHiTex.image.data,f.p.cloudBoundsTex.image.data,stream.windData],bytes);
  });

  test('pruning keeps still-current comparison identities but releases same-hour replaced objects',()=>{
    const f=fixture({withBounds:true});f.update(0);f.drain();const first=f.stream.frames.get(0),second=f.stream.frames.get(f.F);
    f.stream.frames.delete(2*f.F);const versions=[...f.versions(),f.p.cloudBoundsTex.version];
    f.update(f.F);assert.equal(f.stream.ready,false);
    assert.equal(f.stream.committedFirst,first);assert.equal(f.stream.committedSecond,second);
    assert.equal(f.stream.boundsFirst,first);assert.equal(f.stream.boundsSecond,second);
    f.update(0);f.stream.frames.set(0,{...first});f.stream.frames.delete(f.F);
    // Crossing the anchor forces identity pruning, while the missing endpoint
    // prevents a replacement publication from concealing retained old refs.
    f.update(f.F);assert.equal(f.stream.ready,false);
    assert.equal(f.stream.committedFirst,null);assert.equal(f.stream.boundsFirst,null);
    assert.equal(f.stream.committedSecond,null);assert.equal(f.stream.boundsSecond,null);
    assert.deepEqual([...f.versions(),f.p.cloudBoundsTex.version],versions);
  });

  test('same-anchor replacement with a missing partner releases old raw witnesses without republishing',()=>{
    const f=fixture({withBounds:true});f.update(0);f.drain();const stream=f.stream,oldFirst=stream.frames.get(0);
    assert.equal(stream.committedFirst,oldFirst);assert.equal(stream.boundsFirst,oldFirst);
    const versions=[...f.versions(),f.p.cloudBoundsTex.version],lastUpdate=stream.lastUpdate;
    const bytes=[f.p.cloudShadowTex.image.data.slice(),f.p.cloudWeatherHiTex.image.data.slice(),f.p.cloudBoundsTex.image.data.slice(),stream.windData.slice()];
    stream.frames.delete(f.F);f.update(0);assert.equal(stream.anchor,0);assert.equal(stream.ready,false);
    const pending=f.worker.queue[0];assert.equal(pending.hours,f.F);
    f.worker.emit(frame({token:pending.token,hours:0},99));
    assert.equal(stream.ready,false);assert.equal(stream.anchor,0);assert.equal(f.worker.queue[0],pending);
    assert.notEqual(stream.frames.get(0),oldFirst);
    assert.equal(stream.committedFirst,null,'An obsolete same-hour witness must not retain the replaced raw frame');
    assert.equal(stream.boundsFirst,null,'Conservative-support comparison must release the same replaced object');
    assert.equal(stream.committedSecond,null);assert.equal(stream.boundsSecond,null);
    assert.equal(stream.lastUpdate,lastUpdate);assert.deepEqual([...f.versions(),f.p.cloudBoundsTex.version],versions);
    assert.deepEqual([f.p.cloudShadowTex.image.data,f.p.cloudWeatherHiTex.image.data,f.p.cloudBoundsTex.image.data,stream.windData],bytes);
  });
} finally {globalThis.Worker=originalWorker;}
console.log(JSON.stringify({passed:results.every(result=>result.passed),cases:results.length,results,
  scope:'Pure Node actual stream/clock-identity and controlled FIFO Worker contracts. No generation-byte, real worker latency, GPU, cloud image or dynamic service-rate acceptance.'},null,2));
assert.equal(results.filter(result=>!result.passed).length,0,'Weather work queue contracts failed');
