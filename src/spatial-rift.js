// WebGL 2 baseline: the classic GLSL rift distortion is the only deck. The
// TSL port (spatial-rift-node.js) was shelved with the WebGPU line — see git
// history and docs/optimization-roadmap.md (2026-08-15).
export {
  DEFAULT_RIFT_PROFILE, createRiftProfile, SpatialRift,
} from './spatial-rift-webgl.js';
