import assert from 'node:assert/strict';
import { createOceanSurface, sampleOceanSurface, raycastOceanSurface, OCEAN_SURFACE_BIAS } from '../src/ocean-surface.js';
import { oceanSeconds, OCEAN_SECONDS_PER_WORLD_HOUR } from '../src/ocean-clock.js';
import { oceanWavePhases, sampleOceanWaveField } from '../src/ocean-wave-field.js';
import { oceanTidalEventUniforms, sampleOceanTidalRelative } from '../src/ocean-tidal-event.js';

const R = 6000000;
const event = { normal: [1, 0, 0], height: 280, period: 400, epoch: 1234 };
const options = { radius: R, event,
  sampleRegion: () => ({ depth: 2000, offshoreSignificantHeight: 4 }) };
const surface = createOceanSurface('surface-test', options);
const rebuilt = createOceanSurface('surface-test', options);
assert.deepEqual(surface.waveField, rebuilt.waveField);
assert.deepEqual(surface.tidalField, rebuilt.tidalField);
const hours = (event.epoch + event.period / 2) / OCEAN_SECONDS_PER_WORLD_HOUR;
const p = { x: R, y: 0, z: 0 };
const sample = sampleOceanSurface(surface, p, hours);
assert.ok(sample.tidalHeight > 277 && sample.tidalHeight < 280);
assert.equal(sample.seconds, oceanSeconds(hours));
assert.ok(sample.clearance < -275, 'baseline eye really lies below a giant crest');
assert.equal(sample.wet, true);
assert.deepEqual(sample, sampleOceanSurface(rebuilt, p, hours));
// Eye/keel radial altitude cannot change the sampled phase or normal.
const high = sampleOceanSurface(surface, { x: R + 400, y: 0, z: 0 }, hours);
assert.equal(high.height, sample.height);
assert.deepEqual(high.normal, sample.normal);
assert.ok(Math.abs(high.clearance - sample.clearance - 400) < 1e-9);
// Emulate rendering the same baseline world point with different small anchors.
for (const anchor of [{ x: R + 512, y: 100, z: 20 }, { x: R - 1024, y: -90, z: 500 }]) {
  const relative = { x: p.x - anchor.x, y: p.y - anchor.y, z: p.z - anchor.z };
  const phases = oceanWavePhases(surface.waveField, anchor, sample.seconds);
  const rebasedField = { ...surface.waveField, modes: surface.waveField.modes.map((mode, i) =>
    ({ ...mode, phase: phases[i][0] })) };
  const wave = sampleOceanWaveField(rebasedField, relative, 0, { significantHeight: 4, footprint: 4 });
  const tide = sampleOceanTidalRelative(oceanTidalEventUniforms(surface.tidalField, anchor, sample.seconds),
    relative, { depth: 2000 });
  assert.ok(Math.abs(wave.height + tide.height + OCEAN_SURFACE_BIAS - sample.height) < 1e-8);
}
for (const depth of [-3, 0, 0.2, 1, 20]) {
  const shallow = createOceanSurface('surface-test', { ...options,
    sampleRegion: () => ({ depth, offshoreSignificantHeight: 4 }) });
  const s = sampleOceanSurface(shallow, p, hours);
  assert.equal(s.significantHeight, 4, 'local depth does not erase regional incident Hs');
  assert.ok(s.tidalHeight <= Math.max(0, depth) * 0.62 + 1e-10);
  assert.ok(Math.abs(s.waveHeight - sample.waveHeight * Math.min(1, Math.max(0, depth) * 0.62 / 4)) < 1e-10);
  assert.equal(s.wet, depth > 0);
  if (depth <= 0) assert.equal(s.height, OCEAN_SURFACE_BIAS);
}
// Includes depth and regional amplitude gradients, not only constant-Hs waves.
const regional = createOceanSurface('slope-test', { ...options,
  sampleRegion: (dir) => ({ depth: 1 + dir.y * R * 0.05,
    offshoreSignificantHeight: 4 + dir.z * 0.5 }) });
const normal = sampleOceanSurface(regional, p, hours).normal;
for (const axis of ['y', 'z']) {
  const step = 0.05;
  const left = sampleOceanSurface(regional, { ...p, [axis]: -step }, hours);
  const right = sampleOceanSurface(regional, { ...p, [axis]: step }, hours);
  const slope = (right.height - left.height) / (2 * step);
  const radius = sampleOceanSurface(regional, p, hours).surfaceRadius;
  assert.ok(Math.abs(normal[axis] / normal.x + slope * R / radius) < 0.0002);
}
for (const pos of [p, { x: 0, y: R, z: 0 }, { x: 0, y: -R, z: 0 }]) {
  const result = sampleOceanSurface(surface, pos, hours);
  assert.ok(Math.abs(Math.hypot(...Object.values(result.normal)) - 1) < 1e-12);
}
const boundary = (event.epoch + event.period) / OCEAN_SECONDS_PER_WORLD_HOUR;
assert.ok(Math.abs(sampleOceanSurface(surface, p, boundary - 1e-8).height
  - sampleOceanSurface(surface, p, boundary + 1e-8).height) < 1e-4);
// Seeking and restoring persisted time is deterministic; no accumulator/anchor.
sampleOceanSurface(surface, { x: 0, y: 0, z: R }, hours + 1e5);
assert.deepEqual(sampleOceanSurface(surface, p, hours), sample);
assert.throws(() => sampleOceanSurface(surface, p, NaN), RangeError);
assert.throws(() => sampleOceanSurface(surface, { x: 0, y: 0, z: 0 }, hours), RangeError);
assert.throws(() => createOceanSurface('bad', { ...options, radius: 0 }), RangeError);
console.log('Ocean surface owner: deterministic clock/anchors, regional normals, giant and shallow contacts passed.');

let evaluations = 0;
const flat = createOceanSurface('flat-ray', { radius: R,
  sampleRegion: () => { evaluations++; return { depth: 1000, offshoreSignificantHeight: 0 }; } });
const eye = { x: R + 100, y: 0, z: 0 };
const inward = { x: -9, y: 0, z: 0 };
const flatHit = raycastOceanSurface(flat, eye, inward, hours);
assert.ok(Math.abs(flatHit.distance - (100 - OCEAN_SURFACE_BIAS)) < 0.005);
assert.ok(Math.abs(flatHit.position.x - (R + OCEAN_SURFACE_BIAS)) < 0.005);
assert.deepEqual(flatHit.basePosition, p);
assert.deepEqual(flatHit.direction, { x: 1, y: 0, z: 0 });
assert.equal(evaluations, flatHit.evaluations);
assert.ok(evaluations <= 149);
assert.equal(raycastOceanSurface(flat, eye, inward, hours, { maxDistance: 90 }), null);
evaluations = 0;
assert.equal(raycastOceanSurface(flat, eye, { x: 1, y: 0, z: 0 }, hours), null);
assert.equal(evaluations, 129, 'bounded no-hit cost');
assert.equal(raycastOceanSurface(flat, eye, { x: 0, y: 1, z: 0 }, hours), null);
const exit = raycastOceanSurface(flat, p, { x: 1, y: 0, z: 0 }, hours);
assert.ok(Math.abs(exit.distance - OCEAN_SURFACE_BIAS) < 0.005, 'underwater outward exit');
const giantHit = raycastOceanSurface(surface, { x: R + 400, y: 0, z: 0 }, inward, hours);
assert.ok(giantHit && giantHit.distance < 125, 'find actual crest before the flat sea sphere');
assert.ok(Math.abs(sampleOceanSurface(surface, giantHit.position, hours, { normal: false }).clearance) < 0.005);
const dry = createOceanSurface('dry-ray', { radius: R,
  sampleRegion: () => ({ depth: -10, offshoreSignificantHeight: 0 }) });
assert.equal(raycastOceanSurface(dry, eye, inward, hours), null);
// Small sphere deliberately allows a whole-planet range: do not hit its far exit.
const tiny = createOceanSurface('tiny-ray', { radius: 10,
  sampleRegion: () => ({ depth: 5, offshoreSignificantHeight: 0 }) });
assert.equal(raycastOceanSurface(tiny, { x: 9, y: 0, z: 0 }, inward, hours), null);
assert.throws(() => raycastOceanSurface(flat, eye, inward, hours, { maxDistance: 2000 }), RangeError);
assert.throws(() => raycastOceanSurface(flat, eye, { x: 0, y: 0, z: 0 }, hours), RangeError);
assert.throws(() => raycastOceanSurface(flat, eye, inward, hours, { stepSize: 20 }), RangeError);
assert.deepEqual(raycastOceanSurface(surface, { x: R + 400, y: 0, z: 0 }, inward, hours), giantHit);
console.log('Ocean surface ray: bounded near-side bracketing, giant crest, dry/miss/exit and budget checks passed.');
