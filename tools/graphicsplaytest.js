import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const out = 'test-results/graphics-upgrade';
await mkdir(out, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.addInitScript(() => localStorage.clear());

function skyMean(buffer) {
  const png = PNG.sync.read(buffer);
  const sum = [0, 0, 0];
  let samples = 0;
  for (let y = 0; y < Math.floor(png.height * 0.28); y += 4) {
    for (let x = Math.floor(png.width * 0.2); x < Math.floor(png.width * 0.8); x += 4) {
      const offset = (y * png.width + x) * 4;
      sum[0] += png.data[offset];
      sum[1] += png.data[offset + 1];
      sum[2] += png.data[offset + 2];
      samples++;
    }
  }
  return sum.map((value) => value / samples);
}

try {
  const url = `http://127.0.0.1:${port}/?worldlab=1&seed=ASTRO-0&nolock=1&nohero=1`
    + '&quality=performance&renderer=webgl&farflora=0&post=0&freeze=1&buildms=25';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  const states = [];
  for (const altitude of [120000, 23400, 8000, 2000]) {
    await page.evaluate((value) => NMS.setAtmosphereAltitude(0, value), altitude);
    await page.waitForTimeout(700);
    states.push(await page.evaluate(() => ({ altitude: NMS.stats().alt, ...NMS.stats().environment })));
    if (altitude === 23400 || altitude === 2000) {
      await page.screenshot({ path: `${out}/atmosphere-${altitude}.png` });
    }
  }
  for (let i = 1; i < states.length; i++) {
    assert.ok(states[i].atmosphere + 1e-5 >= states[i - 1].atmosphere,
      'atmosphere density must increase continuously during descent');
  }
  const scan = [];
  const scanAltitudes = [120000, 70000, 42000, 30000, 25000, 23400, 20000, 14000, 8000, 3500, 2500, 1800];
  for (let i = 0; i < scanAltitudes.length; i++) {
    await page.evaluate((value) => NMS.setAtmosphereAltitude(0, value), scanAltitudes[i]);
    await page.waitForTimeout(260);
    const frame = await page.screenshot({ path: `${out}/descent-${String(i).padStart(2, '0')}.png` });
    scan.push(skyMean(frame));
  }
  for (let i = 1; i < scan.length; i++) {
    const delta = Math.hypot(scan[i][0] - scan[i - 1][0], scan[i][1] - scan[i - 1][1],
      scan[i][2] - scan[i - 1][2]) / 441.7;
    // Crossing a real cloud bank may legitimately replace much of the upper
    // frame with white. This guard is for catastrophic clear-colour flashes;
    // the finer atmosphere continuity contract is asserted from EnvironmentState.
    assert.ok(delta < 0.72, `atmosphere descent frame ${i} has no full-screen colour flash`);
  }

  for (const degrees of [4, 0, -6]) {
    await page.evaluate(() => NMS.land(2, 0, 'sunset'));
    const solved = await page.evaluate((value) => NMS.setSunAltitude(2, value), degrees);
    assert.ok(Math.abs(solved.actualDegrees - degrees) < 1.1, `rocky twilight fixture reaches ${degrees} degrees`);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/rocky-twilight-${degrees}.png` });
  }

  const waterPlanet = await page.evaluate(() => NMS.planets()
    .find((planet) => planet.liquid === 'water' || planet.liquid === 'toxic')?.i ?? -1);
  if (waterPlanet >= 0) {
    assert.equal(await page.evaluate((index) => NMS.setWaterWake(index, { height: 7, speed: 210 }), waterPlanet), true);
    await page.waitForTimeout(1800);
    const water = await page.evaluate(() => NMS.stats());
    assert.ok(water.waterInteractions > 0, 'fixed low-water flight injects a wake');
    await page.screenshot({ path: `${out}/water-wake.png` });
    const wade = await page.evaluate((index) => NMS.setWade(index, { depth: 0.9 }), waterPlanet);
    assert.ok(wade && wade.actualDepth > 0.35 && wade.actualDepth < 2.3,
      'fixed shallow-water fixture reaches a walkable depth');
    // setWade faces the beach for the visual fixture; step backward to remain
    // in the solved shallows instead of immediately walking onto dry land.
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(650);
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(150);
    const wading = await page.evaluate(() => NMS.stats());
    assert.ok(wading.waterInteractions > 0 && wading.waterContact > 0,
      `wading footsteps inject water ripples: ${JSON.stringify(wading)}`);
    await page.screenshot({ path: `${out}/water-wading.png` });
  }

  const stats = await page.evaluate(() => NMS.stats());
  assert.equal(stats.quality, 'performance');
  assert.equal(stats.rendererBackend, 'webgl2');
  assert.ok(stats.dpr >= 0.85, 'performance tier keeps the main canvas clear');
  assert.ok(stats.cloudSteps >= 24 && stats.cloudSteps <= 48,
    'performance cloud budget stays inside its adaptive range');

  await page.evaluate(() => document.querySelector('#hero-settings-btn').click());
  assert.equal(await page.locator('#graphics-settings-panel').evaluate((element) => element.classList.contains('hidden')), false);
  await page.evaluate(() => {
    document.querySelector('input[name="graphics-quality"][value="balanced"]').checked = true;
  });
  const applied = await page.evaluate(() => {
    document.querySelector('#graphics-settings-apply').click();
    return {
      saved: JSON.parse(localStorage.getItem('deep-space.graphics.v1')),
      maskVisible: !document.querySelector('#graphics-restart-mask').classList.contains('hidden'),
    };
  });
  const saved = applied.saved;
  assert.deepEqual(saved, { version: 1, quality: 'balanced', renderer: 'auto' });
  assert.equal(applied.maskVisible, true);

  assert.deepEqual(errors, [], errors.join('\n'));
  console.log('PASS: graphics settings, atmosphere scan, rocky twilight and water wake browser fixtures');
} finally {
  await browser.close();
  server.close();
}
