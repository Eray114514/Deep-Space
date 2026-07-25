import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
const outDir = new URL('../test-results/cloud-diagnostics/', import.meta.url);
await mkdir(outDir, { recursive: true });

async function capture(vclouds, factor, label, horizon = false, quality = 'high') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const url = `http://127.0.0.1:${port}/?renderer=auto&quality=${quality}&vclouds=${vclouds}`
    + `&farflora=0&nohero=1&freeze=1&scene=orbit&planet=0&factor=${factor}`;
  await page.goto(url);
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  if (horizon) {
    await page.evaluate((altFactor) => NMS.teleport(0, altFactor, { horizon: true, pitch: 0.04 }), factor);
  }
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => {
    const planet = NMS._internals.universe.system.planets[0];
    const uniforms = planet.volCloudMat?.uniforms;
    return {
      renderer: NMS.stats().rendererBackend,
      quality: NMS.stats().quality,
      altitude: NMS.stats().alt,
      coverage: planet.cloudCoverage,
      radius: planet.R,
      cloudAltitude: planet.cloudBands?.[0]?.r - planet.R,
      analyticVisible: planet.cloudMesh?.visible,
      analyticOpacity: planet.cloudMesh?.material?.opacity,
      volumeExists: Boolean(planet.volCloudMesh),
      volumeVisible: planet.volCloudMesh?.visible,
      volumeLayer: planet.volCloudMesh?.layers?.mask,
      volumeMaterial: planet.volCloudMesh?.material?.type,
      engage: uniforms?.uEngage?.value,
      rayQuality: uniforms?.uQuality?.value,
      weatherAudit: planet.cloudAudit(2048),
    };
  });
  state.errors = errors;
  const buffer = await page.screenshot();
  await writeFile(new URL(`${label}.png`, outDir), buffer);
  await page.close();
  return { state, buffer };
}

function difference(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  let sum = 0, changed = 0;
  const pixels = pa.width * pa.height;
  for (let i = 0; i < pa.data.length; i += 4) {
    const delta = (Math.abs(pa.data[i] - pb.data[i])
      + Math.abs(pa.data[i + 1] - pb.data[i + 1])
      + Math.abs(pa.data[i + 2] - pb.data[i + 2])) / 3;
    sum += delta;
    if (delta > 12) changed++;
  }
  return { mean: sum / pixels, changedRatio: changed / pixels };
}

try {
  // NMS.teleport's factor is altitude / radius. 0.72 matches the production
  // opening distance of 1.72 radii from the centre.
  const flatOrbit = await capture(0, 0.72, 'flat-orbit');
  const volumeOrbit = await capture(1, 0.72, 'volume-orbit');
  const flatLow = await capture(0, 0.02, 'flat-low');
  const volumeLow = await capture(1, 0.02, 'volume-low');
  const flatHorizon = await capture(0, 0.02, 'flat-horizon', true);
  const volumeHorizon = await capture(1, 0.02, 'volume-horizon', true);
  const flatSurface = await capture(0, 0.001, 'flat-surface', true);
  const volumeSurface = await capture(1, 0.001, 'volume-surface', true);
  const lowOrbit = await capture(1, 0.72, 'volume-low-quality-orbit', false, 'low');
  const lowHorizon = await capture(1, 0.02, 'volume-low-quality-horizon', true, 'low');
  const lowSurface = await capture(1, 0.001, 'volume-low-quality-surface', true, 'low');
  const result = {
    flatOrbit: flatOrbit.state,
    volumeOrbit: volumeOrbit.state,
    orbitDifference: difference(flatOrbit.buffer, volumeOrbit.buffer),
    flatLow: flatLow.state,
    volumeLow: volumeLow.state,
    lowDifference: difference(flatLow.buffer, volumeLow.buffer),
    flatHorizon: flatHorizon.state,
    volumeHorizon: volumeHorizon.state,
    horizonDifference: difference(flatHorizon.buffer, volumeHorizon.buffer),
    flatSurface: flatSurface.state,
    volumeSurface: volumeSurface.state,
    surfaceDifference: difference(flatSurface.buffer, volumeSurface.buffer),
    lowQualityOrbit: lowOrbit.state,
    lowQualityHorizon: lowHorizon.state,
    lowQualitySurface: lowSurface.state,
    highLowOrbitDifference: difference(volumeOrbit.buffer, lowOrbit.buffer),
    highLowHorizonDifference: difference(volumeHorizon.buffer, lowHorizon.buffer),
    highLowSurfaceDifference: difference(volumeSurface.buffer, lowSurface.buffer),
  };
  console.log(JSON.stringify(result, null, 2));
  for (const state of [result.volumeOrbit, result.volumeLow,
    result.volumeHorizon, result.volumeSurface]) {
    assert.equal(state.renderer, 'webgl2');
    assert.equal(state.quality, 'high');
    assert.equal(state.volumeExists, true);
    assert.equal(state.volumeVisible, true);
    assert.ok(state.engage > 0.98, `volume engage too low: ${state.engage}`);
    assert.equal(state.analyticVisible, false);
    assert.ok(state.analyticOpacity < 0.01, `analytic deck still visible: ${state.analyticOpacity}`);
    assert.deepEqual(state.errors, []);
  }
  for (const state of [result.lowQualityOrbit, result.lowQualityHorizon,
    result.lowQualitySurface]) {
    assert.equal(state.renderer, 'webgl2');
    assert.equal(state.quality, 'low');
    assert.equal(state.volumeExists, true);
    assert.equal(state.volumeVisible, true);
    assert.ok(state.engage > 0.98, `low-tier volume engage too low: ${state.engage}`);
    assert.equal(state.rayQuality, 0);
    assert.equal(state.analyticVisible, false);
    assert.ok(state.analyticOpacity < 0.01,
      `low-tier analytic deck still visible: ${state.analyticOpacity}`);
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.weatherAudit, result.volumeOrbit.weatherAudit,
      'quality tier changed the deterministic cloud footprint');
  }
  assert.ok(result.horizonDifference.mean > 8
    && result.horizonDifference.changedRatio > 0.2,
  `volume horizon is visually indistinguishable: ${JSON.stringify(result.horizonDifference)}`);
  assert.ok(result.surfaceDifference.mean > 10
    && result.surfaceDifference.changedRatio > 0.25,
  `volume surface is visually indistinguishable: ${JSON.stringify(result.surfaceDifference)}`);
  assert.ok(result.highLowHorizonDifference.mean < 34,
    `quality tiers diverged visually: ${JSON.stringify(result.highLowHorizonDifference)}`);
  assert.ok(result.highLowSurfaceDifference.mean < 38,
    `quality tiers diverged visually: ${JSON.stringify(result.highLowSurfaceDifference)}`);
  console.log('PASS: high and low quality render the same volumetric weather field;'
    + ' low changes integration budget only.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
