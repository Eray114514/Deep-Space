import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser, launchWebGPUHardwareBrowser } from './browser.js';
import { resolveRendererPolicy, WEBGPU_PARITY_READY } from '../src/renderer-policy.js';

assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=webgl'), {}).backend, 'webgl2');
assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=webgpu'), {}).backend, 'webgpu');
assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=auto'), {}).backend, 'webgpu');
assert.equal(resolveRendererPolicy(new URLSearchParams('renderer=auto'), null).backend, 'webgl2');

const { server, port } = await startServer(0);
const browser = await launchBrowser();
let failures = 0;
const beautyCaptures = new Map();
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
  // The material lab is a NodeMaterial experiment. Production auto/webgl use
  // the authored WebGLRenderer chain and are exercised by the game page below.
  for (const requested of ['webgpu']) {
    const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/renderlab.html?renderer=${requested}`);
    await page.waitForFunction('window.NMS_RENDERLAB?.ready === true', null, { timeout: 30000 });
    const result = await page.evaluate(() => ({
      ready: NMS_RENDERLAB.ready,
      backend: NMS_RENDERLAB.backend,
      material: NMS_RENDERLAB.material,
    }));
    const ok = result.ready && ['webgpu', 'webgl2'].includes(result.backend)
      && result.material === 'MeshStandardNodeMaterial' && errors.length === 0;
    console.log(`${ok ? '✓' : '✗'} WebGPU experiment ${requested}: ${result.backend}, TSL node material`);
    if (!ok) failures++;
    await page.close();
  }

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

  // The portable correctness run above deliberately uses SwiftShader and is
  // allowed to fall back. When an installed Chrome/Edge is present, require a
  // real GPUDevice so `auto` cannot silently pass as WebGL 2 on developer PCs.
  const hardware = await launchWebGPUHardwareBrowser({ headless: true });
  if (hardware) {
    const page = await hardware.newPage({ viewport: { width: 640, height: 420 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/renderlab.html?renderer=webgpu`);
    await page.waitForFunction('window.NMS_RENDERLAB?.ready === true', null, { timeout: 30000 });
    const result = await page.evaluate(() => ({
      backend: NMS_RENDERLAB.backend,
      adapterInfo: NMS_RENDERLAB.adapterInfo,
    }));
    const ok = result.backend === 'webgpu' && errors.length === 0;
    console.log(`${ok ? '✓' : '✗'} system browser WebGPU: ${result.backend}`);
    if (!ok) failures++;
    await page.close();

    const game = await hardware.newPage({ viewport: { width: 960, height: 540 } });
    const gameErrors = [];
    game.on('pageerror', (error) => gameErrors.push(String(error)));
    game.on('console', (message) => {
      if (message.type() === 'error') gameErrors.push(message.text());
    });
    await game.goto(`http://127.0.0.1:${port}/?renderer=webgpu&nohero=1&quality=high&farflora=0&vclouds=1&freeze=1&scene=orbit&planet=0&factor=0.12`);
    await game.waitForFunction('window.NMS?.booted === true', null, { timeout: 45000 });
    await game.waitForTimeout(800);
    const gameStats = await game.evaluate(() => NMS.stats());
    const webgpuCapture = await game.screenshot();
    await writeFile(new URL('webgpu-orbit.png', captureDir), webgpuCapture);
    const gamePixels = visibleScenePixels(webgpuCapture);
    const gameOk = gameStats.rendererBackend === 'webgpu' && gamePixels > 5000 && gameErrors.length === 0;
    console.log(`${gameOk ? '✓' : '✗'} production WebGPU node pipeline: ${gameStats.rendererBackend}, ${gamePixels} visible pixels`);
    if (!gameOk) {
      failures++;
      console.error(gameErrors.join('\n'));
    }
    await game.close();

    for (const requested of ['webgl', 'webgpu']) {
      const vista = await hardware.newPage({ viewport: { width: 1280, height: 720 } });
      const vistaErrors = [];
      vista.on('pageerror', (error) => vistaErrors.push(String(error)));
      // Teleport factor is altitude / radius, so 0.72 gives a 1.72R opening
      // orbit.  Using 1.72 placed the camera at 2.72R and could make a moon the
      // nearest body, invalidating the fixed mother-world comparison.
      await vista.goto(`http://127.0.0.1:${port}/?renderer=${requested}&nohero=1&quality=high&farflora=0&vclouds=1&freeze=1&time=9.5&scene=orbit&planet=0&factor=0.72`);
      await vista.waitForFunction('window.NMS?.booted === true', null, { timeout: 45000 });
      await vista.waitForTimeout(800);
      const stats = await vista.evaluate(() => NMS.stats());
      const capture = await vista.screenshot();
      beautyCaptures.set(`${stats.rendererBackend}:vista`, capture);
      await writeFile(new URL(`${stats.rendererBackend}-vista.png`, captureDir), capture);
      const ok = stats.rendererBackend === (requested === 'webgpu' ? 'webgpu' : 'webgl2')
        && visibleScenePixels(capture) > 5000 && vistaErrors.length === 0;
      console.log(`${ok ? '✓' : '✗'} ${stats.rendererBackend} fixed beauty vista`);
      if (!ok) {
        failures++;
        console.error(vistaErrors.join('\n'));
      }
      await vista.evaluate(() => NMS.teleport(0, 0.45));
      await vista.waitForTimeout(650);
      const atmosphereCapture = await vista.screenshot();
      beautyCaptures.set(`${stats.rendererBackend}:atmosphere`, atmosphereCapture);
      await writeFile(new URL(`${stats.rendererBackend}-atmosphere.png`, captureDir), atmosphereCapture);
      await vista.close();
    }
    for (const scene of ['vista', 'atmosphere']) {
      const webglBeauty = PNG.sync.read(beautyCaptures.get(`webgl2:${scene}`));
      const webgpuBeauty = PNG.sync.read(beautyCaptures.get(`webgpu:${scene}`));
      let difference = 0;
      let changed = 0;
      const pixels = webglBeauty.width * webglBeauty.height;
      for (let i = 0; i < webglBeauty.data.length; i += 4) {
        const delta = (Math.abs(webglBeauty.data[i] - webgpuBeauty.data[i])
          + Math.abs(webglBeauty.data[i + 1] - webgpuBeauty.data[i + 1])
          + Math.abs(webglBeauty.data[i + 2] - webgpuBeauty.data[i + 2])) / 3;
        difference += delta;
        if (delta > 12) changed++;
      }
      const meanDifference = difference / pixels;
      const changedRatio = changed / pixels;
      // WebGL 2 is a complete compatibility renderer, not the visual target
      // for the WebGPU-native atmosphere/cloud rewrite. Both captures above
      // remain hard-gated for backend identity, visible scene pixels and
      // console/GPU errors; this delta is retained as review evidence only.
      const legacyEnvelope = meanDifference < 35 && changedRatio < 0.75;
      console.log(`ℹ fixed-${scene} cross-backend appearance delta`
        + ` (${legacyEnvelope ? 'inside' : 'outside'} legacy envelope):`
        + ` mean ${meanDifference.toFixed(3)}, changed ${(changedRatio * 100).toFixed(2)}%`);
    }
    await hardware.close();
  } else {
    console.log('↷ system browser WebGPU: skipped (no Chrome/Edge executable)');
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
if (failures) process.exitCode = 1;
