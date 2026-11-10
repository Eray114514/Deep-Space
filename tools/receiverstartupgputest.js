// Cold production surface ownership and forecast-independent receiver startup.
// Freeze the constructor's published hour-zero field, not a later worker frame.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
const out = `test-results/receiver-startup/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/receiverstartupgputest.js');
const reference = execFileSync('git', ['show', '2ee34e1:src/cloud/cloud-surface-shadow-pass.js']);
await writeFile(`${out}/reference-cloud-surface-shadow-pass.js`, reference);
const { server, port } = await startServer(0);let browser;const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/receiver-startup.html*', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>' }));
  await page.route('**/src/cloud/receiver-startup-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: reference }));
  await page.goto(`http://127.0.0.1:${port}/receiver-startup.html?vclouds=1`);
  const result = await page.evaluate(async () => {
    const T = await import('three');
    const { Planet } = await import('/src/planet.js');
    const { CloudSurfaceShadowPass } = await import('/src/cloud/cloud-surface-shadow-pass.js');
    const { CloudSurfaceShadowPass: Original } = await import('/src/cloud/receiver-startup-reference.js');
    const { surfaceCloudOwner } = await import('/src/cloud/surface-clouds.js');
    const r = new T.WebGLRenderer({ canvas: document.querySelector('#fixture'), logarithmicDepthBuffer: true });
    r.setSize(64, 64);r.setClearColor(0x15202b, 1);
    const p = new Planet({ seed: 'receiver-startup-physical', name: 'Receiver fixture', posUniv: new T.Vector3(),
      type: 'lush', radius: 6e6, tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
    const terrain = p.terrainMaterial, water = p.liquidMat;
    const ownership = [terrain, water].filter(Boolean).map(m => ({ type: m.type, owner: surfaceCloudOwner(m) === p,
      cold: !m.userData.shader, lazy: !m.userData.surfaceMedium }));
    const scene = new T.Scene();scene.add(p.group);
    p.group.traverse(o => { if (o.isMesh) o.visible = o.material === terrain || o.material === water; });
    const direction = new T.Vector3(.35, .5, .8).normalize(), camera = new T.PerspectiveCamera(50, 1, .12, 1e8);
    camera.position.copy(direction).multiplyScalar(p.R * 1.35);camera.lookAt(0, 0, 0);camera.updateMatrixWorld(true);
    p.setStellarLights({ sources: [
      { id: 'a', direction: [.35, .7, .8], radius: 1e6, distance: 1e11, irradianceFraction: .65 },
      { id: 'b', direction: [-.4, .6, .7], radius: 1e6, distance: 2e11, irradianceFraction: .35 },
    ] });
    scene.add(new T.AmbientLight(0xffffff, .4));
    for (const v of [[.35, .7, .8], [-.4, .6, .7]]) { const light = new T.DirectionalLight(0xffffff, 1);light.position.set(...v);scene.add(light); }
    p.weatherStream = { ready: false, dispose() {} }; // No worker; the original published field remains immutable.
    p.volCloudMat.uniforms.uSunCacheReady.value = 0;
    const input = () => JSON.stringify([p.weatherHours, ...[p.cloudSpeciesTex, p.cloudWeatherHiTex].map(t =>
      [t.version, t.image.data.length, Array.from(t.image.data).reduce((sum, v, i) => sum + v * (1 + i % 17), 0)])]);
    const firstInput = input(), bindings = [];
    for (const m of [terrain, water].filter(Boolean)) {
      const draw = m.onBeforeRender;
      m.onBeforeRender = function (...args) {
        draw.apply(this, args);
        if (!bindings.some(row => row.type === m.type)) bindings.push({ type: m.type,
          beforeCompile: !m.userData.shader, screen: m.defines.SURFACE_CLOUD_SCREEN,
          enabled: m.userData.surfaceMedium.uSurfaceCloudEnabled.value,
          bands: m.userData.surfaceMedium.cloud_uSpeciesMap.value === p.cloudSpeciesTex });
      };
    }
    const opaque = new T.WebGLRenderTarget(64, 64, { type: T.HalfFloatType,
      depthTexture: new T.DepthTexture(64, 64, T.UnsignedIntType) });
    const color = new T.WebGLRenderTarget(64, 64, { type: T.HalfFloatType, depthBuffer: true });
    const current = new CloudSurfaceShadowPass(scene, camera, { scale: 1 }), old = new Original(scene, camera, { scale: 1 });
    const read = target => {
      const bytes = target.texture.type === T.FloatType ? new Float32Array(64 * 64 * 4) : new Uint16Array(64 * 64 * 4);
      r.setRenderTarget(target);r.readRenderTargetPixels(target, 0, 0, 64, 64, bytes);return bytes;
    };
    const changed = (a, b) => a.reduce((n, value, i) => n + (value !== b[i]), 0);
    old.render(r, opaque, p);const oldPendingRejected = !old.ready;
    // No active volume owner: discovery must work for a never-compiled remote material too.
    current.render(r, opaque, null);const initial = read(current.target);
    const currentPendingReady = current.ready && current.receiverIds.has(p);
    if (!currentPendingReady) throw Error('No cold discovered receiver: ' + JSON.stringify(ownership));
    r.setRenderTarget(color);r.render(scene, camera);const firstColor = read(color);
    p.weatherStream.ready = true;old.render(r, opaque, p);const referencePixels = read(old.target);
    r.setRenderTarget(color);r.render(scene, camera);const referenceColor = read(color);
    p.weatherStream.ready = false;current.render(r, opaque, null);const repeat = read(current.target);
    // The offscreen scene still uses the same 64×64 opaque attachment even
    // when the renderer's visible drawing buffer changes size.
    r.setSize(96, 80);
    current.render(r, opaque, null);
    const offscreen = { viewport: current.viewport.toArray(),
      target: [current.target.width, current.target.height], colorDifference: changed(initial, read(current.target)) };
    r.setSize(64, 64);
    r.setRenderTarget(null);r.render(scene, camera);
    const gl = r.getContext(), program = r.properties.get(current.material).currentProgram;
    const gpuCacheReady = gl.getUniform(program.program, gl.getUniformLocation(program.program, 'uSunCacheReady'));
    const occupied = [], transmission = [[], []];
    for (let i = 0; i < initial.length; i += 4) if (initial[i + 3] > .5) {
      occupied.push(i);for (let star = 0; star < 2; star++) transmission[star].push(initial[i + star]);
    }
    const result = { ownership, bindings, oldPendingRejected, currentPendingReady, inputUnchanged: input() === firstInput,
      weatherHours: p.weatherHours, hasWorker: !!p.weatherStream.worker, gpuCacheReady,
      occupied: occupied.length, transmission: transmission.map(values => ({ minimum: Math.min(...values), maximum: Math.max(...values) })),
      receiverDifference: changed(initial, referencePixels), repeatDifference: changed(initial, repeat), offscreen,
      colorDifference: changed(firstColor, referenceColor), finite: initial.every(Number.isFinite), gl: gl.getError(), lost: gl.isContextLost(),
      scope: 'Actual cold terrain/water materials, constructor production field, physical beams with cache disabled and no worker/time advancement. Old receiver is the pending negative control; forced old eligibility is the same-snapshot physical oracle. No full cloud volume or performance acceptance.' };
    current.dispose();old.dispose();opaque.dispose();color.dispose();p.dispose();return result;
  });
  await page.screenshot({ path: `${out}/fixture.png` });
  const after = await evidenceFingerprint('tools/receiverstartupgputest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);assert.equal(result.gl, 0);assert.equal(result.lost, false);
  assert.ok(result.ownership.length === 2 && result.ownership.every(x => x.owner && x.cold && x.lazy));
  assert.ok(result.bindings.length === 2 && result.bindings.every(x => x.beforeCompile && x.screen === 1 && x.enabled === 0 && x.bands));
  assert.ok(result.oldPendingRejected && result.currentPendingReady && result.inputUnchanged && result.finite);
  assert.equal(result.hasWorker, false);assert.equal(result.gpuCacheReady, 0);assert.ok(result.occupied > 100);
  assert.ok(result.transmission.every(x => x.minimum < .98 && x.minimum >= 0 && x.maximum <= 1));
  assert.equal(result.receiverDifference, 0);assert.equal(result.repeatDifference, 0);assert.equal(result.colorDifference, 0);
  assert.deepEqual(result.offscreen, { viewport: [64, 64], target: [64, 64], colorDifference: 0 });
  console.log(JSON.stringify({ out, result, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
