import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WeaponLighting } from '../src/weapon-lighting.js';
import { weaponSkyPixels } from '../src/weapon-sky-probe.js';
import { FOREGROUND_LAYER, SHIP_INTERIOR_LAYER, WEAPON_FOREGROUND_LAYER } from '../src/render-layers.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
scene.add(camera);
const rig = new WeaponLighting(scene, camera);
const metal = new THREE.MeshStandardMaterial({ metalness: 0.93, roughness: 0.2 });
const weapon = new THREE.Mesh(new THREE.BoxGeometry(), metal);
rig.register(weapon);
const texture = new THREE.Texture();
const radiance = {
  sources: [{ direction: new THREE.Vector3(0, 1, 0), color: new THREE.Color(1, 0.8, 0.6),
    irradiance: 1, visibility: 1 }],
  directScale: 0.6, spaceEnvironment: texture, environmentIntensity: 0.3,
  components: { direct: true, indirect: true, reflections: true },
};
rig.update(radiance, { day: 1 }, true);
assert.equal(metal.envMap, texture);
assert.equal(metal.metalness, 0.93, 'registration preserves authored materials');
assert.ok(rig.suns[0].intensity > 0.5);
assert.ok(rig.root.visible);
const dayReflection = metal.envMapIntensity;
for (const object of [weapon, rig.ambient, ...rig.suns]) {
  assert.equal(object.layers.mask, 1 << WEAPON_FOREGROUND_LAYER);
  assert.equal(object.layers.mask & ((1 << FOREGROUND_LAYER) | (1 << SHIP_INTERIOR_LAYER)), 0);
}
rig.update(radiance, { day: 0 }, true);
assert.equal(rig.suns[0].intensity, 0, 'sun does not illuminate equipment through the night side');
assert.ok(metal.envMapIntensity < dayReflection * 0.1);
radiance.sources[0].irradiance = 0;
rig.update(radiance, { day: 0.08, eclipse: 1 }, true);
assert.equal(rig.suns[0].intensity, 0);
radiance.sources[0].irradiance = 0.5;
radiance.sources[0].visibility = 0.5;
rig.update(radiance, { day: 1 }, true);
assert.ok(Math.abs(rig.suns[0].intensity - 0.48) < 1e-12,
  'source visibility is already part of irradiance, not squared');
const lateMaterial = new THREE.MeshStandardMaterial();
rig.register(new THREE.Mesh(new THREE.BoxGeometry(), lateMaterial));
rig.update(radiance, { day: 1 }, true);
assert.equal(lateMaterial.envMap, texture, 'late imported assets receive radiance');
radiance.components = { direct: false, indirect: false, reflections: false };
rig.update(radiance, { day: 1 }, false);
assert.equal(rig.suns[0].intensity, 0);
assert.equal(rig.ambient.intensity, 0);
assert.equal(metal.envMapIntensity, 0);
assert.equal(rig.root.visible, false);
rig.dispose();
assert.equal(rig.root.parent, null);
const up = new THREE.Vector3(0, 1, 0);
const daylight = weaponSkyPixels({ day: 1, atmosphere: 1, skyIrradiance: 1 }, up);
const night = weaponSkyPixels({ day: 0, atmosphere: 1, skyIrradiance: 0 }, up);
const vacuum = weaponSkyPixels({ day: 1, atmosphere: 0, skyIrradiance: 0 }, up);
const inverted = weaponSkyPixels({ day: 1, atmosphere: 1, skyIrradiance: 1 }, up.clone().negate());
let energy = 0;
for (let i = 0; i < daylight.data.length; i += 4) {
  energy += daylight.data[i] + daylight.data[i + 1] + daylight.data[i + 2];
  assert.equal(night.data[i] + night.data[i + 1] + night.data[i + 2], 0);
  assert.equal(vacuum.data[i] + vacuum.data[i + 1] + vacuum.data[i + 2], 0);
  assert.ok(Number.isFinite(daylight.data[i]));
}
assert.ok(energy / (daylight.width * daylight.height * 3) > 0.2,
  'day sky provides outdoor radiance rather than a boosted galaxy texture');
const top = ((daylight.height - 1) * daylight.width + 10) * 4;
assert.ok(daylight.data[top] > inverted.data[top] * 2, 'probe hemisphere follows planet up');
texture.dispose();
console.log('weapon lighting ownership, day/night, eclipse and late material tests passed');
