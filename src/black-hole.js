const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const implementation = await import(params?.get('renderer') === 'webgpu'
  ? './black-hole-node.js'
  : './black-hole-webgl.js');

export const makeBlackHoleImpostorTexture = implementation.makeBlackHoleImpostorTexture;
export const makeAccretionMaterial = implementation.makeAccretionMaterial;
export const makePhotonMaterial = implementation.makePhotonMaterial;
export const BlackHole = implementation.BlackHole;
