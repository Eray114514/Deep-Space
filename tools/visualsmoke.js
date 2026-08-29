import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge with WebGPU is required.');
const outDir = new URL('../test-results/visual-smoke/', import.meta.url);
await mkdir(outDir, { recursive: true });
const volumeClouds = process.env.NMS_VCLOUDS === '0' ? '0' : '1';
const focus = process.env.NMS_SMOKE_FOCUS || 'all';
const layerAb = process.env.NMS_SMOKE_LAYER_AB !== '0';
const atmosphereAb = process.env.NMS_SMOKE_ATMOSPHERE_AB === '1';
const atmosphereAltitude = Math.max(0, Number(process.env.NMS_ALTITUDE) || 2000);

async function capture(page, name) {
  const buffer = await page.screenshot();
  await writeFile(new URL(`${name}.png`, outDir), buffer);
  const stats = await page.evaluate(() => NMS.stats());
  console.log(JSON.stringify({ name, stats }, null, 2));
  return { buffer, stats };
}

function atmosphereLimbStats(enabledBuffer, disabledBuffer, fixture) {
  const enabled = PNG.sync.read(enabledBuffer);
  const disabled = PNG.sync.read(disabledBuffer);
  assert.equal(enabled.width, disabled.width);
  assert.equal(enabled.height, disabled.height);
  const cameraRadius = fixture.planetRadius + fixture.cameraAltitude;
  const focalScale = (enabled.height * 0.5)
    / Math.tan(fixture.fovDegrees * Math.PI / 360);
  const projectedRadius = (radius) => focalScale
    * Math.tan(Math.asin(Math.min(radius / cameraRadius, 0.999999)));
  const innerRadius = projectedRadius(fixture.planetRadius);
  const outerRadius = projectedRadius(fixture.planetRadius + fixture.opticalTop);
  const centerX = enabled.width * 0.5;
  const centerY = enabled.height * 0.5;
  let samples = 0;
  let darkened = 0;
  let brightened = 0;
  let luminanceDelta = 0;
  let blueDelta = 0;
  for (let y = 0; y < enabled.height; y++) {
    for (let x = 0; x < enabled.width; x++) {
      const radius = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      if (radius < innerRadius || radius > outerRadius) continue;
      const offset = (y * enabled.width + x) * 4;
      const redDelta = enabled.data[offset] - disabled.data[offset];
      const greenDelta = enabled.data[offset + 1] - disabled.data[offset + 1];
      const currentBlueDelta = enabled.data[offset + 2] - disabled.data[offset + 2];
      const currentLuminanceDelta = redDelta * 0.2126
        + greenDelta * 0.7152 + currentBlueDelta * 0.0722;
      if (currentLuminanceDelta < -2) darkened++;
      if (currentLuminanceDelta > 2) brightened++;
      luminanceDelta += currentLuminanceDelta;
      blueDelta += currentBlueDelta - (redDelta + greenDelta) * 0.5;
      samples++;
    }
  }
  return {
    samples,
    innerRadius,
    outerRadius,
    meanLuminanceDelta: luminanceDelta / Math.max(1, samples),
    meanBlueDelta: blueDelta / Math.max(1, samples),
    darkenedFraction: darkened / Math.max(1, samples),
    brightenedFraction: brightened / Math.max(1, samples),
  };
}

async function waitForFocusedPlanetReviewDensity(page) {
  await page.waitForFunction(() => (NMS._planet(0)?.lod?.countChunks?.() || 0) > 80,
    null, { timeout: 45000 });
  // The focused quadtree may keep trading equally detailed chunks as the
  // water queue catches up, so an exact count-stability condition never
  // necessarily becomes true. Once the reviewed density is present, leave a
  // bounded GPU/upload settle margin instead.
  await page.waitForTimeout(3000);
}

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/?renderer=auto&quality=ultra`
    + `&nohero=1&vclouds=${volumeClouds}&farflora=1&post=1&freeze=1`);
  try {
    await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  } catch (error) {
    console.error(JSON.stringify({ bootError: String(error), errors }, null, 2));
    throw error;
  }

  if (focus === 'all' || focus === 'orbit') {
    await page.evaluate(() => NMS.teleport(0, 0.72));
    await waitForFocusedPlanetReviewDensity(page);
    const orbitCapture = await capture(page, '01-orbit-volume');
    if (layerAb) {
      await page.evaluate(() => NMS.setAtmosphereVisible(false));
      await page.waitForTimeout(350);
      const noAtmosphereCapture = await capture(page, '01a-orbit-no-atmosphere');
      const fixture = await page.evaluate(() => ({
        planetRadius: NMS._planet(0).R,
        cameraAltitude: NMS.stats().alt,
        fovDegrees: NMS.stats().fov,
        opticalTop: NMS.atmosphereState().opticalTop,
      }));
      const limb = atmosphereLimbStats(
        orbitCapture.buffer, noAtmosphereCapture.buffer, fixture,
      );
      console.log(JSON.stringify({ atmosphereLimb: limb }, null, 2));
      assert.ok(limb.samples > 1000, 'atmosphere limb A/B must cover a useful pixel band');
      assert.ok(limb.meanLuminanceDelta > 0.4,
        `atmosphere limb must add light rather than a black outline: ${limb.meanLuminanceDelta}`);
      assert.ok(limb.meanBlueDelta > 0.2,
        `atmosphere limb must retain a blue scattering cue: ${limb.meanBlueDelta}`);
      assert.ok(limb.darkenedFraction < 0.03,
        `atmosphere limb darkened too many pixels: ${limb.darkenedFraction}`);
      await page.evaluate(() => {
        NMS.setAtmosphereVisible(true);
        NMS.setCloudsVisible(false, 0);
      });
      await page.waitForTimeout(350);
      await capture(page, '01b-orbit-no-clouds');
      if (atmosphereAb) {
        for (const scale of [8, 4, 2]) {
          await page.evaluate((value) => {
            NMS._pipeline.atmospherePass.material.uniforms.uRadianceScale.value = value;
          }, scale);
          await page.waitForTimeout(250);
          await capture(page, `01b-atmosphere-scale-${scale}`);
        }
        await page.evaluate(() => {
          NMS._pipeline.atmospherePass.material.uniforms.uRadianceScale.value = 14;
        });
      }
      await page.evaluate(() => {
        NMS.setCloudsVisible(true, 0);
        const planet = NMS._planet(0);
        planet.__visualSmokeEclipseSetter = planet.setEclipseOccluder;
        planet.setEclipseOccluder = function disableEclipseForVisualSmoke() {
          return this.__visualSmokeEclipseSetter(null);
        };
        planet.setEclipseOccluder();
      });
      await page.waitForTimeout(350);
      await capture(page, '01c-orbit-no-eclipse');
      await page.evaluate(() => {
        const planet = NMS._planet(0);
        planet.setEclipseOccluder = planet.__visualSmokeEclipseSetter;
        delete planet.__visualSmokeEclipseSetter;
      });
    }
  }

  if (focus === 'all' || focus === 'atmosphere') {
    await page.evaluate((altitude) => NMS.setAtmosphereAltitude(0, altitude, { pitch: -0.2 }),
      atmosphereAltitude);
    await page.waitForTimeout(700);
    await capture(page, '02-lowflight-down');
    await page.evaluate(() => NMS.lookPitch(38));
    await page.waitForTimeout(500);
    await capture(page, '03-lowflight-up');
  }

  let wakeReady = null;
  if (focus === 'all' || focus === 'vegetation') {
    await page.evaluate(() => NMS.land(0, 0, 'meadow'));
    await page.waitForFunction(() => NMS.stats().grassField.total > 50,
      null, { timeout: 12000 });
    await page.waitForTimeout(500);
    await capture(page, '04-walk-meadow');

  }
  if (focus === 'all' || focus === 'water') {
    await page.evaluate(() => NMS.setSunAltitude(0, 35));
    wakeReady = await page.evaluate(() => NMS.setWaterWake(0, { height: 8, speed: 150 }));
    if (wakeReady) {
      await page.waitForTimeout(3800);
      await capture(page, '05-water-wake');
      console.log(JSON.stringify({ waterField: await page.evaluate(() => NMS.waterField()) }, null, 2));
    }
  }

  console.log(JSON.stringify({ errors, wakeReady }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
