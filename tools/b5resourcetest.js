import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__b5-resources', (r) => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__b5-resources`);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { AtmospherePass } = await import('/src/atmosphere-pass-webgl.js');
    const { VolumetricPass } = await import('/src/volumetric-pass-webgl.js');
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(16, 16);
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 1e8);
    const target = () => new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(16, 16, THREE.UnsignedIntType),
    });
    const a = target(), b = target();
    // Composer owns these attachments and releases them on context loss.
    renderer.domElement.addEventListener('webglcontextlost', () => { a.dispose(); b.dispose(); });
    renderer.setRenderTarget(a); renderer.clear(); renderer.setRenderTarget(b); renderer.clear();
    const baseline = renderer.info.memory.textures, counts = [];
    const stages = []; const check = (name) => stages.push({ name, error: renderer.getContext().getError() }); check("init");
    const pass = new AtmospherePass(camera);
    const bodies = Array.from({ length: 6 }, (_, i) => ({ R: 6000000 + i * 1000,
      atmosphere: { pressureBar: 0.5 + i * 0.2 }, atmoMesh: { visible: true },
      posUniv: new THREE.Vector3(), _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(0, 1, 0),
      worldOffsetToLocal: (v, out) => out.copy(v) }));
    for (let i = 0; i < 12; i++) {
      const body = bodies[i % bodies.length];
      pass.setActivePlanet(body, new THREE.Vector3(0, body.R + 1000, 0));
      pass.render(renderer, b, a);
      check(`handoff-${i}`);
      counts.push({ cache: pass.profileCache.size, textures: renderer.info.memory.textures - baseline });
    }
    check("before-loss");
    const beforeLoss = pass.activeCache.multiple;
    const restored = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Context restoration timeout')), 10000);
      renderer.domElement.addEventListener('webglcontextrestored', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    renderer.forceContextLoss();
    await new Promise((resolve) => setTimeout(resolve, 100));
    renderer.forceContextRestore(); await restored;
    check("restored");
    const invalidated = pass.activeCache.multiple === null && pass.material.uniforms.uMultipleEnabled.value === 0;
    renderer.setRenderTarget(a); renderer.clear();
    pass.render(renderer, b, a);
    check("rerender");
    const rebuilt = pass.activeCache.multiple !== beforeLoss;
    const data = new Uint16Array(32 * 32 * 4);
    renderer.readRenderTargetPixels(pass.activeCache.multiple, 0, 0, 32, 32, data);
    const values = Array.from(data, (x) => THREE.DataUtils.fromHalfFloat(x));
    const nonempty = values.some((v, i) => i % 4 !== 3 && v > 0.0001);
    const finite = values.every(Number.isFinite);
    check("readback");
    renderer.setRenderTarget(null); pass.dispose(); a.dispose(); b.dispose(); check("air-dispose");
    const afterAirDispose = renderer.info.memory.textures;
    const volume = new VolumetricPass(new THREE.Scene(), camera);
    volume.setSize(100, 100);
    for (const rt of [volume.current, volume.historyA, volume.historyB]) renderer.initRenderTarget(rt);
    check("volume-init");
    const volumeTextures = renderer.info.memory.textures;
    volume.dispose();
    const afterVolumeDispose = renderer.info.memory.textures;
    const glError = renderer.getContext().getError(); renderer.dispose();
    return { stages, baseline, counts, invalidated, rebuilt, nonempty, finite, afterAirDispose, volumeTextures, afterVolumeDispose, glError };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.ok(result.stages.every((s) => s.error === 0), JSON.stringify(result.stages));
  assert.ok(result.counts.every((c) => c.cache <= 4 && c.textures <= 8));
  assert.deepEqual(result.counts.slice(3).map((c) => c.textures), Array(9).fill(8));
  assert.ok(result.invalidated && result.rebuilt && result.nonempty && result.finite);
  assert.equal(result.afterAirDispose, 0);
  assert.equal(result.volumeTextures, 5, 'three colour + two depth histories');
  assert.equal(result.afterVolumeDispose, 0);
  assert.equal(result.glError, 0);
  await mkdir('test-results/b5', { recursive: true });
  await writeFile('test-results/b5/resources.json', JSON.stringify({ fingerprint: await evidenceFingerprint('tools/b5resourcetest.js'), result, errors }, null, 2));
  console.log('PASS: bounded optical/multiple LUTs, context restoration and history depth disposal', result);
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
