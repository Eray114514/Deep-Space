import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = `test-results/f6-planet-traversal-2k/${stamp}`;
await mkdir(out, { recursive: true });

const { server, port } = await startServer(0);
let browser;
const pageErrors = [];
try {
  browser = await launchHardwareBrowser({
    headless: true,
    executablePath: resolveSystemChromePath() || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const page = await context.newPage();
  page.on('pageerror', err => pageErrors.push(String(err?.stack || err)));

  const navStart = Date.now();
  await page.goto(
    `http://127.0.0.1:${port}/?quality=balanced&nohero=1&nolock=1&post=1&vclouds=1&farflora=1&taa=1`,
    { waitUntil: 'commit' },
  );
  await page.waitForFunction(() => Boolean(window.NMS?.booted), null, { timeout: 120000 });
  const bootMs = Date.now() - navStart;
  console.log('Booted in', bootMs, 'ms');

  const measureRafWindow = async (frames = 36) => page.evaluate(async (count) => {
    const gl = NMS._renderer.getContext();
    const intervals = [];
    let prev = await new Promise(r => requestAnimationFrame(r));
    for (let i = 0; i < count; i++) {
      const now = await new Promise(r => requestAnimationFrame(r));
      intervals.push(+(now - prev).toFixed(2));
      prev = now;
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const medianMs = sorted[sorted.length >> 1];
    const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const maxMs = sorted[sorted.length - 1];
    return {
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      medianMs: +medianMs.toFixed(2),
      medianFps: +(1000 / Math.max(medianMs, 0.1)).toFixed(2),
      p95Ms: +p95Ms.toFixed(2),
      maxMs: +maxMs.toFixed(2),
      representation: NMS.volumeState()?.representation || null,
      textures: NMS._renderer.info.memory.textures,
      geometries: NMS._renderer.info.memory.geometries,
      gl: gl.getError(),
      lost: gl.isContextLost(),
    };
  }, frames);

  // Stage 1: Orbit (pointDirect -> cachedDirect + real approach thrust)
  await page.evaluate(async () => {
    const vp = NMS._pipeline.volumePass;
    for (let i = 0; i < 160 && (vp.farSplit?.lastRoute !== 'cachedDirect' || vp.lightBatchPrefetch?.state !== 'ready'); i++) {
      await new Promise(r => requestAnimationFrame(r));
    }
  });
  await page.keyboard.down('KeyW');
  await page.mouse.down({ button: 'right' });
  const stage1Orbit = await measureRafWindow(36);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: `${out}/1-orbit-2k.png` });
  console.log('Stage 1 Orbit:', JSON.stringify(stage1Orbit));

  // Stage 2: Continuous Far (215 km) -> Near (< 195 km) cloud representation handoff under active flight
  const stage2Handoff = await page.evaluate(async () => {
    const p = NMS._planet(0);
    const gl = NMS._renderer.getContext();
    const vp = NMS._pipeline.volumePass;
    const seaDir = [0.34669147556655305, 0.07291666666666663, -0.9351407276403421];
    const farStartAlt = (p.volCloudBand.rOut - p.R) + 215000;
    NMS.teleport(0, farStartAlt / p.R, { dir: seaDir, horizon: false });
    NMS.setLocalSunAltitude(0, 28);
    // Warm prefetch at 215 km for 20 frames while flying inward across the 200 km boundary!
    for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
    const repBefore = NMS.volumeState()?.representation;

    // Smoothly step altitude from 215 km -> 175 km across 30 live frames (simulating fast orbital dive across 200 km!)
    const intervals = [];
    let prev = await new Promise(r => requestAnimationFrame(r));
    for (let step = 1; step <= 32; step++) {
      const alt = farStartAlt - step * 4500; // crosses 200 km around step 4 down to 71 km!
      NMS.teleport(0, alt / p.R, { dir: seaDir, horizon: true, pitch: -0.35 });
      const now = await new Promise(r => requestAnimationFrame(r));
      intervals.push(+(now - prev).toFixed(2));
      prev = now;
    }
    const handoffStart = performance.now();
    while (!vp.lightBatchStatus?.submitted && performance.now() - handoffStart < 10000) {
      const now = await new Promise(r => requestAnimationFrame(r));
      intervals.push(+(now - prev).toFixed(2));
      prev = now;
    }
    const handoffWaitMs = +(performance.now() - handoffStart).toFixed(2);
    for (let i = 0; i < 6; i++) {
      const now = await new Promise(r => requestAnimationFrame(r));
      intervals.push(+(now - prev).toFixed(2));
      prev = now;
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    return {
      repBefore,
      repAfter: NMS.volumeState()?.representation,
      batchSubmitted: Boolean(vp.lightBatchStatus?.submitted),
      handoffWaitMs,
      medianMs: sorted[sorted.length >> 1],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxHandoffGapMs: sorted[sorted.length - 1],
      gl: gl.getError(),
    };
  });
  await page.screenshot({ path: `${out}/2-descent-handoff-2k.png` });
  console.log('Stage 2 Handoff:', JSON.stringify(stage2Handoff));

  // Stage 3: Coastal & Forest Low-Flight (380 m) with FarFlora + Cross-Scale Shadows + Clouds + TAA
  await page.evaluate(async () => {
    NMS.coast(0, 380);
    NMS.setLocalSunAltitude(0, 22);
    NMS.shipViewDebug.setViewMode('chase');
    NMS.setBuildBudget(60);
    for (let i = 0; i < 36; i++) await new Promise(r => requestAnimationFrame(r));
    NMS.setBuildBudget(0);
  });
  await page.keyboard.down('KeyW');
  await page.mouse.wheel(0, -160);
  const stage3LowFlight = await measureRafWindow(40);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: `${out}/3-coastal-lowflight-2k.png` });
  console.log('Stage 3 LowFlight:', JSON.stringify(stage3LowFlight));

  // Stage 4: Near-Water Skim (45 m) -> Scenic Meadow Landing & On-Foot Walk!
  const stage4WaterAndWalk = await page.evaluate(async () => {
    const p = NMS._planet(0);
    const seaDir = [0.34669147556655305, 0.07291666666666663, -0.9351407276403421];
    NMS.setBuildBudget(80);
    NMS.teleport(0, (p.seaLevel + 45) / p.R, { dir: seaDir, horizon: true, pitch: -0.04 });
    const wStart = performance.now();
    while (performance.now() - wStart < 35000) {
      const w = NMS.waterState(0);
      if (w?.near?.visible && !w.near.pending && w.global.pending === 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    NMS.setBuildBudget(0);
    return { nearWaterCell: NMS.waterState(0)?.near?.cellSize ?? null };
  });
  const nearWaterPerf = await measureRafWindow(30);

  // Land on meadow & walk on foot!
  await page.evaluate(async () => {
    NMS.land(0, 'meadow');
    NMS.setLocalSunAltitude(0, 18);
    NMS.setBuildBudget(60);
    for (let i = 0; i < 30; i++) await new Promise(r => requestAnimationFrame(r));
    NMS.setBuildBudget(0);
  });
  await page.keyboard.down('KeyW');
  const walkPerf = await measureRafWindow(36);
  await page.keyboard.up('KeyW');
  const walkStats = await page.evaluate(() => ({
    state: NMS.stats()?.state,
    grassInstances: NMS.scatterStats?.()?.total ?? null,
    farFloraInstances: NMS.farFloraStats?.()?.instances ?? null,
    gl: NMS._renderer.getContext().getError(),
  }));
  await page.screenshot({ path: `${out}/4-surface-walk-2k.png` });
  console.log('Stage 4 Water+Walk:', JSON.stringify({ nearWaterPerf, walkPerf, walkStats }));

  // Stage 5: Star-System Excursion & Home Planet Revisit
  const stage5Revisit = await page.evaluate(async () => {
    const r = NMS._renderer, gl = r.getContext();
    const texBefore = r.info.memory.textures;
    const homeStarId = NMS.systemInfo?.()?.id || 'MW-0903';
    NMS.warpToStar('MW-0925');
    const t0 = performance.now();
    while (NMS.stats()?.state === 'warp' && performance.now() - t0 < 20000) {
      await new Promise(res => requestAnimationFrame(res));
    }
    for (let i = 0; i < 10; i++) await new Promise(res => requestAnimationFrame(res));
    const foreignGl = gl.getError();

    NMS.warpToStar(homeStarId);
    const t1 = performance.now();
    while (NMS.stats()?.state === 'warp' && performance.now() - t1 < 20000) {
      await new Promise(res => requestAnimationFrame(res));
    }
    NMS.coast(0, 320);
    NMS.setLocalSunAltitude(0, 24);
    NMS.shipViewDebug.setViewMode('chase');
    for (let i = 0; i < 24; i++) await new Promise(res => requestAnimationFrame(res));
    return {
      texBefore,
      texAfterReturn: r.info.memory.textures,
      geoAfterReturn: r.info.memory.geometries,
      foreignGl,
      returnGl: gl.getError(),
      lost: gl.isContextLost(),
    };
  });
  const revisitPerf = await measureRafWindow(30);
  await page.screenshot({ path: `${out}/5-revisit-coast-2k.png` });

  const report = {
    bootMs,
    stage1Orbit,
    stage2Handoff,
    stage3LowFlight,
    stage4WaterAndWalk: { ...stage4WaterAndWalk, nearWaterPerf, walkPerf, walkStats },
    stage5Revisit: { ...stage5Revisit, revisitPerf },
    pageErrors,
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(stage1Orbit.drawingBuffer, [2560, 1440]);
  assert.equal(stage1Orbit.gl, 0);
  assert.equal(stage2Handoff.repBefore, 'far-column');
  assert.equal(stage2Handoff.repAfter, 'near-volume');
  assert.equal(stage2Handoff.batchSubmitted, true);
  assert.ok(stage2Handoff.maxHandoffGapMs < 500, `Far->Near handoff must not stall (${stage2Handoff.maxHandoffGapMs} ms)`);
  assert.equal(stage2Handoff.gl, 0);
  assert.equal(stage3LowFlight.gl, 0);
  assert.equal(nearWaterPerf.gl, 0);
  assert.equal(walkPerf.gl, 0);
  assert.equal(walkStats.state, 'walk');
  assert.equal(walkStats.gl, 0);
  assert.equal(stage5Revisit.foreignGl, 0);
  assert.equal(stage5Revisit.returnGl, 0);
  assert.equal(stage5Revisit.lost, false);
  assert.equal(revisitPerf.gl, 0);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
