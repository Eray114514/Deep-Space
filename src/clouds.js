// Cloud facade — WebGL 2 only. The authored GLSL raymarch in clouds-webgl.js
// is the sole implementation; the TSL/NodeMaterial port was retired with the
// WebGPU backend (see git commit b746772 for the last WebGPU code).
import * as implementation from './clouds-webgl.js';

export const cloudNoiseTexture = implementation.cloudNoiseTexture;
export const disposeCloudNoiseTexture = implementation.disposeCloudNoiseTexture;
export const makeCloudVolumeMaterial = (...args) => implementation.makeCloudVolumeMaterial(...args);
