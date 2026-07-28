// Flora rendering system V2 — wind sway (positionGeometry.y, no instance
// translation pollution) and far-flora distance dissolve (uCamL-based
// smoothstep scaling, not emissive soft fade). Rewritten from scratch to
// restore the WebGL distance fade that the WebGPU branch dropped.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  cos, float, fract, instanceIndex, length, positionGeometry, positionLocal,
  sin, smoothstep, uniform, vec3, vertexColor,
} from 'three/tsl';
import { TIME } from './shaders-node.js';

function copyMaterialFlags(source, target) {
  for (const key of ['transparent', 'opacity', 'side', 'depthWrite', 'depthTest',
    'vertexColors', 'flatShading', 'alphaTest', 'blending', 'forceSinglePass']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

export function applyWindSwayV2(source, { sway = 0.1, grow = 1 } = {}) {
  const material = copyMaterialFlags(source, new MeshStandardNodeMaterial({
    roughness: source.roughness, metalness: source.metalness,
  }));
  const uGrow = uniform(grow);
  const uSway = uniform(sway);
  const uTime = uniform(TIME.value).onFrameUpdate(() => TIME.value);
  // Per-instance phase from instanceIndex (golden-angle distribution).
  const phase = fract(float(instanceIndex).mul(0.6180339)).mul(6.28318);
  // positionGeometry is the raw attribute — untouched by instancing — so its
  // y gives the true 0–5 m local height the sway was tuned against. Using
  // positionLocal.y would read the world-space coordinate (~90k) and produce
  // enormous sway offsets (the "plants flying into the sky" bug).
  const height = positionGeometry.y.max(0);
  // X and Z sway use different frequencies/phases (matching the GLSL deck)
  // so foliage doesn't oscillate in a single plane.
  const swayX = sin(uTime.mul(1.6).add(phase))
    .add(sin(uTime.mul(3.7).add(phase.mul(1.7))).mul(0.4))
    .mul(uSway).mul(height).mul(uGrow);
  const swayZ = cos(uTime.mul(1.3).add(phase.mul(1.3)))
    .add(sin(uTime.mul(2.9).add(phase)).mul(0.4))
    .mul(uSway).mul(height).mul(0.7).mul(uGrow);
  // positionNode references positionLocal (which already carries the instance
  // matrix, since NodeMaterial applies instancing before positionNode) so
  // instancing is preserved. Do NOT multiply positionLocal by uGrow: it
  // includes the instance translation, so scaling it would drag every plant
  // toward the world origin. uGrow only modulates sway strength.
  material.positionNode = positionLocal.add(vec3(swayX, 0, swayZ));
  material.colorNode = source.vertexColors ? vertexColor() : uniform(source.color?.clone() || new THREE.Color(1, 1, 1));
  if (source.emissive) material.emissiveNode = uniform(source.emissive.clone())
    .mul(source.vertexColors ? vertexColor() : 1);
  material.userData.nodeMaterial = 'wind-sway-v2';
  material.userData.uniforms = { uTime, uGrow, uSway };
  source.dispose?.();
  return material;
}

export function applyFarFadeV2(mat, uniforms) {
  const alt = uniform(uniforms.uAltK.value).onFrameUpdate(() => uniforms.uAltK.value);
  const uCamL = uniform(uniforms.uCamL.value).onFrameUpdate(() => uniforms.uCamL.value);
  const nodeMaterial = new MeshStandardNodeMaterial({
    color: 0xffffff, vertexColors: true, roughness: mat.roughness,
    flatShading: mat.flatShading,
  });
  // Distance-based dissolve, restoring the WebGL behavior that the WebGPU
  // branch dropped (it only modulated emissive intensity as a soft fade).
  // uCamL is object-local (set by main.js via worldOffsetToLocal), and
  // positionLocal carries the instance translation (instancing is applied
  // before positionNode), so length(positionLocal - uCamL) approximates the
  // per-instance distance — matching WebGL's distance(instanceMatrix[3].xyz,
  // uCamL). positionWorld is NOT used because the planet group applies a
  // frame rotation that would put positionWorld in a different space than
  // uCamL, breaking the distance calculation.
  const d = length(positionLocal.sub(uCamL));
  const g = float(1).sub(smoothstep(float(3900), float(4400), d)).mul(alt)
    .mul(float(1.15).add(smoothstep(float(450), float(2400), d).mul(1.15)));
  // Scale the raw geometry (positionGeometry) by g while preserving the
  // instance translation. positionLocal.mul(g) would scale the translation
  // too, dragging proxies toward the world origin. Instead, subtract
  // positionGeometry*(1-g) from positionLocal: this equals
  // instanceMatrix * (positionGeometry * g) when instanceMatrix is a pure
  // translation (the common case for flora proxies), giving the correct
  // "shrink in place" behavior.
  nodeMaterial.positionNode = positionLocal.sub(positionGeometry.mul(float(1).sub(g)));
  nodeMaterial.colorNode = vertexColor();
  nodeMaterial.userData.nodeMaterial = 'far-flora-v2';
  nodeMaterial.userData.uniforms = { uCamL, uAltK: alt };
  mat.dispose();
  return nodeMaterial;
}
