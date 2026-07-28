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
    // xyz tangent travel direction; w 0 = local impact, 1 = directional hull wake
    this.directions = Array.from({ length: capacity }, () => new THREE.Vector4(1, 0, 0, 0));
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
      this.directions[i].set(1, 0, 0, 0);
    }
  }

  inject(localPosition, {
    strength = 1,
    speed = 6,
    foam = 0.5,
    direction = null,
    kind = direction ? 'wake' : 'impact',
  } = {}) {
    const index = this.cursor++ % this.capacity;
    this.positions[index].copy(localPosition);
    this.data[index].set(0, speed, Math.max(0, strength), Math.max(0, foam));
    const radial = localPosition.clone().normalize();
    const travel = direction?.clone() || new THREE.Vector3(1, 0, 0);
    travel.addScaledVector(radial, -travel.dot(radial));
    if (travel.lengthSq() < 1e-8) {
      travel.set(Math.abs(radial.y) < 0.9 ? 0 : 1, Math.abs(radial.y) < 0.9 ? 1 : 0, 0)
        .cross(radial);
    }
    travel.normalize();
    this.directions[index].set(travel.x, travel.y, travel.z, kind === 'wake' ? 1 : 0);
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
      const direction = this.directions[i];
      if (direction.w > 0.5) {
        const radial = localPosition.clone().normalize();
        const axis = new THREE.Vector3(direction.x, direction.y, direction.z)
          .addScaledVector(radial, -radial.dot(new THREE.Vector3(direction.x, direction.y, direction.z)))
          .normalize();
        const side = radial.clone().cross(axis).normalize();
        const delta = localPosition.clone().sub(this.positions[i]);
        const along = delta.dot(axis);
        const lateral = delta.dot(side);
        const aft = 1 - Math.min(1, Math.max(0, (along + 2) / 10));
        const trailLength = Math.max(12, value.x * value.y * 2.4 + 20);
        const trail = Math.exp(-Math.max(0, -along - trailLength) * 0.12
          - Math.max(0, along) * 0.34 - value.x * 0.34);
        const arm = Math.abs(Math.abs(lateral) - (4.2 + Math.max(0, -along) * 0.29));
        const armEnvelope = Math.exp(-arm * 0.72) * aft * trail;
        const turbulent = Math.exp(-Math.abs(lateral) * 0.18
          - Math.max(0, along) * 0.4) * trail;
        height += Math.sin(arm * 2.1 - value.x * 4.2) * armEnvelope * value.z * 0.22;
        foam += (armEnvelope + turbulent * 0.4) * value.w;
      } else {
        const distance = localPosition.distanceTo(this.positions[i]);
        const ring = distance - value.x * value.y;
        const envelope = Math.exp(-Math.abs(ring) * 0.42 - value.x * 0.5);
        height += Math.sin(ring * 1.4) * envelope * value.z;
        foam += Math.max(0, Math.sin(ring * 1.4)) * envelope * value.w;
      }
    }
    return { height, foam };
  }
}

export const waterInteraction = new WaterInteractionField();
