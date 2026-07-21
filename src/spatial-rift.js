const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const implementation = await import(params?.get('renderer') === 'webgpu'
  ? './spatial-rift-node.js'
  : './spatial-rift-webgl.js');

export const createRiftDistortionNode = implementation.createRiftDistortionNode
  || (() => ({ outputNode: null, uniforms: {} }));
export const DEFAULT_RIFT_PROFILE = implementation.DEFAULT_RIFT_PROFILE;
export const createRiftProfile = implementation.createRiftProfile;
export const SpatialRift = implementation.SpatialRift;
