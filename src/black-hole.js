import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const implementation = await import(resolveRendererPolicy(params).backend === 'webgpu'
  ? './black-hole-node.js'
  : './black-hole-webgl.js');

export const makeBlackHoleImpostorTexture = implementation.makeBlackHoleImpostorTexture;
export const makeAccretionMaterial = implementation.makeAccretionMaterial;
export const makePhotonMaterial = implementation.makePhotonMaterial;
export const BlackHole = implementation.BlackHole;
