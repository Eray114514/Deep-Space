import assert from 'node:assert/strict';
import * as THREE from 'three';
import {VolumetricPass,VOLUME_LAYER} from '../src/volumetric-pass-webgl.js';
import {makeCloudVolumeMaterial} from '../src/clouds-webgl.js';
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
  assert.throws(()=>pass.setLightBatchesEnabled(true,{fusedDensity:1}),/Invalid/);
  assert.equal(pass.lightBatchesEnabled,false);assert.equal(released,1,'Invalid options must not mutate the executor');
  pass.setLightBatchesEnabled(true,{budgetBytes:1024});assert.equal(disposed,0);assert.equal(released,2);
  pass.setLightBatchesEnabled(false);assert.equal(disposed,1);assert.equal(pass.lightBatch,null);
  const cloud=makeCloudVolumeMaterial({R:6000000},
    {rIn:6000000,rOut:6040000,localWeather:true,ox:0,oy:0,oz:0},null,null,null);
  cloud.uniforms.uLightQuadratureSteps.value=16;
  const renderer=(drawBuffers,colorAttachments)=>({getContext:()=>({
    MAX_DRAW_BUFFERS:1,MAX_COLOR_ATTACHMENTS:2,MAX_TEXTURE_SIZE:3,
    getParameter:key=>[0,drawBuffers,colorAttachments,16384][key],getExtension:()=>true,
  })});
  try {
    pass.setLightBatchesEnabled(true,{budgetBytes:32*1024*1024,fusedDensity:true});
    const fallback=pass.configureLightBatch(renderer(8,4),cloud);
    assert.equal(fallback.fusedDensity,false);assert.equal(fallback.plan.direct,false);
    const fused=pass.configureLightBatch(renderer(8,8),cloud);
    assert.equal(fallback.disposed,true);assert.equal(fused.fusedDensity,true);
    assert.ok(fused.plan.stripe);
    pass.setLightBatchesEnabled(true,{fusedDensity:false});
    assert.equal(fused.disposed,true);assert.equal(pass.lightBatch,null);
  } finally {cloud.dispose();}
  const jobs=[];
  const schedule=(work,options)=>new Promise(resolve=>jobs.push({work,options,resolve}));
  const planet={posUniv:new THREE.Vector3(),volCloudMesh:{visible:true},volCloudBand:{rOut:6000000},
    volCloudMat:{defines:{PRODUCTION_CLOUD_MEDIUM:1},uniforms:{uLightQuadratureSteps:{value:16}}}};
  const approaching=new THREE.Vector3(0,0,6500000);
  pass.setActivePlanet(planet,approaching);
  pass.setLightBatchesEnabled(true,{budgetBytes:32*1024*1024});
  pass.configureLightBatch=()=>({plan:{direct:false},programsReady:true});
  pass.prefetchLightBatches(null,approaching,schedule);
  pass.prefetchLightBatches(null,approaching,schedule);
  assert.equal(jobs.length,1,'One preparation per approached source');
  assert.equal(jobs[0].options.isCurrent(),true);
  jobs[0].resolve(jobs[0].work());await Promise.resolve();
  assert.equal(pass.lightBatchPrefetch.state,'ready');
  pass.setSize(1280,720);
  assert.equal(jobs[0].options.isCurrent(),false,'Resize retires the old layout claim');
  pass.prefetchLightBatches(null,approaching,schedule);
  assert.equal(jobs.length,2);
  pass.setActivePlanet(null,approaching);
  assert.equal(jobs[1].options.isCurrent(),false,'Source removal cancels queued preparation');
  const material=new THREE.ShaderMaterial({defines:{PRODUCTION_CLOUD_MEDIUM:1},
    uniforms:{uLightQuadratureSteps:{value:16}}});
  const geometry=new THREE.BufferGeometry(),mesh=new THREE.Mesh(geometry,material);
  mesh.layers.set(VOLUME_LAYER);pass.scene.add(mesh);
  pass.setActivePlanet({...planet,volCloudMesh:mesh,volCloudMat:material},approaching);
  const ready={source:material,mesh:{geometry},targets:[{}],plan:{width:pass.width,height:pass.height},
    programsReady:true,matchesProgramSource:()=>true,dispose(){}};
  pass.lightBatch=ready;
  const requests=[{mesh,material}];
  assert.equal(pass.usesPreparedLightBatch(requests),true);
  const extra=new THREE.Points(geometry,material);
  extra.layers.set(VOLUME_LAYER);pass.scene.add(extra);
  assert.equal(pass.usesPreparedLightBatch(requests),false,'A foreign volume drawable needs its own gate');
  pass.scene.remove(extra);
  mesh.onBeforeRender=()=>{};
  assert.equal(pass.usesPreparedLightBatch(requests),false,'A custom source callback needs the direct route');
  mesh.onBeforeRender=THREE.Object3D.prototype.onBeforeRender;
  ready.plan.width++;
  assert.equal(pass.usesPreparedLightBatch(requests),false,'A stale viewport cannot be selected');
  pass.scene.remove(mesh);geometry.dispose();material.dispose();
  console.log('PASS depth metadata precedes history sampling, resize invalidates scratch/history, identical layouts retain programs.');
}finally{pass.dispose();}
