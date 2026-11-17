import assert from 'node:assert/strict';
import { createPlanetWeatherField } from '../src/cloud/planet-weather.js';
import { sampleWeatherAtlas, decodeSynopticCoverage } from '../src/cloud/weather-atlas.js';
import { advanceWeatherField, sampleWeatherField, weatherFieldFingerprint } from '../src/weather-field.js';

const body = { seed: 'B4-production-synoptic', R: 6000000, hAmp: 9000,
  hasLiquid: true, seaLevel: 300, fullMaxFreq: 100000,
  height(d, frequency) { assert.equal(frequency, 100000); return 7000 * d.x * d.z; } };
const options = { profile: { cloudiness: 0.5, weatherSpeed: 1, windSpeed: 20 } };
const field = createPlanetWeatherField(body, options);
const clone = createPlanetWeatherField(body, options);
// An absent liquid surface is metadata, never part of the height encoding.
const dry = { ...body, hasLiquid: false, seaLevel: -1e9 };
const dryField = createPlanetWeatherField(dry, options);
const dryWithoutSentinel = createPlanetWeatherField({ ...dry, seaLevel: 0 }, options);
assert.equal(dryField.surfaceRangeMeters, body.hAmp);
assert.equal(dryField.surfaceRangeMeters, dryWithoutSentinel.surfaceRangeMeters);
assert.deepEqual(dryField.surfaceBoundsMeters, dryWithoutSentinel.surfaceBoundsMeters);
const highSea = createPlanetWeatherField({ ...body, seaLevel: 12000 }, options);
assert.ok(highSea.surfaceRangeMeters >= 12000, 'A real liquid surface still belongs in the encoding');
const samples = [];
for (let i = 0; i < 256; i++) {
  const y = 1 - 2 * (i + 0.5) / 256, r = Math.sqrt(1 - y * y), phi = i * 2.399963229728653;
  const d = { x: r * Math.cos(phi), y, z: r * Math.sin(phi) };
  const first = sampleWeatherField(field, d, 17.25);
  assert.deepEqual(first, sampleWeatherField(clone, d, 17.25));
  assert.deepEqual(first, sampleWeatherField(advanceWeatherField(field, 17.25), d));
  assert.ok(Math.abs(Math.hypot(first.wind.x, first.wind.y, first.wind.z) - first.wind.speed) < 1e-10);
  assert.ok(Math.abs(first.wind.x * d.x + first.wind.y * d.y + first.wind.z * d.z) < 1e-10);
  samples.push(first);
}
assert.ok(samples.filter((s) => s.coverage < 0.01).length > 20, 'Actual broad clear regions');
assert.ok(samples.filter((s) => s.coverage > 0.9).length > 20, 'Actual occupied regions');
assert.ok(samples.some((s) => s.morphology.front > 0.3), 'Synoptic fronts reach production source');
// The deck drifts in real time: wind x 2.5, divided by the clock's x60.
assert.equal(field.windRadiansPerHour, 20 * 2.5 * 3600 / 6000000 / 60);
assert.equal(advanceWeatherField(field, 7).version, 9);
assert.match(weatherFieldFingerprint(field, 7), /^weather-v9:/);

// The same authored seed/climate must actually respond to the real surface,
// rather than merely call Planet.height and then keep synthetic continents.
const ocean = createPlanetWeatherField({ ...body, height: () => -100 }, options);
const land = createPlanetWeatherField({ ...body, height: () => 5000 }, options);
let surfaceResponse = 0, evolvedResponse=0;
for (let i = 0; i < 32; i++) {
  const d = { x: Math.cos(i), y: 0.4, z: Math.sin(i) };
  surfaceResponse += Math.abs(ocean.sample(d, 0).humidity - land.sample(d, 0).humidity);
  const angle = 23 * field.windRadiansPerHour;
  const advected = { x: Math.cos(angle) * d.x + Math.sin(angle) * d.z, y: d.y,
    z: -Math.sin(angle) * d.x + Math.cos(angle) * d.z };
  evolvedResponse+=Math.abs(field.sample(d,0).coverage-field.sample(advected,23).coverage);
}
assert.ok(evolvedResponse>.5,'Native storm lifecycle/current terrain must evolve beyond rigid advection');
assert.ok(surfaceResponse > 0.5, 'Real ocean/land changes must affect production humidity');
assert.throws(() => field.sample({ x: 0, y: 0, z: 0 }, 0), RangeError);
assert.throws(() => field.sample({ x: 1, y: 0, z: 0 }, NaN), RangeError);

// Once baked, all consumer fields must read the uploaded bytes, not resample
// a different procedural coverage. R and G intentionally disagree here.
const low = { width: 2, height: 2, data: new Uint8Array([
  0, 255, 0, 255, 255, 0, 128, 255, 64, 0, 0, 128, 192, 255, 64, 192,
]) };
const high = { width: 2, height: 2, data: new Uint8Array(16).fill(128) };
field.bindAtlases(low, high);
for (const d of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0.3, z: 1e-8 }, { x: 0, y: 1, z: 0 }]) {
  for (const hours of [-120, 0, 5000]) {
    const expected = sampleWeatherAtlas(low, d, hours * field.windRadiansPerHour);
    expected[0] = decodeSynopticCoverage(expected[0]);
    const actual = sampleWeatherField(field, d, hours);
    assert.deepEqual([actual.coverage, actual.cloudType, actual.stratusMask, actual.humidity], expected);
    assert.equal(actual.hours, hours);
  }
}
const zero = { width: 1, height: 1, data: new Uint8Array([0, 255, 255, 255]) };
field.bindAtlases(zero, zero);
assert.equal(sampleWeatherField(field, { x: 1, y: 0, z: 0 }, 0).precipitation, 0);
assert.equal(sampleWeatherField(field, { x: 1, y: 0, z: 0 }, 0).kind, 'clear');
assert.equal(createPlanetWeatherField(body, { ...options, fixture: 'clear' }).fixture.name, 'clear');
// Actual ephemeris input owns day/night. Clock hours cannot rotate an
// unrelated test sun, and a second illuminating star prevents fake night.
const litBody={...body,stellarDirectionsAt:()=>[
  {direction:[0,0,1],irradianceFraction:.75},
  {direction:[0,0,-1],irradianceFraction:.25},
]};
const litField=createPlanetWeatherField(litBody,options);
for(const hours of [-120,0,17.25,5000]) {
  assert.equal(litField.sampleRaw({x:0,y:0,z:1},hours).nightSide,0);
  assert.equal(litField.sampleRaw({x:0,y:0,z:-1},hours).nightSide,0);
}
litBody.stellarDirectionsAt=()=>[{direction:[0,0,1],irradianceFraction:1}];
assert.equal(litField.sampleRaw({x:0,y:0,z:-1},17.25).nightSide,1);
console.log('Production synoptic weather: real terrain, deterministic atlas consumers, clear/front regions, wind units, fixtures and clock passed.');
