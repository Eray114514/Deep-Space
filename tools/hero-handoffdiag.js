// Real-hardware WebGPU trace for the title-screen -> flight hand-off.
//
// This is intentionally a diagnostic rather than a pass/fail test. It records
// the exact first 15 seconds after "开始游戏" at a 2560x1440 drawing buffer,
// including browser frame cadence, WebGPU pipeline/texture creation, planet
// LOD work, local-volume ownership and camera motion.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const cssWidth = Number(process.env.HERO_DIAG_CSS_WIDTH) || 2048;
const cssHeight = Number(process.env.HERO_DIAG_CSS_HEIGHT) || 1152;
const durationMs = Number(process.env.HERO_DIAG_DURATION_MS) || 15000;
const outputDir = path.resolve('test-results/hero-handoff-diagnostic');
let browser;
let context;
let server;

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function phaseSummary(frames, start, end) {
  const selected = frames.filter((frame) => frame.elapsed >= start && frame.elapsed < end);
  const times = selected.map((frame) => frame.rafMs).filter((value) => value > 0 && value < 500);
  return {
    frames: selected.length,
    averageFps: times.length
      ? Number((1000 / (times.reduce((sum, value) => sum + value, 0) / times.length)).toFixed(1))
      : 0,
    p50Ms: Number(percentile(times, 0.5).toFixed(2)),
    p95Ms: Number(percentile(times, 0.95).toFixed(2)),
    p99Ms: Number(percentile(times, 0.99).toFixed(2)),
    maxMs: Number(Math.max(0, ...times).toFixed(2)),
    over33Ms: times.filter((value) => value > 33.34).length,
    over50Ms: times.filter((value) => value > 50).length,
  };
}

function quaternionAngle(a, b) {
  if (!a || !b) return 0;
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

function eventGroups(events, keyOf) {
  const grouped = new Map();
  for (const event of events) {
    const key = keyOf(event);
    const current = grouped.get(key) || {
      key, count: 0, firstMs: Infinity, lastMs: -Infinity,
    };
    current.count++;
    current.firstMs = Math.min(current.firstMs, event.elapsed);
    current.lastMs = Math.max(current.lastMs, event.elapsed);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      firstMs: Number(entry.firstMs.toFixed(1)),
      lastMs: Number(entry.lastMs.toFixed(1)),
    }))
    .sort((a, b) => b.count - a.count);
}

try {
  const started = await startServer(0);
  server = started.server;
  browser = await launchWebGPUHardwareBrowser({ headless: true });
  if (!browser) {
    console.log('Hero hand-off diagnostic skipped: no hardware WebGPU browser.');
    process.exitCode = 0;
  } else {
    context = await browser.newContext({
      viewport: { width: cssWidth, height: cssHeight },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      const trace = {
        gpuEvents: [],
        longTasks: [],
        marks: [],
        frames: [],
        traceStart: null,
        stopped: false,
      };
      globalThis.__heroHandoffTrace = trace;
      const event = (type, detail = {}) => {
        trace.gpuEvents.push({ time: performance.now(), type, ...detail });
      };
      const normalizedSize = (size) => {
        if (Array.isArray(size)) return [...size];
        if (size && typeof size === 'object') {
          return [
            Number(size.width ?? 1),
            Number(size.height ?? 1),
            Number(size.depthOrArrayLayers ?? 1),
          ];
        }
        return [Number(size) || 1, 1, 1];
      };
      const wrap = (typeName, method, describe) => {
        const proto = globalThis[typeName]?.prototype;
        const original = proto?.[method];
        if (typeof original !== 'function') return;
        try {
          proto[method] = function wrappedWebGpuCall(...args) {
            try {
              event(`${typeName}.${method}`, describe?.(...args) || {});
            } catch {
              event(`${typeName}.${method}`);
            }
            return original.apply(this, args);
          };
        } catch {
          event('instrumentation-failed', { target: `${typeName}.${method}` });
        }
      };
      const pipelineDescription = (descriptor = {}) => ({
        label: descriptor.label || '',
        topology: descriptor.primitive?.topology || '',
        samples: descriptor.multisample?.count || 1,
        hasFragment: !!descriptor.fragment,
      });
      wrap('GPUDevice', 'createRenderPipeline', pipelineDescription);
      wrap('GPUDevice', 'createRenderPipelineAsync', pipelineDescription);
      wrap('GPUDevice', 'createComputePipeline', (descriptor = {}) => ({
        label: descriptor.label || '',
      }));
      wrap('GPUDevice', 'createComputePipelineAsync', (descriptor = {}) => ({
        label: descriptor.label || '',
      }));
      wrap('GPUDevice', 'createShaderModule', (descriptor = {}) => ({
        label: descriptor.label || '',
        codeLength: typeof descriptor.code === 'string' ? descriptor.code.length : 0,
      }));
      wrap('GPUDevice', 'createTexture', (descriptor = {}) => ({
        label: descriptor.label || '',
        size: normalizedSize(descriptor.size),
        format: descriptor.format || '',
        samples: descriptor.sampleCount || 1,
        mipLevels: descriptor.mipLevelCount || 1,
        usage: descriptor.usage || 0,
      }));
      wrap('GPUCanvasContext', 'configure', (configuration = {}) => ({
        format: configuration.format || '',
        alphaMode: configuration.alphaMode || '',
      }));
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            trace.longTasks.push({
              startTime: entry.startTime,
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
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    const url = `http://127.0.0.1:${started.port}/?renderer=webgpu&quality=ultra`
      + '&vclouds=1&farflora=1&time=9.5';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 150000 });
    const idleSettled = await page.waitForFunction('NMS.idle()', null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    await page.evaluate((settled) => {
      __heroHandoffTrace.marks.push({
        time: performance.now(),
        name: settled ? 'pre-hero-idle' : 'pre-hero-idle-timeout',
        stats: NMS.stats(),
      });
    }, idleSettled);
    await page.click('#hero-splash');
    await page.waitForTimeout(700);
    await page.waitForFunction(() => {
      const hero = document.querySelector('#hero-overlay');
      const start = document.querySelector('#hero-start-btn');
      return hero && start && !hero.classList.contains('hidden') && !start.disabled;
    });

    await page.evaluate((captureDuration) => {
      const trace = globalThis.__heroHandoffTrace;
      const renderer = NMS._renderer;
      trace.traceStart = performance.now();
      trace.marks.push({ time: trace.traceStart, name: 'recording-start' });
      for (const method of ['setSize', 'setPixelRatio', 'setDrawingBufferSize']) {
        const original = renderer?.[method];
        if (typeof original !== 'function') continue;
        renderer[method] = function tracedRendererResize(...args) {
          trace.marks.push({
            time: performance.now(),
            name: `renderer.${method}`,
            args: args.map((value) => Number.isFinite(value) ? value : String(value)),
          });
          return original.apply(this, args);
        };
      }
      NMS.resetPerformanceStats();
      let previous = performance.now();
      const sample = (now) => {
        const stats = NMS.stats();
        const volume = NMS.volumeState();
        const planet = NMS._planet(0);
        const internals = NMS._internals;
        const terrain = planet?.lod?.debugStats?.() || null;
        const water = planet?.waterLod?.debugStats?.() || null;
        const foregroundRoots = internals.scene.children
          .filter((object) => (object.layers.mask & (1 << 3)) !== 0)
          .map((object) => ({
            name: object.name || object.type,
            visible: object.visible,
            position: object.position.toArray(),
          }));
        const bodyLods = internals.universe.planets().map((body) => ({
          id: body.bodyId,
          appear: body.appear,
          groupVisible: body.group.visible,
          terrain: body.lod?.debugStats?.() || null,
          water: body.waterLod?.debugStats?.() || null,
          terrainMaterial: body.terrainMaterial ? {
            id: body.terrainMaterial.id,
            version: body.terrainMaterial.version,
            transparent: body.terrainMaterial.transparent,
            opacity: body.terrainMaterial.opacity,
          } : null,
        }));
        trace.frames.push({
          time: now,
          elapsed: now - trace.traceStart,
          rafMs: now - previous,
          gameFrame: stats.frame,
          bodyClasses: document.body.className,
          heroHidden: document.querySelector('#hero-overlay')?.classList.contains('hidden') ?? true,
          heroLeaving: document.querySelector('#hero-overlay')?.classList.contains('hero-leaving') ?? false,
          pointerLocked: document.pointerLockElement === renderer.domElement,
          navPosition: internals.nav.pos.toArray(),
          navQuaternion: internals.nav.quat.toArray(),
          cameraPosition: internals.camera.position.toArray(),
          cameraQuaternion: internals.camera.quaternion.toArray(),
          fov: internals.camera.fov,
          stats: {
            state: stats.state,
            alt: stats.alt,
            calls: stats.calls,
            tris: stats.tris,
            terrainChunks: stats.terrainChunks,
            waterChunks: stats.waterChunks,
            terrainPending: stats.terrainPending,
            waterPending: stats.waterPending,
            terrainQueue: stats.terrainQueue,
            dpr: stats.dpr,
            adaptiveStage: stats.adaptiveStage,
            localVolumeBudget: stats.localVolumeBudget,
            volumeScale: stats.volumeScale,
            cloudSteps: stats.cloudSteps,
            cloudLightSteps: stats.cloudLightSteps,
            atmosphereSteps: stats.atmosphereSteps,
          },
          terrain,
          water,
          volume: {
            activeBodyId: volume.activeBodyId,
            depthReady: volume.depthReady,
            cloudDepthReady: volume.cloudDepthReady,
            scale: volume.scale,
            drawingBuffer: volume.drawingBuffer,
            sunShaftStrength: volume.sunShaftStrength,
            cloudEngage: planet?.volCloudMat?.uniforms?.uEngage?.value ?? null,
            cloudMeshVisible: planet?.volCloudMesh?.visible ?? false,
            analyticCloudVisible: planet?.cloudMesh?.visible ?? false,
            atmoLayerMask: planet?.atmoMesh?.layers?.mask ?? null,
            temporalHistory: 'absent-on-GameNodePipeline',
          },
          foregroundRoots,
          bodyLods,
        });
        previous = now;
        if (now - trace.traceStart < captureDuration) requestAnimationFrame(sample);
        else trace.stopped = true;
      };
      requestAnimationFrame(sample);
    }, durationMs);

    await page.evaluate(() => {
      __heroHandoffTrace.marks.push({ time: performance.now(), name: 'hero-start-click' });
    });
    await page.click('#hero-start-btn');
    await page.waitForTimeout(3300);
    await page.evaluate(() => {
      __heroHandoffTrace.marks.push({ time: performance.now(), name: 'camera-input-start' });
    });
    const centerX = Math.floor(cssWidth / 2);
    const centerY = Math.floor(cssHeight / 2);
    for (let index = 0; index < 90; index++) {
      const x = centerX + Math.round(Math.sin(index * 0.34) * 42);
      const y = centerY + Math.round(Math.cos(index * 0.27) * 24);
      await page.mouse.move(x, y);
      await page.waitForTimeout(55);
    }
    await page.evaluate(() => {
      __heroHandoffTrace.marks.push({ time: performance.now(), name: 'camera-input-end' });
    });
    await page.waitForFunction('__heroHandoffTrace.stopped === true', null, {
      timeout: durationMs + 10000,
    });

    const trace = await page.evaluate(() => {
      const raw = globalThis.__heroHandoffTrace;
      return {
        ...raw,
        gpuEvents: raw.gpuEvents.map((event) => ({
          ...event,
          elapsed: raw.traceStart == null ? null : event.time - raw.traceStart,
        })),
        longTasks: raw.longTasks.map((entry) => ({
          ...entry,
          elapsed: raw.traceStart == null ? null : entry.startTime - raw.traceStart,
        })),
        marks: raw.marks.map((mark) => ({
          ...mark,
          elapsed: raw.traceStart == null ? null : mark.time - raw.traceStart,
        })),
      };
    });
    trace.pageErrors = pageErrors;
    const clickMark = trace.marks.find((mark) => mark.name === 'hero-start-click');
    const clickElapsed = clickMark?.elapsed || 0;
    const frames = trace.frames.map((frame) => ({
      ...frame,
      elapsed: frame.elapsed - clickElapsed,
    })).filter((frame) => frame.elapsed >= -250);
    const longFrames = frames.filter((frame) => frame.rafMs > 33.34)
      .sort((a, b) => b.rafMs - a.rafMs)
      .slice(0, 30)
      .map((frame) => ({
        elapsed: Number(frame.elapsed.toFixed(1)),
        rafMs: Number(frame.rafMs.toFixed(2)),
        budget: frame.stats.localVolumeBudget,
        terrainPending: frame.stats.terrainPending,
        waterPending: frame.stats.waterPending,
        terrainMorphs: frame.terrain?.activeMorphs || 0,
        waterMorphs: frame.water?.activeMorphs || 0,
        cloudEngage: frame.volume.cloudEngage,
        depthReady: frame.volume.depthReady,
        pointerLocked: frame.pointerLocked,
        heroLeaving: frame.heroLeaving,
      }));
    const stateChanges = [];
    for (let index = 1; index < frames.length; index++) {
      const previous = frames[index - 1];
      const current = frames[index];
      const changes = [];
      for (const key of ['localVolumeBudget', 'volumeScale', 'adaptiveStage']) {
        if (current.stats[key] !== previous.stats[key]) {
          changes.push(`${key}:${previous.stats[key]}->${current.stats[key]}`);
        }
      }
      for (const key of ['depthReady', 'cloudDepthReady', 'cloudMeshVisible',
        'analyticCloudVisible', 'atmoLayerMask']) {
        if (current.volume[key] !== previous.volume[key]) {
          changes.push(`${key}:${previous.volume[key]}->${current.volume[key]}`);
        }
      }
      if (current.pointerLocked !== previous.pointerLocked) {
        changes.push(`pointerLocked:${previous.pointerLocked}->${current.pointerLocked}`);
      }
      const navAngle = quaternionAngle(previous.navQuaternion, current.navQuaternion);
      if (changes.length) {
        stateChanges.push({
          elapsed: Number(current.elapsed.toFixed(1)),
          rafMs: Number(current.rafMs.toFixed(2)),
          navAngle: Number(navAngle.toFixed(6)),
          changes,
        });
      }
    }
    const gpuAfterClick = trace.gpuEvents.filter((event) => event.elapsed >= clickElapsed)
      .map((event) => ({
        ...event,
        elapsed: Number((event.elapsed - clickElapsed).toFixed(1)),
      }));
    const pipelineEvents = gpuAfterClick.filter((event) =>
      /create(?:Render|Compute)Pipeline|createShaderModule/.test(event.type));
    const textureEvents = gpuAfterClick.filter((event) => event.type === 'GPUDevice.createTexture');
    const pipelineGroups = eventGroups(pipelineEvents, (event) =>
      `${event.type}|${event.label || '<blank>'}|samples=${event.samples || 1}`);
    const textureGroups = eventGroups(textureEvents, (event) =>
      `${event.label || '<blank>'}|${event.size?.join('x') || '?'}`
      + `|${event.format || '?'}|samples=${event.samples || 1}`);
    const handoffComplete = frames.find((frame) =>
      !frame.bodyClasses.split(/\s+/).includes('hero-active'));
    const cameraInputStart = trace.marks.find((mark) => mark.name === 'camera-input-start');
    const cameraInputEnd = trace.marks.find((mark) => mark.name === 'camera-input-end');
    const materialCatalog = await page.evaluate(() => {
      const entries = new Map();
      NMS._internals.scene.traverse((object) => {
        if (!object.material) return;
        const materials = Array.isArray(object.material)
          ? object.material : [object.material];
        for (const material of materials) {
          if (!material || entries.has(material.id)) continue;
          const attributes = object.geometry?.attributes
            ? Object.entries(object.geometry.attributes).map(([name, value]) => ({
              name,
              itemSize: value.itemSize,
              stride: value.isInterleavedBufferAttribute ? value.data.stride : value.itemSize,
            }))
            : [];
          entries.set(material.id, {
            id: material.id,
            name: material.name || '',
            type: material.type,
            nodeMaterial: material.userData?.nodeMaterial || '',
            object: object.name || object.type,
            parent: object.parent?.name || object.parent?.type || '',
            geometry: object.geometry?.type || '',
            attributes,
            layerMask: object.layers.mask,
            visible: object.visible,
            castShadow: object.castShadow,
            receiveShadow: object.receiveShadow,
            renderOrder: object.renderOrder,
          });
        }
      });
      return [...entries.values()];
    });
    const summary = {
      url,
      cssViewport: [cssWidth, cssHeight],
      drawingBuffer: frames[0]?.volume.drawingBuffer || null,
      runtime: frames[0] ? {
        renderer: await page.evaluate(() => NMS.stats().rendererBackend),
        gpu: await page.evaluate(() => NMS.stats().gpu),
        adapterInfo: await page.evaluate(() => NMS.stats().adapterInfo),
      } : null,
      phases: {
        handoff: phaseSummary(frames, 0, 3200),
        cameraInput: phaseSummary(frames, 3200, 8500),
        settled: phaseSummary(frames, 8500, durationMs),
      },
      pipelineEventsAfterClick: pipelineEvents.length,
      textureEventsAfterClick: textureEvents.length,
      longTasksAfterClick: trace.longTasks.filter((entry) => entry.elapsed >= clickElapsed).length,
      handoffCompleteMs: handoffComplete
        ? Number(handoffComplete.elapsed.toFixed(1)) : null,
      inputInjectionWallMs: cameraInputStart && cameraInputEnd
        ? Number((cameraInputEnd.elapsed - cameraInputStart.elapsed).toFixed(1)) : null,
      largestLongFrames: longFrames,
      stateChanges,
      pipelineGroups: pipelineGroups.slice(0, 20),
      textureGroups: textureGroups.slice(0, 20),
      shipPipelineEvents: pipelineEvents.filter((event) =>
        /WINGS|BASE/i.test(event.label || '')),
      materialCatalog,
      pageErrors,
    };
    trace.frames = frames;
    trace.summary = summary;
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'trace.json'), JSON.stringify(trace, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Hero hand-off trace: ${path.join(outputDir, 'trace.json')}`);
    if (pageErrors.length) process.exitCode = 1;
    await page.close();
  }
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
