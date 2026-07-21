// Deterministic human-frontier layer.  Artificial sites are content records,
// not renderer objects, so a save, the star map and a live system all resolve
// the same 64 inhabited systems without serialising generated geometry.

import { generateSystemSpec } from './astronomy.js';
import { GALAXY_RADIUS_CELLS, HOME_SYSTEM_ID } from './galaxy-layout.js';
import { makeRng } from './rng.js';

export const CIVILIZATION_VERSION = 1;
export const CIVILIZED_SYSTEM_COUNT = 64;

const HERO_CITY = 'hero-city-world';
const HERO_FLOAT = 'hero-floating-city';
const HUB_TYPES = ['ring-station', 'spine-dock', 'cluster-hub'];
const OUTPOST_TYPES = ['research-outpost', 'mining-outpost', 'relay-outpost'];

function distanceSq(a, b = [0, 0, 0]) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function firstBody(system, predicate) {
  return system.bodies.find((body) => !body.isMoon && predicate(body)) || null;
}

function topologySignature(seed, index, type) {
  const rand = makeRng(`${seed}:civilization:topology:v${CIVILIZATION_VERSION}:${index}:${type}`);
  return [type, ...Array.from({ length: 6 }, () => Math.floor(rand() * 97))].join('-');
}

function makeSite(seed, record, index, type, bodyId, development, role = 'frontier') {
  const rand = makeRng(`${seed}:civilization:site:v${CIVILIZATION_VERSION}:${record.id}:${type}`);
  const surface = type === HERO_CITY || type.endsWith('outpost');
  return {
    id: `CIV-${String(index + 1).padStart(3, '0')}`,
    type,
    systemId: record.id,
    bodyId,
    civilizationLevel: development,
    faction: '人类边疆共同体',
    seed: `${seed}:civilization:${record.id}:${type}`,
    moduleKit: type === HERO_CITY ? 'metropolis-v1'
      : type === HERO_FLOAT ? 'aerostat-v1'
        : HUB_TYPES.includes(type) ? 'orbital-common-v1' : 'surface-common-v1',
    anchor: surface ? 'surface' : type === HERO_FLOAT ? 'upper-atmosphere' : 'orbit',
    landingZone: {
      enabled: type === HERO_CITY || type === HERO_FLOAT || type.endsWith('outpost'),
      normal: [rand() * 2 - 1, rand() * 1.5 - 0.75, rand() * 2 - 1],
      padCount: type === HERO_CITY ? 3 : type === HERO_FLOAT ? 4 : 1,
    },
    topologySignature: topologySignature(seed, index, type),
    role,
  };
}

function chooseDistributed(records, count, seed) {
  const rand = makeRng(`${seed}:civilization:distributed:v${CIVILIZATION_VERSION}`);
  const buckets = new Map();
  for (const record of records) {
    if (!buckets.has(record.region)) buckets.set(record.region, []);
    buckets.get(record.region).push(record);
  }
  for (const list of buckets.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const regions = [...buckets.keys()];
  const result = [];
  let cursor = 0;
  while (result.length < count && regions.length) {
    const region = regions[cursor % regions.length];
    const record = buckets.get(region).pop();
    if (record) result.push(record);
    else regions.splice(cursor % regions.length, 1);
    cursor++;
  }
  return result;
}

export function buildCivilizationSites(seed, catalog) {
  const records = catalog.allSystems();
  const home = catalog.getSystem(HOME_SYSTEM_ID) || records[0];
  const nearest = catalog.nearestSystems(home.positionCells, 13).filter((record) => record.id !== home.id);
  let city = null;
  for (const record of nearest) {
    const system = generateSystemSpec(seed, record);
    const body = firstBody(system, (candidate) => candidate.landable && ['lush', 'ocean', 'desert', 'barren'].includes(candidate.type));
    if (body) { city = { record, body }; break; }
  }
  if (!city) throw new Error('No landable city-world candidate among the 12 nearest systems');

  const remote = records
    .filter((record) => Math.sqrt(distanceSq(record.positionCells)) > GALAXY_RADIUS_CELLS * 0.55)
    .sort((a, b) => distanceSq(b.positionCells) - distanceSq(a.positionCells));
  let floating = null;
  for (const record of remote) {
    const system = generateSystemSpec(seed, record);
    const body = firstBody(system, (candidate) => candidate.type === 'gasGiant');
    if (body) { floating = { record, body }; break; }
  }
  if (!floating) throw new Error('No remote gas giant candidate for the floating city');

  const reserved = new Set([home.id, city.record.id, floating.record.id]);
  const remaining = records.filter((record) => !reserved.has(record.id));
  const selected = chooseDistributed(remaining, 62, seed);
  const sites = [
    makeSite(seed, city.record, 0, HERO_CITY, city.body.bodyId, 5, 'hero'),
    makeSite(seed, floating.record, 1, HERO_FLOAT, floating.body.bodyId, 5, 'hero'),
  ];
  for (let i = 0; i < 14; i++) {
    const record = selected[i];
    sites.push(makeSite(seed, record, sites.length, HUB_TYPES[i % HUB_TYPES.length], null, 3, 'regional-hub'));
  }
  for (let i = 14; i < selected.length; i++) {
    const record = selected[i];
    const system = generateSystemSpec(seed, record);
    const body = firstBody(system, (candidate) => candidate.landable);
    const type = OUTPOST_TYPES[(i - 14) % OUTPOST_TYPES.length];
    sites.push(makeSite(seed, record, sites.length, type, body?.bodyId || null, 1 + ((i - 14) % 2), 'outpost'));
  }
  if (sites.length !== CIVILIZED_SYSTEM_COUNT) throw new Error(`Expected 64 civilization sites, got ${sites.length}`);
  return sites;
}

export function civilizationSitesForSystem(sites, systemId) {
  return sites.filter((site) => site.systemId === systemId);
}

export const CIVILIZATION_SITE_TYPES = Object.freeze({ HERO_CITY, HERO_FLOAT, HUB_TYPES, OUTPOST_TYPES });
