// True volumetric clouds: a raymarched shell between two radii around the
// planet. Coverage reuses the SAME field as the impostor deck, the terrain's
// cast shadows and the CPU transit fog — one cloudscape, four consumers.
// Shape and erosion come from a small tileable 3D noise texture; lighting is
// a short sun march with Beer extinction, a powder term and an HG phase.
// Everything is driven by the planet's cloud spin (frozen under ?freeze=1),
// so the seam test's static frames stay static.

import * as THREE from 'three';
import { hash3i, hashFloat, makeRng } from './rng.js';

let _noiseTex = null;
let _cloudSpriteTex = null;

function cloudSpriteTexture() {
  if (_cloudSpriteTex) return _cloudSpriteTex;
  _cloudSpriteTex = new THREE.TextureLoader().load('/public/assets/cloud-cumulus-atlas-2x2-v1.png');
  _cloudSpriteTex.colorSpace = THREE.SRGBColorSpace;
  _cloudSpriteTex.minFilter = THREE.LinearMipmapLinearFilter;
  _cloudSpriteTex.magFilter = THREE.LinearFilter;
  return _cloudSpriteTex;
}

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

// logDepthBufFC for the manual fragment-depth write (camera.far is fixed)
export function logDepthFC(far) { return 2.0 / (Math.log(far + 1.0) / Math.LN2); }

// Close-range cloud volume made from deterministic spatial puffs. The global
// analytic shell remains responsible for the planet-scale weather pattern;
// these clusters provide parallax, bottoms, gaps and thickness in atmosphere.
// This avoids the screen-space streaking that a long transparent ray march
// produces on several browser/driver combinations.
export function makeCloudPuffField(planet, band, seed) {
  const rand = makeRng(`${seed}:cloud-puffs`);
  const positions = [];
  const sizes = [];
  const shades = [];
  const dir = new THREE.Vector3();
  const thick = band.rOut - band.rIn;
  const baseSize = Math.max(7000, Math.min(18000, planet.R * 0.043));
  const clusterCount = Math.round(620 + planet.cfg.clouds * 480);

  for (let c = 0; c < clusterCount; c++) {
    const y = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const xz = Math.sqrt(Math.max(0, 1 - y * y));
    const h = Math.pow(rand(), 1.55);
    const r = band.rIn + thick * (0.08 + h * 0.84);
    dir.set(Math.cos(a) * xz, y, Math.sin(a) * xz).multiplyScalar(r);
    positions.push(dir.x, dir.y, dir.z);
    sizes.push(baseSize * (0.58 + rand() * 1.02) * (1 - h * 0.22));
    shades.push(rand());
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('aShade', new THREE.Float32BufferAttribute(shades, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uEngage: { value: 0 },
      uPointScale: { value: typeof window === 'undefined' ? 720 : window.innerHeight },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uTint: { value: new THREE.Color(band.tint || 0xffffff) },
      uCloudSprite: { value: cloudSpriteTexture() },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aSize;
      attribute float aShade;
      uniform float uPointScale;
      uniform vec3 uSunDir;
      varying float vShade;
      varying float vLight;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vShade = aShade;
        vLight = dot(normalize(position), normalize(uSunDir)) * 0.5 + 0.5;
        gl_PointSize = clamp(aSize * uPointScale / max(1.0, -mv.z), 1.5, 360.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uEngage;
      uniform vec3 uTint;
      uniform sampler2D uCloudSprite;
      varying float vShade;
      varying float vLight;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 uv = gl_PointCoord - 0.5;
        float ang = (vShade - 0.5) * 0.34;
        mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
        uv = rot * uv;
        if (fract(vShade * 31.7) > 0.5) uv.x = -uv.x;
        uv += 0.5;
        if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
        float atlasId = min(3.0, floor(vShade * 4.0));
        vec2 cell = vec2(mod(atlasId, 2.0), floor(atlasId * 0.5));
        uv = uv * 0.5 + cell * 0.5;
        vec4 texel = texture2D(uCloudSprite, uv);
        float mask = texel.a;
        float light = mix(0.48, 1.06, vLight);
        vec3 color = texel.rgb * uTint * light * mix(0.88, 1.08, vShade);
        float alpha = mask * uEngage * 0.5;
        if (alpha < 0.008) discard;
        gl_FragColor = vec4(color, alpha);
      }`,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 2;
  points.frustumCulled = false;
  return points;
}

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
        // Domain-warp the volume cells sideways. Raw planet-local sampling
        // aligns cellular lobes radially and reads as repeated cloud columns
        // from below; this bends them into irregular anvils and billows.
        vec3 bentLocal = local
          + tangentA * bend * (uRout - uRin) * 1.7
          + tangentB * sin(h * 3.14159) * (uRout - uRin) * 0.45;
        vec3 q = uSpin * bentLocal * ${(1 / 7200).toFixed(9)} + warp * 4.1;
        vec2 n = textureLod(uNoise3, q, 0.0).rg;
        // Locally varied floor and ceiling prevent a single hard lower edge.
        float floorH = 0.025 + (1.0 - n.g) * 0.13;
        float ceilH = 0.48 + cov * 0.38 + (n.r - 0.5) * 0.18;
        float prof = smoothstep(floorH, floorH + 0.14, h)
          * (1.0 - smoothstep(ceilH - 0.18, ceilH, h));
        float cells = smoothstep(0.34, 0.72, n.r);
        float d = cov * prof * cells;
        float ero = textureLod(uNoise3, q * 3.7, 0.0).g;
        d = clamp(d - (1.0 - ero) * 0.22 * (1.0 - d), 0.0, 1.0);
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
        int STEPS = int(clamp(seg / (thick * 0.045), 28.0, 72.0));
        float dt = seg / float(STEPS);
        float jitter = hash12(gl_FragCoord.xy);
        float t = t0 + dt * jitter;

        float sigma = 5.2 / thick;                  // extinction scale
        float mu = dot(dir, uSunDir);
        float hg = (1.0 - 0.28) / (12.566 * pow(1.0 + 0.28 - 1.06 * mu, 1.5));
        float phase = mix(0.0796, hg * 3.4, 0.75);

        vec3 col = vec3(0.0);
        float T = 1.0;
        for (int i = 0; i < 76; i++) {
          if (i >= STEPS || T < 0.02) break;
          vec3 p = dir * t;
          vec3 local = p - uCenter;
          float d = densityAt(local, 1.0);
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

        // Use the continuous front-shell entry depth. Quantising depth to the
        // first occupied ray step produced the vertical barcode artefacts seen
        // at grazing angles even when density itself was smooth.
        float w = max(t0, 0.001);
        gl_FragDepth = log2(1.0 + w) * uLogFC * 0.5;
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  mat.userData.band = band;
  return mat;
}
