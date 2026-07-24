// Spatial rift facade — WebGL 2 only.
import * as implementation from './spatial-rift-webgl.js';

export const createRiftDistortionNode = implementation.createRiftDistortionNode
  || (() => ({ outputNode: null, uniforms: {} }));
export const DEFAULT_RIFT_PROFILE = implementation.DEFAULT_RIFT_PROFILE;
export const createRiftProfile = implementation.createRiftProfile;
export const SpatialRift = implementation.SpatialRift;
