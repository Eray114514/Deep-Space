// Deterministic, seedable random utilities. Everything in the universe
// derives from these — same seed, same universe, always.

// xmur3 string hash -> 32-bit seed stream
export function strHash32(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// mulberry32 PRNG: returns function giving floats in [0,1)
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seedStr) {
  return mulberry32(strHash32(String(seedStr)));
}

// Fast integer-lattice hash -> uint32. Used for star cells, worley, scatter.
export function hash3i(x, y, z, seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  h = (h << 11) | (h >>> 21);
  h = Math.imul(h ^ (z | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
}

// Derive floats in [0,1) from a uint32 hash, lane n (0..2)
export function hashFloat(h, lane = 0) {
  return (((h >>> (lane * 10)) & 1023) + 0.5) / 1024;
}

export function pickWeighted(rand, entries) {
  // entries: [[value, weight], ...]
  let total = 0;
  for (const e of entries) total += e[1];
  let r = rand() * total;
  for (const e of entries) {
    r -= e[1];
    if (r <= 0) return e[0];
  }
  return entries[entries.length - 1][0];
}
