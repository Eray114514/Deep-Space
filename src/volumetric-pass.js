// Atmosphere and local-cloud ownership for the WebGPU render graph. Exactly
// one nearby body may occupy the local volume layer; inactive bodies return
// to their depth-tested world representations.

import * as THREE from 'three';
import { VOLUME_LAYER, WORLD_LAYER } from './render-layers.js';

export { VOLUME_LAYER };

export class VolumetricPass {
  constructor() {
    this.activePlanet = null;
    this.nav = new THREE.Vector3();
    this.center = new THREE.Vector3();
    this.radius = 1;
    this.motion = 1;
    this.historyValid = false;
  }

  setActivePlanet(planet, nav, motion = 0) {
    const previous = this.activePlanet;
    if (previous && previous !== planet) {
      previous.volumeActive = false;
      previous.atmoMesh?.layers.set(WORLD_LAYER);
      if (previous.volCloudMesh) previous.volCloudMesh.visible = false;
      for (const material of [previous.atmoMesh?.material, previous.volCloudMat]) {
        if (material?.uniforms?.uDepthReady) material.uniforms.uDepthReady.value = 0;
      }
    }
    if (!planet?.atmoMesh) {
      this.activePlanet = null;
      this.historyValid = false;
      this.center.set(0, 0, -1e12);
      this.radius = 1;
      return;
    }
    if (this.activePlanet !== planet) this.historyValid = false;
    this.activePlanet = planet;
    planet.volumeActive = true;
    planet.atmoMesh.layers.set(VOLUME_LAYER);
    this.nav.copy(nav);
    this.center.copy(planet.posUniv).sub(nav);
    this.radius = planet.R + planet.atmoHeight;
    this.motion = THREE.MathUtils.clamp(motion, 0, 1);

    // Node materials may expose these optional uniforms for depth-aware
    // raymarching/reprojection. The controller does not depend on a concrete
    // material factory, which keeps the render graph backend-neutral.
    for (const material of [planet.atmoMesh.material, planet.volCloudMat]) {
      if (!material) continue;
      if (material.volumeCenter?.value?.copy) material.volumeCenter.value.copy(this.center);
      if (material.volumeRadius) material.volumeRadius.value = this.radius;
      if (material.volumeMotion) material.volumeMotion.value = this.motion;
    }
  }

  resetHistory() {
    this.historyValid = false;
  }

  dispose() {
    if (!this.activePlanet) return;
    this.activePlanet.volumeActive = false;
    this.activePlanet.atmoMesh?.layers.set(WORLD_LAYER);
    if (this.activePlanet.volCloudMesh) this.activePlanet.volCloudMesh.visible = false;
    this.activePlanet = null;
  }
}
