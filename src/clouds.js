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
  _noiseTex.minFilter = _noiseTex.magFilter = THREE.LinearFilter;
  _noiseTex.wrapS = _noiseTex.wrapT = _noiseTex.wrapR = THREE.RepeatWrapping;
  _noiseTex.needsUpdate = true;
  return _noiseTex;
}

export function makeCloudVolumeMaterial(planet, band, detailTex) {
  const thick = band.rOut - band.rIn;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    uniforms: {
      uNoise3: { value: cloudNoiseTexture() },
      uCloudNoise: { value: detailTex },
      uCov0: { value: band.cov0 },
      uCov1: { value: band.cov1 },
      uCOff: { value: new THREE.Vector3(band.ox, band.oy, band.oz) },
      uCameraLocal: { value: new THREE.Vector3() },
      uSpin: { value: new THREE.Matrix3() },       // same rotation as the shadows
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uRin: { value: band.rIn },
      uRout: { value: band.rOut },
      uSunC: { value: new THREE.Color(1, 0.98, 0.94) },
      uAmbC: { value: new THREE.Color(0.35, 0.42, 0.55) },
      uTint: { value: new THREE.Color(band.tint || 0xffffff) },
      uEngage: { value: 0 },
      uFrame: { value: 0 },
    },
    vertexShader: /* glsl */`
      uniform vec3 uCameraLocal;
      varying vec3 vDirection;
      void main() {
        vDirection = position - uCameraLocal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp sampler3D;
      uniform sampler3D uNoise3;
      uniform sampler2D uCloudNoise;
      uniform float uCov0, uCov1, uRin, uRout, uEngage, uFrame;
      uniform vec3 uCOff, uCameraLocal, uSunDir, uSunC, uAmbC, uTint;
      uniform mat3 uSpin;
      varying vec3 vDirection;

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

      vec2 sphereHits(vec3 origin, float r, vec3 dir) {
        float b = dot(origin, dir);
        float disc = b * b - dot(origin, origin) + r * r;
        if (disc < 0.0) return vec2(-1.0);
        float s = sqrt(disc);
        return vec2(-b - s, -b + s);
      }

      float densityAt(vec3 local, float covScale) {
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
          + tangentA * bend * 0.055
          + tangentB * (bend * bend - 0.08) * 0.045);
        vec3 sd = uSpin * coverageDir;
        float cov = smoothstep(uCov0, uCov1, cloudFbm(sd)) * covScale;
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
        vec3 q = uSpin * radial * (uRin / 26000.0)
          + vec3(0.37, 0.71, 0.53) * (h * 2.7)
          + warp * 1.4;
        vec2 n = textureLod(uNoise3, q, 0.0).rg;
        // Locally varied floor and ceiling prevent a single hard lower edge.
        float floorH = 0.025 + (1.0 - n.g) * 0.13;
        float ceilH = 0.48 + cov * 0.38 + (n.r - 0.5) * 0.18;
        float prof = smoothstep(floorH, floorH + 0.14, h)
          * (1.0 - smoothstep(ceilH - 0.18, ceilH, h));
        float cells = smoothstep(0.34, 0.72, n.r);
        float d = cov * prof * cells;
        float ero = textureLod(uNoise3, q * 3.15, 0.0).g;
        d = clamp(d - (1.0 - ero) * 0.22 * (1.0 - d), 0.0, 1.0);
        return smoothstep(0.035, 0.58, d);
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
        t1 = min(t1, t0 + (uRout - uRin) * 8.0);   // grazing rays: bounded cost
        if (t1 <= t0) discard;

        float seg = t1 - t0;
        float thick = uRout - uRin;
        int STEPS = int(clamp(seg / (thick * 0.024), 64.0, 120.0));
        float dt = seg / float(STEPS);
        // Static blue-noise-style jitter. Changing it every frame without a
        // temporal reprojection buffer produces crawling brush strokes.
        float jitter = hash12(gl_FragCoord.xy);
        float t = t0 + dt * jitter;

        float sigma = 6.4 / thick;                  // extinction scale
        float mu = dot(dir, uSunDir);
        float hg = (1.0 - 0.28) / (12.566 * pow(1.0 + 0.28 - 1.06 * mu, 1.5));
        float phase = mix(0.0796, hg * 3.4, 0.75);

        vec3 col = vec3(0.0);
        float T = 1.0;
        for (int i = 0; i < 124; i++) {
          if (i >= STEPS || T < 0.02) break;
          vec3 local = uCameraLocal + dir * t;
          float d = densityAt(local, 1.0);
          if (d > 0.003) {
            vec3 radial = normalize(local);
            vec3 ta = normalize(cross(radial,
              abs(radial.y) < 0.88 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
            vec3 tb = normalize(cross(radial, ta));
            float filterR = thick * 0.028;
            d = (d + densityAt(local + ta * filterR, 1.0)
              + densityAt(local + tb * filterR, 1.0)) / 3.0;
          }
          if (d > 0.003) {
            // short sun march: how buried is this sample?
            float od = 0.0;
            float ls = thick * 0.35;
            od += densityAt(local + uSunDir * ls * 0.6, 1.0) * ls * 0.6;
            od += densityAt(local + uSunDir * ls * 1.5, 1.0) * ls * 0.9;
            od += densityAt(local + uSunDir * ls * 3.0, 1.0) * ls * 1.5;
            float Tsun = exp(-od * sigma * 0.9);
            float powder = 1.0 - exp(-d * sigma * dt * 2.0);
            float hFrac = clamp((length(local) - uRin) / thick, 0.0, 1.0);
            vec3 s = uSunC * (Tsun * phase * 14.0) + uAmbC * (0.45 + 0.55 * hFrac);
            float a = 1.0 - exp(-d * sigma * dt);
            col += T * a * s * powder * uTint;
            T *= 1.0 - a;
          }
          t += dt;
        }
        float alpha = (1.0 - T) * uEngage;
        if (alpha < 0.004) discard;

        gl_FragColor = vec4(col, alpha);
      }`,
  });
  mat.userData.band = band;
  return mat;
}
