import { createWeatherField } from '../weather-field.js';
import { createWeatherSystem, sampleWeather } from './weather-system.js';
import { sampleCloudColumn } from './cloud-environment.js';
import { sampleWeatherAtlas } from './weather-atlas.js';

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const rotate = (d, a) => ({ x: Math.cos(a) * d.x + Math.sin(a) * d.z,
  y: d.y, z: -Math.sin(a) * d.x + Math.cos(a) * d.z });

// A compact regional terrain source. Weather gradients use this fixed content
// resolution, never a camera LOD or the synthetic weather-test continents.
function terrainSource(body) {
  const width = 128, height = 64, data = new Float32Array(width * height * 4);
  let minSurface = Infinity, maxSurface = -Infinity;
  for (let y = 0; y < height; y++) {
    const latitude = ((y + 0.5) / height - 0.5) * Math.PI;
    for (let x = 0; x < width; x++) {
      const longitude = (x + 0.5) / width * Math.PI * 2;
      const direction = { x: Math.cos(latitude) * Math.cos(longitude), y: Math.sin(latitude),
        z: Math.cos(latitude) * Math.sin(longitude) };
      const column = sampleCloudColumn(body, direction);
      minSurface = Math.min(minSurface, column.surfaceAltitudeMeters);
      maxSurface = Math.max(maxSurface, column.surfaceAltitudeMeters);
      const offset = (y * width + x) * 4;
      data[offset] = column.surfaceAltitudeMeters;
      data[offset + 1] = clamp(Math.max(0, column.terrainAltitudeMeters) / Math.max(body.hAmp, 1));
      data[offset + 2] = column.surfaceIsLiquid ? 1 : 0;
    }
  }
  const atlas = { width, height, data, scale: 1 };
  const sample = (direction) => {
    const [elevationMeters, elevation01, oceanic] = sampleWeatherAtlas(atlas, direction);
    return { elevationMeters, elevation01, oceanic };
  };
  return { sample, minSurface, maxSurface };
}

// First production migration: one seeded synoptic snapshot, coherently advected
// by absolute hours. Storm growth/decay is intentionally not claimed here.
// The climate snapshot has no fake rotating sun; B5 owns actual stellar light.
export function createPlanetWeatherField(body, options = {}) {
  const legacy = createWeatherField(body.seed, options);
  if (legacy.fixture) return legacy; // Explicit diagnostic presets remain available.
  const profile = legacy.profile;
  const terrain = terrainSource(body);
  const system = createWeatherSystem(body.seed, {
    radiusMeters: body.R, terrain: terrain.sample, targetCoverage: profile.cloudiness,
    temperatureK: profile.temperatureK, polarCoolingK: profile.polarCoolingK,
    windSpeed: profile.windSpeed, weatherSpeed: profile.weatherSpeed,
    diurnalRangeK: 0, calibrationSamples: 1024,
  });
  let lowAtlas = null, highAtlas = null;
  // Keep bulk advection in physical units; small planets do not inherit a
  // 6,000 km planet's linear cloud speed. weatherSpeed is an explicit time gain.
  const angularSpeed = profile.windSpeed * 3600 / body.R * profile.weatherSpeed;
  // Only physical surface samples define this encoding. Dry bodies use a
  // -1e9 sea-level sentinel; including it made one 8-bit step millions of
  // metres and exploded even tiny distant cloud shells across the screen.
  const surfaceRangeMeters = Math.max(1000, body.hAmp || 0,
    Math.abs(terrain.minSurface), Math.abs(terrain.maxSurface));
  const field = { ...legacy, version: 5, namespace: `${body.seed}:production-synoptic:v2`,
    synoptic: true, windRadiansPerHour: angularSpeed,
    surfaceRangeMeters, surfaceBoundsMeters: [terrain.minSurface, terrain.maxSurface],
    surfaceAt(direction) {
      return highAtlas
        ? (sampleWeatherAtlas(highAtlas, direction)[1] * 2 - 1) * surfaceRangeMeters
        : terrain.sample(direction).elevationMeters;
    },
    bindAtlases(low, high) { lowAtlas = low; highAtlas = high; },
    sample(direction, hours) {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(hours)) {
        throw new RangeError('Synoptic weather needs a finite direction and absolute hours');
      }
      const d = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
      const spin = hours * angularSpeed;
      let raw = null, morphology = null;
      const structure = () => (raw ||= sampleWeather(system, rotate(d, -spin), 0));
      let coverage, cloudType, stratusMask, humidity, highMask, cloudBaseMeters;
      if (lowAtlas) {
        const low = sampleWeatherAtlas(lowAtlas, d, spin);
        const high = sampleWeatherAtlas(highAtlas, d, spin);
        [coverage, cloudType, stratusMask, humidity] = low;
        highMask = high[0]; cloudBaseMeters = 350 + high[3] * 3850;
      } else {
        raw = structure();
        coverage = raw.lowMask; cloudType = raw.convective;
        stratusMask = raw.stability * (1 - raw.convective);
        humidity = raw.humidity; highMask = raw.highMask;
        cloudBaseMeters = raw.lclMeters;
      }
      const convective = cloudType;
      const temperatureK = profile.temperatureK - d.y * d.y * profile.polarCoolingK;
      const precipitation = smooth(0.48, 0.9, coverage * humidity * (0.72 + convective * 0.58));
      const precipitationKind = precipitation > 0.02 ? (temperatureK < 273.15 ? 'snow' : 'rain') : 'none';
      const gust = (0.1 + convective * 0.7) * (0.75 + 0.25 * Math.sin(hours * 0.83 + d.x * 5.7));
      const fog = smooth(0.65, 0.97, humidity) * profile.fogginess * coverage;
      const visibility = clamp(1 - precipitation * 0.5 - fog * 0.66, 0.04, 1);
      const speed = profile.windSpeed * (0.8 + convective * 0.8 + gust * 0.3);
      const tangentLength = Math.hypot(d.x, d.z);
      const wind = tangentLength > 1e-9
        ? { x: d.z / tangentLength * speed, y: 0, z: -d.x / tangentLength * speed, speed }
        : { x: 0, y: 0, z: 0, speed: 0 };
      const kind = precipitation > 0.6 && convective > 0.5 ? 'storm'
        : precipitationKind === 'snow' ? 'snow' : precipitation > 0.1 ? 'rain'
          : coverage < 0.08 ? 'clear' : stratusMask > 0.5 ? 'stratus' : 'cumulus';
      return { hours, direction: d, coverage, cloudType, stratusMask, humidity,
        highMask, highType: 0.7, multipleScatter: 0, convective, cloudBaseMeters,
        temperatureK, precipitation, precipitationKind, gust, fog, visibility, wind, kind,
        fixture: null, lo: [coverage, cloudType, stratusMask, 0], hi: [highMask, 0.7, 0, 0],
        // Structural diagnostics/fingerprints may request the original model.
        // Gameplay queries only need the small shared atlases and must not pay
        // for six terrain/noise evaluations per water or wind sample.
        get morphology() {
          if (morphology) return morphology;
          const value = structure();
          morphology = { cycloneEye: value.cycloneField.eye, eyewall: value.cycloneField.eyewall,
            spiral: value.cycloneField.spiral, front: value.frontProximity,
            coldFront: value.coldFront, warmFront: value.warmFront,
            anvil: value.speciesWeights.anvil || 0, marineCell: value.oceanic * stratusMask, cloudStreet: 0 };
          return morphology;
        } };
    },
  };
  return field;
}
