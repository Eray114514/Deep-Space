import assert from 'node:assert/strict';
import { startServer } from './server.js';
import { launchBrowser, launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
async function verify(browser, backend, expected) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/natural-material-lab.html?backend=${backend}`);
  await page.waitForFunction('window.NMS_NATURAL_LAB != null', null, { timeout: 60000 });
  const result = await page.evaluate(() => window.NMS_NATURAL_LAB);
  assert.equal(result.ready, true, result.stack || result.error || 'natural material lab did not become ready');
  assert.equal(result.backend, expected);
  assert.deepEqual(errors, []);
  await page.close();
}

const portable = await launchBrowser();
try {
  await verify(portable, 'webgl', 'webgl2');
  console.log('PASS: natural TSL materials compile with WebGPURenderer WebGL2 backend');
  const hardware = await launchWebGPUHardwareBrowser({ headless: true });
  if (hardware) {
    try {
      await verify(hardware, 'auto', 'webgpu');
      console.log('PASS: natural TSL materials compile with WebGPU backend');
    } finally {
      await hardware.close();
    }
  } else {
    console.log('SKIP: natural WebGPU hardware compile (no system browser)');
  }
} finally {
  await portable.close();
  await new Promise((resolve) => server.close(resolve));
}
