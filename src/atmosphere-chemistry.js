// Renderer-neutral planetary atmospheric chemistry and scale model.
// Derives physically coherent Rayleigh, Mie (scattering + absorption + phase
// asymmetry), stratospheric absorption, and radius-proportional scale heights
// for every planet and moon class across the galaxy.
//
// Deliberately has zero Three.js or RNG-stream side effects so terrain/world
// generation determinism is never disturbed.

import { createAtmosphereProfile, mieCoefficients, rayleighCoefficients } from './atmosphere-physics.js';

const EARTH_RADIUS_M = 6000000;
const EARTH_RAYLEIGH_H = 8000;
const EARTH_MIE_H = 1200;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function scaleRgb(rgb, k) {
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

// Independent deterministic FNV-1a hash of the body seed (never touches world RNG).
function hashSeed(seed) {
  const text = String(seed || '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function seedFloat(seed, salt = 0) {
  let h = hashSeed(`${seed}:${salt}`);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// All scattering / absorption coefficients below are expressed in 1e-6 m^-1
// at 1 bar, 286 K Earth-column reference before radius-column compensation.
// Physical invariant: mieExt[c] >= mieScatter[c] >= 0 for every channel.
const U = 1e-6;

const LUSH_VARIANTS = [
  // Classic Earth sapphire-azure with rich golden-crimson sunsets
  {
    name: 'terran-azure',
    rayleigh: [5.8, 13.558, 33.1],
    mieScatter: [5.0, 5.2, 5.5],
    mieExt: [5.4, 5.7, 6.1],
    ozone: [0.76, 2.12, 0.095],
    asymmetry: 0.80,
    mieHeightRatio: 0.16,
    skyHex: 0x72beff,
    atmoHex: 0x56abff,
  },
  // Warm maritime turquoise-cerulean
  {
    name: 'cerulean-warm',
    rayleigh: [5.2, 16.2, 30.8],
    mieScatter: [5.6, 5.8, 5.4],
    mieExt: [6.0, 6.3, 6.2],
    ozone: [1.05, 1.85, 0.12],
    asymmetry: 0.80,
    mieHeightRatio: 0.17,
    skyHex: 0x6fd0f5,
    atmoHex: 0x4cc4ee,
  },
  // High-clarity alpine indigo
  {
    name: 'alpine-indigo',
    rayleigh: [6.2, 12.6, 36.2],
    mieScatter: [4.2, 4.4, 4.8],
    mieExt: [4.6, 4.9, 5.3],
    ozone: [0.68, 2.35, 0.08],
    asymmetry: 0.80,
    mieHeightRatio: 0.145,
    skyHex: 0x68abff,
    atmoHex: 0x4d92ff,
  },
];

const OCEAN_VARIANTS = [
  // Deep pelagic cobalt with luminous humid horizon mist
  {
    name: 'pelagic-cobalt',
    rayleigh: [4.9, 14.4, 36.5],
    mieScatter: [6.2, 6.9, 7.6],
    mieExt: [6.7, 7.5, 8.4],
    ozone: [0.92, 2.30, 0.11],
    asymmetry: 0.80,
    mieHeightRatio: 0.17,
    skyHex: 0x5bb2ff,
    atmoHex: 0x3f98ff,
  },
  // Tropical oceanic aquamarine-azure
  {
    name: 'marine-aquamarine',
    rayleigh: [4.4, 17.6, 33.4],
    mieScatter: [5.8, 6.8, 7.2],
    mieExt: [6.3, 7.3, 7.9],
    ozone: [1.35, 1.90, 0.12],
    asymmetry: 0.79,
    mieHeightRatio: 0.18,
    skyHex: 0x5ccbe8,
    atmoHex: 0x3eb9db,
  },
];

const DESERT_VARIANTS = [
  // Martian butterscotch / iron-oxide dust (absorbs blue, scatters warm ochre)
  {
    name: 'martian-ochre',
    rayleigh: [8.8, 10.6, 13.4],
    mieScatter: [18.5, 11.0, 5.0],
    mieExt: [20.2, 14.4, 11.8],
    ozone: [0.22, 1.25, 3.60],
    asymmetry: 0.70,
    mieHeightRatio: 0.28,
    skyHex: 0xdca06b,
    atmoHex: 0xe89b5a,
  },
  // Arrakis golden honey-amber dust
  {
    name: 'arrakis-gold',
    rayleigh: [9.4, 11.8, 12.6],
    mieScatter: [20.0, 14.6, 6.2],
    mieExt: [21.6, 17.2, 12.8],
    ozone: [0.20, 1.05, 3.30],
    asymmetry: 0.72,
    mieHeightRatio: 0.30,
    skyHex: 0xe5b978,
    atmoHex: 0xf0be6e,
  },
  // Terracotta / burnt-sienna canyon haze
  {
    name: 'sienna-dusk',
    rayleigh: [10.4, 9.2, 10.8],
    mieScatter: [19.2, 9.8, 4.6],
    mieExt: [21.4, 13.8, 12.4],
    ozone: [0.26, 1.55, 4.00],
    asymmetry: 0.68,
    mieHeightRatio: 0.26,
    skyHex: 0xd48562,
    atmoHex: 0xe07a52,
  },
];

const ICE_VARIANTS = [
  // Glacial methane-cyan (CH4 red absorption -> crisp arctic cyan-teal)
  {
    name: 'glacial-cyan',
    rayleigh: [4.0, 16.4, 28.8],
    mieScatter: [4.2, 5.8, 6.8],
    mieExt: [4.8, 6.4, 7.4],
    ozone: [3.20, 0.85, 0.08],
    asymmetry: 0.71,
    mieHeightRatio: 0.24,
    skyHex: 0x9ce2f2,
    atmoHex: 0x7bd8ee,
  },
  // Frost-silver / crystalline diamond-dust sky
  {
    name: 'frost-silver',
    rayleigh: [7.6, 13.4, 22.8],
    mieScatter: [6.4, 7.4, 8.4],
    mieExt: [7.0, 8.0, 9.2],
    ozone: [1.65, 0.95, 0.12],
    asymmetry: 0.74,
    mieHeightRatio: 0.22,
    skyHex: 0xc2def0,
    atmoHex: 0xaad2ec,
  },
  // Cryo Pluto-indigo nitrogen haze
  {
    name: 'cryo-indigo',
    rayleigh: [3.8, 11.8, 29.5],
    mieScatter: [4.0, 5.6, 7.8],
    mieExt: [4.6, 6.2, 8.4],
    ozone: [2.60, 1.15, 0.08],
    asymmetry: 0.74,
    mieHeightRatio: 0.21,
    skyHex: 0x86b9ec,
    atmoHex: 0x6ca4e8,
  },
];

const LAVA_VARIANTS = [
  // Volcanic SO2 + silicate ash + sodium ember haze
  {
    name: 'volcanic-ember',
    rayleigh: [12.0, 8.2, 5.8],
    mieScatter: [22.0, 10.2, 3.4],
    mieExt: [25.5, 16.0, 13.5],
    ozone: [0.30, 1.80, 4.60],
    asymmetry: 0.68,
    mieHeightRatio: 0.30,
    skyHex: 0xc96c40,
    atmoHex: 0xe86b35,
  },
  // Basalt smoky bronze-copper smog
  {
    name: 'smoky-bronze',
    rayleigh: [10.8, 8.8, 6.4],
    mieScatter: [19.5, 11.6, 4.4],
    mieExt: [23.0, 16.2, 13.0],
    ozone: [0.35, 1.55, 4.20],
    asymmetry: 0.66,
    mieHeightRatio: 0.32,
    skyHex: 0xb97a4a,
    atmoHex: 0xd68042,
  },
];

const TOXIC_VARIANTS = [
  // Chlorine + SO2 acid chartreuse-olive haze (Cl2/SO2 absorb blue-violet strongly)
  {
    name: 'chlorine-chartreuse',
    rayleigh: [8.6, 15.2, 8.2],
    mieScatter: [14.5, 17.5, 4.8],
    mieExt: [16.5, 18.8, 24.5],
    ozone: [0.85, 0.22, 4.80],
    asymmetry: 0.72,
    mieHeightRatio: 0.28,
    skyHex: 0xa6cc52,
    atmoHex: 0x9ed645,
  },
  // Venusian sulfuric gold-amber cloud shroud
  {
    name: 'venusian-sulfur',
    rayleigh: [11.5, 14.5, 6.8],
    mieScatter: [19.5, 16.8, 5.4],
    mieExt: [20.8, 19.6, 25.8],
    ozone: [0.45, 0.55, 4.50],
    asymmetry: 0.74,
    mieHeightRatio: 0.30,
    skyHex: 0xd9c264,
    atmoHex: 0xe6c858,
  },
];

const BARREN_VARIANTS = [
  // Tenuous mineral-dust taupe / warm stone exosphere (never blue)
  {
    name: 'regolith-taupe',
    rayleigh: [8.4, 9.2, 10.6],
    mieScatter: [11.5, 9.2, 6.8],
    mieExt: [12.8, 10.8, 9.2],
    ozone: [0.35, 0.90, 2.20],
    asymmetry: 0.72,
    mieHeightRatio: 0.22,
    skyHex: 0x9b9286,
    atmoHex: 0xb4a490,
  },
  // Pale iron-slate dust rim
  {
    name: 'dusty-amber-slate',
    rayleigh: [9.0, 9.6, 10.0],
    mieScatter: [12.8, 9.6, 6.2],
    mieExt: [14.2, 11.4, 9.4],
    ozone: [0.30, 1.00, 2.50],
    asymmetry: 0.70,
    mieHeightRatio: 0.24,
    skyHex: 0xa59482,
    atmoHex: 0xc2a88c,
  },
];

const EXOTIC_VARIANTS = [
  // 0: Titan organic tholin amber-gold (Cassini golden-honey crescent)
  {
    name: 'titan-amber',
    rayleigh: [13.2, 10.4, 5.6],
    mieScatter: [19.0, 13.0, 4.2],
    mieExt: [21.0, 16.0, 12.6],
    ozone: [0.24, 1.30, 3.85],
    asymmetry: 0.69,
    mieHeightRatio: 0.27,
    skyHex: 0xdfa662,
    atmoHex: 0xeb9e4c,
  },
  // 1: Methane emerald-jade / turquoise (CH4 absorbs red strongly)
  {
    name: 'methane-jade',
    rayleigh: [3.8, 21.8, 19.8],
    mieScatter: [4.6, 12.8, 11.4],
    mieExt: [18.5, 14.0, 13.4],
    ozone: [3.90, 0.35, 0.55],
    asymmetry: 0.75,
    mieHeightRatio: 0.22,
    skyHex: 0x58d4b8,
    atmoHex: 0x42d6b4,
  },
  // 2: Amethyst-rose twilight (green-band alkali/iodine absorption)
  {
    name: 'amethyst-twilight',
    rayleigh: [17.0, 6.8, 25.0],
    mieScatter: [13.5, 6.8, 15.0],
    mieExt: [15.2, 11.6, 16.8],
    ozone: [0.38, 3.30, 0.28],
    asymmetry: 0.73,
    mieHeightRatio: 0.22,
    skyHex: 0xb47ce0,
    atmoHex: 0xbd72f0,
  },
  // 3: Rose-copper champagne dusk
  {
    name: 'rose-copper',
    rayleigh: [16.4, 10.2, 11.6],
    mieScatter: [16.8, 10.8, 8.6],
    mieExt: [18.4, 13.4, 12.6],
    ozone: [0.22, 1.50, 2.10],
    asymmetry: 0.71,
    mieHeightRatio: 0.24,
    skyHex: 0xd89aa0,
    atmoHex: 0xe6949c,
  },
  // 4: Two-tone seafoam zenith + warm gold horizon
  {
    name: 'seafoam-gold',
    rayleigh: [5.4, 19.4, 23.4],
    mieScatter: [14.8, 12.2, 6.0],
    mieExt: [16.2, 13.6, 9.2],
    ozone: [2.45, 0.58, 0.24],
    asymmetry: 0.76,
    mieHeightRatio: 0.21,
    skyHex: 0x76cfc4,
    atmoHex: 0x62d4c2,
  },
];

const GAS_GIANT_VARIANTS = [
  // Jovian/Saturnian warm golden-ivory haze with subtle upper pale-azure whisper
  {
    name: 'jovian-amber',
    rayleigh: [9.5, 11.8, 14.5],
    mieScatter: [17.5, 13.8, 8.2],
    mieExt: [19.0, 15.6, 11.8],
    ozone: [0.28, 0.95, 2.50],
    asymmetry: 0.74,
    mieHeightRatio: 0.24,
    skyHex: 0xd9a876,
    atmoHex: 0xe6b47e,
  },
  // Warm champagne-ochre Saturnian limb
  {
    name: 'saturnian-champagne',
    rayleigh: [10.4, 12.4, 13.6],
    mieScatter: [18.8, 15.8, 9.8],
    mieExt: [20.2, 17.4, 13.0],
    ozone: [0.24, 0.85, 2.20],
    asymmetry: 0.75,
    mieHeightRatio: 0.25,
    skyHex: 0xe2c48c,
    atmoHex: 0xedd096,
  },
];

const ICE_GIANT_VARIANTS = [
  // Neptunian deep sapphire-cerulean methane limb
  {
    name: 'neptunian-cerulean',
    rayleigh: [3.6, 15.8, 33.8],
    mieScatter: [4.2, 9.8, 13.6],
    mieExt: [6.4, 10.6, 14.4],
    ozone: [3.80, 0.85, 0.06],
    asymmetry: 0.78,
    mieHeightRatio: 0.22,
    skyHex: 0x4db4e6,
    atmoHex: 0x3ea8e8,
  },
  // Uranian pale glacial cyan-aquamarine
  {
    name: 'uranian-aquamarine',
    rayleigh: [4.2, 19.2, 28.4],
    mieScatter: [5.4, 11.8, 13.2],
    mieExt: [7.6, 12.6, 14.2],
    ozone: [3.50, 0.52, 0.08],
    asymmetry: 0.77,
    mieHeightRatio: 0.23,
    skyHex: 0x72d4e2,
    atmoHex: 0x5ecde0,
  },
];

const VARIANT_TABLE = {
  lush: LUSH_VARIANTS,
  ocean: OCEAN_VARIANTS,
  desert: DESERT_VARIANTS,
  ice: ICE_VARIANTS,
  lava: LAVA_VARIANTS,
  toxic: TOXIC_VARIANTS,
  barren: BARREN_VARIANTS,
  exotic: EXOTIC_VARIANTS,
  gasGiant: GAS_GIANT_VARIANTS,
  iceGiant: ICE_GIANT_VARIANTS,
};

const TYPE_THICKNESS_SCALE = {
  lush: 1.00,
  ocean: 1.04,
  desert: 1.02,
  ice: 0.94,
  lava: 1.05,
  toxic: 1.12,
  barren: 0.74,
  exotic: 0.94,
  gasGiant: 0.76,
  iceGiant: 0.80,
};

function selectChemistryVariant(planet) {
  const type = planet?.type || 'lush';
  const variants = VARIANT_TABLE[type] || LUSH_VARIANTS;
  const seed = planet?.seed;

  // Keep the home world (planet-0 in 0,0,0) and unseeded unit-test fixtures
  // on the canonical Terran-Azure Earth benchmark.
  const isHomeWorld = planet?.bodyId === 'planet-0' && String(seed || '').includes(':0,0,0:0');
  if (!seed || (type === 'lush' && isHomeWorld)) {
    return { ...variants[0], isReferenceLush: !seed && type === 'lush' };
  }

  // Pick a deterministic primary variant and subtly blend toward a neighbour
  // so no two planets across 1,024 star systems look copy-pasted, while each
  // stays strongly anchored in its chemical identity.
  const pick = seedFloat(seed, 11);
  const index = Math.floor(pick * variants.length) % variants.length;
  const base = variants[index];
  const subtle = (seedFloat(seed, 29) - 0.5) * 0.16;

  // Subtle per-world spectral character drift within the same chemical family.
  const drift = [1 + subtle * 0.65, 1 + subtle * 0.2, 1 - subtle * 0.55];
  const rayleigh = base.rayleigh.map((v, i) => Math.max(0.5, v * drift[i]));
  const mieScatter = base.mieScatter.map((v, i) => Math.max(0.5, v * (1 + subtle * (i === 0 ? 0.5 : i === 2 ? -0.4 : 0.1))));
  const mieExt = base.mieExt.map((v, i) => Math.max(mieScatter[i] * 1.05, v * (1 + subtle * (i === 0 ? 0.4 : 0.15))));
  const ozone = base.ozone.map((v) => Math.max(0.02, v * (0.9 + seedFloat(seed, 47) * 0.22)));

  return {
    ...base,
    rayleigh,
    mieScatter,
    mieExt,
    ozone,
    asymmetry: clamp(base.asymmetry + (seedFloat(seed, 61) - 0.5) * 0.04, 0.58, 0.80),
    isReferenceLush: false,
  };
}

/**
 * Derive complete physical atmosphere profile + density scale + UI/material
 * appearance for any planet or moon in the universe.
 */
export function resolveAtmosphereModel(planet) {
  const type = planet?.type || 'lush';
  const isMoon = Boolean(planet?.isMoon);
  const isGiant = type === 'gasGiant' || type === 'iceGiant' || Boolean(planet?.isGasGiant);
  const groundRadiusMeters = Math.max(1000, Number(planet?.R ?? planet?.radius) || 6371000);
  const maxTerrainMeters = isGiant ? 0 : Math.max(0, Number(planet?.hAmp) || 0);

  const rawPressure = Number(planet?.atmosphere?.pressureBar);
  const hasPressure = Number.isFinite(rawPressure) && rawPressure > 0;
  const fallbackDensity = Math.max(0.02, Number(planet?.atmoDensity) || 1);
  const pressure = isGiant ? fallbackDensity : (hasPressure ? rawPressure : fallbackDensity);

  const rawTemp = Number(planet?.weatherProfile?.temperatureK)
    || Number(planet?.equilibriumK)
    || 286;
  const temperatureK = clamp(rawTemp, 120, 750);
  const isUnseededReference = !planet?.seed && groundRadiusMeters >= EARTH_RADIUS_M;
  const temperatureScale = isUnseededReference
    ? clamp(temperatureK / 286, 0.68, 1.45)
    : clamp(Math.pow(temperatureK / 286, 0.52), 0.72, 1.36);

  const variant = selectChemistryVariant(planet);

  // ---- Scale heights & optical top ----------------------------------------
  // Preserve exact Earth reference at R >= 6,000 km for numerical contracts.
  // Below 6,000 km, scale smoothly with planet radius so small moons wear a
  // tight, realistic ~2-3.5% visible crescent rim instead of a 70% bubble,
  // while keeping topAltitude >= 10 * H_R so the outer edge fades cleanly to
  // pure zero with no visible sphere cutoff.
  let rayleighScaleHeightMeters;
  let mieScaleHeightMeters;
  let topAltitudeMeters;
  let ozoneCenterMeters;
  let ozoneHalfWidthMeters;

  if (groundRadiusMeters >= EARTH_RADIUS_M) {
    rayleighScaleHeightMeters = EARTH_RAYLEIGH_H * temperatureScale;
    const baseMieH = (type === 'desert' || type === 'toxic' || type === 'lava') ? 1800 : EARTH_MIE_H;
    mieScaleHeightMeters = baseMieH * Math.sqrt(temperatureScale);
    topAltitudeMeters = clamp(Math.max(
      groundRadiusMeters * (100000 / EARTH_RADIUS_M),
      maxTerrainMeters * 2.4 + 6000,
    ), 26000, 120000);
    ozoneCenterMeters = Math.min(25000, topAltitudeMeters * 0.42);
    ozoneHalfWidthMeters = Math.min(15000, topAltitudeMeters * 0.28);
  } else {
    const rRatio = clamp(groundRadiusMeters / EARTH_RADIUS_M, 0.001, 1);
    const typeThickness = TYPE_THICKNESS_SCALE[type] ?? 1.0;
    const moonTightness = isMoon ? 0.90 : 1.0;
    // Target H_R / R: ~0.0155 on 38 km moons (visible rim ~3.3% of R),
    // ~0.0105 on 230 km worlds, ~0.0080 on 1,200 km homeworld, converging
    // smoothly to 8000 / 6000000 (0.001333) at 6,000 km.
    const compactFraction = 0.0094 * Math.pow(clamp(groundRadiusMeters / 300000, 0.10, 4.2), -0.18);
    const earthFraction = EARTH_RAYLEIGH_H / EARTH_RADIUS_M;
    const blendToEarth = smoothstep(0.28, 1.0, rRatio);
    const baseFraction = lerp(compactFraction * typeThickness * moonTightness, earthFraction, blendToEarth);
    const terrainScaleFloor = maxTerrainMeters * 0.28;
    rayleighScaleHeightMeters = Math.max(
      120,
      Math.max(groundRadiusMeters * baseFraction, terrainScaleFloor) * lerp(temperatureScale, 1, 0.35),
    );
    mieScaleHeightMeters = Math.max(
      50,
      rayleighScaleHeightMeters * clamp(variant.mieHeightRatio, 0.12, 0.34),
    );
    // >= 10.5 scale heights guarantees exp(-top/H_R) < 3e-5: zero visible shell ring!
    const clearanceTop = maxTerrainMeters * 2.2 + Math.min(4500, groundRadiusMeters * 0.03);
    topAltitudeMeters = Math.max(
      rayleighScaleHeightMeters * 10.5,
      mieScaleHeightMeters * 14.0,
      clearanceTop,
    );
    // Never allow extreme edge cases to exceed 22% of the body radius.
    topAltitudeMeters = Math.min(topAltitudeMeters, Math.max(groundRadiusMeters * 0.22, clearanceTop));
    ozoneCenterMeters = Math.min(rayleighScaleHeightMeters * 3.125, topAltitudeMeters * 0.42);
    ozoneHalfWidthMeters = Math.min(rayleighScaleHeightMeters * 1.875, topAltitudeMeters * 0.28);
  }

  // ---- Column-preserving optical compensation -----------------------------
  // Keeps both orbital limb glow and ground zenith/sunset optical depth
  // cinema-grade across 28 km moons to 6,000 km planets while preventing tiny
  // moons from turning into opaque ground fog.
  let columnCompensation = 1.0;
  if (groundRadiusMeters < EARTH_RADIUS_M) {
    const verticalRatio = EARTH_RAYLEIGH_H / rayleighScaleHeightMeters;
    const limbRatio = Math.sqrt((EARTH_RADIUS_M * EARTH_RAYLEIGH_H)
      / (groundRadiusMeters * rayleighScaleHeightMeters));
    columnCompensation = clamp(
      Math.pow(Math.max(0.25, verticalRatio), 0.55) * Math.pow(Math.max(0.25, limbRatio), 0.30),
      0.75,
      12.5,
    );
  }

  // ---- Effective atmospheric density scale --------------------------------
  // Linear below 1 bar (preserves atmoDensity = 0.5 -> 0.5 contract),
  // smoothly compressed above 1 bar so thick 2.7-7 bar atmospheres read as
  // rich, dramatic shrouds without clipping to featureless milk.
  const effectivePressure = pressure <= 1
    ? pressure
    : 1 + Math.log1p((pressure - 1) * 0.85) * 0.72;
  const vacuumFade = !isGiant && hasPressure && pressure < 0.008
    ? smoothstep(0.0005, 0.008, pressure)
    : 1;
  const densityScale = effectivePressure * vacuumFade / temperatureScale;

  // ---- Assemble physical scattering & absorption vectors ------------------
  let rayleigh;
  let mie;
  let ozoneAbsorption;

  if (variant.isReferenceLush && groundRadiusMeters >= EARTH_RADIUS_M) {
    // Exact Earth physical constants for reference contracts.
    rayleigh = rayleighCoefficients();
    mie = mieCoefficients();
    ozoneAbsorption = [0.650e-6, 1.881e-6, 0.085e-6];
  } else {
    const k = U * columnCompensation;
    rayleigh = scaleRgb(variant.rayleigh, k);
    const mieScatter = scaleRgb(variant.mieScatter, k);
    const mieExt = scaleRgb(variant.mieExt, k).map((ext, i) => Math.max(ext, mieScatter[i]));
    mie = {
      scattering: mieScatter,
      extinction: mieExt,
      absorption: mieExt.map((ext, i) => Math.max(0, ext - mieScatter[i])),
      asymmetry: variant.asymmetry,
    };
    ozoneAbsorption = scaleRgb(variant.ozone, k);
  }

  const profile = createAtmosphereProfile({
    groundRadiusMeters,
    topAltitudeMeters,
    rayleighScaleHeightMeters,
    mieScaleHeightMeters,
    ozoneCenterMeters,
    ozoneHalfWidthMeters,
    rayleigh,
    mie,
    ozoneAbsorption,
    multipleScatteringFactor: 0.1,
  });

  // Preview/UI appearance synced with the physical chemistry.
  const limbStrength = isGiant
    ? (type === 'iceGiant' ? 0.52 : 0.46)
    : clamp(smoothstep(0.004, 0.85, pressure) * (type === 'barren' ? 0.35 : 0.62), 0, 0.68);

  return {
    profile,
    densityScale,
    chemistry: variant.name,
    hasSignificantAtmosphere: isGiant || densityScale > 0.004,
    appearance: {
      skyHex: variant.skyHex,
      atmoHex: variant.atmoHex,
      limbStrength,
      chemistry: variant.name,
    },
  };
}

/**
 * Lightweight appearance lookup for star-map/system preview and planet palette
 * setup without building full physics profiles.
 */
export function atmosphereAppearance(body) {
  const variant = selectChemistryVariant(body);
  const type = body?.type || 'lush';
  const isGiant = type === 'gasGiant' || type === 'iceGiant' || Boolean(body?.isGasGiant);
  const pressure = Number(body?.atmosphere?.pressureBar);
  const hasPressure = Number.isFinite(pressure);
  const visible = isGiant || (!hasPressure ? type !== 'barren' : pressure >= 0.006);
  const opacity = !visible ? 0
    : isGiant ? (type === 'iceGiant' ? 0.46 : 0.42)
      : clamp(0.14 + smoothstep(0.006, 1.4, hasPressure ? pressure : 0.8) * 0.44, 0.14, 0.58);
  return {
    skyHex: variant.skyHex,
    atmoHex: variant.atmoHex,
    opacity,
    visible,
    chemistry: variant.name,
  };
}
