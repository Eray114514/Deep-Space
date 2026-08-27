import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('test-results/render-look');
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for render-look performance A/B.');

async function measure(mode) {
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const startedAt = performance.now();
  await page.goto(`http://127.0.0.1:${port}/?quality=balanced&nolock=1&nohero=1`
    + `&vclouds=0&farflora=0&freeze=1&post=1&renderlook=${mode}`);
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 150000 });
  const bootMs = performance.now() - startedAt;
  await page.evaluate(() => NMS.setAdaptiveQualityLocked(true));
  await page.waitForTimeout(1800);
  const frameSample = await page.evaluate(() => new Promise((resolve) => {
    const frames = [];
    let previous = performance.now();
    const tick = (now) => {
      frames.push(now - previous);
      previous = now;
      if (frames.length < 42) requestAnimationFrame(tick);
      else {
        const sorted = frames.slice(6).sort((a, b) => a - b);
        const percentile = (p) => sorted[Math.min(sorted.length - 1,
          Math.floor(sorted.length * p))];
        resolve({
          frameMedianMs: percentile(0.5),
          frameP95Ms: percentile(0.95),
          frameMaxMs: sorted.at(-1),
          draws: NMS.stats().calls,
          programs: NMS._renderer.info.programs?.length || 0,
          look: NMS.renderLookState(),
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  const gpuSample = await page.evaluate(() => new Promise((resolve) => {
    const renderer = NMS._renderer;
    const pipeline = NMS._pipeline;
    const gl = renderer.getContext();
    const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!extension) {
      resolve({ gpuSupported: false, gpuSamples: 0, gpuMedianMs: null, gpuP95Ms: null });
      return;
    }
    const original = pipeline.render.bind(pipeline);
    const pending = [];
    const samples = [];
    const target = 48;
    const deadline = performance.now() + 20000;
    const finish = () => {
      pipeline.render = original;
      samples.sort((a, b) => a - b);
      const percentile = (p) => samples[Math.min(samples.length - 1,
        Math.floor(samples.length * p))] ?? null;
      resolve({
        gpuSupported: true,
        gpuSamples: samples.length,
        gpuMedianMs: percentile(0.5),
        gpuP95Ms: percentile(0.95),
      });
    };
    pipeline.render = (...args) => {
      for (let i = pending.length - 1; i >= 0; i--) {
        const query = pending[i];
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
        const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT);
        const elapsed = gl.getQueryParameter(query, gl.QUERY_RESULT);
        gl.deleteQuery(query);
        pending.splice(i, 1);
        if (!disjoint && elapsed > 0) samples.push(elapsed / 1e6);
      }
      let query = null;
      if (samples.length + pending.length < target) {
        query = gl.createQuery();
        gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      }
      const result = original(...args);
      if (query) {
        gl.endQuery(extension.TIME_ELAPSED_EXT);
        pending.push(query);
      }
      if ((samples.length >= target && pending.length === 0)
        || performance.now() >= deadline) finish();
      return result;
    };
  }));
  const sample = { ...frameSample, ...gpuSample };
  await page.screenshot({ path: path.join(output, `ab-${mode}-2k.png`) });
  await page.close();
  return { mode, bootMs, errors, ...sample };
}

try {
  const legacy = await measure('legacy');
  const next = await measure('next');
  const metric = legacy.gpuSamples >= 24 && next.gpuSamples >= 24 ? 'gpuMedianMs' : 'frameMedianMs';
  const allowance = Math.max(1.5, legacy[metric] * 0.10);
  const regression = next[metric] - legacy[metric];
  console.log(JSON.stringify({ legacy, next, allowance, regression }, null, 2));
  if (legacy.errors.length || next.errors.length) {
    throw new Error(`browser errors: ${[...legacy.errors, ...next.errors].join('; ')}`);
  }
  if (regression > allowance) {
    throw new Error(`render look costs +${regression.toFixed(2)} ms; budget is +${allowance.toFixed(2)} ms`);
  }
  if (next.look.space?.minLuma <= 0.003) throw new Error('performance path lost the sky floor');
  console.log(`PASS: 2K render look ${metric} delta ${regression.toFixed(2)} ms `
    + `(budget ${allowance.toFixed(2)} ms; rAF ${legacy.frameMedianMs.toFixed(2)}`
    + ` -> ${next.frameMedianMs.toFixed(2)} ms)`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
