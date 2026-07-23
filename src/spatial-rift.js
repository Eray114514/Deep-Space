import { resolveRendererPolicy } from './renderer-policy.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const implementation = await import(resolveRendererPolicy(params).backend === 'webgpu'
  ? './spatial-rift-node.js'
  : './spatial-rift-webgl.js');

export const createRiftDistortionNode = implementation.createRiftDistortionNode
  || (() => ({ outputNode: null, uniforms: {} }));
export const DEFAULT_RIFT_PROFILE = implementation.DEFAULT_RIFT_PROFILE;
export const createRiftProfile = implementation.createRiftProfile;
export const SpatialRift = implementation.SpatialRift;
