import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const seeds = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['MILKY-038', 'MILKY-234', 'MILKY-104', 'MILKY-166'];
const output = 'docs/curation/finite-worlds-v2';
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for finalist captures.');

async function settle(page, timeout = 60000) {
  try {
    await page.waitForFunction('NMS.idle()', null, { timeout });
  } catch {
    console.warn('settle timeout; retaining capture and runtime statistics');
  }
  await page.waitForTimeout(700);
}

try {
  for (const seed of seeds) {
    const dir = `${output}/${seed}`;
    await mkdir(dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/?worldlab=1&seed=${seed}`
      + '&renderer=auto&quality=high&nohero=1&farflora=0&freeze=1&buildms=35');
    await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 90000 });
    await settle(page, 30000);
    await page.screenshot({ path: `${dir}/00-orbit.png` });

    await page.evaluate(() => NMS.teleport(0, 0.025, { horizon: true, pitch: 0.02 }));
    await settle(page);
    await page.screenshot({ path: `${dir}/01-low-flight.png` });

    await page.evaluate(() => NMS.land(0, 0, 'meadow'));
    await settle(page);
    await page.screenshot({ path: `${dir}/02-surface.png` });
    const report = await page.evaluate(() => {
      const planet = NMS._internals.universe.system.planets[0];
      return {
        world: NMS.planets()[0],
        terrain: {
          contFreq: planet.contFreq, warpAmp: planet.warpAmp,
          relief: planet.hAmp, mountAmp: planet.mountAmp,
          plainsCalm: planet.plainsCalm,
        },
        stats: NMS.stats(),
      };
    });
    console.log(seed, JSON.stringify({ ...report, errors }));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
