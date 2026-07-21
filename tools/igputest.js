import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({
  headless: true,
  adapterLuid: process.env.IGPU_ADAPTER_LUID,
  args: ['--force_low_power_gpu', '--use-angle=d3d11'],
});
if (!browser) {
  console.log('SKIP: integrated-GPU startup test requires installed Chrome/Edge');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const captureDir = new URL('../test-results/renderers/', import.meta.url);
await mkdir(captureDir, { recursive: true });
try {
  for (const requested of ['webgl', 'auto', 'webgpu']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const started = performance.now();
    await page.goto(`http://127.0.0.1:${port}/?renderer=${requested}&gpu=low&quality=low&nohero=1&farflora=0&vclouds=0&freeze=1&time=9.5&scene=orbit&planet=0&factor=1.72`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 30000 });
    const bootMs = performance.now() - started;
    const stats = await page.evaluate(() => NMS.stats());
    const capture = await page.screenshot();
    await writeFile(new URL(`low-power-${requested}.png`, captureDir), capture);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.ok(bootMs < 30000, `${requested} low-power boot took ${bootMs.toFixed(0)} ms`);
    assert.ok(['low', 'auto-low'].includes(stats.quality));
    console.log(`PASS: ${requested} low-power startup ${bootMs.toFixed(0)} ms; ${stats.rendererBackend}; ${stats.gpu}`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
