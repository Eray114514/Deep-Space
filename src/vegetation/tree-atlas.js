// Bark, foliage and impostor maps for the tree field, painted on the CPU into
// one RGBA atlas per planet. No image files: every texel is a function of the
// planet seed, like the trees themselves.
//
//   u 0.0–0.5              bark, tiles in v, periodic around the trunk in u
//   u 0.5–1.0, 4×2 cells   foliage cards (cells 0–3) and whole-tree impostors
//                          (cells 4–7); alpha-tested with RGB edge dilation
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
  const furrow = style === 'smooth' ? 0.32 : 1;
  for (let y = 0; y < ATLAS_SIZE; y++) {
    const v = y / ATLAS_SIZE;
    for (let x = 0; x < HALF; x++) {
      const a = (x / HALF) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const warp = valueNoise(cx * 1.4 + 9, v * 2.2, cz * 1.4, seed + 7) - 0.5;
      const ridge = Math.abs(valueNoise(cx * 3.8 + warp * 1.7, v * 1.5, cz * 3.8 + warp * 1.7, seed) - 0.5) * 2;
      const secondary = Math.abs(valueNoise(cx * 7.5 - warp, v * 3.4, cz * 7.5 + warp, seed + 13) - 0.5) * 2;
      const fine = valueNoise(cx * 16, v * 12, cz * 16, seed + 3);
      const plates = valueNoise(cx * 1.9, v * 7.5, cz * 1.9, seed + 5);
      const crack = Math.min(1, ridge * 2.8) * (0.76 + 0.24 * Math.min(1, secondary * 2.6));
      let lum = 0.44 + 0.46 * crack * furrow + (1 - furrow) * 0.34
        + (fine - 0.5) * 0.24 + (plates - 0.5) * 0.18;
      // pale horizontal lenticels on smooth bark (birch, aspen)
      if (style === 'smooth') {
        lum -= Math.max(0, valueNoise(cx * 2.4, v * 48, cz * 2.4, seed + 11) - 0.72) * 1.75;
      }
      lum = Math.max(0.18, Math.min(1, lum));
      // Subtle warm-ridge / cool-crevice chromatic contrast so bark never reads monochrome
      const crevice = 1 - Math.min(1, ridge * 2.5);
      const i = (y * ATLAS_SIZE + x) * 4;
      data[i] = Math.min(255, lum * (255 - crevice * 18));
      data[i + 1] = Math.min(255, lum * (248 - crevice * 6));
      data[i + 2] = Math.min(255, lum * (236 - crevice * 14));
      data[i + 3] = 255;
    }
  }
}

// Bleed opaque leaf RGB outward into adjacent transparent gutter pixels so
// bilinear filtering and mipmap generation never darken or grey out leaf edges.
function dilateCellRGB(data, x0, y0, width, height, passes = 5) {
  const n = width * height;
  const mask = new Uint8Array(n);
  const nextMask = new Uint8Array(n);
  const rgb = new Uint8Array(n * 3);
  const nextRgb = new Uint8Array(n * 3);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      const di = ((y0 + py) * ATLAS_SIZE + x0 + px) * 4;
      mask[idx] = data[di + 3] > 0 ? 1 : 0;
      rgb[idx * 3] = data[di];
      rgb[idx * 3 + 1] = data[di + 1];
      rgb[idx * 3 + 2] = data[di + 2];
    }
  }
  for (let pass = 0; pass < passes; pass++) {
    nextMask.set(mask);
    nextRgb.set(rgb);
    let changed = false;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = py * width + px;
        if (mask[idx]) continue;
        let sr = 0, sg = 0, sb = 0, count = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = py + oy;
          if (ny < 0 || ny >= height) continue;
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = px + ox;
            if (nx < 0 || nx >= width) continue;
            const nIdx = ny * width + nx;
            if (!mask[nIdx]) continue;
            sr += rgb[nIdx * 3];
            sg += rgb[nIdx * 3 + 1];
            sb += rgb[nIdx * 3 + 2];
            count++;
          }
        }
        if (count > 0) {
          nextMask[idx] = 1;
          nextRgb[idx * 3] = Math.round(sr / count);
          nextRgb[idx * 3 + 1] = Math.round(sg / count);
          nextRgb[idx * 3 + 2] = Math.round(sb / count);
          changed = true;
        }
      }
    }
    mask.set(nextMask);
    rgb.set(nextRgb);
    if (!changed) break;
  }
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      const di = ((y0 + py) * ATLAS_SIZE + x0 + px) * 4;
      if (data[di + 3] === 0 && mask[idx]) {
        data[di] = rgb[idx * 3];
        data[di + 1] = rgb[idx * 3 + 1];
        data[di + 2] = rgb[idx * 3 + 2];
      }
    }
  }
}

// rasterise shapes into one cell; later shapes overwrite earlier
function cellPainter(data, cell, side = null) {
  const col = cell % 2, row = Math.floor(cell / 2);
  const width = side === null ? CELL : CELL / 2;
  const x0 = HALF + col * CELL + (side || 0) * width, y0 = row * CELL;
  const put = (px, py, r, g, b, alpha = 255) => {
    if (px < 0 || py < 0 || px >= width || py >= CELL) return;
    const i = ((y0 + py) * ATLAS_SIZE + x0 + px) * 4;
    if (alpha >= 255 || data[i + 3] === 0) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
      if (alpha > data[i + 3]) data[i + 3] = alpha;
    } else {
      const a = alpha / 255;
      data[i] = Math.round(data[i] * (1 - a) + r * a);
      data[i + 1] = Math.round(data[i + 1] * (1 - a) + g * a);
      data[i + 2] = Math.round(data[i + 2] * (1 - a) + b * a);
      data[i + 3] = Math.min(255, Math.max(data[i + 3], alpha));
    }
  };
  return {
    dilate(passes = 6) {
      dilateCellRGB(data, x0, y0, width, CELL, passes);
    },
    fill(r, g, b) {
      for (let py = 0; py < CELL; py++) {
        for (let px = 0; px < width; px++) {
          const i = ((y0 + py) * ATLAS_SIZE + x0 + px) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 0;
        }
      }
    },
    // Organic pointed leaf with subtle midrib, side shading, and soft edge anti-aliasing
    leaf(cx, cy, length, lWidth, angle, lum, warm, curve = 0) {
      const ca = Math.cos(angle), sa = Math.sin(angle);
      const reach = Math.ceil(length * CELL * 1.15) + 2;
      const pcx = cx * CELL, pcy = cy * CELL;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const along = (dx * ca + dy * sa) / (length * CELL);
          if (Math.abs(along) >= 1) continue;
          const bend = curve * (along * along - 0.35);
          const across = ((-dx * sa + dy * ca) / (lWidth * CELL)) - bend;
          // Natural teardrop/lanceolate taper: fuller near base, crisp pointed tip
          const shifted = along * 0.5 + 0.5; // 0 at petiole, 1 at tip
          const taper = Math.sin(Math.pow(shifted, 0.78) * Math.PI);
          if (taper <= 0) continue;
          const dist = Math.abs(across) / taper;
          if (dist >= 1.04) continue;
          // 1-px soft coverage ramp for crisp mipmap stability without blocky edges
          const edgeAlpha = dist <= 0.92 ? 255 : Math.round(255 * Math.max(0, (1.04 - dist) / 0.12));
          if (edgeAlpha < 16) continue;
          const rib = Math.abs(across) < 0.08 ? 0.88 : 1.0;
          // Subtle lateral veins & brighter sunlit tip
          const vein = 0.96 + 0.04 * Math.sin(shifted * 22.0 - Math.abs(across) * 8.0);
          const tipLift = 0.88 + 0.18 * shifted;
          const dome = 0.84 + 0.16 * (1 - Math.min(1, dist));
          const shade = lum * rib * vein * tipLift * dome;
          put(Math.round(pcx + dx), Math.round(pcy + dy),
            Math.min(255, shade * (232 + warm * 22)),
            Math.min(255, shade * 255),
            Math.min(255, shade * (206 - warm * 38)),
            edgeAlpha);
        }
      }
    },
    line(ax, ay, bx, by, halfWidth, lum) {
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * CELL * 1.6) + 1;
      const w = Math.max(0, Math.round(halfWidth * CELL));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = Math.round((ax + (bx - ax) * t) * width), py = Math.round((ay + (by - ay) * t) * CELL);
        for (let oy = -w; oy <= w; oy++) for (let ox = -w; ox <= w; ox++) {
          put(px + ox, py + oy, lum * 246, lum * 244, lum * 220, 255);
        }
      }
    },
    blob(cx, cy, radius, lum, seed, radiusY = radius) {
      const rx = Math.max(1.5, radius * width), ry = Math.max(1.5, radiusY * CELL);
      const pcx = cx * width, pcy = cy * CELL;
      for (let dy = -Math.ceil(ry * 1.28); dy <= Math.ceil(ry * 1.28); dy++) {
        for (let dx = -Math.ceil(rx * 1.28); dx <= Math.ceil(rx * 1.28); dx++) {
          const d = Math.hypot(dx / rx, dy / ry);
          const ragged = 0.70 + 0.54 * valueNoise((pcx + dx) * 0.16, (pcy + dy) * 0.16, 1.5, seed);
          if (d >= ragged) continue;
          const micro = valueNoise((pcx + dx) * 0.45, (pcy + dy) * 0.45, 4.5, seed);
          // lit from above with leaf-cluster texture grain so impostors match far crowns
          const shade = lum * (0.78 + 0.28 * (dy / ry) + 0.18 * (micro - 0.45));
          put(Math.round(pcx + dx), Math.round(pcy + dy),
            Math.min(255, shade * 238), Math.min(255, shade * 255), Math.min(255, shade * 210), 255);
        }
      }
    },
  };
}

// The leaf quad is attached at the middle of its bottom edge (v = 0), so every
// card grows upward and outward from (0.5, 0). Higher layered foliage density
// keeps crowns lush across mip levels without requiring inflated LOD leaf cards.
function paintBroadleafCard(painter, rng, round = false) {
  painter.fill(145, 165, 115);
  const twigs = round ? 7 : 6;
  const twigSpecs = [];
  for (let t = 0; t < twigs; t++) {
    const spread = (t / (twigs - 1) - 0.5) * 1.65 + (rng() - 0.5) * 0.18;
    const length = 0.54 + rng() * 0.36;
    const ex = 0.5 + Math.sin(spread) * length * 0.64;
    const ey = Math.cos(spread) * length * 0.94;
    twigSpecs.push({ spread, length, ex, ey });
    painter.line(0.5, 0.0, ex, ey, 0.0045, 0.36);
  }
  // Two depth passes: darker shaded inner leaves first, brighter sunlit leaves over them
  for (let layer = 0; layer < 2; layer++) {
    const lumBase = layer === 0 ? 0.58 : 0.78;
    const lumSpan = layer === 0 ? 0.22 : 0.22;
    for (const { spread, ex, ey } of twigSpecs) {
      const leaves = (round ? 7 : 6) + Math.floor(rng() * 3);
      for (let l = 0; l < leaves; l++) {
        const along = (layer === 0 ? 0.18 : 0.24) + 0.74 * (l + rng() * 0.55) / leaves;
        const side = (l + layer) % 2 ? 1 : -1;
        const angle = Math.PI / 2 - spread + side * (0.58 + rng() * 0.58);
        const lx = 0.5 + (ex - 0.5) * along + (rng() - 0.5) * 0.03;
        const ly = ey * along + (rng() - 0.5) * 0.03;
        const len = (round ? 0.088 : 0.112) * (0.76 + rng() * 0.46) * (layer === 0 ? 1.05 : 0.96);
        painter.leaf(lx + Math.cos(angle) * len * 0.85, ly + Math.sin(angle) * len * 0.85,
          len, len * (round ? 0.78 : 0.50), angle, lumBase + rng() * lumSpan, rng(), (rng() - 0.5) * 0.35);
      }
      if (layer === 1) {
        // Terminal crown leaf at the tip of each twig
        const tipAngle = Math.PI / 2 - spread + (rng() - 0.5) * 0.25;
        const tipLen = (round ? 0.085 : 0.105) * (0.85 + rng() * 0.3);
        painter.leaf(ex + Math.cos(tipAngle) * tipLen * 0.55, ey + Math.sin(tipAngle) * tipLen * 0.55,
          tipLen, tipLen * (round ? 0.74 : 0.48), tipAngle, 0.84 + rng() * 0.16, rng(), (rng() - 0.5) * 0.2);
      }
    }
  }
  painter.dilate(6);
}

function paintNeedleCard(painter, rng) {
  painter.fill(118, 142, 108);
  const sprays = 6;
  const spraySpecs = [];
  for (let t = 0; t < sprays; t++) {
    const spread = (t / (sprays - 1) - 0.5) * 1.55 + (rng() - 0.5) * 0.16;
    const length = 0.58 + rng() * 0.36;
    const ex = 0.5 + Math.sin(spread) * length * 0.64;
    const ey = Math.cos(spread) * length * 0.95;
    spraySpecs.push({ spread, ex, ey });
    painter.line(0.5, 0.0, ex, ey, 0.0065, 0.34);
  }
  // Darker interior needle bed followed by brighter sunlit outer needle sprays
  for (let layer = 0; layer < 2; layer++) {
    for (const { spread, ex, ey } of spraySpecs) {
      const needles = layer === 0 ? 48 : 44;
      for (let n = 0; n < needles; n++) {
        const along = 0.10 + 0.90 * n / needles;
        const side = (n + layer) % 2 ? 1 : -1;
        const angle = Math.PI / 2 - spread + side * (0.62 + rng() * 0.42);
        const bx = 0.5 + (ex - 0.5) * along, by = ey * along;
        const len = (layer === 0 ? 0.088 : 0.074) * (1.12 - along * 0.46) * (0.82 + rng() * 0.38);
        const lum = (layer === 0 ? 0.54 : 0.74) + rng() * 0.24;
        painter.line(bx, by, bx + Math.cos(angle) * len, by + Math.sin(angle) * len,
          layer === 0 ? 0.0055 : 0.0042, lum);
      }
    }
  }
  painter.dilate(6);
}

function paintFrondCard(painter, rng) {
  painter.fill(138, 160, 118);
  for (let t = 0; t < 4; t++) {
    const spread = (t / 3 - 0.5) * 1.25 + (rng() - 0.5) * 0.18;
    const length = 0.72 + rng() * 0.24;
    const ex = 0.5 + Math.sin(spread) * length * 0.64;
    const ey = Math.cos(spread) * length * 0.95;
    painter.line(0.5, 0.0, ex, ey, 0.0055, 0.38);
    for (let l = 0; l < 24; l++) {
      const along = 0.08 + 0.92 * l / 24;
      const side = l % 2 ? 1 : -1;
      const angle = Math.PI / 2 - spread + side * (1.05 + rng() * 0.15);
      const bx = 0.5 + (ex - 0.5) * along, by = ey * along;
      const len = 0.125 * (1.05 - along * 0.72);
      painter.leaf(bx + Math.cos(angle) * len * 0.9, by + Math.sin(angle) * len * 0.9,
        len, len * 0.25, angle, 0.68 + rng() * 0.30, rng(), side * 0.25);
    }
  }
  painter.dilate(6);
}

// Whole-tree silhouette for the horizon tier: the species' own crown clumps
// (normalised x across, y up, r radius) splatted over a trunk.
function paintImpostor(painter, entry, seed, side) {
  const { clumps, trunk } = entry.impostor;
  painter.fill(120, 140, 105);
  painter.line(0.5, 0.0, 0.5, trunk.top, trunk.halfWidth * 0.55, 0.44);
  const ordered = [...clumps].sort((a, b) => side ? b.x - a.x : a.z - b.z);
  for (const clump of ordered) {
    const x = side ? 0.5 + clump.z / entry.width : clump.x;
    painter.blob(x, clump.y, clump.r, 0.56 + 0.44 * clump.light, seed + Math.round(clump.x * 977),
      clump.r * entry.width / entry.height);
  }
  painter.dilate(5);
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
  overhead.dilate(5);
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
