import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = `test-results/f3-lifecycle-gpu/${stamp}`;
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

  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?quality=balanced&nohero=1&nolock=1&post=1&vclouds=1&farflora=1`,
    { waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(window.NMS?.booted), null, { timeout: 120000 });
  const bootMs = Date.now() - t0;

  // 1. Orbit pointDirect -> cachedDirect handoff without long frame stall
  const orbitHandoff = await page.evaluate(async () => {
    const gl = NMS._renderer.getContext();
    const vp = NMS._pipeline.volumePass;
    const p0 = NMS._planet(0);
    const intervals = [];
    let last = performance.now();
    let sawCached = false;
    for (let i = 0; i < 120; i++) {
      const now = await new Promise(r => requestAnimationFrame(r));
      intervals.push(+(now - last).toFixed(2));
      last = now;
      if (vp.farSplit?.lastRoute === 'cachedDirect') { sawCached = true; break; }
    }
    const maxFrameGapMs = Math.max(...intervals);
    return {
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      sawCached,
      lastRoute: vp.farSplit?.lastRoute || null,
      columnsReady: p0?.volCloudMat?.uniforms?.uColumnsReady?.value ?? 0,
      maxFrameGapMs,
      gl: gl.getError(),
      lost: gl.isContextLost(),
    };
  });

  // 2. Near-cloud Dynamic HDR & Ordered Medium / Opaque Depth Occlusion
  const hdrAndOcclusion = await page.evaluate(async () => {
    const THREE = await import('three');
    const gl = NMS._renderer.getContext();
    const r = NMS._renderer;
    const vp = NMS._pipeline.volumePass;
    const p0 = NMS._planet(0);
    NMS.teleport(0, (p0.seaLevel + 420) / p0.R, {
      dir: [0.34669147556655305, 0.07291666666666663, -0.9351407276403421],
      horizon: true,
      pitch: 0.08,
    });
    NMS.setLocalSunAltitude(0, 14);
    NMS.shipViewDebug.setViewMode('chase');
    const batchWait = performance.now();
    while (!vp.lightBatchStatus?.submitted && performance.now() - batchWait < 10000) {
      await new Promise(res => requestAnimationFrame(res));
    }
    for (let i = 0; i < 8; i++) await new Promise(res => requestAnimationFrame(res));

    const w = vp.current.width, h = vp.current.height;
    const raw = new Uint16Array(w * h * 4);
    r.readRenderTargetPixels(vp.current, 0, 0, w, h, raw);
    let nonFinite = 0, cloudOccupied = 0, zeroAlphaForeground = 0, maxHdr = 0, minLum = Infinity;
    for (let i = 0; i < w * h; i++) {
      const cr = THREE.DataUtils.fromHalfFloat(raw[i * 4]);
      const cg = THREE.DataUtils.fromHalfFloat(raw[i * 4 + 1]);
      const cb = THREE.DataUtils.fromHalfFloat(raw[i * 4 + 2]);
      const ca = THREE.DataUtils.fromHalfFloat(raw[i * 4 + 3]);
      if (!Number.isFinite(cr) || !Number.isFinite(cg) || !Number.isFinite(cb) || !Number.isFinite(ca)) {
        nonFinite++;
        continue;
      }
      if (ca > 0.01) {
        cloudOccupied++;
        const lum = Math.max(cr, cg, cb) / Math.max(ca, 0.05);
        if (lum > maxHdr) maxHdr = lum;
        if (ca > 0.5 && lum < minLum) minLum = lum;
      } else {
        zeroAlphaForeground++;
      }
    }
    // Also read pre-tonemap composer HDR buffer to verify unclipped >1.0 solar/sky/cloud HDR headroom
    const hdrRt = NMS._pipeline.composer.readBuffer;
    const sw = Math.min(256, hdrRt.width), sh = Math.min(256, hdrRt.height);
    const sceneHalf = new Uint16Array(sw * sh * 4);
    let maxSceneHdr = 0;
    for (const [ox, oy] of [[0, 0], [Math.floor((hdrRt.width - sw) / 2), Math.floor((hdrRt.height - sh) / 2)], [hdrRt.width - sw, Math.floor(hdrRt.height * 0.55)]]) {
      r.readRenderTargetPixels(hdrRt, Math.max(0, ox), Math.max(0, oy), sw, sh, sceneHalf);
      for (let i = 0; i < sw * sh * 3; i++) {
        const v = THREE.DataUtils.fromHalfFloat(sceneHalf[Math.floor(i / 3) * 4 + (i % 3)]);
        if (Number.isFinite(v) && v > maxSceneHdr) maxSceneHdr = v;
      }
    }
    return {
      representation: NMS.volumeState()?.representation,
      batchSubmitted: Boolean(vp.lightBatchStatus?.submitted),
      residentBytes: vp.lightBatch?.plan?.residentBytes ?? 0,
      budgetBytes: vp.lightBatch?.plan?.budgetBytes ?? vp.lightBatchOptions?.budgetBytes ?? 0,
      nonFinite,
      cloudOccupied,
      zeroAlphaForeground,
      maxCloudUnpremulHdr: +maxHdr.toFixed(4),
      minOpaqueCloudLum: Number.isFinite(minLum) ? +minLum.toFixed(4) : 0,
      maxSceneHdr: +maxSceneHdr.toFixed(4),
      gl: gl.getError(),
    };
  });

  // 3. Dynamic Resize 2560x1440 -> 1920x1080 -> 2560x1440
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise(r => requestAnimationFrame(r)); });
  const resized1080 = await page.evaluate(() => {
    const gl = NMS._renderer.getContext(), vp = NMS._pipeline.volumePass;
    return {
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      volumeSize: [vp.width, vp.height],
      batchSize: [vp.lightBatch?.plan?.width ?? 0, vp.lightBatch?.plan?.height ?? 0],
      gl: gl.getError(),
    };
  });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.evaluate(async () => { for (let i = 0; i < 6; i++) await new Promise(r => requestAnimationFrame(r)); });
  const restored2K = await page.evaluate(() => {
    const gl = NMS._renderer.getContext(), vp = NMS._pipeline.volumePass;
    return {
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      volumeSize: [vp.width, vp.height],
      batchSize: [vp.lightBatch?.plan?.width ?? 0, vp.lightBatch?.plan?.height ?? 0],
      gl: gl.getError(),
    };
  });

  // 4. Short-Dwell Star System Switching & Residency Bounds
  const starSwitch = await page.evaluate(async () => {
    const gl = NMS._renderer.getContext();
    const r = NMS._renderer;
    const texBefore = r.info.memory.textures;
    const geoBefore = r.info.memory.geometries;
    const visited = [];
    for (const targetStar of ['MW-0925', 'MW-0957', 'MW-0903']) {
      const targetId = NMS.warpToStar(targetStar);
      const warpWaitStart = performance.now();
      while (NMS.stats()?.state === 'warp' && performance.now() - warpWaitStart < 20000) {
        await new Promise(res => requestAnimationFrame(res));
      }
      const frames = targetStar === 'MW-0903' ? 14 : 4;
      for (let f = 0; f < frames; f++) await new Promise(res => requestAnimationFrame(res));
      visited.push({
        targetId,
        planets: NMS.planets()?.length ?? 0,
        textures: r.info.memory.textures,
        geometries: r.info.memory.geometries,
        lightBanks: NMS._pipeline.cloudLightBanks?.size ?? 0,
        gl: gl.getError(),
      });
    }
    const p0 = NMS._planet(0);
    if (p0) NMS.teleport(0, (p0.seaLevel + 420) / p0.R, { horizon: true, pitch: 0.05 });
    for (let f = 0; f < 10; f++) await new Promise(res => requestAnimationFrame(res));
    return {
      texBefore,
      geoBefore,
      texAfter: r.info.memory.textures,
      geoAfter: r.info.memory.geometries,
      visited,
      lightBanksAfter: NMS._pipeline.cloudLightBanks?.size ?? 0,
      gl: gl.getError(),
    };
  });

  // 5. Real WebGL Context Loss & Restoration (WEBGL_lose_context)
  const contextRecovery = await page.evaluate(async () => {
    const gl = NMS._renderer.getContext();
    const loseExt = gl.getExtension('WEBGL_lose_context');
    if (!loseExt) return { supported: false };
    loseExt.loseContext();
    for (let i = 0; i < 6; i++) await new Promise(res => setTimeout(res, 40));
    const lostObserved = gl.isContextLost();
    loseExt.restoreContext();
    const waitStart = performance.now();
    while (gl.isContextLost() && performance.now() - waitStart < 10000) {
      await new Promise(res => setTimeout(res, 50));
    }
    // Drain any transition error then advance 20 live world frames on restored context
    gl.getError();
    for (let i = 0; i < 24; i++) await new Promise(res => requestAnimationFrame(res));
    const px = new Uint8Array(16 * 16 * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(1280, 720, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nonZero = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 0 || px[i + 1] > 0 || px[i + 2] > 0) nonZero++;
    }
    return {
      supported: true,
      lostObserved,
      restoredAlive: !gl.isContextLost(),
      centerNonBlackPixels: nonZero,
      glAfterRestoreFrames: gl.getError(),
    };
  });

  await page.screenshot({ path: `${out}/restored-2k.png` });
  const report = { bootMs, orbitHandoff, hdrAndOcclusion, resized1080, restored2K, starSwitch, contextRecovery, pageErrors };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(orbitHandoff.drawingBuffer, [2560, 1440]);
  assert.equal(orbitHandoff.sawCached, true, 'Orbit must smoothly reach cachedDirect');
  assert.equal(orbitHandoff.gl, 0);
  assert.equal(hdrAndOcclusion.nonFinite, 0);
  assert.ok(hdrAndOcclusion.cloudOccupied > 10000, 'Near clouds must render occupied pixels');
  assert.ok(hdrAndOcclusion.zeroAlphaForeground > 10000, 'Opaque foreground/ocean must occlude cloud rays');
  assert.ok(hdrAndOcclusion.maxSceneHdr > 1.0 || hdrAndOcclusion.maxCloudUnpremulHdr > 0.4, 'HDR radiance must preserve dynamic range');
  assert.ok(hdrAndOcclusion.residentBytes <= hdrAndOcclusion.budgetBytes);
  assert.equal(hdrAndOcclusion.gl, 0);
  assert.deepEqual(resized1080.drawingBuffer, [1920, 1080]);
  assert.deepEqual(resized1080.volumeSize, resized1080.batchSize);
  assert.equal(resized1080.gl, 0);
  assert.deepEqual(restored2K.drawingBuffer, [2560, 1440]);
  assert.deepEqual(restored2K.volumeSize, restored2K.batchSize);
  assert.equal(restored2K.gl, 0);
  for (const v of starSwitch.visited) assert.equal(v.gl, 0);
  assert.ok(starSwitch.lightBanksAfter <= 2, 'CloudLightBanks must retire across short-dwell star switches');
  assert.equal(starSwitch.gl, 0);
  if (contextRecovery.supported) {
    assert.equal(contextRecovery.lostObserved, true);
    assert.equal(contextRecovery.restoredAlive, true);
    assert.ok(contextRecovery.centerNonBlackPixels > 0, 'Restored WebGL2 context must present non-black world frames');
    assert.equal(contextRecovery.glAfterRestoreFrames, 0);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
