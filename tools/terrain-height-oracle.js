// Independent crater authority (from 93e934f): a deliberately uncached sum that
// the cached TerrainCraterField must reproduce exactly. The frozen v1 height()
// that used to live here was retired with the terrain v2 generator (2026-11);
// the test now runs the live height() over this crater path instead.
import { smoothstep } from '../src/noise.js';
import { hash3i, hashFloat } from '../src/rng.js';
export class TerrainHeightOracle {
  craters(x, y, z, freq, amp, lane) {
    x *= freq; y *= freq; z *= freq;
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    const seed = this.intSeed + lane * 7919;
    let sum = 0;
    // Sum compact features instead of selecting the nearest center. Switching
    // nearest owners also switched radius/amplitude and cut cliffs across the
    // Voronoi bisectors. The largest support is < 0.67, so 27 cells suffice.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ix = cx + dx, iy = cy + dy, iz = cz + dz;
          const hash = hash3i(ix, iy, iz, seed);
          const px = x - ix - hashFloat(hash, 0);
          const py = y - iy - hashFloat(hash, 1);
          const pz = z - iz - hashFloat(hash, 2);
          const radius = 0.16 + ((hash >>> 4) % 64) / 64 * 0.26;
          const distanceSquared = px * px + py * py + pz * pz;
          if (distanceSquared >= radius * radius * 2.56) continue;
          const t = Math.sqrt(distanceSquared) / radius;
          const amplitude = amp * (0.35 + ((hash >>> 10) % 64) / 64 * 0.65);
          // Zero slope at the bowl center, raised rim, and outer support keeps
          // lighting normals continuous as well as the sampled height.
          sum += amplitude * (t < 1
            ? -1 + 1.35 * smoothstep(0, 1, t)
            : 0.35 * (1 - smoothstep(1, 1.6, t)));
        }
      }
    }
    return sum;
  }

}
