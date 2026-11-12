import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = `test-results/f4-temporal-gpu/${stamp}`;
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

  await page.goto(
    `http://127.0.0.1:${port}/?quality=balanced&nohero=1&nolock=1&post=1&vclouds=1&farflora=1&taa=1`,
    { waitUntil: 'commit' },
  );
  await page.waitForFunction(() => Boolean(window.NMS?.booted), null, { timeout: 120000 });

  // 1. Verify initial TAA ownership, Halton jitter cycle, and restored unjittered camera projection
  const jitterAndOwnership = await page.evaluate(async () => {
    const gl = NMS._renderer.getContext();
    const pipe = NMS._pipeline;
    const baseProj8 = pipe.camera.projectionMatrix.elements[8];
    const baseProj9 = pipe.camera.projectionMatrix.elements[9];
    const seenJitters = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const ts = NMS.temporalState();
      seenJitters.push(ts.jitterPixels);
    }
    const afterProj8 = pipe.camera.projectionMatrix.elements[8];
    const afterProj9 = pipe.camera.projectionMatrix.elements[9];
    const uniqueJitters = new Set(seenJitters.map(j => `${j[0].toFixed(4)},${j[1].toFixed(4)}`)).size;
    return {
      temporalState: NMS.temporalState(),
      smaaEnabled: Boolean(pipe.smaa?.enabled),
      volumeExternalTaa: Boolean(pipe.volumePass?.externalTaaActive),
      uniqueJitters,
      projectionRestoredExact: Math.abs(afterProj8 - baseProj8) < 1e-12 && Math.abs(afterProj9 - baseProj9) < 1e-12,
      gl: gl.getError(),
    };
  });

  // 2. Near-water + cloud + rigid ship multi-producer motion buffer & representative cloud depth verification
  await page.evaluate(async () => {
    const p = NMS._planet(0);
    NMS.setBuildBudget(80);
    NMS.teleport(0, (p.seaLevel + 45) / p.R, {
      dir: [0.34669147556655305, 0.07291666666666663, -0.9351407276403421],
      horizon: true,
      pitch: 0.02,
    });
    NMS.setLocalSunAltitude(0, 28);
    NMS.shipViewDebug.setViewMode('chase');
    while (true) {
      const w = NMS.waterState(0);
      if (w?.near?.visible && !w.near.pending && w.global.pending === 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    NMS.setBuildBudget(0);
    const waitBatch = performance.now();
    while (!NMS._pipeline.volumePass.lightBatchStatus?.submitted && performance.now() - waitBatch < 8000) {
      await new Promise(r => requestAnimationFrame(r));
    }
  });

  // Fly & bank so ship, ocean waves, and weather-advected clouds all produce motion vectors
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -140);
    await page.mouse.move(850, 550);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(905, 550, { steps: 2 });
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(120);
  }
  await page.keyboard.up('KeyW');

  const producers = await page.evaluate(async () => {
    const THREE = await import('three');
    const r = NMS._renderer, gl = r.getContext(), pipe = NMS._pipeline;
    const taa = pipe.temporalAA, vp = pipe.volumePass;

    // Sample motionRead across full 2560x1440 (stride 8 -> 320x180 = 57,600 samples)
    const mw = taa.motionRead.width, mh = taa.motionRead.height;
    // Read a central 640x480 region covering ship (foreground tag 3), ocean (tag 1.5), and clouds (tag 1.25/0)
    const rw = Math.min(800, mw), rh = Math.min(600, mh);
    const ox = Math.floor((mw - rw) / 2), oy = Math.floor((mh - rh) / 2);
    const mRaw = new Uint16Array(rw * rh * 4);
    r.readRenderTargetPixels(taa.motionRead, ox, oy, rw, rh, mRaw);

    let shipPixels = 0, oceanPixels = 0, cloudMotionPixels = 0, worldPixels = 0, nonFinite = 0;
    let maxShipVelPx = 0, maxOceanVelPx = 0;
    for (let i = 0; i < rw * rh; i++) {
      const vx = THREE.DataUtils.fromHalfFloat(mRaw[i * 4]) * mw;
      const vy = THREE.DataUtils.fromHalfFloat(mRaw[i * 4 + 1]) * mh;
      const tag = THREE.DataUtils.fromHalfFloat(mRaw[i * 4 + 2]);
      const d = THREE.DataUtils.fromHalfFloat(mRaw[i * 4 + 3]);
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(tag) || !Number.isFinite(d)) {
        nonFinite++;
        continue;
      }
      const speed = Math.hypot(vx, vy);
      if (tag > 2.75) { shipPixels++; if (speed > maxShipVelPx) maxShipVelPx = speed; }
      else if (Math.abs(tag - 1.5) < 0.12) { oceanPixels++; if (speed > maxOceanVelPx) maxOceanVelPx = speed; }
      else if (Math.abs(tag - 1.25) < 0.12) cloudMotionPixels++;
      else if (tag > 0.8) worldPixels++;
    }

    // Verify cloud representative optical-mass depth target (R=repT, G=spreadT, B=firstT, A=lastT)
    const cw = vp.repDepth.width, ch = vp.repDepth.height;
    const cRaw = new Float32Array(cw * ch * 4);
    r.readRenderTargetPixels(vp.repDepth, 0, 0, cw, ch, cRaw);
    let repOccupied = 0, repOrderViolations = 0, maxRepT = 0, maxSpreadT = 0;
    for (let i = 0; i < cw * ch; i += 4) {
      const repT = cRaw[i * 4], spreadT = cRaw[i * 4 + 1], firstT = cRaw[i * 4 + 2], lastT = cRaw[i * 4 + 3];
      if (repT > 0) {
        repOccupied++;
        if (repT < firstT - 0.5 || repT > lastT + 0.5 || spreadT < -0.5) repOrderViolations++;
        if (repT > maxRepT) maxRepT = repT;
        if (spreadT > maxSpreadT) maxSpreadT = spreadT;
      }
    }

    return {
      nonFinite,
      shipPixels,
      oceanPixels,
      cloudMotionPixels,
      worldPixels,
      maxShipVelPx: +maxShipVelPx.toFixed(3),
      maxOceanVelPx: +maxOceanVelPx.toFixed(3),
      repOccupied,
      repOrderViolations,
      maxRepT: +maxRepT.toFixed(1),
      maxSpreadT: +maxSpreadT.toFixed(1),
      gl: gl.getError(),
    };
  });

  await page.screenshot({ path: `${out}/taa-flight-2k.png` });

  // 3. Stationary detail retention & TAA GPU frame-time measurement at 2560x1440
  const qualityAndPerf = await page.evaluate(async () => {
    const r = NMS._renderer, gl = r.getContext(), pipe = NMS._pipeline;
    // Stop ship motion & measure interior detail gradient retention: TAA OFF vs TAA ON (8 frames converged)
    const p = NMS._planet(0);
    NMS.teleport(0, (p.seaLevel + 180) / p.R, { horizon: true, pitch: -0.15 });
    for (let i = 0; i < 10; i++) await new Promise(res => requestAnimationFrame(res));

    const capturePatchGrad = () => {
      const w = 256, h = 256;
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(1152, 560, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let gradSum = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = (y * w + x) * 4;
          const l0 = 0.299 * px[idx] + 0.587 * px[idx + 1] + 0.114 * px[idx + 2];
          const lx = 0.299 * px[idx + 4] + 0.587 * px[idx + 5] + 0.114 * px[idx + 6];
          const ly = 0.299 * px[idx + w * 4] + 0.587 * px[idx + w * 4 + 1] + 0.114 * px[idx + w * 4 + 2];
          gradSum += Math.hypot(lx - l0, ly - l0);
        }
      }
      return gradSum / ((w - 2) * (h - 2));
    };

    NMS.setTemporalAA(false);
    for (let i = 0; i < 4; i++) await new Promise(res => requestAnimationFrame(res));
    const gradOff = capturePatchGrad();

    NMS.setTemporalAA(true);
    pipe.startProfiling({ every: 1, history: 120 });
    for (let i = 0; i < 12; i++) await new Promise(res => requestAnimationFrame(res));
    const snap = pipe.performanceSnapshot();
    pipe.stopProfiling();
    const gradOn = capturePatchGrad();

    const taaRecords = (snap?.records || []).filter(rec => rec.name.includes('TemporalAAPass') && rec.gpuMs != null);
    const gpus = taaRecords.map(rec => rec.gpuMs).sort((a, b) => a - b);
    const taaGpuMedianMs = gpus.length ? +(gpus[gpus.length >> 1]).toFixed(3) : null;

    // Exposure adaptation check: continuous exposure change keeps correspondence valid
    const prevExp = r.toneMappingExposure;
    r.toneMappingExposure = prevExp * 1.6;
    await new Promise(res => requestAnimationFrame(res));
    const afterExpState = NMS.temporalState();
    r.toneMappingExposure = prevExp;
    await new Promise(res => requestAnimationFrame(res));

    return {
      gradOff: +gradOff.toFixed(4),
      gradOn: +gradOn.toFixed(4),
      sharpnessRetentionRatio: +(gradOn / Math.max(gradOff, 1e-4)).toFixed(4),
      taaGpuMedianMs,
      exposureAdaptedValid: afterExpState.historyValid,
      gl: gl.getError(),
    };
  });

  // 4. Cross-consumer history invalidation matrix (teleport, time jump, resize, volumeScale, debug modes, toggle)
  const invalidations = await page.evaluate(async () => {
    const pipe = NMS._pipeline, gl = NMS._renderer.getContext();
    const checks = {};

    // Teleport invalidates both VolumePass & TemporalAAPass synchronously
    const p = NMS._planet(0);
    NMS.teleport(0, (p.seaLevel + 300) / p.R, { horizon: true });
    checks.teleport = {
      reason: pipe.frameState.reason,
      frameValid: pipe.frameState.valid,
      volValid: pipe.volumePass.historyValid,
      taaValid: pipe.temporalAA.historyValid,
    };
    for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    checks.recoveredAfterTeleport = pipe.temporalAA.historyValid && pipe.volumePass.historyValid;

    // Volume scale change invalidates
    const oldScale = pipe.volumePass.scale;
    pipe.setVolumeScale(Math.max(0.35, oldScale - 0.05));
    checks.volumeScale = {
      reason: pipe.frameState.reason,
      taaValid: pipe.temporalAA.historyValid,
    };
    pipe.setVolumeScale(oldScale);
    for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));

    // Debug modes render cleanly with GL 0
    for (const mode of ['velocity', 'disocclusion', 'weight', 'off']) {
      NMS.setTemporalAA(true, { debugMode: mode });
      await new Promise(r => requestAnimationFrame(r));
    }
    checks.debugModesGl = gl.getError();

    // Turning TAA off restores SMAA cleanly
    NMS.setTemporalAA(false);
    checks.disabledRestoresSmaa = !pipe.temporalAA.enabled && Boolean(pipe.smaa?.enabled) && !pipe.frameState.jitterEnabled;
    NMS.setTemporalAA(true);
    await new Promise(r => requestAnimationFrame(r));
    checks.gl = gl.getError();
    return checks;
  });

  const report = { jitterAndOwnership, producers, qualityAndPerf, invalidations, pageErrors };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(pageErrors, []);
  assert.equal(jitterAndOwnership.temporalState.enabled, true);
  assert.equal(jitterAndOwnership.smaaEnabled, false);
  assert.equal(jitterAndOwnership.volumeExternalTaa, true);
  assert.equal(jitterAndOwnership.uniqueJitters, 8, '8-phase Halton jitter must cycle cleanly');
  assert.equal(jitterAndOwnership.projectionRestoredExact, true);
  assert.equal(jitterAndOwnership.gl, 0);

  assert.equal(producers.nonFinite, 0);
  assert.ok(producers.shipPixels > 200, 'Foreground ship rigid projection must populate motion buffer');
  assert.ok(producers.oceanPixels > 500, 'Deforming ocean wave surface must populate motion buffer');
  assert.ok(producers.repOccupied > 1000, 'Cloud representative optical-mass depth must populate');
  assert.equal(producers.repOrderViolations, 0, 'Cloud first <= rep <= last optical-depth invariant must hold');
  assert.equal(producers.gl, 0);

  assert.ok(qualityAndPerf.sharpnessRetentionRatio >= 0.78, `TAA must not blur stationary detail (${qualityAndPerf.sharpnessRetentionRatio})`);
  if (qualityAndPerf.taaGpuMedianMs !== null) {
    assert.ok(qualityAndPerf.taaGpuMedianMs < 5.0, `2K TAA GPU cost must stay compact (${qualityAndPerf.taaGpuMedianMs} ms)`);
  }
  assert.equal(qualityAndPerf.exposureAdaptedValid, true);
  assert.equal(qualityAndPerf.gl, 0);

  assert.equal(invalidations.teleport.reason, 'teleport');
  assert.equal(invalidations.teleport.volValid, false);
  assert.equal(invalidations.teleport.taaValid, false);
  assert.equal(invalidations.recoveredAfterTeleport, true);
  assert.equal(invalidations.volumeScale.reason, 'volume-scale');
  assert.equal(invalidations.volumeScale.taaValid, false);
  assert.equal(invalidations.debugModesGl, 0);
  assert.equal(invalidations.disabledRestoresSmaa, true);
  assert.equal(invalidations.gl, 0);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
