// Terrain rendering system V2 — PBR terrain material with triplanar micro-
// detail, mid-scale patchiness, per-pixel snowline, cloud shadows and valley
// mist. Rewritten from scratch (not migrated) to fix the valley-mist depth
// bug (positionView.z sign error that silently disabled mist) and align the
// cloud-shadow channel with WebGL's fog_fragment.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs, acos, atan, attribute, cross, dot, exp, float, length, mix,
  normalize, normalLocal, output, positionView, pow, select, smoothstep, texture,
  uniform, vec2, vec3, vec4, transformNormalToView,
} from 'three/tsl';
import { detailTexture } from './shaders-node.js';

let _blankTex = null;
function blankTexture() {
  if (!_blankTex) {
    _blankTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    _blankTex.needsUpdate = true;
  }
  return _blankTex;
}

function copyMaterialFlags(source, target) {
  for (const key of ['transparent', 'opacity', 'side', 'depthWrite', 'depthTest',
    'vertexColors', 'flatShading', 'alphaTest', 'blending', 'forceSinglePass']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

function paletteEnds(planet) {
  const land = planet.pal?.land || [];
  return {
    low: land[0]?.c || new THREE.Color(0x3d4a3f),
    high: land[land.length - 1]?.c || new THREE.Color(0xb0a58c),
    rock: planet.pal?.rock || new THREE.Color(0x5f5c58),
  };
}

export function applyTerrainDetailV2(source, planet, strength = 0.2, macroK = 0.4) {
  const material = copyMaterialFlags(source, new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 }));
  const local = attribute('aLocal', 'vec3');
  const matWeights = attribute('aMat', 'vec3');
  const extra = attribute('aExtra', 'vec4');
  const h = length(local).sub(planet.R);
  const U = planet.palU || {};
  const heightMix = h.sub(U.t0 || 0).div(Math.max(1, U.tSpan || planet.hAmp)).clamp(0, 1);
  const palette = paletteEnds(planet);

  // ---- palette per-pixel: exact height & slope, so coasts, depth gradients
  // and rock bands stay crisp at every distance ----
  let landSurface = uniform(U.landC?.[0] || palette.low);
  const landCount = U.landC ? U.landN : 1;
  for (let i = 1; i < landCount; i++) {
    landSurface = mix(landSurface, uniform(U.landC[i]),
      heightMix.sub(U.landT[i - 1]).div(Math.max(U.landT[i] - U.landT[i - 1], 1e-5)).clamp(0, 1));
  }
  let seaSurface = uniform(U.seaC?.[0] || palette.low);
  const seaMix = float(1).sub(float(U.t0 || 0).sub(h).div(Math.max(1, U.seaDepthSpan || planet.hAmp))).clamp(0, 1);
  const seaCount = U.seaC ? U.seaN : 1;
  for (let i = 1; i < seaCount; i++) {
    seaSurface = mix(seaSurface, uniform(U.seaC[i]),
      seaMix.sub(U.seaT[i - 1]).div(Math.max(U.seaT[i] - U.seaT[i - 1], 1e-5)).clamp(0, 1));
  }
  landSurface = mix(landSurface, uniform(U.forest || palette.low), extra.x);
  landSurface = mix(landSurface, uniform(U.blotch || palette.rock), extra.y);
  if ((U.stripeK || 0) > 0.001) {
    landSurface = mix(landSurface, mix(uniform(U.stripeA), uniform(U.stripeB), extra.z), U.stripeK);
  }
  if ((U.extraMode || 0) > 2.5) landSurface = landSurface.mul(float(1).add(extra.w.sub(0.5).mul(0.2)));
  else if ((U.extraMode || 0) > 0.5) landSurface = mix(landSurface, uniform(U.extraC), extra.w);

  const direction = local.normalize();
  const slope = float(1).sub(dot(normalLocal.normalize(), direction).clamp(0, 1));
  landSurface = mix(landSurface, uniform(U.rock || palette.rock),
    smoothstep(U.slopeLo ?? 0.08, U.slopeHi ?? 0.34, slope));
  let surface = U.hasSea ? select(h.lessThan(U.t0), seaSurface, landSurface) : landSurface;

  // ---- triplanar micro-detail in stable planet-local space ----
  const detailMap = detailTexture();
  const weights0 = pow(abs(normalLocal.normalize()), vec3(4));
  const weights = weights0.div(weights0.x.add(weights0.y).add(weights0.z).max(1e-5));
  const triDetail = (p, scale, channel = 'r') => {
    const a = texture(detailMap, p.yz.mul(scale));
    const b = texture(detailMap, p.zx.mul(scale));
    const c = texture(detailMap, p.xy.mul(scale));
    return a[channel].mul(weights.x).add(b[channel].mul(weights.y)).add(c[channel].mul(weights.z));
  };
  const grain = triDetail(local, 1 / 26, 'r').sub(0.5)
    .add(triDetail(local, 1 / 3.2, 'g').sub(0.5).mul(0.8));
  const strat = texture(detailMap, vec2(length(local).mul(0.055), 0.31)).r.sub(0.5);
  let detail = mix(grain, grain.mul(0.5).add(strat.mul(1.15)), matWeights.x);
  detail = detail.add(triDetail(local, (1 / 3.2) * 0.32, 'r').sub(0.5).mul(matWeights.y).mul(0.75));
  surface = surface.mul(float(1).add(detail.mul(strength)));

  // ---- macro drift: continental-scale tint variation ----
  const macro = triDetail(local, 0.0013, 'r').add(triDetail(local, 0.00028, 'g')).sub(1);
  const macroWeight = macro.mul(1.5).add(0.5).clamp(0, 1).mul(macroK);
  surface = surface.mul(mix(vec3(1), vec3(1.09, 0.99, 0.84), macroWeight));

  // ---- mid-scale patchiness (~100–500 m): soil and moisture variation ----
  const pch = triDetail(local, 0.0035, 'g').add(triDetail(local, 0.0012, 'r')).sub(1);
  surface = surface.mul(float(1).add(pch.mul(float(0.30).add(matWeights.z.mul(0.20))).mul(float(0.5).add(macroK))));
  surface = mix(surface, surface.mul(vec3(0.88, 0.97, 0.92)), pch.mul(-1.8).clamp(0, 0.5).mul(macroK));
  surface = surface.mul(mix(0.42, 1, matWeights.z));

  // ---- per-pixel snowline (slope + altitude + latitude cap) ----
  let snowWeight = float(0);
  if (planet.pal?.snow) {
    const latitude = abs(direction.y).add(texture(detailMap, direction.xz.mul(2).add(direction.y)).r.sub(0.5).mul(0.12));
    const snowLine = float(planet.pal.snowLine).mul(float(1).sub(smoothstep(0.45, 0.95, latitude).mul(0.65)));
    snowWeight = smoothstep(snowLine, snowLine.add(planet.hAmp * 0.1), h)
      .max(smoothstep(planet.pal.capLat, planet.pal.capLat + 0.07, latitude))
      .mul(float(1).sub(smoothstep(0.55, 0.8, slope).mul(0.85)));
    surface = mix(surface, uniform(planet.pal.snow), snowWeight);
  }

  // ---- cloud shadow (.g channel, aligned with WebGL) ----
  const cloudMap = planet.cloudShadowTex || blankTexture();
  const cloudMatrix = uniform(new THREE.Matrix3());
  const cloudDirection = cloudMatrix.mul(direction);
  const cloudU = float(0.5).add(atan(cloudDirection.z, cloudDirection.x.negate()).mul(0.15915494));
  const cloudV = float(1).sub(acos(cloudDirection.y.clamp(-1, 1)).mul(0.31830988));
  const cloudK = uniform(planet.cloudMesh ? 0.42 : 0);
  surface = surface.mul(float(1).sub(texture(cloudMap, vec2(cloudU, cloudV)).g.mul(cloudK)));
  material.colorNode = surface;
  material.roughnessNode = float(1).sub(snowWeight.mul(0.42)).add(pch.mul(0.14)).clamp(0.05, 1);

  // ---- valley mist (FIXED: positionView.z depth, 1 - exp(-k*depth)) ----
  // Mirrors WebGL's fog_fragment: vFogDepth is positive view-space depth, and
  // mist attenuation = 1 - exp(-vFogDepth * 3.2e-4). In TSL, positionView.z is
  // negative in front of the camera, so negate to get positive depth. The
  // previous WebGPU code computed 1 - exp(+k*depth) (missing inner negate),
  // which is always <= 0 and clamped to 0 — silently disabling mist.
  //
  // WebGL applies mist AFTER PBR lighting in <fog_fragment>. To match that
  // ordering, the mist blend is injected via outputNode instead of colorNode;
  // otherwise the sky-colored mist would be lit a second time by the standard
  // material, blowing out distant terrain to white/blue.
  {
    const mistBase = planet.liquid === 'lava' ? 0.05 : (planet.hasLiquid ? 0.26 : 0.1);
    const uMistK = uniform(mistBase * Math.min(planet.atmoDensity || 0.4, 1));
    const uMistH = uniform(planet.hAmp * 0.12);
    const uMistColor = uniform(planet.skyColor.clone().convertSRGBToLinear());
    const mistHeight = h.sub(U.t0 || 0);
    const depth = positionView.z.negate(); // positive view-space depth
    const mistAttenuation = float(1).sub(depth.mul(3.2e-4).negate().exp()); // 1 - exp(-k*depth)
    const mistFactor = smoothstep(uMistH, float(0), mistHeight).mul(mistAttenuation);
    const mist = uMistK.mul(mistFactor).clamp(0, 0.6);
    material.outputNode = vec4(mix(output.rgb, uMistColor, mist), 1);
  }

  // ---- normalNode: micro-relief bending (transformNormalToView) ----
  // Bends the shading normal with the same detail field — this, more than
  // geometry, is what makes ground read as real. transformNormalToView is
  // required because normalNode expects view-space input; without it the
  // local-space normal breaks PBR N·L (view-dependent black ground).
  {
    const nrm = normalLocal.normalize();
    const tang = nrm.cross(vec3(0, 1, 0)).add(vec3(1e-4, 1e-4, 1e-4)).normalize();
    const bitn = nrm.cross(tang);
    const dx = vec3(0.35, 0, 0), dy = vec3(0, 0.35, 0);
    const gx = triDetail(local.add(dx), 1 / 3.2, 'g').sub(triDetail(local.sub(dx), 1 / 3.2, 'g'));
    const gy = triDetail(local.add(dy), 1 / 3.2, 'g').sub(triDetail(local.sub(dy), 1 / 3.2, 'g'));
    const bend = tang.mul(gx).add(bitn.mul(gy)).mul(strength).mul(float(1.7).add(matWeights.x.mul(1.5)));
    material.normalNode = transformNormalToView(nrm.add(bend).normalize());
  }

  // Expose cloudMatrix/cloudK for planet.js in-place uniform updates.
  material.userData.shader = { uniforms: { uCloudMat: cloudMatrix, uCloudK: cloudK } };
  material.userData.nodeMaterial = 'terrain-v2';
  source.dispose?.();
  return material;
}
