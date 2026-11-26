// Lite volumetric clouds: one low-resolution ray march of a spherical cloud
// shell, composited over the lit scene after the atmosphere pass.
//
// It replaces the legacy production cloud stack (light banks, column tiles,
// far/near split programs) as the default. The whole feature is this pass and
// a 64^3 noise volume: no baking, no per-planet GPU caches, no warm-up.
//
// Per frame it draws three things:
//   1. a sun-aligned cloud shadow map (transmittance of the whole cloud column),
//   2. the low-resolution march: cumulus shell + cirrus sheet + the sunlight
//      that cloud shadows remove from the air below (light shafts),
//   3. a full-resolution composite that also shades opaque surfaces with (1).
//
// Inputs it shares with the rest of the frame, so every consumer agrees:
//   - planet.cloudShadowTex: the weather coverage atlas (same uCloudMat spin
//     the terrain and water use).
//   - AtmospherePass uniforms: camera/planet frame, suns, optical-depth LUT.
// Units are metres in the planet-local frame.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../../vendor/jsm/postprocessing/Pass.js';
import { atmosphereTransportGLSL, atmosphereUniformGLSL } from '../atmosphere-transport-glsl.js';
import { RING_SHADOW_GLSL, ringShadowUniforms, bindRingShadow } from '../rings.js';
import { weatherAtlasGLSL, sampleWeatherAtlas } from './weather-atlas.js';
import { liteCloudNoiseTexture } from './lite-cloud-noise.js';

function fract(value) { return value - Math.floor(value); }
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function sampleLiteNoiseB(noiseTex, u, v, w) {
  const data = noiseTex?.image?.data;
  const N = noiseTex?.image?.width || 0;
  if (!data || !N) return 0.5;
  const x = u * N - 0.5, y = v * N - 0.5, z = w * N - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const x0 = ((ix % N) + N) % N, x1 = (x0 + 1) % N;
  const y0 = ((iy % N) + N) % N, y1 = (y0 + 1) % N;
  const z0 = ((iz % N) + N) % N, z1 = (z0 + 1) % N;
  const at = (i, j, k) => data[((k * N + j) * N + i) * 4 + 2] / 255;
  const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
  const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
  const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
  const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
  const c0 = c00 * (1 - fy) + c10 * fy;
  const c1 = c01 * (1 - fy) + c11 * fy;
  return c0 * (1 - fz) + c1 * fz;
}

const SHADOW_SIZE = 1024;
// Depth of the cumulus layer. The deck fills under half of it; towers use the rest.
const LAYER_DEPTH = 11000;
// Game hours for one form-and-dissolve cycle of the cloud fields (calm, natural pace).
const EVOLVE_HOURS = 14;
const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _sun = new THREE.Vector3();
const _rotation = new THREE.Matrix3();
const _ground = new THREE.Vector3();

// Quarter-texel offsets of the march grid; each lands on one pixel of the 2x history.
const SUBPIXEL_CYCLE = [[-0.25, -0.25], [0.25, 0.25], [0.25, -0.25], [-0.25, 0.25]];

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The cloud field: coverage and density. Shared by the view march and the
// shadow map so a cloud and its shadow are the same object.
const cloudFieldGLSL = /* glsl */`
  precision highp sampler3D;
  uniform sampler3D uNoise;
  uniform sampler2D uCloudTex;
  uniform mat3 uCloudMat;
  uniform sampler2D uSurfaceTex;
  uniform float uSynoptic, uShellBase, uShellTop, uShellDepth, uSurfaceRange, uLiftBase, uLiftOn, uLiftMax, uSharp, uHaze, uBillow, uLightLod, uEvolve, uWarp;
  ${weatherAtlasGLSL}

  float sat(float x) { return clamp(x, 0.0, 1.0); }
  // Two copies of a noise field at unrelated offsets, cross-faded in turn:
  // each is frozen while visible and re-seeded while its weight is zero, so
  // the pattern grows and dissolves in place instead of sliding. Returns the
  // weight of the first copy; the offsets are noise-space translations.
  float evolvePhase(float cycles, out vec3 offsetA, out vec3 offsetB) {
    offsetA = fract(vec3(0.731, 0.317, 0.547) * floor(cycles));
    offsetB = fract(vec3(0.413, 0.871, 0.229) * floor(cycles + 0.5)) + 0.5;
    float w = 1.0 - abs(2.0 * fract(cycles) - 1.0);
    // Smoothstep dwell near 0 and 1 keeps single-field contrast steady without
    // rhythmic linear triangle-wave softening.
    return w * w * (3.0 - 2.0 * w);
  }
  float evolveBlend(float a, float b, float w) {
    // Keep the contrast a single field has.
    return 0.5 + (a * w + b * (1.0 - w) - 0.5) / sqrt(w * w + (1.0 - w) * (1.0 - w));
  }
  float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

  // Cancellation-safe sphere intersection: h = (r-|d|)(r+|d|). The textbook
  // b*b-c form loses hundreds of metres at grazing angles on a 1e6 m body.
  vec2 shellHits(vec3 origin, vec3 direction, float radius) {
    float b = dot(origin, direction);
    float ld = length(origin - b * direction);
    float h = (radius - ld) * (radius + ld);
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  float liftAt(vec3 p) {
    if (uLiftOn <= 0.5) return 0.0;
    float surface = (weatherAtlasSample(uSurfaceTex, p).g * 2.0 - 1.0) * uSurfaceRange;
    return min(max(surface + 500.0 - uLiftBase, 0.0) * 0.85, uLiftMax);
  }

  // Synoptic coverage from the shared weather atlas, with a mid-scale breakup
  // so the 256-texel atlas does not draw straight, blurry weather borders.
  // Returns (coverage, lift). Lift raises the local cloud base over high
  // ground (the weather system's regionally smoothed surface altitude), so
  // the layer rides over mountain ranges instead of slicing through them.
  vec2 weatherAt(vec3 p) {
    vec3 q = uCloudMat * p;
    float c = weatherAtlasSample(uCloudTex, q).r;
    // A weather system does not end at a wall. The synoptic mask is widened
    // into a long margin and the breakup noise eats into it, so a deck thins
    // into scattered cumulus before the sky clears.
    if (uSynoptic > 0.5) c = synopticCoverage(c, 0.42);
    vec3 oa, ob;
    float wa = evolvePhase(uEvolve, oa, ob);
    float breakup = evolveBlend(textureLod(uNoise, q / 93000.0 + oa, 0.0).b,
      textureLod(uNoise, q / 93000.0 + ob, 0.0).b, wa);
    c = sat(c * 1.15 + (breakup - 0.5) * 0.8 * (1.0 - 0.6 * c) - 0.07);
    // Mesoscale regimes inside a weather system: closed decks with cracks
    // alternate with broken, open-cell fields instead of one uniform texture.
    float regime = textureLod(uNoise, q.yzx / 310000.0 + 0.61, 0.0).b;
    return vec2(c * mix(0.42, 0.95, smoothstep(0.34, 0.66, regime)), liftAt(p));
  }

  // Distance fades set by the view march. A step grows with distance, so
  // octaves smaller than the step are faded out instead of being sampled as
  // noise: gFarSmall drops the 2-3 km cumulus, gFarWide the 9 km cells.
  float gFarSmall = 0.0, gFarWide = 0.0;
  // Metres one sample stands for (transverse march texel at the sample's
  // distance, or shadow-map texel) and along-ray step filter width. Every noise
  // octave is read at the mip matching the larger of the two, calibrated to the
  // noise volume's real feature bandwidth (~26 texels/cycle) so mid-altitude and
  // orbital clouds stay crisp while distant/large-step samples never alias.
  float gFootprint = 0.0;
  float gStepFilter = 0.0;
  // Footprint that decides when cells merge into sheets. Unlike gFootprint it
  // does not shrink with resolution: the same distance looks the same at 2K.
  float gSheet = 0.0;
  float noiseLod(float period) { return log2(max(max(gFootprint, gStepFilter) * 32.0 / period, 1.0)); }
  // Height of the last sampled column's cloud top within the layer (0..1).
  float gCrown = 0.0;

  // lod 0: light march / shadow / far field. 1: view march. 2: near camera.
  // Noise-space position of a point in the layer.
  vec3 cloudSpace(vec3 p) {
    vec3 q = uCloudMat * p;
    // The cell noise tiles: unwarped, a whole hemisphere showed the same
    // evenly spaced puffs and pores. A slow, large displacement stretches
    // cells into lines here and packs or opens them there.
    // Horizontal only: a vertical component leans every cloud over.
    vec3 warp = textureLod(uNoise, q / 240000.0 + 0.13, 0.0).rgb - 0.5;
    vec3 up = q / length(q);
    return q + (warp - up * dot(warp, up)) * uWarp;
  }
  float topBase(float thick) { return mix(0.21, 0.46, smoothstep(0.3, 0.72, thick)); }
  float towerTop(float wide, float thick) { return 0.52 * smoothstep(0.55, 0.8, wide) * smoothstep(0.4, 0.74, thick); }
  // Radius above which no cloud can be here: cloudDensity's top with every
  // per-cell factor at its largest. Only the slow fields are read.
  float cloudCeiling(vec3 p, float lift) {
    vec3 q = cloudSpace(p);
    float wide = textureLod(uNoise, q.yzx / 63000.0 + 0.5, noiseLod(63000.0)).r;
    float thick = textureLod(uNoise, q.zxy / 149000.0 + 0.37, noiseLod(149000.0)).b;
    return uShellBase + lift + (topBase(thick) + towerTop(wide, thick)) * uShellDepth;
  }
  float cloudDensity(vec3 p, float cover, int lod, float near, float lift) {
    float h = (length(p) - uShellBase - lift) / uShellDepth;
    if (h < 0.0 || h > 1.0) return 0.0;
    float cov = cover * 0.86;                       // never fully closed: the deck keeps its pores
    if (cov < 0.02) return 0.0;
    vec3 q = cloudSpace(p);
    // Worley-led closed cells: values fall along cell walls, which opens a
    // natural pore network instead of blocky cut-outs.
    float base = textureLod(uNoise, q / 27000.0, noiseLod(27000.0)).r;
    float wide = textureLod(uNoise, q.yzx / 63000.0 + 0.5, noiseLod(63000.0)).r;
    float thick = textureLod(uNoise, q.zxy / 149000.0 + 0.37, noiseLod(149000.0)).b;
    float fine = lod > 0 ? 1.0 - gFarSmall : 0.0;
    float small = 0.5;
    if (lod > 0) {
      // Break every ~9 km cell into 2-3 km cumulus. Seen from the ground a
      // sky needs many small clouds receding to the horizon; a few huge
      // blobs overhead read as a ceiling.
      // Single cumulus live and die moderately faster than synoptic fields.
      vec3 sa, sb;
      float sw = evolvePhase(uEvolve * 1.5 + 0.3, sa, sb);
      small = evolveBlend(textureLod(uNoise, q.zxy / 8300.0 + 0.29 + sa, noiseLod(8300.0)).r,
        textureLod(uNoise, q.zxy / 8300.0 + 0.29 + sb, noiseLod(8300.0)).r, sw);
      float nearField = base * 0.46 + wide * 0.2 + small * 0.34;
      float midField = base * 0.7 + wide * 0.3;
      base = mix(mix(midField, nearField, fine), base * 0.35 + wide * 0.65, gFarWide);
    } else base = base * 0.35 + wide * 0.65;
    // From far enough that a cell is a few pixels, single clouds are not
    // seen at all: the fields read as continuous sheets shaped by the
    // weather, and break into cells as the camera comes closer.
    base = mix(base, 0.6, smoothstep(1700.0, 4800.0, gSheet));
    base = sat((base - 0.22) / 0.6);
    // Cumulus profile: flat base, cloud-top height driven by the slow
    // thickness field and by each cell (cell cores tower upward).
    float top = topBase(thick) * mix(0.5, 1.0, base * base);
    // Convective towers: where the wide cells and the thickness field agree,
    // a cumulus grows through the rest of the deck (cumulus congestus).
    // The layer is deeper than the deck needs: the upper half belongs to
    // the towers alone, which stand kilometres clear of everything else.
    top += towerTop(wide, thick) * smoothstep(0.35, 0.7, base);
    // Every small cumulus is its own dome and carries finer bumps: seen from
    // above the deck is a relief of lit tops and shaded gaps, not a flat sheet.
    if (fine > 0.0) top *= 1.0 - fine * (0.22 * (1.0 - small) + 0.12 * (1.0 - textureLod(uNoise, q / 7300.0, noiseLod(7300.0)).g));
    gCrown = top;
    float stepSoft = smoothstep(130.0, 620.0, gStepFilter);
    float baseRamp = mix(0.05, 0.16, stepSoft);
    float profile = smoothstep(0.0, baseRamp, h) * smoothstep(top, top * mix(0.45, 0.74, fine), h);   // crisp tops up close
    float d = sat(remap(base * profile, 1.0 - cov, 1.0, 0.0, 1.0));
    if (d <= 0.0) return 0.0;
    if (fine > 0.0) {
      // Erode only where the cloud is already thin; cores stay solid.
      float e = (1.0 - textureLod(uNoise, q / 7300.0, noiseLod(7300.0)).g) * 0.34 * (1.0 - d);
      if (lod > 1) {
        e += (1.0 - textureLod(uNoise, q.zxy / 1900.0 + 0.13, noiseLod(1900.0)).g) * 0.26 * near * (1.0 - d);
        // Cauliflower: sub-kilometre billows carved into the rim up close.
        e += (1.0 - textureLod(uNoise, q.yzx / 640.0 + 0.71, noiseLod(640.0)).g) * uBillow * near * near * (1.0 - d);
      }
      e = min(e * fine, 0.9);
      d = sat((d - e) / (1.0 - e));
    }
    // Separate transverse (orbital) and along-ray (grazing step) bandlimiting:
    // orbital top-down clouds stay sharp while long horizon steps stay smooth
    // and stipple-free with low Monte-Carlo variance.
    float sharpFootprint = mix(uSharp, 2.2, smoothstep(250.0, 2400.0, gFootprint));
    float sharpStep = mix(uSharp, 1.38, stepSoft);
    float sharp = min(sharpFootprint, sharpStep);
    float haze = uHaze * (sharp - 1.0) / max(uSharp - 1.0, 1e-3);
    return pow(sat((d - haze) * sharp), 1.15) * cov * 1.3;
  }`;

const shadowLookupGLSL = /* glsl */`
  uniform sampler2D tShadow;
  uniform vec3 uShadowX, uShadowY;
  uniform vec2 uShadowCenter;
  uniform float uShadowExtent, uShadowOn;
  // Transmittance of the cloud column between a point below the clouds and the sun.
  // Explicit level-0 lookup keeps non-uniform ray-march loops free of derivative spikes.
  float cloudShadowAt(vec3 p) {
    vec2 uv = (vec2(dot(p, uShadowX), dot(p, uShadowY)) - uShadowCenter) / uShadowExtent * 0.5 + 0.5;
    vec2 edge = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
    return mix(1.0, textureLod(tShadow, uv, 0.0).r, edge.x * edge.y);
  }
  // Surface shadow lookup filtered over the screen pixel's oblique ground ellipse.
  // From ~50 km altitude, distant ground pixels span several shadow-map texels along
  // the view ray; unfiltered level-0 lookups shimmered across scanlines in flight.
  float cloudSurfaceShadowAt(vec3 p, vec3 up, vec3 rd, float distance, float pixelAngle) {
    vec2 uv = (vec2(dot(p, uShadowX), dot(p, uShadowY)) - uShadowCenter) / uShadowExtent * 0.5 + 0.5;
    vec2 edge = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
    float shadowTexel = uShadowExtent / 512.0;
    float crossWidth = distance * pixelAngle;
    float ndotv = max(abs(dot(rd, up)), 0.06);
    vec3 tangent = rd - up * dot(rd, up);
    float tLen = length(tangent);
    vec3 majorDir = tLen > 1e-5 ? tangent / tLen : uShadowX;
    vec2 majorSpanUv = vec2(dot(majorDir, uShadowX), dot(majorDir, uShadowY)) * ((crossWidth / ndotv) / (2.0 * uShadowExtent));
    float minorTexels = crossWidth / shadowTexel;
    float majorTexels = length(majorSpanUv) * 1024.0;
    float lod = log2(max(max(minorTexels, majorTexels * 0.5), 1.0));
    vec2 stepUv = majorSpanUv * 0.25;
    float s = 0.5 * (textureLod(tShadow, uv - stepUv, lod).r + textureLod(tShadow, uv + stepUv, lod).r);
    return mix(1.0, s, edge.x * edge.y);
  }
  // Optical depth between a point inside the layer and the sun, from the same
  // map: the ray's total, taken up linearly between where its cloud begins
  // and ends. Coarse, but it reaches as far as the map does, so a tower
  // shades the deck tens of kilometres down-sun; the short light march in
  // the view pass only knows the nearest few kilometres.
  float cloudCastTau(vec3 p, vec3 sun) {
    vec2 uv = (vec2(dot(p, uShadowX), dot(p, uShadowY)) - uShadowCenter) / uShadowExtent * 0.5 + 0.5;
    vec2 edge = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
    vec3 map = textureLod(tShadow, uv, 0.0).rgb;
    if (map.r > 0.985) return 0.0;
    float along = dot(p, sun);
    vec3 origin = p - sun * along;
    vec2 top = shellHits(origin, sun, uShellTop), base = shellHits(origin, sun, uShellBase);
    float s0 = base.y > base.x ? base.y : top.x, s1 = top.y;
    float depth = sat((s1 - along) / max(s1 - s0, 1.0));
    // One map step of bias keeps a sunlit top out of its own shadow.
    float taken = sat((depth - map.g - 0.07) / max(map.b - map.g, 0.15));
    return -log(max(map.r, 0.004)) * taken * edge.x * edge.y;
  }`;

// One texel = one sun ray. The map lives on the plane through the planet
// centre perpendicular to the sun, so any point along a ray shares its texel.
const shadowShader = /* glsl */`
  precision highp float;
  ${cloudFieldGLSL}
  uniform vec3 uSunDirection0, uShadowX, uShadowY;
  uniform vec2 uShadowCenter;
  uniform float uShadowExtent, uExtinction;
  varying vec2 vUv;
  void main() {
    vec3 sun = normalize(uSunDirection0);
    // Unlike the 2x temporally upsampled view march, the shadow map is drawn
    // in a single pass: bandlimit density contrast to ~2 texels so sub-texel
    // rims do not stair-step or shimmer as clouds and sun move.
    float texel = uShadowExtent / 512.0;
    gFootprint = texel * 2.2;
    gStepFilter = 0.0;
    gSheet = texel;
    gFarSmall = smoothstep(350.0, 1200.0, texel);
    gFarWide = smoothstep(2500.0, 8000.0, texel);
    vec2 xy = uShadowCenter + (vUv * 2.0 - 1.0) * uShadowExtent;
    vec3 origin = uShadowX * xy.x + uShadowY * xy.y;
    float transmittance = 1.0, front = 1.0, back = 1.0;
    vec2 top = shellHits(origin, sun, uShellTop);
    if (top.y > top.x) {
      vec2 base = shellHits(origin, sun, uShellBase);
      float s0 = base.y > base.x ? base.y : top.x, s1 = top.y;
      if (s1 > s0) {
        // Bound the march to the local lifted base and local cloud ceiling.
        // Marching 16 steps across the full [uShellBase, uShellTop] envelope
        // wasted most samples in empty tower/lift headroom and sliced low-sun
        // cumulus shadows into kilometres-apart flickering bands.
        float lift0 = liftAt(origin + sun * s0);
        float lift1 = liftAt(origin + sun * mix(s0, s1, 0.5));
        float rBase = uShellBase + max(min(lift0, lift1) - 150.0, 0.0);
        float rLiftTop = min(uShellTop, uShellBase + max(lift0, lift1) + uShellDepth);
        vec2 bHit = rBase > uShellBase ? shellHits(origin, sun, rBase) : base;
        vec2 lHit = rLiftTop < uShellTop ? shellHits(origin, sun, rLiftTop) : top;
        float m0 = bHit.y > bHit.x ? bHit.y : lHit.x;
        float m1 = lHit.y > lHit.x ? lHit.y : s0;
        if (m1 > m0) {
          float m0Init = m0, mSpanInit = max(m1 - m0, 1.0);
          vec2 w0 = weatherAt(origin + sun * mix(m0, m1, 0.2));
          vec2 w1 = weatherAt(origin + sun * mix(m0, m1, 0.8));
          if (max(w0.x, w1.x) > 0.03) {
            float c0 = cloudCeiling(origin + sun * mix(m0, m1, 0.15), mix(w0.y, w1.y, 0.0));
            float c1 = cloudCeiling(origin + sun * mix(m0, m1, 0.50), mix(w0.y, w1.y, 0.5));
            float c2 = cloudCeiling(origin + sun * mix(m0, m1, 0.85), mix(w0.y, w1.y, 1.0));
            float rCeil = min(rLiftTop, max(max(c0, c1), c2) + 500.0);
            if (rCeil < rLiftTop) {
              vec2 cHit = shellHits(origin, sun, rCeil);
              if (cHit.y > cHit.x) {
                m0 = bHit.y > bHit.x ? bHit.y : cHit.x;
                m1 = cHit.y;
              } else m1 = m0;
            }
            if (m1 > m0) {
              float mSpan = m1 - m0, fullSpan = max(s1 - s0, 1.0);
              int steps = clamp(int(16.0 + mSpan / 1400.0), 16, 28);
              float ds = mSpan / float(steps), tau = 0.0;
              bool hit = false;
              float previous = 0.0, prevDepth = (s1 - m1) / fullSpan;
              gFootprint = texel * 2.2;
              gStepFilter = ds * 0.45;
              for (int i = 0; i < 28; i++) {
                if (i >= steps) break;
                float s = m1 - (float(i) + 0.5) * ds;
                float uw = sat(((s - m0Init) / mSpanInit - 0.2) / 0.6);
                float currDepth = (s1 - s) / fullSpan;
                float density = cloudDensity(origin + sun * s, mix(w0.x, w1.x, uw), 1, 0.0, mix(w0.y, w1.y, uw));
                if (density > 0.002) {
                  if (!hit) {
                    float frac = sat((0.002 - previous) / max(density - previous, 1e-4));
                    front = mix(prevDepth, currDepth, frac);
                    hit = true;
                  }
                  back = (s1 - (s - 0.5 * ds)) / fullSpan;
                } else if (hit && previous > 0.002) {
                  float frac = sat((previous - 0.002) / max(previous - density, 1e-4));
                  back = mix(prevDepth, currDepth, frac);
                }
                previous = density;
                prevDepth = currDepth;
                tau += density * ds;
              }
              transmittance = exp(-tau * uExtinction);
            }
          }
        }
      }
    }
    gl_FragColor = vec4(transmittance, front, back, 1.0);
  }`;

const marchShader = /* glsl */`
  precision highp float;
  #define VIEW_STEPS 8
  uniform sampler2D tSceneDepth;
  uniform float uFrame, uExtinction, uScatterGain, uShaftStrength, uAltocumulus, uPixelAngle, uSheetAngle, uCloudCast;
  uniform vec3 uCloudTint;
  uniform vec2 uSubpixel, uMarchTexel;
  ${atmosphereUniformGLSL}
  varying vec2 vUv;
  layout(location = 1) out highp vec4 gAux;
  layout(location = 2) out highp vec4 gShaft;
  ${atmosphereTransportGLSL}
  ${RING_SHADOW_GLSL}
  ${cloudFieldGLSL}
  ${shadowLookupGLSL}

  float hgPhase(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  }

  // Direct sunlight reaching a point above the ground, through the shared
  // optical-depth LUT (alpha = fraction of the solar path clear of the planet)
  // and planetary ring shadow transmission.
  vec3 sunAt(vec3 p, vec3 sunDirection) {
    float r = length(p);
    float altitude = clamp(r - uGroundR, 0.0, uTopAltitude);
    vec4 depth = sunlightOpticalDepth(altitude, dot(p / r, sunDirection));
    vec3 tau = (uBetaRayleigh * depth.r * uRayleighScaleHeight
      + uBetaMieExtinction * depth.g * uMieScaleHeight
      + uBetaOzone * depth.b * uOzoneHalfWidth) * uDensityScale;
    return exp(-min(tau, vec3(50.0))) * depth.a * ringShadowTransmission(p, sunDirection);
  }

  void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    gAux = vec4(6e4, 6e4, 0.0, 1.0);
    gShaft = vec4(0.0);
    // The whole low-res grid shifts by a quarter texel each frame (2x2 cycle):
    // its samples land on the four quadrants of the history grid.
    vec2 rayUv = vUv + uSubpixel * uMarchTexel;
    vec4 view = uInvProjection * vec4(rayUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
    vec3 rd = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
    vec3 ro = uCameraLocal;
    float r0 = length(ro);
    vec2 groundHit = shellHits(ro, rd, uGroundR - 3000.0);
    bool ground = groundHit.x > 0.0;
    vec3 sunDirection = normalize(uSunDirection0);
    vec3 irradiance = uSunColor0 * uSunEnergy0 * uRadianceScale;
    float mu = dot(rd, sunDirection);
    vec3 sunDirection1 = normalize(uSunDirection1);
    vec3 irradiance1 = uSunColor1 * uSunEnergy1 * uRadianceScale;
    float mu1 = dot(rd, sunDirection1);
    // Temporal step phase: 0.4045085 = (1 + phi^-1) / 4 so every 4-frame 2x2
    // quadrant update advances by the exact golden ratio (+0.618034) instead of
    // aliasing near 0.5 (4 * 0.618 = 2.472) and locking into a dot-grid.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.40450850);
    vec2 outer = shellHits(ro, rd, uShellTop), inner = shellHits(ro, rd, uShellBase);
    // A moon (or a close planet) between the star and this world: the same
    // occluder model the atmosphere pass uses, so cloud, air and ground
    // shadows stay concentric.
    bool eclipsing = uLocalOccluderCount > 0 || uEclipseEnabled >= 0.5;

    // ---- Light shafts. The atmosphere pass lit all the air as if the sky
    // were clear. Below the clouds, take back the primary sun's single
    // scattering wherever the air sits in a cloud shadow.
    float baseHere = uShellBase + weatherAt(ro).y;
    if (uShadowOn > 0.5 && r0 < baseHere) {
      float tMax = min(inner.y, 90000.0);
      float sceneDepth = texture2D(tSceneDepth, rayUv).x;
      if (sceneDepth < 0.999999) tMax = min(tMax, (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005));
      else if (ground) tMax = min(tMax, groundHit.x);
      vec3 loss = vec3(0.0), through = vec3(1.0);
      float previous = 0.0, phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu), phaseM = hgPhase(mu, clamp(uMieAsymmetry, -0.95, 0.95));
      float sj = fract(jitter + 0.37);
      for (int i = 0; i < 16; i++) {
        float x = (float(i) + sj) / 16.0;
        float t = tMax * x * x;                      // dense near the camera
        float dt = t - previous; previous = t;
        vec3 p = ro + rd * t;
        float altitude = max(length(p) - uGroundR, 0.0);
        float rayleigh = exp(-altitude / uRayleighScaleHeight) * uDensityScale;
        float mie = exp(-altitude / uMieScaleHeight) * uDensityScale;
        vec3 ext = uBetaRayleigh * rayleigh + uBetaMieExtinction * mie
          + uBetaOzone * ozoneDensity(altitude) * uDensityScale;
        vec3 source = (uBetaRayleigh * rayleigh * phaseR + uBetaMieScatter * mie * phaseM) * sunAt(p, sunDirection) * irradiance;
        loss += through * source * (1.0 - cloudShadowAt(p)) * mediumIntegral(ext, dt);
        through *= exp(-ext * dt);
      }
      if (eclipsing) loss *= eclipseVisibility(ro, sunDirection);
      gShaft = vec4(loss * uShaftStrength * smoothstep(baseHere, baseHere - 700.0, r0), 1.0);
    }

    // ---- High cirrus & altocumulus: thin ice storey above the cumulus layer.
    // Footprint divides by slant so oblique rays toward the horizon mip-filter
    // cleanly instead of aliasing into shimmering horizontal barcode stripes.
    float cirrusRadius = uShellTop + uShellDepth * 0.41, cirrusT = -1.0, cirrusA = 0.0;
    vec3 cirrusL = vec3(0.0);
    bool cirrusFront = r0 >= cirrusRadius;
    vec2 cirrusHit = shellHits(ro, rd, cirrusRadius);
    if (cirrusFront) { if (cirrusHit.x > 0.0) cirrusT = cirrusHit.x; }
    else if (!ground) cirrusT = cirrusHit.y;
    if (cirrusT > 0.0) {
      vec3 p = ro + rd * cirrusT;
      vec3 q = uCloudMat * p;
      float slant = abs(dot(rd, p / length(p)));
      float cirrusFootprint = cirrusT * uPixelAngle / max(slant, 0.14);
      float patches = smoothstep(0.50, 0.82, textureLod(uNoise, q.zxy / 230000.0 + 0.2, 0.0).b);
      if (patches > 0.0) {
        vec3 cUp = q / length(q);
        // Divergence-free zonal wind vector: smooth everywhere with zero polar seam.
        vec3 zonal = vec3(-cUp.z, 0.0, cUp.x);
        float warpLod = log2(max(cirrusFootprint * 24.0 / 92000.0, 1.0));
        float warp = textureLod(uNoise, q / 92000.0, warpLod).b;
        float fibreLod = log2(max(cirrusFootprint * 26.0 / 34000.0, 1.0));
        // Wind-sheared feathery cirrus wisps: gentle large-scale meander plus a
        // 2-tap directional streak along planetary zonal flow (no marble swirls
        // and no Cartesian axis bias).
        vec3 baseF = q / 34000.0 + vec3(warp * 0.22, -warp * 0.12, warp * 0.18);
        float f0 = textureLod(uNoise, baseF, fibreLod).g;
        float f1 = textureLod(uNoise, baseF + zonal * 0.26, fibreLod).g;
        float f2 = textureLod(uNoise, (baseF + zonal * 0.13) * 2.15 + 0.4, fibreLod + 0.9).r;
        float fibre = (f0 + f1) * 0.31 + f2 * 0.38;
        fibre = mix(fibre, 0.42, smoothstep(65000.0, 220000.0, cirrusT));
        float cellular = smoothstep(0.46, 0.68, textureLod(uNoise, q.yzx / 160000.0 + 0.47, 0.0).b) * uAltocumulus;
        float cellLod = log2(max(cirrusFootprint * 26.0 / 11500.0, 1.0));
        // Gentle wind meander so altocumulus stays mackerel-sky puffs instead
        // of shearing into swirled ribbons.
        vec3 cq = q / 11500.0 + zonal * ((warp - 0.5) * 0.38) + (warp - 0.5) * 0.22;
        float cell = textureLod(uNoise, cq, cellLod).r * 0.78
          + textureLod(uNoise, cq * 1.65 + 0.31, cellLod + 0.9).g * 0.22;
        float puff = smoothstep(0.50, 0.78, cell);
        // Dissolve sub-pixel cells at grazing angles & long distance into a soft veil.
        float cellFade = max(smoothstep(95000.0, 260000.0, cirrusT), 1.0 - smoothstep(0.10, 0.34, slant));
        puff = mix(puff, 0.22, cellFade);
        float horizonFade = smoothstep(0.03, 0.22, slant);
        float a = mix(smoothstep(0.52, 0.86, fibre) * 0.28, puff * 0.48, cellular) * patches * horizonFade;
        float cellThick = cellular * smoothstep(0.62, 0.95, cell) * (1.0 - cellFade);
        cirrusA = 1.0 - pow(1.0 - sat(a), 1.0 / max(slant, 0.32));
        float day = smoothstep(-0.12, 0.12, dot(p / length(p), sunDirection));
        float ecl = eclipsing ? eclipseVisibility(p, sunDirection) : 1.0;
        day *= mix(0.3, 1.0, ecl);
        cirrusL = (irradiance * sunAt(p, sunDirection) * ecl * mix(hgPhase(mu, 0.72), 0.0796, 0.52) * uScatterGain * 0.92
          + irradiance1 * sunAt(p, sunDirection1) * (eclipsing ? eclipseVisibility(p, sunDirection1) : 1.0) * mix(hgPhase(mu1, 0.72), 0.0796, 0.52) * uScatterGain * 0.92
          + irradiance * vec3(0.045, 0.062, 0.095) * (0.25 + 0.75 * day)) * uCloudTint;
        if (!cirrusFront) cirrusL *= 1.0 - 0.42 * cellThick * (1.0 - smoothstep(0.7, 0.97, mu));
      }
    }

    // ---- Cumulus shell: interval for a camera above, inside or below it.
    float T = 1.0, weight = 0.0, weighted = 0.0, tFront = -1.0, tBack = 0.0;
    vec3 L = vec3(0.0);
    float t0 = -1.0, t1 = -1.0;
    if (r0 > uShellTop) { if (outer.y > 0.0) { t0 = max(outer.x, 0.0); t1 = inner.x > 0.0 ? inner.x : outer.y; } }
    else if (r0 > uShellBase) { t0 = 0.0; t1 = inner.x > 0.0 ? inner.x : outer.y; }
    else if (!ground) { t0 = inner.y; t1 = outer.y; }
    if (t1 > t0) {
      t1 = min(t1, t0 + 900000.0);
      float span = t1 - t0;
      vec2 weather = vec2(0.0), weatherA = vec2(0.0), weatherB = vec2(0.0);
      float tWeather = -1e9;
      vec3 sunNear = sunAt(ro + rd * t0, sunDirection);
      vec3 sunMid = sunAt(ro + rd * (t0 + span * 0.4), sunDirection);
      vec3 sunFar = sunAt(ro + rd * t1, sunDirection);
      // Long horizon & limb rays receive up to 2x steps, chosen purely by span.
      float reach = clamp(span / 55000.0, 1.0, 2.0);
      float baseSteps = float(MARCH_STEPS);
      #if MARCH_STEPS == 56
        baseSteps += 40.0 * smoothstep(10000.0, 40000.0, span);
      #endif
      int steps = int(baseSteps * reach);
      float dmin = max(min(min(44.0 + 0.0025 * t0, span / 80.0), 300.0), 20.0);
      float growth = max(0.048, 8.6 / float(steps));
      float dtCap = max(dmin, (1.42 + 0.34 * reach) * span / float(steps));
      float t = t0;
      float prevTs = t0;
      tBack = t0;
      vec3 entry = ro + rd * t0;
      float edgeOn = (1.0 - smoothstep(0.1, 0.42, abs(dot(rd, entry / length(entry))))) * smoothstep(45000.0, 170000.0, t0);
      bool wasEmpty = true;
      int subRemaining = 0;
      float subDt = 0.0;
      float prevD = 0.0;
      for (int i = 0; i < max(MARCH_STEPS, 96) * 2; i++) {
        if (i >= steps || t >= t1) break;
        float dt;
        if (subRemaining > 0) {
          dt = min(subDt, t1 - t);
        } else {
          dt = clamp(growth * (t - t0), dmin, dtCap);
          // Smooth C1 step contraction inside the sunlit outer skin of clouds
          // up to ~95 km so backlit ridges stay crisp and stipple-free while
          // thin wisps and deep shaded cores keep full horizon reach.
          float inCloudSkin = smoothstep(0.012, 0.10, prevD) * smoothstep(105000.0, 18000.0, t) * smoothstep(0.08, 0.45, T);
          dt *= mix(1.0, 0.34, inCloudSkin);
          dt = min(dt, t1 - t);
        }
        // Exact 1-step stratified sample inside [t, t + dt] using one ray-constant
        // jitter: consecutive samples stay strictly 1.00x..1.05x dt apart (zero
        // 2x gaps), and every distance near/mid/far spans 100% of its local step
        // (completely eliminating camera-locked concentric striping shells).
        float ts = t + dt * jitter;
        vec3 p = ro + rd * ts;
        if (ts - tWeather > 3500.0 || ts < tWeather) {
          if (ts - tWeather > 7000.0 || ts < tWeather) { tWeather = ts; weatherA = weatherAt(p); }
          else { tWeather += 3500.0; weatherA = weatherB; }
          weatherB = weatherAt(ro + rd * (tWeather + 3500.0));
        }
        weather = mix(weatherA, weatherB, sat((ts - tWeather) / 3500.0));
        float rp = length(p);
        float above = rp - (uShellBase + weather.y + uShellDepth);
        if (subRemaining == 0 && above > 200.0) {
          t += clamp(0.75 * above / max(-dot(rd, p / rp), 0.10), dt, 5000.0);
          prevTs = t;
          wasEmpty = true; prevD = 0.0;
          continue;
        }
        float cov = weather.x;
        // Skip quickly across genuinely clear synoptic zones.
        if (subRemaining == 0 && cov < 0.025 && max(weatherA.x, weatherB.x) < 0.025) {
          t += min(dt * 1.6, 2800.0);
          prevTs = t;
          wasEmpty = true; prevD = 0.0;
          continue;
        }
        float near = sat(1.0 - ts / 85000.0);
        gFootprint = ts * uPixelAngle;
        gSheet = ts * uSheetAngle;
        gStepFilter = dt * 0.44;
        // Conservative Lipschitz ceiling skip: clears empty tower headroom above
        // the deck from orbit without tunneling through nearby convective towers.
        if (wasEmpty && subRemaining == 0) {
          float over = rp - cloudCeiling(p, weather.y);
          if (over > 240.0) {
            t += clamp(0.75 * over / (max(-dot(rd, p / rp), 0.0) + 0.72), dt, min(4000.0, span * 0.04));
            prevTs = t;
            prevD = 0.0;
            continue;
          }
        }
        gFarSmall = max(smoothstep(450.0, 1400.0, dt), smoothstep(650.0, 1800.0, gFootprint));
        gFarWide = max(smoothstep(2400.0, 6000.0, dt), smoothstep(1400.0, 3200.0, gFootprint));
        gFarSmall = max(gFarSmall, edgeOn);
        gFarWide = max(gFarWide, edgeOn * 0.7);
        int sampleLod = near > 0.0 ? 2 : 1;
        float d = cov < 0.025 ? 0.0 : cloudDensity(p, cov, sampleLod, near, weather.y);
        float crown = gCrown;
        // Single-call-site entry skin refinement: back up to the last confirmed
        // empty sample prevTs and subdivide [prevTs, ts] into 2..4 fine sub-steps
        // so every pixel catches the sunlit front rim regardless of jitter phase.
        if (d > 0.002 && wasEmpty && subRemaining == 0 && T > 0.15 && i < steps - 12) {
          float subSpan = min(ts - prevTs, dt * 1.15);
          if (subSpan > 35.0) {
            int subN = subSpan > 480.0 ? 4 : (subSpan > 160.0 ? 3 : 2);
            t = ts - subSpan;
            wasEmpty = false;
            subRemaining = subN;
            subDt = subSpan / float(subN);
            continue;
          }
        }
        if (d > 0.002) {
          if (tFront < 0.0) tFront = ts;
          float h = sat((rp - uShellBase - weather.y) / uShellDepth);
          // Optical depth toward the sun: five growing steps starting close
          // (117 m) so cauliflower billows self-shadow crisply while reaching ~6 km.
          float tau = 0.0, ls = 180.0;
          vec3 pl = p;
          for (int j = 0; j < 5; j++) {
            pl += sunDirection * (j == 0 ? ls * 0.65 : ls);
            tau += cloudDensity(pl, cov, j == 0 && uLightLod > 0.5 ? sampleLod : 0, near, weather.y) * ls;
            ls *= 2.05;
          }
          tau *= uExtinction;
          if (uShadowOn > 0.5) tau = max(tau, cloudCastTau(p, sunDirection) * uCloudCast);
          float scatter = 0.0, scatter1 = 0.0, a = 1.0;
          for (int k = 0; k < 4; k++) {
            float e = a * exp(-tau * a);
            scatter += e * mix(hgPhase(mu, 0.82 * a), hgPhase(mu, -0.25 * a), 0.28);
            scatter1 += e * mix(hgPhase(mu1, 0.82 * a), hgPhase(mu1, -0.25 * a), 0.28);
            a *= 0.48;
          }
          float skin = 0.0796 * 0.55 * exp(-tau * 0.9);
          scatter += skin;
          scatter1 += skin;
          float powderK = (0.35 * sat(0.5 - 0.5 * mu) + 0.15) * (1.0 - smoothstep(14000.0, 65000.0, ts));
          float powder = mix(1.0, 1.0 - exp(-tau * 2.0 - d * 3.0), powderK)
            * mix(0.78, 1.0, exp(-tau * 0.3));
          float ecl = eclipsing ? eclipseVisibility(p, sunDirection) : 1.0;
          float uSpan = sat((ts - t0) / max(span, 1.0));
          vec3 sunTrans = uSpan < 0.4
            ? mix(sunNear, sunMid, uSpan / 0.4)
            : mix(sunMid, sunFar, (uSpan - 0.4) / 0.6);
          vec3 sun = irradiance * sunTrans * (scatter * powder * ecl);
          if (uSunEnergy1 > 0.001) {
            sun += irradiance1 * sunAt(p, sunDirection1)
              * (scatter1 * powder * (eclipsing ? eclipseVisibility(p, sunDirection1) : 1.0));
          }
          float day = smoothstep(-0.12, 0.12, dot(p / rp, sunDirection)) * mix(0.3, 1.0, ecl);
          float relH = sat(h / max(crown, 0.22));
          vec3 ambColor = mix(vec3(0.019, 0.023, 0.032), vec3(0.048, 0.071, 0.118), smoothstep(0.0, 0.78, h));
          vec3 ambient = irradiance * ambColor
            * (0.56 + 0.44 * exp(-d * 2.2)) * mix(0.76, 1.0, relH) * (0.24 + 0.76 * day);
          float open = mix(0.74, 1.0, smoothstep(0.25, 0.8, crown));
          open = mix(open, 1.0, 0.5 * smoothstep(100000.0, 400000.0, ts));
          vec3 source = (sun * uScatterGain * mix(0.48, 1.0, smoothstep(0.0, 0.55, relH)) + ambient) * open * uCloudTint;
          float Ti = exp(-d * uExtinction * dt);
          float w = T * (1.0 - Ti);
          L += w * source; weighted += w * ts; weight += w;
          T *= Ti;
          tBack = ts;
          wasEmpty = false;
          prevD = d;
          if (T < 0.008) { T = 0.0; break; }
        } else {
          prevTs = ts;
          if (subRemaining == 0) wasEmpty = true;
          prevD = 0.0;
        }
        if (subRemaining > 0) subRemaining--;
        t += dt;
      }
    }
    if (weight < 1e-4 && cirrusA < 0.004) return;

    // Merge the cirrus sheet in ray order.
    float cirrusWeight = 0.0;
    if (cirrusA >= 0.004) {
      cirrusWeight = cirrusA * (cirrusFront ? 1.0 : T);
      if (cirrusFront) L = cirrusL * cirrusA + L * (1.0 - cirrusA);
      else L += T * cirrusL * cirrusA;
      T *= 1.0 - cirrusA;
      tFront = tFront < 0.0 ? cirrusT : min(tFront, cirrusT);
      tBack = max(tBack, cirrusT);
    }

    // Air between the camera and the clouds. The scene behind already carries
    // its own full-path air, so only the cloud-covered fraction adds this.
    vec3 airRadiance, airTransmittance;
    airIntegrate(ro, rd, 0.0, (weighted + cirrusWeight * cirrusT) / max(weight + cirrusWeight, 1e-5), airRadiance, airTransmittance);
    gl_FragColor = vec4(airRadiance * (1.0 - T) + airTransmittance * L, T);
    float representative = (weighted + cirrusWeight * cirrusT) / max(weight + cirrusWeight, 1e-5);
    gAux = vec4(tFront, max(tBack, tFront + 1.0), representative, 1000.0) * 0.001;   // km
  }`;

// Temporal upsampling. The march runs at a reduced resolution with its grid
// shifted by a quarter texel each frame; the history is twice as fine, so
// every history pixel receives an exact sample once in four frames and keeps
// a reprojected, neighbourhood-clamped value in between. Static and slowly
// moving views converge to the history's resolution instead of the march's.
// Cloud in front of a surface at the given distance, for one low-res texel:
// opacity grows from the texel's cloud front over its optical depth, with at
// least ~600 m of fog so a ridge never cuts a cloud along a hard line.
const frontCoverageGLSL = /* glsl */`
  float frontCoverage(vec3 aux, float distance) {
    return distance <= aux.x ? 0.0 : 1.0 - exp(-2.2 * (distance - aux.x) / max(aux.z - aux.x, 600.0));
  }`;

const resolveShader = /* glsl */`
  precision highp float;
  uniform sampler2D tCurrent, tCurrentAux, tHistory, tSceneDepth;
  uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal, uPrevProjection;
  uniform mat3 uPrevLocalToView, uDeckDelta;
  uniform vec3 uCameraDelta, uDeckCameraDelta, uCameraLocal;
  uniform vec2 uCloudTexel, uHistTexel, uHistSize, uSubpixel;
  uniform float uHistoryWeight, uCurrentWeight, uSettling, uDeckMoving, uCameraFar, uShellTop, uShellBase;
  varying vec2 vUv;
  float surfaceDistance, cloudAbove, occluded = 0.0;
  ivec2 maxCell;
  ${frontCoverageGLSL}
  // 5-tap Catmull-Rom bicubic history lookup: prevents repeated fractional
  // reprojection during slow space-to-planet approaches from smearing the 2x
  // history buffer into bilinear blur.
  vec4 sampleHistoryCatmullRom(sampler2D tex, vec2 uv) {
    vec2 pos = uv * uHistSize;
    vec2 center = floor(pos - 0.5) + 0.5;
    vec2 f = pos - center;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = f2 - 0.5 * (f3 + f);
    vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
    vec2 w3 = 0.5 * (f3 - f2);
    vec2 w2 = 1.0 - w0 - w1 - w3;
    vec2 w12 = w1 + w2;
    vec2 tc0 = (center - 1.0) * uHistTexel;
    vec2 tc3 = (center + 2.0) * uHistTexel;
    vec2 tc12 = (center + w2 / max(w12, vec2(1e-5))) * uHistTexel;
    float s0 = w12.x * w0.y;
    float s1 = w0.x * w12.y;
    float s2 = w12.x * w12.y;
    float s3 = w3.x * w12.y;
    float s4 = w12.x * w3.y;
    vec4 t0 = texture2D(tex, clamp(vec2(tc12.x, tc0.y), 0.0, 1.0));
    vec4 t1 = texture2D(tex, clamp(vec2(tc0.x, tc12.y), 0.0, 1.0));
    vec4 t2 = texture2D(tex, clamp(vec2(tc12.x, tc12.y), 0.0, 1.0));
    vec4 t3 = texture2D(tex, clamp(vec2(tc3.x, tc12.y), 0.0, 1.0));
    vec4 t4 = texture2D(tex, clamp(vec2(tc12.x, tc3.y), 0.0, 1.0));
    vec4 result = (t0 * s0 + t1 * s1 + t2 * s2 + t3 * s3 + t4 * s4) / max(s0 + s1 + s2 + s3 + s4, 1e-5);
    // Anti-ringing clamp to the 5-tap convex hull preserves crisp gradients
    // during slow space approach without amplifying half-res raymarch noise.
    vec4 tapMin = min(min(min(t0, t1), min(t2, t3)), t4);
    vec4 tapMax = max(max(max(t0, t1), max(t2, t3)), t4);
    result = clamp(result, tapMin, tapMax);
    return vec4(max(result.rgb, vec3(0.0)), clamp(result.a, 0.0, 1.0));
  }
  // One march texel with the part of its cloud that lies behind this pixel's
  // opaque surface removed. Masking here, per fine pixel and always with that
  // pixel's own grid phase, keeps the depth order out of the per-frame
  // shifted grid: in the composite it switched thin cloud over high ground on
  // and off every frame.
  vec4 maskedTexel(ivec2 cell) {
    cell = clamp(cell, ivec2(0), maxCell);
    vec4 cloud = texelFetch(tCurrent, cell, 0);
    if (surfaceDistance < 0.0) return cloud;
    vec3 aux = texelFetch(tCurrentAux, cell, 0).xyz;
    // A texel that met no cloud carries none to mask.
    float inFront = aux.z > 0.0 ? frontCoverage(aux * 1000.0, surfaceDistance) : cloudAbove;
    if (aux.z > 0.0 && inFront < 0.98) occluded = 1.0;
    return vec4(cloud.rgb * inFront, 1.0 - (1.0 - cloud.a) * inFront);
  }
  void main() {
    vec2 size = 1.0 / uCloudTexel;
    maxCell = ivec2(size) - 1;
    vec2 st = vUv * size - 0.5 - uSubpixel;
    vec2 cellF = clamp(floor(st + 0.5), vec2(0.0), size - 1.0);
    ivec2 cell = ivec2(cellF);
    vec2 off = st - cellF;
    vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
    vec3 rd = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
    float r0 = length(uCameraLocal);
    float sceneDepth = texture2D(tSceneDepth, vUv).x;
    surfaceDistance = sceneDepth < 0.999999
      ? (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005) : -1.0;
    // When both the camera and the opaque surface lie strictly below the cloud
    // shell, no cloud can exist in front of this pixel. Keep the temporal
    // cloud history unmasked behind foreground geometry (trees, props, ground)
    // and let the full-resolution composite cut it out cleanly: moving trees
    // never inherit stale sky-cloud history, newly uncovered sky already has
    // converged clouds, and bilinear filtering never bleeds across leaf edges.
    if (surfaceDistance >= 0.0 && r0 < uShellBase) {
      float b = dot(uCameraLocal, rd);
      float ld = length(uCameraLocal - b * rd);
      float h = (uShellBase - ld) * (uShellBase + ld);
      float deckExit = h >= 0.0 ? -b + sqrt(h) : 0.0;
      if (surfaceDistance <= deckExit) surfaceDistance = -1.0;
    }
    // From above the deck every cloud lies in front of the ground.
    cloudAbove = r0 > uShellTop ? 1.0 : 0.0;
    vec4 nearest = maskedTexel(cell);
    vec2 corner = floor(st), f = st - corner;
    ivec2 c0 = ivec2(corner);
    vec4 spatial = mix(mix(maskedTexel(c0), maskedTexel(c0 + ivec2(1, 0)), f.x),
      mix(maskedTexel(c0 + ivec2(0, 1)), maskedTexel(c0 + ivec2(1, 1)), f.x), f.y);
    if (uHistoryWeight <= 0.0) { gl_FragColor = spatial; return; }
    // Foreground depth dilation: if the shifted march cell missed a cloud rim
    // this frame, inherit the closest adjacent cloud depth so cloud edges
    // reproject with their real parallax instead of jumping to far clear sky.
    float km = texelFetch(tCurrentAux, cell, 0).z;
    if (km <= 0.0) {
      float best = 1e9;
      float kL = texelFetch(tCurrentAux, clamp(cell + ivec2(-1, 0), ivec2(0), maxCell), 0).z;
      float kR = texelFetch(tCurrentAux, clamp(cell + ivec2(1, 0), ivec2(0), maxCell), 0).z;
      float kD = texelFetch(tCurrentAux, clamp(cell + ivec2(0, -1), ivec2(0), maxCell), 0).z;
      float kU = texelFetch(tCurrentAux, clamp(cell + ivec2(0, 1), ivec2(0), maxCell), 0).z;
      if (kL > 0.0) best = min(best, kL);
      if (kR > 0.0) best = min(best, kR);
      if (kD > 0.0) best = min(best, kD);
      if (kU > 0.0) best = min(best, kU);
      if (best < 1e8) km = best;
    }
    float distance = km > 0.0 ? km * 1000.0 : 150000.0;
    bool onDeck = km > 0.0;
    if (!onDeck) {
      float mid = 0.5 * (uShellBase + uShellTop);
      float b = dot(uCameraLocal, rd);
      float h = b * b - (r0 - mid) * (r0 + mid);
      if (h > 0.0) {
        h = sqrt(h);
        float t = r0 > mid ? -b - h : -b + h;
        if (t > 0.0) { distance = t; onDeck = true; }
      }
    }
    vec3 previousView = onDeck
      ? uPrevLocalToView * (uDeckCameraDelta + uDeckDelta * (rd * distance))
      : uPrevLocalToView * (uCameraDelta + rd * distance);
    vec4 clip = uPrevProjection * vec4(previousView, 1.0);
    vec2 uv = clip.xy / max(clip.w, 1e-6) * 0.5 + 0.5;
    if (!(clip.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0)) { gl_FragColor = spatial; return; }
    vec4 history = sampleHistoryCatmullRom(tHistory, uv);
    // Screen motion of this point since last frame, in march texels.
    float motion = length((uv - vUv) * size);
    vec4 m1 = vec4(0.0), m2 = vec4(0.0);
    vec4 lo = nearest, hi = nearest;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec4 n = maskedTexel(cell + ivec2(x, y));
      lo = min(lo, n); hi = max(hi, n);
      m1 += n; m2 += n * n;
    }
    m1 /= 9.0;
    vec4 sigma = sqrt(max(m2 / 9.0 - m1 * m1, vec4(0.0)));
    // Where an opaque surface hides or cuts into the cloud layer (e.g. a ridge
    // or high-altitude foliage above uShellBase), never let stale sky-cloud
    // history bleed onto the foreground object during camera motion or drift.
    if (occluded > 0.5 && max(hi.r, max(hi.g, hi.b)) < 1e-4 && lo.a > 0.999) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    // Variance-guided neighbourhood box: bounds ghosting during fast turns and
    // disocclusion while keeping converged 2x super-resolution edges crisp
    // during slow space-to-planet approaches.
    float clampDrive = max(smoothstep(0.25, 1.5, motion), occluded);
    float gamma = mix(1.85, 1.15, clampDrive);
    vec4 pad = ((hi - lo) * 0.22 + vec4(vec3(0.018), 0.01)) * (1.0 - occluded * 0.85);
    vec4 varLo = max(lo - pad, m1 - sigma * gamma);
    vec4 varHi = min(hi + pad, m1 + sigma * gamma);
    vec4 boxLo = mix(lo - pad, varLo, clampDrive);
    vec4 boxHi = mix(hi + pad, varHi, clampDrive);
    float clampAmount = max(max(smoothstep(0.12, 0.75, motion), uSettling * 0.65), max(uDeckMoving * 0.18, occluded));
    history = mix(history, clamp(history, boxLo, boxHi), clampAmount);
    // This pixel's own sample arrives when the shifted grid lands on it.
    float exact = 1.0 - smoothstep(0.18, 0.44, max(abs(off.x), abs(off.y)));
    // Only fall back to bilinear spatial blending under fast pan/turn motion;
    // keep slow approach in crisp Catmull-Rom 2x accumulation.
    float moving = smoothstep(1.1, 3.6, motion);
    vec4 target = mix(spatial, nearest, exact);
    gl_FragColor = mix(history, target, max(max(exact * uCurrentWeight, moving * 0.28), occluded * 0.5));
  }`;

const compositeShader = /* glsl */`
  precision highp float;
  uniform sampler2D tBase, tSceneDepth, tCloud, tCloudAux, tShaft;
  uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal;
  uniform vec3 uCameraLocal, uSunDirection0;
  uniform float uCameraFar, uShadowFloor, uFullPixelAngle;
  uniform vec2 uCloudTexel, uHistTexel, uSubpixel;
  ${cloudFieldGLSL}
  ${shadowLookupGLSL}
  varying vec2 vUv;
  void main() {
    vec4 base = texture2D(tBase, vUv);
    vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
    vec3 rd = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
    // Distant clouds are sampled by long jittered steps; a small tent filter
    // there trades invisible detail for a clean horizon. The distance is to
    // the deck itself: the march's own front depth comes from this frame's
    // shifted grid and toggled the filter along every distant cloud edge.
    float r0 = length(uCameraLocal);
    float deck = r0 > uShellTop ? shellHits(uCameraLocal, rd, uShellTop).x
      : r0 < uShellBase ? shellHits(uCameraLocal, rd, uShellBase).y : 0.0;
    float coverage = 1.0, shade = 1.0, shaftMask = 1.0;
    float sceneDepth = texture2D(tSceneDepth, vUv).x;
    if (sceneDepth < 0.999999) {
      // Opaque geometry: below the cloud shell cut clouds out at exact full
      // resolution so fine silhouettes (trees, foliage) never get low-res
      // cloud bleed; above uShellBase the resolve already masked frontCoverage.
      float distance = (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005);
      if (r0 < uShellBase) {
        coverage = distance <= deck ? 0.0 : smoothstep(deck, deck + 50.0, distance);
      }
      // Near-field opaque surfaces have negligible air-column shaft loss;
      // fading out the low-res subpixel-shifted shaft buffer prevents a
      // flickering dark halo around nearby tree edges.
      shaftMask = smoothstep(50.0, 600.0, distance);
      if (uShadowOn > 0.5) {
        // Surfaces under the clouds lose their direct sun to the cloud column.
        vec3 p = uCameraLocal + rd * distance;
        float r = length(p);
        vec3 up = p / r;
        // The base rides over high ground with the same lift the march uses.
        float localBase = uShellBase + (r < uShellBase + uLiftMax + 2600.0 ? liftAt(p) : uLiftMax);
        float under = 1.0 - smoothstep(localBase, localBase + 2600.0, r);
        if (under > 0.0) {
          float day = smoothstep(0.0, 0.14, dot(up, normalize(uSunDirection0)));
          shade = mix(1.0, mix(uShadowFloor, 1.0, cloudSurfaceShadowAt(p, up, rd, distance, uFullPixelAngle)), day * under);
        }
      }
    }
    vec4 cloud = coverage > 0.0 ? texture2D(tCloud, vUv) : vec4(0.0, 0.0, 0.0, 1.0);
    // Apply only a subtle anti-aliasing soften on grazing horizon rays — never
    // blur top-down orbital cloud views.
    float far = smoothstep(25000.0, 90000.0, deck);
    if (far > 0.0 && coverage > 0.0) {
      vec3 entryP = uCameraLocal + rd * deck;
      float grazing = 1.0 - smoothstep(0.08, 0.28, abs(dot(rd, entryP / max(length(entryP), 1.0))));
      if (grazing > 0.0) {
        vec2 o = uHistTexel * 1.5;
        vec4 blurred = (cloud * 2.0 + texture2D(tCloud, vUv + o) + texture2D(tCloud, vUv - o)
          + texture2D(tCloud, vUv + vec2(o.x, -o.y)) + texture2D(tCloud, vUv + vec2(-o.x, o.y))) / 6.0;
        cloud = mix(cloud, blurred, far * grazing * 0.12);
      }
    }
    vec3 color = base.rgb * shade * mix(1.0, cloud.a, coverage) + cloud.rgb * coverage;
    vec3 shaftLoss = min(texture2D(tShaft, vUv).rgb * shaftMask, base.rgb * 0.82);
    gl_FragColor = vec4(max(color - shaftLoss, vec3(0.0)), base.a);
  }`;

export class LiteCloudPass extends Pass {
  constructor(camera, atmospherePass, { scale = 0.5, steps = 96, maxPixels = 520000 } = {}) {
    super();
    this.camera = camera;
    this.atmospherePass = atmospherePass;
    this.scale = scale;
    this.baseScale = scale;
    this.maxPixels = maxPixels;
    this.activePlanet = null;
    this.sampleListener = false;
    this.listenerDensity = 0;
    this.listenerProbe = null;
    this.visualEnabled = true;
    this.shadowsEnabled = true;
    this.terrainLift = true;
    this.enabled = false;
    this.needsSwap = true;
    this.frame = 0;
    this.animateJitter = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      count: 3, type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.target.textures[0].name = 'lite-cloud.radiance';
    this.target.textures[1].name = 'lite-cloud.depth-range';
    this.target.textures[2].name = 'lite-cloud.shaft-loss';
    // Cloud front/back distances, linear kilometres. log2 in half float once
    // quantised 200 km into ~2 km steps and drew contour rings wherever terrain
    // crossed the cloud layer. The type is chosen on first render: float32
    // where EXT_color_buffer_float exists, linear half float (0.1%) elsewhere.
    this.target.textures[1].minFilter = this.target.textures[1].magFilter = THREE.NearestFilter;
    this.targetTypeChosen = false;
    this.shadowTarget = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
      depthBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
    });
    this.shadowTarget.texture.name = 'lite-cloud.shadow';
    this.shadowAnchor = new THREE.Vector3();
    this.shadowRight = new THREE.Vector3(1, 0, 0);
    this.previousShadowPlanet = null;
    this.previousShadowExtent = 0;
    this.history = [0, 1].map((index) => {
      const target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, depthBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      target.texture.name = 'lite-cloud.history-' + index;
      return target;
    });
    this.historyIndex = 0;
    this.historyValid = false;
    this.temporalEnabled = true;
    this.previousCamera = new THREE.Vector3();
    this.previousPlanet = null;
    this.previousSun = new THREE.Vector3();
    this.previousLocalToView = new THREE.Matrix3();
    this.previousDeck = new THREE.Matrix3();
    this.settleFrames = 0;
    this.deckMovingEma = 0;

    const air = atmospherePass.material.uniforms;
    const field = {
      uNoise: { value: null },
      uCloudTex: { value: null },
      uCloudMat: { value: new THREE.Matrix3() },
      uSynoptic: { value: 0 },
      // Density contrast, rim billows, detailed first light step (see cloudDensity).
      uEvolve: { value: 0 },
      uWarp: { value: 11000 },
      uSharp: { value: 5 },
      uHaze: { value: 0.05 },
      uBillow: { value: 0.4 },
      uLightLod: { value: 1 },
      uShellBase: { value: 1 },
      uShellTop: { value: 2 },
      uShellDepth: { value: LAYER_DEPTH },
      uSurfaceTex: { value: null },
      uSurfaceRange: { value: 1 },
      uLiftBase: { value: 0 },
      uLiftOn: { value: 0 },
      uLiftMax: { value: 0 },
    };
    const shadow = {
      tShadow: { value: this.shadowTarget.texture },
      uShadowX: { value: new THREE.Vector3(1, 0, 0) },
      uShadowY: { value: new THREE.Vector3(0, 0, 1) },
      uShadowCenter: { value: new THREE.Vector2() },
      uShadowExtent: { value: 1 },
      uShadowOn: { value: 0 },
    };
    const extinction = { value: 0.005 };
    const subpixel = { value: new THREE.Vector2() };
    const marchTexel = { value: new THREE.Vector2(1, 1) };
    this.subpixelIndex = 0;
    this.historyRatio = 1;
    // Share the atmosphere pass's uniform objects: one camera/planet/sun state.
    this.marchMaterial = new THREE.ShaderMaterial({
      name: 'Lite cloud march',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      defines: { MARCH_STEPS: steps },
      uniforms: {
        ...air, ...field, ...shadow, ...ringShadowUniforms(),
        uFrame: { value: 0 },
        uExtinction: extinction,
        // The four scattering octaves stand in for the many orders a thick cloud
        // really has; this gain restores a bright (albedo ~0.8) sunlit deck
        // against Lambert surfaces lit by the same irradiance.
        uScatterGain: { value: 3.6 },
        uAltocumulus: { value: 1 },
        uPixelAngle: { value: 0.002 },
        uSheetAngle: { value: 0.0013 },
        uCloudCast: { value: 1 },
        uShaftStrength: { value: 0.9 },
        uCloudTint: { value: new THREE.Color(1, 1, 1) },
        uSubpixel: subpixel,
        uMarchTexel: marchTexel,
      },
      vertexShader, fragmentShader: marchShader,
    });
    this.shadowMaterial = new THREE.ShaderMaterial({
      name: 'Lite cloud shadow map',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        ...field,
        uSunDirection0: air.uSunDirection0,
        uShadowX: shadow.uShadowX, uShadowY: shadow.uShadowY,
        uShadowCenter: shadow.uShadowCenter, uShadowExtent: shadow.uShadowExtent,
        uExtinction: extinction,
      },
      vertexShader, fragmentShader: shadowShader,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'Lite cloud composite',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        ...field, ...shadow,
        tBase: { value: null }, tSceneDepth: { value: null },
        tCloud: { value: this.target.textures[0] }, tCloudAux: { value: this.target.textures[1] },
        tShaft: { value: this.target.textures[2] },
        uInvProjection: air.uInvProjection, uCameraWorld: air.uCameraWorld, uWorldToLocal: air.uWorldToLocal,
        uCameraLocal: air.uCameraLocal, uSunDirection0: air.uSunDirection0, uCameraFar: air.uCameraFar,
        // Sky and bounce light left under a fully opaque cloud.
        uShadowFloor: { value: 0.4 },
        uFullPixelAngle: { value: 0.001 },
        uCloudTexel: marchTexel,
        uHistTexel: { value: new THREE.Vector2(1, 1) },
        uSubpixel: subpixel,
      },
      vertexShader, fragmentShader: compositeShader,
    });
    this.resolveMaterial = new THREE.ShaderMaterial({
      name: 'Lite cloud temporal resolve',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        tCurrent: { value: this.target.textures[0] }, tCurrentAux: { value: this.target.textures[1] },
        tHistory: { value: null }, tSceneDepth: { value: null },
        uCameraLocal: air.uCameraLocal, uCameraFar: air.uCameraFar,
        uShellTop: field.uShellTop, uShellBase: field.uShellBase,
        uInvProjection: air.uInvProjection, uCameraWorld: air.uCameraWorld, uWorldToLocal: air.uWorldToLocal,
        uPrevProjection: { value: new THREE.Matrix4() },
        uPrevLocalToView: { value: new THREE.Matrix3() },
        uCameraDelta: { value: new THREE.Vector3() },
        uDeckDelta: { value: new THREE.Matrix3() },
        uDeckCameraDelta: { value: new THREE.Vector3() },
        uCloudTexel: marchTexel,
        uHistTexel: { value: new THREE.Vector2(1, 1) },
        uHistSize: { value: new THREE.Vector2(1, 1) },
        uSubpixel: subpixel,
        uHistoryWeight: { value: 0 },
        uSettling: { value: 1 },
        uDeckMoving: { value: 0 },
        // Exact samples arrive once per four frames on the 2x history; ~0.18
        // averages step jitter cleanly while staying responsive to drift.
        uCurrentWeight: { value: 0.18 },
      },
      vertexShader, fragmentShader: resolveShader,
    });
    this.resolveQuad = new FullScreenQuad(this.resolveMaterial);
    this.marchQuad = new FullScreenQuad(this.marchMaterial);
    this.shadowQuad = new FullScreenQuad(this.shadowMaterial);
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
  }

  static supports(planet) {
    return Boolean(planet?.cloudShadowTex && planet.cloudMesh && planet.atmoMesh);
  }

  setVisualEnabled(enabled) {
    this.visualEnabled = Boolean(enabled);
    this.#refresh();
  }

  setQuality({ scale, baseScale, steps } = {}) {
    if (Number.isFinite(scale)) {
      this.scale = THREE.MathUtils.clamp(scale, 0.2, 1);
      if (this.scale > this.baseScale) this.baseScale = this.scale;
    }
    if (Number.isFinite(baseScale)) this.baseScale = THREE.MathUtils.clamp(baseScale, 0.2, 1);
    if (Number.isInteger(steps) && steps !== this.marchMaterial.defines.MARCH_STEPS) {
      this.marchMaterial.defines.MARCH_STEPS = steps;
      this.marchMaterial.needsUpdate = true;
    }
  }

  // Portal hand-off: two views of one renderer exchange worlds at a threshold.
  // Swapping the temporal reconstruction with the planet keeps each world's
  // cloud history continuous, so crossing never restarts the 2x convergence.
  exchangeTemporalState(other) {
    if (!other || other === this) return;
    for (const key of ['history', 'historyIndex', 'historyValid', 'frame', 'previousCamera',
      'previousPlanet', 'previousSun', 'previousLocalToView', 'previousDeck', 'settleFrames',
      'deckMovingEma', 'subpixelIndex', 'historyRatio', 'baseScale', 'target', 'targetTypeChosen']) {
      const value = this[key];
      this[key] = other[key];
      other[key] = value;
    }
    // the resolve pass reprojects with the previous frame's camera
    const mineU = this.resolveMaterial?.uniforms, theirsU = other.resolveMaterial?.uniforms;
    for (const name of ['uPrevLocalToView', 'uPrevProjection']) {
      const a = mineU?.[name]?.value, b = theirsU?.[name]?.value;
      if (a?.clone && b?.copy) { const t = a.clone(); a.copy(b); b.copy(t); }
    }
    const mine = this.activePlanet, theirs = other.activePlanet;
    this.activePlanet = null;
    other.activePlanet = null;
    this.setActivePlanet(theirs);
    other.setActivePlanet(mine);
    if (mine) mine.liteCloudActive = true;
    if (theirs) theirs.liteCloudActive = true;
  }

  setActivePlanet(planet) {
    const next = LiteCloudPass.supports(planet) ? planet : null;
    if (next !== this.activePlanet) {
      if (this.activePlanet) this.activePlanet.liteCloudActive = false;
      this.activePlanet = next;
      if (next) {
        const u = this.marchMaterial.uniforms;
        u.uNoise.value = liteCloudNoiseTexture();
        u.uSynoptic.value = next.weatherField?.synoptic ? 1 : 0;
        const floor = next.hasLiquid && Number.isFinite(next.seaLevel) ? Math.max(next.seaLevel, 0) : 0;
        const atmoTop = Math.max(1000, Number(this.atmospherePass?.profileState?.profile?.topAltitudeMeters) || next.R * 0.09);
        const tropoScale = THREE.MathUtils.clamp(atmoTop / 65000, 0.14, 1.0);
        const shellDepth = LAYER_DEPTH * tropoScale;
        const base = floor + THREE.MathUtils.clamp((next.hAmp || 0) * 0.25, 1500 * tropoScale, 3500 * tropoScale);
        // Over high ground the base lifts with the regional surface altitude.
        // Off by default. Real clouds sit below summits; what read as clipping was
        // the hard intersection, which the composite now softens. With the lift on,
        // regions of high regional altitude also lost their clouds entirely.
        const synoptic = this.terrainLift && Boolean(next.weatherField?.synoptic && next.cloudWeatherHiTex);
        // (On: without it, every snow-capped highland stood in a cloud-free hole,
        // because the fixed-altitude layer lay below the ground there.)
        const highest = synoptic ? Number(next.weatherField.surfaceBoundsMeters?.[1]) || 0 : 0;
        const maxLift = synoptic ? THREE.MathUtils.clamp((highest + 500 - base) * 0.85, 0, 9000 * tropoScale) : 0;
        u.uLiftOn.value = synoptic ? 1 : 0;
        u.uLiftMax.value = maxLift;
        u.uLiftBase.value = base;
        u.uSurfaceRange.value = synoptic ? next.weatherField.surfaceRangeMeters || 1 : 1;
        u.uShellDepth.value = shellDepth;
        u.uShellBase.value = next.R + base;
        u.uShellTop.value = next.R + base + shellDepth + maxLift;
        u.uExtinction.value = 0.005 / Math.pow(tropoScale, 0.55);
        u.uCloudTint.value.set(
          next.type === 'toxic' ? 0xc8e890
            : next.type === 'desert' ? 0xfff0dc
              : next.type === 'lava' ? 0xffd5be
                : 0xffffff,
        );
        if (next.type === 'exotic' && next.atmoColor) {
          u.uCloudTint.value.lerp(next.atmoColor, 0.16);
        }
        bindRingShadow(u, next);
        this.layerMeters = { base, top: base + shellDepth };
      }
    }
    this.#refresh();
  }

  #refresh() {
    const planet = this.activePlanet;
    const enabled = Boolean(planet && this.visualEnabled && planet.cloudVisualEnabled !== false);
    // History from before the pass was switched off is stale; a held view no
    // longer clamps it, so start over instead of fading it out.
    if (enabled && !this.enabled) this.historyValid = false;
    this.enabled = enabled;
    // The planet hides its analytic cloud decks while this pass draws them.
    if (planet) planet.liteCloudActive = this.enabled;
  }

  // CPU mirror of GLSL liftAt + weatherAt at the local cloud base directly above
  // `localPos` so surface rain/snow stays below the rendered clouds and under
  // real cloud cover rather than falling out of clear sky or above the deck.
  weatherSampleAt(localPos) {
    const planet = this.activePlanet;
    if (!planet || !localPos) return null;
    const len = localPos.length();
    if (!(len > 0)) return null;
    const u = this.marchMaterial.uniforms;
    const dir = { x: localPos.x / len, y: localPos.y / len, z: localPos.z / len };
    const base = u.uLiftBase.value;
    const isSynoptic = Boolean(planet.weatherField?.synoptic);
    let lift = 0;
    if (isSynoptic && this.terrainLift && planet.cloudWeatherHiTex) {
      const surfaceAtlas = planet.cloudWeatherHiTex?.userData?.weatherAtlas;
      const surface = planet.weatherField?.surfaceAt
        ? planet.weatherField.surfaceAt(dir)
        : (surfaceAtlas ? (sampleWeatherAtlas(surfaceAtlas, dir)[1] * 2 - 1) * u.uSurfaceRange.value : 0);
      lift = THREE.MathUtils.clamp(Math.max(surface + 500 - base, 0) * 0.85, 0, u.uLiftMax.value);
    }
    const cloudBaseAlt = base + lift;
    const rBase = planet.R + cloudBaseAlt;
    const px = dir.x * rBase, py = dir.y * rBase, pz = dir.z * rBase;
    const spin = planet.cloudSpin || 0;
    const cs = Math.cos(spin), sn = Math.sin(spin);
    const qx = cs * px - sn * pz, qy = py, qz = sn * px + cs * pz;
    const cloudAtlas = planet.cloudShadowTex?.userData?.weatherAtlas;
    let c = cloudAtlas ? sampleWeatherAtlas(cloudAtlas, dir, spin)[0] : 0;
    if (isSynoptic) c = smoothstep(-0.42, 0.42, (c - 0.5) * 4);
    const noiseTex = u.uNoise.value || liteCloudNoiseTexture();
    const cycles = ((planet.weatherHours || 0) / EVOLVE_HOURS) % 1024;
    const fa = Math.floor(cycles), fb = Math.floor(cycles + 0.5);
    const waRaw = 1 - Math.abs(2 * fract(cycles) - 1);
    const wa = waRaw * waRaw * (3 - 2 * waRaw);
    const bA = sampleLiteNoiseB(noiseTex, qx / 93000 + fract(0.731 * fa),
      qy / 93000 + fract(0.317 * fa), qz / 93000 + fract(0.547 * fa));
    const bB = sampleLiteNoiseB(noiseTex, qx / 93000 + fract(0.413 * fb) + 0.5,
      qy / 93000 + fract(0.871 * fb) + 0.5, qz / 93000 + fract(0.229 * fb) + 0.5);
    const breakup = 0.5 + (bA * wa + bB * (1 - wa) - 0.5) / Math.hypot(wa, 1 - wa);
    c = Math.max(0, Math.min(1, c * 1.15 + (breakup - 0.5) * 0.8 * (1 - 0.6 * c) - 0.07));
    const regime = sampleLiteNoiseB(noiseTex, qy / 310000 + 0.61, qz / 310000 + 0.61, qx / 310000 + 0.61);
    const cover = c * (0.42 + (0.95 - 0.42) * smoothstep(0.34, 0.66, regime));
    return { cloudBaseAlt, cover };
  }

  #renderShadowMap(renderer, planet) {
    const u = this.marchMaterial.uniforms;
    _sun.copy(u.uSunDirection0.value).normalize();
    const camera = u.uCameraLocal.value;
    const altitude = Math.max(0, camera.length() - planet.R);
    // Cover what the camera can see; quantise the size with hysteresis so hovering near a step never toggles.
    const wanted = Math.max(25000, altitude * 3 + 25000);
    let extent = Math.min(planet.R * 1.15, 25000 * 2 ** (Math.ceil(Math.log2(wanted / 25000) * 2) / 2));
    if (planet === this.previousShadowPlanet && this.previousShadowExtent > extent
      && wanted > this.previousShadowExtent / Math.SQRT2 * 0.92) {
      extent = this.previousShadowExtent;
    }
    const texel = 2 * extent / SHADOW_SIZE;
    _ground.copy(camera).setLength(planet.R);
    // Anchor the snapping lattice to a nearby surface point instead of the
    // planet centre: at 1,200 km lever arm, the sun's rotation under the x60
    // clock otherwise swept the shadow grid across the clouds at ~4 km/s.
    if (planet !== this.previousShadowPlanet || extent !== this.previousShadowExtent
      || _ground.distanceToSquared(this.shadowAnchor) > (extent * 0.35) ** 2) {
      this.shadowAnchor.copy(_ground);
      this.previousShadowPlanet = planet;
      this.previousShadowExtent = extent;
    }
    const x = u.uShadowX.value, y = u.uShadowY.value;
    x.copy(this.shadowRight).addScaledVector(_sun, -this.shadowRight.dot(_sun));
    if (x.lengthSq() < 1e-6) {
      x.set(0, 1, 0);
      if (Math.abs(_sun.y) > 0.92) x.set(1, 0, 0);
      x.cross(_sun);
    }
    x.normalize();
    this.shadowRight.copy(x);
    y.crossVectors(_sun, x).normalize();
    const ax = this.shadowAnchor.dot(x), ay = this.shadowAnchor.dot(y);
    u.uShadowCenter.value.set(
      ax + Math.round((_ground.dot(x) - ax) / texel) * texel,
      ay + Math.round((_ground.dot(y) - ay) / texel) * texel,
    );
    u.uShadowExtent.value = extent;
    renderer.setRenderTarget(this.shadowTarget);
    this.shadowQuad.render(renderer);
  }

  // Sample the same eroded, moving medium as the beauty pass at the jumper's
  // ears. A weather column alone cannot tell a clear hole from a cloud core.
  #sampleListener(renderer, planet, u) {
    const r = u.uCameraLocal.value.length();
    if (!this.sampleListener || r < u.uShellBase.value || r > u.uShellTop.value) {
      this.listenerDensity = 0;
      return;
    }
    if (!this.listenerProbe) {
      const mat = new THREE.ShaderMaterial({
        name: 'Cloud density at listener', uniforms: u, vertexShader,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        fragmentShader: `${cloudFieldGLSL}
          uniform vec3 uCameraLocal;
          void main() {
            vec2 weather = weatherAt(uCameraLocal);
            float d = cloudDensity(uCameraLocal, weather.x, 2, 1.0, weather.y);
            gl_FragColor = vec4(d, 0., 0., 1.);
          }`,
      });
      this.listenerProbe = { target: new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }),
        quad: new FullScreenQuad(mat), pixel: new Uint8Array(4), at: -Infinity, busy: false };
    }
    const probe = this.listenerProbe, now = performance.now();
    if (probe.busy || now - probe.at < 160) return;
    probe.at = now;
    probe.busy = true;
    renderer.setRenderTarget(probe.target);
    probe.quad.render(renderer);
    renderer.readRenderTargetPixelsAsync(probe.target, 0, 0, 1, 1, probe.pixel).then(() => {
      if (this.activePlanet === planet && this.sampleListener) this.listenerDensity = probe.pixel[0] / 255;
    }).catch(() => { this.listenerDensity = 0; }).finally(() => { probe.busy = false; });
  }

  render(renderer, writeBuffer, readBuffer) {
    const planet = this.activePlanet;
    const u = this.marchMaterial.uniforms;
    const isSynoptic = Boolean(planet.weatherField?.synoptic);
    u.uCloudTex.value = planet.cloudShadowTex;
    u.uSurfaceTex.value = planet.cloudWeatherHiTex || planet.cloudShadowTex;
    u.uSynoptic.value = isSynoptic ? 1 : 0;
    u.uLiftOn.value = isSynoptic && this.terrainLift && Boolean(planet.cloudWeatherHiTex) ? 1 : 0;
    // Same inverse deck spin the terrain and water cloud shadows use.
    _matrix.makeRotationFromQuaternion(_quaternion.copy(planet.cloudMesh.quaternion).invert());
    u.uCloudMat.value.setFromMatrix4(_matrix);
    u.uFrame.value = this.temporalEnabled || this.animateJitter ? (this.frame = (this.frame + 1) % 1024) : 0;

    u.uEvolve.value = ((planet.weatherHours || 0) / EVOLVE_HOURS) % 1024;
    if (this.sampleListener || this.listenerDensity) this.#sampleListener(renderer, planet, u);
    u.uShadowOn.value = this.shadowsEnabled ? 1 : 0;
    if (this.shadowsEnabled) this.#renderShadowMap(renderer, planet);

    const pixels = readBuffer.width * readBuffer.height;
    const pixelCapScale = Math.sqrt(this.maxPixels / Math.max(1, pixels));
    const scale = Math.min(this.scale, pixelCapScale);
    const baseScale = Math.min(Math.max(this.baseScale || this.scale, scale), pixelCapScale);
    const width = Math.max(1, Math.round(readBuffer.width * scale));
    const height = Math.max(1, Math.round(readBuffer.height * scale));
    // Decouple history buffer resolution from transient adaptive march-scale
    // changes: when adaptive quality trims raymarch scale, the history stays
    // intact instead of resizing and flashing blurry.
    const ratio = this.temporalEnabled && baseScale <= 0.55 ? 2 : 1;
    const histScale = this.temporalEnabled ? Math.min(1, baseScale * ratio) : baseScale;
    const histW = Math.max(1, Math.round(readBuffer.width * histScale));
    const histH = Math.max(1, Math.round(readBuffer.height * histScale));
    if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
    }
    // Single-buffer seamless history resize: resize only the incoming write
    // buffer so the previous read buffer stays intact for Catmull-Rom
    // resampling across adaptive DPR steps (zero history wipe / blur flash).
    const read = this.history[this.historyIndex];
    const write = this.history[1 - this.historyIndex];
    if (write.width !== histW || write.height !== histH) {
      write.setSize(histW, histH);
    }
    if (read.width <= 1 || read.height <= 1) {
      read.setSize(histW, histH);
      this.historyValid = false;
    }
    this.historyRatio = ratio;
    const sub = u.uSubpixel.value;
    if (ratio === 2) {
      this.subpixelIndex = (this.subpixelIndex + 1) & 3;
      sub.set(SUBPIXEL_CYCLE[this.subpixelIndex][0], SUBPIXEL_CYCLE[this.subpixelIndex][1]);
    } else sub.set(0, 0);
    u.uMarchTexel.value.set(1 / width, 1 / height);
    // Angle one reconstructed cloud pixel subtends; using histH keeps noise LOD
    // and sharpness steady even if adaptive quality tweaks the march scale.
    const viewSpan = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov || 60) / 2);
    u.uPixelAngle.value = viewSpan / Math.max(1, histH) * (ratio === 2 ? 1.15 : 1);
    // A 1080p-equivalent angular footprint, independent of screen resolution.
    u.uSheetAngle.value = viewSpan / 540 * 0.6;

    if (!this.targetTypeChosen) {
      this.targetTypeChosen = true;
      if (renderer.extensions.has('EXT_color_buffer_float')) {
        this.target.textures[1].type = THREE.FloatType;
        this.target.dispose();
      }
    }
    renderer.setRenderTarget(this.target);
    this.marchQuad.render(renderer);

    const c = this.compositeMaterial.uniforms;
    c.uHistTexel.value.set(1 / histW, 1 / histH);
    c.uFullPixelAngle.value = viewSpan / Math.max(1, readBuffer.height);

    // Temporal resolve into the other history target.
    const r = this.resolveMaterial.uniforms;
    // Match the read target's exact dimensions so seamless single-buffer DPR
    // resizes sample the previous frame accurately via Catmull-Rom.
    r.uHistTexel.value.set(1 / read.width, 1 / read.height);
    r.uHistSize.value.set(read.width, read.height);
    const cameraLocal = u.uCameraLocal.value;
    r.uCameraDelta.value.subVectors(cameraLocal, this.previousCamera);
    // Deck motion since last frame: previous = prevDeck^-1 * deck (rotations).
    const deck = u.uCloudMat.value;
    r.uDeckDelta.value.copy(this.previousDeck).transpose().multiply(deck);
    r.uDeckCameraDelta.value.copy(cameraLocal).applyMatrix3(r.uDeckDelta.value).sub(this.previousCamera);
    // Smooth, gentle clamp factor for in-place cloud evolution (reprojection
    // already compensates rigid deck rotation via uDeckDelta, so frame-dt
    // variation must not toggle history weights between 0 and 1).
    const spin = Math.acos(THREE.MathUtils.clamp((r.uDeckDelta.value.elements[0] + r.uDeckDelta.value.elements[4]
      + r.uDeckDelta.value.elements[8] - 1) / 2, -1, 1));
    const rawDeckMoving = THREE.MathUtils.clamp(spin * planet.R / 10, 0, 1);
    this.deckMovingEma = this.historyValid ? THREE.MathUtils.lerp(this.deckMovingEma, rawDeckMoving, 0.12) : rawDeckMoving;
    r.uDeckMoving.value = this.deckMovingEma;
    this.previousDeck.copy(deck);
    // A teleport, a body change or a resize starts the history over; allow
    // proportionally larger per-frame travel when far out in space.
    const maxContinuousDelta = Math.max(20000, Math.max(0, cameraLocal.length() - planet.R) * 0.08);
    const continuous = this.temporalEnabled && this.historyValid && planet === this.previousPlanet
      && r.uCameraDelta.value.length() < maxContinuousDelta
      && _sun.copy(u.uSunDirection0.value).normalize().dot(this.previousSun) > 0.99985;
    r.uHistoryWeight.value = continuous ? 1 : 0;
    // Clamp gently after a visible turn or cut; smooth decay avoids sharp/blur snaps.
    _matrix.multiplyMatrices(u.uWorldToLocal.value, u.uCameraWorld.value);
    _rotation.setFromMatrix4(_matrix).transpose();
    let turned = 0;
    for (let i = 0; i < 9; i++) turned = Math.max(turned, Math.abs(_rotation.elements[i] - this.previousLocalToView.elements[i]));
    const texelsPerRadian = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov || 60) / 2));
    const moved = !continuous || turned * texelsPerRadian > 0.25;
    this.settleFrames = moved ? 6 : Math.max(0, this.settleFrames - 1);
    const settleFraction = this.settleFrames / 6;
    r.uSettling.value = settleFraction;
    // Continuous blend weight: smoother convergence when steady, responsive on turns.
    r.uCurrentWeight.value = ratio === 2
      ? THREE.MathUtils.lerp(0.14, 0.24, Math.max(settleFraction, r.uDeckMoving.value * 0.35))
      : 0.12;
    this.previousLocalToView.copy(_rotation);
    r.tHistory.value = read.texture;
    r.tSceneDepth.value = this.atmospherePass.sceneDepthTexture || readBuffer.depthTexture || null;
    renderer.setRenderTarget(write);
    this.resolveQuad.render(renderer);
    this.historyIndex = 1 - this.historyIndex;
    this.historyValid = true;
    c.tCloud.value = write.texture;
    // Remember this frame's camera: local-to-view rotation, projection, position.
    _matrix.multiplyMatrices(u.uWorldToLocal.value, u.uCameraWorld.value);
    r.uPrevLocalToView.value.setFromMatrix4(_matrix).transpose();
    r.uPrevProjection.value.copy(this.camera.projectionMatrix);
    this.previousCamera.copy(cameraLocal);
    this.previousPlanet = planet;
    this.previousSun.copy(u.uSunDirection0.value).normalize();
    c.tBase.value = readBuffer.texture;
    c.tSceneDepth.value = this.atmospherePass.sceneDepthTexture || readBuffer.depthTexture || null;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compositeQuad.render(renderer);
  }

  resetHistory() {
    this.historyValid = false;
  }

  releaseTargets() {
    this.target.dispose(); this.shadowTarget.dispose();
    for (const target of this.history) target.dispose();
    this.targetTypeChosen = false; this.historyValid = false;
  }

  dispose() {
    if (this.listenerProbe) {
      this.listenerProbe.target.dispose();
      this.listenerProbe.quad.material.dispose();
      this.listenerProbe.quad.dispose();
      this.listenerProbe = null;
    }
    if (this.activePlanet) this.activePlanet.liteCloudActive = false;
    this.activePlanet = null;
    this.target.dispose();
    this.shadowTarget.dispose();
    for (const target of this.history) target.dispose();
    this.resolveMaterial.dispose();
    this.resolveQuad.dispose();
    this.marchMaterial.dispose();
    this.shadowMaterial.dispose();
    this.compositeMaterial.dispose();
    this.marchQuad.dispose();
    this.shadowQuad.dispose();
    this.compositeQuad.dispose();
  }
}
