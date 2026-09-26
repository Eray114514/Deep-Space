// B4-01 coordinate/terrain integration in actual generated planets.
// Does not accept the pending weather migration, density, optics or cloud art.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { B4_WEATHER_FIXTURES } from './b4-weather-fixtures.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const fingerprint = await evidenceFingerprint('tools/b4weathertest.js');
const fixtureDigest = createHash('sha256').update(await readFile('tools/b4-weather-fixtures.js')).digest('hex');
const output = `test-results/b4-01/${fingerprint.sourceDigest.slice(0, 12)}`;
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&quality=ultra&freeze=1&time=9.5&nohero=1&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  const result = await page.evaluate(async (fixtures) => {
    const { sampleCloudColumn, sampleCloudEnvironment } = await import('/src/cloud/cloud-environment.js');
    const THREE = NMS._THREE;
    const bodies = [];
    let queries = 0, maxRoundTripMeters = 0, maxRebaseMeters = 0, maxTerrainDifferenceMeters = 0;
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    for (const index of fixtures.planetIndices) {
      check(NMS.land(index), `Planet ${index} must exist and be landable`);
      const p = NMS._planet(index);
      const columns = fixtures.columns.map(([id, xyz]) => {
        const direction = new THREE.Vector3(...xyz).normalize();
        const column = sampleCloudColumn(p, direction);
        const expected = p.height(direction, p.fullMaxFreq);
        maxTerrainDifferenceMeters = Math.max(maxTerrainDifferenceMeters,
          Math.abs(column.terrainAltitudeMeters - expected));
        return { id, ...column };
      });
      const baseline = columns.map((c) => sampleCloudEnvironment(p,
        new THREE.Vector3(c.direction.x, c.direction.y, c.direction.z).multiplyScalar(p.R + 12000), 9.5));
      for (const hours of fixtures.absoluteHours) {
        NMS.setTime(hours);
        check(p.weatherHours === hours, 'Production clock must use the same absolute celestial hours');
        for (let i = 0; i < columns.length; i++) {
          const column = columns[i];
          const direction = new THREE.Vector3(column.direction.x, column.direction.y, column.direction.z);
          for (const altitude of fixtures.altitudesMeters) {
            const local = direction.clone().multiplyScalar(p.R + altitude);
            const query = sampleCloudEnvironment(p, local, hours);
            check(Math.abs(query.altitudeMeters - altitude) < 1e-7, 'Radial altitude mismatch');
            check(Math.abs(query.surfaceAltitudeMeters - baseline[i].surfaceAltitudeMeters) < 1e-5,
              'Terrain column must not move with query altitude or clock');
            check(query.absoluteSeconds === hours * 3600, 'Clock units mismatch');
            const universal = p.localPositionToWorld(local);
            const recovered = p.worldPositionToLocal(universal);
            maxRoundTripMeters = Math.max(maxRoundTripMeters, recovered.distanceTo(local));
            // Two distinct floating origins must recover the same body-local point.
            for (const offset of [[123456, -789012, 345678], [-30000000, 1500000, -2000000]]) {
              const origin = p.posUniv.clone().add(new THREE.Vector3(...offset));
              const relative = universal.clone().sub(origin);
              const bodyRelative = p.posUniv.clone().sub(origin);
              const rebased = p.worldOffsetToLocal(relative.sub(bodyRelative));
              maxRebaseMeters = Math.max(maxRebaseMeters, rebased.distanceTo(local));
            }
            queries++;
          }
        }
      }
      NMS.setTime(9.5);
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i], local = new THREE.Vector3(c.direction.x, c.direction.y, c.direction.z)
          .multiplyScalar(p.R + 12000);
        check(JSON.stringify(sampleCloudEnvironment(p, local, 9.5)) === JSON.stringify(baseline[i]),
          'Interleaved clock seeks must reproduce the same query');
      }
      bodies.push({ index, bodyId: p.bodyId, seed: p.seed, type: p.type,
        radiusMeters: p.R, fullMaxFreq: p.fullMaxFreq, hasLiquid: p.hasLiquid,
        seaAltitudeMeters: p.hasLiquid ? p.seaLevel : null, columns });
    }
    return { bodies, queries, maxRoundTripMeters, maxRebaseMeters, maxTerrainDifferenceMeters,
      webglError: NMS._renderer.getContext().getError() };
  }, B4_WEATHER_FIXTURES);
  assert.equal(result.queries, 324);
  assert.ok(result.maxRoundTripMeters < 0.002, 'Universal/body round trip must stay within 2 mm');
  assert.ok(result.maxRebaseMeters < 0.002, 'Floating origin round trip must stay within 2 mm');
  assert.ok(result.maxTerrainDifferenceMeters < 1e-5);
  assert.ok(result.bodies.flatMap((b) => b.columns).some((c) => c.surfaceIsLiquid), 'Include real water');
  assert.ok(result.bodies.flatMap((b) => b.columns).some((c) => !c.surfaceIsLiquid), 'Include real land');
  assert.equal(result.webglError, 0);
  assert.deepEqual(errors, []);
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify({
    stage: 'B4-01', scope: 'Coordinate and real-terrain query contract only; production weather unchanged',
    fingerprint, fixtureDigest, browser: browser.version(), fixtures: B4_WEATHER_FIXTURES, ...result, errors,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ output, queries: result.queries,
    maxRoundTripMeters: result.maxRoundTripMeters, maxRebaseMeters: result.maxRebaseMeters,
    maxTerrainDifferenceMeters: result.maxTerrainDifferenceMeters }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
