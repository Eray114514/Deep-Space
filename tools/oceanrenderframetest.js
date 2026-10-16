import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OceanRenderFrame, OCEAN_ANCHOR_CELL } from '../src/ocean-render-frame.js';
import { oceanDetailOffsets, oceanDetailCoordinates, createOceanDetailFrame } from '../src/ocean-detail-frame.js';
import { createOceanWaveField, oceanWavePhases, sampleOceanWaveField } from '../src/ocean-wave-field.js';

const group = new THREE.Group(), camera = new THREE.PerspectiveCamera();
const frame = new OceanRenderFrame({ group }), detail = createOceanDetailFrame(0.528);
const field = createOceanWaveField('render-frame-contract');
const circular = (a,b) => Math.abs(a-b-Math.round(a-b));
let maxPosition = 0, maxPatch = 0, oldPosition = 0, maxWave = 0, maxUv = 0, rebases = 0;
for(const radius of [6e6,2e7]) for(const sign of [-1,1]) for(const rotation of [0,1]) {
  const point = new THREE.Vector3(radius+.137,sign*radius*.731+.319,-radius*.413+.031);
  const patch = point.clone().add(new THREE.Vector3(7300.18, -1.319, 7.137));
  for(const worldOrigin of [0,1e8,-1e8,0]) for(const eyeOffset of [-256.001,-255.999,-0.001,0.001,255.999,256.001]) {
    const eye=point.clone().add(new THREE.Vector3(eyeOffset,3.7,11.9));
    group.quaternion.setFromEuler(new THREE.Euler(.32+rotation*.4,-.44,.15));
    group.position.copy(eye).applyQuaternion(group.quaternion).negate().add(new THREE.Vector3(worldOrigin,234,-117));
    group.updateMatrixWorld(true);
    camera.position.set(worldOrigin+2.3,235.7,-122.1);
    camera.quaternion.setFromEuler(new THREE.Euler(-.21,.61+rotation*.3,-.34));camera.updateMatrixWorld(true);
    if(frame.sync(camera,patch))rebases++;
    const anchor=frame.anchor.clone(), linear=frame.uniforms.uOceanViewToLocal.value;
    assert.ok(anchor.toArray().every(value=>value%OCEAN_ANCHOR_CELL===0));
    assert.ok(frame.uniforms.uOceanCameraToAnchor.value.toArray().every(value=>value>=0&&value<256));
    const expected=point.clone().sub(anchor);
    const view=point.clone().sub(frame.view.origin).applyQuaternion(group.quaternion).applyQuaternion(camera.quaternion.clone().invert());
    // Simulate the GPU's small view displacement, matrix and final addition.
    const rounded=view.toArray().map(Math.fround), m=linear.elements.map(Math.fround);
    const relative=new THREE.Vector3(...[0,1,2].map(i=>Math.fround(
      Math.fround(Math.fround(m[i]*rounded[0])+Math.fround(m[i+3]*rounded[1]))+Math.fround(m[i+6]*rounded[2]))));
    ['x','y','z'].forEach(axis=>{relative[axis]=Math.fround(relative[axis]+Math.fround(frame.uniforms.uOceanCameraToAnchor.value[axis]));});
    maxPosition=Math.max(maxPosition,relative.distanceTo(expected));
    maxPatch=Math.max(maxPatch,Math.abs(relative.clone().add(frame.uniforms.uOceanAnchorToPatch.value).length()-point.distanceTo(patch)));
    const old=point.clone().fromArray(point.toArray().map(Math.fround)).sub(patch.clone().fromArray(patch.toArray().map(Math.fround)));
    oldPosition=Math.max(oldPosition,old.distanceTo(point.clone().sub(patch)));
    const phases=oceanWavePhases(field,anchor,12345.678);
    const localField={...field,modes:field.modes.map((mode,i)=>({...mode,phase:phases[i][0]}))};
    for(const footprint of [0,4,144])maxWave=Math.max(maxWave,Math.abs(
      sampleOceanWaveField(localField,relative,0,{significantHeight:6.7,footprint}).height
      -sampleOceanWaveField(field,point,12345.678,{significantHeight:6.7,footprint}).height));
    const offsets=oceanDetailOffsets(detail,anchor);
    for(let i=0;i<detail.channels.length;i++) {
      const actual=oceanDetailCoordinates(detail,i,relative,offsets);
      const oracle=oceanDetailCoordinates(detail,i,point,oceanDetailOffsets(detail,new THREE.Vector3()));
      actual.forEach((value,j)=>maxUv=Math.max(maxUv,circular(value,oracle[j])));
    }
    // Geometry publication moves coverage, never the canonical sampling phase.
    frame.sync(camera,patch.clone().addScalar(1024));assert.deepEqual(frame.anchor,anchor);
    frame.sync(camera,null);assert.deepEqual(frame.anchor,anchor);
    assert.equal(frame.uniforms.uOceanAnchorToPatch.value.length(),0);
  }
}
assert.ok(maxPosition<0.0001);assert.ok(maxPatch<0.0001);assert.ok(maxWave<0.0001);assert.ok(maxUv<0.0001);
assert.ok(oldPosition>0.2,'Control must reproduce the rounded point-minus-centre loss.');
assert.ok(rebases>=90);
console.log(JSON.stringify({status:'pass',maxPosition,maxPatch,maxWave,maxUv,oldPosition,rebases}));
