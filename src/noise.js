// Seeded 3D simplex noise (Gustavson-style) + fractal helpers + worley.
// All terrain everywhere derives from these functions evaluated on unit
// sphere directions, which is what makes planets consistent at every LOD.

import { hash3i, hashFloat } from './rng.js';

const GRAD = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F3 = 1 / 3;
const G3 = 1 / 6;

export class Simplex {
  constructor(rand) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  // returns approx [-1, 1]
  noise(xin, yin, zin) {
    const perm = this.perm, permMod12 = this.permMod12;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ii = i & 255, jj = j & 255, kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      t0 *= t0;
      const g = permMod12[ii + perm[jj + perm[kk]]] * 3;
      n0 = t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0 + GRAD[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      t1 *= t1;
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      n1 = t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1 + GRAD[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      t2 *= t2;
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      n2 = t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2 + GRAD[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      t3 *= t3;
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      n3 = t3 * t3 * (GRAD[g] * x3 + GRAD[g + 1] * y3 + GRAD[g + 2] * z3);
    }
    return 32.0 * (n0 + n1 + n2 + n3);
  }

  // Fractal Brownian motion. Octaves with angular wavelength below
  // `maxFreq` are skipped — this is the LOD detail cutoff. The first
  // octave is always included so large shapes never vanish.
  fbm(x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq) {
    let sum = 0, amp = 1, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && f > maxFreq) break;
      sum += amp * this.noise(x * f, y * f + o * 19.19, z * f);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  // Ridged multifractal: sharp mountain crests. Output roughly [0, 1].
  ridged(x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq) {
    let sum = 0, amp = 0.5, norm = 0, f = baseFreq, weight = 1;
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && f > maxFreq) break;
      let n = 1 - Math.abs(this.noise(x * f, y * f - o * 13.7, z * f));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  // Billowy noise (|n|*2-1): puffy / blobby shapes. Roughly [-1, 1].
  billow(x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq) {
    let sum = 0, amp = 1, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && f > maxFreq) break;
      sum += amp * (Math.abs(this.noise(x * f, y * f + o * 7.7, z * f)) * 2 - 1);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }
}

// Worley (cellular) F1 noise on a jittered integer lattice.
// Returns { d: distance to nearest feature point (≈0..1.1), h: its hash }.
const _w = { d: 0, h: 0 };
export function worley3(x, y, z, seed) {
  const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
  let best = Infinity, bestH = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx, iy = cy + dy, iz = cz + dz;
        const h = hash3i(ix, iy, iz, seed);
        const fx = ix + hashFloat(h, 0);
        const fy = iy + hashFloat(h, 1);
        const fz = iz + hashFloat(h, 2);
        const ddx = x - fx, ddy = y - fy, ddz = z - fz;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < best) { best = d2; bestH = h; }
      }
    }
  }
  _w.d = Math.sqrt(best);
  _w.h = bestH;
  return _w;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
