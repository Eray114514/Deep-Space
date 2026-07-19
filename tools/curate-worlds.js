// Reproducible developer-only universe shortlist.
//
// This does not declare a winner by itself. It cheaply rejects weak seeds by
// inspecting their deterministic astronomy, then the top candidates still go
// through the browser capture and traversal pass in tools/explore.js.

import { generateSystemSpec } from '../src/astronomy.js';
import { hash3i, hashFloat, makeRng, strHash32 } from '../src/rng.js';
import { makeWord } from '../src/names.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig } from '../src/world-config.js';

const STAR_PROBABILITY = 0.42;
const galaxyArg = process.argv.find((arg) => arg.startsWith('--galaxy='));
const galaxy = getGalaxyConfig(galaxyArg?.split('=')[1] || ACTIVE_GALAXY_ID);
const CANDIDATE_STREAM = `DEEP-SPACE-CURATION-V1:${galaxy.id}`;
const countArg = process.argv.find((arg) => arg.startsWith('--count='));
const topArg = process.argv.find((arg) => arg.startsWith('--top='));
const candidateCount = Math.max(1, Number(countArg?.split('=')[1]) || 512);
const topCount = Math.max(1, Number(topArg?.split('=')[1]) || 12);

function nearbySystemIds(seed, limit = 18) {
  const galaxySeed = strHash32(`${seed}:galaxy`);
  const cells = [];
  for (let y = -2; y <= 2; y++) {
    for (let z = -5; z <= 5; z++) {
      for (let x = -5; x <= 5; x++) {
        if (x === 0 && y === 0 && z === 0) continue;
        const h = hash3i(x, y, z, galaxySeed);
        if (hashFloat(h, 0) > STAR_PROBABILITY) continue;
        const px = x + 0.12 + hashFloat(h, 0) * 0.76;
        const py = (y + 0.12 + hashFloat(h, 1) * 0.76) * 0.5;
        const pz = z + 0.12 + hashFloat(h, 2) * 0.76;
        cells.push({ id: `${x},${y},${z}`, distance: Math.hypot(px, py, pz) });
      }
    }
  }
  return cells.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

function scoreSeed(seed) {
  const home = generateSystemSpec(seed, '0,0,0');
  const planets = home.bodies.filter((body) => !body.parentId);
  const moons = home.bodies.filter((body) => body.parentId);
  const landable = home.bodies.filter((body) => body.landable !== false);
  const homeTypes = new Set(planets.map((body) => body.type));
  const landableTypes = new Set(landable.map((body) => body.type));
  const firstTypes = new Set(planets.slice(0, 4).map((body) => body.type));
  const typeCounts = new Map();
  for (const body of planets) typeCounts.set(body.type, (typeCounts.get(body.type) || 0) + 1);

  let score = homeTypes.size * 5 + landableTypes.size * 2 + firstTypes.size * 3;
  score += Math.min(moons.length, 6) * 1.5;
  score += Math.min(Math.max(planets.length - 6, 0), 4) * 1.5;
  score += home.stars.length === 2 ? 5 : 0;

  const bonuses = {
    ocean: 10,
    exotic: 8,
    toxic: 5,
    lava: 6,
    gasGiant: 8,
    iceGiant: 7,
  };
  for (const [type, bonus] of Object.entries(bonuses)) {
    if (homeTypes.has(type)) score += bonus;
  }
  if ((homeTypes.has('gasGiant') || homeTypes.has('iceGiant')) && moons.length > 0) score += 5;
  for (const count of typeCounts.values()) score -= Math.max(0, count - 2) * 3;

  const nearby = nearbySystemIds(seed);
  const nearbyTypes = new Set();
  let nearbyBinaries = 0;
  let nearbySpecials = 0;
  for (const cell of nearby) {
    const system = generateSystemSpec(seed, cell.id);
    if (system.stars.length === 2) nearbyBinaries++;
    for (const body of system.bodies) {
      nearbyTypes.add(body.type);
      if (['ocean', 'exotic', 'toxic', 'lava'].includes(body.type)) nearbySpecials++;
    }
  }
  score += nearbyTypes.size * 0.75;
  score += Math.min(nearbyBinaries, 6) * 0.5;
  score += Math.min(nearbySpecials, 18) * 0.2;

  return {
    seed,
    score: Math.round(score * 10) / 10,
    home: home.properName,
    stars: home.stars.map((star) => star.spectralClass).join(' + '),
    planets: planets.length,
    moons: moons.length,
    types: [...homeTypes],
    nearbyTypes: [...nearbyTypes].length,
  };
}

const candidateRng = makeRng(CANDIDATE_STREAM);
const seeds = new Set([galaxy.seed, 'EUCLID', 'ATLAS-7', 'VOYAGER-3']);
while (seeds.size < candidateCount) {
  seeds.add(`${makeWord(candidateRng, 2, 3).toUpperCase()}-${Math.floor(candidateRng() * 1000).toString().padStart(3, '0')}`);
}

const ranked = [...seeds].map(scoreSeed).sort((a, b) => b.score - a.score || a.seed.localeCompare(b.seed));
console.table(ranked.slice(0, topCount));
console.log(`\nCurated ${ranked.length} deterministic candidates for ${galaxy.name} with stream ${CANDIDATE_STREAM}.`);
console.log('Static scores are a filter only; capture and play the finalists before changing the canonical seed.');
