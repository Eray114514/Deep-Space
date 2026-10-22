// Execute the actual Bank scheduler with real revision helpers, an authored
// clock and zero-GPU Map/Scratch doubles. This is policy, never performance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PlanetWeatherStream } from '../src/cloud/planet-weather-stream.js';
import { captureWeatherSources, weatherSourcesCurrent } from '../src/cloud/weather-sources.js';

const source=(await readFile('src/cloud/cloud-column-bank.js','utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const samplerNames=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'];
const fixtures=[],results=[];
function fixture({deadlineAware=true,producer='tile',missing=[]}={}) {
  const F=.03125,records=[];let live=0,maxLive=0,maxDelivered=Infinity,onDispose=null;
  const u={uSpeciesMask:{value:-1},uWeatherMap:{value:{published:true}},uColumnMix:{value:0},
    uColumnsReady:{value:0},uColumnsJointReady:{value:0}};
  for(const name of samplerNames)u[name]={value:u.uWeatherMap.value};
  const stream={anchor:0,frameHours:F,ready:true,disposed:false,frames:new Map(),
    generations:new WeakMap(),generation:0,revisionAt:PlanetWeatherStream.prototype.revisionAt};
  for(const hour of [0,F,2*F])if(!missing.includes(hour))stream.frames.set(hour,{hours:hour});
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
  const bank=new Bank(p,{deadlineAware,producer,tileRows:64,footprintBatch:2});p.cloudColumnMap=bank;
  const f={p,u,stream,bank,records,F,
    setMaxDelivered(value){maxDelivered=value;},
    setOnDispose(callback){onDispose=callback;},
    setHours(hours,{fill=true}={}) {
      p.weatherHours=hours;const current=p.weatherStream;current.anchor=Math.floor(hours/F)*F;
      for(const hour of current.frames.keys())if(hour<current.anchor-F||hour>current.anchor+3*F)current.frames.delete(hour);
      if(fill)for(const hour of [current.anchor,current.anchor+F,current.anchor+2*F])
        if(!current.frames.has(hour))current.frames.set(hour,{hours:hour});
    },
    tick(delta=0,grant=1,options={}) {
      this.setHours(p.weatherHours+delta,options);const result=bank.update(null,{workQuanta:grant,allowCreate:options.allowCreate??true});
      this.check();return result;
    },
    check() {
      assert.ok(live<=1);assert.ok(bank.maps.size<=3);
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
  assert.ok(f.records.some(map=>map.generation===f.F),'Observed insufficient service must eventually prioritize b');
  assert.equal(f.bank.maps.has(0),false,'An infeasible partial a must retire');
}

test('opt-in waits for eight positive game-time observations before preferring a future pair',()=>{
  const f=fixture();f.tick();const first=f.bank.maps.get(0);
  for(let count=0;count<7;count++)f.tick(f.F/20);
  assert.equal(first.disposed,false);assert.equal(f.bank.maps.get(0),first);
  for(let count=0;count<5;count++)f.tick(f.F/20);
  assert.equal(first.disposed,true);assert.equal(f.bank.maps.has(0),false);assert.ok(f.bank.maps.get(f.F));
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

test('a warmed insufficient estimate remains active without a source or clock reset',()=>{
  const f=fixture();trainSlow(f);f.drainOwnedMaps();const start=f.records.length;f.tick(f.F/100,1);
  assert.equal(f.records[start].generation,f.F);assert.equal(f.bank.maps.has(0),false);
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
  const f=fixture();trainSlow(f);f.tick(0,256);assert.equal(f.bank.maps.get(f.F)?.ready,true);
  f.tick(0,256);assert.equal(f.bank.maps.get(2*f.F)?.ready,true);assert.equal(f.u.uColumnsReady.value,0);
  f.setHours(f.F);f.p.weatherStream.ready=false;f.tick(0,0,{allowCreate:false});assert.equal(f.u.uColumnsReady.value,0);
  f.p.weatherStream.ready=true;f.tick(0,0,{allowCreate:false});assert.equal(f.u.uColumnsReady.value,1);
});

for(const change of ['field','species','stream','stream-null','stream-disposed','anchor','context-epoch','context-lost','bank-dispose'])
  test(`a cancellation callback changing ${change} prevents work under the obsolete admission decision`,()=>{
    const f=fixture();f.tick();const first=f.bank.maps.get(0);let callbacks=0;
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
    for(let count=0;count<12&&!callbacks;count++)f.tick(f.F/20);
    assert.equal(callbacks,1);assert.equal(first.disposed,true);
    assert.equal(f.records.length,1,'Do not allocate from a stale plan after user resource callbacks');
    assert.equal(f.u.uColumnsReady.value,0);
  });

console.log(JSON.stringify({passed:results.every(result=>result.passed),cases:results.length,results,
  scope:'Pure CPU scheduling contracts: actual Bank logic, real absolute-hour/revision helpers, authored clock and zero-GPU FakeMap/Scratch. No measured service rate, GPU budget, worker latency, cloud output or dynamic performance acceptance.'},null,2));
assert.equal(results.filter(result=>!result.passed).length,0,'Column deadline policy contracts failed');
