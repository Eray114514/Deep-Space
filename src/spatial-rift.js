import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const settings = resolveGraphicsSettings({ params: params || new URLSearchParams() });
const useNodeMaterials = resolveRendererPolicy(rendererParamsForSettings(settings,
  params || new URLSearchParams())).backend === 'webgpu';
const implementation = await import(useNodeMaterials
  ? './spatial-rift-node.js'
  : './spatial-rift-webgl.js');

export const createRiftDistortionNode = implementation.createRiftDistortionNode
  || (() => ({ outputNode: null, uniforms: {} }));
export const DEFAULT_RIFT_PROFILE = implementation.DEFAULT_RIFT_PROFILE;
export const createRiftProfile = implementation.createRiftProfile;
export const SpatialRift = implementation.SpatialRift;
