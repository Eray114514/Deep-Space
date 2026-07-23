// Shared cloud noise and WebGPURenderer-compatible cloud-shell material.
// Full TSL port of clouds-webgl.js: complete density field (cloudFbm +
// storm arms + warp + floor/ceiling + upper shelf + wisp + cells +
// erosion), HG phase, 2-3 step sun march, Beer extinction, powder term,
// silver lining, and adaptive 28-88 step count.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs, acos, atan, clamp, cos, cross, dot, exp, float, Fn, fract, If, length,
  logarithmicDepthToViewZ,
  Loop, max, min, mix, mod, normalize, pow, positionLocal, positionViewDirection,
  screenUV, sin, sqrt, smoothstep, texture, texture3D, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { hash3i, hashFloat } from './rng.js';

let _noiseTex = null;
let _depthPlaceholder = null;

// 1x1 placeholder so TSL's texture() node compiles before the pipeline binds
// the real scene depth texture each frame.
function depthPlaceholder() {
  if (_depthPlaceholder) return _depthPlaceholder;
  const data = new Uint8Array([255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = 'depth-placeholder';
  tex.needsUpdate = true;
  _depthPlaceholder = tex;
  return tex;
}

function valueNoise3(x, y, z, N, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const v = (ix, iy, iz) => hashFloat(hash3i(((ix % N) + N) % N,
    ((iy % N) + N) % N, ((iz % N) + N) % N, seed), 0);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(v(xi, yi, zi), v(xi + 1, yi, zi), sx),
      lerp(v(xi, yi + 1, zi), v(xi + 1, yi + 1, zi), sx), sy),
    lerp(lerp(v(xi, yi, zi + 1), v(xi + 1, yi, zi + 1), sx),
      lerp(v(xi, yi + 1, zi + 1), v(xi + 1, yi + 1, zi + 1), sx), sy), sz);
}

function worley3(x, y, z, N, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 8;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const h = hash3i(((cx % N) + N) % N, ((cy % N) + N) % N, ((cz % N) + N) % N, seed);
    const px = cx + hashFloat(h, 0), py = cy + hashFloat(h, 1), pz = cz + hashFloat(h, 2);
    best = Math.min(best, (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2);
  }
  return Math.min(1, Math.sqrt(best));
}

export function cloudNoiseTexture() {
  if (_noiseTex) return _noiseTex;
  const S = 64;
  const data = new Uint8Array(S * S * S * 2);
  for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, w = z / S;
    let f = 0, amp = 0.55, fr = 3;
    for (let octave = 0; octave < 3; octave++) {
      f += valueNoise3(u * fr, v * fr, w * fr, fr, 0x51 + octave) * amp;
      amp *= 0.5; fr *= 2;
    }
    const lobes = 1 - worley3(u * 5, v * 5, w * 5, 5, 0xC1);
    const base = Math.min(1, Math.max(0, f * 0.55 + lobes * 0.6));
    const erosion = 1 - worley3(u * 9, v * 9, w * 9, 9, 0xE3) * 0.6
      - worley3(u * 17, v * 17, w * 17, 17, 0xE7) * 0.4;
    const k = (z * S * S + y * S + x) * 2;
    data[k] = base * 255;
    data[k + 1] = Math.min(1, Math.max(0, erosion)) * 255;
  }
  _noiseTex = new THREE.Data3DTexture(data, S, S, S);
  _noiseTex.format = THREE.RGFormat;
  // r185's WebGPU mip generator treats 3D slices as array layers. Sampling a
  // mipmapped Data3DTexture therefore creates invalid 2D-array views on real
  // WebGPU devices; the volume is small enough for linear base-level sampling.
  _noiseTex.minFilter = THREE.LinearFilter;
  _noiseTex.magFilter = THREE.LinearFilter;
  _noiseTex.wrapS = _noiseTex.wrapT = _noiseTex.wrapR = THREE.RepeatWrapping;
  _noiseTex.generateMipmaps = false;
  _noiseTex.needsUpdate = true;
  return _noiseTex;
}

export function disposeCloudNoiseTexture() {
  if (_noiseTex) { _noiseTex.dispose(); _noiseTex = null; }
}

function stormCenters(offX, offY, offZ) {
  const a = new THREE.Vector3(Math.sin(offX * 1.31 + 0.4),
    Math.sin(offY * 1.17 - 1.2) * 0.72, Math.cos(offZ * 1.43 + 0.7)).normalize();
  const ref = Math.abs(a.y) < 0.8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const b = new THREE.Vector3().crossVectors(a, ref).addScaledVector(a, 0.16).normalize();
  return [a, b];
}

export function makeCloudVolumeMaterial(planet, band, detailTex, weatherMap,
  { quality = 'high' } = {}) {
  const [stormA, stormB] = stormCenters(band.ox, band.oy, band.oz);
  const noiseTex = cloudNoiseTexture();
  const nodes = {
    uNoise3: uniform(noiseTex, 'texture3D'),
    uCloudNoise: uniform(detailTex, 'texture'),
    uWeatherMap: uniform(weatherMap, 'texture'),
    uCov0: uniform(band.cov0), uCov1: uniform(band.cov1),
    uCOff: uniform(new THREE.Vector3(band.ox, band.oy, band.oz)),
    uStormA: uniform(stormA), uStormB: uniform(stormB),
    uCameraLocal: uniform(new THREE.Vector3()), uSpin: uniform(new THREE.Matrix3()),
    uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
    uRin: uniform(band.rIn), uRout: uniform(band.rOut),
    uGroundR: uniform(planet.R + Math.max(0, planet.seaLevel || 0)),
    uCameraNear: uniform(0.1), uCameraFar: uniform(1.2e11), uVolumeSize: uniform(new THREE.Vector2(1, 1)),
    tSceneDepth: texture(depthPlaceholder()), uDepthReady: uniform(0),
    uSunC: uniform(new THREE.Color(1, 0.98, 0.94)),
    uAmbC: uniform(new THREE.Color(0.35, 0.42, 0.55)),
    uTint: uniform(new THREE.Color(band.tint || 0xffffff)),
    uEngage: uniform(0), uFrame: uniform(0),
    uQuality: uniform(quality === 'low' ? 0 : 1),
  };

  const weatherUV = (d) => vec2(
    float(0.5).add(atan(d.z, d.x.negate()).mul(0.15915494)),
    float(1).sub(acos(d.y.clamp(-1, 1)).mul(0.31830988)),
  );

  const volume = Fn(() => {
    const origin = nodes.uCameraLocal;
    const ray = positionLocal.sub(origin).normalize();
    const thick = nodes.uRout.sub(nodes.uRin).max(1);
    const dbgSceneLimit = float(0).toVar();

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
    // (terrain, flora, ship). Without this the cloud shell composites as a
    // screen-front layer that hides the ground — the WebGL path has always
    // done this via sceneRayLimit() in clouds-webgl.js.
    {
      const depthReady = nodes.uDepthReady.greaterThan(0.5);
      const depthSample = nodes.tSceneDepth.sample(screenUV).x;
      // logarithmicDepthToViewZ returns negative viewZ; negate for the
      // positive forward distance the ray-march expects (see planet.js).
      // positionViewDirection.z is negative in front of the camera, so use
      // -z for the forward cosine.
      const forwardDistance = logarithmicDepthToViewZ(depthSample,
        nodes.uCameraNear, nodes.uCameraFar).negate();
      const forwardCos = positionViewDirection.z.negate().max(0.035);
      const sceneLimit = forwardDistance.div(forwardCos);
      const useScene = depthReady.and(depthSample.lessThan(0.999999));
      t1.assign(useScene.select(sceneLimit.add(1.5).min(t1), t1));
      dbgSceneLimit.assign(sceneLimit);
    }

    // Grazing-ray cost bound.
    t1.assign(t1.min(t0.add(thick.mul(6.5))));

    const span = t1.sub(t0).max(0);

    // --- adaptive step count (28-88 based on quality + segment length) ---
    // Matches clouds-webgl.js: WebGPU's win is the .level(0) sampling fix,
    // not more steps. The 56-120 range halved framerate for no visible gain.
    const minSteps = mix(28, 46, nodes.uQuality);
    const maxSteps = mix(52, 88, nodes.uQuality);
    const stepCount = span.div(thick.mul(mix(float(0.052), float(0.032), nodes.uQuality)))
      .clamp(minSteps, maxSteps);
    const dt = span.div(stepCount);
    // Temporal jitter (matches clouds-webgl.js hash12): a per-frame dither
    // on the ray offset breaks the concentric banding that a static 0.5
    // midpoint produces, and lets the half-resolution pass accumulate into
    // soft volume over successive frames — the "thickness" the static path
    // lacked.
    const framePhase = mod(nodes.uFrame, 16);
    const jitterUV = screenUV.add(vec2(framePhase.mul(19.19), framePhase.mul(7.73)).mul(0.01));
    const jitter = fract(sin(jitterUV.dot(vec2(127.1, 311.7))).mul(43758.5453));
    const t = t0.add(dt.mul(jitter)).toVar();

    // --- evaluate the weather system footprint once per pixel ---
    const cloudFbm = (sd) => {
      const f0 = texture(detailTex, sd.xy.mul(0.55).add(nodes.uCOff.xy)).g.mul(0.5);
      const f1 = texture(detailTex, sd.yz.mul(1.15).add(nodes.uCOff.yz)).r.mul(0.25);
      const f2 = texture(detailTex, sd.zx.mul(2.35).add(nodes.uCOff.zx)).g.mul(0.125);
      const f3 = texture(detailTex, sd.xy.mul(4.8).sub(nodes.uCOff.xz)).r.mul(0.0625);
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

    // --- full density field (cloudFbm + warp + floor/ceiling + upper shelf + wisp + cells + erosion) ---
    const densityAt = (local, covScale, sysMask) => {
      const r = length(local);
      const h = r.sub(nodes.uRin).div(thick).clamp(0, 1);
      const radial = local.div(r.max(1));
      const tangentA = normalize(cross(radial,
        abs(radial.y).lessThan(0.88).select(vec3(0, 1, 0), vec3(1, 0, 0))));
      const tangentB = normalize(cross(radial, tangentA));
      const bend = h.sub(0.42);
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
        const warp = vec3(
          texture(detailTex, sd.yz.mul(3.1).add(nodes.uCOff.xy)).r,
          texture(detailTex, sd.zx.mul(3.7).add(nodes.uCOff.yz)).g,
          texture(detailTex, sd.xy.mul(4.3).sub(nodes.uCOff.xz)).r,
        ).sub(0.5);
        const q = nodes.uSpin.mul(radial).mul(nodes.uRin.div(118000))
          .add(vec3(0.37, 0.71, 0.53).mul(h.mul(2.7)))
          .add(warp.mul(1.4));
        // .level(0) forces textureSampleLevel(lod=0) instead of textureSample
        // (auto-derivatives). Inside the ray-march Loop the derivatives are
        // undefined — clouds-webgl.js uses textureLod(..., 0.0) for the same
        // reason. Without this the density field jitters per-step and the
        // cloud shell reads as a flat, buzzing sheet instead of volume.
        const n = texture3D(noiseTex, q).level(0).rg;
        const floorH = float(0.025).add(float(1).sub(n.g).mul(0.13));
        const ceilH = float(0.44).add(cov.mul(0.34)).add(n.r.sub(0.5).mul(0.18));
        const lowerProfile = smoothstep(floorH, floorH.add(0.14), h)
          .mul(float(1).sub(smoothstep(ceilH.sub(0.18), ceilH, h)));
        const upperNoise = texture3D(noiseTex, q.mul(1.72).add(vec3(5.7, 2.3, 8.1))).level(0).rg;
        const upperSource = smoothstep(0.28, 0.76, sysMask).mul(smoothstep(0.26, 0.74, cov));
        const upperFloor = float(0.48).add(upperNoise.g.sub(0.5).mul(0.12));
        const upperCeil = float(0.91).add(upperNoise.r.sub(0.5).mul(0.10));
        const upperProfile = smoothstep(upperFloor, upperFloor.add(0.11), h)
          .mul(float(1).sub(smoothstep(upperCeil.sub(0.11), upperCeil, h)));
        const wisp = smoothstep(0.58, 0.88, upperNoise.g)
          .mul(smoothstep(0.62, 0.73, h))
          .mul(float(1).sub(smoothstep(0.91, 0.99, h)));
        const cells = mix(0.58, 1.22, smoothstep(0.18, 0.82, n.r));
        const verticalShape = max(lowerProfile.mul(cells),
          upperSource.mul(upperProfile).mul(float(0.54).add(upperNoise.r.mul(0.52))));
        const verticalShapeFinal = max(verticalShape, upperSource.mul(wisp).mul(0.34));
        let d = cov.mul(verticalShapeFinal);
        // .level(0): same ray-march derivative fix as the other two 3D
        // samples above — erosion must not jitter per step.
        const ero = texture3D(noiseTex, q.mul(3.15)).level(0).g;
        d = d.sub(float(1).sub(ero).mul(0.10).mul(float(1).sub(d))).clamp(0, 1);
        dResult.assign(smoothstep(0.018, 0.46, d));
      });
      return dResult;
    };

    // --- HG phase function (forward + back scatter blend) ---
    const sunDirNorm = nodes.uSunDir.normalize();
    const mu = dot(ray, sunDirNorm);
    const hg = float(0.72).div(float(12.566).mul(float(1.28).sub(mu.mul(1.06)).pow(1.5)));
    const back = float(0.84).div(float(12.566).mul(float(1.16).add(mu.mul(0.8)).pow(1.5)));
    const phase = mix(0.0796, hg.mul(3.35).add(back.mul(0.5)), 0.76);

    const sigma = float(6.4).div(thick);

    // --- main raymarch loop ---
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
  // Match clouds-webgl.js: no alpha clamp — dense cloud can reach full
  // opacity. The previous 0.97 cap left thick clouds permanently 3%
  // transparent, reading as "thin" compared to the WebGL reference.
  const alpha = valid.select(float(1).sub(transmission).mul(nodes.uEngage).clamp(0, 1), float(0));
    return vec4(integrated.mul(nodes.uEngage), alpha);
  })();

  const material = new MeshBasicNodeMaterial({
    transparent: true, premultipliedAlpha: true, depthWrite: false,
    depthTest: false, side: THREE.BackSide,
  });
  // integrated accumulates T*a*s*powder*tint — front-to-back integrated
  // premultiplied radiance, exactly like clouds-webgl.js's col.  The over()
  // composite in node-render-pipeline.js expects premultiplied RGB.  Do NOT
  // divide by alpha: that unp-multiplies the radiance and the
  // premultipliedAlpha=true blend stage writes it straight through, so the
  // volume texture stores un-premultiplied RGB and over() squashes it.
  material.colorNode = volume.rgb;
  material.opacityNode = volume.a;
  material.uniforms = nodes;
  material.userData.band = band;
  material.userData.volumeOutput = 'premultiplied';
  return material;
}
