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
const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _sun = new THREE.Vector3();
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
  uniform float uSynoptic, uShellBase, uShellTop, uShellDepth, uSurfaceRange, uLiftBase, uLiftOn, uLiftMax;
  ${weatherAtlasGLSL}

  float sat(float x) { return clamp(x, 0.0, 1.0); }
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
    float breakup = textureLod(uNoise, q / 93000.0, 0.0).b;
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
  // Height of the last sampled column's cloud top within the layer (0..1).
  float gCrown = 0.0;

  // lod 0: light march / shadow / far field. 1: view march. 2: near camera.
  float cloudDensity(vec3 p, float cover, int lod, float near, float lift) {
    float h = (length(p) - uShellBase - lift) / uShellDepth;
    if (h < 0.0 || h > 1.0) return 0.0;
    float cov = cover * 0.86;                       // never fully closed: the deck keeps its pores
    if (cov < 0.02) return 0.0;
    vec3 q = uCloudMat * p;
    // Worley-led closed cells: values fall along cell walls, which opens a
    // natural pore network instead of blocky cut-outs.
    float base = textureLod(uNoise, q / 27000.0, 0.0).r;
    float wide = textureLod(uNoise, q.yzx / 63000.0 + 0.5, 0.0).r;
    float thick = textureLod(uNoise, q.zxy / 149000.0 + 0.37, 0.0).b;
    float fine = lod > 0 ? 1.0 - gFarSmall : 0.0;
    float small = 0.5;
    if (lod > 0) {
      // Break every ~9 km cell into 2-3 km cumulus. Seen from the ground a
      // sky needs many small clouds receding to the horizon; a few huge
      // blobs overhead read as a ceiling.
      small = textureLod(uNoise, q.zxy / 8300.0 + 0.29, 0.0).r;
      float nearField = base * 0.46 + wide * 0.2 + small * 0.34;
      float midField = base * 0.7 + wide * 0.3;
      base = mix(mix(midField, nearField, fine), base * 0.35 + wide * 0.65, gFarWide);
    } else base = base * 0.35 + wide * 0.65;
    base = sat((base - 0.22) / 0.6);
    // Cumulus profile: flat base, cloud-top height driven by the slow
    // thickness field and by each cell (cell cores tower upward).
    float top = mix(0.3, 0.66, smoothstep(0.3, 0.72, thick)) * mix(0.5, 1.0, base * base);
    // Convective towers: where the wide cells and the thickness field agree,
    // a cumulus grows through the rest of the deck (cumulus congestus).
    top += 0.42 * smoothstep(0.6, 0.84, wide) * smoothstep(0.42, 0.78, thick) * smoothstep(0.35, 0.7, base);
    // Every small cumulus is its own dome and carries finer bumps: seen from
    // above the deck is a relief of lit tops and shaded gaps, not a flat sheet.
    if (fine > 0.0) top *= 1.0 - fine * (0.22 * (1.0 - small) + 0.12 * (1.0 - textureLod(uNoise, q / 7300.0, 0.0).g));
    gCrown = top;
    float profile = smoothstep(0.0, 0.05, h) * smoothstep(top, top * mix(0.5, 0.74, fine), h);   // crisp tops up close
    float d = sat(remap(base * profile, 1.0 - cov, 1.0, 0.0, 1.0));
    if (d <= 0.0) return 0.0;
    if (fine > 0.0) {
      // Erode only where the cloud is already thin; cores stay solid.
      float e = (1.0 - textureLod(uNoise, q / 7300.0, 0.0).g) * 0.34 * (1.0 - d);
      if (lod > 1) e += (1.0 - textureLod(uNoise, q.zxy / 1900.0 + 0.13, 0.0).g) * 0.26 * near * (1.0 - d);
      e = min(e * fine, 0.9);
      d = sat((d - e) / (1.0 - e));
    }
    // Thin rims fade out instead of ending in a hard outline.
    return pow(d, 1.15) * cov * 1.3;
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
    gFarSmall = smoothstep(500.0, 1500.0, texel);
    gFarWide = smoothstep(2500.0, 8000.0, texel);
    vec2 xy = uShadowCenter + (vUv * 2.0 - 1.0) * uShadowExtent;
    vec3 origin = uShadowX * xy.x + uShadowY * xy.y;
    float transmittance = 1.0;
    vec2 top = shellHits(origin, sun, uShellTop);
    if (top.y > top.x) {
      vec2 base = shellHits(origin, sun, uShellBase);
      float s0 = base.y > base.x ? base.y : top.x, s1 = top.y;
      if (s1 > s0) {
        vec2 w0 = weatherAt(origin + sun * mix(s0, s1, 0.2));
        vec2 w1 = weatherAt(origin + sun * mix(s0, s1, 0.8));
        if (max(w0.x, w1.x) > 0.03) {
          float ds = (s1 - s0) / 12.0, tau = 0.0;
          for (int i = 0; i < 12; i++) {
            float k = (float(i) + 0.5) / 12.0;
            tau += cloudDensity(origin + sun * (s0 + (s1 - s0) * k), mix(w0.x, w1.x, k), 1, 0.0, mix(w0.y, w1.y, k)) * ds;
          }
          transmittance = exp(-tau * uExtinction);
        }
      }
    }
    gl_FragColor = vec4(transmittance, 0.0, 0.0, 1.0);
  }`;

const marchShader = /* glsl */`
  precision highp float;
  #define VIEW_STEPS 8
  uniform sampler2D tSceneDepth;
  uniform float uFrame, uExtinction, uScatterGain, uShaftStrength;
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
        float a = smoothstep(0.52, 0.86, fibre) * patches * 0.36;
        // A thin sheet thickens toward the horizon with the slant path.
        float slant = max(abs(dot(rd, p / length(p))), 0.16);
        cirrusA = 1.0 - pow(1.0 - a, 1.0 / slant);
        float day = smoothstep(-0.12, 0.12, dot(p / length(p), sunDirection));
        float ecl = eclipsing ? eclipseVisibility(p, sunDirection) : 1.0;
        day *= mix(0.3, 1.0, ecl);
        cirrusL = (irradiance * sunAt(p, sunDirection) * ecl * mix(hgPhase(mu, 0.7), 0.0796, 0.55) * uScatterGain * 0.9
          + irradiance1 * sunAt(p, sunDirection1) * (eclipsing ? eclipseVisibility(p, sunDirection1) : 1.0) * mix(hgPhase(mu1, 0.7), 0.0796, 0.55) * uScatterGain * 0.9
          + irradiance * vec3(0.045, 0.062, 0.095) * (0.25 + 0.75 * day)) * uCloudTint;
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
      t1 = min(t1, t0 + 320000.0);
      float span = t1 - t0;
      // Weather is looked up where the sample is, every few kilometres of
      // travel. Interpolating a handful of samples across the whole ray made
      // a cloud's existence depend on the view: it vanished as the camera moved.
      float coverMax = 1.0;
      vec2 weather = vec2(0.0);
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
        for (int i = 0; i < MARCH_STEPS; i++) {
          if (t > t1) break;
          float dt = max(dmin, 0.055 * (t - t0));
          vec3 p = ro + rd * t;
          if (t - tWeather > 3500.0) { weather = weatherAt(p); tWeather = t; }
          float rp = length(p);
          float above = rp - (uShellBase + weather.y + uShellDepth);
          if (above > 200.0) {
            // Reaching the local tops takes at least above/down along a straight ray.
            t += clamp(0.8 * above / max(-dot(rd, p / rp), 0.08), dt, 6000.0);
            continue;
          }
          float cov = weather.x;
          float near = sat(1.0 - t / 28000.0);
          // Fade octaves the growing step can no longer resolve.
          // (by step length along grazing rays, by distance when looking down from orbit)
          gFarSmall = max(smoothstep(2.2, 6.0, dt / 500.0), smoothstep(150000.0, 500000.0, t));
          gFarWide = max(smoothstep(1.2, 3.5, dt / 3000.0), smoothstep(1500000.0, 4000000.0, t));
          gFarSmall = max(gFarSmall, edgeOn);
          gFarWide = max(gFarWide, edgeOn * 0.7);
          float d = cov < 0.03 ? 0.0 : cloudDensity(p, cov, near > 0.0 ? 2 : 1, near, weather.y);
          float crown = gCrown;
          if (d > 0.002) {
            if (tFront < 0.0) tFront = t;
            float h = sat((length(p) - uShellBase - weather.y) / uShellDepth);
            // Optical depth toward the sun: five growing steps reaching ~7 km, far
            // enough for a tower to shade the cumulus beside it.
            float tau = 0.0, ls = 300.0;
            vec3 pl = p;
            for (int j = 0; j < 5; j++) { pl += sunDirection * ls; tau += cloudDensity(pl, cov, 0, 0.0, weather.y) * ls; ls *= 1.9; }
            tau *= uExtinction;
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
const resolveShader = /* glsl */`
  precision highp float;
  uniform sampler2D tCurrent, tCurrentAux, tHistory;
  uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal, uPrevProjection;
  uniform mat3 uPrevLocalToView;
  uniform vec3 uCameraDelta;
  uniform vec2 uCloudTexel, uSubpixel;
  uniform float uHistoryWeight, uCurrentWeight;
  varying vec2 vUv;
  void main() {
    vec2 size = 1.0 / uCloudTexel;
    vec2 st = vUv * size - 0.5 - uSubpixel;
    vec2 cellF = clamp(floor(st + 0.5), vec2(0.0), size - 1.0);
    ivec2 cell = ivec2(cellF);
    vec2 off = st - cellF;
    vec4 nearest = texelFetch(tCurrent, cell, 0);
    vec4 spatial = texture2D(tCurrent, vUv - uSubpixel * uCloudTexel);
    if (uHistoryWeight <= 0.0) { gl_FragColor = spatial; return; }
    vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
    vec3 rd = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
    // Clear sky reprojects as a far point so the history follows rotation.
    float km = texelFetch(tCurrentAux, cell, 0).z;
    float distance = km > 0.0 ? km * 1000.0 : 150000.0;
    // The camera offset is formed on the CPU in double precision.
    vec3 previousView = uPrevLocalToView * (uCameraDelta + rd * distance);
    vec4 clip = uPrevProjection * vec4(previousView, 1.0);
    vec2 uv = clip.xy / max(clip.w, 1e-6) * 0.5 + 0.5;
    if (!(clip.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0)) { gl_FragColor = spatial; return; }
    vec4 history = texture2D(tHistory, uv);
    // Screen motion of this point since last frame, in march texels.
    float motion = length((uv - vUv) * size);
    // Keep history inside what the current 3x3 neighbourhood allows: this
    // bounds ghosting when clouds are revealed, relit or the camera cuts.
    vec4 lo = nearest, hi = nearest;
    ivec2 maxCell = ivec2(size) - 1;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec4 n = texelFetch(tCurrent, clamp(cell + ivec2(x, y), ivec2(0), maxCell), 0);
      lo = min(lo, n); hi = max(hi, n);
    }
    vec4 pad = (hi - lo) * 0.25 + vec4(vec3(0.02), 0.01);
    history = clamp(history, lo - pad, hi + pad);
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
  // Cloud in front of a surface at the given distance, for one low-res texel:
  // opacity grows from the texel's cloud front over its optical depth, with
  // at least ~600 m of fog so a ridge never cuts a cloud along a hard line.
  float frontCoverage(vec3 aux, float distance) {
    return distance <= aux.x ? 0.0 : 1.0 - exp(-2.2 * (distance - aux.x) / max(aux.z - aux.x, 600.0));
  }
  void main() {
    vec4 base = texture2D(tBase, vUv);
    vec4 cloud = texture2D(tCloud, vUv);
    // Distant clouds are sampled by long jittered steps; a small tent filter
    // there trades invisible detail for a clean horizon.
    float far = smoothstep(15.0, 70.0, texture2D(tCloudAux, vUv).x);
    if (far > 0.0) {
      vec2 o = uHistTexel * 2.2;
      vec4 blurred = (cloud * 2.0 + texture2D(tCloud, vUv + o) + texture2D(tCloud, vUv - o)
        + texture2D(tCloud, vUv + vec2(o.x, -o.y)) + texture2D(tCloud, vUv + vec2(-o.x, o.y))) / 6.0;
      cloud = mix(cloud, blurred, far * 0.15);
    }
    float coverage = 1.0, shade = 1.0;
    float sceneDepth = texture2D(tSceneDepth, vUv).x;
    if (sceneDepth < 0.999999) {
      // Opaque geometry: keep the fraction of the cloud column in front of it.
      vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
      float distance = (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005);
      // Depth-aware upsample. Each of the four surrounding low-res texels
      // decides how much of its own cloud lies in front of this surface, and
      // the results are blended bilinearly. One shared front distance (the
      // old min of four) switched the whole cloud on or off per texel and drew
      // the low-res grid as blocks along every ridge and coast.
      // The depth range is coarse (march resolution, on this frame's shifted
      // grid); the colour comes from the fine history.
      vec2 st = vUv / uCloudTexel - 0.5 - uSubpixel;
      vec2 cell = floor(st), f = st - cell;
      vec4 ws = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
      // A texel whose ray met no cloud knows nothing about depth order. It
      // used to vote "behind" and erase the fine history's cloud wherever
      // this frame's shifted grid happened to miss it: a 4-frame flicker on
      // every thin edge. Only texels that saw cloud vote.
      float inFront = 0.0, votes = 0.0;
      for (int k = 0; k < 4; k++) {
        vec2 o = vec2(float(k - (k / 2) * 2), float(k / 2));
        vec2 uv = (cell + o + 0.5 + uSubpixel) * uCloudTexel;
        vec3 aux = texture2D(tCloudAux, uv).xyz;
        if (aux.z > 0.0) { inFront += ws[k] * frontCoverage(aux * 1000.0, distance); votes += ws[k]; }
      }
      // No vote at all: from above the deck every cloud lies in front of the
      // ground; from below, keep the surface.
      inFront = votes > 1e-3 ? inFront / votes : (length(uCameraLocal) > uShellTop ? 1.0 : 0.0);
      cloud = vec4(cloud.rgb * inFront, 1.0 - (1.0 - cloud.a) * inFront);
      coverage = 1.0;
      if (uShadowOn > 0.5) {
        // Surfaces under the clouds lose their direct sun to the cloud column.
        vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
        vec3 p = uCameraLocal + normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz) * distance;
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

    const air = atmospherePass.material.uniforms;
    const field = {
      uNoise: { value: null },
      uCloudTex: { value: null },
      uCloudMat: { value: new THREE.Matrix3() },
      uSynoptic: { value: 0 },
      uShellBase: { value: 1 },
      uShellTop: { value: 2 },
      uShellDepth: { value: 7600 },
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
    const extinction = { value: 0.0026 };
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
        tHistory: { value: null },
        uInvProjection: air.uInvProjection, uCameraWorld: air.uCameraWorld, uWorldToLocal: air.uWorldToLocal,
        uPrevProjection: { value: new THREE.Matrix4() },
        uPrevLocalToView: { value: new THREE.Matrix3() },
        uCameraDelta: { value: new THREE.Vector3() },
        uCloudTexel: marchTexel,
        uSubpixel: subpixel,
        uHistoryWeight: { value: 0 },
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
        u.uShellTop.value = next.R + base + 7600 + maxLift;
        u.uCloudTint.value.set(next.type === 'toxic' ? 0xc8e890 : 0xffffff);
        this.layerMeters = { base, top: base + 7600 };
      }
    }
    this.#refresh();
  }

  #refresh() {
    const planet = this.activePlanet;
    this.enabled = Boolean(planet && this.visualEnabled && planet.cloudVisualEnabled !== false);
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
    // A teleport, a body change or a resize starts the history over.
    const continuous = this.temporalEnabled && this.historyValid && planet === this.previousPlanet
      && r.uCameraDelta.value.length() < 20000
      && _sun.copy(u.uSunDirection0.value).normalize().dot(this.previousSun) > 0.99985;
    r.uHistoryWeight.value = continuous ? 1 : 0;
    r.uCurrentWeight.value = ratio === 2 ? 0.22 : 0.1;
    const read = this.history[this.historyIndex], write = this.history[1 - this.historyIndex];
    r.tHistory.value = read.texture;
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
