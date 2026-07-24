// Black hole facade — WebGL 2 only.
import * as implementation from './black-hole-webgl.js';

export const makeBlackHoleImpostorTexture = implementation.makeBlackHoleImpostorTexture;
export const makeAccretionMaterial = implementation.makeAccretionMaterial;
export const makePhotonMaterial = implementation.makePhotonMaterial;
export const BlackHole = implementation.BlackHole;
