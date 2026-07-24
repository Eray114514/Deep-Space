// Renderer-specific natural material facade. The authored WebGL shaders stay
// intact; the WebGPU/TSL port runs on WebGPU (the default) or its WebGL 2 fallback.
import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const useNodeMaterials = resolveRendererPolicy(params).useNodeMaterials;
const implementation = await import(useNodeMaterials ? './shaders-node-v2.js' : './shaders-webgl.js');

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
