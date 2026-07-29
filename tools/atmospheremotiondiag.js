// Real-hardware WebGPU diagnostic for atmosphere instability during camera
// motion. The simulation and adaptive quality are locked, then the camera
// follows an exact forward/reverse quaternion path at two altitudes. Matching
// poses should be pixel-identical; differences therefore distinguish genuine
// temporal instability from ordinary parallax.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const cssWidth = Number(process.env.ATMO_DIAG_CSS_WIDTH) || 2048;
const cssHeight = Number(process.env.ATMO_DIAG_CSS_HEIGHT) || 1152;
const pathSteps = Math.max(8, Number(process.env.ATMO_DIAG_PATH_STEPS) || 18);
const outputDir = path.resolve('test-results/atmosphere-motion-diagnostic');
const scenarios = [
  { name: 'orbit', factor: 0.152, yaw: 0.032, pitch: 0.012 },
  { name: 'descent', factor: 0.058, yaw: 0.025, pitch: 0.01 },
];

let browser;
let context;
let server;

function multiplyQuaternion(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function localLookQuaternion(yaw, pitch) {
  const yawHalf = yaw * 0.5;
  const pitchHalf = pitch * 0.5;
  return multiplyQuaternion(
    [0, Math.sin(yawHalf), 0, Math.cos(yawHalf)],
    [Math.sin(pitchHalf), 0, 0, Math.cos(pitchHalf)],
  );
}

function quaternionAngle(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1]
    + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1,
    Math.floor((sorted.length - 1) * fraction))];
}

function downsamplePng(buffer, columns = 128, rows = 72) {
  const image = PNG.sync.read(buffer);
  const cells = new Uint16Array(columns * rows * 3);
  for (let row = 0; row < rows; row++) {
    const y0 = Math.floor(row * image.height / rows);
    const y1 = Math.max(y0 + 1, Math.floor((row + 1) * image.height / rows));
    for (let column = 0; column < columns; column++) {
      const x0 = Math.floor(column * image.width / columns);
      const x1 = Math.max(x0 + 1, Math.floor((column + 1) * image.width / columns));
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const index = (y * image.width + x) * 4;
          red += image.data[index];
          green += image.data[index + 1];
          blue += image.data[index + 2];
          count++;
        }
      }
      const target = (row * columns + column) * 3;
      cells[target] = Math.round(red / count);
      cells[target + 1] = Math.round(green / count);
      cells[target + 2] = Math.round(blue / count);
    }
  }
  return { columns, rows, cells };
}

function imageSummary(grid) {
  let red = 0;
  let green = 0;
  let blue = 0;
  const count = grid.cells.length / 3;
  for (let index = 0; index < grid.cells.length; index += 3) {
    red += grid.cells[index];
    green += grid.cells[index + 1];
    blue += grid.cells[index + 2];
  }
  return {
    meanRgb: [red, green, blue].map((value) => Number((value / count).toFixed(3))),
    meanLuma: Number(((red * 0.2126 + green * 0.7152 + blue * 0.0722)
      / count).toFixed(3)),
  };
}

function gridDifference(a, b) {
  const values = [];
  const edgeValues = [];
  const flatValues = [];
  let changed = 0;
  let sum = 0;
  let edgeSum = 0;
  let flatSum = 0;
  let edgeCount = 0;
  let flatCount = 0;
  const luminance = (grid, cell) => {
    const offset = cell * 3;
    return grid.cells[offset] * 0.2126
      + grid.cells[offset + 1] * 0.7152
      + grid.cells[offset + 2] * 0.0722;
  };
  for (let row = 0; row < a.rows; row++) {
    for (let column = 0; column < a.columns; column++) {
      const cell = row * a.columns + column;
      const offset = cell * 3;
      const difference = (
        Math.abs(a.cells[offset] - b.cells[offset])
        + Math.abs(a.cells[offset + 1] - b.cells[offset + 1])
        + Math.abs(a.cells[offset + 2] - b.cells[offset + 2])
      ) / 3;
      values.push(difference);
      sum += difference;
      if (difference > 8) changed++;

      const right = column + 1 < a.columns ? luminance(a, cell + 1) : luminance(a, cell);
      const down = row + 1 < a.rows ? luminance(a, cell + a.columns) : luminance(a, cell);
      const gradient = Math.max(
        Math.abs(luminance(a, cell) - right),
        Math.abs(luminance(a, cell) - down),
      );
      if (gradient > 16) {
        edgeValues.push(difference);
        edgeSum += difference;
        edgeCount++;
      } else {
        flatValues.push(difference);
        flatSum += difference;
        flatCount++;
      }
    }
  }
  return {
    meanAbsRgb: Number((sum / values.length).toFixed(4)),
    p95AbsRgb: Number(percentile(values, 0.95).toFixed(4)),
    changedFraction: Number((changed / values.length).toFixed(5)),
    edgeMean: Number((edgeSum / Math.max(1, edgeCount)).toFixed(4)),
    flatMean: Number((flatSum / Math.max(1, flatCount)).toFixed(4)),
    edgeToFlat: Number(((edgeSum / Math.max(1, edgeCount))
      / Math.max(0.01, flatSum / Math.max(1, flatCount))).toFixed(3)),
    edgeP95: Number(percentile(edgeValues, 0.95).toFixed(4)),
    flatP95: Number(percentile(flatValues, 0.95).toFixed(4)),
  };
}

async function waitFrames(page, count = 2) {
  await page.evaluate((frames) => new Promise((resolve) => {
    const step = () => {
      frames--;
      if (frames <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);
}

async function settle(page, timeoutMs = 90000) {
  const started = Date.now();
  let stableSince = 0;
  let previous = '';
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const planet = NMS._planet(0);
      return {
        terrain: planet?.lod?.debugStats?.() || null,
        water: planet?.waterLod?.debugStats?.() || null,
        stats: NMS.stats(),
      };
    });
    const signature = JSON.stringify([
      state.terrain?.visibleLevels,
      state.water?.visibleLevels,
      state.stats.volumeScale,
      state.stats.localVolumeBudget,
    ]);
    const ready = (state.terrain?.activeMorphs || 0) === 0
      && (state.water?.activeMorphs || 0) === 0;
    if (ready && signature === previous) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince > 1600) return state;
    } else {
      stableSince = 0;
      previous = signature;
    }
    await page.waitForTimeout(200);
  }
  throw new Error('Atmosphere motion fixture did not reach a stable LOD/budget state.');
}

async function snapshotState(page) {
  return page.evaluate(() => {
    const planet = NMS._planet(0);
    const atmosphere = planet?.atmoMesh?.material?.uniforms;
    const cloud = planet?.volCloudMat?.uniforms;
    const stats = NMS.stats();
    const volume = NMS.volumeState();
    return {
      time: performance.now(),
      frame: NMS.frame(),
      navQuaternion: NMS._internals.nav.quat.toArray(),
      cameraQuaternion: NMS._internals.camera.quaternion.toArray(),
      rendererBackend: stats.rendererBackend,
      gpu: stats.gpu,
      dpr: stats.dpr,
      adaptiveStage: stats.adaptiveStage,
      localVolumeBudget: stats.localVolumeBudget,
      volumeScale: stats.volumeScale,
      atmosphereSteps: stats.atmosphereSteps,
      cloudSteps: stats.cloudSteps,
      activeBodyId: volume.activeBodyId,
      depthReady: atmosphere?.uDepthReady?.value ?? null,
      cloudDepthReady: cloud?.uDepthReady?.value ?? null,
      depthReversed: atmosphere?.uDepthReversed?.value ?? null,
      volumeSize: atmosphere?.uVolumeSize?.value?.toArray?.() || null,
      atmosphereCamera: atmosphere?.uCameraLocal?.value?.toArray?.() || null,
      cloudCamera: cloud?.uCameraLocal?.value?.toArray?.() || null,
      atmosphereLayer: planet?.atmoMesh?.layers?.mask ?? null,
      atmosphereVisible: planet?.atmoMesh?.visible ?? false,
      atmosphereMaterialVisible: planet?.atmoMesh?.material?.visible ?? false,
      cloudVisible: planet?.volCloudMesh?.visible ?? false,
      cloudEngage: cloud?.uEngage?.value ?? null,
      terrainPending: stats.terrainPending,
      waterPending: stats.waterPending,
    };
  });
}

async function capturePose(page, canvas, baseQuaternion, yaw, pitch) {
  const quaternion = multiplyQuaternion(
    baseQuaternion,
    localLookQuaternion(yaw, pitch),
  );
  await page.evaluate((next) => {
    NMS._internals.nav.quat.fromArray(next).normalize();
    NMS._internals.nav.vel.set(0, 0, 0);
  }, quaternion);
  await waitFrames(page, 2);
  const [png, state] = await Promise.all([
    canvas.screenshot({ type: 'png', scale: 'css' }),
    snapshotState(page),
  ]);
  const grid = downsamplePng(png);
  return {
    quaternion,
    grid,
    image: imageSummary(grid),
    state,
    png,
  };
}

async function runContinuousStateTrace(page, baseQuaternion, scenario) {
  return page.evaluate(({ base, yawAmplitude, pitchAmplitude }) =>
    new Promise((resolve) => {
      const multiply = (a, b) => [
        a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
        a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
        a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
      ];
      const local = (yaw, pitch) => {
        const yh = yaw * 0.5;
        const ph = pitch * 0.5;
        return multiply(
          [0, Math.sin(yh), 0, Math.cos(yh)],
          [Math.sin(ph), 0, 0, Math.cos(ph)],
        );
      };
      const frames = [];
      const total = 150;
      let index = 0;
      let previous = performance.now();
      const step = (now) => {
        const phase = index / (total - 1);
        const yaw = Math.sin(phase * Math.PI * 2) * yawAmplitude;
        const pitch = Math.sin(phase * Math.PI * 4 + 0.35) * pitchAmplitude;
        NMS._internals.nav.quat.fromArray(multiply(base, local(yaw, pitch))).normalize();
        const stats = NMS.stats();
        const volume = NMS.volumeState();
        const planet = NMS._planet(0);
        frames.push({
          index,
          time: now,
          rafMs: now - previous,
          yaw,
          pitch,
          frame: NMS.frame(),
          volumeScale: stats.volumeScale,
          localVolumeBudget: stats.localVolumeBudget,
          adaptiveStage: stats.adaptiveStage,
          depthReady: planet?.atmoMesh?.material?.uniforms?.uDepthReady?.value ?? null,
          cloudDepthReady: planet?.volCloudMat?.uniforms?.uDepthReady?.value ?? null,
          volumeSize: planet?.atmoMesh?.material?.uniforms?.uVolumeSize?.value
            ?.toArray?.() || null,
          activeBodyId: volume.activeBodyId,
        });
        previous = now;
        index++;
        if (index < total) requestAnimationFrame(step);
        else resolve(frames);
      };
      requestAnimationFrame(step);
    }), {
    base: baseQuaternion,
    yawAmplitude: scenario.yaw,
    pitchAmplitude: scenario.pitch,
  });
}

async function runScenario(page, canvas, scenario) {
  await page.evaluate(({ factor }) => {
    NMS.teleport(0, factor, { horizon: true, pitch: -0.14 });
    NMS.setAdaptiveQualityLocked(true);
  }, scenario);
  await settle(page);
  await page.waitForTimeout(500);
  const baseQuaternion = await page.evaluate(() => NMS._internals.nav.quat.toArray());
  const eventStart = await page.evaluate(() => __atmosphereMotionGpuTrace.events.length);
  const continuousFrames = await runContinuousStateTrace(page, baseQuaternion, scenario);
  await page.evaluate((base) => NMS._internals.nav.quat.fromArray(base).normalize(),
    baseQuaternion);
  await waitFrames(page, 3);

  const staticSamples = [];
  for (let index = 0; index < 5; index++) {
    staticSamples.push(await capturePose(page, canvas, baseQuaternion, 0, 0));
  }
  const staticDifferences = staticSamples.slice(1)
    .map((sample) => gridDifference(staticSamples[0].grid, sample.grid));

  const forward = [];
  for (let index = 0; index <= pathSteps; index++) {
    const phase = index / pathSteps;
    forward.push(await capturePose(
      page,
      canvas,
      baseQuaternion,
      scenario.yaw * phase,
      scenario.pitch * Math.sin(phase * Math.PI),
    ));
  }
  const reverse = [];
  for (let index = pathSteps; index >= 0; index--) {
    const phase = index / pathSteps;
    reverse[index] = await capturePose(
      page,
      canvas,
      baseQuaternion,
      scenario.yaw * phase,
      scenario.pitch * Math.sin(phase * Math.PI),
    );
  }

  const matchedPose = forward.map((sample, index) => ({
    index,
    yaw: Number((scenario.yaw * index / pathSteps).toFixed(6)),
    quaternionErrorRad: Number(quaternionAngle(
      sample.quaternion,
      reverse[index].quaternion,
    ).toFixed(9)),
    difference: gridDifference(sample.grid, reverse[index].grid),
    forwardImage: sample.image,
    reverseImage: reverse[index].image,
  }));
  const adjacent = forward.slice(1).map((sample, index) => ({
    index: index + 1,
    angleRad: Number(quaternionAngle(
      forward[index].quaternion,
      sample.quaternion,
    ).toFixed(8)),
    difference: gridDifference(forward[index].grid, sample.grid),
  }));

  const keyImages = [
    ['base', forward[0].png],
    ['turn', forward[pathSteps].png],
    ['return', reverse[0].png],
  ];
  for (const [name, data] of keyImages) {
    await writeFile(path.join(outputDir, `${scenario.name}-${name}.png`), data);
  }

  const gpuEvents = await page.evaluate((start) =>
    __atmosphereMotionGpuTrace.events.slice(start), eventStart);
  const stateChanges = [];
  for (let index = 1; index < continuousFrames.length; index++) {
    const previous = continuousFrames[index - 1];
    const current = continuousFrames[index];
    const changes = [];
    for (const key of [
      'volumeScale', 'localVolumeBudget', 'adaptiveStage', 'depthReady',
      'cloudDepthReady', 'activeBodyId',
    ]) {
      if (current[key] !== previous[key]) {
        changes.push(`${key}:${previous[key]}->${current[key]}`);
      }
    }
    if (JSON.stringify(current.volumeSize) !== JSON.stringify(previous.volumeSize)) {
      changes.push(`volumeSize:${previous.volumeSize}->${current.volumeSize}`);
    }
    if (changes.length) stateChanges.push({
      index,
      rafMs: Number(current.rafMs.toFixed(3)),
      changes,
    });
  }

  const matchedMeans = matchedPose.map((entry) => entry.difference.meanAbsRgb);
  const matchedEdges = matchedPose.map((entry) => entry.difference.edgeToFlat);
  const staticMeans = staticDifferences.map((entry) => entry.meanAbsRgb);
  const longFrames = continuousFrames.filter((frame) => frame.rafMs > 33.34);
  return {
    name: scenario.name,
    factor: scenario.factor,
    baseState: staticSamples[0].state,
    continuous: {
      frames: continuousFrames.length,
      medianRafMs: Number(percentile(
        continuousFrames.map((frame) => frame.rafMs),
        0.5,
      ).toFixed(3)),
      p95RafMs: Number(percentile(
        continuousFrames.map((frame) => frame.rafMs),
        0.95,
      ).toFixed(3)),
      longFrames: longFrames.length,
      maxRafMs: Number(Math.max(...continuousFrames.map((frame) => frame.rafMs))
        .toFixed(3)),
      stateChanges,
    },
    staticPose: {
      comparisons: staticDifferences,
      meanAbsRgbP95: Number(percentile(staticMeans, 0.95).toFixed(4)),
    },
    matchedPose: {
      comparisons: matchedPose,
      meanAbsRgbP50: Number(percentile(matchedMeans, 0.5).toFixed(4)),
      meanAbsRgbP95: Number(percentile(matchedMeans, 0.95).toFixed(4)),
      edgeToFlatP95: Number(percentile(matchedEdges, 0.95).toFixed(3)),
    },
    adjacentMotion: adjacent,
    gpuEvents,
  };
}

function diagnose(report) {
  const gpuErrors = report.gpu.errors.length
    + report.consoleErrors.filter((message) =>
      /ValidationError|WebGPU|GPUDevice|command buffer|TextureBinding|RenderAttachment/i
        .test(message)).length;
  const textureEvents = report.scenarios.flatMap((scenario) =>
    scenario.gpuEvents.filter((event) =>
      event.type === 'GPUDevice.createTexture' || event.type === 'GPUTexture.destroy'));
  const resizeEvents = report.scenarios.flatMap((scenario) =>
    scenario.continuous.stateChanges.filter((event) =>
      event.changes.some((change) => /volumeScale|volumeSize|localVolumeBudget/.test(change))));
  const matchedP95 = Math.max(...report.scenarios.map((scenario) =>
    scenario.matchedPose.meanAbsRgbP95));
  const staticP95 = Math.max(...report.scenarios.map((scenario) =>
    scenario.staticPose.meanAbsRgbP95));
  const edgeRatio = Math.max(...report.scenarios.map((scenario) =>
    scenario.matchedPose.edgeToFlatP95));

  let owner = 'stable';
  let confidence = 'high';
  if (gpuErrors > 0 || resizeEvents.length > 0
    || (textureEvents.length > 0 && matchedP95 > 2)) {
    owner = 'resource-invalidation-or-render-target-rebuild';
  } else if (matchedP95 > 2 && edgeRatio > 2.2) {
    owner = 'depth-composite-or-low-resolution-edge-reconstruction';
  } else if (staticP95 > 1 || matchedP95 > 2) {
    owner = 'temporal-sampling-or-untracked-state';
    confidence = 'medium';
  } else if (report.scenarios.some((scenario) =>
    scenario.continuous.longFrames > scenario.continuous.frames * 0.08)) {
    owner = 'camera-stutter-with-stable-atmosphere-pixels';
  }
  return {
    owner,
    confidence,
    evidence: {
      gpuErrors,
      textureLifecycleEventsDuringMotion: textureEvents.length,
      renderTargetOrBudgetChangesDuringMotion: resizeEvents.length,
      staticPoseMeanAbsRgbP95: Number(staticP95.toFixed(4)),
      matchedPoseMeanAbsRgbP95: Number(matchedP95.toFixed(4)),
      matchedPoseEdgeToFlatP95: Number(edgeRatio.toFixed(3)),
    },
    interpretation: owner === 'stable'
      ? 'No camera-dependent atmosphere instability reproduced in the locked 2K fixture.'
      : owner === 'resource-invalidation-or-render-target-rebuild'
        ? 'Pixel discontinuities coincide with WebGPU resource errors or target/budget churn.'
        : owner === 'depth-composite-or-low-resolution-edge-reconstruction'
          ? 'Repeated-pose differences concentrate at opaque/sky edges while render resources stay stable.'
          : owner === 'temporal-sampling-or-untracked-state'
            ? 'The exact same frozen pose changes without resource churn; inspect frame-varying sampling/state.'
            : 'The motion cadence stalls, but exact repeated poses remain visually stable.',
  };
}

try {
  await mkdir(outputDir, { recursive: true });
  const started = await startServer(0);
  server = started.server;
  browser = await launchWebGPUHardwareBrowser({ headless: true });
  if (!browser) {
    console.log('Atmosphere motion diagnostic skipped: no hardware WebGPU browser.');
    process.exitCode = 0;
  } else {
    context = await browser.newContext({
      viewport: { width: cssWidth, height: cssHeight },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      const trace = { events: [], errors: [] };
      globalThis.__atmosphereMotionGpuTrace = trace;
      const record = (type, detail = {}) =>
        trace.events.push({ time: performance.now(), type, ...detail });
      const normalizeSize = (size) => {
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
      const devicePrototype = globalThis.GPUDevice?.prototype;
      const createTexture = devicePrototype?.createTexture;
      if (typeof createTexture === 'function') {
        devicePrototype.createTexture = function tracedCreateTexture(descriptor = {}) {
          record('GPUDevice.createTexture', {
            label: descriptor.label || '',
            size: normalizeSize(descriptor.size),
            format: descriptor.format || '',
            usage: descriptor.usage || 0,
            samples: descriptor.sampleCount || 1,
          });
          const texture = createTexture.call(this, descriptor);
          const destroy = texture.destroy;
          if (typeof destroy === 'function') {
            texture.destroy = function tracedDestroy() {
              record('GPUTexture.destroy', {
                label: descriptor.label || '',
                size: normalizeSize(descriptor.size),
              });
              return destroy.call(this);
            };
          }
          return texture;
        };
      }
      const adapterPrototype = globalThis.GPUAdapter?.prototype;
      const requestDevice = adapterPrototype?.requestDevice;
      if (typeof requestDevice === 'function') {
        adapterPrototype.requestDevice = async function tracedRequestDevice(...args) {
          const device = await requestDevice.apply(this, args);
          device.addEventListener('uncapturederror', (event) => {
            const message = event.error?.message || String(event.error || event);
            trace.errors.push({ time: performance.now(), message });
          });
          return device;
        };
      }
    });

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const url = `http://127.0.0.1:${started.port}/?renderer=webgpu&quality=ultra`
      + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=0.152'
      + '&time=9.5&freeze=1';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.NMS?.booted === true', null, {
      timeout: 150000,
    });
    await page.evaluate(() => {
      NMS.setAdaptiveQualityLocked(true);
      const style = document.createElement('style');
      style.id = 'atmosphere-motion-diag-clean-frame';
      style.textContent = `
        body > *:not(#app) { display: none !important; }
        #app > *:not(canvas) { display: none !important; }
      `;
      document.head.appendChild(style);
    });
    const canvas = page.locator('#app > canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: 30000 });
    const results = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(page, canvas, scenario));
    }
    const finalGpuTrace = await page.evaluate(() => __atmosphereMotionGpuTrace);
    const runtime = await page.evaluate(() => ({
      stats: NMS.stats(),
      volume: NMS.volumeState(),
    }));
    const report = {
      url,
      cssViewport: [cssWidth, cssHeight],
      drawingBuffer: runtime.volume.drawingBuffer,
      runtime: {
        renderer: runtime.stats.rendererBackend,
        gpu: runtime.stats.gpu,
        adapterInfo: runtime.stats.adapterInfo,
        quality: runtime.stats.quality,
        dpr: runtime.stats.dpr,
      },
      fixedConditions: {
        renderer: 'webgpu',
        quality: 'ultra',
        adaptiveQualityLocked: true,
        simulationFrozen: true,
        weatherHours: runtime.volume.weatherTime,
      },
      scenarios: results,
      gpu: finalGpuTrace,
      consoleErrors,
    };
    report.diagnosis = diagnose(report);
    await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      runtime: report.runtime,
      drawingBuffer: report.drawingBuffer,
      scenarios: report.scenarios.map((scenario) => ({
        name: scenario.name,
        continuous: scenario.continuous,
        staticPose: scenario.staticPose.meanAbsRgbP95,
        matchedPose: scenario.matchedPose.meanAbsRgbP95,
        edgeToFlat: scenario.matchedPose.edgeToFlatP95,
        gpuEvents: scenario.gpuEvents.length,
      })),
      diagnosis: report.diagnosis,
      consoleErrors,
    }, null, 2));
    console.log(`Atmosphere motion report: ${path.join(outputDir, 'report.json')}`);
    if (consoleErrors.length || finalGpuTrace.errors.length) process.exitCode = 1;
    await page.close();
  }
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
