// Renderer-specific natural material facade. The authored WebGL shaders stay
// intact while the WebGPU/TSL port is validated in its explicit experiment.
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const useNodeMaterials = params?.get('renderer') === 'webgpu';
const implementation = await import(useNodeMaterials ? './shaders-node.js' : './shaders-webgl.js');

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
