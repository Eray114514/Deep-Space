import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge with WebGPU is required.');
const outDir = new URL('../test-results/renderers/', import.meta.url);
await mkdir(outDir, { recursive: true });

try {
  for (const renderer of ['webgl', 'webgpu']) {
    for (const vclouds of [0, 1]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.stack || String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${port}/?renderer=${renderer}`
        + `&nohero=1&quality=ultra&farflora=0&vclouds=${vclouds}`
        + '&freeze=1&time=9.5&scene=orbit&planet=0&factor=0.72');
      await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
      await page.waitForTimeout(900);
      const stats = await page.evaluate(() => NMS.stats());
      const name = `${stats.rendererBackend}-volume-${vclouds ? 'on' : 'off'}`;
      await writeFile(new URL(`${name}.png`, outDir), await page.screenshot());
      console.log(JSON.stringify({ name, errors, stats }, null, 2));
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
