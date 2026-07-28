// Shared cloud noise and WebGPURenderer-compatible cloud-shell material.
// The close cloud volume now uses a bounded analytic shell node; the global
// deck and CPU transit fog still share the same deterministic weather field.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  acos, atan, dot, exp, float, Fn, If, Loop, mix, positionLocal, positionView,
  screenUV, sqrt, smoothstep, texture, texture3D, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { hash3i, hashFloat } from './rng.js';

let _noiseTex = null;

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
  { quality = 'ultra' } = {}) {
  const [stormA, stormB] = stormCenters(band.ox, band.oy, band.oz);
  const nodes = {
    uNoise3: uniform(cloudNoiseTexture(), 'texture3D'),
    uCloudNoise: uniform(detailTex, 'texture'),
    uCov0: uniform(band.cov0), uCov1: uniform(band.cov1),
    uCOff: uniform(new THREE.Vector3(band.ox, band.oy, band.oz)),
    uStormA: uniform(stormA), uStormB: uniform(stormB),
    uCameraLocal: uniform(new THREE.Vector3()), uSpin: uniform(new THREE.Matrix3()),
    uStellarDirections0: uniform(new THREE.Vector3(0, 1, 0)),
    uStellarDirections1: uniform(new THREE.Vector3(0, -1, 0)),
    uStellarRadiance0: uniform(new THREE.Color(1, 0.98, 0.94)),
    uStellarRadiance1: uniform(new THREE.Color(1, 0.98, 0.94)),
    uStarIrradiance0: uniform(1), uStarIrradiance1: uniform(0),
    uRin: uniform(band.rIn), uRout: uniform(band.rOut),
    uGroundR: uniform(planet.hasLiquid ? planet.seaRadius : planet.R),
    tSceneDepth: texture(new THREE.Texture()), uDepthReady: uniform(0),
    uDepthReversed: uniform(0), uCameraFar: uniform(1.2e11),
    uVolumeSize: uniform(new THREE.Vector2(1, 1)),
    uSunC: uniform(new THREE.Color(1, 0.98, 0.94)),
    uAmbC: uniform(new THREE.Color(0.35, 0.42, 0.55)),
    uTint: uniform(new THREE.Color(band.tint || 0xffffff)),
    uEngage: uniform(0), uFrame: uniform(0), uWeatherTime: uniform(0),
    uMaxSteps: uniform(quality === 'performance' || quality === 'low' ? 10 : 16),
    uQuality: uniform(quality === 'performance' || quality === 'low' ? 0 : 1),
  };
  const weatherUV = (d) => vec2(
    float(0.5).add(atan(d.z, d.x.negate()).mul(0.15915494)),
    float(1).sub(acos(d.y.clamp(-1, 1)).mul(0.31830988)),
  );
  const weatherTextureNode = texture(weatherMap);
  const volume = Fn(() => {
    const origin = nodes.uCameraLocal;
    const ray = positionLocal.sub(origin).normalize();
    const bOuter = dot(origin, ray);
    const outerDisc = bOuter.mul(bOuter).sub(dot(origin, origin)).add(nodes.uRout.mul(nodes.uRout));
    const outerRoot = sqrt(outerDisc.max(0));
    const t0 = bOuter.negate().sub(outerRoot).max(0).toVar();
    const t1 = bOuter.negate().add(outerRoot).toVar();
    const bInner = dot(origin, ray);
    const innerDisc = bInner.mul(bInner).sub(dot(origin, origin)).add(nodes.uRin.mul(nodes.uRin));
    const innerRoot = sqrt(innerDisc.max(0));
    const innerNear = bInner.negate().sub(innerRoot);
    const innerFar = bInner.negate().add(innerRoot);
    const clipsInner = innerDisc.greaterThan(0).and(innerNear.greaterThan(t0));
    t1.assign(clipsInner.select(innerNear.min(t1), t1));
    // Below cloud base, begin at the outward inner-shell crossing. Without
    // this branch a downward ray starts at the camera and eventually samples
    // the far-side cloud shell through the planet.
    If(origin.length().lessThan(nodes.uRin)
      .and(innerDisc.greaterThan(0)).and(innerFar.greaterThan(0)), () => {
      t0.assign(innerFar.max(0));
      t1.assign(bOuter.negate().add(outerRoot));
    });
    const bGround = dot(origin, ray);
    const groundDisc = bGround.mul(bGround).sub(dot(origin, origin))
      .add(nodes.uGroundR.mul(nodes.uGroundR));
    const groundNear = bGround.negate().sub(sqrt(groundDisc.max(0)));
    const clipsGround = groundDisc.greaterThan(0).and(groundNear.greaterThan(0));
    t1.assign(clipsGround.select(groundNear.min(t1), t1));
    // The main opaque pass owns visibility. Sampling its depth prevents the
    // half-resolution participating-medium pass from bleeding across real
    // mountains, buildings and the ship silhouette.
    const rawDepth = nodes.tSceneDepth.sample(screenUV).r;
    const sceneDepth = mix(rawDepth, float(1).sub(rawDepth), nodes.uDepthReversed);
    const hasSceneDepth = nodes.uDepthReady.greaterThan(0.5)
      .and(sceneDepth.lessThan(0.999999));
    const forwardDistance = nodes.uCameraFar.add(1).pow(sceneDepth).sub(1);
    const forwardCos = positionView.normalize().z.negate().max(0.035);
    const sceneLimit = forwardDistance.div(forwardCos).add(1.5);
    t1.assign(hasSceneDepth.select(t1.min(sceneLimit), t1));
    const span = t1.sub(t0).max(0);
    const stepCount = nodes.uMaxSteps.clamp(8, 32).toVar();
    const stepLength = span.div(stepCount);
    const thickness = nodes.uRout.sub(nodes.uRin).max(1);
    const t = t0.add(stepLength.mul(0.5)).toVar();
    const integrated = vec3(0).toVar();
    const transmission = float(1).toVar();
    Loop(32, ({ i }) => {
      If(i.lessThan(stepCount), () => {
        const samplePosition = origin.add(ray.mul(t));
        const radius = samplePosition.length();
        const direction = samplePosition.div(radius.max(1));
        const weatherDirection = nodes.uSpin.mul(direction);
        const height = radius.sub(nodes.uRin).div(thickness).clamp(0, 1);
        const uv = weatherUV(weatherDirection);
        // Lo/Hi weather channels come from one deterministic authority:
        // R coverage, G convective type, B high-deck mask, A multi-scatter.
        const weatherLo = weatherTextureNode.sample(uv);
        const weatherRaw = weatherLo.r;
        const cloudType = weatherLo.g;
        const weatherHi = weatherLo.b;
        const multipleScatter = weatherLo.a;
        // Coverage is a meteorological probability field, not literal vapour
        // density. Feeding its unshaped value into every ray step turned even
        // 20–30% coverage into a planet-wide grey extinction curtain. A
        // type-aware formation threshold preserves coherent fronts while
        // leaving genuinely clear air between cells.
        const formationThreshold = mix(0.36, 0.22, cloudType);
        const weather = smoothstep(formationThreshold,
          formationThreshold.add(0.42), weatherRaw);
        const lowerFloor = mix(0.015, 0.1, cloudType);
        const lowerCeiling = mix(0.42, 0.78, cloudType);
        const lowerProfile = smoothstep(lowerFloor, lowerFloor.add(0.13), height)
          .mul(smoothstep(lowerCeiling, lowerCeiling.sub(0.18), height));
        const slowWind = vec3(
          nodes.uWeatherTime.mul(0.011),
          nodes.uWeatherTime.mul(-0.0036),
          nodes.uWeatherTime.mul(0.0074),
        );
        const detailWind = vec3(
          nodes.uWeatherTime.mul(0.027),
          nodes.uWeatherTime.mul(-0.009),
          nodes.uWeatherTime.mul(0.018),
        );
        const volumeUV = weatherDirection.mul(2.15).add(vec3(0.5)).add(slowWind)
          .add(vec3(height.mul(0.21), height.mul(0.37), height.mul(0.16)));
        const detail = texture3D(cloudNoiseTexture(), volumeUV).r;
        const upperDetail = texture3D(cloudNoiseTexture(), volumeUV.mul(1.71).add(detailWind)
          .add(vec3(0.37, 0.61, 0.19))).g;
        const erosion = texture(detailTex,
          uv.mul(vec2(18, 9)).add(nodes.uCOff.xy.mul(0.09))).g;
        const upperSource = smoothstep(0.24, 0.76, weatherHi)
          .max(smoothstep(0.62, 0.94, weather).mul(cloudType));
        const upperProfile = smoothstep(0.43, 0.57, height)
          .mul(smoothstep(0.96, 0.82, height)).mul(upperSource)
          .mul(float(0.5).add(upperDetail.mul(0.62)));
        const verticalShape = lowerProfile
          .mul(float(0.46).add(detail.mul(0.78))).max(upperProfile);
        const density = weather.mul(verticalShape)
          .mul(float(0.78).add(erosion.mul(0.36))).clamp(0, 1);
        const primaryDir = nodes.uStellarDirections0.normalize();
        const secondaryDir = nodes.uStellarDirections1.normalize();
        const sunWeather = weatherTextureNode.sample(weatherUV(
          weatherDirection.add(primaryDir.mul(0.018)).normalize())).r;
        const selfShadow = float(1).sub(sunWeather.sub(weather).mul(2.8)).clamp(0.34, 1.12);
        const day0 = smoothstep(-0.16, 0.24, dot(direction, primaryDir));
        const day1 = smoothstep(-0.16, 0.24, dot(direction, secondaryDir));
        // The lower cloud body receives mostly skylight; direct sun reaches
        // the bright crown progressively.  Lighting every sample with the
        // full sun colour made an overcast deck a flat white screen from the
        // ground even though the density silhouette was correct.
        const direct0 = day0.mul(selfShadow).mul(nodes.uStarIrradiance0);
        const direct1 = day1.mul(nodes.uStarIrradiance1);
        const directLight = direct0.add(direct1).mul(mix(0.16, 1, height));
        const heightLight = mix(0.68, 1.08, height);
        const stellarColor = nodes.uStellarRadiance0.mul(direct0)
          .add(nodes.uStellarRadiance1.mul(direct1))
          .div(direct0.add(direct1).max(0.001));
        const cloudColor = mix(nodes.uAmbC.mul(float(0.86).add(multipleScatter.mul(0.34))),
          stellarColor, directLight.clamp(0, 1)).mul(nodes.uTint).mul(heightLight);
        const alphaStep = float(1).sub(exp(density.mul(stepLength).div(thickness).mul(-2.15)));
        integrated.addAssign(cloudColor.mul(transmission).mul(alphaStep));
        transmission.mulAssign(float(1).sub(alphaStep));
        t.addAssign(stepLength);
      });
    });
    const valid = outerDisc.greaterThan(0).and(t1.greaterThan(t0));
    const alpha = valid.select(float(1).sub(transmission).mul(nodes.uEngage).clamp(0, 0.97), float(0));
    return vec4(integrated.mul(nodes.uEngage), alpha);
  })();
  const material = new MeshBasicNodeMaterial({
    transparent: true, premultipliedAlpha: true, depthWrite: false,
    depthTest: true, side: THREE.BackSide,
  });
  // MeshBasicNodeMaterial applies premultiplication for a material carrying
  // premultipliedAlpha.  The raymarch accumulator is already premultiplied,
  // so expose straight RGB here and let the material perform that conversion
  // exactly once before the volume pass stores it.
  material.colorNode = volume.rgb.div(volume.a.max(0.0001));
  material.opacityNode = volume.a;
  material.uniforms = nodes;
  material.userData.band = band;
  material.userData.volumeOutput = 'straight-alpha';
  material.userData.weatherSystemTexture = weatherMap;
  material.userData.weatherSystemTextureNode = weatherTextureNode;
  return material;
}
