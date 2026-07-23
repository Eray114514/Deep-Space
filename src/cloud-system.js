// WebGPU-native volumetric cloud system — a clean rewrite (not a port).
//
// Two-part pipeline:
//   1. A compute kernel bakes a 128^3 RG noise texture (Perlin-Worley base +
//      Worley erosion) into a Storage3DTexture via textureStore. This bypasses
//      r185's 3D-mipmap bug: compute writes directly, never going through
//      Data3DTexture's broken mip-generation path.
//   2. A TSL ray-march material samples the baked noise with texture3D().level(0)
//      (explicit LOD — derivatives are undefined inside the divergent march
//      loop). Full density field, HG phase, 2-3 step sun march, Beer
//      extinction, powder, silver lining, 28-88 adaptive steps.
//
// The material exposes userData.computeNode (one-time bake, schedule via
// renderer.compute) and userData.noiseTexture (for dispose). This mirrors
// ocean-system.js's StorageTexture + computeNode contract.

import * as THREE from 'three';
import { MeshBasicNodeMaterial, Storage3DTexture } from 'three/webgpu';
import {
  abs, bitAnd, bitOr, bitXor, clamp, cos, cross, dot, exp, float, floor, Fn,
  fract, If, instanceIndex, length, logarithmicDepthToViewZ, Loop, max, min,
  mix, mod, normalize, pow, positionLocal, positionViewDirection, screenUV,
  shiftLeft, shiftRight, sin, smoothstep, sqrt, storageTexture3D, texture,
  texture3D, textureStore, uint, uniform, uvec3, vec2, vec3, vec4,
} from 'three/tsl';

const NOISE_SIZE = 128;
const NOISE_VOXELS = NOISE_SIZE * NOISE_SIZE * NOISE_SIZE;

let _noiseStorage3D = null;
let _noiseComputeNode = null;
let _depthPlaceholder = null;

// 1x1 DepthTexture placeholder so TSL's texture() node compiles with the
// correct depth-sampler type before the pipeline binds the real scene depth
// texture each frame.
function depthPlaceholder() {
  if (_depthPlaceholder) return _depthPlaceholder;
  const tex = new THREE.DepthTexture(1, 1);
  tex.name = 'cloud-depth-placeholder';
  _depthPlaceholder = tex;
  return tex;
}

// ---------------------------------------------------------------------------
// GPU hash3i — direct port of rng.js hash3i using TSL uint bit operations.
// The 32-bit constants MUST go through uint() to avoid f32 intermediate
// precision loss (e.g. 0x9e3779b9 = 2654435769 exceeds f32's 24-bit mantissa).
// u32 multiply in WGSL wraps mod 2^32, matching JS Math.imul.
// ---------------------------------------------------------------------------
const hash3iGpu = Fn(([x, y, z, seed]) => {
  const h = bitXor(uint(0x9e3779b9), seed).toVar();
  // h = imul(h ^ x, 0x85ebca6b); rotl 13
  h.assign(bitXor(h, x).mul(uint(0x85ebca6b)));
  h.assign(bitOr(shiftLeft(h, 13), shiftRight(h, 19)));
  // h = imul(h ^ y, 0xc2b2ae35); rotl 11
  h.assign(bitXor(h, y).mul(uint(0xc2b2ae35)));
  h.assign(bitOr(shiftLeft(h, 11), shiftRight(h, 21)));
  // h = imul(h ^ z, 0x27d4eb2f)
  h.assign(bitXor(h, z).mul(uint(0x27d4eb2f)));
  // h ^= h >>> 15; h = imul(h, 0x2545f491)
  h.assign(bitXor(h, shiftRight(h, 15)));
  h.assign(h.mul(uint(0x2545f491)));
  // return (h ^ (h >>> 13)) — u32, no >>>0 needed (already u32)
  return bitXor(h, shiftRight(h, 13));
});

// Derive a float in [0,1) from a uint32 hash, lane n (0..2).
// Matches rng.js hashFloat: (((h >>> (lane*10)) & 1023) + 0.5) / 1024
const hashFloatGpu = Fn(([h, lane]) => {
  const bits = bitAnd(shiftRight(h, lane.mul(10)), uint(1023));
  return float(bits).add(0.5).div(1024.0);
});

// ---------------------------------------------------------------------------
// GPU valueNoise3 — wrapped-lattice value noise, guaranteed tileable.
// Port of clouds-webgl.js valueNoise3. WGSL mod() on floats returns a value
// in [0, N) even for negative inputs (mod(x,y) = x - y*floor(x/y)), so the
// ((ix % N) + N) % N wrap collapses to mod(ix, N).
// ---------------------------------------------------------------------------
const valueNoise3Gpu = Fn(([xf, yf, zf, Nf, seed]) => {
  const xi = floor(xf);
  const yi = floor(yf);
  const zi = floor(zf);
  const fx = xf.sub(xi);
  const fy = yf.sub(yi);
  const fz = zf.sub(zi);
  const sx = fx.mul(fx).mul(float(3).sub(fx.mul(2)));
  const sy = fy.mul(fy).mul(float(3).sub(fy.mul(2)));
  const sz = fz.mul(fz).mul(float(3).sub(fz.mul(2)));

  const v = (ix, iy, iz) => {
    const ixu = uint(mod(ix, Nf));
    const iyu = uint(mod(iy, Nf));
    const izu = uint(mod(iz, Nf));
    return hashFloatGpu(hash3iGpu(ixu, iyu, izu, seed), uint(0));
  };

  const lerp = (a, b, t) => a.add(b.sub(a).mul(t));
  const c00 = lerp(v(xi, yi, zi), v(xi.add(1), yi, zi), sx);
  const c10 = lerp(v(xi, yi.add(1), zi), v(xi.add(1), yi.add(1), zi), sx);
  const c01 = lerp(v(xi, yi, zi.add(1)), v(xi.add(1), yi, zi.add(1)), sx);
  const c11 = lerp(v(xi, yi.add(1), zi.add(1)), v(xi.add(1), yi.add(1), zi.add(1)), sx);
  const c0 = lerp(c00, c10, sy);
  const c1 = lerp(c01, c11, sy);
  return lerp(c0, c1, sz);
});

// ---------------------------------------------------------------------------
// GPU worley3 — wrapped cellular noise (distance to nearest feature point).
// Port of clouds-webgl.js worley3. 27-cell neighbourhood unrolled via Loop.
// Squaring uses d.mul(d), NOT pow(d,2) — pow(log2(neg)) is NaN for negative d.
// ---------------------------------------------------------------------------
const worley3Gpu = Fn(([xf, yf, zf, Nf, seed]) => {
  const xi = floor(xf);
  const yi = floor(yf);
  const zi = floor(zf);
  const best = float(8).toVar();

  Loop(27, ({ i }) => {
    const fi = float(i);
    const dz = fi.div(9).floor().sub(1);
    const dy = fi.mod(9).div(3).floor().sub(1);
    const dx = fi.mod(3).sub(1);

    const cx = xi.add(dx);
    const cy = yi.add(dy);
    const cz = zi.add(dz);
    const cxu = uint(mod(cx, Nf));
    const cyu = uint(mod(cy, Nf));
    const czu = uint(mod(cz, Nf));

    const h = hash3iGpu(cxu, cyu, czu, seed);
    const px = cx.add(hashFloatGpu(h, uint(0)));
    const py = cy.add(hashFloatGpu(h, uint(1)));
    const pz = cz.add(hashFloatGpu(h, uint(2)));
    const ddx = px.sub(xf);
    const ddy = py.sub(yf);
    const ddz = pz.sub(zf);
    const d = ddx.mul(ddx).add(ddy.mul(ddy)).add(ddz.mul(ddz));
    best.assign(min(best, d));
  });

  return min(float(1), sqrt(best));
});

// ---------------------------------------------------------------------------
// Compute kernel: bake 128^3 RGBA noise into the Storage3DTexture.
//   R = Perlin-Worley base lobes (3-octave value fBm + inverted worley)
//   G = high-frequency Worley erosion (two-octave inverted worley)
// textureStore writes directly — no mipmap generation, no Data3DTexture path.
// ---------------------------------------------------------------------------
function buildNoiseKernel(tex) {
  return Fn(() => {
    const fidx = float(instanceIndex);
    const x = fidx.mod(float(NOISE_SIZE)).floor();
    const y = fidx.div(float(NOISE_SIZE)).mod(float(NOISE_SIZE)).floor();
    const z = fidx.div(float(NOISE_SIZE * NOISE_SIZE)).floor();

    const u = x.div(NOISE_SIZE);
    const v = y.div(NOISE_SIZE);
    const w = z.div(NOISE_SIZE);

    // 3-octave value fBm (amp 0.55 → 0.275 → 0.1375; freq 3 → 6 → 12)
    let f = float(0);
    let amp = float(0.55);
    let fr = float(3);
    for (let o = 0; o < 3; o++) {
      f = f.add(valueNoise3Gpu(u.mul(fr), v.mul(fr), w.mul(fr), fr, uint(0x51 + o)).mul(amp));
      amp = amp.mul(0.5);
      fr = fr.mul(2);
    }
    const lobes = float(1).sub(worley3Gpu(u.mul(5), v.mul(5), w.mul(5), float(5), uint(0xC1)));
    const base = f.mul(0.55).add(lobes.mul(0.6)).clamp(0, 1);

    // Two-octave inverted worley erosion
    const ero = float(1)
      .sub(worley3Gpu(u.mul(9), v.mul(9), w.mul(9), float(9), uint(0xE3)).mul(0.6))
      .sub(worley3Gpu(u.mul(17), v.mul(17), w.mul(17), float(17), uint(0xE7)).mul(0.4))
      .clamp(0, 1);

    textureStore(storageTexture3D(tex), uvec3(uint(x), uint(y), uint(z)), vec4(base, ero, 0, 0));
  })().compute(NOISE_VOXELS, [64]);
}

// ---------------------------------------------------------------------------
// Module-level noise lifecycle.
//
// initCloudNoise(renderer?) creates the 128^3 Storage3DTexture and compute
// kernel. If a renderer is passed, the kernel is run immediately (one-time
// bake). Otherwise the caller schedules renderer.compute(computeNode) later —
// main.js does this once per cloud material that owns the computeNode.
// ---------------------------------------------------------------------------
export function initCloudNoise(renderer) {
  if (_noiseStorage3D) return { texture: _noiseStorage3D, computeNode: _noiseComputeNode };
  _noiseStorage3D = new Storage3DTexture(NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  _noiseStorage3D.name = 'cloud-noise-3d';
  // RepeatWrapping so the noise tiles seamlessly across the cloud shell.
  _noiseStorage3D.wrapS = _noiseStorage3D.wrapT = _noiseStorage3D.wrapR = THREE.RepeatWrapping;
  // RGBA8: vec4(base, erosion, 0, 0). rg8unorm is not a guaranteed WebGPU
  // storage format; rgba8unorm is. Sampling reads .rg, the B/A channels are
  // padding.
  _noiseStorage3D.format = THREE.RGBAFormat;
  _noiseStorage3D.generateMipmaps = false;
  _noiseStorage3D.needsUpdate = true;

  _noiseComputeNode = buildNoiseKernel(_noiseStorage3D);
  _noiseComputeNode.name = 'cloud-noise-bake';

  if (renderer) {
    renderer.compute(_noiseComputeNode);
  }
  return { texture: _noiseStorage3D, computeNode: _noiseComputeNode };
}

// Release the module-level 3D noise texture and compute node. Full-session
// teardown only — every cloud material that referenced this texture must be
// disposed first.
export function disposeCloudNoise() {
  if (_noiseStorage3D) { _noiseStorage3D.dispose(); _noiseStorage3D = null; }
  _noiseComputeNode = null;
}

// Storm centers — same analytic derivation as clouds-webgl.js. Two orthogonal
// axes define the spiral-arm weather systems that overlay the base coverage.
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

// ---------------------------------------------------------------------------
// Public material factory.
//
// makeCloudVolumeMaterialV2 returns a MeshBasicNodeMaterial that ray-marches
// a volumetric cloud shell between band.rIn and band.rOut around the planet.
// The density field, HG phase, sun march, Beer extinction, powder, and silver
// lining are a faithful port of clouds-webgl.js. The key WebGPU differences:
//   - 128^3 compute-baked Storage3DTexture (4x the 64^3 CPU-baked Data3DTexture)
//   - all texture3D and in-march texture() samples use .level(0)
//   - depth occlusion via logarithmicDepthToViewZ + positionViewDirection.z
// ---------------------------------------------------------------------------
export function makeCloudVolumeMaterialV2(planet, band, detailTex, _weatherMap,
  { quality = 'high' } = {}) {
  const [stormA, stormB] = stormCenters(band.ox, band.oy, band.oz);
  const { texture: noiseTex, computeNode } = initCloudNoise();

  const nodes = {
    uNoise3: uniform(noiseTex, 'texture3D'),
    uCloudNoise: uniform(detailTex, 'texture'),
    uCov0: uniform(band.cov0), uCov1: uniform(band.cov1),
    uCOff: uniform(new THREE.Vector3(band.ox, band.oy, band.oz)),
    uStormA: uniform(stormA), uStormB: uniform(stormB),
    uCameraLocal: uniform(new THREE.Vector3()), uSpin: uniform(new THREE.Matrix3()),
    uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
    uRin: uniform(band.rIn), uRout: uniform(band.rOut),
    uGroundR: uniform(planet.R + Math.max(0, planet.seaLevel || 0)),
    uCameraNear: uniform(0.1), uCameraFar: uniform(1.2e11),
    uVolumeSize: uniform(new THREE.Vector2(1, 1)),
    tSceneDepth: texture(depthPlaceholder()), uDepthReady: uniform(0),
    uSunC: uniform(new THREE.Color(1, 0.98, 0.94)),
    uAmbC: uniform(new THREE.Color(0.35, 0.42, 0.55)),
    uTint: uniform(new THREE.Color(band.tint || 0xffffff)),
    uEngage: uniform(0), uFrame: uniform(0),
    uQuality: uniform(quality === 'low' ? 0 : 1),
  };

  const volume = Fn(() => {
    const origin = nodes.uCameraLocal;
    const ray = positionLocal.sub(origin).normalize();
    const thick = nodes.uRout.sub(nodes.uRin).max(1);

    // --- ray-sphere intersections (outer, inner, ground) ---
    const bOuter = dot(origin, ray);
    const discOuter = bOuter.mul(bOuter).sub(dot(origin, origin)).add(nodes.uRout.mul(nodes.uRout));
    const outerRoot = sqrt(discOuter.max(0));
    const t0 = bOuter.negate().sub(outerRoot).max(0).toVar();
    const t1 = bOuter.negate().add(outerRoot).toVar();

    const bInner = dot(origin, ray);
    const discInner = bInner.mul(bInner).sub(dot(origin, origin)).add(nodes.uRin.mul(nodes.uRin));
    const innerRoot = sqrt(discInner.max(0));
    const innerNear = bInner.negate().sub(innerRoot);
    const innerFar = bInner.negate().add(innerRoot);
    const clipsInner = discInner.greaterThan(0).and(innerNear.greaterThan(t0));
    t1.assign(clipsInner.select(innerNear.min(t1), t1));

    // Camera inside the cloud shell: march the re-entry segment.
    const camR = length(origin);
    const camInside = camR.lessThan(nodes.uRin).and(discInner.greaterThan(0)).and(innerFar.greaterThan(0));
    t0.assign(camInside.select(innerFar.max(0), t0));

    // Ground occlusion: stop the ray at the planet surface.
    const bGround = dot(origin, ray);
    const discGround = bGround.mul(bGround).sub(dot(origin, origin)).add(nodes.uGroundR.mul(nodes.uGroundR));
    const groundNear = bGround.negate().sub(sqrt(discGround.max(0)));
    const clipsGround = discGround.greaterThan(0).and(groundNear.greaterThan(0));
    t1.assign(clipsGround.select(groundNear.min(t1), t1));

    // Scene-depth occlusion: stop the ray at the first opaque scene surface
    // (terrain, flora, ship). logarithmicDepthToViewZ returns negative
    // viewZ; negate for the positive forward distance the ray-march expects.
    // forwardCos uses -positionViewDirection.z (view-space forward; z is
    // negative in front of the camera), clamped to avoid division-by-zero at
    // grazing angles.
    {
      const depthReady = nodes.uDepthReady.greaterThan(0.5);
      const depthSample = nodes.tSceneDepth.sample(screenUV).x;
      const forwardDistance = logarithmicDepthToViewZ(depthSample,
        nodes.uCameraNear, nodes.uCameraFar).negate();
      const forwardCos = positionViewDirection.z.negate().max(0.035);
      const sceneLimit = forwardDistance.div(forwardCos);
      const useScene = depthReady.and(depthSample.lessThan(0.999999));
      t1.assign(useScene.select(sceneLimit.add(1.5).min(t1), t1));
    }

    // Grazing-ray cost bound.
    t1.assign(t1.min(t0.add(thick.mul(6.5))));
    const span = t1.sub(t0).max(0);

    // --- adaptive step count (28-88 based on quality + segment length) ---
    // Matches clouds-webgl.js: the win is .level(0) sampling, not more steps.
    const minSteps = mix(28, 46, nodes.uQuality);
    const maxSteps = mix(52, 88, nodes.uQuality);
    const stepCount = span.div(thick.mul(mix(float(0.052), float(0.032), nodes.uQuality)))
      .clamp(minSteps, maxSteps);
    const dt = span.div(stepCount);

    // Temporal jitter (matches clouds-webgl.js hash12): per-frame dither on
    // the ray offset breaks concentric banding and lets the half-resolution
    // pass accumulate into soft volume over successive frames.
    const framePhase = mod(nodes.uFrame, 16);
    const jitterUV = screenUV.add(vec2(framePhase.mul(19.19), framePhase.mul(7.73)).mul(0.01));
    const jitter = fract(sin(jitterUV.dot(vec2(127.1, 311.7))).mul(43758.5453));
    const t = t0.add(dt.mul(jitter)).toVar();

    // --- weather system footprint (evaluated once per pixel) ---
    // cloudFbm: the SAME coverage fbm the impostor deck and terrain shadows
    // use. Explicit LOD via .level(0): implicit derivatives are undefined in
    // the divergent march loop and flicker (clouds-webgl.js uses textureLod
    // for the same reason).
    const cloudFbm = (sd) => {
      const f0 = texture(detailTex, sd.xy.mul(0.55).add(nodes.uCOff.xy)).level(0).g.mul(0.5);
      const f1 = texture(detailTex, sd.yz.mul(1.15).add(nodes.uCOff.yz)).level(0).r.mul(0.25);
      const f2 = texture(detailTex, sd.zx.mul(2.35).add(nodes.uCOff.zx)).level(0).g.mul(0.125);
      const f3 = texture(detailTex, sd.xy.mul(4.8).sub(nodes.uCOff.xz)).level(0).r.mul(0.0625);
      return f0.add(f1).add(f2).add(f3).div(0.9375);
    };

    const stormAt = (d, center, phase, radius) => {
      const ref = abs(center.y).lessThan(0.88).select(vec3(0, 1, 0), vec3(1, 0, 0));
      const ta = normalize(cross(ref, center));
      const tb = normalize(cross(center, ta));
      const z = dot(d, center).clamp(-1, 1);
      const x = dot(d, ta);
      const y = dot(d, tb);
      const inv = float(1).div(x.mul(x).add(y.mul(y)).max(1e-5));
      const sin2 = x.mul(y).mul(2).mul(inv);
      const cos2 = x.mul(x).sub(y.mul(y)).mul(inv);
      const r = sqrt(float(2).mul(float(1).sub(z)).max(0)).div(radius);
      const shield = float(1).sub(smoothstep(0.08, 0.5, r)).mul(0.58);
      const turn = phase.sub(r.mul(13));
      const arms = smoothstep(0.66, 0.94,
        float(0.5).add(float(0.5).mul(
          sin2.mul(cos(turn)).add(cos2.mul(sin(turn))),
        )),
      );
      return max(shield, arms.mul(smoothstep(0.1, 0.24, r))
        .mul(float(1).sub(smoothstep(0.62, 1, r))));
    };

    const weatherSystem = (d) => max(
      stormAt(d, nodes.uStormA, nodes.uCOff.z, 0.92),
      stormAt(d, nodes.uStormB, nodes.uCOff.x.add(nodes.uCOff.y), 0.68).mul(0.72),
    );

    const systemDir = nodes.uSpin.mul(origin.add(ray.mul(t0.add(t1).mul(0.5))).normalize());
    const systemMask = weatherSystem(systemDir);

    // --- full density field (cloudFbm + warp + floor/ceiling + upper shelf
    //     + wisp + cells + erosion) — faithful port of clouds-webgl.js ---
    const densityAt = (local, covScale, sysMask) => {
      const r = length(local);
      const h = r.sub(nodes.uRin).div(thick).clamp(0, 1);
      const radial = local.div(r.max(1));
      const tangentA = normalize(cross(radial,
        abs(radial.y).lessThan(0.88).select(vec3(0, 1, 0), vec3(1, 0, 0))));
      const tangentB = normalize(cross(radial, tangentA));
      const bend = h.sub(0.42);
      // Shift the coverage footprint laterally with altitude so anvils,
      // shelves and tilted billows replace vertical curtains.
      const coverageDir = normalize(radial
        .add(tangentA.mul(bend.mul(0.02)))
        .add(tangentB.mul(bend.mul(bend).sub(0.08).mul(0.015))));
      const sd = nodes.uSpin.mul(coverageDir);
      const fine = cloudFbm(sd);
      const baseWeather = smoothstep(nodes.uCov0, nodes.uCov1, fine).pow(0.92);
      const largeSystem = sysMask.mul(smoothstep(0.24, 0.68, fine)).mul(0.86);
      const cov = max(baseWeather, largeSystem).mul(covScale);

      const dResult = float(0).toVar();
      If(cov.greaterThan(0.01), () => {
        // Warp: 3 in-march 2D texture samples — all .level(0) to avoid
        // undefined derivatives inside the ray-march Loop.
        const warp = vec3(
          texture(detailTex, sd.yz.mul(3.1).add(nodes.uCOff.xy)).level(0).r,
          texture(detailTex, sd.zx.mul(3.7).add(nodes.uCOff.yz)).level(0).g,
          texture(detailTex, sd.xy.mul(4.3).sub(nodes.uCOff.xz)).level(0).r,
        ).sub(0.5);
        // Sample the base volume in a spherical weather frame. Horizontal
        // scale follows the planet surface; height travels through a separate
        // oblique noise axis to avoid radial brush-stroke banding.
        const q = nodes.uSpin.mul(radial).mul(nodes.uRin.div(118000))
          .add(vec3(0.37, 0.71, 0.53).mul(h.mul(2.7)))
          .add(warp.mul(1.4));
        // .level(0): forces textureSampleLevel(lod=0) instead of textureSample
        // (auto-derivatives). Inside the ray-march Loop the derivatives are
        // undefined — without this the density field jitters per-step and the
        // cloud shell reads as a flat, buzzing sheet instead of volume.
        const n = texture3D(noiseTex, q).level(0).rg;
        // Locally varied floor and ceiling prevent a single hard lower edge.
        const floorH = float(0.025).add(float(1).sub(n.g).mul(0.13));
        const ceilH = float(0.44).add(cov.mul(0.34)).add(n.r.sub(0.5).mul(0.18));
        const lowerProfile = smoothstep(floorH, floorH.add(0.14), h)
          .mul(float(1).sub(smoothstep(ceilH.sub(0.18), ceilH, h)));
        // Deep weather systems build a distinct upper shelf — towers, anvils,
        // gaps — sharing the same footprint and 3D field as the lower cloud.
        const upperNoise = texture3D(noiseTex, q.mul(1.72).add(vec3(5.7, 2.3, 8.1))).level(0).rg;
        const upperSource = smoothstep(0.28, 0.76, sysMask).mul(smoothstep(0.26, 0.74, cov));
        const upperFloor = float(0.48).add(upperNoise.g.sub(0.5).mul(0.12));
        const upperCeil = float(0.91).add(upperNoise.r.sub(0.5).mul(0.10));
        const upperProfile = smoothstep(upperFloor, upperFloor.add(0.11), h)
          .mul(float(1).sub(smoothstep(upperCeil.sub(0.11), upperCeil, h)));
        // Sparse high-altitude filaments soften storm tops.
        const wisp = smoothstep(0.58, 0.88, upperNoise.g)
          .mul(smoothstep(0.62, 0.73, h))
          .mul(float(1).sub(smoothstep(0.91, 0.99, h)));
        // 3D noise shapes density inside the footprint; a non-zero floor gives
        // broad cloud bodies real depth while Worley sculpts billowing edges.
        const cells = mix(0.58, 1.22, smoothstep(0.18, 0.82, n.r));
        const verticalShape = max(lowerProfile.mul(cells),
          upperSource.mul(upperProfile).mul(float(0.54).add(upperNoise.r.mul(0.52))));
        const verticalShapeFinal = max(verticalShape, upperSource.mul(wisp).mul(0.34));
        let d = cov.mul(verticalShapeFinal);
        // Erosion — .level(0): same ray-march derivative fix.
        const ero = texture3D(noiseTex, q.mul(3.15)).level(0).g;
        d = d.sub(float(1).sub(ero).mul(0.10).mul(float(1).sub(d))).clamp(0, 1);
        dResult.assign(smoothstep(0.018, 0.46, d));
      });
      return dResult;
    };

    // --- HG phase function (forward + back scatter blend) ---
    // Matches clouds-webgl.js exactly.
    const sunDirNorm = nodes.uSunDir.normalize();
    const mu = dot(ray, sunDirNorm);
    const hg = float(0.72).div(float(12.566).mul(float(1.28).sub(mu.mul(1.06)).pow(1.5)));
    const back = float(0.84).div(float(12.566).mul(float(1.16).add(mu.mul(0.8)).pow(1.5)));
    const phase = mix(0.0796, hg.mul(3.35).add(back.mul(0.5)), 0.76);

    const sigma = float(6.4).div(thick);

    // --- main raymarch loop (28-88 steps, early-exit on T < 0.02) ---
    const integrated = vec3(0).toVar();
    const transmission = float(1).toVar();
    Loop(124, ({ i }) => {
      If(i.lessThan(stepCount).and(transmission.greaterThan(0.02)), () => {
        const local = origin.add(ray.mul(t));
        const d = densityAt(local, float(1), systemMask);

        If(d.greaterThan(0.003), () => {
          // Short sun march: how buried is this sample?
          const ls = thick.mul(0.35);
          let od = densityAt(local.add(sunDirNorm.mul(ls.mul(0.6))), float(1), systemMask)
            .mul(ls.mul(0.6));
          od = od.add(densityAt(local.add(sunDirNorm.mul(ls.mul(1.5))), float(1), systemMask)
            .mul(ls.mul(0.9)));
          const odHigh = od.add(densityAt(local.add(sunDirNorm.mul(ls.mul(2.8))), float(1), systemMask)
            .mul(ls.mul(1.3)));
          const odFinal = nodes.uQuality.greaterThan(0.5).select(odHigh, od.mul(1.18));

          const Tsun = exp(odFinal.mul(sigma).mul(0.9).negate());
          const powder = float(1).sub(exp(d.mul(sigma).mul(dt).mul(2).negate()));
          const hFrac = length(local).sub(nodes.uRin).div(thick).clamp(0, 1);
          const silver = Tsun.pow(2.4).mul(mu.max(0).pow(3))
            .mul(float(1).sub(smoothstep(0.56, 0.96, d)));
          const s = nodes.uSunC.mul(Tsun.mul(phase).mul(13.2).add(silver.mul(0.82)))
            .add(nodes.uAmbC.mul(float(0.42).add(hFrac.mul(0.62)))
              .mul(float(0.72).add(Tsun.mul(0.28))));
          const a = float(1).sub(exp(d.mul(sigma).mul(dt).negate()));
          integrated.addAssign(transmission.mul(a).mul(s).mul(powder).mul(nodes.uTint));
          transmission.mulAssign(float(1).sub(a));
        });

        t.addAssign(dt);
      });
    });

    const valid = discOuter.greaterThan(0).and(t1.greaterThan(t0));
    // No alpha clamp — dense cloud can reach full opacity (matches clouds-
    // webgl.js). The previous 0.97 cap left thick clouds permanently 3%
    // transparent, reading as "thin" compared to the WebGL reference.
    const alpha = valid.select(float(1).sub(transmission).mul(nodes.uEngage).clamp(0, 1), float(0));
    return vec4(integrated.mul(nodes.uEngage), alpha);
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true, premultipliedAlpha: true, depthWrite: false,
    depthTest: false, side: THREE.BackSide,
  });
  // integrated accumulates T*a*s*powder*tint — front-to-back integrated
  // premultiplied radiance, exactly like clouds-webgl.js's col. The over()
  // composite expects premultiplied RGB; do NOT divide by alpha.
  material.colorNode = volume.rgb;
  material.opacityNode = volume.a;
  material.uniforms = nodes;
  material.userData.band = band;
  material.userData.computeNode = computeNode;
  material.userData.noiseTexture = noiseTex;
  material.userData.volumeOutput = 'premultiplied';
  return material;
}
