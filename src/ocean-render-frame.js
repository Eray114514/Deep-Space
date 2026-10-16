import * as THREE from 'three';
import { SurfaceViewFrame } from './surface-view-frame.js';

export const OCEAN_ANCHOR_CELL = 256;

// Sampling belongs to the view, not to the asynchronously replaced geometry
// patch. Waves, final texture phases, tides and interactions share this anchor.
export class OceanRenderFrame {
  constructor(planet) {
    this.view = new SurfaceViewFrame(planet);
    this.anchor = new THREE.Vector3();
    this.initialized = false;
    this.uniforms = {
      uOceanViewToLocal: this.view.linear,
      uOceanCameraToAnchor: { value: new THREE.Vector3() },
      uOceanAnchorToPatch: { value: new THREE.Vector3() },
    };
  }

  sync(camera, patchCenter = null) {
    const changed = this.view.sync(camera);
    const eye = this.view.origin;
    const x = Math.floor(eye.x / OCEAN_ANCHOR_CELL) * OCEAN_ANCHOR_CELL;
    const y = Math.floor(eye.y / OCEAN_ANCHOR_CELL) * OCEAN_ANCHOR_CELL;
    const z = Math.floor(eye.z / OCEAN_ANCHOR_CELL) * OCEAN_ANCHOR_CELL;
    const rebased = !this.initialized || x !== this.anchor.x || y !== this.anchor.y || z !== this.anchor.z;
    if (rebased) this.anchor.set(x, y, z);
    this.initialized = true;
    if (changed || rebased) this.uniforms.uOceanCameraToAnchor.value.copy(eye).sub(this.anchor);
    // Patch publication can change independently of camera/body transforms.
    const offset = this.uniforms.uOceanAnchorToPatch.value;
    if (patchCenter) offset.copy(this.anchor).sub(patchCenter);
    else offset.set(0, 0, 0);
    return rebased;
  }
}

export const oceanRenderFrameGLSL = /* glsl */`
uniform mat3 uOceanViewToLocal;
uniform vec3 uOceanCameraToAnchor;
uniform vec3 uOceanAnchorToPatch;
vec3 oceanRelativeFromView(vec3 viewPosition) {
  return uOceanViewToLocal * viewPosition + uOceanCameraToAnchor;
}
float oceanPatchDistance(vec3 relativePosition) {
  return length(relativePosition + uOceanAnchorToPatch);
}
`;
