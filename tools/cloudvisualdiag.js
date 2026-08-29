import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';

const outputDir = path.resolve('test-results/cloud-webgl-reference');
const quick = process.argv.includes('--quick');
const sampleSteps = quick ? [80] : [48, 80, 124];
await mkdir(outputDir, { recursive: true });

function stats(buffer) {
  const image = PNG.sync.read(buffer);
  let luminance = 0;
  let blueBias = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] / 255;
    const green = image.data[offset + 1] / 255;
    const blue = image.data[offset + 2] / 255;
    luminance += red * 0.2126 + green * 0.7152 + blue * 0.0722;
    blueBias += Math.max(0, blue - (red + green) * 0.5);
  }
  const pixels = image.width * image.height;
  return {
    meanLuminance: luminance / pixels,
    meanBlueBias: blueBias / pixels,
  };
}

function difference(first, second) {
  const a = PNG.sync.read(first);
  const b = PNG.sync.read(second);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let total = 0;
  let changed = 0;
  const pixels = a.width * a.height;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    const delta = (Math.abs(a.data[offset] - b.data[offset])
      + Math.abs(a.data[offset + 1] - b.data[offset + 1])
      + Math.abs(a.data[offset + 2] - b.data[offset + 2])) / (255 * 3);
    total += delta;
    if (delta > 0.015) changed++;
  }
  return { meanAbsoluteRgb: total / pixels, changedFraction: changed / pixels };
}

const started = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const url = `http://127.0.0.1:${started.port}/?renderer=webgl&quality=ultra`
    + '&nolock=1&nohero=1&farflora=0&vclouds=1&post=0&freeze=1'
    + '&scene=orbit&planet=0&factor=1.06&time=9.5';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 150000 });
  } catch (error) {
    console.error(JSON.stringify({ bootError: String(error), errors }, null, 2));
    throw error;
  }
  await page.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    NMS.shipVisible(false);
    const style = document.createElement('style');
    style.textContent = 'body > *:not(#app), #app > *:not(canvas) { display: none !important; }';
    document.head.appendChild(style);
  });
  const planetIndex = await page.evaluate(() => {
    const index = NMS.planets().findIndex((_, candidate) =>
      Boolean(NMS._planet(candidate)?.volCloudMesh));
    if (index < 0) throw new Error('The system has no WebGL volume-cloud planet.');
    return index;
  });

  const captures = new Map();
  const results = {};
  async function capture(name, setup, settleMs = 650) {
    await page.evaluate(setup, planetIndex);
    await page.waitForTimeout(settleMs);
    const buffer = await page.screenshot();
    captures.set(name, buffer);
    await writeFile(path.join(outputDir, `${name}.png`), buffer);
    results[name] = {
      image: stats(buffer),
      volume: await page.evaluate(() => NMS.volumeState()),
      atmosphere: await page.evaluate(() => NMS.atmosphereState()),
    };
  }

  await capture('01-orbit-day', (index) => {
    NMS.setAtmosphereVisible(true);
    NMS.setCloudsVisible(true, index);
    NMS.teleport(index, 1.06);
  });
  await capture('02-orbit-cloud-only', (index) => {
    NMS.setAtmosphereVisible(false);
    NMS.setCloudsVisible(true, index);
  });
  await capture('03-orbit-atmosphere-only', (index) => {
    NMS.setAtmosphereVisible(true);
    NMS.setCloudsVisible(false, index);
  });
  await capture('04-orbit-terminator', (index) => {
    const planet = NMS._planet(index);
    const sun = planet.sunDirLocal.clone().normalize();
    const axis = Math.abs(sun.y) < 0.9
      ? new NMS._THREE.Vector3(0, 1, 0) : new NMS._THREE.Vector3(1, 0, 0);
    const tangent = new NMS._THREE.Vector3().crossVectors(sun, axis).normalize();
    NMS.setCloudsVisible(true, index);
    NMS.teleport(index, 1.06, { dir: tangent.toArray() });
  });
  await capture('05-orbit-night', (index) => {
    const planet = NMS._planet(index);
    NMS.teleport(index, 1.06, { dir: planet.sunDirLocal.clone().negate().toArray() });
  });
  await capture('06-ground-below-clouds', (index) => {
    NMS.land(index, 0, 'sunset');
    NMS.setSunAltitude(index, 35, { faceSun: true });
  }, 1600);
  await capture('07-ground-dusk', (index) => {
    NMS.setSunAltitude(index, 1.5, { faceSun: true });
  });
  await capture('08-ground-night', (index) => {
    NMS.setSunAltitude(index, -18, { faceSun: true });
  });

  const sampleControl = [];
  await page.evaluate((index) => {
    NMS.teleport(index, 1.06);
    NMS.setAtmosphereVisible(false);
    NMS.setCloudsVisible(true, index);
  }, planetIndex);
  for (const steps of sampleSteps) {
    const applied = await page.evaluate((value) => NMS.setCloudSamples(value), steps);
    assert.equal(applied, steps, 'cloud step control must preserve the requested tier');
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => NMS.volumeState());
    assert.equal(state.steps, steps, 'cloud step control must reach uMaxSteps');
    const buffer = await page.screenshot();
    const filename = `steps-${steps}.png`;
    await writeFile(path.join(outputDir, filename), buffer);
    sampleControl.push({ steps, filename, state, image: stats(buffer) });
  }

  const runtime = await page.evaluate((index) => ({
    stats: NMS.stats(),
    volume: NMS.volumeState(),
    hasLegacyRewriteState: Boolean(NMS._planet(index)?.volCloudState),
    cloudBand: { ...NMS._planet(index)?.volCloudBand },
    cloudRenderLayer: { ...NMS._planet(index)?.cloudRenderLayer },
  }), planetIndex);
  assert.equal(runtime.stats.rendererBackend, 'webgl2');
  assert.ok(runtime.volume.activeBodyId, 'a live WebGL cloud planet must own the pass');
  assert.equal(runtime.volume.cloudDepthReady, 1, 'cloud pass must consume opaque depth');
  assert.ok(runtime.cloudRenderLayer.minAltitudeMeters >= 8000,
    'the optical cloud base must clear the highest authored relief');
  assert.ok(runtime.cloudRenderLayer.maxAltitudeMeters <= 105000,
    'the optical cloud top must not recreate the legacy planetary shell');
  assert.deepEqual(errors, [], 'cloud reference emitted browser errors');

  const report = {
    url,
    planetIndex,
    renderer: runtime.stats.rendererBackend,
    gpu: runtime.stats.gpu,
    drawingBuffer: runtime.volume.drawingBuffer,
    currentRuntimeContract: {
      usesWebGlCloudMesh: true,
      dependsOnLegacyVolCloudState: false,
      observedLegacyVolCloudState: runtime.hasLegacyRewriteState,
      cloudBand: runtime.cloudBand,
      cloudRenderLayer: runtime.cloudRenderLayer,
      depthReady: runtime.volume.cloudDepthReady,
    },
    results,
    separation: {
      atmosphereContribution: difference(
        captures.get('01-orbit-day'), captures.get('02-orbit-cloud-only')),
      cloudContribution: difference(
        captures.get('01-orbit-day'), captures.get('03-orbit-atmosphere-only')),
    },
    sampleControl,
    errors,
  };
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Cloud WebGL reference: ${path.join(outputDir, 'report.json')}`);
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => started.server.close(resolve));
}
