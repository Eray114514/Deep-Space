import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';

const outputDir = path.resolve('test-results/atmosphere-visual-diagnostic');
await mkdir(outputDir, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
if (!browser) throw new Error('A hardware Chromium browser is required.');

function imageStats(buffer) {
  const png = PNG.sync.read(buffer);
  let luminance = 0;
  let blueBias = 0;
  const pixels = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i] / 255;
    const g = png.data[i + 1] / 255;
    const b = png.data[i + 2] / 255;
    luminance += r * 0.2126 + g * 0.7152 + b * 0.0722;
    blueBias += Math.max(0, b - (r + g) * 0.5);
  }
  return {
    meanLuminance: luminance / pixels,
    meanBlueBias: blueBias / pixels,
  };
}

function imageDifference(a, b) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) {
    throw new Error('Atmosphere comparison dimensions do not match.');
  }
  let absolute = 0;
  let changed = 0;
  const pixels = pa.width * pa.height;
  for (let i = 0; i < pa.data.length; i += 4) {
    const delta = (Math.abs(pa.data[i] - pb.data[i])
      + Math.abs(pa.data[i + 1] - pb.data[i + 1])
      + Math.abs(pa.data[i + 2] - pb.data[i + 2])) / (255 * 3);
    absolute += delta;
    if (delta > 0.015) changed++;
  }
  return { meanAbsoluteRgb: absolute / pixels, changedFraction: changed / pixels };
}

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
  const url = `http://127.0.0.1:${port}/?renderer=webgl&quality=ultra`
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
    const style = document.createElement('style');
    style.textContent = 'body > *:not(#app), #app > *:not(canvas) { display: none !important; }';
    document.head.appendChild(style);
  });

  const captures = new Map();
  async function capture(name, setup) {
    await page.evaluate(setup);
    await page.waitForTimeout(500);
    const buffer = await page.screenshot();
    captures.set(name, buffer);
    await writeFile(path.join(outputDir, `${name}.png`), buffer);
    return imageStats(buffer);
  }

  const results = {};
  results.orbitDay = await capture('01-orbit-day', () => {
    NMS.setCloudsVisible(true);
    NMS.setAtmosphereVisible(true);
    NMS.teleport(0, 1.06);
  });
  results.orbitDayNoAtmosphere = await capture('02-orbit-day-no-atmosphere', () => {
    NMS.setAtmosphereVisible(false);
  });
  results.orbitAtmosphereOnly = await capture('03-orbit-atmosphere-only', () => {
    NMS.setAtmosphereVisible(true);
    NMS.setCloudsVisible(false);
  });
  results.orbitTerminator = await capture('04-orbit-terminator', () => {
    const planet = NMS._planet(0);
    const sun = planet.sunDirLocal.clone().normalize();
    const axis = Math.abs(sun.y) < 0.9
      ? new NMS._THREE.Vector3(0, 1, 0) : new NMS._THREE.Vector3(1, 0, 0);
    const tangent = new NMS._THREE.Vector3().crossVectors(sun, axis).normalize();
    NMS.setCloudsVisible(true);
    NMS.teleport(0, 1.06, { dir: tangent.toArray() });
  });
  results.orbitNight = await capture('05-orbit-night', () => {
    const planet = NMS._planet(0);
    NMS.teleport(0, 1.06, { dir: planet.sunDirLocal.clone().negate().toArray() });
  });
  await page.evaluate(() => {
    NMS.land(0, 0, 'sunset');
    NMS.setSunAltitude(0, 55, { faceSun: true });
  });
  await page.waitForTimeout(1600);
  results.groundDay = await capture('06-ground-day', () => {});
  results.groundDusk = await capture('07-ground-dusk', () => {
    NMS.setSunAltitude(0, 1.5, { faceSun: true });
  });
  results.groundDuskAtmosphereOnly = await capture('07b-ground-dusk-atmosphere-only', () => {
    NMS.setCloudsVisible(false);
  });
  results.groundNight = await capture('08-ground-night', () => {
    NMS.setCloudsVisible(true);
    NMS.setSunAltitude(0, -18, { faceSun: true });
  });
  results.groundNightAtmosphereOnly = await capture('08b-ground-night-atmosphere-only', () => {
    NMS.setCloudsVisible(false);
  });

  // Measure at the deterministic orbit fixture rather than immediately after
  // landing, where hundreds of terrain/water chunks are still streaming and
  // can dwarf or even invert the cost attributed to the atmosphere toggle.
  await page.evaluate(() => {
    NMS.setCloudsVisible(false);
    NMS.setAtmosphereVisible(true);
    NMS.teleport(0, 1.06);
  });
  await page.waitForTimeout(1600);
  const performance = await page.evaluate(async () => {
    const measure = async (enabled) => {
      NMS.setAtmosphereVisible(enabled);
      NMS.resetPerformanceStats();
      for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      const samples = [];
      let previous = performance.now();
      for (let i = 0; i < 120; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        samples.push(now - previous);
        previous = now;
      }
      samples.sort((a, b) => a - b);
      const percentile = (p) => samples[Math.min(samples.length - 1,
        Math.floor(samples.length * p))];
      return {
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: samples[samples.length - 1],
      };
    };
    // Bracket the enabled samples so monotonic GPU/streaming drift is not
    // misreported as pass overhead.
    const disabledA = await measure(false);
    const enabledA = await measure(true);
    const enabledB = await measure(true);
    const disabledB = await measure(false);
    const merge = (a, b) => ({
      medianMs: (a.medianMs + b.medianMs) * 0.5,
      p95Ms: (a.p95Ms + b.p95Ms) * 0.5,
      maxMs: Math.max(a.maxMs, b.maxMs),
    });
    const disabled = merge(disabledA, disabledB);
    const enabled = merge(enabledA, enabledB);
    NMS.setAtmosphereVisible(true);
    return {
      disabled,
      enabled,
      medianOverheadMs: enabled.medianMs - disabled.medianMs,
      p95OverheadMs: enabled.p95Ms - disabled.p95Ms,
      stats: NMS.stats(),
      atmosphere: NMS.atmosphereState(),
    };
  });

  const report = {
    url,
    renderer: performance.stats.rendererBackend,
    gpu: performance.stats.gpu,
    drawingBuffer: await page.evaluate(() => {
      const size = NMS._renderer.getDrawingBufferSize(new NMS._THREE.Vector2());
      return size.toArray();
    }),
    results,
    comparisons: {
      orbitAtmosphereContribution: imageDifference(
        captures.get('01-orbit-day'), captures.get('02-orbit-day-no-atmosphere')),
      orbitCloudContribution: imageDifference(
        captures.get('01-orbit-day'), captures.get('03-orbit-atmosphere-only')),
    },
    performance,
    errors,
  };
  await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
