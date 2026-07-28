import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('Eclipse visual test skipped: no hardware WebGPU browser.');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const outputDir = new URL('../test-results/eclipse/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&time=9.5&freeze=1');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  await page.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    NMS.setWeatherFixture(0, 'clear');
  });
  await page.waitForFunction('NMS.idle()', null, { timeout: 90000 });
  await page.waitForTimeout(2500);

  const ownership = await page.evaluate(() => {
    const active = NMS._planet(0);
    const planets = [];
    for (let index = 0; ; index++) {
      const planet = NMS._planet(index);
      if (!planet) break;
      if (!planet.atmoMesh) continue;
      planets.push({
        index,
        active: planet === active,
        atmosphereLayer: planet.atmoMesh.layers.mask,
        depthReady: planet.atmoMesh.material.uniforms?.uDepthReady?.value || 0,
        volumeCloudVisible: !!planet.volCloudMesh?.visible,
      });
    }
    return planets;
  });
  assert.equal(ownership.filter((body) => body.atmosphereLayer === 4).length, 1,
    'only the active planet may occupy the unoccluded local-volume layer');
  assert.equal(ownership.find((body) => body.atmosphereLayer === 4)?.depthReady, 1,
    'active atmosphere must receive opaque scene depth');
  assert.ok(ownership.filter((body) => !body.active)
    .every((body) => body.atmosphereLayer !== 4 && !body.volumeCloudVisible),
  'inactive moon/planet media must stay in the depth-tested world representation');

  const controlBuffer = await page.screenshot();
  await page.waitForTimeout(900);
  const clearBuffer = await page.screenshot();
  await writeFile(new URL('clear.png', outputDir), clearBuffer);
  const fixture = await page.evaluate(() => {
    const planet = NMS._planet(0);
    return NMS.setEclipseFixture(0, {
      distance: planet.R * 3.5,
      radius: planet.R * 0.24,
      starAngularRadius: 0.012,
    });
  });
  await page.waitForTimeout(900);
  const eclipseBuffer = await page.screenshot();
  await writeFile(new URL('umbra-penumbra.png', outputDir), eclipseBuffer);

  const clear = PNG.sync.read(clearBuffer);
  const control = PNG.sync.read(controlBuffer);
  const eclipse = PNG.sync.read(eclipseBuffer);
  let changed = 0;
  let darkened = 0;
  let meanDifference = 0;
  let stablePixels = 0;
  const brightnessDeltas = [];
  const pixelCount = clear.width * clear.height;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const difference = (
      Math.abs(clear.data[offset] - eclipse.data[offset])
      + Math.abs(clear.data[offset + 1] - eclipse.data[offset + 1])
      + Math.abs(clear.data[offset + 2] - eclipse.data[offset + 2])
    ) / 3;
    const controlDifference = (
      Math.abs(control.data[offset] - clear.data[offset])
      + Math.abs(control.data[offset + 1] - clear.data[offset + 1])
      + Math.abs(control.data[offset + 2] - clear.data[offset + 2])
    ) / 3;
    if (controlDifference > 3) continue;
    stablePixels++;
    meanDifference += difference;
    const clearSum = clear.data[offset] + clear.data[offset + 1] + clear.data[offset + 2];
    const eclipseSum = eclipse.data[offset] + eclipse.data[offset + 1] + eclipse.data[offset + 2];
    brightnessDeltas.push((eclipseSum - clearSum) / 3);
  }
  brightnessDeltas.sort((a, b) => a - b);
  const globalExposureDelta = brightnessDeltas[Math.floor(brightnessDeltas.length / 2)] || 0;
  for (const delta of brightnessDeltas) {
    // Environment exposure continues its slow adaptation while the fixture
    // is toggled. Remove that frame-wide median, then require a large local
    // residual so the regression detects the shadow field rather than tone
    // mapping drift.
    if (Math.abs(delta - globalExposureDelta) > 10) changed++;
    if (delta < globalExposureDelta - 12) darkened++;
  }
  const changedFraction = changed / Math.max(1, stablePixels);
  const darkenedFraction = darkened / Math.max(1, stablePixels);
  meanDifference /= Math.max(1, stablePixels);
  assert.ok(changedFraction > 0.01 && changedFraction < 0.55,
    `eclipse must be local rather than absent or globe-wide; changed ${changedFraction},`
    + ` stable ${stablePixels / pixelCount}`);
  assert.ok(darkenedFraction > 0.005 && darkenedFraction < 0.4,
    `umbra/penumbra must form a bounded brightness valley; darkened ${darkenedFraction}`);
  assert.equal(errors.length, 0, errors.join('\n'));

  console.log('PASS: depth-owned planetary media and local analytic eclipse field');
  console.log(JSON.stringify({
    ownership,
    fixture,
    globalExposureDelta,
    meanDifference,
    changedFraction,
    darkenedFraction,
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
