import assert from 'node:assert/strict';
import { hash3i, hashFloat, makeRng } from '../src/rng.js';
import { worley3 } from '../src/noise.js';
import { Planet } from '../src/planet.js';
import { TerrainCraterField } from '../src/terrain-crater-field.js';
const craterCandidate = Planet.prototype.craters;
const ownerFor = intSeed => ({ intSeed, _craterField: new TerrainCraterField() });

let crossings = 0, oldWorst = 0, newWorst = 0, gradientWorst = 0;
const rows = [];
for (let seed = 0; seed < 24; seed++) {
  const owner = ownerFor(seed);
  const f = (p) => craterCandidate.call(owner, ...p, 1, 1, 0);
  const legacy = (p) => {
    const w = worley3(...p, seed), h = w.h;
    const r = 0.16 + ((h >>> 4) % 64) / 64 * 0.26;
    const amp = 0.35 + ((h >>> 10) % 64) / 64 * 0.65, t = w.d / r;
    return (t < 1 ? t * t * 1.35 - 1 : t < 1.6 ? 0.35 * (1 - (t - 1) / 0.6) : 0) * amp;
  };
  const sites = [];
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const h = hash3i(x, y, z, seed);
    sites.push({ h, p: [x + hashFloat(h, 0), y + hashFloat(h, 1), z + hashFloat(h, 2)] });
  }
  for (let a = 0; a < sites.length; a++) for (let b = a + 1; b < sites.length; b++) {
    const A = sites[a], B = sites[b], d = B.p.map((v, i) => v - A.p[i]);
    const length = Math.hypot(...d), mid = A.p.map((v, i) => (v + B.p[i]) * 0.5);
    const at = (t) => mid.map((v, i) => v + d[i] / length * t);
    if (worley3(...at(-1e-9), seed).h !== A.h || worley3(...at(1e-9), seed).h !== B.h) continue;
    const oldJump = Math.abs(legacy(at(1e-9)) - legacy(at(-1e-9)));
    if (oldJump < 1e-5) continue;
    crossings++;
    const jump = Math.abs(f(at(1e-9)) - f(at(-1e-9)));
    const e = 1e-5, center = f(mid);
    const gradientJump = Math.abs((f(at(e)) - center) / e - (center - f(at(-e))) / e);
    if (oldJump > oldWorst) rows.push({ seed, mid, oldJump, jump, gradientJump });
    oldWorst = Math.max(oldWorst, oldJump); newWorst = Math.max(newWorst, jump);
    gradientWorst = Math.max(gradientWorst, gradientJump);
  }
}
assert.ok(crossings > 100, 'Exercise active crater ownership boundaries, not empty field');
assert.ok(oldWorst > 0.1, 'Legacy discontinuity must be reproduced');
assert.ok(newWorst < 1e-7, `Crater sum retains a height discontinuity: ${newWorst}`);
assert.ok(gradientWorst < 0.02, `Crater sum retains a normal discontinuity: ${gradientWorst}`);
const rng = makeRng('crater-cell-boundaries');
let integerWorst = 0;
for (let i = 0; i < 1000; i++) {
  const p = [rng() * 10 - 5, rng() * 10 - 5, rng() * 10 - 5], axis = i % 3;
  p[axis] = Math.round(p[axis]); const q = [...p]; p[axis] -= 1e-9; q[axis] += 1e-9;
  integerWorst = Math.max(integerWorst, Math.abs(craterCandidate.call(ownerFor(i), ...p, 1, 1, 0)
    - craterCandidate.call(ownerFor(i), ...q, 1, 1, 0)));
}
assert.ok(integerWorst < 1e-7);
console.log(JSON.stringify({ crossings, oldWorst, newWorst, gradientWorst, integerWorst, rows }, null, 2));
