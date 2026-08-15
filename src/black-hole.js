// WebGL 2 baseline: the classic GLSL impostor/accretion/photon materials are
// the only deck. The TSL port (black-hole-node.js) was shelved with the
// WebGPU line — see git history and docs/optimization-roadmap.md (2026-08-15).
export {
  makeBlackHoleImpostorTexture, makeAccretionMaterial, makePhotonMaterial, BlackHole,
} from './black-hole-webgl.js';
