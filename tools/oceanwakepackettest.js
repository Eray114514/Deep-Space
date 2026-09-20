import assert from 'node:assert/strict';
import { sampleOceanWakePacket, oceanWakePacketGLSL } from '../src/ocean-wake-packet.js';

const at = (along, lateral, age, speed = 8.8) => sampleOceanWakePacket({ along, lateral, age, speed });
for (const along of [-2, -8, -12]) {
  let previous = at(along, 0, 0);
  for (const age of [0.7, 1.5, 2.6, 5]) {
    const current = at(along, 0, age);
    assert.ok(current.armCenter > previous.armCenter);
    assert.ok(current.width > previous.width && current.coreWidth > previous.coreWidth);
    assert.ok(Math.abs((at(along - 1, 0, age).armCenter - current.armCenter) - 0.354) < 1e-12);
    previous = current;
  }
}
assert.equal(at(-19, 0, 0).longitudinal, 0, 'no 56 m trail at birth');
// Integrate the whole finite world-space packet, not its clipped screen image.
// Each lateral slice has identical normalized mass despite shoulder migration.
function integrate(age) {
  const p = at(0, 0, age);
  const result = [0, 0, 0];
  const step = 0.25;
  for (let along = p.centerAlong - 3 * p.length; along <= p.centerAlong + 3 * p.length; along += step) {
    const row = at(along, 0, age);
    const extent = row.armCenter + 3 * row.width;
    for (let lateral = -extent; lateral <= extent; lateral += step) {
      const value = at(along, lateral, age);
      result[0] += value.armEnvelope * step * step;
      result[1] += value.coreEnvelope * step * step;
      result[2] += value.centerEnvelope * step * step;
    }
  }
  return result;
}
const initial = integrate(0);
let previous = initial;
for (const age of [0.7, 1.5, 2.6, 5, 7]) {
  const mass = integrate(age);
  const ratio = at(0, 0, age).energy;
  mass.forEach((value, i) => {
    assert.ok(value < previous[i], 'integral energy decays despite spreading');
    assert.ok(Math.abs(value / initial[i] - ratio) < 0.001, 'area normalization matches decay law');
  });
  previous = mass;
}
for (const age of [0, 2.6, 7.9]) {
  const p = at(-10, 0, age);
  const boundary = p.armCenter + 3 * p.width;
  assert.equal(at(-10, boundary + 0.001, age).armEnvelope, 0);
  assert.ok(at(-10, boundary - 0.001, age).armEnvelope < 1e-8);
  const tail = p.centerAlong - 3 * p.length;
  assert.equal(at(tail - 0.001, 0, age).envelope, 0);
  assert.ok(at(tail + 0.001, 0, age).envelope < 1e-8);
}
assert.equal(at(-30, 15, 8).armEnvelope, 0);
assert.equal(at(-30, 15, 90).armEnvelope, 0);
assert.ok(at(-30, 15, 8 - 0.001).armEnvelope < 1e-8);
assert.deepEqual(at(-10, 12, 2), at(-10, 12, 2));
assert.equal(at(-10, 12, 2).armEnvelope, at(-10, -12, 2).armEnvelope);
assert.throws(() => at(0, 0, NaN), RangeError);
assert.ok(oceanWakePacketGLSL.includes('struct OceanWakePacket'));
console.log('Wake packet: propagating Kelvin shoulders, widening core, finite support and integrated energy decay passed.');
