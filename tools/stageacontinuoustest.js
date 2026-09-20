import assert from 'node:assert/strict';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const OUT = `test-results/stage-a-continuous/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const FROM_ALTITUDE = 300000;
const TO_ALTITUDE = 800;
const DURATION_MS = Number(process.env.STAGE_A_DESCENT_MS) || 60000;
const MAX_SUBPIXEL_COLLAPSE = 4.5;
const captureAltitudes = [220000, 136000, 82000, 52000, 30000, 16000, 8000, 3500, 1200];

function frameReadability(buffer) {
  const png = PNG.sync.read(buffer);
  const step = 4;
  const x0 = Math.floor(png.width * 0.04);
  const x1 = Math.floor(png.width * 0.96);
  const y0 = Math.floor(png.height * 0.12);
  const y1 = Math.floor(png.height * 0.78);
  const cols = Math.ceil((x1 - x0) / step);
  const rows = Math.ceil((y1 - y0) / step);
  const classes = new Uint8Array(cols * rows);
  let water = 0, land = 0, neutral = 0, samples = 0;
  let mean = 0, m2 = 0, chroma = 0;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x = Math.min(png.width - 1, x0 + gx * step);
      const y = Math.min(png.height - 1, y0 + gy * step);
      // Remove the ship body while retaining both sides of its surrounding
      // coastline. HUD arcs are thin enough not to dominate this sampled ROI.
      if (x > png.width * 0.32 && x < png.width * 0.68 && y > png.height * 0.48) continue;
      const i = (y * png.width + x) * 4;
      const r = png.data[i] / 255;
      const g = png.data[i + 1] / 255;
      const b = png.data[i + 2] / 255;
      const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const range = Math.max(r, g, b) - Math.min(r, g, b);
      samples++;
      const delta = value - mean;
      mean += delta / samples;
      m2 += delta * (value - mean);
      chroma += range;
      let kind = 0;
      if (value > 0.08 && value < 0.94 && b - r > 0.012 && b - g > -0.06) {
        kind = 1;
        water++;
      } else if (value > 0.08 && value < 0.94
          && (r - b > 0.028 || g - b > 0.025)) {
        kind = 2;
        land++;
      } else neutral++;
      classes[gy * cols + gx] = kind;
    }
  }
  let shoreTransitions = 0;
  for (let gy = 1; gy < rows; gy++) {
    for (let gx = 1; gx < cols; gx++) {
      const kind = classes[gy * cols + gx];
      if (!kind) continue;
      const left = classes[gy * cols + gx - 1];
      const above = classes[(gy - 1) * cols + gx];
      if ((kind === 1 && left === 2) || (kind === 2 && left === 1)) shoreTransitions++;
      if ((kind === 1 && above === 2) || (kind === 2 && above === 1)) shoreTransitions++;
    }
  }
  return {
    waterFraction: water / Math.max(1, samples),
    landFraction: land / Math.max(1, samples),
    neutralFraction: neutral / Math.max(1, samples),
    contrast: Math.sqrt(m2 / Math.max(1, samples)),
    meanChroma: chroma / Math.max(1, samples),
    shoreTransitions,
    samples,
  };
}

function meanFrameDelta(aBuffer, bBuffer) {
  const a = PNG.sync.read(aBuffer);
  const b = PNG.sync.read(bBuffer);
  let sum = 0, samples = 0;
  for (let y = Math.floor(a.height * 0.08); y < a.height * 0.88; y += 3) {
    for (let x = Math.floor(a.width * 0.04); x < a.width * 0.96; x += 3) {
      const i = (y * a.width + x) * 4;
      sum += Math.abs(a.data[i] - b.data[i])
        + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2]);
      samples += 3;
    }
  }
  return sum / Math.max(1, samples) / 255;
}

await mkdir(OUT, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/stageacontinuoustest.js');
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for continuous Stage A evidence.');

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
const video = page.video();
const errors = [];
const idleTrace = [];
let setupBuildBudget = null;
let descentBuildBudget = null;
async function waitForIdle(label) {
  const start = Date.now();
  while (Date.now() - start < 150000) {
    const state = await page.evaluate(() => ({ idle: NMS.idle(), stats: NMS.stats(),
      farFloraPending: NMS._ff.pending(),
      churn: [...(window.__stageAChurn?.values() || [])].filter((r) => r.created > 1 && r.disposed > 0)
        .sort((a, b) => b.created - a.created).slice(0, 24),
      bodies: NMS._internals.universe.system.planets.map((p) => ({ id: p.bodyId,
        terrain: p.lod?.debugStats?.(), water: p.waterLod?.debugStats?.(),
        near: p.nearWaterPatch?.debugStats?.() })) }));
    idleTrace.push({ label, elapsedMs: Date.now() - start, ...state });
    if (state.idle) return;
    await page.waitForTimeout(2000);
  }
  throw new Error(`${label}: NMS.idle did not settle in 150 s; owner trace preserved.`);
}
page.on('pageerror', (error) => errors.push(error.stack || String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

async function snapshot(name) {
  const buffer = await page.screenshot();
  await writeFile(`${OUT}/${name}.png`, buffer);
  const state = await page.evaluate(() => {
    const planet = NMS._planet(0);
    return {
      stats: NMS.stats(),
      lod: NMS.lod(),
      terrain: planet?.lod?.debugStats?.() || null,
      water: planet?.waterLod?.debugStats?.() || null,
      nearWater: planet?.nearWaterPatch?.debugStats?.() || null,
    };
  });
  return { ...state, readability: frameReadability(buffer) };
}

async function writeContactSheet(names) {
  const panelWidth = 640;
  const panelHeight = 360;
  const sheet = new PNG({ width: panelWidth * 3, height: panelHeight * 3 });
  for (let panel = 0; panel < names.length; panel++) {
    const source = PNG.sync.read(await readFile(`${OUT}/${names[panel]}.png`));
    const panelX = panel % 3;
    const panelY = Math.floor(panel / 3);
    for (let y = 0; y < panelHeight; y++) {
      const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / panelHeight));
      for (let x = 0; x < panelWidth; x++) {
        const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / panelWidth));
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const targetOffset = (((panelY * panelHeight + y) * sheet.width)
          + panelX * panelWidth + x) * 4;
        sheet.data[targetOffset] = source.data[sourceOffset];
        sheet.data[targetOffset + 1] = source.data[sourceOffset + 1];
        sheet.data[targetOffset + 2] = source.data[sourceOffset + 2];
        sheet.data[targetOffset + 3] = 255;
      }
    }
  }
  await writeFile(`${OUT}/12-same-target-descent-contact-sheet.png`, PNG.sync.write(sheet));
}

try {
  const url = `http://127.0.0.1:${port}/?renderer=auto&quality=ultra&nohero=1`
    + '&vclouds=1&farflora=1&post=1&freeze=1';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 90000 });
  setupBuildBudget = await page.evaluate(() => {
    window.__stageAChurn = new Map();
    for (const p of NMS._internals.universe.system.planets) for (const [kind, lod] of [['terrain', p.lod], ['water', p.waterLod]]) {
      if (!lod) continue;
      for (const [method, counter] of [['createChildren', 'created'], ['disposeChildren', 'disposed']]) {
        const original = lod[method];
        lod[method] = function (node, ...args) {
          const key = `${p.bodyId}/${kind}/${node.face}/${node.level}/${node.ix}/${node.iy}`;
          const row = window.__stageAChurn.get(key) || { key, created: 0, disposed: 0 };
          row[counter]++;
          row.frame = NMS.frame(); row.forceUntil = node.forceSplitUntil || 0;
          row.parentForceUntil = node.parent?.forceSplitUntil || 0;
          window.__stageAChurn.set(key, row);
          return original.call(this, node, ...args);
        };
      }
    }
    return NMS.setBuildBudget(42);
  });
  assert.equal(setupBuildBudget, 42);
  const coastFixture = await page.evaluate((altitude) => {
    const coast = NMS.setWade(0, { depth: 0.9, overview: true });
    NMS.setLocalSunAltitude(0, 28, { azimuthHint: coast.landward });
    const planet = NMS._planet(0);
    const THREE = NMS._THREE;
    const coastDirection = new THREE.Vector3(...coast.direction);
    const landward = new THREE.Vector3(...coast.landward);
    // Aim beyond the beach at the authored rising hinterland. This keeps the
    // same inlet as the scale anchor while preserving water, shore and relief
    // in the low-altitude end of the uncut descent.
    const targetDirection = coastDirection.clone()
      .addScaledVector(landward, 2000 / planet.R).normalize();
    const crossShore = new THREE.Vector3().crossVectors(targetDirection, landward).normalize();
    const weatherDirections = [targetDirection];
    for (const distance of [18000, 42000]) {
      for (const axis of [landward, crossShore]) {
        weatherDirections.push(targetDirection.clone()
          .addScaledVector(axis, distance / planet.R).normalize());
        weatherDirections.push(targetDirection.clone()
          .addScaledVector(axis, -distance / planet.R).normalize());
      }
    }
    let weatherHour = planet.weatherHours;
    let weatherScore = Infinity;
    let weatherState = null;
    const weatherCandidates = [];
    for (let hour = 0; hour < 240; hour += 0.5) {
      const neighborhood = weatherDirections.map((direction) =>
        planet.weatherAt(direction, hour));
      const scores = neighborhood.map((sample) => (sample.coverage || 0) * 0.65
        + (sample.lowMask || 0) * 0.24
        + (sample.stratusMask || 0) * 0.28
        + (sample.highMask || 0) * 0.12
        + (sample.fog || 0) * 0.4);
      const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      const score = average * 0.4 + Math.max(...scores) * 0.6;
      weatherCandidates.push({ hour, score });
      if (score < weatherScore) {
        weatherScore = score;
        weatherHour = hour;
        weatherState = neighborhood[0];
      }
    }
    planet.setWeatherTime(weatherHour);
    const horizonBlend = Math.max(0, Math.min(1, (altitude - 150000) / 70000));
    const approachRatio = 0.32
      + horizonBlend * horizonBlend * (3 - 2 * horizonBlend) * 1.13;
    const approachDistance = Math.max(3200, altitude * approachRatio);
    const cameraDirection = targetDirection.clone()
      .addScaledVector(landward, -approachDistance / planet.R).normalize();
    window.__stageACoastDirection = coast.direction;
    window.__stageACoastForward = coast.landward;
    window.__stageATargetDirection = targetDirection.toArray();
    NMS.setContinuousAtmosphereAltitude(0, altitude, {
      dir: cameraDirection.toArray(),
      forward: window.__stageACoastForward,
      surfaceTargetDirection: window.__stageATargetDirection,
    });
    weatherCandidates.sort((a, b) => a.score - b.score);
    return {
      ...coast,
      weatherHour,
      weatherScore,
      weatherState,
      weatherCandidates: weatherCandidates.slice(0, 64),
    };
  }, FROM_ALTITUDE);
  await waitForIdle('initial-300km');
  await page.waitForTimeout(1000);
  // CPU weather coverage is a broad physical forecast, not a promise that a
  // specific camera footprint is unobscured. Resolve the canonical clear-air
  // evidence window against the real volume renderer while keeping vclouds=1.
  // The subsequent acceptance descent itself remains one uncut trajectory.
  await page.evaluate(() => {
    const planet = NMS._planet(0);
    const THREE = NMS._THREE;
    const targetDirection = new THREE.Vector3(...window.__stageATargetDirection);
    const landward = new THREE.Vector3(...window.__stageACoastForward);
    const cameraDirection = targetDirection.clone()
      .addScaledVector(landward, -(82000 * 0.32) / planet.R).normalize();
    NMS.setContinuousAtmosphereAltitude(0, 82000, {
      dir: cameraDirection.toArray(),
      forward: window.__stageACoastForward,
      surfaceTargetDirection: window.__stageATargetDirection,
    });
  });
  await waitForIdle('weather-82km');
  await page.evaluate(() => NMS.setCloudsVisible(false, 0));
  await page.waitForTimeout(250);
  const clearReference = await page.screenshot();
  await page.evaluate(() => NMS.setCloudsVisible(true, 0));
  await page.waitForTimeout(1200);
  let renderedWeather = { hour: coastFixture.weatherHour, delta: Infinity };
  for (const candidate of coastFixture.weatherCandidates) {
    await page.evaluate((hour) => NMS.setTime(hour), candidate.hour);
    await page.waitForTimeout(350);
    const solarElevationDegrees = await page.evaluate(() => {
      const planet = NMS._planet(0);
      const THREE = NMS._THREE;
      const targetDirection = new THREE.Vector3(...window.__stageATargetDirection);
      return Math.asin(Math.max(-1, Math.min(1,
        targetDirection.dot(planet.sunDirLocal)))) * 180 / Math.PI;
    });
    if (solarElevationDegrees < 18 || solarElevationDegrees > 42) continue;
    const buffer = await page.screenshot();
    const delta = meanFrameDelta(buffer, clearReference);
    if (delta < renderedWeather.delta) {
      renderedWeather = { ...candidate, delta, solarElevationDegrees };
    }
  }
  assert.ok(Number.isFinite(renderedWeather.delta),
    'rendered weather search must find a clear daylight candidate');
  const renderedState = await page.evaluate((hour) => {
    NMS.setTime(hour);
    const planet = NMS._planet(0);
    const THREE = NMS._THREE;
    const targetDirection = new THREE.Vector3(...window.__stageATargetDirection);
    return {
      weather: planet.weatherAt(targetDirection, hour),
      solarElevationDegrees: Math.asin(Math.max(-1, Math.min(1,
        targetDirection.dot(planet.sunDirLocal)))) * 180 / Math.PI,
    };
  }, renderedWeather.hour);
  await page.waitForTimeout(800);
  Object.assign(renderedWeather, renderedState);
  coastFixture.renderedWeather = renderedWeather;
  delete coastFixture.weatherCandidates;
  await page.evaluate(() => {
    NMS.lodReset();
    NMS.resetPerformanceStats();
    const planet = NMS._planet(0);
    const THREE = NMS._THREE;
    const targetDirection = new THREE.Vector3(...window.__stageATargetDirection);
    const landward = new THREE.Vector3(...window.__stageACoastForward);
    const cameraDirection = targetDirection.clone()
      .addScaledVector(landward, -(300000 * 1.45) / planet.R).normalize();
    const fixture = NMS.setContinuousAtmosphereAltitude(0, 300000, {
      dir: cameraDirection.toArray(),
      forward: window.__stageACoastForward,
      surfaceTargetDirection: window.__stageATargetDirection,
    });
    window.__stageAContinuous = {
      altitude: 300000,
      dir: fixture.dir,
      forward: fixture.forward,
      done: false,
      trace: [],
    };
  });

  await waitForIdle('descent-start-300km');
  descentBuildBudget = await page.evaluate(() => NMS.setBuildBudget(0));
  assert.equal(descentBuildBudget, 0, 'Uncut descent must use the ordinary player build budget.');
  await page.evaluate(({ from, to, duration }) => {
    const state = window.__stageAContinuous;
    const startedAt = performance.now();
    const logFrom = Math.log(from);
    const logTo = Math.log(to);
    let lastSample = -Infinity;
    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / duration);
      // Logarithmic motion gives every apparent scale band meaningful screen
      // time instead of spending almost the whole run in empty high orbit.
      const eased = t * t * (3 - 2 * t);
      const altitude = Math.exp(logFrom + (logTo - logFrom) * eased);
      const planet = NMS._planet(0);
      const THREE = NMS._THREE;
      const targetDirection = new THREE.Vector3(...window.__stageATargetDirection);
      const landward = new THREE.Vector3(...state.forward);
      // Preserve the curved limb in high orbit, then pitch progressively
      // down through the cloud deck. A fixed grazing angle spent 30-82 km
      // looking through hundreds of kilometres of perfectly valid cloud and
      // atmosphere, hiding the same coastline the continuity gate is meant
      // to track. This remains one uncut trajectory with clouds/post/HUD on.
      const horizonBlend = Math.max(0, Math.min(1,
        (altitude - 150000) / 70000));
      const smoothHorizon = horizonBlend * horizonBlend * (3 - 2 * horizonBlend);
      const approachRatio = 0.32 + smoothHorizon * 1.13;
      const approachDistance = Math.max(3200, altitude * approachRatio);
      const cameraDirection = targetDirection.clone()
        .addScaledVector(landward, -approachDistance / planet.R).normalize();
      NMS.setContinuousAtmosphereAltitude(0, altitude, {
        dir: cameraDirection.toArray(),
        forward: state.forward,
        surfaceTargetDirection: window.__stageATargetDirection,
      });
      state.altitude = altitude;
      if (now - lastSample >= 250 || t >= 1) {
        const planet = NMS._planet(0);
        const terrain = planet?.lod?.debugStats?.() || {};
        const water = planet?.waterLod?.debugStats?.() || {};
        state.trace.push({
          t,
          altitude,
          terrainPending: terrain.pending || 0,
          waterPending: water.pending || 0,
          terrainMorphs: terrain.activeMorphs || 0,
          waterMorphs: water.activeMorphs || 0,
          terrainMaxLevel: terrain.visibleMaxLevel ?? null,
          waterMaxLevel: water.visibleMaxLevel ?? null,
          ...NMS.lod(),
        });
        lastSample = now;
      }
      if (t < 1) requestAnimationFrame(step);
      else state.done = true;
    };
    requestAnimationFrame(step);
  }, { from: FROM_ALTITUDE, to: TO_ALTITUDE, duration: DURATION_MS });

  const captures = [];
  const captureNames = [];
  for (const altitude of captureAltitudes) {
    await page.waitForFunction((target) => window.__stageAContinuous.altitude <= target,
      altitude, { timeout: DURATION_MS + 30000, polling: 100 });
    const captureName = `${String(captures.length + 1).padStart(2, '0')}-${altitude}m`;
    const state = await snapshot(captureName);
    captureNames.push(captureName);
    captures.push({ altitude, ...state });
  }
  await writeContactSheet(captureNames);
  await page.waitForFunction(() => window.__stageAContinuous.done,
    null, { timeout: DURATION_MS + 30000, polling: 100 });
  await page.waitForFunction(() => {
    const planet = NMS._planet(0);
    const terrain = planet?.lod?.debugStats?.();
    const water = planet?.waterLod?.debugStats?.();
    const nearWater = planet?.nearWaterPatch?.debugStats?.();
    return (terrain?.pending || 0) === 0 && (water?.pending || 0) === 0
      && (terrain?.activeMorphs || 0) === 0 && (water?.activeMorphs || 0) === 0
      && (!nearWater?.visible || nearWater.pending === false);
  }, null, { timeout: 150000, polling: 250 });
  await page.waitForTimeout(800);

  const final = await snapshot('10-settled-800m');
  const trace = await page.evaluate(() => window.__stageAContinuous.trace);
  const max = (key) => Math.max(0, ...trace.map((sample) => sample[key] || 0));
  const last = trace.at(-1);
  const report = {
    generatedAt: new Date().toISOString(),
    ...fingerprint,
    durationMs: DURATION_MS,
    preparation: { setupBuildBudget, descentBuildBudget,
      scope: '42 ms loading-equivalent fixture preparation only; cold interactive readiness remains independently measured.', idleTrace },
    trajectory: 'curved coast with shallow water and rising hinterland',
    videoArtifact: '11-coast-descent.webm',
    contactSheetArtifact: '12-same-target-descent-contact-sheet.png',
    coastFixture,
    viewport: '1920x1080',
    hud: true,
    post: true,
    renderer: final.stats.rendererBackend,
    gpu: final.stats.gpu,
    samples: trace.length,
    captures: captures.map((capture) => ({
      altitude: capture.altitude,
      terrainPending: capture.terrain?.pending || 0,
      waterPending: capture.water?.pending || 0,
      terrainLevel: capture.terrain?.visibleMaxLevel,
      waterLevel: capture.water?.visibleMaxLevel,
      readability: capture.readability,
    })),
    maxTerrainPending: max('terrainPending'),
    maxWaterPending: max('waterPending'),
    maxTerrainMorphs: max('terrainMorphs'),
    maxWaterMorphs: max('waterMorphs'),
    hardSwaps: final.lod.hardSwaps,
    worstSwapPx: final.lod.worstSwapPx,
    worstCollapsePx: final.lod.worstCollapsePx,
    finalTerrainPending: final.terrain?.pending || 0,
    finalWaterPending: final.water?.pending || 0,
    finalTerrainMorphs: final.terrain?.activeMorphs || 0,
    finalWaterMorphs: final.water?.activeMorphs || 0,
    finalTerrainLevel: final.terrain?.visibleMaxLevel,
    finalWaterLevel: final.water?.visibleMaxLevel,
    finalNearWater: final.nearWater,
    finalTrace: last,
    errors,
  };
  await writeFile(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(errors, [], errors.join('\n'));
  assert.equal(final.stats.rendererBackend, 'webgl2');
  assert.match(final.stats.gpu, /NVIDIA GeForce RTX 5080/i,
    'continuous acceptance must run on the production discrete GPU');
  assert.equal(final.lod.hardSwaps, 0, 'continuous descent has no unmorphed LOD swap');
  assert.ok(final.lod.worstCollapsePx <= MAX_SUBPIXEL_COLLAPSE,
    `collapse ${final.lod.worstCollapsePx}px exceeds ${MAX_SUBPIXEL_COLLAPSE}px`);
  assert.equal(final.terrain?.pending || 0, 0);
  assert.equal(final.water?.pending || 0, 0);
  assert.equal(final.terrain?.activeMorphs || 0, 0);
  assert.equal(final.water?.activeMorphs || 0, 0);
  assert.ok((final.terrain?.visibleMaxLevel || 0) >= 14,
    'continuous descent reaches full near-field terrain detail');
  assert.ok((final.water?.visibleMaxLevel || 0) >= 8,
    'continuous descent reaches the authored water shell cap');
  assert.ok(trace.length >= 120, 'continuous trace samples the full descent');
  const landmarkCaptures = captures.filter((capture) => capture.altitude >= 8000);
  for (const capture of landmarkCaptures) {
    assert.ok(capture.readability.waterFraction >= 0.02,
      `${capture.altitude} m frame loses the tracked water body: ${JSON.stringify(capture.readability)}`);
    assert.ok(capture.readability.landFraction >= 0.035,
      `${capture.altitude} m frame loses the tracked landform: ${JSON.stringify(capture.readability)}`);
    assert.ok(capture.readability.contrast >= 0.07
        && capture.readability.meanChroma >= 0.06,
    `${capture.altitude} m frame collapses into an unreadable atmospheric veil: ${JSON.stringify(capture.readability)}`);
    assert.ok(capture.readability.shoreTransitions >= 500,
      `${capture.altitude} m frame no longer resolves a water/land boundary: ${JSON.stringify(capture.readability)}`);
  }
  console.log('PASS: normal HUD/post continuous Stage A descent');
} catch (error) {
  await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {});
  const state = await page.evaluate(() => ({ stats: NMS.stats(), idle: NMS.idle() })).catch(() => null);
  await writeFile(`${OUT}/failure.json`, JSON.stringify({ status: 'fail', error: String(error.stack || error),
    fingerprint, endFingerprint: await evidenceFingerprint('tools/stageacontinuoustest.js'),
    state, setupBuildBudget, descentBuildBudget, idleTrace, errors }, null, 2));
  throw error;
} finally {
  await page.close();
  await video?.saveAs(`${OUT}/11-coast-descent.webm`);
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
