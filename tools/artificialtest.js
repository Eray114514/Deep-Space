import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCivilizationSites } from '../src/civilization.js';
import { GalaxyCatalog, GALAXY_RADIUS_CELLS, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { getGalaxyConfig } from '../src/world-config.js';

const galaxy = getGalaxyConfig();
const catalog = new GalaxyCatalog(galaxy.seed);
const first = buildCivilizationSites(galaxy.seed, catalog);
const second = buildCivilizationSites(galaxy.seed, new GalaxyCatalog(galaxy.seed));
assert.deepEqual(first, second, 'civilization sites changed across reload');
assert.equal(first.length, 64);
assert.equal(new Set(first.map((site) => site.id)).size, 64);
assert.equal(new Set(first.map((site) => site.systemId)).size, 64);
assert.equal(first.filter((site) => site.role === 'hero').length, 2);
assert.equal(first.filter((site) => site.role === 'regional-hub').length, 14);
assert.equal(first.filter((site) => site.role === 'outpost').length, 48);
assert(first.every((site) => site.systemId !== HOME_SYSTEM_ID));
assert(first.every((site) => site.landingZone.normal.length === 3));
assert(new Set(first.slice(2).map((site) => site.topologySignature)).size >= 50,
  'generic sites need at least 50 unique topology signatures');
const floating = first.find((site) => site.type === 'hero-floating-city');
assert(floating && Math.hypot(...catalog.getSystem(floating.systemId).positionCells) > GALAXY_RADIUS_CELLS * 0.55);

for (const name of ['city-terminal.glb', 'aerostat-core.glb']) {
  const bytes = readFileSync(new URL(`../assets/civilization/${name}`, import.meta.url));
  assert.equal(bytes.subarray(0, 4).toString('utf8'), 'glTF', `${name} is not a binary glTF`);
  assert(bytes.length > 100_000 && bytes.length < 1_000_000, `${name} asset size is outside its shipping budget`);
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.subarray(16, 20).toString('utf8');
  assert.equal(jsonType, 'JSON', `${name} has no glTF JSON chunk`);
  const manifest = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  assert(manifest.extensionsUsed?.includes('EXT_meshopt_compression'), `${name} is not Meshopt compressed`);
}
console.log(`PASS: 64 deterministic civilization sites (${new Set(first.slice(2).map((site) => site.topologySignature)).size} generic signatures)`);
