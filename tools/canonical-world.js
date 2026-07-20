import { createHash } from 'node:crypto';
import * as THREE from 'three';
import {
  COMPACT_OBJECTS_VERSION,
  GENERATION_VERSION,
  generateSystemSpec,
} from '../src/astronomy.js';
import {
  GALAXY_LAYOUT_VERSION,
  nearbyGalaxyCells,
} from '../src/galaxy-layout.js';
import { Planet } from '../src/planet.js';
import {
  ACTIVE_GALAXY_ID,
  WORLD_CONFIG,
  getGalaxyConfig,
  resolveBodyTuning,
} from '../src/world-config.js';

export const CANONICAL_WORLD_SCHEMA_VERSION = 1;
export const CANONICAL_WORLD_LOCK = 'worlds/milky-way.lock.json';

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function summarizeStar(star) {
  return {
    starId: star.starId,
    displayName: star.displayName,
    spectralClass: star.spectralClass,
    massSolar: star.massSolar,
    radiusSolar: star.radiusSolar,
    temperatureK: star.temperatureK,
    luminositySolar: star.luminositySolar,
    color: star.color,
    orbit: star.orbit || null,
  };
}

function summarizeBody(body) {
  return {
    bodyId: body.bodyId,
    parentId: body.parentId,
    properName: body.properName,
    catalogName: body.catalogName,
    type: body.type,
    radius: body.radius,
    massEarth: body.massEarth,
    equilibriumK: body.equilibriumK,
    landable: body.landable,
    tidallyLocked: body.tidallyLocked,
    rotationPeriodHours: body.rotationPeriodHours,
    orbit: body.orbit,
    atmosphere: body.atmosphere,
    magnetosphere: body.magnetosphere,
    clouds: body.clouds,
  };
}

function summarizeHomeSystem(system) {
  return {
    systemId: system.systemId,
    properName: system.properName,
    latinName: system.latinName,
    catalogId: system.catalogId,
    stars: system.stars.map(summarizeStar),
    binaryOrbit: system.binaryOrbit,
    habitableZoneAU: system.habitableZoneAU,
    snowLineAU: system.snowLineAU,
    bodies: system.bodies.map(summarizeBody),
  };
}

function summarizeNearbySystem(cell, system) {
  const primaryBodies = system.bodies.filter((body) => !body.isMoon);
  const moons = system.bodies.filter((body) => body.isMoon);
  return {
    systemId: system.systemId,
    positionCells: cell.positionCells,
    distanceCells: cell.distanceCells,
    properName: system.properName,
    catalogId: system.catalogId,
    spectralClasses: system.stars.map((star) => star.spectralClass),
    binary: system.stars.length > 1,
    primaryBodyCount: primaryBodies.length,
    moonCount: moons.length,
    primaryBodyTypes: primaryBodies.map((body) => body.type),
    notableBodies: primaryBodies
      .filter((body) => ['ocean', 'toxic', 'lava', 'exotic', 'gasGiant', 'iceGiant'].includes(body.type))
      .map((body) => ({ bodyId: body.bodyId, properName: body.properName, type: body.type })),
  };
}

function summarizeBlackHoleSystem(system, destination) {
  const blackHole = system.compactObjects[0];
  return {
    destination: jsonClone(destination),
    systemId: system.systemId,
    properName: system.properName,
    catalogId: system.catalogId,
    centralObject: {
      bodyId: blackHole.bodyId,
      properName: blackHole.properName,
      massEarth: blackHole.massEarth,
      radius: blackHole.radius,
      accretionRadius: blackHole.accretionRadius,
      axialTilt: blackHole.axialTilt,
      blackHole: blackHole.blackHole,
    },
    capturedStars: system.stars.map(summarizeStar),
  };
}

function buildNeighborhoodProfile(seed) {
  const cells = nearbyGalaxyCells(seed, { limit: 64, xzRadius: 8, yRadius: 3 });
  const spectralClasses = {};
  const primaryBodyTypes = {};
  let binaries = 0;
  let moons = 0;
  let landableBodies = 0;

  for (const cell of cells) {
    const system = generateSystemSpec(seed, cell.id);
    if (system.stars.length > 1) binaries++;
    for (const star of system.stars) {
      spectralClasses[star.spectralClass] = (spectralClasses[star.spectralClass] || 0) + 1;
    }
    for (const body of system.bodies) {
      if (body.isMoon) moons++;
      else primaryBodyTypes[body.type] = (primaryBodyTypes[body.type] || 0) + 1;
      if (body.landable) landableBodies++;
    }
  }

  return {
    sampleRule: '64 nearest generated cells inside xzRadius=8, yRadius=3',
    sampledSystems: cells.length,
    binaries,
    moons,
    landableBodies,
    spectralClasses,
    primaryBodyTypes,
  };
}

function buildHomeSurfaceSentinels(galaxy, homeSystem) {
  const body = homeSystem.bodies.find((candidate) => candidate.bodyId === 'planet-0');
  if (!body) throw new Error('Canonical home system has no planet-0. Re-curation is required.');
  const tuning = resolveBodyTuning({
    galaxyId: galaxy.id,
    seed: galaxy.seed,
    systemId: homeSystem.systemId,
    bodyId: body.bodyId,
  });
  const planet = new Planet({
    seed: body.seed,
    name: body.name,
    posUniv: new THREE.Vector3(),
    type: body.type,
    isMoon: body.isMoon,
    radius: body.radius,
    atmosphere: body.atmosphere,
    clouds: body.clouds,
    tuning,
  });
  const directions = [
    ['positiveX', new THREE.Vector3(1, 0, 0)],
    ['positiveY', new THREE.Vector3(0, 1, 0)],
    ['positiveZ', new THREE.Vector3(0, 0, 1)],
    ['diagonalXYZ', new THREE.Vector3(1, 1, 1).normalize()],
  ];
  const surface = {
    systemId: homeSystem.systemId,
    bodyId: body.bodyId,
    tuning,
    naturalSeaLevel: planet.naturalSeaLevel,
    tunedSeaLevel: planet.seaLevel,
    cloudCoverage: planet.cloudCoverage,
    hasRing: Boolean(planet.ringMesh),
    mountMaskLo: planet.mountMaskLo,
    heightSamples: Object.fromEntries(directions.map(([name, direction]) => [
      name,
      planet.height(direction, planet.fullMaxFreq),
    ])),
  };
  planet.dispose();
  return surface;
}

export function buildCanonicalWorldLock(galaxyId = ACTIVE_GALAXY_ID) {
  const galaxy = getGalaxyConfig(galaxyId);
  const homeSystem = generateSystemSpec(galaxy.seed, '0,0,0');
  const blackHoleDestination = { ...galaxy.blackHoleSystem, kind: 'blackHole' };
  const blackHoleSystem = generateSystemSpec(galaxy.seed, blackHoleDestination);
  const nearbySystems = nearbyGalaxyCells(galaxy.seed).map((cell) => (
    summarizeNearbySystem(cell, generateSystemSpec(galaxy.seed, cell.id))
  ));

  const content = {
    schemaVersion: CANONICAL_WORLD_SCHEMA_VERSION,
    kind: 'deep-space-canonical-universe-lock',
    contract: {
      purpose: 'Human-readable compatibility snapshot for the curated release universe.',
      runtimeAuthority: 'src/world-config.js plus deterministic generators',
      scope: 'Home system, authored destinations, 18 nearest systems, a 64-system profile, and home-surface sentinels.',
      infiniteUniverse: true,
      saveGame: false,
      regenerationPolicy: 'Do not refresh after drift unless the universe was intentionally re-curated and reviewed.',
    },
    identity: {
      worldId: WORLD_CONFIG.worldId,
      galaxyId: galaxy.id,
      galaxyName: galaxy.name,
      seed: galaxy.seed,
    },
    generatorVersions: {
      galaxyLayout: GALAXY_LAYOUT_VERSION,
      astronomy: GENERATION_VERSION,
      compactObjects: COMPACT_OBJECTS_VERSION,
    },
    authoredConfig: {
      blackHoleSystem: jsonClone(galaxy.blackHoleSystem),
      bodyTuning: jsonClone(galaxy.bodyTuning),
    },
    homeSystem: summarizeHomeSystem(homeSystem),
    specialDestinations: [summarizeBlackHoleSystem(blackHoleSystem, galaxy.blackHoleSystem)],
    nearbySystems,
    neighborhoodProfile: buildNeighborhoodProfile(galaxy.seed),
    homeSurfaceSentinels: buildHomeSurfaceSentinels(galaxy, homeSystem),
  };
  const fingerprintSha256 = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { ...content, fingerprintSha256 };
}
