import { makeRng } from './rng.js';
import { Simplex, clamp, smoothstep, lerp } from './noise.js';
import { createOceanTidalEvent } from './ocean-tidal-event.js';

// Place optional events AFTER terrain initialization. This stream never draws
// from terrain/climate RNGs, and never changes the ocean's composition/height.
export function placeOceanTidalEvent(event, { seed, radius, gravity, depthAt }) {
  if (!event) return null;
  const random = makeRng(`${seed}:ocean-tidal-sites:v1`);
  const minimumDepth = event.height / 0.62 + Math.max(100, event.height * 0.25);
  let best = null;
  for (let candidate = 0; candidate <= 48; candidate++) {
    const y = candidate === 0 ? event.normal[1] : random() * 2 - 1;
    const angle = candidate === 0 ? 0 : random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const normal = candidate === 0 ? [...event.normal] : [r * Math.cos(angle), y, r * Math.sin(angle)];
    const centerDepth = depthAt({ x: normal[0], y: normal[1], z: normal[2] });
    if (!(centerDepth >= minimumDepth)) continue;
    const field = createOceanTidalEvent({ ...event, normal }, { radius, gravity });
    // High-energy travel corridor around phases 0.3..0.7. Outer finite tails
    // may encounter coast and shoal; those are intentionally not terraformed.
    const along = field.period * field.speed * 0.2 + field.width * 2;
    const lateral = field.lateralWidth * 1.5;
    let minimum = Infinity, deep = 0, dry = 0, count = 0;
    for (let iy = -3; iy <= 3; iy++) for (let ix = -4; ix <= 4; ix++) {
      const a = along * ix / 4, b = lateral * iy / 3;
      const radialSquared = radius * radius - a * a - b * b;
      if (radialSquared <= 0) { dry++; count++; continue; }
      const radial = Math.sqrt(radialSquared);
      const point = field.up.map((v, i) => (v * radial + field.axis[i] * a + field.side[i] * b) / radius);
      const depth = depthAt({ x: point[0], y: point[1], z: point[2] });
      count++; minimum = Math.min(minimum, depth);
      if (!(depth > 0)) dry++;
      if (depth >= minimumDepth) deep++;
    }
    if (dry || deep / count < 0.85) continue;
    const placement = { version: 1, candidate, centerDepth, minimumDepth,
      sampledMinimumDepth: minimum, deepFraction: deep / count, samples: count };
    const score = minimum + centerDepth * 0.1;
    if (!best || score > best.score) best = { score, event: { ...event, normal, placement } };
    // Preserve authored/original sites when their whole sampled energetic
    // corridor is already deep. This keeps compatible good destinations fixed.
    if (candidate === 0 && deep === count) return best.event;
  }
  return best?.event || null;
}

// Ocean identity is independent of the terrain RNG stream and of the camera.
// Values describe optical composition and wave climate, not renderer presets.
const COMPOSITIONS = {
  'temperate-blue': { absorption: [0.16, 0.034, 0.016], scatter: [0.004, 0.024, 0.070], life: 0.35 },
  'jade-shelf': { absorption: [0.23, 0.025, 0.065], scatter: [0.004, 0.034, 0.066], life: 0.65 },
  'mineral-violet': { absorption: [0.042, 0.19, 0.026], scatter: [0.046, 0.013, 0.082], life: 0.1 },
  'copper-brine': { absorption: [0.025, 0.070, 0.22], scatter: [0.078, 0.034, 0.009], life: 0.04 },
  'bioluminescent': { absorption: [0.18, 0.034, 0.021], scatter: [0.005, 0.042, 0.074], life: 1 },
};

// Sea-state archetypes give ocean worlds genuinely distinct surface dynamics,
// foam morphology, subsurface translucency, and underwater optical character
// while preserving the underlying deterministic composition & wave height API.
export const OCEAN_ARCHETYPES = {
  'tropical-lagoon': {
    label: '热带珊瑚浅海',
    sssColor: [0.04, 0.78, 0.72],
    sssStrength: 1.48,
    langmuirStrength: 0.08,
    whitecapStrength: 0.58,
    whitecapThreshold: 0.62,
    glitterSharpness: 1.38,
    fresnelContrast: 1.12,
    capillaryAmp: 0.84,
    swellSteepness: 0.96,
    underwaterFogDensity: 0.0105,
    underwaterClarity: 1.45,
    causticIntensity: 1.48,
    underwaterScatter: [0.045, 0.42, 0.56],
    underwaterAbyss: [0.007, 0.048, 0.115],
    biolumColor: [0.05, 0.86, 0.78],
  },
  'temperate-swell': {
    label: '温带深蓝涌浪',
    sssColor: [0.03, 0.52, 0.56],
    sssStrength: 1.24,
    langmuirStrength: 0.36,
    whitecapStrength: 1.08,
    whitecapThreshold: 0.48,
    glitterSharpness: 1.16,
    fresnelContrast: 1.20,
    capillaryAmp: 1.08,
    swellSteepness: 1.20,
    underwaterFogDensity: 0.016,
    underwaterClarity: 1.08,
    causticIntensity: 1.18,
    underwaterScatter: [0.022, 0.24, 0.44],
    underwaterAbyss: [0.004, 0.022, 0.074],
    biolumColor: [0.04, 0.76, 0.66],
  },
  'pelagic-storm': {
    label: '狂涛巨浪',
    sssColor: [0.05, 0.38, 0.46],
    sssStrength: 1.36,
    langmuirStrength: 1.32,
    whitecapStrength: 1.68,
    whitecapThreshold: 0.32,
    glitterSharpness: 0.84,
    fresnelContrast: 1.34,
    capillaryAmp: 1.44,
    swellSteepness: 1.56,
    underwaterFogDensity: 0.026,
    underwaterClarity: 0.70,
    causticIntensity: 0.72,
    underwaterScatter: [0.022, 0.145, 0.225],
    underwaterAbyss: [0.004, 0.015, 0.038],
    biolumColor: [0.06, 0.72, 0.86],
  },
  'polar-glacial': {
    label: '极地冰渊',
    sssColor: [0.10, 0.60, 0.80],
    sssStrength: 1.30,
    langmuirStrength: 0.50,
    whitecapStrength: 1.18,
    whitecapThreshold: 0.44,
    glitterSharpness: 1.44,
    fresnelContrast: 1.28,
    capillaryAmp: 1.18,
    swellSteepness: 1.14,
    underwaterFogDensity: 0.014,
    underwaterClarity: 1.24,
    causticIntensity: 1.14,
    underwaterScatter: [0.038, 0.28, 0.54],
    underwaterAbyss: [0.005, 0.028, 0.092],
    biolumColor: [0.12, 0.82, 1.0],
  },
  'abyssal-biolum': {
    label: '幽渊荧光海',
    sssColor: [0.03, 0.70, 0.60],
    sssStrength: 1.38,
    langmuirStrength: 0.64,
    whitecapStrength: 1.20,
    whitecapThreshold: 0.43,
    glitterSharpness: 1.16,
    fresnelContrast: 1.24,
    capillaryAmp: 1.06,
    swellSteepness: 1.24,
    underwaterFogDensity: 0.018,
    underwaterClarity: 1.04,
    causticIntensity: 1.06,
    underwaterScatter: [0.016, 0.23, 0.37],
    underwaterAbyss: [0.004, 0.030, 0.072],
    biolumColor: [0.04, 0.94, 0.80],
  },
  'mineral-exotic': {
    label: '异星紫晶海',
    sssColor: [0.46, 0.16, 0.68],
    sssStrength: 1.36,
    langmuirStrength: 0.48,
    whitecapStrength: 0.98,
    whitecapThreshold: 0.48,
    glitterSharpness: 1.26,
    fresnelContrast: 1.24,
    capillaryAmp: 1.04,
    swellSteepness: 1.18,
    underwaterFogDensity: 0.019,
    underwaterClarity: 0.96,
    causticIntensity: 0.98,
    underwaterScatter: [0.16, 0.075, 0.35],
    underwaterAbyss: [0.025, 0.011, 0.078],
    biolumColor: [0.62, 0.28, 1.0],
  },
  'acid-brine': {
    label: '硫磺酸海',
    sssColor: [0.70, 0.46, 0.06],
    sssStrength: 1.24,
    langmuirStrength: 0.56,
    whitecapStrength: 0.86,
    whitecapThreshold: 0.50,
    glitterSharpness: 0.80,
    fresnelContrast: 1.08,
    capillaryAmp: 0.80,
    swellSteepness: 0.88,
    underwaterFogDensity: 0.040,
    underwaterClarity: 0.46,
    causticIntensity: 0.52,
    underwaterScatter: [0.27, 0.21, 0.05],
    underwaterAbyss: [0.055, 0.038, 0.008],
    biolumColor: [0.84, 0.94, 0.16],
  },
};

// Independent RNG namespace so archetype personality never shifts existing
// terrain or composition streams.
export function resolveOceanArchetype(seed, {
  type = 'lush', composition = 'temperate-blue', oceanClass = null, equilibriumK = null,
} = {}) {
  const rng = makeRng(`${seed}:ocean-archetype:v2`);
  const roll = rng();
  let archetype = 'temperate-swell';
  if (oceanClass === 'pelagic-storm') {
    archetype = 'pelagic-storm';
  } else if (oceanClass && OCEAN_ARCHETYPES[oceanClass]) {
    archetype = oceanClass;
  } else if (composition === 'copper-brine' || (type === 'toxic' && composition !== 'mineral-violet')) {
    archetype = 'acid-brine';
  } else if (composition === 'bioluminescent') {
    archetype = 'abyssal-biolum';
  } else if (composition === 'mineral-violet') {
    archetype = 'mineral-exotic';
  } else if (Number.isFinite(equilibriumK) && equilibriumK < 252) {
    archetype = 'polar-glacial';
  } else if (type === 'ocean') {
    const oceanPool = ['pelagic-storm', 'tropical-lagoon', 'temperate-swell', 'polar-glacial', 'abyssal-biolum'];
    archetype = oceanPool[Math.min(oceanPool.length - 1, Math.floor(roll * oceanPool.length))];
  } else if (composition === 'jade-shelf') {
    archetype = roll < 0.72 ? 'tropical-lagoon' : 'temperate-swell';
  } else {
    archetype = roll < 0.28 ? 'tropical-lagoon' : roll < 0.82 ? 'temperate-swell' : 'polar-glacial';
  }
  const base = OCEAN_ARCHETYPES[archetype] || OCEAN_ARCHETYPES['temperate-swell'];
  // Gentle per-world variation inside each archetype so no two worlds match identically.
  const jitter = (v, spread = 0.12) => v * lerp(1 - spread, 1 + spread, rng());
  return {
    archetype,
    seaState: {
      ...base,
      sssStrength: jitter(base.sssStrength, 0.1),
      langmuirStrength: clamp(jitter(base.langmuirStrength, 0.14), 0, 1.6),
      whitecapStrength: jitter(base.whitecapStrength, 0.12),
      glitterSharpness: jitter(base.glitterSharpness, 0.1),
      capillaryAmp: jitter(base.capillaryAmp, 0.1),
      swellSteepness: jitter(base.swellSteepness, 0.08),
      underwaterFogDensity: jitter(base.underwaterFogDensity, 0.1),
      causticIntensity: jitter(base.causticIntensity, 0.1),
    },
  };
}

export function createOceanClimate(seed, {
  type = 'lush', gravity = 9.81, oceanClass = null, equilibriumK = null,
} = {}) {
  const rng = makeRng(`${seed}:ocean-climate:v1`);
  const choice = rng();
  const composition = type === 'lush'
    ? (choice < 0.18 ? 'jade-shelf' : 'temperate-blue')
    : type === 'toxic' ? (choice < 0.5 ? 'copper-brine' : 'mineral-violet')
    : Object.keys(COMPOSITIONS)[Math.min(4, Math.floor(choice * 5))];
  const optics = COMPOSITIONS[composition];
  const giant = oceanClass === 'tidal-giant' || (type === 'ocean' && rng() < 0.09);
  const azimuth = rng() * Math.PI * 2;
  const y = rng() * 1.6 - 0.8;
  const radial = Math.sqrt(1 - y * y);
  const absorption = optics.absorption.map((value) => value * lerp(0.85, 1.15, rng()));
  const windScale = oceanClass === 'pelagic-storm' ? 1.5 : lerp(0.65, 1.25, rng());
  const swellPeriod = lerp(6, 16, rng());
  const event = giant ? {
    kind: 'tidal-giant',
    normal: [radial * Math.cos(azimuth), y, radial * Math.sin(azimuth)],
    height: lerp(160, 380, rng()),
    period: lerp(240, 540, rng()),
    epoch: rng() * 86400,
  } : null;
  const { archetype, seaState } = resolveOceanArchetype(seed, {
    type, composition, oceanClass, equilibriumK,
  });
  return {
    version: 1,
    seed: `${seed}:ocean-climate:v1`,
    composition,
    archetype,
    seaState,
    gravity: Math.max(0.1, gravity),
    absorption,
    scatter: [...optics.scatter],
    biologicalActivity: archetype === 'abyssal-biolum' ? Math.max(optics.life, 0.92) : optics.life,
    windScale,
    swellPeriod,
    event,
    field: new Simplex(makeRng(`${seed}:ocean-regions:v1`)),
  };
}

export function sampleOceanClimate(climate, direction, {
  seconds = 0, waveSeconds = seconds, depth = 1000, weather = null,
} = {}) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('Ocean direction must be finite and nonzero');
  const x = direction.x / length, y = direction.y / length, z = direction.z / length;
  const field = climate.field;
  const basin = field.noise(x * 4.3, y * 4.3, z * 4.3) * 0.5 + 0.5;
  const coastal = 1 - smoothstep(12, 180, Math.max(0, depth));
  const nutrients = clamp((field.noise(x * 11 + 7, y * 11, z * 11) * 0.5 + 0.5)
    * (0.35 + coastal * 0.65) * climate.biologicalActivity, 0, 1);
  const sheltered = coastal * smoothstep(0.28, 0.72, basin);
  const synoptic = field.noise(x * 6 + seconds / 72000, y * 6, z * 6) * 0.5 + 0.5;
  const measuredWind = weather?.wind?.speed;
  const wind = (Number.isFinite(measuredWind) ? measuredWind : lerp(3, 23, synoptic))
    * climate.windScale;
  const openFetch = lerp(0.16, 1, basin);
  const fetch = openFetch * (1 - sheltered * 0.86);
  const windHeight = 0.016 * wind * wind * Math.sqrt(fetch);
  const swellHeight = lerp(0.25, 2.4, basin) * (1 - sheltered * 0.88);
  const shelteredHeight = Math.hypot(windHeight, swellHeight);
  const offshoreHeight = Math.hypot(0.016 * wind * wind * Math.sqrt(openFetch),
    lerp(0.25, 2.4, basin));
  const significantHeight = Math.min(shelteredHeight, Math.max(0, depth) * 0.62);
  const period = climate.swellPeriod * lerp(0.8, 1.2, basin);
  const breaking = smoothstep(0.38, 0.62, shelteredHeight / Math.max(depth, 0.1));
  return {
    composition: climate.composition,
    archetype: climate.archetype || 'temperate-swell',
    seaState: climate.seaState || OCEAN_ARCHETYPES['temperate-swell'],
    // Regional incident sea before the local depth limit. Renderers spanning
    // offshore and shallow water must apply the limit at each surface sample,
    // not propagate the observer's wading depth across the whole ocean patch.
    offshoreSignificantHeight: offshoreHeight,
    significantHeight,
    period,
    wavelength: climate.gravity * period * period / (2 * Math.PI),
    windSpeed: wind,
    fetch,
    sheltered,
    breaking,
    nutrients,
    absorption: climate.absorption.map((value, channel) => value
      + nutrients * [0.10, 0.025, 0.075][channel] + coastal * 0.007),
    scatter: climate.scatter.map((value, channel) => value
      + nutrients * [0.006, 0.035, 0.012][channel]),
    bioluminescence: (climate.composition === 'bioluminescent' || climate.archetype === 'abyssal-biolum')
      // Potential luminous population; the renderer applies the actual local
      // agitation once. Multiplying by coastal breaking here suppressed deep
      // ocean glow a second time despite energetic offshore crests.
      ? Math.max(nutrients, climate.archetype === 'abyssal-biolum' ? 0.35 : 0) : 0,
    eventPhase: climate.event
      ? ((waveSeconds - climate.event.epoch) / climate.event.period % 1 + 1) % 1 : null,
  };
}

// Canonical ocean visual palette shared by Planet seabed/liquidColor AND
// sysview.js star-map previews so star map, portal mouth, shallow bays, and
// live water surface always agree on the world's true ocean color.
const OCEAN_VISUAL_PALETTES = {
  'copper-brine': {
    seaHex: ['#2e1a06', '#5c380e', '#8e5f1e', '#c2923c'],
    liquidHex: '#7d5015',
    sysDeep: [86, 54, 22],
    sysMid: [138, 94, 38],
    sysShallow: [192, 148, 72],
    biolumGlow: null,
  },
  'mineral-violet': {
    seaHex: ['#180b2d', '#34195b', '#572f8b', '#865eb6'],
    liquidHex: '#432270',
    sysDeep: [42, 20, 74],
    sysMid: [76, 40, 122],
    sysShallow: [126, 88, 168],
    biolumGlow: null,
  },
  'jade-shelf': {
    seaHex: ['#051a28', '#0a3d4c', '#146f70', '#41ae93'],
    liquidHex: '#12686c',
    sysDeep: [12, 42, 62],
    sysMid: [22, 92, 106],
    sysShallow: [64, 162, 146],
    biolumGlow: null,
  },
  'bioluminescent': {
    seaHex: ['#04192a', '#0a3a52', '#126b7c', '#32b0aa'],
    liquidHex: '#0e6072',
    sysDeep: [8, 36, 58],
    sysMid: [18, 84, 108],
    sysShallow: [48, 168, 164],
    biolumGlow: [18, 195, 172],
  },
  'temperate-blue': {
    seaHex: ['#041124', '#082c52', '#135273', '#3f8f88'],
    liquidHex: '#15527e',
    sysDeep: [14, 38, 76],
    sysMid: [26, 68, 118],
    sysShallow: [58, 134, 152],
    biolumGlow: null,
  },
};

export function oceanVisualPalette(climate) {
  const comp = climate?.composition || 'temperate-blue';
  const base = OCEAN_VISUAL_PALETTES[comp] || OCEAN_VISUAL_PALETTES['temperate-blue'];
  const arch = climate?.archetype;
  if (comp === 'temperate-blue' && arch === 'pelagic-storm') {
    return {
      ...base,
      seaHex: ['#040d1b', '#0a223d', '#143c5c', '#346d7a'],
      liquidHex: '#103b59',
      sysDeep: [10, 26, 52],
      sysMid: [22, 52, 86],
      sysShallow: [50, 98, 118],
    };
  }
  if (comp === 'temperate-blue' && arch === 'polar-glacial') {
    return {
      ...base,
      seaHex: ['#071c33', '#104068', '#227296', '#66b8cc'],
      liquidHex: '#1c6b8e',
      sysDeep: [16, 48, 84],
      sysMid: [34, 88, 132],
      sysShallow: [92, 168, 194],
    };
  }
  if (comp === 'temperate-blue' && arch === 'tropical-lagoon') {
    return {
      ...base,
      seaHex: ['#051d32', '#0b4768', '#188092', '#4cc4b4'],
      liquidHex: '#167688',
      sysDeep: [12, 48, 82],
      sysMid: [24, 102, 126],
      sysShallow: [72, 182, 174],
    };
  }
  return base;
}
