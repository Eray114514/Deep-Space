import assert from 'node:assert/strict';
import { createOceanClimate, sampleOceanClimate } from '../src/ocean-climate.js';

const first = createOceanClimate('ocean-a', { type: 'lush' });
const replay = createOceanClimate('ocean-a', { type: 'lush' });
const samples = [];
for (let i = 0; i < 256; i++) {
  const y = 1 - 2 * (i + 0.5) / 256;
  const r = Math.sqrt(1 - y * y), angle = i * 2.399963229728653;
  const direction = { x: r * Math.cos(angle), y, z: r * Math.sin(angle) };
  const sample = sampleOceanClimate(first, direction, { seconds: 4200, depth: 900 });
  assert.deepEqual(sample, sampleOceanClimate(replay, direction, { seconds: 4200, depth: 900 }));
  assert.ok(sample.significantHeight >= 0 && Number.isFinite(sample.wavelength));
  samples.push(sample.significantHeight);
}
assert.ok(Math.max(...samples) - Math.min(...samples) > 1,
  'one inhabited world must contain distinct regional sea conditions');
const direction = { x: 0.6, y: 0.8, z: 0 };
const calm = sampleOceanClimate(first, direction, { depth: 80, weather: { wind: { speed: 2 } } });
const storm = sampleOceanClimate(first, direction, { depth: 80, weather: { wind: { speed: 32 } } });
assert.ok(storm.significantHeight > calm.significantHeight * 2, 'weather must alter the local sea');
const shallow = sampleOceanClimate(first, direction, { depth: 0.8, weather: { wind: { speed: 32 } } });
assert.ok(shallow.significantHeight <= 0.8 * 0.62 && shallow.breaking > 0.9,
  'shallow water must limit ordinary waves and expose breaking');
assert.ok(shallow.offshoreSignificantHeight > shallow.significantHeight,
  'incident offshore sea remains available independently of the shallow depth cap');
for (const depth of [0, -1]) {
  const dry = sampleOceanClimate(first, direction, { depth, weather: { wind: { speed: 32 } } });
  assert.equal(dry.significantHeight, 0, 'dry samples cannot displace local water');
  assert.equal(dry.offshoreSignificantHeight, shallow.offshoreSignificantHeight,
    'zero depth must not erase the incident sea used beyond the observer');
}
assert.equal(shallow.offshoreSignificantHeight,
  sampleOceanClimate(first, direction, { depth: 900, weather: { wind: { speed: 32 } } }).offshoreSignificantHeight,
  'entering a shallow bay must not change the offshore incident wave field');
assert.equal(sampleOceanClimate(first, direction, { depth: 900 }).significantHeight,
  sampleOceanClimate(first, direction, { depth: 900 }).offshoreSignificantHeight,
  'deep water keeps the incident sea without a depth cap');
const a = sampleOceanClimate(first, { x: -1, y: 0.1, z: 1e-8 });
const b = sampleOceanClimate(first, { x: -1, y: 0.1, z: -1e-8 });
assert.ok(Math.abs(a.significantHeight - b.significantHeight) < 1e-5,
  'geographical longitude wrap must not introduce a sea-state seam');
const types = new Set(Array.from({ length: 64 }, (_, i) =>
  createOceanClimate(`world-${i}`, { type: 'ocean' }).composition));
assert.ok(types.size >= 4, 'ocean worlds must carry different compositions');
const tidal = createOceanClimate('tidal-world', { type: 'ocean', oceanClass: 'tidal-giant' });
const eventA = sampleOceanClimate(tidal, direction, { seconds: 4200 });
const eventB = sampleOceanClimate(tidal, { x: 0, y: 0, z: 1 }, { seconds: 4200 });
assert.equal(eventA.eventPhase, eventB.eventPhase, 'event time must not depend on the observer');
assert.deepEqual(tidal.event,
  createOceanClimate('tidal-world', { type: 'ocean', oceanClass: 'tidal-giant' }).event);
console.log(`PASS: deterministic ocean climate; regional Hs ${Math.min(...samples).toFixed(2)}–${Math.max(...samples).toFixed(2)} m; ${types.size} compositions; weather, shoaling, spherical seam and event clock`);
