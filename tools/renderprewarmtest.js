import assert from 'node:assert/strict';
import * as THREE from 'three';
import { compileRenderVariant } from '../src/render-prewarm.js';

const scene=new THREE.Scene(),source=new THREE.Group(),camera=new THREE.PerspectiveCamera();
const geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
const exterior=new THREE.InstancedMesh(geometry,material,1),interior=new THREE.Mesh(geometry,material);
exterior.layers.set(3);exterior.visible=false;interior.layers.set(5);
const light=new THREE.PointLight();light.layers.set(3);light.castShadow=true;
source.add(exterior,interior,light);scene.add(source);
let sharedDisposals=0;material.addEventListener('dispose',()=>sharedDisposals++);geometry.addEventListener('dispose',()=>sharedDisposals++);
let target='player',face=2,mip=1,privateDisposals=0,observed;
const controller=new AbortController(),program={program:{},isReady:()=>false};
const props={programs:new Map([['test',program]]),currentProgram:program};
const renderer={getRenderTarget:()=>target,getActiveCubeFace:()=>face,getActiveMipmapLevel:()=>mip,
  domElement:new EventTarget(),getContext:()=>({isContextLost:()=>false}),
  properties:{get:()=>props,has:()=>true},
  setRenderTarget(value,f=0,m=0){target=value;face=f;mip=m;},
  compile(group,compileCamera,compileScene) {
    const lights=[],renderables=[];compileScene.traverse(o=>{if(o.isLight)lights.push(o);});
    group.traverse(o=>{if(o.isMesh)renderables.push(o);assert.equal(Boolean(o.isLight),false);});
    assert.equal(camera.layers.mask,1);assert.equal(compileCamera.layers.mask,8);
    assert.equal(lights.length,1,'Compile must not collect ship interior lights twice');
    assert.equal(renderables.length,1);assert.equal(renderables[0].geometry,geometry);assert.equal(renderables[0].material,material);
    assert.notEqual(renderables[0],exterior);assert.equal(renderables[0].isInstancedMesh,true);
    renderables[0].addEventListener('dispose',()=>privateDisposals++);
    assert.equal(exterior.visible,false);assert.equal(source.parent,scene);assert.equal(target,'hdr');
    observed={group,compileCamera};return new Set([material]);
  }};
const pending=compileRenderVariant(renderer,source,camera,scene,{layer:3,target:'hdr',signal:controller.signal});
assert.equal(target,'player');assert.equal(face,2);assert.equal(mip,1);
assert.equal(privateDisposals,1);assert.equal(sharedDisposals,0);assert.equal(observed.group.children.length,0);
// The player is free to change state while KHR readiness remains unresolved.
camera.layers.set(5);exterior.visible=true;renderer.setRenderTarget('next-player');
controller.abort();await assert.rejects(pending,{code:'aborted'});
assert.equal(camera.layers.mask,32);assert.equal(exterior.visible,true);assert.equal(target,'next-player');
renderer.compile=()=>{throw Error('synchronous compile failure');};
assert.throws(()=>compileRenderVariant(renderer,source,camera,scene,{layer:3,target:'hdr'}),/synchronous/);
assert.equal(target,'next-player');assert.equal(camera.layers.mask,32);assert.equal(sharedDisposals,0);
geometry.dispose();material.dispose();
console.log('PASS: private render variants, one light traversal, layer/type filtering, synchronous restore, delayed rejection and shared-resource ownership.');
