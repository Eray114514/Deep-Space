// Exact near-water CPU throughput attribution. No browser/FPS claims.
import { mkdir, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { Planet } from '../src/planet.js';
import { NearWaterPatch } from '../src/near-water-patch.js';
import { generateSystemSpec } from '../src/astronomy.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { getGalaxyConfig, resolveBodyTuning } from '../src/world-config.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = `test-results/water-build/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/waterbuildperftest.js');
const galaxy = getGalaxyConfig(), catalog = new GalaxyCatalog(galaxy.seed);
const system = generateSystemSpec(galaxy.seed, catalog.getSystem(HOME_SYSTEM_ID));
const body = system.bodies.find(b => b.bodyId === 'planet-0');
const planet = new Planet({ ...body, radius: body.radius, posUniv: new THREE.Vector3(),
  tuning: resolveBodyTuning({ galaxyId: galaxy.id, seed: galaxy.seed,
    systemId: system.systemId, bodyId: body.bodyId }) });
const material = new THREE.MeshBasicMaterial();
const direction = new THREE.Vector3(.34669147556655305, .07291666666666663, -.9351407276403421).normalize();
const height = planet.height;
const report = { ...fingerprint, boundary: 'Node CPU time; flat height control only attributes geometry overhead, never a runtime candidate.', runs: [] };
try {
  for (const flat of [false, true, false, true, false, true]) {
    planet.height = flat ? () => 0 : height;
    const patch = new NearWaterPatch(planet, material);
    const started = performance.now();
    patch._begin(direction);
    const slices = [];
    while (patch.build) {
      patch._buildRows(2);
      slices.push(patch.lastBuildMs);
    }
    const sorted = [...slices].sort((a,b) => a-b);
    report.runs.push({ flat, wallMs: performance.now()-started,
      buildMs: slices.reduce((a,b) => a+b, 0), slices: slices.length,
      p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)],
      max: sorted.at(-1), commitMs: patch.lastCommitMs });
    patch.dispose();
  }
  report.finalFingerprint = await evidenceFingerprint('tools/waterbuildperftest.js');
  report.sourceStable = report.sourceDigest === report.finalFingerprint.sourceDigest
    && report.verifierDigest === report.finalFingerprint.verifierDigest;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, sourceStable: report.sourceStable, runs: report.runs }, null, 2));
} finally { planet.height=height; material.dispose(); }
