// Forecast completion must not turn an identical active pair into an upload.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlanetWeatherStream } from '../src/cloud/planet-weather-stream.js';
import { CloudLightBank } from '../src/cloud/cloud-light-bank.js';
import { PRODUCTION_PARAMETER_LAYERS, productionStorageLayers, CANDIDATE_WIDTH,
  CANDIDATE_HEIGHT, CANDIDATE_LAYERS } from '../src/cloud/production-bands.js';

const originalWorker = globalThis.Worker;
class WorkerFixture {
  messages=[];
  postMessage(message) {this.messages.push(message);}
  terminate() {this.terminated=true;}
  deliver(data) {this.onmessage({data});}
}
globalThis.Worker=WorkerFixture;
try {
  let windBinds=0,atlasBinds=0;
  const texture = () => {
    const t = new THREE.DataTexture(new Float32Array(16),2,2,THREE.RGBAFormat,THREE.FloatType);
    t.userData.weatherAtlas={width:2,height:2,data:new Float32Array(16),scale:1};return t;
  };
  const p={weatherHours:.25,cloudAtlasWidth:2,
    cloudShadowTex:texture(),cloudWeatherHiTex:texture(),
    weatherField:{windRadiansPerHour:0,namespace:'fixture',streamDescriptor:{},surfaceRangeMeters:1,
      bindWind(){windBinds++;},bindAtlases(){atlasBinds++;}},
    cloudSpeciesTex:new THREE.DataArrayTexture(new Float32Array(16*PRODUCTION_PARAMETER_LAYERS),2,2,PRODUCTION_PARAMETER_LAYERS),
    volCloudMat:{uniforms:{uCloudAdvectionPhase:{value:0}}}};
  const stream=new PlanetWeatherStream(p);p.weatherStream=stream;
  const frame=(hours,offset=0)=>({token:stream.token,hours,width:2,height:2,
    wind:Float32Array.from({length:12},(_,i)=>hours*10+i+offset),
    bands:Float32Array.from({length:16*PRODUCTION_PARAMETER_LAYERS},(_,i)=>hours*2+i*.125+offset),
    low:Float32Array.from({length:16},(_,i)=>hours*2+i+offset),
    high:Float32Array.from({length:16},(_,i)=>hours*4+i+offset)});
  const versions=()=>[p.cloudSpeciesTex,p.cloudShadowTex,p.cloudWeatherHiTex].map(t=>t.version);
  stream.update(p.weatherHours);
  stream.worker.deliver(frame(0));assert.equal(stream.ready,false);
  stream.worker.deliver(frame(.5));assert.equal(stream.ready,true);
  const firstVersions=versions();assert.equal(windBinds,1);assert.equal(atlasBinds,1);
  const initialBands=p.cloudSpeciesTex.image.data.slice();
  assert.equal(initialBands[3],.875);
  // North-first GPU rows and south-first CPU atlas still share exact values.
  assert.equal(p.cloudWeatherHiTex.image.data[0],9);
  stream.worker.deliver(frame(1));
  stream.update(p.weatherHours,true);
  assert.deepEqual(versions(),firstVersions,'Prefetch or duplicate force dirtied the active textures');
  assert.equal(windBinds,1);assert.equal(atlasBinds,1);
  assert.deepEqual(p.cloudSpeciesTex.image.data,initialBands);
  // A changed frame at the same hour must commit; timestamps alone are not
  // an identity. Time changes and bracket turnover must also keep working.
  stream.worker.deliver(frame(.5,2));assert.equal(windBinds,2);
  assert.equal(p.cloudSpeciesTex.image.data[3],initialBands[3]+1);
  p.weatherHours=.375;stream.update(p.weatherHours,true);assert.equal(windBinds,3);
  p.weatherHours=.5;stream.update(p.weatherHours,true);assert.equal(windBinds,4);
  assert.equal(p.cloudSpeciesTex.image.data[3],frame(.5,2).bands[3]);
  stream.dispose();assert.equal(stream.worker.terminated,true);
  assert.equal(stream.committedFirst,null);assert.equal(stream.committedSecond,null);
  const w=64,h=32,stride=CANDIDATE_WIDTH*CANDIDATE_HEIGHT;
  const p2={...p,weatherHours:.25,cloudAtlasWidth:w,
    cloudSpeciesTex:new THREE.DataArrayTexture(new Float32Array(w*h*4*productionStorageLayers(w,h)),w,h,productionStorageLayers(w,h)),
    cloudBoundsTex:new THREE.DataTexture(new Float32Array(w*h*4),w,h,THREE.RGBAFormat,THREE.FloatType),
    cloudCandidatesTex:new THREE.DataArrayTexture(new Uint16Array(stride*CANDIDATE_LAYERS),CANDIDATE_WIDTH,CANDIDATE_HEIGHT,CANDIDATE_LAYERS)};
  const s2=new PlanetWeatherStream(p2);p2.weatherStream=s2;
  const acceleratedFrame=(hours,layer,top)=>{
    const result={...frame(hours),bands:new Float32Array(p2.cloudSpeciesTex.image.data.length),
      bounds:Float32Array.from({length:w*h*4},(_,i)=>i%2?top:1000),
      candidates:new Uint16Array(stride*CANDIDATE_LAYERS)};
    result.candidates[layer*stride]=1;return result;
  };
  s2.update(.25);s2.worker.deliver(acceleratedFrame(0,3,8000));s2.worker.deliver(acceleratedFrame(.5,5,9000));
  p2.R=6000000;p2.stellarLightField={sources:[]};
  p2.volCloudMat={uniforms:{uSpeciesMask:{value:-1},uCameraLocal:{value:new THREE.Vector3(0,6003000,0)}}};
  const captureSources=()=>({stream:s2,frames:[0,.5].map(hours=>({hours,revision:s2.revisionAt(hours)}))});
  const cache={weatherSources:captureSources()};
  const bank={planet:p2,fieldOwner:p2.weatherField,speciesMask:-1,baseHours:0,lightIds:'',
    maps:new Map([[0,cache]]),center:new THREE.Vector3(0,6003000,0),cameraHeight:3000,size:128,spacing:100};
  assert.equal(CloudLightBank.prototype.needsReset.call(bank),false);
  const masks=p2.cloudCandidatesTex.image.data;
  assert.equal(masks[3*stride],1);assert.equal(masks[5*stride],1);assert.equal(masks[7*stride],0);
  const oldVersion=p2.cloudCandidatesTex.version;
  // Replacement at the same timestamp must refresh conservative support,
  // not merely the interpolated species/atmosphere textures.
  s2.worker.deliver(acceleratedFrame(.5,7,12000));
  assert.equal(CloudLightBank.prototype.needsReset.call(bank),true,'Replaced forecast left a completed lighting cache valid');
  cache.weatherSources=captureSources();assert.equal(CloudLightBank.prototype.needsReset.call(bank),false);
  assert.ok(p2.cloudCandidatesTex.version>oldVersion);
  assert.equal(masks[3*stride],1);assert.equal(masks[5*stride],0);assert.equal(masks[7*stride],1);
  assert.equal(p2.cloudBoundsTex.image.data[1],12000);
  const offset=PRODUCTION_PARAMETER_LAYERS*w*h*4;
  assert.deepEqual(p2.cloudSpeciesTex.image.data.subarray(offset,offset+masks.length),Float32Array.from(masks));
  const version=p2.cloudCandidatesTex.version;
  s2.worker.deliver(acceleratedFrame(1,9,15000));
  assert.equal(CloudLightBank.prototype.needsReset.call(bank),false,'Unrelated prefetch invalidated live light endpoints');
  assert.equal(p2.cloudCandidatesTex.version,version,'Prefetch changed active acceleration');
  const s3=new PlanetWeatherStream(p2);p2.weatherStream=s3;
  assert.equal(CloudLightBank.prototype.needsReset.call(bank),true,'Replaced stream left completed light endpoints valid');
  s3.dispose();
  s2.dispose();assert.equal(s2.boundsFirst,null);assert.equal(s2.boundsSecond,null);
  for(const texture of [p2.cloudSpeciesTex,p2.cloudBoundsTex,p2.cloudCandidatesTex])texture.dispose();
  console.log('PASS: exact weather transaction, prefetch deduplication, replacement support indexes, time advance, bracket turnover and disposal.');
} finally {globalThis.Worker=originalWorker;}
