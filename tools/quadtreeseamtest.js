import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Planet } from '../src/planet.js';
import { buildGalaxyCatalog } from '../src/galaxy-layout.js';
import { generateSystemSpec } from '../src/astronomy.js';
import {
  ChunkedLOD,
  cardinalNeighbourAddress,
  flushChunkQueue,
  setGridCells,
  setTerrainScreenError,
} from '../src/quadtree.js';
import { makeRng } from '../src/rng.js';

const FACE_FN = [
  (u, v, out) => out.set(1, v, -u),
  (u, v, out) => out.set(-1, v, u),
  (u, v, out) => out.set(u, 1, -v),
  (u, v, out) => out.set(u, -1, v),
  (u, v, out) => out.set(u, v, 1),
  (u, v, out) => out.set(-u, v, -1),
];

function edgeIndex(N, edge, s) {
  if (edge === 0) return s;
  if (edge === 1) return N * (N + 1) + s;
  if (edge === 2) return s * (N + 1);
  return s * (N + 1) + N;
}

function edgeDirections(node, edge) {
  const N = node.gridCells || node.lod.planet.gridCellsAtLevel(node.level);
  const dirs = [];
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const u = edge === 2 ? node.u0 : edge === 3 ? node.u1 : node.u0 + (node.u1 - node.u0) * t;
    const v = edge === 0 ? node.v0 : edge === 1 ? node.v1 : node.v0 + (node.v1 - node.v0) * t;
    dirs.push(FACE_FN[node.face](u, v, new THREE.Vector3()).normalize());
  }
  return dirs;
}

function morphedEdgeData(node, edge) {
  const N = node.gridCells || node.lod.planet.gridCellsAtLevel(node.level);
  const geo = node.mesh.geometry;
  const pos = geo.getAttribute('position');
  const dPos = geo.getAttribute('aPositionDelta');
  const nrm = geo.getAttribute('normal');
  const dNrm = geo.getAttribute('aNormalDelta');
  const morph = geo.getAttribute('aLodMorph');
  const dirs = edgeDirections(node, edge);
  const points = [];
  const normals = [];
  for (let s = 0; s <= N; s++) {
    const idx = edgeIndex(N, edge, s);
    const m = morph ? morph.getX(idx) : 0;
    const p = new THREE.Vector3(
      pos.getX(idx) + (dPos ? dPos.getX(idx) * m : 0),
      pos.getY(idx) + (dPos ? dPos.getY(idx) * m : 0),
      pos.getZ(idx) + (dPos ? dPos.getZ(idx) * m : 0),
    ).add(node.mesh.position);
    const n = new THREE.Vector3(
      nrm.getX(idx) + (dNrm ? dNrm.getX(idx) * m : 0),
      nrm.getY(idx) + (dNrm ? dNrm.getY(idx) * m : 0),
      nrm.getZ(idx) + (dNrm ? dNrm.getZ(idx) * m : 0),
    ).normalize();
    points.push(p);
    normals.push(n);
  }
  return { N, dirs, points, normals };
}

function pointToSegmentDist(p, a, b) {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq < 1e-18) return p.distanceTo(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lenSq, 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function minDistanceToPolyline(p, polyPoints) {
  let best = Infinity;
  for (let i = 0; i < polyPoints.length - 1; i++) {
    const d = pointToSegmentDist(p, polyPoints[i], polyPoints[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

setGridCells(24);
setTerrainScreenError(1.0);

let maxSameLevelGap = 0;
let maxNearSameLevelGap = 0;
let maxMixedLodGap = 0;
let maxNearMixedLodGap = 0;
let maxNormalDiffDeg = 0;
let checkedSameEdges = 0;
let checkedMixedEdges = 0;
let balanceViolations = 0;

for (const [type, radius, focusDir] of [
  ['desert', 387243, new THREE.Vector3(1, 0.998, 0.25).normalize()],
  ['barren', 261001, new THREE.Vector3(1, 0.999, 0.999).normalize()],
]) {
  const planet = new Planet({
    seed: `seam-check:${type}`,
    name: type,
    type,
    posUniv: new THREE.Vector3(),
    radius,
    formation: { tectonicActivity: 0.7, volcanicActivity: 0.6, impactRate: 0.8, erosion: 0.4, waterInventory: 0.2 },
  });
  try {
    const h = planet.height(focusDir, planet.fullMaxFreq);
    const camLocal = focusDir.clone().multiplyScalar(planet.R + h + 324);
    planet.lod.focused = true;
    for (let step = 0; step < 90; step++) {
      planet.lod.update(camLocal, 0.05);
      flushChunkQueue(500);
      const stats = planet.lod.debugStats();
      if (step > 25 && stats.pending === 0 && stats.activeMorphs === 0) break;
    }
    const stats = planet.lod.debugStats();
    assert.equal(planet.lod._orbitCapped, false, `${type} at 324 m must not stay orbit-capped`);
    assert.equal(stats.pending, 0, `${type} queue should drain`);
    assert.equal(stats.activeMorphs, 0, `${type} morphs should settle`);

    const visibleNodes = [];
    const collect = (node) => {
      if (node.mesh?.visible) visibleNodes.push(node);
      if (node.children) for (const c of node.children) collect(c);
    };
    for (const root of planet.lod.roots) collect(root);

    const visibleAncestorAtOrAbove = (face, level, ix, iy) => {
      let curLevel = level;
      let curIx = ix;
      let curIy = iy;
      while (curLevel >= 0) {
        const candidate = planet.lod.findNode(face, curLevel, curIx, curIy, false);
        if (candidate?.mesh?.visible) return candidate;
        curLevel--;
        curIx >>= 1;
        curIy >>= 1;
      }
      return null;
    };

    for (const node of visibleNodes) {
      if (node.level >= 5 && !planet.noShadow) {
        assert.equal(node.mesh.customDepthMaterial, planet.terrainDepthMaterial,
          `${type} L${node.level} shadow chunk must use morph-aware terrainDepthMaterial`);
      }
      if (node.level === 0) continue;
      // Float32 position quantization relative to each chunk's centerPos (~0.7*size)
      // plus 2-mesh ULP rounding reaches ~2e-7 * node.size on coarse L1..L4 chunks.
      const edgeTol = Math.max(0.002, node.size * 2.5e-7);
      const nodeBeyond = planet.lod.beyondHorizon(node);
      for (let edge = 0; edge < 4; edge++) {
        const addr = cardinalNeighbourAddress(node.face, edge, node.level, node.ix, node.iy);
        const sameNb = planet.lod.findNode(addr.face, node.level, addr.ix, addr.iy, false);
        if (sameNb?.mesh?.visible) {
          checkedSameEdges++;
          const a = morphedEdgeData(node, edge);
          const b = morphedEdgeData(sameNb, addr.edge);
          for (let s = 0; s <= a.N; s++) {
            const dir = a.dirs[s];
            let bestIdx = 0;
            let bestDot = -Infinity;
            for (let k = 0; k <= b.N; k++) {
              const dot = dir.dot(b.dirs[k]);
              if (dot > bestDot) { bestDot = dot; bestIdx = k; }
            }
            assert.ok(bestDot > 1 - 1e-10, `Edge direction mismatch (${bestDot})`);
            const gap = a.points[s].distanceTo(b.points[bestIdx]);
            assert.ok(gap <= edgeTol,
              `${type} L${node.level} same-level gap ${gap.toFixed(5)} m exceeds Float32 tolerance ${edgeTol.toFixed(5)} m`);
            maxSameLevelGap = Math.max(maxSameLevelGap, gap);
            if (node.level >= 6) maxNearSameLevelGap = Math.max(maxNearSameLevelGap, gap);
            const deg = THREE.MathUtils.radToDeg(
              Math.acos(THREE.MathUtils.clamp(a.normals[s].dot(b.normals[bestIdx]), -1, 1)),
            );
            maxNormalDiffDeg = Math.max(maxNormalDiffDeg, deg);
          }
        } else if (!sameNb?.splitActive) {
          if (nodeBeyond) continue;
          const coarseNb = visibleAncestorAtOrAbove(addr.face, node.level - 1, addr.ix >> 1, addr.iy >> 1);
          assert.ok(coarseNb, `Missing visible coarse neighbour for f${node.face}/L${node.level}`);
          if (node.level - coarseNb.level > 1) {
            if (!planet.lod.beyondHorizon(coarseNb)) {
              balanceViolations++;
            }
            continue;
          }
          checkedMixedEdges++;
          const fine = morphedEdgeData(node, edge);
          const coarse = morphedEdgeData(coarseNb, addr.edge);
          for (let s = 0; s <= fine.N; s++) {
            const gap = minDistanceToPolyline(fine.points[s], coarse.points);
            assert.ok(gap <= edgeTol,
              `${type} L${node.level} mixed-LOD gap ${gap.toFixed(5)} m exceeds tolerance ${edgeTol.toFixed(5)} m`);
            maxMixedLodGap = Math.max(maxMixedLodGap, gap);
            if (node.level >= 6) maxNearMixedLodGap = Math.max(maxNearMixedLodGap, gap);
          }
        }
      }
    }
  } finally {
    planet.dispose();
  }
}

assert.equal(balanceViolations, 0, `2:1 quadtree balance violated ${balanceViolations} times`);
assert.ok(checkedSameEdges > 100 && checkedMixedEdges > 20,
  `Expected both same-level (${checkedSameEdges}) and mixed-LOD (${checkedMixedEdges}) edges`);
assert.ok(maxNearSameLevelGap < 0.002, `Near/mid same-level edge seam gap too large: ${maxNearSameLevelGap} m`);
assert.ok(maxNearMixedLodGap < 0.002, `Near/mid mixed-LOD T-junction seam gap too large: ${maxNearMixedLodGap} m`);
assert.ok(maxNormalDiffDeg < 0.05, `Border normal discontinuity too large: ${maxNormalDiffDeg} deg`);

// Highland orbit-cap freedom check on a small rugged moon/planet (R = 67 km)
const highlandWorld = new Planet({
  seed: 'highland-cap-test',
  name: 'highland',
  type: 'barren',
  posUniv: new THREE.Vector3(),
  radius: 67000,
});
try {
  const rng = makeRng('highland-peak');
  let peakDir = new THREE.Vector3(0, 1, 0);
  let peakH = -Infinity;
  for (let i = 0; i < 1500; i++) {
    const d = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
    const h = highlandWorld.height(d, highlandWorld.fullMaxFreq);
    if (h > peakH) { peakH = h; peakDir = d; }
  }
  const camLocal = peakDir.clone().multiplyScalar(highlandWorld.R + peakH + 324);
  highlandWorld.lod.update(camLocal, 0.016);
  assert.equal(highlandWorld.lod._orbitCapped, false,
    `Low hover above peak h=${Math.round(peakH)} m must not trigger orbit level cap`);
  assert.equal(highlandWorld.lod._levelCap, highlandWorld.maxLevel);
} finally {
  highlandWorld.dispose();
}

// Sub-Nyquist ridge / terrace / canyon slope distribution check
for (const [type, radius] of [['desert', 387243], ['barren', 261001]]) {
  const p = new Planet({
    seed: `slope-check:${type}`,
    name: type,
    type,
    posUniv: new THREE.Vector3(),
    radius,
    formation: { tectonicActivity: 0.7, volcanicActivity: 0.6, impactRate: 0.8, erosion: 0.4, waterInventory: 0.2 },
  });
  try {
    const rng = makeRng(`slope:${type}`);
    const t1 = new THREE.Vector3();
    const d1 = new THREE.Vector3();
    for (const lvl of [6, 7, 8, 9]) {
      const N = p.gridCellsAtLevel(lvl);
      const cellAngle = (Math.PI / 2) / (N * (1 << lvl));
      const cellM = cellAngle * p.R;
      const freq = p.freqAtLevel(lvl);
      const slopes = [];
      for (let i = 0; i < 2000; i++) {
        const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
        if (Math.abs(dir.y) < 0.95) t1.set(-dir.z, 0, dir.x).normalize();
        else t1.set(1, 0, 0).projectOnPlane(dir).normalize();
        d1.copy(dir).addScaledVector(t1, cellAngle).normalize();
        slopes.push(Math.abs(p.height(d1, freq) - p.height(dir, freq)) / cellM);
      }
      slopes.sort((a, b) => a - b);
      const p99 = slopes[Math.floor(slopes.length * 0.99)];
      const max = slopes[slopes.length - 1];
      assert.ok(p99 < 1.35, `${type} L${lvl} p99 slope ${p99.toFixed(2)} too steep`);
      assert.ok(max < 4.5, `${type} L${lvl} max slope ${max.toFixed(2)} spike detected`);
    }
    // Verify dry-world continent-only hypsometry has no marine shoreface kink.
    p.ridgeAmp = 0; p.hillAmp = 0; p.roughAmp = 0; p.microAmp = 0;
    p.plateauAmt = 0; p.canyonAmp = 0; p.craterAmp = 0; p.duneAmp = 0; p.spikeAmp = 0;
    const N = p.gridCellsAtLevel(6);
    const cellAngle = (Math.PI / 2) / (N * (1 << 6));
    const cellM = cellAngle * p.R;
    const freq = p.freqAtLevel(6);
    const contSlopes = [];
    for (let i = 0; i < 1500; i++) {
      const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
      if (Math.abs(dir.y) < 0.95) t1.set(-dir.z, 0, dir.x).normalize();
      else t1.set(1, 0, 0).projectOnPlane(dir).normalize();
      d1.copy(dir).addScaledVector(t1, cellAngle).normalize();
      contSlopes.push(Math.abs(p.height(d1, freq) - p.height(dir, freq)) / cellM);
    }
    contSlopes.sort((a, b) => a - b);
    const contP99 = contSlopes[Math.floor(contSlopes.length * 0.99)];
    assert.ok(contP99 < 0.8, `${type} dry continent hypsometry p99 ${contP99.toFixed(2)} retains shoreface kink`);
  } finally {
    p.dispose();
  }
}

// Targeted regression checks for real catalog / seed destinations:
// 1. MARS planet 2 (领航员星): verify self-damping ridge spikes are gone at dirMars.
const marsCat = buildGalaxyCatalog('MARS');
const marsP2Spec = generateSystemSpec('MARS', marsCat[0]).bodies[2];
const marsP2 = new Planet({
  seed: marsP2Spec.seed,
  name: marsP2Spec.name,
  catalogName: marsP2Spec.catalogName,
  posUniv: new THREE.Vector3(),
  type: marsP2Spec.type,
  isMoon: marsP2Spec.isMoon,
  radius: marsP2Spec.radius,
  atmosphere: marsP2Spec.atmosphere,
  clouds: marsP2Spec.clouds,
  equilibriumK: marsP2Spec.equilibriumK,
  deferRoots: true,
  formation: marsP2Spec.formation,
  ringSystem: marsP2Spec.ringSystem,
});
try {
  const dirMars = new THREE.Vector3(0.203244915264589, -0.8525336892105488, 0.4815369281583099).normalize();
  const t1 = new THREE.Vector3().crossVectors(dirMars, new THREE.Vector3(0, 1, 0)).normalize();
  const t2 = new THREE.Vector3().crossVectors(dirMars, t1).normalize();
  for (const lvl of [6, 7, 8, 9]) {
    const cAng = (Math.PI / 2) / (marsP2.gridCellsAtLevel(lvl) * (1 << lvl));
    const stepM = cAng * marsP2.R;
    const freq = marsP2.freqAtLevel(lvl);
    const slopes = [];
    for (let iy = -16; iy <= 16; iy++) {
      for (let ix = -16; ix <= 16; ix++) {
        const d = dirMars.clone().addScaledVector(t1, ix * cAng).addScaledVector(t2, iy * cAng).normalize();
        const dX = dirMars.clone().addScaledVector(t1, (ix + 1) * cAng).addScaledVector(t2, iy * cAng).normalize();
        const dY = dirMars.clone().addScaledVector(t1, ix * cAng).addScaledVector(t2, (iy + 1) * cAng).normalize();
        const h = marsP2.height(d, freq);
        slopes.push(Math.hypot((marsP2.height(dX, freq) - h) / stepM, (marsP2.height(dY, freq) - h) / stepM));
      }
    }
    slopes.sort((a, b) => a - b);
    const p99 = slopes[Math.floor(slopes.length * 0.99)];
    const max = slopes[slopes.length - 1];
    assert.ok(p99 < 1.45, `MARS p2 L${lvl} p99 slope ${p99.toFixed(2)} >= 1.45`);
    assert.ok(max < 2.0, `MARS p2 L${lvl} max slope ${max.toFixed(2)} >= 2.0 (ridge spike regressed)`);
  }
} finally {
  marsP2.dispose();
}

// 2. MW-0919 planet 1 (图灵星, desert): global L7 slope check.
const milkyCat = buildGalaxyCatalog('MILKY-038');
const mwSpec = generateSystemSpec('MILKY-038', milkyCat.find((s) => s.id === 'MW-0919'));
const turingSpec = mwSpec.bodies[1];
const turing = new Planet({
  seed: turingSpec.seed,
  name: turingSpec.name,
  catalogName: turingSpec.catalogName,
  posUniv: new THREE.Vector3(),
  type: turingSpec.type,
  isMoon: turingSpec.isMoon,
  radius: turingSpec.radius,
  atmosphere: turingSpec.atmosphere,
  clouds: turingSpec.clouds,
  equilibriumK: turingSpec.equilibriumK,
  deferRoots: true,
  formation: turingSpec.formation,
  ringSystem: turingSpec.ringSystem,
});
try {
  const cAng7 = (Math.PI / 2) / (turing.gridCellsAtLevel(7) * (1 << 7));
  const stepM7 = cAng7 * turing.R;
  const freq7 = turing.freqAtLevel(7);
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const slopes = [];
  for (let i = 0; i < 600; i++) {
    const phi = Math.acos(1 - 2 * ((i + 0.5) / 600));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const d = new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    if (Math.abs(d.y) < 0.9) t1.set(-d.z, 0, d.x).normalize();
    else t1.set(1, 0, 0).projectOnPlane(d).normalize();
    t2.crossVectors(d, t1).normalize();
    const h = turing.height(d, freq7);
    slopes.push(Math.hypot(
      (turing.height(d.clone().addScaledVector(t1, cAng7).normalize(), freq7) - h) / stepM7,
      (turing.height(d.clone().addScaledVector(t2, cAng7).normalize(), freq7) - h) / stepM7,
    ));
  }
  slopes.sort((a, b) => a - b);
  const p99 = slopes[Math.floor(slopes.length * 0.99)];
  const max = slopes[slopes.length - 1];
  assert.ok(p99 < 1.5, `MW-0919 Turing L7 p99 slope ${p99.toFixed(2)} >= 1.5`);
  assert.ok(max < 2.6, `MW-0919 Turing L7 max slope ${max.toFixed(2)} >= 2.6`);
} finally {
  turing.dispose();
}

// 3. HOME planet 3 (威德尔, exotic): verify Voronoi spike bisector cliff is eliminated.
const homeSpec = generateSystemSpec('MILKY-038', milkyCat[0]);
const weddellSpec = homeSpec.bodies[3];
const weddell = new Planet({
  seed: weddellSpec.seed,
  name: weddellSpec.name,
  catalogName: weddellSpec.catalogName,
  posUniv: new THREE.Vector3(),
  type: weddellSpec.type,
  isMoon: weddellSpec.isMoon,
  radius: weddellSpec.radius,
  atmosphere: weddellSpec.atmosphere,
  clouds: weddellSpec.clouds,
  equilibriumK: weddellSpec.equilibriumK,
  deferRoots: true,
  formation: weddellSpec.formation,
  ringSystem: weddellSpec.ringSystem,
});
try {
  const level = 8, N = 64, span = 1 << level;
  const u0 = -1 + (2 * 254) / span, u1 = -1 + (2 * 255) / span;
  const v0 = -1 + (2 * 201) / span, v1 = -1 + (2 * 202) / span;
  const mf = weddell.freqAtLevel(level);
  const rowH = [];
  for (let gi = 25; gi <= 29; gi++) {
    const d = new THREE.Vector3(
      u0 + (u1 - u0) * (gi / N),
      1,
      -(v0 + (v1 - v0) * (29 / N)),
    ).normalize();
    rowH.push(weddell.height(d, mf));
  }
  let maxStepJump = 0;
  for (let k = 1; k < rowH.length; k++) {
    maxStepJump = Math.max(maxStepJump, Math.abs(rowH[k] - rowH[k - 1]));
  }
  assert.ok(maxStepJump < 5,
    `Weddell F2/L8/254,201 gj=29 gi=25..29 max jump ${maxStepJump.toFixed(2)} m >= 5 m (Voronoi spike cliff regressed)`);
} finally {
  weddell.dispose();
}

// 4. TEST19 planet 1 (勘察者星, desert): verify low-altitude refinement near face boundary never deadlocks on beyondHorizon L0 roots.
const test19Cat = buildGalaxyCatalog('TEST19');
const test19Spec = generateSystemSpec('TEST19', test19Cat[0]).bodies[1];
const test19Desert = new Planet({
  seed: test19Spec.seed,
  name: test19Spec.name,
  catalogName: test19Spec.catalogName,
  posUniv: new THREE.Vector3(),
  type: test19Spec.type,
  isMoon: test19Spec.isMoon,
  radius: test19Spec.radius,
  atmosphere: test19Spec.atmosphere,
  clouds: test19Spec.clouds,
  equilibriumK: test19Spec.equilibriumK,
  deferRoots: true,
  formation: test19Spec.formation,
  ringSystem: test19Spec.ringSystem,
});
try {
  const dir19 = new THREE.Vector3(0.27261589562411515, 0.773957299203321, 0.5715511109804289).normalize();
  const h19 = test19Desert.height(dir19, test19Desert.fullMaxFreq);
  const cam19 = dir19.clone().multiplyScalar(test19Desert.R + h19 + 324);
  test19Desert.lod.focused = true;
  for (let step = 0; step < 90; step++) {
    test19Desert.lod.update(cam19, 0.05);
    flushChunkQueue(500);
    const st = test19Desert.lod.debugStats();
    if (step > 25 && st.pending === 0 && st.activeMorphs === 0) break;
  }
  const st19 = test19Desert.lod.debugStats();
  assert.ok(st19.visibleMaxLevel >= 8,
    `TEST19 desert at 324 m must refine to >= L8, got L${st19.visibleMaxLevel}`);
} finally {
  test19Desert.dispose();
}

// 5. Homeworld (瑞亚星, lush): verify ground-column critical-path refinement
// during skydive/approach, highland performance-tier refinement to maxLevel,
// and absence of positive plateau DC shift between maxLevel and fullMaxFreq.
{
  const mwCat = buildGalaxyCatalog('MILKY-038');
  const rheaSpec = generateSystemSpec('MILKY-038', mwCat[0]).bodies.find((b) => b.type === 'lush');
  const makeRhea = () => new Planet({
    seed: rheaSpec.seed,
    name: rheaSpec.name,
    catalogName: rheaSpec.catalogName,
    posUniv: new THREE.Vector3(),
    type: rheaSpec.type,
    isMoon: rheaSpec.isMoon,
    radius: rheaSpec.radius,
    atmosphere: rheaSpec.atmosphere,
    clouds: rheaSpec.clouds,
    equilibriumK: rheaSpec.equilibriumK,
    formation: rheaSpec.formation,
    ringSystem: rheaSpec.ringSystem,
  });

  // 5a. Plateau lodGuard must not create > 0.85 m positive vertical shift at maxLevel.
  setTerrainScreenError(1.0);
  const rhea = makeRhea();
  try {
    const maxFreq = rhea.freqAtLevel(rhea.maxLevel);
    let maxPosDiff = -Infinity;
    let forestDir = null;
    for (let i = 0; i < 2000; i++) {
      const a = i * 2.39996;
      const y = -0.8 + (i / 2000) * 1.6;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const d = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r).normalize();
      const hf = rhea.height(d, rhea.fullMaxFreq);
      const biome = rhea.biomeAt(d, hf);
      if (hf <= rhea.seaLevel + 5 || (biome !== 'forest' && biome !== 'grass')) continue;
      if (!forestDir && hf > rhea.seaLevel + 40 && biome === 'forest') forestDir = d;
      const diff = rhea.height(d, maxFreq) - hf;
      if (diff > maxPosDiff) maxPosDiff = diff;
    }
    assert.ok(maxPosDiff < 0.85,
      `Rhea maxLevel positive height shift ${maxPosDiff.toFixed(3)} m >= 0.85 m (plateau lodGuard regression)`);

    // 5b. Ground-column critical-path priority must refine the chunk underfoot
    // from L0 roots to maxLevel in bounded chunk builds without starving behind
    // far-horizon L4 rings or ocean shells (deterministic: 1 completed chunk/step).
    const walkH = rhea.height(forestDir, rhea.fullMaxFreq);
    const walkCam = forestDir.clone().multiplyScalar(rhea.R + walkH + 1.7);
    const initialWaterChunks = rhea.waterLod ? rhea.waterLod.countChunks() : 0;
    let builtChunks = 0;
    let waterBuiltDuringCatchup = 0;
    let hitLevel = 0;
    let hitErr = Infinity;
    for (let step = 0; step < 440; step++) {
      rhea.update(walkCam, 0.05, true, 0.05);
      if (rhea.lod.groundLodDeficit === 0) break;
      let spins = 0;
      let b = 0;
      while (b === 0 && ++spins < 200) {
        b = flushChunkQueue(1);
      }
      builtChunks += b;
      if (rhea.waterLod) {
        waterBuiltDuringCatchup = rhea.waterLod.countChunks() - initialWaterChunks;
      }
    }
    // Settle morph on the active ground chunk before raycasting its height.
    for (let step = 0; step < 25; step++) {
      rhea.update(walkCam, 0.05, true, 0.05);
    }
    const ray = new THREE.Raycaster(forestDir.clone().multiplyScalar(rhea.R + 50000), forestDir.clone().negate());
    const findHit = (n) => {
      if (hitLevel > 0) return;
      if (n.mesh?.visible) {
        n.mesh.updateMatrixWorld(true);
        const hits = ray.intersectObject(n.mesh, false);
        if (hits.length) {
          hitLevel = n.level;
          hitErr = hits[0].point.length() - (rhea.R + walkH);
        }
      }
      if (n.children) for (const c of n.children) findHit(c);
    };
    for (const root of rhea.lod.roots) findHit(root);
    assert.equal(rhea.lod.groundLodDeficit, 0,
      `Rhea ground column failed to reach maxLevel within 440 chunks (built=${builtChunks})`);
    assert.ok(builtChunks <= 420,
      `Rhea ground column took ${builtChunks} chunks (expected <= 420; critical-path priority regressed)`);
    assert.ok(waterBuiltDuringCatchup <= 4,
      `waterLod stole ${waterBuiltDuringCatchup} chunk builds while terrain underfoot had groundLodDeficit > 0`);
    assert.equal(hitLevel, rhea.maxLevel,
      `Rhea ground chunk under feet is L${hitLevel} (expected maxLevel L${rhea.maxLevel})`);
    assert.ok(Math.abs(hitErr) < 0.5,
      `Rhea ground mesh error ${hitErr.toFixed(3)} m >= 0.5 m`);
  } finally {
    rhea.dispose();
  }

  // 5c. Highland spot with > 1 km low-freq deviation must still reach maxLevel on performance preset.
  setTerrainScreenError(1.35);
  const rheaPerf = makeRhea();
  try {
    let worst = { diff: 0, d: null, hf: 0 };
    for (let i = 0; i < 2000; i++) {
      const a = i * 2.39996;
      const y = -0.9 + (i / 2000) * 1.8;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const d = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r).normalize();
      const hf = rheaPerf.height(d, rheaPerf.fullMaxFreq);
      if (hf <= rheaPerf.seaLevel + 5) continue;
      const diff = Math.abs(hf - rheaPerf.height(d, 24));
      if (diff > worst.diff) worst = { diff, d, hf };
    }
    const cam = worst.d.clone().multiplyScalar(rheaPerf.R + worst.hf + 1.7);
    rheaPerf.lod.focused = true;
    for (let step = 0; step < 300; step++) {
      rheaPerf.lod.update(cam, 0.05);
      flushChunkQueue(80);
      if (step > 25 && rheaPerf.lod.groundLodDeficit === 0) break;
    }
    assert.equal(rheaPerf.lod.groundLodDeficit, 0,
      `Rhea highland spot (|h-h24|=${worst.diff.toFixed(0)} m) must reach maxLevel on performance preset`);
    assert.equal(rheaPerf.lod.debugStats().visibleMaxLevel, rheaPerf.maxLevel,
      `Rhea highland spot stalled below maxLevel ${rheaPerf.maxLevel}`);
  } finally {
    rheaPerf.dispose();
    setTerrainScreenError(1.0);
  }
}

console.log('PASS: quadtree seams, 2:1 balance, border normals, highland LOD freedom, and ridge anti-aliasing', {
  checkedSameEdges,
  checkedMixedEdges,
  maxSameLevelGap: +maxSameLevelGap.toFixed(6),
  maxNearSameLevelGap: +maxNearSameLevelGap.toFixed(6),
  maxMixedLodGap: +maxMixedLodGap.toFixed(6),
  maxNearMixedLodGap: +maxNearMixedLodGap.toFixed(6),
  maxNormalDiffDeg: +maxNormalDiffDeg.toFixed(5),
});
