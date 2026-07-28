import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const settings = resolveGraphicsSettings({ params: params || new URLSearchParams() });
const useNodeMaterials = resolveRendererPolicy(rendererParamsForSettings(settings,
  params || new URLSearchParams())).backend === 'webgpu';
const implementation = await import(useNodeMaterials
  ? './gas-giant-node.js'
  : './gas-giant-webgl.js');

export const GasGiant = implementation.GasGiant;
