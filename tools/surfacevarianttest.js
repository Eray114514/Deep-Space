import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installSurfaceAtmosphere, prepareSurfaceAtmosphere } from '../src/surface-atmosphere.js';
import { hasSurfaceCloudMedium, surfaceCloudOwner, setCloudSurfacePreparation } from '../src/cloud/surface-clouds.js';
import { cloudSurfaceReceiverReady } from '../src/cloud/cloud-surface-shadow-pass.js';

const bands = { name: 'bands' }, noise = { name: 'noise' };
const owner = { uSpeciesMap: { value: bands }, uNoise3: { value: noise } };
for (const [planet, enabled] of [
  [{ R: 6000000 }, false],
  [{ R: 6000000, cloudSpeciesTex: bands }, false],
  [{ R: 6000000, volCloudMat: { uniforms: owner } }, false],
  [{ R: 6000000, cloudSpeciesTex: bands, volCloudMat: { uniforms: owner } }, true],
  [{ R: 6000000, cloudSpeciesTex: bands, volCloudUniforms: owner }, true],
]) {
  assert.equal(hasSurfaceCloudMedium(planet), enabled);
  const material = new THREE.MeshStandardMaterial();
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  installSurfaceAtmosphere(material, planet, shader);
  assert.equal(shader.defines.SURFACE_CLOUD_MEDIUM, Number(enabled));
  if (enabled) {
    assert.equal(shader.uniforms.cloud_uNoise3.value, noise);
    assert.equal(shader.uniforms.cloud_uSpeciesMap.value, bands);
  }
  material.dispose();
}
// Construction predates cloud publication. Registration cannot capture an
// incomplete uniform dictionary or serialize a cyclic live planet into clones.
const p = { R: 6e6, group: new THREE.Group(), _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(0, 1, 0) };
const m = new THREE.MeshStandardMaterial();p.terrainMaterial = m;let previousDraws = 0;
m.onBeforeRender = () => previousDraws++;
prepareSurfaceAtmosphere(m, p);const draw = m.onBeforeRender;prepareSurfaceAtmosphere(m, p);
assert.equal(m.onBeforeRender, draw);assert.equal(surfaceCloudOwner(m), p);
assert.equal(m.userData.surfaceMedium, undefined);const clone = m.clone();assert.equal(surfaceCloudOwner(clone), undefined);clone.dispose();
p.cloudSpeciesTex = bands;p.volCloudMesh = new THREE.Mesh();
p.volCloudMat = { defines: { PRODUCTION_CLOUD_MEDIUM: 1 }, uniforms: {
  ...owner, uBandsReady: { value: 1 }, uWeatherMapHi: { value: noise }, uCameraLocal: { value: new THREE.Vector3() },
  uSunDir: { value: p.sunDirLocal }, uSecondarySunDir: { value: p.sunDirLocal },
} };
p.weatherStream = { ready: false };assert.equal(cloudSurfaceReceiverReady(p), true);
for (const ready of [false, true]) { p.weatherStream.ready = ready;assert.equal(cloudSurfaceReceiverReady(p), true); }
for (const change of [
  () => { p.volCloudMat.defines.PRODUCTION_CLOUD_MEDIUM = 0; },
  () => { p.cloudVisualEnabled = false; },
  () => { p.volCloudMat.uniforms.uBandsReady.value = 0; },
  () => { p.volCloudMat.uniforms.uSpeciesMap.value = noise; },
]) {
  change();assert.equal(cloudSurfaceReceiverReady(p), false);
  p.volCloudMat.defines.PRODUCTION_CLOUD_MEDIUM = 1;p.cloudVisualEnabled = true;
  p.volCloudMat.uniforms.uBandsReady.value = 1;p.volCloudMat.uniforms.uSpeciesMap.value = bands;
}
const camera = new THREE.PerspectiveCamera();camera.updateMatrixWorld(true);
try {
  setCloudSurfacePreparation(true);m.onBeforeRender({}, new THREE.Scene(), camera);
  assert.equal(previousDraws, 1);assert.equal(m.defines.SURFACE_CLOUD_SCREEN, 1);
  const uniforms = m.userData.surfaceMedium;assert.equal(uniforms.uSurfaceCloudEnabled.value, 0);
  assert.equal(uniforms.cloud_uSpeciesMap.value, bands);
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  installSurfaceAtmosphere(m, p, shader);assert.equal(m.onBeforeRender, draw);
  assert.equal(shader.uniforms.cloud_uSpeciesMap, uniforms.cloud_uSpeciesMap);
  m.onBeforeRender({}, new THREE.Scene(), camera);assert.equal(previousDraws, 2);
} finally { setCloudSurfacePreparation(false);m.dispose(); }
console.log('PASS: surface variants, pre-compile ownership/binding, lazy publication, callback identity, clone safety and forecast-independent production receiver eligibility.');
