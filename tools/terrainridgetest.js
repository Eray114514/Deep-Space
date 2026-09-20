import assert from 'node:assert/strict';
import { Simplex } from '../src/noise.js';
import { makeRng } from '../src/rng.js';

let crossings = 0, oldWorst = 0, roundedWorst = 0, preservedFlanks = 0;
for (let seed = 0; seed < 32; seed++) {
  const field = new Simplex(makeRng(`ridge-continuity:${seed}`));
  const y = 0.371, z = -0.253;
  const ridge = (x, width) => field.ridged(x, y, z, 1, 1, 0.55, 2.1, 1e9, width);
  for (let i = -80; i < 80; i++) {
    let lo = i * 0.05, hi = lo + 0.05;
    const a = field.noise(lo, y, z), b = field.noise(hi, y, z);
    if (Math.abs(a) > 0.12) {
      assert.equal(ridge(lo, 0.12), ridge(lo, 0), 'Rounding changed a mountain flank');
      preservedFlanks++;
    }
    if (a * b >= 0) continue;
    for (let j = 0; j < 40; j++) {
      const mid = (lo + hi) * 0.5;
      if (field.noise(mid, y, z) * a > 0) lo = mid;
      else hi = mid;
    }
    const center = (lo + hi) * 0.5;
    // Reject sign flips caused by a separate simplex support discontinuity:
    // this test specifically exercises the ridge's zero crossing.
    if (Math.abs(field.noise(center, y, z)) > 1e-8) continue;
    const e = 1e-6;
    const slopeJump = (width) => Math.abs((ridge(center + e, width)
      - 2 * ridge(center, width) + ridge(center - e, width)) / e);
    oldWorst = Math.max(oldWorst, slopeJump(0));
    roundedWorst = Math.max(roundedWorst, slopeJump(0.12));
    crossings++;
  }
}
assert.ok(crossings > 100, 'Exercise seeded mountain crests');
assert.ok(preservedFlanks > 1000, 'Exercise terrain outside the rounded crests');
assert.ok(oldWorst > 1, 'Reproduce the original normal jump');
assert.ok(roundedWorst < 0.001, `Rounded crest retains a normal jump: ${roundedWorst}`);
console.log('PASS: terrain ridge continuity', { crossings, preservedFlanks, oldWorst, roundedWorst });
