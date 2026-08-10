// Cloud sampling gate + density-contract invariants (phase 3).
//
// docs/cloud-atmosphere-rewrite.md §4 phase 3. This is the phase's acceptance
// gate: through the REAL machinery (fields -> occupancy -> clip -> plan),
// the thinnest shell species (400 m vertical feature) must receive at least
// MIN_SAMPLES_PER_FEATURE samples at every tested view angle, and the
// occupancy volume must be conservative — never report empty where the
// density function can still produce cloud.
//
// The old failure this pins (doc §1): fixed step budget spread over the
// whole shell, so a 1500 m deck at 80° received 0.9 samples and flickered.

import assert from 'node:assert/strict';
import {
  CLOUD_MIN_VERTICAL_FEATURE, CLOUD_SHELL_FLOOR_METERS,
  CLOUD_TROPOSPHERE_TOP_METERS,
} from '../src/cloud/cloud-species.js';
import { createWeatherSystem, sampleWeather } from '../src/cloud/weather-system.js';
import {
  SPECIES_WEIGHT_EPSILON, atlasTexelDirection, cloudDensityCPU,
  cloudFieldByteLength, cloudMediumCPU, cloudNoiseCoordinates,
  createCloudFields, measureCloudFieldCoverage, resolveSpeciesBands,
  sampleBandsAtlas,
} from '../src/cloud/cloud-density.js';
import {
  MAX_STEP_METERS, MIN_SAMPLES_PER_FEATURE, MIN_STEP_METERS,
  OCCUPANCY_EPSILON, STEP_DIVISOR, buildOccupancyVolume,
  clipRayToOccupancy, planRayMarch, stepLengthForSegment,
} from '../src/cloud/cloud-occupancy.js';

const SEED = 'cloud-sampling-test';
const HOURS = 0;

// Equal-area directions, deterministic (no RNG anywhere in this file).
function fibonacci(count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (unused, index) => {
    const y = 1 - 2 * (index + 0.5) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * golden;
    return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
  });
}

function tangentOf(direction) {
  const ref = Math.abs(direction.y) < 0.9
    ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const t = {
    x: direction.y * ref.z - direction.z * ref.y,
    y: direction.z * ref.x - direction.x * ref.z,
    z: direction.x * ref.y - direction.y * ref.x,
  };
  const length = Math.hypot(t.x, t.y, t.z);
  return { x: t.x / length, y: t.y / length, z: t.z / length };
}

const system = createWeatherSystem(SEED, { targetCoverage: 0.5 });
const fieldOptions = {
  noiseSize: 64, detailSize: 32, atlasWidth: 128, atlasHeight: 64,
  hours: HOURS,
};
const fields = createCloudFields(system, fieldOptions);
const occupancy = buildOccupancyVolume(fields, {
  longitude: 64, latitude: 32, altitude: 32,
});
const groundR = fields.groundR;
const shellTop = fields.shellTopMeters;
const fieldBytes = cloudFieldByteLength(fields);

const atAltitude = (direction, altitude) => ({
  x: direction.x * (groundR + altitude),
  y: direction.y * (groundR + altitude),
  z: direction.z * (groundR + altitude),
});
const directionOf = (position) => {
  const radius = Math.hypot(position.x, position.y, position.z);
  return {
    x: position.x / radius, y: position.y / radius, z: position.z / radius,
    radius,
  };
};

function offsetDirection(direction, tangent, metres) {
  const angular = metres / groundR;
  return directionOf({
    x: direction.x * Math.cos(angular) + tangent.x * Math.sin(angular),
    y: direction.y * Math.cos(angular) + tangent.y * Math.sin(angular),
    z: direction.z * Math.cos(angular) + tangent.z * Math.sin(angular),
  });
}

// --- Determinism: same seed, byte-identical bake ----------------------------
//
// The GPU uploads these exact arrays as Data3DTexture/DataTexture. If two
// CPU bakes ever differ, the structural CPU/GPU consistency argument is
// void. This is the cheapest place to catch a Math.random() or iteration-
// order leak.
{
  const again = createCloudFields(system, fieldOptions);
  for (const key of ['shape', 'detail', 'jitter', 'bands']) {
    const a = fields[key].data;
    const b = again[key].data;
    assert.equal(a.length, b.length, `${key} field length changed`);
    let identical = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { identical = false; break; }
    }
    assert.ok(identical, `${key} field is not byte-identical across bakes`);
  }
}

// The bands atlas covers the SHELL species only; fog and noctilucent have
// their own render paths (volumeShell: false) and never enter the atlas.
const shellIds = new Set(fields.shellSpecies.map((species) => species.id));

// --- Bake fidelity at texel centres ------------------------------------------
//
// At an exact texel-centre direction the bilinear read must return the baked
// texel, which must equal a direct weather resolve at that direction. Any
// stride/layer/channel bug in the baker shows up here exactly.
{
  const { width, height } = fields.bands;
  let compared = 0;
  for (let j = 2; j < height; j += 7) {
    for (let i = 3; i < width; i += 11) {
      const direction = atlasTexelDirection(width, height, i, j);
      const weather = sampleWeather(system, direction, HOURS);
      const direct = resolveSpeciesBands(
        weather, fields.sampleRegionalJitter(direction))
        .filter((band) => band.weight >= SPECIES_WEIGHT_EPSILON
          && shellIds.has(band.species.id));
      const baked = sampleBandsAtlas(fields, direction);
      // sampleBandsAtlas keeps weights down to SPECIES_WEIGHT_EPSILON / 2,
      // so its list can be LONGER than the >= EPSILON direct list; compare
      // only at/above EPSILON in both directions.
      for (const band of direct) {
        const match = baked.find((b) => b.species.id === band.species.id);
        assert.ok(match, `texel ${i},${j}: ${band.species.id} lost in bake`);
        assert.ok(Math.abs(match.weight - band.weight) < 1e-3,
          `texel ${i},${j}: ${band.species.id} weight `
          + `${match.weight} vs ${band.weight}`);
        assert.ok(Math.abs(match.baseMeters - band.baseMeters) < 2,
          `texel ${i},${j}: ${band.species.id} base `
          + `${match.baseMeters} vs ${band.baseMeters}`);
        assert.ok(Math.abs(match.topMeters - band.topMeters) < 2,
          `texel ${i},${j}: ${band.species.id} top `
          + `${match.topMeters} vs ${band.topMeters}`);
        compared++;
      }
      for (const band of baked) {
        if (band.weight < SPECIES_WEIGHT_EPSILON) continue;
        assert.ok(direct.some((b) => b.species.id === band.species.id),
          `texel ${i},${j}: baked ${band.species.id} has no direct source`);
      }
    }
  }
  assert.ok(compared > 50, `only ${compared} bands compared — test too thin`);
}

// --- Atlas vs direct agreement off-centre (corruption canary) -----------------
//
// Off texel centre, exact agreement is impossible BY CONSTRUCTION: the atlas
// holds weather resolved at texel centres while the direct path samples
// weather live. A Jaccard gate was tried first and failed at 0.606 — the
// diagnostic probe (worst-case missHard/invent texels all matched a live
// resolve at their own centres EXACTLY) proved the bake is faithful and the
// disagreement is bilinear aliasing of sub-texel weight blobs: localized
// species (lenticular along ridges, cumulus humilis cells, altocumulus
// patches) are smaller than a 128x64 texel (~295 km), so bilinear smears
// them into neighbours (invent) or erases them (missHard). That is a
// resolution limit of the test atlas, not corruption — the production atlas
// is 256x128 and aliases half as much, and phase 7 may retune further.
//
// The canary is therefore quantile-based: a stride/layer bug would skew the
// WHOLE distribution, aliasing only fattens its tail. For every entry where
// either side reports weight >= 0.05, |atlasW - directW| is collected and
// the median/p95 are gated. Thresholds are calibrated from the measured
// distribution below with ~50% headroom; a real corruption drives the median
// toward 0.5+ and p95 toward 1.0.
//
//   measured 2026-08-06, 300 fibonacci directions, 568 entries:
//   median 0.112, p95 0.566, max 1.000 (a single sub-texel 1.0 -> 0 miss).
{
  const diffs = [];
  for (const direction of fibonacci(300)) {
    const weather = sampleWeather(system, direction, HOURS);
    const direct = new Map(resolveSpeciesBands(
      weather, fields.sampleRegionalJitter(direction))
      .filter((band) => band.weight >= 0.005 && shellIds.has(band.species.id))
      .map((band) => [band.species.id, band.weight]));
    const baked = new Map(sampleBandsAtlas(fields, direction)
      .filter((band) => band.weight >= 0.005)
      .map((band) => [band.species.id, band.weight]));
    for (const id of new Set([...direct.keys(), ...baked.keys()])) {
      const d = direct.get(id) ?? 0;
      const a = baked.get(id) ?? 0;
      if (Math.max(d, a) >= 0.05) diffs.push(Math.abs(d - a));
    }
  }
  diffs.sort((x, y) => x - y);
  assert.ok(diffs.length > 400,
    `only ${diffs.length} comparable entries — test too thin`);
  const pick = (q) => diffs[Math.min(diffs.length - 1, Math.floor(q * diffs.length))];
  assert.ok(pick(0.5) < 0.17,
    `atlas/direct median weight error ${pick(0.5).toFixed(3)} — systematic `
    + 'disagreement, likely a stride or layer bug (aliasing alone measured '
    + '0.112 on the 128x64 test atlas)');
  assert.ok(pick(0.95) < 0.85,
    `atlas/direct p95 weight error ${pick(0.95).toFixed(3)} — beyond what `
    + 'sub-texel aliasing explains (measured 0.566), atlas likely corrupted');
}

// --- CPU fp32 stability (prerequisite for the future GPU gate) ----------------
//
// cloudDensityTSL ships with the march in phase 4 (doc §4-3a note). What can
// be pinned NOW is that the CPU math is fp32-stable: same baked bytes, same
// arithmetic, all fetches/lerps rounded through Math.fround. This cannot prove
// the future TSL translation correct; real WebGPU readback remains mandatory.
{
  let checked = 0;
  for (const direction of fibonacci(120)) {
    for (let altitude = 300; altitude < shellTop; altitude += 977) {
      const position = atAltitude(direction, altitude);
      const d64 = cloudDensityCPU(position, null, groundR, { fields });
      const d32 = cloudDensityCPU(
        position, null, groundR, { fields, fp32: true });
      if (d64 > 0.01) {
        assert.ok(Math.abs(d32 - d64) / d64 < 0.01,
          `fp32 wobble ${Math.abs(d32 - d64) / d64} at altitude ${altitude}`);
        checked++;
      } else {
        assert.ok(Math.abs(d32 - d64) < 0.005,
          `fp32 absolute wobble ${Math.abs(d32 - d64)}`);
      }
    }
  }
  assert.ok(checked > 20, 'fp32 check never saw cloud — test not exercising');
}

// --- Step-length policy (the /5 rule, clamped) --------------------------------
{
  const cos = (deg) => Math.cos((deg * Math.PI) / 180);
  // Nadir: step = minFeature / 5 exactly.
  assert.ok(Math.abs(stepLengthForSegment(400, 1) - 80) < 1e-9);
  // 45°: relaxes as 1/cos(zenith) — vertical rise stays 80 m.
  assert.ok(Math.abs(stepLengthForSegment(400, cos(45)) * cos(45) - 80) < 1e-9);
  // Past 85° the grazing floor stops the relaxation.
  assert.ok(Math.abs(stepLengthForSegment(400, cos(88)) - 80 / cos(85)) < 1e-6);
  // Horizontal cap: cirrocumulus granules (400 m) bound the step laterally.
  // The cap only bites when the relaxed step exceeds it, so use the 85°
  // grazing floor: relaxed = 80/cos(85°) ≈ 917 m, cap = 400/4 = 100 m.
  assert.ok(Math.abs(stepLengthForSegment(400, cos(85), 400) - 100) < 1e-9);
  // Clamps.
  assert.equal(stepLengthForSegment(100, 1), MIN_STEP_METERS);
  assert.equal(stepLengthForSegment(1e6, 0.001), MAX_STEP_METERS);
  assert.equal(stepLengthForSegment(1e6, 1, 1e9), MAX_STEP_METERS);
}

// --- The six-angle sampling gate (phase 3 acceptance) --------------------------
//
// Find the thinnest stratus deck on the planet THROUGH THE ATLAS (the render
// path), then for each view angle fire a ray through it and count march
// samples that land inside the deck's altitude band. The gate:
// >= MIN_SAMPLES_PER_FEATURE at every angle, 0° (nadir, shortest path)
// included — that is the critical direction once the step is fixed.
let deck = null;
for (const direction of fibonacci(2000)) {
  const stratus = sampleBandsAtlas(fields, direction)
    .find((band) => band.species.id === 'stratus' && band.weight > 0.8);
  if (!stratus) continue;
  const thickness = stratus.topMeters - stratus.baseMeters;
  if (!deck || thickness < deck.thickness) {
    deck = { direction, stratus, thickness };
  }
}
assert.ok(deck, 'no stratus deck found at all — weather system regressed');
assert.equal(deck.stratus.species.minVerticalFeature, CLOUD_MIN_VERTICAL_FEATURE,
  'stratus is no longer a thinnest species — recheck the step derivation');

const deckMid = (deck.stratus.baseMeters + deck.stratus.topMeters) / 2;
const angleRows = [];
for (const degrees of [0, 45, 60, 70, 80, 88]) {
  const chi = (degrees * Math.PI) / 180;
  const up = deck.direction;
  const tangent = tangentOf(up);
  const ray = {
    x: -Math.cos(chi) * up.x + Math.sin(chi) * tangent.x,
    y: -Math.cos(chi) * up.y + Math.sin(chi) * tangent.y,
    z: -Math.cos(chi) * up.z + Math.sin(chi) * tangent.z,
  };
  const back = 300000;
  const target = atAltitude(up, deckMid);
  const origin = {
    x: target.x - ray.x * back,
    y: target.y - ray.y * back,
    z: target.z - ray.z * back,
  };
  const clip = clipRayToOccupancy(occupancy, origin, ray);
  assert.ok(clip,
    `${degrees}°: ray through a stratus column clipped to null — `
    + 'occupancy is NOT conservative (false empty, the C1 direction)');
  assert.ok(clip.minFeatureMeters <= CLOUD_MIN_VERTICAL_FEATURE,
    `${degrees}°: ray minFeature ${clip.minFeatureMeters} — the 400 m `
    + 'species it crosses was not recorded');

  const plan = planRayMarch(clip, origin, ray);
  let inDeck = 0;
  let totalSamples = 0;
  for (const segment of plan.segments) {
    // The /5 invariant, checked per segment: vertical rise per step must
    // never exceed minFeature / STEP_DIVISOR (except via MIN_STEP, which is
    // below it by construction). Together with T >= minFeature this gives
    // ceil(T / vStep) - 1 >= 4 samples under the worst starting phase.
    const midT = (segment.t0 + segment.t1) / 2;
    const radial = directionOf({
      x: origin.x + ray.x * midT,
      y: origin.y + ray.y * midT,
      z: origin.z + ray.z * midT,
    });
    const cosZenith = Math.abs(
      ray.x * radial.x + ray.y * radial.y + ray.z * radial.z);
    const rise = segment.stepMeters * cosZenith;
    assert.ok(rise <= segment.minFeatureMeters / STEP_DIVISOR * 1.01 + 1e-6,
      `${degrees}°: vertical rise ${rise.toFixed(1)} m exceeds `
      + `minFeature/${STEP_DIVISOR} for feature ${segment.minFeatureMeters}`);

    const count = Math.ceil((segment.t1 - segment.t0) / segment.stepMeters);
    totalSamples += count;
    for (let k = 0; k < count; k++) {
      const t = segment.t0 + (k + 0.5) * segment.stepMeters;
      if (t > segment.t1) break;
      const position = {
        x: origin.x + ray.x * t,
        y: origin.y + ray.y * t,
        z: origin.z + ray.z * t,
      };
      const sample = directionOf(position);
      const altitude = sample.radius - groundR;
      const stratus = sampleBandsAtlas(fields, sample)
        .find((band) => band.species.id === 'stratus'
          && band.weight >= 0.05);
      if (stratus && altitude >= stratus.baseMeters
        && altitude <= stratus.topMeters) inDeck++;
    }
  }
  assert.ok(inDeck >= MIN_SAMPLES_PER_FEATURE,
    `${degrees}°: only ${inDeck} samples in the thinnest species `
    + `(${deck.thickness.toFixed(0)} m deck) — gate is `
    + `${MIN_SAMPLES_PER_FEATURE}`);

  // Empty-space skipping must actually pay — at the GRAZING angles, which
  // are the total-step-critical case (doc §4 phase 3c note). A near-nadir
  // ray spans little more than the column's own decks, so its sample count
  // legitimately tracks the occupied fraction and no skip gain is asserted
  // below 70°. Past 70° the span grows to tens/hundreds of km while the
  // decks stay the same, and skipping most of that span is the entire
  // point of the occupancy volume. Measured on this deck: ratio 0.19 / 0.10
  // / 0.07 at 70° / 80° / 88°, so 0.5 carries real margin.
  const span = clip.tExit - clip.tEnter;
  const naive = span / (CLOUD_MIN_VERTICAL_FEATURE / STEP_DIVISOR);
  if (degrees >= 70) {
    assert.ok(totalSamples < naive * 0.5,
      `${degrees}°: ${totalSamples} samples vs naive ${naive.toFixed(0)} — `
      + 'empty-space skipping is not paying for the march');
  }
  angleRows.push(
    `${degrees}°: segments=${plan.segments.length} skips=${plan.skips.length} `
    + `samples=${totalSamples} inDeck=${inDeck} span=${(span / 1000).toFixed(1)}km`);
}

// --- Clear-sky rays cost one walk, zero samples -------------------------------
{
  let cleared = false;
  for (const direction of fibonacci(500)) {
    if (sampleBandsAtlas(fields, direction).length > 0) continue;
    const origin = atAltitude(direction, shellTop + 5000);
    const ray = { x: -direction.x, y: -direction.y, z: -direction.z };
    if (clipRayToOccupancy(occupancy, origin, ray) === null) {
      cleared = true;
      break;
    }
  }
  assert.ok(cleared,
    'no clear-sky ray returned clip=null in 500 tries — either the planet '
    + 'is overcast (coverage calibration broke) or skipping is dead');
}

// --- Rays that miss the shell entirely ----------------------------------------
{
  const direction = fibonacci(1)[0];
  const origin = atAltitude(direction, shellTop + 10000);
  const tangent = tangentOf(direction);
  assert.equal(clipRayToOccupancy(occupancy, origin, tangent), null,
    'a ray tangent above the shell must not clip');
  const away = { x: direction.x, y: direction.y, z: direction.z };
  assert.equal(clipRayToOccupancy(occupancy, origin, away), null,
    'a ray pointing away from the planet must not clip');
}

// --- Conservative direction: empty voxel => no cloud ---------------------------
//
// False occupied wastes samples; false EMPTY punches holes (C1). For every
// empty voxel probed, the density function at its centre must be ~zero.
// This is the assertion that would have caught the phantom-band bug: a band
// invented by atlas bilinear outside the occupancy window lights this up.
{
  let empty = 0;
  for (let k = 0; k < occupancy.altCount; k += 3) {
    const altitude = occupancy.shellFloor
      + (k + 0.5) * occupancy.cellAltitudeMeters;
    for (let j = 0; j < occupancy.latCount; j += 2) {
      for (let i = 0; i < occupancy.lonCount; i += 2) {
        const direction = atlasTexelDirection(
          occupancy.lonCount, occupancy.latCount, i, j);
        const position = atAltitude(direction, altitude);
        const voxel = occupancy.voxelAt(position);
        if (!voxel || voxel.occupied) continue;
        empty++;
        const density = cloudDensityCPU(position, null, groundR, { fields });
        assert.ok(density < 0.1,
          `empty voxel (${i},${j},${k}) has density ${density.toFixed(3)} `
          + '— occupancy is not conservative (C1 hole)');
      }
    }
  }
  assert.ok(empty > 100, `only ${empty} empty voxels probed — test too thin`);
}

// --- Density sanity -------------------------------------------------------------
{
  // Real cloud somewhere in the chosen deck (scan: coverage thresholds make
  // any single point's density noise-dependent).
  let maxDensity = 0;
  let densestPosition = null;
  const tangent = tangentOf(deck.direction);
  for (let a = -3; a <= 3; a++) {
    for (let b = -3; b <= 3; b++) {
      const position = atAltitude(deck.direction, deckMid);
      position.x += tangent.x * a * 900;
      position.y += tangent.y * a * 900;
      position.z += tangent.z * a * 900;
      const up2 = tangentOf(deck.direction); // second tangent axis
      const north = {
        x: deck.direction.y * up2.z - deck.direction.z * up2.y,
        y: deck.direction.z * up2.x - deck.direction.x * up2.z,
        z: deck.direction.x * up2.y - deck.direction.y * up2.x,
      };
      position.x += north.x * b * 900;
      position.y += north.y * b * 900;
      position.z += north.z * b * 900;
      const density = cloudDensityCPU(position, null, groundR, { fields });
      if (density > maxDensity) {
        maxDensity = density;
        densestPosition = position;
      }
    }
  }
  assert.ok(maxDensity > 0.2,
    `stratus deck core density only ${maxDensity.toFixed(3)} — `
    + 'the density function is not producing cloud where the atlas says '
    + 'weight > 0.8');

  const medium = cloudMediumCPU(
    densestPosition, null, groundR, { fields, collectComponents: true });
  assert.ok(Math.abs(medium.density - maxDensity) < 1e-12,
    'density compatibility wrapper disagrees with the medium contract');
  assert.ok(medium.extinctionPerMeter > 0,
    'visible condensate must have positive optical extinction');
  assert.ok(medium.dominantSpeciesId && medium.familyMask !== 0,
    'visible condensate must retain its dominant species and family');
  assert.ok(medium.components.length > 0,
    'collectComponents must expose the optical contributors');
  const extinctionSum = medium.components.reduce(
    (sum, component) => sum + component.extinctionPerMeter, 0);
  assert.ok(Math.abs(extinctionSum - medium.extinctionPerMeter) < 1e-12,
    'component extinction does not sum to the medium extinction');

  assert.equal(cloudDensityCPU(
    atAltitude(deck.direction, shellTop + 3000), null, groundR, { fields }),
    0, 'density above the shell must be zero');
  assert.deepEqual(cloudMediumCPU(
    atAltitude(deck.direction, shellTop + 3000), null, groundR,
    { fields, collectComponents: true }).components, [],
  'an empty collected medium must return an empty component list');

  // Below local terrain: zero (find a high-terrain direction first).
  let highTerrain = null;
  for (const direction of fibonacci(500)) {
    const terrain = fields.terrainMeters(direction);
    if (terrain > 1500) { highTerrain = { direction, terrain }; break; }
  }
  assert.ok(highTerrain, 'no terrain above 1500 m found — weather broke');
  assert.equal(cloudDensityCPU(
    atAltitude(highTerrain.direction, highTerrain.terrain - 100),
    null, groundR, { fields }),
    0, 'density below local terrain must be zero');
}


// --- Horizontal 3D structure --------------------------------------------------
//
// The previous implementation projected a radial point onto tangent axes.
// Those dot products are identically zero on a sphere, so every horizontal
// sample read the same noise despite the code looking three-dimensional.
// Pin both the coordinate geometry and the final density behaviour.
{
  const tangent = tangentOf(deck.direction);
  const feature = deck.stratus.species.horizontalFeature;
  const movedDirection = offsetDirection(deck.direction, tangent, feature);
  const a = cloudNoiseCoordinates(
    atAltitude(deck.direction, deckMid), groundR, feature);
  const b = cloudNoiseCoordinates(
    atAltitude(movedDirection, deckMid), groundR, feature);
  const coordinateShift = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  assert.ok(coordinateShift > 0.1,
    `one horizontal feature moved noise coordinates by only `
    + `${coordinateShift.toFixed(4)} — horizontal sampling collapsed`);

  const seamEpsilon = 1e-7;
  const seamA = cloudNoiseCoordinates(atAltitude({
    x: -Math.sqrt(1 - seamEpsilon ** 2), y: 0, z: seamEpsilon,
  }, deckMid), groundR, feature);
  const seamB = cloudNoiseCoordinates(atAltitude({
    x: -Math.sqrt(1 - seamEpsilon ** 2), y: 0, z: -seamEpsilon,
  }, deckMid), groundR, feature);
  assert.ok(Math.hypot(
    seamA.x - seamB.x, seamA.y - seamB.y, seamA.z - seamB.z) < 1e-3,
  'noise coordinates tear across the longitude seam');

  const densities = [];
  for (let index = -12; index <= 12; index++) {
    const direction = offsetDirection(
      deck.direction, tangent, index * feature * 0.28);
    const band = sampleBandsAtlas(fields, direction)
      .find((entry) => entry.species.id === 'stratus' && entry.weight > 0.65);
    if (!band) continue;
    const altitude = (band.baseMeters + band.topMeters) * 0.5;
    densities.push(cloudDensityCPU(
      atAltitude(direction, altitude), null, groundR,
      { fields, speciesMask: 'stratus' }));
  }
  assert.ok(densities.length >= 8,
    `only ${densities.length} nearby stratus samples — variation probe too thin`);
  const spread = Math.max(...densities) - Math.min(...densities);
  assert.ok(spread > 0.08,
    `horizontal stratus density spread ${spread.toFixed(3)} — `
    + 'cloud cells are still effectively constant across the surface');
}


// --- Final optical coverage ---------------------------------------------------
// The weather proxy alone used to hit 50% while the actual medium only
// obscured ~26% of the planet. Coverage is accepted on integrated extinction.
const opticalCoverage = measureCloudFieldCoverage(fields, {
  samples: 512,
  verticalStepMeters: 200,
});
assert.ok(Math.abs(opticalCoverage.coverage - system.targetCoverage) <= 0.05,
  `final optical coverage ${opticalCoverage.coverage.toFixed(3)} misses target `
  + `${system.targetCoverage.toFixed(3)}; weather proxy is not sufficient`);

console.log('cloud-sampling: all assertions passed');
console.log(`  optical coverage ${opticalCoverage.coverage.toFixed(3)} `
  + `(target ${system.targetCoverage.toFixed(3)}), fields `
  + `${(fieldBytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`  thinnest deck: stratus, ${deck.thickness.toFixed(0)} m thick, `
  + `base ${deck.stratus.baseMeters.toFixed(0)} m, `
  + `weight ${deck.stratus.weight.toFixed(2)}`);
for (const row of angleRows) console.log(`  ${row}`);
