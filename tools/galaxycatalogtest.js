import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildGalaxyBackdrop, GalaxyCatalog, GALAXY_RADIUS_CELLS, GALAXY_SYSTEM_COUNT, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { getGalaxyConfig } from '../src/world-config.js';
import { buildGalaxyCatalogDocument, GALAXY_CATALOG_PATH } from './galaxy-catalog.js';

const galaxy = getGalaxyConfig();
const actual = buildGalaxyCatalogDocument();
const expected = JSON.parse(await readFile(GALAXY_CATALOG_PATH, 'utf8'));
assert.deepEqual(actual, expected, 'finite galaxy catalogue drifted; curate and export intentionally');
assert.equal(actual.systems.length, GALAXY_SYSTEM_COUNT);
assert.equal(new Set(actual.systems.map((system) => system.id)).size, GALAXY_SYSTEM_COUNT);
assert.equal(actual.systems.filter((system) => system.civilizationTag).length, 64);
assert.equal(actual.civilizationSites.length, 64);
assert(actual.systems.some((system) => system.id === HOME_SYSTEM_ID && system.region === 'spur'));
assert.deepEqual(galaxy.blackHoleSystem.positionCells, [0, 0, 0]);
for (const system of actual.systems) {
  const radius = Math.hypot(system.positionCells[0], system.positionCells[2]);
  assert(radius <= GALAXY_RADIUS_CELLS * 1.1, `${system.id} escaped the finite galaxy boundary`);
}
const catalog = new GalaxyCatalog(galaxy.seed);
assert.equal(catalog.getSystem(HOME_SYSTEM_ID).id, HOME_SYSTEM_ID);
assert.equal(catalog.nearestSystems(catalog.getSystem(HOME_SYSTEM_ID).positionCells, 18).length, 18);
assert(catalog.systemsWithin([0, 0, 0], GALAXY_RADIUS_CELLS).length > 900);
const backdrop = buildGalaxyBackdrop(galaxy.seed, 2048, catalog.allSystems());
for (let i = 0; i < backdrop.length; i += 3) {
  let nearestSq = Infinity;
  for (const system of catalog.allSystems()) {
    const dx = backdrop[i] - system.positionCells[0];
    const dy = backdrop[i + 1] - system.positionCells[1];
    const dz = backdrop[i + 2] - system.positionCells[2];
    nearestSq = Math.min(nearestSq, dx * dx + dy * dy + dz * dz);
  }
  assert(nearestSq < 64,
    'decorative galaxy light escaped every real catalogue arm');
}
console.log(`PASS: finite ${galaxy.name} catalogue ${actual.fingerprintSha256} (${GALAXY_SYSTEM_COUNT} systems)`);
