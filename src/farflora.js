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
import { resolveRendererPolicy } from './renderer-policy.js';
import { applyFarFadeV2 } from './flora-system.js';
import { hash3i, hashFloat } from './rng.js';
import { buildFlora } from './flora.js';
import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';

// Temporary subsystem contract: Stage C replaces the proxy-tree architecture.
export const FAR_FLORA_ENABLED = false;

const rendererParams = typeof location !== 'undefined'
  ? new URLSearchParams(location.search) : new URLSearchParams();
const rendererSettings = resolveGraphicsSettings({ params: rendererParams });
const USE_NODE_MATERIALS = resolveRendererPolicy(
  rendererParamsForSettings(rendererSettings, rendererParams)).backend === 'webgpu';

const TILE_M = 1024;         // metres per cache tile
const CELL_M = 32;           // metres per proxy-tree cell (32 per tile edge)
const RADIUS = 4.4;          // tiles of reach around the camera (~4.5 km)
const CAP = 24000;           // per species
const PREWARM_BELOW = 26000; // build while invisible, well before the tree line appears
const SHOW_BELOW = 16000;    // retained cache band; visual fade starts at 13 km
const STREAM_BUDGET_MS = 1.25;
const REPACK_INTERVAL_MS = 160;
const CACHE_LIMIT = 384;

// per-biome CLUMP probability per 32 m cell and the tree0 share. One proxy
// stands for several near-tier trees (they inflate with distance), so these
// chase the near tier's per-m² density as far as the instance budget allows —
// a 12× density cliff at the bubble edge reads as "the forest ends here"
const FAR_DENSITY = {
  forest: [0.8, 0.72], grass: [0.32, 0.95], snow: [0.0, 0.0],
  slime: [0.38, 0.0], weird: [0.5, 0.0], dryland: [0.1, 0.9],
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

// shader hooks: proxies dissolve at the far rim and when the camera climbs
// out — all on the GPU, no per-instance updates. Keep the sparse proxy trees
// at close range as stable landmarks: scaling them to zero at the detailed
// bubble boundary made every tree the pilot approached appear to sink into
// the terrain before the ship could reach it.
function applyFarFade(mat, uniforms) {
  if (!USE_NODE_MATERIALS) {
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
            float g = (1.0 - smoothstep(3900.0, 4400.0, d)) * uAltK;
            g *= 1.15 + 1.15 * smoothstep(450.0, 2400.0, d);
            transformed *= g;
          }
          #endif`);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_COLOR
          totalEmissiveRadiance *= vColor.rgb;
        #endif`);
    };
    mat.customProgramCacheKey = () => 'far-flora';
    return mat;
  }
  return applyFarFadeV2(mat, uniforms);
}

export class FarFlora {
  constructor({ streamBudgetMs = STREAM_BUDGET_MS, repackIntervalMs = REPACK_INTERVAL_MS,
    density = 1 } = {}) {
    this.planet = null;
    this.meshes = null;       // [tree0 proxies, tree1 proxies]
    this.tiles = new Map();   // packed tile key -> {m0: Float32Array, n0, m1, n1}
    this.queue = [];
    this.queued = new Set();
    this.activeKeys = new Set();
    this.targetKeys = new Set();
    this.stableKeys = new Set();
    this.job = null;
    this.lastKey = '';
    this.dirty = false;
    this.streamBudgetMs = streamBudgetMs;
    this.repackIntervalMs = repackIntervalMs;
    this.density = Math.max(0.35, Math.min(1, density));
    this.displayDensity = 1;
    this.lastRepackAt = -Infinity;
    this.metrics = {
      builtTiles: 0, repacks: 0,
      streamMs: 0, repackMs: 0,
      worstStreamMs: 0, worstRepackMs: 0,
    };
    this.uCamL = { value: new THREE.Vector3() };
    this.uAltK = { value: 1 };
  }

  setPlanet(planet) {
    // 植物系统重做中 — 完全禁用远景植物(proxy tree)渲染。
    // 现有实现的问题:applyFarFadeV2 用 positionLocal.sub(uCamL) 算距离,
    // TSL positionLocal 不含 instanceMatrix,所有实例同步位移→石头/树同步抖动;
    // positionNode = positionLocal.sub(positionGeometry.mul(1-g)) 在 g 变化时
    // 顶点偏移每帧变化→幅度抖动。代码保留供重做参考。
    this.clear();
    this.planet = null;
    return;
  }
  // 原始远景植物创建代码已禁用(重做中)。保留如下供参考:
  // const flora = planet.flora || (planet.flora = buildFlora(planet));
  // this.meshes = [flora.far0, flora.far1].map((geo) => { ... applyFarFade ... });
  // 详见 git 历史或 docs/optimization-roadmap.md 批次 C。

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
    this.queued.clear();
    this.activeKeys.clear();
    this.targetKeys.clear();
    this.stableKeys.clear();
    this.job = null;
    this.lastKey = '';
    this.dirty = false;
    this.lastRepackAt = -Infinity;
  }

  pending() { return this.queue.length + (this.job ? 1 : 0); }

  setDisplayDensity(density) {
    const next = Math.max(0.35, Math.min(1, density));
    if (Math.abs(next - this.displayDensity) < 0.025) return;
    this.displayDensity = next;
    this.dirty = true;
    if (this.pending() === 0) this.repack();
  }

  debugStats() {
    return {
      ...this.metrics,
      pending: this.pending(),
      cachedTiles: this.tiles.size,
      activeTiles: this.activeKeys.size,
      instances: this.meshes ? this.meshes[0].count + this.meshes[1].count : 0,
    };
  }

  update(planet, camLocal, alt) {
    if (planet !== this.planet) this.setPlanet(alt < PREWARM_BELOW ? planet : null);
    if (!this.planet) return;
    if (alt > PREWARM_BELOW) {
      for (const mesh of this.meshes) mesh.visible = false;
      return;
    }
    const p = this.planet;
    this.uCamL.value.copy(camLocal);
    this.uAltK.value = smooth01((13000 - alt) / 3000);
    const visible = alt < SHOW_BELOW && this.uAltK.value > 0.0001;
    for (const mesh of this.meshes) mesh.visible = visible;

    // tile discovery on crossing a tile-sized cell of the coarse lattice
    _dir.copy(camLocal).normalize();
    const Q = p.R / TILE_M;
    const kx = Math.round(_dir.x * Q), ky = Math.round(_dir.y * Q), kz = Math.round(_dir.z * Q);
    const key = kx + ':' + ky + ':' + kz;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.anchorK = [kx, ky, kz];
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
      this.targetKeys = want;
      // Keep the completed previous ring live until its replacement is ready.
      // This prevents a fast flight from punching visible holes into the tree
      // line and avoids repeatedly uploading a half-populated instance buffer.
      this.activeKeys = new Set([...this.stableKeys, ...want]);
      this.dirty = true;

      // Keep completed tiles and in-flight work across tile-boundary changes.
      // Fast low flight used to delete the previous ring and replace the whole
      // queue, so the same forest was regenerated indefinitely.
      this.queue = this.queue.filter((k) => {
        if (want.has(k)) return true;
        this.queued.delete(k);
        return false;
      });
      for (const k of want) {
        if (this.tiles.has(k) || this.queued.has(k) || this.job?.key === k) continue;
        this.queue.push(k);
        this.queued.add(k);
      }
      this.sortQueue();
      this.pruneCache();
    }

    // Generation is resumable and wall-clock-budgeted. Slower CPUs take more
    // frames to fill the invisible 16→13 km warm-up band, but no individual
    // frame inherits a full tile's procedural height/biome cost.
    const streamStart = performance.now();
    const deadline = streamStart + this.streamBudgetMs;
    let completed = 0;
    do {
      if (!this.job) {
        const k = this.queue.shift();
        if (k == null) break;
        this.queued.delete(k);
        if (this.tiles.has(k)) continue;
        this.job = this.createTileJob(p, k);
      }
      if (!this.stepTileJob(p, this.job, deadline)) break;
      this.tiles.set(this.job.key, this.finishTileJob(this.job));
      this.job = null;
      this.dirty = true;
      completed++;
      this.metrics.builtTiles++;
    } while (performance.now() < deadline);
    const streamMs = performance.now() - streamStart;
    this.metrics.streamMs = streamMs;
    this.metrics.worstStreamMs = Math.max(this.metrics.worstStreamMs, streamMs);

    if (this.pending() === 0 && this.targetKeys.size > 0
      && !sameKeys(this.stableKeys, this.targetKeys)) {
      this.stableKeys = new Set(this.targetKeys);
      this.activeKeys = new Set(this.targetKeys);
      this.dirty = true;
      this.pruneCache();
    }

    if (this.dirty) {
      const firstVisibleBatch = visible
        && this.meshes[0].count + this.meshes[1].count === 0 && completed > 0;
      // Keep the previous complete ring resident while the next one streams.
      // Repacking every 160 ms uploaded all 24k matrices repeatedly and was
      // the source of the old <16 km periodic hitch.
      if (firstVisibleBatch || this.pending() === 0) {
        this.repack();
        this.lastRepackAt = performance.now();
      }
    }
  }

  sortQueue() {
    const [ax, ay, az] = this.anchorK || [0, 0, 0];
    this.queue.sort((a, b) => {
      const da = tileDistanceSq(a, ax, ay, az);
      const db = tileDistanceSq(b, ax, ay, az);
      return (da - db) || (a - b);
    });
  }

  pruneCache() {
    if (this.tiles.size <= CACHE_LIMIT) return;
    const [ax, ay, az] = this.anchorK || [0, 0, 0];
    const evict = [...this.tiles.keys()]
      .filter((k) => !this.activeKeys.has(k))
      .sort((a, b) => (tileDistanceSq(b, ax, ay, az) - tileDistanceSq(a, ax, ay, az)) || (b - a));
    while (this.tiles.size > CACHE_LIMIT && evict.length) this.tiles.delete(evict.shift());
  }

  createTileJob(p, key) {
    const qx = (key % 1024) - 512;
    const qy = (Math.floor(key / 1024) % 1024) - 512;
    const qz = Math.floor(key / 1048576) - 512;
    const Q = p.R / TILE_M;
    _anchor.set(qx, qy, qz).normalize();
    frame(_anchor, _e1, _e2);
    const SUB = Math.round(TILE_M / CELL_M) + 1;
    return {
      key, qx, qy, qz, Q,
      Q3: p.R / CELL_M,
      cellAng: CELL_M / p.R,
      seedI: p.intSeed ^ 0xfa12,
      anchor: _anchor.clone(),
      e1: _e1.clone(),
      e2: _e2.clone(),
      SUB, gx: -SUB, gy: -SUB,
      // Write matrices straight into their long-lived typed storage. The old
      // JS arrays created 16 boxed-number entries per tree and then copied the
      // whole tile again on completion, producing severe GC pauses in flight.
      m0: new Float32Array(128 * 16), n0: 0,
      m1: new Float32Array(128 * 16), n1: 0,
      seen: new Set(),
    };
  }

  stepTileJob(p, job, deadline) {
    while (job.gy <= job.SUB) {
      const gx = job.gx, gy = job.gy;
      job.gx++;
      if (job.gx > job.SUB) { job.gx = -job.SUB; job.gy++; }
      _v.copy(job.anchor)
        .addScaledVector(job.e1, gx * 0.5 * job.cellAng)
        .addScaledVector(job.e2, gy * 0.5 * job.cellAng)
        .normalize();
        // the candidate belongs to THIS tile only (no double-planting from
        // the neighbour's overlapping scan)
      if (Math.round(_v.x * job.Q) === job.qx && Math.round(_v.y * job.Q) === job.qy
        && Math.round(_v.z * job.Q) === job.qz) {
        const cx = Math.floor(_v.x * job.Q3), cy = Math.floor(_v.y * job.Q3), cz = Math.floor(_v.z * job.Q3);
        for (let c = 0; c < 8; c++) {
          const ux = cx + (c & 1), uy = cy + ((c >> 1) & 1), uz = cz + (c >> 2);
          // Exact numeric packing stays below Number.MAX_SAFE_INTEGER for the
          // supported planet radii and avoids thousands of temporary strings.
          const ck = (ux + 32768) + (uy + 32768) * 65536
            + (uz + 32768) * 4294967296;
          if (job.seen.has(ck)) continue;
          job.seen.add(ck);
          if (Math.abs(Math.hypot(ux, uy, uz) - job.Q3) > 0.7) continue;
          _up.set(ux, uy, uz).normalize();
          if (Math.round(_up.x * job.Q) !== job.qx || Math.round(_up.y * job.Q) !== job.qy
            || Math.round(_up.z * job.Q) !== job.qz) continue;
          const h0 = hash3i(ux, uy, uz, job.seedI);
          const hgt = p.height(_up, 96);
          const dens = FAR_DENSITY[p.biomeAt(_up, hgt)];
          if (!dens) continue;
          const sel = hashFloat(h0, 0);
          if (sel >= dens[0] * this.density) continue;
          // jitter inside the cell, ground the tree at full terrain detail
          frame(_up, _ce1, _ce2);
          _jd.copy(_up)
            .addScaledVector(_ce1, (hashFloat(h0, 1) - 0.5) * job.cellAng)
            .addScaledVector(_ce2, (hashFloat(h0, 2) - 0.5) * job.cellAng)
            .normalize();
          // full terrain frequency: a coarse height differs from the drawn
          // surface by tens of metres — trees planted with it are BURIED
          const hh = p.height(_jd, p.fullMaxFreq);
          if (p.hasLiquid && hh < p.seaLevel + 0.6) continue;
          _p.copy(_jd).multiplyScalar(p.R + hh - 0.4);
          _q.setFromUnitVectors(Y, _jd);
          _q2.setFromAxisAngle(Y, hashFloat(h0, 1) * Math.PI * 2);
          _q.multiply(_q2);
          const sc = 0.75 + hashFloat(h0, 2) * 0.65;
          _s.set(sc, sc * (0.85 + hashFloat(h0, 0) * 0.4), sc);
          _m.compose(_p, _q, _s);
          appendMatrix(job, hashFloat(h0, 3) < dens[1] ? 0 : 1, _m.elements);
        }
      }
      if (performance.now() >= deadline) return false;
    }
    return true;
  }

  finishTileJob(job) {
    return {
      m0: job.m0, n0: job.n0,
      m1: job.m1, n1: job.n1,
    };
  }

  buildTile(p, key) {
    const job = this.createTileJob(p, key);
    this.stepTileJob(p, job, Infinity);
    return this.finishTileJob(job);
  }

  repack() {
    const started = performance.now();
    this.dirty = false;
    if (!this.meshes) return;
    // Only the live ring consumes the instance budget. Completed tiles just
    // outside it remain cached, ready for a quick turn-back.
    const [ax, ay, az] = this.anchorK || [0, 0, 0];
    const keys = [...this.activeKeys]
      .filter((k) => this.tiles.has(k))
      .sort((a, b) => (tileDistanceSq(a, ax, ay, az) - tileDistanceSq(b, ax, ay, az)) || (a - b));
    let n0 = 0, n1 = 0;
    const a0 = this.meshes[0].instanceMatrix.array;
    const a1 = this.meshes[1].instanceMatrix.array;
    for (const k of keys) {
      const t = this.tiles.get(k);
      // Tiles are generated in stable hash order; retaining a prefix is a
      // deterministic far-density reduction and does not make trees shuffle.
      const c0 = Math.min(Math.floor(t.n0 * this.displayDensity), CAP - n0);
      const c1 = Math.min(Math.floor(t.n1 * this.displayDensity), CAP - n1);
      if (c0 > 0) { a0.set(t.m0.subarray(0, c0 * 16), n0 * 16); n0 += c0; }
      if (c1 > 0) { a1.set(t.m1.subarray(0, c1 * 16), n1 * 16); n1 += c1; }
    }
    this.meshes[0].count = n0;
    this.meshes[1].count = n1;
    this.markInstanceUpload(this.meshes[0], n0);
    this.markInstanceUpload(this.meshes[1], n1);
    const elapsed = performance.now() - started;
    this.metrics.repackMs = elapsed;
    this.metrics.worstRepackMs = Math.max(this.metrics.worstRepackMs, elapsed);
    this.metrics.repacks++;
  }

  markInstanceUpload(mesh, count) {
    const attribute = mesh.instanceMatrix;
    if (attribute.clearUpdateRanges && attribute.addUpdateRange) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * 16);
    }
    attribute.needsUpdate = true;
  }
}

function tileDistanceSq(key, ax, ay, az) {
  const qx = (key % 1024) - 512;
  const qy = (Math.floor(key / 1024) % 1024) - 512;
  const qz = Math.floor(key / 1048576) - 512;
  return (qx - ax) * (qx - ax) + (qy - ay) * (qy - ay) + (qz - az) * (qz - az);
}

function sameKeys(a, b) {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

function appendMatrix(job, species, elements) {
  const matrixKey = species === 0 ? 'm0' : 'm1';
  const countKey = species === 0 ? 'n0' : 'n1';
  let buffer = job[matrixKey];
  const offset = job[countKey] * 16;
  if (offset + 16 > buffer.length) {
    const grown = new Float32Array(buffer.length * 2);
    grown.set(buffer);
    job[matrixKey] = buffer = grown;
  }
  buffer.set(elements, offset);
  job[countKey]++;
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
