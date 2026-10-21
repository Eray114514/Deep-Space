// Exercise the production scheduler with real forecast revision identities.
// The fake map models incremental completion/retirement; no renderer or GPU.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PlanetWeatherStream } from '../src/cloud/planet-weather-stream.js';
import { captureWeatherSources, weatherSourcesCurrent } from '../src/cloud/weather-sources.js';

const code=(await readFile('src/cloud/cloud-column-bank.js','utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const samplers=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'];
const fixtures=[];
function stream(hours=[],ready=false,anchor=0) {
  return {anchor,frameHours:1,ready,disposed:false,frames:new Map(hours.map(hour=>[hour,{hour}])),
    generations:new WeakMap(),generation:0,revisionAt:PlanetWeatherStream.prototype.revisionAt};
}
function fixture(source=stream()) {
  const records=[],leases=[];
  let liveSnapshots=0,maxSnapshots=0;
  const u={uSpeciesMask:{value:-1},uWeatherMap:{value:{published:true}},uColumnMix:{value:-1},
    uColumnsReady:{value:0},uColumnsJointReady:{value:0}};
  for(const name of samplers)u[name]={value:u.uWeatherMap.value};
  const far={defines:{CLOUD_FAR_CACHE:0},version:0,set needsUpdate(value){if(value===true)this.version++;}};
  const p={weatherField:{},weatherHours:.25,weatherStream:source,volCloudMat:{uniforms:u},volCloudFarMat:far,
    cloudSpeciesTex:{image:{data:new Float32Array(4)}}};
  class FakeMap {
    constructor(planet,options) {
      assert.equal(planet,p);assert.equal(options.width,1024);assert.equal(options.footprintSamples,64);
      assert.ok(planet.weatherStream.frames.has(options.hours),'Never substitute the published field for a missing forecast');
      assert.notEqual(planet.weatherStream.revisionAt(options.hours),null);
      Object.assign(this,{hours:options.hours,row:0,ready:false,disposed:false,options,
        weatherSources:captureWeatherSources(planet.weatherStream,[options.hours]),
        target:{textures:[{plane:0},{plane:1}]}});
      records.push(this);liveSnapshots++;maxSnapshots=Math.max(maxSnapshots,liveSnapshots);
      assert.equal(liveSnapshots,1,'Only one snapshot may be under construction');
    }
    bakeSlice(renderer,rows) {
      assert.equal(renderer,null);assert.equal(rows,2);assert.equal(this.disposed,false);assert.equal(this.ready,false);
      this.row+=rows;
      if(this.row>=6) {
        this.ready=true;liveSnapshots--;
        if(!this.options.programOwner.columns) {
          const lease={uniforms:{},disposals:0,dispose(){this.disposals++;}};
          leases.push(lease);this.options.programOwner.columns=lease;
        }
      }
    }
    dispose() {
      if(this.disposed)return;
      assert.ok(samplers.every(name=>!this.target.textures.includes(u[name].value)),
        'Unbind every sampler before retiring its target');
      this.disposed=true;if(!this.ready)liveSnapshots--;
    }
  }
  const {Bank,setCloudFarCacheEnabled}=vm.runInNewContext(`${code}\n({Bank:CloudColumnBank,setCloudFarCacheEnabled});`,
    {CloudColumnMap:FakeMap,weatherSourcesCurrent});
  const bank=new Bank(p);p.cloudColumnMap=bank;
  const f={p,u,bank,records,leases,setCloudFarCacheEnabled,tick(){bank.update(null);assert.ok(liveSnapshots<=1);},
    finish(hour) {
      for(let i=0;i<12&&!bank.maps.get(hour)?.ready;i++)this.tick();
      assert.equal(bank.maps.get(hour)?.ready,true,`Endpoint ${hour} must finish`);
      return bank.maps.get(hour);
    },unbound() {
      assert.equal(u.uColumnsReady.value,0);assert.equal(u.uColumnsJointReady.value,0);
      assert.ok(samplers.every(name=>u[name].value===u.uWeatherMap.value));
    },bound(first,second) {
      assert.equal(u.uColumnsReady.value,1);assert.equal(u.uColumnsJointReady.value,1);
      assert.equal(u.uOpticalColumns.value,first.target.textures[0]);
      assert.equal(u.uColumnHeights.value,first.target.textures[1]);
      assert.equal(u.uOpticalColumnsNext.value,second.target.textures[0]);
      assert.equal(u.uColumnHeightsNext.value,second.target.textures[1]);
    },close() {
      const changed=far.defines.CLOUD_FAR_CACHE!==0,version=far.version;
      bank.dispose();bank.dispose();this.unbound();assert.equal(bank.maps.size,0);
      assert.equal(far.defines.CLOUD_FAR_CACHE,0);assert.equal(far.version,version+Number(changed));
      assert.equal(liveSnapshots,0);assert.ok(maxSnapshots<=1);
      assert.ok(records.every(map=>map.disposed));assert.ok(leases.every(lease=>lease.disposals===1));
      assert.equal(p.cloudColumnMap,null);
    }};
  fixtures.push(f);return f;
}

try {
  // Missing a does not hold up real b; later a must not overlap an in-flight b.
  const f=fixture();
  for(let i=0;i<3;i++)f.tick();
  assert.equal(f.records.length,0);f.unbound();
  f.p.weatherStream.frames.set(1,{hour:1});f.tick();
  const second=f.bank.maps.get(1);assert.equal(second.row,2);f.unbound();
  f.p.weatherStream.frames.set(0,{hour:0});f.tick();
  assert.equal(second.row,4);assert.equal(f.bank.maps.has(0),false);
  f.tick();assert.equal(second.ready,true);assert.equal(f.records.length,1);
  const first=f.finish(0);f.unbound();
  const created=f.records.length;
  f.p.weatherStream.ready=true;f.tick();f.bound(first,second);assert.equal(f.u.uColumnMix.value,.25);
  f.p.weatherStream.ready=false;f.tick();f.unbound();
  assert.equal(first.disposed,false);assert.equal(second.disposed,false);
  f.p.weatherStream.ready=true;f.tick();f.bound(first,second);
  assert.equal(f.records.length,created,'Restored readiness reuses both endpoints');
  f.p.weatherHours=-1;f.tick();assert.equal(f.u.uColumnMix.value,0);
  f.p.weatherHours=3;f.tick();assert.equal(f.u.uColumnMix.value,1);

  // Same-hour frame replacement invalidates that endpoint only. Prefer an
  // existing partial over allocating a replacement snapshot alongside it.
  const g=fixture(stream([0,1,2]));
  const oldFirst=g.finish(0);g.tick();const partial=g.bank.maps.get(1);
  g.p.weatherStream.frames.set(0,{hour:0,replacement:true});g.tick();
  assert.equal(oldFirst.disposed,true);assert.equal(g.bank.maps.get(1),partial);
  assert.equal(partial.row,4);assert.equal(g.bank.maps.has(0),false);g.unbound();
  g.tick();assert.equal(partial.ready,true);
  const replacement=g.finish(0);assert.notEqual(replacement,oldFirst);
  assert.equal(g.bank.maps.get(1),partial);
  g.p.weatherStream.ready=true;g.tick();g.bound(replacement,partial);
  const forecast=g.finish(2);g.bound(replacement,partial);
  g.p.weatherStream.frames.set(2,{hour:2,replacement:true});g.tick();
  assert.equal(forecast.disposed,true);assert.equal(g.bank.maps.get(0),replacement);
  assert.equal(g.bank.maps.get(1),partial);g.bound(replacement,partial);

  // Field/species changes retire all old physical inputs and the owned lease.
  for(const changed of ['field','species']) {
    const h=fixture(stream([0,1,2],true));h.finish(1);h.tick();
    const old=[...h.bank.maps.values()],lease=h.bank.programs.columns;
    if(changed==='field')h.p.weatherField={replacement:true};else h.u.uSpeciesMask.value=4;
    h.tick();h.unbound();assert.ok(old.every(map=>map.disposed));assert.equal(lease.disposals,1);
    assert.equal(h.bank.maps.size,1);assert.equal(h.bank.maps.get(0).row,2);
    assert.equal(h.bank.fieldOwner,h.p.weatherField);assert.equal(h.bank.speciesMask,h.u.uSpeciesMask.value);
  }

  // Stream identity is independent of matching hour/revision numbers. A new
  // not-ready stream may produce only the real endpoint it already contains.
  const h=fixture(stream([0,1,2],true));h.finish(1);h.tick();
  const old=[...h.bank.maps.values()],nextStream=stream([1],false);
  h.p.weatherStream=nextStream;h.tick();h.unbound();
  assert.ok(old.every(map=>map.disposed));assert.equal(h.bank.maps.size,1);
  assert.equal(h.bank.maps.get(1).weatherSources.stream,nextStream);
  assert.equal(h.bank.maps.get(1).row,2);
  const retired=h.bank.maps.get(1);nextStream.disposed=true;nextStream.ready=true;h.tick();
  assert.equal(retired.disposed,true);assert.equal(h.bank.maps.size,0);h.unbound();
  const count=h.records.length;h.tick();assert.equal(h.records.length,count);
  h.p.weatherStream=null;h.tick();h.unbound();assert.equal(h.records.length,count);

  // Clock jumps retire the complete and partial old generation before baking
  // a new pair; absent c is never synthesized from current published textures.
  const j=fixture(stream([0,1,2],true));j.finish(0);j.tick();
  const beforeJump=[...j.bank.maps.values()];
  j.p.weatherStream.anchor=10;j.p.weatherHours=10.4;
  j.p.weatherStream.frames.set(10,{hour:10});j.p.weatherStream.frames.set(11,{hour:11});
  j.tick();j.unbound();assert.ok(beforeJump.every(map=>map.disposed));
  const jumpFirst=j.finish(10),jumpSecond=j.finish(11);j.bound(jumpFirst,jumpSecond);
  for(let i=0;i<3;i++)j.tick();
  assert.equal(j.bank.maps.has(12),false);assert.ok(j.records.every(map=>map.hours!==12));
  assert.ok(Math.abs(j.u.uColumnMix.value-.4)<1e-12);
  j.p.weatherStream.ready=false;j.p.weatherStream.frames.set(12,{hour:12});j.tick();j.unbound();
  assert.equal(j.bank.maps.get(12).row,2);
  j.p.weatherStream.ready=true;j.tick();j.bound(jumpFirst,jumpSecond);

  // Even an existing frame cannot produce a snapshot without a revision.
  const invalid=stream([0,1],true),revisionAt=invalid.revisionAt;
  invalid.revisionAt=function(hour){return hour===0?null:revisionAt.call(this,hour);};
  const k=fixture(invalid);k.tick();
  assert.equal(k.bank.maps.has(0),false);assert.equal(k.bank.maps.get(1).row,2);k.unbound();
  const existing=k.finish(1);invalid.revisionAt=revisionAt;
  const recovered=k.finish(0);k.bound(recovered,existing);

  // Disposal resets the cached shader of a retiring/fading body. Ordinary
  // sampler unbinds do not toggle it and cause a version change every frame.
  const l=fixture(stream([0,1],true)),far=l.p.volCloudFarMat;
  l.setCloudFarCacheEnabled(l.p,false);assert.equal(far.version,0);
  l.setCloudFarCacheEnabled(l.p,true);assert.equal(far.defines.CLOUD_FAR_CACHE,1);assert.equal(far.version,1);
  l.setCloudFarCacheEnabled(l.p,true);l.bank.unbind();l.bank.unbind();
  assert.equal(far.defines.CLOUD_FAR_CACHE,1);assert.equal(far.version,1);
  l.setCloudFarCacheEnabled(null,false);l.setCloudFarCacheEnabled({},false);
  const undefinedDefine={volCloudFarMat:{version:0,set needsUpdate(value){if(value===true)this.version++;}}};
  l.setCloudFarCacheEnabled(undefinedDefine,false);l.setCloudFarCacheEnabled(undefinedDefine,false);
  assert.equal(undefinedDefine.volCloudFarMat.defines.CLOUD_FAR_CACHE,0);
  assert.equal(undefinedDefine.volCloudFarMat.version,1);

} finally {
  for(const f of fixtures)f.close();
}
console.log('PASS: real column-bank logic starts available forecast endpoints before pair readiness, continues one partial, skips missing/invalid revisions, atomically binds complete ready pairs, reuses valid endpoints, and retires source/field/species/stream/time replacements with safe samplers and an idempotent far-cache define reset; no GPU.');
