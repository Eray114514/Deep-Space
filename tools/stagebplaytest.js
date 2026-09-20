// B consolidation captures through the normal post/HUD chain. No art PASS.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const directory = 'test-results/stage-b-player';
await mkdir(directory, { recursive: true });
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = `http://127.0.0.1:${port}/?renderer=webgl&quality=ultra&nohero=1&vclouds=1&post=1&freeze=1`;
  await page.goto(url);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  await page.evaluate(() => NMS.setAdaptiveQualityLocked(true));
  const captures = [];
  for (const name of ['orbit', 'cloud-top', 'surface', 'sunset']) {
    await page.evaluate((name) => {
      if (name === 'orbit') NMS.teleport(0, 0.72);
      if (name === 'cloud-top') NMS.setAtmosphereAltitude(0, 65000, { pitch: -0.08 });
      if (name === 'surface') NMS.setAtmosphereAltitude(0, 1000, { pitch: 0.5 });
      if (name === 'sunset') NMS.setSunAltitude(0, -1, { faceSun: true });
    }, name);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${directory}/${name}.png` });
    const state = await page.evaluate(async () => {
      const times = [];
      let previous = performance.now();
      for (let i = 0; i < 60; i++) {
        const now = await new Promise(requestAnimationFrame);
        times.push(now - previous); previous = now;
      }
      times.sort((a, b) => a - b);
      const renderer = NMS._renderer;
      const gl = renderer.getContext();
      const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      let atmosphereGpuMs = null;
      // Time the pass inside the live composer. Replaying it after the frame
      // would read ping-pong attachments already overwritten by later passes.
      // This excludes opaque/cloud/post costs and is not a frame-budget gate.
      if (extension && !gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
        const pass = NMS._pipeline.atmospherePass;
        const original = pass.render;
        const queries = [];
        pass.render = function timedRender(...args) {
          if (queries.length >= 5 || gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
            return original.apply(this, args);
          }
          const query = gl.createQuery();
          gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
          try { return original.apply(this, args); }
          finally { gl.endQuery(extension.TIME_ELAPSED_EXT); queries.push(query); }
        };
        try {
          for (let i = 0; i < 30 && queries.length < 5; i++) await new Promise(requestAnimationFrame);
        } finally { pass.render = original; }
        for (let i = 0; i < 120 && queries.some((q) => !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)); i++) {
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        if (queries.length === 5 && queries.every((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))
          && !gl.getParameter(extension.GPU_DISJOINT_EXT)) {
          const samples = queries.map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6).sort((a, b) => a - b);
          atmosphereGpuMs = samples[2];
        }
        for (const query of queries) gl.deleteQuery(query);
      }
      return { stats: NMS.stats(), atmosphere: NMS.atmosphereState(), volume: NMS.volumeState(),
        frameIntervalP95Ms: times[Math.floor(times.length * 0.95)], atmosphereGpuMs };
    });
    captures.push({ name, ...state });
  }
  assert.deepEqual(errors, []);
  assert.ok(captures.every((c) => c.stats.rendererBackend === 'webgl2'));
  const report = { url, browser: browser.version(),
    fingerprint: await evidenceFingerprint('tools/stagebplaytest.js'), captures, errors,
    scope: 'Four fixed player poses. Frame cadence includes terrain streaming; no performance, motion, multi-weather or final visual acceptance.' };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log('PASS: B player captures without shader/runtime errors', JSON.stringify(captures.map((c) => ({
    name: c.name, gpu: c.stats.gpu, drawingBuffer: c.volume.drawingBuffer,
    pending: c.stats.pending, frameIntervalP95Ms: c.frameIntervalP95Ms,
    atmosphereGpuMs: c.atmosphereGpuMs,
  })), null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
