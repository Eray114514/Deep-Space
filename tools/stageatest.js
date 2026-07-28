import assert from 'node:assert/strict';
import * as THREE from 'three';
import { generateSystemSpec } from '../src/astronomy.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { Planet } from '../src/planet.js';
import { skirtDropForMorph } from '../src/quadtree.js';
import {
  applySystemBodyTuning,
  getGalaxyConfig,
  resolveBodyTuning,
} from '../src/world-config.js';

function fibonacciDirections(count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + 0.5) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * 2.399963229728653;
    result.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return result;
}

function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { mean, sd, min: Math.min(...values), max: Math.max(...values) };
}

const galaxy = getGalaxyConfig();
const catalog = new GalaxyCatalog(galaxy.seed);
const homeSystem = applySystemBodyTuning(
  generateSystemSpec(galaxy.seed, catalog.getSystem(HOME_SYSTEM_ID)),
  (bodyId) => resolveBodyTuning({
    galaxyId: galaxy.id,
    seed: galaxy.seed,
    systemId: HOME_SYSTEM_ID,
    bodyId,
  }),
);
const homeBody = homeSystem.bodies.find((body) => body.bodyId === 'planet-0');
const homeTuning = resolveBodyTuning({
  galaxyId: galaxy.id,
  seed: galaxy.seed,
  systemId: homeSystem.systemId,
  bodyId: homeBody.bodyId,
});
const home = new Planet({
  seed: homeBody.seed,
  name: homeBody.name,
  posUniv: new THREE.Vector3(),
  type: homeBody.type,
  radius: homeBody.radius,
  atmosphere: homeBody.atmosphere,
  clouds: homeBody.clouds,
  formation: homeBody.formation,
  ringSystem: homeBody.ringSystem,
  tuning: homeTuning,
});

try {
  assert.equal(home.R, 900000, 'authored home radius must own the rendered scale');
  assert.equal(homeBody.radius, 900000,
    'the tuned astronomy dossier must expose the 900 km radius to system preview consumers');
  assert.equal(resolveBodyTuning({
    galaxyId: galaxy.id,
    seed: galaxy.seed,
    systemId: homeSystem.systemId,
    bodyId: 'planet-0-moon-0',
  }).orbitRadiusMeters, 3200000);

  const directions = fibonacciDirections(6000);
  const heights = directions.map((direction) => home.height(direction, home.fullMaxFreq));
  const relief = Math.max(...heights) - Math.min(...heights);
  assert.ok(relief / home.R < 0.025,
    `home relief/R ${(relief / home.R * 100).toFixed(2)}% must read as a planet`);
  const canonicalCell = (Math.PI / 2) * home.R
    / (home.canonicalGridCells * (2 ** home.canonicalMaxLevel));
  assert.ok(canonicalCell <= 1.5,
    `home finest canonical terrain spacing must be <=1.5 m, got ${canonicalCell.toFixed(2)} m`);

  // Scan maxFreq continuously. Any remaining conditional feature gates must
  // blend instead of admitting hundreds of metres in one step.
  const continuityDirs = directions.slice(0, 700);
  const lo = Math.log2(home.freqAtLevel(0));
  const hi = Math.log2(home.fullMaxFreq);
  let previous = continuityDirs.map((direction) => home.height(direction, 2 ** lo));
  let worstRms = 0;
  const continuitySteps = 1100;
  for (let step = 1; step <= continuitySteps; step++) {
    const maxFreq = 2 ** (lo + (hi - lo) * step / continuitySteps);
    const current = continuityDirs.map((direction) => home.height(direction, maxFreq));
    const rms = Math.sqrt(current.reduce((sum, value, index) =>
      sum + (value - previous[index]) ** 2, 0) / current.length);
    worstRms = Math.max(worstRms, rms);
    previous = current;
  }
  assert.ok(worstRms < 24, `continuous LOD sweep must stay below 24 m rms, got ${worstRms.toFixed(2)} m`);

  const masks = directions.map((direction) => {
    const reg = home.nD.fbm(direction.x + 53.1, direction.y - 17.7, direction.z + 29.3,
      home.regFreq, 2, 0.5, 2.1, home.fullMaxFreq);
    const belt = THREE.MathUtils.smoothstep(reg,
      -0.32 + home.beltBias, 0.34 + home.beltBias);
    const wf = home.warpFreq, wa = home.warpAmp;
    const ax = direction.x + home.nB.noise(direction.x * wf + 31.4, direction.y * wf, direction.z * wf) * wa;
    const ay = direction.y + home.nB.noise(direction.x * wf, direction.y * wf + 47.2, direction.z * wf) * wa;
    const az = direction.z + home.nB.noise(direction.x * wf, direction.y * wf, direction.z * wf + 71.7) * wa;
    const continent = home.nA.fbm(ax, ay, az, home.contFreq, 4, 0.52, 2.05, home.fullMaxFreq);
    const foothills = THREE.MathUtils.smoothstep(continent,
      home.mountMaskLo - 0.18, home.mountMaskHi);
    return foothills * (0.34 + 0.66 * belt);
  });
  const mountainFree = masks.filter((value) => value <= 0.002).length / masks.length;
  assert.ok(mountainFree < 0.4,
    `mountain-free surface ${(mountainFree * 100).toFixed(1)}% must not form isolated ranges`);

  const depths = heights.filter((height) => height < home.seaLevel)
    .map((height) => home.seaLevel - height);
  const depthScale = Math.max(60,
    (home.seaLevel + home.hAmp * 0.6) * home.waterStyle.clarity);
  const extinction = [0.11, 0.035, 0.012]
    .map((value) => value / Math.max(0.45, home.waterStyle.clarity));
  const absorption = depths.map((depth) => {
    const hazeT = Math.min(1, Math.max(0, depth / (depthScale * 0.4)));
    const depthHaze = hazeT * hazeT * (3 - 2 * hazeT) * 0.9;
    const transmission = extinction.map((value) =>
      Math.exp(-2 * value * depth) * (1 - depthHaze));
    return 1 - (0.2126 * transmission[0] + 0.7152 * transmission[1] + 0.0722 * transmission[2]);
  });
  const absorptionStats = stats(absorption);
  assert.ok(absorptionStats.sd >= 0.04,
    `effective water-column spread ${absorptionStats.sd.toFixed(4)} must remain visible`);
  const attenuation99 = extinction.map((value) => -Math.log(0.01) / (2 * value));
  assert.ok(attenuation99[0] >= 15 && attenuation99[0] <= 35,
    'red water-column attenuation must occur over tens of metres');
  assert.ok(attenuation99[1] >= 45 && attenuation99[1] <= 100,
    'green water-column attenuation must outlive red without surviving kilometres');
  assert.ok(attenuation99[2] >= 140 && attenuation99[2] <= 280,
    'blue water-column attenuation must penetrate deepest');
  const channelTransmissionAt55m = extinction.map((value) => Math.exp(-2 * value * 55));
  assert.ok(channelTransmissionAt55m[0] < 0.01
    && channelTransmissionAt55m[1] < 0.08
    && channelTransmissionAt55m[2] > channelTransmissionAt55m[1] * 4,
  '55 m water must read blue/deep rather than reveal a pale sea floor');

  assert.equal(skirtDropForMorph(0), 0.08);
  assert.ok(Math.abs(skirtDropForMorph(100) - 112.04) < 1e-9);
  assert.ok(skirtDropForMorph(32.5) < 50,
    'near-surface skirts track the real parent-child gap instead of kilometre-scale cell size');

  const oceanBody = homeSystem.bodies.find((body) => body.bodyId === 'planet-1');
  const oceanTuning = resolveBodyTuning({
    galaxyId: galaxy.id,
    seed: galaxy.seed,
    systemId: homeSystem.systemId,
    bodyId: oceanBody.bodyId,
  });
  const ocean = new Planet({
    seed: oceanBody.seed,
    name: oceanBody.name,
    posUniv: new THREE.Vector3(),
    type: oceanBody.type,
    radius: oceanBody.radius,
    atmosphere: oceanBody.atmosphere,
    clouds: oceanBody.clouds,
    formation: oceanBody.formation,
    ringSystem: oceanBody.ringSystem,
    tuning: oceanTuning,
  });
  try {
    assert.equal(ocean.type, 'ocean', 'home-system planet-1 is the curated ocean category');
    assert.equal(ocean.R, 560000);
    assert.ok(ocean.waterStyle.swell >= home.waterStyle.swell * 2,
      'curated pelagic world must carry a visibly rough storm sea-state');
    const oceanHeights = directions.map((direction) =>
      ocean.height(direction, ocean.fullMaxFreq));
    const oceanDepths = oceanHeights.filter((height) => height < ocean.seaLevel)
      .map((height) => ocean.seaLevel - height)
      .sort((a, b) => a - b);
    const oceanCoverage = oceanDepths.length / oceanHeights.length;
    const oceanMedianDepth = oceanDepths[Math.floor(oceanDepths.length * 0.5)];
    const oceanP90Depth = oceanDepths[Math.floor(oceanDepths.length * 0.9)];
    assert.ok(oceanCoverage >= 0.90 && oceanCoverage <= 0.95,
      `pelagic world must retain 5–10% island land, got ${(oceanCoverage * 100).toFixed(1)}% water`);
    assert.ok(oceanMedianDepth >= 350 && oceanMedianDepth <= 1200,
      `pelagic median depth must read as a broad shallow sea, got ${oceanMedianDepth.toFixed(0)} m`);
    assert.ok(oceanP90Depth < 2500,
      `pelagic shelves must dominate over abyssal terrain, p90=${oceanP90Depth.toFixed(0)} m`);
    assert.deepEqual(oceanBody.atmosphere.composition, ['N₂', 'O₂', 'H₂O']);
    assert.equal(oceanBody.clouds.regime, '广域风暴云系');
  } finally {
    ocean.dispose();
  }

  console.log('PASS: Stage A terrain scale, LOD continuity, mountain continuity, water-column and sea-state contracts');
  console.log(JSON.stringify({
    radius: home.R,
    canonicalCell,
    reliefRatio: relief / home.R,
    worstRms,
    mountainFree,
    absorption: absorptionStats,
    attenuation99,
  }, null, 2));
} finally {
  home.dispose();
}
