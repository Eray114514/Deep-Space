import { mkdir, writeFile } from 'node:fs/promises';
import { Simplex } from '../src/noise.js';
import { makeRng } from '../src/rng.js';
import { latticeNoiseClass, minimumSkewCellDistanceSquared } from './terrain-lattice-oracle.js';
import { continuousTerrainNoise } from './terrain-continuous-candidate.js';
const out = `test-results/terrain-lattice-oracle/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const names = ['tetra-4', 'cube-8', 'pruned-14', 'oracle-64', 'oracle-216'];
const instances = [Simplex, latticeNoiseClass(0, 1), latticeNoiseClass(-1, 2, true),
  latticeNoiseClass(-1, 2), latticeNoiseClass(-2, 3)].map((C) => new C(makeRng('lattice-oracle')));
const rng = makeRng('lattice-samples'), points = [], maxErrors = names.map(() => 0);
const worst = names.map(() => null);
for (let n = 0; n < 20000; n++) {
  const q = [rng() * 200 - 100, rng() * 200 - 100, rng() * 200 - 100];
  points.push(q);
  const values = instances.map((noise) => noise.noise(...q));
  values.forEach((value, i) => {
    const error = Math.abs(value - values[4]);
    if (error > maxErrors[i]) { maxErrors[i] = error; worst[i] = { q, value, oracle: values[4] }; }
  });
}
// Test actual skew-cell transitions, not just internal tetra ordering planes.
const skewJumps = names.map(() => 0);
for (let n = 0; n < 5000; n++) for (let axis = 0; axis < 3; axis++) {
  const q = [rng() * 20 - 10, rng() * 20 - 10, rng() * 20 - 10];
  q[axis] = Math.round(q[axis]);
  const unskew = (sign) => {
    const v = [...q]; v[axis] += sign * 1e-9;
    const t = (v[0] + v[1] + v[2]) / 6;
    return v.map((x) => x - t);
  };
  const left = unskew(-1), right = unskew(1);
  instances.forEach((noise, i) => { skewJumps[i] = Math.max(skewJumps[i], Math.abs(noise.noise(...left) - noise.noise(...right))); });
}
const timings = [];
for (let i = 0; i < instances.length; i++) {
  let checksum = 0;
  const start = performance.now();
  for (let round = 0; round < 5; round++) for (const q of points) checksum += instances[i].noise(...q);
  timings.push({ name: names[i], millisecondsPer100k: performance.now() - start, checksum });
}
const stencil = [];
for (let x = -2; x <= 3; x++) for (let y = -2; y <= 3; y++) for (let z = -2; z <= 3; z++) {
  const minimum = minimumSkewCellDistanceSquared([x, y, z]);
  if (minimum < .6) stencil.push({ offset: [x, y, z], minimum });
}
const report = { scope: 'CPU diagnostic, no runtime edits. Timings are warmed single-run measurements, not a release performance gate.',
  samples: points.length, names, maxErrorsAgainst216: maxErrors, worst, maximumSkewBoundaryJump: skewJumps, stencil, timings };
const candidate = new Simplex(makeRng('lattice-oracle'));
candidate.noise = continuousTerrainNoise;
let candidateError = 0;
for (const q of points) candidateError = Math.max(candidateError,
  Math.abs(candidate.noise(q[0],q[1],q[2])-instances[4].noise(q[0],q[1],q[2])));
const coordinates = Float64Array.from(points.flat());
const directTimings = [];
for (const [name, noise] of [['original',instances[0]],['unrolled14',candidate]]) {
  // A fresh monomorphic direct xyz call site per implementation, no spread,
  // REST array, apply, wrapper around the noise method, or per-sample allocation.
  const bench = new Function('noise','coordinates', `let checksum=0; const start=performance.now();
    for(let round=0;round<50;round++)for(let i=0;i<coordinates.length;i+=3)
      checksum+=noise.noise(coordinates[i],coordinates[i+1],coordinates[i+2]);
    return {ms:performance.now()-start,checksum};`);
  bench(noise,coordinates);
  directTimings.push({name,samples:points.length*50,...bench(noise,coordinates)});
}
Object.assign(report,{candidateErrorAgainst216:candidateError,directTimings});
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out, ...report }, null, 2));
