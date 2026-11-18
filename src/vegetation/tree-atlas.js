// Bark, foliage and impostor maps for the tree field, painted on the CPU into
// one RGBA atlas per planet. No image files: every texel is a function of the
// planet seed, like the trees themselves.
//
//   u 0.0–0.5              bark, tiles in v, periodic around the trunk in u
//   u 0.5–1.0, 4×2 cells   foliage cards (cells 0–3) and whole-tree impostors
//                          (cells 4–7); alpha-tested
//
// Maps are near-white luminance patterns. Vertex colours carry the species'
// actual bark and canopy colours, so one atlas serves every tint.

import * as THREE from 'three';

export const ATLAS_SIZE = 1024;
const HALF = ATLAS_SIZE / 2;
const CELL = ATLAS_SIZE / 4;          // 256 px foliage / impostor cells

export const CELL_BROADLEAF = 0;
export const CELL_NEEDLE = 1;
export const CELL_BUSH = 2;
export const CELL_FROND = 3;
export const CELL_IMPOSTOR_0 = 4;     // + species index (0..3)

// The last cell holds a quarter-cell overhead projection per species.
export function crownTopRect(slot) {
  const u0 = 0.75 + (slot % 2) * 0.125;
  const v0 = 0.75 + Math.floor(slot / 2) * 0.125;
  const inset = 2 / ATLAS_SIZE;
  return { u0: u0 + inset, u1: u0 + 0.125 - inset, v0: v0 + inset, v1: v0 + 0.125 - inset };
}

// uv rectangle of a cell, inset so mip levels do not bleed across cells
export function cellRect(cell) {
  const col = cell % 2, row = Math.floor(cell / 2);
  const inset = 3 / ATLAS_SIZE;
  return {
    u0: 0.5 + col * 0.25 + inset, u1: 0.5 + (col + 1) * 0.25 - inset,
    v0: row * 0.25 + inset, v1: (row + 1) * 0.25 - inset,
  };
}
export const BARK_RECT = { u0: 4 / ATLAS_SIZE, u1: 0.5 - 4 / ATLAS_SIZE };

function hash3(x, y, z, seed) {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * ux;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * ux;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * ux;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * ux;
  return (x00 + (x10 - x00) * uy) + ((x01 + (x11 - x01) * uy) - (x00 + (x10 - x00) * uy)) * uz;
}

function paintBark(data, seed, style) {
  // Sampled on a cylinder so the pattern closes around the trunk. The tree
  // mesher mirrors v between rings, which makes any pattern tile lengthwise.
  const furrow = style === 'smooth' ? 0.35 : 1;
  for (let y = 0; y < ATLAS_SIZE; y++) {
    const v = y / ATLAS_SIZE;
    for (let x = 0; x < HALF; x++) {
      const a = (x / HALF) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const warp = valueNoise(cx * 1.3 + 9, v * 2.4, cz * 1.3, seed + 7) - 0.5;
      const ridge = Math.abs(valueNoise(cx * 3.4 + warp * 1.6, v * 1.3, cz * 3.4 + warp * 1.6, seed) - 0.5) * 2;
      const fine = valueNoise(cx * 13, v * 9, cz * 13, seed + 3);
      const plates = valueNoise(cx * 1.7, v * 7, cz * 1.7, seed + 5);
      const crack = Math.min(1, ridge * 3.2);
      let lum = 0.5 + 0.42 * crack * furrow + (1 - furrow) * 0.3 + (fine - 0.5) * 0.24 + (plates - 0.5) * 0.16;
      // pale horizontal lenticels on smooth bark (birch, aspen)
      if (style === 'smooth') lum -= Math.max(0, valueNoise(cx * 2.2, v * 46, cz * 2.2, seed + 11) - 0.74) * 1.6;
      lum = Math.max(0.2, Math.min(1, lum));
      const i = (y * ATLAS_SIZE + x) * 4;
      data[i] = lum * 255; data[i + 1] = lum * 250; data[i + 2] = lum * 242; data[i + 3] = 255;
    }
  }
}

// rasterise soft-edged shapes into one cell; later shapes overwrite earlier
function cellPainter(data, cell, side = null) {
  const col = cell % 2, row = Math.floor(cell / 2);
  const width = side === null ? CELL : CELL / 2;
  const x0 = HALF + col * CELL + (side || 0) * width, y0 = row * CELL;
  const put = (px, py, r, g, b) => {
    if (px < 0 || py < 0 || px >= width || py >= CELL) return;
    const i = ((y0 + py) * ATLAS_SIZE + x0 + px) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  return {
    fill(r, g, b) {
      for (let py = 0; py < CELL; py++) {
        for (let px = 0; px < width; px++) {
          const i = ((y0 + py) * ATLAS_SIZE + x0 + px) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 0;
        }
      }
    },
    // ellipse centred at (cx, cy) in 0..1 cell space, long axis along `angle`
    leaf(cx, cy, length, width, angle, lum, warm) {
      const ca = Math.cos(angle), sa = Math.sin(angle);
      const reach = Math.ceil(length * CELL) + 1;
      const pcx = cx * CELL, pcy = cy * CELL;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const along = (dx * ca + dy * sa) / (length * CELL);
          const across = (-dx * sa + dy * ca) / (width * CELL);
          // pointed tip: the blade narrows toward both ends
          const taper = 1 - Math.pow(Math.abs(along), 1.7);
          if (Math.abs(along) >= 1 || taper <= 0 || Math.abs(across) >= taper) continue;
          const rib = Math.abs(across) < 0.09 ? 0.86 : 1;
          const shade = lum * rib * (0.86 + 0.14 * (1 - Math.abs(across) / taper));
          put(Math.round(pcx + dx), Math.round(pcy + dy),
            Math.min(255, shade * (238 + warm * 17)), Math.min(255, shade * 255), Math.min(255, shade * (214 - warm * 40)));
        }
      }
    },
    line(ax, ay, bx, by, halfWidth, lum) {
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * CELL * 1.5) + 1;
      const w = Math.max(0, Math.round(halfWidth * CELL));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = Math.round((ax + (bx - ax) * t) * width), py = Math.round((ay + (by - ay) * t) * CELL);
        for (let oy = -w; oy <= w; oy++) for (let ox = -w; ox <= w; ox++) put(px + ox, py + oy, lum * 255, lum * 255, lum * 235);
      }
    },
    blob(cx, cy, radius, lum, seed, radiusY = radius) {
      const rx = radius * width, ry = radiusY * CELL;
      const pcx = cx * width, pcy = cy * CELL;
      for (let dy = -Math.ceil(ry * 1.22); dy <= Math.ceil(ry * 1.22); dy++) {
        for (let dx = -Math.ceil(rx * 1.22); dx <= Math.ceil(rx * 1.22); dx++) {
          const d = Math.hypot(dx / rx, dy / ry);
          const ragged = 0.72 + 0.5 * valueNoise((pcx + dx) * 0.14, (pcy + dy) * 0.14, 1.5, seed);
          if (d >= ragged) continue;
          // lit from above: the underside of every clump is darker
          const shade = lum * (0.8 + 0.28 * (dy / ry) + 0.14 * valueNoise((pcx + dx) * 0.5, (pcy + dy) * 0.5, 4.5, seed));
          put(Math.round(pcx + dx), Math.round(pcy + dy),
            Math.min(255, shade * 240), Math.min(255, shade * 255), Math.min(255, shade * 215));
        }
      }
    },
  };
}

// The leaf quad is attached at the middle of its bottom edge (v = 0), so every
// card grows upward and outward from (0.5, 0).
function paintBroadleafCard(painter, rng, round = false) {
  painter.fill(150, 165, 120);
  const twigs = 5;
  for (let t = 0; t < twigs; t++) {
    const spread = (t / (twigs - 1) - 0.5) * 1.5 + (rng() - 0.5) * 0.2;
    const length = 0.55 + rng() * 0.35;
    const ex = 0.5 + Math.sin(spread) * length * 0.62, ey = Math.cos(spread) * length * 0.95;
    painter.line(0.5, 0.0, ex, ey, 0.004, 0.38);
    const leaves = 6 + Math.floor(rng() * 4);
    for (let l = 0; l < leaves; l++) {
      const along = 0.25 + 0.75 * (l + rng() * 0.6) / leaves;
      const side = l % 2 ? 1 : -1;
      const angle = Math.PI / 2 - spread + side * (0.7 + rng() * 0.5);
      const lx = 0.5 + (ex - 0.5) * along, ly = ey * along;
      const len = (round ? 0.075 : 0.095) * (0.75 + rng() * 0.5);
      painter.leaf(lx + Math.cos(angle) * len, ly + Math.sin(angle) * len,
        len, len * (round ? 0.78 : 0.46), angle, 0.7 + rng() * 0.3, rng());
    }
  }
}

function paintNeedleCard(painter, rng) {
  painter.fill(120, 140, 110);
  const sprays = 4;
  for (let t = 0; t < sprays; t++) {
    const spread = (t / (sprays - 1) - 0.5) * 1.3 + (rng() - 0.5) * 0.2;
    const length = 0.6 + rng() * 0.36;
    const ex = 0.5 + Math.sin(spread) * length * 0.6, ey = Math.cos(spread) * length * 0.96;
    painter.line(0.5, 0.0, ex, ey, 0.006, 0.36);
    const needles = 46;
    for (let n = 0; n < needles; n++) {
      const along = 0.12 + 0.88 * n / needles;
      const side = n % 2 ? 1 : -1;
      const angle = Math.PI / 2 - spread + side * (0.75 + rng() * 0.35);
      const bx = 0.5 + (ex - 0.5) * along, by = ey * along;
      const len = 0.07 * (1.1 - along * 0.5) * (0.8 + rng() * 0.4);
      painter.line(bx, by, bx + Math.cos(angle) * len, by + Math.sin(angle) * len, 0.0035, 0.66 + rng() * 0.34);
    }
  }
}

function paintFrondCard(painter, rng) {
  painter.fill(140, 160, 120);
  for (let t = 0; t < 3; t++) {
    const spread = (t - 1) * 0.5 + (rng() - 0.5) * 0.2;
    const ex = 0.5 + Math.sin(spread) * 0.6, ey = Math.cos(spread) * 0.96;
    painter.line(0.5, 0.0, ex, ey, 0.005, 0.4);
    for (let l = 0; l < 20; l++) {
      const along = 0.1 + 0.9 * l / 20;
      const side = l % 2 ? 1 : -1;
      const angle = Math.PI / 2 - spread + side * 1.15;
      const bx = 0.5 + (ex - 0.5) * along, by = ey * along;
      const len = 0.11 * (1 - along * 0.75);
      painter.leaf(bx + Math.cos(angle) * len, by + Math.sin(angle) * len, len, len * 0.2, angle, 0.72 + rng() * 0.28, rng());
    }
  }
}

// Whole-tree silhouette for the horizon tier: the species' own crown clumps
// (normalised x across, y up, r radius) splatted over a trunk.
function paintImpostor(painter, entry, seed, side) {
  const { clumps, trunk } = entry.impostor;
  painter.fill(120, 140, 105);
  painter.line(0.5, 0.0, 0.5, trunk.top, trunk.halfWidth * 0.5, 0.46);
  const ordered = [...clumps].sort((a, b) => side ? b.x - a.x : a.z - b.z);
  for (const clump of ordered) {
    const x = side ? 0.5 + clump.z / entry.width : clump.x;
    painter.blob(x, clump.y, clump.r, 0.56 + 0.44 * clump.light, seed + Math.round(clump.x * 977),
      clump.r * entry.width / entry.height);
  }
}

// species: [{ card: 'broadleaf' | 'needle' | 'round' | 'frond', bark, impostor: { clumps, trunk } }]
export function buildTreeAtlas(seedInt, rng, species) {
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  paintBark(data, seedInt, species[0]?.bark || 'furrowed');
  paintBroadleafCard(cellPainter(data, CELL_BROADLEAF), rng, false);
  paintNeedleCard(cellPainter(data, CELL_NEEDLE), rng);
  paintBroadleafCard(cellPainter(data, CELL_BUSH), rng, true);
  paintFrondCard(cellPainter(data, CELL_FROND), rng);
  const overhead = cellPainter(data, 7);
  overhead.fill(120, 140, 105);
  species.forEach((entry, index) => {
    if (entry.impostor && index < 3) {
      for (const clump of [...entry.impostor.clumps].sort((a, b) => a.y - b.y)) {
        const { x, z, span } = entry.impostor.footprint;
        const u = 0.5 + (clump.x - x) / span;
        const v = 0.5 + (clump.z / entry.width - z) / span;
        overhead.blob((index % 2 + u) * 0.5, (Math.floor(index / 2) + v) * 0.5,
          clump.r / span * 0.5, 0.52 + clump.y * 0.47, seedInt + index);
      }
      for (let side = 0; side < 2; side++) {
        paintImpostor(cellPainter(data, CELL_IMPOSTOR_0 + index, side), entry, seedInt + index, side);
      }
    }
  });
  const texture = new THREE.DataTexture(data, ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
