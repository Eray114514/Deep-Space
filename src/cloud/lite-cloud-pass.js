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
  uniform float uSynoptic, uShellBase, uShellTop, uShellDepth, uSurfaceRange, uLiftBase, uLiftOn;
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
    if (uSynoptic > 0.5) c = synopticCoverage(c, 0.12);
    float breakup = textureLod(uNoise, q / 93000.0, 0.0).b;
    c = sat(c * 1.12 + (breakup - 0.5) * 0.55 - 0.06);
    // Mesoscale regimes inside a weather system: closed decks with cracks
    // alternate with broken, open-cell fields instead of one uniform texture.
    float regime = textureLod(uNoise, q.yzx / 310000.0 + 0.61, 0.0).b;
    float lift = 0.0;
    if (uLiftOn > 0.5) {
      float surface = (weatherAtlasSample(uSurfaceTex, p).g * 2.0 - 1.0) * uSurfaceRange;
      lift = max(surface + 1300.0 - uLiftBase, 0.0);
    }
    return vec2(c * mix(0.42, 0.95, smoothstep(0.34, 0.66, regime)), lift);
  }

  // Distance fades set by the view march. A step grows with distance, so
  // octaves smaller than the step are faded out instead of being sampled as
  // noise: gFarSmall drops the 2-3 km cumulus, gFarWide the 9 km cells.
  float gFarSmall = 0.0, gFarWide = 0.0;

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
    float top = mix(0.42, 1.0, smoothstep(0.3, 0.72, thick)) * mix(0.5, 1.0, base * base);
    // Every small cumulus is its own dome and carries finer bumps: seen from
    // above the deck is a relief of lit tops and shaded gaps, not a flat sheet.
    if (fine > 0.0) top *= 1.0 - fine * (0.34 * (1.0 - small) + 0.2 * (1.0 - textureLod(uNoise, q / 7300.0, 0.0).g));
    float profile = smoothstep(0.0, 0.07, h) * smoothstep(top, top * 0.45, h);
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
    return pow(d, 1.35) * cov * 1.3;
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
    vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
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

    // ---- Light shafts. The atmosphere pass lit all the air as if the sky
    // were clear. Below the clouds, take back the primary sun's single
    // scattering wherever the air sits in a cloud shadow.
    if (uShadowOn > 0.5 && r0 < uShellBase) {
      float tMax = min(inner.y, 90000.0);
      float sceneDepth = texture2D(tSceneDepth, vUv).x;
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
      gShaft = vec4(loss * uShaftStrength * smoothstep(uShellBase, uShellBase - 700.0, r0), 1.0);
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
        cirrusL = (irradiance * sunAt(p, sunDirection) * mix(hgPhase(mu, 0.7), 0.0796, 0.55) * uScatterGain * 0.9
          + irradiance1 * sunAt(p, sunDirection1) * mix(hgPhase(mu1, 0.7), 0.0796, 0.55) * uScatterGain * 0.9
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
        for (int i = 0; i < MARCH_STEPS; i++) {
          if (t > t1) break;
          float dt = max(dmin, 0.055 * (t - t0));
          vec3 p = ro + rd * t;
          if (t - tWeather > 3500.0) { weather = weatherAt(p); tWeather = t; }
          float cov = weather.x;
          float near = sat(1.0 - t / 28000.0);
          // Fade octaves the growing step can no longer resolve.
          // (by step length along grazing rays, by distance when looking down from orbit)
          gFarSmall = max(smoothstep(2.2, 6.0, dt / 500.0), smoothstep(80000.0, 220000.0, t));
          gFarWide = max(smoothstep(1.2, 3.5, dt / 3000.0), smoothstep(300000.0, 700000.0, t));
          float d = cov < 0.03 ? 0.0 : cloudDensity(p, cov, near > 0.0 ? 2 : 1, near, weather.y);
          if (d > 0.002) {
            if (tFront < 0.0) tFront = t;
            float h = sat((length(p) - uShellBase - weather.y) / uShellDepth);
            // Optical depth toward the sun: four growing steps.
            float tau = 0.0, ls = 320.0;
            vec3 pl = p;
            for (int j = 0; j < 4; j++) { pl += sunDirection * ls; tau += cloudDensity(pl, cov, 0, 0.0, weather.y) * ls; ls *= 1.8; }
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
            float powder = mix(1.0, 1.0 - exp(-tau * 2.0 - d * 3.0), 0.35 * sat(0.5 - 0.5 * mu) + 0.15);
            // The companion star reuses the primary's optical depth (they are
            // rarely far apart in the sky) with its own phase and horizon.
            vec3 sun = irradiance * mix(sunNear, sunFar, sat((t - t0) / span)) * scatter * powder;
            if (uSunEnergy1 > 0.001) sun += irradiance1 * sunAt(p, sunDirection1) * scatter1 * powder;
            float day = smoothstep(-0.12, 0.12, dot(normalize(p), sunDirection));
            vec3 ambient = irradiance * mix(vec3(0.012, 0.017, 0.028), vec3(0.045, 0.062, 0.095), h)
              * (0.55 + 0.45 * exp(-d * 2.5)) * (0.25 + 0.75 * day);
            // Bases sit in their own shadow; tops catch the sun.
            vec3 source = (sun * uScatterGain * mix(0.5, 1.0, smoothstep(0.0, 0.55, h)) + ambient) * uCloudTint;
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

// Temporal resolve. Every frame marches with a different jitter phase; this
// pass reprojects last frame's result to where the cloud is now and blends,
// so the step noise averages out instead of sitting on screen as grain.
const resolveShader = /* glsl */`
  precision highp float;
  uniform sampler2D tCurrent, tCurrentAux, tHistory;
  uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal, uPrevProjection;
  uniform mat3 uPrevLocalToView;
  uniform vec3 uCameraDelta;
  uniform vec2 uCloudTexel;
  uniform float uHistoryWeight;
  varying vec2 vUv;
  void main() {
    vec4 current = texture2D(tCurrent, vUv);
    if (uHistoryWeight <= 0.0) { gl_FragColor = current; return; }
    vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
    vec3 rd = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
    // Clear sky reprojects as a far point so the history follows rotation.
    float km = texture2D(tCurrentAux, vUv).z;
    float distance = km > 0.0 ? km * 1000.0 : 150000.0;
    // The camera offset is formed on the CPU in double precision.
    vec3 previousView = uPrevLocalToView * (uCameraDelta + rd * distance);
    vec4 clip = uPrevProjection * vec4(previousView, 1.0);
    vec2 uv = clip.xy / max(clip.w, 1e-6) * 0.5 + 0.5;
    float valid = clip.w > 0.0 && uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 ? 1.0 : 0.0;
    vec4 history = texture2D(tHistory, uv);
    // Keep history inside what the current neighbourhood allows: this bounds
    // ghosting when clouds are revealed, lit differently or the camera cuts.
    vec4 a = texture2D(tCurrent, vUv + vec2(uCloudTexel.x, 0.0)), b = texture2D(tCurrent, vUv - vec2(uCloudTexel.x, 0.0));
    vec4 c = texture2D(tCurrent, vUv + vec2(0.0, uCloudTexel.y)), d = texture2D(tCurrent, vUv - vec2(0.0, uCloudTexel.y));
    vec4 lo = min(current, min(min(a, b), min(c, d))), hi = max(current, max(max(a, b), max(c, d)));
    vec4 pad = (hi - lo) * 0.6 + vec4(vec3(0.02), 0.01);
    history = clamp(history, lo - pad, hi + pad);
    gl_FragColor = mix(current, history, valid * uHistoryWeight);
  }`;

const compositeShader = /* glsl */`
  precision highp float;
  uniform sampler2D tBase, tSceneDepth, tCloud, tCloudAux, tShaft;
  uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal;
  uniform vec3 uCameraLocal, uSunDirection0;
  uniform float uCameraFar, uShellBase, uShadowFloor;
  uniform vec2 uCloudTexel;
  ${shadowLookupGLSL}
  varying vec2 vUv;
  void main() {
    vec4 base = texture2D(tBase, vUv);
    vec4 cloud = texture2D(tCloud, vUv);
    // Distant clouds are sampled by long jittered steps; a small tent filter
    // there trades invisible detail for a clean horizon.
    float far = smoothstep(15.0, 70.0, texture2D(tCloudAux, vUv).x);
    if (far > 0.0) {
      vec2 o = uCloudTexel * 1.1;
      vec4 blurred = (cloud * 2.0 + texture2D(tCloud, vUv + o) + texture2D(tCloud, vUv - o)
        + texture2D(tCloud, vUv + vec2(o.x, -o.y)) + texture2D(tCloud, vUv + vec2(-o.x, o.y))) / 6.0;
      cloud = mix(cloud, blurred, far * 0.5);
    }
    float coverage = 1.0, shade = 1.0;
    float sceneDepth = texture2D(tSceneDepth, vUv).x;
    if (sceneDepth < 0.999999) {
      // Opaque geometry: keep the fraction of the cloud column in front of it.
      vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
      float distance = (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005);
      vec2 aux = texture2D(tCloudAux, vUv).xy * 1000.0;
      coverage = smoothstep(aux.x, max(aux.y, aux.x + 1.0), distance);
      if (uShadowOn > 0.5) {
        // Surfaces under the clouds lose their direct sun to the cloud column.
        vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
        vec3 p = uCameraLocal + normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz) * distance;
        float r = length(p);
        float under = 1.0 - smoothstep(uShellBase, uShellBase + 2600.0, r);
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

    const air = atmospherePass.material.uniforms;
    const field = {
      uNoise: { value: null },
      uCloudTex: { value: null },
      uCloudMat: { value: new THREE.Matrix3() },
      uSynoptic: { value: 0 },
      uShellBase: { value: 1 },
      uShellTop: { value: 2 },
      uShellDepth: { value: 5200 },
      uSurfaceTex: { value: null },
      uSurfaceRange: { value: 1 },
      uLiftBase: { value: 0 },
      uLiftOn: { value: 0 },
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
        ...shadow,
        tBase: { value: null }, tSceneDepth: { value: null },
        tCloud: { value: this.target.textures[0] }, tCloudAux: { value: this.target.textures[1] },
        tShaft: { value: this.target.textures[2] },
        uInvProjection: air.uInvProjection, uCameraWorld: air.uCameraWorld, uWorldToLocal: air.uWorldToLocal,
        uCameraLocal: air.uCameraLocal, uSunDirection0: air.uSunDirection0, uCameraFar: air.uCameraFar,
        uShellBase: field.uShellBase,
        // Sky and bounce light left under a fully opaque cloud.
        uShadowFloor: { value: 0.4 },
        uCloudTexel: { value: new THREE.Vector2(1, 1) },
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
        uCloudTexel: this.compositeMaterial.uniforms.uCloudTexel,
        // 0.9 ≈ ten frames of accumulation.
        uHistoryWeight: { value: 0 },
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
        const synoptic = Boolean(next.weatherField?.synoptic && next.cloudWeatherHiTex);
        const highest = synoptic ? Number(next.weatherField.surfaceBoundsMeters?.[1]) || 0 : 0;
        const maxLift = synoptic ? THREE.MathUtils.clamp(highest + 1300 - base, 0, 9000) : 0;
        u.uLiftOn.value = synoptic ? 1 : 0;
        u.uLiftBase.value = base;
        u.uSurfaceRange.value = synoptic ? next.weatherField.surfaceRangeMeters || 1 : 1;
        u.uShellBase.value = next.R + base;
        u.uShellTop.value = next.R + base + 5200 + maxLift;
        u.uCloudTint.value.set(next.type === 'toxic' ? 0xc8e890 : 0xffffff);
        this.layerMeters = { base, top: base + 5200 };
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
    if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
      for (const target of this.history) target.setSize(width, height);
      this.historyValid = false;
    }

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
    c.uCloudTexel.value.set(1 / width, 1 / height);

    // Temporal resolve into the other history target.
    const r = this.resolveMaterial.uniforms;
    const cameraLocal = u.uCameraLocal.value;
    r.uCameraDelta.value.subVectors(cameraLocal, this.previousCamera);
    // A teleport, a body change or a resize starts the history over.
    const continuous = this.temporalEnabled && this.historyValid && planet === this.previousPlanet
      && r.uCameraDelta.value.length() < 20000;
    r.uHistoryWeight.value = continuous ? 0.9 : 0;
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
    c.tBase.value = readBuffer.texture;
    c.tSceneDepth.value = this.atmospherePass.sceneDepthTexture || readBuffer.depthTexture || null;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compositeQuad.render(renderer);
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
