// Shader-level beauty: a shared procedural detail texture, triplanar
// micro-detail on terrain (so close-up ground has grain, not flat vertex
// color), animated water normals, and wind sway for vegetation.
// All injected via onBeforeCompile — no custom materials, three.js keeps
// doing lights/shadows/morphs/fog for us.

import * as THREE from 'three';
import { Simplex } from './noise.js';
import { makeRng } from './rng.js';

// one global clock drives water and wind everywhere
export const TIME = { value: 0 };
export function tickShaders(dt) { TIME.value += dt; }

let _detailTex = null;
export function detailTexture() {
  if (_detailTex || typeof document === 'undefined') return _detailTex;
  const S = 256;
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
  _detailTex = new THREE.CanvasTexture(canvas);
  _detailTex.wrapS = _detailTex.wrapT = THREE.RepeatWrapping;
  _detailTex.colorSpace = THREE.NoColorSpace;
  return _detailTex;
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
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aLocal;
        attribute vec2 aMat;
        attribute vec4 aExtra;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec2 vMat;
        varying vec4 vExtra;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocalPos = aLocal;
        vLocalNrm = normal;
        vMat = aMat;
        vExtra = aExtra;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailTex;
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
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec2 vMat;
        varying vec4 vExtra;
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

          // ---- micro grain, biome-styled
          vec3 w = pow(abs(normalize(vLocalNrm)), vec3(4.0));
          w /= (w.x + w.y + w.z);
          float grain = (triDetail(vLocalPos, w, uDetailS.x, 0) - 0.5)
                      + (triDetail(vLocalPos, w, uDetailS.y, 1) - 0.5) * 0.8;
          float strat = texture2D(uDetailTex, vec2(length(vLocalPos) * 0.055, 0.31)).r - 0.5;
          float d = mix(grain, grain * 0.5 + strat * 1.15, vMat.x);
          d += (triDetail(vLocalPos, w, uDetailS.y * 0.32, 0) - 0.5) * vMat.y * 0.75;
          diffuseColor.rgb *= 1.0 + d * uDetailK;

          // ---- continental-scale tint drift: dry-brown swathes
          float macro = triDetail(vLocalPos, w, 0.0013, 0)
                      + triDetail(vLocalPos, w, 0.00028, 1) - 1.0;
          float mw = clamp(macro * 1.5 + 0.5, 0.0, 1.0) * uMacroK;
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.09, 0.99, 0.84), mw);

          // ---- per-pixel snowline: crisp caps from orbit
          if (uSnowK > 0.5) {
            float lat = abs(nd.y) + (texture2D(uDetailTex, nd.xz * 2.0 + nd.y).r - 0.5) * 0.12;
            float sl = uSnowLine * (1.0 - 0.65 * smoothstep(0.45, 0.95, lat));
            float sw = smoothstep(sl, sl + uSnowBand, hgt);
            sw = max(sw, smoothstep(uSnowCap, uSnowCap + 0.07, lat));
            sw *= 1.0 - smoothstep(0.55, 0.8, slope) * 0.85;
            diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, sw);
          }

          // ---- the cloud deck overhead casts drifting shadows
          vec3 cd = uCloudMat * nd;
          float cu = 0.5 + atan(cd.z, -cd.x) * 0.15915494;
          float cvv = 1.0 - acos(clamp(cd.y, -1.0, 1.0)) * 0.31830988;
          diffuseColor.rgb *= 1.0 - texture2D(uCloudTex, vec2(cu, cvv)).g * uCloudK;
        }`)
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
          vec3 tang = normalize(cross(normal, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
          vec3 bitn = cross(normal, tang);
          normal = normalize(normal + (tang * gx + bitn * gy) * uDetailK * (1.1 + vMat.x * 1.2));
        }`);
  };
  material.customProgramCacheKey = () => 'terrain-palette-v3';
}

// Living water: two scrolling noise scales perturb the shading normal.
export function applyWaterWaves(material, waveScale = 1 / 14) {
  const tex = detailTexture();
  if (!tex) return;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailTex = { value: tex };
    shader.uniforms.uTime = TIME;
    shader.uniforms.uWaveS = { value: waveScale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aLocal;
        varying vec3 vLocalPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocalPos = aLocal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailTex;
        uniform float uTime;
        uniform float uWaveS;
        varying vec3 vLocalPos;`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec2 uv1 = vLocalPos.xy * uWaveS + vec2(uTime * 0.021, uTime * -0.013);
          vec2 uv2 = vLocalPos.yz * uWaveS * 3.7 + vec2(uTime * -0.033, uTime * 0.027);
          vec2 g = (texture2D(uDetailTex, uv1).rg - 0.5) * 0.5
                 + (texture2D(uDetailTex, uv2).rg - 0.5) * 0.3;
          normal = normalize(normal + vec3(g.x, g.y, 0.0) * 0.55);
        }`);
  };
  material.customProgramCacheKey = () => 'water-waves';
}

// Procedural cloud coverage evaluated per-FRAGMENT: a texture-based fBm
// with an analytic threshold. A baked cloud texture shows its texels as
// hard squares from orbit; this is smooth at every distance.
export function applyCloudField(material, coverage, offX, offY, offZ) {
  const tex = detailTexture();
  if (!tex) return;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudNoise = { value: tex };
    shader.uniforms.uCov0 = { value: 0.55 - coverage * 0.24 };
    shader.uniforms.uCov1 = { value: 0.86 - coverage * 0.14 };
    shader.uniforms.uCOff = { value: new THREE.Vector3(offX, offY, offZ) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCDir;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCDir = normalize(position);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uCloudNoise;
        uniform float uCov0;
        uniform float uCov1;
        uniform vec3 uCOff;
        varying vec3 vCDir;
        float cloudFbm(vec3 d) {
          float f = texture2D(uCloudNoise, d.xy * 0.55 + uCOff.xy).g * 0.5;
          f += texture2D(uCloudNoise, d.yz * 1.15 + uCOff.yz).r * 0.25;
          f += texture2D(uCloudNoise, d.zx * 2.35 + uCOff.zx).g * 0.125;
          f += texture2D(uCloudNoise, d.xy * 4.8 - uCOff.xz).r * 0.0625;
          return f / 0.9375;
        }`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        {
          float a = smoothstep(uCov0, uCov1, cloudFbm(normalize(vCDir)));
          diffuseColor.a *= pow(a, 1.3);
        }`);
  };
  material.customProgramCacheKey = () => 'cloud-field';
}

// Wind: vegetation bends with a per-instance phase, stronger toward the tip.
export function applyWindSway(material, amount) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = TIME;
    shader.uniforms.uSway = { value: amount };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          vec3 ip = instanceMatrix[3].xyz;
          float ph = ip.x * 0.61 + ip.y * 0.53 + ip.z * 0.47;
          float k = uSway * max(transformed.y, 0.0);
          transformed.x += (sin(uTime * 1.6 + ph) + 0.4 * sin(uTime * 3.7 + ph * 1.7)) * k;
          transformed.z += (cos(uTime * 1.3 + ph * 1.3) + 0.4 * sin(uTime * 2.9 + ph)) * k * 0.7;
        }
        #endif`);
  };
  material.customProgramCacheKey = () => 'wind-sway-' + amount;
}
