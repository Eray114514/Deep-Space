import { describe, expect, it } from 'vitest';
import { createGalaxy, terrainHeight } from '../src/simulation/Galaxy';

describe('deterministic galaxy', () => {
  it('creates the planned map and reachable set', () => {
    const galaxy = createGalaxy();
    expect(galaxy).toHaveLength(512);
    expect(galaxy.filter((star) => star.reachable)).toHaveLength(32);
    expect(galaxy.filter((star) => star.planet.landable)).toHaveLength(5);
    expect(galaxy[0].name).toBe('赫利俄斯-9');
  });

  it('is stable for the same seed and varied for another', () => {
    expect(createGalaxy(8, 12)).toEqual(createGalaxy(8, 12));
    expect(createGalaxy(8, 12)).not.toEqual(createGalaxy(8, 13));
  });
});

describe('terrain field', () => {
  it('is deterministic and finite', () => {
    const a = terrainHeight(120.5, -90.2, 991);
    expect(a).toBe(terrainHeight(120.5, -90.2, 991));
    expect(Number.isFinite(a)).toBe(true);
    expect(a).not.toBe(terrainHeight(121.5, -90.2, 991));
  });
});
