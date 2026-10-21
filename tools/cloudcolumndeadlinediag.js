// Independent CPU diagnostic, deliberately excluded from npm test. A passing
// frozen-clock bake does not establish that columns can follow the live clock.
// Usage: node tools/cloudcolumndeadlinediag.js <full-report.json> [--out=<directory>]
// Exit 1 records a reproduced deadline failure; exit 2 means invalid evidence
// or a broken model/control. This script never creates a renderer or a worker.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { CelestialClock, TIME_SCALE } from '../src/astronomy.js';
import { PlanetWeatherStream } from '../src/cloud/planet-weather-stream.js';
import { captureWeatherSources, weatherSourcesCurrent } from '../src/cloud/weather-sources.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier='tools/cloudcolumndeadlinediag.js';
const args=process.argv.slice(2),paths=args.filter(arg=>!arg.startsWith('--'));
const outputArgs=args.filter(arg=>arg.startsWith('--out='));
const usage='Usage: node tools/cloudcolumndeadlinediag.js <full-report.json> [--out=<directory>]';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fps=60,durationSeconds=12,ticks=fps*durationSeconds;
let directory;
const report={schema:1,kind:'ideal-column-bank-deadline-model',createdAt:new Date().toISOString(),
  scope:'Pure CPU ideal frame scheduling model, not actual GPU or whole-game throughput. The actual Bank and revision identities run with zero-cost fake maps, instantaneous valid a/b/c forecasts, one update per ideal 60 FPS frame, and the actual CelestialClock at its default TIME_SCALE. No density, optical output, worker latency, frame cost, compilation, route eligibility, or GPU completion is simulated.',
  exitCodes:{0:'Dynamic model reached a ready pair; still not actual GPU throughput acceptance.',
    1:'Known deadline failure reproduced: dynamic model never ready; frozen positive control ready.',
    2:'Invalid input, source mismatch, or failed model/control invariant.'}};

try {
  assert.equal(paths.length,1,usage);
  assert.ok(outputArgs.length<=1&&args.every(arg=>!arg.startsWith('--')||arg.startsWith('--out=')),usage);
  assert.ok(outputArgs.every(arg=>arg.length>'--out='.length),usage);
  directory=resolve(outputArgs[0]?.slice('--out='.length)
    ||`test-results/cloud-column-deadline/${report.createdAt.replace(/[:.]/g,'-')}`);
  const inputPath=resolve(paths[0]),inputBytes=await readFile(inputPath);
  const input=JSON.parse(inputBytes.toString('utf8'));
  report.input={path:inputPath,bytes:inputBytes.length,sha256:sha256(inputBytes),
    beforeSourceDigest:input.before?.sourceDigest,afterSourceDigest:input.after?.sourceDigest,
    identity:input.result?.identity,options:input.result?.options,
    forecast:input.result?.fullAtlas?.forecast};
  report.before=await evidenceFingerprint(verifier);
  assert.match(report.input.beforeSourceDigest||'',/^[a-f0-9]{64}$/,'Input must identify its full runtime source');
  assert.equal(report.input.afterSourceDigest,report.input.beforeSourceDigest,'Input runtime changed during GPU capture');
  assert.equal(report.input.beforeSourceDigest,report.before.sourceDigest,'Input runtime must match the current runtime');
  assert.deepEqual(input.errors,[],'Input GPU capture has errors');
  assert.equal(input.result?.error,0,'Input GPU capture did not finish with GL0');
  assert.equal(input.result?.lost,false,'Input GPU capture lost its context');
  const forecast=report.input.forecast,frameHours=forecast?.frameHours;
  assert.ok(Number.isFinite(frameHours)&&frameHours>0,'Actual measured forecast.frameHours is required');
  assert.ok(Number.isFinite(forecast.hours),'Actual forecast hour is required');
  assert.ok(forecast.streamReady&&forecast.framePresent&&forecast.nextFramePresent,
    'Input must contain a real ready forecast pair');

  const sourcePaths=['src/cloud/cloud-column-bank.js','src/cloud/cloud-column-map.js',
    'src/cloud/weather-sources.js','src/cloud/planet-weather-stream.js','src/astronomy.js','src/main.js'];
  const sourceBytes=await Promise.all(sourcePaths.map(path=>readFile(new URL('../'+path,import.meta.url))));
  report.modelSources=Object.fromEntries(sourcePaths.map((path,i)=>[path,
    {bytes:sourceBytes[i].length,sha256:sha256(sourceBytes[i])}]));
  const bankSource=sourceBytes[0].toString('utf8');
  const mapSource=sourceBytes[1].toString('utf8');
  // The fake map models only this fixed producer shape and row progression.
  // Fail closed if production changes these assumptions instead of silently
  // reporting a deadline for a different producer.
  assert.equal((mapSource.match(/this\.height=width\/2;/g)||[]).length,1);
  assert.equal((mapSource.match(/this\.row\+=rows;/g)||[]).length,1);
  assert.match(mapSource,/if\(this\.row>=this\.height\)\s*\{\s*this\.ready=true;/);
  const executable=bankSource.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  const samplerNames=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'];

  function simulate(frozen) {
    const clock=new CelestialClock('column-deadline-model',{initialHours:forecast.hours,persist:false,frozen});
    const stream={anchor:Math.floor(clock.hours/frameHours)*frameHours,frameHours,ready:true,disposed:false,
      frames:new Map(),generations:new WeakMap(),generation:0,revisionAt:PlanetWeatherStream.prototype.revisionAt};
    const fallback={name:'published-weather-fallback'};
    const u={uSpeciesMask:{value:-1},uWeatherMap:{value:fallback},uColumnMix:{value:0},
      uColumnsReady:{value:0},uColumnsJointReady:{value:0}};
    for(const name of samplerNames)u[name]={value:fallback};
    const planet={weatherHours:clock.hours,weatherField:{},weatherStream:stream,volCloudMat:{uniforms:u}};
    let currentTick=0,maxPending=0,readyTicks=0,firstReady=null,cleaning=false,unsafeDisposals=0;
    const maps=[],timeline=[];
    class IdealMap {
      constructor(p,options) {
        assert.equal(p,planet);
        assert.ok(stream.frames.has(options.hours),'A missing forecast must never be fabricated');
        assert.notEqual(stream.revisionAt(options.hours),null);
        this.width=options.width;this.height=options.width/2;this.row=0;this.ready=false;this.disposed=false;
        this.weatherSources=captureWeatherSources(stream,[options.hours]);
        this.target={textures:[{map:maps.length,plane:0},{map:maps.length,plane:1}]};
        this.record={index:maps.length,hours:options.hours,revision:stream.revisionAt(options.hours),
          createdTick:currentTick,createdSeconds:currentTick/fps,bakeTicks:0,row:0,ready:false};
        maps.push(this.record);
      }
      bakeSlice(renderer,rows) {
        assert.equal(renderer,null);assert.ok(!this.disposed&&!this.ready);
        this.row+=rows;this.record.row=this.row;this.record.bakeTicks++;
        if(this.row>=this.height) {
          this.ready=true;this.record.ready=true;this.record.completedTick=currentTick;
          this.record.completedSeconds=currentTick/fps;
        }
      }
      dispose() {
        if(this.disposed)return;
        if(samplerNames.some(name=>this.target.textures.includes(u[name].value)))unsafeDisposals++;
        this.disposed=true;this.record.disposedTick=currentTick;
        this.record.disposedSeconds=currentTick/fps;this.record.disposalReason=cleaning?'model-cleanup':'bank-retirement';
      }
    }
    const Bank=vm.runInNewContext(`${executable}\nCloudColumnBank;`,
      {CloudColumnMap:IdealMap,weatherSourcesCurrent},{timeout:1000});
    const bank=new Bank(planet);planet.cloudColumnMap=bank;
    const options={width:bank.width,height:bank.width/2,rowsPerTick:bank.rows,footprintSamples:bank.footprintSamples};
    assert.equal(options.width,input.result.options.width,'Measured and scheduled widths must agree');
    assert.equal(options.height,input.result.options.height);
    assert.equal(options.rowsPerTick,input.result.options.batchRows);
    assert.equal(options.footprintSamples,input.result.options.footprintSamples);
    let lastAnchor=null,lastReady=false;
    try {
      for(currentTick=1;currentTick<=ticks;currentTick++) {
        clock.update(1/fps,true);planet.weatherHours=clock.hours;
        const a=Math.floor(clock.hours/frameHours)*frameHours,b=a+frameHours,c=b+frameHours;
        stream.anchor=a;
        // Match the real stream's retention envelope. Overlapping forecast
        // objects retain their revision; the worker idealization only removes
        // delivery latency, never replaces snapshots with published textures.
        for(const hour of stream.frames.keys())if(hour<a-frameHours||hour>b+frameHours*2)stream.frames.delete(hour);
        for(const hours of [a,b,c])if(!stream.frames.has(hours))stream.frames.set(hours,{hours});
        stream.ready=true;
        assert.ok([a,b,c].every(hours=>stream.revisionAt(hours)!==null));
        bank.update(null);
        const pending=[...bank.maps.values()].filter(map=>!map.ready).length;
        maxPending=Math.max(maxPending,pending);assert.ok(pending<=1,'At most one map may be under construction');
        const ready=u.uColumnsReady.value===1;
        if(ready) {
          readyTicks++;firstReady??={tick:currentTick,seconds:currentTick/fps,hours:clock.hours,anchor:a};
          assert.ok(bank.maps.get(a)?.ready&&bank.maps.get(b)?.ready);
          assert.equal(u.uColumnsJointReady.value,1);
        } else assert.ok(samplerNames.every(name=>u[name].value===fallback));
        if(a!==lastAnchor||ready!==lastReady||currentTick===ticks) {
          timeline.push({tick:currentTick,seconds:currentTick/fps,hours:clock.hours,anchor:a,ready,
            maps:[...bank.maps].map(([hours,map])=>({hours,row:map.row,ready:map.ready}))});
        }
        lastAnchor=a;lastReady=ready;
      }
      return {frozen,fps,ticks,durationSeconds,clockStartHours:forecast.hours,clockEndHours:clock.hours,
        timeScale:clock.scale,options,firstReady,readyTicks,neverReady:readyTicks===0,maxPending,
        completedEndpoints:maps.filter(map=>map.ready).length,
        retiredIncompleteEndpoints:maps.filter(map=>!map.ready&&map.disposalReason==='bank-retirement').length,
        largestEndpointProgressRows:Math.max(0,...maps.map(map=>map.row)),
        maps,timeline,unsafeDisposals};
    } finally {
      currentTick=ticks;cleaning=true;bank.dispose();
      assert.equal(unsafeDisposals,0,'Unbind before retiring targets');
    }
  }

  const dynamic=simulate(false),frozen=simulate(true);
  report.model={fps,durationSeconds,ticks,actualFrameHours:frameHours,timeScale:TIME_SCALE,
    forecastIntervalRealSeconds:frameHours*3600/TIME_SCALE,
    ticksPerEndpoint:Math.ceil(dynamic.options.height/dynamic.options.rowsPerTick),
    assumptions:{gpuCostMs:0,workerCostMs:0,compileCostMs:0,frameOverrunMs:0,
      requestedForecasts:'Real a/b/c absolute-hour identities, instantly available and stable per revision',
      producer:'Fake output textures, actual default dimensions/row budget and bank scheduling',
      route:'Assume far eligibility and one bank update on every frame; no missing updates'}};
  report.model.endpointMinimumRealSeconds=report.model.ticksPerEndpoint/fps;
  report.model.initialPairMinimumTicks=report.model.ticksPerEndpoint*2;
  report.model.initialPairMinimumRealSeconds=report.model.initialPairMinimumTicks/fps;
  report.model.endpointTickCostToForecastIntervalRatio=report.model.endpointMinimumRealSeconds/report.model.forecastIntervalRealSeconds;
  report.dynamic=dynamic;report.frozen=frozen;
  assert.ok(frozen.firstReady,'Frozen positive control must reach an actual complete pair');
  assert.equal(frozen.firstReady.tick,report.model.initialPairMinimumTicks,
    'Frozen first pair must witness the actual single-map row schedule');
  report.after=await evidenceFingerprint(verifier);
  assert.equal(report.after.sourceDigest,report.before.sourceDigest,'Runtime changed during CPU capture');
  assert.equal(report.after.verifierDigest,report.before.verifierDigest,'Diagnostic changed during capture');
  report.deadlineSatisfied=dynamic.readyTicks>0;
  report.knownDeadlineFailure=dynamic.neverReady;
  report.status=dynamic.neverReady?'known-deadline-failure':'ready-within-ideal-model';
  report.conclusion=dynamic.neverReady
    ?'At the measured forecast spacing and default row budget, no live-clock sampling pair became ready during the ideal 12-second 60 FPS model, even with instantaneous forecasts and zero GPU cost. The frozen positive control completed the pair. This demonstrates an architectural scheduling/deadline deficit; frozen native parity or faster individual bakes cannot establish real-time catch-up.'
    :'The ideal model reached a pair. This is not proof of sustainable real-time catch-up or actual GPU/whole-game throughput.';
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,sourceDigest:report.before.sourceDigest,
    actualFrameHours:frameHours,forecastIntervalRealSeconds:report.model.forecastIntervalRealSeconds,
    endpointMinimumRealSeconds:report.model.endpointMinimumRealSeconds,
    initialPairMinimumRealSeconds:report.model.initialPairMinimumRealSeconds,
    dynamicReadyTicks:dynamic.readyTicks,frozenFirstReadyTick:frozen.firstReady.tick,
    report:`${directory}/report.json`},null,2));
  process.exitCode=dynamic.neverReady?1:0;
} catch(error) {
  report.status='invalid-diagnostic';report.failure={message:String(error.message||error),stack:String(error.stack||error)};
  if(directory) {
    await mkdir(directory,{recursive:true});
    await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));
  }
  console.error(report.failure.stack);process.exitCode=2;
}
