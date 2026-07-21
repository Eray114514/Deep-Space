// Fast node-side smoke test (no browser): builds one planet of every type,
// checks the height/color functions and LOD chunk builder for sanity and
// LOD-consistency, and prints terrain stats. `node tools/sanity.js`

import * as THREE from 'three';
import { Planet, TYPES } from '../src/planet.js';
import { flushChunkQueue, pendingChunks } from '../src/quadtree.js';
import { Scatter, capFor } from '../src/scatter.js';
import { FarFlora } from '../src/farflora.js';

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

  let min = Infinity, max = -Infinity, below = 0, nan = 0, snowSamples = 0, snowFlora = 0;
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
    if ((type === 'lush' || type === 'ocean') && p.snowWeightAt(dir, h) > 0.28) {
      snowSamples++;
      if (['grass', 'forest', 'dryland', 'shore'].includes(p.biomeAt(dir, h))) snowFlora++;
    }
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
  if (type === 'lush' || type === 'ocean') {
    check(snowSamples > 0, `${type}: snow mask produced no QA samples`);
    check(snowFlora === 0, `${type}: ${snowFlora} snow-covered samples still select a flora biome`);
  }
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
  let maxInfSeen = 0;
  const scanInfluence = () => {
    let m = 0;
    const walk = (n) => {
      if (n.mesh && n.mesh.visible && n.mesh.morphTargetInfluences) {
        m = Math.max(m, n.mesh.morphTargetInfluences[0]);
      }
      if (n.children) n.children.forEach(walk);
    };
    for (const r of p.lod.roots) walk(r);
    return m;
  };
  // converge-or-timeout: LOD prefetch builds ~40% more chunks near the
  // surface, so heavy worlds need more passes — but exit as soon as the
  // queue drains and every morph has relaxed
  for (let it = 0; it < 240; it++) {
    p.lod.update(cam, 0.05);
    if (p.waterLod) p.waterLod.update(cam, 0.05);
    flushChunkQueue(400);
    maxInfSeen = Math.max(maxInfSeen, scanInfluence());
    if (it > 20 && pendingChunks() === 0 && scanInfluence() < 0.01) break;
  }
  const tRefine = performance.now() - t1;

  // geomorph: transitions must happen (influence ~1 observed on new chunks),
  // settle to full detail, and carry bounded parent-shape deltas
  check(maxInfSeen > 0.5, `${type}: no geomorph transition observed (max influence ${maxInfSeen.toFixed(2)})`);
  check(scanInfluence() < 0.01, `${type}: geomorph never settled (${scanInfluence().toFixed(2)})`);
  {
    let morphed = 0, maxDelta = 0;
    const walk = (n) => {
      if (n.mesh && n.level > 0) {
        const ma = n.mesh.geometry.morphAttributes;
        if (ma && ma.position && ma.position[0]) {
          morphed++;
          const a = ma.position[0].array;
          for (let i = 0; i < a.length; i += 37 * 3) maxDelta = Math.max(maxDelta, Math.abs(a[i]));
        }
      }
      if (n.children) n.children.forEach(walk);
    };
    for (const r of p.lod.roots) walk(r);
    check(morphed > 10, `${type}: chunks missing morph targets (${morphed})`);
    check(maxDelta < p.hAmp * 2.5, `${type}: morph deltas out of range (${maxDelta.toFixed(1)} m)`);
  }
  check(pendingChunks() === 0, `${type}: build queue never drained`);
  const chunks = p.lod.countChunks();
  check(chunks > 30, `${type}: too little subdivision near surface (${chunks} chunks)`);

  // props must be planet-fixed: WALK the camera through dense vegetation
  // across many rebuilds — every prop in the shared interior must persist
  // bit-identically at every single rebuild (this has been broken twice)
  if (type === 'lush') {
    const scatter = new Scatter({ streamBudgetMs: Infinity });
    const m4 = new THREE.Matrix4();
    const grab = () => {
      const map = new Map();
      const cnt = {};
      for (const kind in scatter.meshes) {
        const im = scatter.meshes[kind];
        cnt[kind] = im.count;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m4);
          const x = m4.elements[12], y = m4.elements[13], z = m4.elements[14];
          map.set(kind + ':' + x.toFixed(3) + ',' + y.toFixed(3) + ',' + z.toFixed(3), [x, y, z]);
        }
      }
      return { map, cnt };
    };

    // start somewhere green and dense
    const rnd2 = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(1234);
    let walkDir = null;
    const probe = new THREE.Vector3();
    for (let i = 0; i < 2000 && !walkDir; i++) {
      probe.set(rnd2() * 2 - 1, rnd2() * 2 - 1, rnd2() * 2 - 1);
      if (probe.lengthSq() < 0.05 || probe.lengthSq() > 1) continue;
      probe.normalize();
      const h = p.height(probe, 64);
      if (p.hasLiquid && h < p.seaLevel + 3) continue;
      const biome = p.biomeAt(probe, h);
      if (biome === 'grass' || biome === 'forest') walkDir = probe.clone();
    }
    check(!!walkDir, `${type}: found no vegetated ground to walk`);

    let axis = new THREE.Vector3(0, 1, 0).cross(walkDir);
    if (axis.lengthSq() < 0.01) axis.set(1, 0, 0).cross(walkDir);
    axis.normalize();

    let prev = null, prevCam = null;
    let rebuilds = 0, worstKept = 1, totChecked = 0;
    const peaks = {};
    const cam = new THREE.Vector3();
    for (let step = 0; step <= 50; step++) {
      const dir = walkDir.clone().applyAxisAngle(axis, (step * 1.4) / p.R);
      cam.copy(dir).multiplyScalar(p.R + p.height(dir, p.fullMaxFreq) + 1.7);
      const keyBefore = scatter.lastKey;
      scatter.update(p, cam, 2);
      if (scatter.lastKey === keyBefore) continue;
      rebuilds++;
      const cur = grab();
      for (const k in cur.cnt) peaks[k] = Math.max(peaks[k] || 0, cur.cnt[k]);
      if (prev) {
        let miss = 0, tot = 0;
        for (const [k, pos] of prev.map) {
          const da = Math.hypot(pos[0] - prevCam.x, pos[1] - prevCam.y, pos[2] - prevCam.z);
          const db = Math.hypot(pos[0] - cam.x, pos[1] - cam.y, pos[2] - cam.z);
          if (da > 110 || db > 110) continue;     // safely inside both ranges
          tot++;
          if (!cur.map.has(k)) miss++;
        }
        totChecked += tot;
        if (tot > 0) worstKept = Math.min(worstKept, 1 - miss / tot);
      }
      prev = cur;
      prevCam = cam.clone();
    }
    check(rebuilds >= 4, `${type}: walk produced too few rebuilds (${rebuilds})`);
    check(totChecked > 500, `${type}: too few props to judge stability (${totChecked})`);
    check(worstKept === 1, `${type}: props churn while walking (worst rebuild kept ${(worstKept * 100).toFixed(1)}%)`);
    // a kind at its instance cap means anchor-dependent selection: which
    // props render would depend on where the camera stands → visible churn
    for (const k in peaks) {
      check(peaks[k] < capFor(k), `${type}: '${k}' saturated its instance cap (${peaks[k]}/${capFor(k)})`);
    }
    const peakStr = Object.entries(peaks).filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`         scatter walk: ${rebuilds} rebuilds, ${totChecked} interior checks, worst kept ${(worstKept * 100).toFixed(1)}%  peaks[${peakStr}]`);
    scatter.clear();

    // far tier: proxy forests must be non-empty over vegetated ground and
    // bit-identical between two independent builds at the same spot
    const farCam = walkDir.clone().multiplyScalar(p.R + p.height(walkDir, p.fullMaxFreq) + 300);
    const buildFar = () => {
      const ff = new FarFlora({ streamBudgetMs: Infinity, repackIntervalMs: 0 });
      for (let i = 0; i < 200 && (i < 2 || ff.pending() > 0); i++) ff.update(p, farCam, 300);
      const counts = [ff.meshes[0].count, ff.meshes[1].count];
      const sig = ff.meshes[0].instanceMatrix.array.slice(0, counts[0] * 16).join(',');
      ff.clear();
      return { counts, sig };
    };
    const fa = buildFar(), fb = buildFar();
    check(fa.counts[0] + fa.counts[1] > 100, `${type}: far flora suspiciously sparse (${fa.counts})`);
    check(fa.counts[0] === fb.counts[0] && fa.counts[1] === fb.counts[1] && fa.sig === fb.sig,
      `${type}: far flora not deterministic (${fa.counts} vs ${fb.counts})`);
    console.log(`         far flora: ${fa.counts[0]}+${fa.counts[1]} proxy trees in reach`);
  }
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
