import { hash3i, hashFloat } from './rng.js';

// Two fixed neighbourhood slots cover the two authored crater lanes. Values
// are exact Float64 hash results, never interpolated heights. Arbitrary lane,
// seed or cell changes replace a slot; no spatial/universe-sized cache grows.
export class TerrainCraterField {
  constructor() {
    this.slots = Array.from({ length: 2 }, () => ({
      seed: NaN, x: NaN, y: NaN, z: NaN, sites: new Float64Array(27 * 5),
    }));
  }

  neighbourhood(cx, cy, cz, seed, lane) {
    const slot = this.slots[(lane & 1)];
    if (slot.seed === seed && slot.x === cx && slot.y === cy && slot.z === cz) return slot.sites;
    slot.seed = seed; slot.x = cx; slot.y = cy; slot.z = cz;
    let index = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const hash = hash3i(cx + dx, cy + dy, cz + dz, seed);
          slot.sites[index++] = hashFloat(hash, 0);
          slot.sites[index++] = hashFloat(hash, 1);
          slot.sites[index++] = hashFloat(hash, 2);
          slot.sites[index++] = 0.16 + ((hash >>> 4) % 64) / 64 * 0.26;
          slot.sites[index++] = 0.35 + ((hash >>> 10) % 64) / 64 * 0.65;
        }
      }
    }
    return slot.sites;
  }
}
