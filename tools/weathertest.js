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
