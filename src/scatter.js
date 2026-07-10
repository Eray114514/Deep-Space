// Surface props: alien flora (seeded per-planet species from flora.js) plus
// rocks and crystals, scattered around the camera when near the ground.
// Placement is a pure function of (planet seed, surface cell) — walk away
// and come back, the same tree is waiting.

import * as THREE from 'three';
import { hash3i, hashFloat } from './rng.js';
import { applyWindSway, GROW } from './shaders.js';
import { buildFlora } from './flora.js';

// wind strength per prop kind (0 = rigid)
const SWAY = { grass: 0.06, shrub: 0.05, pod: 0.03, tree0: 0.012, tree1: 0.012, blob: 0.02, cactus: 0.008 };

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
const CAPS = { grass: 8000, shrub: 2600, tree0: 1500, tree1: 1500, pod: 1200, default: 2000 };
export function capFor(kind) { return CAPS[kind] ?? CAPS.default; }
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
  snow:     [['tree1', 0.05, 0.6, 1.2], ['rock', 0.07, 0.3, 1.0], ['boulder', 0.02, 0.5, 1.2]],
  sand:     [['cactus', 0.05, 0.7, 1.5], ['shrub', 0.025, 0.5, 1.0], ['rock', 0.06, 0.3, 1.0]],
  rock:     [['rock', 0.18, 0.4, 1.3], ['boulder', 0.05, 0.6, 1.6]],
  regolith: [['rock', 0.16, 0.3, 1.4], ['boulder', 0.05, 0.5, 2.0]],
  ice:      [['crystal', 0.06, 0.6, 1.8], ['rock', 0.07, 0.3, 1.0]],
  ash:      [['rock', 0.12, 0.3, 1.2], ['boulder', 0.03, 0.5, 1.5]],
  ember:    [['rock', 0.06, 0.3, 1.0]],
  slime:    [['pod', 0.12, 0.9, 1.8], ['blob', 0.16, 0.6, 2.0], ['grass', 0.2, 1.0, 1.8], ['crystal', 0.04, 0.5, 1.4]],
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
    cactus: new THREE.Color(0x3f7a33).convertSRGBToLinear(),
  };
  switch (planet.type) {
    case 'toxic': base.crystal = (p.blotch || p.rock).clone().multiplyScalar(1.4); break;
    case 'ice': base.crystal = new THREE.Color(0x9fd0f0).convertSRGBToLinear(); break;
    case 'exotic': base.crystal = p.land[p.land.length - 1].c.clone().multiplyScalar(1.3); break;
  }
  if (!base.crystal) base.crystal = new THREE.Color(0xb0d8f0).convertSRGBToLinear();
  return base;
}

// flora carries its colour per-vertex, so a flat material.emissive can't
// follow it — patch the emissive term to inherit the vertex/instance tint.
// Pods then glow in their own accent colour at night for free.
function floraEmissive(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #ifdef USE_COLOR
        totalEmissiveRadiance *= vColor;
      #endif`);
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => (key ? key.call(mat) : '') + '-flora';
}
// self-light per flora kind (keeps vegetation readable in shadow; pods glow)
const FLORA_GLOW = { tree0: 0.16, tree1: 0.16, shrub: 0.14, pod: 0.55, grass: 0.05 };

export class Scatter {
  constructor() {
    if (!GEO) GEO = baseGeo();
    this.planet = null;
    this.flora = null;  // per-planet species geometries
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
      const glow = kind === 'crystal' ? 0.35
        : (kind === 'rock' || kind === 'boulder') ? 0.08 : 0.3;
      const mat = new THREE.MeshStandardMaterial({
        color: colors[kind], roughness: 0.95, flatShading: true,
        emissive: colors[kind].clone().multiplyScalar(glow),
      });
      applyWindSway(mat, SWAY[kind] || 0);   // 0 sway still wires the grow scale
      this.addMesh(planet, kind, GEO[kind], mat);
    }
    // this world's own species: geometry seeded by the planet, colours baked
    // per-vertex (material stays white; instance colour adds per-plant drift)
    this.flora = buildFlora(planet);
    for (const kind of FLORA_KINDS) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.9,
        flatShading: true, side: THREE.DoubleSide,
      });
      mat.emissive.setScalar(FLORA_GLOW[kind]);
      applyWindSway(mat, SWAY[kind] || 0);
      floraEmissive(mat);
      const im = this.addMesh(planet, kind, this.flora[kind], mat);
      if (kind === 'grass') im.castShadow = false;   // invisible; halves its cost
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
    if (this.flora) {
      for (const k of FLORA_KINDS) this.flora[k].dispose();
      this.flora = null;
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
    // climbing away: props shrink to nothing across a 200 m band instead of
    // blinking out (all at once!) the moment an altitude line is crossed
    const g = Math.max(0, Math.min(1, (SHOW_BELOW_ALT - alt) / 200));
    GROW.value = g * g * (3 - 2 * g);
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
          // pack ±16383 per axis (Q reaches ~13.4k on 120 km worlds)
          const ck = (qx + 16384) + (qy + 16384) * 32768 + (qz + 16384) * 1073741824;
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
      if (this.meshes[kind].instanceColor) this.meshes[kind].instanceColor.needsUpdate = true;
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
    // (each tuft is already 4–6 blades, so 2 tufts per cell reads dense)
    const copies = kind === 'grass' ? 2 : 1;
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
        // tufts wear the colour of the ground they grow from (slightly
        // brightened) — dry tan land grows dry tan grass, not green
        p.colorAt(_jd, hh, 0.08, 64, _ic);
        _ic.multiplyScalar(1.35).offsetHSL(
          (hashFloat(hc, 0) - 0.5) * 0.04, 0.03, (hashFloat(hc, 1) - 0.5) * 0.1);
      } else {
        // no two plants quite the same colour
        _ic.setRGB(1, 1, 1).offsetHSL(
          (hashFloat(hc, 0) - 0.5) * 0.05, 0, (hashFloat(hc, 1) - 0.5) * 0.16);
      }
      im.setColorAt(counts[kind], _ic);
      im.setMatrixAt(counts[kind]++, _m);
    }
  }
}
