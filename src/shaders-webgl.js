// Shader-level beauty: a shared procedural detail texture, triplanar
// micro-detail on terrain (so close-up ground has grain, not flat vertex
// color), animated water normals, and wind sway for vegetation.
// All injected via onBeforeCompile — no custom materials, three.js keeps
// doing lights/shadows/morphs/fog for us.

import * as THREE from 'three';
import { Simplex } from './noise.js';
import { makeRng } from './rng.js';
import { WATER_IMPULSE_CAP, waterInteraction } from './water-interaction.js';
import { SURFACE_INTERACTION_CAP, surfaceInteraction } from './surface-interaction.js';
import { surfaceMaterialSlots } from './surface-materials.js';

// one global clock drives water and wind everywhere
export const TIME = { value: 0 };
export function tickShaders(dt) { TIME.value += dt; }

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

// Triplanar terrain detail in stable planet-local space (the aLocal
// attribute — world space would swim under camera-relative rendering).
// Per-vertex biome weights (aMat) blend rock strata against organic mottle,
// micro-normals give relief, and the planet's own cloud layer casts moving
// shadows via one extra texture sample.
export function applyTerrainDetail(material, planet, strength = 0.2, macroK = 0.4, scale1 = 1 / 26, scale2 = 1 / 3.2) {
  const tex = detailTexture();
  if (!tex) return;
  material.onBeforeCompile = (shader) => {
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
    shader.uniforms.uDetailS = { value: new THREE.Vector2(scale1, scale2) };
    shader.uniforms.uCloudTex = { value: cloudTex };
    shader.uniforms.uCloudK = { value: planet.cloudMesh ? 0.42 : 0 };
    shader.uniforms.uCloudMat = { value: new THREE.Matrix3() };
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
    shader.uniforms.uSeaDepthSpan = { value: U.seaDepthSpan };
    shader.uniforms.uRockC = { value: U.rock };
    shader.uniforms.uSlopeLo = { value: U.slopeLo };
    shader.uniforms.uSlopeHi = { value: U.slopeHi };
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
    shader.uniforms.uMistH = { value: planet.hAmp * 0.12 };
    shader.uniforms.uMistColor = { value: planet.skyColor.clone().convertSRGBToLinear() };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute vec3 aLocal;
        attribute vec3 aMat;
        attribute vec4 aExtra;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec3 vMat;
        varying vec4 vExtra;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocalPos = aLocal;
        vLocalNrm = normal;
        vMat = aMat;
        vExtra = aExtra;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailTex;
        uniform sampler2D uGrassColor;
        uniform sampler2D uGrassNormal;
        uniform sampler2D uGrassOrm;
        uniform sampler2D uRockColor;
        uniform sampler2D uRockNormal;
        uniform sampler2D uRockRoughness;
        uniform float uEarthLike;
        uniform float uDetailK;
        uniform float uMacroK;
        uniform vec2 uDetailS;
        uniform sampler2D uCloudTex;
        uniform float uCloudK;
        uniform mat3 uCloudMat;
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
        uniform float uSeaDepthSpan;
        uniform vec3 uRockC;
        uniform float uSlopeLo;
        uniform float uSlopeHi;
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
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec3 vMat;
        varying vec4 vExtra;
        float gSnowW = 0.0;
        float gPatch = 0.0;
        float gSurfaceRoughness = 0.82;
        vec2 surfaceMaterialUv(vec3 p, vec3 n) {
          vec3 an = abs(n);
          if (an.x > an.y && an.x > an.z) return p.yz * 0.085;
          if (an.y > an.z) return p.zx * 0.085;
          return p.xy * 0.085;
        }
        float triDetail(vec3 p, vec3 w, float s, int ch) {
          vec2 a = texture2D(uDetailTex, p.yz * s).rg;
          vec2 b = texture2D(uDetailTex, p.zx * s).rg;
          vec2 c = texture2D(uDetailTex, p.xy * s).rg;
          vec2 m = a * w.x + b * w.y + c * w.z;
          return ch == 0 ? m.r : m.g;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // ---- the palette, per-pixel: exact height & slope, so coasts,
          // depth gradients and rock bands stay crisp at every distance
          vec3 nd = normalize(vLocalPos);
          float hgt = length(vLocalPos) - uPlanetR;
          float slope = 1.0 - clamp(dot(normalize(vLocalNrm), nd), 0.0, 1.0);
          vec3 base;
          if (uHasSea > 0.5 && hgt < uT0) {
            float t = clamp(1.0 - (uT0 - hgt) / uSeaDepthSpan, 0.0, 1.0);
            base = uSeaC[0];
            for (int i = 1; i < 7; i++) {
              if (float(i) >= uSeaN) break;
              base = mix(base, uSeaC[i],
                clamp((t - uSeaT[i - 1]) / max(uSeaT[i] - uSeaT[i - 1], 1e-5), 0.0, 1.0));
            }
          } else {
            float t = clamp((hgt - uT0) / uTSpan, 0.0, 1.0);
            base = uLandC[0];
            for (int i = 1; i < 7; i++) {
              if (float(i) >= uLandN) break;
              base = mix(base, uLandC[i],
                clamp((t - uLandT[i - 1]) / max(uLandT[i] - uLandT[i - 1], 1e-5), 0.0, 1.0));
            }
            base = mix(base, uForestC, vExtra.x);
            base = mix(base, uBlotchC, vExtra.y);
            if (uStripeK > 0.001) base = mix(base, mix(uStripeA, uStripeB, vExtra.z), uStripeK);
            if (uExtraMode > 2.5) base *= 1.0 + (vExtra.w - 0.5) * 0.2;
            else if (uExtraMode > 0.5) base = mix(base, uExtraC, vExtra.w);
            base = mix(base, uRockC, smoothstep(uSlopeLo, uSlopeHi, slope));
          }
          diffuseColor.rgb = base;

          // ---- baked ray-marched sun shadows: mountains shade whole
          // valleys, kilometres beyond the realtime shadow map's reach
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.78, 0.82, 0.9),
            diffuseColor.rgb, vMat.z);

          // ---- micro grain, biome-styled
          vec3 w = pow(abs(normalize(vLocalNrm)), vec3(4.0));
          w /= (w.x + w.y + w.z);
          float grain = (triDetail(vLocalPos, w, uDetailS.x, 0) - 0.5)
                      + (triDetail(vLocalPos, w, uDetailS.y, 1) - 0.5) * 0.8;
          float strat = texture2D(uDetailTex, vec2(length(vLocalPos) * 0.055, 0.31)).r - 0.5;
          float d = mix(grain, grain * 0.5 + strat * 1.15, vMat.x);
          d += (triDetail(vLocalPos, w, uDetailS.y * 0.32, 0) - 0.5) * vMat.y * 0.75;
          diffuseColor.rgb *= 1.0 + d * uDetailK;

          // Compressed scanned structure is restricted to the near field.
          // Alien palettes retain their authored hue while still inheriting
          // real soil/stone grain and roughness.
          float pbrNear = 1.0 - smoothstep(18.0, 92.0, length(vViewPosition));
          float pbrRock = smoothstep(uSlopeLo, uSlopeHi, slope);
          vec2 pbrUv = surfaceMaterialUv(vLocalPos, normalize(vLocalNrm));
          vec3 pbrGrass = texture2D(uGrassColor, pbrUv).rgb;
          vec3 pbrStone = texture2D(uRockColor, pbrUv * 0.78 + 0.17).rgb;
          vec3 pbrSample = mix(pbrGrass, pbrStone, pbrRock);
          float pbrLum = dot(pbrSample, vec3(0.2126, 0.7152, 0.0722));
          vec3 pbrStructure = mix(vec3(pbrLum), pbrSample, uEarthLike * 0.42);
          pbrStructure = clamp(pbrStructure * 1.45, vec3(0.58), vec3(1.42));
          diffuseColor.rgb *= mix(vec3(1.0), pbrStructure, pbrNear * 0.48);
          gSurfaceRoughness = mix(texture2D(uGrassOrm, pbrUv).g,
            texture2D(uRockRoughness, pbrUv * 0.78 + 0.17).r, pbrRock);

          // ---- continental-scale tint drift: dry-brown swathes
          float macro = triDetail(vLocalPos, w, 0.0013, 0)
                      + triDetail(vLocalPos, w, 0.00028, 1) - 1.0;
          float mw = clamp(macro * 1.5 + 0.5, 0.0, 1.0) * uMacroK;
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.09, 0.99, 0.84), mw);

          // ---- mid-scale patchiness (~100–500 m): soil and moisture
          // variation seen from a hilltop — the octave between micro grain
          // and continental swathes that uniform game terrain lacks
          float pch = triDetail(vLocalPos, w, 0.0035, 1)
                    + triDetail(vLocalPos, w, 0.0012, 0) - 1.0;
          gPatch = pch;
          diffuseColor.rgb *= 1.0 + pch * (0.30 + 0.20 * vMat.z) * (0.5 + uMacroK);
          // damp hollows darken and cool slightly
          diffuseColor.rgb = mix(diffuseColor.rgb,
            diffuseColor.rgb * vec3(0.88, 0.97, 0.92),
            clamp(-pch * 1.8, 0.0, 0.5) * uMacroK);

          // ---- per-pixel snowline: crisp caps from orbit
          if (uSnowK > 0.5) {
            float lat = abs(nd.y) + (texture2D(uDetailTex, nd.xz * 2.0 + nd.y).r - 0.5) * 0.12;
            float sl = uSnowLine * (1.0 - 0.65 * smoothstep(0.45, 0.95, lat));
            float sw = smoothstep(sl, sl + uSnowBand, hgt);
            sw = max(sw, smoothstep(uSnowCap, uSnowCap + 0.07, lat));
            sw *= 1.0 - smoothstep(0.55, 0.8, slope) * 0.85;
            diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, sw);
            gSnowW = sw;
          }

          // ---- the cloud deck overhead casts drifting shadows
          vec3 cd = uCloudMat * nd;
          float cu = 0.5 + atan(cd.z, -cd.x) * 0.15915494;
          float cvv = 1.0 - acos(clamp(cd.y, -1.0, 1.0)) * 0.31830988;
          diffuseColor.rgb *= 1.0 - texture2D(uCloudTex, vec2(cu, cvv)).g * uCloudK;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // snow glints, damp hollows go faintly glossy, dry rises stay matte —
        // low-sun specular variation is a big part of ground reading as real
        roughnessFactor = clamp(roughnessFactor - gSnowW * 0.34 + gPatch * 0.12, 0.38, 1.0);
        float pbrNearRough = 1.0 - smoothstep(18.0, 92.0, length(vViewPosition));
        roughnessFactor = mix(roughnessFactor, clamp(gSurfaceRoughness, 0.38, 1.0), pbrNearRough * 0.35);`)
      .replace('#include <fog_fragment>', `
        #ifdef USE_FOG
        {
          // valley mist: haze pools in the low country and thickens with
          // distance — the depth cue that sells scale from altitude
          float mist = uMistK
            * smoothstep(uMistH, 0.0, (length(vLocalPos) - uPlanetR) - uT0)
            * (1.0 - exp(-vFogDepth * 3.2e-4));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uMistColor, clamp(mist, 0.0, 0.6));
        }
        #endif
        #include <fog_fragment>`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          // micro-relief: bend the shading normal with the same detail field —
          // this, more than geometry, is what makes ground read as *real*
          vec3 wN = pow(abs(normalize(vLocalNrm)), vec3(4.0));
          wN /= (wN.x + wN.y + wN.z);
          float gx = triDetail(vLocalPos + vec3(0.35, 0.0, 0.0), wN, uDetailS.y, 1)
                   - triDetail(vLocalPos - vec3(0.35, 0.0, 0.0), wN, uDetailS.y, 1);
          float gy = triDetail(vLocalPos + vec3(0.0, 0.35, 0.0), wN, uDetailS.y, 1)
                   - triDetail(vLocalPos - vec3(0.0, 0.35, 0.0), wN, uDetailS.y, 1);
          vec3 ndPbr = normalize(vLocalPos);
          float slopePbr = 1.0 - clamp(dot(normalize(vLocalNrm), ndPbr), 0.0, 1.0);
          float rockPbr = smoothstep(uSlopeLo, uSlopeHi, slopePbr);
          vec2 uvPbr = surfaceMaterialUv(vLocalPos, normalize(vLocalNrm));
          vec2 grassN = texture2D(uGrassNormal, uvPbr).xy * 2.0 - 1.0;
          vec2 rockN = texture2D(uRockNormal, uvPbr * 0.78 + 0.17).xy * 2.0 - 1.0;
          vec2 scanN = mix(grassN, rockN, rockPbr);
          float scanNear = 1.0 - smoothstep(8.0, 72.0, length(vViewPosition));
          gx += scanN.x * scanNear * 0.34;
          gy += scanN.y * scanNear * 0.34;
          vec3 tang = normalize(cross(normal, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
          vec3 bitn = cross(normal, tang);
          normal = normalize(normal + (tang * gx + bitn * gy) * uDetailK * (1.7 + vMat.x * 1.5));
        }`);
  };
  material.customProgramCacheKey = () => 'terrain-layered-pbr-v6-ktx2';
}

// Living water: scrolling normal perturbation, plus Beer–Lambert depth
// absorption — the terrain depth beneath each vertex is baked at build, so
// deeps go dark, shallows glow, and shorelines fade in softly.
export function applyWaterWaves(material, planet, waveScale = 1 / 14) {
  const tex = detailTexture();
  if (!tex) return;
  material.depthWrite = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailTex = { value: tex };
    shader.uniforms.uTime = TIME;
    shader.uniforms.uWaveS = { value: waveScale };
    const deep = planet && planet.pal && planet.pal.sea
      ? planet.pal.sea[0].c.clone().lerp(planet.liquidColor.clone().convertSRGBToLinear(), 0.4)
      : new THREE.Color(0.02, 0.08, 0.15);
    const shallow = planet
      ? planet.liquidColor.clone().convertSRGBToLinear().lerp(new THREE.Color(1, 1, 1), 0.3)
      : new THREE.Color(0.4, 0.75, 0.8);
    shader.uniforms.uDeepC = { value: deep };
    shader.uniforms.uShallowC = { value: shallow };
    // grazing angles mirror the sky instead of showing the deep diffuse —
    // without this, water toward the horizon reads as a near-black sheet
    const sky = planet && planet.skyColor
      ? planet.skyColor.clone().convertSRGBToLinear().multiplyScalar(1.15)
      : new THREE.Color(0.25, 0.4, 0.55);
    shader.uniforms.uSkyC = { value: sky };
    shader.uniforms.uRipplePos = { value: waterInteraction.positions };
    shader.uniforms.uRippleData = { value: waterInteraction.data };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute vec3 aLocal;
        attribute float aDepth;
        varying vec3 vLocalPos;
        varying vec3 vWaveT;
        varying vec3 vWaveB;
        varying float vDepth;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocalPos = aLocal;
        vDepth = aDepth;
        vec3 waveUp = normalize(aLocal);
        vec3 waveT = normalize(cross(waveUp, abs(waveUp.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 waveB = cross(waveUp, waveT);
        float macroWave = sin((aLocal.x + aLocal.z) * 0.016 + uTime * 0.82) * 0.26
          + sin((aLocal.z - aLocal.y * 0.7) * 0.027 - uTime * 1.07) * 0.14
          + sin((aLocal.x * 0.55 + aLocal.y) * 0.043 + uTime * 1.34) * 0.07;
        transformed += waveUp * macroWave;
        vWaveT = normalize(normalMatrix * waveT);
        vWaveB = normalize(normalMatrix * waveB);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailTex;
        uniform float uTime;
        uniform float uWaveS;
        uniform vec3 uDeepC;
        uniform vec3 uShallowC;
        uniform vec3 uSkyC;
        uniform vec3 uRipplePos[${WATER_IMPULSE_CAP}];
        uniform vec4 uRippleData[${WATER_IMPULSE_CAP}];
        varying vec3 vLocalPos;
        varying vec3 vWaveT;
        varying vec3 vWaveB;
        varying float vDepth;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float dep = max(vDepth, 0.0);
          float ab = 1.0 - exp(-dep * 0.05);          // absorption e-fold ~20 m
          diffuseColor.rgb = mix(uShallowC, uDeepC, ab);
          // shorelines fade in instead of cutting a hard waterline
          diffuseColor.a *= mix(0.22, 1.0, 1.0 - exp(-dep * 0.12));
          // Fresnel: at grazing angles the surface turns into a sky mirror
          // (abs() so the DoubleSide underside behaves when submerged)
          float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 5.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, uSkyC, fres * 0.65);
          diffuseColor.a = mix(diffuseColor.a, min(1.0, diffuseColor.a * 2.2 + 0.25), fres);
          float shoreFoam = (1.0 - smoothstep(0.25, 3.2, dep))
            * (0.55 + 0.45 * sin(dep * 7.0 + uTime * 1.8));
          float wakeFoam = 0.0;
          for (int i = 0; i < ${WATER_IMPULSE_CAP}; i++) {
            vec4 rd = uRippleData[i];
            vec3 delta = vLocalPos - uRipplePos[i];
            float dist = length(delta);
            float ring = dist - rd.x * rd.y;
            float envelope = exp(-abs(ring) * 0.24 - rd.x * 0.42) * rd.z;
            wakeFoam += (0.32 + 0.68 * max(0.0, sin(ring * 1.4)))
              * envelope * rd.w * 1.75;
          }
          float foam = clamp(shoreFoam * 0.42 + wakeFoam, 0.0, 0.92);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.97, 1.0), foam);
        }`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 upL = normalize(vLocalPos);
          vec3 tanL = normalize(cross(upL, abs(upL.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 bitL = cross(upL, tanL);
          vec2 surfaceUv = vec2(dot(vLocalPos, tanL), dot(vLocalPos, bitL));
          vec2 uv1 = surfaceUv * uWaveS + vec2(uTime * 0.021, uTime * -0.013);
          vec2 uv2 = surfaceUv * uWaveS * 3.7 + vec2(uTime * -0.033, uTime * 0.027);
          vec2 g = (texture2D(uDetailTex, uv1).rg - 0.5) * 0.5
                 + (texture2D(uDetailTex, uv2).rg - 0.5) * 0.3;
          for (int i = 0; i < ${WATER_IMPULSE_CAP}; i++) {
            vec4 rd = uRippleData[i];
            vec3 delta = vLocalPos - uRipplePos[i];
            vec2 planar = vec2(dot(delta, tanL), dot(delta, bitL));
            float dist = length(planar);
            float ring = dist - rd.x * rd.y;
            float envelope = exp(-abs(ring) * 0.24 - rd.x * 0.42) * rd.z;
            g += planar / max(dist, 0.05) * cos(ring * 1.4) * envelope * 0.72;
          }
          normal = normalize(normal + (vWaveT * g.x + vWaveB * g.y) * 0.55);
        }`);
  };
  material.customProgramCacheKey = () => 'water-tangent-wakes-v3';
}

// Procedural cloud coverage evaluated per-FRAGMENT: a texture-based fBm
// with an analytic threshold. A baked cloud texture shows its texels as
// hard squares from orbit; this is smooth at every distance.
export function applyCloudField(material, coverage, offX, offY, offZ, relief = 0) {
  const tex = detailTexture();
  if (!tex) return;
  const weatherTex = cloudSystemTexture(offX, offY, offZ);
  material.userData.weatherSystemTexture = weatherTex;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudNoise = { value: tex };
    shader.uniforms.uWeatherSystem = { value: weatherTex };
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
          float fine = cloudVertexFbm(d);
          float base = smoothstep(uCov0, uCov1, fine);
          float system = weatherSystem(d) * smoothstep(0.24, 0.68, fine) * 0.86;
          return max(base, system);
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCDir = normalize(position);
        float vertexCloud = cloudVertexAmount(vCDir);
        transformed += vCDir * uCloudRelief * pow(vertexCloud, 1.15);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uCloudNoise;
        uniform sampler2D uWeatherSystem;
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
  material.customProgramCacheKey = () => 'cloud-field-v4-surface-fallback';
}

// Wind: vegetation bends with a per-instance phase, stronger toward the tip.
// all scatter props share this scale: 1 on the ground, easing to 0 as the
// camera climbs out — thousands of props must never blink out in one frame
export const GROW = { value: 1 };

export function applyWindSway(material, amount, foliageLighting = false) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TIME;
    shader.uniforms.uGrow = GROW;
    shader.uniforms.uSway = { value: amount };
    shader.uniforms.uBendPos = { value: surfaceInteraction.positions };
    shader.uniforms.uBendData = { value: surfaceInteraction.data };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uGrow;
        uniform float uSway;
        uniform vec4 uBendPos[${SURFACE_INTERACTION_CAP}];
        uniform vec4 uBendData[${SURFACE_INTERACTION_CAP}];`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          transformed *= uGrow;
          vec3 ip = instanceMatrix[3].xyz;
          float ph = ip.x * 0.61 + ip.y * 0.53 + ip.z * 0.47;
          float k = uSway * max(transformed.y, 0.0);
          transformed.x += (sin(uTime * 1.6 + ph) + 0.4 * sin(uTime * 3.7 + ph * 1.7)) * k;
          transformed.z += (cos(uTime * 1.3 + ph * 1.3) + 0.4 * sin(uTime * 2.9 + ph)) * k * 0.7;
          float pressure = 0.0;
          for (int i = 0; i < ${SURFACE_INTERACTION_CAP}; i++) {
            float d = distance(ip, uBendPos[i].xyz);
            float recovery = exp(-uBendData[i].x);
            pressure = max(pressure, (1.0 - smoothstep(0.0, uBendPos[i].w, d))
              * uBendData[i].y * recovery);
          }
          float tip = smoothstep(0.0, 0.65, max(transformed.y, 0.0));
          transformed.x += sin(ph) * pressure * tip * 0.7;
          transformed.z += cos(ph) * pressure * tip * 0.7;
          transformed.y *= 1.0 - pressure * tip * 0.68;
        }
        #endif`);
    if (material.vertexColors) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef USE_COLOR
          totalEmissiveRadiance *= vColor.rgb;
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
  material.customProgramCacheKey = () => 'wind-sway-' + amount + '-' + (foliageLighting ? 'leaf' : 'solid');
}
