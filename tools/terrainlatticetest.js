import assert from 'node:assert/strict';
import { TerrainSimplex } from '../src/terrain-noise.js';
import { Simplex } from '../src/noise.js';
import { makeRng } from '../src/rng.js';
import { latticeNoiseClass } from './terrain-lattice-oracle.js';

const Oracle = latticeNoiseClass(-2, 3);
const field = new TerrainSimplex(makeRng('terrain-lattice-contract'));
const oracle = new Oracle(makeRng('terrain-lattice-contract'));
const original = new Simplex(makeRng('terrain-lattice-contract'));
assert.deepEqual(field.perm, original.perm, 'Terrain consumed different RNG draws');
const rng = makeRng('terrain-lattice-boundaries');
let maximumError = 0, maximumJump = 0, originalJump = 0;
for (let i = 0; i < 12000; i++) {
  const p = [rng() * 200 - 100, rng() * 200 - 100, rng() * 200 - 100];
  maximumError = Math.max(maximumError, Math.abs(field.noise(...p) - oracle.noise(...p)));
  // Internal tetra ordering planes and integer skew-cell boundaries must
  // agree without resetting the field or changing its amplitude.
  const x = rng() * 20 - 10, z = rng() * 20 - 10, e = 1e-9;
  const a = [x + e, x - e, z], b = [x - e, x + e, z];
  maximumJump = Math.max(maximumJump, Math.abs(field.noise(...a) - field.noise(...b)));
  originalJump = Math.max(originalJump, Math.abs(original.noise(...a) - original.noise(...b)));
  const axis = i % 3;
  p[axis] = Math.round(p[axis]);
  const at = (sign) => {
    const q = [...p]; q[axis] += sign * e;
    const unskew = (q[0] + q[1] + q[2]) / 6;
    return q.map((v) => v - unskew);
  };
  maximumJump = Math.max(maximumJump, Math.abs(field.noise(...at(-1)) - field.noise(...at(1))));
}
assert.ok(originalJump > 0.001, 'Reproduce dropped-support discontinuity');
assert.ok(maximumError < 1e-12, `Incomplete lattice support: ${maximumError}`);
assert.ok(maximumJump < 1e-7, `Discontinuous terrain noise: ${maximumJump}`);
console.log('PASS: complete terrain lattice support', { maximumError, maximumJump, originalJump });
