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

export function createOceanClimate(seed, { type = 'lush', gravity = 9.81, oceanClass = null } = {}) {
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
  return {
    version: 1,
    seed: `${seed}:ocean-climate:v1`,
    composition,
    gravity: Math.max(0.1, gravity),
    absorption: optics.absorption.map((value) => value * lerp(0.85, 1.15, rng())),
    scatter: [...optics.scatter],
    biologicalActivity: optics.life,
    windScale: oceanClass === 'pelagic-storm' ? 1.5 : lerp(0.65, 1.25, rng()),
    swellPeriod: lerp(6, 16, rng()),
    event: giant ? {
      kind: 'tidal-giant',
      normal: [radial * Math.cos(azimuth), y, radial * Math.sin(azimuth)],
      height: lerp(160, 380, rng()),
      period: lerp(240, 540, rng()),
      epoch: rng() * 86400,
    } : null,
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
    bioluminescence: climate.composition === 'bioluminescent'
      // Potential luminous population; the renderer applies the actual local
      // agitation once. Multiplying by coastal breaking here suppressed deep
      // ocean glow a second time despite energetic offshore crests.
      ? nutrients : 0,
    eventPhase: climate.event
      ? ((waveSeconds - climate.event.epoch) / climate.event.period % 1 + 1) % 1 : null,
  };
}
