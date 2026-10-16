import assert from 'node:assert/strict';
import * as THREE from 'three';
import {NearWaterPatch} from '../src/near-water-patch.js';
import {FrameWorkBudget} from '../src/frame-work-budget.js';

const create=()=>{
  const planet={R:6000000,seaRadius:6000000,seaLevel:42,name:'water-stream',group:new THREE.Group(),
    height:d=>Math.sin(d.x*731)*12+d.z*63,fullMaxFreq:100};
  const material=new THREE.MeshBasicMaterial();
  return {planet,material,patch:new NearWaterPatch(planet,material,{cells:32,size:512,rowsPerFrame:64})};
};
const a=create(),b=create(),direction=new THREE.Vector3(1,-2,-3).normalize();
const cam=direction.clone().multiplyScalar(a.planet.R+400);
const snapshot=patch=>Object.fromEntries(Object.entries(patch.mesh.geometry.attributes).map(([name,v])=>[name,v.array.slice()]));
const finish=patch=>{let calls=0;while(patch.build){patch._buildRows(Infinity);assert.ok(++calls<10000);}return snapshot(patch);};
try {
  a.patch.update(cam,true,1/60,0);assert.equal(a.patch.build,null);
  a.patch._begin(direction);const expected=finish(a.patch);
  b.patch._begin(direction);
  const clockOriginal=globalThis.performance,height=b.planet.height;
  let clock=0,maximum=0,slices=0;
  try {
    globalThis.performance={now:()=>clock};
    b.planet.height=(...args)=>{clock++;return height(...args);};
    while(b.patch.build) {
      const before=clock,row=b.patch.build.row,column=b.patch.build.column;
      b.patch._buildRows(0);assert.equal(b.patch.build.row,row);assert.equal(b.patch.build.column,column);
      b.patch._buildRows(2);maximum=Math.max(maximum,clock-before);slices++;
    }
    assert.ok(maximum<=8,`Water atomic burst was ${maximum} bathymetry queries`);
  } finally {globalThis.performance=clockOriginal;b.planet.height=height;}
  assert.deepEqual(snapshot(b.patch),expected,'Row/column pauses must preserve all geometry, depth and footprint attributes');
  const oldGeometry=b.patch.mesh.geometry;
  const away=new THREE.Vector3(-1,2,3).normalize();b.patch._begin(away);b.patch._buildRows(.001);
  assert.equal(b.patch.mesh.geometry,oldGeometry,'Old complete patch must remain live during a replacement');
  b.patch.update(cam,false,1/60,0);assert.equal(b.patch.build,null);assert.equal(b.patch.mesh.visible,false);
  b.patch._begin(direction);assert.deepEqual(finish(b.patch),expected,'Hidden cancelled work must not leak on return');
  // A focused scene reservation can pause an existing row without destroying
  // it; the next frame's renewed grant must make progress.
  const budget=new FrameWorkBudget(()=>0).begin(0,{terrain:3});b.patch._begin(away);
  const awayCam=away.clone().multiplyScalar(b.planet.R+400);
  budget.run('water',2,grant=>b.patch.update(awayCam,true,1/60,grant));
  assert.equal(b.patch.build.row,0);assert.equal(b.patch.build.column,0);
  budget.begin(5,{terrain:3});budget.run('water',2,grant=>b.patch.update(awayCam,true,1/60,grant));
  assert.ok(!b.patch.build||b.patch.build.row>0||b.patch.build.column>0);
  console.log(`PASS: water row/column resumability (${slices} slices, max ${maximum} queries), zero grant, full attribute parity, old mesh retention, cancellation/return and shared reservation.`);
} finally {for(const f of [a,b]){f.patch.dispose();f.material.dispose();}}
