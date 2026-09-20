import assert from 'node:assert/strict';
import { makeRng } from '../src/rng.js';
import { createOceanWaveField, sampleOceanWaveField, oceanWavePhases } from '../src/ocean-wave-field.js';
import { oceanSeconds } from '../src/ocean-clock.js';

assert.equal(oceanSeconds(24), 1440);
assert.ok(Math.abs(oceanSeconds(24 + 60 / 3600) - oceanSeconds(24) - 1) < 1e-10);
assert.throws(() => oceanSeconds(NaN), RangeError);

const field = createOceanWaveField('ocean-contract');
assert.deepEqual(field, createOceanWaveField('ocean-contract'));
assert.notDeepEqual(field, createOceanWaveField('another-ocean'));
assert.equal(field.modes.length, 12);
assert.throws(() => createOceanWaveField('bad', { gravity: 0 }), RangeError);
for (const mode of field.modes) {
  assert.ok(Math.abs(Math.hypot(...mode.axis) - 1) < 1e-12);
  assert.ok(Math.abs(mode.omega ** 2 - 9.81 * mode.k) < 1e-12);
}
const position = { x: 6000000.125, y: -1234.56, z: 3456.789 };
const seconds = 12345.678;
const options = { significantHeight: 4, footprint: 1.3 };
const sample = sampleOceanWaveField(field, position, seconds, options);
for (const axis of ['x', 'y', 'z']) {
  const step = 0.01;
  const before = sampleOceanWaveField(field, { ...position, [axis]: position[axis] - step }, seconds, options);
  const after = sampleOceanWaveField(field, { ...position, [axis]: position[axis] + step }, seconds, options);
  const numerical = (after.height - before.height) / (2 * step);
  assert.ok(Math.abs(numerical - sample.gradient[axis]) < 1e-6, `analytic ${axis} gradient`);
}

// Emulate the draw's relative-coordinate evaluation with the CPU reference.
for (const center of [position, { x: 6000100, y: -1200, z: 3500 }, { x: 5999000, y: 0, z: 0 }]) {
  const phases = oceanWavePhases(field, center, seconds);
  assert.ok(phases.every(([phase]) => phase >= 0 && phase < Math.PI * 2));
  const rebased = { ...field, modes: field.modes.map((mode, i) => ({
    ...mode, omega: 0, phase: phases[i][0],
  })) };
  const local = sampleOceanWaveField(rebased, {
    x: position.x - center.x, y: position.y - center.y, z: position.z - center.z,
  }, 0, options);
  assert.ok(Math.abs(local.height - sample.height) < 1e-8, 'anchor-independent wave height');
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(local.gradient[axis] - sample.gradient[axis]) < 1e-8);
  }
}

// Both harmonics must smoothly vanish at four samples per wavelength.
for (const mode of field.modes) {
  const single = { modes: [mode], normalization: 1 };
  const lambda = Math.PI * 2 / mode.k;
  for (const threshold of [lambda / 16, lambda / 8, lambda / 4]) {
    const before = sampleOceanWaveField(single, position, seconds, { footprint: threshold - 1e-5 });
    const after = sampleOceanWaveField(single, position, seconds, { footprint: threshold + 1e-5 });
    assert.ok(Math.abs(after.height - before.height) < 1e-5, 'continuous footprint filtering');
  }
  assert.equal(sampleOceanWaveField(single, position, seconds, { footprint: lambda / 4 }).height, 0);
  // At lambda/8 the harmonic is absent, but the fundamental is intact.
  const phase = oceanWavePhases(single, position, seconds)[0][0];
  const filtered = sampleOceanWaveField(single, position, seconds, { footprint: lambda / 8 });
  assert.ok(Math.abs(filtered.height - mode.weight * Math.sin(phase)) < 1e-10);
}
const timeStep = 1e-4;
const speedBound = options.significantHeight * field.normalization
  * field.modes.reduce((sum, mode) => sum + mode.weight * mode.omega * 1.44, 0);
for (const t of [0, seconds, 1e6]) {
  const a = sampleOceanWaveField(field, position, t, options);
  const b = sampleOceanWaveField(field, position, t + timeStep, options);
  assert.ok(Math.abs(a.height - b.height) <= speedBound * timeStep * 1.001, 'continuous time');
}

// Independent spatial samples check the stated Hs normalization rather than
// only reasserting its construction formula.
const random = makeRng('ocean-height-statistics');
let sum = 0, sumSquares = 0;
const count = 20000;
for (let i = 0; i < count; i++) {
  const point = { x: random() * 1e7, y: random() * 1e7, z: random() * 1e7 };
  const { height } = sampleOceanWaveField(field, point, i, { significantHeight: 3 });
  sum += height;
  sumSquares += height * height;
}
const mean = sum / count;
const measuredHs = 4 * Math.sqrt(sumSquares / count - mean * mean);
assert.ok(Math.abs(mean) < 0.025, 'wave field is approximately zero mean');
assert.ok(Math.abs(measuredHs - 3) < 0.08, `Hs normalization: ${measuredHs}`);
console.log(`ocean wave field tests passed (measured Hs ${measuredHs.toFixed(3)} m)`);
