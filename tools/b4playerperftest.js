// Same player pose and post path, alternating cloud on/off on the real GPU.
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const fingerprint = await evidenceFingerprint('tools/b4playerperftest.js');
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&quality=ultra&freeze=1&time=9.5&nohero=1&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  await page.evaluate(async () => {
    window.B0 = await import('/tools/b0-browser.js');
    B0.installCaptureHold(); NMS.setAdaptiveQualityLocked(true);
    NMS.setAtmosphereVisible(true); NMS.setCloudsVisible(true, 0);
    B0.groundPose(0, 35);
  });
  await page.waitForFunction(() => __b0RenderedFrames > 32, null, { timeout: 150000 });
  const column = await page.evaluate(() => B0.occupiedColumn(0, 35));
  const gpu = await page.evaluate(() => {
    const gl = NMS._renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  const records = [];
  for (const scene of ['S2-below', 'S2-inside', 'S2-above', 'S4-globe']) {
    await page.evaluate(({ column, scene }) => {
      B0.cloudPose(0, column, scene);
    }, { column, scene });
    for (const enabled of [false, true]) {
      await page.evaluate((enabled) => {
        NMS.setCloudsVisible(enabled, 0);
        NMS._pipeline.volumePass.resetHistory();
      }, enabled);
      const start = await page.evaluate(() => __b0RenderedFrames);
      await page.waitForFunction((start) => __b0RenderedFrames >= start + 48,
        start, { timeout: 150000 });
      const sample = await page.evaluate(() => new Promise((resolve) => {
        const gaps = [], started = performance.now();
        let previous = started;
        function next(now) {
          gaps.push(now - previous); previous = now;
          if (now - started < 2500) { requestAnimationFrame(next); return; }
          gaps.sort((a, b) => a - b);
          resolve({ fps: gaps.length * 1000 / (now - started),
            p50Ms: gaps[Math.floor(gaps.length * 0.5)],
            p95Ms: gaps[Math.floor(gaps.length * 0.95)],
            p99Ms: gaps[Math.floor(gaps.length * 0.99)],
            maxMs: gaps[gaps.length - 1], frameCount: gaps.length,
            stats: NMS.stats(), volume: NMS.volumeState() });
        }
        requestAnimationFrame(next);
      }));
      records.push({ scene, clouds: enabled, ...sample });
      console.log(scene, enabled ? 'clouds-on' : 'clouds-off',
        sample.fps.toFixed(1), sample.p95Ms.toFixed(1));
    }
  }
  const output = `test-results/b4-player-perf/${fingerprint.sourceDigest.slice(0, 12)}`;
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify({ fingerprint, gpu, column,
    records, errors }, null, 2) + '\n');
  if (errors.length) throw Error(errors.join('\n'));
  console.log(output);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
