// Procedural cinematic star rendering.
//
//   1. Photosphere: animated cellular granulation (domain-warped Worley cells
//      with bright upwelling centres and dark intergranular lanes), a slow
//      boiling macro-plasma layer, supergranular network faculae that brighten
//      toward the limb, sparse umbra/penumbra sunspots in the active belts and
//      chromatic limb darkening (the disc stays brightest at its centre and
//      deepens to a warm ember at the edge — there is no bright rim inside the
//      disc).
//   2. Corona: one BackSide sphere around the star. Every fragment reconstructs
//      its view ray's impact parameter b (in stellar radii) and evaluates an
//      analytic line-of-sight corona profile, so the halo starts exactly at the
//      true silhouette from any distance, including close skims, and fades
//      smoothly into space. Soft long streamers and a restrained anamorphic
//      streak ride on top.
//   3. Prominences: seeded magnetic plasma arches anchored in the active belts.
//
// All shaders include Three.js logarithmic depth buffer chunks and construct
// cleanly in pure Node (no DOM / canvas dependency).

import * as THREE from 'three';
import { makeRng, strHash32 } from './rng.js';
import { adaptedStellarRgb } from './stellar-radiometry.js';

const NOISE_GLSL = /* glsl */`
vec3 starHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float starHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float starNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(
      mix(starHash13(i + vec3(0, 0, 0)), starHash13(i + vec3(1, 0, 0)), f.x),
      mix(starHash13(i + vec3(0, 1, 0)), starHash13(i + vec3(1, 1, 0)), f.x),
      f.y
    ),
    mix(
      mix(starHash13(i + vec3(0, 0, 1)), starHash13(i + vec3(1, 0, 1)), f.x),
      mix(starHash13(i + vec3(0, 1, 1)), starHash13(i + vec3(1, 1, 1)), f.x),
      f.y
    ),
    f.z
  );
}

// Octaves are rotated against each other so the lattice never shows as
// axis-aligned blocks.
const mat3 STAR_OCT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

float starFbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * starNoise(p);
    p = STAR_OCT * p * 2.03 + vec3(13.7, -9.2, 5.4);
    a *= 0.5;
  }
  return v / 0.9375;
}
`;

const WORLEY_GLSL = /* glsl */`
// Animated 3D cellular noise: x = F1, y = F2, z = per-cell hash.
vec3 starWorley(vec3 p, float t, float jitter) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 9.0;
  float d2 = 9.0;
  float id = 0.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 h = starHash33(i + g);
        vec3 o = 0.5 + jitter * 0.5 * sin(t + 6.2831853 * h);
        vec3 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = h.z; }
        else if (d < d2) { d2 = d; }
      }
    }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
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
uniform vec3 uSeedOff;
uniform float uSpotStrength;
uniform float uSpotDensity;
uniform float uGranuleScale;
uniform float uGranuleAmp;
uniform float uIntensity;
uniform float uExtinction;
uniform vec3 uCoreColor;
uniform vec3 uMidColor;
uniform vec3 uDarkColor;
uniform vec3 uLimbU;
varying vec3 vLocalDir;
varying vec3 vNormalView;
varying vec3 vViewPos;
${NOISE_GLSL}
${WORLEY_GLSL}

void main() {
  vec3 N = normalize(vNormalView);
  vec3 V = normalize(vViewPos);
  float mu = clamp(dot(N, V), 0.0, 1.0);

  // Slow rigid rotation; the surface evolves through its own boiling instead
  // of differential shear, which would smear features into latitude stripes
  // over a long session.
  float rot = uTime * 0.0035;
  float ca = cos(rot), sa = sin(rot);
  vec3 p = vec3(vLocalDir.x * ca - vLocalDir.z * sa, vLocalDir.y, vLocalDir.x * sa + vLocalDir.z * ca);
  float t = uTime;
  vec3 so = uSeedOff;
  float lat = vLocalDir.y;

  // Screen footprint of one pixel on the unit sphere, for detail LOD.
  float px = length(fwidth(vLocalDir));

  // Macro plasma flow: large, slowly boiling convection pattern.
  vec3 q = p * 2.1 + so;
  vec3 warp = vec3(
    starFbm(q + vec3(0.0, 0.0, t * 0.012)),
    starFbm(q + vec3(5.2, 1.3, -t * 0.010)),
    starFbm(q + vec3(-3.1, 7.7, t * 0.011))
  );
  vec3 pw = p + (warp - 0.5) * 0.30;
  float macro = starFbm(pw * 3.6 + so * 1.7 + vec3(t * 0.008, -t * 0.006, t * 0.004));
  // Bright plasma rivers where the warped flow field folds over itself.
  float river = 1.0 - abs(2.0 * starFbm(pw * 5.2 + so * 0.7 + vec3(-t * 0.007, t * 0.009, 0.0)) - 1.0);
  river = pow(river, 7.0);
  float mLod = 1.0 - smoothstep(0.3, 0.85, px * 16.0);
  float meso = starFbm(pw * 16.0 + so * 2.3 + vec3(t * 0.03, t * 0.02, -t * 0.025));
  meso = mix(0.5, meso, mLod);

  // Supergranulation network (faculae) and active-region sunspots.
  vec3 sg = starWorley(pw * 7.0 + so, t * 0.045, 0.75);
  float network = 1.0 - smoothstep(0.0, 0.12, sg.y - sg.x);

  // Granulation: a fine "rice grain" texture of soft bright convective
  // cells divided by thin darker lanes. It is a texture, not a pattern.
  float gScale = uGranuleScale;
  float gLod = 1.0 - smoothstep(0.3, 0.85, px * gScale);
  float granule = 0.5;
  if (gLod > 0.0) {
    vec3 g = starWorley(pw * gScale + so * 3.1, t * 0.42, 0.9);
    float cell = 0.38 * smoothstep(0.0, 0.40, g.y - g.x) + 0.62 * (1.0 - g.x);
    granule = mix(0.5, cell, gLod);
  }

  float heat = 0.70
    + (macro - 0.5) * 1.05
    + river * 0.26
    + (meso - 0.5) * 0.30
    + (granule - 0.5) * 0.30 * uGranuleAmp;

  // Faculae: the network brightens toward the limb, where it is seen edge-on.
  float limbView = 1.0 - mu;
  heat += network * 0.22 * pow(limbView, 1.5);

  // Sunspots live only in a few supergranule cells inside the active belts.
  float belt = exp(-pow((abs(lat) - 0.30) / 0.17, 2.0));
  float spotSel = step(1.0 - uSpotDensity, sg.z) * belt * uSpotStrength;
  if (spotSel > 0.0) {
    float spotR = 0.17 + 0.10 * fract(sg.z * 13.7);
    float fil = starNoise(pw * gScale * 1.4 + so);
    float pen = 1.0 - smoothstep(spotR * (0.80 + 0.12 * fil), spotR * 1.05, sg.x);
    float umbra = 1.0 - smoothstep(spotR * 0.34, spotR * 0.50, sg.x);
    float plage = (1.0 - smoothstep(spotR * 1.05, spotR * 2.0, sg.x)) * (1.0 - pen);
    heat += plage * spotSel * 0.12 * (0.4 + limbView);
    heat = mix(heat, 0.40 + 0.08 * fil, pen * spotSel);
    heat = mix(heat, 0.10, umbra * spotSel);
  }
  heat = max(heat, 0.0);

  // Temperature ramp: ember lanes -> golden plasma -> white-hot crests.
  vec3 col = mix(uDarkColor, uMidColor, smoothstep(0.18, 0.74, heat));
  col = mix(col, uCoreColor, smoothstep(0.78, 1.20, heat));
  col *= 0.22 + 0.95 * heat;

  // Chromatic limb darkening: blue drops fastest, so the edge deepens to a
  // warm ember while the centre stays the brightest part of the disc.
  vec3 limb = 1.0 - uLimbU * (1.0 - sqrt(mu));
  // A blazing core: the centre of the disc runs hotter and brighter so the
  // star reads as a light source, not a lit orange ball.
  float core = mu * mu * mu;
  col = mix(col, uCoreColor * (0.35 + 0.95 * heat), core * 0.45);
  col *= limb * (0.62 + 1.25 * core) * uIntensity;

  // The filmic tone curve bleaches bright plasma toward peach; pre-saturate
  // so the disc lands on gold and ember instead of pastel.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(lum), col, 1.45), 0.0);

  // Planetary atmosphere sunset extinction.
  vec3 extinctTint = vec3(1.35, 0.42, 0.12);
  col = mix(col, extinctTint * lum * (1.0 - 0.55 * uExtinction), uExtinction * 0.82);

  gl_FragColor = vec4(col, 1.0);
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
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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
  float endFade = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);

  // Twisted magnetic strands flowing along the arch.
  float flow1 = pNoise(vec2(vUv.x * 13.0 - uTime * 0.22 + vPhase, vUv.y * 5.0 + vUv.x * 3.0));
  float flow2 = pNoise(vec2(vUv.x * 29.0 + uTime * 0.15 + vPhase * 1.9, vUv.y * 9.0 - vUv.x * 5.0));
  float strands = smoothstep(0.30, 0.85, flow1 * 0.6 + flow2 * 0.4);
  float wispy = pNoise(vec2(vUv.x * 6.0 + vPhase, uTime * 0.05));
  float widthFade = pow(clamp(across, 0.0, 1.0), mix(1.2, 2.6, wispy));

  // Dense, bright footpoints; a fainter, frayed crest.
  float footBoost = 0.55 + 0.65 * pow(abs(vUv.x * 2.0 - 1.0), 1.6);
  float intensity = widthFade * endFade * (0.22 + 0.78 * strands) * footBoost;

  vec3 col = mix(uRimColor, uCoreColor, pow(widthFade, 3.0) * 0.55 * strands);
  col = mix(col, vec3(1.0, 0.38, 0.12), uExtinction * 0.75);
  float fade = uOpacity * (1.0 - 0.78 * uExtinction);
  gl_FragColor = vec4(col * intensity * 1.7 * fade, 1.0);
  #include <logdepthbuf_fragment>
}
`;

const CORONA_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vViewPos;
varying vec3 vCenterView;
void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPos.xyz;
  vCenterView = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  gl_Position = projectionMatrix * mvPos;
  #include <logdepthbuf_vertex>
}
`;

const CORONA_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uSeed;
uniform float uRadius;
uniform float uExtent;
uniform float uOpacity;
uniform float uEclipse;
uniform float uExtinction;
uniform float uCloseFactor;
uniform float uGain;
uniform float uFar;
uniform vec3 uCoronaColor;
uniform vec3 uChromoColor;
uniform vec3 uFlareColor;
varying vec3 vViewPos;
varying vec3 vCenterView;

float cHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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
  // Impact parameter of this view ray against the star centre, in radii.
  vec3 dir = normalize(vViewPos);
  float along = dot(vCenterView, dir);
  if (along <= 0.0) discard;
  vec3 offset = dir * along - vCenterView;
  float b = max(length(offset) / uRadius, 1.0);
  float h = b - 1.0;

  // Analytic line-of-sight corona: a thin chromospheric skin hugging the
  // limb, a bright K-corona that falls steeply, and a faint wide F-corona.
  float closeCalm = 1.0 - 0.55 * uCloseFactor;
  float chromo = exp(-h * 38.0);
  float inner = pow(b, -9.0);
  float mid = pow(b, -4.0);
  float outer = pow(b, -2.0);

  // Long soft streamers: periodic in angle, slowly stretched outward.
  vec2 o2 = offset.xy / max(length(offset.xy), 1e-6);
  float lb = log(b);
  float s1 = cNoise(o2 * 3.2 + vec2(uSeed * 1.3, lb * 0.9 - uTime * 0.006));
  float s2 = cNoise(o2 * 7.5 + vec2(-uSeed * 0.7, lb * 1.6 - uTime * 0.011));
  float streamers = 0.55 + 0.9 * pow(clamp(s1 * 0.65 + s2 * 0.35, 0.0, 1.0), 1.7);

  float edge = 1.0 - smoothstep(uExtent * 0.45, uExtent, b);
  float corona = (inner * 0.70 + mid * 0.06 * streamers * closeCalm + outer * 0.006 * closeCalm) * edge;
  // Far away the disc is a few pixels: a lens glare keeps it radiant.
  corona += uFar * (0.30 * pow(b, -3.0) * (0.8 + 0.4 * streamers) + 0.02 * outer) * edge;

  // Restrained anamorphic streak (screen-horizontal), quiet when close.
  vec2 s = offset.xy / uRadius;
  float streakY = exp(-abs(s.y) * 9.0);
  float streakX = exp(-abs(s.x) * 0.55) * (1.0 - smoothstep(uExtent * 0.5, uExtent, abs(s.x)));
  float anamorphic = streakY * streakX * 0.035 * (1.0 + 2.0 * uFar) * (1.0 - 0.85 * uCloseFactor) * smoothstep(1.0, 1.6, b);

  vec3 cCol = mix(uCoronaColor, vec3(1.0, 0.45, 0.18), uExtinction * 0.8);
  vec3 hCol = mix(uChromoColor, vec3(1.0, 0.35, 0.10), uExtinction * 0.8);
  vec3 fCol = mix(uFlareColor, vec3(1.0, 0.52, 0.24), uExtinction * 0.8);

  float vis = uOpacity * clamp(uEclipse, 0.0, 1.0) * (1.0 - 0.72 * uExtinction);
  vec3 outCol = (cCol * corona + hCol * chromo * 0.35 + fCol * anamorphic) * uGain * vis;
  float oLum = dot(outCol, vec3(0.2126, 0.7152, 0.0722));
  outCol = max(mix(vec3(oLum), outCol, 1.3), 0.0);
  gl_FragColor = vec4(outCol, 1.0);
  #include <logdepthbuf_fragment>
}
`;

// Artistic photosphere palettes anchored on effective temperature (sRGB hex).
// Interpolated in log-temperature so neighbouring spectral types blend.
const PALETTE = [
  { k: 2800, core: 0xffa868, mid: 0xff5f18, dark: 0x7a1503, chromo: 0xff3a14, corona: 0xff7a3c, flare: 0xffa070, prom: 0xff3c18 },
  { k: 4300, core: 0xffc888, mid: 0xff7418, dark: 0x8a2004, chromo: 0xff4a18, corona: 0xffa85a, flare: 0xffd0a0, prom: 0xff4a1c },
  { k: 5800, core: 0xffdc98, mid: 0xff9424, dark: 0xa02a06, chromo: 0xff5520, corona: 0xffd394, flare: 0xfff0d8, prom: 0xff5a26 },
  { k: 6900, core: 0xfffaf2, mid: 0xffd68e, dark: 0xb86a2c, chromo: 0xff6a3a, corona: 0xffe9c6, flare: 0xfff6ea, prom: 0xff6e44 },
  { k: 9500, core: 0xf6f9ff, mid: 0xcfdfff, dark: 0x5f7fc4, chromo: 0xff8aa8, corona: 0xdbe8ff, flare: 0xeef4ff, prom: 0xff7f9c },
  { k: 20000, core: 0xeef4ff, mid: 0xa9c3ff, dark: 0x3756b4, chromo: 0x9fb8ff, corona: 0xb6ceff, flare: 0xdce8ff, prom: 0xa0b8ff },
  { k: 40000, core: 0xe9f0ff, mid: 0x94b2ff, dark: 0x2945a4, chromo: 0x8aa8ff, corona: 0xa4c0ff, flare: 0xd2e2ff, prom: 0x8eaaff },
];

function paletteAt(temperatureK) {
  const t = Math.log(Math.max(2000, temperatureK || 5780));
  let lo = PALETTE[0];
  let hi = PALETTE[PALETTE.length - 1];
  for (let i = 0; i < PALETTE.length - 1; i++) {
    if (temperatureK <= PALETTE[i + 1].k) { lo = PALETTE[i]; hi = PALETTE[i + 1]; break; }
  }
  const span = Math.log(hi.k) - Math.log(lo.k);
  const f = span > 0 ? THREE.MathUtils.clamp((t - Math.log(lo.k)) / span, 0, 1) : 0;
  const out = {};
  for (const key of ['core', 'mid', 'dark', 'chromo', 'corona', 'flare', 'prom']) {
    out[key] = new THREE.Color(lo[key]).lerp(new THREE.Color(hi[key]), f);
  }
  return out;
}

function spectralProfile(spec, referenceK) {
  const base = new THREE.Color().fromArray(adaptedStellarRgb(spec.temperatureK, referenceK));
  const cls = (spec.spectralClass || 'G')[0];
  const pal = paletteAt(spec.temperatureK || 5780);

  // Convective envelopes: cool stars carry large, high-contrast cells; hot
  // radiative envelopes show only faint, fine mottling.
  let granuleScale = 110;
  let granuleAmp = 1.0;
  let spotStrength = 0.9;
  let spotDensity = 0.16;
  let limbU = [0.60, 0.80, 0.94];
  let intensity = 1.05;
  if (cls === 'M') {
    granuleScale = 72; spotStrength = 1.0; spotDensity = 0.22; limbU = [0.56, 0.80, 0.92];
  } else if (cls === 'K') {
    granuleScale = 90; spotDensity = 0.19; limbU = [0.54, 0.74, 0.90];
  } else if (cls === 'F') {
    granuleScale = 120; granuleAmp = 0.85; spotStrength = 0.6; spotDensity = 0.10; limbU = [0.46, 0.60, 0.74];
  } else if (cls === 'A') {
    granuleScale = 135; granuleAmp = 0.5; spotStrength = 0.25; spotDensity = 0.06; limbU = [0.42, 0.50, 0.58]; intensity = 1.1;
  } else if (cls === 'B' || cls === 'O') {
    granuleScale = 150; granuleAmp = 0.38; spotStrength = 0.12; spotDensity = 0.05; limbU = [0.40, 0.44, 0.50]; intensity = 1.15;
  } else if (cls === 'D') {
    granuleScale = 170; granuleAmp = 0.3; spotStrength = 0.0; spotDensity = 0.0; limbU = [0.40, 0.44, 0.50]; intensity = 1.2;
  }

  return {
    base,
    coreColor: pal.core,
    midColor: pal.mid,
    darkColor: pal.dark,
    chromoColor: pal.chromo,
    coronaColor: pal.corona,
    flareColor: pal.flare,
    promColor: pal.prom,
    granuleScale,
    granuleAmp,
    spotStrength,
    spotDensity,
    limbU: new THREE.Vector3(...limbU),
    intensity,
  };
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

    // Two crossed ribbons per arch keep volume from every viewing angle.
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

const CORONA_EXTENT = 9;

export function createStarVisual({ spec, referenceK, positionUniv, seed = '' }) {
  const R = spec.radiusRender;
  const seedKey = `${seed}:${spec.starId || spec.displayName || 'star'}`;
  const seedHash = strHash32(seedKey);
  const seedFloat = (seedHash % 10000) / 100;
  const seedRand = makeRng(`${seedKey}:photosphere:v2`);
  const seedOff = new THREE.Vector3(seedRand() * 61, seedRand() * 61, seedRand() * 61);
  const profile = spectralProfile(spec, referenceK);

  const group = new THREE.Group();
  group.name = `star-${spec.starId || '0'}`;

  // 1. Photosphere sphere
  const photosphereGeo = new THREE.SphereGeometry(R, 128, 96);
  const photosphereMat = new THREE.ShaderMaterial({
    vertexShader: PHOTOSPHERE_VERT,
    fragmentShader: PHOTOSPHERE_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSeedOff: { value: seedOff },
      uSpotStrength: { value: profile.spotStrength },
      uSpotDensity: { value: profile.spotDensity },
      uGranuleScale: { value: profile.granuleScale },
      uGranuleAmp: { value: profile.granuleAmp },
      uIntensity: { value: profile.intensity },
      uExtinction: { value: 0 },
      uCoreColor: { value: profile.coreColor.clone() },
      uMidColor: { value: profile.midColor.clone() },
      uDarkColor: { value: profile.darkColor.clone() },
      uLimbU: { value: profile.limbU.clone() },
    },
    fog: false,
    toneMapped: true,
  });
  const mesh = new THREE.Mesh(photosphereGeo, photosphereMat);
  mesh.name = 'star-photosphere';
  group.add(mesh);

  // 2. Solar prominence magnetic arches
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
      uRimColor: { value: profile.promColor.clone() },
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

  // 3. Analytic corona + anamorphic streak on a BackSide sphere: back faces
  // cover every view ray that passes near the star, from outside or inside.
  const coronaGeo = new THREE.SphereGeometry(1, 48, 32);
  const coronaMat = new THREE.ShaderMaterial({
    vertexShader: CORONA_VERT,
    fragmentShader: CORONA_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seedFloat },
      uRadius: { value: R },
      uExtent: { value: CORONA_EXTENT },
      uOpacity: { value: 1 },
      uEclipse: { value: 1 },
      uExtinction: { value: 0 },
      uCloseFactor: { value: 0 },
      uGain: { value: 1 },
      uFar: { value: 0 },
      uCoronaColor: { value: profile.coronaColor.clone() },
      uChromoColor: { value: profile.chromoColor.clone() },
      uFlareColor: { value: profile.flareColor.clone() },
    },
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: true,
  });
  const glow = new THREE.Mesh(coronaGeo, coronaMat);
  glow.name = 'star-corona';
  glow.scale.setScalar(R * CORONA_EXTENT);
  glow.frustumCulled = false;
  group.add(glow);

  const light = new THREE.PointLight(profile.base, 3.2, 0, 0);

  return {
    spec,
    group,
    mesh,
    glow,
    prominences,
    light,
    baseColor: profile.base.clone().multiplyScalar(4),
    glowBase: profile.coronaColor.clone(),
    glowExt: 1,
    eclipseVis: 1,
    positionUniv: positionUniv.clone(),

    setExtinction(x) {
      this.glowExt = 1 - 0.72 * x;
      photosphereMat.uniforms.uExtinction.value = x;
      promMat.uniforms.uExtinction.value = x;
      coronaMat.uniforms.uExtinction.value = x;
    },

    update(timeSec, systemFade = 1, eclipseVisibility = 1) {
      photosphereMat.uniforms.uTime.value = timeSec;
      promMat.uniforms.uTime.value = timeSec;
      coronaMat.uniforms.uTime.value = timeSec;

      const dist = group.position.length();
      const ratio = dist / Math.max(R, 1);
      // Close-up factor calms the wide corona and streak when skimming.
      const closeFactor = 1 - THREE.MathUtils.smoothstep(ratio, 1.8, 7.5);
      // Far away the disc shrinks to a few pixels; widen and lift the halo
      // so the star still reads as a radiant jewel instead of a dot.
      const farFactor = THREE.MathUtils.smoothstep(ratio, 8, 120);
      const extent = CORONA_EXTENT * (1 + 1.6 * farFactor);
      coronaMat.uniforms.uCloseFactor.value = closeFactor;
      coronaMat.uniforms.uExtent.value = extent;
      coronaMat.uniforms.uGain.value = 1;
      coronaMat.uniforms.uFar.value = farFactor;
      coronaMat.uniforms.uOpacity.value = systemFade;
      coronaMat.uniforms.uEclipse.value = eclipseVisibility;
      glow.scale.setScalar(R * extent);
      promMat.uniforms.uOpacity.value = systemFade;
      this.eclipseVis = eclipseVisibility;
    },

    dispose() {
      photosphereGeo.dispose();
      photosphereMat.dispose();
      promGeo.dispose();
      promMat.dispose();
      coronaGeo.dispose();
      coronaMat.dispose();
    },
  };
}
