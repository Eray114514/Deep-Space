// Planet-scale weather model. planet-weather.js now bakes a real-terrain
// snapshot into the production atlas; this model's full storm evolution is
// still CPU-only. Passing these CPU tests does not prove rendered C1/C5.
// See docs/cloud-weather-contract.md for the staged consumer/coordinate contract.
// This model uses a body-local +Y pole, absolute celestial hours and a
// 350-4200 m LCL range. Its default terrain is synthetic, not Planet.height.
//
// THE COVERAGE CONTRACT (C5 / D7) — the core of this phase
//   Coverage here is a proxy AREA FRACTION, not measured production opacity.
//   The field is built as a
//   large-scale synoptic POTENTIAL (Hadley/Ferrel structure, meandering storm
//   track, discrete cyclones, discrete subtropical highs, orography) and then
//   THRESHOLDED. Coverage is calibrated by moving that single threshold until
//   the measured occupied area matches the contract. Because the potential is
//   low-frequency, moving the threshold grows and shrinks whole weather systems
//   instead of fading every pixel — which is what produces "some regions clear,
//   some cloudy" rather than a uniform speckle.

import { makeRng, strHash32 } from '../rng.js';
import { Simplex } from '../noise.js';
import {
  CLOUD_LCL_MAX_METERS, CLOUD_LCL_MIN_METERS, CLOUD_SPECIES,
} from './cloud-species.js';

export const WEATHER_SYSTEM_VERSION = 3;

// Coverage is solved to within this absolute area fraction. Tighter than this
// is not meaningful: the measurement itself is a finite equal-area sample.
export const COVERAGE_TOLERANCE = 0.05;

// Regimes partition the planet into large-scale circulation zones. Their
// existence is what makes orbital views read as "有体系" (systematic) rather
// than as noise: a subtropical high is a persistent multi-thousand-kilometre
// clear region, the ITCZ is a persistent cloudy band.
export const WEATHER_REGIMES = Object.freeze([
  'subtropical-high',  // descending, persistently clear — the big clear areas
  'itcz',              // convergence, deep convection — the bright cloudy band
  'frontal',           // mid-latitude baroclinic systems, organized bands
  'cyclone',           // closed circulation with eye/eyewall/spiral structure
  'orographic',        // terrain-forced lift and lee-side drying
  'polar',             // cold, stable, low moisture capacity
]);

const TAU = Math.PI * 2;
const DEFAULT_RADIUS_METERS = 6_000_000;

// From space, a genus obscures the surface in proportion to its optical depth.
// Ice cloud is translucent, so a cirrus sheet must not count as full coverage —
// counting it as full is one way an implementation can "hit" the contract while
// the planet still looks bare.
const ORBITAL_OPACITY = Object.freeze({ low: 1, mid: 0.85, high: 0.45 });
// A direction counts as cloud-covered when this much of the surface behind it
// is obscured.
const OCCUPANCY_THRESHOLD = 0.5;

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function smoothstep(low, high, value) {
  if (high === low) return value >= high ? 1 : 0;
  const t = clamp((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) { return a + (b - a) * t; }

function finite(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v) {
  const inv = 1 / Math.max(Math.hypot(v.x, v.y, v.z), 1e-12);
  return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

function unitVector(value) {
  const x = finite(Array.isArray(value) ? value[0] : value?.x, 0);
  const y = finite(Array.isArray(value) ? value[1] : value?.y, 1);
  const z = finite(Array.isArray(value) ? value[2] : value?.z, 0);
  return normalize({ x, y, z });
}

// Advection is a rotation about +Y. Keeping the axis aligned with the rotation
// pole means latitude is invariant under advection, so a storm track stays a
// storm track as the clock runs — which is both physically right and what makes
// the calibrated coverage stable over time instead of drifting.
function rotateY(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

function tangentBasis(center) {
  const up = Math.abs(center.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const a = normalize(cross(up, center));
  return { a, b: normalize(cross(center, a)) };
}

function gaussian(value, center, width) {
  const t = (value - center) / width;
  return Math.exp(-t * t);
}

// Dewpoint depression (T − Td) in kelvin from relative humidity.
//
// Superlinear on purpose. The relationship is not "half the humidity, half the
// depression": saturated marine air sits within a couple of kelvin of its
// dewpoint while desert air runs 25 K+ dry. A linear map compresses that into a
// narrow band, and since the LCL is 125·(T − Td), a compressed depression makes
// every cloud base land at a similar altitude — the flat ceiling S1(b) exists to
// eliminate.
function dewpointDepression(humidity) {
  return Math.pow(1 - clamp(humidity), 1.45) * 36;
}

function fbm(simplex, dir, frequency, octaves, gain = 0.52, lacunarity = 2.07) {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let f = frequency;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * simplex.noise(
      dir.x * f, dir.y * f + octave * 19.19, dir.z * f);
    norm += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }
  return sum / Math.max(norm, 1e-9);
}

// ---------------------------------------------------------------------------
// Terrain proxy
//
// Orography is a first-class driver here: it sets orographicLift (lenticular
// clouds, windward cloud walls), lee-side drying (real deserts sit downwind of
// ranges), oceanic fraction (marine stratocumulus decks) and terrainConcavity
// (valley fog). planet-weather.js injects a fixed regional Planet.height atlas.
// The default below remains a synthetic standalone fixture.
// ---------------------------------------------------------------------------

function createDefaultTerrain(namespace) {
  const relief = new Simplex(makeRng(`${namespace}:relief`));
  const ranges = new Simplex(makeRng(`${namespace}:ranges`));
  return (direction) => {
    const continent = fbm(relief, direction, 1.6, 5, 0.5);
    // Ridges ride on top of continents so mountains sit inland, not in mid-ocean.
    const ridge = 1 - Math.abs(fbm(ranges, direction, 4.4, 4, 0.55));
    const land = smoothstep(-0.02, 0.16, continent);
    const elevation01 = clamp(land * (0.22 + ridge * ridge * 0.78));
    return {
      elevation01,
      elevationMeters: elevation01 * 6500,
      oceanic: 1 - land,
    };
  };
}

// Surface gradient and concavity, by finite differences on the sphere. The step
// is an angular offset, so the returned gradient is in metres per metre of
// surface distance once divided by the arc length.
function terrainDerivatives(system, direction) {
  const { a, b } = tangentBasis(direction);
  const step = 4e-4;                       // ~2.5 km on an Earth-sized body
  const arc = step * system.radiusMeters;
  const sampleAt = (ua, ub) => system.terrain(normalize({
    x: direction.x + a.x * ua + b.x * ub,
    y: direction.y + a.y * ua + b.y * ub,
    z: direction.z + a.z * ua + b.z * ub,
  }));
  const center = system.terrain(direction);
  const east = sampleAt(step, 0);
  const west = sampleAt(-step, 0);
  const north = sampleAt(0, step);
  const south = sampleAt(0, -step);
  const gradA = (east.elevationMeters - west.elevationMeters) / (2 * arc);
  const gradB = (north.elevationMeters - south.elevationMeters) / (2 * arc);
  // Positive laplacian = bowl. Valley floors and basins pool cold air at night,
  // which is where radiation fog forms first.
  const laplacian = (east.elevationMeters + west.elevationMeters
    + north.elevationMeters + south.elevationMeters
    - 4 * center.elevationMeters) / (arc * arc);
  return {
    ...center,
    gradient: { a: gradA, b: gradB },
    basis: { a, b },
    concavity: clamp(laplacian * 4e6 * 0.5 + 0.5),
  };
}

// ---------------------------------------------------------------------------
// Synoptic systems
// ---------------------------------------------------------------------------

function placeCyclones(rand, count) {
  const cyclones = [];
  for (let index = 0; index < count; index++) {
    // Alternate hemispheres so both storm tracks are populated; a one-sided
    // planet reads as a bug from orbit.
    const hemisphere = index % 2 === 0 ? 1 : -1;
    const sinLat = hemisphere * (0.52 + rand() * 0.32);
    const lon = rand() * TAU;
    const radius = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    cyclones.push({
      center: {
        x: Math.cos(lon) * radius,
        y: sinLat,
        z: Math.sin(lon) * radius,
      },
      // Angular radius of the cloud shield: 0.14-0.26 rad is 900-1650 km on an
      // Earth-sized body, matching real mid-latitude lows.
      reach: 0.14 + rand() * 0.12,
      // Storms track eastward, faster at higher latitude.
      drift: (0.0055 + rand() * 0.0075) * (hemisphere > 0 ? 1 : -1),
      phase: rand() * TAU,
      strength: 0.68 + rand() * 0.42,
      // Only the strongest lows are tight enough to have a resolvable eye.
      tropical: rand() < 0.34,
    });
  }
  return cyclones;
}

function placeSubtropicalHighs(rand, count, terrain) {
  const highs = [];
  let guard = 0;
  while (highs.length < count && guard++ < count * 40) {
    const hemisphere = highs.length % 2 === 0 ? 1 : -1;
    const sinLat = hemisphere * (0.34 + rand() * 0.24);
    const lon = rand() * TAU;
    const radius = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));
    const center = {
      x: Math.cos(lon) * radius, y: sinLat, z: Math.sin(lon) * radius,
    };
    // Real subtropical highs are ocean-centred (Azores, Pacific). Rejecting
    // land-centred candidates is what puts the big clear areas over water and
    // the deserts on their eastern flank, instead of scattering clear patches.
    if (terrain(center).oceanic < 0.45 && guard < count * 30) continue;
    highs.push({
      center,
      reach: 0.30 + rand() * 0.18,
      drift: 0.0011 * (hemisphere > 0 ? 1 : -1),
      strength: 0.8 + rand() * 0.45,
    });
  }
  return highs;
}

// One cyclone's contribution at a direction: shield, eye, eyewall, spiral arms,
// and the trailing cold/warm front pair.
function cycloneAt(cyclone, direction, hours, evolutionSpeed) {
  const center = rotateY(cyclone.center, hours * cyclone.drift);
  const cosine = clamp(dot(direction, center), -1, 1);
  const angular = Math.acos(cosine);
  if (angular > cyclone.reach * 3.4) return null;

  const { a, b } = tangentBasis(center);
  const azimuth = Math.atan2(dot(direction, b), dot(direction, a));
  const reach = cyclone.reach;
  const phase = cyclone.phase + hours * 0.012;

  const age = hours * evolutionSpeed * 0.065 + cyclone.phase;
  // A smooth seeded lifecycle, reconstructed from absolute time. No per-frame
  // RNG or recalibration: individual lows develop and dissipate independently.
  const strength = cyclone.strength * (0.20 + 0.80 * Math.pow(0.5 + 0.5 * Math.cos(age), 2));
  const shield = smoothstep(reach * 1.55, reach * 0.28, angular) * strength;
  const eyeRadius = cyclone.tropical ? reach * 0.07 : reach * 0.02;
  const eye = cyclone.tropical
    ? 1 - smoothstep(eyeRadius * 0.6, eyeRadius * 1.9, angular) : 0;
  const eyewall = cyclone.tropical
    ? smoothstep(eyeRadius * 0.9, eyeRadius * 1.7, angular)
      * smoothstep(reach * 0.5, reach * 0.22, angular) * strength
    : 0;

  // Integer-count logarithmic arms stay continuous across atan2's seam, so a
  // cyclone reads as circulation from orbit rather than a round white stamp.
  const arms = cyclone.tropical ? 2 : 3;
  const wave = Math.sin(azimuth * arms - angular / Math.max(reach, 1e-4) * 2.6
    - phase) * 0.5 + 0.5;
  const spiral = smoothstep(reach * 0.3, reach * 0.6, angular)
    * smoothstep(reach * 1.7, reach * 0.9, angular)
    * smoothstep(0.42, 0.86, wave) * strength * (1 - eye);

  // Fronts are finite curved tails attached to the low, not great-circle belts.
  const heading = phase * 0.4;
  const frontReach = smoothstep(reach * 0.7, reach * 1.3, angular)
    * smoothstep(reach * 6.0, reach * 3.2, angular);
  const coldDelta = azimuth - heading - angular * 2.1;
  const coldDistance = Math.abs(Math.sin(coldDelta)) * Math.sin(angular);
  const coldFront = smoothstep(reach * 0.42, reach * 0.06, coldDistance)
    * smoothstep(-0.05, 0.26, Math.cos(coldDelta)) * frontReach;
  const warmDelta = azimuth - heading + 1.74 + angular * 0.9;
  const warmDistance = Math.abs(Math.sin(warmDelta)) * Math.sin(angular);
  const warmFront = smoothstep(reach * 0.55, reach * 0.09, warmDistance)
    * smoothstep(-0.04, 0.3, Math.cos(warmDelta))
    * smoothstep(reach * 0.7, reach * 1.3, angular)
    * smoothstep(reach * 4.4, reach * 2.4, angular) * 0.82;

  return {
    angular,
    reach,
    shield,
    eye,
    eyewall,
    spiral,
    coldFront,
    warmFront,
    front: Math.max(coldFront, warmFront),
    // Distance to the nearest front line, in radians, for frontDistance.
    frontAngular: Math.min(
      coldDistance / Math.max(Math.sin(angular), 1e-4) * angular + angular * 0.0,
      Math.PI),
    inner: angular < reach * 1.55,
  };
}

// ---------------------------------------------------------------------------
// Field evaluation
// ---------------------------------------------------------------------------

// `full` splits the cheap structural evaluation (used tens of thousands of
// times by the coverage solver) from the complete thermodynamic sample.
function evaluateField(system, directionValue, hours, full) {
  const direction = unitVector(directionValue);
  const advected = rotateY(direction, -hours * system.advectionRadiansPerHour);
  const sinLat = direction.y;
  const absLatitude = Math.abs(sinLat);
  const lonAngle = Math.atan2(advected.z, advected.x);

  const terrain = terrainDerivatives(system, direction);
  const oceanic = clamp(terrain.oceanic);

  // -- Circulation skeleton -------------------------------------------------
  // The ITCZ meanders instead of being a drawn stripe.
  const itczShift = fbm(system.macroNoise, advected, 1.1, 2) * 0.055;
  const itcz = 1.28 * gaussian(sinLat, itczShift, 0.135);

  // Rossby waves displace the storm track in longitude, so mid latitudes are
  // alternately stormy and clear rather than banded.
  const rossby = Math.sin(lonAngle * 5 + system.wavePhase)
    * 0.55 + Math.sin(lonAngle * 3 - system.wavePhase * 1.7) * 0.45;
  const trackCenter = 0.72 + rossby * 0.11;
  const track = 0.92 * gaussian(absLatitude, trackCenter, 0.15);

  const subsidenceBand = 0.62 * gaussian(absLatitude, 0.46, 0.185);
  const polarDry = 0.34 * smoothstep(0.84, 1.0, absLatitude);

  let highCells = 0;
  for (const high of system.highs) {
    const center = rotateY(high.center, hours * high.drift);
    const angular = Math.acos(clamp(dot(direction, center), -1, 1));
    highCells += high.strength * smoothstep(high.reach * 1.6, 0, angular);
  }

  let shield = 0;
  let spiral = 0;
  let eyewall = 0;
  let eye = 0;
  let front = 0;
  let coldFront = 0;
  let warmFront = 0;
  let nearestFront = Math.PI;
  let insideCyclone = 0;
  let cycloneEyeDistance = Math.PI;
  for (const cyclone of system.cyclones) {
    const c = cycloneAt(cyclone, direction, hours, system.evolutionSpeed);
    if (!c) continue;
    shield = Math.max(shield, c.shield);
    spiral = Math.max(spiral, c.spiral);
    eyewall = Math.max(eyewall, c.eyewall);
    eye = Math.max(eye, c.eye);
    front = Math.max(front, c.front);
    coldFront = Math.max(coldFront, c.coldFront);
    warmFront = Math.max(warmFront, c.warmFront);
    if (c.front > 0) {
      // A front's angular half-width scales with the parent low's reach, so a
      // strong response means the sample sits close to the line.
      nearestFront = Math.min(nearestFront, (1 - c.front) * c.reach * 0.5);
    }
    if (c.inner) insideCyclone = Math.max(insideCyclone, c.shield);
    cycloneEyeDistance = Math.min(cycloneEyeDistance, c.angular);
  }

  // -- Orography ------------------------------------------------------------
  // Zonal jets: westerlies at mid latitudes, easterlies in the tropics. The
  // sign flip is what makes the windward side of a range change with latitude.
  const zonal = Math.sin(absLatitude * Math.PI * 1.9) * (absLatitude < 0.3 ? -1 : 1);
  const { a: eastAxis, b: northAxis } = terrain.basis;
  const windLocal = normalize({
    x: zonal + fbm(system.windNoise, advected, 2.1, 3) * 0.35,
    y: 0,
    z: fbm(system.windNoise, advected, 1.7, 2) * 0.42,
  });
  // Express the wind in the local tangent basis to dot it against the gradient.
  const windA = windLocal.x;
  const windB = windLocal.z;
  const upslope = windA * terrain.gradient.a + windB * terrain.gradient.b;
  const orographicLift = clamp(upslope * 42);
  const leeDrying = clamp(-upslope * 42) * clamp(terrain.elevation01 * 2.4);

  // -- Potentials -----------------------------------------------------------
  const macroTexture = fbm(system.macroNoise, advected, 2.3, 5, 0.5) * 0.52;
  const midAdvected = rotateY(direction, -hours * system.advectionRadiansPerHour * 1.25);
  const highAdvected = rotateY(direction, -hours * system.advectionRadiansPerHour * 1.65);
  const midTexture = fbm(system.midNoise, midAdvected, 2.9, 4, 0.5) * 0.55;
  const highTexture = fbm(system.highNoise, highAdvected, 2.0, 4, 0.5) * 0.6;

  const marine = oceanic * gaussian(absLatitude, 0.42, 0.22) * 0.34;

  const lowPotential = system.coverageBias
    + itcz + track + marine + macroTexture
    + shield * 0.9 + spiral * 0.55 + eyewall * 1.3 + front * 1.15
    + orographicLift * 0.8
    - subsidenceBand - polarDry - highCells * 0.95
    - leeDrying * 0.7 - eye * 1.6;

  const midPotential = system.coverageBias * 0.85
    + midTexture + front * 1.05 + shield * 0.72 + itcz * 0.42
    + orographicLift * 0.95
    - subsidenceBand * 0.85 - highCells * 0.8 - leeDrying * 0.5
    - polarDry * 0.5 - 0.18;

  // Jet-stream shear band feeds cirrus; anvil outflow feeds the rest.
  const jet = gaussian(absLatitude, 0.66, 0.2);
  const anvilOutflow = clamp(eyewall * 1.4 + spiral * 0.5 + itcz * 0.55);
  const highPotential = system.coverageBias * 0.8
    + highTexture + jet * 0.5 + front * 0.95 + anvilOutflow * 0.9
    + itcz * 0.35 - highCells * 0.55 - polarDry * 0.35 - 0.24;

  // Thresholding a low-frequency potential is what makes coverage an AREA
  // property (C5): moving the threshold grows and shrinks whole systems.
  const lowMask = smoothstep(-0.12, 0.12, lowPotential);
  const midMask = smoothstep(-0.12, 0.12, midPotential);
  const highMask = smoothstep(-0.14, 0.14, highPotential);

  const obstruction = 1
    - (1 - lowMask * ORBITAL_OPACITY.low)
    * (1 - midMask * ORBITAL_OPACITY.mid)
    * (1 - highMask * ORBITAL_OPACITY.high);

  if (!full) return { obstruction };

  // -- Thermodynamics -------------------------------------------------------
  const sunDirection = rotateY(system.sunDirection,
    hours * TAU / system.rotationPeriodHours);
  const lights=system.lightDirectionsAt?.(hours);
  const cosSun = Array.isArray(lights)
    ? Math.max(-1,...lights.filter(light=>light.irradianceFraction>0).map(light=>
      dot(direction,{x:light.direction[0],y:light.direction[1],z:light.direction[2]})))
    : dot(direction, sunDirection);
  const nightSide = smoothstep(0.1, -0.14, cosSun);

  const temperatureK = system.baseTemperatureK
    - absLatitude * absLatitude * system.polarCoolingK
    - terrain.elevationMeters * 0.0065
    + cosSun * system.diurnalRangeK * 0.5
    - lowMask * 2.4;

  const humidity = clamp(
    0.26
    + oceanic * 0.30
    + itcz * 0.20
    + lowMask * 0.17
    + shield * 0.10
    + front * 0.08
    + fbm(system.humidityNoise, advected, 2.6, 3) * 0.13
    - leeDrying * 0.24
    - highCells * 0.13
    - polarDry * 0.16
    - terrain.elevation01 * 0.10);
  const midHumidity = clamp(0.5 * (midMask + 0.5)
    + front * 0.3 + midTexture * 0.35 - highCells * 0.22 - 0.14);
  const highHumidity = clamp(0.5 * (highMask + 0.45)
    + anvilOutflow * 0.35 + highTexture * 0.3 - 0.12);

  const dewpointK = temperatureK - dewpointDepression(humidity);

  const windSpeedMs = clamp(
    system.baseWindSpeed * (0.42 + Math.abs(zonal) * 0.75)
    + eyewall * 48 + front * 16 + spiral * 9
    + orographicLift * 10, 0.4, 90);
  const shear = clamp(jet * 0.62 + front * 0.42 + Math.abs(zonal) * 0.22
    + fbm(system.windNoise, advected, 3.3, 2) * 0.16);

  // Convective energy is a CAPE proxy: warm, humid, and not capped from above.
  const warmth = smoothstep(272, 302, temperatureK);
  const convective = clamp(
    warmth * (humidity - 0.34) * 1.9
    + itcz * 0.42 + eyewall * 0.62 + spiral * 0.2
    + coldFront * 0.3
    - subsidenceBand * 0.28 - highCells * 0.24);
  // Subsidence inversions are the strongest stabilizers; deep convection is the
  // strongest destabilizer. Stratus needs the former, cumulonimbus the latter.
  const stability = clamp(0.5
    + subsidenceBand * 0.42 + highCells * 0.3 + polarDry * 0.35
    + (1 - warmth) * 0.22
    - convective * 0.85 - eyewall * 0.4);

  const frontProximity = clamp(Math.max(front,
    smoothstep(0.22, 0.0, nearestFront) * 0.85));
  const frontDistance = nearestFront * system.radiusMeters;

  const lclMeters = liftingCondensationLevel({
    temperatureK, dewpointK, orographicLift, stability,
  });

  const sample = {
    kind: 'weather-sample',
    direction,
    hours,
    regime: null,
    // Coverage / area structure (C5, C1)
    lowMask, midMask, highMask, obstruction,
    lowPotential, midPotential, highPotential,
    clearSkyMask: 1 - obstruction,
    covered: obstruction >= OCCUPANCY_THRESHOLD,
    // Synoptic geometry
    frontDistance,
    frontProximity,
    coldFront, warmFront,
    cycloneField: {
      eyeDistance: cycloneEyeDistance * system.radiusMeters,
      eyewall, spiral, shield, eye,
    },
    // Thermodynamics
    temperatureK, dewpointK, humidity, midHumidity, highHumidity,
    lclMeters,
    convectiveEnergy: convective * 3200,   // J/kg-ish, for downstream physics
    convective,
    stability,
    // Winds
    windVector: {
      x: windLocal.x * eastAxis.x + windLocal.z * northAxis.x,
      y: windLocal.x * eastAxis.y + windLocal.z * northAxis.y,
      z: windLocal.x * eastAxis.z + windLocal.z * northAxis.z,
      speed: windSpeedMs,
    },
    windSpeedMs,
    windSpeed: clamp(windSpeedMs / 40),
    shear,
    // Surface context
    orographicLift,
    leeDrying,
    oceanic,
    terrainConcavity: terrain.concavity,
    elevationMeters: terrain.elevationMeters,
    absLatitude,
    nightSide,
    solarElevation: cosSun,
  };

  sample.regime = classifyRegime(sample, {
    itcz, subsidenceBand, highCells, insideCyclone, polarDry,
  });
  const weights = speciesWeights(sample);
  sample.speciesWeights = weights.weights;
  sample.familyAmounts = weights.familyAmounts;
  return Object.freeze(sample);
}

function classifyRegime(sample, structure) {
  if (structure.insideCyclone > 0.28) return 'cyclone';
  if (sample.frontProximity > 0.45) return 'frontal';
  if (sample.absLatitude > 0.84) return 'polar';
  if (structure.itcz > 0.5) return 'itcz';
  if (sample.orographicLift > 0.4 || sample.leeDrying > 0.4) return 'orographic';
  if (structure.subsidenceBand + structure.highCells > 0.5) {
    return 'subtropical-high';
  }
  return sample.covered ? 'frontal' : 'subtropical-high';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Per-point lifting condensation level in metres (D5, S1b).
//
// Physical basis: air lifted from the surface saturates where its temperature
// falls to the dewpoint. Espy's field approximation LCL ≈ 125 · (T − Td) gives
// roughly 500 m over warm humid ocean, 2500 m over dry interior, and 4000 m+
// over desert. Terrain-forced ascent lowers it on windward slopes; a strong
// subsidence inversion caps a shallow well-mixed layer and lowers it further.
//
// This function is why a cloud deck stops being a ceiling: its altitude becomes
// a property of local air, so it varies continuously across the planet (S1b).
export function liftingCondensationLevel(thermodynamics = {}) {
  const temperatureK = finite(thermodynamics.temperatureK, 288);
  const dewpointK = finite(thermodynamics.dewpointK, 278);
  const orographicLift = clamp(finite(thermodynamics.orographicLift, 0));
  const stability = clamp(finite(thermodynamics.stability, 0.5));
  const depression = Math.max(0, temperatureK - dewpointK);
  const raw = 125 * depression
    * (1 - orographicLift * 0.38)
    * (1 - Math.max(0, stability - 0.55) * 0.35);
  return clamp(raw, CLOUD_LCL_MIN_METERS, CLOUD_LCL_MAX_METERS);
}

// Soft acceptance of one trigger window. Fully satisfied inside [min,max], and
// falling off over a margin proportional to the window width so a narrow window
// is genuinely selective while a wide one is permissive.
function windowScore(value, window) {
  const [min, max] = window;
  if (value >= min && value <= max) return 1;
  const margin = Math.max(0.06, (max - min) * 0.3);
  const distance = value < min ? min - value : value - max;
  return Math.max(0, 1 - distance / margin);
}

// Nearest-fit fallback used only when every strict trigger in one family is
// zero. A synoptic low-cloud mask cannot legitimately resolve to "no low-cloud
// genus": the mask owns WHERE cloud exists, while triggers choose WHAT it is.
// Exponential tails retain that nearest choice without making out-of-window
// species compete during normal conditions.
function windowLogAffinity(value, window) {
  const [min, max] = window;
  if (value >= min && value <= max) return 0;
  const margin = Math.max(0.06, (max - min) * 0.3);
  const distance = value < min ? min - value : value - max;
  return -3 * distance / margin;
}

function fallbackSpeciesLogScore(species, weather) {
  if (species.id === 'anvil') return -Infinity;
  let score = 0;
  for (const [key, window] of Object.entries(species.triggers)) {
    score += windowLogAffinity(finite(weather[key], 0), window);
  }
  return score;
}

// Score every species against a weather sample's trigger windows.
//
// Weights are normalized WITHIN each family, then scaled by that family's area
// amount. Normalizing all sixteen together would be wrong: low, mid and high
// decks genuinely coexist over the same point, so they must not compete. The
// returned weight is therefore directly "how much of this genus is here", which
// is what the density function consumes.
export function speciesWeights(weather) {
  if (!weather) throw new TypeError('speciesWeights() needs a weather sample');
  const raw = new Map();
  for (const species of CLOUD_SPECIES) {
    let score = 1;
    for (const [key, window] of Object.entries(species.triggers)) {
      const value = finite(weather[key], 0);
      score *= windowScore(value, window);
      if (score <= 0) break;
    }
    raw.set(species.id, score);
  }

  // An anvil only exists downwind of a tower that reached the tropopause.
  // Without this gate the high family would grow ice sheets over calm air.
  const parentScore = raw.get('cumulonimbus') || 0;
  raw.set('anvil', (raw.get('anvil') || 0) * clamp(parentScore * 2.5));

  const familyAmounts = {
    low: clamp(finite(weather.lowMask, 0)),
    mid: clamp(finite(weather.midMask, 0)),
    high: clamp(finite(weather.highMask, 0)),
  };

  const weights = {};
  for (const family of ['low', 'mid', 'high']) {
    const members = CLOUD_SPECIES.filter((s) => s.family === family);
    let scores = members.map((species) => raw.get(species.id) || 0);
    let total = scores.reduce((sum, score) => sum + score, 0);
    if (total <= 1e-6) {
      const logScores = members.map((species) =>
        fallbackSpeciesLogScore(species, weather));
      const bestLog = Math.max(...logScores);
      scores = logScores.map((score) => Math.exp(score - bestLog));
      total = scores.reduce((sum, score) => sum + score, 0);
    }
    // The calibrated synoptic mask owns covered AREA. Formation triggers only
    // partition that amount among genera; applying a second "best fit" amount
    // here silently erased fully covered columns when all strict windows missed.
    const amount = familyAmounts[family];
    familyAmounts[family] = amount;
    for (let index = 0; index < members.length; index++) {
      const species = members[index];
      weights[species.id] = total > 1e-6
        ? amount * (scores[index] / total) : 0;
    }
  }
  // Special species are absolute, not a share of a deck: fog is a surface
  // phenomenon and noctilucent cloud lives above the troposphere entirely.
  for (const species of CLOUD_SPECIES) {
    if (species.family !== 'special') continue;
    weights[species.id] = raw.get(species.id) || 0;
  }
  return { weights, familyAmounts };
}

// Sample the full weather state for one unit-sphere direction.
//
// Deterministic: identical (system, direction, timeHours) always yields an
// identical result. C1 depends on this, and so does the world lock.
export function sampleWeather(system, direction, timeHours = 0) {
  if (system?.kind !== 'weather-system') {
    throw new TypeError('sampleWeather() expects a system from createWeatherSystem()');
  }
  return evaluateField(system, direction, finite(timeHours, 0), true);
}

// Equal-area sampling directions. The Fibonacci lattice gives near-uniform
// spherical area per sample, which is required for an AREA measurement — a
// lat/lon grid would over-count the poles and quietly bias the contract.
export function fibonacciDirections(count) {
  const directions = new Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index++) {
    const y = 1 - 2 * (index + 0.5) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * golden;
    directions[index] = {
      x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius,
    };
  }
  return directions;
}

// Measure the fraction of the planet's surface that is cloud-covered, as seen
// from orbit. This is a COUNT of occupied directions, not an average density —
// averaging a density is exactly the C5 mistake.
export function measureCoverage(system, hours = 0, samples = 2048) {
  const directions = fibonacciDirections(Math.max(64, Math.round(samples)));
  let occupied = 0;
  for (const direction of directions) {
    if (evaluateField(system, direction, hours, false).obstruction
      >= OCCUPANCY_THRESHOLD) occupied++;
  }
  return occupied / directions.length;
}

// Solve the synoptic threshold until the measured cloud-covered AREA fraction
// matches the authored coverage within COVERAGE_TOLERANCE.
//
// The knob is a single bias added to every potential BEFORE thresholding, so
// raising coverage grows the existing weather systems outward rather than
// fading in cloud everywhere. That distinction is the whole of C5: the same
// measured 0.5 can be half the planet under organized systems, or the entire
// planet under a uniform half-density haze, and only the former looks like
// Earth from orbit.
export function calibrateCoverage(system, targetCoverage, options = {}) {
  const target = clamp(finite(targetCoverage, 0.5), 0.02, 0.98);
  const samples = Math.max(256, Math.round(finite(options.samples, 2048)));
  const hours = finite(options.hours, 0);
  const iterations = Math.max(6, Math.round(finite(options.iterations, 20)));
  // The potential's dynamic range is roughly +/-2.5; this bracket covers a
  // fully clear and a fully overcast planet.
  let low = -2.6;
  let high = 2.6;
  let measured = NaN;
  let bias = system.coverageBias;
  for (let step = 0; step < iterations; step++) {
    bias = (low + high) * 0.5;
    system.coverageBias = bias;
    measured = measureCoverage(system, hours, samples);
    if (Math.abs(measured - target) <= COVERAGE_TOLERANCE * 0.4) break;
    if (measured < target) low = bias; else high = bias;
  }
  system.coverageBias = bias;
  system.measuredCoverage = measured;
  system.targetCoverage = target;
  return { bias, measured, target };
}

// Build a weather system for a planet.
//
// `options.targetCoverage` is the orbital area fraction from the astronomy
// dossier. Construction runs calibrateCoverage() so the returned system
// actually satisfies that contract instead of merely storing the number.
export function createWeatherSystem(seed, options = {}) {
  const namespace = `${String(seed)}:cloud-weather:v${WEATHER_SYSTEM_VERSION}`;
  const rand = makeRng(`${namespace}:layout`);
  const terrain = typeof options.terrain === 'function'
    ? options.terrain : createDefaultTerrain(namespace);

  const system = {
    kind: 'weather-system',
    version: WEATHER_SYSTEM_VERSION,
    seed: String(seed),
    namespace,
    terrain,
    radiusMeters: Math.max(1, finite(options.radiusMeters, DEFAULT_RADIUS_METERS)),
    rotationPeriodHours: Math.max(0.5, finite(options.rotationPeriodHours, 24)),
    baseTemperatureK: finite(options.temperatureK, 289),
    polarCoolingK: clamp(finite(options.polarCoolingK, 52), 0, 180),
    diurnalRangeK: clamp(finite(options.diurnalRangeK, 9), 0, 60),
    baseWindSpeed: clamp(finite(options.windSpeed, 15), 0.5, 90),
    sunDirection: unitVector(options.sunDirection || { x: 1, y: 0, z: 0 }),
    advectionRadiansPerHour: (0.004 + rand() * 0.008)
      * clamp(finite(options.weatherSpeed, 1), 0, 8),
    evolutionSpeed: clamp(finite(options.weatherSpeed, 1), 0, 8),
    wavePhase: rand() * TAU,
    macroNoise: new Simplex(makeRng(`${namespace}:macro`)),
    midNoise: new Simplex(makeRng(`${namespace}:mid`)),
    highNoise: new Simplex(makeRng(`${namespace}:high`)),
    humidityNoise: new Simplex(makeRng(`${namespace}:humidity`)),
    windNoise: new Simplex(makeRng(`${namespace}:wind`)),
    coverageBias: 0,
    measuredCoverage: NaN,
    targetCoverage: clamp(finite(options.targetCoverage, 0.5), 0.02, 0.98),
  };
  system.cyclones = placeCyclones(rand, 5 + Math.floor(rand() * 4));
  system.highs = placeSubtropicalHighs(rand, 4 + Math.floor(rand() * 3), terrain);

  calibrateCoverage(system, system.targetCoverage, {
    samples: Math.round(finite(options.calibrationSamples, 2048)),
    iterations: Math.round(finite(options.calibrationIterations, 20)),
  });
  return system;
}

// Deterministic fingerprint of the cloud field. Distinct from
// weatherFieldFingerprint() in weather-field.js: that one covers gameplay
// production weather, this one covers the CPU candidate model.
export function weatherSystemFingerprint(system, hours = 0, samples = 96) {
  let hash = strHash32(`${system.namespace}|${system.coverageBias.toFixed(6)}`);
  for (const direction of fibonacciDirections(Math.max(16, samples))) {
    const sample = sampleWeather(system, direction, hours);
    for (const value of [
      sample.lowMask, sample.midMask, sample.highMask,
      sample.humidity, sample.lclMeters / 1000, sample.convective,
      sample.stability, sample.shear, sample.frontProximity,
    ]) {
      const quantized = Math.round(finite(value, 0) * 4096);
      hash ^= quantized & 0xff;
      hash = Math.imul(hash, 16777619);
      hash ^= (quantized >>> 8) & 0xff;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return `cloud-weather-v${WEATHER_SYSTEM_VERSION}:`
    + `${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
