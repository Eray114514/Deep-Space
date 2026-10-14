import assert from 'node:assert/strict';
import * as THREE from 'three';
import {makeCloudVolumeMaterial} from '../src/clouds-webgl.js';
import {CloudLightBatchRenderer} from '../src/cloud/cloud-light-batch-renderer.js';

const source=makeCloudVolumeMaterial({R:6000000},
  {rIn:6000000,rOut:6040000,localWeather:true,ox:0,oy:0,oz:0},null,null,null);
const options={width:64,height:64,budgetBytes:8*1024*1024};
const stage=new CloudLightBatchRenderer(source,options),geometry=new THREE.PlaneGeometry(),mesh=new THREE.Mesh(geometry,source);
const camera=new THREE.PerspectiveCamera();camera.layers.set(7);
const sentinel={},state={target:sentinel,face:2,mip:3,ready:false,queries:0,compiles:[]};
const properties=new Map(),gl={getExtension(){return {COMPLETION_STATUS_KHR:1};},getProgramParameter(){state.queries++;return state.ready;}};
const renderer={getContext:()=>gl,getRenderTarget:()=>state.target,getActiveCubeFace:()=>state.face,getActiveMipmapLevel:()=>state.mip,
  setRenderTarget(target,face=0,mip=0){Object.assign(state,{target,face,mip});},properties:{get:material=>properties.get(material)},
  compile(scene,compileCamera){scene.traverse(object=>{if(!object.isMesh)return;
    properties.set(object.material,{currentProgram:{program:{}}});state.compiles.push({target:state.target,camera:compileCamera});});}};
const restored=()=>{assert.equal(state.target,sentinel);assert.equal(state.face,2);assert.equal(state.mip,3);assert.equal(camera.layers.mask,1<<7);};
try {
  const first=stage.prepareAsync(renderer,camera,mesh,{});restored();assert.equal(state.compiles.length,6);
  assert.notEqual(state.compiles[0].camera,camera);assert.equal(stage.programsReady,false);
  stage.releaseScratch();assert.equal(stage.source,null);
  state.ready=true;assert.equal(await first,true);restored();assert.equal(stage.programsReady,true);
  stage.configure(source,options);assert.equal(stage.materials.length,6);
  source.fragmentShader+='\n// preparation revision\n';stage.configure(source,options);state.ready=false;
  const cancelled=stage.prepareAsync(renderer,camera,mesh,{});stage.dispose();assert.equal(await cancelled,false);
  const queries=state.queries;await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(state.queries,queries,'Disposal must stop polling destroyed programs');restored();
  const migrating=new CloudLightBatchRenderer(source,options);
  const obsolete=migrating.prepareAsync(renderer,camera,mesh,{});
  source.fragmentShader+='\n// cancelled in-flight family\n';migrating.configure(source,options);
  assert.equal(await obsolete,false);assert.equal(migrating.programsReady,false);restored();
  state.ready=true;assert.equal(await migrating.prepareAsync(renderer,camera,mesh,{}),true);migrating.dispose();
  const failing=new CloudLightBatchRenderer(source,options),originalCompile=renderer.compile;
  renderer.compile=()=>{throw Error('controlled preparation failure');};
  assert.equal(await failing.prepareAsync(renderer,camera,mesh,{}),false);assert.match(failing.preparationError,/controlled/);restored();
  failing.dispose();renderer.compile=originalCompile;
  console.log('PASS private compile state restored before polling, scratch release during preparation, cancellation and failure fallback.');
}finally{stage.dispose();geometry.dispose();source.dispose();}
