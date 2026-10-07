import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installSurfaceAtmosphere } from '../src/surface-atmosphere.js';
import { hasSurfaceCloudMedium } from '../src/cloud/surface-clouds.js';

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
console.log('PASS: surface shader variants require both weather bands and their live uniform owner, including retained shared uniforms.');
