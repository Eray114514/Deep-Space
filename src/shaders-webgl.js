import { terrainDetailDomains, terrainDetailGLSL, bindTerrainDetailFrame } from './terrain-detail-frame.js';
import { installSurfaceAtmosphere, prepareSurfaceAtmosphere } from './surface-atmosphere.js';
import { weatherAtlasGLSL } from './cloud/weather-atlas.js';
import { hasSurfaceCloudMedium } from './cloud/surface-clouds.js';
// Shader-level beauty: a shared procedural detail texture, triplanar
// micro-detail on terrain (so close-up ground has grain, not flat vertex
// color), animated water normals, and wind sway for vegetation.
// All injected via onBeforeCompile — no custom materials, three.js keeps
// doing lights/shadows/morphs/fog for us.

import * as THREE from 'three';
import { DISTURBANCE_GLSL, disturbanceUniforms } from './vegetation/disturbance.js';
import { Simplex } from './noise.js';
import { makeRng } from './rng.js';
import { WATER_IMPULSE_CAP, waterInteraction } from './water-interaction.js';
import { SURFACE_INTERACTION_CAP, surfaceInteraction } from './surface-interaction.js';
import { surfaceMaterialSlots } from './surface-materials.js';
import { createOceanWaveField, oceanWavePhases, oceanWaveGLSL } from './ocean-wave-field.js';
import { OCEAN_ARCHETYPES } from './ocean-climate.js';
import { oceanSeconds } from './ocean-clock.js';
import { oceanWakePacketGLSL } from './ocean-wake-packet.js';
import { createOceanDetailFrame, oceanDetailOffsets, oceanDetailGLSL } from './ocean-detail-frame.js';
import { OceanRenderFrame, oceanRenderFrameGLSL } from './ocean-render-frame.js';
import { createOceanTidalEvent, oceanTidalEventUniforms, oceanTidalEventGLSL } from './ocean-tidal-event.js';

// one global clock drives water and wind everywhere
export const TIME = { value: 0 };
export function tickShaders(dt) { TIME.value += dt; }
export const WIND = new THREE.Vector4(1, 0, 0.25, 0);
export function setWeatherWind(direction = null, strength = 0, gust = 0) {
  const x = Number(direction?.x) || 0;
  const z = Number(direction?.z) || 0;
  const inverse = 1 / Math.max(1e-6, Math.hypot(x, z));
  WIND.x = x * inverse;
  WIND.y = z * inverse;
  WIND.z = THREE.MathUtils.clamp(strength, 0, 2);
  WIND.w = THREE.MathUtils.clamp(gust, 0, 1);
}

let _detailTex = null;
let _detailData = null;   // kept for CPU-side sampling (cloud transit fog)
const DETAIL_SIZE = 512;

// bilinear, wrapping sample of the detail texture on the CPU — must agree
// with what the GPU sees so fog can thicken exactly where a cloud is
export function sampleDetailCPU(u, v, ch) {
  if (!_detailData) return 0.5;
  const S = DETAIL_SIZE;
  let x = (u - Math.floor(u)) * S, y = (v - Math.floor(v)) * S;
  const x0 = x | 0, y0 = y | 0;
  const x1 = (x0 + 1) % S, y1 = (y0 + 1) % S;
  const fx = x - x0, fy = y - y0;
  const c = ch === 0 ? 0 : 1;
  const a = _detailData[(y0 * S + x0) * 4 + c], b = _detailData[(y0 * S + x1) * 4 + c];
  const d = _detailData[(y1 * S + x0) * 4 + c], e = _detailData[(y1 * S + x1) * 4 + c];
  return ((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy) / 255;
}

export function detailTexture() {
  if (_detailTex || typeof document === 'undefined') return _detailTex;
  const S = DETAIL_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n1 = new Simplex(makeRng('detail:1'));
  const n2 = new Simplex(makeRng('detail:2'));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // tileable via toroidal mapping
      const a = (x / S) * Math.PI * 2, b = (y / S) * Math.PI * 2;
      const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b);
      const v1 = n1.fbm(cx + 3, sx + cy, sy - cx, 1.5, 4, 0.55, 2.2, 1e9);
      const v2 = n2.fbm(cy - 1, sy + sx, cx + 2, 3.1, 4, 0.55, 2.2, 1e9);
      const k = (y * S + x) * 4;
      img.data[k] = (v1 * 0.5 + 0.5) * 255;
      img.data[k + 1] = (v2 * 0.5 + 0.5) * 255;
      img.data[k + 2] = 128;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  _detailData = img.data;
  _detailTex = new THREE.CanvasTexture(canvas);
  _detailTex.wrapS = _detailTex.wrapT = THREE.RepeatWrapping;
  _detailTex.colorSpace = THREE.NoColorSpace;
  return _detailTex;
}

// Release the module-level GPU/CPU caches backing the procedural detail
// texture. Intended for full-session teardown (context-loss recovery,
// hot-reload) where every consumer of this texture is being rebuilt — the
// next call to detailTexture() will regenerate both buffers from scratch.
export function disposeDetailTexture() {
  if (_detailTex) { _detailTex.dispose(); _detailTex = null; }
  _detailData = null;
}

function smooth01(lo, hi, value) {
  const t = Math.min(1, Math.max(0, (value - lo) / Math.max(hi - lo, 1e-6)));
  return t * t * (3 - 2 * t);
}

function normalized(x, y, z) {
  const k = 1 / Math.max(Math.hypot(x, y, z), 1e-6);
  return { x: x * k, y: y * k, z: z * k };
}

function stormAtCPU(d, center, phase, radius) {
  const ref = Math.abs(center.y) < 0.88 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const tangentA = normalized(
    ref.y * center.z - ref.z * center.y,
    ref.z * center.x - ref.x * center.z,
    ref.x * center.y - ref.y * center.x,
  );
  const tangentB = normalized(
    center.y * tangentA.z - center.z * tangentA.y,
    center.z * tangentA.x - center.x * tangentA.z,
    center.x * tangentA.y - center.y * tangentA.x,
  );
  const dot = Math.min(1, Math.max(-1, d.x * center.x + d.y * center.y + d.z * center.z));
  const x = d.x * tangentA.x + d.y * tangentA.y + d.z * tangentA.z;
  const y = d.x * tangentB.x + d.y * tangentB.y + d.z * tangentB.z;
  const inv = 1 / Math.max(x * x + y * y, 1e-5);
  const sin2 = 2 * x * y * inv, cos2 = (x * x - y * y) * inv;
  const r = Math.sqrt(Math.max(0, 2 * (1 - dot))) / radius;
  const shield = (1 - smooth01(0.08, 0.5, r)) * 0.58;
  const turn = phase - r * 13;
  const armWave = smooth01(0.66, 0.94,
    0.5 + 0.5 * (sin2 * Math.cos(turn) + cos2 * Math.sin(turn)));
  const arms = armWave * smooth01(0.1, 0.24, r) * (1 - smooth01(0.62, 1, r));
  return Math.max(shield, arms);
}

function cloudSystemCPU(d, ox, oy, oz) {
  const c1 = normalized(Math.sin(ox * 1.31 + 0.4), Math.sin(oy * 1.17 - 1.2) * 0.72,
    Math.cos(oz * 1.43 + 0.7));
  const ref = Math.abs(c1.y) < 0.8 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const cross = normalized(
    c1.y * ref.z - c1.z * ref.y,
    c1.z * ref.x - c1.x * ref.z,
    c1.x * ref.y - c1.y * ref.x,
  );
  const c2 = normalized(cross.x + c1.x * 0.16, cross.y + c1.y * 0.16, cross.z + c1.z * 0.16);
  return Math.max(stormAtCPU(d, c1, oz, 0.92), stormAtCPU(d, c2, ox + oy, 0.68) * 0.72);
}

function cloudSystemTexture(ox, oy, oz) {
  const width = 192, height = 192;
  const data = new Uint8Array(width * height);
  const d = { x: 0, y: 0, z: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let px = ((x + 0.5) / width) * 2 - 1;
      let pz = ((y + 0.5) / height) * 2 - 1;
      let py = 1 - Math.abs(px) - Math.abs(pz);
      if (py < 0) {
        const oldX = px;
        px = (1 - Math.abs(pz)) * Math.sign(oldX || 1);
        pz = (1 - Math.abs(oldX)) * Math.sign(pz || 1);
      }
      const inv = 1 / Math.max(Math.hypot(px, py, pz), 1e-6);
      d.x = px * inv; d.y = py * inv; d.z = pz * inv;
      data[y * width + x] = Math.round(cloudSystemCPU(d, ox, oy, oz) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// CPU twin of the GLSL cloud field below: ordinary distributed weather stays
// unchanged, while one or two independently shaped large systems are unioned
// on top instead of suppressing clear-side clouds.
export function cloudDensityCPU(d, cov0, cov1, ox, oy, oz) {
  let f = sampleDetailCPU(d.x * 0.55 + ox, d.y * 0.55 + oy, 1) * 0.5;
  f += sampleDetailCPU(d.y * 1.15 + oy, d.z * 1.15 + oz, 0) * 0.25;
  f += sampleDetailCPU(d.z * 2.35 + oz, d.x * 2.35 + ox, 1) * 0.125;
  f += sampleDetailCPU(d.x * 4.8 - ox, d.y * 4.8 - oz, 0) * 0.0625;
  f /= 0.9375;
  const base = Math.pow(smooth01(cov0, cov1, f), 1.3);
  const system = cloudSystemCPU(d, ox, oy, oz) * smooth01(0.24, 0.68, f) * 0.86;
  return Math.max(base, system);
}

export function cloudBaseDensityCPU(d, cov0, cov1, ox, oy, oz) {
  let f = sampleDetailCPU(d.x * 0.55 + ox, d.y * 0.55 + oy, 1) * 0.5;
  f += sampleDetailCPU(d.y * 1.15 + oy, d.z * 1.15 + oz, 0) * 0.25;
  f += sampleDetailCPU(d.z * 2.35 + oz, d.x * 2.35 + ox, 1) * 0.125;
  f += sampleDetailCPU(d.x * 4.8 - ox, d.y * 4.8 - oz, 0) * 0.0625;
  return Math.pow(smooth01(cov0, cov1, f / 0.9375), 1.3);
}

let _blankTex = null;
function blankTexture() {
  if (!_blankTex) {
    _blankTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    _blankTex.needsUpdate = true;
  }
  return _blankTex;
}

// Triplanar detail uses camera-relative metres plus CPU-reduced planet-local
// phases. aLocal is retained only for radial and regional-scale fields.
// Per-vertex biome weights (aMat) blend rock strata against organic mottle,
// micro-normals give relief, and the planet's own cloud layer casts moving
// shadows via one extra texture sample.
export function applyTerrainDetail(material, planet, strength = 0.2, macroK = 0.4, scale1 = 1 / 26, scale2 = 1 / 3.2) {
  const tex = detailTexture();
  if (!tex) return material;
  const detailDomains = terrainDetailDomains(scale1, scale2);
  const detailUniforms = bindTerrainDetailFrame(material, planet, detailDomains);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, detailUniforms);
    // compiled at first render — by then the planet knows if it has clouds
    const cloudTex = planet.cloudShadowTex || blankTexture();
    shader.uniforms.uDetailTex = { value: tex };
    shader.uniforms.uGrassColor = surfaceMaterialSlots.grassColor;
    shader.uniforms.uGrassNormal = surfaceMaterialSlots.grassNormal;
    shader.uniforms.uGrassOrm = surfaceMaterialSlots.grassOrm;
    shader.uniforms.uRockColor = surfaceMaterialSlots.rockColor;
    shader.uniforms.uRockNormal = surfaceMaterialSlots.rockNormal;
    shader.uniforms.uRockRoughness = surfaceMaterialSlots.rockRoughness;
    shader.uniforms.uEarthLike = { value: planet.type === 'lush' || planet.type === 'ocean' ? 1 : 0 };
    shader.uniforms.uDetailK = { value: strength };
    shader.uniforms.uMacroK = { value: macroK };
    shader.uniforms.uCloudTex = { value: cloudTex };
    material.userData.cloudShadowTextureNode = shader.uniforms.uCloudTex;
    shader.uniforms.uCloudSynoptic = { value: planet.weatherField?.synoptic ? 1 : 0 };
    shader.uniforms.uCloudK = { value: planet.cloudMesh ? 0.42 : 0 };
    shader.uniforms.uCloudMat = { value: new THREE.Matrix3() };
    shader.uniforms.uEclipseEnabled = { value: 0 };
    shader.uniforms.uEclipseCenter = { value: new THREE.Vector3() };
    shader.uniforms.uEclipseRadius = { value: 1 };
    shader.uniforms.uEclipseStarAngle = { value: 0 };
    shader.uniforms.uEclipseSunDir = { value: new THREE.Vector3(0, 1, 0) };
    const pal = planet.pal;
    shader.uniforms.uSnowK = { value: pal && pal.snow ? 1 : 0 };
    shader.uniforms.uSnowColor = { value: pal && pal.snow ? pal.snow : new THREE.Color(1, 1, 1) };
    shader.uniforms.uSnowLine = { value: pal ? pal.snowLine : 1e9 };
    shader.uniforms.uSnowBand = { value: planet.hAmp * 0.1 };
    shader.uniforms.uSnowCap = { value: pal && pal.capLat ? pal.capLat : 9.0 };
    shader.uniforms.uPlanetR = { value: planet.R };
    // the whole palette, evaluated per-pixel
    const U = planet.palU;
    shader.uniforms.uLandT = { value: U.landT };
    shader.uniforms.uLandC = { value: U.landC };
    shader.uniforms.uLandN = { value: U.landN };
    shader.uniforms.uSeaT = { value: U.seaT };
    shader.uniforms.uSeaC = { value: U.seaC };
    shader.uniforms.uSeaN = { value: U.seaN };
    shader.uniforms.uHasSea = { value: U.hasSea };
    shader.uniforms.uT0 = { value: U.t0 };
    shader.uniforms.uTSpan = { value: U.tSpan };
    shader.uniforms.uTCurve = { value: U.tCurve };
    // the meadow's base colour, matching the planted grass (scatter.js)
    shader.uniforms.uMeadowC = { value: planet.floraPal
      ? planet.floraPal.canopy.clone().offsetHSL(0, 0.12, 0.02) : new THREE.Color(0.1, 0.2, 0.05) };
    shader.uniforms.uSeaDepthSpan = { value: U.seaDepthSpan };
    shader.uniforms.uRockC = { value: U.rock };
    shader.uniforms.uSlopeLo = { value: U.slopeLo };
    shader.uniforms.uSlopeHi = { value: U.slopeHi };
    shader.uniforms.uCanopySun = { value: planet.sunDirLocal };
    shader.uniforms.uCanopyC = { value: planet.floraPal?.canopy || U.forest };
    shader.uniforms.uForestC = { value: U.forest };
    shader.uniforms.uBlotchC = { value: U.blotch };
    shader.uniforms.uStripeA = { value: U.stripeA };
    shader.uniforms.uStripeB = { value: U.stripeB };
    shader.uniforms.uStripeK = { value: U.stripeK };
    shader.uniforms.uExtraC = { value: U.extraC };
    shader.uniforms.uExtraMode = { value: U.extraMode };
    // mist pools over WATER worlds; magma seas get a whisper of heat haze,
    // not lake fog (basins on lava planets drowned in red soup otherwise)
    const mistBase = planet.liquid === 'lava' ? 0.05 : (planet.hasLiquid ? 0.26 : 0.1);
    shader.uniforms.uMistK = {
      value: mistBase * Math.min(planet.atmoDensity || 0.4, 1),
    };
    // land sits within a few hundred metres of the datum now; a 12% band
    // would hang valley mist over every plain
    shader.uniforms.uTime = TIME;
    shader.uniforms.uMistH = { value: planet.hAmp * 0.015 };
    shader.uniforms.uMistColor = { value: planet.skyColor.clone().convertSRGBToLinear() };
    const seaState = planet.oceanClimate?.seaState || null;
    const isWaterSea = planet.hasLiquid && (planet.liquid === 'water' || planet.liquid === 'toxic');
    shader.uniforms.uSeaCausticK = { value: isWaterSea ? (seaState?.causticIntensity ?? 1.0) : 0 };
    shader.uniforms.uSeaAbsorption = {
      value: new THREE.Vector3(...(planet.oceanClimate?.absorption || [0.16, 0.034, 0.016])),
    };
    shader.uniforms.uSeaScatter = {
      value: new THREE.Vector3(...(seaState?.underwaterScatter || [0.025, 0.24, 0.42])),
    };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute vec3 aLocal;
        attribute vec3 aMat;
        attribute vec2 aSurfaceHeight;
        attribute vec4 aExtra;
        attribute vec3 aPositionDelta;
        attribute vec3 aNormalDelta;
        attribute vec3 aMatDelta;
        attribute vec4 aExtraDelta;
        attribute float aLodMorph;
        varying float vSurfaceHeight;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec3 vRadialView;
        varying vec3 vMat;
        varying vec4 vExtra;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal = normalize(objectNormal + aNormalDelta * aLodMorph);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += aPositionDelta * aLodMorph;
        vSurfaceHeight = aSurfaceHeight.x + aSurfaceHeight.y * aLodMorph;
        vLocalPos = aLocal + aPositionDelta * aLodMorph;
        vLocalNrm = normalize(normal + aNormalDelta * aLodMorph);
        vRadialView = normalize(normalMatrix * normalize(vLocalPos));
        vMat = aMat + aMatDelta * aLodMorph;
        vExtra = aExtra + aExtraDelta * aLodMorph;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailTex;
        uniform float uTime;
        uniform float uSeaCausticK;
        uniform vec3 uSeaAbsorption;
        uniform vec3 uSeaScatter;
        uniform sampler2D uGrassColor;
        ${weatherAtlasGLSL}
        uniform sampler2D uGrassNormal;
        uniform sampler2D uGrassOrm;
        uniform sampler2D uRockColor;
        uniform sampler2D uRockNormal;
        uniform sampler2D uRockRoughness;
        uniform float uEarthLike;
        uniform float uDetailK;
        uniform float uMacroK;
        ${terrainDetailGLSL(detailDomains)}
        uniform sampler2D uCloudTex;
        uniform float uCloudK, uCloudSynoptic;
        uniform mat3 uCloudMat;
        uniform float uEclipseEnabled;
        uniform vec3 uEclipseCenter;
        uniform float uEclipseRadius;
        uniform float uEclipseStarAngle;
        uniform vec3 uEclipseSunDir;
        uniform float uSnowK;
        uniform vec3 uSnowColor;
        uniform float uSnowLine;
        uniform float uSnowBand;
        uniform float uSnowCap;
        uniform float uPlanetR;
        uniform float uLandT[7];
        uniform vec3 uLandC[7];
        uniform float uLandN;
        uniform float uSeaT[7];
        uniform vec3 uSeaC[7];
        uniform float uSeaN;
        uniform float uHasSea;
        uniform float uT0;
        uniform float uTSpan;
        uniform float uTCurve;
        uniform vec3 uMeadowC;
        uniform float uSeaDepthSpan;
        uniform vec3 uRockC;
        uniform float uSlopeLo;
        uniform float uSlopeHi;
        uniform vec3 uCanopySun, uCanopyC;
        uniform vec3 uForestC;
        uniform vec3 uBlotchC;
        uniform vec3 uStripeA;
        uniform vec3 uStripeB;
        uniform float uStripeK;
        uniform float uExtraMode;
        uniform vec3 uExtraC;
        uniform float uMistK;
        uniform float uMistH;
        uniform vec3 uMistColor;
        varying float vSurfaceHeight;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec3 vRadialView;
        varying vec3 vMat;
        varying vec4 vExtra;
        float gSnowW = 0.0;
        float gMeadow = 0.0;
        float gSlopeBreak = 0.0;
        float gPatch = 0.0;
        float gShoreWet = 0.0;
        float gSand = 0.0;
        float gSurfaceRoughness = 0.82;
        float eclipseVisibility(vec3 samplePosition) {
          if (uEclipseEnabled < 0.5) return 1.0;
          vec3 toOccluder = uEclipseCenter - samplePosition;
          float distanceToOccluder = length(toOccluder);
          if (distanceToOccluder <= uEclipseRadius) return 0.0;
          float angularRadius = asin(clamp(
            uEclipseRadius / distanceToOccluder, 0.0, 0.9999));
          float separation = acos(clamp(dot(normalize(toOccluder),
            normalize(uEclipseSunDir)), -1.0, 1.0));
          float penumbra = max(uEclipseStarAngle, 0.00002);
          return smoothstep(max(angularRadius - penumbra, 0.0),
            angularRadius + penumbra, separation);
        }
        vec2 surfaceMaterialUv(vec3 p, vec3 n, vec4 domain) {
          vec3 an = abs(n);
          vec3 q = p * domain.w + domain.xyz;
          if (an.x > an.y && an.x > an.z) return q.yz;
          if (an.y > an.z) return q.zx;
          return q.xy;
        }
        vec3 triScanSample(sampler2D tex, vec3 q, vec3 weights, vec2 bend, vec3 meanColor) {
          vec3 sampleColor = texture2D(tex, q.yz + bend).rgb * weights.x
            + texture2D(tex, q.zx + bend).rgb * weights.y
            + texture2D(tex, q.xy + bend).rgb * weights.z;
          return sampleColor / max(meanColor, vec3(0.02));
        }
        float triDetail(vec3 p, vec3 w, vec4 domain, int ch) {
          vec3 q = p * domain.w + domain.xyz;
          vec2 a = texture2D(uDetailTex, q.yz).rg;
          vec2 b = texture2D(uDetailTex, q.zx).rg;
          vec2 c = texture2D(uDetailTex, q.xy).rg;
          vec2 m = a * w.x + b * w.y + c * w.z;
          return ch == 0 ? m.r : m.g;
        }
        float terrainHash(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }
        float terrainField(vec3 p) {
          vec3 cell = floor(p);
          vec3 f = fract(p);
          vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
          return mix(mix(mix(terrainHash(cell), terrainHash(cell + vec3(1,0,0)), w.x),
                         mix(terrainHash(cell + vec3(0,1,0)), terrainHash(cell + vec3(1,1,0)), w.x), w.y),
                     mix(mix(terrainHash(cell + vec3(0,0,1)), terrainHash(cell + vec3(1,0,1)), w.x),
                         mix(terrainHash(cell + vec3(0,1,1)), terrainHash(cell + vec3(1,1,1)), w.x), w.y), w.z);
        }
        float terrainRegionalField(vec3 p) {
          // Rotate the second octave and warp its coordinates. Unlike a
          // repeating triplanar tile this field has no kilometre-sized stamp
          // for an orbiting camera to resolve as a woven lattice.
          float broad = terrainField(p * 0.000035);
          vec3 rotated = vec3(dot(p, vec3(0.36, 0.48, -0.8)),
            dot(p, vec3(-0.8, 0.60, 0.0)), dot(p, vec3(0.48, 0.64, 0.60)));
          float regional = terrainField(rotated * 0.00032 + broad * 2.4);
          float drainage = terrainField(rotated.yzx * 0.0011 + regional * 3.1);
          float fine = terrainField(rotated.zxy * 0.0037 + drainage * 1.8);
          return broad * 0.38 + regional * 0.30 + drainage * 0.20 + fine * 0.12;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // ---- the palette, per-pixel: exact height & slope, so coasts,
          // depth gradients and rock bands stay crisp at every distance
          vec3 nd = normalize(vLocalPos);
          float hgt = vSurfaceHeight;
          float slope = 1.0 - clamp(dot(normalize(vLocalNrm), nd), 0.0, 1.0);
          // Keep the authored forest, soil and rock provinces visible from
          // orbit too. The old distance mask removed their identity to hide
          // discontinuous source fields; those fields are continuous now.
          float vertexFieldFade = 1.0;
          float viewDist = length(vViewPosition);
          // From a full-disk orbit one terrain cell is several kilometres and
          // the mesh cannot carry the coast's bays and islets, so the shore
          // came out as the smooth outline of the coarsest octaves. Roughen
          // the height the palette reads (never the geometry) near the
          // waterline, and hand back to the real surface on approach.
          float coastFar = smoothstep(260000.0, 900000.0, viewDist) * uHasSea;
          if (coastFar > 0.001) {
            vec3 cq = vLocalPos / uPlanetR;
            float cn = (terrainField(cq * 97.0 + 1.3) - 0.5)
              + (terrainField(cq.yzx * 223.0 + 4.1) - 0.5) * 0.62
              + (terrainField(cq.zxy * 541.0 + 8.7) - 0.5) * 0.36;
            float band = 1.0 - smoothstep(0.0, uTSpan * 0.03, abs(hgt - uT0));
            hgt += cn * uTSpan * 0.011 * coastFar * band;
          }
          float pixelMetres = max(length(dFdx(vLocalPos)), length(dFdy(vLocalPos)));
          vec3 base;
          if (uHasSea > 0.5 && hgt < uT0) {
            float t = clamp(1.0 - (uT0 - hgt) / uSeaDepthSpan, 0.0, 1.0);
            base = uSeaC[0];
            for (int i = 1; i < 7; i++) {
              if (float(i) >= uSeaN) break;
              base = mix(base, uSeaC[i],
                clamp((t - uSeaT[i - 1]) / max(uSeaT[i] - uSeaT[i - 1], 1e-5), 0.0, 1.0));
            }
            float seabedDepth = uT0 - hgt;
            float shelf = (1.0 - smoothstep(2.0, 42.0, seabedDepth))
              * (1.0 - smoothstep(3500.0, 7500.0, viewDist));
            if (shelf > 0.001) {
              vec3 seaW = pow(abs(normalize(vLocalNrm)), vec3(4.0));
              seaW /= max(seaW.x + seaW.y + seaW.z, 1e-5);
              float sediment = triDetail(terrainDetailPosition(), seaW, terrainSediment, 0)
                * 0.58 + triDetail(terrainDetailPosition(), seaW, terrainSedimentFine, 1) * 0.42;
              float rippleBars = smoothstep(0.28, 0.72,
                triDetail(terrainDetailPosition(), seaW, terrainRipple, 1));
              vec3 shelfSand = uLandC[0]
                * (0.46 + sediment * 0.48 + rippleBars * 0.18);
              base = mix(base, shelfSand, shelf * 0.88);
            }
          } else {
            float t = pow(clamp((hgt - uT0) / uTSpan, 0.0, 1.0), uTCurve);
            base = uLandC[0];
            for (int i = 1; i < 7; i++) {
              if (float(i) >= uLandN) break;
              base = mix(base, uLandC[i],
                clamp((t - uLandT[i - 1]) / max(uLandT[i] - uLandT[i - 1], 1e-5), 0.0, 1.0));
            }
            // ---- climate mosaic, per pixel. Elevation alone painted every
            // lowland one green. Moisture and a latitude/altitude temperature
            // decide between dry steppe, grassland and woodland, and two
            // finer fields break the woodland edge into stands and clearings
            // so the pattern holds from orbit down to low flight.
            vec3 climateP = vLocalPos / uPlanetR;
            float moistBroad = terrainField(climateP * 2.7 + vec3(7.3, 1.9, 4.1));
            float moistMid = terrainField(vec3(dot(climateP, vec3(0.36, 0.48, -0.8)),
              dot(climateP, vec3(-0.8, 0.60, 0.0)), dot(climateP, vec3(0.48, 0.64, 0.60))) * 11.0 + moistBroad * 2.0);
            float moistFine = terrainField(climateP.yzx * 47.0 + moistMid * 1.7);
            float moisture = moistBroad * 0.5 + moistMid * 0.32 + moistFine * 0.18;
            // circulation: a dry belt either side of the equator, wet tropics
            float sinLat = abs(nd.y);
            float dryBelt = exp(-pow((sinLat - 0.42) / 0.13, 2.0));
            moisture += 0.1 * exp(-pow(sinLat / 0.16, 2.0)) - 0.2 * dryBelt;
            float standField = terrainField(vLocalPos.zxy * 0.00052) * 0.6
              + terrainField(vLocalPos * 0.0031 + 3.7) * 0.4;
            float chill = smoothstep(0.55, 0.92, abs(nd.y) + t * 0.5);
            float forestW = clamp(vExtra.x / 0.85, 0.0, 1.0);
            if (uEarthLike > 0.5) {
              // woodland mapped on the CPU (where trees are planted) keeps a
              // forest floor whatever the per-pixel moisture says
              float wooded = smoothstep(0.12, 0.4, forestW);
              float dryW = (1.0 - smoothstep(0.24, 0.42, moisture)) * (1.0 - wooded);
              vec3 steppe = mix(base, uMeadowC * vec3(1.12, 0.98, 0.68), 0.45);
              base = mix(base, steppe, dryW * 0.52);
              // the driest country is bare: pale sand and ochre rock
              float aridW = (1.0 - smoothstep(0.08, 0.22, moisture)) * (1.0 - wooded);
              base = mix(base, mix(uRockC, uLandC[0], 0.45) * vec3(0.98, 0.90, 0.74), aridW * 0.72);
              // Terrestrial ground cover shares the rock and alpine limits
              // used by the planting biomes. Snow and beaches overlay it.
              gMeadow = (1.0 - aridW * 0.85) * (1.0 - dryW * 0.22) * (1.0 - chill)
                * (1.0 - smoothstep(uSlopeLo, uSlopeHi, slope)) * smoothstep(0.012, 0.05, t)
                * (1.0 - smoothstep(0.47, 0.61, t));
              vec3 tundra = mix(uRockC, base, 0.35) * vec3(0.96, 0.94, 0.9);
              base = mix(base, tundra, chill * 0.7);
              forestW = max(smoothstep(0.3, 0.62, forestW * 0.75 + (moisture - 0.5) * 0.9
                + (standField - 0.5) * 0.8) * (1.0 - chill * 0.8)
                * smoothstep(0.02, 0.07, t) * (1.0 - smoothstep(0.42, 0.56, t)),
                wooded * (0.6 + 0.4 * standField));
              // Ground around scattered tree groves shifts toward a fertile
              // mossy under-story instead of bare sand.
              float groveFloor = smoothstep(0.03, 0.40, vExtra.w) * (1.0 - chill);
              base = mix(base, mix(uMeadowC * 0.78, uForestC, 0.52), groveFloor * 0.55);
              base *= 0.9 + 0.2 * terrainField(vLocalPos.yxz * 0.00017 + 9.1);
              // wet country is deeper and bluer-green, dry country warmer
              float wetW = smoothstep(0.46, 0.7, moisture);
              base = mix(base, base * vec3(0.72, 0.9, 0.78), wetW * 0.6);
            } else {
              base *= 0.86 + 0.28 * moisture;
              forestW *= 0.85;
            }
            base = mix(base, uForestC, forestW * 0.85 * vertexFieldFade);
            // As trees thin with range, resolve crown groups and their sun-facing
            // shoulders on the terrain itself. Filter each scale by pixel footprint.
            float canopyCover = uEarthLike * smoothstep(0.08, 0.88, vExtra.w + (standField - 0.5) * 0.42)
              * smoothstep(35.0, 310.0, viewDist);
            if (canopyCover > 0.001) {
              vec3 sunTangent = uCanopySun - nd * dot(nd, uCanopySun);
              mat3 groveFrame = mat3(0.36, 0.48, -0.8, -0.8, 0.60, 0.0, 0.48, 0.64, 0.60);
              vec3 groveP = groveFrame * vLocalPos * 0.012 + standField * vec3(2.3, -3.1, 1.7);
              float grove = terrainField(groveP);
              float coarse = 1.0 - smoothstep(12.0, 68.0, pixelMetres);
              vec3 q = groveFrame * groveP.yzx * 5.42 + grove * vec3(-1.3, 1.6, 2.1);
              float crown = terrainField(q);
              float lit = crown - terrainField(q + groveFrame * (groveFrame * sunTangent).yzx * 0.58);
              float fine = 1.0 - smoothstep(2.5, 14.0, pixelMetres);
              float gaps = mix(0.84, 0.42 + 0.58 * smoothstep(0.18, 0.58, grove), coarse);
              float shoulders = grove - terrainField(groveP + groveFrame * sunTangent * 0.264);
              float sunlight = smoothstep(-0.01, 0.30, dot(nd, uCanopySun)) * vMat.z;
              vec3 leaves = uCanopyC * max(0.22, 0.88 + (standField - 0.5) * 0.85
                + coarse * ((grove - 0.5) * 1.1 + shoulders * 1.2 * sunlight)
                + fine * ((crown - 0.5) * 0.86 + lit * 1.6 * sunlight));
              base = mix(base, leaves, canopyCover * gaps);
            }
            base = mix(base, uBlotchC, vExtra.y * vertexFieldFade);
            if (uStripeK > 0.001) base = mix(base,
              mix(uStripeA, uStripeB, vExtra.z), uStripeK * vertexFieldFade);
            if (uExtraMode > 2.5) base *= 1.0
              + (vExtra.w - 0.5) * 0.2 * vertexFieldFade;
            else if (uExtraMode > 0.5) base = mix(base, uExtraC,
              vExtra.w * vertexFieldFade);
            base = mix(base, uRockC, smoothstep(uSlopeLo, uSlopeHi, slope)
              * mix(0.18, 1.0, vertexFieldFade));
          }
          if (!(uHasSea > 0.5 && hgt < uT0)) {
            // ---- ground mottle from 30 m to 3 km: soil showing through
            // thin cover, greener hollows, paler rises. Each octave fades
            // out before it would alias, so nothing sparkles at altitude.
            float mA = terrainField(vLocalPos.zxy * 0.00041 + 5.3);
            float mB = terrainField(vLocalPos * 0.0019 + mA * 2.0);
            float mC = terrainField(vLocalPos.yzx * 0.0083 + mB * 1.5);
            float mD = terrainField(vLocalPos * 0.034 + 1.7);
            float fadeB = 1.0 - smoothstep(60000.0, 160000.0, viewDist);
            float fadeC = 1.0 - smoothstep(14000.0, 40000.0, viewDist);
            float fadeD = 1.0 - smoothstep(3000.0, 9000.0, viewDist);
            float mottle = (mA - 0.5) * 0.9 + (mB - 0.5) * 0.7 * fadeB
              + (mC - 0.5) * 0.5 * fadeC + (mD - 0.5) * 0.35 * fadeD;
            vec3 lean = mix(vec3(1.04, 1.0, 0.90), vec3(0.86, 1.0, 0.92), clamp(mottle + 0.5, 0.0, 1.0));
            base *= mix(vec3(1.0), lean, 0.42) * (1.0 + mottle * 0.30);
            // Grass blades disappear at tens of metres. Keep their living colour
            // and multi-scale structure in the turf across 20..2000 m, with
            // stony soil breaks on rolling slope faces.
            float meadow = gMeadow * (1.0 - smoothstep(0.22, 0.82, vExtra.w))
              * (1.0 - smoothstep(18.0, 110.0, pixelMetres));
            if (meadow > 0.001) {
              vec3 groundN = normalize(vLocalNrm);
              float slopeAng = sqrt(max(0.0, slope * (2.0 - slope)));
              // Long-term exposure depends on slope and latitude, even
              // when the current sun has moved to the other side of the sky.
              vec3 poleward = (vec3(0, 1, 0) - nd * nd.y) * sign(nd.y);
              float exposure = -dot(groundN, poleward);
              float dryBank = smoothstep(0.36, 0.72,
                mB * 0.30 + mC * 0.42 + mD * 0.28 + exposure * 0.32);
              // Sample the ground scans in two independent, phase-stable
              // domains (terrainDetailPosition) so nothing swims or tiles.
              vec3 rel = terrainDetailPosition();
              vec3 weights = pow(abs(groundN), vec3(6.0));
              weights /= max(dot(weights, vec3(1.0)), 1e-5);
              vec3 uv = rel * terrainSward.w + terrainSward.xyz;
              vec3 broadUv = rel * terrainHeath.w + terrainHeath.xyz;
              vec3 grassMean = max(textureLod(uGrassColor, vec2(0.5), 12.0).rgb, vec3(0.02));
              vec3 rockMean = max(textureLod(uRockColor, vec2(0.5), 12.0).rgb, vec3(0.02));
              vec3 swardScan = clamp(triScanSample(uGrassColor, uv, weights,
                vec2(mC, mD) * 0.46, grassMean), vec3(0.32), vec3(1.85));
              vec3 heathScan = clamp(triScanSample(uGrassColor, -broadUv.zyx, weights.zyx,
                vec2(mB, mC) * 0.73, grassMean), vec3(0.36), vec3(1.75));
              float fibre = dot(swardScan, vec3(0.2126, 0.7152, 0.0722));
              float breaks = dot(heathScan, vec3(0.2126, 0.7152, 0.0722));
              // Phase-stable turf hummock relief from terrainGrain (no Float32 vLocalPos).
              float tuft = triDetail(rel, weights, terrainGrain, 0);
              vec3 sunTangent = uCanopySun - nd * dot(nd, uCanopySun);
              float shoulder = tuft - triDetail(rel + sunTangent * 3.2, weights, terrainGrain, 0);
              float resolved = 1.0 - smoothstep(2.5, 28.0, pixelMetres);
              float lit = smoothstep(0.01, 0.3, dot(groundN, uCanopySun)) * vMat.z;
              vec3 lush = mix(base, uMeadowC * vec3(0.78, 0.94, 0.80), 0.76);
              vec3 drySward = mix(lush, uMeadowC * vec3(1.24, 1.08, 0.68), 0.58);
              vec3 swardTex = mix(vec3(1.0), swardScan, 0.55) * mix(vec3(1.0), heathScan, 0.35);
              vec3 sward = mix(lush, drySward, smoothstep(0.12, 0.95,
                dryBank * 0.72 + (breaks - 0.85) * 0.55));
              sward *= swardTex * (0.68 + 0.32 * clamp(fibre, 0.4, 1.7))
                * (0.78 + 0.22 * clamp(breaks, 0.4, 1.6));
              sward *= 1.0 + resolved * (0.24 * (tuft - 0.5) + 0.70 * shoulder * lit);
              // Steeper rolling hillside shoulders expose stony soil breaks.
              float slopeBreak = smoothstep(0.11, 0.30,
                slopeAng + (1.0 - breaks) * 0.12 + (dryBank - 0.5) * 0.08);
              gSlopeBreak = slopeBreak * meadow;
              vec3 rockScan = clamp(triScanSample(uRockColor, -uv.zyx + vec3(0.37, 0.71, 0.19), weights.zyx,
                vec2(mD, mB) * 0.35, rockMean), vec3(0.32), vec3(1.85));
              vec3 slopeSoil = mix(uRockC * vec3(0.95, 0.92, 0.86),
                base * vec3(0.74, 0.68, 0.56), 0.35) * mix(vec3(1.0), rockScan, 0.78);
              sward = mix(sward, slopeSoil, slopeBreak * 0.68);
              base = mix(base, sward, meadow);
            }
            // Exposed terrestrial bedding reads across a valley, beyond the
            // range of the metre-scale rock scan. Warped heights and broken
            // exposures keep the bands local to the outcrop.
            float exposed = uEarthLike * smoothstep(0.095, 0.34, slope);
            if (exposed > 0.001) {
              float bedding = hgt + 95.0 * mA + 37.0 * mB;
              float seam = terrainField(vec3(bedding * 0.021, mA * 1.4, 11.7));
              float layers = smoothstep(0.29, 0.7, seam) - 0.5;
              layers *= 1.0 - smoothstep(12.0, 70.0, pixelMetres);
              vec3 shale = mix(vec3(0.64, 0.70, 0.74), vec3(1.16, 1.09, 0.97), mC);
              base *= mix(vec3(1.0), shale * (0.92 + 0.52 * layers), exposed);
            }
          }
          // Sheltered, low-gradient shores collect pale sand. Rock projects
          // through exposed banks and promontories, including underwater;
          // the strand narrows with slope instead of outlining every coast.
          float shoreHeight = hgt - uT0;
          if (uEarthLike > 0.5 && uHasSea > 0.5 && abs(shoreHeight) < 36.0) {
            float exposure = terrainField(vLocalPos * 0.00071 + 13.6);
            float gravel = terrainField(vLocalPos.zxy * 0.0087 + exposure * 2.4);
            float rocky = smoothstep(0.012, 0.085, slope + (exposure - 0.5) * 0.055);
            float upperBeach = mix(3.0, 15.0, 1.0 - exposure);
            float strand = (1.0 - smoothstep(upperBeach * 0.48, upperBeach, shoreHeight))
              * smoothstep(-34.0, -9.0, shoreHeight);
            gSand = strand * (1.0 - rocky);
            vec3 sand = uLandC[0] * vec3(1.05, 1.01, 0.91) * (0.82 + gravel * 0.36);
            vec3 outcrop = uRockC * (0.60 + 0.54 * gravel);
            base = mix(base, mix(sand, outcrop, rocky), strand * 0.86);
          }
          diffuseColor.rgb = base;

          // ---- baked ray-marched sun shadows: mountains shade whole
          // valleys, kilometres beyond the realtime shadow map's reach
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.78, 0.82, 0.9),
            diffuseColor.rgb, vMat.z);

          // ---- micro grain, biome-styled (gated by resolved camera distance)
          vec3 w = pow(abs(normalize(vLocalNrm)), vec3(4.0));
          w /= max(w.x + w.y + w.z, 1e-5);
          if (uHasSea > 0.5 && hgt >= uT0 && hgt - uT0 < 3.6 && viewDist < 4500.0) {
            float shoreDrift = triDetail(terrainDetailPosition(), w, terrainShore, 1)
              + triDetail(terrainDetailPosition(), w, terrainShoreFine, 0) - 1.0;
            float wetReach = 2.4 + shoreDrift * 1.1;
            gShoreWet = (1.0 - smoothstep(0.2, wetReach, hgt - uT0))
              * (1.0 - smoothstep(2800.0, 4500.0, viewDist));
            diffuseColor.rgb = mix(diffuseColor.rgb,
              diffuseColor.rgb * vec3(0.56, 0.65, 0.69), gShoreWet * 0.80);
          }
          // ---- submerged seabed optics: Beer-Lambert spectral tinting and
          // crisp multi-wave optical caustic webs visible both from above clear
          // shallows and while diving underwater.
          if (uHasSea > 0.5 && uSeaCausticK > 0.001 && hgt < uT0 && viewDist < 6500.0) {
            float subDepth = max(0.0, uT0 - hgt);
            float subFade = 1.0 - smoothstep(3200.0, 6500.0, viewDist);
            vec3 depthAtten = exp(-uSeaAbsorption * min(subDepth, 75.0) * 0.82);
            vec3 scatterFloor = clamp(uSeaScatter * 2.2, vec3(0.03), vec3(0.75));
            diffuseColor.rgb = mix(diffuseColor.rgb,
              diffuseColor.rgb * mix(scatterFloor, depthAtten, 0.78)
                + uSeaScatter * (1.0 - depthAtten) * 0.16,
              smoothstep(0.0, 2.4, subDepth) * subFade * 0.86);
            float sunElev = smoothstep(-0.02, 0.24, dot(nd, uCanopySun));
            float nDotSun = max(0.0, dot(normalize(vLocalNrm), uCanopySun));
            float causticMask = smoothstep(0.0, 0.45, subDepth) * exp(-subDepth * 0.042)
              * sunElev * (0.30 + 0.70 * nDotSun) * vMat.z * subFade;
            if (causticMask > 0.002) {
              vec3 cRef = abs(nd.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
              vec3 cT = normalize(cross(cRef, nd));
              vec3 cB = cross(nd, cT);
              vec3 relP = terrainDetailPosition() + uCanopySun * (subDepth * 0.24);
              // Analytic 3-wave warped interference lattice -> crisp luminous caustic filaments
              vec2 cp = vec2(dot(relP, cT), dot(relP, cB)) * 0.62;
              float ct = uTime * 1.15;
              vec2 w1 = cp + vec2(sin(cp.y * 0.7 + ct * 0.8), cos(cp.x * 0.7 - ct * 0.65)) * 0.85;
              vec2 w2 = mat2(0.82, -0.57, 0.57, 0.82) * cp * 1.38
                + vec2(cos(cp.y * 0.9 - ct * 0.95), sin(cp.x * 0.85 + ct * 0.72)) * 0.75;
              float g1 = abs(sin(w1.x + ct * 0.5) + cos(w1.y - ct * 0.42));
              float g2 = abs(sin(w2.x - ct * 0.62) + cos(w2.y + ct * 0.54));
              float net1 = pow(clamp(1.0 - g1 * 0.62, 0.0, 1.0), 4.0);
              float net2 = pow(clamp(1.0 - g2 * 0.62, 0.0, 1.0), 4.0);
              float causticWeb = clamp((net1 * 0.85 + net2 * 0.75 + net1 * net2 * 1.4), 0.0, 1.6)
                * (1.0 - smoothstep(0.9, 8.5, pixelMetres));
              vec3 causticSpectral = depthAtten / max(max(depthAtten.r, max(depthAtten.g, depthAtten.b)), 0.08);
              vec3 causticTint = mix(causticSpectral, vec3(1.0, 0.98, 0.92), exp(-subDepth * 0.22));
              // Darken inter-filament cells slightly and brighten glowing caustic webs for high contrast
              diffuseColor.rgb *= mix(1.0, 0.62 + causticWeb * 1.15 * uSeaCausticK, clamp(causticMask, 0.0, 0.94));
              diffuseColor.rgb += causticTint * causticWeb * causticMask * uSeaCausticK * 0.85;
            }
          }
          float grainNear = 1.0 - smoothstep(2500.0, 9500.0, viewDist);
          if (grainNear > 0.001) {
            float grain = (triDetail(terrainDetailPosition(), w, terrainGrain, 0) - 0.5)
                        + (triDetail(terrainDetailPosition(), w, terrainGrainFine, 1) - 0.5) * 0.8;
            float strat = texture2D(uDetailTex, vec2(vSurfaceHeight * 0.055, 0.31)).r - 0.5;
            float d = mix(grain, grain * 0.5 + strat * 1.15,
              vMat.x * vertexFieldFade);
            if (vMat.y > 0.002) {
              d += (triDetail(terrainDetailPosition(), w, terrainOrganic, 0) - 0.5)
                * vMat.y * vertexFieldFade * 0.75;
            }
            diffuseColor.rgb *= 1.0 + d * uDetailK * grainNear;
          }

          float pbrNear = 1.0 - smoothstep(70.0, 720.0, viewDist);
          if (pbrNear > 0.001) {
            float pbrRock = max(smoothstep(uSlopeLo, uSlopeHi, slope), gSlopeBreak * 0.7);
            vec2 pbrUv = surfaceMaterialUv(terrainDetailPosition(), normalize(vLocalNrm), terrainGrass);
            vec2 pbrRockUv = surfaceMaterialUv(terrainDetailPosition(), normalize(vLocalNrm), terrainRock);
            // The scans are tints around their own average colour: divide by
            // that average (their last mip) so the near ground keeps the
            // planet palette and gains the scan's full contrast. Scaling the
            // raw texel instead pushed every value under the clamp floor and
            // left one flat darkened olive.
            vec3 grassMean = max(textureLod(uGrassColor, vec2(0.5), 12.0).rgb, vec3(0.02));
            vec3 rockMean = max(textureLod(uRockColor, vec2(0.5), 12.0).rgb, vec3(0.02));
            vec3 pbrGrass = texture2D(uGrassColor, pbrUv).rgb / grassMean;
            vec3 pbrStone = texture2D(uRockColor, pbrRockUv).rgb / rockMean;
            // a second, rotated and larger sampling breaks up the 12 m tile
            vec3 pbrGrass2 = texture2D(uGrassColor, vec2(pbrUv.y, -pbrUv.x) * 0.31 + vec2(0.37, 0.71)).rgb / grassMean;
            vec3 pbrStone2 = texture2D(uRockColor, vec2(-pbrRockUv.y, pbrRockUv.x) * 0.27 + vec2(0.13, 0.52)).rgb / rockMean;
            vec3 pbrSample = mix(pbrGrass * (0.55 + 0.45 * pbrGrass2), pbrStone * (0.6 + 0.4 * pbrStone2), pbrRock);
            float pbrLum = dot(pbrSample, vec3(0.2126, 0.7152, 0.0722));
            // keep the planet's hue on alien worlds, the scan's on earth-like ones
            vec3 pbrStructure = mix(vec3(pbrLum), pbrSample, 0.25 + uEarthLike * 0.45);
            pbrStructure = clamp(pbrStructure, vec3(0.25), vec3(2.2));
            // Inside the 3D grass ring (~20..62 m), keep subtle root shade
            // matching the sward rather than creating a dark ring past 100 m.
            float meadowNear = gMeadow * (1.0 - gSand) * (1.0 - gSlopeBreak * 0.8)
              * (1.0 - smoothstep(18.0, 62.0, viewDist));
            vec3 swardBase = mix(diffuseColor.rgb, uMeadowC * 0.68, 0.42)
              * mix(vec3(1.0), pbrStructure, 0.62);
            // Sand carries fine granular contrast without the green blades
            // and deep crevices photographed in the grassland scan.
            diffuseColor.rgb *= mix(vec3(1.0), mix(pbrStructure, vec3(0.83 + 0.17 * pbrLum), gSand),
              pbrNear * 0.85 * (1.0 - meadowNear * 0.65));
            diffuseColor.rgb = mix(diffuseColor.rgb, swardBase, meadowNear * 0.65);
            gSurfaceRoughness = mix(texture2D(uGrassOrm, pbrUv).g,
              texture2D(uRockRoughness, pbrRockUv).r, pbrRock);
          }

          // ---- continental-scale tint drift: dry-brown swathes
          float macro = terrainRegionalField(vLocalPos) * 2.0 - 1.0;
          float mw = clamp(macro * 1.5 + 0.5, 0.0, 1.0) * uMacroK;
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.04, 0.99, 0.90), mw);
          diffuseColor.rgb *= 1.0 + macro * 0.48 * uMacroK;

          // ---- mid-scale patchiness (~100–500 m)
          float patchNear = 1.0 - smoothstep(1800.0, 10000.0, viewDist);
          if (patchNear > 0.001) {
            float pch = (triDetail(terrainDetailPosition(), w, terrainPatch, 1)
                       + triDetail(terrainDetailPosition(), w, terrainPatchFine, 0) - 1.0) * patchNear;
            gPatch = pch;
            diffuseColor.rgb *= 1.0 + pch * (0.30 + 0.20 * vMat.z) * (0.5 + uMacroK);
            diffuseColor.rgb = mix(diffuseColor.rgb,
              diffuseColor.rgb * vec3(0.88, 0.97, 0.92),
              clamp(-pch * 1.8, 0.0, 0.5) * uMacroK);
          }

          // ---- per-pixel snowline: crisp caps from orbit
          if (uSnowK > 0.5) {
            float lat = abs(nd.y) + (texture2D(uDetailTex, nd.xz * 2.0 + nd.y).r - 0.5) * 0.12;
            float sl = uSnowLine * (1.0 - 0.65 * smoothstep(0.45, 0.95, lat));
            // a broken snowline: drifts reach down gullies, rock shows above
            float snowH = hgt + (terrainField(vLocalPos * 0.00075 + 2.9) - 0.5) * uSnowBand * 2.6
              + (terrainField(vLocalPos.zxy * 0.0052) - 0.5) * uSnowBand * 1.1;
            float sw = smoothstep(sl, sl + uSnowBand * 0.55, snowH);
            sw = max(sw, smoothstep(uSnowCap, uSnowCap + 0.07, lat));
            sw *= 1.0 - smoothstep(0.2, 0.42, slope) * 0.9;
            diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, sw);
            gSnowW = sw;
          }
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // snow glints, damp hollows go faintly glossy, dry rises stay matte —
        // low-sun specular variation is a big part of ground reading as real
        roughnessFactor = clamp(roughnessFactor - gSnowW * 0.34
          - gShoreWet * 0.38 + gPatch * 0.12, 0.24, 1.0);
        float pbrNearRough = 1.0 - smoothstep(70.0, 720.0, length(vViewPosition));
        roughnessFactor = mix(roughnessFactor, clamp(gSurfaceRoughness, 0.38, 1.0), pbrNearRough * 0.35);`)
      .replace('#include <fog_fragment>', `
        #ifdef USE_FOG
        {
          // valley mist: haze pools in the low country and thickens with
          // distance — the depth cue that sells scale from altitude
          float mist = uMistK
            * smoothstep(uMistH, 0.0, vSurfaceHeight - uT0)
            * (1.0 - exp(-vFogDepth * 3.2e-4));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uMistColor, clamp(mist, 0.0, 0.6));
        }
        #endif
        #include <fog_fragment>`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          normal = normalize(normal);
          float viewDistNrm = length(vViewPosition);
          float pixelMetresNrm = max(length(dFdx(vLocalPos)), length(dFdy(vLocalPos)));
          float normalVertexFieldFade = 1.0 - smoothstep(4500.0, 24000.0, viewDistNrm);
          if (normalVertexFieldFade > 0.001) {
            vec3 locN = normalize(vLocalNrm);
            vec3 refAxis = abs(locN.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
            vec3 locT = normalize(cross(refAxis, locN));
            vec3 locB = cross(locN, locT);
            vec3 wN = pow(abs(locN), vec3(4.0));
            wN /= max(wN.x + wN.y + wN.z, 1e-5);
            vec3 detailPos = terrainDetailPosition();
            float gx = triDetail(detailPos + locT * 0.35, wN, terrainGrainFine, 1)
                     - triDetail(detailPos - locT * 0.35, wN, terrainGrainFine, 1);
            float gy = triDetail(detailPos + locB * 0.35, wN, terrainGrainFine, 1)
                     - triDetail(detailPos - locB * 0.35, wN, terrainGrainFine, 1);
            // Mid-altitude turf swells & erosion micro-topography (26..110 m).
            float grainMid = 1.0 - smoothstep(14.0, 110.0, pixelMetresNrm);
            if (grainMid > 0.001) {
              gx += (triDetail(detailPos + locT * 1.8, wN, terrainGrain, 0)
                   - triDetail(detailPos - locT * 1.8, wN, terrainGrain, 0)) * 1.35 * grainMid;
              gy += (triDetail(detailPos + locB * 1.8, wN, terrainGrain, 0)
                   - triDetail(detailPos - locB * 1.8, wN, terrainGrain, 0)) * 1.35 * grainMid;
            }
            float scanNear = 1.0 - smoothstep(35.0, 420.0, viewDistNrm);
            float swardScanNear = (1.0 - smoothstep(10.0, 65.0, pixelMetresNrm)) * uEarthLike;
            if (scanNear > 0.001 || swardScanNear > 0.001) {
              vec3 ndPbr = normalize(vLocalPos);
              float slopePbr = 1.0 - clamp(dot(locN, ndPbr), 0.0, 1.0);
              float rockPbr = max(smoothstep(uSlopeLo, uSlopeHi, slopePbr), gSlopeBreak * 0.7);
              if (scanNear > 0.001) {
                vec2 uvPbr = surfaceMaterialUv(detailPos, locN, terrainGrass);
                vec2 uvRockPbr = surfaceMaterialUv(detailPos, locN, terrainRock);
                vec2 grassN = texture2D(uGrassNormal, uvPbr).xy * 2.0 - 1.0;
                vec2 rockN = texture2D(uRockNormal, uvRockPbr).xy * 2.0 - 1.0;
                vec2 scanN = mix(grassN, rockN, rockPbr);
                gx += scanN.x * scanNear * 0.36;
                gy += scanN.y * scanNear * 0.36;
              }
              if (swardScanNear > 0.001) {
                vec2 uvSward = surfaceMaterialUv(detailPos, locN, terrainSward);
                vec2 sGrassN = texture2D(uGrassNormal, uvSward).xy * 2.0 - 1.0;
                vec2 sRockN = texture2D(uRockNormal, vec2(-uvSward.y, uvSward.x) + vec2(0.37, 0.71)).xy * 2.0 - 1.0;
                vec2 sScanN = mix(sGrassN, sRockN, rockPbr);
                gx += sScanN.x * swardScanNear * 0.30;
                gy += sScanN.y * swardScanNear * 0.30;
              }
            }
            vec3 localPerturb = (locT * gx + locB * gy) * uDetailK
              * normalVertexFieldFade
              * (1.7 + vMat.x * normalVertexFieldFade * 1.5);
            normal = normalize(normal + localPerturb * uTerrainViewToLocal);
          }
        }`);
    installSurfaceAtmosphere(material, planet, shader);
  };
  material.customProgramCacheKey = () => 'terrain-layered-pbr-v27-bedding-' + hasSurfaceCloudMedium(planet);
  return prepareSurfaceAtmosphere(material, planet);
}

// Living water combines a deterministic gravity-wave cascade, a camera-local
// geometry patch, spectral water-column transport and live sky/cloud light.
// The closed globe remains deliberately coarse; only the optical near field
// spends vertices on displaced waves.
export function applyWaterWaves(material, planet, waveScale = 1 / 14) {
  const tex = detailTexture();
  if (!tex) return material;
  const clarity = Math.max(0.25, planet?.waterStyle?.clarity || 1);
  const depthScale = Math.max(60,
    ((planet?.seaLevel ?? 0) + (planet?.hAmp ?? 1200) * 0.6) * clarity);
  const extinctionValues = planet?.oceanClimate?.absorption
    || [1.8, 1.2, 0.6].map((value) => value * 2.3 / (0.9 * depthScale));
  const oceanField = planet.oceanSurface?.waveField || createOceanWaveField(planet.seed, {
    gravity: planet.gravity,
    period: planet.oceanClimate?.swellPeriod || 10,
  });
  const tidalField = planet.oceanSurface?.tidalField || (planet.oceanClimate?.event
    ? createOceanTidalEvent(planet.oceanClimate.event, { radius: planet.seaRadius, gravity: planet.gravity }) : null);
  const tidalGLSL = tidalField ? oceanTidalEventGLSL
    : 'vec4 oceanTidalEvent(vec3 p, float depth) { return vec4(0.0); }';
  const wavelengths = oceanField.modes.map((mode) => Math.PI * 2 / mode.k);
  const amplitudes = oceanField.modes.map((mode) => mode.weight * oceanField.normalization * 2);

  material.depthWrite = true;
  // The water shader owns its optical surface. Shallows reveal the real
  // terrain through controlled alpha below; the unreliable engine-level
  // transmission variant remains disabled by the material contract.
  material.transparent = true;
  // The custom optical pass below owns solar glints and the reflected sky.
  // Leaving MeshPhysicalMaterial's white direct lobe at its default strength
  // reintroduced a clipped pillar and revealed every long-wave crest as a
  // parallel rail at sunset, independently of the authored chromatic path.
  material.specularIntensity = 0.0;
  material.polygonOffset = false;
  material.forceSinglePass = true;
  material.opacity = 1;
  material.userData.waterProfile = {
    model: 'regional-ocean-wave-field-webgl-v2',
    depthScale,
    extinction: extinctionValues,
    extinctionUnits: 'inverse-metres',
    depthHaze: { distance: depthScale * 0.4, strength: 0.9 },
    spectrum: {
      wavelengths,
      amplitudes,
      nearPatchCellMetres: 4,
    },
    dryShellDiscard: true,
    directionalWake: true,
  };
  const unitAxis = (a) => {
    const inv = 1 / Math.hypot(a[0], a[1], a[2]);
    return [a[0] * inv, a[1] * inv, a[2] * inv];
  };
  const crossAxis = (a, b) => unitAxis([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
  const mesoA0 = unitAxis([-0.412, 0.793, -0.449]);
  const mesoB0 = crossAxis(mesoA0, [0.23, 0.41, 0.88]);
  const mesoA1 = unitAxis([0.618, -0.341, 0.708]);
  const mesoB1 = crossAxis(mesoA1, [0.47, 0.78, -0.41]);
  const mesoScale0 = 0.014;
  const mesoScale1 = 0.0055;
  const fract01 = (v) => v - Math.floor(v);
  const dot3 = (a, p) => a[0] * p.x + a[1] * p.y + a[2] * p.z;
  const glslVec3 = (a) => `vec3(${a.map((v) => Number(v).toPrecision(17)).join(', ')})`;

  const resolveOceanOptics = () => {
    const absorption = planet?.oceanClimate?.absorption || extinctionValues;
    const tx = absorption.map((a) => Math.exp(-a * 16));
    const txMax = Math.max(tx[0], tx[1], tx[2], 1e-4);
    const txNorm = tx.map((v) => v / txMax);
    const deep = planet?.pal?.sea
      ? planet.pal.sea[0].c.clone().lerp(planet.liquidColor, 0.34)
      : new THREE.Color(0.02, 0.08, 0.15);
    let shelf = planet?.pal?.sea
      ? planet.pal.sea[planet.pal.sea.length - 1].c.clone().lerp(planet.liquidColor, 0.28)
      : new THREE.Color(0.06, 0.25, 0.30);
    let shallow = planet
      ? planet.liquidColor.clone().lerp(new THREE.Color(0.16, 0.72, 0.62), 0.38)
      : new THREE.Color(0.12, 0.56, 0.62);
    if (planet?.oceanClimate) {
      deep.setRGB(...planet.oceanClimate.scatter);
      shelf = deep.clone().multiplyScalar(1.05).add(
        new THREE.Color(txNorm[0] * 0.13, txNorm[1] * 0.13, txNorm[2] * 0.13));
      const sand = planet?.pal?.land?.[0]?.c;
      if (sand) {
        const sandTx = new THREE.Color(
          sand.r * Math.exp(-absorption[0] * 4.5),
          sand.g * Math.exp(-absorption[1] * 4.5),
          sand.b * Math.exp(-absorption[2] * 4.5),
        );
        shallow = shelf.clone().multiplyScalar(1.45).lerp(sandTx, 0.36);
      } else {
        shallow = shelf.clone().multiplyScalar(1.55);
      }
    }
    return { absorption, deep, shelf, shallow };
  };
  const initialOptics = resolveOceanOptics();
  const shelfSpan = THREE.MathUtils.clamp(
    (planet?.palU?.seaDepthSpan || (planet?.hAmp || 8000) * 0.04) * clarity,
    140, 560,
  );

  const seaState = planet?.oceanClimate?.seaState
    || OCEAN_ARCHETYPES[planet?.oceanClimate?.archetype]
    || OCEAN_ARCHETYPES['temperate-swell'];
  const oceanFrame = new OceanRenderFrame(planet);
  const drawUniforms = {
    ...oceanFrame.uniforms,
    uNearPatchCenter: { value: new THREE.Vector3(1e9, 1e9, 1e9) },
    uNearPatchRadius: { value: 0 },
    uRippleCount: { value: 0 },
    uDeepC: { value: initialOptics.deep.clone() },
    uShelfC: { value: initialOptics.shelf.clone() },
    uShallowC: { value: initialOptics.shallow.clone() },
    uAbsorption: { value: new THREE.Vector3(...initialOptics.absorption) },
    uShelfSpan: { value: shelfSpan },
    uBiologicalActivity: { value: (planet?.oceanClimate?.composition === 'bioluminescent'
      || planet?.oceanClimate?.archetype === 'abyssal-biolum')
      ? (planet.oceanClimate.biologicalActivity || 0.8) : 0 },
    uMesoOffsets: { value: new THREE.Vector4() },
    uWaterSssColor: { value: new THREE.Vector3(...seaState.sssColor) },
    uWaterSssStrength: { value: seaState.sssStrength },
    uWaterLangmuir: { value: seaState.langmuirStrength },
    uWaterWhitecap: { value: new THREE.Vector2(seaState.whitecapStrength, seaState.whitecapThreshold) },
    uWaterOpticsParams: {
      value: new THREE.Vector4(
        seaState.glitterSharpness,
        seaState.fresnelContrast,
        seaState.capillaryAmp,
        seaState.swellSteepness,
      ),
    },
    uWaterBiolumColor: { value: new THREE.Vector3(...seaState.biolumColor) },
    uWaterUnderScatter: { value: new THREE.Vector3(...seaState.underwaterScatter) },
  };
  drawUniforms.uOceanModes = { value: oceanField.modes.map((mode) =>
    new THREE.Vector4(...mode.axis, mode.k)) };
  drawUniforms.uOceanPhases = { value: oceanField.modes.map(() => new THREE.Vector2()) };
  drawUniforms.uOceanNormalization = { value: oceanField.normalization };
  drawUniforms.uOceanHeight = { value: 2 };
  drawUniforms.uOceanTime = { value: 0 };
  // The shared tile contains broad noise features; its extra UV multiplier
  // previously stretched "short" facets across tens of metres. Resolve the
  // missing metre-scale band, with CPU phases and mip filtering unchanged.
  const detailFrame = createOceanDetailFrame(THREE.MathUtils.clamp(waveScale * 0.92, 0.028, 0.066) * 8);
  drawUniforms.uOceanDetailOffsets = { value: detailFrame.channels.map(() => new THREE.Vector4()) };
  if (tidalField) {
    for (const name of ['Axis', 'Side', 'Up', 'Offset']) drawUniforms[`uTidal${name}`] = { value: new THREE.Vector3() };
    drawUniforms.uTidalShape = { value: new THREE.Vector4() };
    drawUniforms.uTidalDepthRatio = { value: tidalField.depthRatio };
  }
  material.userData.oceanWaveField = oceanField;
  material.userData.oceanTidalField = tidalField;
  material.userData.oceanSamplingAnchor = oceanFrame.anchor;
  material.userData.syncOceanField = () => {
    const center = drawUniforms.uNearPatchRadius.value > 0
      ? drawUniforms.uNearPatchCenter.value : new THREE.Vector3();
    const seconds = oceanSeconds(planet.weatherHours || 0);
    drawUniforms.uOceanTime.value = seconds;
    oceanDetailOffsets(detailFrame, oceanFrame.anchor).forEach((offset, i) =>
      drawUniforms.uOceanDetailOffsets.value[i].set(...offset));
    drawUniforms.uMesoOffsets.value.set(
      fract01(dot3(mesoA0, oceanFrame.anchor) * mesoScale0),
      fract01(dot3(mesoB0, oceanFrame.anchor) * mesoScale0),
      fract01(dot3(mesoA1, oceanFrame.anchor) * mesoScale1),
      fract01(dot3(mesoB1, oceanFrame.anchor) * mesoScale1),
    );
    const phases = oceanWavePhases(oceanField, oceanFrame.anchor, seconds);
    for (let i = 0; i < phases.length; i++) drawUniforms.uOceanPhases.value[i].set(...phases[i]);
    if (tidalField) {
      const state = oceanTidalEventUniforms(tidalField, oceanFrame.anchor, seconds);
      for (const name of ['Axis', 'Side', 'Up', 'Offset']) {
        drawUniforms[`uTidal${name}`].value.set(...state[name.toLowerCase()]);
      }
      drawUniforms.uTidalShape.value.set(...state.shape);
    }
    if (center.lengthSq() > 1) {
      const state = planet.oceanAt?.(center.clone().normalize());
      if (state) {
        drawUniforms.uOceanHeight.value = state.offshoreSignificantHeight;
        if (drawUniforms.uBiologicalActivity) {
          drawUniforms.uBiologicalActivity.value = state.bioluminescence;
        }
        material.userData.oceanState = state;
        material.userData.waterProfile.spectrum.significantHeight = state.offshoreSignificantHeight;
        material.userData.waterProfile.spectrum.amplitudes = oceanField.modes.map((mode) =>
          mode.weight * oceanField.normalization * state.offshoreSignificantHeight);
      }
    }
  };
  material.userData.syncOceanField();
  const interactionPixels = new Float32Array(WATER_IMPULSE_CAP * 3 * 4);
  const interactionTexture = new THREE.DataTexture(
    interactionPixels, WATER_IMPULSE_CAP, 3, THREE.RGBAFormat, THREE.FloatType,
  );
  interactionTexture.name = `water-interactions:${planet?.name || planet?.seed || 'water'}`;
  interactionTexture.minFilter = THREE.NearestFilter;
  interactionTexture.magFilter = THREE.NearestFilter;
  interactionTexture.generateMipmaps = false;
  interactionTexture.colorSpace = THREE.NoColorSpace;
  let uploadedRippleCount = -1;
  const syncWaterInteractionTexture = () => {
    // Pack only live impulses at the start of the texture. Most frames have no
    // contact at all; bounding the shader loops avoids dozens of dependent
    // texture reads per ocean pixel while retaining the complete 12-event
    // wake/impact budget when the ship actually touches water.
    const directional = [];
    const impacts = [];
    for (let sourceIndex = 0; sourceIndex < WATER_IMPULSE_CAP; sourceIndex++) {
      const data = waterInteraction.data[sourceIndex];
      if (data.z <= 0.001 || waterInteraction.planetId !== planet.seed) continue;
      const direction = waterInteraction.directions[sourceIndex];
      (direction.w > 0.5 ? directional : impacts).push(sourceIndex);
    }
    // Finite packets need the actual deposit spacing. Subsampling a 150 m/s
    // track down to four sources left 50 m holes between 36 m-wide packets.
    // Keep the bounded twelve-source history; the shader rejects pixels
    // outside each packet before doing its noise/foam work.
    directional.sort((a, b) => waterInteraction.data[a].x
      - waterInteraction.data[b].x);
    const sourceIndices = [...impacts, ...directional];
    let packedIndex = 0;
    for (const sourceIndex of sourceIndices) {
      if (packedIndex >= WATER_IMPULSE_CAP) break;
      const data = waterInteraction.data[sourceIndex];
      const position = waterInteraction.positions[sourceIndex];
      const direction = waterInteraction.directions[sourceIndex];
      let offset = packedIndex * 4;
      const anchor = oceanFrame.anchor;
      interactionPixels[offset] = position.x - anchor.x;
      interactionPixels[offset + 1] = position.y - anchor.y;
      interactionPixels[offset + 2] = position.z - anchor.z;
      interactionPixels[offset + 3] = 0;
      offset = (WATER_IMPULSE_CAP + packedIndex) * 4;
      interactionPixels[offset] = data.x;
      interactionPixels[offset + 1] = data.y;
      interactionPixels[offset + 2] = data.z;
      interactionPixels[offset + 3] = data.w;
      offset = (WATER_IMPULSE_CAP * 2 + packedIndex) * 4;
      interactionPixels[offset] = direction.x;
      interactionPixels[offset + 1] = direction.y;
      interactionPixels[offset + 2] = direction.z;
      interactionPixels[offset + 3] = direction.w;
      packedIndex++;
    }
    drawUniforms.uRippleCount.value = packedIndex;
    if (packedIndex === 0 && uploadedRippleCount === 0) return;
    uploadedRippleCount = packedIndex;
    interactionTexture.needsUpdate = true;
  };
  syncWaterInteractionTexture();
  // onBeforeCompile can run more than once for light/render variants. Every
  // variant must retain the same mutable draw controls; pointing debug/runtime
  // code at whichever Shader happened to compile last made A/B gates and the
  // near-patch selector update a non-rendered uniform set.
  material.userData.waterUniforms = drawUniforms;
  material.defaultAttributeValues ||= {};
  material.defaultAttributeValues.aWaterCell = [144];
  material.userData.waterInteractionTexture = interactionTexture;
  material.userData.syncWaterInteractionTexture = syncWaterInteractionTexture;
  const previousWaterDraw = material.onBeforeRender;
  material.onBeforeRender = function (renderer, scene, camera, ...args) {
    previousWaterDraw?.call(this, renderer, scene, camera, ...args);
    const rebased = oceanFrame.sync(camera, drawUniforms.uNearPatchRadius.value > 0
      ? drawUniforms.uNearPatchCenter.value : null);
    if (rebased || drawUniforms.uOceanTime.value !== oceanSeconds(planet.weatherHours || 0)) {
      material.userData.syncOceanField();
      syncWaterInteractionTexture();
    }
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, oceanFrame.uniforms);
    const cloudTex = planet.cloudShadowTex || blankTexture();
    const sky = planet?.skyColor || new THREE.Color(0.25, 0.4, 0.55);
    shader.uniforms.uDetailTex = { value: tex };
    shader.uniforms.uTime = drawUniforms.uOceanTime;
    shader.uniforms.uWaveS = { value: waveScale };
    shader.uniforms.uSwell = { value: planet?.waterStyle?.swell || 1 };
    shader.uniforms.uFoamK = { value: planet?.waterStyle?.foam || 1 };
    shader.uniforms.uDeepC = drawUniforms.uDeepC;
    shader.uniforms.uShelfC = drawUniforms.uShelfC;
    shader.uniforms.uShallowC = drawUniforms.uShallowC;
    shader.uniforms.uAbsorption = drawUniforms.uAbsorption;
    shader.uniforms.uShelfSpan = drawUniforms.uShelfSpan;
    shader.uniforms.uBiologicalActivity = drawUniforms.uBiologicalActivity;
    shader.uniforms.uMesoOffsets = drawUniforms.uMesoOffsets;
    shader.uniforms.uWaterSssColor = drawUniforms.uWaterSssColor;
    shader.uniforms.uWaterSssStrength = drawUniforms.uWaterSssStrength;
    shader.uniforms.uWaterLangmuir = drawUniforms.uWaterLangmuir;
    shader.uniforms.uWaterWhitecap = drawUniforms.uWaterWhitecap;
    shader.uniforms.uWaterOpticsParams = drawUniforms.uWaterOpticsParams;
    shader.uniforms.uWaterBiolumColor = drawUniforms.uWaterBiolumColor;
    shader.uniforms.uWaterUnderScatter = drawUniforms.uWaterUnderScatter;
    shader.uniforms.uDepthHazeDistance = { value: depthScale * 0.4 };
    shader.uniforms.uNearPatchCenter = drawUniforms.uNearPatchCenter;
    shader.uniforms.uNearPatchRadius = drawUniforms.uNearPatchRadius;
    for (const name of ['uOceanModes', 'uOceanPhases', 'uOceanNormalization', 'uOceanHeight', 'uOceanDetailOffsets']) {
      shader.uniforms[name] = drawUniforms[name];
    }
    for (const [name, uniform] of Object.entries(drawUniforms)) {
      if (name.startsWith('uTidal')) shader.uniforms[name] = uniform;
    }
    shader.uniforms.uSkyZenith = {
      value: sky.clone().multiply(new THREE.Color(0.3, 0.42, 0.78)),
    };
    shader.uniforms.uSkyHorizon = { value: sky.clone() };
    shader.uniforms.uDay = { value: 1 };
    shader.uniforms.uSunset = { value: 0 };
    shader.uniforms.uSunDir = {
      value: planet?.sunDirLocal?.clone() || new THREE.Vector3(0, 1, 0),
    };
    shader.uniforms.uSunColor = { value: new THREE.Color(1, 0.94, 0.82) };
    shader.uniforms.uSunEnergy = { value: 1 };
    shader.uniforms.uSecondarySunDir = { value: new THREE.Vector3(0, 1, 0) };
    shader.uniforms.uSecondarySunColor = { value: new THREE.Color(1, 1, 1) };
    shader.uniforms.uSecondarySunEnergy = { value: 0 };
    shader.uniforms.uCloudTex = { value: cloudTex };
    shader.uniforms.uCloudK = { value: planet.cloudMesh ? 0.72 : 0 };
    shader.uniforms.uCloudMat = { value: new THREE.Matrix3() };
    shader.uniforms.uEclipseEnabled = { value: planet.eclipseOccluder ? 1 : 0 };
    shader.uniforms.uEclipseCenter = {
      value: planet.eclipseOccluder?.centerLocal?.clone() || new THREE.Vector3(),
    };
    shader.uniforms.uEclipseRadius = { value: planet.eclipseOccluder?.radius || 1 };
    shader.uniforms.uEclipseStarAngle = {
      value: planet.eclipseOccluder?.starAngularRadius || 0,
    };
    shader.uniforms.uRippleTex = { value: interactionTexture };
    shader.uniforms.uRippleCount = drawUniforms.uRippleCount;
    // A material can have several live programs (shadow/light/fog variants).
    // Environment updates must reach every one, not only the last compilation.
    for (const [name, uniform] of Object.entries(shader.uniforms)) {
      if (!name.startsWith('u')) continue;
      drawUniforms[name] ||= uniform;
      shader.uniforms[name] = drawUniforms[name];
    }
    material.userData.waterCloudTexture = shader.uniforms.uCloudTex;
    shader.uniforms.uCloudSynoptic = { value: planet.weatherField?.synoptic ? 1 : 0 };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uSwell;
        uniform vec3 uSunDir;
        uniform vec3 uSecondarySunDir;
        ${oceanRenderFrameGLSL}
        uniform float uNearPatchRadius;
        attribute vec3 aLocal;
        attribute float aDepth;
        attribute vec3 aPositionDelta;
        attribute vec3 aNormalDelta;
        attribute float aDepthDelta;
        attribute float aLodMorph;
        attribute float aNearPatchPass;
        attribute float aWaterCell;
        varying vec3 vLocalPos;
        varying vec3 vOceanRelative;
        ${oceanWaveGLSL}
        ${tidalGLSL}
        varying vec3 vWaveUp;
        varying vec3 vWaveT;
        varying vec3 vWaveB;
        varying vec3 vSunDirView;
        varying vec3 vSecondarySunDirView;
        varying vec2 vMacroSlope;
        varying float vWaveHeight;
        varying float vWaveNear;
        varying float vDepth;
        varying float vNearPatchPass;
        varying float vWaterCell;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal = normalize(objectNormal + aNormalDelta * aLodMorph);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += aPositionDelta * aLodMorph;
        vLocalPos = aLocal + aPositionDelta * aLodMorph;
        vDepth = aDepth + aDepthDelta * aLodMorph;
        vNearPatchPass = aNearPatchPass;
        vWaterCell = aWaterCell;
        vec3 waveUp = normalize(vLocalPos);
        vec3 waveT = normalize(cross(waveUp,
          abs(waveUp.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 waveB = cross(waveUp, waveT);
        float macroWave = 0.0;
        // Both meshes use the same pre-displacement rendered position and
        // sampling anchor. Never subtract planet-scale Float32 attributes.
        vOceanRelative = oceanRelativeFromView((modelViewMatrix * vec4(transformed, 1.0)).xyz);
        float cameraDistance = length((modelViewMatrix * vec4(transformed, 1.0)).xyz);
        vWaveNear = 1.0 - smoothstep(18000.0, 220000.0, cameraDistance);
        float patchDistanceVertex = oceanPatchDistance(vOceanRelative);
        float patchGeometry = 1.0 - smoothstep(uNearPatchRadius - 1840.0,
          uNearPatchRadius - 640.0, patchDistanceVertex);
        float geometryNear = step(0.5, aNearPatchPass) * patchGeometry;
        vec3 waveGradient = vec3(0.0);
        if (geometryNear > 0.0001) {
          float localCell = max(4.0, aWaterCell);
          vec4 waveSample = oceanWaveField(vOceanRelative, localCell);
          macroWave = waveSample.x;
          waveGradient = waveSample.yzw;
        }
        float shoal = min(1.0, max(0.0, vDepth) * 0.62 / max(uOceanHeight, 0.001));
        vec4 tidalSample = oceanTidalEvent(vOceanRelative, vDepth);
        float displacedWave = macroWave * shoal * geometryNear + tidalSample.x;
        transformed += waveUp * (displacedWave + 0.18);
        vWaveUp = normalize(normalMatrix * waveUp);
        vWaveT = normalize(normalMatrix * waveT);
        vWaveB = normalize(normalMatrix * waveB);
        vSunDirView = normalize(normalMatrix * uSunDir);
        vSecondarySunDirView = normalize(normalMatrix * uSecondarySunDir);
        vMacroSlope = vec2(dot(waveGradient, waveT),
          dot(waveGradient, waveB)) * shoal * geometryNear;
        vWaveHeight = displacedWave;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailTex;
        uniform sampler2D uCloudTex;
        uniform float uTime, uCloudSynoptic;
        varying vec3 vOceanRelative;
        ${oceanWaveGLSL}
        ${tidalGLSL}
        uniform float uSwell;
        ${weatherAtlasGLSL}
        uniform float uWaveS;
        uniform float uFoamK;
        uniform vec3 uDeepC;
        uniform vec3 uShelfC;
        uniform vec3 uShallowC;
        uniform vec3 uAbsorption;
        uniform float uShelfSpan;
        uniform float uBiologicalActivity;
        uniform float uDepthHazeDistance;
        uniform vec4 uMesoOffsets;
        uniform vec3 uWaterSssColor;
        uniform float uWaterSssStrength;
        uniform float uWaterLangmuir;
        uniform vec2 uWaterWhitecap;
        uniform vec4 uWaterOpticsParams;
        uniform vec3 uWaterBiolumColor;
        uniform vec3 uWaterUnderScatter;
        ${oceanRenderFrameGLSL}
        uniform float uNearPatchRadius;
        uniform vec3 uSkyZenith;
        uniform vec3 uSkyHorizon;
        uniform float uDay;
        uniform float uSunset;
        uniform vec3 uSunColor;
        uniform float uSunEnergy;
        uniform vec3 uSecondarySunColor;
        uniform float uSecondarySunEnergy;
        uniform float uCloudK;
        uniform mat3 uCloudMat;
        uniform float uEclipseEnabled;
        uniform vec3 uEclipseCenter;
        uniform float uEclipseRadius;
        uniform float uEclipseStarAngle;
        uniform sampler2D uRippleTex;
        uniform int uRippleCount;
        varying vec3 vLocalPos;
        varying vec3 vWaveUp;
        varying vec3 vWaveT;
        varying vec3 vWaveB;
        varying vec3 vSunDirView;
        varying vec3 vSecondarySunDirView;
        varying vec2 vMacroSlope;
        varying float vWaveHeight;
        varying float vWaveNear;
        varying float vDepth;
        varying float vNearPatchPass;
        varying float vWaterCell;
        float gWaterFoam = 0.0;
        float gWaterWakeFoam = 0.0;
        float gWaterLangmuir = 0.0;
        float gWaterRoughness = 0.16;
        vec2 gWaterDetail = vec2(0.5);
        vec2 gWaterMacroSlope = vec2(0.0);
        float gWaterCloud = 0.0;
        float gWaterShallow = 0.0;
        float gWaterFacetLight = 0.5;
        float gWaterCrest = 0.0;
        float gWaterShoalMask = 1.0;
        float waterHash21(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float waterNoise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(waterHash21(i), waterHash21(i + vec2(1.0, 0.0)), f.x),
            mix(waterHash21(i + vec2(0.0, 1.0)),
              waterHash21(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float waterFbm2(vec2 p) {
          // The shared tile already contains four octaves. Hardware mipmaps
          // integrate unresolved roughness; rotating a second incommensurate
          // sample hides the tile without evaluating hundreds of hash ALU
          // operations for every covered near-water pixel.
          mat2 rotation = mat2(0.8, -0.6, 0.6, 0.8);
          float a = texture2D(uDetailTex, p * 0.04).r;
          float b = texture2D(uDetailTex, rotation * p * 0.067 + vec2(0.37, 0.19)).g;
          return clamp(0.5 + ((a * 0.65 + b * 0.35) - 0.5) * 2.0, 0.0, 1.0);
        }
        ${oceanDetailGLSL(detailFrame)}
        ${oceanWakePacketGLSL}
        vec2 waterDetail(vec3 p, float scale, vec2 drift) {
          // Work in a camera-local tangent-sized frame near the patch so the
          // 6,000 km planet does not quantise metre-scale facets in mediump
          // arithmetic. Two unrelated world projections feed non-periodic
          // value-noise fBm; unlike the old tiled normal texture and analytic
          // sines, this cannot form kilometre-long rails or rectangular cells.
          return vec2(
            oceanDetailA(p, drift * 9.0),
            oceanDetailB(p, drift.yx * vec2(-7.0, 11.0)));
        }
        vec3 waterWaveGradient() {
          float footprint = max(length(dFdx(vOceanRelative)), length(dFdy(vOceanRelative)));
          return oceanWaveField(vOceanRelative, footprint).yzw;
        }
        float waterCloud(vec3 localDirection) {
          vec3 cd = uCloudMat * normalize(localDirection);
          float cloudCover = weatherAtlasSample(uCloudTex, cd).r;
          if (uCloudSynoptic > 0.5) cloudCover = synopticCoverage(cloudCover, 0.12);
          return cloudCover * uCloudK;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float patchDistance = oceanPatchDistance(vOceanRelative);
          if (uNearPatchRadius > 0.0) {
            // World-space ownership boundary. Geometric waves have already
            // reached zero before this radius, so both meshes meet on the
            // same sphere and a camera pan cannot reveal a screen-locked
            // checkerboard or rectangular coverage edge.
            // From underwater (!gl_FrontFacing), upward grazing rays cross
            // coarse inscribed waterLod chords before the finer NearWaterPatch
            // sphere, turning the above-water sag overlap into a double-discard
            // slit. Bridge that chord sag with a bounded overlap band.
            float patchHandoff = uNearPatchRadius - 640.0;
            float maxOverlap = max(0.0, min(420.0,
              min(patchHandoff * 0.45, (uNearPatchRadius - patchHandoff) * 0.7)));
            float underwaterOverlap = gl_FrontFacing ? 0.0
              : min(maxOverlap, 18.0 / max(abs(dot(normalize(vWaveUp),
                normalize(vViewPosition))), 0.03));
            if (vNearPatchPass < 0.5 && patchDistance < patchHandoff - underwaterOverlap) discard;
            if (vNearPatchPass > 0.5 && patchDistance >= patchHandoff + underwaterOverlap) discard;
          }
          vec3 localUp = normalize(vLocalPos);
          vec3 localT = normalize(cross(localUp,
            abs(localUp.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 localB = cross(localUp, localT);
          // Sample the displaced surface, not its flat sea-sphere footprint.
          // Otherwise a 280 m wave face stretches a few metres of texture
          // into long vertical fabric streaks. The anchor remains unchanged.
          float viewDist = length(vViewPosition);
          vec3 detailPosition = vOceanRelative + localUp * vWaveHeight;
          float detailFade = 1.0 - smoothstep(22000.0, 48000.0, viewDist);
          vec2 detailSample = detailFade > 0.001
            ? mix(vec2(0.5), waterDetail(detailPosition, uWaveS, vec2(uTime * 0.095, -uTime * 0.065)), detailFade)
            : vec2(0.5);
          gWaterDetail = detailSample;
          // A real waterline advances and retreats over the authored contour.
          // Modulate depth with a broad stochastic swash field and the actual
          // geometric crest so the coverage, wet band and foam never collapse
          // to a ruler-straight material boundary.
          float swashField = (detailSample.r - 0.5) * 2.6
            + (detailSample.g - 0.5) * 1.2 + vWaveHeight * 0.42;
          float edgeDepth = vDepth + swashField;
          // Kilometre-wide triangles can interpolate a dry cape across a
          // deep inlet. Opaque terrain already occludes inland water. Let it
          // own the silhouette until the bathymetry resolves the shoreline.
          float coarseShell = (1.0 - vNearPatchPass) * smoothstep(150.0, 720.0, vWaterCell);
          if (gl_FrontFacing && coarseShell < 0.001 && edgeDepth <= -0.85) discard;
          float edgeCoverage = gl_FrontFacing
            ? mix(smoothstep(-0.85, 0.22, edgeDepth), 1.0, coarseShell) : 1.0;
          float dep = max(edgeDepth, coarseShell * 36.0);
          float opticalFootprint = max(length(dFdx(vOceanRelative)), length(dFdy(vOceanRelative)));
          float farBathymetry = smoothstep(2.0, 22.0, opticalFootprint);
          // Orbital footprints cannot resolve metre-scale shelf triangles,
          // but their authored depth still identifies shelf, slope or abyss.
          // Lift only the first metres so unresolved shoals stay continuous
          // while preserving full shelf-to-abyss contrast from high altitude.
          float unresolvedDepth = max(dep, mix(3.0, 0.0, smoothstep(0.0, 12.0, dep)));
          float opticalDepth = mix(dep, unresolvedDepth, farBathymetry);
          gWaterShallow = 1.0 - smoothstep(0.08, 6.0, dep);
          gWaterShoalMask = mix(0.28, 1.0, clamp(dep / max(uOceanHeight * 2.2, 2.0), 0.0, 1.0));
          float viewCos = clamp(abs(dot(normalize(vWaveUp),
            normalize(vViewPosition))), 0.015, 1.0);
          // Sea-floor light makes a down/up trip through the column. The
          // coefficients scale with the planet's real bathymetry, preserving
          // a broad shelf-to-abyss response instead of saturating at 20 m.
          float waterPath = 2.0 * opticalDepth / viewCos;
          vec3 transmission = exp(-uAbsorption * waterPath);
          float depthHaze = smoothstep(0.0, uDepthHazeDistance, opticalDepth) * 0.9;
          vec3 bodyTransmit = transmission * (1.0 - depthHaze);
          float fragmentShoal = min(1.0, dep * 0.62 / max(uOceanHeight, 0.001));
          if (vWaveNear > 0.001) {
            if (fragmentShoal > 0.001 && opticalFootprint < 900.0) {
              vec3 analyticWaveGradient = waterWaveGradient();
              gWaterMacroSlope = vec2(dot(analyticWaveGradient, localT),
                dot(analyticWaveGradient, localB)) * fragmentShoal * vWaveNear;
            }
            vec4 tidalFragment = oceanTidalEvent(vOceanRelative, dep);
            vec3 tidalGradient = tidalFragment.yzw;
            gWaterMacroSlope += vec2(dot(tidalGradient, localT), dot(tidalGradient, localB)) * vWaveNear;
          } else {
            vec4 tidalFragment = vec4(0.0);
          }
          float smallDetail = clamp(detailSample.r * 0.58 + detailSample.g * 0.42,
            0.0, 1.0);
          float refractiveWarp = 0.0;
          float caustic = 0.0;
          if (dep < 95.0 && uDay > 0.002 && viewDist < 6500.0) {
            float causticFade = 1.0 - smoothstep(4200.0, 6500.0, viewDist);
            refractiveWarp = (oceanCausticWarp(vOceanRelative,
              vec2(uTime * 0.035, -uTime * 0.027)) - 0.5) * causticFade;
            caustic = pow(smoothstep(0.51, 0.86,
              oceanCaustic(vOceanRelative, vec2(refractiveWarp * 3.2)
                + vec2(uTime * 0.19, -uTime * 0.13))), 2.0)
              * exp(-dep * 0.024) * uDay * causticFade;
          }
          vec3 seabed = uShallowC * (0.76 + caustic * 0.72)
            * (0.92 + refractiveWarp * 0.2);
          float shelfSpan = max(80.0, uShelfSpan);
          float innerShelf = smoothstep(1.5, max(26.0, shelfSpan * 0.14), opticalDepth);
          float outerShelf = smoothstep(max(24.0, shelfSpan * 0.09), shelfSpan * 1.4, opticalDepth);
          float abyssRamp = smoothstep(shelfSpan * 0.85, shelfSpan * 3.0, opticalDepth);
          vec3 shelfColumn = mix(uShallowC * (0.86 + uDay * 0.28),
            uShelfC * (0.74 + uDay * 0.34), innerShelf);
          vec3 abyssColumn = uDeepC * (0.76 + uDay * 0.38) * mix(1.0, 0.78, abyssRamp);
          vec3 waterScatter = mix(shelfColumn, abyssColumn, outerShelf);
          diffuseColor.rgb = seabed * bodyTransmit + waterScatter * (1.0 - bodyTransmit);
          vec3 authoredDepthColor = mix(shelfColumn, abyssColumn, outerShelf);
          diffuseColor.rgb = mix(diffuseColor.rgb, authoredDepthColor,
            0.22 + outerShelf * 0.42);
          // Looking down through a clear shelf retains its bright water column;
          // at grazing angles the body darkens before Fresnel sky reflection
          // takes over in emissivemap_fragment.
          diffuseColor.rgb *= mix(0.76, 1.06, smoothstep(0.16, 0.78, viewCos));
          diffuseColor.rgb *= 0.88 + smallDetail * 0.18;
          // Approximate unresolved facet skylight below the specular lobe.
          float facetLight = clamp(0.12 + smallDetail * 0.7
            + detailSample.g * 0.34
            + dot(gWaterMacroSlope, vec2(0.71, -0.49)) * 0.16, 0.0, 1.0);
          gWaterFacetLight = facetLight;
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.77, 0.88, 0.94),
            diffuseColor.rgb * vec3(1.12, 1.1, 1.03), facetLight);
          float shoreFade = 1.0 - smoothstep(1800.0, 11500.0, viewDist);
          float shoreFoam = 0.0;
          float crestHeight = smoothstep(0.0, 0.12,
            vWaveHeight / max(uOceanHeight, 0.25));
          gWaterCrest = crestHeight;
          float macroSlopeLen = length(gWaterMacroSlope);
          bool needAlongShore = (dep < 24.0 && shoreFade > 0.001)
            || (crestHeight > 0.001 && macroSlopeLen > 0.035 && dep > 5.0)
            ${tidalField ? '|| true' : ''};
          float alongShoreBreak = needAlongShore
            ? oceanShore(vOceanRelative, vec2(uTime * 0.032, -uTime * 0.024))
            : 0.5;
          if (dep < 24.0 && shoreFade > 0.001) {
            vec2 shoreCoordinates = oceanShorePhase(vOceanRelative, vec2(0.0, uTime * 0.37 / 6.28318530718));
            float shoreWarp = (alongShoreBreak - 0.5) * 3.4
              + sin(shoreCoordinates.x * 6.28318530718) * 1.15
              + sin(shoreCoordinates.y * 6.28318530718) * 0.85;
            float shorePhase = sqrt(max(dep, 0.08)) * 3.35 - uTime * 1.75 + shoreWarp;
            float waveLine = sin(shorePhase);
            float shoreBand = pow(1.0 - smoothstep(0.12, 22.0, dep), 0.82);
            float poreBreak = mix(0.68, smoothstep(0.32, 0.72, smallDetail),
              1.0 - smoothstep(1.0, 9.0, opticalFootprint));
            float alongBreak = smoothstep(0.28, 0.76, alongShoreBreak);
            float breakingCrest = smoothstep(0.42, 0.90, waveLine) * poreBreak;
            float trailingLace = smoothstep(0.08, 0.62, sin(shorePhase - 0.52))
              * (1.0 - smoothstep(0.8, 12.0, dep)) * poreBreak * 0.34;
            float swashNoise = smoothstep(0.40, 0.75,
              alongShoreBreak * 0.62
                + (sin(shorePhase * 0.65 + (alongShoreBreak - 0.5) * 2.2) * 0.5 + 0.5) * 0.44);
            float swashRibbon = (1.0 - smoothstep(0.03, 2.2, dep))
              * swashNoise * uFoamK * 0.40;
            shoreFoam = ((shoreBand * breakingCrest + trailingLace)
              * (0.36 + alongBreak * 0.64) * uFoamK * 0.82
              + swashRibbon) * shoreFade;
          }
          float openWhitecap = 0.0;
          float langmuirStreak = 0.0;
          float seaEnergy = smoothstep(0.9, 4.8, uOceanHeight);
          if (crestHeight > 0.001 && macroSlopeLen > 0.025 && dep > 4.0) {
            vec2 foamPoreUv = oceanCapillary(vOceanRelative + localUp * vWaveHeight,
              vec2(uTime * 0.08, -uTime * 0.055));
            vec2 foamPore = texture2D(uDetailTex, foamPoreUv).rg;
            float resolvedPores = smoothstep(0.40, 0.60, foamPore.x * 0.58 + foamPore.y * 0.42);
            float crestSlopeGate = smoothstep(0.025, 0.095, macroSlopeLen);
            float detailGate = smoothstep(uWaterWhitecap.y, uWaterWhitecap.y + 0.28,
              smallDetail * 0.65 + alongShoreBreak * 0.35);
            openWhitecap = crestHeight * resolvedPores * crestSlopeGate
              * smoothstep(4.0, 26.0, dep) * detailGate
              * uFoamK * uWaterWhitecap.x * 0.58;
            // Trailing aerated foam lace sliding down steep storm wave backs
            float spumeTail = smoothstep(0.05, 0.16, macroSlopeLen)
              * smoothstep(0.48, 0.80, foamPore.y)
              * smoothstep(8.0, 42.0, dep) * seaEnergy * uWaterWhitecap.x * 0.24;
            openWhitecap = max(openWhitecap, spumeTail * crestHeight);
          }
          // Wind-aligned Langmuir foam lanes on energetic / stormy seas
          if (uWaterLangmuir > 0.02 && dep > 6.0 && viewDist < 9000.0 && vWaveNear > 0.01) {
            float langFade = (1.0 - smoothstep(2600.0, 9000.0, viewDist))
              * smoothstep(6.0, 32.0, dep) * (0.28 + 0.72 * seaEnergy) * vWaveNear;
            if (langFade > 0.002) {
              vec3 windAxis = uOceanModes[0].xyz - localUp * dot(uOceanModes[0].xyz, localUp);
              float windAxisLen = length(windAxis);
              vec3 wDir = windAxisLen > 1e-4 ? (windAxis / windAxisLen) : localT;
              vec3 wSide = cross(localUp, wDir);
              vec3 wPos = vOceanRelative + localUp * vWaveHeight;
              vec2 lUv = vec2(dot(wPos, wDir) * 0.0042 - uTime * 0.014,
                dot(wPos, wSide) * 0.029);
              float lWarp = (texture2D(uDetailTex, lUv * 0.45 + vec2(0.19, 0.43)).r - 0.5) * 0.32;
              float laneA = texture2D(uDetailTex, vec2(lUv.x, lUv.y + lWarp)).g;
              float laneB = texture2D(uDetailTex, vec2(lUv.x * 1.9 + 0.31, lUv.y * 2.1 - lWarp)).r;
              float laneSharp = smoothstep(0.60, 0.86, laneA * 0.62 + laneB * 0.38);
              langmuirStreak = laneSharp * smoothstep(0.32, 0.78, smallDetail)
                * uWaterLangmuir * langFade * 0.42;
            }
          }
          gWaterLangmuir = langmuirStreak;
          ${tidalField ? `
          vec4 tidalFoamSample = oceanTidalEvent(vOceanRelative, dep);
          float crestFraction = tidalFoamSample.x / max(1.0, uTidalShape.x);
          float tidalCrestFoam = smoothstep(0.62, 0.92, crestFraction)
            * smoothstep(0.38, 0.68, smallDetail * 0.6 + alongShoreBreak * 0.4);
          openWhitecap += tidalCrestFoam * 0.78;
          ` : ''}
          float wakeFoam = 0.0;
          if (uRippleCount > 0 && viewDist < 4500.0)
          for (int i = 0; i < ${WATER_IMPULSE_CAP}; i++) {
            if (i >= uRippleCount) break;
            vec3 ripplePosition = texelFetch(uRippleTex, ivec2(i, 0), 0).xyz;
            vec4 rd = texelFetch(uRippleTex, ivec2(i, 1), 0);
            if (rd.z <= 0.001) continue;
            vec4 rdir = texelFetch(uRippleTex, ivec2(i, 2), 0);
            vec3 delta = vOceanRelative - ripplePosition;
            vec2 planar = vec2(dot(delta, localT), dot(delta, localB));
            float dist = max(length(planar), 0.05);
            float ring = dist - rd.x * rd.y;
            float impactEnvelope = exp(-abs(ring) * 0.24 - rd.x * 0.42) * rd.z;
            float impactCore = exp(-dist * 0.45 - rd.x * 0.95) * rd.z * 0.85;
            float impactFoam = ((0.35 + 0.65 * max(0.0, sin(ring * 1.45)))
              * impactEnvelope + impactCore) * rd.w * 1.35;
            vec3 wakeAxis = normalize(rdir.xyz - localUp * dot(rdir.xyz, localUp)
              + localT * 0.0001);
            vec3 wakeSide = normalize(cross(localUp, wakeAxis));
            float along = dot(delta, wakeAxis);
            float lateral = dot(delta, wakeSide);
            if (rdir.w > 0.5 && !oceanWakeAlongSupport(along, rd.x, rd.y)) continue;
            OceanWakePacket packet = oceanWakePacket(along, lateral, rd.x, rd.y, rd.z);
            float trailDistance = packet.trailDistance;
            float armEnvelope = packet.armEnvelope;
            float armCore = packet.coreEnvelope;
            float centreEnvelope = packet.centerEnvelope;
            float shoulderPhase = sin(trailDistance * 0.27 - rd.x * 3.1
              + abs(lateral) * 0.09 + sign(lateral) * 1.37) * 0.5 + 0.5;
            // Both divergent pressure shoulders must survive, while their
            // crests still break into unequal packets instead of two rails.
            float wakeBreak = waterFbm2(vec2(trailDistance * 0.055,
              lateral * 0.095) + vec2(rd.x * 0.23, -rd.x * 0.17));
            float shoulderBreak = smoothstep(0.40, 0.72,
              shoulderPhase * 0.43 + wakeBreak * 0.57);
            float sternWash = centreEnvelope;
            float wedgeHalfWidth = packet.armCenter;
            float insideWedge = 1.0 - smoothstep(wedgeHalfWidth - 2.0,
              wedgeHalfWidth + 3.0, abs(lateral));
            float transverseCrest = pow(max(0.0,
              sin(trailDistance * 0.31 + abs(lateral) * 0.085 - rd.x * 2.4)), 2.0)
              * insideWedge * packet.envelope
              * smoothstep(0.45, 0.75, wakeBreak);
            // A dim continuous pressure shoulder carries the V from the
            // stern; stochastic breaking rides on top. Previously almost all
            // visible energy lived in shoulderBreak, creating detached stamps.
            float directionalFoam = (armEnvelope * (0.16 + shoulderBreak * 2.05)
              + armCore * shoulderBreak * 0.72
              + transverseCrest * 0.62
              + centreEnvelope * (0.14 + smallDetail * 0.24)
              + sternWash * 0.26) * rd.w * 1.05;
            // A hull emits several overlapping pressure samples. Summing all
            // of them filled the Kelvin wedge into a flat grey slab before
            // either divergent shoulder could read. The physical surface at
            // a pixel is owned by the strongest breaking event instead.
            wakeFoam = max(wakeFoam,
              mix(impactFoam, directionalFoam, step(0.5, rdir.w)));
          }
          gWaterWakeFoam = clamp(wakeFoam, 0.0, 0.78);
          gWaterFoam = clamp(shoreFoam * 0.92 + openWhitecap + langmuirStreak + wakeFoam, 0.0, 0.96);
          vec3 foamAlbedo = mix(vec3(0.93, 0.97, 0.99),
            normalize(max(uShallowC, vec3(0.02))) * 0.95, 0.16);
          diffuseColor.rgb = mix(diffuseColor.rgb, foamAlbedo, gWaterFoam * 0.92);
          float cloud = waterCloud(vLocalPos);
          gWaterCloud = cloud;
          // Preserve a coherent water surface while allowing the actual shelf
          // geometry to read through clear shallows. Deep water is fully
          // opaque; foam locally restores full coverage. Underwater ceiling
          // (!gl_FrontFacing) renders Snell's window + TIR as an opaque boundary.
          float interfaceFresnel = 0.0201 + 0.9799 * pow(1.0 - viewCos, 5.0);
          float transmittedEnergy = dot(transmission, vec3(0.2126, 0.7152, 0.0722));
          float alphaFloor = mix(0.10, 0.18, farBathymetry);
          if (gl_FrontFacing) {
            diffuseColor.a = clamp(1.0 - transmittedEnergy * (1.0 - interfaceFresnel), alphaFloor, 1.0);
            diffuseColor.a = mix(diffuseColor.a, 1.0, gWaterFoam) * edgeCoverage;
          } else {
            diffuseColor.rgb *= 0.12;
            diffuseColor.a = 0.97;
          }
          float distanceRough = smoothstep(2.0, 32.0, opticalFootprint) * 0.12;
          gWaterRoughness = clamp(0.044 + (1.0 - smallDetail) * 0.082 + distanceRough
            + gWaterFoam * 0.50 + cloud * 0.05, 0.038, 0.78);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = gWaterRoughness;`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 upL = normalize(vLocalPos);
          vec3 tanL = normalize(cross(upL,
            abs(upL.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 bitL = cross(upL, tanL);
          // The stochastic fBm channels are unrelated slope axes. Keeping the
          // normal field noise-owned removes the perspective-compressed sine
          // rails that previously read as a brushed-metal plane. Cross-fade
          // scales smoothly with pixelFootprint so total wave slope stays
          // fluid and liquid at every altitude rather than stacking.
          // Keep micro-normals smoothly liquid so wave backs never spike into
          // dark black facets or reveal a circular near-patch seam.
          vec2 g = (gWaterDetail - 0.5) * 0.68 * uWaterOpticsParams.z;
          float pixelFootprint = max(length(dFdx(vOceanRelative)), length(dFdy(vOceanRelative)));
          g *= (1.0 - smoothstep(3.0, 26.0, pixelFootprint)) * vWaveNear;
          float capFade = (1.0 - smoothstep(0.35, 4.2, pixelFootprint)) * vWaveNear;
          if (capFade > 0.001) {
            vec2 capillaryUv = oceanCapillary(vOceanRelative, vec2(uTime * 0.42, -uTime * 0.29));
            vec2 capillary = texture2D(uDetailTex, capillaryUv).rg - 0.5;
            vec2 fineCapUv = mat2(0.8, -0.6, 0.6, 0.8) * capillaryUv * 2.05 + vec2(-uTime * 0.31, uTime * 0.38);
            vec2 fineCap = texture2D(uDetailTex, fineCapUv).rg - 0.5;
            float fineFade = 1.0 - smoothstep(0.08, 1.1, pixelFootprint);
            g += (capillary * 0.26 + fineCap * 0.16 * fineFade) * uWaterOpticsParams.z * capFade;
          }
          if (pixelFootprint < 110.0 && vWaveNear > 0.001) {
            vec2 mesoUv0 = vec2(dot(vOceanRelative, ${glslVec3(mesoA0)}),
              dot(vOceanRelative, ${glslVec3(mesoB0)})) * ${Number(mesoScale0).toPrecision(17)}
              + uMesoOffsets.xy + vec2(uTime * 0.052, -uTime * 0.036);
            vec2 mesoUv1 = vec2(dot(vOceanRelative, ${glslVec3(mesoA1)}),
              dot(vOceanRelative, ${glslVec3(mesoB1)})) * ${Number(mesoScale1).toPrecision(17)}
              + uMesoOffsets.zw + vec2(-uTime * 0.034, uTime * 0.026);
            vec2 meso0 = texture2D(uDetailTex, mesoUv0).rg - 0.5;
            vec2 meso1 = texture2D(uDetailTex, mesoUv1).rg - 0.5;
            float mesoFade0 = mix(0.24, 0.42, smoothstep(1.5, 8.0, pixelFootprint))
              * (1.0 - smoothstep(12.0, 48.0, pixelFootprint));
            float mesoFade1 = mix(0.14, 0.36, smoothstep(5.0, 22.0, pixelFootprint))
              * (1.0 - smoothstep(26.0, 105.0, pixelFootprint));
            g += (meso0 * mesoFade0 + meso1 * mesoFade1) * gWaterShoalMask * vWaveNear;
          }
          if (uRippleCount > 0 && length(vViewPosition) < 4500.0)
          for (int i = 0; i < ${WATER_IMPULSE_CAP}; i++) {
            if (i >= uRippleCount) break;
            vec3 ripplePosition = texelFetch(uRippleTex, ivec2(i, 0), 0).xyz;
            vec4 rd = texelFetch(uRippleTex, ivec2(i, 1), 0);
            if (rd.z <= 0.001) continue;
            vec4 rdir = texelFetch(uRippleTex, ivec2(i, 2), 0);
            vec3 delta = vOceanRelative - ripplePosition;
            vec2 planar = vec2(dot(delta, tanL), dot(delta, bitL));
            float dist = max(length(planar), 0.05);
            float ring = dist - rd.x * rd.y;
            float impactEnvelope = exp(-abs(ring) * 0.24 - rd.x * 0.42) * rd.z;
            vec2 impactGradient = planar / dist * cos(ring * 1.4) * impactEnvelope * 0.72;
            vec3 wakeAxis = normalize(rdir.xyz - upL * dot(rdir.xyz, upL)
              + tanL * 0.0001);
            vec3 wakeSide = normalize(cross(upL, wakeAxis));
            float along = dot(delta, wakeAxis);
            float lateral = dot(delta, wakeSide);
            if (rdir.w > 0.5 && !oceanWakeAlongSupport(along, rd.x, rd.y)) continue;
            OceanWakePacket packet = oceanWakePacket(along, lateral, rd.x, rd.y, rd.z);
            float trailDistance = packet.trailDistance;
            float armDistance = packet.armDistance;
            float armEnvelope = packet.armEnvelope;
            float centreEnvelope = packet.centerEnvelope;
            float armOscillation = cos(armDistance * 2.1 - rd.x * 4.2);
            float packetBreak = smoothstep(0.34, 0.72,
              waterFbm2(vec2(trailDistance * 0.052 + rd.x * 0.19,
                lateral * 0.087 - rd.x * 0.13)));
            vec3 wakeGradientObject = wakeSide * sign(lateral) * armOscillation
              * armEnvelope * mix(0.036, 0.115, packetBreak)
              - wakeAxis * centreEnvelope * (0.014 + packetBreak * 0.026);
            vec2 wakeGradient = vec2(dot(wakeGradientObject, tanL),
              dot(wakeGradientObject, bitL));
            g += mix(impactGradient * 1.18, wakeGradient, step(0.5, rdir.w));
          }
          float opticalSwellBoost = mix(1.0, clamp(1.22 * uWaterOpticsParams.w, 1.0, 1.78),
            vWaveNear * (1.0 - smoothstep(35.0, 260.0, pixelFootprint)));
          vec2 finalSlope = gWaterMacroSlope * opticalSwellBoost + g * 0.34;
          float slopeMag = length(finalSlope);
          if (slopeMag > 0.68) finalSlope *= 0.68 / slopeMag;
          normal = normalize(normal
            - vWaveT * finalSlope.x
            - vWaveB * finalSlope.y);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 viewDir = normalize(vViewPosition);
          vec3 sunDirV = normalize(vSunDirView);
          vec3 waveUp = normalize(vWaveUp);
          vec3 sunTrans = surfaceStellarTransmission(normalize(uSurfaceViewToLocal * vSunDirView));
          vec3 underN = normalize(normal);
          vec3 refrSkyDir = normalize(mix(waveUp, -viewDir + underN * 0.36, 0.58));
          vec3 reflectionDir = reflect(-viewDir, normal);
          // Prevent steep wave backs from reflecting below-horizon darkness
          float reflUp = dot(reflectionDir, waveUp);
          if (reflUp < 0.035) {
            reflectionDir = normalize(reflectionDir + waveUp * (0.045 - reflUp));
          }
          // Single shared surfaceWaterReflectedSky call for both above-water
          // reflection and underwater Snell's window (prevents 2x FXC inlining).
          vec3 skySampleDir = gl_FrontFacing ? reflectionDir : refrSkyDir;
          float skySampleRough = gl_FrontFacing ? gWaterRoughness : 0.08;
          float skyHeight = clamp(dot(skySampleDir, waveUp), 0.0, 1.0);
          float cloud = gWaterCloud;
          vec3 sampledSky = mix(uSkyHorizon, uSkyZenith, sqrt(skyHeight));
          if (gl_FrontFacing) {
            sampledSky = mix(sampledSky, vec3(0.46, 0.5, 0.56)
              * (0.22 + uDay * 0.62), cloud * 0.62);
          }
          sampledSky = surfaceWaterReflectedSky(
            vLocalPos,
            normalize(uSurfaceViewToLocal * skySampleDir),
            skySampleRough,
            cloud,
            sampledSky
          );
          if (!gl_FrontFacing) {
            // Physical underwater ceiling optics: Snell's window refraction cone
            // (~48.6 deg for water IOR 1.333) surrounded by abyssal Total Internal Reflection.
            float cosUnder = clamp(dot(underN, viewDir), 0.0, 1.0);
            float snellWindow = smoothstep(0.54, 0.72, cosUnder);
            float criticalRing = exp(-pow((cosUnder - 0.645) / 0.062, 2.0));
            float refrSunDot = max(dot(refrSkyDir, sunDirV), 0.0);
            vec3 sunOverhead = uSunColor * (pow(refrSunDot, 38.0) * 1.85 + pow(refrSunDot, 4.5) * 0.38)
              * min(uSunEnergy, 1.6) * sunTrans;
            // Dancing underside wave caustic sparkle inside the window
            float underRipple = smoothstep(0.45, 0.85, gWaterFacetLight) * (0.25 + 0.75 * uDay);
            vec3 windowCol = (sampledSky * (0.72 + 0.45 * uDay) + sunOverhead)
              * (0.84 + 0.36 * underRipple);
            // Total Internal Reflection outside Snell's window reflects the deep column
            vec3 tirCol = mix(uDeepC * 0.52, uWaterUnderScatter * 0.38,
              clamp(gWaterFacetLight * 0.65 + 0.2, 0.0, 1.0)) * (0.18 + 0.82 * uDay);
            // Silvery-cyan dispersion shimmer along the critical-angle ring
            vec3 rimCol = mix(uWaterSssColor, vec3(0.62, 0.92, 1.0), 0.5)
              * criticalRing * (0.16 + 0.40 * uDay) * (0.65 + 0.6 * gWaterFacetLight);
            totalEmissiveRadiance += mix(tirCol, windowCol, snellWindow) + rimCol;
          } else {
            float ndv = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
            float fresnelRaw = 0.0201 + 0.9799 * pow(1.0 - ndv, 5.0);
            float fresnel = clamp(fresnelRaw * uWaterOpticsParams.y, 0.0, 0.96);
            diffuseColor.rgb *= mix(1.0 - fresnel * 0.64, 1.0, gWaterFoam);
            vec3 reflectedSky = sampledSky;
            float sunDot = max(dot(reflectionDir, sunDirV), 0.0);
            float glitterField = (sunDot > 0.008 || (uSunset > 1e-3 && sunDot > 1e-4))
              ? oceanGlitter(vOceanRelative, vec2(uTime * 0.16, -uTime * 0.11))
              : 0.5;
            float glitterBreak = 0.12 + 0.88 * smoothstep(0.45, 0.79,
              glitterField * 0.72 + gWaterFacetLight * 0.28);
            float glintPower = mix(1550.0, 200.0, gWaterRoughness) * uWaterOpticsParams.x;
            float broadPower = mix(105.0, 22.0, gWaterRoughness);
            float sunGlint = sunDot > 1e-5
              ? (pow(sunDot, glintPower) * mix(0.92, 0.30, gWaterRoughness) * glitterBreak
                + pow(sunDot, broadPower) * 0.09 * smoothstep(0.42, 0.84, glitterField))
                * min(uSunEnergy, 1.6)
              : 0.0;
            float secondDot = max(dot(reflectionDir,
              normalize(vSecondarySunDirView)), 0.0);
            float secondGlint = (secondDot > 1e-5 && uSecondarySunEnergy > 1e-5)
              ? pow(secondDot, glintPower) * mix(0.58, 0.20, gWaterRoughness) * min(uSecondarySunEnergy, 1.6)
              : 0.0;
            totalEmissiveRadiance += reflectedSky
              * (0.022 + gWaterShallow * 0.024
                + fresnel * mix(0.46, 0.82, max(uDay, uSunset * 0.88)))
              * (1.0 - gWaterFoam * 0.74);
            // Rich upward internal ocean scatter keeps wave troughs luminous
            // jewel-blue/emerald rather than muddy black when tilted away from sun.
            vec3 bodyUpScatter = mix(uDeepC, uShelfC, clamp(gWaterShallow * 0.75 + 0.25, 0.0, 1.0));
            totalEmissiveRadiance += bodyUpScatter * (0.055 + 0.065 * uDay)
              * (1.0 - fresnel * 0.55) * (1.0 - gWaterFoam * 0.85);
            // Physical backlit wave-crest subsurface scattering (SSS): sunlight
            // transmits through thin raised wave crests toward the camera, tinted
            // by the planet's sea-state archetype and modulated by clouds & ring shadows.
            float crestSlope = smoothstep(0.035, 0.18, length(gWaterMacroSlope));
            float subsurfaceWave = clamp(gWaterCrest * 0.85 + crestSlope * 0.55 + gWaterShallow * 0.55, 0.0, 1.0);
            vec3 sssHalf = normalize(-sunDirV + normal * 0.42);
            float crestBacklight = pow(clamp(dot(viewDir, sssHalf), 0.0, 1.0), 2.8) * 0.95
              + max(0.0, dot(normal, sunDirV)) * 0.28;
            vec3 sssTint = mix(uWaterSssColor, uShallowC * 1.15, gWaterShallow * 0.48);
            totalEmissiveRadiance += sssTint * uWaterSssStrength
              * (0.018 + subsurfaceWave * mix(0.055, 0.36, vWaveNear) * (0.26 + crestBacklight * (0.55 + gWaterFacetLight * 0.45)))
              * (0.14 + uDay * 0.86)
              * mix(vec3(0.38), sunTrans, 0.76)
              * (1.0 - gWaterFoam * 0.84);
            // The broad low-sun lobe stays chromatic while the much narrower
            // solar core remains bright. Separating them avoids a clipped white
            // pillar and preserves the warm path across individual wave facets.
            float warmPath = (sunDot > 1e-5 && uSunset > 1e-4)
              ? (pow(sunDot, mix(18.0, 5.0, gWaterRoughness)) * 0.34 * glitterBreak
                + pow(sunDot, 2.4) * 0.038 * smoothstep(0.38, 0.78, glitterField)) * uSunset
              : 0.0;
            vec3 reflectedSunColor = mix(uSunColor, vec3(1.0, 0.12, 0.018),
              uSunset * 0.9);
            sunGlint *= mix(1.0, 0.012, uSunset);
            if (sunGlint + warmPath > 1e-6) {
              totalEmissiveRadiance += reflectedSunColor * (sunGlint + warmPath) * sunTrans;
            }
            if (secondGlint > 1e-6) {
              totalEmissiveRadiance += uSecondarySunColor * secondGlint
                * surfaceStellarTransmission(normalize(uSurfaceViewToLocal * vSecondarySunDirView));
            }
            totalEmissiveRadiance += vec3(0.38, 0.46, 0.52)
              * gWaterFoam * (0.05 + 0.065 * uDay);
            // Aerated wake water remains bright even when it interrupts a dark
            // reflection. Keeping this separate from generic shore foam makes
            // the two Kelvin shoulders legible in a normal chase camera.
            totalEmissiveRadiance += vec3(0.62, 0.72, 0.78)
              * gWaterWakeFoam * (0.08 + 0.07 * uDay);
            // Organisms respond to local agitation, not a uniformly emissive
            // planet. Daylight overwhelms the faint glow; breaking crests,
            // plankton lanes and vessel disturbance reveal luminous trails after dusk.
            float biologicalAgitation = clamp(gWaterFoam * 0.72
              + gWaterWakeFoam * 2.4
              + gWaterLangmuir * 1.15
              + smoothstep(0.05, 0.20, length(gWaterMacroSlope)) * 0.42, 0.0, 1.0);
            float biologicalNight = 1.0 - smoothstep(0.0, 0.22, uDay);
            totalEmissiveRadiance += uWaterBiolumColor
              * uBiologicalActivity * biologicalAgitation * biologicalNight * 2.45;
          }
        }`);
    installSurfaceAtmosphere(material, planet, shader);
  };
  material.customProgramCacheKey = () => `water-regional-wave-field-v37-cinematic-snell:${hasSurfaceCloudMedium(planet)}:${tidalField ? 'tidal' : 'ordinary'}`;
  return prepareSurfaceAtmosphere(material, planet);
}

// Procedural cloud coverage evaluated per-FRAGMENT: a texture-based fBm
// with an analytic threshold. A baked cloud texture shows its texels as
// hard squares from orbit; this is smooth at every distance.
export function applyCloudField(material, coverage, offX, offY, offZ, relief = 0,
  weatherMap = null, localLayer = null) {
  const tex = detailTexture();
  if (!tex) return material;
  const weatherTex = weatherMap || cloudSystemTexture(offX, offY, offZ);
  material.userData.weatherSystemTexture = weatherTex;
  material.userData.weatherSystemTextureOwned = !weatherMap;
  const weatherUniform = { value: weatherTex };
  material.userData.weatherSystemTextureNode = weatherUniform;
  const surfaceUniform = { value: localLayer?.surfaceAtlas || weatherTex };
  material.userData.surfaceSystemTextureNode = surfaceUniform;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudNoise = { value: tex };
    shader.uniforms.uWeatherSystem = weatherUniform;
    shader.uniforms.uWeatherReady = { value: weatherMap ? 1 : 0 };
    shader.uniforms.uSurfaceAtlas = surfaceUniform;
    shader.uniforms.uLocalLayer = { value: localLayer ? 1 : 0 };
    shader.uniforms.uLayerHigh = { value: localLayer?.high ? 1 : 0 };
    shader.uniforms.uSurfaceRange = { value: localLayer?.surfaceRange || 1 };
    shader.uniforms.uDeckBaseAltitude = { value: localLayer?.baseAltitude || 0 };
    shader.uniforms.uSurfaceSpin = { value: new THREE.Matrix3() };
    shader.uniforms.uCov0 = { value: 0.55 - coverage * 0.24 };
    shader.uniforms.uCov1 = { value: 0.86 - coverage * 0.14 };
    shader.uniforms.uCOff = { value: new THREE.Vector3(offX, offY, offZ) };
    shader.uniforms.uCloudRelief = { value: relief };
    // the shell fades away as the camera nears its own altitude — the
    // transit white-out fog takes over, so you fly THROUGH, never POP through
    shader.uniforms.uCamProx = { value: 1 };
    // The same angular pattern that reads as weather systems from orbit would
    // become continent-wide streaks when viewed from inside the shell. Blend
    // toward a denser inexpensive field for the low-tier surface sky.
    shader.uniforms.uSurfaceView = { value: 0 };
    // sun direction in the deck's own (rotating) frame, for self-shadowing
    shader.uniforms.uCSun = { value: new THREE.Vector3(0, 1, 0) };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uCloudNoise;
        uniform sampler2D uWeatherSystem;
        uniform sampler2D uSurfaceAtlas;
        uniform float uWeatherReady;
        uniform float uLocalLayer, uLayerHigh, uSurfaceRange, uDeckBaseAltitude;
        uniform mat3 uSurfaceSpin;
        ${weatherAtlasGLSL}
        uniform float uCov0;
        uniform float uCov1;
        uniform vec3 uCOff;
        uniform float uCloudRelief;
        varying vec3 vCDir;
        float cloudVertexFbm(vec3 d) {
          float f = texture2D(uCloudNoise, d.xy * 0.55 + uCOff.xy).g * 0.5;
          f += texture2D(uCloudNoise, d.yz * 1.15 + uCOff.yz).r * 0.25;
          f += texture2D(uCloudNoise, d.zx * 2.35 + uCOff.zx).g * 0.125;
          return f / 0.875;
        }
        float weatherSystem(vec3 d) {
          d /= abs(d.x) + abs(d.y) + abs(d.z);
          vec2 oct = d.xz;
          if (d.y < 0.0) oct = (1.0 - abs(oct.yx)) * sign(oct.xy);
          return texture2D(uWeatherSystem, oct * 0.5 + 0.5).r;
        }
        float cloudVertexAmount(vec3 d) {
          if (uWeatherReady > 0.5) {
            float amount = weatherAtlasSample(uWeatherSystem, d).r;
            return uLocalLayer > 0.5 ? synopticCoverage(amount, uLayerHigh > 0.5 ? 0.14 : 0.12) : amount;
          }
          float fine = cloudVertexFbm(d);
          float base = smoothstep(uCov0, uCov1, fine);
          float system = weatherSystem(d) * smoothstep(0.24, 0.68, fine) * 0.86;
          return max(base, system);
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCDir = normalize(position);
        float vertexCloud = cloudVertexAmount(vCDir);
        float altitudeShift = uCloudRelief * pow(vertexCloud, 1.15);
        if (uLocalLayer > 0.5) {
          vec4 layer = weatherAtlasSample(uSurfaceAtlas, vCDir);
          float surface = (weatherAtlasSample(uSurfaceAtlas,
            uSurfaceSpin * vCDir).g * 2.0 - 1.0) * uSurfaceRange;
          float targetAltitude = uLayerHigh > 0.5 ? 11200.0
            : max(250.0, surface + 350.0 + layer.a * 3850.0 + 1100.0);
          altitudeShift += targetAltitude - uDeckBaseAltitude;
        }
        transformed += vCDir * altitudeShift;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uCloudNoise;
        uniform sampler2D uWeatherSystem;
        uniform float uWeatherReady;
        uniform float uLocalLayer, uLayerHigh;
        ${weatherAtlasGLSL}
        uniform float uCov0;
        uniform float uCov1;
        uniform vec3 uCOff;
        uniform float uCamProx;
        uniform float uSurfaceView;
        uniform vec3 uCSun;
        varying vec3 vCDir;
        float cloudFbm(vec3 d) {
          float s = mix(1.0, 5.4, uSurfaceView);
          float f = texture2D(uCloudNoise, d.xy * (0.55 * s) + uCOff.xy).g * 0.5;
          f += texture2D(uCloudNoise, d.yz * (1.15 * s) + uCOff.yz).r * 0.25;
          f += texture2D(uCloudNoise, d.zx * (2.35 * s) + uCOff.zx).g * 0.125;
          f += texture2D(uCloudNoise, d.xy * (4.8 * s) - uCOff.xz).r * 0.0625;
          return f / 0.9375;
        }
        float weatherSystem(vec3 d) {
          d /= abs(d.x) + abs(d.y) + abs(d.z);
          vec2 oct = d.xz;
          if (d.y < 0.0) oct = (1.0 - abs(oct.yx)) * sign(oct.xy);
          return texture2D(uWeatherSystem, oct * 0.5 + 0.5).r;
        }
        float cloudAmount(vec3 d) {
          if (uWeatherReady > 0.5) {
            float amount = weatherAtlasSample(uWeatherSystem, d).r;
            return uLocalLayer > 0.5 ? synopticCoverage(amount, uLayerHigh > 0.5 ? 0.14 : 0.12) : amount;
          }
          float fine = cloudFbm(d);
          float base = smoothstep(
            uCov0 - 0.02 * uSurfaceView,
            uCov1 - 0.10 * uSurfaceView,
            fine);
          float system = weatherSystem(d) * smoothstep(0.24, 0.68, fine) * 0.86;
          return max(base, system);
        }`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        {
          vec3 nd = normalize(vCDir);
          float a = cloudAmount(nd);
          // Dense orbital cores must read as kilometres of suspended water,
          // not translucent paint on the planet. A sub-linear response keeps
          // broad opaque bodies while retaining soft procedural edges.
          diffuseColor.a *= pow(a, mix(0.95, 0.72, uSurfaceView)) * uCamProx;
          // volumetric look from one extra tap: density INCREASING toward
          // the sun means we're in a cloud's shadowed core; decreasing
          // means a sunlit edge. Thick cores also darken (their own bulk).
          float aSun = cloudAmount(normalize(nd + uCSun * 0.05));
          float self = clamp(1.0 - (aSun - a) * 1.9, 0.42, 1.18);
          diffuseColor.rgb *= self * (1.0 - a * 0.3);
        }`);
  };
  material.customProgramCacheKey = () => `cloud-field-v6-local:${localLayer ? (localLayer.high ? 'high' : 'low') : 'legacy'}`;
  return material;
}

// Wind: vegetation bends with a per-instance phase, stronger toward the tip.
// all scatter props share this scale: 1 on the ground, easing to 0 as the
// camera climbs out — thousands of props must never blink out in one frame
export const GROW = { value: 1 };

export function applyWindSway(material, amount, foliageLighting = false, frame = null) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TIME;
    shader.uniforms.uGrow = GROW;
    shader.uniforms.uSway = { value: amount };
    shader.uniforms.uWind = { value: WIND };
    shader.uniforms.uBendPos = { value: surfaceInteraction.positions };
    shader.uniforms.uBendData = { value: surfaceInteraction.data };
    shader.uniforms.uWindPhase = { value: new THREE.Vector4() };
    shader.uniforms.uWindFlutterPhase = { value: 0 };
    Object.assign(shader.uniforms, disturbanceUniforms());
    if (frame) Object.assign(shader.uniforms, frame.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uGrow;
        uniform float uSway;
        uniform vec4 uWind;
        uniform vec4 uWindPhase;
        uniform float uWindFlutterPhase;
        uniform vec4 uBendPos[${SURFACE_INTERACTION_CAP}];
        uniform vec4 uBendData[${SURFACE_INTERACTION_CAP}];
        ${DISTURBANCE_GLSL}
        // under a landing ship grass is flattened well past the hull and shrubs
        // bend over. Normals stay as authored: grass carries up-facing field
        // normals, and turning them with a flattened blade shades it black.
        mat3 plantBend() {
          #ifdef USE_INSTANCING
            ${amount > 0 ? `vec3 ip = instanceMatrix[3].xyz;
            float r = fract((ip.x * 0.61 + ip.y * 0.53 + ip.z * 0.47) * 0.137);
            return plantBendMatrix(plantDisturbance(ip, normalize(instanceMatrix[1].xyz), r, 1.25, 1.65),
              mat3(instanceMatrix));` : 'return mat3(1.0);'}
          #else
            return mat3(1.0);
          #endif
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          transformed *= uGrow;
          vec3 ip = instanceMatrix[3].xyz;
          float ph = ip.x * 0.61 + ip.y * 0.53 + ip.z * 0.47;
          float crush = plantPadCrush(ip, normalize(instanceMatrix[1].xyz), fract(ph * 0.137),
            ${amount > 0 ? '0.46, 0.58' : '0.36, 0.46'});
          float k = uSway * max(transformed.y, 0.0) * uWind.z * (1.0 - crush * 0.85);
          float gustEnvelope = 1.0 + uWind.w
            * (0.52 + 0.48 * sin(uTime * 0.23 + ph * 0.11 + uWindPhase.w));
          float along = (0.56 * sin(uTime * 0.82 + ph + uWindPhase.x)
            + 0.29 * sin(uTime * 1.9 + ph * 1.67 + uWindPhase.y)
            ${foliageLighting ? '+ 0.08 * sin(uTime * 7.6 + ph * 2.31 + uWindFlutterPhase)' : ''}) * gustEnvelope
            + 0.34 * uWind.z;
          float across = 0.13 * sin(uTime * 3.4 + ph * 0.73 + uWindPhase.z) * gustEnvelope;
          transformed.x += (uWind.x * along - uWind.y * across) * k;
          transformed.z += (uWind.y * along + uWind.x * across) * k;
          float pressure = 0.0;
          for (int i = 0; i < ${SURFACE_INTERACTION_CAP}; i++) {
            float d = distance(ip, uBendPos[i].xyz);
            float recovery = exp(-uBendData[i].x);
            pressure = max(pressure, (1.0 - smoothstep(0.0, uBendPos[i].w, d))
              * uBendData[i].y * recovery);
          }
          float tip = smoothstep(0.0, 0.65, max(transformed.y, 0.0));
          transformed.x += sin(ph + uWindPhase.x) * pressure * tip * 0.7;
          transformed.z += cos(ph + uWindPhase.x) * pressure * tip * 0.7;
          transformed.y *= 1.0 - pressure * tip * 0.68;
          transformed = plantBend() * transformed;
          transformed *= 1.0 - crush;
        }
        #endif`);
    if (material.vertexColors) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_COLOR
          ${foliageLighting && material.map
            ? 'totalEmissiveRadiance += diffuseColor.rgb * 0.2;'
            : 'totalEmissiveRadiance *= vColor.rgb;'}
        #endif`);
    }
    if (foliageLighting) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
          nonPerturbedNormal = normal;
        #endif`);
    }
  };
  // uSway carries the exact sway amplitude as a uniform; GLSL only branches on
  // amount > 0, so keying by boolean avoids compiling separate identical
  // programs for grassNear / grassMid / grassFar.
  material.customProgramCacheKey = () => 'wind-sway-v7-disturb-' + (amount > 0 ? 'sway' : 'rigid') + '-' + (foliageLighting ? (material.map ? 'card' : 'leaf') : 'solid');
  return material;
}

let _terrainDepthMat = null;

/**
 * Shared morph-aware depth material for shadow-casting terrain chunks so
 * directional shadows follow aLodMorph displacements without perimeter seams.
 */
export function terrainDepthMaterial() {
  if (_terrainDepthMat) return _terrainDepthMat;
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.customProgramCacheKey = () => 'terrain-lod-depth-v1';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aPositionDelta;
        attribute float aLodMorph;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += aPositionDelta * aLodMorph;`);
  };
  _terrainDepthMat = mat;
  return mat;
}
