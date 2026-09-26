import assert from 'node:assert/strict';
import { sampleCloudColumn, sampleCloudEnvironment } from '../src/cloud/cloud-environment.js';

const body = {
  R: 6000000, fullMaxFreq: 65536, hasLiquid: true, seaLevel: 700,
  height(direction, frequency) {
    assert.equal(frequency, 65536, 'weather cannot consume camera terrain LOD');
    return direction.x * 2000 - 500;
  },
};
const ocean = sampleCloudEnvironment(body, { x: 0, y: body.R + 1000, z: 0 }, 9.5);
assert.equal(ocean.terrainAltitudeMeters, -500);
assert.equal(ocean.surfaceAltitudeMeters, 700);
assert.equal(ocean.terrainClearanceMeters, 1500);
assert.equal(ocean.surfaceClearanceMeters, 300);
assert.equal(ocean.surfaceIsLiquid, true);
assert.equal(ocean.absoluteSeconds, 34200);
const mountain = sampleCloudEnvironment(body, { x: body.R + 1200, y: 0, z: 0 }, -2);
assert.equal(mountain.surfaceAltitudeMeters, 1500);
assert.equal(mountain.surfaceIsLiquid, false);
assert.equal(mountain.surfaceClearanceMeters, -300, 'mountains may intersect a cloud query');
assert.equal(mountain.absoluteSeconds, -7200, 'clock is absolute, not clamped or wrapped');
const dry = { ...body, hasLiquid: false, seaLevel: -1e9 };
assert.equal(sampleCloudColumn(dry, { x: 0, y: 4, z: 0 }).seaAltitudeMeters, null);
assert.equal(sampleCloudColumn(dry, { x: 0, y: 4, z: 0 }).surfaceAltitudeMeters, -500);
for (const hours of [0, 1e6, -100, 9.5]) {
  for (const altitude of [0, 12000, 1000000]) {
    const q = sampleCloudEnvironment(body, { x: 0, y: body.R + altitude, z: 0 }, hours);
    assert.equal(q.altitudeMeters, altitude);
    assert.equal(q.surfaceAltitudeMeters, ocean.surfaceAltitudeMeters);
    assert.deepEqual(q.direction, ocean.direction);
  }
}
assert.deepEqual(ocean, sampleCloudEnvironment(body, { x: 0, y: body.R + 1000, z: 0 }, 9.5));
const raisedSea = sampleCloudColumn({ ...body, seaLevel: 1000 }, ocean.direction);
assert.equal(raisedSea.terrainAltitudeMeters, ocean.terrainAltitudeMeters);
assert.equal(raisedSea.surfaceAltitudeMeters, 1000, 'sea moves without changing terrain');
for (const position of [{ x: 0, y: 0, z: 0 }, { x: NaN, y: 1, z: 0 },
  { x: Infinity, y: 0, z: 0 }, { x: 1.79e308, y: 1.79e308, z: 1.79e308 }, {}]) {
  assert.throws(() => sampleCloudEnvironment(body, position, 0), RangeError);
}
for (const hours of [NaN, Infinity, undefined, 1e308]) {
  assert.throws(() => sampleCloudEnvironment(body, { x: 1, y: 0, z: 0 }, hours), RangeError);
}
assert.throws(() => sampleCloudColumn({ ...body, fullMaxFreq: 0 }, ocean.direction));
assert.throws(() => sampleCloudColumn({ ...body, height: () => NaN }, ocean.direction), RangeError);
assert.throws(() => sampleCloudColumn({ ...body, seaLevel: NaN }, ocean.direction), RangeError);
console.log('B4 environment: radial/terrain/liquid heights, absolute clock, canonical terrain and invalid inputs passed.');
