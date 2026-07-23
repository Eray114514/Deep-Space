// V2 facade: routes WebGPU natural-material calls to the from-scratch
// WebGPU-native systems (ocean-system, terrain-system, flora-system) while
// re-exporting unchanged helpers (detail texture, CPU cloud density, cloud
// field deck, GROW, TIME) from the legacy shaders-node.js. This lets
// shaders.js dispatch to V2 without touching planet.js or scatter.js.
import {
  TIME, GROW, tickShaders,
  sampleDetailCPU, detailTexture, disposeDetailTexture,
  cloudDensityCPU, cloudBaseDensityCPU,
  applyCloudField,
} from './shaders-node.js';
import { makeOceanMaterialV2 } from './ocean-system.js';
import { applyTerrainDetailV2 } from './terrain-system.js';
import { applyWindSwayV2 } from './flora-system.js';

export {
  TIME, GROW, tickShaders,
  sampleDetailCPU, detailTexture, disposeDetailTexture,
  cloudDensityCPU, cloudBaseDensityCPU,
  applyCloudField,
};

// V2 ocean: compute-FFT wave field + PBR MeshStandardNodeMaterial. Signature
// matches the legacy applyWaterWaves(material, planet, waveScale).
export const applyWaterWaves = (source, planet, waveScale = 1 / 14) =>
  makeOceanMaterialV2(source, planet, waveScale);

// V2 terrain: PBR with valley-mist depth fix + normalNode micro-relief.
export const applyTerrainDetail = (source, planet, strength = 0.2, macroK = 0.4) =>
  applyTerrainDetailV2(source, planet, strength, macroK);

// V2 wind sway: positionGeometry.y (no instance-translation pollution).
// Legacy callers pass a scalar amount; V2 takes { sway, grow }.
export const applyWindSway = (source, amount) =>
  applyWindSwayV2(source, { sway: amount, grow: GROW.value });
