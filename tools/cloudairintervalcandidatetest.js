// Pure CPU/source control for the tool-only Far interval candidate.
// Does not execute GLSL or establish HDR, compiler cost, or player acceptance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { cloudAirIntervalCandidate } from './cloud-air-interval-candidate.js';
import { atmosphereSampleBoundary } from '../src/atmosphere-quadrature.js';

const input='docs/baselines/foundation-cloud-readiness-2026-10-26/candidate-page/failure.json.gz';
const report=JSON.parse(gunzipSync(await readFile(input)));
const probe=report.finalState?.probe||report.state.probe;
const shaders=[0,1].map(cache=>probe.shaders.find(s=>s.type===35632
  && s.source.includes('#define CLOUD_FAR_VIEW 1')&&s.source.includes(`#define CLOUD_FAR_CACHE ${cache}`)));
assert.ok(shaders.every(s=>s&&!s.truncated&&s.source.length===s.sourceLength));
function body(source,name) {
  const matches=[...source.matchAll(new RegExp('\\b(?:void|float|vec[234]|CloudColumnPayload)\\s+'+name+'\\s*\\([^;]*?\\)\\s*\\{','g'))];
  assert.equal(matches.length,1,name);
  const start=matches[0].index,brace=source.indexOf('{',start);let at=brace+1,depth=1;
  while(depth&&at<source.length){const c=source[at++];if(c==='{')depth++;else if(c==='}')depth--;}
  assert.equal(depth,0);return source.slice(start,at);
}
for(const shader of shaders) {
  const next=cloudAirIntervalCandidate(shader.source);
  for(const name of ['airSample','mediumStep','cloudAirTransport','cloudAirGap','cloudAirAdvance',
    'air_localStellarVisibility','localStellarVisibility','cloudExtinctionAt','cloudCombinedSource'])
    assert.equal(body(next,name),body(shader.source,name),'Unchanged physical/stateful kernel '+name);
  for(const name of ['cloudCachedColumn','cloudFarColumn'])
    assert.equal(body(next,name).split('{')[0].trim(),body(shader.source,name).split('{')[0].trim(),'Original callable signature '+name);
  assert.equal(body(next,'cloudFarAirInterval').match(/\bairSample\(/g).length,1);
  assert.equal(body(next,'cloudFarAirInterval').match(/\bmediumStep\(/g).length,1);
  assert.equal(body(next,'cloudColumnResult').match(/\bcloudFarAirInterval\(/g).length,1);
  assert.ok(body(next,'cloudColumnResult').includes('#if CLOUD_FAR_CACHE\n        payload=cloudPrepareCachedColumn'));
}

// Independent transcription of the original front loop and reuseCells=false
// cloudAirTransport state machine, recording each physical sample argument.
function original({a,b,closest,steps,rayleigh,mie,enabled,gap}) {
  const calls=[];
  if(enabled<.5||b<=a)return calls;
  if(!gap){let previous=a;for(let i=0;i<Math.trunc(steps);i++){
    const next=atmosphereSampleBoundary(a,b,closest,(i+1)/steps);
    calls.push({middle:(previous+next)*.5,distance:next-previous});previous=next;
  }return calls;}
  const cursor=a;let gapReady=false,gapPrevious=a,gapStart=a,gapIndex=0,gapCount=0,gapStride=0,quadratic=false;
  for(let work=0;work<64+Math.trunc(steps);work++){
    let next=cursor,sampleLength=0,middle=0;
    if(!gapReady){gapStart=cursor;gapPrevious=cursor;const cellLimit=Math.min(rayleigh,mie)*.25;
      quadratic=b-cursor>cellLimit*Math.min(32,steps);
      gapCount=quadratic?Math.trunc(steps):Math.trunc(Math.min(32,Math.max(1,Math.ceil((b-cursor)/Math.max(cellLimit,50)))));
      gapStride=(b-cursor)/gapCount;gapReady=true;}
    if(gapIndex>=gapCount)break;
    if(quadratic){next=atmosphereSampleBoundary(gapStart,b,closest,(gapIndex+1)/steps);
      sampleLength=next-gapPrevious;middle=(gapPrevious+next)*.5;
    }else{sampleLength=gapStride;middle=gapStart+(gapIndex+.5)*gapStride;}
    calls.push({middle,distance:sampleLength});gapPrevious=next;gapIndex++;
  }return calls;
}
function candidate({a,b,closest,steps,rayleigh,mie,enabled,gap}) {
  const calls=[];if(enabled<.5||b<=a)return calls;
  let quadratic=true,count=Math.trunc(steps),stride=0,previous=a;
  if(gap){const cellLimit=Math.min(rayleigh,mie)*.25;
    quadratic=b-a>cellLimit*Math.min(32,steps);
    count=quadratic?Math.trunc(steps):Math.trunc(Math.min(32,Math.max(1,Math.ceil((b-a)/Math.max(cellLimit,50)))));
    stride=(b-a)/count;}
  for(let i=0;i<count;i++){let next=a,distance,middle;
    if(quadratic){next=atmosphereSampleBoundary(a,b,closest,(i+1)/steps);distance=next-previous;middle=(previous+next)*.5;}
    else{distance=stride;middle=a+(i+.5)*stride;}
    calls.push({middle,distance});previous=next;
  }return calls;
}
let cases=0,nodes=0,linear=0,quadratic=0;
for(const gap of [false,true])for(const steps of [24,32,48])for(const [rayleigh,mie] of [[8000,1200],[5000,160],[2000,400]])
for(const a of [-250,0,123.5])for(const closest of [-10000,100,50000])for(const enabled of [0,.5,1]){
  const threshold=Math.min(rayleigh,mie)*.25*Math.min(32,steps);
  for(const length of [-1,0,1,49.99,50,50.01,threshold-.001,threshold,threshold+.001,100000]){
    const input={a,b:a+length,closest,steps,rayleigh,mie,enabled,gap};
    const old=original(input),next=candidate(input);assert.deepEqual(next,old,JSON.stringify(input));
    cases++;nodes+=next.length;
    if(gap&&next.length){if(length>threshold)quadratic++;else linear++;}
  }
}
let schedules=0;
for(const ready of [0,.5,.50001,1])for(const footprint of [0,899.999,900,900.001,2399.999,2400,2400.001,10000]) {
  const old=ready>.5&&footprint>2400?[true]:[false,...(ready>.5&&footprint>900?[true]:[])];
  const cachedOnly=ready>.5&&footprint>2400,useCached=ready>.5&&footprint>900,next=[];
  for(let method=cachedOnly?1:0;method<(useCached?2:1);method++)next.push(method>0);
  assert.deepEqual(next,old);schedules++;
}
console.log(JSON.stringify({passed:true,sourceVariants:2,intervalCases:cases,sampleNodes:nodes,linearGapCases:linear,
  quadraticGapCases:quadratic,dispatchCases:schedules,boundary:'CPU/source scheduling only. No native compilation, FP32/HDR equality or performance acceptance.'}));
