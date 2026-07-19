import * as THREE from 'three';
import { makeRng, strHash32 } from './rng.js';
import { generateCelestialNames, ROMAN } from './names.js';

export const GENERATION_VERSION = 2;
export const TIME_SCALE = 60; // real seconds -> simulated seconds
const TAU = Math.PI * 2;

const STELLAR_CLASSES = [
  { spectral: 'M', weight: 54, mass: [0.18, 0.58], temp: [2600, 3900], color: 0xff9b70 },
  { spectral: 'K', weight: 25, mass: [0.58, 0.86], temp: [3900, 5200], color: 0xffc88a },
  { spectral: 'G', weight: 12, mass: [0.86, 1.12], temp: [5200, 6100], color: 0xfff1cf },
  { spectral: 'F', weight: 6, mass: [1.12, 1.45], temp: [6100, 7500], color: 0xf3f6ff },
  { spectral: 'A', weight: 2.1, mass: [1.45, 2.3], temp: [7500, 10000], color: 0xcad8ff },
  { spectral: 'B', weight: 0.55, mass: [2.3, 8], temp: [10000, 26000], color: 0x9cbcff },
  { spectral: 'O', weight: 0.05, mass: [8, 18], temp: [26000, 42000], color: 0x82a8ff },
  { spectral: 'D', weight: 0.3, mass: [0.5, 1.05], temp: [7000, 18000], color: 0xdde8ff },
];

function range(rand, [a, b]) { return a + (b - a) * rand(); }
function weighted(rand, items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let n = rand() * total;
  for (const item of items) { n -= item.weight; if (n <= 0) return item; }
  return items[items.length - 1];
}
function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function makeStar(rand, index, systemName, home = false) {
  const cls = home && index === 0 ? STELLAR_CLASSES.find((c) => c.spectral === 'G') : weighted(rand, STELLAR_CLASSES);
  const massSolar = range(rand, cls.mass);
  const temperatureK = range(rand, cls.temp);
  const luminositySolar = cls.spectral === 'D'
    ? 0.01 + rand() * 0.09
    : Math.max(0.003, Math.pow(massSolar, massSolar < 0.43 ? 2.3 : massSolar < 2 ? 4 : 3.5));
  const radiusSolar = cls.spectral === 'D' ? 0.009 + rand() * 0.009 : Math.max(0.12, Math.pow(massSolar, 0.72));
  const radiusRender = cls.spectral === 'D' ? 1.7e6 + rand() * 1.2e6 : 4e6 * Math.max(0.55, radiusSolar);
  return {
    starId: `star-${index}`,
    displayName: index === 0 ? `${systemName}星` : `${systemName} ${String.fromCharCode(65 + index)}`,
    component: String.fromCharCode(65 + index),
    spectralClass: `${cls.spectral}${Math.floor(rand() * 10)}V`,
    massSolar, radiusSolar, temperatureK, luminositySolar, radiusRender,
    color: cls.color,
  };
}

function solveKepler(mean, eccentricity) {
  let e = mean;
  for (let i = 0; i < 6; i++) e -= (e - eccentricity * Math.sin(e) - mean) / (1 - eccentricity * Math.cos(e));
  return e;
}

export function orbitalPosition(orbit, timeHours, out = new THREE.Vector3()) {
  const mean = ((orbit.phase + timeHours / orbit.periodHours) * TAU) % TAU;
  const E = solveKepler(mean, orbit.eccentricity || 0);
  const a = orbit.renderRadius;
  const x = a * (Math.cos(E) - orbit.eccentricity);
  const z = a * Math.sqrt(1 - orbit.eccentricity * orbit.eccentricity) * Math.sin(E);
  out.set(x, 0, z);
  out.applyAxisAngle(new THREE.Vector3(1, 0, 0), orbit.inclination || 0);
  out.applyAxisAngle(new THREE.Vector3(0, 1, 0), orbit.ascendingNode || 0);
  return out;
}

export function orbitalVelocity(orbit, timeHours, out = new THREE.Vector3()) {
  const step = Math.max(0.001, orbit.periodHours / 100000);
  const a = orbitalPosition(orbit, timeHours - step, new THREE.Vector3());
  const b = orbitalPosition(orbit, timeHours + step, out);
  return b.sub(a).multiplyScalar(1 / (step * 2 * 3600));
}

export function orientationAt(body, timeHours, out = new THREE.Quaternion()) {
  if (body.tidallyLocked) {
    const towardParent = orbitalPosition(body.orbit, timeHours, new THREE.Vector3()).negate().normalize();
    return out.setFromUnitVectors(new THREE.Vector3(-1, 0, 0), towardParent);
  }
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), body.axialTilt || 0);
  const angle = ((body.rotationPhase + timeHours / body.rotationPeriodHours) * TAU) % TAU;
  return out.copy(tilt).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle));
}

function bodyClimate(equilibriumK, rand, isHome, au, snowLine) {
  if (isHome) return 'lush';
  if (equilibriumK > 620) return 'lava';
  if (equilibriumK > 350) return rand() < 0.55 ? 'desert' : 'barren';
  if (equilibriumK > 235 && equilibriumK < 330) {
    const r = rand(); return r < 0.32 ? 'lush' : r < 0.55 ? 'ocean' : r < 0.78 ? 'desert' : 'toxic';
  }
  if (au > snowLine * 0.82 && rand() < 0.36) return rand() < 0.66 ? 'gasGiant' : 'iceGiant';
  return equilibriumK < 190 ? 'ice' : (rand() < 0.55 ? 'barren' : 'ice');
}

export function generateStellarSpec(seed, starCell, systemName = '') {
  const id = typeof starCell === 'string' ? starCell : starCell.id;
  const isHome = id === '0,0,0';
  const rand = makeRng(`${seed}:stellar:v${GENERATION_VERSION}:${id}`);
  const primary = makeStar(rand, 0, systemName, isHome);
  const binaryChance = isHome ? 0.34 : Math.min(0.62, 0.2 + primary.massSolar * 0.15);
  const stars = [primary];
  if (rand() < binaryChance) stars.push(makeStar(rand, 1, systemName, false));
  if (stars.length === 2) primary.displayName = `${systemName} A`;
  const totalMass = stars.reduce((sum, star) => sum + star.massSolar, 0);
  const totalLuminosity = stars.reduce((sum, star) => sum + star.luminositySolar, 0);
  const binarySemiMajorAU = stars.length === 2 ? 0.025 + rand() * 0.085 : 0;
  const binaryEccentricity = stars.length === 2 ? rand() * 0.28 : 0;
  const binaryOrbit = stars.length === 2 ? {
    semiMajorAU: binarySemiMajorAU,
    renderRadius: 1.1e7 + rand() * 2.3e7,
    periodHours: Math.sqrt(Math.pow(binarySemiMajorAU, 3) / totalMass) * 365.25 * 24,
    eccentricity: binaryEccentricity,
    inclination: (rand() - 0.5) * 0.28,
    ascendingNode: rand() * TAU,
    phase: rand(),
  } : null;
  return { stars, binaryOrbit, totalMass, totalLuminosity, binarySemiMajorAU, binaryEccentricity };
}

function atmosphereFor(type, rand) {
  const pressure = (a, b) => a + rand() * (b - a);
  const profiles = {
    lush: { composition: ['N₂', 'O₂', 'Ar', 'H₂O'], pressureBar: pressure(0.72, 1.38), greenhouseK: pressure(22, 42) },
    ocean: { composition: ['N₂', 'O₂', 'H₂O'], pressureBar: pressure(1.1, 3.2), greenhouseK: pressure(28, 58) },
    desert: { composition: ['CO₂', 'N₂', 'Ar'], pressureBar: pressure(0.12, 1.8), greenhouseK: pressure(18, 90) },
    ice: { composition: ['N₂', 'CH₄', 'Ar', 'H₂O'], pressureBar: pressure(0.01, 0.7), greenhouseK: pressure(2, 18) },
    lava: { composition: ['CO₂', 'SO₂', 'Na'], pressureBar: pressure(0.08, 8), greenhouseK: pressure(45, 180) },
    barren: { composition: ['Ar', 'CO₂'], pressureBar: pressure(0.0001, 0.08), greenhouseK: pressure(0, 5) },
    toxic: { composition: ['CO₂', 'Cl₂', 'SO₂'], pressureBar: pressure(0.8, 6), greenhouseK: pressure(35, 130) },
    exotic: { composition: ['N₂', 'Xe', 'CH₄'], pressureBar: pressure(0.2, 3.5), greenhouseK: pressure(8, 75) },
    gasGiant: { composition: ['H₂', 'He', 'NH₃'], pressureBar: null, greenhouseK: null },
    iceGiant: { composition: ['H₂', 'He', 'CH₄'], pressureBar: null, greenhouseK: null },
  };
  return profiles[type] || profiles.barren;
}

const DYNAMO_ACTIVITY = {
  lush: 1.0, ocean: 0.92, desert: 0.58, ice: 0.34, lava: 0.74,
  barren: 0.2, toxic: 0.68, exotic: 0.76, gasGiant: 2.5, iceGiant: 1.75,
};

const CLOUD_CHANCE = {
  lush: 0.74, ocean: 0.9, desert: 0.2, ice: 0.5, lava: 0.08,
  barren: 0.03, toxic: 0.72, exotic: 0.28, gasGiant: 1, iceGiant: 1,
};

function cloudCondensates(type, equilibriumK) {
  if (type === 'gasGiant') return ['NH₃冰晶', 'H₂O冰晶'];
  if (type === 'iceGiant') return ['CH₄冰晶', 'H₂S冰晶'];
  if (type === 'toxic') return ['硫酸气溶胶', '硫化物'];
  if (type === 'lava') return ['硅酸盐', '金属蒸气'];
  if (type === 'ice') {
    if (equilibriumK < 90) return ['N₂冰晶', 'CH₄冰晶'];
    if (equilibriumK < 190) return ['CH₄冰晶', 'H₂O冰晶'];
    return ['H₂O冰晶'];
  }
  if (type === 'desert' || type === 'barren') return ['H₂O冰晶', '尘埃'];
  if (type === 'exotic') return ['CH₄冰晶', '有机霾'];
  return ['H₂O液滴', 'H₂O冰晶'];
}

// One deterministic physical dossier owns the properties that used to be
// rolled independently by astronomy, the star map and the planet renderer.
// The model is intentionally legible rather than pretending to be a full
// magnetohydrodynamics simulation.
export function derivePlanetaryEnvironment(body) {
  const rand = makeRng(`${body.seed}:environment:v1`);
  const giant = body.type === 'gasGiant' || body.type === 'iceGiant';
  const mass = Math.max(body.massEarth || 0.01, 0.01);
  const rotation = Math.max(body.rotationPeriodHours || 24, 1);
  const activity = DYNAMO_ACTIVITY[body.type] ?? 0.35;
  const rotationFactor = Math.sqrt(clamp(24 / rotation, 0.06, 2.4));
  const massFactor = clamp(Math.pow(mass, 0.22), 0.38, giant ? 2.2 : 1.55);
  const lockFactor = body.tidallyLocked ? 0.58 : 1;
  const variability = 0.78 + rand() * 0.44;
  const strengthEarth = giant
    ? clamp(activity * rotationFactor * massFactor * variability, 1.2, 18)
    : clamp(activity * rotationFactor * massFactor * lockFactor * variability, 0.01, 3.5);
  const magneticLabel = strengthEarth < 0.25 ? '微弱' : strengthEarth < 0.85 ? '中等' : '强烈';
  const magnetosphere = {
    strengthEarth,
    label: magneticLabel,
    origin: strengthEarth < 0.08 ? '感应磁层' : '内禀磁场',
  };

  let atmosphere = body.atmosphere ? {
    ...body.atmosphere,
    composition: [...(body.atmosphere.composition || [])],
  } : null;
  if (atmosphere && atmosphere.pressureBar != null) {
    const gravityRetention = clamp(Math.pow(mass, 0.16), 0.52, 1.42);
    const thermalRetention = clamp(310 / Math.max(body.equilibriumK || 250, 70), 0.48, 1.45);
    // A dynamo helps on geological timescales, but gravity and temperature
    // remain first-class: a weak field does not instantly erase an atmosphere.
    const magneticRetention = 0.8 + 0.2 * clamp(strengthEarth, 0, 1);
    const lockRetention = body.tidallyLocked ? 0.9 : 1;
    const temperature = body.equilibriumK || 250;
    const volatilePhaseRetention = body.type === 'ice'
      ? temperature < 65 ? 0.003
        : temperature < 90 ? 0.01 + smoothstep(65, 90, temperature) * 0.07
          : temperature < 125 ? 0.08 + smoothstep(90, 125, temperature) * 0.72
            : 1
      : 1;
    atmosphere.pressureBar = clamp(
      atmosphere.pressureBar * gravityRetention * thermalRetention * magneticRetention * lockRetention * volatilePhaseRetention,
      0.00005,
      12,
    );
    atmosphere.state = volatilePhaseRetention < 0.1
      ? '挥发物大部冻结沉降'
      : volatilePhaseRetention < 0.8 ? '季节性挥发物循环' : '稳定气态层';
  }

  const pressureBar = atmosphere?.pressureBar;
  const pressureSupport = giant
    ? 1
    : smoothstep(-2.7, -0.15, Math.log10(Math.max(pressureBar || 0, 0.00001)));
  const cloudChance = clamp((CLOUD_CHANCE[body.type] ?? 0.08) * pressureSupport, 0, 1);
  const hasClouds = giant || rand() < cloudChance;
  const coverage = hasClouds
    ? clamp((giant ? 0.66 : 0.18) + rand() * (giant ? 0.18 : 0.55) * (0.55 + pressureSupport * 0.45), 0, 0.85)
    : 0;
  const clouds = {
    coverage,
    probability: cloudChance,
    condensates: cloudCondensates(body.type, body.equilibriumK || 250),
    regime: coverage > 0.62 ? '全球云幕' : coverage > 0.36 ? '多云' : coverage > 0.05 ? '稀疏云层' : '晴空或无稳定云层',
  };

  return { atmosphere, magnetosphere, clouds };
}

function attachPlanetaryEnvironment(body) {
  return Object.assign(body, derivePlanetaryEnvironment(body));
}

export const COMPACT_OBJECTS_VERSION = 1;

// A black-hole system is a separate authored destination rather than a roll
// inside ordinary star cells. It therefore cannot replace a selected system
// or consume any of the legacy stellar/planetary RNG stream.
export function generateBlackHoleSystemSpec(seed, destination) {
  const systemId = destination.id;
  const rand = makeRng(`${seed}:compact-objects:v${COMPACT_OBJECTS_VERSION}:${systemId}`);
  const systemName = destination.systemName || '厄瑞玻斯观测区';
  const massSolar = 1850 + rand() * 950;
  const eventHorizonKm = massSolar * 2.95325;
  const renderRadius = 2.6e6 + rand() * 8e5;
  const centralObject = {
    bodyId: 'black-hole-0', parentId: null, host: 'system-barycenter',
    seed: `${seed}:bh:${systemId}:0`, name: destination.name || '厄瑞玻斯',
    properName: destination.name || '厄瑞玻斯', catalogName: destination.catalogId || 'AF BH-001',
    type: 'blackHole', isMoon: false, radius: renderRadius,
    accretionRadius: renderRadius * (10.5 + rand() * 2.5),
    orbitIndex: 0,
    orbit: {
      semiMajorAU: 0, renderRadius: 0, periodHours: 1e15,
      eccentricity: 0, inclination: 0, ascendingNode: 0, phase: 0,
    },
    equilibriumK: null, atmosphere: null, axialTilt: rand() * Math.PI,
    rotationPeriodHours: 0.001, rotationPhase: rand(), tidallyLocked: false,
    massEarth: massSolar * 332946, landable: false,
    compactObjectVersion: COMPACT_OBJECTS_VERSION,
    blackHole: {
      massSolar, eventHorizonKm, spin: 0.58 + rand() * 0.34,
      accretionDisc: true, discTemperatureK: 3100 + rand() * 1700,
    },
  };

  const stars = [];
  const capturedCount = 3;
  for (let i = 0; i < capturedCount; i++) {
    const star = makeStar(rand, i, systemName, false);
    const semiMajorAU = 34 + i * 31 + rand() * 18;
    star.displayName = `${systemName} ${String.fromCharCode(65 + i)}`;
    star.orbit = {
      semiMajorAU,
      renderRadius: 5.4e7 + i * 4.6e7,
      periodHours: Math.sqrt(Math.pow(semiMajorAU, 3) / massSolar) * 365.25 * 24,
      eccentricity: 0.08 + rand() * 0.24,
      inclination: (rand() - 0.5) * 0.46,
      ascendingNode: rand() * TAU,
      phase: rand(),
    };
    stars.push(star);
  }

  return {
    generationVersion: GENERATION_VERSION,
    compactObjectsVersion: COMPACT_OBJECTS_VERSION,
    systemId, name: systemName, properName: systemName,
    latinName: 'Erebus Gravitational Observatory', nameSourceCategory: 'authored-compact-object',
    catalogId: destination.catalogId || 'AF BH-001', isHome: false, isBlackHoleSystem: true,
    stars, binaryOrbit: null, bodies: [], compactObjects: [centralObject],
    habitableZoneAU: [], snowLineAU: null,
  };
}

export function generateSystemSpec(seed, starCell) {
  if (typeof starCell === 'object' && starCell?.kind === 'blackHole') {
    return generateBlackHoleSystemSpec(seed, starCell);
  }
  const id = typeof starCell === 'string' ? starCell : starCell.id;
  const rand = makeRng(`${seed}:system-spec:v${GENERATION_VERSION}:${id}`);
  const isHome = id === '0,0,0';
  const bodyCount = (isHome ? 6 : 4) + Math.floor(rand() * 5);
  // Reserve the actual upper bound (four moons per giant) so name allocation
  // never wraps and repeats inside moon-rich outer systems.
  const preliminaryMoonCount = bodyCount * 4;
  const names = generateCelestialNames(seed, id, bodyCount, preliminaryMoonCount);
  const baseName = names.system.zh;
  const stellar = generateStellarSpec(seed, id, baseName);
  const { stars, binaryOrbit, totalMass, totalLuminosity, binarySemiMajorAU, binaryEccentricity } = stellar;
  const starCount = stars.length;

  const bodies = [];
  const snowLine = 2.7 * Math.sqrt(totalLuminosity);
  // The guaranteed home world is physically placed in the system's
  // insolation-scaled habitable zone; its lush label is no longer an override
  // pasted onto a scorching inner orbit.
  let au = isHome
    ? Math.max(starCount === 2 ? binarySemiMajorAU * (1 + binaryEccentricity) * 3.4 : 0.16, 0.98 * Math.sqrt(totalLuminosity))
    : Math.max(starCount === 2 ? binarySemiMajorAU * (1 + binaryEccentricity) * 3.4 : 0.16, 0.16 + rand() * 0.12);
  let moonNameIndex = 0;
  for (let i = 0; i < bodyCount; i++) {
    au *= i === 0 ? 1 : 1.42 + rand() * 0.34;
    const equilibriumK = 278 * Math.pow(totalLuminosity, 0.25) / Math.sqrt(au);
    let type = bodyClimate(equilibriumK, rand, isHome && i === 0, au, snowLine);
    if (isHome && i === 0) type = 'lush';
    const giant = type === 'gasGiant' || type === 'iceGiant';
    const seedBody = `${seed}:p:${id}:${i}`;
    const bodyRand = makeRng(seedBody);
    const radius = giant
      ? (type === 'gasGiant' ? 850000 + bodyRand() * 850000 : 620000 + bodyRand() * 520000)
      : 160000 + bodyRand() * 240000;
    const periodHours = Math.sqrt(Math.pow(au, 3) / Math.max(totalMass, 0.08)) * 365.25 * 24;
    const tidallyLocked = isHome && i === 0
      ? false
      : au < 0.12 * Math.sqrt(totalMass) || (!giant && rand() < 0.04);
    const rotationPeriodHours = tidallyLocked ? periodHours : giant ? 8 + rand() * 10 : 11 + rand() * 61;
    const bodyId = `planet-${i}`;
    const orbit = {
      semiMajorAU: au,
      renderRadius: Math.min(6e7 * Math.pow(1.68, i) * (0.9 + rand() * 0.2), 1.6e9),
      periodHours, eccentricity: rand() * (i === 0 ? 0.04 : 0.08),
      inclination: (rand() - 0.5) * 0.14, ascendingNode: rand() * TAU, phase: rand(),
    };
    const n = names.bodies[i];
    const spec = {
      bodyId, parentId: null, host: starCount === 2 ? 'AB' : 'A', seed: seedBody,
      name: n.displayName, properName: n.zh, latinName: n.latin, nameSourceCategory: n.sourceCategory,
      catalogName: `${baseName}${starCount === 2 ? ' (AB)' : ''} ${String.fromCharCode(98 + i)}`,
      type, isMoon: false, radius, orbitIndex: i, orbit,
      equilibriumK, axialTilt: giant ? rand() * 0.18 : rand() * 0.72,
      atmosphere: atmosphereFor(type, bodyRand),
      rotationPeriodHours, rotationPhase: rand(), tidallyLocked,
      massEarth: giant ? 18 + rand() * 220 : 0.35 + rand() * 5.8,
      landable: !giant,
    };
    attachPlanetaryEnvironment(spec);
    bodies.push(spec);

    const moonMax = giant ? 2 + Math.floor(rand() * 3) : radius > 230000 && rand() < 0.38 ? 1 : 0;
    for (let m = 0; m < moonMax; m++) {
      const moonSeed = `${seed}:m:${id}:${i}:${m}`;
      const moonRng = makeRng(moonSeed);
      const moonRadius = giant ? 36000 + moonRng() * 110000 : 28000 + moonRng() * 72000;
      const moonOrbitRadius = radius * (3.2 + m * 1.55 + rand() * 1.15);
      const moonPeriod = 34 + Math.pow(moonOrbitRadius / Math.max(radius, 1), 1.5) * 9;
      const mn = names.moons[moonNameIndex++ % names.moons.length];
      const moonType = equilibriumK < 215 ? 'ice' : (rand() < 0.58 ? 'barren' : 'exotic');
      const moonSpec = {
        bodyId: `${bodyId}-moon-${m}`, parentId: bodyId, host: bodyId, seed: moonSeed,
        name: mn.displayName, properName: mn.zh, latinName: mn.latin, nameSourceCategory: mn.sourceCategory,
        catalogName: `${n.zh} ${ROMAN[m] || m + 1}`,
        type: moonType,
        isMoon: true, radius: moonRadius, orbitIndex: i,
        orbit: { renderRadius: moonOrbitRadius, periodHours: moonPeriod, eccentricity: rand() * 0.06,
          inclination: (rand() - 0.5) * 0.18, ascendingNode: rand() * TAU, phase: rand(), semiMajorAU: 0 },
        equilibriumK, atmosphere: atmosphereFor(moonType, moonRng), axialTilt: rand() * 0.08, rotationPeriodHours: moonPeriod,
        rotationPhase: rand(), tidallyLocked: true, massEarth: 0.01 + rand() * 0.12, landable: true,
      };
      attachPlanetaryEnvironment(moonSpec);
      bodies.push(moonSpec);
    }
  }
  return {
    generationVersion: GENERATION_VERSION, systemId: id,
    name: names.system.displayName, properName: baseName, latinName: names.system.latin,
    nameSourceCategory: names.system.sourceCategory,
    catalogId: names.system.catalogId, isHome, stars, binaryOrbit, bodies,
    compactObjects: [],
    habitableZoneAU: [0.95 * Math.sqrt(totalLuminosity), 1.67 * Math.sqrt(totalLuminosity)], snowLineAU: snowLine,
  };
}

export class CelestialClock {
  constructor(seed, { initialHours = null, persist = true, frozen = false } = {}) {
    this.seed = seed; this.persist = persist; this.frozen = frozen; this.scale = TIME_SCALE;
    this.key = `astral-frontier:${GENERATION_VERSION}:${seed}:clock`;
    let saved = null;
    if (persist && typeof localStorage !== 'undefined') saved = Number(localStorage.getItem(this.key));
    this.hours = Number.isFinite(initialHours) ? initialHours : Number.isFinite(saved) ? saved : 0;
    this._saveAcc = 0;
  }
  update(realSeconds, active = true) {
    if (!this.frozen && active) this.hours += realSeconds * this.scale / 3600;
    this._saveAcc += realSeconds;
    if (this._saveAcc > 2) { this._saveAcc = 0; this.save(); }
    return this.hours;
  }
  set(hours) { this.hours = Number(hours) || 0; this.save(); return this.hours; }
  advance(hours) { this.hours += Number(hours) || 0; this.save(); return this.hours; }
  save() { if (this.persist && typeof localStorage !== 'undefined') localStorage.setItem(this.key, String(this.hours)); }
  snapshot() { return { hours: this.hours, scale: this.scale, frozen: this.frozen, generationVersion: GENERATION_VERSION }; }
}

export class BodyFrame {
  constructor(spec) { this.spec = spec; this.position = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.orientation = new THREE.Quaternion(); }
  update(timeHours, parentPosition = null, parentVelocity = null) {
    orbitalPosition(this.spec.orbit, timeHours, this.position);
    orbitalVelocity(this.spec.orbit, timeHours, this.velocity);
    if (parentPosition) this.position.add(parentPosition);
    if (parentVelocity) this.velocity.add(parentVelocity);
    orientationAt(this.spec, timeHours, this.orientation);
    return this;
  }
  localToWorld(local, out = new THREE.Vector3()) { return out.copy(local).applyQuaternion(this.orientation).add(this.position); }
  worldToLocal(world, out = new THREE.Vector3()) { return out.copy(world).sub(this.position).applyQuaternion(this.orientation.clone().invert()); }
}

export function stellarIrradiance(stars, bodyPosition) {
  let total = 0;
  for (const star of stars) {
    const d2 = Math.max(1, star.position.distanceToSquared(bodyPosition));
    total += star.luminositySolar / d2;
  }
  return total;
}

export function eclipseFraction(observer, lightPos, lightRadius, blockers) {
  const toLight = new THREE.Vector3().subVectors(lightPos, observer);
  const lightDistance = toLight.length();
  const lightAngular = Math.asin(Math.min(1, lightRadius / lightDistance));
  let visible = 1;
  for (const blocker of blockers) {
    const toBlocker = new THREE.Vector3().subVectors(blocker.position, observer);
    const distance = toBlocker.length();
    if (distance >= lightDistance) continue;
    const separation = toBlocker.angleTo(toLight);
    const angular = Math.asin(Math.min(1, blocker.radius / distance));
    const overlap = smoothstep(lightAngular + angular, Math.abs(lightAngular - angular), separation);
    visible *= 1 - overlap * Math.min(1, angular * angular / Math.max(lightAngular * lightAngular, 1e-8));
  }
  return Math.max(0, Math.min(1, visible));
}

export function hashSpec(spec) { return strHash32(JSON.stringify(spec)); }
