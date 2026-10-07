import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FrameWorkBudget } from '../src/frame-work-budget.js';
import { createSurfaceWarmupScene } from '../src/surface-warmup.js';
import { Scatter } from '../src/scatter.js';
import { FarFlora } from '../src/farflora.js';
import { ChunkedLOD, flushChunkQueue, pendingChunks } from '../src/quadtree.js';
import { vegetationPrecisionFixture } from './vegetation-precision-fixture.js';
import { farFloraPrecisionFixture } from './far-flora-precision-fixture.js';

// Actual elapsed work (including atomic overshoot) constrains later producers;
// preserve the focused terrain reservation and keep zero-grant maintenance.
let clock=0;
const ledger=new FrameWorkBudget(()=>clock).begin(6,{terrain:3});
assert.equal(ledger.run('near',2,budget=>{assert.equal(budget,2);clock+=2.5;return 42;}),42);
ledger.run('far',2,budget=>{assert.equal(budget,.5);clock+=.6;});
ledger.run('terrain',3,budget=>{assert.ok(Math.abs(budget-2.9)<1e-9);clock+=3;});
assert.ok(Math.abs(ledger.snapshot().overrunMs-.1)<1e-9);
ledger.run('maintenance',1,budget=>{assert.equal(budget,0);clock+=.2;});
const detached=ledger.snapshot();detached.records[0].elapsedMs=999;
assert.equal(ledger.snapshot().records[0].elapsedMs,2.5);
ledger.begin(1);
assert.throws(()=>ledger.run('failed',1,()=>{clock+=2;throw Error('worker');}),/worker/);
assert.ok(Math.abs(ledger.snapshot().spentMs-2)<1e-9);

// With no grant real generators must preserve queued work and display state,
// then resume with the same seeded result as an uninterrupted build.
const nearFixture=vegetationPrecisionFixture(6000000,'relief');
const near=new Scatter({grassRadius:36,grassDensity:.35});
const nearControl=new Scatter({grassRadius:36,grassDensity:.35});
const p=nearFixture.planet,cam=new THREE.Vector3(1,-2,-3).normalize().multiplyScalar(p.R+10);
try {
  near.update(p,cam,10,0);
  assert.ok(near.job);
  const progress=near.job;
  near.update(p,cam,10,0);
  assert.equal(near.job,progress);
  assert.equal(Object.values(near.meshes).reduce((n,m)=>n+m.count,0),0);
  near.update(p,cam,10,Infinity);nearControl.update(p,cam,10,Infinity);
  for(const kind in near.meshes) {
    assert.equal(near.meshes[kind].count,nearControl.meshes[kind].count);
    assert.deepEqual(near.meshes[kind].instanceMatrix.array,nearControl.meshes[kind].instanceMatrix.array);
  }
} finally {near.clear();nearControl.clear();nearFixture.geometry.dispose();}
const farFixture=farFloraPrecisionFixture(6000000,'relief'),far=new FarFlora();
try {
  const p=farFixture.planet,cam=new THREE.Vector3(1,0,0).multiplyScalar(p.R+400);
  far.update(p,cam,400,0);
  assert.equal(far.job,null);assert.ok(far.queue.length>0);assert.equal(far.tiles.size,0);
  const key=far.queue[0],expected=far.buildTile(p,key);
  far.update(p,cam,400,Infinity);
  assert.deepEqual(far.tiles.get(key).m0,expected.m0);
  assert.deepEqual(far.tiles.get(key).m1,expected.m1);
  assert.equal(far.pending(),0);
  far.update(p,cam,20000,0);
  assert.ok(far.meshes.every(m=>!m.visible),'Visibility maintenance cannot be skipped with a zero grant');
} finally {far.clear();farFixture.geometry.dispose();}
const terrain={R:6000000,hAmp:1,gridCells:4,maxLevel:2,noSkirt:true,
  height:()=>0,freqAtLevel:()=>1,terrainMaterial:new THREE.MeshBasicMaterial(),group:new THREE.Group()};
const lod=new ChunkedLOD(terrain);
try {
  lod._levelCap=2;lod.findNode(0,2,0,0,true);
  const queued=pendingChunks(lod);assert.ok(queued>0);
  assert.equal(flushChunkQueue(0),0);assert.equal(pendingChunks(lod),queued);
  assert.ok(flushChunkQueue(Infinity)>0);assert.equal(pendingChunks(lod),0);
} finally {lod.dispose();terrain.terrainMaterial.dispose();}

// The former 2x2 render drew every world mesh and native full-size shadows.
// Only the representative group can enter this scene; clone shadow maps and
// cleanup must never own, move or dispose production resources.
const source=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),group=new THREE.Group();
const representative=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
const other=new THREE.Mesh(representative.geometry,representative.material);
group.add(representative);source.add(group,other);
const light=new THREE.DirectionalLight();light.visible=false;light.castShadow=true;
light.shadow.mapSize.set(2048,2048);light.shadow.map=new THREE.WebGLRenderTarget(1,1);
let productionDisposals=0;light.shadow.map.addEventListener('dispose',()=>productionDisposals++);
source.add(light,light.target);
const before=light.position.toArray();
const warm=createSurfaceWarmupScene(source,group,camera,light);
assert.equal(group.parent,warm.scene);assert.equal(other.parent,source);
assert.equal(warm.lights.length,1);assert.equal(warm.lights[0].shadow.map,null);
assert.deepEqual(warm.lights[0].shadow.mapSize.toArray(),[2,2]);
warm.lights[0].shadow.map=new THREE.WebGLRenderTarget(2,2);
let privateDisposals=0;warm.lights[0].shadow.map.addEventListener('dispose',()=>privateDisposals++);
warm.dispose();warm.dispose();
assert.equal(privateDisposals,1);assert.equal(productionDisposals,0);
assert.equal(group.parent,source);assert.equal(light.visible,false);
assert.deepEqual(light.position.toArray(),before);assert.deepEqual(light.shadow.mapSize.toArray(),[2048,2048]);
light.shadow.dispose();representative.geometry.dispose();representative.material.dispose();
console.log('PASS: shared scene-work overruns/reservation, real zero-grant/resume generators, private warmup scope and shadow ownership.');
