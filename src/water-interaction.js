import * as THREE from 'three';

export const WATER_IMPULSE_CAP = 12;

export class WaterInteractionField {
  constructor(capacity = WATER_IMPULSE_CAP) {
    this.capacity = capacity;
    this.planetId = null;
    this.cursor = 0;
    this.positions = Array.from({ length: capacity }, () => new THREE.Vector3(1e9, 1e9, 1e9));
    // x age, y propagation speed, z strength, w foam
    this.data = Array.from({ length: capacity }, () => new THREE.Vector4(99, 6, 0, 0));
  }

  setPlanet(planetId) {
    if (planetId === this.planetId) return;
    this.planetId = planetId;
    this.clear();
  }

  clear() {
    this.cursor = 0;
    for (let i = 0; i < this.capacity; i++) {
      this.positions[i].set(1e9, 1e9, 1e9);
      this.data[i].set(99, 6, 0, 0);
    }
  }

  inject(localPosition, { strength = 1, speed = 6, foam = 0.5 } = {}) {
    const index = this.cursor++ % this.capacity;
    this.positions[index].copy(localPosition);
    this.data[index].set(0, speed, Math.max(0, strength), Math.max(0, foam));
    return index;
  }

  update(dt) {
    for (const value of this.data) {
      value.x += Math.max(0, dt);
      if (value.x > 8) value.z = 0;
    }
  }

  activeCount() {
    return this.data.reduce((count, value) => count + (value.z > 0.001 ? 1 : 0), 0);
  }

  sample(localPosition) {
    let height = 0, foam = 0;
    for (let i = 0; i < this.capacity; i++) {
      const value = this.data[i];
      if (value.z <= 0) continue;
      const distance = localPosition.distanceTo(this.positions[i]);
      const ring = distance - value.x * value.y;
      const envelope = Math.exp(-Math.abs(ring) * 0.42 - value.x * 0.5);
      height += Math.sin(ring * 1.4) * envelope * value.z;
      foam += Math.max(0, Math.sin(ring * 1.4)) * envelope * value.w;
    }
    return { height, foam };
  }
}

export const waterInteraction = new WaterInteractionField();
