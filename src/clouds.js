// Renderer-specific cloud facade. WebGL keeps the authored shader/raymarch;
// the TSL port is isolated behind the explicit WebGPU experiment.
import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const settings = resolveGraphicsSettings({ params: params || new URLSearchParams() });
const useNodeMaterials = resolveRendererPolicy(rendererParamsForSettings(settings,
  params || new URLSearchParams())).backend === 'webgpu';
const implementation = await import(useNodeMaterials ? './clouds-node.js' : './clouds-webgl.js');

export const cloudNoiseTexture = implementation.cloudNoiseTexture;
export const disposeCloudNoiseTexture = implementation.disposeCloudNoiseTexture;
export const makeCloudVolumeMaterial = (...args) => implementation.makeCloudVolumeMaterial(...args);
