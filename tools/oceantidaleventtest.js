import assert from 'node:assert/strict';
import { createOceanTidalEvent, sampleOceanTidalEvent, oceanTidalEventUniforms,
  sampleOceanTidalRelative } from '../src/ocean-tidal-event.js';

const event = { normal: [0.3, 0.8, -0.2], height: 240, period: 360, epoch: 1234 };
const field = createOceanTidalEvent(event);
assert.deepEqual(field, createOceanTidalEvent(event));
assert.throws(() => createOceanTidalEvent({ ...event, normal: [0, 0, 0] }), RangeError);
const vector = (a) => ({ x: a[0], y: a[1], z: a[2] });
const pointAt = (s, v, radial = field.radius) => vector(field.up.map((value, i) =>
  value * radial + field.axis[i] * s + field.side[i] * v));
const peakTime = event.epoch + event.period / 2;
assert.ok(sampleOceanTidalEvent(field, pointAt(0, 0), peakTime).height > event.height * 0.98,
  'the finite packet retains its authored peak height');
assert.ok(sampleOceanTidalEvent(field, pointAt(-field.width, 0), peakTime).height
  > sampleOceanTidalEvent(field, pointAt(field.width, 0), peakTime).height * 2,
  'the rear shoulder is longer than the steep leading edge');
assert.throws(() => sampleOceanTidalEvent(field, pointAt(0, 0), peakTime, { depth: NaN }), RangeError);
const point = pointAt(field.width * 0.4, field.lateralWidth * 0.3);
const reference = sampleOceanTidalEvent(field, point, peakTime);
for (const anchor of [pointAt(0, 0), pointAt(2000, -300), pointAt(-1000, 1200)]) {
  const uniforms = oceanTidalEventUniforms(field, anchor, peakTime);
  const rebased = sampleOceanTidalRelative(uniforms,
    { x: point.x - anchor.x, y: point.y - anchor.y, z: point.z - anchor.z });
  assert.ok(Math.abs(rebased.height - reference.height) < 1e-8, 'stable across 6 Mm anchors');
}
for (const p of [point, pointAt(-field.width, 0), pointAt(field.width * 5.4, 0),
  pointAt(field.width, field.lateralWidth * 2.4), pointAt(100, 200, field.radius * 0.6)]) {
  const exact = sampleOceanTidalEvent(field, p, peakTime);
  for (const axis of ['x', 'y', 'z']) {
    const h = 0.02;
    const before = sampleOceanTidalEvent(field, { ...p, [axis]: p[axis] - h }, peakTime);
    const after = sampleOceanTidalEvent(field, { ...p, [axis]: p[axis] + h }, peakTime);
    assert.ok(Math.abs((after.height - before.height) / (2 * h) - exact.gradient[axis]) < 1e-6,
      `analytic ${axis} derivative including support envelopes`);
  }
}
for (const t of [event.epoch - 1e-3, event.epoch, event.epoch + 1e-3, peakTime]) {
  const a = sampleOceanTidalEvent(field, point, t);
  const b = sampleOceanTidalEvent(field, point, t + event.period);
  assert.ok(Math.abs(a.height - b.height) < 1e-8, 'periodic event has no clock seam');
}
// Check wrap where the outgoing packet actually resides, not just at its
// empty centre. Its value and spatial derivative vanish before teleporting.
const exit = pointAt(field.speed * field.period / 2, 0);
for (const dt of [-1e-3, 0, 1e-3]) {
  const sample = sampleOceanTidalEvent(field, exit, event.epoch + dt);
  assert.ok(Math.abs(sample.height) < 1e-10);
  assert.ok(Math.hypot(...Object.values(sample.gradient)) < 1e-10);
}
for (const depth of [-1, 0, 0.5, 2, 20]) {
  for (let i = -60; i <= 60; i++) {
    const sample = sampleOceanTidalEvent(field, pointAt(i * field.width / 10, 0), peakTime, { depth });
    assert.ok(Math.abs(sample.height) <= Math.max(depth, 0) * 0.62 + 1e-10);
  }
}
assert.ok(sampleOceanTidalEvent(field, pointAt(field.width * 2.5, 0), peakTime).height < 0,
  'a shallow drawdown precedes the crest');
assert.equal(sampleOceanTidalEvent(field, pointAt(0, field.lateralWidth * 3), peakTime).height, 0);
assert.equal(sampleOceanTidalEvent(field, pointAt(0, 0, -field.radius), peakTime).height, 0);
for (const normal of [[0, 1, 0], [0, -1, 0], [1, 0, 0]]) {
  const polar = createOceanTidalEvent({ ...event, normal });
  const sample = sampleOceanTidalEvent(polar, vector(normal.map((v) => v * polar.radius)), peakTime);
  assert.ok(Number.isFinite(sample.height) && Object.values(sample.gradient).every(Number.isFinite));
}
console.log('tidal event deterministic anchors, gradients, periodicity, finite support and shoaling tests passed');
