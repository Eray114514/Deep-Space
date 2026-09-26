import * as THREE from 'three';
import { stellarOcclusionUniforms } from './stellar-occlusion.js';
export function atmosphereUniforms(camera = { far: 1e7 }) {
  return {
    ...stellarOcclusionUniforms(),
    tOpticalDepth: { value: null },
    tMultipleScattering: { value: null },
    uMultipleEnabled: { value: 0 },
    uEnabled: { value: 0 },
    uCameraFar: { value: camera.far },
    uCameraLocal: { value: new THREE.Vector3() },
    uInvProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uWorldToLocal: { value: new THREE.Matrix4() },
    uGroundR: { value: 1 },
    uTopR: { value: 2 },
    uTopAltitude: { value: 1 },
    uRayleighScaleHeight: { value: 8000 },
    uMieScaleHeight: { value: 1200 },
    uOzoneCenter: { value: 25000 },
    uOzoneHalfWidth: { value: 15000 },
    uBetaRayleigh: { value: new THREE.Vector3() },
    uBetaMieScatter: { value: new THREE.Vector3() },
    uBetaMieExtinction: { value: new THREE.Vector3() },
    uBetaOzone: { value: new THREE.Vector3() },
    uDensityScale: { value: 1 },
    uGroundAlbedo: { value: new THREE.Color(0.18, 0.2, 0.16) },
    uSunDirection0: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor0: { value: new THREE.Color(1, 1, 1) },
    uSunEnergy0: { value: 1 },
    uSunDirection1: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor1: { value: new THREE.Color(1, 1, 1) },
    uSunEnergy1: { value: 0 },
    uEclipseEnabled: { value: 0 },
    uEclipseCenter: { value: new THREE.Vector3() },
    uEclipseRadius: { value: 1 },
    uEclipseStarAngle: { value: 0 },
    uRadianceScale: { value: 3.2 },
  };
}
export function namespacedAtmosphereUniforms() {
  return Object.fromEntries(Object.entries(atmosphereUniforms()).map(([name, value]) => ['air_' + name, value]));
}
