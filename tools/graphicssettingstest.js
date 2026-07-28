import assert from 'node:assert/strict';
import { GRAPHICS_SETTINGS_KEY, QUALITY_PROFILES, chooseAutomaticQuality,
  resolveGraphicsSettings, resolveQualityProfile, writeGraphicsSettings } from '../src/graphics-settings.js';
import { createEnvironmentState, updateEnvironmentState } from '../src/environment-state.js';
import * as THREE from 'three';
import { WaterInteractionField } from '../src/water-interaction.js';

const values = new Map();
const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
writeGraphicsSettings({ quality: 'balanced', renderer: 'webgl' }, storage);
assert.equal(JSON.parse(values.get(GRAPHICS_SETTINGS_KEY)).version, 1);
assert.equal(JSON.parse(values.get(GRAPHICS_SETTINGS_KEY)).renderer, 'auto');
assert.deepEqual(resolveGraphicsSettings({ params: new URLSearchParams(), storage }).quality, 'balanced');
const overridden = resolveGraphicsSettings({ params: new URLSearchParams('quality=low&renderer=webgpu'), storage });
assert.equal(overridden.quality, 'performance');
assert.equal(overridden.renderer, 'webgpu');
assert.equal(overridden.source.quality, 'url');
assert.equal(chooseAutomaticQuality('Intel(R) Arc(TM) Graphics'), 'performance');
assert.equal(resolveQualityProfile({ quality: 'auto' }, 'NVIDIA RTX 5080 Laptop GPU').id, 'ultra');
assert.equal(QUALITY_PROFILES.performance.dprMin, 0.85);
assert.equal(QUALITY_PROFILES.ultra.cloudSteps, 124);

const env = createEnvironmentState();
let previous = 0;
let previousGameplay = 0;
for (let height = 110000; height >= 0; height -= 1000) {
  updateEnvironmentState(env, { cameraHeight: height, atmosphereHeight: 100000, atmosphereDensity: 1, solarElevation: 0.1 });
  assert.ok(env.atmosphere + 1e-9 >= previous, 'atmosphere entry is monotonic');
  assert.ok(env.gameplayAtmosphere + 1e-9 >= previousGameplay,
    'gameplay atmosphere entry is monotonic');
  assert.ok(env.directTransmittance >= 0 && env.directTransmittance <= 1);
  previous = env.atmosphere;
  previousGameplay = env.gameplayAtmosphere;
}
updateEnvironmentState(env, {
  cameraHeight: 80000, atmosphereHeight: 100000,
  atmosphereDensity: 1, solarElevation: 0.4,
});
assert.ok(env.atmosphere < 0.0001,
  'an 80 km gameplay shell must not turn the physical zenith blue');
assert.ok(env.gameplayAtmosphere > 0.05,
  'flight handling still enters continuously across the authored shell');
updateEnvironmentState(env, {
  cameraHeight: 12000, atmosphereHeight: 100000,
  atmosphereDensity: 1, solarElevation: 0.4,
});
assert.ok(env.atmosphere > 0.15 && env.atmosphere < 0.3,
  'physical sky column should build gradually below the stratosphere');
assert.ok(env.exposure >= 0.92 && env.exposure <= 1.18);
const water = new WaterInteractionField(4);
water.setPlanet('test-water');
water.inject(new THREE.Vector3(), { strength: 1.2, speed: 5, foam: 0.8 });
water.update(0.5);
assert.equal(water.activeCount(), 1);
assert.ok(Number.isFinite(water.sample(new THREE.Vector3(2.5, 0, 0)).height));
water.setPlanet('other-water');
assert.equal(water.activeCount(), 0, 'interaction field resets between planets');
console.log('graphics settings and environment state tests passed');
