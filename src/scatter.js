// Surface props: alien flora (seeded per-planet species from flora.js) plus
// rocks and crystals, scattered around the camera when near the ground.
// Placement is a pure function of (planet seed, surface cell) — walk away
// and come back, the same tree is waiting.

import * as THREE from 'three';
import { hash3i, hashFloat } from './rng.js';
import { applyWindSway, GROW } from './shaders.js';
import { buildFlora } from './flora.js';
import { VegetationFrame } from './vegetation-frame.js';

// Smooth value noise over planet-local metres (a pure function of position,
// independent of the planet's terrain fields) for meadow patchiness.
function smoothHash(ix, iy, iz) { return hashFloat(hash3i(ix, iy, iz, 0x6d2b), 0); }
function meadowNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(smoothHash(ix, iy, iz), smoothHash(ix + 1, iy, iz), ux),
      lerp(smoothHash(ix, iy + 1, iz), smoothHash(ix + 1, iy + 1, iz), ux), uy),
    lerp(lerp(smoothHash(ix, iy, iz + 1), smoothHash(ix + 1, iy, iz + 1), ux),
      lerp(smoothHash(ix, iy + 1, iz + 1), smoothHash(ix + 1, iy + 1, iz + 1), ux), uy), uz);
}
const _straw = new THREE.Color(0.42, 0.34, 0.13);

// WebGL 2 baseline: the instance-architecture Stage C rewrite targeted the
// shelved WebGPU/TSL line. The classic InstancedMesh deck is authoritative.
export const SCATTER_ENABLED = true;

// wind strength per prop kind (0 = rigid)
const SWAY = {
  grass: 0.08, grassNear: 0.09, grassMid: 0.075, grassFar: 0.055,
  shrub: 0.05, pod: 0.03, tree0: 0.012, tree1: 0.012, blob: 0.02, cactus: 0.008,
};

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
const DEFAULT_RANGE = 5;     // overridden by the central quality profile
// instance caps sized ABOVE the densest possible biome in range — a kind
// that saturates its cap renders an anchor-dependent subset, which shows
// up as props sliding around while you walk
const CAPS = {
  grassNear: 14000, grassMid: 30000, grassFar: 60000,
  shrub: 900, pod: 1200, default: 2000,
};
export function capFor(kind) { return CAPS[kind] ?? CAPS.default; }
const SHOW_BELOW_ALT = 600;  // metres
// Planted cells are cached (placement is a pure function of the cell), so a
// ring that moves by one cell only computes its new leading edge. The old
// stream recomputed ~100k tufts per ring and threw the unfinished ring away
// at every 9 m step: while the player kept moving no ring ever finished and
// the grass stayed where it was first planted.
const CELL_CACHE_LIMIT = 700;
// Grass tufts per cell shrink with camera height: from 40 m up a meadow
// reads at a third of the density, and that is what keeps the ring up with a
// low-flying ship. Quantised so the ring is only rebuilt at a few heights.
function grassShareForAltitude(alt) {
  return alt < 12 ? 1 : alt < 40 ? 0.6 : 0.3;
}
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
const _offset = new THREE.Vector3();
const _plantRot = new Float32Array(9);
const _plantPos = new Float64Array(3);
let _plantHeight = 0;

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
// Trees are not scattered here: the tree field (farflora.js) plants and
// draws every tree at every distance, so there is no near bubble to fall out of.
const FLORA_KINDS = ['shrub', 'pod'];
const GRASS_LODS = [
  ['grassNear', 'grass', 0, 8],
  ['grassMid', 'grassMid', 8, 24],
  ['grassFar', 'grassFar', 24, Infinity],
];

// per-biome prop recipes: [kind, density 0..1, minScale, maxScale]
const RECIPES = {
  grass:    [['grass', 0.78, 0.9, 1.7], ['shrub', 0.06, 0.45, 1.0], ['pod', 0.02, 0.8, 1.4], ['rock', 0.03, 0.3, 0.9]],
  forest:   [['shrub', 0.22, 0.5, 1.15], ['grass', 0.22, 0.8, 1.5], ['rock', 0.03, 0.3, 0.8]],
  snow:     [['rock', 0.07, 0.3, 1.0], ['boulder', 0.02, 0.5, 1.2]],
  sand:     [['cactus', 0.05, 0.7, 1.5], ['shrub', 0.025, 0.35, 0.7], ['rock', 0.06, 0.3, 1.0]],
  rock:     [['rock', 0.18, 0.4, 1.3], ['boulder', 0.05, 0.6, 1.6]],
  regolith: [['rock', 0.16, 0.3, 1.4], ['boulder', 0.05, 0.5, 2.0]],
  ice:      [['crystal', 0.06, 0.6, 1.8], ['rock', 0.07, 0.3, 1.0]],
  ash:      [['rock', 0.12, 0.3, 1.2], ['boulder', 0.03, 0.5, 1.5]],
  ember:    [['rock', 0.06, 0.3, 1.0]],
  slime:    [['pod', 0.14, 1.0, 2.0], ['blob', 0.14, 0.6, 2.0], ['grass', 0.2, 1.0, 1.8], ['crystal', 0.03, 0.5, 1.4]],
  weird:    [['crystal', 0.11, 0.7, 2.6], ['pod', 0.08, 1.0, 2.0], ['blob', 0.06, 0.8, 2.2]],
  shore:    [['rock', 0.03, 0.2, 0.7], ['shrub', 0.02, 0.35, 0.7]],
  dryland:  [['grass', 0.3, 0.7, 1.3], ['shrub', 0.06, 0.4, 0.85], ['rock', 0.04, 0.3, 0.9]],
};

const MEADOW_DENSITY = {
  // A nine-metre cell carries stable tuft candidates.  One tuft contains
  // several blades, so lush terrain lands around 30-40 visible blades/m2 at
  // ultra instead of the previous sparse ~10 blades/m2.
  grass: 360, forest: 250, dryland: 150, slime: 135, weird: 90,
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
const FLORA_GLOW = { tree0: 0.08, tree1: 0.08, shrub: 0.06, pod: 0.55, grass: 0.012 };

export class Scatter {
  constructor({ streamBudgetMs = STREAM_BUDGET_MS, grassRadius = 45, grassDensity = 0.82 } = {}) {
    if (!GEO) GEO = baseGeo();
    this.planet = null;
    this.flora = null;  // per-planet species geometries
    this.meshes = {};   // kind -> InstancedMesh
    this.staging = {};  // kind -> persistent CPU-side next-ring buffers
    this.job = null;
    this.streamBudgetMs = streamBudgetMs;
    this.range = Math.max(4, Math.ceil(grassRadius / CELL_M));
    this.grassDensity = Math.max(0.35, Math.min(1, grassDensity));
    this.lastKey = '';
    this.seen = new Set();
    this.frame = new VegetationFrame();
    this.cellCache = new Map();
    this.wantJob = null;
    this.grassShare = 1;
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
      mat = applyWindSway(mat, SWAY[kind] || 0, false, this.frame);
      this.addMesh(planet, kind, GEO[kind], mat);
    }
    // this world's own species: geometry seeded by the planet, colours baked
    // per-vertex (material stays white; instance colour adds per-plant drift).
    // The planet owns the geometries — the far tier shares them.
    this.flora = planet.flora || (planet.flora = buildFlora(planet));
    for (const kind of FLORA_KINDS) {
      // shrubs share the tree atlas (bark + alpha-tested foliage cards); pods
      // keep their flat-shaded alien look until they are redone
      const textured = kind === 'shrub';
      let mat = new THREE.MeshStandardMaterial(textured ? {
        color: 0xffffff, vertexColors: true, roughness: 0.88, side: THREE.DoubleSide,
        map: this.flora.trees.atlas, alphaTest: 0.42,
      } : {
        color: 0xffffff, vertexColors: true, roughness: 0.9,
        flatShading: true, side: THREE.DoubleSide,
      });
      // the same stand-in for transmitted light the tree field uses
      if (textured) mat.emissive.copy(this.flora.trees.shrub.leafColor).multiplyScalar(0.16);
      else mat.emissive.setScalar(FLORA_GLOW[kind]);
      // textured foliage keeps its crown normals on back faces (see farflora.js)
      mat = applyWindSway(mat, SWAY[kind] || 0, textured, this.frame);
      const im = this.addMesh(planet, kind, this.flora[kind], mat);
      if (textured) {
        im.customDepthMaterial.map = this.flora.trees.atlas;
        im.customDepthMaterial.alphaTest = 0.42;
      }
    }
    for (const [kind, geometryKey] of GRASS_LODS) {
      let mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.94,
        flatShading: false, side: THREE.DoubleSide,
      });
      mat.emissive.copy(this.flora.grassTint).multiplyScalar(FLORA_GLOW.grass);
      // Grass is a paper-thin blade but both sides represent the same upward
      // leaf surface.  Tell both renderer paths not to invert its lighting
      // normal on back faces.
      mat = applyWindSway(mat, SWAY[kind], true, this.frame);
      const im = this.addMesh(planet, kind, this.flora[geometryKey], mat);
      im.castShadow = false;
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
    im.name = 'scatter:' + kind;
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Shadow casters must use the same grow/wind/pressure deformation as the
    // visible mesh. Native shadow materials do not inherit onBeforeCompile.
    im.customDepthMaterial = applyWindSway(new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    }), SWAY[kind] || 0, kind.startsWith('grass'), this.frame);
    im.customDistanceMaterial = applyWindSway(new THREE.MeshDistanceMaterial(),
      SWAY[kind] || 0, kind.startsWith('grass'), this.frame);
    // Interaction injection runs after streaming in the main loop. Sync at
    // both draw entry points; revision caching copies only on real changes.
    const syncInteractions = () => this.frame.syncInteractions(planet.bodyId || planet.seed);
    im.onBeforeRender = syncInteractions;
    im.onBeforeShadow = syncInteractions;
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
        im.customDepthMaterial.dispose();
        im.customDistanceMaterial.dispose();
        im.dispose();
      }
    }
    this.flora = null;   // geometries are planet-owned (planet.dispose frees them)
    this.meshes = {};
    this.staging = {};
    this.job = null;
    this.wantJob = null;
    this.cellCache.clear();
    this.planet = null;
    this.lastKey = '';
    this.frame.setOrigin(_v.set(0, 0, 0));
  }

  hideAll() {
    for (const kind in this.meshes) this.meshes[kind].count = 0;
  }

  // camLocal: camera in planet-local coords; alt: metres above terrain
  update(planet, camLocal, alt, budgetMs=this.streamBudgetMs) {
    if (planet !== this.planet) this.setPlanet(alt < PREWARM_BELOW_ALT ? planet : null);
    if (!this.planet) return;
    // climbing away: props shrink to nothing across a 200 m band instead of
    // blinking out (all at once!) the moment an altitude line is crossed
    const g = Math.max(0, Math.min(1, (SHOW_BELOW_ALT - alt) / 200));
    GROW.value = g * g * (3 - 2 * g);
    for (const kind in this.meshes) this.meshes[kind].visible = g > 0.0001;
    if (alt > PREWARM_BELOW_ALT) { this.hideAll(); this.lastKey = ''; return; }

    const p = this.planet;
    this.frame.syncInteractions(p.bodyId || p.seed);
    _dir.copy(camLocal).normalize();
    const Q = p.R / CELL_M;                 // cell-id lattice radius
    const cellAng = CELL_M / p.R;

    // rebuild only when the camera crosses into a new planet-fixed cell (or
    // changes height band)
    const kx = Math.round(_dir.x * Q), ky = Math.round(_dir.y * Q), kz = Math.round(_dir.z * Q);
    const share = grassShareForAltitude(alt);
    const key = p.seed + ':' + kx + ':' + ky + ':' + kz + ':' + share;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.wantJob = [kx, ky, kz, share];
    }
    // An unfinished ring is never thrown away: it finishes (cheaply, from the
    // cache) and the newest target starts right after it.
    if (!this.job && this.wantJob) {
      const [wx, wy, wz, wantShare] = this.wantJob;
      this.wantJob = null;
      this.grassShare = wantShare;
      this.beginJob(p, wx, wy, wz, Q, cellAng);
    }
    if (!this.job) return;
    if (budgetMs<=0)return;
    if (this.stepJob(performance.now() + budgetMs)) {
      this.commitJob(this.job);
      this.pruneCellCache(this.job);
      this.job = null;
    }
  }

  pruneCellCache(job) {
    if (this.cellCache.size <= CELL_CACHE_LIMIT) return;
    const keep = new Set(job.needed);
    for (const key of this.cellCache.keys()) {
      if (this.cellCache.size <= CELL_CACHE_LIMIT * 0.8) break;
      if (!keep.has(key)) this.cellCache.delete(key);
    }
  }

  setGrassDensity(density) {
    const next = Math.max(0.35, Math.min(1, density));
    if (Math.abs(next - this.grassDensity) < 0.025) return;
    this.grassDensity = next;
    // cached cells size their tuft lists for the old density
    this.cellCache.clear();
    this.lastKey = '';
  }

  debugStats() {
    const counts = {};
    let signature = 2166136261 >>> 0;
    const view = new DataView(new ArrayBuffer(4));
    for (const [name, mesh] of Object.entries(this.meshes)) {
      if (!name.startsWith('grass')) continue;
      counts[name] = mesh.count;
      signature = Math.imul(signature ^ mesh.count, 16777619) >>> 0;
      const values = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count * 16; i++) {
        view.setFloat32(0, values[i], true);
        signature = Math.imul(signature ^ view.getUint32(0, true), 16777619) >>> 0;
      }
    }
    return { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0), signature,
      origin: this.frame.origin.toArray(), pending: Boolean(this.job || this.wantJob),
      cachedCells: this.cellCache.size };
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
      origin: _anchor.clone().multiplyScalar(p.R + p.height(_anchor, p.fullMaxFreq)),
      counts, range: this.range,
      cells: [], cellIndex: 0, needed: [],
      grassShare: this.grassShare,
      initial: Object.values(this.meshes).every((mesh) => mesh.count === 0),
      lastPreviewAt: performance.now(),
    };
    const steps = this.range * 2;
    for (let gy = -steps; gy <= steps; gy++) {
      for (let gx = -steps; gx <= steps; gx++) {
        if (gx * gx + gy * gy <= steps * steps) this.job.cells.push([gx, gy]);
      }
    }
    // The first visible vegetation must appear around the player, not after a
    // raster scan has spent seconds filling the far rim. This order is stable
    // and is reused for every visit to the same field.
    this.job.cells.sort((a, b) => (a[0] * a[0] + a[1] * a[1])
      - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
    this.job.work = this.buildJob(this.job);
  }

  stepJob(deadline) {
    const job = this.job;
    // A tuft candidate (including rejection) is the atomic work unit. A
    // whole meadow cell can contain hundreds of expensive terrain queries.
    // Keep its cursor across frames rather than checking after four cells.
    let units = 0;
    while (!job.work.next().done) {
      // Amortize clock reads over at most eight candidates/discovery steps,
      // never over an entire cell. Infinity is useful for controlled builds.
      if (deadline === Infinity || (++units & 7) !== 0) continue;
      const now = performance.now();
      if (now < deadline) continue;
      if (job.initial && now - job.lastPreviewAt > 90) {
        this.commitJob(job);
        job.lastPreviewAt = now;
      }
      return false;
    }
    return true;
  }

  *buildJob(job) {
    while (job.cellIndex < job.cells.length) {
      const [gx, gy] = job.cells[job.cellIndex++];
      _v.copy(job.anchor)
        .addScaledVector(job.e1, gx * 0.5 * job.cellAng)
        .addScaledVector(job.e2, gy * 0.5 * job.cellAng)
        .normalize();
      const fx = Math.floor(_v.x * job.Q), fy = Math.floor(_v.y * job.Q), fz = Math.floor(_v.z * job.Q);
      for (let corner = 0; corner < 8; corner++) {
        const qx = fx + (corner & 1), qy = fy + ((corner >> 1) & 1), qz = fz + (corner >> 2);
        const ck = `${qx}:${qy}:${qz}`;
        if (this.seen.has(ck)) continue;
        this.seen.add(ck);
        if (Math.abs(Math.hypot(qx, qy, qz) - job.Q) <= 0.7) {
          yield* this.placeCell(job, ck, qx, qy, qz);
        }
        yield;
      }
      yield;
    }
  }

  // Ensure the cell is planted (cached), then copy it into this ring.
  *placeCell(job, ck, qx, qy, qz) {
    // props near the range edge grow in instead of popping in
    _up.set(qx, qy, qz).normalize();
    const dot = Math.min(1, Math.max(-1, _up.dot(job.anchor)));
    const cells = Math.acos(dot) / job.cellAng;
    let edge = Math.min(1, Math.max(0, ((this.range - 1) - cells) / Math.max(2, this.range * 0.3)));
    if (edge < 0.03) return;
    edge = edge * edge * (3 - 2 * edge);

    let cell = this.cellCache.get(ck);
    if (!cell) {
      cell = this.createCell(job, qx, qy, qz);
      this.cellCache.set(ck, cell);
    }
    if (!cell.recipe) return;
    job.needed.push(ck);
    const wantGrass = Math.round((MEADOW_DENSITY[cell.biome] || 0) * this.grassDensity * job.grassShare);
    yield* this.fillGrass(job, cell, qx, qy, qz, wantGrass);
    this.assembleCell(job, cell, edge, wantGrass);
  }

  createCell(job, qx, qy, qz) {
    const p = job.p;
    const up = new THREE.Vector3(qx, qy, qz).normalize();   // canonical cell direction
    const hgt = p.height(up, p.fullMaxFreq);
    const biome = p.biomeAt(up, hgt);
    const recipe = RECIPES[biome] || null;
    const cell = { up, biome, recipe, origin: up.clone().multiplyScalar(p.R + hgt), grass: null, props: [] };
    if (!recipe) return cell;
    // cell-local tangent frame, derived from the canonical direction
    cell.e1 = new THREE.Vector3();
    if (Math.abs(up.y) < 0.93) cell.e1.set(-up.z, 0, up.x).normalize();
    else cell.e1.set(1, 0, 0).projectOnPlane(up).normalize();
    cell.e2 = new THREE.Vector3().crossVectors(up, cell.e1);
    const meadowMax = Math.round((MEADOW_DENSITY[biome] || 0) * this.grassDensity);
    if (meadowMax > 0) {
      cell.grass = {
        cursor: 0, count: 0,
        attempt: new Uint16Array(meadowMax), rot: new Float32Array(meadowMax * 9),
        pos: new Float32Array(meadowMax * 3), color: new Float32Array(meadowMax * 3),
        noise: new Float32Array(meadowMax),
      };
    }
    // Trees and rocks may stand in a meadow without deleting a nine-metre
    // square of grass around themselves: one structural roll per cell.
    const seedI = job.seedI;
    const h0 = hash3i(qx, qy, qz, seedI);
    const structural = recipe.filter(([kind]) => kind !== 'grass');
    const structuralWeight = structural.reduce((sum, item) => sum + item[1], 0);
    const sel = hashFloat(h0, 5);
    if (sel < structuralWeight) {
      let acc = 0, chosen = null;
      for (const r of structural) { acc += r[1]; if (sel < acc) { chosen = r; break; } }
      if (chosen && this.meshes[chosen[0]]) {
        const [kind, , s0, s1] = chosen;
        const hc = hash3i(qx, qy, qz, seedI ^ 0x71a3);
        if (this.plant(job, cell, hc, s0, s1)) {
          // no two plants quite the same colour
          _ic.setRGB(1, 1, 1).offsetHSL(
            (hashFloat(hc, 0) - 0.5) * 0.05, 0, (hashFloat(hc, 1) - 0.5) * 0.16);
          cell.props.push({ kind, rot: _plantRot.slice(), pos: _plantPos.slice(), color: [_ic.r, _ic.g, _ic.b] });
        }
      }
    }
    return cell;
  }

  // One plant: jitter inside the cell, ground it at full terrain detail.
  // Leaves its rotation-scale in _plantRot and its offset from the cell
  // origin in _plantPos. Returns false when the spot is under water.
  plant(job, cell, hc, s0, s1) {
    const p = job.p;
    _jd.copy(cell.up)
      .addScaledVector(cell.e1, (hashFloat(hc, 1) - 0.5) * job.cellAng)
      .addScaledVector(cell.e2, (hashFloat(hc, 2) - 0.5) * job.cellAng)
      .normalize();
    const hh = p.height(_jd, p.fullMaxFreq);
    if (p.hasLiquid && hh < p.seaLevel + 0.4) return false;   // not in the sea
    _plantHeight = hh;
    _v2.copy(_jd).multiplyScalar(p.R + hh).sub(cell.origin);
    _q.setFromUnitVectors(Y, _jd);
    _q2.setFromAxisAngle(Y, hashFloat(hc, 1) * Math.PI * 2);
    _q.multiply(_q2);
    const sc = s0 + (s1 - s0) * hashFloat(hc, 2);
    _s.set(sc, sc * (0.8 + hashFloat(hc, 0) * 0.5), sc);
    _m.compose(_v.set(0, 0, 0), _q, _s);
    const e = _m.elements;
    _plantRot[0] = e[0]; _plantRot[1] = e[1]; _plantRot[2] = e[2];
    _plantRot[3] = e[4]; _plantRot[4] = e[5]; _plantRot[5] = e[6];
    _plantRot[6] = e[8]; _plantRot[7] = e[9]; _plantRot[8] = e[10];
    _plantPos[0] = _v2.x; _plantPos[1] = _v2.y; _plantPos[2] = _v2.z;
    return true;
  }

  // Grass is planted as a prefix: tuft c is a pure function of (cell, c), so
  // a sparser ring is the first tufts of a denser one.
  *fillGrass(job, cell, qx, qy, qz, want) {
    const grass = cell.grass;
    if (!grass) return;
    const target = Math.min(want, grass.attempt.length);
    const h0 = hash3i(qx, qy, qz, job.seedI);
    while (grass.cursor < target) {
      // Yield before the next candidate; the previous one is fully cached.
      yield;
      const c = grass.cursor++;
      const hc = c === 0 ? h0 : hash3i(qx + c * 131, qy - c * 57, qz + c * 263, job.seedI);
      if (!this.plant(job, cell, hc, 0.52, 0.96)) continue;
      const i = grass.count++;
      grass.attempt[i] = c;
      grass.rot.set(_plantRot, i * 9);
      grass.pos.set(_plantPos, i * 3);
      // A small hash offset dissolves the circular LOD boundary into the
      // meadow. The same blade always chooses the same side of the blend.
      grass.noise[i] = (hashFloat(hc, 3) - 0.5) * 3.2;
      // tufts blend the ground colour with the planet's canopy tint: they
      // still belong to the terrain, but read as living growth on any soil
      job.p.colorAt(_jd, _plantHeight, 0.08, 64, _ic);
      _ic.lerp(this.flora.grassTint, 0.72);
      // Patches a few metres across dry toward straw or stay lush; the
      // whole meadow sits darker than the bare-ground palette it grows from.
      const wx = _jd.x * job.p.R, wy = _jd.y * job.p.R, wz = _jd.z * job.p.R;
      const patch = meadowNoise(wx / 7.5, wy / 7.5, wz / 7.5) * 0.65
        + meadowNoise(wx / 2.2 + 17, wy / 2.2, wz / 2.2) * 0.35;
      const dryness = Math.min(1, Math.max(0, (patch - 0.52) * 3.2));
      _ic.lerp(_straw, dryness * 0.55).multiplyScalar(0.58 + (1 - patch) * 0.22).offsetHSL(
        (hashFloat(hc, 0) - 0.5) * 0.05, 0.12, (hashFloat(hc, 1) - 0.5) * 0.08);
      grass.color[i * 3] = _ic.r; grass.color[i * 3 + 1] = _ic.g; grass.color[i * 3 + 2] = _ic.b;
    }
  }

  assembleCell(job, cell, edge, wantGrass) {
    _offset.copy(cell.origin).sub(job.origin);
    for (const prop of cell.props) {
      this.stage(job, prop.kind, prop.rot, 0, prop.pos, 0, prop.color, 0, edge);
    }
    const grass = cell.grass;
    if (!grass) return;
    for (let i = 0; i < grass.count; i++) {
      if (grass.attempt[i] >= wantGrass) break;
      const px = grass.pos[i * 3] + _offset.x, py = grass.pos[i * 3 + 1] + _offset.y, pz = grass.pos[i * 3 + 2] + _offset.z;
      const noisyDistance = Math.sqrt(px * px + py * py + pz * pz) + grass.noise[i];
      const drawKind = noisyDistance < 8 ? 'grassNear' : noisyDistance < 24 ? 'grassMid' : 'grassFar';
      this.stage(job, drawKind, grass.rot, i * 9, grass.pos, i * 3, grass.color, i * 3, edge);
    }
  }

  stage(job, kind, rot, ro, pos, po, color, co, edge) {
    if (!this.meshes[kind] || job.counts[kind] >= capFor(kind)) return;
    const index = job.counts[kind]++;
    const stage = this.staging[kind];
    const m = stage.matrix, at = index * 16;
    m[at] = rot[ro] * edge; m[at + 1] = rot[ro + 1] * edge; m[at + 2] = rot[ro + 2] * edge; m[at + 3] = 0;
    m[at + 4] = rot[ro + 3] * edge; m[at + 5] = rot[ro + 4] * edge; m[at + 6] = rot[ro + 5] * edge; m[at + 7] = 0;
    m[at + 8] = rot[ro + 6] * edge; m[at + 9] = rot[ro + 7] * edge; m[at + 10] = rot[ro + 8] * edge; m[at + 11] = 0;
    m[at + 12] = pos[po] + _offset.x; m[at + 13] = pos[po + 1] + _offset.y; m[at + 14] = pos[po + 2] + _offset.z;
    m[at + 15] = 1;
    stage.color[index * 3] = color[co];
    stage.color[index * 3 + 1] = color[co + 1];
    stage.color[index * 3 + 2] = color[co + 2];
  }

  commitJob(job) {
    this.frame.setOrigin(job.origin);
    this.frame.syncInteractions(job.p.bodyId || job.p.seed);
    for (const kind in this.meshes) {
      const count = job.counts[kind];
      const mesh = this.meshes[kind];
      mesh.position.copy(job.origin);
      const stage = this.staging[kind];
      mesh.instanceMatrix.array.set(stage.matrix.subarray(0, count * 16), 0);
      mesh.instanceColor.array.set(stage.color.subarray(0, count * 3), 0);
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }
}
