// Shared first-person viewmodel building blocks extracted from Saltline's PAC-9
// (`src/saltline/pac9-viewmodel.js`) and extended for multi-weapon arsenals:
//   - Real-time planetary sun/sky environment uniforms for optic glass
//   - Micro-detail & rain-bead PBR shader patcher (chainable on existing shaders)
//   - Articulated gloved hands (`buildHand`) + right/left hand rig helpers
//   - Volumetric/starburst muzzle flash (`buildMuzzleFlash`)
//   - Parallax-free reflex/holo/chevron/microdot lens (`buildOpticLens`)
//   - Live magnified scope ocular display (`buildMagnifiedScopeDisplay`)
//   - Critically-damped spring & pose math utilities
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const Quat = THREE.Quaternion;
const Mat4 = THREE.Matrix4;

// ------------------------------------------------------------ math & springs

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (v) => Math.min(1, Math.max(0, v));

export function smoothstep(edge0, edge1, x) {
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function smootherstep(x) {
  const t = saturate(x);
  return t * t * t * (t * (6 * t - 15) + 10);
}

export const damp = (current, target, lambda, dt) =>
  target + (current - target) * Math.exp(-lambda * dt);

export const spring = (k, d) => ({ x: 0, v: 0, k, c: d });

export function stepSpring(s, target, dt) {
  const steps = dt > 0.012 ? Math.ceil(dt / 8e-3) : 1;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += ((target - s.x) * s.k - s.v * s.c) * h;
    s.x += s.v * h;
  }
  return s.x;
}

export const quatEuler = (x, y, z, order = 'XYZ') =>
  new Quat().setFromEuler(new THREE.Euler(x, y, z, order));

export const triangleCount = (geo) => {
  if (!geo?.attributes?.position) return 0;
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
};

export function countObjectTriangles(root) {
  let total = 0;
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry) total += triangleCount(obj.geometry);
  });
  return Math.round(total);
}

// ------------------------------------------------ shared lens sun/sky & rain

export const SHARED_LENS_SUN = {
  dir: new THREE.Vector3(0.916, 0.225, 0.331).normalize(),
  color: new THREE.Color(1, 0.72, 0.42),
  up: new THREE.Vector3(0, 1, 0),
};

export const SHARED_LENS_SKY = {
  zenith: new THREE.Color(0.055, 0.085, 0.13),
  horizon: new THREE.Color(0.95, 0.55, 0.28),
  horizonAway: new THREE.Color(0.16, 0.22, 0.3),
};

function assignVec3(dst, src, normalizeVec = false) {
  if (!src) return;
  if (src.isVector3) dst.copy(src);
  else if (Array.isArray(src)) dst.set(src[0] ?? 0, src[1] ?? 0, src[2] ?? 0);
  else if (typeof src === 'object' && 'x' in src) dst.set(src.x, src.y, src.z);
  if (normalizeVec && dst.lengthSq() > 1e-10) dst.normalize();
}

function assignColor(dst, src) {
  if (src == null) return;
  if (src.isColor) dst.copy(src);
  else if (Array.isArray(src)) dst.setRGB(src[0] ?? 0, src[1] ?? 0, src[2] ?? 0);
  else dst.set(src);
}

export function setLensEnvironment({
  sunDir,
  sunColor,
  skyZenith,
  skyHorizon,
  skyHorizonAway,
  worldUp,
} = {}) {
  assignVec3(SHARED_LENS_SUN.dir, sunDir, true);
  assignColor(SHARED_LENS_SUN.color, sunColor);
  assignVec3(SHARED_LENS_SUN.up, worldUp, true);
  assignColor(SHARED_LENS_SKY.zenith, skyZenith);
  assignColor(SHARED_LENS_SKY.horizon, skyHorizon);
  assignColor(SHARED_LENS_SKY.horizonAway, skyHorizonAway);
}

export const SHARED_RAIN_WETNESS = { value: 0 };

const DETAIL_COMMON_GLSL = `
varying vec3 vVmObjP;
varying vec3 vVmWNrm;
varying vec3 vVmONrm;
uniform float uVmDetailKind;
uniform float uRain;
uniform vec3 uVmWorldUp;
float vmDh3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vmDn3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(vmDh3(i), vmDh3(i + vec3(1,0,0)), f.x), mix(vmDh3(i + vec3(0,1,0)), vmDh3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(vmDh3(i + vec3(0,0,1)), vmDh3(i + vec3(1,0,1)), f.x), mix(vmDh3(i + vec3(0,1,1)), vmDh3(i + vec3(1,1,1)), f.x), f.y),
    f.z
  );
}
vec2 vmDh2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
vec2 vmDrops(vec2 uv, float cell, float seed){
  vec2 g = uv / cell, i = floor(g), f = fract(g);
  float best = 0.0;
  for (int a = -1; a <= 1; a++) {
    for (int b = -1; b <= 1; b++) {
      vec2 o = vec2(float(a), float(b));
      vec2 r = vmDh2(i + o + seed);
      float keep = step(0.70, fract(r.x * 7.31 + r.y * 3.17));
      vec2 c = o + 0.2 + 0.6 * r;
      float rad = (0.16 + 0.22 * fract(r.x * 13.7)) * keep;
      float d = length(f - c);
      best = max(best, sqrt(max(rad * rad - d * d, 0.0)));
    }
  }
  return vec2(best * cell, step(1e-6, best));
}
vec3 vmBump(vec3 N, float h){
  vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g);
}
`;

const DETAIL_ROUGHNESS_GLSL = `
vec3 vmDP = vVmObjP;
vec3 vmDAn = abs(vVmONrm);
vec2 vmDUV = (vmDAn.y > vmDAn.x && vmDAn.y > vmDAn.z) ? vmDP.xz : (vmDAn.x > vmDAn.z ? vmDP.zy : vmDP.xy);
float vmDSm = vmDn3(vmDP * 36.0), vmDSm2 = vmDn3(vmDP * 150.0 + 7.0), vmDFine = vmDn3(vmDP * 2400.0);
float vmDHt = 0.0, vmDR = 0.0;
if (uVmDetailKind >= 0.0) {
  if (uVmDetailKind < 0.5) {
    float scuff = smoothstep(0.70, 0.9, vmDn3(vmDP * vec3(420.0, 420.0, 26.0) + 3.0));
    float smudge = smoothstep(0.55, 0.8, vmDn3(vmDP * 55.0 + 11.0));
    vmDR = (vmDSm - 0.5) * 0.20 + (vmDSm2 - 0.5) * 0.10 + (vmDFine - 0.5) * 0.08 + scuff * 0.18 - smudge * 0.12;
    vmDHt = vmDFine * 0.000010 - scuff * 0.000015;
  } else if (uVmDetailKind < 1.5) {
    float ring = sin(vmDP.z * 5200.0) * 0.5 + 0.5, streak = vmDn3(vec3(vmDP.z * 950.0, 1.0, 2.0));
    vmDR = (streak - 0.5) * 0.26 + (vmDSm - 0.5) * 0.14 + (vmDFine - 0.5) * 0.10;
    vmDHt = ring * 0.000014 + vmDFine * 0.000010;
  } else {
    float st = vmDn3(vmDP * 1500.0) * 0.6 + vmDn3(vmDP * 3100.0 + 5.0) * 0.4;
    vmDR = (vmDSm - 0.5) * 0.18 + (st - 0.5) * 0.14 - smoothstep(0.6, 0.85, vmDSm2) * 0.10;
    vmDHt = st * 0.000075;
  }
  roughnessFactor = clamp(roughnessFactor + vmDR, 0.10, 1.0);
}
float vmDUp = smoothstep(0.28, 0.75, dot(normalize(vVmWNrm), normalize(uVmWorldUp))) * uRain;
vec2 vmDD1 = vmDrops(vmDUV, 0.0046, 3.0), vmDD2 = vmDrops(vmDUV + 0.31, 0.0023, 9.0);
float vmDDrop = max(vmDD1.y, vmDD2.y) * vmDUp, vmDDropH = max(vmDD1.x, vmDD2.x) * vmDUp;
float vmDWet = vmDUp * (0.5 + 0.5 * smoothstep(0.3, 0.7, vmDSm));
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.5, vmDWet);
roughnessFactor = mix(roughnessFactor, 0.10, vmDDrop);
diffuseColor.rgb *= 1.0 - 0.18 * vmDWet;
`;

const DETAIL_NORMAL_GLSL = `
normal = vmBump(normal, vmDHt + vmDDropH * 0.32);
`;

// Patch a MeshStandardMaterial / MeshPhysicalMaterial with Saltline's procedural
// micro-detail (kind 0 = anodised, 1 = machined steel, 2 = polymer, -1 = wetness
// & rain beads only, preserving existing wear/camo shaders). Safe to chain onto
// materials that already define `onBeforeCompile`.
export function applyDetailShader(material, kind = 0, wetUniform = SHARED_RAIN_WETNESS) {
  if (!material || (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial)) {
    return material;
  }
  if (material.userData?._vmDetailPatched) {
    material.userData._vmWetUniform = wetUniform;
    return material;
  }
  const prevCompile = material.onBeforeCompile;
  const prevCacheKey = typeof material.customProgramCacheKey === 'function'
    ? material.customProgramCacheKey.bind(material)
    : null;
  material.userData = material.userData || {};
  material.userData._vmDetailPatched = true;
  material.userData._vmWetUniform = wetUniform;

  material.onBeforeCompile = (shader, renderer) => {
    if (prevCompile && prevCompile !== THREE.Material.prototype.onBeforeCompile) {
      prevCompile(shader, renderer);
    }
    shader.uniforms.uVmDetailKind = { value: kind };
    shader.uniforms.uRain = material.userData._vmWetUniform || wetUniform;
    shader.uniforms.uVmWorldUp = { value: SHARED_LENS_SUN.up };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vVmObjP; varying vec3 vVmWNrm; varying vec3 vVmONrm;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvVmObjP = position; vVmONrm = normal; vVmWNrm = normalize(mat3(modelMatrix) * normal);'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DETAIL_COMMON_GLSL)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + DETAIL_ROUGHNESS_GLSL);
    if (shader.fragmentShader.includes('#include <normal_fragment_maps>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n' + DETAIL_NORMAL_GLSL
      );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clearcoat_normal_fragment_begin>',
        DETAIL_NORMAL_GLSL + '\n#include <clearcoat_normal_fragment_begin>'
      );
    }
  };
  material.customProgramCacheKey = () => {
    const base = prevCacheKey ? prevCacheKey() : '';
    return `${base}|vm-detail-${kind}`;
  };
  return material;
}

// ------------------------------------------------ Saltline base materials

export const SALTLINE_BASE_COLOURS = {
  brass: () => new THREE.MeshStandardMaterial({
    color: 0xc29a45, roughness: 0.42, metalness: 1, vertexColors: true,
  }),
  glove_fabric: () => new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x23262a).multiplyScalar(0.5), roughness: 0.93, metalness: 0, vertexColors: true,
  }),
  anodized_black: () => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(85e-4, 9e-3, 0.0105), roughness: 0.4, metalness: 0.45, vertexColors: true,
    });
    return applyDetailShader(m, 0);
  },
  gunmetal: () => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.016, 0.016, 0.0165), roughness: 0.5, metalness: 0.7, vertexColors: true,
    });
    return applyDetailShader(m, 1);
  },
  polymer: () => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.0125, 0.0128, 0.0135), roughness: 0.62, metalness: 0, vertexColors: true,
    });
    return applyDetailShader(m, 2);
  },
};

// ------------------------------------------------ Saltline gloved hands
// Saltline glove geometry, with a shared wrist, forearm and elbow for every pose.

function mergeColored(list) {
  const valid = list.filter(Boolean).map((g) => {
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  });
  if (!valid.length) return new THREE.BufferGeometry();
  const hasColor = valid.some((g) => g.attributes.color);
  const cleaned = valid.map((g) => {
    if (hasColor && !g.attributes.color) {
      const c = new Float32Array(g.attributes.position.count * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    for (const k of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    }
    return g;
  });
  const allIndexed = cleaned.every((g) => g.index);
  const allNonIndexed = cleaned.every((g) => !g.index);
  const normalized = allIndexed || allNonIndexed
    ? cleaned
    : cleaned.map((g) => (g.index ? g.toNonIndexed() : g));
  return mergeGeometries(normalized, false) || new THREE.BufferGeometry();
}

var Bv = [31, 21.5, 12.5], Fv = [5.6, 5.3, 5], Lv = [3.2, 3.1, 3], am = [12.5, 10, 7.6], lm = [16, 11, 6.6], dC = [3, 2.6, 2.2], kf = [36, 27, 16], gl = [20, 14, 8.4], Df = [4.8, 4.5, 4.2], pC = [30, 9.5, 2.2], E_ = [5, 6.9, 9], mC = [30, 9.5, 2.2], gC = [26, 26, 25];
var um = (i) => (i < 0 ? 0 : i > 1 ? 1 : i);
var xl = (i, e, t) => ((t = um((t - i) / (e - i))), t * t * (3 - 2 * t));
var Ff = (i, e) => Math.sign(i) * Math.pow(Math.abs(i), e);
var vC = (i) => {
  let e = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return e - Math.floor(e);
};
var Xo = new V3(), S_ = new V3(0, 0, -1);

class RingStrip {
  constructor(e) {
    this.N = e; this.P = []; this.C = []; this.weld = [];
  }
  v(e, t, n = 1) {
    this.P.push(e.x, e.y, e.z);
    this.C.push(t[0] * n, t[1] * n, t[2] * n);
  }
  rings() {
    return this.P.length / 3 / this.N;
  }
  collapse() {
    this.weld.push(this.rings() - 1);
  }
  geo(e = false) {
    let t = this.N, n = this.rings(), s = [];
    for (let a = 0; a < n - 1; a++) {
      for (let l = 0; l < t; l++) {
        let c = a * t + l, u = a * t + (l + 1) % t, h = c + t, f = u + t;
        e ? s.push(c, u, h, u, f, h) : s.push(c, h, u, u, h, f);
      }
    }
    let o = new THREE.BufferGeometry();
    o.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    o.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    o.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(this.P.length / 3 * 2), 2));
    o.setIndex(s);
    o.computeVertexNormals();
    let r = o.attributes.normal;
    for (let a of this.weld) {
      let l = 0, c = 0, u = 0;
      for (let f = 0; f < t; f++) {
        l += r.getX(a * t + f); c += r.getY(a * t + f); u += r.getZ(a * t + f);
      }
      let h = Math.hypot(l, c, u) || 1;
      for (let f = 0; f < t; f++) r.setXYZ(a * t + f, l / h, c / h, u / h);
    }
    return o;
  }
}

function gridSurface(i, e, t) {
  let n = [], s = [], o = [], r = i.length, a = e.length;
  for (let c = 0; c < a; c++) {
    for (let u = 0; u < r; u++) {
      let h = t(i[u], e[c], Xo);
      n.push(Xo.x, Xo.y, Xo.z);
      s.push(h[0], h[1], h[2]);
    }
  }
  for (let c = 0; c < a - 1; c++) {
    for (let u = 0; u < r - 1; u++) {
      let h = c * r + u, f = h + 1, p = h + r, d = p + 1;
      o.push(h, f, p, f, d, p);
    }
  }
  let l = new THREE.BufferGeometry();
  l.setAttribute('position', new THREE.Float32BufferAttribute(n, 3));
  l.setAttribute('color', new THREE.Float32BufferAttribute(s, 3));
  l.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.length / 3 * 2), 2));
  l.setIndex(o);
  l.computeVertexNormals();
  return l;
}

var GRID_STEPS = [-1, -0.9, -0.5, 0, 0.5, 0.9, 1];
var gridEdge = (i) => (Math.abs(i) > 0.95 ? -1 : Math.abs(i) > 0.8 ? 0.82 : 1);

function gloveStrap(i, e, t, n, s, o, r, a = null, l = false, c = GRID_STEPS, u = GRID_STEPS) {
  return gridSurface(c, u, (h, f, p) => {
    let d = i + h * t, v = e + (l ? f : -f) * n, g = Math.min(gridEdge(h), gridEdge(f)), x = r(d, v) + (g < 0 ? -22e-4 : s * g);
    p.set(d, l ? -x : x, v);
    if (a) a(p);
    let y = typeof o === 'function' ? o(h, f) : o, b = g < 0 ? 0.5 : g < 1 ? 0.8 : 1;
    return [y[0] * b, y[1] * b, y[2] * b];
  });
}

export const HAND_FINGERS = [
  { base: [-0.031, 0, -0.094], len: [0.044, 0.026, 0.022], rad: [96e-4, 9e-3, 83e-4, 76e-4] },
  { base: [-0.0105, 1e-3, -0.099], len: [0.049, 0.03, 0.023], rad: [97e-4, 91e-4, 84e-4, 77e-4] },
  { base: [0.0105, 0, -0.095], len: [0.045, 0.028, 0.022], rad: [94e-4, 88e-4, 81e-4, 74e-4] },
  { base: [0.03, -2e-3, -0.086], len: [0.035, 0.021, 0.02], rad: [84e-4, 78e-4, 72e-4, 66e-4] },
];

var Nv = [12, 34, 44, 68, 90, 112, 136, 146, 168, 192, 220, 245, 270, 295, 320, 348].map((i) => i * Math.PI / 180);
var T_ = Nv.length, A_ = 12e-4, R_ = [0.14, 0.22, 0.27, 0.73, 0.78, 0.88], xC = [0.1, 0.17, 0.1];

function buildDigit(i) {
  let e = new RingStrip(T_), { base: t, qs: n, len: s, rad: o } = i, r = i.pads || [1, 1, 0], a = i.patchJ ?? 1, l = i.bump || xC, c = i.tipW || 1, u = i.tipH || 1, h = [], f = [], p = t.clone();
  for (let M = 0; M < 3; M++) {
    h.push(p.clone());
    f.push(S_.clone().applyQuaternion(n[M + 1]));
    p.addScaledVector(f[M], s[M]);
  }
  let d = S_.clone().applyQuaternion(n[0]), v = (M) => (M ? f[M - 1] : d);
  let g = [0, 1, 2].map((M) => new V3().addVectors(v(M), f[M]).normalize());
  let x = (M, E) => (M.x - h[E].x) * g[E].x + (M.y - h[E].y) * g[E].y + (M.z - h[E].z) * g[E].z;
  let y = (M, E) => {
    let w = x(M, E);
    if (w > 0) M.addScaledVector(v(E), -w / v(E).dot(g[E]));
  };
  let b = (M, E) => {
    let w = x(M, E);
    if (w < 0) M.addScaledVector(f[E], -w / f[E].dot(g[E]));
  };
  let m = new V3(), A = new Quat();
  let _ = (M, E, w, S) => {
    let z = S.kD || 1, H = S.kP || 1, O = S.ao || 1;
    for (let q = 0; q < T_; q++) {
      let U = Math.cos(Nv[q]), T = Math.sin(Nv[q]), D = q >= 1 && q <= 7, C = q >= 2 && q <= 6;
      let G = w * U, j = T > 0 ? w * 0.96 * T * (C ? z : 1 + (z - 1) * 0.4) : w * 0.98 * T * H;
      if (S.pad && C) { G += U * A_; j += T * A_; }
      G *= S.wx || 1; j *= S.wy || 1;
      m.set(G, j, 0).applyQuaternion(M).add(E);
      if (S.a >= 0) y(m, S.a);
      if (S.b >= 0) b(m, S.b);
      let N = D ? Bv : q >= 10 && q <= 14 ? am : lm, Q = O;
      if (S.pad && C) N = Fv;
      else if (S.patch && C) { N = lm; Q *= 0.9; }
      if ((S.pad && D && !C) || (S.edge && D)) N = dC;
      if (S.saddle && q >= 8) { N = am; Q *= 0.9; }
      if (S.stitch && D) { N = kf; Q *= 0.8; }
      if (q === 0 || q === 8 || q === 9 || q === 15) Q *= 0.72;
      if (q >= 9) Q *= S.aoP || 1;
      e.v(m, N, Q);
    }
  };
  _(n[0], Xo.copy(h[0]).addScaledVector(d, -(i.rootBack || 0.012) - 2e-3), 1e-5, { a: 0, b: -1, ao: i.rootAo || 0.5 });
  e.collapse();
  _(n[0], Xo.copy(h[0]).addScaledVector(d, -(i.rootBack || 0.012)), o[0] * (i.rootK || 1), { a: 0, b: -1, ao: i.rootAo || 0.5, saddle: i.saddle });
  for (let M = 0; M < 3; M++) {
    for (let E = 0; E < 4; E++) {
      let w = E / 3;
      A.slerpQuaternions(n[M], n[M + 1], w);
      _(A, Xo.copy(h[M]).addScaledVector(E < 2 ? v(M) : f[M], (E - 1.5) * 4e-4), o[M], {
        a: w < 0.5 ? M : -1, b: w < 0.5 ? -1 : M,
        kD: 1 + l[M] * (E === 0 || E === 3 ? 0.55 : 1),
        patch: M === a, saddle: i.saddle && M < 2,
        wx: M === 2 ? 1 + (c - 1) * 0.5 : 1, wy: M === 2 ? 1 + (u - 1) * 0.5 : 1,
        ao: M === 0 && !i.rootAo ? 0.62 + 0.1 * E : 1, aoP: E === 1 || E === 2 ? 0.55 : 0.8,
      });
    }
    if (M < 2) {
      for (let E = 0; E < R_.length; E++) {
        let w = R_[E], S = (o[M] + (o[M + 1] - o[M]) * w) * (1 - 0.06 * Math.sin(Math.PI * w));
        _(n[M + 1], Xo.copy(h[M]).addScaledVector(f[M], s[M] * w), S, {
          a: M + 1, b: M, pad: r[M] && (E === 2 || E === 3), edge: r[M] && (E === 1 || E === 4),
          saddle: i.saddle && M === 0, ao: M === 0 && !i.rootAo ? 0.86 + 0.14 * xl(0, 0.5, w) : 1,
        });
      }
    } else {
      let E = o[3], w = s[2] - E;
      _(n[3], Xo.copy(h[2]).addScaledVector(f[2], s[2] * 0.2), o[2] * 0.97, { a: -1, b: 2, stitch: 1, wx: c, wy: u });
      _(n[3], Xo.copy(h[2]).addScaledVector(f[2], s[2] * 0.42), (o[2] + E) * 0.5, { a: -1, b: 2, kP: 1.08, wx: c, wy: u });
      for (let S of [0, 0.6, 1.05, 1.36]) {
        _(n[3], Xo.copy(h[2]).addScaledVector(f[2], w + E * 1.08 * Math.sin(S)), E * Math.cos(S), { a: -1, b: -1, kP: 1.06, wx: c, wy: u });
      }
      _(n[3], Xo.copy(h[2]).addScaledVector(f[2], w + E * 1.08), 1e-5, { a: -1, b: -1 });
      e.collapse();
    }
  }
  return e.geo();
}

var quatYaw = (i) => new Quat().setFromAxisAngle(new V3(0, 1, 0), i);
var quatPitch = (i) => new Quat().setFromAxisAngle(new V3(1, 0, 0), i);

function buildFinger(i, e) {
  let t = [quatYaw(e[3] || 0)];
  for (let n = 0; n < 3; n++) t.push(t[n].clone().multiply(quatPitch(-e[n])));
  return buildDigit({ base: new V3(i.base[0], i.base[1], i.base[2]), qs: t, len: i.len, rad: i.rad });
}

function thumbFrame(i, e) {
  let t = i.clone().negate(), n = new V3().crossVectors(e, t);
  if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
  n.normalize();
  let s = new V3().crossVectors(t, n);
  return new Quat().setFromRotationMatrix(new Mat4().makeBasis(n, s, t));
}

function buildThumb(i) {
  let e = i.map((o) => new V3(o[0], o[1], o[2]).normalize()), t = new V3(-0.72, 0.69, 0), n = [], s = e[2].clone().sub(e[0]);
  if (s.length() > 0.12) t.multiplyScalar(0.25).addScaledVector(s.normalize(), -1);
  for (let o = 0; o < 3; o++) n.push(thumbFrame(e[o], t));
  n.unshift(n[0].clone());
  return buildDigit({
    base: new V3(-0.028, -7e-3, -0.014), qs: n, len: [0.044, 0.031, 0.026], rad: [0.0165, 0.0118, 0.011, 0.01],
    pads: [0, 1, 0], patchJ: 2, bump: [0, 0.2, 0.2], tipW: 1.12, tipH: 0.86, saddle: 1, rootBack: 0.01, rootK: 0.72, rootAo: 0.9,
  });
}

var Qc = 6e-3;
var D_ = (i) => -0.0975 + 0.0125 * Math.pow((i + 8e-3) / 0.04, 2);
var Ov = (i) => D_(i) + 6e-3;
var Hv = (i) => 0.029 + 0.014 * xl(0.05, 0.85, i);
var L_ = (i) => 0.0185 - 65e-4 * xl(0.1, 1, i);
var k_ = (i) => 0.0185 + 3e-3 * Math.sin(Math.PI * um(i * 1.6)) - 55e-4 * xl(0.3, 1, i);

function palmBackHeight(i, e) {
  let t = um((Qc - e) / (Qc - Ov(i))), n = Math.min(0.999, Math.abs(i / Hv(t)));
  return L_(t) * Math.pow(1 - Math.pow(n, 2.5), 0.4);
}

function palmFrontHeight(i, e) {
  let t = um((Qc - e) / (Qc - Ov(i))), n = Hv(t), s = Math.min(0.999, Math.abs(i / n));
  return k_(t) * Math.pow(1 - Math.pow(s, 2.5), 0.4) * (1 + 0.14 * Math.max(0, i / n) * Math.sin(Math.PI * t));
}

function buildPalm() {
  let e = new RingStrip(24), t = new V3();
  let n = [[0, 0, 1, 1], [0.1, 0, 1, 1], [0.22, 0, 1, 1], [0.36, 0, 1, 1], [0.5, 0, 1, 1], [0.64, 0, 1, 1], [0.77, 0, 1, 1], [0.89, 0, 1, 1], [1, 0, 1, 1], [1, -5e-3, 0.8, 1], [1, -9e-3, 0.45, 0.985], [1, -0.0105, 0.04, 0.97]];
  for (let [s, o, r, a] of n) {
    let l = Hv(s) * a, c = L_(s) * r, u = k_(s) * r;
    for (let h = 0; h < 24; h++) {
      let f = (h + 0.5) / 24 * Math.PI * 2, p = Math.cos(f), d = Math.sin(f);
      let v = l * Ff(p, 0.8), g = d >= 0 ? c * Ff(d, 0.8) : u * Ff(d, 0.8) * (1 + 0.14 * Math.max(0, v / l) * Math.sin(Math.PI * s));
      t.set(v, g, Qc + (Ov(v) - Qc) * s + o);
      let x = d > 0.3 ? Bv : d < -0.3 ? am : lm, y = 1;
      if (s === 0.1 && d > 0.3) { x = kf; y = 0.75; }
      if (o < 0) { x = lm; y = 0.7 + o * 30; }
      if (d < -0.3) y *= 0.82 + 0.18 * Math.abs(p);
      e.v(t, x, y);
    }
  }
  return e.geo();
}

function buildThumbWeb(i) {
  let t = new RingStrip(12), n = new V3(), s = new V3(), o = new V3(), r = new V3(), a = new V3();
  let l = new V3(i.x, i.y, i.z - 1).normalize(), c = [-0.12, 0, 0.2, 0.4, 0.6, 0.78, 0.9];
  for (let d = 0; d < c.length; d++) {
    let v = c[d], g = d === 0 || d === c.length - 1;
    s.set(-0.028, -7e-3, -0.014).addScaledVector(i, 0.044 * v);
    o.set(-0.03, -3e-3, -0.022 - 0.06 * v);
    r.subVectors(s, o);
    let x = r.length() * 0.5 + 5e-3;
    r.normalize();
    a.crossVectors(r, l).normalize();
    let y = g ? 1e-5 : 85e-4 * (1 - 0.55 * v), b = g ? 1e-5 : x * (1 - 0.3 * v * v);
    for (let m = 0; m < 12; m++) {
      let A = (m + 0.5) / 12 * Math.PI * 2, _ = Math.cos(A), M = Math.sin(A);
      n.copy(s).add(o).multiplyScalar(0.5).addScaledVector(r, _ * b).addScaledVector(a, M * y);
      let E = a.y * M < 0;
      t.v(n, E ? am : Bv, E ? 0.85 : 0.92);
    }
    if (g) t.collapse();
  }
  let u = t.geo(), h = u.attributes.position, f = u.index.array, p = 0;
  for (let d = 0; d < f.length; d += 3) {
    s.fromBufferAttribute(h, f[d]);
    o.fromBufferAttribute(h, f[d + 1]);
    n.fromBufferAttribute(h, f[d + 2]);
    p += s.dot(o.cross(n));
  }
  if (p < 0) {
    for (let d = 0; d < f.length; d += 3) {
      let v = f[d + 1]; f[d + 1] = f[d + 2]; f[d + 2] = v;
    }
    u.computeVertexNormals();
  }
  return u;
}

function mirrorGeometry(i) {
  i.scale(-1, 1, 1);
  if (!i.index) {
    let t = i.attributes.position.count, n = new Uint32Array(t);
    for (let s = 0; s < t; s++) n[s] = s;
    i.setIndex(new THREE.BufferAttribute(n, 1));
  }
  let e = i.index.array;
  for (let t = 0; t < e.length; t += 3) {
    let n = e[t + 1]; e[t + 1] = e[t + 2]; e[t + 2] = n;
  }
  return i;
}

export function buildHand(opts) {
  let parts = [], debug = opts.debugParts || null;
  let add = (name, geo) => { parts.push(geo); if (debug) debug.push([name, geo]); return geo; };
  add('palm', buildPalm());
  {
    let d = [];
    for (let v = 0; v <= 30; v++) d.push(-1 + v / 15);
    add('guard', gridSurface(d, [-1, -0.9, -0.5, 0, 0.5, 0.9, 1], (v, g, x) => {
      let y = -5e-4 + v * 0.0405, b = D_(y) + 45e-4 - g * 0.011, m = Math.min(gridEdge(v), gridEdge(g)), A = 0;
      for (let M = 0; M < 4; M++) {
        let E = (y - HAND_FINGERS[M].base[0]) / 58e-4;
        A += (M === 3 ? 0.8 : 1) * Math.exp(-E * E);
      }
      A = Math.min(1, A) * (1 - 0.55 * g * g);
      x.set(y, palmBackHeight(y, b) + (m < 0 ? (g > 0.95 ? -8e-3 : -3e-3) : (16e-4 + 6e-3 * A) * m), b);
      let _ = m < 0 ? 0.6 : 0.85 + 1.3 * A;
      return [Lv[0] * _, Lv[1] * _, Lv[2] * _];
    }));
  }
  for (let d = 0; d < 3; d++) add('bar', gloveStrap(1e-3, -0.034 - d * 0.015, 0.023 + d * 25e-4, 52e-4, 19e-4, Fv, palmBackHeight));
  add('seam', gloveStrap(0, -0.0225, 0.027, 13e-4, 9e-4, kf.map((d) => d * 0.8), palmBackHeight, null, false, GRID_STEPS, [-1, 0, 1].map((d) => d * 0.9)));
  add('heelPad', gloveStrap(0.013, -0.03, 0.0135, 0.017, 17e-4, Fv, palmFrontHeight, null, true));

  let indexGeos = [];
  for (let d = 0; d < 4; d++) {
    if (d === 0 && opts.indexPoses) {
      for (let pose of opts.indexPoses) indexGeos.push(buildFinger(HAND_FINGERS[0], pose));
      continue;
    }
    add('finger' + d, buildFinger(HAND_FINGERS[d], opts.fingers[d]));
  }
  add('thumb', buildThumb(opts.thumb));
  add('web', buildThumbWeb(new V3(opts.thumb[0][0], opts.thumb[0][1], opts.thumb[0][2]).normalize()));

  let forearmDir = new V3(opts.forearm[0], opts.forearm[1], opts.forearm[2]).normalize();
  const wristZ = 0.022;
  // Distances are in metres. A longer sleeve continues up the upper arm.
  const elbowZ = wristZ + 0.245;
  const elbowBlend = 0.034;
  const upperArmDir = new V3().fromArray(opts.upperArm ?? [0, -.25, .97]).normalize();
  const center = new V3(), tangent = new V3(), sectionQ = new Quat();
  let forearmQ = new Quat().setFromUnitVectors(new V3(0, 0, 1), forearmDir), identQ = new Quat(), tmpQ = new Quat();
  let bendWrist = (pt) => {
    tmpQ.slerpQuaternions(identQ, forearmQ, xl(2e-3, 0.042, pt.z));
    pt.z -= wristZ; pt.applyQuaternion(tmpQ); pt.z += wristZ;
    return pt;
  };
  {
    let v = new RingStrip(24), g = new V3();
    let x = [[-85e-4, -15e-4, Df, 0.6], [-9e-3, 22e-4, Df, 1.3], [-6e-3, 26e-4, Df, 1.3], [-52e-4, 2e-3, gl, 0.75], [4e-3, 14e-4, gl, 1], [0.011, 16e-4, gl, 0.7], [0.0122, 3e-3, Df, 1.2], [0.0305, 32e-4, Df, 1.2], [0.0317, 18e-4, gl, 0.7], [0.04, 2e-3, gl, 1], [0.054, 24e-4, gl, 1], [0.058, 26e-4, kf, 0.7], [0.058, -4e-3, gl, 0.4]];
    for (let [y, b, m, A] of x) {
      for (let _ = 0; _ < 24; _++) {
        let M = (_ + 0.5) / 24 * Math.PI * 2, E = Math.sin(M);
        v.v(bendWrist(g.set((0.0296 + b) * Ff(Math.cos(M), 0.8), (E >= 0 ? 0.0185 + b : 0.0204 + b) * Ff(E, 0.8), y)), m, A);
      }
    }
    add('cuff', v.geo(true));
  }
  add('strapTab', gloveStrap(9e-3, 0.0215, 0.0135, 76e-4, 17e-4, (d) => (d > 0.55 ? kf.map((v) => v * 0.75) : [9, 9, 9.6]), (d) => 0.0217 * Math.pow(1 - Math.pow(Math.min(0.999, Math.abs(d / 0.0328)), 2.5), 0.4), bendWrist));
  add('pullTab', gloveStrap(3e-3, 4e-3, 65e-4, 0.0115, 22e-4, pC, () => 0.022, bendWrist, true));
  {
    let d = [];
    for (let z = 0; z < 24; z++) {
      d.push(z * 15);
      if (z === 4 || z === 16) d.push(z * 15 + 11.5);
      if (z === 5 || z === 17) d.push(z * 15 + 3.5);
    }
    d.sort((z, H) => z - H);
    let v = d.length, g = d.indexOf(75), x = d.indexOf(255), y = new RingStrip(v), b = new V3(), m = wristZ + (opts.sleeve ?? 0.34);
    // Integrate the two segment directions through a rounded elbow. Rotate
    // each cross-section with the tangent so a bent sleeve retains its volume.
    const poseSection = (z) => {
      const blend = um((z - elbowZ + elbowBlend) / (2 * elbowBlend));
      const upper = Math.max(0, z - elbowZ - elbowBlend) + elbowBlend * blend * blend;
      center.copy(forearmDir).multiplyScalar(z - wristZ - upper).addScaledVector(upperArmDir, upper);
      center.z += wristZ;
      tangent.copy(forearmDir).lerp(upperArmDir, blend).normalize();
      sectionQ.setFromUnitVectors(forearmDir, tangent).multiply(forearmQ);
    };
    let A = [[0.0415, 0], [0.04, 1], [0.044, 2], [0.049, 3], [0.055, 3], [0.061, 3], [0.0655, 4], [0.0685, 5]];
    let _ = [0.1415, 0.143, 0.157, 0.1582, 0.1662, 0.1674, 0.181, 0.1825], M = _.slice(), E = Math.ceil((m - 0.074) / 52e-4);
    for (let z = 0; z <= E; z++) {
      let H = 0.074 + (m - 0.074) * z / E;
      if (!_.some((O) => Math.abs(O - H) < 16e-4)) M.push(H);
    }
    M.sort((z, H) => z - H);
    for (let z of M) A.push([z, 6]);
    let w = 0;
    for (let [z, H] of A) {
      poseSection(z);
      for (let O = 0; O < v; O++) {
        let q = d[O] * Math.PI / 180, U, T = 1, D = E_;
        if (H === 0) { U = 0.0292; T = 0.4; }
        else if (H === 1) { U = 0.0372; T = 1.15; }
        else if (H === 2) { U = 0.0377; T = 1.1; }
        else if (H === 3) {
          let C = Math.cos(q * 12);
          U = 0.0368 + 12e-4 * C; T = 0.62 + 0.26 * C;
        } else if (H === 4) { U = 0.0356; T = 0.55; }
        else if (H === 5) { U = 0.038; T = 0.9; }
        else {
          let C = um((z - 0.0685) / (elbowZ - 0.0685));
          let G = 48e-4 * Math.exp(-Math.pow((C - 0.13) / 0.11, 2));
          let j = 48e-4 * xl(0.62, 0.85, C);
          // Past the elbow, tension smooths the outside panel. Keep shallow
          // fabric folds on the inside instead of ridges around a whole arm.
          if (opts.shoulderSocket) j *= .12 + .38 * (.5 + .5 * Math.sin(q - .7));
          let N = Math.pow(Math.abs(Math.sin(Math.PI * z / 0.027 + 1.7 * Math.sin(q + 0.5) + 0.8 * Math.sin(2 * q + 1.3))), 0.6) * 2 - 1.25;
          let Q = Math.pow(Math.abs(Math.sin(Math.PI * z / 0.034 + 1.9 * Math.sin(q - 0.8) + 0.7 * Math.sin(2 * q))), 0.6) * 2 - 1.25;
          let K = Math.sin(z * 40 + 2 * Math.sin(q * 2 + 1)) + 0.6 * Math.sin(3 * q + z * 25);
          const muscle = .011 * Math.exp(-Math.pow((z - .183) / .068, 2));
          const upperArm = .017 * xl(elbowZ - .012, elbowZ + .095, z);
          U = .0375 + muscle + upperArm + .003 * C + G * N + j * Q + .0016 * K;
          T = 0.78 + 0.26 * xl(-1.1, 0.5, (G * N + j * Q) / (G + j + 8e-4)) + 0.04 * K;
          if (opts.shoulderSocket) T += (.90 - T) * .55 * C;
          let ie = vC(w);
          if (z > 0.1575 && z < 0.167) { D = gC; T *= 0.85 + 0.25 * ie; }
          else if (z > 0.1425 && z < 0.1815) { D = mC; T *= 0.78 + 0.3 * ie; }
        }
        if (H > 0) {
          if (O === g || O === x) { U += 19e-4; T *= 1.3; }
          else if (Math.abs(O - g) === 1 || Math.abs(O - x) === 1) T *= 0.52;
        }
        b.set(Math.cos(q) * U, Math.sin(q) * U * 0.84, 0).applyQuaternion(sectionQ).add(center);
        y.v(b, D, T);
        w++;
      }
    }
    poseSection(m + .006);
    for (let z = 0; z < v; z++) y.v(center, E_, 0.3);
    y.collapse();
    const sleeve = y.geo(true);
    if (opts.shoulderSocket) {
      // A posed sleeve uses the authored longitudinal station of each ring.
      // The other glove parts keep zero here and remain rigid.
      for (const part of parts) part.attributes.uv?.array.fill(0);
      for (let i = 0; i < sleeve.attributes.uv.count; i++) {
        const z = A[Math.floor(i / v)]?.[0] ?? m + .006;
        sleeve.attributes.uv.setX(i, z - wristZ);
      }
      opts.shoulderSocket.copy(center);
      if (opts.mirror) opts.shoulderSocket.x *= -1;
    }
    add('sleeve', sleeve);
  }

  let out = {
    fabric: mergeColored(parts),
    rubber: null,
    index: indexGeos.length ? indexGeos : null,
    knuckle: HAND_FINGERS[0].base.slice(),
  };
  if (opts.mirror) {
    mirrorGeometry(out.fabric);
    if (out.index) out.index.forEach(mirrorGeometry);
    out.knuckle[0] *= -1;
  }
  return out;
}

export function dirInFrame(quat, vec, mirror = false) {
  const out = new V3(vec[0], vec[1], vec[2]).normalize().applyQuaternion(quat.clone().invert());
  if (mirror) out.x *= -1;
  return [out.x, out.y, out.z];
}

function makeViewMesh(geo, mat, name = '') {
  const m = new THREE.Mesh(geo, mat);
  if (name) m.name = name;
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = false;
  return m;
}

export function createRightHandRig({
  gripPos = [0, -0.1, 0.073],
  gripQuat = null,
  palmOffset = [6e-3, -0.031, -0.085],
  fingers = null,
  indexPoses = null,
  thumb = null,
  forearm = null,
  sleeve = 0.34,
  gloveMaterial = null,
} = {}) {
  const q = gripQuat
    ? gripQuat.clone()
    : quatEuler(-0.24, 0, 0).multiply(quatEuler(0, 0, -Math.PI / 2));
  const mat = gloveMaterial || applyDetailShader(SALTLINE_BASE_COLOURS.glove_fabric(), 2);
  const hand = buildHand({
    mirror: false,
    fingers: fingers || [null, [0.62, 1.72, 0.8, 0], [0.68, 1.7, 0.8, -0.03], [0.74, 1.66, 0.8, -0.09]],
    indexPoses: indexPoses || [[0.1, 0.16, 0.1, 0.05], [0.46, 1.15, 0.5, 0]],
    thumb: thumb || [
      dirInFrame(q, [-0.85, 0.05, -0.5]),
      dirInFrame(q, [-0.6, -0.05, -0.8]),
      dirInFrame(q, [-0.05, -0.2, -0.97]),
    ],
    forearm: forearm || dirInFrame(q, [0.27, -0.44, 0.86]),
    upperArm: dirInFrame(q, [-.16, -.18, .97]),
    sleeve,
  });

  const group = new THREE.Group();
  group.name = 'saltline-right-hand';
  group.quaternion.copy(q);
  const gp = Array.isArray(gripPos) ? new V3().fromArray(gripPos) : gripPos.clone();
  const po = Array.isArray(palmOffset) ? new V3().fromArray(palmOffset) : palmOffset.clone();
  group.position.copy(gp).sub(po.applyQuaternion(q));

  const fabricMesh = makeViewMesh(hand.fabric, mat, 'saltline-right-glove');
  const triggerFingerMesh = makeViewMesh(hand.index[0].clone(), mat, 'saltline-trigger-finger');
  group.add(fabricMesh, triggerFingerMesh);

  const restAttr = hand.index[0].attributes;
  const pullAttr = hand.index[1].attributes;
  let shownWeight = -1;

  function setTriggerFinger(w) {
    const cw = clamp(w, 0, 1);
    if (Math.abs(cw - shownWeight) < 4e-3) return;
    shownWeight = cw;
    const pos = triggerFingerMesh.geometry.attributes.position;
    const nrm = triggerFingerMesh.geometry.attributes.normal;
    const p0 = restAttr.position.array, p1 = pullAttr.position.array;
    const n0 = restAttr.normal.array, n1 = pullAttr.normal.array;
    for (let i = 0; i < p0.length; i++) {
      pos.array[i] = p0[i] + (p1[i] - p0[i]) * cw;
      nrm.array[i] = n0[i] + (n1[i] - n0[i]) * cw;
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  }
  setTriggerFinger(0);

  const tris = Math.round(triangleCount(hand.fabric) + triangleCount(hand.index[0]));
  return { group, setTriggerFinger, tris, fabricMesh, triggerFingerMesh, gripQuat: q };
}

export function createLeftHandRig({
  fingers = null,
  thumb = null,
  forearm = null,
  sleeve = 0.34,
  supportQuat = null,
  gloveMaterial = null,
} = {}) {
  const q = supportQuat
    ? supportQuat.clone()
    : quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.06, 0, 0));
  const mat = gloveMaterial || applyDetailShader(SALTLINE_BASE_COLOURS.glove_fabric(), 2);
  const hand = buildHand({
    mirror: true,
    fingers: fingers || [
      [1.27, 1.42, 0.75, 0.02],
      [1.3, 1.45, 0.75, 0],
      [1.3, 1.45, 0.75, -0.02],
      [1.33, 1.45, 0.75, -0.05],
    ],
    thumb: thumb || [
      dirInFrame(q, [0, 0.25, -0.97], true),
      dirInFrame(q, [0.05, 0.1, -0.99], true),
      dirInFrame(q, [0, 0, -1], true),
    ],
    forearm: forearm || dirInFrame(q, [-0.5, -0.35, 0.79], true),
    upperArm: dirInFrame(q, [.24, -.10, .96], true),
    sleeve,
  });

  const group = new THREE.Group();
  group.name = 'saltline-left-hand';
  const fabricMesh = makeViewMesh(hand.fabric, mat, 'saltline-left-glove');
  group.add(fabricMesh);
  const tris = Math.round(triangleCount(hand.fabric));
  return { group, tris, fabricMesh, supportQuat: q };
}

// ------------------------------------------------ muzzle flash

export function buildMuzzleFlash({ suppressed = false } = {}) {
  const pos = [], uvs = [], types = [], idx = [];
  const quad = (a, b, c, d, type) => {
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) pos.push(p[0], p[1], p[2]);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k++) types.push(type);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const k = suppressed ? 0.52 : 1;
  const r0 = 0.13 * k, r1 = 0.13 * 0.7 * k;
  quad([-r0, -r0, -0.03 * k], [r0, -r0, -0.03 * k], [r0, r0, -0.03 * k], [-r0, r0, -0.03 * k], 0);
  quad([-r1, -r1, -0.09 * k], [r1, -r1, -0.09 * k], [r1, r1, -0.09 * k], [-r1, r1, -0.09 * k], 0);
  const jr = 0.065 * k, jl = (suppressed ? 0.22 : 0.34);
  quad([-jr, 0, 0.01], [jr, 0, 0.01], [jr, 0, -jl], [-jr, 0, -jl], 1);
  quad([0, -jr, 0.01], [0, jr, 0.01], [0, jr, -jl], [0, -jr, -jl], 1);
  const sl = 0.17 * k, sc = 0.05 * k, su = 0.035 * k;
  quad([-sl, -sc, su], [sl, -sc, su], [sl, sc, su], [-sl, sc, su], 2);
  quad([-sl, 0, su + sc], [sl, 0, su + sc], [sl, 0, su - sc], [-sl, 0, su - sc], 2);
  const cr = 0.05 * k, hr = 0.03 * (suppressed ? 0.85 : 1);
  quad([-cr, -cr, -0.01], [cr, -cr, -0.01], [cr, cr, -0.01], [-cr, cr, -0.01], 3);
  quad([-hr, -hr, 0.02], [hr, -hr, 0.02], [hr, hr, 0.02], [-hr, hr, 0.02], 4);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aType', new THREE.Float32BufferAttribute(types, 1));
  geo.setIndex(idx);

  const tintVec = suppressed ? 'vec3(0.76, 0.64, 0.52)' : 'vec3(1.0, 0.50, 0.16)';
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uSeed: { value: 0 },
      uInt: { value: 0 },
      uHeat: { value: 0 },
      uJet: { value: suppressed ? 0.18 : 1 },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aType;
      varying vec2 vUv;
      varying float vType;
      void main(){
        vUv = uv;
        vType = aType;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      varying float vType;
      uniform float uSeed, uInt, uHeat, uJet;
      float h1(float n){ return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p), a = atan(p.y, p.x);
        float I = 0.0;
        vec3 tintc = ${tintVec};
        if (vType < 0.5) {
          float n1 = 3.0 + floor(h1(1.0) * 3.0), n2 = 5.0 + floor(h1(2.0) * 4.0);
          float pet = pow(abs(cos(a * n1 * 0.5 + h1(3.0) * 6.283)), 5.0) * (0.55 + 0.45 * h1(4.0));
          pet += pow(abs(cos(a * n2 * 0.5 + h1(5.0) * 6.283)), 14.0) * 0.55;
          float reach = 0.35 + 0.65 * pet;
          I = (0.25 + pet) * smoothstep(reach, reach * 0.15, r) * (0.75 + 0.25 * sin(r * 26.0 + h1(6.0) * 20.0));
        } else if (vType < 1.5) {
          float y = vUv.y, x = p.x * (1.0 + 0.5 * sin(y * 17.0 + h1(7.0) * 30.0) * y);
          float wdt = mix(0.20, 0.75, smoothstep(0.0, 0.35, y)) * (1.0 - y * 0.75);
          I = exp(-x * x / (wdt * wdt * 0.35)) * pow(1.0 - y, 1.4) * (0.7 + 0.3 * sin(y * 31.0 + h1(8.0) * 9.0)) * 0.9;
        } else if (vType < 2.5) {
          float u = abs(p.x), len = 0.55 + 0.45 * h1(9.0 + step(0.0, p.x));
          float wv = p.y * (1.0 + u * 3.0) + 0.12 * sin(u * 14.0 + h1(10.0) * 20.0) * u;
          I = exp(-wv * wv * 22.0) * smoothstep(len, 0.06, u) * smoothstep(0.02, 0.10, u) * 0.85 * uJet;
        } else if (vType < 3.5) {
          I = exp(-r * r * 5.0) * 2.4 * smoothstep(1.0, 0.6, r);
          tintc = vec3(1.0, 0.82, 0.58);
        } else {
          gl_FragColor = vec4(vec3(1.0, 0.28, 0.06) * exp(-r * r * 4.0) * smoothstep(1.0, 0.5, r) * uHeat, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }
        vec3 col = mix(tintc, vec3(1.0, 0.90, 0.70), clamp(I * I * 0.7, 0.0, 1.0)) * I * uInt;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = suppressed ? 'muzzle-flash-suppressed' : 'muzzle-flash';
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return mesh;
}

// ------------------------------------------------ reflex / holo optic lens

export function rectWindowPoly(cx, cy, width, height, chamfer = 0.0022) {
  const hw = width * 0.5, hh = height * 0.5;
  const c = Math.min(chamfer, hw * 0.45, hh * 0.45);
  return [
    [cx - hw + c, cy - hh],
    [cx + hw - c, cy - hh],
    [cx + hw, cy - hh + c],
    [cx + hw, cy + hh - c],
    [cx + hw - c, cy + hh],
    [cx - hw + c, cy + hh],
    [cx - hw, cy + hh - c],
    [cx - hw, cy - hh + c],
  ];
}

const RETICLE_MODES = { dot: 0, holo: 1, chevron: 2, microdot: 3 };

// Build a parallax-free collimator / holographic optic glass window at local `z = zPos`
// whose dichroic coating dynamically reflects `SHARED_LENS_SUN` and `SHARED_LENS_SKY`.
export function buildOpticLens(
  windowPoly,
  zPos = 0,
  { reticle = 'dot', color = [1, 0.16, 0.08], brightness = 7.2, tilt = 0.1 } = {}
) {
  const shape = new THREE.Shape();
  windowPoly.forEach((pt, idx) => (idx ? shape.lineTo(pt[0], pt[1]) : shape.moveTo(pt[0], pt[1])));
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.translate(0, 0, zPos);

  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const pt of windowPoly) {
    minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
    minY = Math.min(minY, pt[1]); maxY = Math.max(maxY, pt[1]);
  }
  const posAttr = geo.attributes.position;
  const uvAttr = geo.attributes.uv;
  const spanX = Math.max(1e-5, maxX - minX);
  const spanY = Math.max(1e-5, maxY - minY);
  for (let i = 0; i < posAttr.count; i++) {
    uvAttr.setXY(i, (posAttr.getX(i) - minX) / spanX, (posAttr.getY(i) - minY) / spanY);
  }

  const mode = RETICLE_MODES[reticle] ?? 0;
  const retColor = new THREE.Color(color[0] ?? 1, color[1] ?? 0.16, color[2] ?? 0.08);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uBright: { value: brightness },
      uReticleMode: { value: mode },
      uRetCol: { value: retColor },
      uTilt: { value: tilt },
      uSun: { value: SHARED_LENS_SUN.dir },
      uSunCol: { value: SHARED_LENS_SUN.color },
      uUp: { value: SHARED_LENS_SUN.up },
      uZen: { value: SHARED_LENS_SKY.zenith },
      uHor: { value: SHARED_LENS_SKY.horizon },
      uHorAway: { value: SHARED_LENS_SKY.horizonAway },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vView, vFwd, vRight, vUp, vWPos, vWN;
      varying vec2 vUv;
      uniform float uTilt;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = mv.xyz;
        vFwd = (modelViewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz;
        vRight = (modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
        vUp = (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * normalize(vec3(0.0, -uTilt, 1.0)));
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec3 vView, vFwd, vRight, vUp, vWPos, vWN;
      varying vec2 vUv;
      uniform float uBright, uReticleMode;
      uniform vec3 uRetCol, uSun, uSunCol, uUp, uZen, uHor, uHorAway;
      void main(){
        #include <logdepthbuf_fragment>
        vec3 d = normalize(vView), fw = normalize(vFwd);
        float k = max(dot(d, fw), 1e-3);
        vec2 a = vec2(dot(d, normalize(vRight)), dot(d, normalize(vUp))) / k;
        float r = length(a), px = max(fwidth(r), 1e-5);
        float ret = 0.0;
        if (uReticleMode < 0.5) {
          // 'dot': crisp 2 MOA red dot
          float dotR = max(0.00095, px * 0.95);
          ret = 1.0 - smoothstep(dotR - px, dotR + px, r);
          ret += 0.045 * exp(-r * r / 0.000016);
        } else if (uReticleMode < 1.5) {
          // 'holo': 65 MOA outer ring + cardinal stadia ticks + 1 MOA center dot
          float dotR = max(0.00072, px * 0.85);
          float ringW = max(0.00046, px * 0.65);
          float dotI = 1.0 - smoothstep(dotR - px, dotR + px, r);
          float ring = 1.0 - smoothstep(ringW - px * 0.5, ringW + px, abs(r - 0.0138));
          float tick = (1.0 - smoothstep(0.0, px * 1.2 + 0.00042, min(abs(a.x), abs(a.y))))
            * step(0.0138, r) * (1.0 - smoothstep(0.0176, 0.0186, r));
          ret = clamp(dotI + ring * 0.88 + tick * 0.88, 0.0, 1.0);
          ret += 0.05 * exp(-r * r / 0.000022);
        } else if (uReticleMode < 2.5) {
          // 'chevron': tactical inverted V tip at (0, 0) + BDC ticks
          float slope = abs(a.x) * 1.15 + a.y;
          float leg = 1.0 - smoothstep(0.00045, 0.00045 + px * 1.2, abs(slope));
          float span = step(-0.0065, a.y) * step(a.y, 0.0004) * step(abs(a.x), 0.0058);
          float bdc = (1.0 - smoothstep(0.00035, 0.00035 + px, abs(a.x)))
            * step(-0.016, a.y) * step(a.y, -0.0085);
          ret = clamp(leg * span + bdc * 0.65, 0.0, 1.0);
          ret += 0.04 * exp(-r * r / 0.000018);
        } else {
          // 'microdot': 3.25 MOA compact pistol dot
          float dotR = max(0.00125, px * 1.05);
          ret = 1.0 - smoothstep(dotR - px, dotR + px, r);
          ret += 0.055 * exp(-r * r / 0.000024);
        }

        // Window edge mask so reticle never bleeds into the housing bezel
        vec2 edgeDist = abs(vUv - 0.5) * 2.0;
        float edge = smoothstep(0.90, 1.0, max(edgeDist.x, edgeDist.y));
        vec3 retCol = uRetCol * ret * uBright * (1.0 - edge);

        // Dichroic coated glass reflecting live planetary sun & sky
        vec3 wv = normalize(vWPos - cameraPosition);
        vec3 n = normalize(vWN);
        if (dot(n, wv) > 0.0) n = -n;
        vec3 rf = reflect(wv, n);
        float fres = pow(1.0 - abs(dot(wv, n)), 3.0);
        vec3 upN = normalize(uUp);
        vec3 sunN = normalize(uSun);
        float sunAz = clamp(dot(rf, sunN) * 0.5 + 0.5, 0.0, 1.0);
        vec3 horCol = mix(uHorAway, uHor, pow(sunAz, 2.2));
        vec3 sky = mix(horCol, uZen, clamp(dot(rf, upN) * 1.4 + 0.2, 0.0, 1.0));
        float sd = max(dot(rf, sunN), 0.0);
        sky += uSunCol * (pow(sd, 6.0) * 0.6 + pow(sd, 90.0) * 6.0);

        float band = smoothstep(0.25, 0.5, vUv.x * 0.6 + vUv.y)
          * (1.0 - smoothstep(0.62, 0.95, vUv.x * 0.6 + vUv.y));
        vec3 coat = mix(vec3(0.30, 0.50, 0.95), vec3(1.0, 0.62, 0.28),
          clamp(fres * 2.2 + vUv.y * 0.75 - 0.15, 0.0, 1.0));
        float refl = 0.12 + 0.60 * fres + 0.07 * band;

        vec2 eg = (vUv - vec2(0.5, 0.14)) * vec2(1.0, 1.6);
        retCol += uRetCol * 0.20 * exp(-dot(eg, eg) * 60.0) * (1.0 - smoothstep(0.985, 0.9995, k));
        vec3 col = (sky * 1.45 + vec3(0.025, 0.03, 0.04)) * coat * refl * (1.0 - edge) + retCol;
        float alpha = clamp(0.18 + 0.32 * fres + 0.05 * band + 0.62 * edge, 0.0, 0.94);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `optic-lens-${reticle}`;
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  return mesh;
}

// ------------------------------------------------ magnified scope display

// Build an ocular `opticGlass` mesh + front `objective` Object3D compatible with
// `SurfaceWeapons.renderScopeView(renderer)`:
//   - `opticGlass.material.uniforms`: `tScope`, `eyeBox`, `ads`, `uEyeOffset`, ...
//   - `opticGlass.material.map`: getter/setter directly backed by `uniforms.tScope.value`
//     so `lens.material.map = scopeTarget.texture` and `lens.material?.map === scopeTarget.texture`
//     work seamlessly alongside `uniforms.tScope.value`.
//   - `objective`: `THREE.Object3D` placed at the front of the scope pointing down `-Z`.
export function buildMagnifiedScopeDisplay({
  radius = 0.017,
  z = 0.02,
  y = 0,
  objectiveZ = -0.048,
  objectiveY = null,
  reticleColor = [1, 0.22, 0.12],
} = {}) {
  const geo = new THREE.CircleGeometry(radius, 48);
  const uniforms = {
    tScope: { value: null },
    uHasScope: { value: 0 },
    eyeBox: { value: 1 },
    ads: { value: 0 },
    uEyeOffset: { value: new THREE.Vector2(0, 0) },
    uRetCol: { value: new THREE.Color(reticleColor[0] ?? 1, reticleColor[1] ?? 0.22, reticleColor[2] ?? 0.12) },
    uSun: { value: SHARED_LENS_SUN.dir },
    uSunCol: { value: SHARED_LENS_SUN.color },
    uUp: { value: SHARED_LENS_SUN.up },
    uZen: { value: SHARED_LENS_SKY.zenith },
    uHor: { value: SHARED_LENS_SKY.horizon },
    uHorAway: { value: SHARED_LENS_SKY.horizonAway },
  };

  const mat = new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide,
    uniforms,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vWPos, vWN;
      void main(){
        vUv = uv;
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      varying vec3 vWPos, vWN;
      uniform sampler2D tScope;
      uniform float uHasScope, eyeBox, ads;
      uniform vec2 uEyeOffset;
      uniform vec3 uRetCol, uSun, uSunCol, uUp, uZen, uHor, uHorAway;

      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float px = max(fwidth(r), 0.002);
        float rim = smoothstep(0.955, 1.0, r);

        // Live magnified scope picture with subtle edge pincushion & chromatic dispersion
        float distK = 1.0 + 0.045 * r * r;
        vec2 suv = clamp(0.5 + p * 0.5 * distK, vec2(0.002), vec2(0.998));
        float ca = 0.0038 * smoothstep(0.35, 1.0, r);
        vec2 caDir = r > 1e-4 ? p / r : vec2(0.0);
        vec3 scopeImg = vec3(
          texture2D(tScope, clamp(suv + caDir * ca, vec2(0.002), vec2(0.998))).r,
          texture2D(tScope, suv).g,
          texture2D(tScope, clamp(suv - caDir * ca, vec2(0.002), vec2(0.998))).b
        );
        // Subtle optical emerald-cyan glass edge tint
        scopeImg *= mix(vec3(1.0), vec3(0.86, 0.98, 0.95), smoothstep(0.58, 0.98, r));

        // Etched first-focal-plane mil-dot & rangefinder reticle
        float lineW = max(0.0032, px * 0.65);
        float gap = 0.055;
        float hLine = (1.0 - smoothstep(lineW * 0.6, lineW + px * 0.6, abs(p.y)))
          * step(gap, abs(p.x)) * (1.0 - smoothstep(0.88, 0.92, abs(p.x)));
        float vLine = (1.0 - smoothstep(lineW * 0.6, lineW + px * 0.6, abs(p.x)))
          * ((step(gap, -p.y) * (1.0 - smoothstep(0.88, 0.92, abs(p.y))))
           + (step(0.14, p.y) * (1.0 - smoothstep(0.62, 0.66, p.y))));
        // Heavy outer duplex posts
        float postW = lineW * 2.6;
        float hPost = (1.0 - smoothstep(postW * 0.7, postW + px, abs(p.y))) * step(0.52, abs(p.x)) * step(abs(p.x), 0.94);
        float vPost = (1.0 - smoothstep(postW * 0.7, postW + px, abs(p.x))) * step(0.52, -p.y) * step(-p.y, 0.94);

        // Mil-dots at 0.16, 0.28, 0.40 on horizontal and lower vertical axes
        float dots = 0.0;
        for (int i = 1; i <= 3; i++) {
          float m = float(i) * 0.12 + 0.04;
          dots = max(dots, 1.0 - smoothstep(0.010, 0.010 + px, length(vec2(abs(p.x) - m, p.y))));
          dots = max(dots, 1.0 - smoothstep(0.010, 0.010 + px, length(vec2(p.x, p.y + m))));
        }
        float etched = clamp(max(max(hLine, vLine), max(max(hPost, vPost), dots)), 0.0, 1.0);

        // Illuminated center horseshoe + 1 MOA dot / chevron
        float cDot = 1.0 - smoothstep(0.014, 0.014 + px, r);
        float cRing = (1.0 - smoothstep(0.005, 0.005 + px, abs(r - 0.044))) * step(-0.75, p.y / max(r, 1e-4));
        float illum = clamp(cDot + cRing * 0.9, 0.0, 1.0);

        scopeImg = mix(scopeImg, vec3(0.02), etched * 0.9);
        scopeImg += uRetCol * illum * (1.35 + 0.6 * ads);

        // Physical eye-box shadow vignette (crescent shadow when off-axis or eyeBox < 1)
        float boxOpen = clamp(eyeBox, 0.0, 1.0) * smoothstep(0.08, 0.88, ads);
        float boxRad = mix(0.14, 1.06, boxOpen);
        vec2 shadowCenter = uEyeOffset * mix(1.5, 0.55, boxOpen);
        float dEye = length(p - shadowCenter);
        float softness = mix(0.28, 0.085, boxOpen);
        float clearMask = 1.0 - smoothstep(boxRad - softness, boxRad + softness * 0.5, dEye);
        clearMask *= uHasScope;

        // Multi-coated ocular glass reflection (visible at hip & lightly across dark regions)
        vec3 wv = normalize(vWPos - cameraPosition);
        vec3 n = normalize(vWN);
        if (dot(n, wv) > 0.0) n = -n;
        vec3 rf = reflect(wv, n);
        float fres = pow(1.0 - abs(dot(wv, n)), 3.0);
        vec3 upN = normalize(uUp), sunN = normalize(uSun);
        float sunAz = clamp(dot(rf, sunN) * 0.5 + 0.5, 0.0, 1.0);
        vec3 horCol = mix(uHorAway, uHor, pow(sunAz, 2.0));
        vec3 sky = mix(horCol, uZen, clamp(dot(rf, upN) * 1.35 + 0.2, 0.0, 1.0));
        float sd = max(dot(rf, sunN), 0.0);
        sky += uSunCol * (pow(sd, 7.0) * 0.5 + pow(sd, 96.0) * 4.5);
        vec3 coat = mix(vec3(0.16, 0.52, 0.44), vec3(0.58, 0.26, 0.72), clamp(fres * 2.0 + vUv.y * 0.5, 0.0, 1.0));
        vec3 darkTube = vec3(0.008, 0.009, 0.011) + sky * coat * (0.14 + 0.55 * fres);

        vec3 col = mix(darkTube, scopeImg + sky * coat * 0.05 * fres, clearMask);
        col = mix(col, vec3(0.005, 0.006, 0.007), rim);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  // Alias `material.map` <-> `uniforms.tScope.value` so both SurfaceWeapons's
  // `lens.material.map` contract and direct `uniforms.tScope` updates stay in sync.
  Object.defineProperty(mat, 'map', {
    get() {
      return uniforms.tScope.value;
    },
    set(tex) {
      uniforms.tScope.value = tex || null;
      uniforms.uHasScope.value = tex ? 1 : 0;
    },
    enumerable: true,
    configurable: true,
  });

  const opticGlass = new THREE.Mesh(geo, mat);
  opticGlass.name = 'optic-glass';
  opticGlass.position.set(0, y, z);
  opticGlass.renderOrder = 6;
  opticGlass.frustumCulled = false;
  opticGlass.onBeforeRender = () => {
    uniforms.uHasScope.value = uniforms.tScope.value ? 1 : 0;
  };

  const objective = new THREE.Object3D();
  objective.name = 'scope-objective';
  objective.position.set(0, objectiveY ?? y, objectiveZ);

  return {
    opticGlass,
    objective,
    uniforms,
    update({ ads = 0, eyeBox = 1, eyeOffsetX = 0, eyeOffsetY = 0 } = {}) {
      uniforms.ads.value = clamp(ads, 0, 1);
      uniforms.eyeBox.value = clamp(eyeBox, 0, 1);
      uniforms.uEyeOffset.value.set(eyeOffsetX, eyeOffsetY);
      uniforms.uHasScope.value = uniforms.tScope.value ? 1 : 0;
    },
  };
}
