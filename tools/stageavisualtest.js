import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const OUT = 'test-results/stage-a';
await mkdir(OUT, { recursive: true });

function imageStats(buffer) {
  const png = PNG.sync.read(buffer);
  let visible = 0;
  let sum = 0;
  let sumSq = 0;
  let chroma = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
    if (a === 0 || r + g + b < 5) continue;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    visible++;
    sum += y;
    sumSq += y * y;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const mean = visible ? sum / visible : 0;
  return {
    width: png.width,
    height: png.height,
    visible,
    mean,
    sd: visible ? Math.sqrt(Math.max(0, sumSq / visible - mean * mean)) : 0,
    chroma: visible ? chroma / visible : 0,
  };
}

function roiDifference(aBuffer, bBuffer, {
  x0 = 0.25, x1 = 0.75, y0 = 0.48, y1 = 0.94,
} = {}) {
  const a = PNG.sync.read(aBuffer);
  const b = PNG.sync.read(bBuffer);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0, changed = 0, count = 0;
  for (let y = Math.floor(a.height * y0); y < Math.floor(a.height * y1); y++) {
    for (let x = Math.floor(a.width * x0); x < Math.floor(a.width * x1); x++) {
      const index = (y * a.width + x) * 4;
      const delta = (Math.abs(a.data[index] - b.data[index])
        + Math.abs(a.data[index + 1] - b.data[index + 1])
        + Math.abs(a.data[index + 2] - b.data[index + 2])) / 3;
      sum += delta;
      if (delta > 8) changed++;
      count++;
    }
  }
  return { mae: sum / count, changedRatio: changed / count };
}

async function capture(page, name) {
  const buffer = await page.screenshot();
  await writeFile(join(OUT, `${name}.png`), buffer);
  const stats = imageStats(buffer);
  assert.ok(stats.visible > stats.width * stats.height * 0.16,
    `${name} must contain a substantial rendered scene`);
  assert.ok(stats.sd > 12, `${name} must retain lighting/depth contrast`);
  return stats;
}

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge with WebGPU is required for Stage A visual validation.');

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack || String(error)));
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error' || /validation error|NodeBuilder|shader error/i.test(text)) {
    errors.push(text);
  }
});

try {
  const base = `http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    // Stage A isolates terrain and water. Volumetric cloud traversal has its
    // own Stage B capture; letting a low cloud fill the wake frame previously
    // allowed a completely invisible water interaction to pass.
    + '&nohero=1&farflora=0&freeze=1&vclouds=0&scene=orbit&planet=0&factor=0.72&time=9.5';
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 90000 });
  await page.waitForTimeout(1800);

  const contract = await page.evaluate(() => {
    const planet = NMS._internals.universe.system.planets[0];
    const water = planet.liquidMat;
    return {
      renderer: NMS.stats().rendererBackend,
      radius: planet.R,
      reliefRatio: planet.hAmp / planet.R,
      specRadius: NMS._internals.universe.system.spec.bodies
        .find((body) => body.bodyId === 'planet-0')?.radius,
      oceanSpec: (() => {
        const body = NMS._internals.universe.system.spec.bodies
          .find((candidate) => candidate.bodyId === 'planet-1');
        const runtime = NMS._internals.universe.system.bodyById.get('planet-1');
        return {
          type: body?.type,
          radius: body?.radius,
          runtimeType: runtime?.type,
          runtimeRadius: runtime?.R,
          oceanProfile: runtime?.tuning?.oceanProfile,
        };
      })(),
      waterMaterialOwned: water === planet.waterLod?.planet?.terrainMaterial,
      waterUnderlay: !!planet.waterUnderlayMaterial,
      waterFinestCell: (Math.PI / 2) * planet.seaRadius
        / (planet.waterLod.planet.gridCellsAtLevel(planet.waterLod.planet.maxLevel)
          * (2 ** planet.waterLod.planet.maxLevel)),
      nodeMaterial: water?.userData?.nodeMaterial,
      profile: water?.userData?.waterProfile,
      moonOrbit: NMS._internals.universe.system.frames.get('planet-0-moon-0')?.spec?.orbit?.renderRadius,
    };
  });
  assert.equal(contract.renderer, 'webgpu');
  assert.equal(contract.radius, 900000);
  assert.equal(contract.specRadius, 900000);
  assert.deepEqual(contract.oceanSpec, {
    type: 'ocean',
    radius: 560000,
    runtimeType: 'ocean',
    runtimeRadius: 560000,
    oceanProfile: 'pelagic-storm',
  });
  assert.ok(contract.reliefRatio < 0.025);
  assert.ok(contract.waterFinestCell <= 32,
    `near water LOD must resolve the shortest swell, cell=${contract.waterFinestCell.toFixed(1)}m`);
  assert.equal(contract.waterMaterialOwned, true);
  assert.equal(contract.waterUnderlay, false,
    'water must not hide transmission behind a coplanar flat-colour underlay');
  assert.equal(contract.nodeMaterial, 'water-cross-sea-spectrum-v7');
  assert.equal(contract.profile?.spectrum?.model, 'directional-jonswap-inspired');
  assert.equal(contract.profile?.spectrum?.wavelengths?.length, 16);
  assert.equal(contract.profile?.spectrum?.amplitudes?.length, 16);
  assert.equal(contract.profile?.spectrum?.choppyDisplacement, true);
  assert.equal(contract.profile?.spectrum?.jacobianWhitecaps, true);
  assert.equal(contract.profile?.spectrum?.meanSquareSlopeFiltering, true);
  assert.deepEqual({
    transmission: contract.profile?.transmission,
    dynamicSky: contract.profile?.dynamicSky,
    cloudReflection: contract.profile?.cloudReflection,
    radianceReflection: contract.profile?.radianceReflection,
    wetShore: contract.profile?.wetShore,
    deterministicBathymetry: contract.profile?.deterministicBathymetry,
  }, {
    transmission: true,
    dynamicSky: true,
    cloudReflection: true,
    radianceReflection: true,
    wetShore: true,
    deterministicBathymetry: true,
  });
  assert.ok(contract.moonOrbit >= 3200000, 'home moon stays outside the enlarged atmosphere');

  const orbit = await capture(page, 'orbit');

  await page.evaluate(() => NMS.coast(0, 85));
  await page.waitForTimeout(1800);
  const ocean = await capture(page, 'ocean-day');

  assert.equal(await page.evaluate(() => NMS.setWaterWake(0, { height: 3, speed: 210 })), true);
  await page.waitForTimeout(2800);
  const wakeState = await page.evaluate(() => ({
    stats: NMS.stats(),
    field: NMS.waterField().filter((entry) => entry.active),
  }));
  assert.ok(wakeState.stats.waterInteractions > 0);
  assert.ok(wakeState.stats.waterContact > 0,
    `visible hull must contact water: ${JSON.stringify(wakeState.stats)}`);
  assert.ok(wakeState.field.length >= 2, 'directional hull wake segments are active');
  assert.ok(wakeState.field.filter((entry) =>
    Math.abs(entry.screen[0]) <= 1 && Math.abs(entry.screen[1]) <= 1
      && entry.screen[2] >= -1 && entry.screen[2] <= 1).length >= 2,
  `directional wake segments remain inside view: ${JSON.stringify(wakeState.field)}`);
  const wake = await capture(page, 'water-wake');
  const wakeOnBuffer = await page.screenshot();
  assert.equal(await page.evaluate(() => NMS.muteWaterWake(true)), true);
  await page.waitForTimeout(180);
  const wakeOffBuffer = await page.screenshot();
  await writeFile(join(OUT, 'water-wake-off.png'), wakeOffBuffer);
  const wakeDifference = roiDifference(wakeOnBuffer, wakeOffBuffer);
  assert.ok(wakeDifference.mae > 0.45 && wakeDifference.changedRatio > 0.012,
    `wake must visibly displace/foam the water ROI: ${JSON.stringify(wakeDifference)}`);

  const overviewResult = await page.evaluate(() => NMS.setWade(0, { depth: 0.9, overview: true }));
  assert.ok(Math.abs(overviewResult.actualDepth - 0.9) < 0.5,
    `shore overview must resolve shallow water: ${JSON.stringify(overviewResult)}`);
  assert.equal(overviewResult.overview, true);
  await page.waitForTimeout(1200);
  const shore = await capture(page, 'shore-day');

  const wadeResult = await page.evaluate(() => {
    const wade = NMS.setWade(0, { depth: 0.9 });
    const sun = NMS.setSunAltitude(0, 35);
    return { wade, sun };
  });
  assert.ok(Math.abs(wadeResult.wade.actualDepth - 0.9) < 0.5,
    `wade fixture must resolve shallow water: ${JSON.stringify(wadeResult)}`);
  assert.equal(wadeResult.wade.overview, false);
  assert.ok(Math.abs(wadeResult.sun.actualDegrees - 35) < 0.7,
    `daylight fixture must resolve its solar altitude: ${JSON.stringify(wadeResult)}`);
  await page.waitForTimeout(1800);
  const dayEnvironment = await page.evaluate(() => {
    const p = NMS._internals.universe.system.planets[0];
    const u = p.liquidMat.userData.shader.uniforms;
    return { horizon: u.uSkyHorizon.value.toArray(), day: u.uDay.value, sunset: u.uSunset.value };
  });
  const sunsetResult = await page.evaluate(() => NMS.setSunAltitude(0, -2, { faceSun: true }));
  assert.ok(Math.abs(sunsetResult.actualDegrees + 2) < 0.7);
  assert.equal(sunsetResult.faceSun, true);
  await page.waitForTimeout(1000);
  const sunsetEnvironment = await page.evaluate(() => {
    const p = NMS._internals.universe.system.planets[0];
    const u = p.liquidMat.userData.shader.uniforms;
    return { horizon: u.uSkyHorizon.value.toArray(), day: u.uDay.value, sunset: u.uSunset.value };
  });
  assert.notDeepEqual(sunsetEnvironment.horizon, dayEnvironment.horizon,
    'water reflection receives the live sunset horizon colour');
  assert.ok(sunsetEnvironment.sunset > dayEnvironment.sunset);
  const sunset = await capture(page, 'shore-sunset');

  assert.equal(await page.evaluate(() => NMS.dive(0)), true);
  await page.waitForTimeout(1400);
  const diveState = await page.evaluate(() => {
    const stats = NMS.stats();
    const p = NMS._internals.universe.system.planets[0];
    const localRadius = p.worldPositionToLocal(NMS._internals.nav.pos).length();
    return {
      stats,
      localRadius,
      seaRadius: p.seaRadius,
      waterDepth: p.seaRadius - localRadius,
    };
  });
  assert.equal(diveState.stats.environment.underwater, true,
    `dive fixture must be underwater: ${JSON.stringify(diveState)}`);
  const underwater = await capture(page, 'underwater');

  await page.evaluate(() => NMS.openStarMap());
  await page.waitForFunction('NMS.starMapOpen === true');
  await page.evaluate(() => NMS.setStarMapMode('system'));
  await page.waitForFunction(() => {
    const map = NMS._internals.starMap;
    return map?.mode === 'system' && map.sysview?.bodies?.length > 0
      && map.els?.loading?.classList.contains('done');
  }, null, { timeout: 90000 });
  const previewContract = await page.evaluate(() => {
    const map = NMS._internals.starMap;
    const preview = map.systemPreview(NMS._internals.universe.system.star);
    const oceanBody = preview.bodies.find((body) => body.bodyId === 'planet-1');
    const oceanRecord = map.sysview.bodies.find((record) => record.body.bodyId === 'planet-1');
    const homeRecord = map.sysview.bodies.find((record) => record.body.bodyId === 'planet-0');
    return {
      oceanType: oceanBody?.type,
      oceanRadius: oceanBody?.radius,
      oceanVisualRadius: oceanRecord?.radius,
      homeVisualRadius: homeRecord?.radius,
    };
  });
  assert.equal(previewContract.oceanType, 'ocean');
  assert.equal(previewContract.oceanRadius, 560000);
  assert.ok(previewContract.oceanVisualRadius > 1.6,
    'the ocean world must be visibly readable rather than a tiny blue dot');
  assert.ok(previewContract.homeVisualRadius > previewContract.oceanVisualRadius,
    'the 900 km home world owns the largest terrestrial silhouette in preview');
  const systemPreview = await capture(page, 'system-preview');
  await page.evaluate(() => NMS.closeStarMap());

  assert.deepEqual(errors, [], errors.join('\n'));
  console.log('PASS: Stage A WebGPU orbit, open ocean, shore, sunset reflection, wake, underwater and ocean-world preview scenes');
  console.log(JSON.stringify({
    contract, previewContract, overviewResult, wadeResult, sunsetResult,
    orbit, ocean, shore, sunset, wake, wakeDifference, underwater, systemPreview,
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
