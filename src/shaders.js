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

// Triplanar two-scale albedo grain, sampled in stable planet-local space
// (the aLocal attribute baked by the chunk builder — world space would swim
// under camera-relative rendering).
export function applyTerrainDetail(material, strength = 0.2, scale1 = 1 / 26, scale2 = 1 / 3.2) {
  const tex = detailTexture();
  if (!tex) return;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailTex = { value: tex };
    shader.uniforms.uDetailK = { value: strength };
    shader.uniforms.uDetailS = { value: new THREE.Vector2(scale1, scale2) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aLocal;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocalPos = aLocal;
        vLocalNrm = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetailTex;
        uniform float uDetailK;
        uniform vec2 uDetailS;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        float triDetail(vec3 p, vec3 w, float s, int ch) {
          vec2 a = texture2D(uDetailTex, p.yz * s).rg;
          vec2 b = texture2D(uDetailTex, p.zx * s).rg;
          vec2 c = texture2D(uDetailTex, p.xy * s).rg;
          vec2 m = a * w.x + b * w.y + c * w.z;
          return ch == 0 ? m.r : m.g;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 w = pow(abs(normalize(vLocalNrm)), vec3(4.0));
          w /= (w.x + w.y + w.z);
          float d = (triDetail(vLocalPos, w, uDetailS.x, 0) - 0.5)
                  + (triDetail(vLocalPos, w, uDetailS.y, 1) - 0.5) * 0.8;
          diffuseColor.rgb *= 1.0 + d * uDetailK;
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
          normal = normalize(normal + (tang * gx + bitn * gy) * uDetailK * 1.6);
        }`);
  };
  material.customProgramCacheKey = () => 'terrain-detail';
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
