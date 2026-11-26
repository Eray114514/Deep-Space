// The tree field: every tree on a world, from arm's length to the horizon.
//
// A tree is planted once, by a pure function of (planet seed, surface cell),
// and stands in that exact spot at that exact size at every distance. Only
// its level of detail changes:
//
//   near     < ~85 m     full branches and leaves
//   mid      < ~230 m    smooth curved limbs + stratified 34% foliage
//   far      < ~850 m    trunk, primary limbs + nested 12% foliage
//   horizon  to 4.4 km   dome-lit crossed silhouettes + overhead crown
//
// Neighbouring visible levels hand over across a wide 24% band with exact
// complementary 4x4 Bayer ordered dither, while shadow casters switch cleanly
// at the single deterministic midpoint with zero shadow-map dither noise.
// Newly streamed tiles reveal smoothly over 0.65 s instead of popping in bulk.

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
const STREAM_BUDGET_MS = 2.0;
const REPACK_INTERVAL_MS = 150;
// the densest biome; cells whose roll is above it cannot hold a tree
const MAX_DENSITY = 0.62;
const CACHE_LIMIT = 384;

// level bands in metres; each tree jitters them by ±15% (see the shader)
const TIERS = [
  { name: 'horizon', geometry: 'horizon', lo: 850, hi: Infinity, cap: 115000, shadow: false },
  { name: 'far',     geometry: 'far',     lo: 230, hi: 850,      cap: 14000,  shadow: true },
  { name: 'mid',     geometry: 'mid',     lo: 85,  hi: 230,      cap: 1600,   shadow: true },
  { name: 'near',    geometry: 'near',    lo: 0,   hi: 85,       cap: 420,    shadow: true },
];
const BAND_JITTER = 0.15;
const BAND_LO_FRAC = 0.76;     // wide 24% crossfade band eliminates abrupt morph perception
const SHADOW_MID_FRAC = 0.88;  // single deterministic non-overlapping shadow handoff
const HORIZON_THIN_FROM = 1100;
const HORIZON_KEEP_RIM = 0.12;
function horizonKeep(d) {
  const t = Math.min(1, Math.max(0, (d - HORIZON_THIN_FROM) / (RIM_M - HORIZON_THIN_FROM)));
  return 1 + (HORIZON_KEEP_RIM - 1) * t * t * (3 - 2 * t);
}
const TIER_MARGIN_M = 64;     // slack so a level is resident well before its band begins
const RECLASSIFY_M = 20;      // camera travel that re-sorts trees into levels

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

// Level hand-over, rim growth, horizon thinning, smooth tile reveal, wind, and
// hemisphere + backlit foliage shading on the GPU.
// `aRand` is the tree's stable random number; `aBorn` is its tile reveal epoch.
function applyTreeField(material, uniforms, tier, depthOnly = false) {
  const lo = tier.lo.toFixed(1), hi = Number.isFinite(tier.hi) ? tier.hi.toFixed(1) : '1.0e9';
  const hasHi = Number.isFinite(tier.hi), hasLo = tier.lo > 0;
  const loFrac = BAND_LO_FRAC.toFixed(2);
  const shMid = SHADOW_MID_FRAC.toFixed(2);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
          uniform vec3 uCamL;
          uniform float uAltK;
          uniform float uTreeTime;
          uniform float uRevealTime;
          uniform vec4 uTreeWind;
          uniform vec2 uTreeWindPhase;
          uniform vec3 uTreeSunDir;
          attribute float aRand;
          attribute float aBorn;
          ${depthOnly ? '' : `
          varying vec2 vTreeFade;
          varying vec2 vTreeUv;
          varying vec3 vTreeShading;
          varying float vTreeDist;`}
          // share of horizon trees kept at distance d; mirrored on the CPU
          float horizonKeep(float d) {
            return mix(1.0, ${HORIZON_KEEP_RIM.toFixed(2)}, smoothstep(${HORIZON_THIN_FROM.toFixed(1)}, ${RIM_M.toFixed(1)}, d));
          }
          ${DISTURBANCE_GLSL}
          // a blown-over tree pivots about its base, away from the downwash
          mat3 treeBend() {
            #ifdef USE_INSTANCING
              vec4 dist = plantDisturbance(instanceMatrix[3].xyz, normalize(instanceMatrix[1].xyz),
                aRand, 1.53, 1.0);
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
            float tileReveal = smoothstep(0.0, 0.65, uRevealTime - aBorn);
            ${depthOnly ? `
            // Shadow casters switch cleanly at one deterministic distance per
            // tree — zero overlapping double casters and zero shadow-map dither
            // noise when moving across texels.
            float g = uAltK * ${hasLo ? `step(lo * ${shMid}, d)` : '1.0'} * ${hasHi ? `step(d, hi * ${shMid})` : '1.0'} * step(0.35, tileReveal);` : `
            vTreeUv = uv;
            vTreeDist = d;
            // x: fading in from the coarser side (and newly streamed tile reveal),
            // y: fading out to the finer side. Strictly ordered smoothstep edges.
            vTreeFade = vec2(${hasHi ? `1.0 - smoothstep(hi * ${loFrac}, hi, d)` : '1.0'} * tileReveal, ${hasLo ? `smoothstep(lo * ${loFrac}, lo, d)` : '1.0'});
            float g = uAltK * ${hasLo ? `step(lo * ${loFrac}, d)` : '1.0'} * ${hasHi ? 'step(d, hi)' : '1.0'} * (0.86 + 0.14 * tileReveal);`}
            ${tier.name === 'horizon' ? `
            float r2 = fract(aRand * 7.13);
            float rim = ${RIM_M.toFixed(1)} * (0.72 + 0.28 * r2);
            g *= 1.0 - smoothstep(rim * 0.82, rim, d);
            // thin the horizon out with distance, one tree at a time
            float keep = horizonKeep(d);
            g *= 1.0 - smoothstep(keep - 0.07, keep, r2);` : ''}
            vec4 treeView = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            if (!isOrthographic && treeView.z > 40.0) g = 0.0;
            // wind: the crown leans gently, the trunk base stays put.
            // Origin-rebased wind phase prevents sway snaps on tile crossings;
            // shadow pass omits the high-frequency flutter harmonic to avoid
            // sub-texel shadow-edge sparkling under leafy canopies.
            float crush = plantPadCrush(treeBase, normalize(instanceMatrix[1].xyz), aRand, 0.46, 0.58);
            g *= 1.0 - crush;
            float lift = max(transformed.y, 0.0);
            float basePhase = treeBase.x * 0.37 + treeBase.z * 0.29;
            float p1 = basePhase + uTreeWindPhase.x + aRand * 6.283185;
            ${depthOnly ? `
            float sway = (0.62 * sin(uTreeTime * 0.85 + p1)) * (0.35 + uTreeWind.w) + 0.36;` : `
            float p2 = basePhase * 1.67 + uTreeWindPhase.y + aRand * 10.4929;
            float sway = (0.62 * sin(uTreeTime * 0.85 + p1) + 0.26 * sin(uTreeTime * 1.95 + p2))
              * (0.35 + uTreeWind.w) + 0.36;`}
            float bend = lift * lift * 0.00105 * uTreeWind.z * (1.0 - crush) * ${tier.name === 'horizon' ? '0.0' : '1.0'};
            transformed.x += uTreeWind.x * sway * bend;
            transformed.z += uTreeWind.y * sway * bend;
            ${depthOnly && tier.name === 'far' ? `
            // At 230..850 m a shadow-map texel is 1.2..2.5 m across; pad the
            // lower trunk slightly in the shadow pass so it never falls between
            // texels and leaves the crown shadow detached from its root.
            float stemMask = smoothstep(5.5, 0.8, max(transformed.y, 0.0)) * step(length(transformed.xz), 0.75);
            if (stemMask > 0.001) {
              vec2 radialXZ = length(transformed.xz) > 1e-4 ? normalize(transformed.xz) : vec2(1.0, 0.0);
              transformed.xz += radialXZ * (0.48 * stemMask);
            }` : ''}
            transformed = treeBend() * transformed;
            ${depthOnly ? '' : `
            vec3 instUp = normalize(instanceMatrix[1].xyz);
            vec3 worldN = normalize(mat3(instanceMatrix) * objectNormal);
            float upFactor = clamp(dot(worldN, instUp) * 0.5 + 0.5, 0.0, 1.0);
            vec3 localVert = (instanceMatrix * vec4(transformed * g, 1.0)).xyz;
            vec3 toCam = normalize(uCamL - localVert + vec3(1e-5));
            float backlit = pow(clamp(dot(toCam, -uTreeSunDir), 0.0, 1.0), 3.0);
            vTreeShading = vec3(aRand, upFactor, backlit);`}
            transformed *= g;
          }
          #endif`);
    if (!depthOnly) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
            uniform vec3 uTreeSunColor;
            uniform vec3 uTreeSkyColor;
            uniform vec3 uTreeGroundColor;
            uniform vec2 uTreeEnvParams;
            varying vec2 vTreeFade;
            varying vec2 vTreeUv;
            varying vec3 vTreeShading;
            varying float vTreeDist;
            // Crisp 4x4 Bayer ordered matrix: complementary across adjacent LODs
            // without salt-and-pepper noise shimmer during walking transitions.
            float treeDither(vec2 p) {
              vec2 c = mod(floor(p), 4.0);
              int idx = int(c.x) + int(c.y) * 4;
              float b = 0.0;
              if (idx == 0) b = 0.0; else if (idx == 1) b = 8.0; else if (idx == 2) b = 2.0; else if (idx == 3) b = 10.0;
              else if (idx == 4) b = 12.0; else if (idx == 5) b = 4.0; else if (idx == 6) b = 14.0; else if (idx == 7) b = 6.0;
              else if (idx == 8) b = 3.0; else if (idx == 9) b = 11.0; else if (idx == 10) b = 1.0; else if (idx == 11) b = 9.0;
              else if (idx == 12) b = 15.0; else if (idx == 13) b = 7.0; else if (idx == 14) b = 13.0; else b = 5.0;
              return (b + 0.5) / 16.0;
            }`)
        .replace('void main() {', `void main() {
            if (vTreeFade.x < 0.999 || vTreeFade.y < 0.999) {
              float n = treeDither(gl_FragCoord.xy);
              if (n > vTreeFade.x || n <= 1.0 - vTreeFade.y) discard;
            }`)
        .replace('#include <alphatest_fragment>', `#ifdef USE_ALPHATEST
            float isLeafA = step(0.5, vTreeUv.x);
            // Gently lower foliage cutoff at distance to preserve mipmap crown volume.
            float effAlphaTest = mix(0.05, alphaTest * mix(1.0, 0.72, smoothstep(55.0, 260.0, vTreeDist)), isLeafA);
            if ( diffuseColor.a < effAlphaTest ) discard;
            #endif`)
        .replace('#include <color_fragment>', `#include <color_fragment>
            #ifdef USE_COLOR
              float isLeafC = step(0.5, vTreeUv.x);
              float rA = vTreeShading.x - 0.5;
              float rB = fract(vTreeShading.x * 13.73) - 0.5;
              vec3 treeVar = mix(
                vec3(1.0 + rB * 0.08, 1.0 + rB * 0.06, 1.0 + rB * 0.04),
                vec3(1.0 + rA * 0.14 + rB * 0.12, 1.0 + rB * 0.14, 1.0 - rA * 0.12 + rB * 0.10),
                isLeafC
              );
              diffuseColor.rgb *= treeVar;
            #endif`)
        // Foliage normals describe the crown as one rounded volume. Flipping
        // them on back faces would shade the far side of every card as if it
        // faced into the tree, turning half the canopy black.
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
            #ifdef DOUBLE_SIDED
              normal *= faceDirection;
            #endif`)
        // Sky/ground hemisphere fill + sunlit leaf subsurface translucency,
        // driven by live planet lighting so crowns stay rich in daylight, glow
        // warm when backlit at sunset, and darken naturally at night.
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            #ifdef USE_COLOR
              float isLeafE = step(0.5, vTreeUv.x);
              float upK = vTreeShading.y;
              float backlit = vTreeShading.z;
              vec3 hemiFill = mix(uTreeGroundColor, uTreeSkyColor, upK) * (0.02 + 0.68 * uTreeEnvParams.y + 0.18 * uTreeEnvParams.x);
              vec3 sssTint = diffuseColor.rgb * vec3(1.18, 1.24, 0.62);
              vec3 leafTrans = sssTint * uTreeSunColor * (backlit * 0.34 * uTreeEnvParams.x) * isLeafE;
              totalEmissiveRadiance += diffuseColor.rgb * (hemiFill * mix(0.45, 0.96, isLeafE) + vec3(0.085) * uTreeEnvParams.x) + leafTrans;
            #endif`);
    }
  };
  material.customProgramCacheKey = () => 'tree-field-v4-' + tier.name + (depthOnly ? '-depth' : '');
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
    this.displayDensityTarget = 1;
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
      uRevealTime: { value: 0 },
      uTreeWind: { value: WIND },
      uTreeWindPhase: { value: new THREE.Vector2() },
      uTreeSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uTreeSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      uTreeSkyColor: { value: new THREE.Color(0.42, 0.60, 0.86) },
      uTreeGroundColor: { value: new THREE.Color(0.18, 0.22, 0.12) },
      uTreeEnvParams: { value: new THREE.Vector2(1.0, 0.16) },
      ...disturbanceUniforms(),
    };
    this.uCamL = this.uniforms.uCamL;
    this.uAltK = this.uniforms.uAltK;
    this.origin = new THREE.Vector3();
    this.cameraLocal = new THREE.Vector3();
    this.classifiedAt = new THREE.Vector3(Infinity, 0, 0);
    this.horizonClassifiedAt = new THREE.Vector3(Infinity, 0, 0);
  }

  setEnvironment(sunDirLocal, sunColor, skyColor, groundColor, sunVis = 1, hemiIntensity = 0.16) {
    if (sunDirLocal) this.uniforms.uTreeSunDir.value.copy(sunDirLocal).normalize();
    if (sunColor) this.uniforms.uTreeSunColor.value.copy(sunColor);
    if (skyColor) this.uniforms.uTreeSkyColor.value.copy(skyColor);
    if (groundColor) this.uniforms.uTreeGroundColor.value.copy(groundColor);
    this.uniforms.uTreeEnvParams.value.set(
      Math.max(0, Math.min(1, Number.isFinite(sunVis) ? sunVis : 1)),
      Math.max(0, Math.min(1, Number.isFinite(hemiIntensity) ? hemiIntensity : 0.16)),
    );
  }

  setShadowRadius(radius) {
    if (!this.tiers) return;
    const r = Number.isFinite(radius) ? radius : Infinity;
    for (const { tier, meshes } of this.tiers) {
      // Skip shadow-pass submission for tiers whose nearest caster lies outside
      // the active shadow frustum (e.g. far >= 202 m while on foot at 180 m).
      const minCasterDist = tier.lo * (1 - BAND_JITTER) * SHADOW_MID_FRAC;
      const cast = Boolean(tier.shadow && minCasterDist <= r + 24);
      for (const mesh of meshes) mesh.castShadow = cast;
    }
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
        // the planet owns the species geometry; the per-instance attributes
        // live on this field's own shallow copy
        const geometry = species.geometries[tier.geometry].clone();
        const aRand = new THREE.InstancedBufferAttribute(new Float32Array(tier.cap), 1);
        aRand.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('aRand', aRand);
        const aBorn = new THREE.InstancedBufferAttribute(new Float32Array(tier.cap).fill(-100), 1);
        aBorn.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('aBorn', aBorn);
        const foliage = { map: trees.atlas, alphaTest: 0.40, vertexColors: true, side: THREE.DoubleSide };
        // Keep uniform direct and ambient diffuse lighting across every tree
        // level so no tier flashes specular silver in sunlight.
        const crown = new THREE.MeshLambertMaterial(foliage);
        const material = applyTreeField(crown, this.uniforms, tier);
        const im = new THREE.InstancedMesh(geometry, material, tier.cap);
        im.name = 'trees:' + tier.name + ':' + species.name;
        im.count = 0;
        im.visible = false;
        im.frustumCulled = false;
        im.receiveShadow = true;
        im.castShadow = tier.shadow;
        if (tier.shadow) {
          // Slightly firmer alphaTest (0.28 vs 0.40) keeps leafy shadow silhouettes
          // solid across shadow texels without binary pinhole flickering.
          im.customDepthMaterial = applyTreeField(new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking, map: trees.atlas, alphaTest: 0.28,
            side: THREE.DoubleSide,
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
    this.horizonClassifiedAt.set(Infinity, 0, 0);
    this.uCamL.value.set(0, 0, 0);
    this.uniforms.uTreeWindPhase.value.set(0, 0);
  }

  pending() { return this.queue.length + (this.job ? 1 : 0); }

  setDisplayDensity(density) {
    // Only retarget here. The update loop eases `displayDensity` toward this
    // value in small steps, so a quality-stage change thins the forest one
    // tree at a time instead of deleting a whole batch in a single repack.
    const next = Math.max(0.35, Math.min(1, density));
    if (Math.abs(next - this.displayDensityTarget) < 0.005) return;
    this.displayDensityTarget = next;
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
      // how far the camera has moved since trees were last sorted into levels
      sortLag: this.classifiedAt.x === Infinity ? null : this.cameraLocal.distanceTo(this.classifiedAt),
    };
  }

  update(planet, camLocal, alt, budgetMs = this.streamBudgetMs) {
    if (planet !== this.planet) this.setPlanet(alt < PREWARM_BELOW ? planet : null);
    if (!this.planet) return;
    if (alt > PREWARM_BELOW) {
      for (const mesh of this.meshes) mesh.visible = false;
      return;
    }
    const p = this.planet;
    const nowMs = performance.now();
    const nowSec = nowMs * 0.001;
    this.uniforms.uRevealTime.value = nowSec;
    this.cameraLocal.copy(camLocal);
    if (this.displayDensity !== this.displayDensityTarget) {
      const step = 0.02;
      const delta = this.displayDensityTarget - this.displayDensity;
      this.displayDensity += Math.abs(delta) <= step ? delta : Math.sign(delta) * step;
      this.dirty = true;
    }
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
            want.add(`${qx}:${qy}:${qz}`);
          }
        }
      }
      this.targetKeys = want;
      this.activeKeys = new Set([...this.stableKeys, ...want]);
      this.dirty = true;

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

    // Generation is resumable and wall-clock-budgeted.
    const streamStart = performance.now();
    const deadline = streamStart + budgetMs;
    let completed = 0;
    const smoothReveal = visible && Number.isFinite(budgetMs) && this.metrics.repacks > 0;
    do {
      if (budgetMs <= 0) break;
      if (!this.job) {
        const k = this.queue.shift();
        if (k == null) break;
        this.queued.delete(k);
        if (this.tiles.has(k)) continue;
        this.job = this.createTileJob(p, k);
      }
      if (!this.stepTileJob(p, this.job, deadline)) break;
      const finished = this.finishTileJob(this.job);
      finished.bornAt = smoothReveal ? nowSec : -100;
      this.tiles.set(this.job.key, finished);
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

    this.completedSinceRepack = (this.completedSinceRepack || 0) + completed;
    let repacked = false;
    if (this.dirty) {
      const now = performance.now();
      const firstVisibleBatch = visible
        && this.meshes[0].count + this.meshes[1].count === 0 && completed > 0;
      const streamedTiles = this.completedSinceRepack > 0
        && now - this.lastRepackAt >= this.repackIntervalMs;
      if (firstVisibleBatch || this.pending() === 0 || streamedTiles) {
        this.repack();
        this.lastRepackAt = now;
        this.completedSinceRepack = 0;
        repacked = true;
      }
    }
    // the camera moved: re-sort the trees in reach into levels
    if (!repacked && visible && this.cameraLocal.distanceTo(this.classifiedAt) > RECLASSIFY_M) {
      this.repack(this.cameraLocal.distanceTo(this.horizonClassifiedAt) < 110);
    }

    // Copy disturbance records after repack() so uDistPos always uses the
    // exact render origin that the meshes will draw with on this frame.
    vegetationDisturbance.copyRelative(this.uniforms.uDistPos.value, this.uniforms.uDistData.value,
      this.origin, p.bodyId || p.seed);
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
    const Q3 = p.R / CELL_M;
    const ax = Math.abs(qx), ay = Math.abs(qy), az = Math.abs(qz);
    const major = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const minorA = major === 0 ? 1 : 0, minorB = major === 2 ? 1 : 2;
    const centre = [qx, qy, qz].map((value) => value / Q * Q3);
    const reach = Math.ceil(TILE_M / CELL_M) + 2;
    const minR = Q3 - 0.7;
    const maxR = Q3 + 0.7;
    return {
      key, qx, qy, qz, Q, origin, Q3,
      minR2: minR * minR, maxR2: maxR * maxR,
      cellAng: CELL_M / p.R,
      seedI: p.intSeed ^ 0xfa12,
      anchor: _anchor.clone(),
      major, minorA, minorB,
      majorSign: [qx, qy, qz][major] >= 0 ? 1 : -1,
      a0: Math.round(centre[minorA]) - reach, a1: Math.round(centre[minorA]) + reach,
      b0: Math.round(centre[minorB]) - reach, b1: Math.round(centre[minorB]) + reach,
      ia: Math.round(centre[minorA]) - reach, ib: Math.round(centre[minorB]) - reach,
      cell: [0, 0, 0], step: 3, ca: 0, cb: 0, cm: -1,
      m0: new Float32Array(128 * 16), n0: 0, r0: new Float32Array(128),
      m1: new Float32Array(128 * 16), n1: 0, r1: new Float32Array(128),
    };
  }

  stepTileJob(p, job, deadline) {
    const cell = job.cell;
    const densityGate = MAX_DENSITY * this.density;
    let checks = 0;
    for (;;) {
      // pause between candidates, never inside one: the cursor is resumable
      if ((++checks & 63) === 0 && performance.now() >= deadline) return false;
      if (job.step > 2) {
        if (job.ib > job.b1) return true;
        job.step = -2;
        job.ca = job.ia; job.cb = job.ib;
        job.ia++;
        if (job.ia > job.a1) { job.ia = job.a0; job.ib++; }
        const rest = job.Q3 * job.Q3 - job.ca * job.ca - job.cb * job.cb;
        job.cm = rest > 0 ? Math.round(Math.sqrt(rest)) : -1;
      }
      const offset = job.step++;
      if (job.cm < 0) { job.step = 3; continue; }
      cell[job.minorA] = job.ca;
      cell[job.minorB] = job.cb;
      cell[job.major] = job.majorSign * (job.cm + offset);
      const ux = cell[0], uy = cell[1], uz = cell[2];
      const r2 = ux * ux + uy * uy + uz * uz;
      if (r2 < job.minR2 || r2 > job.maxR2) continue;
      // Fast density pre-reject before sqrt/normalize and tile-ownership check
      const h0 = hash3i(ux, uy, uz, job.seedI);
      const sel = hashFloat(h0, 0);
      if (sel >= densityGate) continue;
      const invR = 1 / Math.sqrt(r2);
      _up.set(ux * invR, uy * invR, uz * invR);
      // the candidate belongs to THIS tile only
      if (Math.round(_up.x * job.Q) !== job.qx || Math.round(_up.y * job.Q) !== job.qy
        || Math.round(_up.z * job.Q) !== job.qz) continue;
      const temperate = p.type === 'lush' || p.type === 'ocean';
      let biome, dens;
      if (!temperate) {
        biome = p.biomeAt(_up, p.height(_up, 96));
        dens = FAR_DENSITY[biome];
        if (!dens || sel >= dens[0] * this.density) continue;
      }
      // jitter inside the cell, ground the tree at full terrain detail
      frame(_up, _ce1, _ce2);
      _jd.copy(_up)
        .addScaledVector(_ce1, (hashFloat(h0, 1) - 0.5) * job.cellAng)
        .addScaledVector(_ce2, (hashFloat(h0, 2) - 0.5) * job.cellAng)
        .normalize();
      const hh = p.height(_jd, p.fullMaxFreq);
      if (p.hasLiquid && hh < p.seaLevel + 0.6) continue;
      let cover = biome === 'forest' ? 1 : 0;
      if (temperate) {
        const moist = p.landMoisture(_jd);
        biome = p.biomeAt(_jd, hh, moist);
        dens = FAR_DENSITY[biome];
        if (!dens || !dens[0]) continue;
        cover = p.woodlandCover(_jd, p.landT(hh), moist, p.fullMaxFreq);
        if (sel >= MAX_DENSITY * cover * this.density) continue;
      }
      _p.copy(_jd).multiplyScalar(p.R + hh - 0.25).sub(job.origin);
      _q.setFromUnitVectors(Y, _jd);
      _q2.setFromAxisAngle(Y, hashFloat(h0, 1) * Math.PI * 2);
      _q.multiply(_q2);
      const sc = 0.7 + hashFloat(h0, 2) * 0.6;
      // A woodland stand closes overhead; open-country trees keep their
      // isolated silhouettes. One transform serves every distance tier.
      const spread = sc * (1 + 0.85 * cover);
      _s.set(spread, sc * (0.9 + hashFloat(h0, 0) * 0.25), spread);
      _m.compose(_p, _q, _s);
      const variant = hash3i(ux, uy, uz, job.seedI ^ 0x3d1f);
      // Choose the species at the jittered planting site, independently of
      // the roll that admits the lattice cell or sizes its tree.
      const speciesHash = hash3i(Math.round(_jd.x * job.Q3), Math.round(_jd.y * job.Q3),
        Math.round(_jd.z * job.Q3), job.seedI ^ 0xc31b);
      appendMatrix(job, hashFloat(speciesHash) < dens[1] ? 0 : 1, _m.elements, hashFloat(variant));
    }
  }

  finishTileJob(job) {
    return {
      origin: job.origin,
      bornAt: -100,
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
    const [ax, ay, az] = this.anchorK || [0, 0, 0];
    const keys = [...this.activeKeys]
      .filter((k) => this.tiles.has(k))
      .sort((a, b) => (tileDistanceSq(a, ax, ay, az) - tileDistanceSq(b, ax, ay, az))
        || compareTileKeys(a, b));
    if (!nearOnly) {
      this.horizonClassifiedAt.copy(this.cameraLocal);
      if (keys.length) this.origin.copy(this.tiles.get(keys[0]).origin);
      for (const mesh of this.meshes) mesh.position.copy(this.origin);
      // Rebase wind phase in CPU doubles so crossing tile origins never snaps sway
      const basePhase = this.origin.x * 0.37 + this.origin.z * 0.29;
      const period = Math.PI * 2;
      this.uniforms.uTreeWindPhase.value.set(basePhase % period, (basePhase * 1.67) % period);
    }
    this.uCamL.value.copy(this.cameraLocal).sub(this.origin);
    this.classifiedAt.copy(this.cameraLocal);
    _cam.copy(this.uCamL.value);

    const counts = this.tiers.map(() => [0, 0]);
    for (const k of keys) {
      const t = this.tiles.get(k);
      const bornAt = Number.isFinite(t.bornAt) ? t.bornAt : -100;
      _offset.copy(t.origin).sub(this.origin);
      // every tree of a tile is within TILE_M of its origin
      const tileDistance = Math.max(0, _offset.distanceTo(_cam) - TILE_M);
      for (let level = nearOnly ? 1 : 0; level < this.tiers.length; level++) {
        const { tier, meshes } = this.tiers[level];
        // Scale tier margin to the band width (always > RECLASSIFY_M = 20 m) so
        // near doesn't upload 2.5x extra hidden g=0 trees beyond its 98 m cutoff.
        const margin = Math.min(TIER_MARGIN_M, Math.max(RECLASSIFY_M + 10, tier.hi * 0.34));
        const reach = tier.hi * (1 + BAND_JITTER) + margin;
        if (tileDistance > reach) continue;
        const from = tier.lo * (1 - BAND_JITTER) * BAND_LO_FRAC - margin;
        for (let species = 0; species < 2; species++) {
          const source = t.m[species], rand = t.r[species];
          const available = t.n[species];
          const mesh = meshes[species];
          const target = mesh.instanceMatrix.array;
          const targetRand = mesh.geometry.getAttribute('aRand').array;
          const targetBorn = mesh.geometry.getAttribute('aBorn').array;
          let n = counts[level][species];
          if (level === 0) {
            const nearest = Math.max(0, _offset.distanceTo(_cam) - TILE_M);
            if (nearest < RIM_M) {
              for (let i = 0; i < available && n < tier.cap; i++) {
                if ((rand[i] * 53.13) % 1 >= this.displayDensity) continue;
                const x = source[i * 16 + 12] + _offset.x - _cam.x;
                const y = source[i * 16 + 13] + _offset.y - _cam.y;
                const z = source[i * 16 + 14] + _offset.z - _cam.z;
                const d = Math.sqrt(x * x + y * y + z * z);
                const r = rand[i];
                if (d > RIM_M + 180) continue;
                if ((r * 7.13) % 1 > horizonKeep(d - 180) + 0.02) continue;
                target.set(source.subarray(i * 16, i * 16 + 16), n * 16);
                target[n * 16 + 12] += _offset.x;
                target[n * 16 + 13] += _offset.y;
                target[n * 16 + 14] += _offset.z;
                targetRand[n] = r;
                targetBorn[n] = bornAt;
                n++;
              }
            }
          } else {
            for (let i = 0; i < available && n < tier.cap; i++) {
              if ((rand[i] * 53.13) % 1 >= this.displayDensity) continue;
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
              targetBorn[n] = bornAt;
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
    const born = mesh.geometry.getAttribute('aBorn');
    if (born) {
      if (born.clearUpdateRanges && born.addUpdateRange) {
        born.clearUpdateRanges();
        born.addUpdateRange(0, count);
      }
      born.needsUpdate = true;
    }
  }
}

function tileDistanceSq(key, ax, ay, az) {
  const [qx, qy, qz] = tileCoordinates(key);
  return (qx - ax) * (qx - ax) + (qy - ay) * (qy - ay) + (qz - az) * (qz - az);
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
