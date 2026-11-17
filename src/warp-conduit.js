// Warp conduit: the tunnel as real 3D geometry around the travel axis.
//
// One scalar field F(d) - "formation" - says how much of ordinary space at
// distance d ahead has been folded into the conduit. A formation front sweeps
// from the far end back over the ship on entry; an opening front sweeps the
// same way on exit. The near-field star streaks, the conduit wall, the inner
// veil and the far throat all read the same F(d): streaks are bent onto the
// conduit radius and become the wall's filaments, instead of one effect
// fading out while another fades in.
//
// The conduit lives in its own frame (local -Z = heading) that the host moves
// with the camera. Everything is transparent, depth-tested against the hull
// (it is drawn on the ship's foreground layer, after the world and its post
// effects), so the hull and cockpit always sit in front of it.

import * as THREE from 'three';

export const CONDUIT_PERIOD = 36000.0;

const NOISE = /* glsl */`
float cHash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// value noise, periodic with integer period 'per'
float pnoise(vec2 p, vec2 per){
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i0 = mod(i, per);
  vec2 i1 = mod(i + 1.0, per);
  float a = cHash12(i0);
  float b = cHash12(vec2(i1.x, i0.y));
  float c = cHash12(vec2(i0.x, i1.y));
  float d = cHash12(i1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

const FORMATION = /* glsl */`
uniform float uEnter;   // 0..1 formation front
uniform float uExit;    // 0..1 opening front
uniform float uDMax;    // conduit length
uniform float uScale;   // radius / 60
uniform float uFrontNear; // how far behind the ship a front ends (reference units)
float frontPos(float k){
  float q = 1.0 - k;
  return mix(-uFrontNear * uScale, uDMax + 1500.0 * uScale, q * q);
}
float formation(float d){
  float fe = frontPos(uEnter);
  float we = 120.0 * uScale + 0.22 * max(fe, 0.0);
  float fx = frontPos(uExit);
  float wx = 140.0 * uScale + 0.26 * max(fx, 0.0);
  return smoothstep(fe - we, fe + we, d) * (1.0 - smoothstep(fx - wx, fx + wx, d));
}
// The axis wanders: the far conduit curves away, the near part stays on the
// heading so it lines up with the real sky at entry and exit.
uniform vec2 uBend;
vec2 bendAt(float d){
  float q = max(d, 0.0) / (1800.0 * uScale);
  return uBend * 1800.0 * uScale * q * q / (1.0 + q);
}
`;

const WALL_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uR;
uniform float uWide;
uniform float uZNear;
uniform float uZFar;
uniform float uTime;
uniform float uRadiusScale;
varying vec2 vUv;
varying float vD;
${FORMATION}
void main(){
  vUv = uv;
  // 1/r-style subdivision: rows bunch up near the ship
  float z = mix(uZNear, uZFar, uv.y * uv.y);
  float d = -z;
  float F = formation(d);
  float ang = uv.x * 6.28318530718;
  float breathe = 1.0 + 0.012 * sin(d / uScale * 0.0035 - uTime * 0.7);
  float r = uR * uRadiusScale * mix(uWide, 1.0, F) * breathe;
  vec2 axis = bendAt(d) * F;
  vec3 p = vec3(cos(ang) * r + axis.x, sin(ang) * r + axis.y, z);
  vD = d;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const WALL_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uOffset;
uniform float uTime;
uniform float uIntensity;
uniform float uTwist;
uniform float uGlow;
uniform float uDetail;
uniform vec3 uColDeep, uColMid, uColFil, uColRib, uColThroat, uColEdge, uColWarm;
uniform float uWarmMix;
varying vec2 vUv;
varying float vD;
${NOISE}
${FORMATION}
const float P = ${CONDUIT_PERIOD.toFixed(1)};
void main(){
  #include <logdepthbuf_fragment>
  float d = vD;
  float F = formation(d);
  float s = (d + uOffset) / uScale;                       // scrolls toward the viewer
  float a = vUv.x + d / uScale * uTwist + uTime * 0.0035;  // slow helix

  // formation / dissolve: near, the wall crystallises with an eroded edge;
  // far, it condenses smoothly into the throat light
  float dn = pnoise(vec2(a * 24.0, s / 240.0), vec2(24.0, P / 240.0));
  float hz = smoothstep(0.0, 1.0, 1.0 - exp(-max(d, 0.0) / (2000.0 * uScale)));
  float m = F * 1.3 - 0.3 + (dn - 0.5) * 0.6 * (1.0 - 0.8 * hz);
  float alpha = mix(smoothstep(0.0, 0.14, m), F * F, hz);
  float edge = smoothstep(0.0, 0.04, m) * (1.0 - smoothstep(0.04, 0.12, m)) * (1.0 - hz);
  if (alpha < 0.002 && edge < 0.002) discard;

  // large plasma lanes: the light/dark order of the conduit
  float big = pnoise(vec2(a * 6.0, s / 900.0), vec2(6.0, P / 900.0)) * 0.62
            + pnoise(vec2(a * 14.0, s / 300.0), vec2(14.0, P / 300.0)) * 0.38;
  float bigB = pnoise(vec2(a * 6.0, (s + 60.0) / 900.0), vec2(6.0, P / 900.0)) * 0.62
             + pnoise(vec2(a * 14.0, (s + 60.0) / 300.0), vec2(14.0, P / 300.0)) * 0.38;
  // faces tilted toward the throat catch its light -> relief
  float relief = clamp((bigB - big) * 7.0, -1.0, 1.0) * 0.6;
  float lanes = smoothstep(0.36, 0.72, big);

  // braided filaments (captured starlight), advected by the plasma field
  float warpA = (big - 0.5) * 0.045 + (pnoise(vec2(a * 10.0, s / 520.0), vec2(10.0, P / 520.0)) - 0.5) * 0.02;
  float fc = (a + warpA) * 180.0;
  float fn = pnoise(vec2(fc, s / 900.0), vec2(180.0, P / 900.0));
  float ridge = 1.0 - abs(fn * 2.0 - 1.0);
  float fw = clamp(fwidth(fc) * 1.2, 0.0, 1.0);
  float fil = pow(ridge, mix(16.0, 2.5, fw)) * mix(1.0, 0.3, fw);
  // broken into dashes: their foreshortening is the depth cue
  fil *= smoothstep(0.3, 0.62, pnoise(vec2(fc * 0.5, s / 300.0), vec2(90.0, P / 300.0)));
  float bank = 0.35 + 0.65 * smoothstep(0.2, 0.85, pnoise(vec2(a * 5.0, s / 360.0), vec2(5.0, P / 360.0)));

  // a few major filaments, gated into travelling segments
  float fc2 = (a + warpA * 1.4) * 28.0;
  float fn2 = pnoise(vec2(fc2, s / 2400.0), vec2(28.0, P / 2400.0));
  float ridge2 = 1.0 - abs(fn2 * 2.0 - 1.0);
  float fw2 = clamp(fwidth(fc2) * 2.0, 0.0, 1.0);
  float major = pow(ridge2, mix(34.0, 4.0, fw2)) * mix(1.0, 0.25, fw2);
  major *= smoothstep(0.38, 0.78, pnoise(vec2(fc2, s / 400.0), vec2(28.0, P / 400.0)));

  // bright knots sliding along the filaments: the heirs of the star points
  float knots = 0.0;
  if (uDetail > 0.5) {
    float kn = pnoise(vec2(fc, s / 60.0), vec2(180.0, P / 60.0));
    float kfw = clamp(fwidth(s / 60.0) * 0.8, 0.0, 1.0);
    knots = pow(kn, 7.0) * fil * 3.0 * (1.0 - kfw);
  }

  // sparse pressure ribs: broken arcs that mark distance
  float rsc = s / 300.0;
  float ri = floor(rsc);
  float rf = fract(rsc) - 0.5;
  float rh = cHash12(vec2(mod(ri, P / 300.0), 7.31));
  float ringW = 0.05;
  float ringWe = max(ringW, fwidth(rsc) * 0.9);
  float ring = exp(-(rf * rf) / (ringWe * ringWe)) * (ringW / ringWe);
  float arcs = smoothstep(0.45, 0.78, pnoise(vec2(a * 8.0, rh * 97.0), vec2(8.0, 1000.0)));
  float exists = step(0.3, rh) * (0.5 + rh * 0.7);
  float ribFar = 1.0 - smoothstep(1300.0, 2600.0, d / uScale);
  ring *= arcs * exists * smoothstep(150.0, 900.0, d / uScale) * ribFar;
  float groove = exp(-(rf * rf) / (0.16 * 0.16)) * (0.35 + 0.65 * arcs) * exists * ribFar;
  // the tube's breathing: wide soft compression waves rushing toward the ship
  float wave = 0.5 + 0.5 * sin(s / 520.0 * 6.28318530718 + big * 2.0);
  wave = mix(1.0, 0.72 + 0.5 * wave * wave, (1.0 - hz) * smoothstep(80.0, 600.0, d / uScale));

  // the conduit is lit by its own far throat
  float depthLit = smoothstep(-250.0 * uScale, uDMax, d);
  float illum = 0.42 + 0.58 * pow(depthLit, 1.25);
  float fine = pnoise(vec2((a + warpA) * 40.0, s / 140.0), vec2(40.0, P / 140.0));
  // dark lanes stay plasma, never holes: the wall always reads as a surface
  vec3 base = mix(uColDeep * 2.0 + uColMid * 1.05, uColMid * 2.6, smoothstep(0.2, 0.85, big));
  base *= illum * (0.62 + 0.6 * relief) * (0.8 + 0.4 * fine);
  base *= (1.0 - 0.35 * groove) * (0.7 + 0.45 * bank) * wave;
  vec3 laneGlow = mix(uColMid * 3.0, uColFil, 0.35) * pow(lanes, 2.2) * (0.15 + 0.3 * fine);

  float lanesG = lanes * lanes;
  float nearDim = 0.5 + 0.5 * smoothstep(0.0, 1400.0, d / uScale);
  // a minority of filaments burn warm (destination-star tint)
  float warm = smoothstep(0.62, 0.8, pnoise(vec2(fc2 * 0.25, s / 1600.0), vec2(7.0, P / 1600.0))) * uWarmMix;
  vec3 filCol = mix(uColFil, uColWarm, warm);
  vec3 emis = filCol * (fil * lanesG * 0.5 + major * lanes * 0.8 + knots * lanesG * 1.4);
  emis += laneGlow;
  emis *= nearDim * (0.45 + 0.8 * bank) * wave;
  emis += uColRib * ring * 0.16 * (0.4 + 0.6 * nearDim);
  emis *= (0.45 + 0.55 * illum) * uIntensity * uGlow;
  vec3 col = base + emis;

  // haze converging on the throat light gives the extreme-depth read
  float haze = 1.0 - exp(-max(d, 0.0) / (2500.0 * uScale));
  float hzk = smoothstep(0.0, 1.0, haze);
  col = mix(col, uColThroat * mix(0.4, 0.85, hzk * hzk) * (0.85 + 0.25 * big) * uIntensity, pow(hzk, 3.0) * 0.94);
  col *= mix(1.0, F * F, hz);
  col += mix(uColEdge, uColFil, 0.6) * edge * 0.22 * uIntensity * (0.3 + 0.7 * lanes);
  gl_FragColor = vec4(col, max(alpha, edge * 0.25));
}
`;

const VEIL_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uOffset;
uniform float uTime;
uniform float uIntensity;
uniform float uTwist;
uniform float uGlow;
uniform vec3 uColFil;
uniform vec3 uColThroat;
varying vec2 vUv;
varying float vD;
${NOISE}
${FORMATION}
const float P = ${CONDUIT_PERIOD.toFixed(1)};
void main(){
  #include <logdepthbuf_fragment>
  float d = vD;
  float F = formation(d);
  float s = (d + uOffset) / uScale;
  float a = vUv.x - d / uScale * uTwist * 1.7 - uTime * 0.009;
  float w1 = pnoise(vec2(a * 5.0, s / 720.0), vec2(5.0, P / 720.0));
  float w2 = pnoise(vec2(a * 11.0, s / 240.0), vec2(11.0, P / 240.0));
  float wisp = smoothstep(0.58, 0.95, w1 * 0.62 + w2 * 0.38);
  float fade = smoothstep(-60.0, 260.0, d / uScale) * (1.0 - smoothstep(1400.0, 3600.0, d / uScale));
  float k = wisp * fade * F * F * uGlow * uIntensity;
  if (k < 0.001) discard;
  gl_FragColor = vec4(mix(uColFil, uColThroat, 0.5) * k * 0.34, 1.0);
}
`;

const THROAT_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uR;
uniform float uWide;
varying vec2 vP;
varying float vF;
${FORMATION}
void main(){
  vP = position.xy;
  float F = formation(uDMax);
  vF = F;
  float r = uR * mix(uWide, 1.0, F) * 1.04;
  vec2 axis = bendAt(uDMax) * F;
  vec3 p = vec3(position.xy * r + axis, -uDMax);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const THROAT_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uIntensity;
uniform float uTime;
uniform vec3 uColThroat;
uniform vec3 uColFil;
varying vec2 vP;
varying float vF;
${NOISE}
void main(){
  #include <logdepthbuf_fragment>
  float r = length(vP);
  float ang = atan(vP.y, vP.x) / 6.28318530718 + 0.5;
  float n = pnoise(vec2(ang * 16.0, uTime * 0.6), vec2(16.0, 1000.0));
  float alpha = smoothstep(0.15, 1.0, vF);
  if (alpha < 0.002) discard;
  float core = exp(-r * r * 7.0) * (0.85 + 0.3 * n);
  vec3 col = uColThroat * (0.36 + 0.9 * core) + uColFil * core * 0.2;
  gl_FragColor = vec4(col * uIntensity * vF * vF, alpha);
}
`;

// Near-field star streaks: a cylinder of points that flows past the ship at
// the visual warp speed, so streak length follows depth (1/z) and every star
// visibly rushes by. The formation field folds them onto the conduit radius.
const STAR_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aSeed;   // r0, theta, z01, magnitude
attribute vec3 aColor;
uniform float uTravel;
uniform float uFieldNear;
uniform float uFieldLen;
uniform float uStreak;
uniform vec2 uRes;
uniform float uPx;
uniform float uR;
uniform float uWide;
uniform float uGain;
uniform vec3 uColFil;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vQ;
varying float vLen;
varying float vHW;
${FORMATION}
void main(){
  float r0 = aSeed.x;
  float th = aSeed.y;
  float mag = aSeed.w;
  float z = uFieldNear - uFieldLen + mod(aSeed.z * uFieldLen + uTravel, uFieldLen);
  float d = -z;
  float F = formation(max(d, -60.0 * uScale));
  float h = fract(mag * 17.13 + aSeed.z * 5.7);
  float rt = uR * mix(uWide, 1.0, F) * (0.9 + 0.2 * h);
  float r = mix(r0, rt, F);
  th += F * (h - 0.5) * 0.18;
  vec2 axis = bendAt(d) * F;
  vec3 head = vec3(cos(th) * r + axis.x, sin(th) * r + axis.y, z);
  vec3 tail = head - vec3(0.0, 0.0, uStreak);
  tail.z = max(tail.z, uFieldNear - uFieldLen);

  vec4 hv = modelViewMatrix * vec4(head, 1.0);
  vec4 tv = modelViewMatrix * vec4(tail, 1.0);
  const float NZ = -0.5;
  vAlpha = 0.0; vQ = vec2(0.0); vLen = 0.0; vHW = 1.0; vColor = vec3(0.0);
  if (hv.z > NZ && tv.z > NZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (hv.z > NZ) hv = mix(tv, hv, (NZ - tv.z) / (hv.z - tv.z));
  else if (tv.z > NZ) tv = mix(hv, tv, (NZ - hv.z) / (tv.z - hv.z));
  vec4 ch = projectionMatrix * hv;
  vec4 ct = projectionMatrix * tv;
  vec2 sh = (ch.xy / ch.w * 0.5 + 0.5) * uRes;
  vec2 st = (ct.xy / ct.w * 0.5 + 0.5) * uRes;
  vec2 dv = sh - st;
  float lpx = length(dv);
  vec2 dir = lpx > 1e-3 ? dv / lpx : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = (0.55 + 1.35 * mag) * uPx;
  float ext = hw * 2.0;
  float along = position.x;
  float side = position.y;
  vec2 p = mix(st, sh, along) + dir * (along * 2.0 - 1.0) * ext + nrm * side * ext;
  vQ = vec2(along * lpx + (along * 2.0 - 1.0) * ext, side * ext);
  vLen = lpx;
  vHW = hw;
  float energy = pow(hw * 3.0 / (lpx + hw * 3.0), mix(0.35, 0.75, 1.0 - mag));
  float farFade = smoothstep(uFieldNear - uFieldLen, uFieldNear - uFieldLen + 700.0 * uScale, z);
  float absorb = 1.0 - smoothstep(0.5, 0.95, F);
  float flare = 1.0 + 1.1 * F * (1.0 - F) * 4.0;
  vAlpha = (0.05 + 1.1 * mag * mag) * energy * farFade * absorb * flare * uGain;
  vColor = mix(aColor, uColFil, smoothstep(0.1, 0.8, F));
  vec4 cc = mix(ct, ch, along);
  gl_Position = vec4((p / uRes) * 2.0 - 1.0, cc.z / cc.w, 1.0);
  #ifdef USE_LOGDEPTHBUF
    vFragDepth = 1.0 + cc.w;
    vIsPerspective = 1.0;
  #endif
}
`;

const STAR_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
varying vec2 vQ;
varying float vLen;
varying float vHW;
void main(){
  #include <logdepthbuf_fragment>
  if (vAlpha < 0.001) discard;
  float dx = max(0.0, max(-vQ.x, vQ.x - vLen));
  float dist2 = dx * dx + vQ.y * vQ.y;
  float prof = exp(-dist2 / (vHW * vHW) * 1.1);
  float t = clamp(vQ.x / max(vLen, 1e-3), 0.0, 1.0);
  float grad = mix(0.12, 1.0, pow(t, 1.3));
  grad = mix(1.0, grad, smoothstep(vHW * 1.5, vHW * 8.0, vLen));
  float a = prof * grad * vAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;

// Palettes in sRGB; converted to linear on use.
export const CONDUIT_STYLES = Object.freeze({
  abyssal: { deep: '#020409', mid: '#0d2144', filament: '#a8ccff', rib: '#d6e6ff',
    throat: '#e4f0ff', edge: '#6fa4ff', light: '#cfe2ff', ambient: '#1a2c55' },
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class WarpConduit {
  // radius: conduit radius in metres; layer: the render layer to draw on.
  constructor({ radius = 220, layer = 0, quality = 'medium', renderOrder = 40 } = {}) {
    this.radius = radius;
    this.scale = radius / 60;
    this.group = new THREE.Group();
    this.group.name = 'warp-conduit';
    this.group.visible = false;
    const k = this.scale;
    const q = quality === 'low'
      ? { stars: 1600, radial: 96, rows: 150, veil: false, detail: 0 }
      : { stars: 2600, radial: 144, rows: 210, veil: true, detail: 1 };
    this.quality = q;
    this.shared = {
      uEnter: { value: 0 }, uExit: { value: 0 }, uDMax: { value: 4000 * k }, uScale: { value: k },
      uFrontNear: { value: 1700 }, uR: { value: radius }, uWide: { value: 7.0 }, uTime: { value: 0 },
      uOffset: { value: 0 }, uIntensity: { value: 1 }, uGlow: { value: 0 }, uTwist: { value: 0.00005 },
      uBend: { value: new THREE.Vector2() },
      uColDeep: { value: new THREE.Color() }, uColMid: { value: new THREE.Color() },
      uColFil: { value: new THREE.Color() }, uColRib: { value: new THREE.Color() },
      uColThroat: { value: new THREE.Color() }, uColEdge: { value: new THREE.Color() },
      uColWarm: { value: new THREE.Color(1, 0.7, 0.45) }, uWarmMix: { value: 0.35 },
    };
    this.setStyle(CONDUIT_STYLES.abyssal);
    const make = (vertexShader, fragmentShader, extra, blending, name) => {
      const material = new THREE.ShaderMaterial({
        vertexShader, fragmentShader, uniforms: { ...this.shared, ...extra },
        transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending,
        toneMapped: false,
      });
      material.name = name;
      return material;
    };
    this.wallGeometry = new THREE.PlaneGeometry(1, 1, q.radial, q.rows);
    this.wall = new THREE.Mesh(this.wallGeometry, make(WALL_VERT, WALL_FRAG, {
      uZNear: { value: 250 * k }, uZFar: { value: -4000 * k }, uRadiusScale: { value: 1 }, uDetail: { value: q.detail },
    }, THREE.NormalBlending, 'conduit-wall'));
    this.throat = new THREE.Mesh(new THREE.CircleGeometry(1, 96),
      make(THROAT_VERT, THROAT_FRAG, {}, THREE.NormalBlending, 'conduit-throat'));
    this.veil = new THREE.Mesh(this.wallGeometry, make(WALL_VERT, VEIL_FRAG, {
      uZNear: { value: 250 * k }, uZFar: { value: -4000 * k }, uRadiusScale: { value: 0.58 },
    }, THREE.AdditiveBlending, 'conduit-veil'));
    this.starGeometry = this.#buildStars(q.stars);
    this.starMaterial = make(STAR_VERT, STAR_FRAG, {
      uTravel: { value: 0 }, uFieldNear: { value: 1200 * k }, uFieldLen: { value: 4400 * k },
      uStreak: { value: 0 }, uRes: { value: new THREE.Vector2(1920, 1080) }, uPx: { value: 1 }, uGain: { value: 1 },
    }, THREE.CustomBlending, 'conduit-stars');
    // premultiplied additive: colour already carries its alpha
    this.starMaterial.blendSrc = THREE.OneFactor;
    this.starMaterial.blendDst = THREE.OneFactor;
    this.stars = new THREE.Mesh(this.starGeometry, this.starMaterial);
    this.wall.renderOrder = renderOrder;
    this.throat.renderOrder = renderOrder + 1;
    this.veil.renderOrder = renderOrder + 2;
    this.stars.renderOrder = renderOrder + 3;
    for (const mesh of [this.wall, this.throat, this.veil, this.stars]) {
      mesh.frustumCulled = false;
      mesh.layers.set(layer);
      this.group.add(mesh);
    }
    this.travel = 0;
    this.clock = 0;
    this.state = { enclosure: 0, coverage: 0, glow: 0, ribPulse: 0 };
  }

  setStyle(style) {
    const s = this.shared;
    s.uColDeep.value.set(style.deep);
    s.uColMid.value.set(style.mid);
    s.uColFil.value.set(style.filament);
    s.uColRib.value.set(style.rib);
    s.uColThroat.value.set(style.throat);
    s.uColEdge.value.set(style.edge);
  }

  // Tint the far end toward the destination star (linear colour).
  setDestinationTint(color, amount = 0.3) {
    this.shared.uColThroat.value.set(CONDUIT_STYLES.abyssal.throat).lerp(color, amount);
    this.shared.uColWarm.value.copy(color).lerp(new THREE.Color(1, 0.7, 0.45), 0.5);
  }

  setSize(width, height, pixelRatio) {
    this.starMaterial.uniforms.uRes.value.set(width, height);
    this.starMaterial.uniforms.uPx.value = pixelRatio;
  }

  #buildStars(count) {
    const k = this.scale;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const seed = new Float32Array(count * 4);
    const color = new Float32Array(count * 3);
    const rnd = mulberry32(1337);
    const rMin = 5 * k, rMax = 1700 * k;
    const tint = [[0.72, 0.82, 1.0], [0.86, 0.91, 1.0], [1.0, 0.97, 0.93], [1.0, 0.86, 0.68], [1.0, 0.74, 0.55]];
    for (let i = 0; i < count; i++) {
      seed[i * 4] = Math.sqrt(rMin * rMin + (rMax * rMax - rMin * rMin) * Math.pow(rnd(), 1.15));
      seed[i * 4 + 1] = rnd() * Math.PI * 2;
      seed[i * 4 + 2] = rnd();
      seed[i * 4 + 3] = Math.pow(rnd(), 3.2);
      color.set(tint[Math.min(4, Math.floor(Math.pow(rnd(), 1.4) * 5))], i * 3);
    }
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    geometry.instanceCount = count;
    return geometry;
  }

  // CPU mirror of the GLSL formation field.
  formationAt(d, enter, exit) {
    const k = this.scale, dmax = 4000 * k, near = this.shared.uFrontNear.value;
    const front = (x) => { const q = 1 - x; return -near * k + (dmax + 1500 * k + near * k) * q * q; };
    const fe = front(enter), we = 120 * k + 0.22 * Math.max(fe, 0);
    const fx = front(exit), wx = 140 * k + 0.26 * Math.max(fx, 0);
    return smooth(fe - we, fe + we, d) * (1 - smooth(fx - wx, fx + wx, d));
  }

  // Per frame. `frame` gives the conduit's world pose (camera-relative render
  // space, -Z along the heading); `params`: enter, exit (0..1 fronts), warp
  // (0..1 flow), speed (visual m/s), streak (metres), glow, bend (vec2).
  update(dt, frame, params) {
    this.clock += dt;
    const { enter = 0, exit = 0, warp = 0, speed = 0, streak = 0, starGain = 1, bend = null } = params;
    const k = this.scale;
    const active = enter > 0.0005 && exit < 0.9995;
    const starsLive = warp > 0.001 || active;
    this.group.visible = active || starsLive;
    this.group.position.copy(frame.position);
    this.group.quaternion.copy(frame.quaternion);
    this.group.updateMatrixWorld(true);
    this.travel += speed * dt;
    const s = this.shared;
    s.uEnter.value = enter;
    s.uExit.value = exit;
    s.uTime.value = this.clock;
    s.uOffset.value = this.travel % (CONDUIT_PERIOD * k);
    s.uGlow.value = 0.35 + 0.65 * smooth(0.15, 1, warp);
    if (bend) s.uBend.value.copy(bend);
    const enclosure = active ? this.formationAt(0, enter, exit) : 0;
    const coverage = Math.min(enter, 1 - exit);
    this.wall.visible = active;
    this.throat.visible = active;
    this.veil.visible = active && this.quality.veil && warp > 0.2;
    this.stars.visible = starsLive && !(coverage > 0.999 && enclosure > 0.999);
    const sm = this.starMaterial.uniforms;
    sm.uTravel.value = this.travel % (4400 * k);
    sm.uStreak.value = Math.min(streak, 1100 * k);
    sm.uGain.value = starGain * (1 + 0.15 * warp);
    const ribPhase = ((this.travel / k) % 300) / 300 - 0.5;
    this.state.enclosure = enclosure;
    this.state.coverage = coverage;
    this.state.glow = s.uGlow.value;
    this.state.ribPulse = Math.exp(-Math.pow(ribPhase / 0.06, 2));
    return this.state;
  }

  dispose() {
    this.group.removeFromParent();
    this.wallGeometry.dispose();
    this.throat.geometry.dispose();
    this.starGeometry.dispose();
    for (const mesh of [this.wall, this.throat, this.veil, this.stars]) mesh.material.dispose();
  }
}
