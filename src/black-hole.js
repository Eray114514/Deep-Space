import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const settings = resolveGraphicsSettings({ params: params || new URLSearchParams() });
const useNodeMaterials = resolveRendererPolicy(rendererParamsForSettings(settings,
  params || new URLSearchParams())).backend === 'webgpu';
const implementation = await import(useNodeMaterials
  ? './black-hole-node.js'
  : './black-hole-webgl.js');

export const makeBlackHoleImpostorTexture = implementation.makeBlackHoleImpostorTexture;
export const makeAccretionMaterial = implementation.makeAccretionMaterial;
export const makePhotonMaterial = implementation.makePhotonMaterial;
export const BlackHole = implementation.BlackHole;
