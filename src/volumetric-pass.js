// Atmosphere and local clouds volume state controller. The WebGL 2 render
// pipeline (GameLegacyPipeline) owns the actual scene passes; this object
// only carries simulation-facing state shared by atmosphere/cloud materials.

import * as THREE from 'three';

export const VOLUME_LAYER = 2;

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
    if (!planet?.atmoMesh) {
      this.activePlanet = null;
      this.historyValid = false;
      this.center.set(0, 0, -1e12);
      this.radius = 1;
      return;
    }
    if (this.activePlanet !== planet) this.historyValid = false;
    this.activePlanet = planet;
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

  dispose() {}
}
