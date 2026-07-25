// Far-distance FPS comparison. Measures steady-state frame rate at several
// altFactors to validate the camera-proximity-gated cloud/atmosphere march.
//   node tools/farperf.js
// Optional: PERF_FACTOR=4 PERF_QUALITY=high node tools/farperf.js

import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const width = Number(process.env.PERF_WIDTH) || 1920;
const height = Number(process.env.PERF_HEIGHT) || 1080;
const sampleMs = Number(process.env.PERF_SAMPLE_MS) || 6000;
const quality = process.env.PERF_QUALITY || 'high';

const factors = (process.env.PERF_FACTORS || '1.3,2.5,4.0,8.0')
  .split(',').map(Number);

let browser, server;
try {
  const started = await startServer(0);
  server = started.server;
  browser = await launchWebGPUHardwareBrowser({ headless: true });
  if (!browser) throw new Error('System Chrome/Edge is required for far-perf.');
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = new URL(`http://127.0.0.1:${started.port}/`);
  url.searchParams.set('worldlab', '1');
  url.searchParams.set('nolock', '1');
  url.searchParams.set('nohero', '1');
  url.searchParams.set('scene', 'orbit');
  url.searchParams.set('planet', '0');
  url.searchParams.set('factor', '0.12');
  url.searchParams.set('farflora', '0');
  url.searchParams.set('renderer', 'auto');
  url.searchParams.set('quality', quality);
  url.searchParams.set('freeze', '1');

  await page.goto(url.href);
  await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
  await page.waitForFunction(() => NMS.idle(), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(800);

  const results = [];
  for (const factor of factors) {
    await page.evaluate((f) => NMS.teleport(0, f, { dir: [1, 0.2, 0.3] }), factor);
    await page.waitForTimeout(1200);
    const timing = await page.evaluate((duration) => new Promise((resolve) => {
      const gaps = [];
      let frames = 0;
      let previous = performance.now();
      const start = previous;
      function sample(now) {
        frames++;
        const gap = now - previous;
        if (gap > 25) gaps.push(gap);
        previous = now;
        if (now - start >= duration) {
          resolve({
            fps: frames * 1000 / (now - start),
            maxFrameMs: gaps.length ? Math.max(...gaps) : 0,
            framesOver25Ms: gaps.length,
          });
        } else {
          requestAnimationFrame(sample);
        }
      }
      requestAnimationFrame(sample);
    }), sampleMs);
    const state = await page.evaluate(() => {
      const { universe, nav } = NMS._internals;
      const planet = universe.system.planets[0];
      // worldPositionToLocal subtracts the planet's universe position before
      // rotating, giving true camera-relative distance (worldOffsetToLocal
      // does not subtract, so it reports a meaningless universe-scale length).
      const camR = planet.worldPositionToLocal(nav.pos).length();
      const rOut = planet.volCloudMat?.uniforms?.uRout?.value || 0;
      const uCamProx = planet.volCloudMat?.uniforms?.uCamProx?.value;
      const uEngage = planet.volCloudMat?.uniforms?.uEngage?.value;
      return { alt: NMS.stats().alt, camR, rOut, ratio: rOut ? camR / rOut : 0, uCamProx, uEngage };
    });
    results.push({ factor, ...timing, ...state });
  }

  console.log(JSON.stringify({ quality, viewport: `${width}x${height}`, results, errors }, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
