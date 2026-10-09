// Scheduling ownership, without GPU timing: a missing source or a clock jump
// must not allocate overlapping snapshots or expose a partially baked slot.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {CloudLightBank} from '../src/cloud/cloud-light-bank.js';

const uniforms={uSunCacheReady:{value:0},uSunTransport:{value:null},uSunCacheEncoded:{value:0},
  uSunCacheDepth:{value:0},uSunCacheMix:{value:0},uSunCacheOffsets:{value:new THREE.Vector2()}};
for(const suffix of ['A','B']) {
  uniforms['uSunCacheMatrix'+suffix]={value:Array.from({length:4},()=>new THREE.Matrix4())};
  uniforms['uSunCacheValid'+suffix]={value:new THREE.Vector4()};
  uniforms['uSunCacheMargin'+suffix]={value:new THREE.Vector4()};
}
const planet={weatherHours:0,weatherField:{windRadiansPerHour:0},volCloudMat:{uniforms}};
const bank=Object.create(CloudLightBank.prototype);
Object.assign(bank,{planet,baseHours:0,interval:.0015,size:128,depth:128,maps:new Map(),
  target:{texture:{}},initialized:false,submissions:[],disposed:false});
let liveSnapshots=0,maxSnapshots=0,created=0,retired=0,missing=1;
bank.create=index=>{
  if(index===missing)return null;
  created++;liveSnapshots++;maxSnapshots=Math.max(maxSnapshots,liveSnapshots);
  const cache={ready:false,disposed:false,hours:index*bank.interval,tileOffset:(index%3)*512,
    available:[true,true,true,true],interiorMargins:[.01,.01,.03,.03],
    transforms:Array.from({length:4},()=>new THREE.Matrix4()),submissions:0,
    bakeSlice(renderer,{slices}) {
      this.submissions++;
      if(slices===128 || this.submissions===12){this.ready=true;liveSnapshots--;}
    },
    dispose() {if(this.disposed)return;this.disposed=true;retired++;if(!this.ready)liveSnapshots--;}};
  bank.maps.set(index,cache);return cache;
};
bank.update(null);
assert.equal(bank.initialized,false);assert.equal(uniforms.uSunCacheReady.value,0);
assert.equal(bank.maps.get(0).ready,true);assert.equal(liveSnapshots,0);
missing=-1;bank.update(null);
assert.equal(bank.initialized,true);assert.equal(uniforms.uSunCacheReady.value,1);
assert.equal(bank.maps.size,2);assert.equal(maxSnapshots,1);
const first=bank.maps.get(0),second=bank.maps.get(1);
bank.update(null);assert.equal(liveSnapshots,1);assert.equal(uniforms.uSunCacheReady.value,1);
assert.equal(bank.maps.get(0),first);assert.equal(bank.maps.get(1),second);
// Jump during the forecast's construction. Obsolete slots retire before a
// new snapshot starts, and both replacement endpoints must finish to bind.
const pending=bank.maps.get(2);planet.weatherHours=12*bank.interval;bank.update(null);
assert.equal(pending.disposed,true);assert.equal(first.disposed,true);assert.equal(second.disposed,true);
assert.equal(uniforms.uSunCacheReady.value,0);assert.equal(liveSnapshots,1);
for(let i=0;i<11;i++)bank.update(null);
assert.equal(uniforms.uSunCacheReady.value,1);assert.equal(bank.maps.get(12).ready,true);
assert.equal(bank.maps.get(13).ready,true);assert.equal(liveSnapshots,0);assert.equal(maxSnapshots,1);
assert.ok(created===5 && retired===3);
for(const cache of bank.maps.values())cache.dispose();assert.equal(liveSnapshots,0);
console.log('PASS light-bank sequential bootstrap, missing source, forecast cancellation, clock jump and atomic endpoint readiness.');
