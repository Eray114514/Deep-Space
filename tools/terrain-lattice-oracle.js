// Diagnostic lattice sum. Not imported by runtime.
import { Simplex } from '../src/noise.js';
const GRAD = [1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1];
// Exact box-constrained quadratic minimum for distance from a lattice point
// to the current skew cell. A = I - J/6, so A^T A = I - J/4.
export function minimumSkewCellDistanceSquared(d) {
  let best = Infinity;
  for (let code = 0; code < 27; code++) {
    let c = code, sum = 0, free = 0;
    const z = [];
    for (let a = 0; a < 3; a++) {
      const state = c % 3; c = Math.floor(c / 3);
      z[a] = state === 2 ? null : state - d[a];
      if (state === 2) free++; else sum += z[a];
    }
    const value = sum / (4 - free);
    let valid = true;
    for (let a = 0; a < 3; a++) if (z[a] === null) {
      z[a] = value;
      if (value + d[a] < 0 || value + d[a] > 1) valid = false;
    }
    if (valid) {
      const total = z[0] + z[1] + z[2];
      best = Math.min(best, z[0] ** 2 + z[1] ** 2 + z[2] ** 2 - total ** 2 / 4);
    }
  }
  return best;
}
export function latticeNoiseClass(min = -1, max = 2, prune = false) {
  const offsets = [];
  for (let i = min; i <= max; i++) for (let j = min; j <= max; j++) for (let k = min; k <= max; k++) {
    if (prune && minimumSkewCellDistanceSquared([i, j, k]) >= .6) continue;
    const t = (i + j + k) / 6;
    offsets.push([i, j, k, i - t, j - t, k - t]);
  }
  return class LatticeNoise extends Simplex {
    noise(x, y, z) {
      const s = (x + y + z) / 3;
      const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
      const t = (i + j + k) / 6;
      const x0 = x - i + t, y0 = y - j + t, z0 = z - k + t;
      let sum = 0;
      for (const [di, dj, dk, ox, oy, oz] of offsets) {
        const dx = x0 - ox, dy = y0 - oy, dz = z0 - oz;
        const a = .6 - dx * dx - dy * dy - dz * dz;
        if (a <= 0) continue;
        const g = this.permMod12[((i + di) & 255) + this.perm[((j + dj) & 255) + this.perm[(k + dk) & 255]]] * 3;
        sum += a ** 4 * (GRAD[g] * dx + GRAD[g + 1] * dy + GRAD[g + 2] * dz);
      }
      return 32 * sum;
    }
  };
}
