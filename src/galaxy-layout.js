// Finite, deterministic barred-spiral galaxy catalogue. Runtime, curation
// tools and compatibility locks all call this module so the 1,024 reachable
// systems are a content contract rather than an open-ended lattice.

import { makeRng } from './rng.js';

export const GALAXY_LAYOUT_VERSION = 2;
export const GALAXY_SYSTEM_COUNT = 1024;
export const CELL = 4e9;
export const GALAXY_RADIUS_CELLS = 52;
export const HOME_SYSTEM_ID = '0,0,0';

const REGION_COUNTS = Object.freeze({
  bulge: 110,
  bar: 130,
  'major-arm': 420,
  'minor-arm': 180,
  spur: 120,
  disk: 48,
  halo: 16,
});

const REGION_PROFILE = Object.freeze({
  bulge: { age: [8.5, 12.8], metallicity: [-0.15, 0.35] },
  bar: { age: [6.2, 11.8], metallicity: [-0.08, 0.4] },
  'major-arm': { age: [0.4, 8.2], metallicity: [-0.35, 0.28] },
  'minor-arm': { age: [1.2, 9.4], metallicity: [-0.45, 0.18] },
  spur: { age: [1.8, 9.8], metallicity: [-0.28, 0.2] },
  disk: { age: [3.0, 11.5], metallicity: [-0.65, 0.12] },
  halo: { age: [10.2, 13.4], metallicity: [-1.8, -0.45] },
});

function lerp(a, b, t) { return a + (b - a) * t; }
function rounded(value, digits) { const result = Number(value.toFixed(digits)); return Object.is(result, -0) ? 0 : result; }
function signed(rand) { return rand() * 2 - 1; }
function bell(rand) { return (rand() + rand() + rand() + rand() - 2) * 0.72; }

function rotateXZ(x, z, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x * c - z * s, x * s + z * c];
}

function spiralPoint(rand, armIndex, armCount, {
  inner = 0.2,
  outer = 0.98,
  pitch = 0.205,
  phase = 0,
  width = 0.035,
  yScale = 0.014,
} = {}) {
  const radialT = Math.pow(rand(), 0.82);
  const r = lerp(inner, outer, radialT) * GALAXY_RADIUS_CELLS;
  const base = phase + armIndex * Math.PI * 2 / armCount;
  const theta = base + Math.log(r / (inner * GALAXY_RADIUS_CELLS)) / Math.tan(pitch);
  const lateral = bell(rand) * width * GALAXY_RADIUS_CELLS * (0.45 + radialT * 0.85);
  return [
    Math.cos(theta) * r - Math.sin(theta) * lateral,
    bell(rand) * yScale * GALAXY_RADIUS_CELLS,
    Math.sin(theta) * r + Math.cos(theta) * lateral,
  ];
}

function regionPosition(rand, region, index) {
  if (region === 'bulge') {
    const r = Math.pow(rand(), 1.7) * GALAXY_RADIUS_CELLS * 0.18;
    const theta = rand() * Math.PI * 2;
    return [Math.cos(theta) * r, bell(rand) * GALAXY_RADIUS_CELLS * 0.055, Math.sin(theta) * r * 0.78];
  }
  if (region === 'bar') {
    const along = signed(rand) * GALAXY_RADIUS_CELLS * 0.3;
    const across = bell(rand) * GALAXY_RADIUS_CELLS * 0.035 * (1 - Math.abs(along) / (GALAXY_RADIUS_CELLS * 0.38));
    const [x, z] = rotateXZ(along, across, 0.42);
    return [x, bell(rand) * GALAXY_RADIUS_CELLS * 0.025, z];
  }
  if (region === 'major-arm') {
    return spiralPoint(rand, index % 2, 2, { phase: 0.42, pitch: 0.205, width: 0.032 });
  }
  if (region === 'minor-arm') {
    return spiralPoint(rand, index % 2, 2, { inner: 0.29, outer: 0.92, phase: 0.42 + Math.PI / 2, pitch: 0.225, width: 0.026 });
  }
  if (region === 'spur') {
    const local = spiralPoint(rand, 0, 1, { inner: 0.5, outer: 0.72, phase: 3.3, pitch: 0.19, width: 0.018, yScale: 0.009 });
    local[0] += signed(rand) * GALAXY_RADIUS_CELLS * 0.014;
    local[2] += signed(rand) * GALAXY_RADIUS_CELLS * 0.014;
    return local;
  }
  if (region === 'disk') {
    const r = Math.sqrt(rand()) * GALAXY_RADIUS_CELLS;
    const theta = rand() * Math.PI * 2;
    return [Math.cos(theta) * r, bell(rand) * GALAXY_RADIUS_CELLS * 0.04, Math.sin(theta) * r];
  }
  const radius = Math.pow(rand(), 0.55) * GALAXY_RADIUS_CELLS * 1.08;
  const y = signed(rand) * radius * 0.62;
  const flatRadius = Math.sqrt(Math.max(0, radius * radius - y * y));
  const theta = rand() * Math.PI * 2;
  return [Math.cos(theta) * flatRadius, y, Math.sin(theta) * flatRadius];
}

function formationRecord(rand, region) {
  const profile = REGION_PROFILE[region];
  const ageGyr = lerp(profile.age[0], profile.age[1], rand());
  const metallicity = lerp(profile.metallicity[0], profile.metallicity[1], rand());
  const starFormation = region === 'major-arm' || region === 'minor-arm'
    ? lerp(0.55, 1, rand())
    : region === 'spur' ? lerp(0.38, 0.78, rand())
      : region === 'halo' ? lerp(0.01, 0.08, rand()) : lerp(0.08, 0.42, rand());
  return {
    ageGyr: rounded(ageGyr, 3),
    metallicity: rounded(metallicity, 4),
    starFormation: rounded(starFormation, 4),
  };
}

function recordId(index) {
  return index === 0 ? HOME_SYSTEM_ID : `MW-${String(index).padStart(4, '0')}`;
}

export function buildGalaxyCatalog(seed, { systemCount = GALAXY_SYSTEM_COUNT } = {}) {
  if (systemCount !== GALAXY_SYSTEM_COUNT) {
    throw new Error(`The curated Milky Way contract requires exactly ${GALAXY_SYSTEM_COUNT} systems`);
  }
  const rand = makeRng(`${seed}:finite-galaxy:v${GALAXY_LAYOUT_VERSION}`);
  const records = [];
  let globalIndex = 0;
  for (const [region, count] of Object.entries(REGION_COUNTS)) {
    for (let regionIndex = 0; regionIndex < count; regionIndex++) {
      const id = recordId(globalIndex);
      let positionCells = regionPosition(rand, region, regionIndex);
      if (id === HOME_SYSTEM_ID) {
        // The home system sits in an Orion-like spur, not in the old lattice
        // origin. The stable ID remains for body tuning and debug tooling.
        positionCells = regionPosition(makeRng(`${seed}:home-position:v2`), 'spur', 0);
      }
      const formation = formationRecord(rand, id === HOME_SYSTEM_ID ? 'spur' : region);
      records.push({
        id,
        index: globalIndex,
        region: id === HOME_SYSTEM_ID ? 'spur' : region,
        positionCells: positionCells.map((value) => rounded(value, 6)),
        stellarSeed: `${seed}:star:${id}`,
        formation,
      });
      globalIndex++;
    }
  }
  return records;
}

const BACKDROP_SPREAD = Object.freeze({
  bulge: [0.72, 0.38],
  bar: [0.46, 0.24],
  'major-arm': [0.36, 0.16],
  'minor-arm': [0.32, 0.14],
  spur: [0.22, 0.1],
  disk: [1.15, 0.52],
  halo: [2.5, 1.9],
});

// Decorative light follows the committed systems instead of rolling a second
// independent galaxy. Every luminous clump is therefore supported by a real,
// selectable catalogue destination; small seeded scatter only fills the gaps
// between the 1,024 navigation points.
export function buildGalaxyBackdrop(seed, count = 20000, records = buildGalaxyCatalog(seed)) {
  const rand = makeRng(`${seed}:galaxy-backdrop:catalog-v1`);
  const byRegion = new Map();
  for (const record of records) {
    if (!byRegion.has(record.region)) byRegion.set(record.region, []);
    byRegion.get(record.region).push(record);
  }
  const neighbors = new Map(records.map((anchor) => {
    const nearest = byRegion.get(anchor.region)
      .filter((candidate) => candidate !== anchor)
      .sort((a, b) => {
        const adx = a.positionCells[0] - anchor.positionCells[0];
        const ady = a.positionCells[1] - anchor.positionCells[1];
        const adz = a.positionCells[2] - anchor.positionCells[2];
        const bdx = b.positionCells[0] - anchor.positionCells[0];
        const bdy = b.positionCells[1] - anchor.positionCells[1];
        const bdz = b.positionCells[2] - anchor.positionCells[2];
        return adx * adx + ady * ady + adz * adz - (bdx * bdx + bdy * bdy + bdz * bdz);
      })
      .slice(0, 4);
    return [anchor.id, nearest];
  }));
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const anchor = records[Math.floor(rand() * records.length)];
    const nearby = neighbors.get(anchor.id);
    const bridge = anchor.region === 'halo' || !nearby.length
      ? anchor : nearby[Math.floor(rand() * nearby.length)];
    const along = bridge === anchor ? 0 : rand();
    const [planar, vertical] = BACKDROP_SPREAD[anchor.region] || BACKDROP_SPREAD.disk;
    positions[i * 3] = lerp(anchor.positionCells[0], bridge.positionCells[0], along) + bell(rand) * planar;
    positions[i * 3 + 1] = lerp(anchor.positionCells[1], bridge.positionCells[1], along) + bell(rand) * vertical;
    positions[i * 3 + 2] = lerp(anchor.positionCells[2], bridge.positionCells[2], along) + bell(rand) * planar;
  }
  return positions;
}

function xyz(value) {
  if (Array.isArray(value)) return value;
  return [value?.x || 0, value?.y || 0, value?.z || 0];
}

function distanceSq(a, b) {
  const aa = xyz(a), bb = xyz(b);
  const dx = aa[0] - bb[0], dy = aa[1] - bb[1], dz = aa[2] - bb[2];
  return dx * dx + dy * dy + dz * dz;
}

export class GalaxyCatalog {
  constructor(seed, records = buildGalaxyCatalog(seed)) {
    this.seed = seed;
    this.records = records;
    this.byId = new Map(records.map((record) => [record.id, record]));
  }

  getSystem(id) { return this.byId.get(id) || null; }
  allSystems() { return this.records; }

  nearestSystems(positionCells, limit = 18) {
    return [...this.records]
      .sort((a, b) => distanceSq(a.positionCells, positionCells) - distanceSq(b.positionCells, positionCells)
        || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, limit));
  }

  systemsWithin(positionCells, radiusCells) {
    const radiusSq = radiusCells * radiusCells;
    return this.records.filter((record) => distanceSq(record.positionCells, positionCells) <= radiusSq);
  }
}

export function galaxySystemById(seed, id) {
  return new GalaxyCatalog(seed).getSystem(id);
}

export function nearbyGalaxyCells(seed, {
  limit = 18,
  centerId = HOME_SYSTEM_ID,
} = {}) {
  const catalog = new GalaxyCatalog(seed);
  const center = catalog.getSystem(centerId) || catalog.records[0];
  return catalog.nearestSystems(center.positionCells, limit + 1)
    .filter((record) => record.id !== center.id)
    .slice(0, limit)
    .map((record) => ({
      ...record,
      distanceCells: Math.sqrt(distanceSq(record.positionCells, center.positionCells)),
    }));
}
