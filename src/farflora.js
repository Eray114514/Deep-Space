// Far flora: the detailed scatter bubble only reaches ~200 m, so without
// this tier a forested world looks BARE from anywhere above walking height
// and trees visibly grow in as you approach. Here every vegetated cell out
// to ~4.5 km gets a low-poly proxy tree (same species silhouette/colours),
// instanced in two draw calls. A vertex-shader fade dissolves proxies just
// inside the detailed bubble and at the far rim, so trees stand on the
// horizon from 10+ km up and nothing ever pops or "grows".
//
// Placement is a pure function of (planet seed, coarse surface cell) —
// tiles are cached, built a few per update, and repacked into the global
// InstancedMesh, so flying laps around a planet always regrows the same
// forest.

import * as THREE from 'three';
import { hash3i, hashFloat } from './rng.js';
import { buildFlora } from './flora.js';

const TILE_M = 1024;         // metres per cache tile
const CELL_M = 32;           // metres per proxy-tree cell (32 per tile edge)
const RADIUS = 4.4;          // tiles of reach around the camera (~4.5 km)
const CAP = 16000;           // per species
const SHOW_BELOW = 16000;    // m altitude; fade starts at 10 km

// per-biome proxy density (fraction of cells carrying a tree) and which
// species: mirrors the near-tier RECIPES tree densities
const FAR_DENSITY = {
  forest: [0.56, 0.72], grass: [0.06, 0.95], snow: [0.045, 0.0],
  slime: [0.05, 0.0], weird: [0.12, 0.0], dryland: [0.02, 0.9],
};

const _dir = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3();
const _jd = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _ce1 = new THREE.Vector3();
const _ce2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const Y = new THREE.Vector3(0, 1, 0);

// shader hooks: proxies dissolve inside the detailed bubble, at the far rim,
// and when the camera climbs out — all on the GPU, no per-instance updates
function applyFarFade(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uCamL;
        uniform float uAltK;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          float d = distance(instanceMatrix[3].xyz, uCamL);
          float g = smoothstep(150.0, 205.0, d) * (1.0 - smoothstep(3900.0, 4400.0, d)) * uAltK;
          // distant proxies inflate into grove-blobs: canopies must OVERLAP
          // on far hillsides or a forest thins into scattered specks
          g *= 1.0 + 1.1 * smoothstep(500.0, 2200.0, d);
          transformed *= g;
        }
        #endif`);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #ifdef USE_COLOR
        totalEmissiveRadiance *= vColor;
      #endif`);
  };
  mat.customProgramCacheKey = () => 'far-flora';
}

export class FarFlora {
  constructor() {
    this.planet = null;
    this.meshes = null;       // [tree0 proxies, tree1 proxies]
    this.tiles = new Map();   // packed tile key -> {m0: Float32Array, n0, m1, n1}
    this.queue = [];
    this.lastKey = '';
    this.dirty = false;
    this.uCamL = { value: new THREE.Vector3() };
    this.uAltK = { value: 1 };
  }

  setPlanet(planet) {
    this.clear();
    this.planet = planet;
    if (!planet) return;
    const flora = planet.flora || (planet.flora = buildFlora(planet));
    this.meshes = [flora.far0, flora.far1].map((geo) => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.95, flatShading: true,
      });
      mat.emissive.setScalar(0.14);
      applyFarFade(mat, { uCamL: this.uCamL, uAltK: this.uAltK });
      const im = new THREE.InstancedMesh(geo, mat, CAP);
      im.count = 0;
      im.frustumCulled = false;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      planet.group.add(im);
      return im;
    });
  }

  clear() {
    if (this.planet && this.meshes) {
      for (const im of this.meshes) {
        this.planet.group.remove(im);
        im.material.dispose();
        im.dispose();      // geometry is planet-owned
      }
    }
    this.meshes = null;
    this.planet = null;
    this.tiles.clear();
    this.queue.length = 0;
    this.lastKey = '';
    this.dirty = false;
  }

  pending() { return this.queue.length; }

  update(planet, camLocal, alt) {
    if (planet !== this.planet) this.setPlanet(alt < SHOW_BELOW ? planet : null);
    if (!this.planet) return;
    if (alt > SHOW_BELOW) { this.clear(); return; }
    const p = this.planet;
    this.uCamL.value.copy(camLocal);
    this.uAltK.value = smooth01((13000 - alt) / 3000);

    // tile discovery on crossing a tile-sized cell of the coarse lattice
    _dir.copy(camLocal).normalize();
    const Q = p.R / TILE_M;
    const kx = Math.round(_dir.x * Q), ky = Math.round(_dir.y * Q), kz = Math.round(_dir.z * Q);
    const key = kx + ':' + ky + ':' + kz;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const want = new Set();
      _anchor.set(kx, ky, kz).normalize();
      frame(_anchor, _e1, _e2);
      const STEPS = Math.ceil(RADIUS) * 2 + 1;
      const ang = TILE_M / p.R;
      for (let gy = -STEPS; gy <= STEPS; gy++) {
        for (let gx = -STEPS; gx <= STEPS; gx++) {
          if (gx * gx + gy * gy > (RADIUS * 2 + 1) * (RADIUS * 2 + 1)) continue;
          _v.copy(_anchor)
            .addScaledVector(_e1, gx * 0.5 * ang)
            .addScaledVector(_e2, gy * 0.5 * ang)
            .normalize();
          const fx = Math.floor(_v.x * Q), fy = Math.floor(_v.y * Q), fz = Math.floor(_v.z * Q);
          for (let c = 0; c < 8; c++) {
            const qx = fx + (c & 1), qy = fy + ((c >> 1) & 1), qz = fz + (c >> 2);
            if (Math.abs(Math.hypot(qx, qy, qz) - Q) > 0.71) continue;
            want.add((qx + 512) + (qy + 512) * 1024 + (qz + 512) * 1048576);
          }
        }
      }
      for (const k of this.tiles.keys()) {
        if (!want.has(k)) { this.tiles.delete(k); this.dirty = true; }
      }
      const missing = [];
      for (const k of want) if (!this.tiles.has(k)) missing.push(k);
      missing.sort((a, b) => a - b);          // deterministic build order
      this.queue = missing;
    }

    // build a couple of tiles per frame (each is ~600 height/biome samples)
    let built = 0;
    while (this.queue.length && built < 2) {
      const k = this.queue.shift();
      if (!this.tiles.has(k)) {
        this.tiles.set(k, this.buildTile(p, k));
        this.dirty = true;
        built++;
      }
    }

    if (this.dirty) this.repack();
  }

  buildTile(p, key) {
    const qx = (key % 1024) - 512;
    const qy = (Math.floor(key / 1024) % 1024) - 512;
    const qz = Math.floor(key / 1048576) - 512;
    const Q = p.R / TILE_M;
    const Q3 = p.R / CELL_M;
    const cellAng = CELL_M / p.R;
    const seedI = p.intSeed ^ 0xfa12;
    _anchor.set(qx, qy, qz).normalize();
    frame(_anchor, _e1, _e2);
    const SUB = Math.round(TILE_M / CELL_M) + 1;
    const m0 = [], m1 = [];
    const seen = new Set();
    for (let gy = -SUB; gy <= SUB; gy++) {
      for (let gx = -SUB; gx <= SUB; gx++) {
        _v.copy(_anchor)
          .addScaledVector(_e1, gx * 0.5 * cellAng)
          .addScaledVector(_e2, gy * 0.5 * cellAng)
          .normalize();
        // the candidate belongs to THIS tile only (no double-planting from
        // the neighbour's overlapping scan)
        if (Math.round(_v.x * Q) !== qx || Math.round(_v.y * Q) !== qy
          || Math.round(_v.z * Q) !== qz) continue;
        const cx = Math.floor(_v.x * Q3), cy = Math.floor(_v.y * Q3), cz = Math.floor(_v.z * Q3);
        for (let c = 0; c < 8; c++) {
          const ux = cx + (c & 1), uy = cy + ((c >> 1) & 1), uz = cz + (c >> 2);
          const ck = ux + ':' + uy + ':' + uz;
          if (seen.has(ck)) continue;
          seen.add(ck);
          if (Math.abs(Math.hypot(ux, uy, uz) - Q3) > 0.7) continue;
          _up.set(ux, uy, uz).normalize();
          if (Math.round(_up.x * Q) !== qx || Math.round(_up.y * Q) !== qy
            || Math.round(_up.z * Q) !== qz) continue;
          const h0 = hash3i(ux, uy, uz, seedI);
          const hgt = p.height(_up, 96);
          const dens = FAR_DENSITY[p.biomeAt(_up, hgt)];
          if (!dens) continue;
          const sel = hashFloat(h0, 0);
          if (sel >= dens[0]) continue;
          // jitter inside the cell, ground the tree at full terrain detail
          frame(_up, _ce1, _ce2);
          _jd.copy(_up)
            .addScaledVector(_ce1, (hashFloat(h0, 1) - 0.5) * cellAng)
            .addScaledVector(_ce2, (hashFloat(h0, 2) - 0.5) * cellAng)
            .normalize();
          const hh = p.height(_jd, 128);
          if (p.hasLiquid && hh < p.seaLevel + 0.6) continue;
          _p.copy(_jd).multiplyScalar(p.R + hh - 0.4);
          _q.setFromUnitVectors(Y, _jd);
          _q2.setFromAxisAngle(Y, hashFloat(h0, 1) * Math.PI * 2);
          _q.multiply(_q2);
          const sc = 0.75 + hashFloat(h0, 2) * 0.65;
          _s.set(sc, sc * (0.85 + hashFloat(h0, 0) * 0.4), sc);
          _m.compose(_p, _q, _s);
          (hashFloat(h0, 3) < dens[1] ? m0 : m1).push(..._m.elements);
        }
      }
    }
    return {
      m0: new Float32Array(m0), n0: m0.length / 16,
      m1: new Float32Array(m1), n1: m1.length / 16,
    };
  }

  repack() {
    this.dirty = false;
    if (!this.meshes) return;
    const keys = [...this.tiles.keys()].sort((a, b) => a - b);
    let n0 = 0, n1 = 0;
    const a0 = this.meshes[0].instanceMatrix.array;
    const a1 = this.meshes[1].instanceMatrix.array;
    for (const k of keys) {
      const t = this.tiles.get(k);
      const c0 = Math.min(t.n0, CAP - n0), c1 = Math.min(t.n1, CAP - n1);
      if (c0 > 0) { a0.set(t.m0.subarray(0, c0 * 16), n0 * 16); n0 += c0; }
      if (c1 > 0) { a1.set(t.m1.subarray(0, c1 * 16), n1 * 16); n1 += c1; }
    }
    this.meshes[0].count = n0;
    this.meshes[1].count = n1;
    this.meshes[0].instanceMatrix.needsUpdate = true;
    this.meshes[1].instanceMatrix.needsUpdate = true;
  }
}

function frame(u, a, b) {
  if (Math.abs(u.y) < 0.93) a.set(-u.z, 0, u.x).normalize();
  else a.set(1, 0, 0).projectOnPlane(u).normalize();
  b.crossVectors(u, a);
}

function smooth01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
