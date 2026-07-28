// Shared WebGPU volume-depth contract.
//
// A perspective depth buffer is not logarithmic distance. The retired volume
// path treated it as `pow(far + 1, depth) - 1`, which only happened to look
// plausible in a few fixed cameras and let atmosphere/clouds composite in
// front of opaque terrain during a real descent. Every participating medium
// now resolves the same view-space distance from the opaque pass.

import {
  float, mix, perspectiveDepthToViewZ, screenUV,
} from 'three/tsl';

export function sceneRayLimit(nodes, forwardCos, padding = 0) {
  const rawDepth = nodes.tSceneDepth.sample(screenUV).r;
  // Three's WebGPU backend uses reversed depth when supported. Convert both
  // layouts to the conventional near=0/far=1 form before linearization.
  const perspectiveDepth = mix(rawDepth, float(1).sub(rawDepth), nodes.uDepthReversed);
  const hasOpaqueDepth = nodes.uDepthReady.greaterThan(0.5)
    .and(perspectiveDepth.lessThan(0.999999));
  const viewZ = perspectiveDepthToViewZ(
    perspectiveDepth,
    nodes.uCameraNear,
    nodes.uCameraFar,
  );
  // viewZ is negative in front of the camera. The volume ray parameter is a
  // true Euclidean distance, so compensate for the ray's forward cosine.
  const rayDistance = viewZ.negate().div(forwardCos.max(0.0001))
    .add(padding).max(0);
  return { hasOpaqueDepth, rayDistance };
}
