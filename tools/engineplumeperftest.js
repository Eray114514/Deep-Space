// Same-camera 2K hardware A/B for the HALCYON engine-plume foreground cost.
// GPU timer queries measure the complete frame with the two plume rigs on and
// off; exact draw-call delta verifies that the comparison really toggled them.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const output = path.resolve('test-results/engine-plume');
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for engine-plume performance A/B.');

const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

async function setPlumeVisible(visible) {
  await page.evaluate((nextVisible) => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) {
      rig.visible = nextVisible;
    }
  }, visible);
  await page.waitForTimeout(600);
}

async function measure(label, visible) {
  await setPlumeVisible(visible);
  const frame = await page.evaluate(() => new Promise((resolve) => {
    const frames = [];
    let previous = performance.now();
    const tick = (now) => {
      frames.push(now - previous);
      previous = now;
      if (frames.length < 54) requestAnimationFrame(tick);
      else {
        const sorted = frames.slice(8).sort((a, b) => a - b);
        const percentile = (p) => sorted[Math.min(sorted.length - 1,
          Math.floor(sorted.length * p))];
        resolve({
          frameMedianMs: percentile(0.5),
          frameP95Ms: percentile(0.95),
          draws: NMS.stats().calls,
          triangles: NMS.stats().tris,
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  const gpu = await page.evaluate(() => new Promise((resolve) => {
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
    const target = 42;
    const deadline = performance.now() + 20000;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      pipeline.render = original;
      for (const query of pending) gl.deleteQuery(query);
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
  return { label, visible, ...frame, ...gpu };
}

try {
  await page.goto(`http://127.0.0.1:${port}/?quality=balanced&nolock=1&nohero=1`
    + '&post=1&vclouds=0&farflora=0&freeze=1&buildms=25&shaderchecks=1');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 150000 });
  await page.evaluate(() => {
    document.body.classList.add('hide-hud');
    NMS.setAdaptiveQualityLocked(true);
    if (NMS._pipeline.grade) NMS._pipeline.grade.enabled = false;
    const { scene, ship } = NMS._internals;
    /* Terrain/water construction continues asynchronously after boot and used
       to contaminate the A/B with unrelated draw and GPU work.  Measure the
       foreground contract in a fixed dark-field scene: same camera, lights and
       ship, with only the two plume rigs toggled by the harness. */
    for (const child of scene.children) {
      if (child === ship.group || child.isLight) continue;
      child.visible = false;
    }
    for (const strobe of ship.ext.strobes) strobe.visible = false;
    scene.background = new NMS._THREE.Color(0x02050a);
    const originalFx = ship.updateEngineFx.bind(ship);
    ship.updateEngineFx = (dt) => originalFx(dt, 1.34e6, 0, 0);
    const originalUpdate = ship.update.bind(ship);
    const proofPose = new NMS._THREE.Quaternion()
      .setFromEuler(new NMS._THREE.Euler(-0.07, -0.34, -0.025, 'YXZ'));
    ship.update = (...args) => {
      const result = originalUpdate(...args);
      ship.group.quaternion.multiply(proofPose);
      return result;
    };
  });
  await page.waitForTimeout(1800);

  /* ABBAAB order cancels most thermal/driver drift and stops one unusually
     slow frame window from becoming the claimed effect cost.  Each entry still
     owns 42 independent GPU timer queries and its own rAF distribution. */
  const sequence = [false, true, true, false, false, true];
  const samples = [];
  for (let index = 0; index < sequence.length; index++) {
    const visible = sequence[index];
    samples.push(await measure(`${visible ? 'plume-on' : 'plume-off'}-${index + 1}`, visible));
  }
  await page.screenshot({ path: path.join(output, '06-high-power-2k-hardware.png') });

  const controls = samples.filter((sample) => !sample.visible);
  const plumes = samples.filter((sample) => sample.visible);
  const median = (values) => {
    const ordered = values.slice().sort((a, b) => a - b);
    return ordered[Math.floor(ordered.length / 2)];
  };
  const aggregate = (entries) => ({
    frameMedianMs: median(entries.map((entry) => entry.frameMedianMs)),
    frameP95Ms: median(entries.map((entry) => entry.frameP95Ms)),
    draws: median(entries.map((entry) => entry.draws)),
    triangles: median(entries.map((entry) => entry.triangles)),
    gpuSamples: entries.reduce((sum, entry) => sum + entry.gpuSamples, 0),
    gpuMedianMs: entries.every((entry) => entry.gpuMedianMs != null)
      ? median(entries.map((entry) => entry.gpuMedianMs)) : null,
    gpuP95Ms: entries.every((entry) => entry.gpuP95Ms != null)
      ? median(entries.map((entry) => entry.gpuP95Ms)) : null,
  });
  const control = aggregate(controls);
  const plume = aggregate(plumes);
  const gpuUsable = controls.every((sample) => sample.gpuSamples >= 24)
    && plumes.every((sample) => sample.gpuSamples >= 24);
  const gpuDeltaMs = gpuUsable ? plume.gpuMedianMs - control.gpuMedianMs : null;
  const frameDeltaMs = plume.frameMedianMs - control.frameMedianMs;
  const result = {
    viewport: '2560x1440',
    control,
    plume,
    samples,
    drawDelta: plume.draws - control.draws,
    gpuDeltaMs,
    frameDeltaMs,
    errors,
  };
  await writeFile(path.join(output, 'performance.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));

  if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`);
  if (result.drawDelta !== 2) {
    throw new Error(`engine plume draw delta is ${result.drawDelta}; expected exactly 2`);
  }
  if (gpuUsable && gpuDeltaMs > 0.45) {
    throw new Error(`engine plume costs +${gpuDeltaMs.toFixed(3)} ms GPU; budget is +0.450 ms`);
  }
  if (frameDeltaMs > 1.5) {
    throw new Error(`engine plume costs +${frameDeltaMs.toFixed(3)} ms rAF; budget is +1.500 ms`);
  }
  const metric = gpuUsable
    ? `GPU median ${gpuDeltaMs >= 0 ? '+' : ''}${gpuDeltaMs.toFixed(3)} ms`
    : `rAF median ${frameDeltaMs >= 0 ? '+' : ''}${frameDeltaMs.toFixed(3)} ms (GPU timer unavailable)`;
  console.log(`PASS: 2K engine plume ${metric}; ${result.drawDelta} instanced draws`);
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
