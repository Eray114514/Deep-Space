// WebGL 2 baseline: the authored cloud shader/raymarch is the only deck.
// The TSL port (clouds-node.js) was shelved with the WebGPU line — see git
// history and docs/optimization-roadmap.md (2026-08-15 decision).
export { cloudNoiseTexture, disposeCloudNoiseTexture, makeCloudVolumeMaterial } from './clouds-webgl.js';
