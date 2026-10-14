import assert from 'node:assert/strict';
import * as THREE from 'three';
import {VolumetricPass} from '../src/volumetric-pass-webgl.js';
const pass=new VolumetricPass(new THREE.Scene(),new THREE.PerspectiveCamera(),{scale:.46});
try {
  pass.setSize(1280,720);
  for(const rt of [pass.historyA,pass.historyB]) {
    assert.equal(rt.depthTexture.image.width,rt.width);assert.equal(rt.depthTexture.image.height,rt.height);
  }
  let disposed=0;const stage={dispose(){disposed++;}};pass.lightBatch=stage;
  pass.setSize(1280,720);assert.equal(pass.lightBatch,stage);assert.equal(disposed,0,'An unchanged layout must keep compiled programs');
  const depthVersion=pass.historyA.depthTexture.version;
  pass.setSize(960,540);assert.equal(disposed,1);assert.equal(pass.lightBatch,null);
  for(const rt of [pass.historyA,pass.historyB]) {
    assert.equal(rt.depthTexture.image.width,rt.width);assert.equal(rt.depthTexture.image.height,rt.height);
  }
  assert.ok(pass.historyA.depthTexture.version>depthVersion);
  assert.equal(pass.historyValid,false);
  console.log('PASS depth metadata precedes history sampling, resize invalidates scratch/history, identical layouts retain programs.');
}finally{pass.dispose();}
