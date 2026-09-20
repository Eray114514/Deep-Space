import assert from 'node:assert/strict';
import { createOceanDetailFrame, oceanDetailOffsets, oceanDetailCoordinates, oceanDetailGLSL } from '../src/ocean-detail-frame.js';

const frame = createOceanDetailFrame(0.0397);
assert.deepEqual(frame, createOceanDetailFrame(0.0397));
assert.throws(() => createOceanDetailFrame(NaN), RangeError);
const point = { x: 6000000.125, y: -2356000.375, z: 4567000.875 };
const origin = { x: 0, y: 0, z: 0 };
const circularError = (a, b) => Math.abs((a - b) - Math.round(a - b));
let worstDouble = 0;
let worstFloat = 0;
for (const delta of [0, 1024, -1024, 4096]) {
  const anchor = { x: point.x + delta, y: point.y - delta * 0.43, z: point.z + delta * 0.72 };
  const offsets = oceanDetailOffsets(frame, anchor);
  assert.ok(offsets.flat().every((v) => v >= 0 && v < 1));
  const relative = Object.fromEntries(Object.keys(point).map((key) => [key, point[key] - anchor[key]]));
  for (let index = 0; index < frame.channels.length; index++) {
    const drift = [0.123, -0.987];
    const expected = oceanDetailCoordinates(frame, index, point, oceanDetailOffsets(frame, origin), drift);
    const actual = oceanDetailCoordinates(frame, index, relative, offsets, drift);
    const rounded = oceanDetailCoordinates(frame, index,
      Object.fromEntries(Object.entries(relative).map(([k, v]) => [k, Math.fround(v)])),
      offsets.map((uv) => uv.map(Math.fround)), drift).map(Math.fround);
    for (let i = 0; i < 4; i++) {
      worstDouble = Math.max(worstDouble, circularError(actual[i], expected[i]));
      worstFloat = Math.max(worstFloat, circularError(rounded[i], expected[i]));
    }
  }
}
assert.ok(worstDouble < 1e-8, `double phase error ${worstDouble}`);
assert.ok(worstFloat < 0.0003, `float boundary phase error ${worstFloat}`);
const glsl = oceanDetailGLSL(frame);
assert.ok(glsl.includes('uOceanDetailOffsets[8]'));
assert.ok(!glsl.includes('fract('), 'Do not break texture mip derivatives at wrap seams.');
assert.ok(!glsl.includes('uNearPatchCenter'), 'Shader never reconstructs million-metre coordinates.');
console.log(JSON.stringify({ status: 'pass', channels: frame.channels.length, worstDouble, worstFloat }));
