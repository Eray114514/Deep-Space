import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { terrainDetailDomains, terrainDetailPhase, terrainDetailGLSL,
  bindTerrainDetailFrame } from '../src/terrain-detail-frame.js';

const domains = terrainDetailDomains(0.0397, 0.3125);
assert.throws(() => terrainDetailDomains(NaN), RangeError);
const circular = (a, b) => Math.abs(a - b - Math.round(a - b));
let maxDouble = 0, maxFloat = 0, oldError = 0, wrongRockPhase = 0;
for (const radius of [6e6, 2e7]) for (const sign of [-1, 1]) {
  const point = new THREE.Vector3(radius + 0.137, -radius * 0.73 + 0.319, sign * radius * 0.41 + 0.031);
  for (const offset of [0, 0.35, -0.35, 31.999, 32.001, -117.42, 4096]) {
    const anchor = point.clone().add(new THREE.Vector3(offset, offset * 0.41, -offset * 0.73));
    const relative = point.clone().sub(anchor);
    for (const domain of domains) {
      const phase = terrainDetailPhase(domain, anchor);
      for (const [i, axis] of ['x', 'y', 'z'].entries()) {
        const expected = point[axis] * domain.scale + domain.shift;
        maxDouble = Math.max(maxDouble, circular(relative[axis] * domain.scale + phase[i], expected));
        const gpu = Math.fround(Math.fround(Math.fround(relative[axis]) * Math.fround(domain.scale)) + Math.fround(phase[i]));
        maxFloat = Math.max(maxFloat, circular(gpu, expected));
        const old = Math.fround(Math.fround(point[axis]) * Math.fround(domain.scale));
        oldError = Math.max(oldError, circular(old + domain.shift, expected));
      }
    }
    const grass = terrainDetailPhase(domains[10], anchor);
    const rock = terrainDetailPhase(domains[11], anchor);
    wrongRockPhase = Math.max(wrongRockPhase, circular(grass[0] * 0.78 + 0.17, rock[0]));
  }
}
assert.ok(maxDouble < 2e-9);
assert.ok(maxFloat < 0.0002, `phase error ${maxFloat}`);
assert.ok(oldError > 0.1, 'Control must expose original planet-scale precision loss.');
assert.ok(wrongRockPhase > 0.1, 'Control must detect reducing before the final rock scale.');
assert.ok(!terrainDetailGLSL(domains).includes('fract('), 'Keep implicit mip derivatives continuous.');

// Same owner references survive shader variants; the actual eye and complete
// body transform own the phases, not nav.pos or the last chunk drawn.
const group = new THREE.Group(), camera = new THREE.PerspectiveCamera();
const planet = { group }, material = new THREE.MeshStandardMaterial();
let previousCalls = 0;
material.onBeforeRender = () => previousCalls++;
const uniforms = bindTerrainDetailFrame(material, planet, domains);
const firstArray = uniforms.uTerrainDomains.value;
let maxTransform = 0;
for (const rebase of [0, 1e8, -1e8, 0]) {
  group.position.set(-6e6 + rebase, -234, 117);
  group.quaternion.setFromEuler(new THREE.Euler(0.32, -0.44, 0.15));
  group.updateMatrixWorld(true);
  camera.position.set(rebase + 2.3, 1.7, -5.1);
  camera.quaternion.setFromEuler(new THREE.Euler(-0.21, 0.61, -0.34));
  camera.updateMatrixWorld(true);
  material.onBeforeRender(null, null, camera);
  const anchor = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(group.matrixWorld.clone().invert());
  domains.forEach((domain, index) => assert.deepEqual(uniforms.uTerrainDomains.value[index].toArray(),
    [...terrainDetailPhase(domain, anchor), domain.scale]));
  const localDelta = new THREE.Vector3(0.031, -0.35, 0.137);
  const viewDelta = localDelta.clone().applyQuaternion(group.quaternion).applyQuaternion(camera.quaternion.clone().invert());
  maxTransform = Math.max(maxTransform, viewDelta.applyMatrix3(uniforms.uTerrainViewToLocal.value).distanceTo(localDelta));
  material.onBeforeRender(null, null, camera);
  assert.equal(uniforms.uTerrainDomains.value, firstArray);
}
assert.equal(previousCalls, 8);
assert.ok(maxTransform < 1e-12);
const source = readFileSync(new URL('../src/shaders-webgl.js', import.meta.url), 'utf8').split('// Living water combines')[0];
assert.ok(!/triDetail\(vLocalPos|surfaceMaterialUv\(vLocalPos/.test(source));
assert.ok(!source.includes('pbrUv * 0.78'), 'Rock color/normal/roughness all own final phases.');
assert.equal((source.match(/Object.assign\(shader.uniforms, detailUniforms\)/g) || []).length, 1);
console.log(JSON.stringify({ status: 'pass', domains: domains.length, maxDouble, maxFloat,
  oldError, wrongRockPhase, maxTransform }));
