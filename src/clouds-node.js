// Shared cloud noise and WebGPURenderer-compatible cloud-shell material.
// The close cloud volume now uses a bounded analytic shell node; the global
// deck and CPU transit fog still share the same deterministic weather field.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  acos, atan, dot, exp, float, Fn, fract, If, Loop, mix, positionLocal, positionView,
  pow, screenUV, sin, sqrt, smoothstep, texture, texture3D, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { hash3i, hashFloat } from './rng.js';
import { sceneRayLimit } from './volume-depth-node.js';

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

export function makeCloudVolumeMaterial(planet, band, detailTex, weatherLoMap,
  weatherHiMap,
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
    uDepthReversed: uniform(0), uCameraNear: uniform(0.12), uCameraFar: uniform(1.2e11),
    uVolumeSize: uniform(new THREE.Vector2(1, 1)),
    uSunC: uniform(new THREE.Color(1, 0.98, 0.94)),
    uAmbC: uniform(new THREE.Color(0.35, 0.42, 0.55)),
    uTint: uniform(new THREE.Color(band.tint || 0xffffff)),
    uEngage: uniform(0), uFrame: uniform(0), uWeatherTime: uniform(0),
    uDebugShell: uniform(0),
    uMaxSteps: uniform(quality === 'performance' || quality === 'low' ? 24 : 56),
    uLightSteps: uniform(quality === 'performance' || quality === 'low' ? 2 : 5),
    uQuality: uniform(quality === 'performance' || quality === 'low' ? 0 : 1),
  };
  const weatherUV = (d) => vec2(
    float(0.5).add(atan(d.z, d.x.negate()).mul(0.15915494)),
    float(1).sub(acos(d.y.clamp(-1, 1)).mul(0.31830988)),
  );
  const weatherLoTextureNode = texture(weatherLoMap);
  const weatherHiTextureNode = texture(weatherHiMap);
  // A deliberately cheaper density evaluation for the sun ray. It preserves
  // the same weather ownership and vertical families as the view ray while
  // using one 3D lookup instead of the full erosion cascade. This makes real
  // self-shadowing affordable at every occupied view-ray sample.
  const lightDensityAt = (samplePosition) => {
    const radius = samplePosition.length();
    const direction = samplePosition.div(radius.max(1));
    const weatherDirection = nodes.uSpin.mul(direction);
    const height = radius.sub(nodes.uRin)
      .div(nodes.uRout.sub(nodes.uRin).max(1)).clamp(0, 1);
    const lo = weatherLoTextureNode.sample(weatherUV(weatherDirection));
    const hi = weatherHiTextureNode.sample(weatherUV(weatherDirection));
    const formationThreshold = mix(0.36, 0.22, lo.g);
    const coverage = smoothstep(formationThreshold,
      formationThreshold.add(0.42), lo.r);
    const lowTop = mix(0.34, 0.78, lo.g).add(hi.b.mul(0.16)).clamp(0.3, 0.94);
    const lowEnvelope = smoothstep(0.018, 0.075, height)
      .mul(smoothstep(lowTop, lowTop.sub(0.2), height))
      .max(smoothstep(0.012, 0.052, height)
        .mul(smoothstep(0.47, 0.32, height)).mul(lo.b));
    const highEnvelope = smoothstep(0.28, 0.4, height)
      .mul(smoothstep(0.99, 0.82, height)).mul(hi.r)
      .mul(float(0.34).add(hi.g.mul(0.34)).add(hi.b.mul(0.32)));
    const advectedPosition = nodes.uSpin.mul(samplePosition)
      .mul(1 / 42000)
      .add(vec3(
        nodes.uWeatherTime.mul(0.011),
        nodes.uWeatherTime.mul(-0.0036),
        nodes.uWeatherTime.mul(0.0074),
      ))
      .add(vec3(height.mul(0.37), height.mul(1.4), height.mul(0.23)));
    const body = texture3D(cloudNoiseTexture(), advectedPosition).r;
    return coverage.mul(lowEnvelope.max(highEnvelope))
      .mul(float(0.24).add(body.mul(0.94)))
      .mul(float(0.74).add(lo.a.mul(0.3)))
      .clamp(0, 1);
  };
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
    const forwardCos = positionView.normalize().z.negate().max(0.035);
    const sceneDepth = sceneRayLimit(nodes, forwardCos, 0.35);
    t1.assign(sceneDepth.hasOpaqueDepth.select(t1.min(sceneDepth.rayDistance), t1));
    const span = t1.sub(t0).max(0);
    const stepCount = nodes.uMaxSteps.clamp(16, 64).toVar();
    const stepLength = span.div(stepCount);
    const thickness = nodes.uRout.sub(nodes.uRin).max(1);
    // Interleaved-gradient jitter removes coherent shell slices. A fixed
    // midpoint made all neighbouring pixels cross the same 56 radial samples,
    // producing the vertical white brush marks seen during cloud traversal.
    // Keep the pattern temporally stable: without a history buffer, frame-
    // varying blue noise would trade those bands for distracting shimmer.
    const rayJitter = fract(sin(dot(screenUV.mul(nodes.uVolumeSize),
      vec2(12.9898, 78.233))).mul(43758.5453));
    const t = t0.add(stepLength.mul(float(0.12).add(rayJitter.mul(0.76)))).toVar();
    const integrated = vec3(0).toVar();
    const transmission = float(1).toVar();
    Loop(64, ({ i }) => {
      If(i.lessThan(stepCount), () => {
        const samplePosition = origin.add(ray.mul(t));
        const radius = samplePosition.length();
        const direction = samplePosition.div(radius.max(1));
        const weatherDirection = nodes.uSpin.mul(direction);
        const height = radius.sub(nodes.uRin).div(thickness).clamp(0, 1);
        const uv = weatherUV(weatherDirection);
        // Meteorological Lo/Hi maps preserve the HPVolumeCloud-style contract
        // instead of discarding cloud families in one over-packed atlas.
        // Lo = density, cloud type, stratus mask, humidity.
        // Hi = high mask, high type, convective energy, multi scatter.
        const weatherLo = weatherLoTextureNode.sample(uv);
        const weatherHi = weatherHiTextureNode.sample(uv);
        const weatherRaw = weatherLo.r;
        const cloudType = weatherLo.g;
        const stratusMask = weatherLo.b;
        const humidity = weatherLo.a;
        const highMask = weatherHi.r;
        const highType = weatherHi.g;
        const convective = weatherHi.b;
        const multipleScatter = weatherHi.a;
        // Coverage is a meteorological probability field, not literal vapour
        // density. Feeding its unshaped value into every ray step turned even
        // 20–30% coverage into a planet-wide grey extinction curtain. A
        // type-aware formation threshold preserves coherent fronts while
        // leaving genuinely clear air between cells.
        const formationThreshold = mix(0.36, 0.22, cloudType);
        const weather = smoothstep(formationThreshold,
          formationThreshold.add(0.42), weatherRaw);
        const stratusProfile = smoothstep(0.015, 0.055, height)
          .mul(smoothstep(0.25, 0.13, height))
          .mul(stratusMask);
        const cumulusTop = mix(0.34, 0.78, cloudType)
          .add(convective.mul(0.16)).clamp(0.3, 0.94);
        const cumulusProfile = smoothstep(0.025, 0.09, height)
          .mul(smoothstep(cumulusTop, cumulusTop.sub(0.18), height))
          .mul(float(1).sub(stratusMask.mul(0.72)));
        const altoProfile = smoothstep(0.27, 0.39, height)
          .mul(smoothstep(0.62, 0.49, height))
          .mul(highMask.mul(float(1).sub(highType)));
        const cirrusProfile = smoothstep(0.62, 0.72, height)
          .mul(smoothstep(0.99, 0.88, height))
          .mul(highMask).mul(float(0.42).add(highType.mul(0.58)));
        const anvilProfile = smoothstep(0.57, 0.66, height)
          .mul(smoothstep(0.88, 0.78, height))
          .mul(convective).mul(cloudType);
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
        // Planet-scale weather decides placement; higher-frequency 3D
        // Perlin-Worley and erosion decide cauliflower lobes and wispy edges.
        // Detail is metre-scaled, not unit-sphere-scaled. Multiplying only the
        // direction by 18.5 created cloud lobes hundreds of kilometres wide;
        // from inside, each ray then sampled almost the same column and exposed
        // marching bands. 42 km weather cells with an 11.5 km erosion cascade
        // preserve orbital systems while resolving cauliflower structure in
        // low flight.
        const weatherPosition = nodes.uSpin.mul(samplePosition);
        const volumeUV = weatherPosition.mul(1 / 42000).add(vec3(0.5)).add(slowWind)
          .add(vec3(height.mul(0.37), height.mul(1.4), height.mul(0.23)));
        const detail = texture3D(cloudNoiseTexture(), volumeUV).r;
        const upperDetail = texture3D(cloudNoiseTexture(),
          weatherPosition.mul(1 / 11500).add(volumeUV.mul(0.19)).add(detailWind)
          .add(vec3(0.37, 0.61, 0.19))).g;
        const erosion = texture(detailTex,
          uv.mul(vec2(54, 27)).add(nodes.uCOff.xy.mul(0.09))
            .add(nodes.uWeatherTime.mul(vec2(0.0007, -0.00031)))).g;
        const billowShape = float(0.34).add(detail.mul(0.92))
          .sub(float(1).sub(upperDetail).mul(mix(0.16, 0.42, height)));
        // Secondary genera share the same meteorological Lo/Hi channels but
        // occupy distinct vertical shapes. This is more than naming metadata:
        // each term changes the actual density sampled by the ray marcher.
        const stratocumulusProfile = smoothstep(0.055, 0.11, height)
          .mul(smoothstep(0.34, 0.24, height))
          .mul(stratusMask).mul(float(1).sub(cloudType.mul(0.68)))
          .mul(float(0.42).add(detail.mul(0.76)));
        const nimbostratusProfile = smoothstep(0.02, 0.07, height)
          .mul(smoothstep(0.48, 0.34, height))
          .mul(stratusMask).mul(humidity)
          .mul(float(0.54).add(convective.mul(0.32)));
        const altocumulusProfile = smoothstep(0.28, 0.37, height)
          .mul(smoothstep(0.62, 0.49, height))
          .mul(highMask).mul(float(1).sub(highType.mul(0.72)))
          .mul(smoothstep(0.38, 0.68, detail));
        const lenticularProfile = smoothstep(0.34, 0.39, height)
          .mul(smoothstep(0.48, 0.43, height))
          .mul(highMask).mul(float(1).sub(convective))
          .mul(smoothstep(0.68, 0.84, erosion));
        const cirrocumulusProfile = smoothstep(0.7, 0.76, height)
          .mul(smoothstep(0.96, 0.88, height))
          .mul(highMask).mul(highType)
          .mul(smoothstep(0.46, 0.72, upperDetail));
        const towerProfile = smoothstep(0.04, 0.12, height)
          .mul(smoothstep(0.86, 0.68, height))
          .mul(convective).mul(cloudType)
          .mul(float(0.28).add(detail.mul(1.02)));
        const lowShape = stratusProfile.mul(float(0.82).add(erosion.mul(0.22)))
          .max(cumulusProfile.mul(billowShape));
        const lowFamilies = lowShape.max(stratocumulusProfile)
          .max(nimbostratusProfile).max(towerProfile);
        const thinShape = altoProfile.mul(float(0.44).add(detail.mul(0.42)))
          .max(cirrusProfile.mul(float(0.25).add(erosion.mul(0.5))))
          .max(anvilProfile.mul(float(0.48).add(detail.mul(0.54))))
          .max(altocumulusProfile).max(lenticularProfile)
          .max(cirrocumulusProfile);
        const lowDensity = weather.mul(lowFamilies)
          .mul(float(0.72).add(humidity.mul(0.34)));
        const highDensity = highMask.mul(thinShape)
          .mul(float(0.44).add(highType.mul(0.38)));
        const density = pow(lowDensity.max(highDensity)
          .sub(float(1).sub(upperDetail).mul(0.11))
          .clamp(0, 1), 1.18);
        const primaryDir = nodes.uStellarDirections0.normalize();
        const secondaryDir = nodes.uStellarDirections1.normalize();
        // HPVolumeCloud-inspired cone light march. Five geometrically growing
        // segments cover the useful cloud-internal light path. Direct light
        // uses Beer extinction; the additive phi_fwd term uses the much slower
        // diffusion attenuation sqrt(3 * (1 - omega0)), omega0 = 0.999.
        // Consequently thin edges retain directional silver lining while an
        // optically thick core receives soft, isotropic internal illumination.
        const lightB = dot(samplePosition, primaryDir);
        const lightDisc = lightB.mul(lightB).sub(dot(samplePosition, samplePosition))
          .add(nodes.uRout.mul(nodes.uRout));
        const lightExit = lightB.negate().add(sqrt(lightDisc.max(0))).max(0);
        const lightCover = lightExit.min(thickness.mul(0.9)).min(12000);
        const lightDenom = pow(2, nodes.uLightSteps).sub(1).max(1);
        const lightOpticalDepth = float(0).toVar();
        const lightKappaDepth = float(0).toVar();
        const sourceSurvival = float(1).toVar();
        const phiForward = float(0).toVar();
        Loop(5, ({ i: lightIndex }) => {
          If(lightIndex.lessThan(nodes.uLightSteps), () => {
            const ratioPower = pow(2, float(lightIndex));
            const lightStep = lightCover.mul(ratioPower).div(lightDenom);
            const lightStart = lightCover.mul(ratioPower.sub(1)).div(lightDenom);
            const lightDistance = lightStart.add(lightStep.mul(0.5));
            const lightPosition = samplePosition.add(primaryDir.mul(lightDistance));
            const lightDensity = lightDensityAt(lightPosition);
            const localOpticalDepth = lightDensity.mul(lightStep).div(thickness)
              .mul(float(3.4).add(convective.mul(1.8))
                .add(stratusMask.mul(humidity).mul(0.65)));
            const centerOpticalDepth = lightOpticalDepth
              .add(localOpticalDepth.mul(0.5));
            const kappaStep = localOpticalDepth.mul(0.05477226);
            const kappaToCenter = lightKappaDepth.add(kappaStep.mul(0.5));
            const multipleScatterBuild = float(1)
              .sub(exp(centerOpticalDepth.mul(-1.35)));
            const inverseRadiusWeight = lightStep
              .div(lightDistance.add(lightStep.mul(0.5)).max(1));
            phiForward.addAssign(sourceSurvival
              .mul(localOpticalDepth).mul(lightDensity)
              .mul(multipleScatterBuild)
              .mul(exp(kappaToCenter.negate()))
              .mul(inverseRadiusWeight));
            lightOpticalDepth.addAssign(localOpticalDepth);
            lightKappaDepth.addAssign(kappaStep);
            // Only true absorption removes energy from the diffuse field.
            sourceSurvival.mulAssign(exp(localOpticalDepth.mul(-0.001)));
          });
        });
        const selfShadow = exp(lightOpticalDepth.mul(-1.08)).clamp(0.025, 1);
        const diffuseField = float(1).sub(exp(phiForward.mul(-5.6)))
          .mul(multipleScatter)
          .mul(smoothstep(0.045, 0.32, density));
        const day0 = smoothstep(-0.16, 0.24, dot(direction, primaryDir));
        const day1 = smoothstep(-0.16, 0.24, dot(direction, secondaryDir));
        // Dual-lobe Henyey-Greenstein plus Beer-powder lighting preserves the
        // silver forward rim without crushing cloud sides/bottoms to black.
        const viewToLight = dot(ray.negate(), primaryDir).clamp(-1, 1);
        const gForward = float(0.68);
        const gBack = float(-0.22);
        const phaseForward = float(1).sub(gForward.mul(gForward))
          .div(pow(float(1).add(gForward.mul(gForward))
            .sub(gForward.mul(viewToLight).mul(2)), 1.5).mul(12.56637));
        const phaseBack = float(1).sub(gBack.mul(gBack))
          .div(pow(float(1).add(gBack.mul(gBack))
            .sub(gBack.mul(viewToLight).mul(2)), 1.5).mul(12.56637));
        const phase = phaseForward.mul(0.82).add(phaseBack.mul(0.18))
          .mul(7.5).clamp(0.18, 2.4);
        const powder = float(1).sub(exp(density.mul(-5.2)));
        const direct0 = day0.mul(selfShadow).mul(nodes.uStarIrradiance0);
        const direct1 = day1.mul(nodes.uStarIrradiance1);
        const directLight = direct0.add(direct1)
          .mul(mix(0.22, 1, height)).mul(phase);
        const heightLight = mix(0.62, 1.1, height);
        const stellarColor = nodes.uStellarRadiance0.mul(direct0)
          .add(nodes.uStellarRadiance1.mul(direct1))
          .div(direct0.add(direct1).max(0.001));
        const internalLight = nodes.uAmbC.mul(float(0.64)
          .add(multipleScatter.mul(0.28)).add(powder.mul(0.14)));
        const diffuseSun = nodes.uStellarRadiance0
          .mul(diffuseField).mul(day0).mul(0.92);
        const cloudColor = internalLight.add(stellarColor.mul(directLight))
          .add(diffuseSun)
          .mul(nodes.uTint).mul(heightLight);
        const extinctionStrength = float(3.4).add(convective.mul(1.8))
          .add(stratusMask.mul(humidity).mul(0.65));
        const alphaStep = float(1).sub(exp(
          density.mul(stepLength).div(thickness).mul(extinctionStrength).negate()));
        integrated.addAssign(cloudColor.mul(transmission).mul(alphaStep));
        transmission.mulAssign(float(1).sub(alphaStep));
        t.addAssign(stepLength);
      });
    });
    const valid = outerDisc.greaterThan(0).and(t1.greaterThan(t0));
    const alpha = valid.select(float(1).sub(transmission).mul(nodes.uEngage).clamp(0, 0.97), float(0));
    const resolved = vec4(integrated.mul(nodes.uEngage), alpha);
    return nodes.uDebugShell.greaterThan(0.5)
      .select(vec4(1, 0.05, 0.02, valid.select(0.55, 0)), resolved);
  })();
  const material = new MeshBasicNodeMaterial({
    transparent: true, premultipliedAlpha: true, depthWrite: false,
    depthTest: true, side: THREE.BackSide, fog: false,
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
  material.userData.weatherLoTexture = weatherLoMap;
  material.userData.weatherHiTexture = weatherHiMap;
  material.userData.weatherLoTextureNode = weatherLoTextureNode;
  material.userData.weatherHiTextureNode = weatherHiTextureNode;
  material.userData.cloudFamilies = [
    'stratus', 'stratocumulus', 'nimbostratus', 'cumulus',
    'cumulonimbus', 'altocumulus', 'altostratus',
    'cirrus', 'cirrocumulus', 'lenticular', 'anvil',
  ];
  return material;
}
