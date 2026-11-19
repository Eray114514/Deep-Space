import { clamp, frequencyBlend, lerp, smoothstep } from './noise.js';

// A surveyed catchment in a tangent chart. Each station drains towards the
// sea through one of three lower stations. The lowest cumulative spill/cut
// cost picks the outlet path; contributing area picks the river and fork.
// Only the resulting two small profiles travel to terrain workers.
const STEP = 1000;
const ROWS = 34;
const HALF = 12;
const dot = (axis, p) => axis[0] * p.x + axis[1] * p.y + axis[2] * p.z;

export function drainageDirection(basin, radius, inland, across) {
  const xyz = basin.up.map((v, i) => v + (basin.inland[i] * inland + basin.side[i] * across) / radius);
  const length = Math.hypot(...xyz);
  return { x: xyz[0] / length, y: xyz[1] / length, z: xyz[2] / length };
}

export function buildCoastalDrainage(field, site) {
  const [a, b, c] = site.direction, [u, v, w] = site.landward;
  const basin = { up: site.direction.slice(), inland: site.landward.slice(),
    side: [b * w - c * v, c * u - a * w, a * v - b * u],
    minDot: 1 / Math.sqrt(1 + (42000 / field.R) ** 2), channels: [] };
  const outlet = { col: 0, row: 0, cost: 0, height: field.landDatum, area: 1, children: [] };
  // Warp the sampling lattice as well as its eventual channels. Valleys can
  // bend through a long axial plain without inheriting the grid bearing.
  const offsetAt = (row, col) => col * STEP + smoothstep(0, 4, row) * (
    1550 * field.nC.noise(18.7 + row * 0.134, -2.1 + col * 0.062, 8.3)
    + 460 * field.nB.noise(7.2 + row * 0.293, col * 0.108, 27.4));
  let previous = new Map([[0, outlet]]);
  const cells = [outlet];
  for (let row = 1; row <= ROWS; row++) {
    const current = new Map();
    const half = Math.min(row, HALF);
    for (let col = -half; col <= half; col++) {
      const pos = drainageDirection(basin, field.R, row * STEP, offsetAt(row, col));
      const height = field.height(pos, field.R / 240);
      let parent, cost = Infinity;
      for (let k = col - 1; k <= col + 1; k++) {
        const lower = previous.get(k);
        if (!lower) continue;
        const uphill = Math.max(0, lower.height - height);
        const attempt = lower.cost + (k === col ? 24 : 35)
          + uphill * 1.6 + Math.max(0, lower.height - field.landDatum) * 0.075;
        if (attempt < cost) { parent = lower; cost = attempt; }
      }
      const cell = { col, row, height, cost, area: 1, parent, children: [] };
      current.set(col, cell);
      parent.children.push(cell);
      cells.push(cell);
    }
    previous = current;
  }
  for (let i = cells.length - 1; i > 0; i--) cells[i].parent.area += cells[i].area;
  for (const cell of cells) cell.children.sort((l, r) => r.area - l.area);

  function upstream(first) {
    const path = [];
    for (let cell = first; cell; cell = cell.children[0]) path.push(cell);
    return path;
  }
  const main = upstream(outlet);
  const fork = main.filter(cell => cell.row >= 3 && cell.row <= 20)
    .map(cell => cell.children[1]).filter(Boolean).sort((l, r) => r.area - l.area)[0];
  const paths = [main];
  if (fork) paths.push([...main.slice(0, fork.row), ...upstream(fork)]);
  for (const path of paths) {
    const profile = path.map((cell, i) => {
      // A five-station average rounds the raster corners. Width follows
      // catchment area, including the added discharge below a confluence.
      let offset = 0;
      for (let k = -2; k <= 2; k++) {
        const neighbor = path[clamp(i + k, 0, path.length - 1)];
        offset += (3 - Math.abs(k)) * neighbor.col * STEP;
      }
      return { offset: offset / 9 + offsetAt(i, cell.col) - cell.col * STEP,
        width: 430 + 1850 * Math.sqrt(cell.area / outlet.area) };
    });
    basin.channels.push(profile);
  }
  return basin;
}

export function drainageStation(profile, metres) {
  const station = clamp(metres / STEP, 0, profile.length - 1);
  const row = Math.floor(station);
  const a = profile[row], b = profile[Math.min(row + 1, profile.length - 1)];
  const prev = profile[Math.max(0, row - 1)];
  const next = profile[Math.min(profile.length - 1, row + 2)];
  const t = station - row;
  const leftSlope = (b.offset - prev.offset) * 0.5;
  const rightSlope = (next.offset - a.offset) * 0.5;
  return lerp(a.offset, b.offset, t * t * (3 - 2 * t))
    + t * (1 - t) * ((1 - t) * leftSlope - t * rightSlope);
}

export function carveCoastalDrainage(field, dir, height, maxFreq) {
  const basin = field.coastalDrainage;
  const cosine = dot(basin.up, dir);
  if (cosine < basin.minDot) return height;
  const scale = field.R / cosine;
  const inland = dot(basin.inland, dir) * scale;
  if (inland < -3000 || inland >= ROWS * STEP) return height;
  const across = dot(basin.side, dir) * scale;
  let result = height;
  for (const profile of basin.channels) {
    const end = (profile.length - 1) * STEP;
    if (inland >= end) continue;
    const station = Math.max(0, inland / STEP);
    const row = Math.floor(station), t = station - row;
    const a = profile[row], b = profile[row + 1];
    const lateral = across - drainageStation(profile, inland);
    const width = lerp(a.width, b.width, t);
    const span = Math.abs(lateral) / width;
    if (span >= 1.85) continue;
    // Drowned lower reach, a gravel bed rising inland, then a gradual
    // return to the original headwater relief. A narrow intertidal bench
    // sits between the bed and the much steeper valley flanks.
    const bed = field.landDatum - 38 + Math.max(0, inland) * 0.00125
      + Math.max(0, inland - 14800) ** 1.65 * 0.000029;
    const side = Math.sign(lateral);
    // Curvature at either end of the station describes the depositional
    // bank. Interpolate it too: a per-interval sign/width would put a sheer
    // lateral step in the shoreline at each kilometre marker.
    const bendA = b.offset + profile[Math.max(0, row - 1)].offset - 2 * a.offset;
    const bendB = profile[Math.min(row + 2, profile.length - 1)].offset + a.offset - 2 * b.offset;
    const bend = 2 * lerp(bendA, bendB, smoothstep(0, 1, t)) / STEP;
    const innerBank = clamp(bend * side * 1.4, -1, 1);
    const spur = field.bandFbm(field.nB, dir.x + 11, dir.y - 19, dir.z,
      field.R / 3300, 5, 0.54, 2.1, maxFreq);
    const apron = span * (1 + 0.30 * innerBank) + 0.075 * spur;
    const shelf = bed + (20 + 18 * innerBank) * smoothstep(0.11, 0.34, apron)
      + 26 * smoothstep(0.26, 0.52, apron);
    // Tributary gullies and rock noses interrupt the exposed wall. Preserve
    // bed width and return continuously to the undisturbed rim.
    const wall = span + 0.45 * spur * smoothstep(0.1, 0.6, span);
    const bank = smoothstep(0.24, 1.52, wall);
    let target = lerp(shelf, Math.max(shelf, height), bank);
    const face = smoothstep(0.08, 0.34, bank) * (1 - smoothstep(0.78, 1, bank));
    if (face > 0) {
      const layer = (target + 140 * spur) / 112;
      const part = layer - Math.floor(layer);
      target += (smoothstep(0.25, 0.77, part) - part) * 85 * face
        * frequencyBlend(field.R / 210, maxFreq);
    }
    const taper = smoothstep(-3000, 0, inland) * (1 - smoothstep(end - 4400, end, inland));
    result = Math.min(result, lerp(height, target, taper));
  }
  return result;
}
