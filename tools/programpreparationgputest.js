import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
const out = `test-results/program-preparation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/programpreparationgputest.js');
const { server, port } = await startServer(0);let browser;const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/program-preparation.html', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><style>body{background:#14202b;color:white;font:18px sans-serif}canvas{width:384px;height:384px;image-rendering:pixelated}</style><p>Shared material: mesh + instancing + transparent double side</p><canvas id="fixture"></canvas>' }));
  await page.goto(`http://127.0.0.1:${port}/program-preparation.html`);
  const result = await page.evaluate(async () => {
    const T = await import('three'), { compilePrograms } = await import('/src/program-preparation.js');
    const make = (canvas = document.createElement('canvas')) => {
      const renderer = new T.WebGLRenderer({ canvas });renderer.setSize(96, 96);renderer.setClearColor(0x14202b, 1);
      const scene = new T.Scene(), camera = new T.PerspectiveCamera(45, 1, .1, 30);
      camera.position.set(0, 1, 7);camera.lookAt(0, 0, 0);camera.updateMatrixWorld(true);
      const geometry = new T.SphereGeometry(.8, 16, 12);
      const material = new T.MeshStandardMaterial({ color: 0x91b2d0, roughness: .4, metalness: .3,
        side: T.DoubleSide, transparent: true, opacity: .8 });
      const source = new T.Group();scene.add(source);
      const mesh = new T.Mesh(geometry, material);mesh.position.x = -1;source.add(mesh);
      const instances = new T.InstancedMesh(geometry, material, 1);
      instances.setMatrixAt(0, new T.Matrix4().makeTranslation(1, 0, 0));source.add(instances);
      const light = new T.DirectionalLight(0xffeed9, 3);light.position.set(2, 3, 4);scene.add(light, new T.AmbientLight(0x8bacdd, .7));
      const target = new T.WebGLRenderTarget(96, 96, { type: T.HalfFloatType });
      const read = (screen = true) => {
        renderer.setRenderTarget(target);renderer.render(scene, camera);
        const data = new Uint16Array(96 * 96 * 4);renderer.readRenderTargetPixels(target, 0, 0, 96, 96, data);
        if (screen) { renderer.setRenderTarget(null);renderer.render(scene, camera); }return data;
      };
      return { renderer, scene, source, target, camera, material, read, cleanup() { target.dispose();instances.dispose();geometry.dispose();material.dispose();renderer.dispose(); } };
    };
    const same = (a, b) => a.reduce((sum, value, i) => sum + (value !== b[i] ? 1 : 0), 0);
    const a = make(document.querySelector('#fixture'));
    await a.renderer.compileAsync(a.scene, a.camera);const original = a.read();
    await compilePrograms(a.renderer, a.scene, a.camera);const candidate = a.read();
    await a.renderer.compileAsync(a.scene, a.camera);const repeatOld = a.read();
    await compilePrograms(a.renderer, a.scene, a.camera);const repeatNew = a.read();
    const gl = a.renderer.getContext(), extension = gl.getExtension('KHR_parallel_shader_compile');
    const variants = a.renderer.properties.get(a.material).programs.size;
    const native = { differences: [same(original, candidate), same(original, repeatOld), same(original, repeatNew)],
      finite: [...original].every(value => (value & 0x7c00) !== 0x7c00),
      distinctRed: new Set([...original].filter((_, i) => i % 4 === 0)).size, variants, gl: gl.getError(), khr: Boolean(extension) };
    const controls = [];
    for (const kind of ['material-disposed', 'aborted', 'registry-reset', 'timeout', 'context-lost']) {
      const f = make(), r = f.renderer, context = r.getContext(), ext = context.getExtension('KHR_parallel_shader_compile');
      const controller = new AbortController();
      const pending = compilePrograms(r, f.scene, f.camera, null, { signal: controller.signal, timeoutMs: kind === 'timeout' ? 1 : 10000 });
      const observed = pending.then(() => ({ resolved: true }), error => ({ code: error.code, message: error.message }));
      let polls = 0;const query = context.getProgramParameter;
      context.getProgramParameter = function(program, parameter) {
        if (parameter === ext?.COMPLETION_STATUS_KHR) polls++;
        return query.call(this, program, parameter);
      };
      if (kind === 'material-disposed') f.material.dispose();
      if (kind === 'aborted') controller.abort();
      if (kind === 'registry-reset') r.dispose();
      const clearBefore = r.getClearColor(new T.Color()).getHex();
      if (kind === 'context-lost') r.forceContextLoss();
      const outcome = await observed;
      context.getProgramParameter = query;
      const record = { kind, ...outcome, polls, gl: kind === 'context-lost' ? null : context.getError() };
      if (kind === 'context-lost') {
        // Actual WEBGL_lose_context loss/restore on this isolated renderer. Old
        // work must stay rejected; a new task must capture the rebuilt registry.
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(Error('Context restore deadline')), 6000);
          r.domElement.addEventListener('webglcontextrestored', () => { clearTimeout(deadline);resolve(); }, { once: true });
          setTimeout(() => r.forceContextRestore(), 100);
        });
        record.clearBefore = clearBefore;record.clearAfterRestore = r.getClearColor(new T.Color()).getHex();
        // The fixture owns its authored clear color; the vendor reconstructs
        // WebGLBackground on restore rather than preserving setClearColor.
        r.setClearColor(clearBefore, 1);
        await compilePrograms(r, f.scene, f.camera);
        const restored = f.read();record.restoreDifference = same(original, restored);
        record.restored = !context.isContextLost();record.gl = context.getError();
      }
      controls.push(record);f.cleanup();
    }
    const lighting = [], lightingPixels = [];
    for (const useTargetScene of [false, true]) {
      const f = make(), r = f.renderer;r.setRenderTarget(f.target);
      await compilePrograms(r, f.source, f.camera, useTargetScene ? f.scene : null);
      const prepared = new Set(r.properties.get(f.material).programs.values());
      lightingPixels.push(f.read(false));
      const drawn = [...r.properties.get(f.material).programs.values()];
      lighting.push({ useTargetScene, prepared: prepared.size, addedOnDraw: drawn.filter(p => !prepared.has(p)).length,
        gl: r.getContext().getError() });f.cleanup();
    }
    const lightingDifference = same(lightingPixels[0], lightingPixels[1]);
    // Force only the renderer's extension capability to the supported no-KHR
    // contract, without injecting readiness values or changing shader inputs.
    const n = make(), has = n.renderer.extensions.has;
    n.renderer.extensions.has = name => name === 'KHR_parallel_shader_compile' ? false : has.call(n.renderer.extensions, name);
    await compilePrograms(n.renderer, n.scene, n.camera);const noKhr = n.read();
    const noKhrDifference = same(original, noKhr);n.cleanup();
    const rendererName = gl.getParameter(gl.RENDERER);a.cleanup();
    return { native, controls, lighting, lightingDifference, noKhrDifference, rendererName,
      scope: 'Hardware WebGL2 shared mesh/instanced transparent DoubleSide material, native RGBA16F old/new repeats, real disposal/abort/registry/deadline/loss and isolated context restoration. No full production draw warm-up or cold/performance acceptance.' };
  });
  await page.screenshot({ path: `${out}/fixture.png` });
  const after = await evidenceFingerprint('tools/programpreparationgputest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);
  assert.ok(result.native.finite && result.native.variants >= 4 && result.native.distinctRed > 100);
  assert.deepEqual(result.native.differences, [0, 0, 0]);assert.equal(result.native.gl, 0);assert.equal(result.noKhrDifference, 0);
  assert.ok(result.lighting[0].addedOnDraw > 0);assert.equal(result.lighting[1].addedOnDraw, 0);
  assert.ok(result.lighting.every(row => row.gl === 0));assert.equal(result.lightingDifference, 0);
  for (const control of result.controls) {
    assert.equal(control.code, control.kind);assert.equal(control.polls, 0);assert.equal(control.gl, 0);
    if (control.kind === 'context-lost') { assert.equal(control.restored, true);assert.equal(control.restoreDifference, 0); }
  }
  console.log(JSON.stringify({ out, result, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
