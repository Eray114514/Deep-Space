// Shared WebGPU volume-depth contract.
//
// The production camera writes logarithmic depth across centimetres-to-AU
// scale. The retired volume path approximated that curve without the near
// plane and a later repair incorrectly used perspective-depth linearization.
// Both errors could make atmosphere/clouds cover terrain or vanish inside the
// planet disk. Every participating medium now shares this exact contract.

import { logarithmicDepthToViewZ, screenUV } from 'three/tsl';

export function sceneRayLimit(nodes, forwardCos, padding = 0) {
  const rawDepth = nodes.tSceneDepth.sample(screenUV).r;
  // The production renderer writes logarithmic fragment depth because one
  // camera spans cockpit centimetres and astronomical distances. Perspective
  // linearization therefore underestimates a 700 km surface hit to the near
  // plane and clips the entire cloud disk, leaving only a bright limb.
  const conventionalHasDepth = rawDepth.lessThan(0.999999);
  const reversedHasDepth = rawDepth.greaterThan(0.000001);
  const hasOpaqueDepth = nodes.uDepthReady.greaterThan(0.5)
    .and(nodes.uDepthReversed.greaterThan(0.5)
      .select(reversedHasDepth, conventionalHasDepth));
  const viewZ = logarithmicDepthToViewZ(
    rawDepth,
    nodes.uCameraNear,
    nodes.uCameraFar,
  );
  // viewZ is negative in front of the camera. The volume ray parameter is a
  // true Euclidean distance, so compensate for the ray's forward cosine.
  const rayDistance = viewZ.negate().div(forwardCos.max(0.0001))
    .add(padding).max(0);
  return { hasOpaqueDepth, rayDistance };
}
