// Terrain generator profile (pure Node): what the height function actually
// contains, in physical units. Prints the land elevation distribution, the
// RMS slope measured over several baselines (a flat-plate world shows ~0° at
// short baselines), and the cost of one height sample per LOD cutoff.
//
//   node tools/terrain-profile.js [type=lush] [radiusMeters=1200000] [seed]

import * as THREE from 'three';
import { Planet } from '../src/planet.js';

const type = process.argv[2] || 'lush';
const radiusMeters = Number(process.argv[3] || 1200000);
const seed = process.argv[4] || 'PROFILE:' + type;

const p = new Planet({
  seed, name: 'PROFILE', posUniv: new THREE.Vector3(), type,
  tuning: { radiusMeters },
});
const R = p.R;
console.log(`type=${type} R=${(R / 1000).toFixed(0)} km hAmp=${p.hAmp.toFixed(0)} m sea=${p.hasLiquid ? p.seaLevel.toFixed(0) : 'none'} fullMaxFreq=${p.fullMaxFreq.toFixed(0)}`);

const rnd = ((s) => () => (s = (s * 16807) % 2147483647) / 2147483647)(1234);
const dir = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), d = new THREE.Vector3();
const randomDir = () => {
  do dir.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1); while (dir.lengthSq() < 0.01 || dir.lengthSq() > 1);
  return dir.normalize();
};

// ---- land elevation distribution -----------------------------------------
const land = [];
const sites = [];
for (let i = 0; i < 6000; i++) {
  randomDir();
  const h = p.height(dir, p.fullMaxFreq);
  if (!p.hasLiquid || h > p.seaLevel) {
    land.push(h - (p.hasLiquid ? p.seaLevel : 0));
    if (sites.length < 1500) sites.push(dir.clone());
  }
}
land.sort((a, b) => a - b);
const q = (f) => land[Math.min(land.length - 1, Math.floor(f * land.length))];
console.log(`land fraction ${(land.length / 6000 * 100).toFixed(1)}%  elevation above sea/datum (m): `
  + [0.05, 0.25, 0.5, 0.75, 0.9, 0.99].map((f) => `p${f * 100}=${q(f).toFixed(0)}`).join(' '));

// ---- slope by baseline -----------------------------------------------------
for (const baseline of [3, 30, 300, 3000, 30000]) {
  let sum = 0, steep = 0;
  for (const site of sites) {
    if (Math.abs(site.y) < 0.95) t1.set(-site.z, 0, site.x).normalize(); else t1.set(1, 0, 0);
    t2.crossVectors(site, t1);
    const h0 = p.height(site, p.fullMaxFreq);
    const hx = p.height(d.copy(site).addScaledVector(t1, baseline / R).normalize(), p.fullMaxFreq);
    const hy = p.height(d.copy(site).addScaledVector(t2, baseline / R).normalize(), p.fullMaxFreq);
    const slope = Math.hypot(hx - h0, hy - h0) / baseline;
    sum += slope * slope;
    if (slope > 0.36) steep++;
  }
  const rms = Math.sqrt(sum / sites.length);
  console.log(`baseline ${String(baseline).padStart(5)} m: rms slope ${(Math.atan(rms) * 180 / Math.PI).toFixed(2)}°  steeper than 20°: ${(steep / sites.length * 100).toFixed(1)}%`);
}

// ---- cost per sample ---------------------------------------------------------
for (const level of [3, 6, 9, 12, p.maxLevel]) {
  const maxFreq = p.freqAtLevel(level);
  const n = 20000;
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < n; i++) acc += p.height(sites[i % sites.length], maxFreq);
  const us = (performance.now() - t0) / n * 1000;
  console.log(`level ${String(level).padStart(2)} (maxFreq ${maxFreq.toFixed(0)}): ${us.toFixed(2)} µs/sample`);
  if (!Number.isFinite(acc)) throw new Error('non-finite height');
}
