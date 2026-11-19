// Procedural cinematic star rendering:
//   1. Photosphere sphere: 3D spherical domain-warped convective granulation,
//      magnetic sunspots, Eddington limb darkening, chromospheric rim flash,
//      and atmospheric sunset extinction.
//   2. Inner volumetric corona shell: 3D BackSide plasma halo wrapping the limb
//      for close-up orbital skimming without billboard artifacts.
//   3. Solar prominence arches: seeded 3D magnetic plasma loops anchored in the
//      photosphere along active latitude bands.
//   4. Outer corona & anamorphic flare: camera-facing radial magnetic streamers
//      and a restrained cinema horizontal flare modulated by eclipse visibility.
//
// All shaders include Three.js logarithmic depth buffer chunks and construct
// cleanly in pure Node (no DOM / canvas dependency).

import * as THREE from 'three';
import { makeRng, strHash32 } from './rng.js';
import { adaptedStellarRgb } from './stellar-radiometry.js';

const _tmpVec = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpCamDir = new THREE.Vector3();
const _tmpRight = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
const _tmpMat = new THREE.Matrix4();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(1, 0, 0);

const NOISE_GLSL = /* glsl */`
float starHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float starNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(starHash(i + vec3(0, 0, 0)), starHash(i + vec3(1, 0, 0)), f.x),
      mix(starHash(i + vec3(0, 1, 0)), starHash(i + vec3(1, 1, 0)), f.x),
      f.y
    ),
    mix(
      mix(starHash(i + vec3(0, 0, 1)), starHash(i + vec3(1, 0, 1)), f.x),
      mix(starHash(i + vec3(0, 1, 1)), starHash(i + vec3(1, 1, 1)), f.x),
      f.y
    ),
    f.z
  );
}

float starFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * starNoise(p);
    p = p * 2.04 + vec3(13.7, -9.2, 5.4);
    a *= 0.5;
  }
  return v;
}

float starRidged(vec3 p) {
  float v = 0.0;
  float a = 0.52;
  for (int i = 0; i < 3; i++) {
    float n = 1.0 - abs(starNoise(p) * 2.0 - 1.0);
    v += a * n * n;
    p = p * 2.13 + vec3(-7.1, 11.3, 4.9);
    a *= 0.48;
  }
  return v;
}
`;

const PHOTOSPHERE_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocalDir;
varying vec3 vNormalView;
varying vec3 vViewPos;
void main() {
  vLocalDir = normalize(position);
  vNormalView = normalize(normalMatrix * normal);
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewPos = -mvPos.xyz;
  gl_Position = projectionMatrix * mvPos;
  #include <logdepthbuf_vertex>
}
`;

const PHOTOSPHERE_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uSeed;
uniform float uSpotStrength;
uniform float uGranuleScale;
uniform float uExtinction;
uniform vec3 uCoreColor;
uniform vec3 uMidColor;
uniform vec3 uDarkColor;
uniform vec3 uRimColor;
varying vec3 vLocalDir;
varying vec3 vNormalView;
varying vec3 vViewPos;
${NOISE_GLSL}

void main() {
  vec3 N = normalize(vNormalView);
  vec3 V = normalize(vViewPos);
  float mu = clamp(dot(N, V), 0.0, 1.0);

  // Differential solar rotation: equator spins faster than poles
  float lat = vLocalDir.y;
  float rotAngle = uTime * (0.018 - 0.007 * lat * lat);
  float ca = cos(rotAngle), sa = sin(rotAngle);
  vec3 p = vec3(
    vLocalDir.x * ca - vLocalDir.z * sa,
    vLocalDir.y,
    vLocalDir.x * sa + vLocalDir.z * ca
  );
  vec3 seedOff = vec3(uSeed * 1.73, uSeed * 2.41, uSeed * 0.89);

  // Domain-warped plasma convection (supergranules + boiling cells)
  vec3 flow = vec3(
    starFbm(p * 3.1 + seedOff + vec3(uTime * 0.022, 0.0, -uTime * 0.015)),
    starFbm(p * 3.1 + seedOff + vec3(19.4, uTime * 0.019, 7.2)),
    starFbm(p * 3.1 + seedOff + vec3(-8.3, 14.1, uTime * 0.021))
  );
  vec3 warped = p + (flow - 0.5) * 0.24;

  float macro = starFbm(warped * (uGranuleScale * 0.45) + seedOff + vec3(0.0, uTime * 0.016, 0.0));
  float granules = starRidged(warped * uGranuleScale + seedOff * 1.3 - vec3(uTime * 0.028, 0.0, uTime * 0.018));
  float fine = starNoise(warped * (uGranuleScale * 2.4) + vec3(uTime * 0.04));

  // Active-belt magnetic sunspots (concentrated at +/-10..38 deg latitude)
  float belt = exp(-pow((abs(lat) - 0.32) / 0.24, 2.0));
  float spotField = starFbm(p * 4.4 + seedOff * 2.1 + vec3(uTime * 0.005, 0.0, 0.0));
  float spotMask = smoothstep(0.68, 0.84, spotField) * belt * uSpotStrength;
  float faculae = smoothstep(0.58, 0.72, spotField) * (1.0 - smoothstep(0.72, 0.82, spotField)) * belt * 0.45;

  float heat = clamp(macro * 0.38 + granules * 0.56 + fine * 0.14 + faculae - spotMask * 0.85, 0.0, 1.25);
  float contrast = pow(clamp(heat, 0.0, 1.25), 1.45);

  // Rich blackbody ramp before ACES tone mapping: deep molten lanes -> fiery
  // plasma midtones -> incandescent white-hot boiling granule crests.
  vec3 col = mix(uDarkColor, uMidColor, smoothstep(0.08, 0.58, contrast));
  col = mix(col, uCoreColor, smoothstep(0.56, 1.08, contrast));

  // Eddington limb darkening: dramatic depth & warm saturation toward the limb
  float limb = mix(0.18, 1.0, pow(mu, 0.62));
  vec3 limbTint = mix(uDarkColor * 1.45 + uRimColor * 0.42, vec3(1.0), pow(mu, 0.48));
  col *= limb * limbTint;

  // Thin incandescent chromospheric limb flash right at the grazing horizon
  float rim = pow(1.0 - mu, 4.8);
  float rimFlicker = 0.72 + 0.38 * starNoise(warped * 10.5 + vec3(uTime * 0.06));
  col += uRimColor * rim * rimFlicker * 1.75;

  // Restrained HDR headroom: keeps saturated fiery midtones under ACES while
  // letting only the hottest granule peaks bloom cleanly.
  float peakBoost = 1.0 + smoothstep(0.72, 1.15, contrast) * 1.15;
  col *= 1.48 * peakBoost;

  // Planetary atmosphere sunset extinction
  vec3 extinctTint = vec3(1.35, 0.42, 0.12);
  col = mix(col, col * (1.0 - 0.82 * uExtinction) * 0.25 + extinctTint * (0.85 * limb), uExtinction * 0.78);

  gl_FragColor = vec4(col, 1.0);
  #include <logdepthbuf_fragment>
}
`;

const CORONA_SHELL_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocalDir;
varying vec3 vNormalView;
varying vec3 vViewPos;
void main() {
  vLocalDir = normalize(position);
  vNormalView = normalize(normalMatrix * normal);
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewPos = -mvPos.xyz;
  gl_Position = projectionMatrix * mvPos;
  #include <logdepthbuf_vertex>
}
`;

const CORONA_SHELL_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uSeed;
uniform float uOpacity;
uniform float uExtinction;
uniform vec3 uRimColor;
uniform vec3 uCoronaColor;
varying vec3 vLocalDir;
varying vec3 vNormalView;
varying vec3 vViewPos;
${NOISE_GLSL}

void main() {
  // BackSide sphere: invert normal so dot(N, V) peaks at center and vanishes at outer edge
  vec3 N = -normalize(vNormalView);
  vec3 V = normalize(vViewPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  // Concentrates into a soft volumetric atmosphere shell around the solar limb
  float shell = pow(ndv, 2.8) * smoothstep(0.0, 0.22, ndv);
  vec3 p = vLocalDir * 4.5 + vec3(uSeed * 2.3, uTime * 0.035, -uTime * 0.025);
  float wisps = 0.65 + 0.55 * starFbm(p);
  vec3 col = mix(uCoronaColor, uRimColor, pow(ndv, 1.4)) * shell * wisps * 1.15;
  col = mix(col, vec3(1.0, 0.42, 0.14) * shell * wisps * 0.6, uExtinction * 0.75);
  float alpha = clamp(shell * uOpacity * (1.0 - 0.7 * uExtinction), 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
  #include <logdepthbuf_fragment>
}
`;

const PROMINENCE_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aArcPhase;
varying vec2 vUv;
varying float vPhase;
void main() {
  vUv = uv;
  vPhase = aArcPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const PROMINENCE_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uOpacity;
uniform float uExtinction;
uniform vec3 uRimColor;
uniform vec3 uCoreColor;
varying vec2 vUv;
varying float vPhase;

float pHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float pNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(pHash(i), pHash(i + vec2(1.0, 0.0)), f.x),
    mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  // vUv.x = along arch [0..1], vUv.y = across ribbon width [0..1]
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float widthFade = pow(clamp(across, 0.0, 1.0), 1.65);
  float endFade = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);

  // Flowing magnetic plasma strands along the arch
  float flow1 = pNoise(vec2(vUv.x * 11.0 - uTime * 0.24 + vPhase, vUv.y * 4.5));
  float flow2 = pNoise(vec2(vUv.x * 23.0 + uTime * 0.17 + vPhase * 1.9, vUv.y * 7.0));
  float strands = smoothstep(0.24, 0.84, flow1 * 0.62 + flow2 * 0.38);

  // Brighter near anchored footpoints, delicate translucent crest at apex
  float footBoost = 0.62 + 0.55 * pow(abs(vUv.x * 2.0 - 1.0), 1.5);
  float intensity = widthFade * endFade * (0.28 + 0.72 * strands) * footBoost;

  vec3 col = mix(uRimColor, uCoreColor, pow(widthFade, 2.0) * 0.45);
  col = mix(col, vec3(1.0, 0.38, 0.12), uExtinction * 0.75);
  float fade = uOpacity * (1.0 - 0.78 * uExtinction);
  gl_FragColor = vec4(col * intensity * 2.25 * fade, intensity * fade);
  #include <logdepthbuf_fragment>
}
`;

const OUTER_CORONA_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vQuad;
void main() {
  vQuad = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const OUTER_CORONA_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uSeed;
uniform float uOpacity;
uniform float uEclipse;
uniform float uExtinction;
uniform float uCloseFactor;
uniform vec3 uCoronaColor;
uniform vec3 uFlareColor;
varying vec2 vQuad;

float cHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float cNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(cHash(i), cHash(i + vec2(1.0, 0.0)), f.x),
    mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  // vQuad in [-1, 1] maps to +/- 5.5 R around star center
  vec2 p = vQuad;
  float r = length(p);
  if (r > 1.0) discard;

  // Star disc radius in quad space is ~1 / 5.5 = 0.1818
  float discR = 0.182;
  float d = max(0.0, r - discR);

  // C1-smooth multi-scale exponential corona (keeps deep space velvet-black up close)
  float edgeMask = smoothstep(1.0, 0.68, r);
  float closeCalm = 1.0 - 0.62 * uCloseFactor;
  float innerGlow = exp(-d * 14.5) * 0.78;
  float midGlow = exp(-d * 6.4) * 0.22 * closeCalm;
  float outerGlow = exp(-d * 3.6) * 0.05 * closeCalm;

  // Radial magnetic coronal streamers (subtle eclipse-photo filaments)
  float ang = atan(p.y, p.x);
  vec2 dir = vec2(cos(ang), sin(ang));
  float ray1 = cNoise(dir * 5.2 + vec2(uSeed * 1.3, uTime * 0.035));
  float ray2 = cNoise(dir * 11.5 - vec2(uTime * 0.025, uSeed * 2.1));
  float radialFlow = cNoise(vec2(ang * 3.0 + uSeed, r * 7.5 - uTime * 0.14));
  float streamers = pow(clamp(ray1 * 0.58 + ray2 * 0.42, 0.0, 1.0), 2.0) * (0.7 + 0.3 * radialFlow);
  float streamerMask = exp(-d * 5.8) * smoothstep(discR * 0.88, discR * 1.18, r) * (1.0 - 0.45 * uCloseFactor);

  // Restrained cinema anamorphic horizontal streak (attenuates cleanly in eclipse or close-up)
  float streakY = exp(-abs(p.y) * 38.0);
  float streakX = exp(-abs(p.x) * 2.75) * smoothstep(1.0, 0.65, abs(p.x));
  float fineStreakY = exp(-abs(p.y) * 98.0);
  float anamorphic = (streakY * streakX * 0.34 + fineStreakY * streakX * 0.24)
    * (1.0 - 0.78 * uCloseFactor);

  float corona = (innerGlow + midGlow + outerGlow + streamers * streamerMask * 0.55) * edgeMask;
  vec3 cCol = mix(uCoronaColor, vec3(1.0, 0.45, 0.18), uExtinction * 0.8);
  vec3 fCol = mix(uFlareColor, vec3(1.0, 0.52, 0.24), uExtinction * 0.8);

  float vis = uOpacity * clamp(uEclipse, 0.0, 1.0) * (1.0 - 0.72 * uExtinction);
  vec3 outCol = (cCol * corona + fCol * anamorphic) * vis;
  float alpha = clamp((corona + anamorphic) * vis, 0.0, 1.0);
  gl_FragColor = vec4(outCol, alpha);
  #include <logdepthbuf_fragment>
}
`;

function spectralProfile(spec, referenceK) {
  const base = new THREE.Color().fromArray(adaptedStellarRgb(spec.temperatureK, referenceK));
  const cls = (spec.spectralClass || 'G')[0];
  const temp = spec.temperatureK || 5700;

  const coreColor = base.clone().lerp(new THREE.Color(0xffffff), 0.62);
  const midColor = base.clone();
  let darkColor;
  let rimColor;
  let coronaColor;
  let flareColor;
  let spotStrength = 0.55;
  let granuleScale = 12.0;

  if (cls === 'M') {
    darkColor = new THREE.Color(0x3a0702);
    rimColor = new THREE.Color(0xff4214);
    coronaColor = new THREE.Color(0xff6b2e);
    flareColor = new THREE.Color(0xff9a62);
    spotStrength = 0.82;
    granuleScale = 9.5;
  } else if (cls === 'K') {
    darkColor = new THREE.Color(0x5c1804);
    rimColor = new THREE.Color(0xff6b1c);
    coronaColor = new THREE.Color(0xff9d4a);
    flareColor = new THREE.Color(0xffcfa0);
    spotStrength = 0.68;
    granuleScale = 11.0;
  } else if (cls === 'G') {
    darkColor = new THREE.Color(0x5a1602);
    midColor.lerp(new THREE.Color(0xff9830), 0.36);
    rimColor = new THREE.Color(0xff5e14);
    coronaColor = base.clone().lerp(new THREE.Color(0xffa84c), 0.45);
    flareColor = base.clone().lerp(new THREE.Color(0xfff0d6), 0.5);
    spotStrength = 0.62;
    granuleScale = 13.0;
  } else if (cls === 'F' || cls === 'A') {
    darkColor = base.clone().multiplyScalar(0.32).lerp(new THREE.Color(0x284a88), 0.35);
    rimColor = base.clone().lerp(new THREE.Color(0x90d0ff), 0.45);
    coronaColor = base.clone().lerp(new THREE.Color(0xbde0ff), 0.35);
    flareColor = new THREE.Color(0xdcf0ff);
    spotStrength = 0.28;
    granuleScale = 14.5;
  } else if (cls === 'B' || cls === 'O') {
    darkColor = new THREE.Color(0x162d78);
    rimColor = new THREE.Color(0x66b8ff);
    coronaColor = new THREE.Color(0x7cc4ff);
    flareColor = new THREE.Color(0xc2e4ff);
    spotStrength = 0.18;
    granuleScale = 15.5;
  } else {
    // White dwarf (D)
    darkColor = new THREE.Color(0x3a5fa8);
    rimColor = new THREE.Color(0xaee0ff);
    coronaColor = new THREE.Color(0xcceaff);
    flareColor = new THREE.Color(0xffffff);
    spotStrength = 0.12;
    granuleScale = 19.0;
  }

  // Smooth temperature tweak for stars near spectral boundaries
  if (temp < 4200 && cls !== 'M') {
    rimColor.lerp(new THREE.Color(0xff4a16), 0.35);
  }

  return { base, coreColor, midColor, darkColor, rimColor, coronaColor, flareColor, spotStrength, granuleScale };
}

function buildProminencesGeometry(radius, seedKey, archCount = 4) {
  const rand = makeRng(`${seedKey}:prominences:v1`);
  const segU = 28;
  const positions = [];
  const uvs = [];
  const phases = [];
  const indices = [];
  let vertOffset = 0;

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const cur = new THREE.Vector3();
  const next = new THREE.Vector3();

  for (let a = 0; a < archCount; a++) {
    const lon = (a / archCount) * Math.PI * 2 + (rand() - 0.5) * 0.9;
    const latSign = a % 2 === 0 ? 1 : -1;
    const lat = latSign * (0.14 + rand() * 0.42);
    const span = 0.24 + rand() * 0.22; // angular half-span on sphere
    const tilt = (rand() - 0.5) * 0.65;
    const archHeight = radius * (0.14 + rand() * 0.18);
    const ribbonHalfWidth = radius * (0.026 + rand() * 0.020);
    const phase = rand() * 100;

    // Two anchor footpoints on the photosphere (slightly embedded at 0.985 R)
    const cLat = Math.cos(lat), sLat = Math.sin(lat);
    const centerDir = new THREE.Vector3(cLat * Math.cos(lon), sLat, cLat * Math.sin(lon)).normalize();
    const east = new THREE.Vector3(-Math.sin(lon), 0, Math.cos(lon)).normalize();
    const north = new THREE.Vector3().crossVectors(centerDir, east).normalize();
    const axis = east.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(north, Math.sin(tilt)).normalize();

    p0.copy(centerDir).multiplyScalar(Math.cos(span)).addScaledVector(axis, -Math.sin(span)).normalize().multiplyScalar(radius * 0.985);
    p1.copy(centerDir).multiplyScalar(Math.cos(span)).addScaledVector(axis, Math.sin(span)).normalize().multiplyScalar(radius * 0.985);
    mid.copy(centerDir).multiplyScalar(radius + archHeight);

    // Build two crossed ribbons per arch so it retains 3D volume from every viewing angle
    for (let sheet = 0; sheet < 2; sheet++) {
      const sheetOffset = vertOffset;
      for (let i = 0; i <= segU; i++) {
        const t = i / segU;
        const omt = 1 - t;
        // Quadratic Bezier arch
        cur.set(0, 0, 0)
          .addScaledVector(p0, omt * omt)
          .addScaledVector(mid, 2 * omt * t)
          .addScaledVector(p1, t * t);
        const tNext = Math.min(1, t + 0.02);
        const omtN = 1 - tNext;
        next.set(0, 0, 0)
          .addScaledVector(p0, omtN * omtN)
          .addScaledVector(mid, 2 * omtN * tNext)
          .addScaledVector(p1, tNext * tNext);
        tangent.subVectors(next, cur);
        if (tangent.lengthSq() < 1e-8) tangent.copy(axis);
        tangent.normalize();

        if (sheet === 0) {
          side.crossVectors(tangent, centerDir).normalize();
        } else {
          side.copy(cur).normalize();
        }
        const width = ribbonHalfWidth * (0.55 + 0.65 * Math.sin(t * Math.PI));
        positions.push(
          cur.x - side.x * width, cur.y - side.y * width, cur.z - side.z * width,
          cur.x + side.x * width, cur.y + side.y * width, cur.z + side.z * width,
        );
        uvs.push(t, 0, t, 1);
        phases.push(phase, phase);
        if (i < segU) {
          const baseIdx = sheetOffset + i * 2;
          indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx + 1, baseIdx + 3, baseIdx + 2);
        }
      }
      vertOffset += (segU + 1) * 2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aArcPhase', new THREE.Float32BufferAttribute(phases, 1));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

export function createStarVisual({ spec, referenceK, positionUniv, seed = '' }) {
  const R = spec.radiusRender;
  const seedKey = `${seed}:${spec.starId || spec.displayName || 'star'}`;
  const seedFloat = (strHash32(seedKey) % 10000) / 100;
  const profile = spectralProfile(spec, referenceK);

  const group = new THREE.Group();
  group.name = `star-${spec.starId || '0'}`;

  // 1. Photosphere sphere
  const photosphereGeo = new THREE.SphereGeometry(R, 96, 64);
  const photosphereMat = new THREE.ShaderMaterial({
    vertexShader: PHOTOSPHERE_VERT,
    fragmentShader: PHOTOSPHERE_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seedFloat },
      uSpotStrength: { value: profile.spotStrength },
      uGranuleScale: { value: profile.granuleScale },
      uExtinction: { value: 0 },
      uCoreColor: { value: profile.coreColor.clone() },
      uMidColor: { value: profile.midColor.clone() },
      uDarkColor: { value: profile.darkColor.clone() },
      uRimColor: { value: profile.rimColor.clone() },
    },
    fog: false,
    toneMapped: true,
  });
  const mesh = new THREE.Mesh(photosphereGeo, photosphereMat);
  mesh.name = 'star-photosphere';
  group.add(mesh);

  // 2. Inner 3D volumetric corona shell
  const coronaShellGeo = new THREE.SphereGeometry(R * 1.26, 64, 48);
  const coronaShellMat = new THREE.ShaderMaterial({
    vertexShader: CORONA_SHELL_VERT,
    fragmentShader: CORONA_SHELL_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seedFloat },
      uOpacity: { value: 1 },
      uExtinction: { value: 0 },
      uRimColor: { value: profile.rimColor.clone() },
      uCoronaColor: { value: profile.coronaColor.clone() },
    },
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: true,
  });
  const coronaShell = new THREE.Mesh(coronaShellGeo, coronaShellMat);
  coronaShell.name = 'star-corona-shell';
  group.add(coronaShell);

  // 3. Solar prominence magnetic arches (skip for ultra-compact white dwarfs)
  const cls = (spec.spectralClass || 'G')[0];
  const archCount = cls === 'D' ? 2 : cls === 'M' || cls === 'K' ? 4 : 3;
  const promGeo = buildProminencesGeometry(R, seedKey, archCount);
  const promMat = new THREE.ShaderMaterial({
    vertexShader: PROMINENCE_VERT,
    fragmentShader: PROMINENCE_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uExtinction: { value: 0 },
      uRimColor: { value: profile.rimColor.clone() },
      uCoreColor: { value: profile.coreColor.clone() },
    },
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: true,
  });
  const prominences = new THREE.Mesh(promGeo, promMat);
  prominences.name = 'star-prominences';
  group.add(prominences);

  // 4. Outer corona streamers + restrained anamorphic cinema flare (billboard quad)
  const outerCoronaGeo = new THREE.PlaneGeometry(2, 2);
  const outerCoronaMat = new THREE.ShaderMaterial({
    vertexShader: OUTER_CORONA_VERT,
    fragmentShader: OUTER_CORONA_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seedFloat },
      uOpacity: { value: 1 },
      uEclipse: { value: 1 },
      uExtinction: { value: 0 },
      uCloseFactor: { value: 0 },
      uCoronaColor: { value: profile.coronaColor.clone() },
      uFlareColor: { value: profile.flareColor.clone() },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: true,
  });
  const glow = new THREE.Mesh(outerCoronaGeo, outerCoronaMat);
  glow.name = 'star-outer-corona';
  glow.scale.setScalar(R * 5.5);
  glow.frustumCulled = false;
  group.add(glow);

  const light = new THREE.PointLight(profile.base, 3.2, 0, 0);

  let extinction = 0;

  return {
    spec,
    group,
    mesh,
    glow,
    coronaShell,
    prominences,
    light,
    baseColor: profile.base.clone().multiplyScalar(4),
    glowBase: profile.coronaColor.clone(),
    glowExt: 1,
    eclipseVis: 1,
    positionUniv: positionUniv.clone(),

    setExtinction(x) {
      extinction = x;
      this.glowExt = 1 - 0.72 * x;
      photosphereMat.uniforms.uExtinction.value = x;
      coronaShellMat.uniforms.uExtinction.value = x;
      promMat.uniforms.uExtinction.value = x;
      outerCoronaMat.uniforms.uExtinction.value = x;
    },

    update(timeSec, systemFade = 1, eclipseVisibility = 1) {
      photosphereMat.uniforms.uTime.value = timeSec;
      coronaShellMat.uniforms.uTime.value = timeSec;
      promMat.uniforms.uTime.value = timeSec;
      outerCoronaMat.uniforms.uTime.value = timeSec;

      // Orient the outer corona/flare quad to face the camera at origin (camera-relative space)
      const dist = group.position.length();
      if (dist > 1) {
        _tmpCamDir.copy(group.position).multiplyScalar(-1 / dist);
        const refUp = Math.abs(_tmpCamDir.y) < 0.96 ? _worldUp : _altUp;
        _tmpRight.crossVectors(refUp, _tmpCamDir).normalize();
        _tmpUp.crossVectors(_tmpCamDir, _tmpRight).normalize();
        _tmpMat.makeBasis(_tmpRight, _tmpUp, _tmpCamDir);
        _tmpQuat.setFromRotationMatrix(_tmpMat);
        glow.quaternion.copy(_tmpQuat);
      }

      // Close-up factor smoothly calms the anamorphic streak when skimming the corona
      const ratio = dist / Math.max(R, 1);
      const closeFactor = 1 - THREE.MathUtils.smoothstep(ratio, 1.8, 7.5);
      outerCoronaMat.uniforms.uCloseFactor.value = closeFactor;
      outerCoronaMat.uniforms.uOpacity.value = systemFade;
      outerCoronaMat.uniforms.uEclipse.value = eclipseVisibility;
      coronaShellMat.uniforms.uOpacity.value = systemFade;
      promMat.uniforms.uOpacity.value = systemFade;

      // Gently boost apparent corona footprint at very long interplanetary distances
      // so the star reads as a crisp jewel instead of sub-pixel aliasing, while
      // staying physically anchored at 5.5 R up close.
      const distBoost = 1 + Math.min(2.2, Math.max(0, (ratio - 40) / 140));
      glow.scale.setScalar(R * 5.5 * distBoost);
      this.eclipseVis = eclipseVisibility;
    },

    dispose() {
      photosphereGeo.dispose();
      photosphereMat.dispose();
      coronaShellGeo.dispose();
      coronaShellMat.dispose();
      promGeo.dispose();
      promMat.dispose();
      outerCoronaGeo.dispose();
      outerCoronaMat.dispose();
    },
  };
}
