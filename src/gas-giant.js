import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const implementation = await import(resolveRendererPolicy(params).useNodeMaterials
  ? './gas-giant-node.js'
  : './gas-giant-webgl.js');

export const GasGiant = implementation.GasGiant;
