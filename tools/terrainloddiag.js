import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for terrain LOD diagnostics.');
await mkdir('test-results/terrain-lod', { recursive: true });

try {
  for (const level of [2, 3]) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`http://127.0.0.1:${port}/?renderer=auto&quality=high&nohero=1`
      + '&farflora=0&freeze=1&post=0&vclouds=0');
    await page.waitForFunction('Boolean(window.NMS)', null, { timeout: 90000 });
    await page.evaluate((cap) => {
      const planet = NMS._internals.universe.system.planets[0];
      planet.orbitLevelCap = cap;
      if (planet.waterLod) planet.waterLod.planet.orbitLevelCap = Math.min(2, cap);
    }, level);
    await page.waitForFunction('window.NMS.booted === true', null, { timeout: 90000 });
    await page.waitForFunction(() => {
      const planet = NMS._internals.universe.system.planets[0];
      const terrain = planet.lod.debugStats();
      const water = planet.waterLod?.debugStats?.();
      return terrain.pending === 0 && terrain.activeMorphs === 0
        && (!water || (water.pending === 0 && water.activeMorphs === 0));
    }, null, { timeout: 90000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/terrain-lod/orbit-level-${level}.png` });
    console.log(level, await page.evaluate(() => {
      const planet = NMS._internals.universe.system.planets[0];
      return { terrain: planet.lod.debugStats(), water: planet.waterLod?.debugStats?.() };
    }));
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
