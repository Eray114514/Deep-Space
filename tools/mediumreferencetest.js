import assert from 'node:assert/strict';
import { integrateMediumSlabs, MEDIUM_FIXTURES } from './medium-reference.js';

const near = (a, b, tolerance = 1e-10) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tolerance));
// Independent forward Euler transport at fine resolution, with prescribed
// sources. This uses neither slab sorting nor the analytic exponential step.
for (const fixture of MEDIUM_FIXTURES) {
  const expected = integrateMediumSlabs(fixture.slabs, fixture.depth, fixture.background);
  const steps = 120000, dt = fixture.depth / steps;
  const L = [0, 0, 0], T = [1, 1, 1];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const active = fixture.slabs.filter((s) => s.start <= t && t < s.end);
    for (let c = 0; c < 3; c++) {
      const sigma = active.reduce((sum, s) => sum + s.extinction[c], 0);
      const source = active.reduce((sum, s) => sum + s.source[c], 0);
      L[c] += T[c] * source * dt;
      T[c] *= 1 - sigma * dt;
    }
  }
  near(expected.radiance, L.map((v, c) => v + T[c] * fixture.background[c]), 0.00004);
  assert.ok(expected.T.every((v) => v >= 0 && v <= 1));
}
const vacuum = integrateMediumSlabs([], 1000, [0.2, 0.4, 0.6]);
near(vacuum.radiance, [0.2, 0.4, 0.6]);
const slab = { start: 0, end: 10, extinction: [0.1, 0.2, 0.3], source: [0.2, 0.4, 0.6] };
const full = integrateMediumSlabs([slab], 10);
near(full.T, [Math.exp(-1), Math.exp(-2), Math.exp(-3)]);
near(full.L, full.T.map((t) => 2 * (1 - t)));
const split = integrateMediumSlabs([{ ...slab, end: 4 }, { ...slab, start: 4 }], 10);
near(full.L, split.L); near(full.T, split.T);
console.log('PASS: B0 analytic medium reference, vacuum, segmentation and independent fine-step transport');
