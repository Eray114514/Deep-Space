import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GalaxyCatalog } from '../src/galaxy-layout.js';
import { generateSystemSpec } from '../src/astronomy.js';
import { getGalaxyConfig, resolveBodyTuning, applySystemBodyTuning } from '../src/world-config.js';
import { createOceanClimate, placeOceanTidalEvent } from '../src/ocean-climate.js';
import { Planet } from '../src/planet.js';

const event = { normal: [1, 0, 0], height: 282, period: 400, epoch: 123 };
const options = { seed: 'site-contract', radius: 6000000, gravity: 9.81 };
assert.equal(placeOceanTidalEvent(event, { ...options, depthAt: () => -100 }), null);
assert.equal(placeOceanTidalEvent(event, { ...options, depthAt: () => 100 }), null);
const good = placeOceanTidalEvent(event, { ...options, depthAt: () => 2000 });
assert.deepEqual(good.normal, event.normal, 'Preserve a deep original site.');
assert.equal(good.placement.candidate, 0);
assert.deepEqual(placeOceanTidalEvent(event, { ...options, depthAt: (d) => d.x < 0 ? 2000 : -10 }),
  placeOceanTidalEvent(event, { ...options, depthAt: (d) => d.x < 0 ? 2000 : -10 }), 'Candidate search replays.');
assert.deepEqual(event, { normal: [1, 0, 0], height: 282, period: 400, epoch: 123 }, 'Input event remains immutable.');

const galaxy = getGalaxyConfig();
const rows = [];
for (const star of new GalaxyCatalog(galaxy.seed).allSystems()) {
  const tuning = (bodyId) => resolveBodyTuning({ seed: galaxy.seed, systemId: star.id, bodyId });
  const spec = applySystemBodyTuning(generateSystemSpec(galaxy.seed, star), tuning);
  for (const body of spec.bodies) {
    const original = body.type === 'ocean' ? createOceanClimate(body.seed, { type: body.type }).event : null;
    if (!original) continue;
    const planet = new Planet({ ...body, posUniv: new THREE.Vector3(), tuning: tuning(body.bodyId) });
    const placed = planet.oceanClimate.event;
    const depthAt = (dir) => planet.seaLevel - planet.height(dir, planet.fullMaxFreq);
    assert.deepEqual(placed, placeOceanTidalEvent(original, { seed: body.seed,
      radius: planet.seaRadius, gravity: planet.gravity, depthAt }), 'Runtime uses the deterministic finished terrain search.');
    if (placed) {
      assert.ok(placed.placement.centerDepth >= placed.placement.minimumDepth);
      assert.ok(placed.placement.deepFraction >= 0.85);
      assert.ok(placed.placement.sampledMinimumDepth > 0);
      assert.equal(placed.height, original.height);
      assert.equal(placed.period, original.period);
      assert.equal(placed.epoch, original.epoch);
      assert.ok(planet.oceanSurface.tidalField.up.every((v, i) => Math.abs(v - placed.normal[i]) < 1e-12));
    } else assert.equal(planet.oceanSurface.tidalField, null);
    rows.push({ systemId: star.id, bodyId: body.bodyId, event: !!placed, ...placed?.placement });
    planet.dispose();
  }
}
assert.equal(rows.length, 21);
const preserved = rows.find((r) => r.systemId === 'MW-0493' && r.bodyId === 'planet-5');
assert.equal(preserved.candidate, 0, 'Validated Miller reference basin stays fixed.');
console.log(JSON.stringify({ status: 'pass', total: rows.length,
  relocated: rows.filter((r) => r.event && r.candidate > 0).length,
  disabled: rows.filter((r) => !r.event).length, rows }, null, 2));
