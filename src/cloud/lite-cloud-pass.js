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
import { weatherAtlasGLSL } from './weather-atlas.js';
import { liteCloudNoiseTexture } from './lite-cloud-noise.js';

const SHADOW_SIZE = 1024;
// Depth of the cumulus layer. The deck fills under half of it; towers use the rest.
const LAYER_DEPTH = 11000;
// Game hours for one form-and-dissolve cycle of the cloud fields.
const EVOLVE_HOURS = 5;
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
    return 1.0 - abs(2.0 * fract(cycles) - 1.0);
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
    float lift = 0.0;
    if (uLiftOn > 0.5) {
      float surface = (weatherAtlasSample(uSurfaceTex, p).g * 2.0 - 1.0) * uSurfaceRange;
      lift = min(max(surface + 500.0 - uLiftBase, 0.0) * 0.85, uLiftMax);
    }
    return vec2(c * mix(0.42, 0.95, smoothstep(0.34, 0.66, regime)), lift);
  }

  // Distance fades set by the view march. A step grows with distance, so
  // octaves smaller than the step are faded out instead of being sampled as
  // noise: gFarSmall drops the 2-3 km cumulus, gFarWide the 9 km cells.
  float gFarSmall = 0.0, gFarWide = 0.0;
  // Metres one sample stands for (a march texel at the sample's distance, or
  // a shadow-map texel). Every noise octave is read at the mip that matches
  // it, so detail smaller than a pixel averages out instead of being dropped
  // early (blurry from orbit) or sampled raw (sparkle).
  float gFootprint = 0.0;
  // Footprint that decides when cells merge into sheets. Unlike gFootprint it
  // does not shrink with resolution: the same distance looks the same at 2K.
  float gSheet = 0.0;
  float noiseLod(float period) { return log2(max(gFootprint * 64.0 / period, 1.0)); }
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
      // Single cumulus live and die faster than the fields they belong to.
      vec3 sa, sb;
      float sw = evolvePhase(uEvolve * 2.7 + 0.3, sa, sb);
      small = evolveBlend(textureLod(uNoise, q.zxy / 8300.0 + 0.29 + sa, noiseLod(8300.0)).r,
        textureLod(uNoise, q.zxy / 8300.0 + 0.29 + sb, noiseLod(8300.0)).r, sw);
      float nearField = base * 0.46 + wide * 0.2 + small * 0.34;
      float midField = base * 0.7 + wide * 0.3;
      base = mix(mix(midField, nearField, fine), base * 0.35 + wide * 0.65, gFarWide);
    } else base = base * 0.35 + wide * 0.65;
    // From far enough that a cell is a few pixels, single clouds are not
    // seen at all: the fields read as continuous sheets shaped by the
    // weather, and break into cells as the camera comes closer.
    base = mix(base, 0.6, smoothstep(1500.0, 4200.0, gSheet));
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
    float profile = smoothstep(0.0, 0.05, h) * smoothstep(top, top * mix(0.5, 0.74, fine), h);   // crisp tops up close
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
    // A cumulus goes from clear air to opaque within tens of metres. The
    // noise ramp spans hundreds, which drew every cloud as a ball of fog:
    // push the ramp to the outside so the edge is a surface, then let the
    // thinnest rim still fade instead of ending in a hard outline.
    // The edge can only be as sharp as a sample is small: a hard cut through
    // sub-pixel cloud drew salt-and-pepper grain and contour rings from orbit.
    float sharp = mix(uSharp, 1.5, smoothstep(120.0, 1100.0, gFootprint));
    float haze = uHaze * (sharp - 1.0) / max(uSharp - 1.0, 1e-3);
    return pow(sat((d - haze) * sharp), 1.15) * cov * 1.3;
  }`;

const shadowLookupGLSL = /* glsl */`
  uniform sampler2D tShadow;
  uniform vec3 uShadowX, uShadowY;
  uniform vec2 uShadowCenter;
  uniform float uShadowExtent, uShadowOn;
  // Transmittance of the cloud column between a point below the clouds and the sun.
  float cloudShadowAt(vec3 p) {
    vec2 uv = (vec2(dot(p, uShadowX), dot(p, uShadowY)) - uShadowCenter) / uShadowExtent * 0.5 + 0.5;
    vec2 edge = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
    return mix(1.0, texture2D(tShadow, uv).r, edge.x * edge.y);
  }
  // Optical depth between a point inside the layer and the sun, from the same
  // map: the ray's total, taken up linearly between where its cloud begins
  // and ends. Coarse, but it reaches as far as the map does, so a tower
  // shades the deck tens of kilometres down-sun; the short light march in
  // the view pass only knows the nearest few kilometres.
  float cloudCastTau(vec3 p, vec3 sun) {
    vec2 uv = (vec2(dot(p, uShadowX), dot(p, uShadowY)) - uShadowCenter) / uShadowExtent * 0.5 + 0.5;
    vec2 edge = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
    vec3 map = texture2D(tShadow, uv).rgb;
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
    // Same octaves as the view march, faded by what one texel can resolve.
    float texel = uShadowExtent / 512.0;
    gFootprint = texel;
    gSheet = texel;
    gFarSmall = smoothstep(500.0, 1500.0, texel);
    gFarWide = smoothstep(2500.0, 8000.0, texel);
    vec2 xy = uShadowCenter + (vUv * 2.0 - 1.0) * uShadowExtent;
    vec3 origin = uShadowX * xy.x + uShadowY * xy.y;
    float transmittance = 1.0, front = 1.0, back = 1.0;
    vec2 top = shellHits(origin, sun, uShellTop);
    if (top.y > top.x) {
      vec2 base = shellHits(origin, sun, uShellBase);
      float s0 = base.y > base.x ? base.y : top.x, s1 = top.y;
      if (s1 > s0) {
        vec2 w0 = weatherAt(origin + sun * mix(s0, s1, 0.2));
        vec2 w1 = weatherAt(origin + sun * mix(s0, s1, 0.8));
        if (max(w0.x, w1.x) > 0.03) {
          // Walk down from the sunward side and note where the cloud on
          // this ray begins and ends (as fractions of the layer crossing):
          // the view march uses them to shade cloud with cloud.
          float ds = (s1 - s0) / 16.0, tau = 0.0;
          bool hit = false;
          float previous = 0.0;
          // A low sun stretches each step to kilometres: hard-edged density
          // sampled that coarsely drew square, flickering shadows.
          gFootprint = max(texel, ds * 0.3);
          for (int i = 0; i < 16; i++) {
            float k = 1.0 - (float(i) + 0.5) / 16.0;
            float density = cloudDensity(origin + sun * (s0 + (s1 - s0) * k), mix(w0.x, w1.x, k), 1, 0.0, mix(w0.y, w1.y, k));
            // Where the cloud begins and ends, found within the step from the
            // two densities around the crossing: whole steps drew parallel
            // bands across the deck at a low sun.
            // Sample i sits at (i + 0.5) / 16 of the crossing; the threshold
            // is crossed between it and the previous one.
            if (density > 0.002) {
              if (!hit) {
                front = max(float(i) - 0.5 + sat((0.002 - previous) / max(density - previous, 1e-4)), 0.0) / 16.0;
                hit = true;
              }
              back = (float(i) + 1.0) / 16.0;
            } else if (hit && previous > 0.002) {
              back = (float(i) - 0.5 + sat((previous - 0.002) / max(previous - density, 1e-4))) / 16.0;
            }
            previous = density;
            tau += density * ds;
          }
          transmittance = exp(-tau * uExtinction);
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
  ${cloudFieldGLSL}
  ${shadowLookupGLSL}

  float hgPhase(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  }

  // Direct sunlight reaching a point above the ground, through the shared
  // optical-depth LUT (alpha = fraction of the solar path clear of the planet).
  vec3 sunAt(vec3 p, vec3 sunDirection) {
    float r = length(p);
    float altitude = clamp(r - uGroundR, 0.0, uTopAltitude);
    vec4 depth = sunlightOpticalDepth(altitude, dot(p / r, sunDirection));
    vec3 tau = (uBetaRayleigh * depth.r * uRayleighScaleHeight
      + uBetaMieExtinction * depth.g * uMieScaleHeight
      + uBetaOzone * depth.b * uOzoneHalfWidth) * uDensityScale;
    return exp(-min(tau, vec3(50.0))) * depth.a;
  }

  void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    gAux = vec4(6e4, 6e4, 0.0, 1.0);
    gShaft = vec4(0.0);
    // The whole low-res grid shifts by a quarter texel each frame (2x2 cycle):
    // its samples land exactly on the centres of the 2x history's pixels.
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
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.61803);
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
      float previous = 0.0, phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu), phaseM = hgPhase(mu, 0.8);
      float sj = fract(jitter + 0.37);
      for (int i = 0; i < 16; i++) {
        float x = (float(i) + sj) / 16.0;
        float t = tMax * x * x;                      // dense near the camera
        float dt = t - previous; previous = t;
        vec3 p = ro + rd * t;
        float altitude = max(length(p) - uGroundR, 0.0);
        float rayleigh = exp(-altitude / uRayleighScaleHeight) * uDensityScale;
        float mie = exp(-altitude / uMieScaleHeight) * uDensityScale;
        vec3 source = (uBetaRayleigh * rayleigh * phaseR + uBetaMieScatter * mie * phaseM) * sunAt(p, sunDirection) * irradiance;
        loss += through * source * (1.0 - cloudShadowAt(p)) * dt;
        through *= exp(-(uBetaRayleigh * rayleigh + uBetaMieExtinction * mie) * dt);
      }
      if (eclipsing) loss *= eclipseVisibility(ro, sunDirection);
      gShaft = vec4(loss * uShaftStrength * smoothstep(baseHere, baseHere - 700.0, r0), 1.0);
    }

    // ---- High cirrus: one thin sheet well above the cumulus layer. It costs
    // a handful of fetches and gives the sky a second, clearly higher storey.
    float cirrusRadius = uShellTop + 4500.0, cirrusT = -1.0, cirrusA = 0.0;
    vec3 cirrusL = vec3(0.0);
    bool cirrusFront = r0 >= cirrusRadius;
    vec2 cirrusHit = shellHits(ro, rd, cirrusRadius);
    if (cirrusFront) { if (cirrusHit.x > 0.0) cirrusT = cirrusHit.x; }
    else if (!ground) cirrusT = cirrusHit.y;
    if (cirrusT > 0.0) {
      vec3 p = ro + rd * cirrusT;
      vec3 q = uCloudMat * p;
      float patches = smoothstep(0.5, 0.8, textureLod(uNoise, q.zxy / 230000.0 + 0.2, 0.0).b);
      if (patches > 0.0) {
        float warp = textureLod(uNoise, q / 41000.0, 0.0).b;
        vec3 streak = q * vec3(1.0 / 16000.0, 1.0 / 16000.0, 1.0 / 90000.0) + warp * 0.22;
        float fibre = textureLod(uNoise, streak, 0.0).g * 0.6 + textureLod(uNoise, streak * 2.7 + 0.4, 0.0).r * 0.4;
        // Past ~60 km single fibres are sub-pixel and would sparkle; let the
        // sheet dissolve instead (cirrus is a near-sky layer in this pass).
        fibre = mix(fibre, 0.4, smoothstep(50000.0, 180000.0, cirrusT));
        // Not every high sheet is fibrous. Elsewhere the same storey breaks
        // into altocumulus: small rounded cells packed in loose rows, grey in
        // the middle and bright at the rims from below. A fibrous texture
        // over the whole sky converged on the vanishing point as streaks.
        float cellular = smoothstep(0.42, 0.62, textureLod(uNoise, q.yzx / 160000.0 + 0.47, 0.0).b) * uAltocumulus;
        // The body channel tiles three cells to a period: a 7 km period gives
        // ~2.3 km cells with kilometre and half-kilometre lobes. (At a 2.6 km
        // period the cells were a few hundred metres and repeated visibly.)
        vec3 cq = q * vec3(1.0 / 7000.0, 1.0 / 7000.0, 1.0 / 11000.0) + warp * 0.45;
        float cellLod = log2(max(cirrusT * uPixelAngle * 64.0 / 7000.0, 1.0));
        float cell = textureLod(uNoise, cq, cellLod).r * 0.8 + textureLod(uNoise, cq * 1.7 + 0.31, cellLod + 0.8).g * 0.2;
        float puff = smoothstep(0.5, 0.74, cell);
        // Past a few hundred kilometres the cells merge into a thin sheet.
        float cellFade = smoothstep(120000.0, 400000.0, cirrusT);
        puff = mix(puff, 0.3, cellFade);
        float a = mix(smoothstep(0.52, 0.86, fibre) * 0.36, puff * 0.62, cellular) * patches;
        float cellThick = cellular * smoothstep(0.62, 0.95, cell) * (1.0 - cellFade);
        // A thin sheet thickens toward the horizon with the slant path.
        float slant = max(abs(dot(rd, p / length(p))), 0.16);
        cirrusA = 1.0 - pow(1.0 - a, 1.0 / slant);
        float day = smoothstep(-0.12, 0.12, dot(p / length(p), sunDirection));
        float ecl = eclipsing ? eclipseVisibility(p, sunDirection) : 1.0;
        day *= mix(0.3, 1.0, ecl);
        cirrusL = (irradiance * sunAt(p, sunDirection) * ecl * mix(hgPhase(mu, 0.7), 0.0796, 0.55) * uScatterGain * 0.9
          + irradiance1 * sunAt(p, sunDirection1) * (eclipsing ? eclipseVisibility(p, sunDirection1) : 1.0) * mix(hgPhase(mu1, 0.7), 0.0796, 0.55) * uScatterGain * 0.9
          + irradiance * vec3(0.045, 0.062, 0.095) * (0.25 + 0.75 * day)) * uCloudTint;
        // From below, a cell's thick middle passes less of the sunlit top.
        if (!cirrusFront) cirrusL *= 1.0 - 0.45 * cellThick * (1.0 - smoothstep(0.7, 0.97, mu));
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
      // A ray grazing the limb crosses up to ~700 km of layer. Cut at 320 km,
      // the far half of the curving deck vanished, and the cut moved with the
      // camera, so distant clouds appeared and disappeared.
      t1 = min(t1, t0 + 900000.0);
      float span = t1 - t0;
      // Weather is looked up where the sample is, every few kilometres of
      // travel. Interpolating a handful of samples across the whole ray made
      // a cloud's existence depend on the view: it vanished as the camera moved.
      float coverMax = 1.0;
      // Interpolated between lookups 3.5 km apart along the ray. Held
      // constant instead, coverage and base lift stepped at fixed distances
      // from the camera and cut every cloud into terraces around the viewer.
      vec2 weather = vec2(0.0), weatherA = vec2(0.0), weatherB = vec2(0.0);
      float tWeather = -1e9;
      if (coverMax >= 0.03) {
        vec3 sunNear = sunAt(ro + rd * t0, sunDirection);
        vec3 sunFar = sunAt(ro + rd * t1, sunDirection);
        float dmin = max(min(min(50.0 + 0.004 * t0, span / 90.0), 300.0), 20.0);
        float t = t0 + dmin * jitter;
        tBack = t0;
        // Seen edge-on from far away (the limb from orbit) the small octaves
        // are squeezed below a pixel and only produce sparkle: drop them there.
        vec3 entry = ro + rd * t0;
        float edgeOn = (1.0 - smoothstep(0.1, 0.42, abs(dot(rd, entry / length(entry))))) * smoothstep(40000.0, 160000.0, t0);
        // Inside cloud the lit skin is thinner than a coarse step. On entry
        // the ray backs up and continues in fine steps; otherwise the first
        // sample sat deep on average and every top read grey with a bright
        // rim and contour rings (worst looking straight down).
        // The fine steps cover the lit skin only (while the ray is still
        // mostly clear), and a few empty fine samples are tolerated after
        // backing up: leaving fine mode on the first empty sample jumped the
        // ray straight over any cloud thinner than a coarse step.
        bool inside = false;
        int refine = 0, fine = 0;
        // Long rays (the horizon band from low altitude, the limb from high)
        // cross hundreds of kilometres of layer; 96 steps ran out before the
        // far end and the clouds there were missing, at a distance that moved
        // with the camera. They get up to twice the steps, decided by the
        // span alone so every pixel's samples stay at the same distances as
        // its neighbours'. Only that thin band pays for them.
        float reach = clamp(span / 60000.0, 1.0, 2.0);
        int steps = int(float(MARCH_STEPS) * reach);
        for (int i = 0; i < MARCH_STEPS * 2; i++) {
          if (i >= steps || t > t1) break;
          // Steps grow with distance, but never past a fair share of the
          // span: looking down from 17 km the growth alone reached kilometre
          // steps inside the layer and jumped whole small cumulus, which then
          // came and went from frame to frame with the jitter.
          float dt = max(dmin, min(0.055 * (t - t0), (1.2 + 0.3 * reach) * span / float(steps)));
          // Only the first few samples past an entry are fine: a grazing ray
          // through a thin deck stayed "inside" for hundreds of steps and ran
          // out of budget before the far half of the sky.
          if (inside && fine > 0 && T > 0.35) { dt = max(dt * 0.3, 20.0); fine--; }
          // Samples stay one step apart; only the start is jittered. Picking
          // a random point inside each step left gaps of up to two steps,
          // which skipped thin cloud on some frames and not others: the whole
          // deck flickered. (The contour terraces that dither was hiding came
          // from steps too long for the layer, fixed by the cap above.)
          // Far steps are kilometres long. Without an offset every pixel samples
          // the same distances and the clouds are cut into arcs around the
          // camera that slide as it moves; shifted by a fraction of the step
          // per pixel and frame, the history averages them out. Near steps
          // stay put (shifting them made the deck flicker).
          vec3 p = ro + rd * (t + dt * (jitter - 0.5) * smoothstep(2500.0, 5000.0, dt));
          if (t - tWeather > 3500.0) {
            if (t - tWeather > 7000.0) { tWeather = t; weatherA = weatherAt(p); }
            else { tWeather += 3500.0; weatherA = weatherB; }
            weatherB = weatherAt(ro + rd * (tWeather + 3500.0));
          }
          weather = mix(weatherA, weatherB, sat((t - tWeather) / 3500.0));
          float rp = length(p);
          float above = rp - (uShellBase + weather.y + uShellDepth);
          if (above > 200.0) {
            // Reaching the local tops takes at least above/down along a straight ray.
            t += clamp(0.8 * above / max(-dot(rd, p / rp), 0.08), dt, 6000.0);
            continue;
          }
          float cov = weather.x;
          // Close-range billows last until a march texel outgrows them.
          float near = sat(1.0 - t / 60000.0);
          gFootprint = t * uPixelAngle;
          gSheet = t * uSheetAngle;
          // Above the highest top this spot can have, no sample can hit
          // cloud: skip down toward it. Most of the layer's depth is kept for
          // towers, so a ray looking down from orbit otherwise spent half its
          // steps in empty air. The bound can rise along the ray (~0.4 m per
          // metre at most), hence the shorter jump where the ray is flat.
          if (!inside) {
            float over = rp - cloudCeiling(p, weather.y);
            if (over > 150.0) {
              t += clamp(0.9 * over / (max(-dot(rd, p / rp), 0.0) + 0.4), dt, 6000.0);
              continue;
            }
          }
          // Fade octaves the growing step can no longer resolve.
          // (by step length along grazing rays, by distance when looking down from orbit)
          gFarSmall = max(smoothstep(2.2, 6.0, dt / 500.0), smoothstep(500.0, 1500.0, gFootprint));
          gFarWide = max(smoothstep(1.2, 3.5, dt / 3000.0), smoothstep(800.0, 2000.0, gFootprint));
          gFarSmall = max(gFarSmall, edgeOn);
          gFarWide = max(gFarWide, edgeOn * 0.7);
          float d = cov < 0.03 ? 0.0 : cloudDensity(p, cov, near > 0.0 ? 2 : 1, near, weather.y);
          float crown = gCrown;
          if (d > 0.002 && !inside) { inside = true; refine = 4; fine = 8; t -= dt * 0.85; continue; }
          if (d <= 0.002) { if (refine > 0) refine--; else inside = false; }
          if (d > 0.002) {
            if (tFront < 0.0) tFront = t;
            float h = sat((length(p) - uShellBase - weather.y) / uShellDepth);
            // Optical depth toward the sun: five growing steps reaching ~7 km, far
            // enough for a tower to shade the cumulus beside it.
            float tau = 0.0, ls = 300.0;
            vec3 pl = p;
            // The first step sees the same billows the view does, so each one
            // shades the next instead of the whole cloud lighting as a blob.
            for (int j = 0; j < 5; j++) {
              pl += sunDirection * ls;
              tau += cloudDensity(pl, cov, j == 0 && uLightLod > 0.5 ? (near > 0.0 ? 2 : 1) : 0, near, weather.y) * ls;
              ls *= 1.9;
            }
            tau *= uExtinction;
            // Far-reaching shade from the sun map: cloud on cloud.
            if (uShadowOn > 0.5) tau = max(tau, cloudCastTau(p, sunDirection) * uCloudCast);
            // Multi-scattering octaves: each order loses extinction and
            // anisotropy. Gives silver linings and keeps thick cores from going black.
            float scatter = 0.0, scatter1 = 0.0, a = 1.0;
            for (int k = 0; k < 4; k++) {
              float e = a * exp(-tau * a);
              scatter += e * mix(hgPhase(mu, 0.82 * a), hgPhase(mu, -0.25 * a), 0.28);
              scatter1 += e * mix(hgPhase(mu1, 0.82 * a), hgPhase(mu1, -0.25 * a), 0.28);
              a *= 0.48;
            }
            // The higher orders a thick cloud really has leave its sunlit
            // skin as a near-Lambert diffuser (albedo ~0.8 from any side).
            // Four HG octaves lose that energy fast at back-scatter angles,
            // so an orbit view with the sun behind it saw grey tops. This
            // isotropic term only lives where sunlight still arrives; shaded
            // flanks (large tau) keep their blue-grey.
            float skin = 0.0796 * 0.55 * exp(-tau * 0.9);
            scatter += skin;
            scatter1 += skin;
            // Powder darkens the sun-facing rims of small puffs seen up close.
            // From tens of kilometres it only dimmed whole decks: with the sun
            // behind an orbital viewer it halved every cloud top to grey.
            float powderK = (0.35 * sat(0.5 - 0.5 * mu) + 0.15) * (1.0 - smoothstep(12000.0, 60000.0, t));
            float powder = mix(1.0, 1.0 - exp(-tau * 2.0 - d * 3.0), powderK)
              * mix(0.76, 1.0, exp(-tau * 0.3));
            // The companion star reuses the primary's optical depth (they are
            // rarely far apart in the sky) with its own phase and horizon.
            float ecl = eclipsing ? eclipseVisibility(p, sunDirection) : 1.0;
            vec3 sun = irradiance * mix(sunNear, sunFar, sat((t - t0) / span)) * (scatter * powder * ecl);
            if (uSunEnergy1 > 0.001) sun += irradiance1 * sunAt(p, sunDirection1) * (scatter1 * powder
              * (eclipsing ? eclipseVisibility(p, sunDirection1) : 1.0));
            // Under the umbra the surrounding sky is shadowed too.
            float day = smoothstep(-0.12, 0.12, dot(normalize(p), sunDirection)) * mix(0.3, 1.0, ecl);
            vec3 ambient = irradiance * mix(vec3(0.013, 0.020, 0.036), vec3(0.047, 0.070, 0.116), h)
              * (0.55 + 0.45 * exp(-d * 2.5)) * (0.25 + 0.75 * day);
            // Bases sit in their own shadow; tops catch the sun.
            // Troughs between domes are hemmed in by their neighbours: less sun
            // and sky reaches them. This is what lets the deck read as relief
            // from straight above, where the light march alone sees no shadow.
            float open = mix(0.74, 1.0, smoothstep(0.25, 0.8, crown));
            open = mix(open, 1.0, 0.5 * smoothstep(100000.0, 400000.0, t));
            // Bases sit lower in their own cloud, not in the deck: a small cumulus
            // whose top is at a third of the deck used to stay in the "base"
            // band entirely and read grey from above.
            vec3 source = (sun * uScatterGain * mix(0.5, 1.0, smoothstep(0.0, 0.55, h / max(crown, 0.2))) + ambient) * open * uCloudTint;
            float Ti = exp(-d * uExtinction * dt);
            float w = T * (1.0 - Ti);
            L += w * source; weighted += w * t; weight += w;
            T *= Ti;
            tBack = t;
            if (T < 0.008) { T = 0.0; break; }
          }
          t += dt;
        }
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
  uniform vec2 uCloudTexel, uSubpixel;
  uniform float uHistoryWeight, uCurrentWeight, uSettling, uDeckMoving, uCameraFar, uShellTop, uShellBase;
  varying vec2 vUv;
  float surfaceDistance, cloudAbove, occluded = 0.0;
  ivec2 maxCell;
  ${frontCoverageGLSL}
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
    float sceneDepth = texture2D(tSceneDepth, vUv).x;
    surfaceDistance = sceneDepth < 0.999999
      ? (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005) : -1.0;
    // From above the deck every cloud lies in front of the ground.
    cloudAbove = length(uCameraLocal) > uShellTop ? 1.0 : 0.0;
    vec4 nearest = maskedTexel(cell);
    vec2 corner = floor(st), f = st - corner;
    ivec2 c0 = ivec2(corner);
    vec4 spatial = mix(mix(maskedTexel(c0), maskedTexel(c0 + ivec2(1, 0)), f.x),
      mix(maskedTexel(c0 + ivec2(0, 1)), maskedTexel(c0 + ivec2(1, 1)), f.x), f.y);
    if (uHistoryWeight <= 0.0) { gl_FragColor = spatial; return; }
    vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
    vec3 rd = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
    // Clear sky reprojects as a far point so the history follows rotation.
    float km = texelFetch(tCurrentAux, cell, 0).z;
    float distance = km > 0.0 ? km * 1000.0 : 150000.0;
    // Where this frame saw no cloud but the ray crosses the deck, whatever the
    // history holds there is cloud that just drifted off: follow it at the
    // deck's middle so it leaves rather than fading out as a trail.
    bool onDeck = km > 0.0;
    if (!onDeck) {
      float mid = 0.5 * (uShellBase + uShellTop);
      float b = dot(uCameraLocal, rd), r0 = length(uCameraLocal);
      float h = b * b - (r0 - mid) * (r0 + mid);
      if (h > 0.0) {
        h = sqrt(h);
        float t = r0 > mid ? -b - h : -b + h;
        if (t > 0.0) { distance = t; onDeck = true; }
      }
    }
    // The camera offset is formed on the CPU in double precision. A cloud
    // point also rode the deck's rotation since last frame: at the game's
    // accelerated clock that is several texels a frame, and reprojecting it
    // as fixed ground dragged every cloud into a long streak.
    vec3 previousView = onDeck
      ? uPrevLocalToView * (uDeckCameraDelta + uDeckDelta * (rd * distance))
      : uPrevLocalToView * (uCameraDelta + rd * distance);
    vec4 clip = uPrevProjection * vec4(previousView, 1.0);
    vec2 uv = clip.xy / max(clip.w, 1e-6) * 0.5 + 0.5;
    if (!(clip.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0)) { gl_FragColor = spatial; return; }
    vec4 history = texture2D(tHistory, uv);
    // Screen motion of this point since last frame, in march texels.
    float motion = length((uv - vUv) * size);
    // Keep history inside what the current 3x3 neighbourhood allows: this
    // bounds ghosting when clouds are revealed, relit or the camera cuts.
    // A held view reprojects exactly, and there the clamp would only erase
    // sub-texel cloud that the shifted grid sees in one phase of four, so it
    // applies while the view moves and for a few frames after it settles.
    // Drifting clouds also grow and dissolve; while the deck moves, keep half
    // the clamp so a cloud that thinned away does not linger in the history.
    float clampAmount = max(max(smoothstep(0.05, 0.3, motion), uSettling), uDeckMoving * 0.5);
    vec4 lo = nearest, hi = nearest;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec4 n = maskedTexel(cell + ivec2(x, y));
      lo = min(lo, n); hi = max(hi, n);
    }
    vec4 pad = (hi - lo) * 0.25 + vec4(vec3(0.02), 0.01);
    // Cloud drifting behind a ridge is followed by its history onto the
    // ridge itself; where the surface hides cloud, the current frame rules.
    clampAmount = max(clampAmount, occluded * uDeckMoving);
    history = mix(history, clamp(history, lo - pad, hi + pad), clampAmount);
    // This pixel's own sample arrives when the shifted grid lands on it.
    float exact = 1.0 - smoothstep(0.15, 0.4, max(abs(off.x), abs(off.y)));
    // In fast motion only a quarter of the pixels would see a current sample,
    // which drew a 2x2 comb across moving edges: let every pixel follow the
    // interpolated current frame there.
    float moving = smoothstep(0.5, 2.5, motion);
    vec4 target = mix(spatial, nearest, exact);
    gl_FragColor = mix(history, target, max(exact * uCurrentWeight, moving * 0.35));
  }`;

const compositeShader = /* glsl */`
  precision highp float;
  uniform sampler2D tBase, tSceneDepth, tCloud, tCloudAux, tShaft;
  uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal;
  uniform vec3 uCameraLocal, uSunDirection0;
  uniform float uCameraFar, uShadowFloor;
  uniform vec2 uCloudTexel, uHistTexel, uSubpixel;
  ${cloudFieldGLSL}
  ${shadowLookupGLSL}
  varying vec2 vUv;
  void main() {
    vec4 base = texture2D(tBase, vUv);
    vec4 cloud = texture2D(tCloud, vUv);
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
    float far = smoothstep(15000.0, 70000.0, deck);
    if (far > 0.0) {
      vec2 o = uHistTexel * 2.2;
      vec4 blurred = (cloud * 2.0 + texture2D(tCloud, vUv + o) + texture2D(tCloud, vUv - o)
        + texture2D(tCloud, vUv + vec2(o.x, -o.y)) + texture2D(tCloud, vUv + vec2(-o.x, o.y))) / 6.0;
      cloud = mix(cloud, blurred, far * 0.15);
    }
    float coverage = 1.0, shade = 1.0;
    float sceneDepth = texture2D(tSceneDepth, vUv).x;
    if (sceneDepth < 0.999999) {
      // Opaque geometry: the resolve already kept only the cloud in front of
      // it; here the surface takes the cloud column's shadow.
      float distance = (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005);
      coverage = 1.0;
      if (uShadowOn > 0.5) {
        // Surfaces under the clouds lose their direct sun to the cloud column.
        vec3 p = uCameraLocal + rd * distance;
        float r = length(p);
        // The base rides over high ground with the same lift the march uses.
        float localBase = uShellBase + (r < uShellBase + uLiftMax + 2600.0 ? weatherAt(p).y : uLiftMax);
        float under = 1.0 - smoothstep(localBase, localBase + 2600.0, r);
        if (under > 0.0) {
          float day = smoothstep(0.0, 0.14, dot(p / r, normalize(uSunDirection0)));
          shade = mix(1.0, mix(uShadowFloor, 1.0, cloudShadowAt(p)), day * under);
        }
      }
    }
    vec3 color = base.rgb * shade * mix(1.0, cloud.a, coverage) + cloud.rgb * coverage;
    gl_FragColor = vec4(max(color - texture2D(tShaft, vUv).rgb, vec3(0.0)), base.a);
  }`;

export class LiteCloudPass extends Pass {
  constructor(camera, atmospherePass, { scale = 0.5, steps = 96, maxPixels = 520000 } = {}) {
    super();
    this.camera = camera;
    this.atmospherePass = atmospherePass;
    this.scale = scale;
    this.maxPixels = maxPixels;
    this.activePlanet = null;
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
      depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.shadowTarget.texture.name = 'lite-cloud.shadow';
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
        ...air, ...field, ...shadow,
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
        uSubpixel: subpixel,
        uHistoryWeight: { value: 0 },
        uSettling: { value: 1 },
        uDeckMoving: { value: 0 },
        // Exact samples arrive once per four frames on the 2x history; at
        // ~0.22 each, about twenty frames average the step jitter away.
        uCurrentWeight: { value: 0.22 },
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

  setQuality({ scale, steps } = {}) {
    if (Number.isFinite(scale)) this.scale = THREE.MathUtils.clamp(scale, 0.2, 1);
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
      'subpixelIndex', 'historyRatio', 'target', 'targetTypeChosen']) {
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
        const base = floor + THREE.MathUtils.clamp((next.hAmp || 0) * 0.25, 1500, 3500);
        // Over high ground the base lifts with the regional surface altitude.
        // Off by default. Real clouds sit below summits; what read as clipping was
        // the hard intersection, which the composite now softens. With the lift on,
        // regions of high regional altitude also lost their clouds entirely.
        const synoptic = this.terrainLift && Boolean(next.weatherField?.synoptic && next.cloudWeatherHiTex);
        // (On: without it, every snow-capped highland stood in a cloud-free hole,
        // because the fixed-altitude layer lay below the ground there.)
        const highest = synoptic ? Number(next.weatherField.surfaceBoundsMeters?.[1]) || 0 : 0;
        const maxLift = synoptic ? THREE.MathUtils.clamp((highest + 500 - base) * 0.85, 0, 9000) : 0;
        u.uLiftOn.value = synoptic ? 1 : 0;
        u.uLiftMax.value = maxLift;
        u.uLiftBase.value = base;
        u.uSurfaceRange.value = synoptic ? next.weatherField.surfaceRangeMeters || 1 : 1;
        u.uShellBase.value = next.R + base;
        u.uShellTop.value = next.R + base + LAYER_DEPTH + maxLift;
        u.uCloudTint.value.set(next.type === 'toxic' ? 0xc8e890 : 0xffffff);
        this.layerMeters = { base, top: base + LAYER_DEPTH };
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

  #renderShadowMap(renderer, planet) {
    const u = this.marchMaterial.uniforms;
    _sun.copy(u.uSunDirection0.value).normalize();
    const x = u.uShadowX.value, y = u.uShadowY.value;
    x.set(0, 1, 0); if (Math.abs(_sun.y) > 0.92) x.set(1, 0, 0);
    x.cross(_sun).normalize();
    y.crossVectors(_sun, x).normalize();
    const camera = u.uCameraLocal.value;
    const altitude = Math.max(0, camera.length() - planet.R);
    // Cover what the camera can see; quantise the size so it does not breathe.
    const wanted = Math.max(25000, altitude * 3 + 25000);
    const extent = Math.min(planet.R * 1.15, 25000 * 2 ** (Math.ceil(Math.log2(wanted / 25000) * 2) / 2));
    const texel = 2 * extent / SHADOW_SIZE;
    _ground.copy(camera).setLength(planet.R);
    // Snap to whole texels: a sliding map would make shadow edges crawl.
    u.uShadowCenter.value.set(Math.round(_ground.dot(x) / texel) * texel, Math.round(_ground.dot(y) / texel) * texel);
    u.uShadowExtent.value = extent;
    renderer.setRenderTarget(this.shadowTarget);
    this.shadowQuad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const planet = this.activePlanet;
    const u = this.marchMaterial.uniforms;
    u.uCloudTex.value = planet.cloudShadowTex;
    u.uSurfaceTex.value = planet.cloudWeatherHiTex || planet.cloudShadowTex;
    // Same inverse deck spin the terrain and water cloud shadows use.
    _matrix.makeRotationFromQuaternion(_quaternion.copy(planet.cloudMesh.quaternion).invert());
    u.uCloudMat.value.setFromMatrix4(_matrix);
    u.uFrame.value = this.temporalEnabled || this.animateJitter ? (this.frame = (this.frame + 1) % 64) : 0;

    u.uEvolve.value = ((planet.weatherHours || 0) / EVOLVE_HOURS) % 1024;
    u.uShadowOn.value = this.shadowsEnabled ? 1 : 0;
    if (this.shadowsEnabled) this.#renderShadowMap(renderer, planet);

    const pixels = readBuffer.width * readBuffer.height;
    const scale = Math.min(this.scale, Math.sqrt(this.maxPixels / Math.max(1, pixels)));
    const width = Math.max(1, Math.round(readBuffer.width * scale));
    const height = Math.max(1, Math.round(readBuffer.height * scale));
    // The history is twice the march resolution while that stays within the
    // output; a march at three quarters or more just accumulates in place.
    const ratio = this.temporalEnabled && scale <= 0.55 ? 2 : 1;
    if (this.target.width !== width || this.target.height !== height || this.historyRatio !== ratio) {
      this.target.setSize(width, height);
      for (const target of this.history) target.setSize(width * ratio, height * ratio);
      this.historyRatio = ratio;
      this.historyValid = false;
    }
    const sub = u.uSubpixel.value;
    if (ratio === 2) {
      this.subpixelIndex = (this.subpixelIndex + 1) & 3;
      sub.set(SUBPIXEL_CYCLE[this.subpixelIndex][0], SUBPIXEL_CYCLE[this.subpixelIndex][1]);
    } else sub.set(0, 0);
    u.uMarchTexel.value.set(1 / width, 1 / height);
    // Angle one march texel subtends; the shifted grid resolves a little finer.
    const viewSpan = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov || 60) / 2);
    u.uPixelAngle.value = viewSpan / height * (ratio === 2 ? 0.6 : 1);
    // A 1080p march texel, whatever the resolution.
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
    c.uHistTexel.value.set(1 / (width * ratio), 1 / (height * ratio));

    // Temporal resolve into the other history target.
    const r = this.resolveMaterial.uniforms;
    const cameraLocal = u.uCameraLocal.value;
    r.uCameraDelta.value.subVectors(cameraLocal, this.previousCamera);
    // Deck motion since last frame: previous = prevDeck^-1 * deck (rotations).
    const deck = u.uCloudMat.value;
    r.uDeckDelta.value.copy(this.previousDeck).transpose().multiply(deck);
    r.uDeckCameraDelta.value.copy(cameraLocal).applyMatrix3(r.uDeckDelta.value).sub(this.previousCamera);
    // Metres the deck slid at the planet's surface since last frame.
    const spin = Math.acos(THREE.MathUtils.clamp((r.uDeckDelta.value.elements[0] + r.uDeckDelta.value.elements[4]
      + r.uDeckDelta.value.elements[8] - 1) / 2, -1, 1));
    r.uDeckMoving.value = THREE.MathUtils.smoothstep(spin * planet.R, 0.5, 3);
    // A held view over a held deck can average longer: the sharp cloud rims
    // otherwise shimmer with the march's per-frame step jitter.
    const held = this.settleFrames === 0 && r.uDeckMoving.value < 0.5;
    r.uCurrentWeight.value = ratio === 2 ? (held ? 0.1 : 0.22) : 0.1;
    this.previousDeck.copy(deck);
    // A teleport, a body change or a resize starts the history over.
    const continuous = this.temporalEnabled && this.historyValid && planet === this.previousPlanet
      && r.uCameraDelta.value.length() < 20000
      && _sun.copy(u.uSunDirection0.value).normalize().dot(this.previousSun) > 0.99985;
    r.uHistoryWeight.value = continuous ? 1 : 0;
    // Clamp for two full grid cycles after the view turns by a visible amount
    // (in march texels) or cuts; translation shows up in the per-pixel motion.
    _matrix.multiplyMatrices(u.uWorldToLocal.value, u.uCameraWorld.value);
    _rotation.setFromMatrix4(_matrix).transpose();
    let turned = 0;
    for (let i = 0; i < 9; i++) turned = Math.max(turned, Math.abs(_rotation.elements[i] - this.previousLocalToView.elements[i]));
    const texelsPerRadian = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov || 60) / 2));
    const moved = !continuous || turned * texelsPerRadian > 0.1;
    this.settleFrames = moved ? 8 : Math.max(0, this.settleFrames - 1);
    r.uSettling.value = this.settleFrames > 0 ? 1 : 0;
    this.previousLocalToView.copy(_rotation);
    const read = this.history[this.historyIndex], write = this.history[1 - this.historyIndex];
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
