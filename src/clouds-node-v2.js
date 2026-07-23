// V2 facade: routes WebGPU cloud calls to the from-scratch cloud-system.js
// (compute-baked 128^3 Storage3DTexture, .level(0) sampling, full density
// field). Re-exports makeCloudVolumeMaterial with the legacy signature so
// clouds.js can dispatch without changes.
import {
  initCloudNoise,
  disposeCloudNoise,
  makeCloudVolumeMaterialV2,
} from './cloud-system.js';

// Legacy clouds.js re-exports cloudNoiseTexture / disposeCloudNoiseTexture.
// No external caller invokes cloudNoiseTexture() directly — it is only used
// inside makeCloudVolumeMaterial. We expose init/dispose for lifecycle parity.
export const cloudNoiseTexture = () => initCloudNoise().texture;
export const disposeCloudNoiseTexture = disposeCloudNoise;

export const makeCloudVolumeMaterial = (planet, band, detailTex, weatherMap, opts) =>
  makeCloudVolumeMaterialV2(planet, band, detailTex, weatherMap, opts);
