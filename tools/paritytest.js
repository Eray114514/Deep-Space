// WebGPU ↔ WebGL visual parity test.
// Captures the home planet from a fixed orbit angle in both backends on the
// same real GPU, compares pixel similarity, and fails when WebGPU diverges
// beyond the tolerance threshold. Outputs baseline, test, and difference
// images to test-results/parity/.
//
// Usage:
//   node tools/paritytest.js              # default: orbit vista
//   node tools/paritytest.js surface      # surface vista
//   node tools/paritytest.js horizon      # horizon vista
//
// Requires an installed Chrome/Edge with WebGPU support (launchWebGPUHardwareBrowser).

import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const SCENE = process.argv[2] || 'orbit';
const MODE = process.argv[3] || 'webgpu'; // 'webgpu' | 'tsl-webgl'
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for the parity test.');

const outDir = new URL('../test-results/parity/', import.meta.url);
await mkdir(outDir, { recursive: true });

// Scene presets: altitude factor + camera options.
const SCENES = {
  orbit:   { factor: 0.72,  teleport: false },
  horizon: { factor: 0.02,  teleport: { horizon: true, pitch: 0.04 } },
  surface: { factor: 0.001, teleport: { horizon: true, pitch: -0.02 } },
};
const preset = SCENES[SCENE] || SCENES.orbit;

async function captureBackend(backend, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

  const url = `http://127.0.0.1:${port}/?renderer=${backend}&quality=high&vclouds=1`
    + `&farflora=0&nohero=1&freeze=1&scene=orbit&planet=0&factor=${preset.factor}`;
  await page.goto(url);
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });

  if (preset.teleport) {
    await page.evaluate((altFactor, opts) => NMS.teleport(0, altFactor, opts),
      preset.factor, preset.teleport);
  }
  // Wait for shader compilation + LOD settle.
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => ({
    renderer: NMS.stats().rendererBackend,
    quality: NMS.stats().quality,
    altitude: NMS.stats().alt,
    dpr: NMS.stats().dpr,
  }));
  state.errors = errors;

  const buffer = await page.screenshot();
  await writeFile(new URL(`${label}.png`, outDir), buffer);
  await page.close();
  return { state, buffer };
}

// Pixel-level comparison: MSE, changed-ratio, max-delta, and a diff image.
function compare(a, b) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  const w = Math.min(pa.width, pb.width);
  const h = Math.min(pa.height, pb.height);
  const pixels = w * h;

  const diff = new PNG({ width: w, height: h });
  let sumSq = 0;
  let changed = 0;
  let maxDelta = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (pa.width * y + x) << 2;
      const j = (pb.width * y + x) << 2;
      const dr = Math.abs(pa.data[i] - pb.data[j]);
      const dg = Math.abs(pa.data[i + 1] - pb.data[j + 1]);
      const db = Math.abs(pa.data[i + 2] - pb.data[j + 2]);
      const delta = (dr + dg + db) / 3;
      sumSq += delta * delta;
      if (delta > 12) changed++;
      if (delta > maxDelta) maxDelta = delta;

      // Diff image: red channel = difference magnitude, green/blue = 0.
      const di = (w * y + x) << 2;
      const d = Math.min(255, delta * 3);
      diff.data[di] = d;
      diff.data[di + 1] = 0;
      diff.data[di + 2] = 0;
      diff.data[di + 3] = 255;
    }
  }

  const mse = sumSq / pixels;
  const rmse = Math.sqrt(mse);
  const changedRatio = changed / pixels;
  return { mse, rmse, changedRatio, maxDelta, diffBuffer: PNG.sync.write(diff) };
}

try {
  console.log(`Parity test: scene=${SCENE}, mode=${MODE}, factor=${preset.factor}`);

  // Capture WebGL baseline first — it is the authored visual reference.
  const webgl = await captureBackend('webgl', `webgl-${SCENE}`);
  console.log('WebGL baseline:', webgl.state);

  // Capture test backend — WebGPU or TSL-on-WebGL depending on mode.
  const testBackend = MODE === 'tsl-webgl' ? 'tsl-webgl' : 'webgpu';
  const testLabel = MODE === 'tsl-webgl' ? 'tsl-webgl' : 'webgpu';
  const test = await captureBackend(testBackend, `${testLabel}-${SCENE}`);
  console.log(`${testLabel} test:   `, test.state);

  // Surface backend mismatches as errors.
  if (webgl.state.errors.length) console.error('WebGL errors:', webgl.state.errors);
  if (test.state.errors.length) console.error(`${testLabel} errors:`, test.state.errors);

  const result = compare(webgl.buffer, test.buffer);
  await writeFile(new URL(`diff-${SCENE}-${testLabel}.png`, outDir), result.diffBuffer);

  console.log(`\nDifference (WebGL vs ${testLabel}):`);
  console.log(`  RMSE:         ${result.rmse.toFixed(2)}`);
  console.log(`  Changed (>12): ${(result.changedRatio * 100).toFixed(1)}%`);
  console.log(`  Max delta:    ${result.maxDelta}`);

  // Tolerance: test backend must be visually equivalent to WebGL.
  // RMSE < 18 accounts for MSAA strategy differences (4× MSAA vs SMAA)
  // and float precision. Changed ratio < 40% allows edge AA divergence but
  // catches region-level failures (black atmospheres, missing clouds).
  const RMSE_LIMIT = 18;
  const CHANGED_LIMIT = 0.40;
  let pass = true;

  if (result.rmse > RMSE_LIMIT) {
    console.error(`FAIL: RMSE ${result.rmse.toFixed(2)} exceeds limit ${RMSE_LIMIT}`);
    pass = false;
  }
  if (result.changedRatio > CHANGED_LIMIT) {
    console.error(`FAIL: changed ratio ${(result.changedRatio * 100).toFixed(1)}% exceeds limit ${(CHANGED_LIMIT * 100)}%`);
    pass = false;
  }
  if (test.state.errors.length) {
    console.error(`FAIL: ${testLabel} backend reported console errors`);
    pass = false;
  }

  if (pass) {
    console.log(`\nPASS: ${testLabel} visual parity within tolerance for scene="${SCENE}".`);
  } else {
    console.log(`\nFAIL: ${testLabel} diverges from WebGL baseline. Inspect diff-${SCENE}-${testLabel}.png.`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
