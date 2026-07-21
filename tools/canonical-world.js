import { createHash } from 'node:crypto';
import * as THREE from 'three';
import {
  COMPACT_OBJECTS_VERSION,
  GENERATION_VERSION,
  generateSystemSpec,
} from '../src/astronomy.js';
import {
  GALAXY_LAYOUT_VERSION,
  GalaxyCatalog,
  HOME_SYSTEM_ID,
} from '../src/galaxy-layout.js';
import { buildCivilizationSites, CIVILIZATION_VERSION } from '../src/civilization.js';
import { buildGalaxyCatalogDocument } from './galaxy-catalog.js';
import { Planet } from '../src/planet.js';
import {
  ACTIVE_GALAXY_ID,
  WORLD_CONFIG,
  getGalaxyConfig,
  resolveBodyTuning,
} from '../src/world-config.js';

export const CANONICAL_WORLD_SCHEMA_VERSION = 2;
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
    formation: body.formation,
    ringSystem: body.ringSystem,
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

function buildNeighborhoodProfile(seed, catalog) {
  const home = catalog.getSystem(HOME_SYSTEM_ID);
  const cells = catalog.nearestSystems(home.positionCells, 64);
  const spectralClasses = {};
  const primaryBodyTypes = {};
  let binaries = 0;
  let moons = 0;
  let landableBodies = 0;

  for (const cell of cells) {
    const system = generateSystemSpec(seed, cell);
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
    sampleRule: '64 nearest records in the finite 1,024-system catalogue',
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
    formation: body.formation,
    ringSystem: body.ringSystem,
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
  const catalog = new GalaxyCatalog(galaxy.seed);
  const homeRecord = catalog.getSystem(HOME_SYSTEM_ID);
  const homeSystem = generateSystemSpec(galaxy.seed, homeRecord);
  const blackHoleDestination = { ...galaxy.blackHoleSystem, kind: 'blackHole' };
  const blackHoleSystem = generateSystemSpec(galaxy.seed, blackHoleDestination);
  const nearbyRecords = catalog.nearestSystems(homeRecord.positionCells, 19)
    .filter((record) => record.id !== HOME_SYSTEM_ID).slice(0, 18);
  const nearbySystems = nearbyRecords.map((cell) => (
    summarizeNearbySystem({ ...cell, distanceCells: Math.hypot(
      cell.positionCells[0] - homeRecord.positionCells[0],
      cell.positionCells[1] - homeRecord.positionCells[1],
      cell.positionCells[2] - homeRecord.positionCells[2],
    ) }, generateSystemSpec(galaxy.seed, cell))
  ));
  const catalogDocument = buildGalaxyCatalogDocument(galaxyId);
  const civilizationSites = buildCivilizationSites(galaxy.seed, catalog);

  const content = {
    schemaVersion: CANONICAL_WORLD_SCHEMA_VERSION,
    kind: 'deep-space-canonical-universe-lock',
    contract: {
      purpose: 'Human-readable compatibility snapshot for the curated release universe.',
      runtimeAuthority: 'src/world-config.js plus deterministic generators',
      scope: 'Complete finite catalogue summary, home system, authored destinations, 18 nearest systems, 64-system profile, civilization sites, and surface sentinels.',
      infiniteUniverse: false,
      finiteSystemCount: 1024,
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
      civilization: CIVILIZATION_VERSION,
    },
    authoredConfig: {
      blackHoleSystem: jsonClone(galaxy.blackHoleSystem),
      bodyTuning: jsonClone(galaxy.bodyTuning),
    },
    finiteCatalog: {
      fingerprintSha256: catalogDocument.fingerprintSha256,
      morphology: jsonClone(galaxy.morphology),
      systems: catalogDocument.systems.map((record) => ({
        id: record.id, positionCells: record.positionCells, region: record.region,
        stellarSeed: record.stellarSeed, formation: record.formation,
        civilizationTag: record.civilizationTag,
      })),
    },
    homeSystem: summarizeHomeSystem(homeSystem),
    specialDestinations: [summarizeBlackHoleSystem(blackHoleSystem, galaxy.blackHoleSystem)],
    civilizationSites,
    nearbySystems,
    neighborhoodProfile: buildNeighborhoodProfile(galaxy.seed, catalog),
    homeSurfaceSentinels: buildHomeSurfaceSentinels(galaxy, homeSystem),
  };
  const fingerprintSha256 = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { ...content, fingerprintSha256 };
}
