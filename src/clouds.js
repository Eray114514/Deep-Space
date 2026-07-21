// Renderer-specific cloud facade. WebGL keeps the authored shader/raymarch;
// the TSL port is isolated behind the explicit WebGPU experiment.
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const useNodeMaterials = params?.get('renderer') === 'webgpu';
const implementation = await import(useNodeMaterials ? './clouds-node.js' : './clouds-webgl.js');

export const cloudNoiseTexture = implementation.cloudNoiseTexture;
export const disposeCloudNoiseTexture = implementation.disposeCloudNoiseTexture;
export const makeCloudVolumeMaterial = (...args) => implementation.makeCloudVolumeMaterial(...args);
