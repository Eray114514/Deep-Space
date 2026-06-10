// Fast node-side smoke test (no browser): builds one planet of every type,
// checks the height/color functions and LOD chunk builder for sanity and
// LOD-consistency, and prints terrain stats. `node tools/sanity.js`

import * as THREE from 'three';
import { Planet, TYPES } from '../src/planet.js';
import { flushChunkQueue, pendingChunks } from '../src/quadtree.js';

const dir = new THREE.Vector3();
const col = new THREE.Color();
let failures = 0;

function check(cond, msg) {
  if (!cond) { failures++; console.error('  ✗', msg); }
}

for (const type of Object.keys(TYPES)) {
  const t0 = performance.now();
  const p = new Planet({
    seed: 'SANITY:' + type, name: type.toUpperCase(),
    posUniv: new THREE.Vector3(), type,
  });
  const tBuild = performance.now() - t0;

  let min = Infinity, max = -Infinity, below = 0, nan = 0;
  const N = 4000;
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(42);
  for (let i = 0; i < N; i++) {
    dir.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (dir.lengthSq() < 0.01 || dir.lengthSq() > 1) { i--; continue; }
    dir.normalize();
    const h = p.height(dir, p.fullMaxFreq);
    if (Number.isNaN(h)) { nan++; continue; }
    min = Math.min(min, h); max = Math.max(max, h);
    if (p.hasLiquid && h < p.seaLevel) below++;
    p.colorAt(dir, h, 0.1, p.fullMaxFreq, col);
    if (Number.isNaN(col.r + col.g + col.b)) nan++;
  }

  // LOD consistency: coarse height field must approximate the fine one
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    dir.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (dir.lengthSq() < 0.01 || dir.lengthSq() > 1) { i--; continue; }
    dir.normalize();
    const hF = p.height(dir, p.fullMaxFreq);
    const hC = p.height(dir, p.freqAtLevel(1));
    worst = Math.max(worst, Math.abs(hF - hC));
  }

  console.log(
    `${type.padEnd(7)} R=${p.R.toFixed(0).padStart(4)}  h=[${min.toFixed(1)}, ${max.toFixed(1)}]m  hAmp=${p.hAmp.toFixed(0)}m` +
    (p.hasLiquid ? `  sea=${p.seaLevel.toFixed(1)}m cover=${(below / N * 100).toFixed(0)}%` : '            ') +
    `  lvl≤${p.maxLevel}  LODdiff=${worst.toFixed(1)}m  build=${tBuild.toFixed(0)}ms`,
  );

  check(nan === 0, `${type}: NaNs in height/color`);
  check(max - min > p.hAmp * 0.3, `${type}: terrain suspiciously flat (${(max - min).toFixed(1)}m)`);
  check(max - min < p.hAmp * 6, `${type}: terrain wildly out of range`);
  check(worst < p.hAmp * 1.2, `${type}: far/near LOD disagree too much (${worst.toFixed(1)}m)`);
  check(p.lod.roots.length === 6 && p.lod.roots.every((r) => r.mesh), `${type}: root chunks missing`);
  if (p.hasLiquid && p.liquid === 'water') {
    const frac = below / N;
    check(frac > 0.1 && frac < 0.95, `${type}: odd sea coverage ${(frac * 100).toFixed(0)}%`);
  }

  // exercise the subdivision + build queue around a surface point
  // (the tree deepens one level per update, so iterate past convergence)
  const cam = p.scenicDir().multiplyScalar(p.R + 50);
  const t1 = performance.now();
  for (let it = 0; it < 80; it++) {
    p.lod.update(cam);
    flushChunkQueue(400);
  }
  const tRefine = performance.now() - t1;
  check(pendingChunks() === 0, `${type}: build queue never drained`);
  const chunks = p.lod.countChunks();
  check(chunks > 30, `${type}: too little subdivision near surface (${chunks} chunks)`);
  let leafTris = 0;
  for (const r of p.lod.roots) {
    const walk = (n) => {
      if (n.mesh && n.mesh.visible) leafTris += n.mesh.geometry.index.count / 3;
      if (n.children) n.children.forEach(walk);
    };
    walk(r);
  }
  console.log(`         near-surface: chunks=${chunks} visibleTris=${(leafTris / 1000).toFixed(0)}k refine=${tRefine.toFixed(0)}ms`);
  p.dispose();
}

console.log(failures ? `\nSANITY: ${failures} failure(s)` : '\nSANITY: all good');
process.exit(failures ? 1 : 0);
