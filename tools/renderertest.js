import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';
import { resolveRendererPolicy, WEBGPU_PARITY_READY } from '../src/renderer-policy.js';

// WebGPU 迁移已退役,渲染策略固定为 WebGL 2。
assert.equal(WEBGPU_PARITY_READY, false);
assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=webgl'), {}).backend, 'webgl2');
assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=webgpu'), {}).backend, 'webgl2');
assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=auto'), {}).backend, 'webgl2');
assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=auto'), null).backend, 'webgl2');

const { server, port } = await startServer(0);
const browser = await launchBrowser();
let failures = 0;
const captureDir = new URL('../test-results/renderers/', import.meta.url);
await mkdir(captureDir, { recursive: true });
const visibleScenePixels = (buffer) => {
  const png = PNG.sync.read(buffer);
  let count = 0;
  for (let y = Math.floor(png.height * 0.10); y < Math.floor(png.height * 0.82); y++) {
    for (let x = Math.floor(png.width * 0.22); x < Math.floor(png.width * 0.78); x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 48) count++;
    }
  }
  return count;
};
try {
  // 生产路径使用 WebGLRenderer 链路,由下方游戏页面验证。
  const productionPage = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const productionErrors = [];
  productionPage.on('pageerror', (error) => productionErrors.push(String(error)));
  productionPage.on('console', (message) => {
    if (message.type() === 'error') productionErrors.push(message.text());
  });
  await productionPage.goto(`http://127.0.0.1:${port}/?renderer=webgl&nohero=1&quality=low&farflora=0&vclouds=0&freeze=1&scene=orbit&planet=0&factor=0.12`);
  await productionPage.waitForFunction('window.NMS?.booted === true', null, { timeout: 45000 });
  await productionPage.waitForTimeout(800);
  const production = await productionPage.evaluate(() => NMS.stats());
  const webglCapture = await productionPage.screenshot();
  await writeFile(new URL('webgl2-orbit.png', captureDir), webglCapture);
  const productionPixels = visibleScenePixels(webglCapture);
  const productionOk = production.rendererBackend === 'webgl2' && productionPixels > 5000
    && productionErrors.length === 0;
  console.log(`${productionOk ? '✓' : '✗'} production authored WebGL 2 pipeline: ${production.rendererBackend}, ${productionPixels} visible pixels`);
  if (!productionOk) {
    failures++;
    console.error(productionErrors.join('\n'));
  }
  await productionPage.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
if (failures) process.exitCode = 1;
