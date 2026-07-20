// Pure, deterministic galaxy lattice placement. Keep this module free of
// rendering code so developer tools can inspect the same cells as the game.

import { hash3i, hashFloat, strHash32 } from './rng.js';

export const GALAXY_LAYOUT_VERSION = 1;
export const CELL = 4e9;
export const STAR_PROBABILITY = 0.42;
export const DISC_HALF_THICKNESS = 6;
export const HALO_PROBABILITY = 0.10;

export function galaxyCellAt(seed, ix, iy, iz, force = false) {
  const galaxySeed = strHash32(`${seed}:galaxy`);
  const hash = hash3i(ix, iy, iz, galaxySeed);
  const probability = STAR_PROBABILITY
    * (Math.abs(iy) > DISC_HALF_THICKNESS ? HALO_PROBABILITY : 1);
  if (!force && hashFloat(hash, 0) > probability) return null;

  return {
    id: `${ix},${iy},${iz}`,
    ix,
    iy,
    iz,
    positionCells: [
      ix + 0.12 + hashFloat(hash, 0) * 0.76,
      (iy + 0.12 + hashFloat(hash, 1) * 0.76) * 0.5,
      iz + 0.12 + hashFloat(hash, 2) * 0.76,
    ],
  };
}

export function nearbyGalaxyCells(seed, {
  limit = 18,
  xzRadius = 5,
  yRadius = 2,
} = {}) {
  const cells = [];
  for (let iy = -yRadius; iy <= yRadius; iy++) {
    for (let iz = -xzRadius; iz <= xzRadius; iz++) {
      for (let ix = -xzRadius; ix <= xzRadius; ix++) {
        if (ix === 0 && iy === 0 && iz === 0) continue;
        const cell = galaxyCellAt(seed, ix, iy, iz);
        if (!cell) continue;
        cell.distanceCells = Math.hypot(...cell.positionCells);
        cells.push(cell);
      }
    }
  }
  return cells
    .sort((a, b) => a.distanceCells - b.distanceCells || a.id.localeCompare(b.id))
    .slice(0, limit);
}
