// True volumetric clouds: a raymarched shell between two radii around the
// planet. Coverage reuses the SAME field as the impostor deck, the terrain's
// cast shadows and the CPU transit fog — one cloudscape, four consumers.
// Shape and erosion come from a small tileable 3D noise texture; lighting is
// a short sun march with Beer extinction, a powder term and an HG phase.
// Everything is driven by the planet's cloud spin (frozen under ?freeze=1),
// so the seam test's static frames stay static.

import * as THREE from 'three';
import { hash3i, hashFloat } from './rng.js';

let _noiseTex = null;

// wrapped-lattice value noise → guaranteed tiling in all three axes
function valueNoise3(x, y, z, N, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const v = (ix, iy, iz) => hashFloat(hash3i(((ix % N) + N) % N, ((iy % N) + N) % N, ((iz % N) + N) % N, seed), 0);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(v(xi, yi, zi), v(xi + 1, yi, zi), sx), lerp(v(xi, yi + 1, zi), v(xi + 1, yi + 1, zi), sx), sy),
    lerp(lerp(v(xi, yi, zi + 1), v(xi + 1, yi, zi + 1), sx), lerp(v(xi, yi + 1, zi + 1), v(xi + 1, yi + 1, zi + 1), sx), sy),
    sz);
}

// wrapped worley (cellular): distance to nearest feature point on a wrapped
// lattice — inverted it reads as billowing cauliflower lobes
function worley3(x, y, z, N, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 8;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const h = hash3i(((cx % N) + N) % N, ((cy % N) + N) % N, ((cz % N) + N) % N, seed);
        const px = cx + hashFloat(h, 0), py = cy + hashFloat(h, 1), pz = cz + hashFloat(h, 2);
        const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z);
        if (d < best) best = d;
      }
    }
  }
  return Math.min(1, Math.sqrt(best));
}

// 64³ RG texture: R = perlin-worley base lobes, G = high-frequency erosion.
// The larger volume removes the chunky cellular blocks visible from orbit.
export function cloudNoiseTexture() {
  if (_noiseTex) return _noiseTex;
  const S = 64;
  const data = new Uint8Array(S * S * S * 2);
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S, w = z / S;
        let f = 0, amp = 0.55, fr = 3;
        for (let o = 0; o < 3; o++) {
          f += valueNoise3(u * fr, v * fr, w * fr, fr, 0x51 + o) * amp;
          amp *= 0.5; fr *= 2;
        }
        const lobes = 1 - worley3(u * 5, v * 5, w * 5, 5, 0xC1);
        const base = Math.min(1, Math.max(0, f * 0.55 + lobes * 0.6));
        const ero = 1 - worley3(u * 9, v * 9, w * 9, 9, 0xE3) * 0.6
          - worley3(u * 17, v * 17, w * 17, 17, 0xE7) * 0.4;
        const k = (z * S * S + y * S + x) * 2;
        data[k] = base * 255;
        data[k + 1] = Math.min(1, Math.max(0, ero)) * 255;
      }
    }
  }
  _noiseTex = new THREE.Data3DTexture(data, S, S, S);
  _noiseTex.format = THREE.RGFormat;
  _noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  _noiseTex.magFilter = THREE.LinearFilter;
  _noiseTex.wrapS = _noiseTex.wrapT = _noiseTex.wrapR = THREE.RepeatWrapping;
  _noiseTex.generateMipmaps = true;
  _noiseTex.needsUpdate = true;
  return _noiseTex;
}

// Release the module-level 3D noise texture. For full-session teardown only
// (context-loss recovery, hot-reload) — every cloud ShaderMaterial that
// referenced this texture must itself be disposed first, since disposing
// here invalidates the GPU handle for all existing references.
export function disposeCloudNoiseTexture() {
  if (_noiseTex) { _noiseTex.dispose(); _noiseTex = null; }
}

function stormCenters(offX, offY, offZ) {
  const a = new THREE.Vector3(
    Math.sin(offX * 1.31 + 0.4),
    Math.sin(offY * 1.17 - 1.2) * 0.72,
    Math.cos(offZ * 1.43 + 0.7),
  ).normalize();
  const ref = Math.abs(a.y) < 0.8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const b = new THREE.Vector3().crossVectors(a, ref).addScaledVector(a, 0.16).normalize();
  return [a, b];
}

export function makeCloudVolumeMaterial(planet, band, detailTex, _weatherMap,
  { quality = 'high' } = {}) {
  const thick = band.rOut - band.rIn;
  const qualityValue = quality === 'low' ? 0 : 1;
  const [stormA, stormB] = stormCenters(band.ox, band.oy, band.oz);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    uniforms: {
      uNoise3: { value: cloudNoiseTexture() },
      uCloudNoise: { value: detailTex },
      uCov0: { value: band.cov0 },
      uCov1: { value: band.cov1 },
      uCOff: { value: new THREE.Vector3(band.ox, band.oy, band.oz) },
      uStormA: { value: stormA },
      uStormB: { value: stormB },
      uCameraLocal: { value: new THREE.Vector3() },
      uSpin: { value: new THREE.Matrix3() },       // same rotation as the shadows
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uRin: { value: band.rIn },
      uRout: { value: band.rOut },
      uGroundR: { value: planet.R + Math.max(0, planet.seaLevel || 0) },
      tSceneDepth: { value: null },
      uDepthReady: { value: 0 },
      uCameraFar: { value: 1.2e11 },
      uVolumeSize: { value: new THREE.Vector2(1, 1) },
      uSunC: { value: new THREE.Color(1, 0.98, 0.94) },
      uAmbC: { value: new THREE.Color(0.35, 0.42, 0.55) },
      uTint: { value: new THREE.Color(band.tint || 0xffffff) },
      uEngage: { value: 0 },
      uFrame: { value: 0 },
      // Both tiers execute this exact material and density field. The quality
      // value changes integration cost only; cloud placement and coverage do
      // not depend on it.
      uQuality: { value: qualityValue },
      // Camera proximity factor in [0,1]: 1 = close enough that individual
      // billows resolve on screen (full march cost), 0 = far enough that cloud
      // detail is sub-pixel (reduced march cost). Coverage, footprint and
      // silhouette are independent of this — only raymarch sample count and
      // the third sun-march lookup are gated, so distant frames stay
      // visually identical while costing a fraction of the close-up shader.
      uCamProx: { value: 1 },
    },
    vertexShader: /* glsl */`
      uniform vec3 uCameraLocal;
      varying vec3 vDirection;
      varying vec3 vViewDirection;
      void main() {
        vDirection = position - uCameraLocal;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDirection = viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp sampler3D;
      uniform sampler3D uNoise3;
      uniform sampler2D uCloudNoise;
      uniform sampler2D tSceneDepth;
      uniform float uCov0, uCov1, uRin, uRout, uGroundR, uEngage, uFrame, uQuality, uCamProx;
      uniform float uDepthReady, uCameraFar;
      uniform vec2 uVolumeSize;
      uniform vec3 uCOff, uStormA, uStormB, uCameraLocal, uSunDir, uSunC, uAmbC, uTint;
      uniform mat3 uSpin;
      varying vec3 vDirection;
      varying vec3 vViewDirection;

      // the SAME coverage fbm the impostor deck, terrain shadows and the CPU
      // transit fog use — one sky, everywhere. Explicit LOD: implicit
      // derivatives are UNDEFINED in the divergent march loop and flicker.
      float cloudFbm(vec3 d) {
        float f = textureLod(uCloudNoise, d.xy * 0.55 + uCOff.xy, 0.0).g * 0.5;
        f += textureLod(uCloudNoise, d.yz * 1.15 + uCOff.yz, 0.0).r * 0.25;
        f += textureLod(uCloudNoise, d.zx * 2.35 + uCOff.zx, 0.0).g * 0.125;
        f += textureLod(uCloudNoise, d.xy * 4.8 - uCOff.xz, 0.0).r * 0.0625;
        return f / 0.9375;
      }

      float stormAt(vec3 d, vec3 center, float phase, float radius) {
        vec3 ref = abs(center.y) < 0.88 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 ta = normalize(cross(ref, center));
        vec3 tb = normalize(cross(center, ta));
        float z = clamp(dot(d, center), -1.0, 1.0);
        float x = dot(d, ta), y = dot(d, tb);
        float inv = 1.0 / max(x * x + y * y, 1e-5);
        float sin2 = 2.0 * x * y * inv;
        float cos2 = (x * x - y * y) * inv;
        float r = sqrt(max(0.0, 2.0 * (1.0 - z))) / radius;
        float shield = (1.0 - smoothstep(0.08, 0.5, r)) * 0.58;
        float turn = phase - r * 13.0;
        float arms = smoothstep(0.66, 0.94,
          0.5 + 0.5 * (sin2 * cos(turn) + cos2 * sin(turn)));
        arms *= smoothstep(0.1, 0.24, r) * (1.0 - smoothstep(0.62, 1.0, r));
        return max(shield, arms);
      }

      float weatherSystem(vec3 d) {
        return max(stormAt(d, uStormA, uCOff.z, 0.92),
          stormAt(d, uStormB, uCOff.x + uCOff.y, 0.68) * 0.72);
      }

      vec2 sphereHits(vec3 origin, float r, vec3 dir) {
        float b = dot(origin, dir);
        float disc = b * b - dot(origin, origin) + r * r;
        if (disc < 0.0) return vec2(-1.0);
        float s = sqrt(disc);
        return vec2(-b - s, -b + s);
      }

      float sceneRayLimit() {
        if (uDepthReady < 0.5) return 1e20;
        vec2 uv = gl_FragCoord.xy / max(uVolumeSize, vec2(1.0));
        float depth = texture2D(tSceneDepth, clamp(uv, 0.0, 1.0)).x;
        if (depth >= 0.999999) return 1e20;
        // Three.js logarithmic depth: depth = log2(1 + clipW)/log2(1 + far).
        float forwardDistance = pow(uCameraFar + 1.0, depth) - 1.0;
        float forwardCos = max(-normalize(vViewDirection).z, 0.035);
        return forwardDistance / forwardCos;
      }

      float densityAt(vec3 local, float covScale, float systemMask) {
        float r = length(local);
        float h = clamp((r - uRin) / (uRout - uRin), 0.0, 1.0);
        vec3 radial = local / r;
        vec3 tangentA = normalize(cross(radial,
          abs(radial.y) < 0.88 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 tangentB = normalize(cross(radial, tangentA));
        float bend = h - 0.42;
        // A cloud footprint must not be the same 2D mask extruded straight
        // through the whole shell. Shift it laterally with altitude so anvils,
        // shelves and tilted billows replace the former vertical curtains.
        vec3 coverageDir = normalize(radial
          + tangentA * bend * 0.02
          + tangentB * (bend * bend - 0.08) * 0.015);
        vec3 sd = uSpin * coverageDir;
        float fine = cloudFbm(sd);
        // Preserve the complete analytic weather footprint. Earlier the
        // volume raised this mask to 1.42 and then gated it again with Worley,
        // deleting most clouds that were visible in the orbit deck.
        float baseWeather = pow(smoothstep(uCov0, uCov1, fine), 0.92);
        float largeSystem = systemMask * smoothstep(0.24, 0.68, fine) * 0.86;
        float cov = max(baseWeather, largeSystem) * covScale;
        if (cov < 0.01) return 0.0;
        vec3 warp = vec3(
          textureLod(uCloudNoise, sd.yz * 3.1 + uCOff.xy, 0.0).r,
          textureLod(uCloudNoise, sd.zx * 3.7 + uCOff.yz, 0.0).g,
          textureLod(uCloudNoise, sd.xy * 4.3 - uCOff.xz, 0.0).r
        ) - 0.5;
        // Sample the base volume in a spherical weather frame: horizontal
        // scale follows the planet surface while height travels through a
        // separate oblique noise axis. Sampling raw world metres here made
        // ray steps line up into long radial brush strokes.
        // Planet-scale billows first; fine Worley erosion is added below.
        // Using a fixed 26 km cell size repeated identical popcorn all around
        // a large world and closed into a bright ring at the limb.
        vec3 q = uSpin * radial * (uRin / 118000.0)
          + vec3(0.37, 0.71, 0.53) * (h * 2.7)
          + warp * 1.4;
        vec2 n = textureLod(uNoise3, q, 0.8).rg;
        // Locally varied floor and ceiling prevent a single hard lower edge.
        float floorH = 0.025 + (1.0 - n.g) * 0.13;
        float ceilH = 0.44 + cov * 0.34 + (n.r - 0.5) * 0.18;
        float lowerProfile = smoothstep(floorH, floorH + 0.14, h)
          * (1.0 - smoothstep(ceilH - 0.18, ceilH, h));
        // Deep weather systems build a distinct, broad upper shelf. It shares
        // the same footprint and 3D field as the lower cloud, but a displaced
        // vertical profile creates towers, anvils and gaps instead of one
        // uniformly extruded layer.
        vec2 upperNoise = textureLod(uNoise3,
          q * 1.72 + vec3(5.7, 2.3, 8.1), 1.15).rg;
        float upperSource = smoothstep(0.28, 0.76, systemMask)
          * smoothstep(0.26, 0.74, cov);
        float upperFloor = 0.48 + (upperNoise.g - 0.5) * 0.12;
        float upperCeil = 0.91 + (upperNoise.r - 0.5) * 0.10;
        float upperProfile = smoothstep(upperFloor, upperFloor + 0.11, h)
          * (1.0 - smoothstep(upperCeil - 0.11, upperCeil, h));
        // Sparse high-altitude filaments soften storm tops without inventing
        // a second camera-facing weather map.
        float wisp = smoothstep(0.58, 0.88, upperNoise.g)
          * smoothstep(0.62, 0.73, h) * (1.0 - smoothstep(0.91, 0.99, h));
        // 3D noise shapes density inside the footprint; it must not decide
        // whether the footprint exists. A non-zero floor gives broad cloud
        // bodies real depth while Worley still sculpts billowing edges.
        float cells = mix(0.58, 1.22, smoothstep(0.18, 0.82, n.r));
        float verticalShape = max(lowerProfile * cells,
          upperSource * upperProfile * (0.54 + upperNoise.r * 0.52));
        verticalShape = max(verticalShape, upperSource * wisp * 0.34);
        float d = cov * verticalShape;
        float ero = textureLod(uNoise3, q * 3.15, 1.25).g;
        d = clamp(d - (1.0 - ero) * 0.10 * (1.0 - d), 0.0, 1.0);
        return smoothstep(0.018, 0.46, d);
      }

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        if (uEngage < 0.01) discard;
        vec3 dir = normalize(vDirection);
        vec2 outer = sphereHits(uCameraLocal, uRout, dir);
        if (outer.y <= 0.0) discard;
        vec2 inner = sphereHits(uCameraLocal, uRin, dir);
        // march the FIRST pass through the shell only (the re-entry segment
        // on the far side is behind the planet for any ray that matters)
        float t0 = max(outer.x, 0.0);
        float t1 = (inner.x > 0.0) ? inner.x : outer.y;
        float camR = length(uCameraLocal);
        if (camR < uRin && inner.y > 0.0) { t0 = max(inner.y, 0.0); t1 = outer.y; }
        // From below the cloud base, rays aimed into the planet reach terrain
        // before reaching any cloud. Without this occlusion test the far-side
        // shell was integrated over the foreground and looked like a full-
        // screen cloud card.
        vec2 ground = sphereHits(uCameraLocal, uGroundR, dir);
        if (ground.x > 0.0) {
          if (ground.x <= t0) discard;
          t1 = min(t1, ground.x);
        }
        // Stop the ray at the first opaque scene surface. Trees, rocks,
        // terrain and the ship now occlude the volume instead of receiving a
        // half-resolution cloud layer over their silhouettes.
        t1 = min(t1, sceneRayLimit() + 1.5);
        t1 = min(t1, t0 + (uRout - uRin) * 6.5);   // grazing rays: bounded cost
        if (t1 <= t0) discard;

        float seg = t1 - t0;
        float thick = uRout - uRin;
        // This material is rendered by the half-resolution temporal volume
        // pass. A fresh jittered 44–84 sample signal reconstructs more cleanly
        // than 120 static steps and avoids the old grazing-angle brush tails.
        // uCamProx reduces sample count when the camera is far enough that
        // individual billows are sub-pixel: at uCamProx=1 the high tier keeps
        // its authored 46–88 step range; at uCamProx=0 it drops to the low
        // tier's 28–52 step range. Silhouette and coverage come from the same
        // density field regardless of step count, so distant frames remain
        // visually equivalent while the raymarch cost falls by ~40%.
        float tierMin = mix(28.0, 46.0, uQuality);
        float tierMax = mix(52.0, 88.0, uQuality);
        float lowMin = 28.0;
        float lowMax = 52.0;
        float minSteps = mix(lowMin, tierMin, uCamProx);
        float maxSteps = mix(lowMax, tierMax, uCamProx);
        float stride = mix(0.052, mix(0.052, 0.032, uQuality), uCamProx);
        int STEPS = int(clamp(seg / (thick * stride), minSteps, maxSteps));
        float dt = seg / float(STEPS);
        float framePhase = mod(uFrame, 16.0);
        float jitter = hash12(gl_FragCoord.xy
          + vec2(framePhase * 19.19, framePhase * 7.73));
        float t = t0 + dt * jitter;
        // A weather system spans hundreds of kilometres while this shell is
        // only kilometres thick. Evaluate its footprint once per pixel; the
        // 3D billows, erosion and vertical profile still vary at every step.
        vec3 systemDir = uSpin * normalize(uCameraLocal + dir * ((t0 + t1) * 0.5));
        float systemMask = weatherSystem(systemDir);

        float sigma = 6.4 / thick;                  // extinction scale
        float mu = dot(dir, uSunDir);
        float hg = (1.0 - 0.28) / (12.566 * pow(1.0 + 0.28 - 1.06 * mu, 1.5));
        float back = (1.0 - 0.16) / (12.566 * pow(1.0 + 0.16 + 0.8 * mu, 1.5));
        float phase = mix(0.0796, hg * 3.35 + back * 0.5, 0.76);

        vec3 col = vec3(0.0);
        float T = 1.0;
        for (int i = 0; i < 124; i++) {
          if (i >= STEPS || T < 0.02) break;
          vec3 local = uCameraLocal + dir * t;
          float d = densityAt(local, 1.0, systemMask);
          if (d > 0.003) {
            // short sun march: how buried is this sample?
            float od = 0.0;
            float ls = thick * 0.35;
            od += densityAt(local + uSunDir * ls * 0.6, 1.0, systemMask) * ls * 0.6;
            od += densityAt(local + uSunDir * ls * 1.5, 1.0, systemMask) * ls * 0.9;
            if (uQuality > 0.5 && uCamProx > 0.35) {
              od += densityAt(local + uSunDir * ls * 2.8, 1.0, systemMask) * ls * 1.3;
            } else {
              // Preserve approximately the same optical depth with one fewer
              // lookup on the low tier (or when the camera is far enough that
              // the third self-shadow sample is below perceptual threshold), so
              // the silhouette and coverage stay stable while only fine
              // self-shadow detail is reduced.
              od *= 1.18;
            }
            float Tsun = exp(-od * sigma * 0.9);
            float powder = 1.0 - exp(-d * sigma * dt * 2.0);
            float hFrac = clamp((length(local) - uRin) / thick, 0.0, 1.0);
            float silver = pow(Tsun, 2.4) * pow(max(mu, 0.0), 3.0)
              * (1.0 - smoothstep(0.56, 0.96, d));
            vec3 s = uSunC * (Tsun * phase * 13.2 + silver * 0.82)
              + uAmbC * (0.42 + 0.62 * hFrac) * (0.72 + Tsun * 0.28);
            float a = 1.0 - exp(-d * sigma * dt);
            col += T * a * s * powder * uTint;
            T *= 1.0 - a;
          }
          t += dt;
        }
        float alpha = (1.0 - T) * uEngage;
        if (alpha < 0.004) discard;

        // RGB is already front-to-back integrated (premultiplied).
        gl_FragColor = vec4(col * uEngage, alpha);
      }`,
  });
  mat.userData.band = band;
  return mat;
}
