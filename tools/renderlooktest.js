import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { createPbrMaterial, PBR_MATERIAL_PROFILES, setSharedPbrEnvironment,
  tagMaterialProfile } from '../src/pbr-materials.js';
import { generateSpaceRadianceData } from '../src/space-radiance.js';

const first = generateSpaceRadianceData('MILKY-038', 256);
const repeat = generateSpaceRadianceData('MILKY-038', 256);
const alternate = generateSpaceRadianceData('MILKY-039', 256);
assert.equal(first.stats.fingerprint, repeat.stats.fingerprint,
  'space radiance changed across identical reloads');
assert.notEqual(first.stats.fingerprint, alternate.stats.fingerprint,
  'space radiance namespace does not respond to seed identity');
assert(first.stats.minLuma > 0.003,
  'a sky direction still falls below the authored non-black radiance floor');
assert(first.stats.bandMeanLuma > first.stats.outsideMeanLuma * 3.5,
  'the diffuse background competes with or erases the Milky Way hierarchy');
assert(first.stats.maxLuma < 0.04,
  'the diffuse background is bright enough to become the source-demo skybox');

assert.equal(PBR_MATERIAL_PROFILES.paintedDielectric.metalness, 0.02);
assert(PBR_MATERIAL_PROFILES.bareAlloy.metalness > 0.8);
assert(PBR_MATERIAL_PROFILES.rubber.roughness > 0.9);
assert(PBR_MATERIAL_PROFILES.glass.envMapIntensity > 1);

const sharedEnvironment = new THREE.Texture();
const localEnvironment = new THREE.Texture();
const sharedMaterial = createPbrMaterial('polymer');
const localProbeMaterial = tagMaterialProfile(new THREE.MeshStandardMaterial(), 'polymer');
localProbeMaterial.envMap = localEnvironment;
const profileRoot = new THREE.Group();
profileRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), sharedMaterial));
profileRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), localProbeMaterial));
setSharedPbrEnvironment(sharedEnvironment, profileRoot);
assert.equal(sharedMaterial.envMap, sharedEnvironment,
  'shared PBR asset did not opt into the current space environment');
assert.equal(localProbeMaterial.envMap, localEnvironment,
  'shared environment traversal overwrote a zone-owned local probe');

const [spaceSource, halcyonSource] = await Promise.all([
  readFile(new URL('../src/space-radiance.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/halcyon/materials.js', import.meta.url), 'utf8'),
]);
assert(!spaceSource.includes('Math.random('), 'space background is not deterministic');
assert(!halcyonSource.includes('Math.random('), 'ship reflection fallback is not deterministic');
console.log(`PASS: deterministic non-black space radiance ${first.stats.fingerprint}; `
  + `Milky Way/outside ${(first.stats.bandMeanLuma / first.stats.outsideMeanLuma).toFixed(2)}x`);
