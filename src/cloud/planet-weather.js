import { createWeatherField } from '../weather-field.js';
import { createWeatherSystem, samplePrecipitation, sampleWeather, sampleWeatherAtlasChannels } from './weather-system.js';
import { sampleCloudColumn } from './cloud-environment.js';
import { sampleWeatherAtlas, decodeSynopticCoverage } from './weather-atlas.js';
import { calibrateProductionCoverage } from './production-coverage.js';
import { TIME_SCALE } from '../astronomy.js';

// Real-time cloud drift relative to the physical wind speed (16 m/s -> ~40 m/s).
const CLOUD_DRIFT_GAIN = 2.5;

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// A compact regional terrain source. Weather gradients use this fixed content
// resolution, never a camera LOD or the synthetic weather-test continents.
function terrainSource(body) {
  const width = (body?.R || 6000000) < 400000 ? 64 : 128;
  const height = width >> 1, data = new Float32Array(width * height * 4);
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
  return { sample, atlas, minSurface, maxSurface };
}

// One native weather model, sampled at absolute hours. GPU forecasts and CPU
// diagnostics reconstruct the same model; arbitrary-time queries must not read
// a forecast committed for another hour. B5 owns actual stellar lighting.
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
  let lowAtlas = null, highAtlas = null,windAtlas=null;
  // Keep bulk advection in physical units; small planets do not inherit a
  // 6,000 km planet's linear cloud speed. weatherSpeed is an explicit time gain.
  // The celestial clock runs TIME_SCALE times real time. Wind carried at
  // that rate crossed the sky at kilometres per second: no ship could keep
  // up with a cloud and nothing could be watched forming. The deck drifts
  // at a real-time speed instead, a little faster than the physical wind so
  // the motion still reads from the ground.
  const angularSpeed = profile.windSpeed * CLOUD_DRIFT_GAIN * 3600 / body.R / TIME_SCALE;
  system.advectionRadiansPerHour = angularSpeed;
  // System attaches the read-only ephemeris after constructing the body.
  // Every absolute-time query then uses actual stars in that body's frame.
  system.lightDirectionsAt=hours=>body.stellarDirectionsAt?.(hours);
  let cachedOpticalCalibration;
  // Only physical surface samples define this encoding. Dry bodies use a
  // -1e9 sea-level sentinel; including it made one 8-bit step millions of
  // metres and exploded even tiny distant cloud shells across the screen.
  const surfaceRangeMeters = Math.max(1000, body.hAmp || 0,
    Math.abs(terrain.minSurface), Math.abs(terrain.maxSurface));
  const field = { ...legacy, version: 9, namespace: `${body.seed}:production-synoptic:v6`,
    get opticalCalibration() {
      if (cachedOpticalCalibration === undefined) {
        cachedOpticalCalibration = body.cloudOffsets
          ? calibrateProductionCoverage(system, body.cloudOffsets) : null;
      }
      return cachedOpticalCalibration;
    },
    synoptic: true, windRadiansPerHour: angularSpeed,
    streamDescriptor: { seed: body.seed, terrain: terrain.atlas,
      coverageBias: system.coverageBias, angularSpeed,
      options: { radiusMeters: body.R, targetCoverage: profile.cloudiness,
        temperatureK: profile.temperatureK, polarCoolingK: profile.polarCoolingK,
        windSpeed: profile.windSpeed, weatherSpeed: profile.weatherSpeed, diurnalRangeK: 0 } },
    sampleRaw(direction, hours) { return sampleWeather(system, direction, hours); },
    sampleAtlas(direction, hours) { return sampleWeatherAtlasChannels(system, direction, hours); },
    surfaceRangeMeters, surfaceBoundsMeters: [terrain.minSurface, terrain.maxSurface],
    surfaceAt(direction) {
      // Re-baking the 128-wide terrain into a 256-wide weather image smooths
      // its knots a second time. Heights and clipping must use the original
      // regional source, including narrow peaks and coastal minima.
      return terrain.sample(direction).elevationMeters;
    },
    bindAtlases(low, high) { lowAtlas = low; highAtlas = high; },
    bindWind(atlas) {windAtlas=atlas;},
    sample(direction, hours) {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(hours)) {
        throw new RangeError('Synoptic weather needs a finite direction and absolute hours');
      }
      const d = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
      const spin = hours * angularSpeed;
      let raw = null, morphology = null;
      const structure = () => (raw ||= sampleWeather(system, d, hours));
      let coverage, cloudType, stratusMask, humidity, highMask, cloudBaseMeters;
      const atlasCurrent=lowAtlas && (!Number.isFinite(lowAtlas.hours)
        || Math.abs(lowAtlas.hours-hours)<=1/300+1e-9);
      if (atlasCurrent) {
        const low = sampleWeatherAtlas(lowAtlas, d, spin);
        const high = sampleWeatherAtlas(highAtlas, d, spin);
        [coverage, cloudType, stratusMask, humidity] = low;
        coverage = decodeSynopticCoverage(coverage);
        highMask = decodeSynopticCoverage(high[0], 0.14); cloudBaseMeters = 350 + high[3] * 3850;
      } else {
        raw = structure();
        coverage = raw.lowMask; cloudType = raw.convective;
        stratusMask = raw.stability * (1 - raw.convective);
        humidity = raw.humidity; highMask = raw.highMask;
        cloudBaseMeters = raw.lclMeters;
      }
      const convective = cloudType;
      const temperatureK = atlasCurrent ? profile.temperatureK - d.y*d.y*profile.polarCoolingK
        - field.surfaceAt(d)*.0065 : structure().temperatureK;
      const windCurrent=windAtlas && Math.abs(windAtlas.hours-hours)<=1/300+1e-9;
      const nativeWind=windCurrent ? sampleWeatherAtlas(windAtlas,d,spin) : null;
      const native=atlasCurrent?null:structure();
      const precipitation = nativeWind ? nativeWind[3]
        : (native ? samplePrecipitation(native)
          : (coverage > 0.55 && humidity > 0.64 ? samplePrecipitation(structure()) : 0));
      const precipitationKind = precipitation > 0.02 ? (temperatureK < 273.15 ? 'snow' : 'rain') : 'none';
      const gust = (0.1 + convective * 0.7) * (0.75 + 0.25 * Math.sin(hours * 0.83 + d.x * 5.7));
      const fog = smooth(0.65, 0.97, humidity) * profile.fogginess * coverage;
      const visibility = clamp(1 - precipitation * 0.5 - fog * 0.66, 0.04, 1);
      const speed = profile.windSpeed * (0.8 + convective * 0.8 + gust * 0.3);
      const tangentLength = Math.hypot(d.x, d.z);
      let wind = tangentLength > 1e-9
        ? { x: d.z / tangentLength * speed, y: 0, z: -d.x / tangentLength * speed, speed }
        : { x: 0, y: 0, z: 0, speed: 0 };
      if(nativeWind) {
        const normalPart=nativeWind[0]*d.x+nativeWind[1]*d.y+nativeWind[2]*d.z;
        const vector=nativeWind.slice(0,3).map((v,i)=>v-normalPart*[d.x,d.y,d.z][i]);
        wind={x:vector[0],y:vector[1],z:vector[2],speed:Math.hypot(...vector)};
      } else if(native) wind={x:native.windVector.x*native.windSpeedMs,
        y:native.windVector.y*native.windSpeedMs,z:native.windVector.z*native.windSpeedMs,speed:native.windSpeedMs};
      const kind = precipitation > 0.6 && convective > 0.5 ? 'storm'
        : precipitationKind === 'snow' ? 'snow' : precipitation > 0.1 ? 'rain'
          : coverage < 0.08 ? 'clear' : stratusMask > 0.5 ? 'stratus' : 'cumulus';
      return { hours, direction: d, coverage, cloudType, stratusMask, humidity,
        highMask, highType: 0.7, multipleScatter: 0, convective, cloudBaseMeters,
        temperatureK, precipitation, precipitationKind, gust, fog, visibility, wind, kind,
        fixture: null, lo: [coverage, cloudType, stratusMask, 0], hi: [highMask, 0.7, 0, 0],
        get native() { return structure(); },
        get potentials() { const w = structure(); return { low: w.lowPotential, mid: w.midPotential, high: w.highPotential }; },
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
