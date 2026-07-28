import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeRng } from '../src/rng.js';
import {
  WEATHER_NAMESPACE_SUFFIX,
  advanceWeatherField,
  createWeatherField,
  createWeatherFixture,
  sampleWeatherField,
  weatherFieldFingerprint,
  weatherFixtureNames,
} from '../src/weather-field.js';

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(value) {
  const scale = 1 / Math.hypot(value.x, value.y, value.z);
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

function rotateAroundAxis(value, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const projection = dot(axis, value) * (1 - cosine);
  const perpendicular = cross(axis, value);
  return {
    x: value.x * cosine + perpendicular.x * sine + axis.x * projection,
    y: value.y * cosine + perpendicular.y * sine + axis.y * projection,
    z: value.z * cosine + perpendicular.z * sine + axis.z * projection,
  };
}

const direction = { x: 0.31, y: 0.42, z: -0.71 };
const hours = 4812.375;
const first = createWeatherField('NAVEMI-382/body-1');
const reload = createWeatherField('NAVEMI-382/body-1');

assert.equal(first.namespace, `NAVEMI-382/body-1${WEATHER_NAMESPACE_SUFFIX}`);
assert.deepEqual(
  sampleWeatherField(first, direction, hours),
  sampleWeatherField(reload, direction, hours),
  'same seed, body, direction and absolute hours must survive reload exactly',
);
assert.equal(
  weatherFieldFingerprint(first, hours),
  weatherFieldFingerprint(reload, hours),
  'weather fingerprint must survive reload exactly',
);

const state = advanceWeatherField(first, hours);
assert.deepEqual(
  sampleWeatherField(state, direction),
  sampleWeatherField(first, direction, hours),
  'absolute-hour state cursor must not change the sampled weather',
);
const farState = advanceWeatherField(state, hours + 240);
assert.deepEqual(
  sampleWeatherField(farState, direction),
  sampleWeatherField(first, direction, hours + 240),
  'advancing from another state must still use absolute rather than delta hours',
);
assert.deepEqual(
  sampleWeatherField(state, direction),
  sampleWeatherField(first, direction, hours),
  'advancing must not mutate an older weather state',
);

const scaledDirection = { x: direction.x * 90, y: direction.y * 90, z: direction.z * 90 };
const normalizedSample = sampleWeatherField(first, direction, hours);
const scaledSample = sampleWeatherField(first, scaledDirection, hours);
for (const value of [
  Math.abs(normalizedSample.coverage - scaledSample.coverage),
  Math.abs(normalizedSample.humidity - scaledSample.humidity),
  Math.abs(normalizedSample.wind.x - scaledSample.wind.x),
  Math.abs(normalizedSample.wind.y - scaledSample.wind.y),
  Math.abs(normalizedSample.wind.z - scaledSample.wind.z),
]) assert.ok(value < 1e-12, 'weather sampling must normalize spherical directions');

const other = createWeatherField('NAVEMI-382/body-2');
assert.notEqual(
  weatherFieldFingerprint(first, hours),
  weatherFieldFingerprint(other, hours),
  'independent body seed namespaces must produce different weather',
);
assert.notEqual(
  weatherFieldFingerprint(first, hours),
  weatherFieldFingerprint(first, hours + 240),
  'absolute time must evolve the weather field',
);

let previous = sampleWeatherField(first, direction, hours);
let worstStep = 0;
for (let index = 1; index <= 600; index++) {
  const sample = sampleWeatherField(first, direction, hours + index / 120);
  for (const key of [
    'coverage', 'cloudType', 'stratusMask', 'highMask', 'multipleScatter',
    'humidity', 'precipitation', 'convective', 'visibility', 'fog', 'gust',
  ]) {
    worstStep = Math.max(worstStep, Math.abs(sample[key] - previous[key]));
  }
  previous = sample;
}
assert.ok(worstStep < 0.025,
  `absolute-time weather must be continuous; worst 30-second step was ${worstStep}`);

const ranges = [];
for (let index = 0; index < 1024; index++) {
  const y = 1 - 2 * (index + 0.5) / 1024;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  const sample = sampleWeatherField(first, {
    x: Math.cos(angle) * radius,
    y,
    z: Math.sin(angle) * radius,
  }, hours);
  assert.equal(sample.lo.length, 4);
  assert.equal(sample.hi.length, 4);
  assert.deepEqual(sample.lo, [
    sample.coverage, sample.cloudType, sample.stratusMask, 0,
  ], 'Lo weather channel contract drifted');
  assert.deepEqual(sample.hi, [
    sample.highMask, sample.highType, 0, sample.multipleScatter,
  ], 'Hi weather channel contract drifted');
  for (const value of [
    ...sample.lo, ...sample.hi, sample.humidity, sample.precipitation,
    sample.convective, sample.visibility, sample.fog, sample.gust,
    sample.wind.x, sample.wind.y, sample.wind.z, sample.wind.speed,
  ]) assert.ok(Number.isFinite(value), 'weather outputs must remain finite');
  assert.ok(Math.abs(
    sample.direction.x * sample.wind.x
      + sample.direction.y * sample.wind.y
      + sample.direction.z * sample.wind.z,
  ) < 1e-8, 'wind must remain tangent to the planet');
  ranges.push(sample);
}
assert.ok(Math.max(...ranges.map((sample) => sample.coverage))
  - Math.min(...ranges.map((sample) => sample.coverage)) > 0.55,
'default weather must contain meaningfully different regional coverage');
const meanCoverage = ranges.reduce((sum, sample) => sum + sample.coverage, 0) / ranges.length;
const meanConvective = ranges.reduce((sum, sample) => sum + sample.convective, 0) / ranges.length;
const clearFraction = ranges.filter((sample) => sample.coverage < 0.15).length / ranges.length;
const overcastFraction = ranges.filter((sample) => sample.coverage > 0.85).length / ranges.length;
assert.ok(meanCoverage > 0.12 && meanCoverage < 0.72,
  `default weather must preserve open sky and cloud systems; mean coverage was ${meanCoverage}`);
assert.ok(meanConvective < 0.58,
  `cyclone systems must remain regional rather than globally convective; mean was ${meanConvective}`);
assert.ok(clearFraction > 0.08 && overcastFraction > 0.015,
  `default weather needs clear air and dense systems; fractions were ${clearFraction}/${overcastFraction}`);
assert.ok(new Set(ranges.map((sample) => sample.kind)).size >= 2,
  'default weather must contain more than one regional weather class');

for (const sample of ranges) {
  assert.deepEqual(Object.keys(sample.morphology), [
    'cycloneEye', 'eyewall', 'spiral', 'front', 'coldFront',
    'warmFront', 'anvil', 'marineCell', 'cloudStreet',
  ], 'weather morphology channel contract drifted');
  for (const value of Object.values(sample.morphology)) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1,
      'weather morphology channels must remain finite and normalized');
  }
}

const morphologyPeak = (key) => Math.max(...ranges.map((sample) => sample.morphology[key]));
assert.ok(morphologyPeak('eyewall') > 0.7,
  'weather map must contain a dense, resolved cyclone eyewall');
assert.ok(morphologyPeak('front') > 0.85,
  'weather map must contain a long, resolved synoptic front');
assert.ok(morphologyPeak('marineCell') > 0.68,
  'humid boundary layers must contain orbit-readable cellular cloud decks');
assert.ok(morphologyPeak('cloudStreet') > 0.8,
  'regional boundary layers must contain wind-aligned cloud streets');

const frontSamples = ranges.filter((sample) => sample.morphology.front > 0.5);
const nonFrontSamples = ranges.filter((sample) => sample.morphology.front < 0.05);
const mean = (values, selector) =>
  values.reduce((sum, value) => sum + selector(value), 0) / values.length;
assert.ok(frontSamples.length >= 6 && frontSamples.length < ranges.length * 0.08,
  `fronts must be long regional bands, not global belts; samples=${frontSamples.length}`);
assert.ok(mean(frontSamples, (sample) => sample.coverage)
    > mean(nonFrontSamples, (sample) => sample.coverage) + 0.12,
  'front morphology must visibly raise cloud coverage along its finite band');

// Sample the exact moving cyclone centre and a point on its eyewall. This
// proves the clear eye survives even when a Fibonacci orbit scan misses its
// roughly 40 km disk.
const lowAngle = first.basePhase + hours * first.windRadiansPerHour;
const movingStorm = rotateAroundAxis(
  first.stormCenterA,
  first.windAxis,
  lowAngle * 0.76,
);
const tangent = normalize(cross(
  Math.abs(movingStorm.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 },
  movingStorm,
));
const ringRadius = 0.076;
const eyewallDirection = normalize({
  x: movingStorm.x * Math.cos(ringRadius) + tangent.x * Math.sin(ringRadius),
  y: movingStorm.y * Math.cos(ringRadius) + tangent.y * Math.sin(ringRadius),
  z: movingStorm.z * Math.cos(ringRadius) + tangent.z * Math.sin(ringRadius),
});
const eyeSample = sampleWeatherField(first, movingStorm, hours);
const eyewallSample = sampleWeatherField(first, eyewallDirection, hours);
assert.ok(eyeSample.morphology.cycloneEye > 0.95
    && eyewallSample.morphology.eyewall > 0.7,
  'cyclone centre and annular eyewall must remain independently readable');
assert.ok(eyeSample.coverage + 0.55 < eyewallSample.coverage,
  `cyclone eye must be visibly clear: ${eyeSample.coverage}/${eyewallSample.coverage}`);

assert.deepEqual(weatherFixtureNames(),
  ['clear', 'cumulus', 'stratus', 'storm', 'snow', 'fog']);
for (const name of weatherFixtureNames()) {
  const fixture = createWeatherFixture(name);
  const field = createWeatherField('fixture', { fixture });
  const sample = sampleWeatherField(field, direction, hours);
  assert.equal(sample.fixture, name);
  assert.equal(sample.kind, name);
}
const overriddenFixture = createWeatherFixture('storm', { precipitation: 0.51 });
assert.equal(overriddenFixture.precipitation, 0.51);
assert.equal(createWeatherFixture('storm').precipitation, 0.94,
  'fixture overrides must not mutate the shared preset');

// A storm fixture forces local rain/lightning state, not a global opaque cloud
// constant. Its orbit map must retain clear sectors around finite systems.
const stormFixtureField = createWeatherField('fixture', {
  fixture: createWeatherFixture('storm'),
});
const stormFixtureSamples = [];
for (let index = 0; index < 2048; index++) {
  const y = 1 - 2 * (index + 0.5) / 2048;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  stormFixtureSamples.push(sampleWeatherField(stormFixtureField, {
    x: Math.cos(angle) * radius,
    y,
    z: Math.sin(angle) * radius,
  }, hours));
}
const stormCoverageMean = mean(stormFixtureSamples, (sample) => sample.coverage);
const stormCoverageRange = Math.max(...stormFixtureSamples.map((sample) => sample.coverage))
  - Math.min(...stormFixtureSamples.map((sample) => sample.coverage));
const stormClearFraction = stormFixtureSamples
  .filter((sample) => sample.coverage < 0.15).length / stormFixtureSamples.length;
assert.ok(stormCoverageMean < 0.62 && stormCoverageRange > 0.72
    && stormClearFraction > 0.08,
  `storm fixture must retain regional systems/open sky, got mean/range/clear `
    + `${stormCoverageMean}/${stormCoverageRange}/${stormClearFraction}`);
assert.ok(stormFixtureSamples.every((sample) =>
  sample.kind === 'storm' && sample.precipitation > 0.7),
'storm fixture must still force deterministic gameplay precipitation');

const controlA = makeRng('existing-universe-stream');
const controlB = makeRng('existing-universe-stream');
const prefixA = [controlA(), controlA()];
const prefixB = [controlB(), controlB()];
createWeatherField('independent-weather-stream');
const suffixA = [controlA(), controlA(), controlA()];
const suffixB = [controlB(), controlB(), controlB()];
assert.deepEqual(prefixA, prefixB);
assert.deepEqual(suffixA, suffixB,
  'creating weather must not consume an existing universe RNG stream');

const source = await readFile(new URL('../src/weather-field.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /Math\.random\s*\(/,
  'weather authority must never use Math.random()');
assert.doesNotMatch(source, /\b(?:deltaTime|dt)\b/,
  'weather authority must not integrate frame delta time');

console.log('PASS: deterministic absolute-time weather field, Lo/Hi channels,'
  + ` continuity (${worstStep.toFixed(6)} worst step), fixtures and RNG isolation`);
