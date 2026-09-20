// Repeatable real-GPU surface benchmark. This is intentionally not part of
// npm test because CI commonly has only SwiftShader. On a development machine:
//   npm run test:performance
// Optional: PERF_ADAPTER_LUID=0,88763 PERF_ASSERT=1 npm run test:performance

import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const width = Number(process.env.PERF_WIDTH) || 1920;
const height = Number(process.env.PERF_HEIGHT) || 1080;
const sampleMs = Number(process.env.PERF_SAMPLE_MS) || 8000;
const assertPerformance = process.env.PERF_ASSERT === '1';
const errors = [];
const fingerprint = await evidenceFingerprint('tools/perftest.js');
let browser;
let server;

try {
  const started = await startServer(0);
  server = started.server;
  browser = await launchHardwareBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => errors.push(String(error)));

  const url = new URL(`http://127.0.0.1:${started.port}/`);
  url.searchParams.set('worldlab', '1');
  url.searchParams.set('nolock', '1');
  url.searchParams.set('nohero', '1');
  url.searchParams.set('scene', 'lowflight');
  url.searchParams.set('alt', process.env.PERF_ALT || '800');
  url.searchParams.set('buildms', process.env.PERF_BUILD_MS || '50');
  // Keep backend comparison deterministic. Far-flora generation has its own
  // dedicated terrain test and varies with the selected biome.
  url.searchParams.set('farflora', process.env.PERF_FARFLORA || '0');
  url.searchParams.set('renderer', process.env.PERF_RENDERER || 'auto');
  url.searchParams.set('quality', process.env.PERF_QUALITY || 'high');
  if (process.env.PERF_GPU) url.searchParams.set('gpu', process.env.PERF_GPU);
  if (process.env.PERF_POST != null) url.searchParams.set('post', process.env.PERF_POST);
  if (process.env.PERF_VCLOUDS != null) url.searchParams.set('vclouds', process.env.PERF_VCLOUDS);

  const bootStart = Date.now();
  await page.goto(url.href);
  await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
  const bootMs = Date.now() - bootStart;

  const settleStart = Date.now();
  // `NMS.idle()` already includes terrain and far-flora queues. Requiring an
  // exact proxy count made valid worlds without tree coverage wait forever.
  let settled = true;
  try {
    await page.waitForFunction(() => NMS.idle(), null, {
      timeout: Number(process.env.PERF_SETTLE_MS) || 150000,
    });
  } catch {
    // Report a slow/non-settling backend instead of losing the performance
    // sample entirely. The pending counts in the report retain that evidence.
    settled = false;
  }
  await page.waitForTimeout(1000);
  const featureMask = {
    terrain: process.env.PERF_TERRAIN !== '0',
    water: process.env.PERF_WATER !== '0',
    shadows: process.env.PERF_SHADOWS !== '0',
  };
  if (!featureMask.terrain || !featureMask.water || !featureMask.shadows) {
    await page.evaluate((mask) => {
      const hideTree = (lod) => {
        if (!lod) return;
        lod.update = () => {};
        const hide = (node) => {
          if (node.mesh) node.mesh.visible = false;
          if (node.children) node.children.forEach(hide);
        };
        lod.roots.forEach(hide);
      };
      for (const planet of NMS._internals.universe.planets()) {
        if (!mask.terrain) hideTree(planet.lod);
        if (!mask.water) hideTree(planet.waterLod);
      }
      if (!mask.shadows) NMS._renderer.shadowMap.enabled = false;
    }, featureMask);
  }
  await page.evaluate(() => NMS.resetAdaptiveQuality());
  await page.waitForTimeout(Number(process.env.PERF_ADAPT_MS) || 15000);
  await page.evaluate(() => NMS.resetPerformanceStats());
  const settleMs = Date.now() - settleStart;

  const timing = await page.evaluate((duration) => new Promise((resolve) => {
    const gaps = [];
    let frames = 0;
    let previous = performance.now();
    const start = previous;
    function sample(now) {
      frames++;
      const gap = now - previous;
      gaps.push(gap);
      previous = now;
      if (now - start >= duration) {
        const sorted = [...gaps].sort((a, b) => a - b);
        const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
        resolve({
          fps: frames * 1000 / (now - start),
          low1Fps: 1000 / Math.max(0.1, p99),
          maxFrameMs: Math.max(...gaps),
          framesOver25Ms: gaps.filter((gap) => gap > 25).length,
          longFrameRatio: gaps.filter((gap) => gap > 50).length / gaps.length,
          frameCount: frames,
          sampleMs: now - start,
        });
      } else {
        requestAnimationFrame(sample);
      }
    }
    requestAnimationFrame(sample);
  }), sampleMs);

  const result = await page.evaluate(() => {
    const { universe, nav } = NMS._internals;
    const planet = universe.planets().reduce((closest, candidate) => {
      if (!closest) return candidate;
      return candidate.posUniv.distanceToSquared(nav.pos)
        < closest.posUniv.distanceToSquared(nav.pos) ? candidate : closest;
    }, null);
    return {
      stats: NMS.stats(),
      terrain: planet?.lod?.debugStats?.() || null,
      water: planet?.waterLod?.debugStats?.() || null,
    };
  });
  const minFps = Number(process.env.PERF_MIN_FPS)
    || (result.stats.quality === 'ultra' ? 60 : result.stats.quality === 'performance' ? 45 : 50);
  const minLow1Fps = Number(process.env.PERF_MIN_LOW1_FPS)
    || (result.stats.quality === 'ultra' ? 50 : result.stats.quality === 'performance' ? 30 : 38);
  const finalFingerprint = await evidenceFingerprint('tools/perftest.js');
  const report = {
    generatedAt: new Date().toISOString(),
    ...fingerprint,
    stableSource: fingerprint.sourceDigest === finalFingerprint.sourceDigest,
    viewport: `${width}x${height}`,
    requestedFeatures: {
      quality: url.searchParams.get('quality'),
      post: url.searchParams.get('post') !== '0',
      volumetricClouds: url.searchParams.get('vclouds') !== '0',
      farFlora: url.searchParams.get('farflora') !== '0',
    },
    featureMask,
    bootMs,
    settleMs,
    settled,
    fps: Number(timing.fps.toFixed(1)),
    // Runtime HUD stats retain only 600 frames. Acceptance uses the entire
    // measured interval, including its first frames and any >500 ms stalls.
    low1Fps: Number(timing.low1Fps.toFixed(1)),
    longFrameRatio: timing.longFrameRatio,
    frameCount: timing.frameCount,
    sampleMs: timing.sampleMs,
    maxFrameMs: Number(timing.maxFrameMs.toFixed(1)),
    framesOver25Ms: timing.framesOver25Ms,
    minFps,
    minLow1Fps,
    ...result,
    errors,
  };
  if (process.env.PERF_REPORT) {
    await mkdir(dirname(process.env.PERF_REPORT), { recursive: true });
    await writeFile(process.env.PERF_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));

  if (errors.length) throw new Error(`${errors.length} page error(s)`);
  if (assertPerformance && !report.stableSource) throw new Error('Source changed during performance sampling');
  if (assertPerformance && !settled) throw new Error('Surface did not settle before performance sampling');
  if (assertPerformance && timing.fps < minFps) {
    throw new Error(`surface performance ${timing.fps.toFixed(1)} FPS is below ${minFps} FPS`);
  }
  if (assertPerformance && timing.low1Fps < minLow1Fps) {
    throw new Error(`surface 1% low ${timing.low1Fps.toFixed(1)} FPS is below ${minLow1Fps} FPS`);
  }
  if (assertPerformance && timing.longFrameRatio >= 0.01) {
    throw new Error(`surface long-frame ratio ${(timing.longFrameRatio * 100).toFixed(2)}% exceeds 1%`);
  }
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
