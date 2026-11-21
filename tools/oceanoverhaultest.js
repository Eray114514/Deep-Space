import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  OCEAN_ARCHETYPES, createOceanClimate, sampleOceanClimate, resolveOceanArchetype,
  oceanVisualPalette,
} from '../src/ocean-climate.js';
import { computeUnderwaterEnvironment, UnderwaterSystem } from '../src/underwater.js';
import { Planet } from '../src/planet.js';
import { applySystemBodyTuning } from '../src/world-config.js';

// 1. Ocean archetype diversity across worlds without disturbing composition RNG
const archetypes = new Set();
const compositions = new Set();
for (let i = 0; i < 80; i++) {
  const climate = createOceanClimate(`diverse-ocean-${i}`, {
    type: 'ocean',
    equilibriumK: 235 + (i % 6) * 14,
  });
  archetypes.add(climate.archetype);
  compositions.add(climate.composition);
  assert.ok(OCEAN_ARCHETYPES[climate.archetype], `Valid archetype ${climate.archetype}`);
  assert.ok(climate.seaState && climate.seaState.sssStrength > 0);
}
assert.ok(archetypes.size >= 5, `Ocean worlds must span at least 5 distinct sea-state archetypes (got ${archetypes.size})`);
assert.ok(compositions.size >= 4, `Ocean worlds keep 4+ compositions (got ${compositions.size})`);

// Authored pelagic-storm profile (Curie) resolves to storm sea state with strong Langmuir & whitecaps
const stormClimate = createOceanClimate('curie-test', {
  type: 'ocean', oceanClass: 'pelagic-storm', equilibriumK: 278,
});
assert.equal(stormClimate.archetype, 'pelagic-storm');
const lagoonClimate = resolveOceanArchetype('lagoon-test', {
  type: 'lush', composition: 'jade-shelf', oceanClass: 'tropical-lagoon',
});
assert.equal(lagoonClimate.archetype, 'tropical-lagoon');
assert.ok(stormClimate.seaState.langmuirStrength > lagoonClimate.seaState.langmuirStrength * 4,
  'Storm seas must have dramatically stronger wind-driven Langmuir lanes than calm lagoons');
assert.ok(stormClimate.seaState.whitecapStrength > lagoonClimate.seaState.whitecapStrength * 1.8,
  'Storm seas must have heavier breaking whitecaps than calm lagoons');
assert.ok(lagoonClimate.seaState.underwaterClarity > stormClimate.seaState.underwaterClarity * 1.5,
  'Tropical lagoons must be markedly clearer underwater than stormy seas');

// 2. Depth-graded Beer-Lambert underwater optics
const clearPlanet = {
  liquid: 'water',
  oceanClimate: createOceanClimate('reef-world', { type: 'lush', oceanClass: 'tropical-lagoon' }),
};
const shallowEnv = computeUnderwaterEnvironment(clearPlanet, { subDepth: 2, day: 1, sunset: 0 });
const midEnv = computeUnderwaterEnvironment(clearPlanet, { subDepth: 24, day: 1, sunset: 0 });
const abyssEnv = computeUnderwaterEnvironment(clearPlanet, { subDepth: 110, day: 1, sunset: 0 });
assert.ok(shallowEnv.sunTransmit[0] > midEnv.sunTransmit[0] && midEnv.sunTransmit[0] > abyssEnv.sunTransmit[0],
  'Red solar light must attenuate monotonically with depth');
assert.ok(midEnv.sunTransmit[2] > midEnv.sunTransmit[0] * 3,
  'Blue/cyan light must penetrate far deeper than red in clear water (Beer-Lambert)');
assert.ok(shallowEnv.shaftStrength > 0.5 && abyssEnv.shaftStrength === 0,
  'Sunlit god-ray shafts must shine in shallow epipelagic water and vanish in the abyss');
assert.ok(shallowEnv.fogDensity < abyssEnv.fogDensity,
  'Underwater fog density should tighten gracefully from bright shallows into dark trenches');

const bioPlanet = {
  liquid: 'water',
  oceanClimate: createOceanClimate('bio-world', { type: 'ocean', oceanClass: 'abyssal-biolum' }),
};
const bioNight = computeUnderwaterEnvironment(bioPlanet, { subDepth: 15, day: 0, sunset: 0 });
assert.ok(bioNight.biolumGlow > 0.8, 'Bioluminescent ocean must glow brightly at night underwater');

const toxicPlanet = {
  liquid: 'toxic',
  oceanClimate: createOceanClimate('acid-world', { type: 'toxic' }),
};
const toxicEnv = computeUnderwaterEnvironment(toxicPlanet, { subDepth: 6, day: 1, sunset: 0 });
assert.ok(toxicEnv.fogDensity > shallowEnv.fogDensity * 2,
  'Toxic acid seas must be murkier than clear tropical lagoons');

// 3. UnderwaterSystem pure-Node lifecycle (marine snow, sun shafts, spray, dispose)
const fx = new UnderwaterSystem();
fx.update({
  dt: 0.016,
  underwater: false,
  planet: clearPlanet,
  upDir: new THREE.Vector3(0, 1, 0),
});
assert.equal(fx.snowPoints.visible, false);
assert.equal(fx.shaftGroup.visible, false);
fx.update({
  dt: 0.016,
  underwater: true,
  planet: clearPlanet,
  subDepth: 5,
  day: 1,
  sunset: 0,
  upDir: new THREE.Vector3(0, 1, 0),
  sunDirWorld: new THREE.Vector3(0.4, 0.85, 0.3).normalize(),
  cameraPosUniv: new THREE.Vector3(10, 20, 30),
});
assert.equal(fx.snowPoints.visible, true, 'Marine snow & micro-bubbles activate underwater');
assert.equal(fx.shaftGroup.visible, true, 'Snell-refracted sunlit shafts activate in sunlit shallows');
fx.emitSplash(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), { count: 16 });
fx.update({ dt: 0.05, underwater: false, planet: clearPlanet, upDir: new THREE.Vector3(0, 1, 0) });
assert.equal(fx.sprayPoints.visible, true, 'Splash spray droplets render and simulate after water entry');
fx.dispose();

// 4. Planet wiring check
const stormPlanet = new Planet({
  seed: 'storm-ocean-planet',
  name: 'Curie Replica',
  posUniv: new THREE.Vector3(),
  type: 'ocean',
  radius: 560000,
  deferRoots: true,
  tuning: { oceanProfile: 'pelagic-storm' },
});
assert.equal(stormPlanet.oceanClimate.archetype, 'pelagic-storm');
assert.ok(stormPlanet.waterStyle.foam >= 1.4);
const sample = sampleOceanClimate(stormPlanet.oceanClimate, { x: 1, y: 0, z: 0 }, { depth: 400 });
assert.equal(sample.archetype, 'pelagic-storm');
stormPlanet.dispose();

// 5. Canonical oceanVisualPalette coherence (star map, seabed, liquidColor)
const copperPal = oceanVisualPalette({ composition: 'copper-brine', archetype: 'acid-brine' });
assert.ok(copperPal.sysMid[0] > copperPal.sysMid[2] * 1.6, 'copper-brine sysview palette must be warm amber, not blue');
const violetPal = oceanVisualPalette({ composition: 'mineral-violet', archetype: 'mineral-exotic' });
assert.ok(violetPal.sysMid[0] > violetPal.sysMid[1] && violetPal.sysMid[2] > violetPal.sysMid[1], 'mineral-violet sysview palette must be violet');
const biolumPal = oceanVisualPalette({ composition: 'bioluminescent', archetype: 'abyssal-biolum' });
assert.ok(Array.isArray(biolumPal.biolumGlow) && biolumPal.biolumGlow[1] > 150, 'bioluminescent palette must expose night glow');

let copperSeed = null;
for (let i = 0; i < 60 && !copperSeed; i++) {
  const s = `copper-check-${i}`;
  if (createOceanClimate(s, { type: 'ocean', equilibriumK: 295 }).composition === 'copper-brine') copperSeed = s;
}
assert.ok(copperSeed, 'Should find a deterministic copper-brine ocean seed');
const copperPlanet = new Planet({
  seed: copperSeed, name: 'Copper Test', posUniv: new THREE.Vector3(),
  type: 'ocean', radius: 320000, deferRoots: true, equilibriumK: 295,
});
assert.equal(copperPlanet.oceanClimate.composition, 'copper-brine');
assert.ok(copperPlanet.liquidColor.r > copperPlanet.liquidColor.b, 'copper-brine Planet.liquidColor must be warm, not blue');
assert.ok(copperPlanet.pal.sea[1].c.r > copperPlanet.pal.sea[1].c.b, 'copper-brine seabed palette must match ocean composition');
copperPlanet.dispose();

const tunedSpec = applySystemBodyTuning(
  { bodies: [{ bodyId: 'planet-1', type: 'lush', radius: 200000 }], compactObjects: [] },
  (id) => (id === 'planet-1' ? { type: 'ocean', oceanProfile: 'pelagic-storm' } : null),
);
assert.equal(tunedSpec.bodies[0].oceanProfile, 'pelagic-storm', 'applySystemBodyTuning must forward oceanProfile for sysview parity');

console.log(`PASS: ocean overhaul (${archetypes.size} sea-state archetypes, Beer-Lambert depth optics, Snell sun shafts, marine snow, splash spray, Planet/sysview palette coherence)`);
