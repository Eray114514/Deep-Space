import * as THREE from 'three';
import { sampleOceanWakePacket } from './ocean-wake-packet.js';

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

  // Interaction diagnostic probe, NOT the displaced ocean surface. `height`
  // is a legacy oscillating signal retained for callers, not vertex motion.
  // Wake support/age/energy share the CPU+GLSL packet, but this probe sums all
  // sources and omits GPU history selection, breakup, lighting and compositing.
  // Use Planet.sampleWaterSurface() for actual sea clearance/contact.
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
        const packet = sampleOceanWakePacket({ along, lateral,
          age: value.x, speed: value.y, strength: value.z });
        height += Math.sin(packet.armDistance * 2.1 - value.x * 4.2)
          * packet.armEnvelope * 0.22;
        foam += (packet.armEnvelope + packet.centerEnvelope * 0.4) * value.w;
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
