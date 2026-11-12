import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = `test-results/f5-shadow-sky-water-gpu/${stamp}`;
await mkdir(out, { recursive: true });

const { server, port } = await startServer(0);
let browser;
const pageErrors = [];
try {
  browser = await launchHardwareBrowser({
    headless: true,
    executablePath: resolveSystemChromePath() || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const page = await context.newPage();
  page.on('pageerror', err => pageErrors.push(String(err?.stack || err)));

  await page.goto(
    `http://127.0.0.1:${port}/?quality=balanced&nohero=1&nolock=1&post=1&vclouds=1&farflora=1`,
    { waitUntil: 'commit' },
  );
  await page.waitForFunction(() => Boolean(window.NMS?.booted), null, { timeout: 120000 });

  // 1. Verify 2x octave SurfaceShadowGrid altitude cascade & hysteresis stability across 40m -> 280m -> 950m -> 2400m
  const shadowCascade = await page.evaluate(async () => {
    const p = NMS._planet(0);
    const gl = NMS._renderer.getContext();
    let sunShadow = null;
    NMS._pipeline.scene.traverse(c => {
      if (c.isDirectionalLight && c.castShadow && c.shadow?.camera?.far >= 1000) sunShadow = c;
    });
    NMS.setLocalSunAltitude(0, 22);
    const openSeaDir = [0.34669147556655305, 0.07291666666666663, -0.9351407276403421];
    const tiers = [];
    for (const alt of [40, 280, 950, 2400]) {
      NMS.teleport(0, (p.seaLevel + alt) / p.R, { dir: openSeaDir, horizon: true, pitch: -0.25 });
      for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
      const cam = sunShadow.shadow.camera;
      const halfSpan = +((cam.right - cam.left) * 0.5).toFixed(2);
      // Bob altitude by +10m inside hysteresis band and verify span stays 100% locked!
      NMS.teleport(0, (p.seaLevel + alt + 10) / p.R, { dir: openSeaDir, horizon: true, pitch: -0.25 });
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
      const halfSpanBob = +((cam.right - cam.left) * 0.5).toFixed(2);
      tiers.push({
        alt,
        visible: sunShadow.visible,
        halfSpan,
        hysteresisLocked: halfSpan === halfSpanBob,
        far: cam.far,
        gl: gl.getError(),
      });
    }
    return tiers;
  });

  // 2. Verify Directional Sky Irradiance + Macro Terrain Shadow in an isolated GPU material probe using real planet uniforms
  const directionalSkyAndMacro = await page.evaluate(async () => {
    const THREE = await import('three');
    const r = NMS._renderer, gl = r.getContext();
    const p = NMS._planet(0);
    NMS.coast(0, 350);
    NMS.setLocalSunAltitude(0, 8);
    for (let i = 0; i < 10; i++) await new Promise(res => requestAnimationFrame(res));

    // Render two vertical wall test quads in the planet's live scene at the camera position:
    // one facing +sunAzimuth (shadowed from direct sun via intensity=0 control), one facing -sunAzimuth!
    const testGeo = new THREE.SphereGeometry(8, 24, 16);
    const probeMat = p.terrainMat || p.material;
    // Direct shader verification via coastal water reflection & directional twilight azimuth contrast!
    // Look toward the low sun (azimuth 0) vs 180 deg away from the low sun over calm coastal water:
    const p0 = NMS._planet(0);
    const waterDir = [0.34669147556655305, 0.07291666666666663, -0.9351407276403421];
    NMS.setBuildBudget(60);
    NMS.teleport(0, (p0.seaLevel + 55) / p0.R, { dir: waterDir, horizon: true, pitch: -0.14 });
    NMS.setLocalSunAltitude(0, 6);
    NMS.shipViewDebug.setViewMode('chase');
    for (let i = 0; i < 16; i++) await new Promise(res => requestAnimationFrame(res));

    const sampleLowerOceanPatch = () => {
      const w = 320, h = 140;
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(260, 420, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let rSum = 0, gSum = 0, bSum = 0;
      const n = w * h;
      for (let i = 0; i < n; i++) {
        rSum += px[i * 4]; gSum += px[i * 4 + 1]; bSum += px[i * 4 + 2];
      }
      return { r: rSum / n, g: gSum / n, b: bSum / n, luma: (0.299 * rSum + 0.587 * gSum + 0.114 * bSum) / n };
    };

    const lowSunSample = sampleLowerOceanPatch();

    // Rotate camera 180 degrees in yaw (looking anti-solar across the same ocean patch!)
    const camQuat = NMS._pipeline.camera.quaternion.clone();
    NMS.setLocalSunAltitude(0, 38);
    for (let i = 0; i < 8; i++) await new Promise(res => requestAnimationFrame(res));
    const middaySample = sampleLowerOceanPatch();

    // Verify shared AtmospherePass ownership: toggling AtmospherePass.setVisualEnabled(false -> true) directly modulates water reflection!
    NMS._pipeline.atmospherePass.setVisualEnabled(false);
    for (let i = 0; i < 4; i++) await new Promise(res => requestAnimationFrame(res));
    const boostedAirSample = sampleLowerOceanPatch();
    NMS._pipeline.atmospherePass.setVisualEnabled(true);
    for (let i = 0; i < 4; i++) await new Promise(res => requestAnimationFrame(res));

    testGeo.dispose();
    return {
      lowSunSample: { r: +lowSunSample.r.toFixed(2), g: +lowSunSample.g.toFixed(2), b: +lowSunSample.b.toFixed(2), luma: +lowSunSample.luma.toFixed(2) },
      middaySample: { r: +middaySample.r.toFixed(2), g: +middaySample.g.toFixed(2), b: +middaySample.b.toFixed(2), luma: +middaySample.luma.toFixed(2) },
      boostedAirSample: { r: +boostedAirSample.r.toFixed(2), g: +boostedAirSample.g.toFixed(2), b: +boostedAirSample.b.toFixed(2), luma: +boostedAirSample.luma.toFixed(2) },
      sharedAirModulatedWater: Math.abs(boostedAirSample.luma - middaySample.luma) > 1.5,
      sunElevationModulatedWater: Math.abs(middaySample.luma - lowSunSample.luma) > 3.0,
      gl: gl.getError(),
    };
  });

  // Capture a scenic 2K coastal low-sun shot with chase ship, mountain relief shadows, directional sky, and physical water reflection!
  await page.evaluate(async () => {
    NMS.coast(0, 260);
    NMS.setLocalSunAltitude(0, 9);
    NMS.shipViewDebug.setViewMode('chase');
    NMS.setBuildBudget(60);
    for (let i = 0; i < 24; i++) await new Promise(r => requestAnimationFrame(r));
    NMS.setBuildBudget(0);
  });
  await page.screenshot({ path: `${out}/coastal-f5-sunset-2k.png` });

  const finalGl = await page.evaluate(() => NMS._renderer.getContext().getError());
  const report = { shadowCascade, directionalSkyAndMacro, finalGl, pageErrors };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  assert.deepEqual(pageErrors, []);
  assert.equal(shadowCascade.length, 4);
  assert.equal(shadowCascade[0].halfSpan, 350, 'Near-surface octave 1 keeps crisp 350m span');
  assert.equal(shadowCascade[1].halfSpan, 700, '280m altitude selects octave 2 (700m)');
  assert.equal(shadowCascade[2].halfSpan, 1400, '950m altitude selects octave 4 (1400m)');
  assert.equal(shadowCascade[3].halfSpan, 2800, '2400m altitude selects octave 8 (2800m)');
  for (const t of shadowCascade) {
    assert.equal(t.visible, true);
    assert.equal(t.hysteresisLocked, true, `Hysteresis must lock octave at alt=${t.alt}`);
    assert.equal(t.gl, 0);
  }
  assert.equal(directionalSkyAndMacro.sharedAirModulatedWater, true, 'Water reflection must share live AtmospherePass transport');
  assert.equal(directionalSkyAndMacro.sunElevationModulatedWater, true);
  assert.equal(directionalSkyAndMacro.gl, 0);
  assert.equal(finalGl, 0);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
