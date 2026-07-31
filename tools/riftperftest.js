// Real-hardware WebGPU trace for opening and crossing a prepared spatial rift.
//
// This deliberately uses the production 2K Ultra drawing-buffer budget and
// records browser cadence plus WebGPU pipeline/texture creation. It catches
// work that a low-quality functional test can hide at the exact hand-off.

import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const cssWidth = Number(process.env.RIFT_PERF_CSS_WIDTH) || 2048;
const cssHeight = Number(process.env.RIFT_PERF_CSS_HEIGHT) || 1152;
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });

if (!browser) {
  server.close();
  console.log('SKIP: no system Chrome/Edge with hardware WebGPU is available');
  process.exit(0);
}

const context = await browser.newContext({ viewport: { width: cssWidth, height: cssHeight } });
await context.addInitScript(() => {
  const trace = {
    gpuEvents: [],
    longTasks: [],
    frames: [],
    crossingRequestedAt: null,
    stopped: false,
  };
  globalThis.__riftPerf = trace;
  const recordGpu = (type, descriptor = {}) => {
    trace.gpuEvents.push({
      at: performance.now(),
      type,
      label: descriptor.label || '',
      samples: descriptor.multisample?.count || descriptor.sampleCount || 1,
      format: descriptor.format || descriptor.fragment?.targets?.[0]?.format || '',
      stack: type.endsWith('createTexture') ? new Error().stack : '',
    });
  };
  const wrap = (typeName, method) => {
    const proto = globalThis[typeName]?.prototype;
    const original = proto?.[method];
    if (typeof original !== 'function') return;
    try {
      proto[method] = function tracedGpuCall(descriptor, ...rest) {
        recordGpu(`${typeName}.${method}`, descriptor || {});
        return original.call(this, descriptor, ...rest);
      };
    } catch {
      // Instrumentation is diagnostic-only and must not affect the game.
    }
  };
  wrap('GPUDevice', 'createRenderPipeline');
  wrap('GPUDevice', 'createRenderPipelineAsync');
  wrap('GPUDevice', 'createComputePipeline');
  wrap('GPUDevice', 'createComputePipelineAsync');
  wrap('GPUDevice', 'createShaderModule');
  wrap('GPUDevice', 'createTexture');
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        trace.longTasks.push({
          at: entry.startTime,
          duration: entry.duration,
          name: entry.name,
        });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // Long Tasks are not exposed by every Chromium build.
  }
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

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(frames) {
  const gaps = frames.map((frame) => frame.gap).filter((gap) => gap > 0);
  return {
    frames: gaps.length,
    p95: Number(percentile(gaps, 0.95).toFixed(2)),
    max: Number(Math.max(0, ...gaps).toFixed(2)),
    over50: gaps.filter((gap) => gap > 50).length,
    over250: gaps.filter((gap) => gap > 250).length,
  };
}

try {
  const url = `http://127.0.0.1:${port}/?nolock=1&nohero=1&quality=ultra`
    + '&vclouds=1&farflora=0&freeze=1&renderer=webgpu&buildms=14';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });

  const target = await page.evaluate(() => {
    const { universe, starMap } = NMS._internals;
    for (const star of universe.nearStarsList) {
      const preview = starMap.systemPreview(star);
      const body = preview.bodies.find((candidate) => !candidate.isMoon
        && !['gasGiant', 'iceGiant', 'blackHole'].includes(candidate.type)
        && (candidate.clouds?.coverage || 0) > 0.12);
      if (body) return {
        starId: star.id,
        bodyId: body.bodyId,
        bodyIndex: body.index,
      };
    }
    return null;
  });
  if (!target) throw new Error('No cloudy rift target is available');

  await page.evaluate((selected) => {
    NMS.openStarMap();
    NMS.selectStarMapTarget(selected.starId);
  }, target);
  await page.locator(`#sm-systemGlyph [data-glyph-index="${target.bodyIndex}"]`).click({ force: true });
  await page.waitForFunction(() => document.querySelector('#sm-planetLeft')?.classList.contains('active'));
  await page.locator('#sm-routeAction').click({ force: true });
  await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'));
  await page.waitForTimeout(250);

  await page.evaluate(() => {
    const trace = globalThis.__riftPerf;
    trace.frames.length = 0;
    trace.gpuEvents.length = 0;
    trace.longTasks.length = 0;
    trace.startedAt = performance.now();
    let previous = trace.startedAt;
    const sample = (now) => {
      if (trace.stopped) return;
      const rift = NMS.riftState();
      const stats = NMS.stats();
      let phase = rift.open < 0.025 ? 'calibration' : 'opening';
      if (rift.open > 0.985 && !rift.arrived) phase = 'stable';
      if (trace.crossingRequestedAt !== null && !rift.arrived) phase = 'crossing';
      if (rift.arrived) phase = 'arrival';
      trace.frames.push({
        at: now,
        elapsed: now - trace.startedAt,
        gap: now - previous,
        phase,
        open: rift.open,
        ready: rift.previewVolume?.portalReadiness || 0,
        pending: stats.pending,
        volumeBodyId: NMS.volumeState().activeBodyId,
      });
      previous = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.locator('#route-rift-btn').click();
  await page.waitForFunction(() => NMS.riftState().open > 0.985
    && (NMS.riftState().previewVolume?.portalReadiness || 0) > 0.96, null,
  { timeout: 60000 });
  const preparationAtOpen = await page.evaluate('NMS.warpPreparationState()');
  const preparedMaterials = await page.evaluate((bodyId) => {
    const system = NMS._internals.riftPreviewSystem;
    const body = system?.bodyById.get(bodyId);
    const entries = [];
    const inspect = (root, owner) => root?.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials.filter(Boolean)) {
        entries.push({
          owner,
          object: object.name || object.type,
          materialId: material.id,
          materialType: material.type,
        });
      }
    });
    inspect(body?.group, 'target');
    for (const [index, view] of (system?.starViews || []).entries()) {
      inspect(view.group, `star-${index}`);
    }
    return entries;
  }, target.bodyId);
  await page.waitForTimeout(500);
  await page.evaluate(() => NMS.approachRift(38));
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    globalThis.__riftPerf.crossingRequestedAt = performance.now();
    NMS.approachRift(-10);
  });
  await page.waitForFunction(() => NMS.riftState().arrived, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  const result = await page.evaluate(() => {
    const trace = globalThis.__riftPerf;
    trace.stopped = true;
    return {
      trace,
      system: NMS.system(),
      rift: NMS.riftState(),
      volume: NMS.volumeState(),
      stats: NMS.stats(),
    };
  });

  const phases = {};
  for (const phase of ['calibration', 'opening', 'stable', 'crossing', 'arrival']) {
    phases[phase] = summarize(result.trace.frames.filter((frame) => frame.phase === phase));
  }
  const crossingAt = result.trace.crossingRequestedAt || Infinity;
  const handoffGpuEvents = result.trace.gpuEvents.filter((event) =>
    event.at >= crossingAt - 120 && event.at <= crossingAt + 1500);
  const handoffLongTasks = result.trace.longTasks.filter((event) =>
    event.at >= crossingAt - 120 && event.at <= crossingAt + 5000);

  const report = {
    target,
    preparationAtOpen,
    preparedMaterials,
    phases,
    crossingRequestedAt: result.trace.crossingRequestedAt,
    crossingFrames: result.trace.frames.filter((frame) =>
      Math.abs(frame.at - result.trace.crossingRequestedAt) < 1800),
    handoffGpuEvents,
    handoffLongTasks,
    arrival: {
      systemId: result.system.id,
      volumeBodyId: result.volume.activeBodyId,
      pending: result.stats.pending,
    },
    pageErrors,
  };
  const maxHandoffLongTask = handoffLongTasks.reduce(
    (maxDuration, event) => Math.max(maxDuration, event.duration),
    0,
  );
  const summary = {
    target,
    preparation: {
      lod: preparationAtOpen.lodWarmState,
      water: preparationAtOpen.waterWarmState,
      volume: preparationAtOpen.volumeWarmState,
      riftStructure: preparationAtOpen.riftStructureWarmState,
      rift: preparationAtOpen.riftWarmState,
    },
    phases,
    handoffLongTasks: {
      count: handoffLongTasks.length,
      max: Math.round(maxHandoffLongTask * 10) / 10,
    },
    arrival: report.arrival,
    pageErrors,
  };
  console.log(JSON.stringify(
    process.env.NMS_RIFT_TRACE_VERBOSE === '1' ? report : summary,
    null,
    2,
  ));

  const handoffFrozen = phases.crossing.over250 + phases.arrival.over250;
  process.exitCode = result.system.id !== target.starId
    || result.volume.activeBodyId !== target.bodyId
    || pageErrors.length > 0
    || handoffFrozen > 0 ? 1 : 0;
} finally {
  await context.close();
  await browser.close();
  server.close();
}
