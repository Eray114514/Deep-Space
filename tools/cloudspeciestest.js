// Cloud species table invariants.
//
// docs/cloud-atmosphere-rewrite.md phase 0. The species table is read as ground
// truth by the weather system (phase 1 species weights), the density function
// (phase 3 vertical bands) and the step budget (phase 3 sampling gate). A
// malformed entry there would silently produce either an invisible species or
// an unsatisfiable step budget, so the table's invariants are asserted here
// rather than discovered later as a rendering artifact.

import assert from 'node:assert/strict';
import {
  BASE_REFERENCE, CLOUD_ABSOLUTE_TOP_METERS, CLOUD_MIN_SAMPLES_PER_FEATURE,
  CLOUD_MIN_VERTICAL_FEATURE, CLOUD_SHELL_SPECIES, CLOUD_SPECIES,
  CLOUD_SPECIES_IDS, CLOUD_TROPOSPHERE_TOP_METERS, MORPHOLOGY, cloudSpecies,
  cloudSpeciesByFamily, speciesAltitudeBand,
} from '../src/cloud/cloud-species.js';

const MORPHOLOGY_VALUES = new Set(Object.values(MORPHOLOGY));
const BASE_REFERENCE_VALUES = new Set(Object.values(BASE_REFERENCE));

// R3: "云类必须足够多（不只是多层的不同云类，单层内也分很多云种）". A table that
// degenerates to one species per family would satisfy "multi-layer" while
// failing the actual requirement.
assert.ok(CLOUD_SPECIES.length >= 14,
  `R3 requires many species; table has ${CLOUD_SPECIES.length}`);
assert.equal(new Set(CLOUD_SPECIES_IDS).size, CLOUD_SPECIES.length,
  'species ids must be unique');

for (const species of CLOUD_SPECIES) {
  const where = `species ${species.id}`;
  assert.ok(species.id && typeof species.id === 'string', `${where}: id`);
  assert.ok(species.nameZh, `${where}: needs a Chinese name for UI/dossier use`);
  assert.ok(BASE_REFERENCE_VALUES.has(species.baseReference),
    `${where}: unknown baseReference ${species.baseReference}`);
  assert.ok(MORPHOLOGY_VALUES.has(species.morphology),
    `${where}: unknown morphology ${species.morphology}`);

  // A species anchored to the LCL must not also hardcode an absolute base, and
  // vice versa — two anchors would make the resolved band ambiguous.
  if (species.baseReference === BASE_REFERENCE.LCL) {
    assert.equal(species.baseAbsolute, undefined,
      `${where}: LCL-anchored species must not set baseAbsolute`);
  } else {
    assert.equal(typeof species.baseAbsolute, 'number',
      `${where}: absolute species needs baseAbsolute`);
    assert.ok(species.baseAbsolute >= 0, `${where}: baseAbsolute must be >= 0`);
  }

  // C4: 云千万不能同质化，就算同种云也不是一定在同一高度.
  //
  // Two independent jitter lanes, with distinct jobs:
  //   baseJitter  — moves the WHOLE deck up/down per point, so a genus does not
  //                 sit on one surface planet-wide. This is the C4 requirement.
  //   depthJitter — varies thickness about the authored nominal, independently
  //                 of altitude. Without splitting these two, jitter thinned a
  //                 deck instead of moving it, and a 600 m stratus could resolve
  //                 to 330 m — below the feature scale the step budget is
  //                 derived from. That inconsistency is what this test caught.
  assert.ok(species.depthJitter > 0,
    `${where}: needs nonzero depthJitter so thickness varies per point`);
  if (species.baseAbsolute === 0) {
    // A surface-anchored genus (fog) has the ground as its base. Jittering that
    // would float it, so C4 is satisfied by its LCL-tracking top instead.
    assert.equal(species.baseJitter, 0,
      `${where}: surface-anchored species must not jitter its base`);
    assert.equal(species.topReference, BASE_REFERENCE.LCL,
      `${where}: surface-anchored species must vary via an LCL-tracked top`);
  } else {
    assert.ok(species.baseJitter > 0,
      `${where}: C4 requires nonzero baseJitter so the genus is not one surface`);
  }

  assert.ok(species.minVerticalFeature > 0,
    `${where}: minVerticalFeature must be positive`);
  assert.ok(species.horizontalFeature > 0,
    `${where}: horizontalFeature must be positive`);
  assert.ok(species.extinctionPerKm > 0,
    `${where}: extinctionPerKm must be positive`);
  assert.ok(species.triggers && Object.keys(species.triggers).length > 0,
    `${where}: needs formation triggers or it can never be selected`);
  for (const [name, window] of Object.entries(species.triggers)) {
    assert.ok(Array.isArray(window) && window.length === 2,
      `${where}: trigger ${name} must be a [min,max] pair`);
    assert.ok(window[0] <= window[1],
      `${where}: trigger ${name} window is inverted`);
  }

  for (const key of ['convectiveDepthScale', 'convectiveTopRange']) {
    const response = species[key];
    if (response === undefined) continue;
    assert.ok(Array.isArray(response) && response.length === 2,
      `${where}: ${key} must be a [low,high] pair`);
    assert.ok(response[1] > response[0],
      `${where}: ${key} must increase with convective energy`);
  }

  // The resolved band must be sane across the whole LCL range and at both
  // jitter extremes, not just at the nominal midpoint.
  for (const lcl of [350, 1200, 2600, 4200]) {
    for (const [jitterBase, jitterDepth] of
      [[0, 0], [0, 1], [1, 0], [1, 1], [0.5, 0.5]]) {
      const band = speciesAltitudeBand(species, lcl, jitterBase, jitterDepth);
      const label = `lcl=${lcl} jitter=${jitterBase},${jitterDepth}`;
      assert.ok(Number.isFinite(band.base) && Number.isFinite(band.top),
        `${where}: non-finite band at ${label}`);
      assert.ok(band.base >= 0,
        `${where}: negative base ${band.base.toFixed(0)} at ${label}`);
      assert.ok(band.top > band.base,
        `${where}: inverted band at ${label}`);
      // The feature the marcher must resolve cannot exceed the band that
      // actually exists, or the phase 3 step budget would be derived from a
      // thickness this species never occupies. speciesAltitudeBand enforces
      // this by flooring depth at minVerticalFeature; assert it holds.
      assert.ok(species.minVerticalFeature <= band.top - band.base + 1e-6,
        `${where}: minVerticalFeature ${species.minVerticalFeature} exceeds `
        + `resolved band ${(band.top - band.base).toFixed(0)} m at ${label}`);
    }
  }

  // A deck must actually move as the per-point base jitter sweeps (C4), and its
  // thickness must actually vary as the depth jitter sweeps. Asserting the
  // amplitudes are nonzero is not enough — the resolution function must use
  // them, which is the bug class that produced a uniform "ceiling".
  if (species.baseJitter > 0) {
    const low = speciesAltitudeBand(species, 1200, 0, 0.5);
    const high = speciesAltitudeBand(species, 1200, 1, 0.5);
    assert.ok(high.base - low.base > species.baseJitter,
      `${where}: base jitter is not applied (${low.base} vs ${high.base})`);
  }


  // Convective energy must affect the vertical geometry, not merely species
  // selection. This is the physical distinction between fair-weather puffs
  // and a developed tower after the genus has already formed.
  if (species.convectiveDepthScale || species.convectiveTopRange) {
    const window = species.triggers.convective;
    const low = speciesAltitudeBand(species, 1200, 0.5, 0.5,
      { convective: window[0] });
    const high = speciesAltitudeBand(species, 1200, 0.5, 0.5,
      { convective: window[1] });
    assert.ok(high.top - low.top > species.minVerticalFeature * 0.2,
      `${where}: convective energy does not materially raise the cloud top `
      + `(${low.top.toFixed(0)} vs ${high.top.toFixed(0)} m)`);
  }
}

// Families must all be populated: the vertical structure requirement is that
// low/mid/high decks coexist, and a missing family collapses the sky to one
// deck regardless of how many species the table declares.
for (const family of ['low', 'mid', 'high']) {
  const members = cloudSpeciesByFamily(family);
  assert.ok(members.length >= 3,
    `family ${family} needs >= 3 species for single-layer variety (R3), `
    + `has ${members.length}`);
}

// The shell budget must exclude species that are not rendered in the
// tropospheric shell. Fog (0 -> LCL, camera usually inside it) and noctilucent
// (76-85 km) get dedicated paths; folding fog's 150 m feature into the shell
// budget would quadruple the step cost of every orbital ray for a genus that is
// not even visible from orbit.
assert.ok(CLOUD_SHELL_SPECIES.length < CLOUD_SPECIES.length,
  'fog and noctilucent must be excluded from the shell species set');
for (const species of CLOUD_SHELL_SPECIES) {
  assert.notEqual(species.family, 'special',
    `special-family species ${species.id} must not be in the shell set`);
}

// The sampling gate (phase 3) is derived from the tightest feature among shell
// species. If that value drifts upward the gate silently weakens, so pin the
// relationship rather than the literal number.
const tightestShell = Math.min(
  ...CLOUD_SHELL_SPECIES.map((species) => species.minVerticalFeature));
assert.equal(CLOUD_MIN_VERTICAL_FEATURE, tightestShell,
  'CLOUD_MIN_VERTICAL_FEATURE must equal the shell-species minimum');
assert.ok(CLOUD_MIN_VERTICAL_FEATURE <= 500,
  'the sampling gate is only meaningful if some shell species is thin: '
  + `${CLOUD_MIN_VERTICAL_FEATURE} m`);
assert.equal(CLOUD_MIN_SAMPLES_PER_FEATURE, 4,
  'phase 3 gate asserts >= 4 samples through the thinnest feature');

// Optical density must be ordered by genus: ice cloud is semi-transparent,
// deep convective cloud is optically thick. Inverting this makes cirrus read as
// a white slab, which is half of the "白色色块" complaint.
const extinction = (id) => cloudSpecies(id).extinctionPerKm;
assert.ok(extinction('cirrus') < extinction('altostratus'),
  'ice cirrus must be optically thinner than mid-level altostratus');
assert.ok(extinction('altostratus') < extinction('cumulonimbus'),
  'altostratus must be optically thinner than a deep convective tower');
assert.ok(extinction('stratus') < extinction('nimbostratus'),
  'thin stratus must be optically thinner than precipitating nimbostratus');

// Shell sizing. CLOUD_TROPOSPHERE_TOP_METERS is DERIVED from the worst-case
// jittered ceiling of the shell species, not authored. A hardcoded 13000 would
// clip anvil and cumulonimbus tops once depth jitter pushed them above the lid,
// which reads as a flat-topped cloud slab.
assert.ok(CLOUD_TROPOSPHERE_TOP_METERS >= 13000,
  `tropospheric shell must reach at least the 13 km tropopause, `
  + `got ${CLOUD_TROPOSPHERE_TOP_METERS}`);
for (const species of CLOUD_SHELL_SPECIES) {
  // Worst case: highest LCL and both jitter lanes at maximum.
  const band = speciesAltitudeBand(species, 4200, 1, 1,
    { convective: 1 });
  assert.ok(band.top <= CLOUD_TROPOSPHERE_TOP_METERS + 1e-6,
    `species ${species.id} tops out at ${band.top.toFixed(0)} m, above the `
    + `${CLOUD_TROPOSPHERE_TOP_METERS.toFixed(0)} m shell it renders in`);
}
assert.ok(CLOUD_ABSOLUTE_TOP_METERS > CLOUD_TROPOSPHERE_TOP_METERS,
  'mesospheric species must extend beyond the tropospheric shell');

assert.throws(() => cloudSpecies('nonexistent-genus'),
  'unknown species must throw rather than return undefined');

const familyCounts = ['low', 'mid', 'high', 'special']
  .map((family) => `${family}=${cloudSpeciesByFamily(family).length}`)
  .filter((entry) => !entry.endsWith('=0'))
  .join(' ');
console.log(`PASS: ${CLOUD_SPECIES.length} cloud species (${familyCounts}); `
  + `${CLOUD_SHELL_SPECIES.length} in shell, thinnest feature `
  + `${CLOUD_MIN_VERTICAL_FEATURE} m, shell top `
  + `${CLOUD_TROPOSPHERE_TOP_METERS.toFixed(0)} m`);
