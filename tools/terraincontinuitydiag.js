// CPU attribution only. Never mutates the production generator or lock.
import * as THREE from 'three';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Planet } from '../src/planet.js';
import { Simplex } from '../src/noise.js';
import { makeRng } from '../src/rng.js';
import { generateSystemSpec } from '../src/astronomy.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { getGalaxyConfig, resolveBodyTuning } from '../src/world-config.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { latticeNoiseClass } from './terrain-lattice-oracle.js';

const out = `test-results/terrain-continuity/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const source = await readFile(new URL('../src/noise.js', import.meta.url), 'utf8');
const continuousSource = source.replace("'./rng.js'", JSON.stringify(new URL('../src/rng.js', import.meta.url).href))
  .replaceAll('0.6 -', '0.5 -');
const { Simplex: HalfKernel } = await import(`data:text/javascript;base64,${Buffer.from(continuousSource).toString('base64')}`);
const useLattice = process.env.TERRAIN_CONTINUITY_KERNEL === 'lattice';
const Continuous = useLattice ? latticeNoiseClass(-1, 2) : HalfKernel;
const raw = new Simplex(makeRng('continuity-probe'));
const fixed = new Continuous(makeRng('continuity-probe'));
let sumOld = 0, sumNew = 0;
const rng = makeRng('continuity-amplitude');
for (let i = 0; i < 20000; i++) {
  const xyz = [rng() * 40 - 20, rng() * 40 - 20, rng() * 40 - 20];
  sumOld += raw.noise(...xyz) ** 2; sumNew += fixed.noise(...xyz) ** 2;
}
const gain = useLattice ? 1 : Math.sqrt(sumOld / sumNew);
const planeRng = makeRng('samples');
const planes = [];
for (let i = 0; i < 20000; i++) {
  const x = planeRng() * 20 - 10, z = planeRng() * 20 - 10;
  const values = [1e-4, 1e-6, 1e-8, 1e-10].map((epsilon) => ({ epsilon,
    oldJump: raw.noise(x + epsilon, x - epsilon, z) - raw.noise(x - epsilon, x + epsilon, z),
    continuousJump: (fixed.noise(x + epsilon, x - epsilon, z) - fixed.noise(x - epsilon, x + epsilon, z)) * gain }));
  planes.push({ x, z, values });
}
planes.sort((a, b) => Math.abs(b.values.at(-1).oldJump) - Math.abs(a.values.at(-1).oldJump));
const galaxy = getGalaxyConfig();
const system = generateSystemSpec(galaxy.seed, new GalaxyCatalog(galaxy.seed).getSystem(HOME_SYSTEM_ID));
const body = system.bodies.find((b) => b.bodyId === 'planet-0');
const planet = new Planet({ ...body, posUniv: new THREE.Vector3(),
  tuning: resolveBodyTuning({ galaxyId: galaxy.id, seed: galaxy.seed, systemId: system.systemId, bodyId: body.bodyId }) });
const alternative = Object.create(planet);
for (const key of ['nA', 'nB', 'nC', 'nD']) {
  alternative[key] = Object.assign(Object.create(Continuous.prototype), planet[key]);
  alternative[key].noise = function (...args) { return Continuous.prototype.noise.apply(this, args) * gain; };
}
const fixture = JSON.parse(await readFile('test-results/stage-a-continuous/2026-09-08T08-53-21-489Z/report.json', 'utf8')).coastFixture;
const origin = new THREE.Vector3(...fixture.direction), forward = new THREE.Vector3(...fixture.landward);
const side = new THREE.Vector3().crossVectors(origin, forward).normalize();
const direction = (along, across) => origin.clone().addScaledVector(forward, along / planet.R)
  .addScaledVector(side, across / planet.R).normalize();
const domains = [];
for (let octave = 0; octave < 6; octave++) {
  domains.push({ name: `mountain-${octave}`, sample: (q) => [q.x * planet.mountFreq * 2.1 ** octave,
    q.y * planet.mountFreq * 2.1 ** octave - octave * 13.7, q.z * planet.mountFreq * 2.1 ** octave] });
  domains.push({ name: `detail-${octave}`, sample: (q) => [q.x * planet.detailFreq * 2.2 ** octave,
    q.y * planet.detailFreq * 2.2 ** octave + octave * 19.19, q.z * planet.detailFreq * 2.2 ** octave] });
}
for (let octave = 0; octave < 4; octave++) domains.push({ name: `continent-${octave}`, sample: (q) => {
  const { x, y, z } = q, f = planet.warpFreq, a = planet.warpAmp, cf = planet.contFreq * 2.05 ** octave;
  return [(x + planet.nB.noise(x * f + 31.4, y * f, z * f) * a) * cf,
    (y + planet.nB.noise(x * f, y * f + 47.2, z * f) * a) * cf + octave * 19.19,
    (z + planet.nB.noise(x * f, y * f, z * f + 71.7) * a) * cf];
} });
const crossings = [];
for (const across of [-20000, 0, 20000]) for (const domain of domains) for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
  const field = (distance) => { const value = domain.sample(direction(distance, across)); return value[a] - value[b]; };
  for (let start = -20000; start < 40000; start += 1000) {
    const va = field(start), vb = field(start + 1000);
    for (let boundary = Math.ceil(Math.min(va, vb)); boundary <= Math.floor(Math.max(va, vb)); boundary++) {
      let lo = start, hi = start + 1000;
      for (let i = 0; i < 45; i++) {
        const mid = (lo + hi) / 2;
        if ((field(mid) < boundary) === (va < boundary)) lo = mid; else hi = mid;
      }
      const at = (lo + hi) / 2;
      const values = [1, 0.01, 0.0001].map((metres) => {
        const left = direction(at - metres, across), right = direction(at + metres, across);
        return { metres, oldJump: planet.height(right) - planet.height(left),
          continuousJump: alternative.height(right) - alternative.height(left) };
      });
      crossings.push({ domain: domain.name, axes: [a, b], boundary, along: at, across,
        direction: direction(at, across).toArray(), values });
    }
  }
}
crossings.sort((a, b) => Math.abs(b.values.at(-1).oldJump) - Math.abs(a.values.at(-1).oldJump));
const surfaceNormal = (owner, along, across, spacing) => {
  const q = direction(along, across), tangent = forward.clone().projectOnPlane(q).normalize();
  const bitangent = new THREE.Vector3().crossVectors(q, tangent).normalize();
  const base = q.clone().multiplyScalar(owner.R + owner.height(q));
  const a = q.clone().addScaledVector(tangent, spacing / owner.R).normalize();
  const b = q.clone().addScaledVector(bitangent, spacing / owner.R).normalize();
  return a.multiplyScalar(owner.R + owner.height(a)).sub(base)
    .cross(b.multiplyScalar(owner.R + owner.height(b)).sub(base)).normalize();
};
for (const crossing of crossings.slice(0, 16)) {
  crossing.normalComparison = [5, 35.9527, 71.9053].map((spacing) => {
    const compare = (owner) => {
      const left = surfaceNormal(owner, crossing.along - .01, crossing.across, spacing);
      const right = surfaceNormal(owner, crossing.along + .01, crossing.across, spacing);
      return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(left.dot(right), -1, 1)));
    };
    return { forwardSampleMetres: spacing, centersApartMetres: .02,
      oldNormalJumpDegrees: compare(planet), continuousNormalJumpDegrees: compare(alternative) };
  });
}
const shifts = [];
for (let across = -20000; across <= 20000; across += 1000) for (let along = -20000; along <= 40000; along += 1000) {
  const q = direction(along, across), oldHeight = planet.height(q), newHeight = alternative.height(q);
  shifts.push({ along, across, oldHeight, newHeight, delta: newHeight - oldHeight,
    coastFlipped: (oldHeight < planet.seaLevel) !== (newHeight < planet.seaLevel) });
}
const absoluteShifts = shifts.map((r) => Math.abs(r.delta)).sort((a, b) => a - b);
const report = { ...await evidenceFingerprint('tools/terraincontinuitydiag.js'),
  claim: 'Simplex tetrahedron boundary continuity, not gradient-direction isotropy. CPU-only: no screenshot correspondence is asserted.',
  alternative: useLattice ? 'Kernel .6, complete 64-neighbor diagnostic lattice sum, same gradients/permutations/amplitude32; no RMS refit.'
    : 'Kernel .5, same permutations/gradients, gain fitted to raw-noise RMS of independent 20k samples. Not a runtime patch.',
  gain, oldRms: Math.sqrt(sumOld / 20000), newRawRms: Math.sqrt(sumNew / 20000),
  rawPlaneSamples: planes.length, rawNonvanishingJumps: planes.filter((r) => Math.abs(r.values.at(-1).oldJump) > 1e-5).length,
  continuousNonvanishingJumps: planes.filter((r) => Math.abs(r.values.at(-1).continuousJump) > 1e-5).length,
  worstRawPlanes: planes.slice(0, 16), fixture, terrainCrossings: crossings,
  terrainShift: { points: shifts.length, medianAbsoluteMetres: absoluteShifts[Math.floor(absoluteShifts.length * .5)],
    p95AbsoluteMetres: absoluteShifts[Math.floor(absoluteShifts.length * .95)], maxAbsoluteMetres: absoluteShifts.at(-1),
    coastFlips: shifts.filter((r) => r.coastFlipped).length },
  scopeLimits: 'Three local transects, 1 km crossing brackets of selected primary noise domains; excludes some erosion-offset/province/warp boundaries. RMS matching does not preserve authored heights or coastline.' };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out, gain, rawNonvanishingJumps: report.rawNonvanishingJumps,
  continuousNonvanishingJumps: report.continuousNonvanishingJumps, crossings: crossings.length,
  worstCrossings: crossings.slice(0, 5), terrainShift: report.terrainShift }, null, 2));
