// Deterministic planetary weather authority.
//
// Weather is sampled from a body seed, a unit-sphere direction and absolute
// celestial hours. It never integrates per-frame deltas, so reloads, time warp and
// peers reconstruct the same state without persisting renderer data.

import { makeRng, strHash32 } from './rng.js';
import { Simplex } from './noise.js';

export const WEATHER_FIELD_VERSION = 1;
export const WEATHER_NAMESPACE_SUFFIX = ':weather:v1';

const TAU = Math.PI * 2;
const DEFAULT_PROFILE = Object.freeze({
  cloudiness: 0.56,
  humidity: 0.58,
  storminess: 0.42,
  highClouds: 0.34,
  fogginess: 0.24,
  windSpeed: 16,
  temperatureK: 286,
  polarCoolingK: 44,
  weatherSpeed: 1,
});

const FIXTURE_PRESETS = Object.freeze({
  clear: Object.freeze({
    coverage: 0.05, cloudType: 0.08, stratusMask: 0, highMask: 0.06,
    highType: 0.2, multipleScatter: 0.12, humidity: 0.24,
    precipitation: 0, convective: 0.04, visibility: 1, fog: 0,
    gust: 0.08, windSpeed: 4, precipitationKind: 'none',
  }),
  cumulus: Object.freeze({
    coverage: 0.62, cloudType: 0.16, stratusMask: 0.08, highMask: 0.18,
    highType: 0.72, multipleScatter: 0.46, humidity: 0.64,
    precipitation: 0.015, convective: 0.34, visibility: 0.94, fog: 0.05,
    gust: 0.28, windSpeed: 12, precipitationKind: 'rain',
  }),
  stratus: Object.freeze({
    coverage: 0.84, cloudType: 0.2, stratusMask: 0.92, highMask: 0.32,
    highType: 0.08, multipleScatter: 0.66, humidity: 0.86,
    precipitation: 0.34, convective: 0.12, visibility: 0.56, fog: 0.38,
    gust: 0.2, windSpeed: 10, precipitationKind: 'rain',
  }),
  storm: Object.freeze({
    coverage: 0.97, cloudType: 0.96, stratusMask: 0.28, highMask: 0.7,
    highType: 0.76, multipleScatter: 0.93, humidity: 0.96,
    precipitation: 0.94, convective: 0.98, visibility: 0.24, fog: 0.66,
    gust: 0.92, windSpeed: 34, precipitationKind: 'rain',
  }),
  snow: Object.freeze({
    coverage: 0.91, cloudType: 0.58, stratusMask: 0.74, highMask: 0.5,
    highType: 0.3, multipleScatter: 0.82, humidity: 0.9,
    precipitation: 0.82, convective: 0.44, visibility: 0.32, fog: 0.58,
    gust: 0.56, windSpeed: 18, precipitationKind: 'snow', temperatureK: 264,
  }),
  fog: Object.freeze({
    coverage: 0.38, cloudType: 0.08, stratusMask: 0.72, highMask: 0.08,
    highType: 0, multipleScatter: 0.54, humidity: 0.98,
    precipitation: 0.04, convective: 0.02, visibility: 0.1, fog: 0.96,
    gust: 0.06, windSpeed: 2, precipitationKind: 'none',
  }),
});

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function smoothstep(low, high, value) {
  const t = clamp((value - low) / Math.max(high - low, 1e-9));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function finite(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function unitVector(value) {
  const x = finite(Array.isArray(value) ? value[0] : value?.x, 0);
  const y = finite(Array.isArray(value) ? value[1] : value?.y, 1);
  const z = finite(Array.isArray(value) ? value[2] : value?.z, 0);
  const inverseLength = 1 / Math.max(Math.hypot(x, y, z), 1e-12);
  return { x: x * inverseLength, y: y * inverseLength, z: z * inverseLength };
}

function randomUnit(rand) {
  const y = rand() * 2 - 1;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = rand() * TAU;
  return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(value) {
  const inverseLength = 1 / Math.max(Math.hypot(value.x, value.y, value.z), 1e-12);
  return {
    x: value.x * inverseLength,
    y: value.y * inverseLength,
    z: value.z * inverseLength,
  };
}

function rotateAroundAxis(value, axis, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const projection = dot(axis, value) * (1 - cosine);
  const perpendicular = cross(axis, value);
  return {
    x: value.x * cosine + perpendicular.x * sine + axis.x * projection,
    y: value.y * cosine + perpendicular.y * sine + axis.y * projection,
    z: value.z * cosine + perpendicular.z * sine + axis.z * projection,
  };
}

function tangentVector(direction, preferredAxis) {
  let tangent = cross(preferredAxis, direction);
  if (dot(tangent, tangent) < 1e-8) {
    tangent = cross(Math.abs(direction.y) < 0.9
      ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }, direction);
  }
  return normalize(tangent);
}

function fractal(simplex, direction, frequency, octaves, lacunarity = 2.03, gain = 0.52) {
  let value = 0;
  let amplitude = 1;
  let normalization = 0;
  let scale = frequency;
  for (let octave = 0; octave < octaves; octave++) {
    value += simplex.noise(
      direction.x * scale,
      direction.y * scale,
      direction.z * scale,
    ) * amplitude;
    normalization += amplitude;
    amplitude *= gain;
    scale *= lacunarity;
  }
  return value / Math.max(normalization, 1e-9);
}

function profileFrom(options = {}) {
  const source = options.profile || options;
  return Object.freeze({
    cloudiness: clamp(finite(source.cloudiness, DEFAULT_PROFILE.cloudiness)),
    humidity: clamp(finite(source.humidity, DEFAULT_PROFILE.humidity)),
    storminess: clamp(finite(source.storminess, DEFAULT_PROFILE.storminess)),
    highClouds: clamp(finite(source.highClouds, DEFAULT_PROFILE.highClouds)),
    fogginess: clamp(finite(source.fogginess, DEFAULT_PROFILE.fogginess)),
    windSpeed: clamp(finite(source.windSpeed, DEFAULT_PROFILE.windSpeed), 0, 120),
    temperatureK: clamp(finite(source.temperatureK, DEFAULT_PROFILE.temperatureK), 80, 900),
    polarCoolingK: clamp(finite(source.polarCoolingK, DEFAULT_PROFILE.polarCoolingK), 0, 180),
    weatherSpeed: clamp(finite(source.weatherSpeed, DEFAULT_PROFILE.weatherSpeed), 0, 8),
  });
}

function freezeFixture(value) {
  return value ? Object.freeze({ ...value }) : null;
}

export function createWeatherFixture(name, overrides = {}) {
  const preset = FIXTURE_PRESETS[name];
  if (!preset) {
    throw new RangeError(`Unknown weather fixture "${name}". Expected ${Object.keys(FIXTURE_PRESETS).join(', ')}.`);
  }
  return freezeFixture({ name, ...preset, ...overrides });
}

export function weatherFixtureNames() {
  return Object.keys(FIXTURE_PRESETS);
}

export function createWeatherField(seed, options = {}) {
  const namespace = `${String(seed)}${WEATHER_NAMESPACE_SUFFIX}`;
  const rand = makeRng(`${namespace}:layout`);
  const profile = profileFrom(options);
  const fixture = typeof options.fixture === 'string'
    ? createWeatherFixture(options.fixture, options.fixtureOverrides)
    : freezeFixture(options.fixture);
  const field = {
    kind: 'weather-field',
    version: WEATHER_FIELD_VERSION,
    namespace,
    seed: String(seed),
    profile,
    fixture,
    // Planet-scale circulation follows the rotation axis. This lets orbit,
    // volume, cloud shadow and CPU surface sampling reconstruct the same
    // advected spherical field with one absolute-time rotation.
    windAxis: { x: 0, y: 1, z: 0 },
    secondaryAxis: randomUnit(rand),
    stormCenterA: randomUnit(rand),
    stormCenterB: randomUnit(rand),
    basePhase: rand() * TAU,
    detailPhase: rand() * TAU,
    gustPhase: rand() * TAU,
    windRadiansPerHour: (0.004 + rand() * 0.009) * profile.weatherSpeed,
    macroNoise: new Simplex(makeRng(`${namespace}:macro`)),
    detailNoise: new Simplex(makeRng(`${namespace}:detail`)),
    humidityNoise: new Simplex(makeRng(`${namespace}:humidity`)),
    highNoise: new Simplex(makeRng(`${namespace}:high`)),
  };
  return Object.freeze(field);
}

function resolveFieldAndHours(fieldOrState, absoluteHours) {
  if (fieldOrState?.kind === 'weather-state') {
    return {
      field: fieldOrState.field,
      hours: Number.isFinite(absoluteHours) ? Number(absoluteHours) : fieldOrState.hours,
    };
  }
  if (fieldOrState?.kind !== 'weather-field') {
    throw new TypeError('Expected a weather field created by createWeatherField().');
  }
  return { field: fieldOrState, hours: finite(absoluteHours, 0) };
}

export function advanceWeatherField(fieldOrState, absoluteHours) {
  const { field } = resolveFieldAndHours(fieldOrState, absoluteHours);
  if (!Number.isFinite(absoluteHours)) {
    throw new TypeError('advanceWeatherField() requires finite absolute celestial hours.');
  }
  return Object.freeze({
    kind: 'weather-state',
    version: WEATHER_FIELD_VERSION,
    field,
    hours: Number(absoluteHours),
  });
}

function stormCell(direction, center, core, edge) {
  return smoothstep(edge, core, dot(direction, center));
}

function classifyWeather(coverage, cloudType, stratusMask, precipitation,
  precipitationKind, convective, fog) {
  if (fog > 0.72 && precipitation < 0.2) return 'fog';
  if (precipitationKind === 'snow' && precipitation > 0.18) return 'snow';
  if (convective > 0.72 && coverage > 0.72) return 'storm';
  if (stratusMask > 0.58 && coverage > 0.58) return 'stratus';
  if (coverage > 0.34 || cloudType > 0.2) return 'cumulus';
  return 'clear';
}

function applyFixture(sample, fixture) {
  if (!fixture) return sample;
  const numericKeys = [
    'coverage', 'cloudType', 'stratusMask', 'highMask', 'highType',
    'multipleScatter', 'humidity', 'precipitation', 'convective',
    'visibility', 'fog', 'gust', 'temperatureK',
  ];
  for (const key of numericKeys) {
    if (Number.isFinite(fixture[key])) sample[key] = Number(fixture[key]);
  }
  if (Number.isFinite(fixture.windSpeed)) {
    const direction = normalize(sample.wind);
    const speed = clamp(Number(fixture.windSpeed), 0, 120);
    sample.wind = {
      x: direction.x * speed,
      y: direction.y * speed,
      z: direction.z * speed,
      speed,
    };
  }
  if (fixture.precipitationKind) sample.precipitationKind = fixture.precipitationKind;
  sample.fixture = fixture.name || 'custom';
  return sample;
}

export function sampleWeatherField(fieldOrState, directionValue, absoluteHours) {
  const { field, hours } = resolveFieldAndHours(fieldOrState, absoluteHours);
  const direction = unitVector(directionValue);
  const profile = field.profile;
  const lowAngle = field.basePhase + hours * field.windRadiansPerHour;
  const highAngle = field.detailPhase + hours * field.windRadiansPerHour * 1.47;
  const lowDirection = rotateAroundAxis(direction, field.windAxis, lowAngle);
  const detailDirection = rotateAroundAxis(direction, field.secondaryAxis, highAngle);

  const macro = fractal(field.macroNoise, lowDirection, 1.35, 4);
  const detail = fractal(field.detailNoise, detailDirection, 4.8, 3, 2.11, 0.48);
  const humidPattern = fractal(field.humidityNoise,
    rotateAroundAxis(direction, field.windAxis, lowAngle * 0.72), 1.9, 3);
  const highPattern = fractal(field.highNoise, detailDirection, 2.5, 3);

  const movingStormA = rotateAroundAxis(field.stormCenterA, field.windAxis, lowAngle * 0.76);
  const movingStormB = rotateAroundAxis(field.stormCenterB, field.secondaryAxis, highAngle * -0.48);
  const stormSystems = Math.max(
    stormCell(direction, movingStormA, 0.986, 0.78),
    stormCell(direction, movingStormB, 0.992, 0.84) * 0.78,
  );

  const latitude = Math.abs(direction.y);
  const oceanicHumidity = profile.humidity
    + humidPattern * 0.2 - Math.max(0, latitude - 0.72) * 0.24;
  const humidity = clamp(oceanicHumidity);
  // Cloudiness is an areal target, not an opacity bias. Center humidity before
  // applying it so a wet planet does not become a featureless white shell.
  const coverageSource = macro * 0.52 + detail * 0.16
    + (profile.cloudiness - 0.45) * 0.82
    + (humidity - 0.5) * 0.22 + stormSystems * 0.42;
  const coverage = smoothstep(0.02, 0.44, coverageSource);
  const stratusSource = humidity * 0.58 + macro * 0.22
    - Math.abs(detail) * 0.18 + profile.fogginess * 0.25;
  const stratusMask = smoothstep(0.46, 0.84, stratusSource) * coverage;
  const convectiveSource = coverage * humidity * (0.54 + profile.storminess * 0.7)
    + stormSystems * 0.72 + Math.max(0, detail) * 0.13 - stratusMask * 0.2;
  const convective = smoothstep(0.42, 1.18, convectiveSource);
  const cloudType = clamp(convective * 0.92 + stormSystems * 0.2);
  const highMask = clamp(smoothstep(-0.08, 0.48, highPattern
    + profile.highClouds * 0.72 + convective * 0.22 - 0.34));
  const highType = clamp(0.5 + detail * 0.38 + convective * 0.28);
  const multipleScatter = clamp(coverage * 0.54 + highMask * 0.22
    + humidity * 0.16 + convective * 0.2);

  const temperatureK = profile.temperatureK - latitude * profile.polarCoolingK
    + humidPattern * 3.5;
  const precipitation = clamp(smoothstep(0.48, 0.9,
    coverage * humidity * (0.72 + convective * 0.58)));
  const precipitationKind = precipitation > 0.02
    ? (temperatureK < 273.15 ? 'snow' : 'rain') : 'none';
  const gustWave = Math.sin(hours * 0.83 + field.gustPhase
    + direction.x * 5.7 - direction.z * 4.1) * 0.5 + 0.5;
  const gust = clamp((0.12 + convective * 0.72 + Math.max(0, detail) * 0.18)
    * mix(0.62, 1, gustWave));
  const fog = clamp(smoothstep(0.6, 0.96, humidity)
    * (0.28 + stratusMask * 0.52 + precipitation * 0.34)
    * (0.45 + profile.fogginess * 0.75));
  const visibility = clamp(1 - precipitation * 0.5 - fog * 0.66
    - convective * precipitation * 0.18, 0.04, 1);

  const prevailing = tangentVector(direction, field.windAxis);
  const crossWind = tangentVector(direction, field.secondaryAxis);
  const windSpeed = profile.windSpeed * (0.55 + humidity * 0.28
    + convective * 0.48 + gust * 0.46);
  const windDirection = normalize({
    x: prevailing.x + crossWind.x * (detail * 0.3),
    y: prevailing.y + crossWind.y * (detail * 0.3),
    z: prevailing.z + crossWind.z * (detail * 0.3),
  });

  const sample = applyFixture({
    hours,
    direction,
    humidity,
    coverage,
    cloudType,
    stratusMask,
    highMask,
    highType,
    multipleScatter,
    precipitation,
    precipitationKind,
    convective,
    visibility,
    fog,
    gust,
    temperatureK,
    wind: {
      x: windDirection.x * windSpeed,
      y: windDirection.y * windSpeed,
      z: windDirection.z * windSpeed,
      speed: windSpeed,
    },
    fixture: null,
  }, field.fixture);

  sample.coverage = clamp(sample.coverage);
  sample.cloudType = clamp(sample.cloudType);
  sample.stratusMask = clamp(sample.stratusMask);
  sample.highMask = clamp(sample.highMask);
  sample.highType = clamp(sample.highType);
  sample.multipleScatter = clamp(sample.multipleScatter);
  sample.humidity = clamp(sample.humidity);
  sample.precipitation = clamp(sample.precipitation);
  sample.convective = clamp(sample.convective);
  sample.visibility = clamp(sample.visibility, 0.04, 1);
  sample.fog = clamp(sample.fog);
  sample.gust = clamp(sample.gust);
  sample.lo = Object.freeze([
    sample.coverage, sample.cloudType, sample.stratusMask, 0,
  ]);
  sample.hi = Object.freeze([
    sample.highMask, sample.highType, 0, sample.multipleScatter,
  ]);
  sample.kind = classifyWeather(
    sample.coverage,
    sample.cloudType,
    sample.stratusMask,
    sample.precipitation,
    sample.precipitationKind,
    sample.convective,
    sample.fog,
  );
  sample.wind = Object.freeze(sample.wind);
  return Object.freeze(sample);
}

function fingerprintMix(hash, value) {
  const quantized = Math.round(finite(value, 0) * 65535);
  hash ^= quantized & 0xff;
  hash = Math.imul(hash, 16777619);
  hash ^= (quantized >>> 8) & 0xff;
  return Math.imul(hash, 16777619) >>> 0;
}

export function weatherFieldFingerprint(fieldOrState, absoluteHours = undefined, samples = 64) {
  const resolved = resolveFieldAndHours(fieldOrState, absoluteHours);
  let hash = strHash32(`${resolved.field.namespace}|${JSON.stringify(resolved.field.profile)}`
    + `|${JSON.stringify(resolved.field.fixture)}|${resolved.hours}`);
  const count = Math.max(8, Math.min(512, Math.round(samples)));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index++) {
    const y = 1 - 2 * (index + 0.5) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * goldenAngle;
    const sample = sampleWeatherField(resolved.field, {
      x: Math.cos(angle) * radius,
      y,
      z: Math.sin(angle) * radius,
    }, resolved.hours);
    for (const value of [
      ...sample.lo, ...sample.hi,
      sample.humidity, sample.precipitation, sample.convective,
      sample.visibility, sample.fog, sample.gust,
      sample.wind.x, sample.wind.y, sample.wind.z,
    ]) hash = fingerprintMix(hash, value);
  }
  return `weather-v${WEATHER_FIELD_VERSION}:${hash.toString(16).padStart(8, '0')}`;
}
