import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required.');
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => console.error(error.stack || error));
page.on('console', (message) => {
  if (message.type() === 'error') console.error(message.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=auto&quality=high&vclouds=1`
    + '&farflora=0&nohero=1&freeze=1&scene=orbit&planet=0&factor=0.72');
  await page.waitForFunction('Boolean(window.NMS)', null, { timeout: 60000 });
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => {
      const planet = NMS._internals.universe.system.planets[0];
      const { universe, nav } = NMS._internals;
      return {
        booted: NMS.booted, frame: NMS.frame(), stats: NMS.stats(),
        volume: planet.volCloudMesh?.visible,
        engage: planet.volCloudMat?.uniforms?.uEngage?.value,
        analytic: planet.cloudMesh?.visible,
        distances: universe.system.planets.map((body, index) => ({
          index, id: body.bodyId, type: body.type,
          surfaceDistance: nav.pos.distanceTo(body.posUniv) - body.R,
        })).sort((a, b) => a.surfaceDistance - b.surfaceDistance).slice(0, 3),
      };
    });
    console.log(i, state);
    if (state.booted && i > 8) break;
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
