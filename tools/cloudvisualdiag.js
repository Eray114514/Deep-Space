import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function listOption(name, fallback, map = (value) => value) {
  return option(name, fallback).split(',').map((value) => map(value.trim()))
    .filter((value) => value !== '' && Number.isNaN(value) === false);
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '');
}

function imageDifference(lowerBuffer, higherBuffer) {
  const lower = PNG.sync.read(lowerBuffer);
  const higher = PNG.sync.read(higherBuffer);
  assert.equal(lower.width, higher.width);
  assert.equal(lower.height, higher.height);
  const deltas = [];
  let sum = 0;
  let changed = 0;
  const pixels = lower.width * lower.height;
  for (let offset = 0; offset < lower.data.length; offset += 4) {
    const delta = (Math.abs(lower.data[offset] - higher.data[offset])
      + Math.abs(lower.data[offset + 1] - higher.data[offset + 1])
      + Math.abs(lower.data[offset + 2] - higher.data[offset + 2])) / 3;
    deltas.push(delta);
    sum += delta;
    if (delta > 3) changed++;
  }
  deltas.sort((a, b) => a - b);
  return {
    meanRgb255: sum / pixels,
    p95Rgb255: deltas[Math.floor(deltas.length * 0.95)] || 0,
    changedOver3Ratio: changed / pixels,
  };
}

const seeds = listOption('seeds',
  'CLOUD-PHASE4-A,CLOUD-PHASE4-B,CLOUD-PHASE4-C');
const times = listOption('times', '9.5,17.75,23.5', Number);
const samples = listOption('samples', '4,6,8,12', Number)
  .map((value) => Math.max(4, Math.min(12, Math.round(value))));
const sunAzimuthDeg = Number(option('sun-azimuth', '0')) || 0;
const cloudPercentile = Math.max(0.5,
  Math.min(0.98, Number(option('cloud-percentile', '0.82')) || 0.82));
const quick = process.argv.includes('--quick');
const activeSeeds = quick ? seeds.slice(0, 1) : seeds;
const activeTimes = quick ? times.slice(0, 1) : times;
const activeSamples = quick ? samples : [samples.includes(8) ? 8 : samples.at(-1)];
const views = listOption('views', 'S1,S2,S3,S4')
  .filter((view) => ['S1', 'S2', 'S3', 'S4'].includes(view));
const outputDir = new URL('../test-results/cloud-phase4/', import.meta.url);
await mkdir(outputDir, { recursive: true });

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('SKIP: cloud visual diagnostic needs an installed hardware WebGPU browser.');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  renderer: 'webgpu',
  viewport: [960, 540],
  quality: 'balanced',
  seeds: activeSeeds,
  times: activeTimes,
  samples: activeSamples,
  convergenceSamples: samples,
  sunAzimuthDeg,
  cloudPercentile,
  fixtures: [],
  convergence: [],
};

async function waitFrames(page, count = 4) {
  await page.evaluate((frames) => new Promise((resolve) => {
    let remaining = frames;
    const step = () => {
      remaining--;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);
}

async function setView(page, planetIndex, view, azimuth, percentile) {
  return page.evaluate(({ bodyIndex, scene, azimuthDeg, cloudQuantile }) => {
    const p = NMS._planet(bodyIndex);
    const occupancy = p.cloudResource.occupancy;
    const fields = p.cloudResource.fields;
    const { lonCount, latCount, altCount, data } = occupancy;
    const candidates = [];
    for (let j = 0; j < latCount; j++) {
      for (let i = 0; i < lonCount; i++) {
        let score = 0;
        let highestK = 0;
        let lowestK = altCount;
        for (let k = 0; k < altCount; k++) {
          const bound = data[((k * latCount + j) * lonCount + i) * 4];
          score += bound;
          if (bound >= 0.01) {
            highestK = k;
            lowestK = Math.min(lowestK, k);
          }
        }
        if (score > 0) candidates.push({ score, i, j, highestK, lowestK });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[Math.min(candidates.length - 1,
      Math.floor((candidates.length - 1) * cloudQuantile))]
      || { score: 0, i: 0, j: Math.floor(latCount / 2), highestK: 0, lowestK: 0 };
    const lon = ((best.i + 0.5) / lonCount) * Math.PI * 2;
    const lat = ((best.j + 0.5) / latCount - 0.5) * Math.PI;
    const up = new NMS._THREE.Vector3(
      Math.cos(lon) * Math.cos(lat),
      Math.sin(lat),
      Math.sin(lon) * Math.cos(lat),
    ).normalize();
    const sunProjected = p.sunDirLocal.clone()
      .addScaledVector(up, -p.sunDirLocal.dot(up));
    if (sunProjected.lengthSq() < 1e-6) {
      sunProjected.crossVectors(up,
        Math.abs(up.y) < 0.9 ? new NMS._THREE.Vector3(0, 1, 0)
          : new NMS._THREE.Vector3(1, 0, 0));
    }
    sunProjected.normalize();
    const crossTangent = new NMS._THREE.Vector3()
      .crossVectors(up, sunProjected).normalize();
    const azimuth = azimuthDeg * Math.PI / 180;
    const tangent = sunProjected.multiplyScalar(Math.cos(azimuth))
      .addScaledVector(crossTangent, Math.sin(azimuth)).normalize();
    const cloudTop = occupancy.shellFloor
      + (best.highestK + 1) / altCount
        * (occupancy.shellTop - occupancy.shellFloor);
    const cloudMiddle = occupancy.shellFloor
      + ((best.lowestK + best.highestK + 1) * 0.5) / altCount
        * (occupancy.shellTop - occupancy.shellFloor);

    const place = (altitude, tangentAmount, upAmount, positionDirection = up) => {
      const localPosition = positionDirection.clone().multiplyScalar(p.R + altitude);
      const localForward = tangent.clone().multiplyScalar(tangentAmount)
        .addScaledVector(positionDirection, upAmount).normalize();
      const localTarget = localPosition.clone()
        .addScaledVector(localForward, Math.max(200000, p.R * 0.25));
      const worldPosition = p.localPositionToWorld(localPosition,
        new NMS._THREE.Vector3());
      const worldTarget = p.localPositionToWorld(localTarget,
        new NMS._THREE.Vector3());
      NMS.setPosition(...worldPosition.toArray(), ...worldTarget.toArray());
      return { altitude, forward: localForward.toArray() };
    };

    let pose;
    if (scene === 'S4') {
      NMS.teleport(bodyIndex, 1.2, { dir: up.toArray() });
      pose = { altitude: p.R * 1.2, forward: up.clone().negate().toArray() };
    } else if (scene === 'S3') {
      pose = place(400000, 0.94, -0.34);
    } else if (scene === 'S2') {
      pose = place(cloudTop + 1500, 0.985, -0.17);
    } else {
      // At a 45-degree camera pitch, offset the observer back by roughly the
      // cloud midpoint's angular distance so the selected occupied column is
      // actually inside the frame instead of directly behind its top edge.
      const observerUp = up.clone().applyAxisAngle(crossTangent,
        -Math.atan(cloudMiddle / p.R)).normalize();
      const terrain = p.height?.(observerUp, 64)
        || fields.terrainMeters(observerUp);
      pose = place(terrain + 2.2, 0.707, 0.707, observerUp);
    }
    return {
      scene,
      planetIndex: bodyIndex,
      selectedColumn: best,
      direction: up.toArray(),
      cloudTop,
      cloudMiddle,
      groundR: fields.groundR,
      shellTop: fields.shellTopMeters,
      pose,
    };
  }, {
    bodyIndex: planetIndex,
    scene: view,
    azimuthDeg: azimuth,
    cloudQuantile: percentile,
  });
}

try {
  for (let seedIndex = 0; seedIndex < activeSeeds.length; seedIndex++) {
    const seed = activeSeeds[seedIndex];
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      const url = `http://127.0.0.1:${port}/?renderer=webgpu&quality=balanced`
        + `&worldlab=1&seed=${encodeURIComponent(seed)}&nolock=1&freeze=1`
        + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=0.15';
      await page.goto(url);
      await page.waitForFunction('window.NMS?.booted === true', null, {
        timeout: 120000,
      });
      await page.evaluate(() => {
        NMS.setAdaptiveQualityLocked(true);
        NMS.shipVisible(false);
        document.body.classList.add('hide-hud');
      });
      const planetIndex = await page.evaluate(() => {
        const index = NMS.planets().findIndex((_, candidate) =>
          Boolean(NMS._planet(candidate)?.volCloudState));
        if (index < 0) throw new Error('seed has no cloud-bearing planet');
        NMS.teleport(index, 0.15);
        return index;
      });
      try {
        await page.waitForFunction(
          (index) => NMS.cloudResourceState(index).planet?.status === 'ready',
          planetIndex,
          { timeout: 180000 },
        );
      } catch (error) {
        console.error(seed, JSON.stringify({
          resource: await page.evaluate((index) => NMS.cloudResourceState(index),
            planetIndex),
          errors,
        }, null, 2));
        throw error;
      }

      for (const time of activeTimes) {
        for (const view of views) {
          const captures = [];
          for (const sampleCount of activeSamples) {
            await page.evaluate(({ hours, spp }) => {
              NMS.setTime(hours);
              NMS.setCloudSamples(spp);
            }, { hours: time, spp: sampleCount });
            await waitFrames(page, 1);
            const pose = await setView(page, planetIndex, view, sunAzimuthDeg,
              cloudPercentile);
            await waitFrames(page, 5);
            try {
              await page.waitForFunction(
                (index) => NMS._planet(index)?.volCloudMesh?.visible === true
                  && NMS._planet(index)?.volCloudUniforms?.uEngage?.value > 0.98,
                planetIndex, { timeout: 30000 },
              );
            } catch (error) {
              const diagnostic = await page.evaluate((index) => ({
                volume: NMS.volumeState(),
                resource: NMS.cloudResourceState(index),
                stats: NMS.stats(),
                planet: {
                  visible: NMS._planet(index)?.volCloudMesh?.visible,
                  volumeActive: NMS._planet(index)?.volumeActive,
                  blend: NMS._planet(index)?.volumeBlend,
                  engage: NMS._planet(index)?.volCloudUniforms?.uEngage?.value,
                  analyticVisible: NMS._planet(index)?.cloudMesh?.visible,
                },
              }), planetIndex).catch(() => null);
              console.error(JSON.stringify({ seed, time, view, sampleCount,
                diagnostic }, null, 2));
              throw error;
            }
            const buffer = await page.screenshot();
            const filename = `${safeName(seed)}-t${String(time).replace('.', '-')}`
              + `-${view}-spp${sampleCount}-az${sunAzimuthDeg}.png`;
            await writeFile(new URL(filename, outputDir), buffer);
            const state = await page.evaluate((index) => ({
              volume: NMS.volumeState(),
              resource: NMS.cloudResourceState(index),
              fps: NMS.stats().averageFps,
              backend: NMS.stats().rendererBackend,
            }), planetIndex);
            captures.push({ sampleCount, filename, buffer, state });
            manifest.fixtures.push({
              seed, time, view, sampleCount, filename, pose, state,
            });
          }
          for (let index = 1; index < captures.length; index++) {
            manifest.convergence.push({
              seed,
              time,
              view,
              lower: captures[index - 1].sampleCount,
              higher: captures[index].sampleCount,
              difference: imageDifference(
                captures[index - 1].buffer, captures[index].buffer),
            });
          }
        }
      }
      assert.deepEqual(errors, [], `${seed} emitted browser errors`);
    } finally {
      await page.close();
    }
  }

  // Always produce the complete 4/6/8/12 ladder once, even when the default
  // multi-seed/time matrix uses only the selected 8-spp diagnostic tier.
  if (!quick && activeSamples.length === 1 && samples.length > 1) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      const seed = activeSeeds[0];
      const time = activeTimes[0];
      const url = `http://127.0.0.1:${port}/?renderer=webgpu&quality=balanced`
        + `&worldlab=1&seed=${encodeURIComponent(seed)}&nolock=1&freeze=1`
        + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=0.15';
      await page.goto(url);
      await page.waitForFunction('window.NMS?.booted === true', null,
        { timeout: 120000 });
      await page.evaluate(() => {
        NMS.setAdaptiveQualityLocked(true);
        NMS.shipVisible(false);
        document.body.classList.add('hide-hud');
      });
      const planetIndex = await page.evaluate(() => {
        const index = NMS.planets().findIndex((_, candidate) =>
          Boolean(NMS._planet(candidate)?.volCloudState));
        if (index < 0) throw new Error('seed has no cloud-bearing planet');
        NMS.teleport(index, 0.15);
        return index;
      });
      await page.waitForFunction(
        (index) => NMS.cloudResourceState(index).planet?.status === 'ready',
        planetIndex,
        { timeout: 180000 },
      );
      for (const view of views) {
        let previous = null;
        for (const sampleCount of samples) {
          await page.evaluate(({ hours, spp }) => {
            NMS.setTime(hours);
            NMS.setCloudSamples(spp);
          }, { hours: time, spp: sampleCount });
          await waitFrames(page, 1);
          const pose = await setView(page, planetIndex, view, sunAzimuthDeg,
            cloudPercentile);
          await waitFrames(page, 5);
          const buffer = await page.screenshot();
          const filename = `convergence-${safeName(seed)}-${view}`
            + `-spp${sampleCount}.png`;
          await writeFile(new URL(filename, outputDir), buffer);
          if (previous) manifest.convergence.push({
            seed, time, view, lower: previous.sampleCount, higher: sampleCount,
            difference: imageDifference(previous.buffer, buffer),
          });
          manifest.fixtures.push({
            seed, time, view, sampleCount, filename, pose, convergence: true,
          });
          previous = { sampleCount, buffer };
        }
      }
      assert.deepEqual(errors, [], 'convergence fixture emitted browser errors');
    } finally {
      await page.close();
    }
  }

  await writeFile(new URL('manifest.json', outputDir),
    `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    output: new URL('manifest.json', outputDir).pathname,
    fixtures: manifest.fixtures.length,
    convergence: manifest.convergence,
  }, null, 2));
  console.log('PASS: S1-S4 WebGPU captures completed with parameterized sun azimuth.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
