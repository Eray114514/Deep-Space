// Natural material facade — WebGL 2 only. The authored GLSL shaders in
// shaders-webgl.js are the sole implementation; the TSL/NodeMaterial port was
// retired with the WebGPU backend (see git commit b746772 for the last code).
import * as implementation from './shaders-webgl.js';

export const TIME = implementation.TIME;
export const GROW = implementation.GROW;
export const tickShaders = implementation.tickShaders;
export const sampleDetailCPU = implementation.sampleDetailCPU;
export const detailTexture = implementation.detailTexture;
export const disposeDetailTexture = implementation.disposeDetailTexture;
export const cloudDensityCPU = implementation.cloudDensityCPU;
export const cloudBaseDensityCPU = implementation.cloudBaseDensityCPU;
export const applyTerrainDetail = (material, ...args) =>
  implementation.applyTerrainDetail(material, ...args) || material;
export const applyWaterWaves = (material, ...args) =>
  implementation.applyWaterWaves(material, ...args) || material;
export const applyCloudField = (material, ...args) =>
  implementation.applyCloudField(material, ...args) || material;
export const applyWindSway = (material, ...args) =>
  implementation.applyWindSway(material, ...args) || material;
