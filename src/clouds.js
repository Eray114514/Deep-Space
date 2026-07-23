// Renderer-specific cloud facade. WebGL keeps the authored shader/raymarch;
// the TSL port runs on WebGPU (the default) or its WebGL 2 fallback.
import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const useNodeMaterials = resolveRendererPolicy(params).backend === 'webgpu';
const implementation = await import(useNodeMaterials ? './clouds-node-v2.js' : './clouds-webgl.js');

export const cloudNoiseTexture = implementation.cloudNoiseTexture;
export const disposeCloudNoiseTexture = implementation.disposeCloudNoiseTexture;
export const makeCloudVolumeMaterial = (...args) => implementation.makeCloudVolumeMaterial(...args);
