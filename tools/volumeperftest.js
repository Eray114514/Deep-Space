// Real-hardware WebGPU cost isolation for the local atmosphere/cloud layer.
// Measures the exact same settled orbit frame while toggling only participating
// media and cloud integration budgets.

import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const width = Number(process.env.PERF_WIDTH) || 2560;
const height = Number(process.env.PERF_HEIGHT) || 1440;
const sampleMs = Number(process.env.PERF_SAMPLE_MS) || 4000;
const settleMs = Number(process.env.PERF_SETTLE_MS) || 90000;
const allowBusy = process.env.PERF_ALLOW_BUSY === '1';
const orbitOnly = process.env.PERF_ORBIT_ONLY === '1';
const factor = Number(process.env.PERF_FACTOR) || 0.152;
let browser;
let server;

async function measure(page, fixture) {
  await page.evaluate((next) => {
    const planet = NMS._planet(0);
    if (planet.atmoMesh?.material) planet.atmoMesh.material.visible = next.atmosphere;
    for (const mesh of [planet.cloudMesh, planet.cloudMesh2, planet.cloudMeshNoctilucent]) {
      if (mesh?.material) mesh.material.visible = next.analyticClouds;
    }
    if (planet.volCloudMat) {
      planet.volCloudMat.visible = next.volumeClouds;
    }
  }, fixture);
  // Visibility changes can instantiate a pipeline variant on its first real
  // draw. Discard that compilation and the render-target tier transition
  // before collecting steady frames.
  await page.waitForTimeout(2200);
  await page.evaluate(() => NMS.resetPerformanceStats());
  await page.waitForTimeout(300);
  const timing = await page.evaluate((duration) => new Promise((resolve) => {
    let frames = 0;
    let previous = performance.now();
    const frameTimes = [];
    const start = previous;
    function sample(now) {
      frames++;
      frameTimes.push(now - previous);
      previous = now;
      if (now - start >= duration) {
        frameTimes.sort((a, b) => a - b);
        resolve({
          fps: frames * 1000 / (now - start),
          medianMs: frameTimes[Math.floor(frameTimes.length * 0.5)],
          p95Ms: frameTimes[Math.floor(frameTimes.length * 0.95)],
        });
      } else requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }), sampleMs);
  const state = await page.evaluate(() => ({
    stats: NMS.stats(),
    volume: NMS.volumeState(),
    cloud: (() => {
      const planet = NMS._planet(0);
      return {
        meshVisible: planet.volCloudMesh?.visible || false,
        materialVisible: planet.volCloudMat?.visible || false,
        engage: planet.volCloudMat?.uniforms?.uEngage?.value || 0,
        lightSteps: planet.volCloudMat?.uniforms?.uLightSteps?.value || 0,
      };
    })(),
  }));
  return {
    name: fixture.name,
    atmosphere: fixture.atmosphere,
    analyticClouds: fixture.analyticClouds,
    volumeClouds: fixture.volumeClouds,
    fps: Number(timing.fps.toFixed(1)),
    medianMs: Number(timing.medianMs.toFixed(2)),
    p95Ms: Number(timing.p95Ms.toFixed(2)),
    calls: state.stats.calls,
    triangles: state.stats.tris,
    volumeScale: state.volume.scale,
    localVolumeBudget: state.stats.localVolumeBudget,
    viewSteps: state.volume.steps,
    lightSteps: state.cloud.lightSteps,
    volumeMeshVisible: state.cloud.meshVisible,
    volumeMaterialVisible: state.cloud.materialVisible,
    engage: Number(state.cloud.engage.toFixed(4)),
  };
}

async function settle(page, label) {
  const minimumLevels = label === 'orbit'
    ? { terrain: 5, water: 4 }
    : label === 'approach'
      ? { terrain: 7, water: 7 }
      : { terrain: 8, water: 8 };
  try {
    const started = Date.now();
    let stableSince = 0;
    let previousSignature = '';
    while (Date.now() - started < settleMs) {
      const state = await page.evaluate(() => {
        const planet = NMS._planet(0);
        return {
          terrain: planet?.lod?.debugStats?.() || null,
          water: planet?.waterLod?.debugStats?.() || null,
        };
      });
      const levelReady = (!state.terrain
        || state.terrain.visibleMaxLevel >= minimumLevels.terrain)
        && (!state.water || state.water.visibleMaxLevel >= minimumLevels.water);
      const morphReady = (!state.terrain || state.terrain.activeMorphs === 0)
        && (!state.water || state.water.activeMorphs === 0);
      const signature = JSON.stringify([
        state.terrain?.visibleLevels,
        state.water?.visibleLevels,
      ]);
      if (levelReady && morphReady && signature === previousSignature) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 1800) break;
      } else {
        stableSince = 0;
        previousSignature = signature;
      }
      await page.waitForTimeout(250);
    }
    if (!stableSince || Date.now() - stableSince < 1800) {
      throw new Error(`${label} visible LOD did not stabilize`);
    }
    await page.waitForTimeout(1200);
  } catch (error) {
    const state = await page.evaluate(() => ({
      stats: NMS.stats(),
      volume: NMS.volumeState(),
      terrain: NMS._planet(0)?.lod?.debugStats?.() || null,
      water: NMS._planet(0)?.waterLod?.debugStats?.() || null,
      idle: NMS.idle(),
    })).catch(() => null);
    if (allowBusy) {
      console.warn(`${label} remained busy: ${JSON.stringify(state)}`);
      return;
    }
    throw new Error(`${label} did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
}

try {
  const started = await startServer(0);
  server = started.server;
  browser = await launchWebGPUHardwareBrowser({ headless: true });
  if (!browser) {
    console.log('Volume performance test skipped: no hardware WebGPU browser.');
    process.exitCode = 0;
  } else {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${started.port}/?renderer=webgpu&quality=high`
      + `&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=${factor}`
      + '&time=9.5&freeze=1');
    await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
    await page.evaluate(() => NMS.setAdaptiveQualityLocked(true));
    await settle(page, 'orbit');

    const results = [];
    const deckOnly = await measure(page, {
      name: 'orbit-analytic-deck',
      atmosphere: false,
      analyticClouds: true,
      volumeClouds: false,
    });
    results.push(deckOnly);
    const orbit = await measure(page, {
      name: 'orbit-atmosphere-and-deck',
      atmosphere: true,
      analyticClouds: true,
      volumeClouds: true,
    });
    results.push(orbit);

    let approachAnalytic = null;
    let approach = null;
    let inCloud = null;
    if (!orbitOnly) {
      await page.evaluate(() => NMS.teleport(0, 0.06));
      await settle(page, 'approach');
      approachAnalytic = await measure(page, {
        name: 'approach-analytic-only',
        atmosphere: true,
        analyticClouds: true,
        volumeClouds: false,
      });
      results.push(approachAnalytic);
      approach = await measure(page, {
        name: 'approach-physical-volume',
        atmosphere: true,
        analyticClouds: true,
        volumeClouds: true,
      });
      results.push(approach);

      await page.evaluate(() => NMS.teleport(0, 0.022));
      await settle(page, 'in-cloud');
      inCloud = await measure(page, {
        name: 'in-cloud-physical-volume',
        atmosphere: true,
        analyticClouds: true,
        volumeClouds: true,
      });
      results.push(inCloud);
    }

    const runtime = await page.evaluate(() => {
      const stats = NMS.stats();
      return {
        gpu: stats.gpu,
        adapterInfo: stats.adapterInfo,
        renderer: stats.rendererBackend,
      };
    });
    console.log(JSON.stringify({
      viewport: `${width}x${height}`,
      factor,
      runtime,
      results,
      errors,
      note: 'Headless requestAnimationFrame cadence is environment-dependent; compare same-page deltas.',
    }, null, 2));
    if (errors.length) throw new Error(errors.join('\n'));
    if (orbit.volumeMeshVisible || orbit.engage > 0.001) {
      throw new Error(`Orbit rendered physical cloud volume: ${JSON.stringify(orbit)}`);
    }
    if (!String(orbit.localVolumeBudget).startsWith('orbit:')) {
      throw new Error(`Orbit budget tier mismatch: ${orbit.localVolumeBudget}`);
    }
    if (approach && !(approach.engage > 0.05 && approach.engage < 0.95)) {
      throw new Error(`Approach did not exercise cloud crossfade: ${approach.engage}`);
    }
    if (inCloud && !(inCloud.engage > 0.95 && inCloud.volumeMeshVisible)) {
      throw new Error(`In-cloud volume was not fully engaged: ${JSON.stringify(inCloud)}`);
    }
    if (orbit.medianMs - deckOnly.medianMs > 8) {
      throw new Error(`Orbit atmosphere overhead exceeded 8 ms: ${JSON.stringify({
        deckOnly: deckOnly.medianMs,
        orbit: orbit.medianMs,
      })}`);
    }
    if (approach && approach.medianMs - approachAnalytic.medianMs > 12) {
      throw new Error(`Approach volume overhead exceeded 12 ms: ${JSON.stringify({
        analytic: approachAnalytic.medianMs,
        volume: approach.medianMs,
      })}`);
    }
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
