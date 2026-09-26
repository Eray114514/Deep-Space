// Weather system invariants (phase 1).
//
// CPU model checks; production still uses weather-field.js. These do not prove
// production weather/density consistency. Each assertion below pins one of the
// user requirements that the previous implementation violated, and is written
// to fail on the specific degenerate form that violation took.

import assert from 'node:assert/strict';
import {
  COVERAGE_TOLERANCE, WEATHER_REGIMES, calibrateCoverage, createWeatherSystem,
  liftingCondensationLevel, measureCoverage, sampleWeather, speciesWeights,
  weatherSystemFingerprint,
} from '../src/cloud/weather-system.js';
import {
  CLOUD_LCL_MAX_METERS, CLOUD_LCL_MIN_METERS, CLOUD_SPECIES,
} from '../src/cloud/cloud-species.js';

// Equal-area sampling. A lat/lon grid would over-weight the poles, and every
// area claim below would be wrong by that bias.
function fibonacci(count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (unused, index) => {
    const y = 1 - 2 * (index + 0.5) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * golden;
    return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
  });
}

const SEED = 'weather-system-test';
const system = createWeatherSystem(SEED, { targetCoverage: 0.5 });
const directions = fibonacci(3000);
const samples = directions.map((d) => sampleWeather(system, d, 0));

// --- D5 / S1(b): cloud base is a property of local air, not a constant -------
//
// This is the "云就在我头顶 / 云是天花板" complaint. A single global base is the
// degenerate form; so is a base that technically varies but stays inside a
// couple hundred metres. Both are excluded by requiring the humid-marine and
// dry-continental populations to be separated by kilometres.
const marine = samples.filter((s) =>
  s.oceanic > 0.85 && s.absLatitude < 0.55 && s.humidity > 0.7);
const interior = samples.filter((s) =>
  s.oceanic < 0.15 && s.elevationMeters > 800);
assert.ok(marine.length > 50 && interior.length > 50,
  `need both marine (${marine.length}) and dry-interior (${interior.length}) `
  + 'populations to compare cloud bases');
const mean = (list) => list.reduce((sum, s) => sum + s.lclMeters, 0) / list.length;
const marineLcl = mean(marine);
const interiorLcl = mean(interior);
assert.ok(marineLcl < 800,
  `humid marine LCL must sit low (< 800 m), got ${marineLcl.toFixed(0)} m`);
assert.ok(interiorLcl > 2000,
  `dry interior LCL must sit high (> 2000 m), got ${interiorLcl.toFixed(0)} m`);

for (const sample of samples) {
  assert.ok(Number.isFinite(sample.lclMeters), 'LCL must be finite');
  assert.ok(sample.lclMeters >= CLOUD_LCL_MIN_METERS
    && sample.lclMeters <= CLOUD_LCL_MAX_METERS,
    `LCL ${sample.lclMeters} outside the range the species table is authored `
    + `against (${CLOUD_LCL_MIN_METERS}-${CLOUD_LCL_MAX_METERS} m)`);
}

// The approximation itself must be monotone in dewpoint depression, or a
// "drier" point could produce a lower cloud base.
assert.ok(liftingCondensationLevel({ temperatureK: 300, dewpointK: 298 })
  < liftingCondensationLevel({ temperatureK: 300, dewpointK: 285 }),
  'LCL must rise with dewpoint depression');
// Windward ascent lowers the base — this is why cloud hugs the upwind face of a
// range instead of floating level across it.
assert.ok(
  liftingCondensationLevel({ temperatureK: 300, dewpointK: 288, orographicLift: 1 })
  < liftingCondensationLevel({ temperatureK: 300, dewpointK: 288, orographicLift: 0 }),
  'orographic lift must lower the condensation level');

// --- C5 / D7: coverage is an AREA contract ----------------------------------
//
// The failure mode this guards against: satisfying "coverage 0.5" by making
// every point half-dense. That measures correctly under an averaging metric and
// looks like uniform mottling from orbit — the "白色色块" complaint. So the
// measurement here COUNTS occupied directions, and a second assertion requires
// the clear area to be organized into a few large regions rather than scattered.
const measured = measureCoverage(system, 0, 4096);
assert.ok(Math.abs(measured - 0.5) <= COVERAGE_TOLERANCE,
  `coverage contract 0.5 not met: measured area fraction ${measured.toFixed(3)}`);

for (const target of [0.25, 0.75]) {
  const tuned = createWeatherSystem(`${SEED}:cov-${target}`, { targetCoverage: target });
  const actual = measureCoverage(tuned, 0, 4096);
  assert.ok(Math.abs(actual - target) <= COVERAGE_TOLERANCE,
    `coverage contract ${target} not met: measured ${actual.toFixed(3)}`);
}

// Connected-region structure. Build an adjacency graph over the equal-area
// lattice and require that most of the clear sky is a handful of big systems.
const spacing = Math.sqrt(4 * Math.PI / directions.length);
const cosNeighbour = Math.cos(spacing * 2.2);
const adjacency = directions.map(() => []);
for (let i = 0; i < directions.length; i++) {
  for (let j = i + 1; j < directions.length; j++) {
    const cosine = directions[i].x * directions[j].x
      + directions[i].y * directions[j].y + directions[i].z * directions[j].z;
    if (cosine > cosNeighbour) { adjacency[i].push(j); adjacency[j].push(i); }
  }
}
function componentSizes(wanted) {
  const seen = new Uint8Array(directions.length);
  const sizes = [];
  for (let start = 0; start < directions.length; start++) {
    if (seen[start] || samples[start].covered !== wanted) continue;
    const stack = [start];
    seen[start] = 1;
    let size = 0;
    while (stack.length) {
      const node = stack.pop();
      size++;
      for (const next of adjacency[node]) {
        if (!seen[next] && samples[next].covered === wanted) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}
function regionsHolding(sizes, fraction) {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let accumulated = 0;
  let count = 0;
  while (accumulated < total * fraction && count < sizes.length) {
    accumulated += sizes[count++];
  }
  return count;
}
const clearSizes = componentSizes(false);
const cloudySizes = componentSizes(true);
assert.ok(clearSizes.length > 0 && cloudySizes.length > 0,
  'a half-covered planet must have both clear and cloudy regions');
// Uniform half-density mottling produces hundreds of tiny alternating regions.
// Real synoptic weather concentrates most area into a few systems.
assert.ok(regionsHolding(clearSizes, 0.8) <= 6,
  'C5: 80% of the clear area must live in <= 6 large regions, not scattered '
  + `patches (needed ${regionsHolding(clearSizes, 0.8)} of ${clearSizes.length})`);
assert.ok(regionsHolding(cloudySizes, 0.8) <= 6,
  'C5: 80% of the cloudy area must live in <= 6 large regions '
  + `(needed ${regionsHolding(cloudySizes, 0.8)} of ${cloudySizes.length})`);
// The largest clear region must be genuinely large — a real subtropical high
// spans thousands of kilometres.
assert.ok(clearSizes[0] / directions.length > 0.08,
  'C5: the largest continuous clear region must cover > 8% of the planet, got '
  + `${(clearSizes[0] / directions.length * 100).toFixed(1)}%`);

// --- S3: the planet must read as "有体系" ------------------------------------
const regimeArea = new Map();
for (const sample of samples) {
  assert.ok(WEATHER_REGIMES.includes(sample.regime),
    `unknown regime ${sample.regime}`);
  regimeArea.set(sample.regime, (regimeArea.get(sample.regime) || 0) + 1);
}
const significantRegimes = [...regimeArea.entries()]
  .filter(([, count]) => count / directions.length >= 0.04);
assert.ok(significantRegimes.length >= 3,
  'S3 requires at least 3 regimes covering meaningful area, got '
  + `${significantRegimes.length}: ${[...regimeArea.keys()].join(', ')}`);

// --- R3: single-layer species variety ---------------------------------------
//
// Degenerate form: the table declares 16 genera but the weather only ever
// selects stratus, so the sky is one sheet everywhere. Require that most of the
// table actually occurs somewhere with weight worth rendering.
const peak = new Map(CLOUD_SPECIES.map((s) => [s.id, 0]));
const occurrences = new Map(CLOUD_SPECIES.map((s) => [s.id, 0]));
for (const sample of samples) {
  for (const [id, weight] of Object.entries(sample.speciesWeights)) {
    if (weight > peak.get(id)) peak.set(id, weight);
    if (weight > 0.2) occurrences.set(id, occurrences.get(id) + 1);
  }
}
const present = CLOUD_SPECIES.filter((s) => peak.get(s.id) > 0.25);
assert.ok(present.length >= 8,
  `R3 requires >= 8 species with meaningful weight somewhere, got `
  + `${present.length}: ${present.map((s) => s.id).join(', ')}`);
// Variety must be within a layer too, not only across layers.
for (const family of ['low', 'mid', 'high']) {
  const members = CLOUD_SPECIES.filter((s) => s.family === family);
  const active = members.filter((s) => peak.get(s.id) > 0.25);
  assert.ok(active.length >= 2,
    `R3 requires >= 2 ${family} species to occur, got ${active.length}`);
}
// Weights must be a distribution, not a broadcast: a single point cannot be
// every genus at once, or "云种" would be meaningless.
for (const sample of samples) {
  for (const family of ['low', 'mid', 'high']) {
    const total = CLOUD_SPECIES.filter((s) => s.family === family)
      .reduce((sum, s) => sum + sample.speciesWeights[s.id], 0);
    assert.ok(total <= 1 + 1e-6,
      `${family} species weights must sum to <= 1, got ${total.toFixed(3)}`);
    assert.ok(Math.abs(total - sample.familyAmounts[family]) < 1e-6,
      `${family} species lost calibrated family coverage: `
      + `${total.toFixed(3)} vs ${sample.familyAmounts[family].toFixed(3)}`);
  }
}
// An anvil without a parent tower is physically impossible, and was one way the
// old system produced high ice sheets over calm air.
for (const sample of samples) {
  if (sample.speciesWeights.anvil > 0.05) {
    assert.ok(sample.speciesWeights.cumulonimbus > 0,
      'anvil must only occur where a cumulonimbus tower exists');
  }
}

// --- C1: determinism is the precondition for space/surface agreement --------
const repeat = createWeatherSystem(SEED, { targetCoverage: 0.5 });
assert.equal(weatherSystemFingerprint(repeat, 0),
  weatherSystemFingerprint(system, 0),
  'same seed must reconstruct the same weather system');
for (const index of [0, 137, 900, 2411]) {
  const a = sampleWeather(system, directions[index], 6.25);
  const b = sampleWeather(repeat, directions[index], 6.25);
  assert.equal(a.lowMask, b.lowMask, 'C1: resampling must be identical');
  assert.equal(a.lclMeters, b.lclMeters, 'C1: LCL must be identical');
  assert.equal(a.regime, b.regime, 'C1: regime must be identical');
}
// Advection must actually move weather, or "same result at every time" would
// pass the determinism check while the sky was frozen.
const moved = directions.slice(0, 400)
  .filter((d, i) => sampleWeather(system, d, 0).covered
    !== sampleWeather(system, d, 240).covered).length;
assert.ok(moved > 8,
  `weather must advect over time; only ${moved}/400 directions changed in 10 days`);

// Coverage must survive advection — a contract that only holds at t=0 is not a
// contract.
const laterCoverage = measureCoverage(system, 720, 4096);
assert.ok(Math.abs(laterCoverage - 0.5) <= COVERAGE_TOLERANCE * 1.4,
  `coverage must hold as weather advects: ${laterCoverage.toFixed(3)} at t+720h`);

// --- API surface -------------------------------------------------------------
assert.throws(() => sampleWeather({}, { x: 0, y: 1, z: 0 }),
  'sampleWeather must reject a non-system');
assert.throws(() => speciesWeights(null),
  'speciesWeights must reject a missing sample');
const recalibrated = calibrateCoverage(system, 0.5, { samples: 1024 });
assert.ok(Number.isFinite(recalibrated.bias) && Number.isFinite(recalibrated.measured),
  'calibrateCoverage must report the solved bias and the measured area');

console.log(`PASS: coverage ${measured.toFixed(3)} (target 0.500, `
  + `${regionsHolding(clearSizes, 0.8)} regions hold 80% of clear area, `
  + `largest ${(clearSizes[0] / directions.length * 100).toFixed(1)}%); `
  + `LCL marine ${marineLcl.toFixed(0)} m vs interior ${interiorLcl.toFixed(0)} m; `
  + `${significantRegimes.length} regimes; ${present.length}/${CLOUD_SPECIES.length} `
  + 'species active');
