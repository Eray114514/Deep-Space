// Surface props: alien flora (seeded per-planet species from flora.js) plus
// rocks and crystals, scattered around the camera when near the ground.
// Placement is a pure function of (planet seed, surface cell) — walk away
// and come back, the same tree is waiting.

import * as THREE from 'three';
import { hash3i, hashFloat } from './rng.js';
import { applyWindSway, GROW } from './shaders.js';
import { buildFlora } from './flora.js';

// wind strength per prop kind (0 = rigid)
const SWAY = { grass: 0.08, shrub: 0.05, pod: 0.03, tree0: 0.012, tree1: 0.012, blob: 0.02, cactus: 0.008 };

// jagged rock: displace a subdivided solid by hashed per-vertex noise —
// crags instead of platonic dice
function craggyGeo(base, amount, seed) {
  const pos = base.attributes.position;
  const seen = new Map();   // co-located verts must move together
  for (let i = 0; i < pos.count; i++) {
    const key = pos.getX(i).toFixed(3) + ',' + pos.getY(i).toFixed(3) + ',' + pos.getZ(i).toFixed(3);
    let k = seen.get(key);
    if (k === undefined) {
      const h = hash3i(Math.round(pos.getX(i) * 97), Math.round(pos.getY(i) * 89),
        Math.round(pos.getZ(i) * 83), seed);
      k = 1 + (hashFloat(h, 0) - 0.35) * amount;
      seen.set(key, k);
    }
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  base.computeVertexNormals();
  return base;
}

const CELL_M = 9;            // metres per scatter cell (approx)
const RANGE = 24;            // cells of radius around the camera
// instance caps sized ABOVE the densest possible biome in range — a kind
// that saturates its cap renders an anchor-dependent subset, which shows
// up as props sliding around while you walk
const CAPS = { grass: 10000, shrub: 2600, tree0: 1500, tree1: 1500, pod: 1200, default: 2000 };
export function capFor(kind) { return CAPS[kind] ?? CAPS.default; }
const SHOW_BELOW_ALT = 600;  // metres
const PREWARM_BELOW_ALT = 8000;
const STREAM_BUDGET_MS = 1.8;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _jd = new THREE.Vector3();
const _ce1 = new THREE.Vector3();
const _ce2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _ic = new THREE.Color();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// shared mineral geometries (unit-ish size, origin at base) — vegetation is
// per-planet (seeded species built by flora.js in setPlanet)
function baseGeo() {
  const shift = (g, y) => { g.translate(0, y, 0); return g; };
  return {
    rock: craggyGeo(new THREE.IcosahedronGeometry(0.7, 1), 0.75, 101),
    boulder: shift(craggyGeo(new THREE.IcosahedronGeometry(1.4, 1), 0.6, 202), 0.9),
    crystal: shift(new THREE.OctahedronGeometry(1, 0), 0.9),
    blob: shift(new THREE.SphereGeometry(0.9, 6, 5), 0.5),
    cactus: shift(new THREE.CylinderGeometry(0.28, 0.36, 2.4, 6), 1.2),
  };
}
let GEO = null;
const FLORA_KINDS = ['tree0', 'tree1', 'shrub', 'pod', 'grass'];

// per-biome prop recipes: [kind, density 0..1, minScale, maxScale]
const RECIPES = {
  grass:    [['grass', 0.78, 0.9, 1.7], ['shrub', 0.1, 0.7, 1.4], ['tree0', 0.05, 0.7, 1.2], ['pod', 0.02, 0.8, 1.4], ['rock', 0.03, 0.3, 0.9]],
  forest:   [['tree0', 0.4, 0.7, 1.3], ['tree1', 0.16, 0.6, 1.15], ['shrub', 0.15, 0.8, 1.5], ['grass', 0.22, 0.8, 1.5], ['rock', 0.03, 0.3, 0.8]],
  snow:     [['rock', 0.07, 0.3, 1.0], ['boulder', 0.02, 0.5, 1.2]],
  sand:     [['cactus', 0.05, 0.7, 1.5], ['shrub', 0.025, 0.5, 1.0], ['rock', 0.06, 0.3, 1.0]],
  rock:     [['rock', 0.18, 0.4, 1.3], ['boulder', 0.05, 0.6, 1.6]],
  regolith: [['rock', 0.16, 0.3, 1.4], ['boulder', 0.05, 0.5, 2.0]],
  ice:      [['crystal', 0.06, 0.6, 1.8], ['rock', 0.07, 0.3, 1.0]],
  ash:      [['rock', 0.12, 0.3, 1.2], ['boulder', 0.03, 0.5, 1.5]],
  ember:    [['rock', 0.06, 0.3, 1.0]],
  slime:    [['pod', 0.14, 1.0, 2.0], ['tree1', 0.05, 0.8, 1.6], ['blob', 0.14, 0.6, 2.0], ['grass', 0.2, 1.0, 1.8], ['crystal', 0.03, 0.5, 1.4]],
  weird:    [['tree1', 0.12, 0.9, 2.0], ['crystal', 0.11, 0.7, 2.6], ['pod', 0.08, 1.0, 2.0], ['blob', 0.06, 0.8, 2.2]],
  shore:    [['rock', 0.03, 0.2, 0.7], ['shrub', 0.02, 0.5, 1.0]],
  dryland:  [['grass', 0.3, 0.7, 1.3], ['shrub', 0.06, 0.6, 1.2], ['rock', 0.04, 0.3, 0.9]],
};

function propColors(planet) {
  const p = planet.pal;
  const base = {
    rock: p.rock.clone(),
    boulder: p.rock.clone().multiplyScalar(0.85),
    crystal: null,
    blob: (p.blotch || p.rock).clone(),
    cactus: new THREE.Color(0x55a04a).convertSRGBToLinear(),
  };
  switch (planet.type) {
    case 'toxic': base.crystal = (p.blotch || p.rock).clone().multiplyScalar(1.4); break;
    case 'ice': base.crystal = new THREE.Color(0x9fd0f0).convertSRGBToLinear(); break;
    case 'exotic': base.crystal = p.land[p.land.length - 1].c.clone().multiplyScalar(1.3); break;
  }
  if (!base.crystal) base.crystal = new THREE.Color(0xb0d8f0).convertSRGBToLinear();
  return base;
}

// self-light per flora kind (keeps vegetation readable in shadow; pods glow)
const FLORA_GLOW = { tree0: 0.16, tree1: 0.16, shrub: 0.14, pod: 0.55, grass: 0.09 };

export class Scatter {
  constructor({ streamBudgetMs = STREAM_BUDGET_MS } = {}) {
    if (!GEO) GEO = baseGeo();
    this.planet = null;
    this.flora = null;  // per-planet species geometries
    this.meshes = {};   // kind -> InstancedMesh
    this.staging = {};  // kind -> persistent CPU-side next-ring buffers
    this.job = null;
    this.streamBudgetMs = streamBudgetMs;
    this.lastKey = '';
    this.seen = new Set();
  }

  setPlanet(planet) {
    this.clear();
    this.planet = planet;
    if (!planet) return;
    const colors = propColors(planet);
    for (const kind of Object.keys(GEO)) {
      // a touch of self-light keeps the stylized props readable in shadow
      const glow = kind === 'crystal' ? 0.35
        : (kind === 'rock' || kind === 'boulder') ? 0.08 : 0.3;
      let mat = new THREE.MeshStandardMaterial({
        color: colors[kind], roughness: 0.95, flatShading: true,
        emissive: colors[kind].clone().multiplyScalar(glow),
      });
      mat = applyWindSway(mat, SWAY[kind] || 0);   // 0 sway still wires the grow scale
      this.addMesh(planet, kind, GEO[kind], mat);
    }
    // this world's own species: geometry seeded by the planet, colours baked
    // per-vertex (material stays white; instance colour adds per-plant drift).
    // The planet owns the geometries — the far tier shares them.
    this.flora = planet.flora || (planet.flora = buildFlora(planet));
    for (const kind of FLORA_KINDS) {
      let mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.9,
        // grass carries hand-authored up-normals (field-soft lighting) that
        // flat shading would discard
        flatShading: kind !== 'grass', side: THREE.DoubleSide,
      });
      mat.emissive.setScalar(FLORA_GLOW[kind]);
      mat = applyWindSway(mat, SWAY[kind] || 0);
      const im = this.addMesh(planet, kind, this.flora[kind], mat);
      if (kind === 'grass') im.castShadow = false;   // invisible; halves its cost
    }
    for (const kind in this.meshes) {
      const cap = capFor(kind);
      const im = this.meshes[kind];
      im.setColorAt(0, _ic.setRGB(1, 1, 1));
      this.staging[kind] = {
        matrix: new Float32Array(cap * 16),
        color: new Float32Array(cap * 3),
      };
    }
    this.lastKey = '';
  }

  addMesh(planet, kind, geo, mat) {
    const im = new THREE.InstancedMesh(geo, mat, capFor(kind));
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    planet.group.add(im);
    this.meshes[kind] = im;
    return im;
  }

  clear() {
    if (this.planet) {
      for (const kind in this.meshes) {
        const im = this.meshes[kind];
        this.planet.group.remove(im);
        im.material.dispose();
        im.dispose();
      }
    }
    this.flora = null;   // geometries are planet-owned (planet.dispose frees them)
    this.meshes = {};
    this.staging = {};
    this.job = null;
    this.planet = null;
    this.lastKey = '';
  }

  hideAll() {
    for (const kind in this.meshes) this.meshes[kind].count = 0;
  }

  // camLocal: camera in planet-local coords; alt: metres above terrain
  update(planet, camLocal, alt) {
    if (planet !== this.planet) this.setPlanet(alt < PREWARM_BELOW_ALT ? planet : null);
    if (!this.planet) return;
    // climbing away: props shrink to nothing across a 200 m band instead of
    // blinking out (all at once!) the moment an altitude line is crossed
    const g = Math.max(0, Math.min(1, (SHOW_BELOW_ALT - alt) / 200));
    GROW.value = g * g * (3 - 2 * g);
    for (const kind in this.meshes) this.meshes[kind].visible = g > 0.0001;
    if (alt > PREWARM_BELOW_ALT) { this.hideAll(); this.lastKey = ''; return; }

    const p = this.planet;
    _dir.copy(camLocal).normalize();
    const Q = p.R / CELL_M;                 // cell-id lattice radius
    const cellAng = CELL_M / p.R;

    // rebuild only when the camera crosses into a new planet-fixed cell
    const kx = Math.round(_dir.x * Q), ky = Math.round(_dir.y * Q), kz = Math.round(_dir.z * Q);
    const key = p.seed + ':' + kx + ':' + ky + ':' + kz;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.beginJob(p, kx, ky, kz, Q, cellAng);
    }
    if (!this.job) return;
    if (this.stepJob(performance.now() + this.streamBudgetMs)) {
      this.commitJob(this.job);
      this.job = null;
    }
  }

  beginJob(p, kx, ky, kz, Q, cellAng) {
    // The discovery lattice is anchored at the canonical center of the
    // camera's cell. A new target replaces only the unfinished staging job;
    // the last complete ring remains visible until this one commits.
    _anchor.set(kx, ky, kz).normalize();
    if (Math.abs(_anchor.y) < 0.93) _e1.set(-_anchor.z, 0, _anchor.x).normalize();
    else _e1.set(1, 0, 0).projectOnPlane(_anchor).normalize();
    _e2.crossVectors(_anchor, _e1);
    const counts = {};
    for (const kind in this.meshes) counts[kind] = 0;
    this.seen.clear();
    this.job = {
      p, Q, cellAng, seedI: p.intSeed ^ 0x5ca7,
      anchor: _anchor.clone(), e1: _e1.clone(), e2: _e2.clone(),
      counts, gx: -RANGE * 2, gy: -RANGE * 2,
    };
  }

  stepJob(deadline) {
    const job = this.job;
    const STEPS = RANGE * 2;
    _anchor.copy(job.anchor);
    while (job.gy <= STEPS) {
      const gx = job.gx, gy = job.gy;
      job.gx++;
      if (job.gx > STEPS) { job.gx = -STEPS; job.gy++; }
      if (gx * gx + gy * gy <= STEPS * STEPS) {
        _v.copy(job.anchor)
          .addScaledVector(job.e1, gx * 0.5 * job.cellAng)
          .addScaledVector(job.e2, gy * 0.5 * job.cellAng)
          .normalize();
        const fx = Math.floor(_v.x * job.Q), fy = Math.floor(_v.y * job.Q), fz = Math.floor(_v.z * job.Q);
        for (let corner = 0; corner < 8; corner++) {
          const qx = fx + (corner & 1), qy = fy + ((corner >> 1) & 1), qz = fz + (corner >> 2);
          const ck = (qx + 16384) + (qy + 16384) * 32768 + (qz + 16384) * 1073741824;
          if (this.seen.has(ck)) continue;
          this.seen.add(ck);
          if (Math.abs(Math.hypot(qx, qy, qz) - job.Q) > 0.7) continue;
          this.placeCell(job.p, qx, qy, qz, job.Q, job.cellAng, job.seedI, job.counts);
        }
      }
      if ((gx & 3) === 3 && performance.now() >= deadline) return false;
    }
    return true;
  }

  commitJob(job) {
    for (const kind in this.meshes) {
      const count = job.counts[kind];
      const mesh = this.meshes[kind];
      const stage = this.staging[kind];
      mesh.instanceMatrix.array.set(stage.matrix.subarray(0, count * 16), 0);
      mesh.instanceColor.array.set(stage.color.subarray(0, count * 3), 0);
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }

  // everything here depends ONLY on (planet seed, qx, qy, qz):
  // the same rock stands in the same spot forever
  placeCell(p, qx, qy, qz, Q, cellAng, seedI, counts) {
    _up.set(qx, qy, qz).normalize();          // canonical cell direction
    const h0 = hash3i(qx, qy, qz, seedI);

    // props near the range edge grow in instead of popping in
    const dot = Math.min(1, Math.max(-1, _up.dot(_anchor)));
    const cells = Math.acos(dot) / cellAng;
    let edge = Math.min(1, Math.max(0, ((RANGE - 1) - cells) / 5));
    if (edge < 0.03) return;
    edge = edge * edge * (3 - 2 * edge);

    const hgt = p.height(_up, p.fullMaxFreq);
    const recipe = RECIPES[p.biomeAt(_up, hgt)];
    if (!recipe) return;

    const sel = hashFloat(h0, 0);
    let acc = 0, chosen = null;
    for (const r of recipe) { acc += r[1]; if (sel < acc) { chosen = r; break; } }
    if (!chosen) return;
    const [kind, , s0, s1] = chosen;
    const im = this.meshes[kind];
    if (!im || counts[kind] >= capFor(kind)) return;

    // cell-local tangent frame, derived from the canonical direction
    if (Math.abs(_up.y) < 0.93) _ce1.set(-_up.z, 0, _up.x).normalize();
    else _ce1.set(1, 0, 0).projectOnPlane(_up).normalize();
    _ce2.crossVectors(_up, _ce1);

    // grass grows in little clumps; everything else stands alone
    const copies = kind === 'grass' ? 4 : 1;
    for (let c = 0; c < copies && counts[kind] < capFor(kind); c++) {
      const hc = c === 0 ? h0 : hash3i(qx + c * 131, qy - c * 57, qz + c * 263, seedI);
      // jitter inside the cell, then re-sample ground height there
      _jd.copy(_up)
        .addScaledVector(_ce1, (hashFloat(hc, 1) - 0.5) * cellAng)
        .addScaledVector(_ce2, (hashFloat(hc, 2) - 0.5) * cellAng)
        .normalize();
      const hh = p.height(_jd, p.fullMaxFreq);
      if (p.hasLiquid && hh < p.seaLevel + 0.4) continue;   // not in the sea

      _v2.copy(_jd).multiplyScalar(p.R + hh);
      _q.setFromUnitVectors(Y, _jd);
      _q2.setFromAxisAngle(Y, hashFloat(hc, 1) * Math.PI * 2);
      _q.multiply(_q2);
      const sc = (s0 + (s1 - s0) * hashFloat(hc, 2)) * edge;
      _s.set(sc, sc * (0.8 + hashFloat(hc, 0) * 0.5), sc);
      _m.compose(_v2, _q, _s);
      if (kind === 'grass') {
        // tufts blend the ground colour with the planet's canopy tint: they
        // still belong to the terrain, but read as living growth on any soil
        p.colorAt(_jd, hh, 0.08, 64, _ic);
        _ic.lerp(this.flora.grassTint, 0.5).multiplyScalar(1.35).offsetHSL(
          (hashFloat(hc, 0) - 0.5) * 0.05, 0.06, (hashFloat(hc, 1) - 0.5) * 0.12);
      } else {
        // no two plants quite the same colour
        _ic.setRGB(1, 1, 1).offsetHSL(
          (hashFloat(hc, 0) - 0.5) * 0.05, 0, (hashFloat(hc, 1) - 0.5) * 0.16);
      }
      const index = counts[kind]++;
      const stage = this.staging[kind];
      stage.matrix.set(_m.elements, index * 16);
      stage.color[index * 3] = _ic.r;
      stage.color[index * 3 + 1] = _ic.g;
      stage.color[index * 3 + 2] = _ic.b;
    }
  }
}
