import type { Biome, StarSystem } from '../game/types';

const PREFIX = ['阿斯', '赫利', '维斯', '诺瓦', '开普', '赛勒', '伊奥', '塔洛', '奥尔', '洛希', '弥拉', '科尔'];
const SUFFIX = ['特拉', '翁', '利斯', '弧', '之门', '深井', '座', '余烬', '潮', '庭', '墓', '岬'];
const BIOMES: Biome[] = ['basalt', 'ice', 'mycelium'];
const SPECTRAL = ['A', 'F', 'G', 'K', 'M'] as const;

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGalaxy(count = 512, seed = 91477): StarSystem[] {
  const random = mulberry32(seed);
  const systems: StarSystem[] = [];
  const palette = [0x9bdfff, 0xffe2aa, 0xff9f74, 0xd6c5ff, 0xffeee0];

  for (let i = 0; i < count; i += 1) {
    const arm = i % 5;
    const r = 18 + Math.pow(random(), 0.66) * 270;
    const angle = r * 0.046 + arm * (Math.PI * 2) / 5 + (random() - 0.5) * 0.72;
    const y = (random() - 0.5) * (9 + r * 0.055);
    const biome = BIOMES[i % BIOMES.length];
    const reachable = i < 32;
    const spectral = SPECTRAL[Math.floor(random() * SPECTRAL.length)];
    const color = palette[SPECTRAL.indexOf(spectral)];
    const p1 = biome === 'basalt' ? 0x6e2d1c : biome === 'ice' ? 0x7ca6b9 : 0x163f38;
    const p2 = biome === 'basalt' ? 0xcb7140 : biome === 'ice' ? 0xd9f3ff : 0x48a65c;
    const accent = biome === 'mycelium' ? 0x79fff2 : biome === 'ice' ? 0x8ee8ff : 0xffb55e;
    const planetRadius = 30_000 + random() * 12_000;
    const atmosphereHeight = planetRadius * (0.078 + random() * 0.026);
    systems.push({
      id: i,
      name: i === 0 ? '赫利俄斯-9' : `${PREFIX[Math.floor(random() * PREFIX.length)]}${SUFFIX[Math.floor(random() * SUFFIX.length)]}-${String(i + 1).padStart(2, '0')}`,
      spectral,
      position: [Math.cos(angle) * r, y, Math.sin(angle) * r],
      reachable,
      distance: Math.round(r * 1.83),
      color,
      planet: {
        id: `P-${i}-A`,
        name: i === 0 ? '维斯佩拉 IV' : `${PREFIX[(i + 3) % PREFIX.length]}-${String.fromCharCode(65 + (i % 6))}`,
        biome,
        radius: planetRadius,
        atmosphere: atmosphereHeight,
        seed: Math.floor(random() * 9_999_999),
        landable: i < 5,
        primary: p1,
        secondary: p2,
        accent,
      },
    });
  }
  systems[0].position = [0, 0, 0];
  systems[0].distance = 0;
  return systems;
}

export function terrainHeight(x: number, z: number, seed: number): number {
  const sx = x * 0.0032 + seed * 0.00017;
  const sz = z * 0.0032 - seed * 0.00013;
  const continental = Math.sin(sx * 0.42) * Math.cos(sz * 0.38) * 42;
  const ridges = Math.pow(Math.abs(Math.sin(sx * 1.7 + Math.cos(sz * 0.9))), 2.2) * 31;
  const detail = Math.sin(sx * 5.4 + Math.sin(sz * 2.1)) * 4.5 + Math.cos(sz * 7.1) * 2.5;
  return continental + ridges + detail - 18;
}
