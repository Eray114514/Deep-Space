import * as THREE from 'three';

export const SURFACE_INTERACTION_CAP = 4;

class SurfaceInteractionField {
  constructor() {
    // xyz planet-local centre, w radius
    this.positions = Array.from({ length: SURFACE_INTERACTION_CAP },
      () => new THREE.Vector4(1e9, 1e9, 1e9, 1));
    // x age, y strength, z recovery rate, w reserved
    this.data = Array.from({ length: SURFACE_INTERACTION_CAP }, () => new THREE.Vector4(99, 0, 1, 0));
    this.cursor = 0;
    this.planetId = null;
  }

  setPlanet(planetId) {
    if (planetId === this.planetId) return;
    this.planetId = planetId;
    this.clear();
  }

  clear() {
    for (let i = 0; i < SURFACE_INTERACTION_CAP; i++) {
      this.positions[i].set(1e9, 1e9, 1e9, 1);
      this.data[i].set(99, 0, 1, 0);
    }
  }

  inject(position, radius, strength = 1, recovery = 1) {
    const index = this.cursor++ % SURFACE_INTERACTION_CAP;
    this.positions[index].set(position.x, position.y, position.z, radius);
    this.data[index].set(0, strength, recovery, 0);
  }

  update(dt) {
    for (const value of this.data) value.x += Math.max(0, dt) * value.z;
  }

  activeCount() {
    return this.data.reduce((count, value) => count + (value.y * Math.exp(-value.x) > 0.01 ? 1 : 0), 0);
  }
}

export const surfaceInteraction = new SurfaceInteractionField();

