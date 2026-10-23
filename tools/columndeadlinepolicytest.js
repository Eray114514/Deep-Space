// Execute the actual Bank scheduler with real revision helpers, an authored
// clock and zero-GPU Map/Scratch doubles. This is policy, never performance.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { PlanetWeatherStream } from '../src/cloud/planet-weather-stream.js';
import { CloudColumnTileMap } from '../src/cloud/cloud-column-tile-map.js';
import { captureWeatherSources, weatherSourcesCurrent } from '../src/cloud/weather-sources.js';

const runtimeBankBytes=await readFile('src/cloud/cloud-column-bank.js');
const source=runtimeBankBytes.toString()
  .replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const samplerNames=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'];
const fixtures=[],results=[];
function fixture({deadlineAware=true,producer='tile',missing=[],forecastSteps=2,cacheSteps=forecastSteps}={}) {
  const F=.03125,records=[];let live=0,maxLive=0,maxDelivered=Infinity,onDispose=null;
  const u={uSpeciesMask:{value:-1},uWeatherMap:{value:{published:true}},uColumnMix:{value:0},
    uColumnsReady:{value:0},uColumnsJointReady:{value:0}};
  for(const name of samplerNames)u[name]={value:u.uWeatherMap.value};
  const stream={anchor:0,frameHours:F,ready:true,disposed:false,frames:new Map(),forecastRequests:new Map(),
    generations:new WeakMap(),generation:0,revisionAt:PlanetWeatherStream.prototype.revisionAt};
  Object.setPrototypeOf(stream,PlanetWeatherStream.prototype);
  for(let index=0;index<=forecastSteps;index++)if(!missing.includes(index*F))stream.frames.set(index*F,{hours:index*F});
  const p={weatherHours:0,weatherField:{},weatherStream:stream,volCloudMat:{uniforms:u},
    volCloudFarMat:{defines:{CLOUD_FAR_CACHE:0}}};
  class FakeScratch {
    constructor(width,rows){Object.assign(this,{width,rows,epoch:0,lost:false,disposed:false});}
    dispose(){this.disposed=true;}
  }
  class FakeMap {
    constructor(planet,options,kind) {
      assert.equal(planet,p);assert.equal(options.width,1024);assert.equal(options.footprintSamples,64);
      assert.notEqual(planet.weatherStream.revisionAt(options.hours),null,'Only a real forecast identity may be allocated');
      Object.assign(this,{kind,options,generation:options.hours,width:options.width,height:options.width/2,
        row:0,footprintCursor:0,ready:false,disposed:false,invalidated:false,contextEpoch:null,draws:0,
        weatherSources:captureWeatherSources(planet.weatherStream,[options.hours]),target:{textures:[{},{}]}});
      this.total=kind==='tile'?Math.ceil(this.height/options.tileRows)*Math.ceil(options.footprintSamples/options.footprintBatch):this.height/2;
      records.push(this);live++;maxLive=Math.max(maxLive,live);assert.ok(live<=1,'Only one partial snapshot may exist');
    }
    bakeWork(renderer,grant) {
      assert.equal(renderer,null);assert.ok(Number.isInteger(grant)&&grant>=0);
      assert.equal(this.disposed,false);assert.equal(this.ready,false);
      const draws=Math.min(grant,maxDelivered,this.total-this.draws);this.draws+=draws;
      if(draws)this.contextEpoch=this.options.scratch.epoch;
      const perTile=Math.ceil(this.options.footprintSamples/this.options.footprintBatch);
      this.row=Math.min(this.height,Math.floor(this.draws/perTile)*this.options.tileRows);
      this.footprintCursor=this.draws%perTile*this.options.footprintBatch;
      if(this.draws===this.total){this.ready=true;this.row=this.height;this.footprintCursor=0;live--;}
      return {draws,row:this.row,footprintCursor:this.footprintCursor,ready:this.ready,blocked:grant>0&&draws===0};
    }
    bakeSlice(renderer,rows) {
      assert.equal(renderer,null);assert.equal(rows,2);this.draws++;this.row+=rows;
      if(this.row>=this.height){this.ready=true;live--;}
    }
    dispose() {
      if(this.disposed)return;
      assert.ok(samplerNames.every(name=>!this.target.textures.includes(u[name].value)),'Retire only after sampler unbinding');
      this.disposed=true;if(!this.ready)live--;onDispose?.(this);
    }
  }
  class FakeTileMap extends FakeMap {constructor(planet,options){super(planet,options,'tile');}}
  class FakeRowMap extends FakeMap {constructor(planet,options){super(planet,options,'rows');}}
  const Bank=vm.runInNewContext(`${source}\nCloudColumnBank;`,{CloudColumnMap:FakeRowMap,
    CloudColumnTileMap:FakeTileMap,CloudColumnScratch:FakeScratch,weatherSourcesCurrent,performance});
  const bank=new Bank(p,{deadlineAware,producer,tileRows:64,footprintBatch:2,forecastSteps,cacheSteps});p.cloudColumnMap=bank;
  const f={p,u,stream,bank,records,F,
    setMaxDelivered(value){maxDelivered=value;},
    setOnDispose(callback){onDispose=callback;},
    setHours(hours,{fill=true}={}) {
      p.weatherHours=hours;const current=p.weatherStream;current.anchor=Math.floor(hours/F)*F;
      for(const hour of current.frames.keys())if(hour<current.anchor-F||hour>current.anchor+3*F)current.frames.delete(hour);
      if(fill)for(const hour of bank.endpointHours(current))
        if(!current.frames.has(hour))current.frames.set(hour,{hours:hour});
    },
    tick(delta=0,grant=1,options={}) {
      this.setHours(p.weatherHours+delta,options);const result=bank.update(null,{workQuanta:grant,allowCreate:options.allowCreate??true});
      this.check();return result;
    },
    check() {
      assert.ok(live<=1);assert.ok(bank.maps.size<=cacheSteps+1);
      for(const map of records)assert.ok(map.disposed||bank.maps.get(map.generation)===map,'No live orphan map');
      if(u.uColumnsReady.value) {
        const a=p.weatherStream.anchor,first=bank.maps.get(a),second=bank.maps.get(a+F);
        assert.ok(first?.ready&&second?.ready&&p.weatherStream.ready,'Only a real complete current pair may publish');
        assert.equal(u.uOpticalColumns.value,first.target.textures[0]);assert.equal(u.uOpticalColumnsNext.value,second.target.textures[0]);
      } else for(const name of samplerNames)assert.equal(u[name].value,u.uWeatherMap.value);
    },
    drainOwnedMaps() {
      bank.unbind();for(const [hour,map] of bank.maps){bank.maps.delete(hour);map.dispose();}
    },
    close() {bank.dispose();this.check();assert.equal(live,0);assert.ok(maxLive<=1);assert.ok(records.every(map=>map.disposed));}
  };
  fixtures.push(f);return f;
}
function test(name,run) {
  const first=fixtures.length;let failure;
  try{run();}catch(error){failure={message:error.message,stack:error.stack};}
  finally{for(const f of fixtures.slice(first))try{f.close();}catch(error){failure||={message:error.message,stack:error.stack};}}
  results.push({name,passed:!failure,...failure&&{failure}});
}
function trainSlow(f,{grant=1,maxDelivered=Infinity}={}) {
  f.setMaxDelivered(maxDelivered);f.tick(0,grant);
  for(let count=0;count<12;count++)f.tick(f.F/20,grant);
  assert.ok(f.bank.maps.get(0),'No feasible replacement is not a reason to cancel a partial map');
  assert.equal(f.records.length,1,'Insufficient service alone cannot trigger repeated restarts');
}

test('unknown service calibrates and an infeasible future pair cannot justify cancelling partial a',()=>{
  const f=fixture();f.tick();const first=f.bank.maps.get(0);
  for(let count=0;count<12;count++)f.tick(f.F/20);
  assert.ok(f.bank.service.samples>=8);assert.ok(f.bank.service.rate>0);
  assert.equal(first.disposed,false);assert.equal(f.bank.maps.get(0),first);assert.equal(f.records.length,1);
  assert.equal(f.u.uColumnsReady.value,0);
});

test('a feasible current pair preserves a/b order and publishes both real completed endpoints',()=>{
  const f=fixture();f.tick(0,8);const first=f.bank.maps.get(0);
  for(let count=0;count<12;count++)f.tick(f.F/1000,8);
  assert.equal(f.bank.maps.get(0),first);assert.equal(first.disposed,false);assert.equal(f.records.length,1);
  for(let count=0;count<60&&!f.u.uColumnsReady.value;count++)f.tick(f.F/1000,8);
  assert.equal(f.u.uColumnsReady.value,1);assert.equal(f.records[0].generation,0);assert.equal(f.records[1].generation,f.F);
});

test('default-false and ordinary rows ignore the opt-in deadline policy',()=>{
  for(const options of [{deadlineAware:false},{deadlineAware:true,producer:'rows'}]) {
    const f=fixture(options);f.tick();const first=f.bank.maps.get(0);
    for(let count=0;count<12;count++)f.tick(f.F/20);
    assert.equal(f.bank.maps.get(0),first);assert.equal(first.disposed,false);assert.equal(f.records.length,1);
  }
});

test('service prediction uses delivered draws rather than the granted maximum',()=>{
  const f=fixture();trainSlow(f,{grant:100,maxDelivered:1});
  assert.ok(f.records.every(map=>map.draws<=13),'The fake producer intentionally delivered at most one draw per update');
});

for(const hourIndex of [1,2])test(`an existing partial ${hourIndex===1?'b':'c'} is never preempted to chase a`,()=>{
  const f=fixture({missing:[0]});
  f.tick(0,hourIndex===1?1:256,{fill:false});
  if(hourIndex===2)f.tick(f.F/20,1,{fill:false});
  const pending=f.bank.maps.get(hourIndex*f.F);assert.ok(pending&&!pending.ready);
  f.stream.frames.set(0,{hours:0});
  for(let count=0;count<12;count++)f.tick(f.F/20,1);
  assert.equal(f.bank.maps.get(hourIndex*f.F),pending);assert.equal(pending.disposed,false);assert.equal(f.bank.maps.has(0),false);
});

test('zero grant performs validation/publication without allocating a new snapshot or advancing an existing partial',()=>{
  const f=fixture();for(let count=0;count<12;count++)f.tick(f.F/100,0,{allowCreate:false});
  assert.equal(f.records.length,0);assert.equal(f.bank.maps.size,0);assert.equal(f.u.uColumnsReady.value,0);
  f.tick(0,1);const pending=[...f.bank.maps.values()][0],draws=pending.draws;
  for(let count=0;count<4;count++)f.tick(f.F/100,0,{allowCreate:false});
  assert.equal(pending.draws,draws);assert.equal(f.records.length,1);
});

test('explicit zero-draw preparation remains available through the separate allowCreate option',()=>{
  const f=fixture();f.tick(0,0,{allowCreate:true});
  assert.equal(f.records.length,1);assert.equal(f.records[0].draws,0);assert.equal(f.records[0].ready,false);
  assert.equal(f.u.uColumnsReady.value,0);
});

test('zero game-time deltas cannot warm the service estimate or trigger a deadline cancellation',()=>{
  const f=fixture();f.tick();const first=f.bank.maps.get(0);
  for(let count=0;count<12;count++)f.tick(0);
  f.tick(f.F/20);assert.equal(first.disposed,false);assert.equal(f.bank.maps.get(0),first);assert.equal(f.records.length,1);
});

test('a warmed insufficient estimate keeps bounded calibration active without a source or clock reset',()=>{
  const f=fixture();trainSlow(f);f.drainOwnedMaps();const start=f.records.length;f.tick(f.F/100,1);
  assert.ok(f.bank.service.samples>=8);assert.equal(f.records[start].generation,0);assert.equal(f.bank.maps.has(0),true);
});

for(const reset of ['field','species','stream','clock-backward','clock-forward-jump'])test(`${reset} discards the previous service estimate before selecting a new current pair`,()=>{
  const f=fixture();trainSlow(f);f.drainOwnedMaps();const start=f.records.length;
  if(reset==='field')f.p.weatherField={};
  else if(reset==='species')f.u.uSpeciesMask.value=3;
  else if(reset==='stream')f.p.weatherStream={...f.stream,frames:new Map(f.stream.frames),generations:new WeakMap(),generation:0};
  else if(reset==='clock-backward')f.setHours(f.p.weatherHours-f.F/4);
  else f.setHours(f.p.weatherHours+4*f.F);
  f.tick(reset.startsWith('clock')?0:f.F/100,1);
  assert.equal(f.records[start].generation,f.p.weatherStream.anchor,'A fresh estimate must keep the original current-pair order');
  assert.equal(f.u.uColumnsReady.value,0);
});

test('future completion and stream-not-ready never forge a current ready pair',()=>{
  const f=fixture({missing:[0]});f.tick(0,256,{fill:false});assert.equal(f.bank.maps.get(f.F)?.ready,true);
  f.tick(0,256,{fill:false});assert.equal(f.bank.maps.get(2*f.F)?.ready,true);assert.equal(f.u.uColumnsReady.value,0);
  f.setHours(f.F);f.p.weatherStream.ready=false;f.tick(0,0,{allowCreate:false});assert.equal(f.u.uColumnsReady.value,0);
  f.p.weatherStream.ready=true;f.tick(0,0,{allowCreate:false});assert.equal(f.u.uColumnsReady.value,1);
});

for(const change of ['field','species','stream','stream-null','stream-disposed','anchor','context-epoch','context-lost','bank-dispose'])
  test(`a cancellation callback changing ${change} prevents work under the obsolete admission decision`,()=>{
    const f=fixture({forecastSteps:3,cacheSteps:2});f.tick();const first=f.bank.maps.get(0);let callbacks=0;
    f.setOnDispose(map=>{
      if(map!==first||callbacks)return;callbacks++;
      if(change==='field')f.p.weatherField={};
      else if(change==='species')f.u.uSpeciesMask.value=3;
      else if(change==='stream')f.p.weatherStream={...f.stream,frames:new Map(f.stream.frames),generations:new WeakMap(),generation:0};
      else if(change==='stream-null')f.p.weatherStream=null;
      else if(change==='stream-disposed')f.stream.disposed=true;
      else if(change==='anchor')f.setHours(f.p.weatherHours+f.F);
      else if(change==='context-epoch')f.bank.scratch.epoch++;
      else if(change==='context-lost')f.bank.scratch.lost=true;
      else f.bank.dispose();
    });
    f.setHours(f.F/20);f.bank.service={stream:f.stream,hours:f.p.weatherHours,lastDraws:0,rate:180/f.F,samples:8};
    f.tick(0);
    assert.equal(callbacks,1);assert.equal(first.disposed,true);
    assert.equal(f.records.length,1,'Do not allocate from a stale plan after user resource callbacks');
    assert.equal(f.u.uColumnsReady.value,0);
  });

test('four-endpoint lookahead retains exactly one bounded forecast lease and complete canonical targets',()=>{
  const f=fixture({forecastSteps:3});assert.equal(f.stream.forecastSteps,2);
  for(let index=0;index<4;index++)f.tick(0,256);
  assert.equal(f.stream.forecastSteps,3);assert.equal(f.stream.forecastRequests.size,1);
  assert.equal(f.bank.maps.size,4);assert.ok([...f.bank.maps.values()].every(map=>map.ready));
  assert.equal(f.u.uColumnsReady.value,1);const plan=f.bank.plan();
  assert.deepEqual([...plan.jobs].map(job=>job.hours),[0,f.F,2*f.F,3*f.F]);
  assert.equal(plan.maxMaps,4);assert.equal(plan.targetCapacityBytes,24*1024*1024);
  assert.equal(plan.allocatedTargetBytes,plan.targetCapacityBytes);assert.equal(plan.snapshotBytes,0);
  for(let count=0;count<30;count++)f.tick(0,0,{allowCreate:false});
  assert.equal(f.records.length,4);assert.equal(f.stream.forecastRequests.size,1);
  f.bank.dispose();assert.equal(f.stream.forecastSteps,2);assert.equal(f.stream.forecastRequests.size,0);
});

test('turnover keeps real a/b/c identities and retires one target before allocating the new fourth',()=>{
  const f=fixture({forecastSteps:3});for(let index=0;index<4;index++)f.tick(0,256);
  const prior=[...f.bank.maps.values()];f.tick(f.F,0,{allowCreate:false});
  assert.equal(prior[0].disposed,true);for(const map of prior.slice(1))assert.equal(f.bank.maps.get(map.generation),map);
  assert.equal(f.u.uColumnsReady.value,1);assert.equal(f.u.uOpticalColumns.value,prior[1].target.textures[0]);
  assert.equal(f.bank.maps.size,3);f.tick(0,1);assert.equal(f.bank.maps.size,4);
  assert.equal(f.bank.maps.get(4*f.F).draws,1);assert.equal(f.records.length,5);
});

test('the fourth future endpoint cannot masquerade as a missing current pair',()=>{
  const f=fixture({forecastSteps:3,missing:[0,.03125]});
  f.tick(0,256,{fill:false});f.tick(0,256,{fill:false});
  assert.ok(f.bank.maps.get(2*f.F).ready&&f.bank.maps.get(3*f.F).ready);
  assert.equal(f.bank.maps.has(0),false);assert.equal(f.bank.maps.has(f.F),false);assert.equal(f.u.uColumnsReady.value,0);
});

test('zero admission requests bounded source lead without allocating any GPU snapshot',()=>{
  const f=fixture({forecastSteps:3});for(let count=0;count<20;count++)f.tick(0,0,{allowCreate:false});
  assert.equal(f.stream.forecastSteps,3);assert.equal(f.records.length,0);assert.equal(f.bank.plan().allocatedTargetBytes,0);
  f.bank.dispose();f.bank.update(null);assert.equal(f.stream.forecastSteps,2);assert.equal(f.records.length,0);
});

test('raw-only lookahead keeps the original three-target GPU capacity and current pair',()=>{
  const f=fixture({forecastSteps:3,cacheSteps:2});for(let index=0;index<4;index++)f.tick(0,256);
  assert.equal(f.stream.forecastSteps,3);assert.equal(f.bank.maps.size,3);assert.equal(f.records.length,3);
  assert.equal(f.bank.maps.has(3*f.F),false);assert.equal(f.bank.plan().targetCapacityBytes,18*1024*1024);
  assert.equal(f.u.uColumnsReady.value,1);f.tick(f.F,1);
  assert.equal(f.bank.maps.size,3);assert.equal(f.bank.maps.get(3*f.F).draws,1);
  assert.equal(f.u.uColumnsReady.value,1);
});

test('a replacement stream takes the lease only while the bank remains active',()=>{
  const f=fixture({forecastSteps:3});f.tick(0,1);
  const next=Object.assign(Object.create(PlanetWeatherStream.prototype),{...f.stream,frames:new Map(f.stream.frames),forecastRequests:new Map()});
  f.p.weatherStream=next;f.tick(0,0,{allowCreate:false});
  assert.equal(f.stream.forecastSteps,2);assert.equal(f.stream.forecastRequests.size,0);
  assert.equal(next.forecastSteps,3);assert.equal(next.forecastRequests.size,1);assert.equal(f.u.uColumnsReady.value,0);
  f.bank.dispose();assert.equal(next.forecastSteps,2);assert.equal(next.forecastRequests.size,0);
});

for(const change of ['stream-null','stream-disposed','bank-dispose'])test(`lookahead lease cannot survive cancellation callback ${change}`,()=>{
  const f=fixture({forecastSteps:3});f.tick();const first=f.bank.maps.get(0);
  f.setOnDispose(map=>{if(map!==first)return;if(change==='stream-null')f.p.weatherStream=null;
    else if(change==='stream-disposed')f.stream.disposed=true;else f.bank.dispose();});
  f.setHours(f.F/20);f.bank.service={stream:f.stream,hours:f.p.weatherHours,lastDraws:0,rate:180/f.F,samples:8};f.tick(0);
  assert.equal(first.disposed,true);assert.equal(f.stream.forecastRequests.size,0);assert.equal(f.records.length,1);
});


// Recovery selection uses the same actual Bank source and actual admission /
// revision methods, with a separate authored-F=.5h, R=6Mm slot fixture.
const strip=bytes=>bytes.toString().replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const Stream=PlanetWeatherStream,admission=CloudColumnTileMap.prototype.admission;
function recoveryFixture({bankBytes=runtimeBankBytes,frameHours=.5,width=1024,tileRows=64,footprintSamples=64,
  footprintBatch=2,deadlineAware=true,producer='tile',forecastSteps=3,cacheSteps=2}={}) {
  const events=[],requests=[],maps=[],F=frameHours;
  let onDispose=null,onDraw=null,closing=false;
  const u={uSpeciesMask:{value:-1},uWeatherMap:{value:{}},uColumnMix:{value:0},uColumnsReady:{value:0},uColumnsJointReady:{value:0}};
  const samplers=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'];
  for(const name of samplers)u[name]={value:u.uWeatherMap.value};
  const stream=Object.assign(Object.create(Stream.prototype),{anchor:0,frameHours:F,ready:true,disposed:false,
    frames:new Map(),forecastRequests:new Map(),generations:new WeakMap(),generation:0});
  const planet={R:6e6,weatherHours:0,weatherField:{},weatherStream:stream,volCloudMat:{uniforms:u},volCloudFarMat:{defines:{CLOUD_FAR_CACHE:0}}};
  stream.planet=planet;
  class Scratch {
    constructor(){this.epoch=0;this.lost=false;this.disposed=false;this.observed=0;}
    observeRenderer(){assert.equal(this.disposed,false);this.observed++;}
    dispose(){this.disposed=true;}
  }
  class MapProducer {
    constructor(p,options){
      this.options=options;this.generation=options.hours;this.weatherSources=captureWeatherSources(p.weatherStream,[options.hours]);
      assert.notEqual(this.weatherSources.frames[0].revision,null,'No imaginary source');
      assert.ok(f.bank.endpointHours().includes(options.hours),'No out-of-horizon allocation');
      Object.assign(this,{row:0,footprintCursor:0,draws:0,ready:false,disposed:false,invalidated:false,startedWork:false,startedFinal:false,
        contextEpoch:null,footprintSamples,footprintBatch,target:{textures:[{},{}]},snapshots:[],field:p.weatherField,species:u.uSpeciesMask.value});
      this.total=producer==='rows'?width/4:Math.ceil((width/2)/tileRows)*Math.ceil(footprintSamples/footprintBatch);
      maps.push(this);events.push({kind:'create',hours:p.weatherHours,endpoint:this.generation});
      assert.equal(maps.filter(m=>!m.disposed&&!m.ready).length,1,'Only one partial map');
    }
    admission(){return admission.call(this);}
    sourcesCurrent(){return this.field===planet.weatherField&&this.species===u.uSpeciesMask.value&&weatherSourcesCurrent(this.weatherSources,planet.weatherStream);}
    setProgress(draws){
      this.draws=draws;const perTile=Math.ceil(footprintSamples/footprintBatch);
      if(producer==='rows'){this.row=Math.min(width/2,draws*2);this.footprintCursor=0;}
      else {this.row=Math.min(width/2,Math.floor(draws/perTile)*tileRows);this.footprintCursor=draws%perTile*footprintBatch;}
      this.startedWork=draws>0&&perTile>1;this.startedFinal=draws>=perTile;this.contextEpoch=draws?0:null;this.ready=draws===this.total;
    }
    bakeWork(_renderer,grant){
      assert.equal(this.disposed,false);assert.ok(Number.isInteger(grant)&&grant>=0);let draws=0;
      for(let index=0;index<grant&&!this.ready&&!this.disposed&&!this.invalidated;index++){
        if(!this.sourcesCurrent()){this.invalidated=true;break;}
        this.setProgress(this.draws+1);draws++;onDraw?.(this);
        if(!this.sourcesCurrent()||(f.bank.scratch&&(f.bank.scratch.lost||this.contextEpoch!==f.bank.scratch.epoch)))this.invalidated=true;
      }
      if(this.ready&&!this.invalidated&&!this.disposed&&!this.completed){this.completed=true;events.push({kind:'complete',hours:planet.weatherHours,endpoint:this.generation,draws:this.draws});}
      return {draws};
    }
    bakeSlice(renderer){return this.bakeWork(renderer,1);}
    dispose(){
      if(this.disposed)return;this.disposed=true;
      if(!this.ready&&this.draws)events.push({kind:closing?'cleanup':'cancel',hours:planet.weatherHours,endpoint:this.generation,draws:this.draws});
      onDispose?.(this);
    }
  }
  const Bank=vm.runInNewContext(`${strip(bankBytes)}\nCloudColumnBank;`,{CloudColumnMap:MapProducer,
    CloudColumnTileMap:MapProducer,CloudColumnScratch:Scratch,weatherSourcesCurrent});
  const f={F,u,stream,planet,maps,events,requests,bank:null,draws:0,
    time(hours,{fill=true}={}){
      planet.weatherHours=hours;const current=planet.weatherStream;if(!current)return;
      current.anchor=Math.floor(hours/F)*F;
      for(const hour of current.frames.keys())if(hour<current.anchor-F||hour>current.anchor+3*F)current.frames.delete(hour);
      if(fill)for(let index=0;index<=current.forecastSteps;index++){
        const hour=current.anchor+index*F;if(!current.frames.has(hour))current.frames.set(hour,{hours:hour});
      }
    },
    supply(hour){if(!planet.weatherStream.frames.has(hour))planet.weatherStream.frames.set(hour,{hours:hour});},
    force(rate,samples=8){f.bank.service={stream:planet.weatherStream,hours:planet.weatherHours,lastDraws:0,rate,samples};},
    pair(first,second){
      f.bank.recoveryPair={first,second,sources:captureWeatherSources(planet.weatherStream,[first,second]),epoch:f.bank.scratch.epoch,finishHours:null,feasible:false};
      return f.bank.recoveryPair;
    },
    seed(hour,draws){const map=new MapProducer(planet,{hours:hour,width,tileRows,footprintBatch,scratch:f.bank.scratch});map.setProgress(draws);f.bank.maps.set(hour,map);return map;},
    slot(hours,grant=1,{fill=true,admit=producer==='tile',requestHook=null}={}){
      f.time(hours,{fill});let submitted;
      if(admit)submitted=f.bank.update(null,{admit:(request,produce)=>{
        requests.push({hours,phase:request.phase,maxUnits:request.maxUnits,key:request.key});
        return requestHook?requestHook(request,produce):produce(Math.min(grant,request.maxUnits));
      }});
      else submitted=f.bank.update(null,{workQuanta:grant,allowCreate:grant>0});
      f.draws+=submitted?.draws||0;f.check();return submitted;
    },
    check(){
      assert.ok(f.bank.maps.size<=cacheSteps+1);assert.ok(maps.filter(map=>!map.disposed&&!map.ready).length<=1);
      for(const map of maps)assert.ok(map.disposed||f.bank.maps.get(map.generation)===map,'No live orphan');
      if(u.uColumnsReady.value){
        const a=planet.weatherStream.anchor,first=f.bank.maps.get(a),second=f.bank.maps.get(a+F);
        assert.ok(first?.ready&&second?.ready&&planet.weatherStream.ready);assert.ok(first.sourcesCurrent()&&second.sourcesCurrent());
        assert.equal(u.uOpticalColumns.value,first.target.textures[0]);assert.equal(u.uOpticalColumnsNext.value,second.target.textures[0]);
        assert.ok(planet.weatherHours>=a&&planet.weatherHours<a+F,'Only the true current pair publishes');
      } else for(const name of samplers)assert.equal(u[name].value,u.uWeatherMap.value);
    },
    onDispose(callback){onDispose=callback;},onDraw(callback){onDraw=callback;},
    close(){closing=true;onDispose=null;onDraw=null;f.bank.dispose();assert.ok(maps.every(map=>map.disposed));}
  };
  f.bank=new Bank(planet,{width,producer,tileRows,footprintSamples,footprintBatch,forecastSteps,cacheSteps,deadlineAware});
  f.time(0);fixtures.push(f);return f;
}

let detail={};
const make=options=>recoveryFixture(options);
const pairHours=f=>f.bank.recoveryPair?[f.bank.recoveryPair.first,f.bank.recoveryPair.second]:null;
function recoveryTest(name,work){detail={};test(name,work);Object.assign(results.at(-1),detail);}
recoveryTest('old-policy liveness red becomes bounded candidate bootstrap recovery',()=>{
  const f=make();let firstReady=null,ready=0,maxMaps=0;
  for(let tick=0;tick<540;tick++){f.slot(tick/360,1);if(f.u.uColumnsReady.value){firstReady??=tick/6;ready++;}maxMaps=Math.max(maxMaps,f.bank.maps.size);}
  assert.ok(ready>0);assert.ok(firstReady<90);assert.ok(maxMaps<=3);
  const completed=f.events.filter(row=>row.kind==='complete');assert.ok(completed.length>=2);
  assert.equal(completed[0].endpoint,1);assert.equal(completed[1].endpoint,1.5);
  assert.ok(completed[0].hours>completed[0].endpoint-.5,'Bootstrap recovery is not completion by first use');
  Object.assign(detail,{draws:f.draws,readyFrames:ready,firstReadySeconds:firstReady,maxMaps,completed});
});

recoveryTest('normal high throughput reaches steady first use while bootstrap remains separately late',()=>{
  const f=make();const hz=8,duration=420;
  for(let tick=0;tick<hz*duration;tick++)f.slot(tick/(hz*60),12);
  const complete=new Map(f.events.filter(row=>row.kind==='complete').map(row=>[row.endpoint,row.hours]));
  const due=[];for(let hour=.5;hour-.5<=f.planet.weatherHours;hour+=.5)due.push({hour,deadline:hour-.5,finished:complete.get(hour)});
  const steady=due.filter(row=>row.deadline>=2);assert.ok(steady.length>=8);
  assert.ok(steady.every(row=>row.finished!==undefined&&row.finished<row.deadline));
  assert.ok(due.some(row=>row.deadline===0&&row.finished>row.deadline));
  Object.assign(detail,{steadyDue:steady.length,steadyOnTime:steady.filter(row=>row.finished<row.deadline).length,
    bootstrapLate:due.filter(row=>row.deadline<2&&row.finished>row.deadline).length,
    scope:'CPU ordered-submission first use only; no GPU completion deadline acceptance'});
});

recoveryTest('a feasible partial b is retained rather than blindly restarting c/d',()=>{
  const f=make();f.slot(0,0);f.supply(1.5);const b=f.seed(.5,200);f.force(360);f.slot(0,1);
  assert.equal(f.bank.maps.get(.5),b);assert.equal(b.disposed,false);assert.equal(b.draws,201);
  assert.deepEqual(pairHours(f),[.5,1]);assert.equal(f.bank.recoveryPair.feasible,true);
  assert.equal(f.events.filter(row=>row.kind==='cancel').length,0);
});

recoveryTest('a selected c/d waits for d eligibility and never backfills a rejected b',()=>{
  const f=make();f.slot(0,0);f.supply(1.5);f.time(.4);const c=f.seed(1,256);f.force(10000);const selected=f.pair(1,1.5);
  f.slot(.4,1);assert.equal(f.bank.recoveryPair,selected);assert.equal(f.bank.maps.size,1);assert.equal(f.bank.maps.has(.5),false);
  f.force(0);f.slot(.41,1);assert.equal(f.bank.recoveryPair,selected);assert.equal(f.bank.maps.size,1);
  f.force(10000);f.slot(.5,1);assert.equal(f.bank.recoveryPair,selected);assert.equal(f.bank.maps.get(1),c);
  assert.ok(f.bank.maps.has(1.5));assert.equal(f.bank.maps.has(.5),false);assert.equal(f.u.uColumnsReady.value,0);
  detail.created=f.events.filter(row=>row.kind==='create');
});

recoveryTest('future completed pair publishes only after it becomes the true current pair',()=>{
  const f=make();f.slot(0,0);f.supply(1.5);f.time(.5);f.seed(1,256);f.seed(1.5,256);
  f.force(0);f.slot(.5,0);assert.equal(f.u.uColumnsReady.value,0);
  f.slot(1,0);assert.equal(f.u.uColumnsReady.value,1);
});

recoveryTest('service decline invalidates prediction without an idle or cancellation feedback loop',()=>{
  const f=make();f.slot(0,0);f.time(2/3);f.supply(1.5);const c=f.seed(1,240);const pair=f.pair(1,1.5);f.force(180);
  for(let tick=0;tick<10;tick++){f.slot(2/3+tick/180,1);assert.equal(f.bank.recoveryPair,pair);assert.equal(f.bank.recoveryPair.feasible,false);}
  assert.equal(c.draws,250);assert.equal(c.disposed,false);assert.equal(f.u.uColumnsReady.value,0);
  assert.equal(f.events.filter(row=>row.kind==='cancel').length,0);
});

recoveryTest('late raw d never gets a placeholder or a false feasible deadline',()=>{
  const f=make();f.slot(0,0);f.supply(1.5);f.time(.4);const c=f.seed(1,256);f.pair(1,1.5);f.force(360);
  f.stream.frames.delete(1.5);f.slot(.4,0,{fill:false});assert.equal(f.bank.maps.has(1.5),false);
  assert.equal(f.bank.recoveryPair,null);assert.equal(f.u.uColumnsReady.value,0);
  f.time(7/6,{fill:false});f.supply(1.5);f.supply(2);f.force(360);f.slot(7/6,1,{fill:false});
  assert.equal(f.bank.maps.get(1),c);assert.equal(f.bank.recoveryPair?.feasible||false,false);
  assert.equal(f.u.uColumnsReady.value,0);assert.equal(f.bank.maps.get(1.5)?.draws,1,'Best effort may still calibrate a real late source');
});

recoveryTest('hour jumps invalidate an absolute commitment before stale publication or allocation',()=>{
  const f=make();f.slot(0,0);f.supply(1.5);f.time(.2);const c=f.seed(1,12);f.pair(1,1.5);f.force(360);
  f.slot(2,0);assert.equal(c.disposed,true);assert.equal(f.bank.maps.size,0);assert.equal(f.bank.recoveryPair,null);
  assert.equal(f.u.uColumnsReady.value,0);assert.ok(f.requests.at(-1).phase==='initialize-work');
});

recoveryTest('expiration of an old pair keeps its still-useful second partial',()=>{
  const f=make();f.slot(0,0);f.time(.9);f.seed(.5,256);const second=f.seed(1,200);f.pair(.5,1);
  f.time(1.01);f.force(10000);f.slot(1.01,1);
  assert.equal(second.disposed,false);assert.equal(f.bank.maps.get(1),second);assert.equal(second.draws,201);
  assert.deepEqual(pairHours(f),[1,1.5]);assert.equal(f.bank.recoveryPair.feasible,true);
});

for(const rate of [0,NaN,Infinity,-1])recoveryTest(`unknown or invalid service still makes bounded calibration progress (${rate})`,()=>{
  const f=make();f.slot(0,0);
  for(let tick=0;tick<12;tick++){f.force(rate);f.slot(0,1);}
  assert.equal(f.bank.maps.size,1);assert.equal(f.bank.maps.get(0).draws,12);assert.equal(f.bank.recoveryPair,null);
  assert.equal(f.events.filter(row=>row.kind==='cancel').length,0);
});

recoveryTest('untrained service and temporarily infeasible supply do not become hard admission gates',()=>{
  for(const [rate,samples] of [[10000,7],[1,8]]){
    const f=make();f.slot(0,0);
    for(let tick=0;tick<12;tick++){f.force(rate,samples);f.slot(0,1);}
    assert.equal(f.bank.maps.get(0).draws,12);assert.equal(f.bank.recoveryPair,null);
  }
});

recoveryTest('complete current a/b rebinds under zero service and zero grant',()=>{
  const f=make();f.slot(0,0);f.seed(0,256);f.seed(.5,256);f.force(0);const count=f.maps.length;
  f.slot(0,0);assert.equal(f.u.uColumnsReady.value,1);assert.equal(f.maps.length,count);
});

recoveryTest('zero grants retain the selected pair without allocating snapshots',()=>{
  const f=make();f.slot(0,0);f.supply(1.5);f.force(360);f.slot(0,0);const pair=f.bank.recoveryPair;
  assert.ok(pair);for(let tick=0;tick<8;tick++)f.slot(0,0);
  assert.equal(f.bank.recoveryPair,pair);assert.equal(f.maps.length,0);assert.equal(f.u.uColumnsReady.value,0);
});

recoveryTest('strict retirement equality and adjacent floating-point anchors do not forge feasibility',()=>{
  const equal=512/1.5;
  for(const factor of [1-Number.EPSILON*4,1,1+Number.EPSILON*4]){
    const f=make();f.slot(0,0);f.supply(1.5);f.force(equal*factor);f.slot(0,0);
    assert.equal(Boolean(f.bank.recoveryPair?.feasible),factor>1);
  }
  const f=make();for(const hours of [.5-Number.EPSILON,.5,.5+Number.EPSILON]){f.slot(hours,0);assert.equal(f.stream.anchor,Math.floor(hours/.5)*.5);}
});

recoveryTest('unrelated revisions preserve a commitment while replacing d changes only its source token',()=>{
  const f=make();f.slot(0,0);f.supply(1.5);const c=f.seed(1,20);f.force(360);const pair=f.pair(1,1.5);
  f.stream.frames.set(0,{hours:0});f.slot(0,0,{fill:false});assert.equal(f.bank.recoveryPair,pair);
  f.stream.frames.set(1.5,{hours:1.5});f.slot(0,0,{fill:false});assert.notEqual(f.bank.recoveryPair,pair);
  assert.equal(f.bank.maps.get(1),c);assert.equal(c.disposed,false);assert.deepEqual(pairHours(f),[1,1.5]);
});

for(const change of ['field','species','stream','stream-null','stream-disposed','hour','within-hour','context','retire','dispose'])
recoveryTest(`admission callback ${change} cannot spend an obsolete selected phase`,()=>{
  const f=make();f.slot(0,0);f.supply(1.5);f.force(360);
  f.slot(0,1,{requestHook:(request,produce)=>{
    if(change==='field')f.planet.weatherField={};
    else if(change==='species')f.u.uSpeciesMask.value=0;
    else if(change==='stream')f.planet.weatherStream={...f.stream};
    else if(change==='stream-null')f.planet.weatherStream=null;
    else if(change==='stream-disposed')f.stream.disposed=true;
    else if(change==='hour')f.time(.5);
    else if(change==='within-hour')f.planet.weatherHours=.1;
    else if(change==='context')f.bank.scratch.epoch++;
    else if(change==='retire')f.bank.retireMaps();
    else f.bank.dispose();
    return produce(Math.min(1,request.maxUnits));
  }});
  assert.equal(f.maps.length,0);assert.equal(f.bank.updating,false);assert.equal(f.u.uColumnsReady.value,0);
});

for(const change of ['field','species','stream','hour','context','retire','dispose','nested-update'])
recoveryTest(`cancellation callback ${change} cannot reuse a former choice`,()=>{
  const f=make();f.slot(0,0);f.supply(1.5);const a=f.seed(0,8);f.force(360);let calls=0;
  f.onDispose(map=>{if(map!==a||calls++)return;
    if(change==='field')f.planet.weatherField={};
    else if(change==='species')f.u.uSpeciesMask.value=0;
    else if(change==='stream')f.planet.weatherStream={...f.stream};
    else if(change==='hour')f.time(.5);
    else if(change==='context')f.bank.scratch.epoch++;
    else if(change==='retire')f.bank.retireMaps();
    else if(change==='dispose')f.bank.dispose();
    else f.bank.update(null,{workQuanta:12});
  });
  f.slot(0,1);assert.equal(a.disposed,true);assert.equal(f.bank.updating,false);
  if(change==='nested-update'){assert.equal(f.maps.length,2);assert.equal(f.bank.maps.get(1)?.draws,1);}
  else {assert.equal(f.maps.length,1);assert.equal(f.u.uColumnsReady.value,0);}
});

for(const change of ['field','hour','context','retire','dispose'])recoveryTest(`draw callback ${change} cannot publish a former current pair`,()=>{
  const f=make();f.slot(0,0);f.seed(0,256);const b=f.seed(.5,255);f.force(10000);
  f.onDraw(map=>{if(map!==b)return;
    if(change==='field')f.planet.weatherField={};else if(change==='hour')f.planet.weatherHours=.5;
    else if(change==='context')f.bank.scratch.epoch++;else if(change==='retire')f.bank.retireMaps();else f.bank.dispose();
  });
  f.slot(0,1);assert.equal(f.u.uColumnsReady.value,0);assert.equal(f.bank.updating,false);
});


recoveryTest('forecast release can dispose the bank before renderer observation without touching detached scratch',()=>{
  const f=make();f.slot(0,0);const previous=f.stream,release=previous.releaseForecast;
  const next=Object.assign(Object.create(Object.getPrototypeOf(previous)),{...previous,frames:new Map(previous.frames),forecastRequests:new Map()});
  previous.releaseForecast=function(owner){const value=release.call(this,owner);f.bank.dispose();return value;};
  f.planet.weatherStream=next;assert.doesNotThrow(()=>f.slot(0,1));
  assert.equal(f.maps.length,0);assert.equal(f.bank.updating,false);assert.equal(f.bank.disposed,true);
});

recoveryTest('throwing final forecast release cannot leave the Bank update guard latched',()=>{
  const f=make();f.slot(0,0);const error=Error('expected release failure');f.stream.releaseForecast=()=>{throw error;};
  assert.throws(()=>f.slot(0,0,{requestHook:(_request,produce)=>{f.planet.weatherStream=null;return produce(0);}}),value=>value===error);
  assert.equal(f.bank.updating,false);assert.equal(f.u.uColumnsReady.value,0);
});

recoveryTest('raw two-step demand never invents d and raw3/cache3 keeps its authored four-target cap',()=>{
  for(const [forecastSteps,cacheSteps] of [[2,2],[3,3]]){
    const f=make({forecastSteps,cacheSteps});
    for(let tick=0;tick<960;tick++)f.slot(tick/480,12);
    assert.ok(f.bank.maps.size<=cacheSteps+1);assert.ok(f.maps.every(map=>map.disposed||f.bank.endpointHours().includes(map.generation)));
    assert.equal(f.stream.forecastSteps,forecastSteps);
  }
});

const report={passed:results.every(result=>result.passed),cases:results.length,results,
  sourceSha256:createHash('sha256').update(runtimeBankBytes).digest('hex'),
  verifierSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  scope:'Pure CPU actual Bank, revision/lease/admission and bounded recovery scheduling contracts. Renderer/storage/worker delivery are doubles. Ordered-submit first-use controls are separate from bootstrap recovery; no actual GPU/fence/worker-latency/native-output or performance acceptance.'};
const reportPath=process.argv.find(value=>value.startsWith('--report='))?.slice('--report='.length);
if(reportPath)await writeFile(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
assert.equal(results.filter(result=>!result.passed).length,0,'Column deadline policy contracts failed');
