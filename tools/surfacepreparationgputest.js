// Separate framebuffer, receiver-screen and shadow keys. No cloud kernel edit.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
const out = `test-results/surface-preparation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/surfacepreparationgputest.js');
const { server, port } = await startServer(0);let browser;const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/surface-preparation.html*', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>' }));
  await page.goto(`http://127.0.0.1:${port}/surface-preparation.html?vclouds=1`);
  const result = await page.evaluate(async () => {
    const T = await import('three');
    const { Planet } = await import('/src/planet.js');
    const { createGameRenderer } = await import('/src/renderer-runtime.js');
    const { compilePrograms } = await import('/src/program-preparation.js');
    const { withSurfaceWarmupVariant } = await import('/src/render-prewarm.js');
    const { createSurfaceWarmupScene } = await import('/src/surface-warmup.js');
    const { renderer: r } = await createGameRenderer({}, { canvas: document.querySelector('#fixture'), logarithmicDepthBuffer: true });
    r.setSize(64, 64);r.setClearColor(0x15202b, 1);r.shadowMap.enabled = true;
    r.toneMapping = T.ACESFilmicToneMapping;
    const p = new Planet({ seed: 'receiver-startup-physical', name: 'Surface preparation', posUniv: new T.Vector3(),
      type: 'lush', radius: 6e6, tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
    // Constructor-published hour-zero bands, no worker or advancing weather.
    const materials = [p.terrainMaterial, p.liquidMat].filter(Boolean);
    const scene = new T.Scene(), group = new T.Group();scene.add(group);
    const camera = new T.PerspectiveCamera(50, 1, .12, 1e8), direction = new T.Vector3(.35, .5, .8).normalize();
    camera.position.copy(direction).multiplyScalar(p.R * 1.35);camera.lookAt(0, 0, 0);camera.updateMatrixWorld(true);
    const sources = [];
    p.group.traverse(mesh => { if (mesh.isMesh && materials.includes(mesh.material)) sources.push(mesh); });
    for (const mesh of sources) {
      const copy = mesh.clone(false);copy.geometry = mesh.geometry.clone();copy.visible = true;copy.frustumCulled = false;
      copy.castShadow = true;copy.receiveShadow = true;group.add(copy);
    }
    const sun = new T.DirectionalLight(0xffeed9, 3);sun.position.set(0, 4e6, 7e6);sun.castShadow = true;sun.shadow.mapSize.set(2, 2);
    scene.add(sun, new T.AmbientLight(0x8bacdd, .7));
    const target = new T.WebGLRenderTarget(64, 64, { type: T.HalfFloatType });
    const pixels = [], rows = [];
    const programs = () => new Set(materials.flatMap(m => [...(r.properties.get(m).programs?.values() || [])]));
    const prepare = async ({ name, hdr, screen }) => {
      r.setRenderTarget(hdr ? target : null);
      let pending;
      try {
        pending = screen ? withSurfaceWarmupVariant(group, () => compilePrograms(r, group, camera, scene))
          : compilePrograms(r, group, camera, scene);
      } finally { r.setRenderTarget(null); }
      await pending;
      const prepared = programs(), start = performance.now();
      const warmup = createSurfaceWarmupScene(scene, group, camera, sun);
      try {
        r.setRenderTarget(target);
        withSurfaceWarmupVariant(group, () => r.render(warmup.scene, camera));
      } finally { warmup.dispose(); }
      const native = new Uint16Array(64 * 64 * 4);r.readRenderTargetPixels(target, 0, 0, 64, 64, native);
      pixels.push(native);
      const drawn = programs();rows.push({ name, hdr, screen, prepared: prepared.size,
        addedOnDraw: [...drawn].filter(program => !prepared.has(program)).length,
        reflectionWallMs: performance.now() - start, error: r.getContext().getError(),
        sourceScreen: materials.map(m => m.defines?.SURFACE_CLOUD_SCREEN ?? null) });
    };
    // Clear only these test materials' program leases between cold controls.
    for (const control of [{ name: 'original', hdr: false, screen: false },
      { name: 'target-only', hdr: true, screen: false }, { name: 'screen-only', hdr: false, screen: true },
      { name: 'target-and-screen', hdr: true, screen: true }]) {
      for (const m of materials) { m.dispose();m.defines ||= {};delete m.defines.SURFACE_CLOUD_SCREEN;m.needsUpdate = true; }
      await prepare(control);
    }
    const retained = programs();sun.visible = false;r.setRenderTarget(target);
    await withSurfaceWarmupVariant(group, () => compilePrograms(r, group, camera, scene));
    const shadowOffAdded = [...programs()].filter(program => !retained.has(program)).length;
    sun.visible = true;
    const difference = (a, b) => a.reduce((sum, value, index) => sum + Number(value !== b[index]), 0);
    const final = pixels.at(-1);
    const finite = [...final].every(value => Number.isFinite(T.DataUtils.fromHalfFloat(value)));
    const distinctRed = new Set(final.filter((_value, i) => i % 4 === 0)).size;
    r.clear();const clear = new Uint16Array(64 * 64 * 4);r.readRenderTargetPixels(target, 0, 0, 64, 64, clear);
    const clearDifferences = difference(clear, final);
    // Show the tested HDR result with the ordinary display transform.
    r.setRenderTarget(null);withSurfaceWarmupVariant(group, () => r.render(scene, camera));
    for (const copy of [...group.children]) copy.geometry.dispose();
    group.clear();target.dispose();sun.shadow.dispose();p.dispose();
    await new Promise(resolve => setTimeout(resolve, 100));
    const retirement = r.programRetirement.snapshot(), gl = r.getContext().getError();r.dispose();
    return { rows, differences: pixels.slice(0, -1).map(value => difference(value, final)),
      finite, distinctRed, clearDifferences, shadowOffAdded, retirement, gl,
      scope: 'Real constructor-published terrain/water and material hooks; same HDR draw, SCREEN1 depth-preparation mode. Shadow-off remains an independent family; not all startup programs, cloud lighting or whole-page speed acceptance.' };
  });
  await page.screenshot({ path: `${out}/fixture.png` });
  const after = await evidenceFingerprint('tools/surfacepreparationgputest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);
  assert.ok(result.rows.slice(0, -1).every(row => row.addedOnDraw > 0));
  assert.equal(result.rows.at(-1).addedOnDraw, 0);assert.ok(result.rows.every(row => row.error === 0));
  assert.deepEqual(result.differences, [0, 0, 0]);assert.ok(result.finite && result.distinctRed > 16 && result.clearDifferences > 100);
  assert.ok(result.shadowOffAdded > 0);assert.equal(result.gl, 0);assert.deepEqual(result.retirement.faults, []);
  console.log(JSON.stringify({ out, result, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
