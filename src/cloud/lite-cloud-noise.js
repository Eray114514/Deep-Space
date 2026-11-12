// Tileable 64^3 RGBA8 noise volume for the lite cloud pass.
//   R: Perlin-Worley cloud body (closed cells; low values along cell walls)
//   G: high-frequency Worley for edge erosion
//   B: low-frequency value noise for thickness and coverage breakup
// Seeded and deterministic. It only shapes pixels: nothing in the canonical
// universe (terrain, weather, names) reads it, so it owns its own RNG.
import * as THREE from 'three';

export const LITE_CLOUD_NOISE_SIZE = 64;

export function buildLiteCloudNoise(N = LITE_CLOUD_NOISE_SIZE) {
  let seed = 0x38b4c10d;
  const rnd = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const valueField = (f) => { const a = new Float32Array(f * f * f); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const pointField = (f) => { const a = new Float32Array(f * f * f * 3); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const sampleValue = (a, f, x, y, z) => {
    x *= f; y *= f; z *= f;
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    let fx = x - x0, fy = y - y0, fz = z - z0;
    fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    fz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const X0 = x0 % f, X1 = (x0 + 1) % f, Y0 = y0 % f, Y1 = (y0 + 1) % f, Z0 = z0 % f, Z1 = (z0 + 1) % f;
    const g = (i, j, k) => a[(k * f + j) * f + i];
    const l = (p, q, t) => p + (q - p) * t;
    return l(l(l(g(X0, Y0, Z0), g(X1, Y0, Z0), fx), l(g(X0, Y1, Z0), g(X1, Y1, Z0), fx), fy),
      l(l(g(X0, Y0, Z1), g(X1, Y0, Z1), fx), l(g(X0, Y1, Z1), g(X1, Y1, Z1), fx), fy), fz);
  };
  const sampleWorley = (a, f, x, y, z) => {
    x *= f; y *= f; z *= f;
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    let best = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const ix = cx + i, iy = cy + j, iz = cz + k;
      const o = ((((iz % f) + f) % f * f + ((iy % f) + f) % f) * f + ((ix % f) + f) % f) * 3;
      const dx = ix + a[o] - x, dy = iy + a[o + 1] - y, dz = iz + a[o + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  const v2 = valueField(2), v4 = valueField(4), v8 = valueField(8), v16 = valueField(16);
  const w3 = pointField(3), w6 = pointField(6), w12 = pointField(12), w8 = pointField(8), w16 = pointField(16);
  const n = N * N * N, channels = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let p = 0;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++, p++) {
    const x = (i + 0.5) / N, y = (j + 0.5) / N, z = (k + 0.5) / N;
    const perlin = sampleValue(v4, 4, x, y, z) * 0.5 + sampleValue(v8, 8, x, y, z) * 0.3 + sampleValue(v16, 16, x, y, z) * 0.2;
    const worley = sampleWorley(w3, 3, x, y, z) * 0.6 + sampleWorley(w6, 6, x, y, z) * 0.28 + sampleWorley(w12, 12, x, y, z) * 0.12;
    channels[0][p] = worley * 0.72 + perlin * 0.42;
    channels[1][p] = sampleWorley(w8, 8, x, y, z) * 0.62 + sampleWorley(w16, 16, x, y, z) * 0.38;
    channels[2][p] = sampleValue(v2, 2, x, y, z) * 0.5 + sampleValue(v4, 4, x, y, z) * 0.32 + sampleValue(v8, 8, x, y, z) * 0.18;
  }
  const out = new Uint8Array(n * 4);
  for (let c = 0; c < 3; c++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { if (channels[c][i] < lo) lo = channels[c][i]; if (channels[c][i] > hi) hi = channels[c][i]; }
    for (let i = 0; i < n; i++) out[i * 4 + c] = Math.round((channels[c][i] - lo) / (hi - lo) * 255);
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  return out;
}

let shared = null;
export function liteCloudNoiseTexture() {
  if (shared) return shared;
  const N = LITE_CLOUD_NOISE_SIZE;
  const texture = new THREE.Data3DTexture(buildLiteCloudNoise(N), N, N, N);
  texture.name = 'lite-cloud.noise';
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  shared = texture;
  return texture;
}
