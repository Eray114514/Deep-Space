// The receiver depth draw and opaque draw use the same scene/camera within
// one pipeline render. Native maps already reflect this frame's deformations.
// Reuse them only after a successful depth preparation; explicit invalidation
// still wins. Always restore the renderer's public update policy.
export function withPreparedShadows(renderer,prepared,work) {
  const shadows=renderer.shadowMap,auto=shadows.autoUpdate;
  if(prepared&&!shadows.needsUpdate)shadows.autoUpdate=false;
  try {return work();} finally {shadows.autoUpdate=auto;}
}
