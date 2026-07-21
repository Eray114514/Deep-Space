import { createHash } from 'node:crypto';
import { buildGalaxyCatalog, GALAXY_LAYOUT_VERSION, GALAXY_RADIUS_CELLS,
  GALAXY_SYSTEM_COUNT, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig } from '../src/world-config.js';
import { buildCivilizationSites, CIVILIZATION_VERSION } from '../src/civilization.js';
import { GalaxyCatalog } from '../src/galaxy-layout.js';

export const GALAXY_CATALOG_SCHEMA_VERSION = 1;
export const GALAXY_CATALOG_PATH = 'worlds/milky-way.catalog.json';

export function buildGalaxyCatalogDocument(galaxyId = ACTIVE_GALAXY_ID) {
  const galaxy = getGalaxyConfig(galaxyId);
  const rawSystems = buildGalaxyCatalog(galaxy.seed);
  const catalog = new GalaxyCatalog(galaxy.seed, rawSystems);
  const civilizationSites = buildCivilizationSites(galaxy.seed, catalog);
  const civilizationBySystem = new Map(civilizationSites.map((site) => [site.systemId, site.type]));
  const systems = rawSystems.map((record) => ({
    ...record,
    civilizationTag: civilizationBySystem.get(record.id) || null,
  }));
  const content = {
    schemaVersion: GALAXY_CATALOG_SCHEMA_VERSION,
    kind: 'deep-space-finite-galaxy-catalog',
    identity: {
      galaxyId: galaxy.id,
      name: galaxy.name,
      seed: galaxy.seed,
      catalogVersion: galaxy.catalogVersion,
    },
    contract: {
      finite: true,
      reachableSystemCount: GALAXY_SYSTEM_COUNT,
      homeSystemId: HOME_SYSTEM_ID,
      radiusCells: GALAXY_RADIUS_CELLS,
      layoutVersion: GALAXY_LAYOUT_VERSION,
      civilizationVersion: CIVILIZATION_VERSION,
    },
    morphology: galaxy.morphology,
    centralBlackHole: galaxy.blackHoleSystem,
    civilizationSites,
    systems,
  };
  const fingerprintSha256 = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { ...content, fingerprintSha256 };
}
