import { mkdir, writeFile } from 'node:fs/promises';
import { buildGalaxyCatalog, GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { buildCivilizationSites } from '../src/civilization.js';
import { generateSystemSpec } from '../src/astronomy.js';
import { makeRng } from '../src/rng.js';

const count = Number(process.argv[2] || 256);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function homeTerrainTraits(body) {
  const rand = makeRng(body.seed);
  const draws = Array.from({ length: 16 }, () => rand());
  const reliefMeters = Math.min(body.radius * 0.034 * (0.85 + draws[1] * 0.5),
    7000 + draws[2] * 6000);
  const continentFrequency = 1.1 + draws[7] * 1.5;
  const mountainStrength = (0.55 + draws[9] * 0.45)
    * (0.72 + (body.formation?.tectonicActivity || 0) * 0.7);
  const plainsCalm = 0.45 + draws[13] * 0.45;
  const warpAmplitude = 0.22 + draws[14] * 0.5;
  const plateCoherence = 1 - ((continentFrequency - 1.1) / 1.5 * 0.62
    + (warpAmplitude - 0.22) / 0.5 * 0.38);
  const reliefScore = Math.min(1, reliefMeters * mountainStrength / 10500);
  const coverage = body.clouds?.coverage || 0;
  // Prefer a readable broken-cloud weather system over either a bare globe or
  // a featureless overcast. This metric only nominates the visual shortlist;
  // fixed orbit/flight/surface captures still decide the release universe.
  const cloudScore = Math.max(0, 1 - Math.abs(coverage - 0.52) / 0.38);
  return {
    plateCoherence: Number(plateCoherence.toFixed(4)),
    continentFrequency: Number(continentFrequency.toFixed(4)),
    warpAmplitude: Number(warpAmplitude.toFixed(4)),
    reliefMeters: Number(reliefMeters.toFixed(1)),
    mountainStrength: Number(mountainStrength.toFixed(4)),
    plainsCalm: Number(plainsCalm.toFixed(4)),
    cloudCoverage: Number(coverage.toFixed(4)),
    visualScore: Number((plateCoherence * 25 + reliefScore * 22 + cloudScore * 18).toFixed(4)),
  };
}

function scoreSeed(seed) {
  const records = buildGalaxyCatalog(seed);
  const catalog = new GalaxyCatalog(seed, records);
  const home = catalog.getSystem(HOME_SYSTEM_ID);
  const near = catalog.nearestSystems(home.positionCells, 19).slice(1);
  const nearestDistances = near.map((record) => distance(home.positionCells, record.positionCells));
  const minSeparation = Math.min(...nearestDistances);
  const localSpread = Math.max(...nearestDistances) - minSeparation;
  const verticalRms = Math.sqrt(records.reduce((sum, record) => sum + record.positionCells[1] ** 2, 0) / records.length);
  const homeSystem = generateSystemSpec(seed, home);
  const homeBody = homeSystem.bodies.find((body) => !body.isMoon && body.type === 'lush')
    || homeSystem.bodies.find((body) => !body.isMoon && body.landable);
  const homeTerrain = homeTerrainTraits(homeBody);
  const primaryTypes = new Set(homeSystem.bodies.filter((body) => !body.isMoon).map((body) => body.type));
  const sampleTypes = new Set();
  let rings = 0, giants = 0, landable = 0;
  for (const record of catalog.nearestSystems(home.positionCells, 64)) {
    const system = generateSystemSpec(seed, record);
    for (const body of system.bodies.filter((candidate) => !candidate.isMoon)) {
      sampleTypes.add(body.type);
      if (body.ringSystem?.present) rings++;
      if (body.type === 'gasGiant' || body.type === 'iceGiant') giants++;
      if (body.landable) landable++;
    }
  }
  const sites = buildCivilizationSites(seed, catalog);
  const city = sites.find((site) => site.type === 'hero-city-world');
  const floating = sites.find((site) => site.type === 'hero-floating-city');
  const floatingRadius = Math.hypot(...catalog.getSystem(floating.systemId).positionCells);
  const collisionPenalty = records.slice(0, 320).reduce((penalty, record, index, list) => {
    let nearest = Infinity;
    for (let j = 0; j < list.length; j++) if (j !== index) nearest = Math.min(nearest, distance(record.positionCells, list[j].positionCells));
    return penalty + Math.max(0, 0.32 - nearest) * 18;
  }, 0);
  const score = primaryTypes.size * 7 + sampleTypes.size * 9 + Math.min(18, rings) * 1.7
    + Math.min(42, giants) * 0.45 + Math.min(180, landable) * 0.08
    + Math.min(8, minSeparation) * 2.2 + Math.min(24, localSpread) * 0.4
    + Math.min(62, floatingRadius) * 0.12 + homeTerrain.visualScore
    - Math.abs(verticalRms - 4.1) * 0.8 - collisionPenalty;
  return {
    seed, score: Number(score.toFixed(4)), minSeparation: Number(minSeparation.toFixed(4)),
    localSpread: Number(localSpread.toFixed(4)), verticalRms: Number(verticalRms.toFixed(4)),
    homePrimaryTypes: [...primaryTypes], sampleTypes: [...sampleTypes].sort(), rings, giants, landable,
    homeTerrain,
    citySystemId: city.systemId, floatingSystemId: floating.systemId, floatingRadius: Number(floatingRadius.toFixed(4)),
  };
}

const candidates = [];
for (let i = 1; i <= count; i++) candidates.push(scoreSeed(`MILKY-${String(i).padStart(3, '0')}`));
candidates.sort((a, b) => b.score - a.score || a.seed.localeCompare(b.seed));
const report = {
  generatedAt: new Date().toISOString(), candidateCount: count,
  rule: 'Static score nominates candidates only; final selection requires fixed-camera and flight review.',
  top12: candidates.slice(0, 12),
  top4: candidates.slice(0, 4),
};
await mkdir('worlds', { recursive: true });
await writeFile('worlds/finite-candidates.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(report.top12.map((candidate, index) => `${index + 1}. ${candidate.seed} ${candidate.score}`).join('\n'));
