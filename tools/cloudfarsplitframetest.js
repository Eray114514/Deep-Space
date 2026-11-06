import assert from 'node:assert/strict';
import * as T from '../vendor/three.module.js';
import { collectCloudSplitOwners, planCloudSplitFrame } from './cloud-far-split-frame.js';
import { createCloudSplitResourceTracker } from './cloud-far-split-routing.js';
const scene=new T.Scene(),camera=new T.PerspectiveCamera(50,1,.1,100);
camera.position.z=10;
const tracker=createCloudSplitResourceTracker(),owners=new Map(),prepared=new Set(),target=new T.WebGLRenderTarget(4,4);
const groups=[new T.Group(),new T.Group()];scene.add(...groups);
const meshes=groups.map((group,index)=>{
  const uniforms={uCameraLocal:{value:new T.Vector3(0,0,10)},uColumnsReady:{value:0},uEngage:{value:1},
    uDepthInvProjection:{value:new T.Matrix4()},uSunDirection:{value:new T.Vector3(0,1,0)}};
  for(const name of ['uColumnsJointReady','uColumnMix','uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'])uniforms[name]={value:0};
  const reference=new T.ShaderMaterial({transparent:true,uniforms});
  const programs={reference};for(const name of ['point','cached','combine','pointDirect','cachedDirect']){programs[name]=reference.clone();programs[name].uniforms=uniforms;prepared.add(programs[name]);}
  const mesh=new T.Mesh(new T.SphereGeometry(1,8,8),reference);mesh.frustumCulled=false;mesh.position.z=index?1:-1;
  group.add(mesh);owners.set(mesh,{reference,programs,outerRadius:1});return mesh;
});
const options={scene,camera,owners,tracker,prepared,targets:[target],width:4,height:4,scratchBytes:512};
const order=()=>collectCloudSplitOwners(scene,camera,owners).map(row=>row.object);
assert.deepEqual(order(),meshes);
// At large distances normalized z rounds to 1 for both; Three still orders
// by the distinct, undivided clip z. An accidental Vector3 collector fails.
camera.far=1e20;camera.updateProjectionMatrix();meshes[0].position.z=-2e17;meshes[1].position.z=-3e17;
assert.deepEqual(order(),[meshes[1],meshes[0]]);
camera.far=100;camera.updateProjectionMatrix();meshes[0].position.z=-1;meshes[1].position.z=1;
groups[0].renderOrder=2;assert.deepEqual(order(),[meshes[1],meshes[0]]);groups[0].renderOrder=0;
meshes[0].renderOrder=1;assert.deepEqual(order(),[meshes[1],meshes[0]]);meshes[0].renderOrder=0;
meshes[1].position.z=-1;assert.deepEqual(order(),meshes);meshes[1].position.z=1;
groups[0].visible=false;assert.deepEqual(order(),[meshes[1]]);groups[0].visible=true;
meshes[1].layers.set(2);assert.deepEqual(order(),[meshes[0]]);meshes[1].layers.set(0);
let published=0,draws=0;
const execute=plan=>plan.execute({draw(){draws++;},publish(){published++;}});
execute(planCloudSplitFrame(options));assert.equal(draws,2);assert.equal(published,1);
const mutations=[
  ()=>{camera.position.x+=1;},
  ()=>{camera.fov+=1;camera.updateProjectionMatrix();},
  ()=>{meshes[0].position.x+=1;},
  ()=>{owners.get(meshes[0]).reference.uniforms.uSunDirection.value.x+=1;},
  ()=>{owners.get(meshes[0]).reference.uniforms.uEngage.value=.4;},
  ()=>{owners.get(meshes[0]).reference.uniforms.uDepthInvProjection.value.elements[0]+=1;},
  ()=>{groups[0].renderOrder+=1;},
  ()=>{const material=owners.get(meshes[0]).programs.pointDirect;material.depthWrite=!material.depthWrite;},
  ()=>{target.viewport.z-=1;},
  ()=>{owners.get(meshes[0]).outerRadius+=1;},
  ()=>{target.setSize(8,8);},
];
for(const mutate of mutations){const plan=planCloudSplitFrame(options),before=draws;mutate();assert.throws(()=>execute(plan),/Stale|Retired/);assert.equal(draws,before);}
const cancelled=planCloudSplitFrame(options);cancelled.cancel();assert.throws(()=>execute(cancelled),/cancelled/);
const mid=planCloudSplitFrame(options),before=published;
assert.throws(()=>mid.execute({draw(){mid.cancel();},publish(){published++;}}),/cancelled/);assert.equal(published,before);
const fail=planCloudSplitFrame(options);assert.throws(()=>fail.execute({draw(){throw Error('Draw failed');},publish(){published++;}}),/Draw failed/);
assert.equal(published,before);assert.throws(()=>execute(fail),/consumed/);
const program=owners.get(meshes[0]).programs.pointDirect;
const revoked=planCloudSplitFrame(options);prepared.delete(program);assert.throws(()=>execute(revoked),/revoked/);
assert.throws(()=>planCloudSplitFrame(options),/not prepared/);prepared.add(program);
const retired=planCloudSplitFrame(options);program.dispose();assert.throws(()=>execute(retired),/Retired/);
const original=meshes[0].material;meshes[0].material=[original];assert.throws(()=>planCloudSplitFrame(options),/arrays/);meshes[0].material=original;
tracker.dispose();target.dispose();for(const mesh of meshes){mesh.geometry.dispose();for(const m of Object.values(owners.get(mesh).programs))m.dispose();}
console.log('PASS split frame ordering, hidden/layers, camera/depth/light mutations, program/target retirement, cancellation and publish isolation');
