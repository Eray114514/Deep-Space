// WebGPU-native ocean v6 — PBR + noise-driven non-periodic normal + stable glint.
//
// v5 (MeshBasicNodeMaterial + noise normal) fixed the periodic-white and
// glint-drift bugs but dropped PBR lighting, so the ocean didn't respond to
// the scene's sun/atmosphere lights. v6 keeps v5's stable-glint insight
// (Fresnel + sun specular on the smooth sphere normal) but restores PBR via
// MeshStandardNodeMaterial, and drives the wave normal from scrolling noise
// (detailTexture) instead of a compute FFT — simpler, guaranteed to render
// on frame 0, and non-periodic.
//
// The compute-FFT StorageTexture approach (v2) was abandoned because the
// StorageTexture is empty until the compute kernel runs, and the kernel
// scheduling dependency with ChunkedLOD made first-frame rendering fragile
// (full-black ocean). The noise approach has no such bootstrapping problem.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs, attribute, cos, cross, dot, exp, float, max, min, mix, normalize, pow,
  positionViewDirection, smoothstep, texture, time,
  transformNormalToView, uniform, vec2, vec3,
} from 'three/tsl';
import { detailTexture } from './shaders-node.js';

function copyMaterialFlags(source, target) {
  for (const key of ['transparent', 'opacity', 'side', 'depthWrite', 'depthTest',
    'vertexColors', 'flatShading', 'alphaTest', 'blending', 'forceSinglePass']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

export function makeOceanMaterialV2(source, planet, waveScale = 1 / 14) {
  const material = copyMaterialFlags(source, new MeshStandardNodeMaterial({
    roughness: 0.35, metalness: 0.0,
  }));

  // --- Palette (linear space) ---------------------------------------------
  const palSea = planet && planet.pal && planet.pal.sea ? planet.pal.sea[0].c : null;
  const deepC = (palSea || new THREE.Color(0x061b35)).clone()
    .lerp((planet && planet.liquidColor ? planet.liquidColor.clone().convertSRGBToLinear()
      : new THREE.Color(0.02, 0.08, 0.15)), 0.4);
  const shallowC = (planet && planet.liquidColor ? planet.liquidColor.clone().convertSRGBToLinear()
    : new THREE.Color(0.4, 0.75, 0.8)).clone().lerp(new THREE.Color(1, 1, 1), 0.25);
  const skyC = (planet && planet.skyColor ? planet.skyColor.clone().convertSRGBToLinear()
    : new THREE.Color(0.25, 0.4, 0.55)).clone().multiplyScalar(0.6);
  const sunC = new THREE.Color(1.0, 0.98, 0.92);
  const deepVec = vec3(deepC.r, deepC.g, deepC.b);
  const shallowVec = vec3(shallowC.r, shallowC.g, shallowC.b);
  const skyVec = vec3(skyC.r, skyC.g, skyC.b);
  const sunVec = vec3(sunC.r, sunC.g, sunC.b);

  // --- Uniforms -----------------------------------------------------------
  const sunDirLocal = uniform(
    (planet && planet.sunDirLocal ? planet.sunDirLocal.clone() : new THREE.Vector3(0, 1, 0))
  );
  const opacity = uniform(source.opacity !== undefined ? source.opacity : 1);

  // --- Attributes ---------------------------------------------------------
  const local = attribute('aLocal', 'vec3');
  const depth = attribute('aDepth', 'float').max(0);

  // --- Smooth sphere normal: stable, drives Fresnel + specular ------------
  const smoothN = normalize(local);

  // --- Noise-driven wave normal (NON-PERIODIC) ----------------------------
  // Triplanar sampling of the shared detail texture, scrolled slowly. The
  // noise has no fixed spatial wavelength, so it cannot form the repeating
  // bright stripes that pure Gerstner sinusoids imprint on a sphere.
  const detailMap = detailTexture();
  const tt = time;
  const s1 = waveScale, s2 = waveScale * 2.3;
  const g1 = texture(detailMap, local.xy.mul(s1).add(vec2(tt.mul(0.018), tt.mul(-0.011)))).g
    .add(texture(detailMap, local.yz.mul(s1).add(vec2(tt.mul(0.013), tt.mul(0.02)))).g)
    .add(texture(detailMap, local.zx.mul(s1).add(vec2(tt.mul(-0.016), tt.mul(0.014)))).g).div(3);
  const g2 = texture(detailMap, local.xy.mul(s2).add(vec2(tt.mul(-0.022), tt.mul(0.017)))).r
    .add(texture(detailMap, local.yz.mul(s2).add(vec2(tt.mul(0.019), tt.mul(-0.013)))).r)
    .add(texture(detailMap, local.zx.mul(s2).add(vec2(tt.mul(0.015), tt.mul(0.021)))).r).div(3);
  const upRef = abs(smoothN.y).lessThan(0.88).select(vec3(0, 1, 0), vec3(1, 0, 0));
  const t1 = normalize(cross(upRef, smoothN));
  const t2 = cross(smoothN, t1);
  const waveN = normalize(smoothN
    .add(t1.mul(g1.sub(0.5).mul(0.35)))
    .add(t2.mul(g2.sub(0.5).mul(0.35))));

  // --- View-space vectors -------------------------------------------------
  const NsmoothV = transformNormalToView(smoothN);
  const NwaveV = transformNormalToView(waveN);
  const V = normalize(positionViewDirection);
  const L = transformNormalToView(normalize(sunDirLocal));

  // --- Fresnel on SMOOTH normal: stable, no periodic brightening ----------
  const NdotV = abs(dot(NsmoothV, V)).clamp(0, 1);
  const fres = pow(float(1).sub(NdotV), 5);
  const fresSchlick = fres.add(float(0.02).mul(float(1).sub(fres)));

  // --- N·L diffuse factor on WAVE normal: ripples without stripes ---------
  const NdotL = dot(NwaveV, L).clamp(0, 1);

  // --- Sun specular on SMOOTH normal: glint pinned to geometry, no drift --
  const H = normalize(V.add(L));
  const NdotH = dot(NsmoothV, H).max(0);
  const spec = pow(NdotH, 180).mul(1.5);

  // --- Wavelength-dependent Beer–Lambert absorption -----------------------
  const absR = float(1).sub(exp(depth.mul(-0.06)));
  const absG = float(1).sub(exp(depth.mul(-0.035)));
  const absB = float(1).sub(exp(depth.mul(-0.02)));
  const waterBody = vec3(
    mix(shallowVec.x, deepVec.x, absR),
    mix(shallowVec.y, deepVec.y, absG),
    mix(shallowVec.z, deepVec.z, absB),
  );
  const sss = skyVec.mul(0.10).mul(absG);

  // --- Foam: shoreline surf only (no crest foam — that was periodic) ------
  const shoreFoam = smoothstep(0, 6, depth).mul(smoothstep(22, 0, depth)).mul(0.25);

  // --- colorNode: PBR base color (diffuse comes from N·L via normalNode) ---
  // PBR will multiply this by lighting; keep it the water body color so
  // diffuse ripples show through. Fresnel sky reflection and sun glint are
  // added via emissiveNode so they stay on the smooth normal (stable).
  material.colorNode = waterBody.add(sss);

  // --- normalNode: wave-perturbed, for PBR diffuse + ambient specular -----
  material.normalNode = NwaveV;

  // --- roughnessNode: wet sheen, foam mats it down ------------------------
  material.roughnessNode = mix(float(0.18), float(0.65), shoreFoam);
  material.metalnessNode = float(0.0);

  // --- emissiveNode: stable Fresnel sky reflection + sun glint ------------
  // Additive (unlit) so they ride on top of PBR without inheriting the
  // perturbed normal. Using the smooth normal is the core fix for the
  // glint-drift and periodic-white bugs.
  const skyRefl = skyVec.mul(fresSchlick.mul(0.5));
  const sunGlint = sunVec.mul(spec);
  material.emissiveNode = skyRefl.add(sunGlint).add(vec3(shoreFoam));

  // --- opacityNode: depth fade + Fresnel opacity --------------------------
  const depthFactor = mix(float(0.22), float(1.0), float(1).sub(exp(depth.mul(-0.12))));
  const depthOpacity = opacity.mul(depthFactor);
  material.opacityNode = mix(depthOpacity, depthOpacity.mul(2.0).add(0.2).min(1.0), fres);

  // --- userData contract --------------------------------------------------
  material.userData.nodeMaterial = 'ocean-v6-pbr-noise';
  material.userData.opacityNodeUniform = opacity;
  material.userData.sunDirUniform = sunDirLocal;
  source.dispose?.();
  return material;
}
