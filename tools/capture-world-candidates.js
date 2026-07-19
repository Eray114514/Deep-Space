// Fast art-direction contact sheet for shortlisted universe seeds.
// Unlike explore.js this intentionally does not wait for every terrain queue
// to drain; finalists receive the full traversal pass only after visual review.

import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const seeds = (process.env.SEEDS || 'NAVEMI-382').split(',').map((seed) => seed.trim()).filter(Boolean);
const out = process.env.OUT || 'test-results/world-candidates';
const galaxy = process.env.GALAXY || 'milky-way';
const homeOnly = process.env.HOME_ONLY === '1';
const { server, port } = await startServer(0);
const browser = await launchBrowser();

async function capture(page, path) {
  await page.screenshot({ path, timeout: 90000 });
}

try {
  for (const seed of seeds) {
    const dir = `${out}/${seed}`;
    await mkdir(dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const params = new URLSearchParams({ worldlab: '1', galaxy, seed, nolock: '1', nohero: '1', buildms: '120' });
    for (const [envKey, paramKey] of [['SYSTEM', 'system'], ['BODY', 'body'], ['SEA', 'sea'], ['CLOUDS', 'clouds']]) {
      if (process.env[envKey] != null) params.set(paramKey, process.env[envKey]);
    }
    await page.goto(`http://127.0.0.1:${port}/?${params}`);
    await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 90000 });
    await page.waitForTimeout(1800);
    await capture(page, `${dir}/00-spawn.png`);

    const planets = await page.evaluate(() => NMS.planets());
    const representatives = [];
    const seenTypes = new Set();
    for (const planet of planets) {
      if (planet.isMoon || seenTypes.has(planet.type)) continue;
      seenTypes.add(planet.type);
      representatives.push(planet);
    }
    for (const [index, planet] of (homeOnly ? [] : representatives).entries()) {
      await page.evaluate(({ i }) => NMS.teleport(i, 0.55), planet);
      await page.waitForTimeout(900);
      const prefix = String(index + 1).padStart(2, '0');
      await capture(page, `${dir}/${prefix}-${planet.type}-orbit.png`);
    }

    await page.evaluate(() => NMS.teleport(0, 0.06, { horizon: true, pitch: -0.22 }));
    await page.waitForTimeout(3500);
    await capture(page, `${dir}/80-home-low.png`);
    await page.evaluate(() => NMS.land(0));
    await page.waitForFunction(() => NMS.state === 'walk', null, { timeout: 90000 });
    await page.waitForTimeout(4500);
    await capture(page, `${dir}/81-home-surface.png`);
    await page.evaluate(() => NMS.faceShip());
    await page.waitForTimeout(1200);
    await capture(page, `${dir}/82-home-ship.png`);

    console.log(`${seed}: ${planets.length} bodies, ${representatives.length} primary visual types, ${errors.length} page errors`);
    for (const error of errors) console.error(`  ${error.split('\n')[0]}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
