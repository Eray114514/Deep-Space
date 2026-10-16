import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NearWaterPatch } from '../src/near-water-patch.js';
import { WATER_GEOMETRY_ATTRIBUTES } from '../src/near-water-geometry.js';

const planet = { R:6000000,seaRadius:6000000,seaLevel:42,name:'worker-contract',group:new THREE.Group(),
  height:d=>Math.sin(d.x*731)*12+d.z*63,fullMaxFreq:100,createTerrainSnapshot:()=>({fixture:true}) };
const material=new THREE.MeshBasicMaterial(),workers=[];
const factory=()=>{
  const worker={messages:[],terminated:false,postMessage(data){this.messages.push(data);},terminate(){this.terminated=true;}};
  workers.push(worker);return worker;
};
const direction=new THREE.Vector3(1,-2,-3).normalize(),cam=direction.clone().multiplyScalar(planet.R+40);
const fallback=new NearWaterPatch(planet,material,{cells:32,size:512,workerFactory:null});
const patch=new NearWaterPatch(planet,material,{cells:32,size:512,workerFactory:factory});
const finish=p=>{while(p.build)p._buildRows(Infinity);};
try {
  fallback._begin(direction); const expectedJob=fallback.build; finish(fallback);
  const attributes=Object.fromEntries(WATER_GEOMETRY_ATTRIBUTES.map(key=>[key,expectedJob[key].slice()]));
  patch.update(cam,true,1/60,0);assert.equal(workers.length,0,'Zero grant cannot admit worker/allocate a patch');
  patch.update(cam,true,1/60,2);const worker=workers[0],token=patch.workerToken,oldGeometry=patch.mesh.geometry;
  assert.equal(worker.messages.length,2);assert.equal(patch.build.position.length,0,'No duplicate full buffers on main thread');
  worker.onmessage({data:{token:token-1,attributes}});assert.equal(patch.build.ready,undefined);
  worker.onmessage({data:{token,attributes,cpuMs:20,wallMs:30}});
  assert.equal(patch.mesh.geometry,oldGeometry,'Completion must not publish outside the frame grant');
  patch._buildRows(0);assert.equal(patch.mesh.geometry,oldGeometry);
  patch._buildRows(2);assert.equal(patch.build,null);assert.equal(patch.rebuilds,1);
  for(const [key,attribute] of Object.entries(fallback.mesh.geometry.attributes))
    assert.deepEqual(patch.mesh.geometry.attributes[key].array,attribute.array);
  patch._begin(direction);const abandoned=patch.build;
  patch.update(cam,false,1/60,0);assert.ok(worker.terminated);assert.equal(patch.build,null);
  worker.onmessage({data:{token:token+1,attributes}});assert.equal(patch.build,null,'Cancelled completion must stay dead');
  patch.update(cam,true,1/60,2);patch._begin(direction);const second=workers[1];
  second.onerror({message:'controlled failure'});assert.ok(second.terminated);assert.ok(!patch.build.worker);
  assert.notEqual(patch.build,abandoned);finish(patch);assert.equal(patch.rebuilds,2);
  for(const [key,attribute] of Object.entries(fallback.mesh.geometry.attributes))
    assert.deepEqual(patch.mesh.geometry.attributes[key].array,attribute.array);
  patch._begin(direction);assert.equal(workers.length,2,'Failed worker cannot respawn/retry every frame');finish(patch);
  const throwing=new NearWaterPatch(planet,material,{cells:8,size:64,workerFactory:()=>{throw Error('unavailable');}});
  throwing._begin(direction);finish(throwing);assert.match(throwing.workerError,/unavailable/);throwing.dispose();
  const malformed=new NearWaterPatch(planet,material,{cells:8,size:64,workerFactory:factory});
  malformed._begin(direction);workers.at(-1).onmessage({data:{token:malformed.workerToken,attributes:{}}});
  assert.match(malformed.workerError,/Invalid/);finish(malformed);malformed.dispose();
  const moving=new NearWaterPatch(planet,material,{cells:32,size:512,workerFactory:factory});
  moving.update(cam,true,1/60,2);const obsolete=workers.at(-1),obsoleteToken=moving.workerToken;
  moving.update(new THREE.Vector3(-cam.x,-cam.y,-cam.z),true,1/60,0);
  assert.ok(obsolete.terminated);assert.equal(moving.build,null,'Far jump cancels even with zero new admission grant');
  obsolete.onmessage({data:{token:obsoleteToken,attributes}});assert.equal(moving.build,null);
  moving.update(cam,true,1/60,2);const timed=workers.at(-1);
  moving.build.workerObservedMs=0;
  moving.build.workerLastCheck=performance.now()-84000;
  moving._buildRows(2);assert.equal(moving.worker,timed,'A blocked main thread cannot time out a queued reply');
  assert.equal(moving.build.workerObservedMs,250);
  moving.build.workerObservedMs=30001;
  moving._buildRows(2);assert.ok(timed.terminated);assert.match(moving.workerError,/30 s/);finish(moving);
  const count=moving.rebuilds;moving.dispose();timed.onmessage({data:{token:moving.workerToken,attributes}});
  assert.equal(moving.rebuilds,count);moving._begin(direction);assert.equal(moving.build,null);
  const workerOriginal=globalThis.Worker;let workerUrl;
  try {
    globalThis.Worker=class {constructor(url){workerUrl=url;}postMessage(){}terminate(){}};
    const {NearWaterPatch:Versioned}=await import('../src/near-water-patch.js?v=worker-cache-contract');
    const versioned=new Versioned(planet,material,{cells:8,size:64});versioned._begin(direction);
    assert.equal(workerUrl.search,'?v=worker-cache-contract','Built worker must inherit the owner module release URL');
    versioned.dispose();
  } finally {if(workerOriginal===undefined)delete globalThis.Worker;else globalThis.Worker=workerOriginal;}
  console.log('PASS: worker admission, stale token/epoch, atomic/granted full attribute publication, hidden/far-jump/dispose cancellation, exact failure/timeout fallback and bounded retries.');
} finally {patch.dispose();fallback.dispose();material.dispose();}
