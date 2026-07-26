import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const out = 'test-results/vegetation';
await mkdir(out, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  const url = `http://127.0.0.1:${port}/?worldlab=1&seed=NAVEMI-382&nolock=1&nohero=1`
    + '&scene=walk&planet=0&bias=meadow&quality=performance&renderer=webgl&farflora=1&post=0&buildms=45';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  await page.waitForTimeout(8000);
  const diagnostic = await page.evaluate(() => NMS.stats());
  console.log(JSON.stringify({ planetType: diagnostic.planetType, grass: diagnostic.grassField,
    terrainQueue: diagnostic.terrainQueue, adaptiveStage: diagnostic.adaptiveStage }));
  await page.waitForFunction(() => NMS.stats().grassField.total > 20, null, { timeout: 30000 });
  await page.waitForTimeout(500);

  const initial = await page.evaluate(() => ({
    direction: NMS.referenceState().playerLocal.map((value, index, values) => {
      const length = Math.hypot(...values);
      return value / length;
    }),
    field: NMS.stats().grassField,
  }));
  assert.ok(initial.field.counts.grassNear > 0, 'near grass LOD is populated');
  assert.ok(initial.field.counts.grassMid > 0, 'mid grass LOD is populated');
  assert.ok(initial.field.counts.grassFar > 0, 'far grass LOD is populated');
  await page.evaluate(() => NMS.setSunAltitude(0, 35));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/meadow.png` });

  const away = await page.evaluate((origin) => {
    const up = new NMS._THREE.Vector3().fromArray(origin);
    const tangent = new NMS._THREE.Vector3().crossVectors(up,
      Math.abs(up.y) < 0.9 ? new NMS._THREE.Vector3(0, 1, 0) : new NMS._THREE.Vector3(1, 0, 0)).normalize();
    return up.addScaledVector(tangent, 42 / NMS.referenceState().terrainRadius).normalize().toArray();
  }, initial.direction);
  assert.equal(await page.evaluate((direction) => NMS.setWalkDirection(direction), away), true);
  await page.waitForTimeout(900);
  await page.waitForFunction(() => NMS.stats().grassField.total > 20, null, { timeout: 30000 });
  assert.equal(await page.evaluate((direction) => NMS.setWalkDirection(direction), initial.direction), true);
  await page.waitForTimeout(1200);
  await page.waitForFunction((signature) => NMS.stats().grassField.signature === signature,
    initial.field.signature, { timeout: 45000 });

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(450);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(80);
  assert.ok((await page.evaluate(() => NMS.stats().surfaceInteractions)) > 0,
    'walking injects a recovering grass-pressure field');
  assert.deepEqual(errors, [], errors.join('\n'));
  const nodePage = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const nodeErrors = [];
  nodePage.on('pageerror', (error) => nodeErrors.push(String(error)));
  await nodePage.goto(`http://127.0.0.1:${port}/?worldlab=1&seed=NAVEMI-382&nolock=1&nohero=1`
    + '&scene=walk&planet=0&bias=meadow&quality=performance&renderer=webgpu&farflora=0&post=0&buildms=45');
  await nodePage.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  await nodePage.waitForFunction(() => NMS.stats().grassField.total > 20, null, { timeout: 60000 });
  await nodePage.keyboard.down('KeyW');
  await nodePage.waitForTimeout(400);
  await nodePage.keyboard.up('KeyW');
  assert.ok((await nodePage.evaluate(() => NMS.stats().surfaceInteractions)) > 0,
    'node grass path receives the shared interaction field');
  assert.deepEqual(nodeErrors, [], nodeErrors.join('\n'));
  await nodePage.close();
  console.log('PASS: deterministic near/mid/far meadow, return stability and walk interaction');
} finally {
  await browser.close();
  server.close();
}
