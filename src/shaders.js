// WebGL 2 baseline: the authored natural-material shader deck in
// shaders-webgl.js is the only implementation. The TSL port (shaders-node.js)
// was shelved with the WebGPU line — see git history and
// docs/optimization-roadmap.md (2026-08-15 decision).
//
// The apply* wrappers below are load-bearing: the WebGL appliers mutate the
// material in place and may return undefined, so the facade guarantees the
// caller always gets a material back.
import {
  TIME, GROW, WIND, setWeatherWind, tickShaders, sampleDetailCPU,
  detailTexture, disposeDetailTexture, cloudDensityCPU, cloudBaseDensityCPU,
  applyTerrainDetail as applyTerrainDetailImpl,
  applyWaterWaves as applyWaterWavesImpl,
  applyCloudField as applyCloudFieldImpl,
  applyWindSway as applyWindSwayImpl,
  terrainDepthMaterial,
} from './shaders-webgl.js';

export {
  TIME, GROW, WIND, setWeatherWind, tickShaders, sampleDetailCPU,
  detailTexture, disposeDetailTexture, cloudDensityCPU, cloudBaseDensityCPU,
  terrainDepthMaterial,
};
export const applyTerrainDetail = (material, ...args) =>
  applyTerrainDetailImpl(material, ...args) || material;
export const applyWaterWaves = (material, ...args) =>
  applyWaterWavesImpl(material, ...args) || material;
export const applyCloudField = (material, ...args) =>
  applyCloudFieldImpl(material, ...args) || material;
export const applyWindSway = (material, ...args) =>
  applyWindSwayImpl(material, ...args) || material;
// No WebGL noctilucent field: the identity fallback keeps the caller's
// material untouched, exactly as the old facade did on the WebGL path.
export const applyNoctilucentField = (material) => material;
