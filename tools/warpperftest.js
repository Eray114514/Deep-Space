// Focused WebGPU regression for stellar-warp frame continuity.
// It deliberately skips rift traversal, screenshots and PNG decoding so CDP
// capture work cannot be mistaken for an in-game frozen-effect frame.
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const TARGET_STAR_ID = 'MW-0919';
const TARGET_BODY_ID = 'planet-4';
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });

if (!browser) {
  server.close();
  console.log('SKIP: no system Chrome/Edge with hardware WebGPU is available');
  process.exit(0);
}

const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  window.__warpGpuErrors = [];
  const adapterPrototype = globalThis.GPUAdapter?.prototype;
  const requestDevice = adapterPrototype?.requestDevice;
  if (typeof requestDevice !== 'function') return;
  adapterPrototype.requestDevice = async function tracedRequestDevice(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', (event) => {
      window.__warpGpuErrors.push(event.error?.message || String(event.error || event));
    });
    return device;
  };
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error' || /GPUValidationError|shader error/i.test(text)) {
    pageErrors.push(text);
  }
});

try {
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&nohero=1&quality=low&vclouds=1&farflora=0&freeze=1&buildms=1.6&renderer=webgpu`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  const target = await page.evaluate(({ starId, bodyId }) => {
    const { universe, starMap } = NMS._internals;
    const star = universe.nearStarsList.find((candidate) => candidate.id === starId);
    const preview = starMap.systemPreview(star);
    const body = preview.bodies.find((candidate) => candidate.bodyId === bodyId);
    return { starId: star.id, bodyId: body.bodyId, bodyIndex: body.index };
  }, { starId: TARGET_STAR_ID, bodyId: TARGET_BODY_ID });

  await page.evaluate((starId) => {
    NMS.openStarMap();
    NMS.selectStarMapTarget(starId);
  }, target.starId);
  await page.locator(`#sm-systemGlyph [data-glyph-index="${target.bodyIndex}"]`).click({ force: true });
  await page.waitForFunction(() => document.querySelector('#sm-planetLeft')?.classList.contains('active'));
  await page.evaluate(() => NMS._internals.starMap.warpToSelection());
  await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'), null,
    { timeout: 60000 });
  await page.waitForFunction(() => {
    const state = NMS.warpPreparationState();
    return state.targetReady && state.lodReady && state.waterReady;
  }, null, { timeout: 30000 });

  const preparation = await page.evaluate('NMS.warpPreparationState()');
  await page.evaluate(({ starId, bodyId }) => {
    const phases = {
      routeClick: [],
      spool: [],
      handoff: [],
      cruise: [],
      volumeActivation: [],
      arrival: [],
    };
    const events = [];
    let previous = performance.now();
    let started = false;
    let finishedAt = null;
    let previousSystemId = NMS.system().id;
    let previousVolumeBodyId = NMS.volumeState().activeBodyId;

    const snapshot = (now) => {
      const system = NMS._internals.universe.system;
      return {
        at: now,
        state: NMS.state,
        warp: NMS.warp(),
        warpArrival: NMS.stats().warpArrival,
        systemId: system?.star?.id || null,
        builtBodies: system?.bodyById?.size || 0,
        totalBodies: system?._specs?.length || 0,
        pendingChunks: NMS.stats().pending,
        volumeBodyId: NMS.volumeState().activeBodyId,
      };
    };

    const phaseFor = (state) => {
      if (!started) return 'routeClick';
      if (state.state !== 'warp') return 'arrival';
      if (state.systemId !== starId) return 'spool';
      if (state.volumeBodyId === bodyId || state.warpArrival > 0.02) return 'volumeActivation';
      if (state.warp < 0.72) return 'handoff';
      return 'cruise';
    };

    const sample = (now) => {
      const state = snapshot(now);
      if (state.state === 'warp') started = true;
      const gap = Math.max(0, now - previous);
      const phase = phaseFor(state);
      phases[phase].push(gap);

      if (state.systemId !== previousSystemId) {
        events.push({ type: 'system-handoff', gap, ...state });
      }
      if (state.volumeBodyId !== previousVolumeBodyId) {
        events.push({ type: 'volume-handoff', gap, ...state });
      }
      if (gap > 100) events.push({ type: 'long-frame', phase, gap, ...state });

      previousSystemId = state.systemId;
      previousVolumeBodyId = state.volumeBodyId;
      previous = now;

      if (started && state.state !== 'warp') {
        if (finishedAt === null) finishedAt = now;
        if (now - finishedAt > 500) {
          window.__warpPerf = { phases, events, finished: state };
          return;
        }
      }
      requestAnimationFrame(sample);
    };

    window.__warpPerf = null;
    requestAnimationFrame(sample);
  }, target);

  await page.evaluate(() => NMS.beginPreparedWarp());
  await page.waitForFunction(() => window.__warpPerf, null, { timeout: 40000 });

  const result = await page.evaluate((bodyId) => {
    const planet = NMS._internals.universe.system.bodyById.get(bodyId) || null;
    const waterMeshes = planet?.waterLod?.roots
      ?.map((root) => root.mesh)
      .filter(Boolean) || [];
    return {
      perf: window.__warpPerf,
      gpuErrors: window.__warpGpuErrors || [],
      system: NMS.system(),
      volume: NMS.volumeState(),
      terrain: planet?.lod?.debugStats?.() || null,
      waterLod: planet?.waterLod?.debugStats?.() || null,
      water: {
        exists: !!planet?.waterLod,
        lodVisible: planet?.waterLod?.visible ?? null,
        meshCount: waterMeshes.length,
        visibleMeshCount: waterMeshes.filter((mesh) => mesh.visible).length,
        material: waterMeshes[0]?.material?.userData?.nodeMaterial || null,
      },
    };
  }, target.bodyId);

  const summarize = (gaps) => {
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      frames: sorted.length,
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      max: sorted.at(-1) || 0,
      frozen: sorted.filter((gap) => gap > 250).length,
    };
  };
  const phases = Object.fromEntries(Object.entries(result.perf.phases)
    .map(([name, gaps]) => [name, summarize(gaps)]));
  const allGaps = Object.values(result.perf.phases).flat();
  const all = summarize(allGaps);

  console.log(JSON.stringify({
    target,
    preparation,
    phases,
    all,
    events: result.perf.events,
    arrival: {
      state: result.perf.finished.state,
      systemId: result.system.id,
      volumeBodyId: result.volume.activeBodyId,
      terrain: result.terrain,
      waterLod: result.waterLod,
      water: result.water,
    },
    gpuErrors: result.gpuErrors,
    pageErrors,
  }, null, 2));

  const failed = result.system.id !== target.starId
    || result.volume.activeBodyId !== target.bodyId
    || (result.water.exists && (!result.water.lodVisible
      || result.water.visibleMeshCount === 0))
    || result.terrain?.pending > 0
    || result.terrain?.activeMorphs > 0
    || result.waterLod?.pending > 0
    || result.waterLod?.activeMorphs > 0
    || result.gpuErrors.length > 0
    || pageErrors.length > 0
    || all.frozen > 0;
  process.exitCode = failed ? 1 : 0;
} finally {
  await context.close();
  await browser.close();
  server.close();
}
