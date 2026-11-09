import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeCloudVolumeMaterial, disposeCloudNoiseTexture } from '../src/clouds-webgl.js';
import { CloudFarSplitPass } from '../src/cloud/cloud-far-split-pass.js';
import { VOLUME_LAYER } from '../src/render-layers.js';

const source = makeCloudVolumeMaterial({ R: 6e6 }, {
  rIn: 6001000, rOut: 6015000, ox: .1, oy: .2, oz: .3, localWeather: true,
}, null, null, null);
source.defines.CLOUD_FAR_VIEW = 1;
const scene = new THREE.Scene(), geometry = new THREE.SphereGeometry(1);
const mesh = new THREE.Mesh(geometry, source);
mesh.layers.set(VOLUME_LAYER);scene.add(mesh);
const current = new THREE.WebGLRenderTarget(32, 24);
const camera = new THREE.PerspectiveCamera();
let target, draw, draws = [];
const renderer = {
  extensions: { has: () => true }, getContext: () => ({ isContextLost: () => false }),
  setRenderTarget(value) { target = value; }, clear() {}, render() { draws.push(target);draw?.(); },
};
const split = new CloudFarSplitPass(renderer);
const request = { mesh, material: source, cacheVariants: [0] };
try {
  const prepared = split.requests(scene, request, current);
  assert.equal(prepared.length, 4);
  const dictionaries = prepared.map(row => row.material.uniforms);
  const replacement = { value: 1 };
  source.uniforms.air_uEnabled = replacement;
  assert.equal(split.render(scene,camera,current,null),true);
  assert.deepEqual(draws,[current]);
  assert.equal(split.scratch,null);
  assert.equal(prepared[0].material.uniforms,dictionaries[0]);
  assert.equal(dictionaries[0].air_uEnabled,replacement);
  source.uniforms.uColumnsReady.value = 1;
  const bank = { disposed:false };
  draws = [];
  assert.equal(split.render(scene,camera,current,bank),true);
  assert.deepEqual(draws,[...split.scratch,current]);
  assert.equal(dictionaries[3].uSplitPoint.value,split.scratch[0].texture);
  draw = () => { throw Error('failed payload draw'); };
  const frames = split.frames;
  assert.throws(() => split.render(scene,camera,current,bank),/failed payload draw/);
  assert.equal(mesh.material,source);assert.equal(split.frames,frames);
  draw = undefined;
  split.releaseScratch();
  assert.equal(dictionaries[3].uSplitPoint.value,null);
  assert.equal(dictionaries[3].uSplitCached.value,null);
  assert.ok(prepared.every((row,i) => row.material.uniforms === dictionaries[i]));
  const other = new THREE.Mesh(geometry,source);other.layers.set(VOLUME_LAYER);scene.add(other);
  assert.equal(split.requests(scene,request,current),null);
  other.visible = false;
  const direct = split.requests(scene,{ ...request,cacheVariants:[0,1] },current);
  assert.equal(direct.length,2);
  source.defines.CLOUD_FAR_CACHE = 1;
  draws = [];
  assert.equal(split.render(scene,camera,current,bank),true);
  assert.equal(split.lastRoute,'cachedDirect');assert.deepEqual(draws,[current]);
  source.dispose();assert.equal(split.plan,null);assert.equal(split.materials,null);
} finally {
  split.dispose();current.dispose();geometry.dispose();source.dispose();disposeCloudNoiseTexture();
}
console.log('PASS split closure, stable prepared uniform dictionaries, scratch retirement, draw failure and multi-owner exclusion');
