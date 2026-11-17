// The tree field: every tree on a world, from arm's length to the horizon.
//
// A tree is planted once, by a pure function of (planet seed, surface cell),
// and stands in that exact spot at that exact size at every distance. Only
// its level of detail changes:
//
//   near     < ~45 m     full branches and leaves
//   mid      < ~140 m    thinned mesh
//   far      < ~800 m    trunk, limbs and a few dozen foliage cards
//   horizon  to 4.4 km   two crossed quads with the species' silhouette
//
// Nothing pops. Neighbouring levels hand over across a band of distance with
// complementary screen-door dither, each tree at its own slightly different
// distance. At the outer rim a tree grows from nothing while it is still a
// few pixels tall, and the horizon level thins out gradually (again per tree)
// where the terrain's own canopy colour takes over. The earlier design drew
// dense detailed trees inside a 45 m bubble and sparse inflated proxies
// outside it, so the forest visibly ended a few steps ahead of the player.
//
// Tiles are cached, built a few per update inside a time budget and started
// well before they can be seen.

import * as THREE from 'three';
import { hash3i, hashFloat } from './rng.js';
import { buildFlora } from './flora.js';
import { TIME, WIND } from './shaders.js';
import { DISTURBANCE_GLSL, disturbanceUniforms, vegetationDisturbance } from './vegetation/disturbance.js';

export const FAR_FLORA_ENABLED = true;

const TILE_M = 1024;         // metres per cache tile
const CELL_M = 16;           // metres per planting cell
const RADIUS = 4.4;          // tiles of reach around the camera (~4.5 km)
const RIM_M = 4400;
const PREWARM_BELOW = 26000; // build while invisible, well before the tree line appears
const SHOW_BELOW = 16000;    // retained cache band; visual fade starts at 13 km
const STREAM_BUDGET_MS = 1.25;
const REPACK_INTERVAL_MS = 160;
const CACHE_LIMIT = 384;

// level bands in metres; each tree jitters them by ±15% (see the shader)
const TIERS = [
  { name: 'horizon', geometry: 'horizon', lo: 800, hi: Infinity, cap: 70000, shadow: false },
  { name: 'far', geometry: 'far', lo: 140, hi: 800, cap: 14000, shadow: false },
  { name: 'mid', geometry: 'mid', lo: 45, hi: 140, cap: 1000, shadow: true },
  { name: 'near', geometry: 'near', lo: 0, hi: 45, cap: 160, shadow: true },
];
const BAND_JITTER = 0.15;
const TIER_MARGIN_M = 48;     // slack so a level is resident before its band begins
const RECLASSIFY_M = 24;      // camera travel that re-sorts trees into levels

// trees per 16 m cell and the share of species 0. Open country is scattered
// with single trees, woodland is close to a closed canopy.
const FAR_DENSITY = {
  forest: [0.62, 0.7], grass: [0.035, 0.9], snow: [0.0, 0.0],
  slime: [0.16, 0.0], weird: [0.2, 0.0], dryland: [0.012, 0.9],
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
const _offset = new THREE.Vector3();
const _cam = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// Level hand-over, rim growth, horizon thinning and wind, all per instance on
// the GPU. `aRand` is the tree's stable random number.
function applyTreeField(material, uniforms, tier, depthOnly = false) {
  const lo = tier.lo.toFixed(1), hi = Number.isFinite(tier.hi) ? tier.hi.toFixed(1) : '1.0e9';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
          uniform vec3 uCamL;
          uniform float uAltK;
          uniform float uTreeTime;
          uniform vec4 uTreeWind;
          attribute float aRand;
          varying vec2 vTreeFade;
          ${DISTURBANCE_GLSL}
          // a blown-over tree pivots about its base, away from the downwash
          mat3 treeBend() {
            #ifdef USE_INSTANCING
              vec4 dist = plantDisturbance(instanceMatrix[3].xyz, normalize(instanceMatrix[1].xyz),
                aRand, 1.5, 1.0);
              return plantBendMatrix(dist, mat3(instanceMatrix));
            #else
              return mat3(1.0);
            #endif
          }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          objectNormal = treeBend() * objectNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
          {
            vec3 treeBase = instanceMatrix[3].xyz;
            float d = distance(treeBase, uCamL);
            float jitter = 1.0 + (aRand - 0.5) * ${(BAND_JITTER * 2).toFixed(2)};
            float lo = ${lo} * jitter, hi = ${hi} * jitter;
            // x: fading in from the coarser side, y: fading out to the finer
            // side. The neighbouring level evaluates the same two edges, so
            // the dither masks are exact complements.
            vTreeFade = vec2(smoothstep(hi, hi * 0.9, d), smoothstep(lo * 0.9, lo, d));
            float g = uAltK * step(lo * 0.9, d) * step(d, hi);
            ${tier.name === 'horizon' ? `
            float r2 = fract(aRand * 7.13);
            float rim = ${RIM_M.toFixed(1)} * (0.72 + 0.28 * r2);
            g *= 1.0 - smoothstep(rim * 0.82, rim, d);
            // thin the horizon out with distance, one tree at a time
            float keep = mix(1.0, 0.34, smoothstep(1100.0, ${RIM_M.toFixed(1)}, d));
            g *= 1.0 - smoothstep(keep - 0.07, keep, r2);` : ''}
            vec4 treeView = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            if (!isOrthographic && treeView.z > 40.0) g = 0.0;
            // wind: the crown leans and shivers, the trunk base stays put
            float lift = max(transformed.y, 0.0);
            float phase = treeBase.x * 0.37 + treeBase.z * 0.29 + aRand * 6.28;
            float sway = (0.6 * sin(uTreeTime * 0.9 + phase) + 0.3 * sin(uTreeTime * 2.1 + phase * 1.7))
              * (0.35 + uTreeWind.w) + 0.4;
            float bend = lift * lift * 0.0011 * uTreeWind.z * ${tier.name === 'horizon' ? '0.0' : '1.0'};
            transformed.x += uTreeWind.x * sway * bend;
            transformed.z += uTreeWind.y * sway * bend;
            transformed = treeBend() * transformed;
            transformed *= g;
          }
          #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
          varying vec2 vTreeFade;
          float treeDither(vec2 p) {
            return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
          }`)
      .replace('void main() {', `void main() {
          ${depthOnly ? '' : `{
            float n = treeDither(gl_FragCoord.xy);
            if (n > vTreeFade.x) discard;
            if (n <= 1.0 - vTreeFade.y) discard;
          }`}`)
      // Foliage normals describe the crown as one rounded volume. Flipping
      // them on back faces would shade the far side of every card as if it
      // faced into the tree, turning half the canopy black.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          #ifdef DOUBLE_SIDED
            normal *= faceDirection;
          #endif`)
      // Leaves pass and scatter light; a crown's shaded side is dim green,
      // never black. A fraction of the albedo stands in for that transmitted
      // and bounced light until the tree field joins the sky-ambient model.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          #ifdef USE_COLOR
            totalEmissiveRadiance += diffuseColor.rgb * 0.2;
          #endif`);
  };
  material.customProgramCacheKey = () => 'tree-field-v2-' + tier.name + (depthOnly ? '-depth' : '');
  return material;
}

export class FarFlora {
  constructor({ streamBudgetMs = STREAM_BUDGET_MS, repackIntervalMs = REPACK_INTERVAL_MS,
    density = 1 } = {}) {
    this.planet = null;
    this.meshes = null;       // flat list, horizon level first: [h0, h1, far0, far1, mid0, ...]
    this.tiers = null;        // [{ tier, meshes: [species0, species1] }]
    this.tiles = new Map();   // signed x:y:z -> tile-local matrices + double-precision origin
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
    this.uniforms = {
      uCamL: { value: new THREE.Vector3() },
      uAltK: { value: 1 },
      uTreeTime: TIME,
      uTreeWind: { value: WIND },
      ...disturbanceUniforms(),
    };
    this.uCamL = this.uniforms.uCamL;
    this.uAltK = this.uniforms.uAltK;
    this.origin = new THREE.Vector3();
    this.cameraLocal = new THREE.Vector3();
    this.classifiedAt = new THREE.Vector3(Infinity, 0, 0);
  }

  setPlanet(planet) {
    this.clear();
    this.planet = planet;
    if (!planet) return;
    const flora = planet.flora || (planet.flora = buildFlora(planet));
    const trees = flora.trees;
    this.tiers = TIERS.map((tier) => ({
      tier,
      meshes: trees.species.map((species) => {
        // the planet owns the species geometry; the per-instance random
        // number lives on this field's own shallow copy
        const geometry = species.geometries[tier.geometry].clone();
        geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(new Float32Array(tier.cap), 1));
        geometry.getAttribute('aRand').setUsage(THREE.DynamicDrawUsage);
        const material = applyTreeField(new THREE.MeshStandardMaterial({
          map: trees.atlas, alphaTest: 0.42, vertexColors: true, roughness: 0.86,
          side: THREE.DoubleSide,
        }), this.uniforms, tier);
        const im = new THREE.InstancedMesh(geometry, material, tier.cap);
        im.name = 'trees:' + tier.name + ':' + species.name;
        im.count = 0;
        im.visible = false;
        im.frustumCulled = false;
        im.receiveShadow = true;
        im.castShadow = tier.shadow;
        if (tier.shadow) {
          im.customDepthMaterial = applyTreeField(new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking, map: trees.atlas, alphaTest: 0.42,
          }), this.uniforms, tier, true);
        }
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        planet.group.add(im);
        return im;
      }),
    }));
    this.meshes = this.tiers.flatMap((entry) => entry.meshes);
  }

  clear() {
    if (this.planet && this.meshes) {
      for (const im of this.meshes) {
        this.planet.group.remove(im);
        im.material.dispose();
        im.customDepthMaterial?.dispose();
        im.geometry.dispose();   // this field's copy; the species keeps its own
        im.dispose();
      }
    }
    this.meshes = null;
    this.tiers = null;
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
    this.origin.set(0, 0, 0);
    this.cameraLocal.set(0, 0, 0);
    this.classifiedAt.set(Infinity, 0, 0);
    this.uCamL.value.set(0, 0, 0);
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
      levels: this.tiers ? Object.fromEntries(this.tiers.map((entry) => [entry.tier.name,
        entry.meshes.reduce((sum, mesh) => sum + mesh.count, 0)])) : {},
      origin: this.origin.toArray(),
    };
  }

  update(planet, camLocal, alt, budgetMs=this.streamBudgetMs) {
    if (planet !== this.planet) this.setPlanet(alt < PREWARM_BELOW ? planet : null);
    if (!this.planet) return;
    if (alt > PREWARM_BELOW) {
      for (const mesh of this.meshes) mesh.visible = false;
      return;
    }
    const p = this.planet;
    this.cameraLocal.copy(camLocal);
    this.uCamL.value.copy(camLocal).sub(this.origin);
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
            // Planet-scale coordinates exceed the old 10-bit x/y fields.
            // Keep the full signed tuple so neighbouring axes cannot alias.
            want.add(`${qx}:${qy}:${qz}`);
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
    const deadline = streamStart + budgetMs;
    let completed = 0;
    do {
      if(budgetMs<=0)break;
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

    vegetationDisturbance.copyRelative(this.uniforms.uDistPos.value, this.uniforms.uDistData.value,
      this.origin, p.bodyId || p.seed);

    if (!this.dirty && visible && this.cameraLocal.distanceTo(this.classifiedAt) > RECLASSIFY_M) {
      this.repack(true);
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
      return (da - db) || compareTileKeys(a, b);
    });
  }

  pruneCache() {
    if (this.tiles.size <= CACHE_LIMIT) return;
    const [ax, ay, az] = this.anchorK || [0, 0, 0];
    const evict = [...this.tiles.keys()]
      .filter((k) => !this.activeKeys.has(k))
      .sort((a, b) => (tileDistanceSq(b, ax, ay, az) - tileDistanceSq(a, ax, ay, az))
        || compareTileKeys(b, a));
    while (this.tiles.size > CACHE_LIMIT && evict.length) this.tiles.delete(evict.shift());
  }

  createTileJob(p, key) {
    const [qx, qy, qz] = tileCoordinates(key);
    const Q = p.R / TILE_M;
    _anchor.set(qx, qy, qz).normalize();
    frame(_anchor, _e1, _e2);
    // Subtract while coordinates are still doubles; Float32 planet-scale
    // matrices lose centimetres/metres before camera-relative rendering.
    const origin = _anchor.clone().multiplyScalar(p.R + p.height(_anchor, p.fullMaxFreq));
    const SUB = Math.round(TILE_M / CELL_M) + 1;
    return {
      key, qx, qy, qz, Q, origin,
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
      m0: new Float32Array(128 * 16), n0: 0, r0: new Float32Array(128),
      m1: new Float32Array(128 * 16), n1: 0, r1: new Float32Array(128),
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
          _p.copy(_jd).multiplyScalar(p.R + hh - 0.25).sub(job.origin);
          _q.setFromUnitVectors(Y, _jd);
          _q2.setFromAxisAngle(Y, hashFloat(h0, 1) * Math.PI * 2);
          _q.multiply(_q2);
          const sc = 0.7 + hashFloat(h0, 2) * 0.6;
          _s.set(sc, sc * (0.9 + hashFloat(h0, 0) * 0.25), sc);
          _m.compose(_p, _q, _s);
          appendMatrix(job, hashFloat(h0, 3) < dens[1] ? 0 : 1, _m.elements,
            hashFloat(hash3i(ux, uy, uz, job.seedI ^ 0x3d1f), 0));
        }
      }
      if (performance.now() >= deadline) return false;
    }
    return true;
  }

  finishTileJob(job) {
    return {
      origin: job.origin,
      m: [job.m0, job.m1], n: [job.n0, job.n1], r: [job.r0, job.r1],
    };
  }

  buildTile(p, key) {
    const job = this.createTileJob(p, key);
    this.stepTileJob(p, job, Infinity);
    return this.finishTileJob(job);
  }

  // Copies the live ring into the level meshes. `nearOnly` re-sorts just the
  // three close levels after the camera has moved; the horizon level holds
  // every tree in reach and only changes when tiles do.
  repack(nearOnly = false) {
    const started = performance.now();
    if (!nearOnly) this.dirty = false;
    if (!this.meshes) return;
    // Only the live ring consumes the instance budget. Completed tiles just
    // outside it remain cached, ready for a quick turn-back.
    const [ax, ay, az] = this.anchorK || [0, 0, 0];
    const keys = [...this.activeKeys]
      .filter((k) => this.tiles.has(k))
      .sort((a, b) => (tileDistanceSq(a, ax, ay, az) - tileDistanceSq(b, ax, ay, az))
        || compareTileKeys(a, b));
    if (!nearOnly) {
      if (keys.length) this.origin.copy(this.tiles.get(keys[0]).origin);
      // These translations combine with the camera-relative planet transform
      // on the CPU. The GPU only adds nearby tile offsets and tree geometry.
      for (const mesh of this.meshes) mesh.position.copy(this.origin);
    }
    this.uCamL.value.copy(this.cameraLocal).sub(this.origin);
    this.classifiedAt.copy(this.cameraLocal);
    _cam.copy(this.uCamL.value);

    const counts = this.tiers.map(() => [0, 0]);
    for (const k of keys) {
      const t = this.tiles.get(k);
      _offset.copy(t.origin).sub(this.origin);
      // every tree of a tile is within TILE_M of its origin
      const tileDistance = Math.max(0, _offset.distanceTo(_cam) - TILE_M);
      for (let level = nearOnly ? 1 : 0; level < this.tiers.length; level++) {
        const { tier, meshes } = this.tiers[level];
        const reach = tier.hi * (1 + BAND_JITTER) + TIER_MARGIN_M;
        if (tileDistance > reach) continue;
        const from = tier.lo * (1 - BAND_JITTER) * 0.9 - TIER_MARGIN_M;
        for (let species = 0; species < 2; species++) {
          const source = t.m[species], rand = t.r[species];
          // Tiles are generated in stable hash order; retaining a prefix is a
          // deterministic density reduction and does not make trees shuffle.
          const available = Math.floor(t.n[species] * this.displayDensity);
          const mesh = meshes[species];
          const target = mesh.instanceMatrix.array;
          const targetRand = mesh.geometry.getAttribute('aRand').array;
          let n = counts[level][species];
          if (level === 0) {
            const take = Math.min(available, tier.cap - n);
            if (take > 0) {
              copyTileMatrices(target, source, n, take, _offset);
              targetRand.set(rand.subarray(0, take), n);
              n += take;
            }
          } else {
            for (let i = 0; i < available && n < tier.cap; i++) {
              const x = source[i * 16 + 12] + _offset.x - _cam.x;
              const y = source[i * 16 + 13] + _offset.y - _cam.y;
              const z = source[i * 16 + 14] + _offset.z - _cam.z;
              const d = Math.sqrt(x * x + y * y + z * z);
              if (d > reach || d < from) continue;
              target.set(source.subarray(i * 16, i * 16 + 16), n * 16);
              target[n * 16 + 12] += _offset.x;
              target[n * 16 + 13] += _offset.y;
              target[n * 16 + 14] += _offset.z;
              targetRand[n] = rand[i];
              n++;
            }
          }
          counts[level][species] = n;
        }
      }
    }
    for (let level = nearOnly ? 1 : 0; level < this.tiers.length; level++) {
      for (let species = 0; species < 2; species++) {
        const mesh = this.tiers[level].meshes[species];
        mesh.count = counts[level][species];
        this.markInstanceUpload(mesh, mesh.count);
      }
    }
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
    const rand = mesh.geometry.getAttribute('aRand');
    if (rand.clearUpdateRanges && rand.addUpdateRange) {
      rand.clearUpdateRanges();
      rand.addUpdateRange(0, count);
    }
    rand.needsUpdate = true;
  }
}

function tileDistanceSq(key, ax, ay, az) {
  const [qx, qy, qz] = tileCoordinates(key);
  return (qx - ax) * (qx - ax) + (qy - ay) * (qy - ay) + (qz - az) * (qz - az);
}

function copyTileMatrices(target, source, start, count, offset) {
  target.set(source.subarray(0, count * 16), start * 16);
  for (let i = 0; i < count; i++) {
    const at = (start + i) * 16 + 12;
    target[at] = source[i * 16 + 12] + offset.x;
    target[at + 1] = source[i * 16 + 13] + offset.y;
    target[at + 2] = source[i * 16 + 14] + offset.z;
  }
}

function tileCoordinates(key) {
  return key.split(':').map(Number);
}

function compareTileKeys(a, b) {
  const [ax, ay, az] = tileCoordinates(a);
  const [bx, by, bz] = tileCoordinates(b);
  // Preserve the old packing's z/y/x tie order within its valid domain.
  return (az - bz) || (ay - by) || (ax - bx);
}

function sameKeys(a, b) {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

function appendMatrix(job, species, elements, random) {
  const matrixKey = species === 0 ? 'm0' : 'm1';
  const randKey = species === 0 ? 'r0' : 'r1';
  const countKey = species === 0 ? 'n0' : 'n1';
  let buffer = job[matrixKey];
  const offset = job[countKey] * 16;
  if (offset + 16 > buffer.length) {
    const grown = new Float32Array(buffer.length * 2);
    grown.set(buffer);
    job[matrixKey] = buffer = grown;
    const grownRand = new Float32Array(job[randKey].length * 2);
    grownRand.set(job[randKey]);
    job[randKey] = grownRand;
  }
  buffer.set(elements, offset);
  job[randKey][job[countKey]] = random;
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
