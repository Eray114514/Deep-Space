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

// 48³ RG texture: R = perlin-worley base lobes, G = high-frequency erosion
export function cloudNoiseTexture() {
  if (_noiseTex) return _noiseTex;
  const S = 48;
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

// logDepthBufFC for the manual fragment-depth write (camera.far is fixed)
export function logDepthFC(far) { return 2.0 / (Math.log(far + 1.0) / Math.LN2); }

export function makeCloudVolumeMaterial(planet, band, detailTex, far) {
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
      uCenter: { value: new THREE.Vector3() },     // planet center, camera space
      uSpin: { value: new THREE.Matrix3() },       // same rotation as the shadows
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uRin: { value: band.rIn },
      uRout: { value: band.rOut },
      uSunC: { value: new THREE.Color(1, 0.98, 0.94) },
      uAmbC: { value: new THREE.Color(0.35, 0.42, 0.55) },
      uTint: { value: new THREE.Color(band.tint || 0xffffff) },
      uEngage: { value: 0 },
      uLogFC: { value: logDepthFC(far) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        // camera-relative rendering: the camera sits at the origin, so the
        // world position of a shell vertex IS the ray direction
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp sampler3D;
      uniform sampler3D uNoise3;
      uniform sampler2D uCloudNoise;
      uniform float uCov0, uCov1, uRin, uRout, uEngage, uLogFC;
      uniform vec3 uCOff, uCenter, uSunDir, uSunC, uAmbC, uTint;
      uniform mat3 uSpin;
      varying vec3 vDir;

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

      // both intersections of |p - C| = r along o=0 + t*dir
      vec2 sphereHits(vec3 C, float r, vec3 dir) {
        float b = dot(dir, C);
        float disc = b * b - dot(C, C) + r * r;
        if (disc < 0.0) return vec2(-1.0);
        float s = sqrt(disc);
        return vec2(b - s, b + s);
      }

      float densityAt(vec3 local, float covScale) {
        float r = length(local);
        float h = clamp((r - uRin) / (uRout - uRin), 0.0, 1.0);
        vec3 sd = uSpin * (local / r);
        float cov = smoothstep(uCov0, uCov1, cloudFbm(sd)) * covScale;
        if (cov < 0.01) return 0.0;
        // puffy bottoms, wispy tops; thicker coverage climbs higher
        float prof = smoothstep(0.0, 0.16, h) * (1.0 - smoothstep(0.45 + 0.4 * cov, 1.0, h));
        vec3 q = uSpin * local * ${(1 / 5200).toFixed(9)};
        vec2 n = textureLod(uNoise3, q, 0.0).rg;
        float d = clamp(cov * prof - (1.0 - n.r) * 0.42, 0.0, 1.0);
        float ero = textureLod(uNoise3, q * 3.7, 0.0).g;
        d = clamp(d - ero * 0.3 * (1.0 - d), 0.0, 1.0);
        return d;
      }

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        if (uEngage < 0.01) discard;
        vec3 dir = normalize(vDir);
        vec2 outer = sphereHits(uCenter, uRout, dir);
        if (outer.y <= 0.0) discard;
        vec2 inner = sphereHits(uCenter, uRin, dir);
        // march the FIRST pass through the shell only (the re-entry segment
        // on the far side is behind the planet for any ray that matters)
        float t0 = max(outer.x, 0.0);
        float t1 = (inner.x > 0.0) ? inner.x : outer.y;
        float camR = length(uCenter);
        if (camR < uRin && inner.y > 0.0) { t0 = max(inner.y, 0.0); t1 = outer.y; }
        t1 = min(t1, t0 + (uRout - uRin) * 14.0);   // grazing rays: bounded cost
        if (t1 <= t0) discard;

        float seg = t1 - t0;
        float thick = uRout - uRin;
        int STEPS = int(clamp(seg / (thick * 0.09), 14.0, 36.0));
        float dt = seg / float(STEPS);
        float jitter = hash12(gl_FragCoord.xy);
        float t = t0 + dt * jitter;

        float sigma = 5.2 / thick;                  // extinction scale
        float mu = dot(dir, uSunDir);
        float hg = (1.0 - 0.28) / (12.566 * pow(1.0 + 0.28 - 1.06 * mu, 1.5));
        float phase = mix(0.0796, hg * 3.4, 0.75);

        vec3 col = vec3(0.0);
        float T = 1.0;
        float tEntry = -1.0;
        for (int i = 0; i < 40; i++) {
          if (i >= STEPS || T < 0.02) break;
          vec3 p = dir * t;
          vec3 local = p - uCenter;
          float d = densityAt(local, 1.0);
          if (d > 0.003) {
            if (tEntry < 0.0) tEntry = t;
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

        // depth of the first REAL sample, so terrain correctly occludes far
        // clouds while the deck overhead still draws in front of mountains
        float w = max((tEntry > 0.0 ? tEntry : t0), 0.001);
        gl_FragDepth = log2(1.0 + w) * uLogFC * 0.5;
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  mat.userData.band = band;
  return mat;
}
