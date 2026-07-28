import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('Atmosphere traversal diagnostic skipped: no hardware WebGPU browser.');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const outputDir = new URL('../test-results/atmosphere-traversal/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=0.152&time=9.5');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  await page.evaluate(() => NMS.setAdaptiveQualityLocked(true));
  const planet = await page.evaluate(() => {
    const body = NMS._planet(0);
    return {
      radius: body.R,
      atmosphereHeight: body.atmoHeight,
      direction: body.scenicDir(body.sunDirLocal).lerp(body.sunDirLocal, 0.55).normalize().toArray(),
    };
  });
  const altitudesKm = process.argv[3]
    ? process.argv[3].split(',').map(Number).filter(Number.isFinite)
    : [130, 100, 80, 60, 45, 30, 18, 12, 9, 6, 3, 1];
  const fixtures = process.argv[2] ? process.argv[2].split(',') : ['clear', 'cumulus', 'storm'];
  for (const fixture of fixtures) {
    await page.evaluate((name) => NMS.setWeatherFixture(0, name), fixture);
    for (const altitudeKm of altitudesKm) {
      await page.evaluate(({ altitude, direction }) => NMS.setAtmosphereAltitude(0,
        altitude * 1000, { dir: direction, horizon: true, pitch: -0.22 }), {
        altitude: altitudeKm,
        direction: planet.direction,
      });
      await page.waitForTimeout(900);
      const state = await page.evaluate(() => ({
        stats: NMS.stats(),
        volume: NMS.volumeState(),
      }));
      await writeFile(new URL(`${fixture}-${String(altitudeKm).padStart(3, '0')}km.png`,
        outputDir), await page.screenshot());
      console.log(fixture, altitudeKm, JSON.stringify({
        actualAltitude: state.stats.alt,
        atmosphere: state.stats.environment.atmosphere,
        cloudDensity: state.stats.environment.cloudDensity,
        depthReady: state.volume.depthReady,
        depthReversed: state.volume.depthReversed,
      }));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
