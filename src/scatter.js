// Surface props: low-poly trees, rocks, crystals, grass scattered around the
// camera when near the ground. Placement is a pure function of (planet seed,
// surface cell) — walk away and come back, the same rock is waiting.

import * as THREE from 'three';
import { hash3i, hashFloat } from './rng.js';

const CELL_M = 9;            // metres per scatter cell (approx)
const RANGE = 24;            // cells of radius around the camera
const MAX_PER_KIND = 1400;
const SHOW_BELOW_ALT = 600;  // metres

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
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// shared geometries (unit-ish size, origin at base)
function baseGeo() {
  const shift = (g, y) => { g.translate(0, y, 0); return g; };
  return {
    rock: new THREE.IcosahedronGeometry(0.7, 0),
    boulder: shift(new THREE.DodecahedronGeometry(1.4, 0), 0.6),
    tree: shift(new THREE.ConeGeometry(1.0, 4.4, 6), 2.1),
    trunkTree: shift(new THREE.ConeGeometry(1.35, 6.2, 7), 2.9),
    crystal: shift(new THREE.OctahedronGeometry(1, 0), 0.9),
    grass: shift(new THREE.ConeGeometry(0.07, 0.65, 4), 0.3),
    blob: shift(new THREE.SphereGeometry(0.9, 6, 5), 0.5),
    cactus: shift(new THREE.CylinderGeometry(0.28, 0.36, 2.4, 6), 1.2),
  };
}
let GEO = null;

// per-biome prop recipes: [kind, density 0..1, minScale, maxScale, tumble?]
const RECIPES = {
  grass:    [['grass', 0.85, 0.8, 1.6], ['tree', 0.05, 0.6, 1.1], ['rock', 0.05, 0.3, 0.9]],
  forest:   [['trunkTree', 0.5, 0.7, 1.15], ['tree', 0.3, 0.5, 1.0], ['rock', 0.04, 0.3, 0.8], ['grass', 0.3, 0.8, 1.4]],
  snow:     [['rock', 0.07, 0.3, 1.0], ['boulder', 0.02, 0.5, 1.2]],
  sand:     [['cactus', 0.05, 0.7, 1.5], ['rock', 0.06, 0.3, 1.0]],
  rock:     [['rock', 0.18, 0.4, 1.3], ['boulder', 0.05, 0.6, 1.6]],
  regolith: [['rock', 0.16, 0.3, 1.4], ['boulder', 0.05, 0.5, 2.0]],
  ice:      [['crystal', 0.06, 0.6, 1.8], ['rock', 0.07, 0.3, 1.0]],
  ash:      [['rock', 0.12, 0.3, 1.2], ['boulder', 0.03, 0.5, 1.5]],
  ember:    [['rock', 0.06, 0.3, 1.0]],
  slime:    [['blob', 0.2, 0.6, 2.0], ['crystal', 0.05, 0.5, 1.4], ['grass', 0.25, 1.0, 1.8]],
  weird:    [['crystal', 0.14, 0.7, 2.6], ['blob', 0.1, 0.8, 2.2]],
  shore:    [['rock', 0.03, 0.2, 0.7]],
};

function propColors(planet) {
  const p = planet.pal;
  const base = {
    rock: p.rock.clone(),
    boulder: p.rock.clone().multiplyScalar(0.85),
    tree: (p.forest || p.rock).clone().multiplyScalar(2.1),
    trunkTree: (p.forest || p.rock).clone().multiplyScalar(1.6),
    crystal: null,
    grass: null,
    blob: (p.blotch || p.rock).clone(),
    cactus: new THREE.Color(0x3f7a33).convertSRGBToLinear(),
  };
  switch (planet.type) {
    case 'lush': base.grass = p.land[2].c.clone().multiplyScalar(1.5); break;
    case 'ocean': base.grass = p.land[2].c.clone().multiplyScalar(1.3); break;
    case 'toxic': base.grass = p.land[1].c.clone().multiplyScalar(1.2); base.crystal = (p.blotch || p.rock).clone().multiplyScalar(1.4); break;
    case 'ice': base.crystal = new THREE.Color(0x9fd0f0).convertSRGBToLinear(); break;
    case 'exotic': base.crystal = p.land[p.land.length - 1].c.clone().multiplyScalar(1.3); break;
  }
  if (!base.grass) base.grass = new THREE.Color(0x6a8a40).convertSRGBToLinear();
  if (!base.crystal) base.crystal = new THREE.Color(0xb0d8f0).convertSRGBToLinear();
  return base;
}

export class Scatter {
  constructor() {
    if (!GEO) GEO = baseGeo();
    this.planet = null;
    this.meshes = {};   // kind -> InstancedMesh
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
      const glow = kind === 'crystal' ? 0.35 : (kind === 'rock' || kind === 'boulder') ? 0.08 : 0.3;
      const mat = new THREE.MeshStandardMaterial({
        color: colors[kind], roughness: 0.95, flatShading: true,
        emissive: colors[kind].clone().multiplyScalar(glow),
      });
      const im = new THREE.InstancedMesh(GEO[kind], mat, MAX_PER_KIND);
      im.count = 0;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      planet.group.add(im);
      this.meshes[kind] = im;
    }
    this.lastKey = '';
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
    this.meshes = {};
    this.planet = null;
    this.lastKey = '';
  }

  hideAll() {
    for (const kind in this.meshes) this.meshes[kind].count = 0;
  }

  // camLocal: camera in planet-local coords; alt: metres above terrain
  update(planet, camLocal, alt) {
    if (planet !== this.planet) this.setPlanet(alt < SHOW_BELOW_ALT ? planet : null);
    if (!this.planet) return;
    if (alt > SHOW_BELOW_ALT) { this.hideAll(); this.lastKey = ''; return; }

    const p = this.planet;
    _dir.copy(camLocal).normalize();
    const Q = p.R / CELL_M;                 // cell-id lattice radius
    const cellAng = CELL_M / p.R;

    // rebuild only when the camera crosses into a new planet-fixed cell
    const kx = Math.round(_dir.x * Q), ky = Math.round(_dir.y * Q), kz = Math.round(_dir.z * Q);
    const key = p.seed + ':' + kx + ':' + ky + ':' + kz;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // discovery lattice anchored at the CANONICAL center of the camera's own
    // cell — planet-fixed, so the grid of sample points never swims
    _anchor.set(kx, ky, kz).normalize();
    if (Math.abs(_anchor.y) < 0.93) _e1.set(-_anchor.z, 0, _anchor.x).normalize();
    else _e1.set(1, 0, 0).projectOnPlane(_anchor).normalize();
    _e2.crossVectors(_anchor, _e1);

    const counts = {};
    for (const kind in this.meshes) counts[kind] = 0;
    const seedI = p.intSeed ^ 0x5ca7;
    this.seen.clear();

    // half-step oversampling, and every sample claims all 8 lattice corners
    // of its cube — so which cells get found cannot depend on how the
    // discovery grid happens to align with the planet lattice
    const STEPS = RANGE * 2;
    for (let gy = -STEPS; gy <= STEPS; gy++) {
      for (let gx = -STEPS; gx <= STEPS; gx++) {
        if (gx * gx + gy * gy > STEPS * STEPS) continue;
        _v.copy(_anchor)
          .addScaledVector(_e1, gx * 0.5 * cellAng)
          .addScaledVector(_e2, gy * 0.5 * cellAng)
          .normalize();
        const fx = Math.floor(_v.x * Q), fy = Math.floor(_v.y * Q), fz = Math.floor(_v.z * Q);
        for (let corner = 0; corner < 8; corner++) {
          const qx = fx + (corner & 1), qy = fy + ((corner >> 1) & 1), qz = fz + (corner >> 2);
          const ck = (qx + 512) + (qy + 512) * 1024 + (qz + 512) * 1048576;
          if (this.seen.has(ck)) continue;
          this.seen.add(ck);
          // only cells on the planet's surface shell carry a prop
          if (Math.abs(Math.hypot(qx, qy, qz) - Q) > 0.7) continue;
          this.placeCell(p, qx, qy, qz, Q, cellAng, seedI, counts);
        }
      }
    }
    for (const kind in this.meshes) {
      this.meshes[kind].count = counts[kind];
      this.meshes[kind].instanceMatrix.needsUpdate = true;
    }
  }

  // everything here depends ONLY on (planet seed, qx, qy, qz):
  // the same rock stands in the same spot forever
  placeCell(p, qx, qy, qz, Q, cellAng, seedI, counts) {
    _up.set(qx, qy, qz).normalize();          // canonical cell direction
    const h0 = hash3i(qx, qy, qz, seedI);

    const hgt = p.height(_up, p.fullMaxFreq);
    const recipe = RECIPES[p.biomeAt(_up, hgt)];
    if (!recipe) return;

    const sel = hashFloat(h0, 0);
    let acc = 0, chosen = null;
    for (const r of recipe) { acc += r[1]; if (sel < acc) { chosen = r; break; } }
    if (!chosen) return;
    const [kind, , s0, s1] = chosen;
    const im = this.meshes[kind];
    if (!im || counts[kind] >= MAX_PER_KIND) return;

    // cell-local tangent frame, derived from the canonical direction
    if (Math.abs(_up.y) < 0.93) _ce1.set(-_up.z, 0, _up.x).normalize();
    else _ce1.set(1, 0, 0).projectOnPlane(_up).normalize();
    _ce2.crossVectors(_up, _ce1);

    // grass grows in little clumps; everything else stands alone
    const copies = kind === 'grass' ? 3 : 1;
    for (let c = 0; c < copies && counts[kind] < MAX_PER_KIND; c++) {
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
      const sc = s0 + (s1 - s0) * hashFloat(hc, 2);
      _s.set(sc, sc * (0.8 + hashFloat(hc, 0) * 0.5), sc);
      _m.compose(_v2, _q, _s);
      im.setMatrixAt(counts[kind]++, _m);
    }
  }
}
