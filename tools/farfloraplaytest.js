import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

// Targeted production integration, not a cloud/weather or performance gate.
// Disable volume clouds while their implementation is being worked on separately.
const out = process.env.FAR_FLORA_OUT || 'test-results/far-flora-player';
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/farfloraplaytest.js');
const { server, port } = await startServer(0);
let browser;
const errors = [];
try {
  browser = process.env.FAR_FLORA_HARDWARE === '1'
    ? await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined })
    : await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const url = `http://127.0.0.1:${port}/?nolock=1&nohero=1&freeze=1&time=9.5`
    + '&scene=surfaceflight&planet=0&bias=meadow&alt=400&quality=balanced'
    + '&farflora=1&vclouds=0&post=1&buildms=35';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 150000 });
  console.log('Booted; streaming real far-flora ring.');
  await page.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    NMS.setLocalSunAltitude(0, 35);
    NMS.lookPitch(-20);
  });
  await page.waitForFunction(() => NMS._ff.pending() === 0 && NMS._ff.debugStats().instances > 1000,
    null, { timeout: 120000 });
  await page.waitForTimeout(2000);
  const state = await page.evaluate(() => {
    const ff = NMS._ff, gl = NMS._renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const jobs = [...ff.targetKeys].map(key => ff.createTileJob(ff.planet, key));
    return { radiusMeters: ff.planet.R, anchor: ff.anchorK, metrics: ff.debugStats(),
      maxShellErrorTiles: Math.max(...jobs.map(j => Math.abs(Math.hypot(j.qx, j.qy, j.qz) - j.Q))),
      maxAnchorDistanceTiles: Math.max(...jobs.map(j => Math.hypot(
        j.qx - ff.anchorK[0], j.qy - ff.anchorK[1], j.qz - ff.anchorK[2]))),
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webglError: gl.getError(), stats: NMS.stats() };
  });
  await writeFile(`${out}/state.json`, JSON.stringify({ state, errors }, null, 2));
  console.log(JSON.stringify({ radius: state.radiusMeters, anchor: state.anchor, farFlora: state.metrics,
    webglError: state.webglError, errors }));
  assert.ok(state.radiusMeters > 524288, 'Use a real planet exceeding the old tile-key domain.');
  assert.ok(state.maxShellErrorTiles <= 0.710001);
  assert.ok(state.maxAnchorDistanceTiles < 7);

  // Render OFF/ON/OFF within one animation callback: camera, geometry, sun,
  // wind and uniforms cannot advance between the three attribution captures.
  const captures = await page.evaluate(() => new Promise(resolve => {
    const pipeline = NMS._pipeline, renderer = NMS._renderer, ff = NMS._ff;
    const original = pipeline.render;
    pipeline.render = function (...args) {
      pipeline.render = original;
      const visibility = ff.meshes.map(mesh => mesh.visible);
      const exposure = renderer.toneMappingExposure;
      const gradeTime = pipeline.grade?.uniforms.uTime;
      const time = gradeTime?.value;
      if (gradeTime) gradeTime.value = 0;
      const capture = visible => {
        ff.meshes.forEach(mesh => { mesh.visible = visible; });
        renderer.toneMappingExposure = exposure;
        original.apply(this, args);
        return { image: renderer.domElement.toDataURL('image/png'),
          webglError: renderer.getContext().getError() };
      };
      try {
        const off = capture(false), on = capture(true), offAgain = capture(false);
        resolve({ off, on, offAgain });
      } finally {
        ff.meshes.forEach((mesh, index) => { mesh.visible = visibility[index]; });
        if (gradeTime) gradeTime.value = time;
        renderer.toneMappingExposure = exposure;
        original.apply(this, args);
      }
    };
  }));
  const images = {};
  for (const [name, capture] of Object.entries(captures)) {
    const bytes = Buffer.from(capture.image.split(',')[1], 'base64');
    images[name] = PNG.sync.read(bytes);
    await writeFile(`${out}/${name}.png`, bytes);
  }
  const difference = (a, b) => {
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    let pixels = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.max(...[0, 1, 2].map(c => Math.abs(a.data[i + c] - b.data[i + c]))) > 3) pixels++;
    }
    return pixels;
  };
  const changedPixels = difference(images.off, images.on);
  const repeatPixels = difference(images.off, images.offAgain);
  const captureErrors = Object.fromEntries(Object.entries(captures).map(([name, capture]) => [name, capture.webglError]));
  await writeFile(`${out}/capture.json`, JSON.stringify({ changedPixels, repeatPixels, captureErrors }, null, 2));
  console.log(JSON.stringify({ changedPixels, repeatPixels, captureErrors }));
  // Separate the actual far-flora shader/buffers from errors elsewhere in the
  // in-progress production scene. Preserve parents and world transforms.
  const isolated = await page.evaluate(() => {
    const T = NMS._THREE, renderer = NMS._renderer, gl = renderer.getContext();
    const meshes = NMS._ff.meshes;
    const parents = meshes.map(mesh => mesh.parent);
    const visibility = meshes.map(mesh => mesh.visible);
    const scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 2));
    parents[0].updateWorldMatrix(true, false);
    const group = new T.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(parents[0].matrixWorld);
    scene.add(group);
    const target = new T.WebGLRenderTarget(640, 360);
    const previous = renderer.getRenderTarget();
    const clearColor = renderer.getClearColor(new T.Color()), clearAlpha = renderer.getClearAlpha();
    const pixels = new Uint8Array(640 * 360 * 4);
    gl.getError();
    try {
      meshes.forEach(mesh => { group.add(mesh); mesh.visible = true; });
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(scene, NMS._internals.camera);
      renderer.readRenderTargetPixels(target, 0, 0, 640, 360, pixels);
      let litPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 3) litPixels++;
      }
      return { webglError: gl.getError(), litPixels, instances: meshes.map(mesh => mesh.count) };
    } finally {
      meshes.forEach((mesh, index) => { parents[index].add(mesh); mesh.visible = visibility[index]; });
      renderer.setRenderTarget(previous);
      renderer.setClearColor(clearColor, clearAlpha);
      target.dispose();
    }
  });
  console.log(JSON.stringify({ isolatedFarFlora: isolated }));
  // Capture the active player tab before a second boot backgrounds it.
  await page.screenshot({ path: `${out}/player.png` });

  // A second boot with far flora disabled establishes whether the whole-scene
  // error already occurs without constructing any proxy-tree mesh.
  const baselinePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await baselinePage.goto(url.replace('farflora=1', 'farflora=0'), { waitUntil: 'domcontentloaded' });
  await baselinePage.waitForFunction(() => window.NMS?.booted, null, { timeout: 150000 });
  await baselinePage.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    NMS.setLocalSunAltitude(0, 35);
    NMS.lookPitch(-20);
    NMS._renderer.getContext().getError();
  });
  await baselinePage.waitForTimeout(2000);
  const baseline = await baselinePage.evaluate(() => ({
    farFloraMeshes: NMS._ff.meshes?.length || 0,
    webglError: NMS._renderer.getContext().getError(),
  }));
  await baselinePage.close();
  console.log(JSON.stringify({ withoutFarFlora: baseline }));
  const finalFingerprint = await evidenceFingerprint('tools/farfloraplaytest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ fingerprint,
    stableSource: fingerprint.sourceDigest === finalFingerprint.sourceDigest,
    finalSourceDigest: finalFingerprint.sourceDigest, state, changedPixels, repeatPixels,
    captureErrors, isolated, baseline, errors,
    scope: '1280x720 Balanced, normal HUD/post, volume clouds disabled; not performance acceptance' }, null, 2));
  assert.equal(isolated.webglError, 0, 'Far-flora materials and uploaded instances must render without GL errors.');
  assert.ok(isolated.litPixels > 100, 'Actual far-flora instances must render in isolation.');
  assert.ok(changedPixels > 100, 'Restored trees must contribute visible pixels in the real pipeline.');
  assert.ok(repeatPixels < changedPixels * 0.05,
    'Capture drift must be small enough to attribute the visible change to far flora.');
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log('PASS: isolated production far-flora shader/buffers and player-image contribution.');
  assert.ok(Object.values(captureErrors).every(error => error === 0),
    `Full player render has WebGL errors; no-far-flora baseline error=${baseline.webglError}. See ${out}/report.json.`);
  console.log(`PASS: production far trees visible (${changedPixels} changed pixels, ${repeatPixels} repeat drift), no new attribution-render errors; ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
