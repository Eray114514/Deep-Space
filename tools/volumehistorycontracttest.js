import assert from 'node:assert/strict';
import * as THREE from 'three';
import {VolumetricPass} from '../src/volumetric-pass-webgl.js';
const pass=new VolumetricPass(new THREE.Scene(),new THREE.PerspectiveCamera(),{scale:.46});
try {
  pass.setSize(1280,720);
  for(const rt of [pass.historyA,pass.historyB]) {
    assert.equal(rt.depthTexture.image.width,rt.width);assert.equal(rt.depthTexture.image.height,rt.height);
  }
  let disposed=0,released=0;const stage={dispose(){disposed++;},releaseScratch(){released++;}};pass.lightBatch=stage;
  pass.setSize(1280,720);assert.equal(pass.lightBatch,stage);assert.equal(disposed,0,'An unchanged layout must keep compiled programs');
  const depthVersion=pass.historyA.depthTexture.version;
  pass.setSize(960,540);assert.equal(disposed,0);assert.equal(released,1);assert.equal(pass.lightBatch,stage);
  for(const rt of [pass.historyA,pass.historyB]) {
    assert.equal(rt.depthTexture.image.width,rt.width);assert.equal(rt.depthTexture.image.height,rt.height);
  }
  assert.ok(pass.historyA.depthTexture.version>depthVersion);
  assert.equal(pass.historyValid,false);
  assert.throws(()=>pass.setLightBatchesEnabled(true,{width:1}),/Unknown/);
  assert.throws(()=>pass.setLightBatchesEnabled(true,{budgetBytes:NaN}),/Invalid/);
  assert.equal(pass.lightBatchesEnabled,false);assert.equal(released,1,'Invalid options must not mutate the executor');
  pass.setLightBatchesEnabled(true,{budgetBytes:1024});assert.equal(disposed,0);assert.equal(released,2);
  pass.setLightBatchesEnabled(false);assert.equal(disposed,1);assert.equal(pass.lightBatch,null);
  console.log('PASS depth metadata precedes history sampling, resize invalidates scratch/history, identical layouts retain programs.');
}finally{pass.dispose();}
