// Renderer-specific natural material facade. The authored WebGL shaders stay
// intact while the WebGPU/TSL port is validated in its explicit experiment.
import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const settings = resolveGraphicsSettings({ params: params || new URLSearchParams() });
const useNodeMaterials = resolveRendererPolicy(rendererParamsForSettings(settings,
  params || new URLSearchParams())).backend === 'webgpu';
const implementation = await import(useNodeMaterials ? './shaders-node.js' : './shaders-webgl.js');

export const TIME = implementation.TIME;
export const GROW = implementation.GROW;
export const WIND = implementation.WIND;
export const setWeatherWind = implementation.setWeatherWind;
export const tickShaders = implementation.tickShaders;
export const sampleDetailCPU = implementation.sampleDetailCPU;
export const detailTexture = implementation.detailTexture;
export const disposeDetailTexture = implementation.disposeDetailTexture;
export const applyTerrainDetail = (material, ...args) =>
  implementation.applyTerrainDetail(material, ...args) || material;
export const applyWaterWaves = (material, ...args) =>
  implementation.applyWaterWaves(material, ...args) || material;
export const applyWindSway = (material, ...args) =>
  implementation.applyWindSway(material, ...args) || material;
