// Stage B real-hardware acceptance: physical atmosphere, binary lighting,
// deterministic weather, surface effects, depth-aware volume and 2K cost.

import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const failures = [];
let passes = 0;
function check(condition, label, detail = '') {
  if (condition) {
    passes++;
    console.log(`✓ ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${label}${detail ? `: ${detail}` : ''}`);
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function roiStats(buffer, x0, y0, x1, y1) {
  const png = PNG.sync.read(buffer);
  const sx = Math.floor(png.width * x0), ex = Math.floor(png.width * x1);
  const sy = Math.floor(png.height * y0), ey = Math.floor(png.height * y1);
  let count = 0, r = 0, g = 0, b = 0, luma = 0, luma2 = 0;
  let nearBlack = 0, nearWhite = 0;
  for (let y = sy; y < ey; y++) for (let x = sx; x < ex; x++) {
    const index = (y * png.width + x) * 4;
    const pr = png.data[index], pg = png.data[index + 1], pb = png.data[index + 2];
    const value = pr * 0.2126 + pg * 0.7152 + pb * 0.0722;
    r += pr; g += pg; b += pb; luma += value; luma2 += value * value; count++;
    if (value < 4) nearBlack++;
    if (value > 248) nearWhite++;
  }
  const mean = luma / count;
  return {
    r: r / count, g: g / count, b: b / count,
    mean, deviation: Math.sqrt(Math.max(0, luma2 / count - mean * mean)),
    nearBlack: nearBlack / count, nearWhite: nearWhite / count,
  };
}

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('↷ Stage B hardware visual: skipped (no system Chrome/Edge)');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const outputDir = new URL('../test-results/stage-b/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const runtimeErrors = [];
const watch = (page) => {
  page.on('pageerror', (error) => runtimeErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
};

try {
  const orbit = await browser.newPage({ viewport: { width: 2048, height: 1152 } });
  watch(orbit);
  await orbit.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=0.72&time=9.5');
  await orbit.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  await orbit.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    NMS.resetPerformanceStats();
  });
  await orbit.waitForTimeout(6000);
  const orbitState = await orbit.evaluate(() => ({
    stats: NMS.stats(),
    volume: NMS.volumeState(),
    stellar: NMS.stellarState(0),
    weather: NMS.weatherState(0, [0.31, 0.42, 0.85]),
  }));
  const orbitCapture = await orbit.screenshot();
  await writeFile(new URL('orbit-2k.png', outputDir), orbitCapture);
  const orbitImage = roiStats(orbitCapture, 0.18, 0.02, 0.82, 0.98);
  check(orbitState.stats.rendererBackend === 'webgpu', '2K scene uses the WebGPU production backend');
  check(orbitState.volume.depthReady === 1 && orbitState.volume.cloudDepthReady === 1,
    'atmosphere and clouds consume opaque scene depth');
  check(orbitState.stellar?.count === 2
      && orbitState.stellar.sources.every((source) => source.irradiance > 0),
  'home-world atmosphere receives both stellar contributions');
  check(orbitState.stats.averageFps >= 30 && orbitState.stats.low1Fps >= 20,
    '2K high-quality orbit remains interactive',
    `${orbitState.stats.averageFps} avg / ${orbitState.stats.low1Fps} low-1% FPS`);
  check(orbitImage.nearBlack < 0.82 && orbitImage.nearWhite < 0.72
      && orbitImage.deviation > 18,
  'orbit image retains terrain/cloud/limb dynamic range',
  `black ${(orbitImage.nearBlack * 100).toFixed(1)}%, white ${(orbitImage.nearWhite * 100).toFixed(1)}%, sd ${orbitImage.deviation.toFixed(1)}`);
  const firstFingerprint = orbitState.weather.fingerprint;
  const evolvedFingerprint = await orbit.evaluate(() => {
    NMS.setTime(NMS.stats().cosmicHours + 6);
    return NMS.weatherState(0, [0.31, 0.42, 0.85]).fingerprint;
  });
  check(firstFingerprint !== evolvedFingerprint,
    'weather evolves from absolute celestial time without frame integration');
  await orbit.close();

  const surface = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  watch(surface);
  await surface.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + '&nohero=1&farflora=0&vclouds=1&freeze=1&weather=cumulus');
  await surface.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  await surface.evaluate(() => {
    NMS.land(0, 0, 'sunset');
    NMS.setSunAltitude(0, 0, { faceSun: true });
  });
  await surface.waitForTimeout(2600);
  const sunsetState = await surface.evaluate(() => ({
    environment: NMS.stats().environment,
    volume: NMS.volumeState(),
  }));
  const sunsetCapture = await surface.screenshot();
  await writeFile(new URL('sunset-shafts.png', outputDir), sunsetCapture);
  const sunsetSky = roiStats(sunsetCapture, 0.18, 0.20, 0.82, 0.58);
  check(sunsetState.environment.sunset > 0.65
      && sunsetState.environment.directTransmittance < 0.5,
  'zero-altitude sun enters the long-path sunset regime');
  check(sunsetState.volume.sunShaftStrength > 0.05
      && sunsetState.volume.sunShaftDebug?.reason === 'active',
  'humid low sun activates bounded radial light shafts',
  `strength ${sunsetState.volume.sunShaftStrength.toFixed(3)}`);
  check(sunsetSky.r > sunsetSky.b * 0.82,
    'sunset sky shifts away from the cold daytime palette',
    `R ${sunsetSky.r.toFixed(1)} / B ${sunsetSky.b.toFixed(1)}`);

  await surface.evaluate(() => NMS.setWeatherFixture(0, 'storm'));
  await surface.waitForTimeout(900);
  const stormState = await surface.evaluate(() => NMS.weatherState(0));
  const stormCapture = await surface.screenshot();
  await writeFile(new URL('storm-rain.png', outputDir), stormCapture);
  check(stormState.kind === 'storm' && stormState.effects.rainVisible
      && stormState.effects.precipitation > 0.7,
  'storm fixture renders dense rain and exposes live effect state');

  await surface.evaluate(() => NMS.setWeatherFixture(0, 'snow'));
  await surface.waitForTimeout(900);
  const snowState = await surface.evaluate(() => NMS.weatherState(0));
  const snowCapture = await surface.screenshot();
  await writeFile(new URL('snow.png', outputDir), snowCapture);
  check(snowState.kind === 'snow' && snowState.effects.snowVisible,
    'snow fixture renders a distinct particle system');

  await surface.evaluate(() => {
    NMS.setWeatherFixture(0, 'clear');
    NMS.setHeadlampEnabled(false);
    const planet = NMS._planet(0);
    NMS.teleport(0, 0.45, {
      dir: planet.sunDirLocal.clone().negate().toArray(),
    });
  });
  await surface.waitForTimeout(900);
  const nightCapture = await surface.screenshot();
  await writeFile(new URL('night-fill.png', outputDir), nightCapture);
  const nightGround = roiStats(nightCapture, 0.24, 0.12, 0.76, 0.88);
  const nightState = await surface.evaluate(() => ({
    environment: NMS.stats().environment,
    lighting: NMS.lightingState(),
  }));
  check(nightState.environment.day < 0.03, 'night fixture reaches negligible direct daylight');
  check(nightGround.mean > 3 && nightGround.mean < 110 && nightGround.nearBlack < 0.94,
    'night-side terrain remains readable without becoming daylight',
    `planet mean ${nightGround.mean.toFixed(1)}, black ${(nightGround.nearBlack * 100).toFixed(1)}%, lights ${JSON.stringify(nightState.lighting)}`);
  await surface.close();

  check(runtimeErrors.length === 0, 'Stage B hardware scenarios emit no browser/GPU errors',
    runtimeErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\nStage B hardware acceptance: ${passes} passed, ${failures.length} failed.`);
if (failures.length) {
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exitCode = 1;
} else {
  console.log('PASS: Stage B visual, weather and 2K WebGPU gates are satisfied.');
}
