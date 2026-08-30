import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const OUT = 'test-results/stage-a-webgl';
const MAX_SUBPIXEL_COLLAPSE = 4.5;
await mkdir(OUT, { recursive: true });

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for the WebGL2 Stage A review.');

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack || String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

async function settle(index = 0, milliseconds = 4000) {
  await page.waitForTimeout(milliseconds);
  await page.waitForFunction((planetIndex) => {
    const planet = NMS._planet(planetIndex);
    const terrain = planet?.lod?.debugStats?.();
    const water = planet?.waterLod?.debugStats?.();
    return (terrain?.visible || 0) > 0 && (!water || (water.visible || 0) > 0);
  }, index, { timeout: 30000 });
  // Acceptance images represent a settled LOD state. Sampling while hundreds
  // of chunks remain queued can make a transition frame look like the final
  // renderer and hides exactly the refinement weakness this suite audits.
  await page.waitForFunction((planetIndex) => {
    const planet = NMS._planet(planetIndex);
    const terrain = planet?.lod?.debugStats?.();
    const water = planet?.waterLod?.debugStats?.();
    return (terrain?.pending || 0) === 0 && (water?.pending || 0) === 0;
  }, index, { timeout: 120000, polling: 250 });
  // Retain the LOD monitor window that began immediately before the camera
  // move. The capture is taken after settlement, but its telemetry must still
  // cover the complete coarse-to-fine transition rather than an easy idle
  // window.
  await page.waitForTimeout(900);
}

function imageMoments(buffer) {
  const png = PNG.sync.read(buffer);
  let samples = 0;
  let mean = 0;
  let m2 = 0;
  let chroma = 0;
  let nearBlack = 0;
  // Central review field: excludes most HUD panels while retaining the
  // planet/ocean or coastline owned by each deterministic fixture.
  for (let y = Math.floor(png.height * 0.12); y < Math.ceil(png.height * 0.88); y += 2) {
    for (let x = Math.floor(png.width * 0.18); x < Math.ceil(png.width * 0.82); x += 2) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i] / 255;
      const g = png.data[i + 1] / 255;
      const b = png.data[i + 2] / 255;
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      samples++;
      const delta = luminance - mean;
      mean += delta / samples;
      m2 += delta * (luminance - mean);
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      if (luminance < 0.008) nearBlack++;
    }
  }
  return {
    mean,
    sd: Math.sqrt(m2 / Math.max(samples, 1)),
    meanChroma: chroma / Math.max(samples, 1),
    nearBlackFraction: nearBlack / Math.max(samples, 1),
  };
}

function meanImageDelta(aBuffer, bBuffer) {
  const a = PNG.sync.read(aBuffer);
  const b = PNG.sync.read(bBuffer);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0;
  let samples = 0;
  for (let y = Math.floor(a.height * 0.12); y < Math.ceil(a.height * 0.88); y += 3) {
    for (let x = Math.floor(a.width * 0.18); x < Math.ceil(a.width * 0.82); x += 3) {
      const i = (y * a.width + x) * 4;
      sum += Math.abs(a.data[i] - b.data[i])
        + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2]);
      samples += 3;
    }
  }
  return sum / Math.max(1, samples) / 255;
}

async function capture(name, index = 0) {
  const buffer = await page.screenshot();
  await writeFile(`${OUT}/${name}.png`, buffer);
  const state = await page.evaluate((planetIndex) => {
    const planet = NMS._planet(planetIndex);
    return {
      stats: NMS.stats(),
      lod: NMS.lod(),
      terrain: planet?.lod?.debugStats?.() || null,
      water: planet?.waterLod?.debugStats?.() || null,
    };
  }, index);
  const result = { name, image: imageMoments(buffer), ...state };
  console.log(JSON.stringify(result, null, 2));
  return { ...result, buffer };
}

try {
  const url = `http://127.0.0.1:${port}/?renderer=auto&quality=ultra&nohero=1`
    + '&vclouds=1&farflora=0&post=1&freeze=1&buildms=120';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 90000 });

  const shaderContract = await page.evaluate(() => {
    const planet = NMS._planet(0);
    const terrainShader = planet?.terrainMaterial?.userData?.shader;
    const waterShader = planet?.liquidMat?.userData?.shader;
    const terrainMesh = planet?.lod?.roots?.find((root) => root.mesh)?.mesh;
    const waterMesh = planet?.waterLod?.roots?.find((root) => root.mesh)?.mesh;
    return {
      terrainMaterial: planet?.terrainMaterial?.type,
      waterMaterial: planet?.liquidMat?.type,
      waterTransmission: planet?.liquidMat?.transmission,
      waterIor: planet?.liquidMat?.ior,
      terrainUniforms: Object.keys(terrainShader?.uniforms || {}),
      waterUniforms: Object.keys(waterShader?.uniforms || {}),
      terrainMorphAttributes: terrainMesh
        ? ['aPositionDelta', 'aNormalDelta', 'aMatDelta', 'aExtraDelta']
          .every((name) => terrainMesh.geometry.hasAttribute(name)) : false,
      waterMorphAttributes: waterMesh
        ? ['aPositionDelta', 'aNormalDelta', 'aDepthDelta']
          .every((name) => waterMesh.geometry.hasAttribute(name)) : false,
      terrainDrawBridge: terrainMesh?.onBeforeRender?.name || '',
      waterDrawBridge: waterMesh?.onBeforeRender?.name || '',
    };
  });
  console.log(JSON.stringify({ shaderContract }, null, 2));
  assert.equal(shaderContract.terrainMaterial, 'MeshStandardMaterial');
  assert.equal(shaderContract.waterMaterial, 'MeshPhysicalMaterial');
  assert.ok(shaderContract.waterTransmission >= 0.8,
    'water enables the opaque-scene transmission path');
  assert.ok(Math.abs(shaderContract.waterIor - 1.333) < 1e-6,
    'water uses the physical liquid IOR');
  for (const name of ['uLodMorph']) {
    assert.ok(shaderContract.terrainUniforms.includes(name), `terrain owns ${name}`);
  }
  for (const name of ['uLodMorph', 'uAbsorption', 'uSkyZenith', 'uSkyHorizon',
    'uSunDir', 'uCloudTex']) {
    assert.ok(shaderContract.waterUniforms.includes(name), `water owns ${name}`);
  }
  assert.ok(shaderContract.terrainMorphAttributes, 'terrain carries parent deltas');
  assert.ok(shaderContract.waterMorphAttributes, 'water carries parent/depth deltas');
  assert.equal(shaderContract.terrainDrawBridge, 'syncLodMorph');
  assert.equal(shaderContract.waterDrawBridge, 'syncLodMorph');

  const results = [];
  await page.evaluate(() => { NMS.lodReset(); NMS.teleport(0, 2.5); });
  await settle(0, 4500);
  results.push(await capture('01-far-player'));
  await page.keyboard.press('KeyH');
  results.push(await capture('01-far-clean'));
  await page.keyboard.press('KeyH');

  await page.evaluate(() => { NMS.lodReset(); NMS.teleport(0, 0.72); });
  await settle(0, 5000);
  results.push(await capture('02-orbit-player'));

  for (const [name, altitude] of [['03-descent-136km', 136000], ['04-descent-52km', 52000]]) {
    await page.evaluate((metres) => { NMS.lodReset(); NMS.setAtmosphereAltitude(0, metres, { pitch: -0.2 }); }, altitude);
    await settle(0, 6000);
    results.push(await capture(name));
  }

  await page.evaluate(() => {
    NMS.lodReset();
    NMS.setSunAltitude(0, 32);
    NMS.setWade(0, { depth: 0.9, overview: true });
    NMS.setLocalSunAltitude(0, 32);
  });
  await settle(0, 6500);
  const coastDay = await capture('05-coast-day-player');
  results.push(coastDay);
  await page.keyboard.press('KeyH');
  results.push(await capture('05-coast-day-clean'));
  await page.keyboard.press('KeyH');

  await page.evaluate(() => NMS.setLocalSunAltitude(0, 3.5));
  await settle(0, 3200);
  const coastSunset = await capture('06-coast-sunset-player');
  results.push(coastSunset);
  assert.ok(Math.abs(coastDay.stats.environment.solarElevation - Math.sin(32 * Math.PI / 180)) < 0.01,
    'day fixture reaches the requested local solar elevation');
  assert.ok(Math.abs(coastSunset.stats.environment.solarElevation - Math.sin(3.5 * Math.PI / 180)) < 0.01,
    'sunset fixture reaches the requested local solar elevation');
  assert.ok(Math.abs(coastDay.stats.alt - coastSunset.stats.alt) < 0.1,
    'day and sunset captures retain the same local camera altitude');
  assert.ok(meanImageDelta(coastDay.buffer, coastSunset.buffer) > 0.025,
    'the same coastline must respond visibly to sunset lighting');

  const oceanIndex = await page.evaluate(() => NMS.planets()
    .find((planet) => planet.liquid === 'water' && planet.i !== 0)?.i ?? -1);
  if (oceanIndex >= 0) {
    await page.evaluate((index) => { NMS.lodReset(); NMS.teleport(index, 0.82); }, oceanIndex);
    await settle(oceanIndex, 5000);
    results.push(await capture('07-pelagic-orbit-player', oceanIndex));
  }

  assert.deepEqual(errors, [], errors.join('\n'));
  for (const result of results) {
    assert.equal(result.stats.rendererBackend, 'webgl2', `${result.name} uses the production backend`);
    assert.equal(result.lod.hardSwaps, 0, `${result.name} has no unmorphed hard LOD swap`);
    assert.ok(result.lod.worstCollapsePx <= MAX_SUBPIXEL_COLLAPSE,
      `${result.name} keeps every fast LOD collapse below ${MAX_SUBPIXEL_COLLAPSE}px`);
    assert.equal(result.terrain?.pending || 0, 0, `${result.name} terrain LOD is settled`);
    assert.equal(result.water?.pending || 0, 0, `${result.name} water LOD is settled`);
  }
  console.log(`PASS: Stage A WebGL2 visual matrix (${results.length} captures)`);
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
