const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const implementation = await import(params?.get('renderer') === 'webgpu'
  ? './gas-giant-node.js'
  : './gas-giant-webgl.js');

export const GasGiant = implementation.GasGiant;
