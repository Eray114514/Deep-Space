// Paired warm cost of the actual resolve shaders, separate from cloud density
// and compilation. The added quality work has an explicit absolute GPU budget.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = `test-results/volume-filter-performance/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/verifier.js`, await readFile('tools/volumehistoryfilterperftest.js'));
const before = await evidenceFingerprint('tools/volumehistoryfilterperftest.js');
const reference = execFileSync('git', ['show', '9ca1a18:src/volumetric-pass-webgl.js']);
await writeFile(`${out}/reference-volumetric-pass-webgl.js`, reference);
const { server, port } = await startServer(0);
let browser;
const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/tools/volume-filter-perf.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.route('**/src/volume-filter-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: reference }));
  await page.goto(`http://127.0.0.1:${port}/tools/volume-filter-perf.html`);
  const result = await page.evaluate(async () => {
    const T = await import('three');
    const { VolumetricPass: Current } = await import('/src/volumetric-pass-webgl.js');
    const { VolumetricPass: Original } = await import('/src/volume-filter-reference.js');
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const { QUALITY_PROFILES } = await import('/src/graphics-settings.js');
    const renderer = new T.WebGLRenderer();renderer.debug.checkShaderErrors = true;
    const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) throw Error('Actual warm GPU timer is required');
    const camera = new T.PerspectiveCamera(60, 1, .12, 1.2e11);camera.updateMatrixWorld(true);
    const passes = { original: new Original(new T.Scene(), camera), current: new Current(new T.Scene(), camera) };
    const paint = new T.ShaderMaterial({ uniforms: { delta: { value: 0 }, depth: { value: 1 } },
      depthTest: true, depthFunc: T.AlwaysDepth, depthWrite: true,
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'varying vec2 vUv;uniform float delta,depth;void main(){gl_FragColor=vec4(vUv.x*.3-.15+delta,.2+vUv.y*.3,.3,.5);gl_FragDepth=depth;}' });
    const paintQuad = new FullScreenQuad(paint);
    const records = [];
    const cases = [['performance', 1280, 720, .3], ['balanced', 1280, 720, .3],
      ['balanced', 2560, 1440, .5], ['ultra', 2560, 1440, 1]];
    const stats = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { count: values.length, median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
        p95: sorted[Math.ceil(sorted.length * .95) - 1], minimum: sorted[0], maximum: sorted.at(-1) };
    };
    for (const [quality, screenWidth, screenHeight, addedBudgetMs] of cases) {
      const profile = QUALITY_PROFILES[quality];
      const width = Math.round(screenWidth * profile.dprTarget * profile.volumeScale);
      const height = Math.round(screenHeight * profile.dprTarget * profile.volumeScale);
      const depthWidth = Math.round(screenWidth * profile.dprTarget), depthHeight = Math.round(screenHeight * profile.dprTarget);
      const target = (w = width, h = height, depth = true) => new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType,
        minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: depth,
        ...(depth ? { depthTexture: new T.DepthTexture(w, h, T.UnsignedIntType) } : {}) });
      const current = target(width, height, false), history = target(), output = target(), opaque = target(depthWidth, depthHeight);
      for (const [mode, depth, stationary] of [['moving-sky', 1, false], ['stationary-sky', 1, true],
        ['stationary-opaque', .5, true], ['moving-opaque', .5, false]]) {
        paint.uniforms.depth.value = depth;
        for (const [rt, delta] of [[current, 0], [history, .002], [opaque, 0]]) {
          paint.uniforms.delta.value = delta;renderer.setRenderTarget(rt);renderer.clear(true, true, false);paintQuad.render(renderer);
        }
        for (const pass of Object.values(passes)) {
          const u = pass.resolveMaterial.uniforms;
          u.tCurrent.value = current.texture;u.tHistory.value = history.texture;
          u.tSceneDepth.value = opaque.depthTexture;u.tHistoryDepth.value = history.depthTexture;
          u.uHistoryValid.value = 1;if (u.uDepthReady) u.uDepthReady.value = 1;
          if (u.uStationaryHistory) u.uStationaryHistory.value = stationary ? 1 : 0;
          // Exercise the still-supported opaque micro-motion branch as well:
          // all four depth taps plus the non-sky neighborhood distance test.
          u.uMotion.value = mode === 'moving-opaque' ? .0005 : 0;
          u.uRadius.value = 10;u.uCenter.value.set(0, 0, 0);u.uNavDelta.value.set(0, 0, 0);
          u.uCurrentToPrevious.value.identity();u.uCameraFar.value = camera.far;
          u.uInvProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);
          u.uPrevViewProjection.value.makeTranslation(stationary ? 0 : .5 / width, stationary ? 0 : .5 / height, 0).multiply(camera.projectionMatrix);
        }
        renderer.setRenderTarget(output);
        const measure = async name => {
          if (gl.getParameter(ext.GPU_DISJOINT_EXT)) throw Error('GPU timer disjoint before draw');
          const query = gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          const start = performance.now();passes[name].resolveQuad.render(renderer);const cpuMs = performance.now() - start;
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          const deadline = performance.now() + 10000;
          while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
            if (performance.now() > deadline) throw Error('GPU query deadline');
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          if (gl.getParameter(ext.GPU_DISJOINT_EXT)) throw Error('GPU timer disjoint after draw');
          const gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;gl.deleteQuery(query);
          return { name, cpuMs, gpuMs };
        };
        const warmup = [];
        for (let round = 0; round < 3; round++) for (const name of ['original', 'current']) warmup.push(await measure(name));
        const samples = [];
        for (let round = 0; round < 64; round++) for (const name of round % 2 ? ['current', 'original'] : ['original', 'current']) {
          samples.push({ round, ...await measure(name) });
        }
        const old = stats(samples.filter(sample => sample.name === 'original').map(sample => sample.gpuMs));
        const next = stats(samples.filter(sample => sample.name === 'current').map(sample => sample.gpuMs));
        records.push({ quality, screenWidth, screenHeight, dpr: profile.dprTarget, volumeScale: profile.volumeScale,
          width, height, depthWidth, depthHeight, mode, original: old, current: next, addedMedianMs: next.median - old.median,
          addedP95Ms: next.p95 - old.p95, addedBudgetMs, warmup, samples });
      }
      current.dispose();history.dispose();output.dispose();opaque.dispose();
    }
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const result = { records, gl: gl.getError(), lost: gl.isContextLost(),
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      scope: 'Actual resolve only, prescribed signed HDR gradient, low-resolution history depth and borrowed full-resolution opaque depth at the authored DPR, with 64 alternating warm samples per implementation/case/mode. Added GPU budgets .3/.5/1 ms are local quality-work limits, not whole-frame FPS acceptance or a speedup claim. Warmup and first submissions are retained but excluded. Earlier 16-sample audit had two maximum/p95 overruns; both it and the 64-sample same-resolution-depth control are retained separately. This final tool uses the production depth grid; maxima and all raw samples remain reported.' };
    for (const pass of Object.values(passes)) pass.dispose();paint.dispose();paintQuad.dispose();
    return result;
  });
  const after = await evidenceFingerprint('tools/volumehistoryfilterperftest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);assert.equal(result.gl, 0);assert.equal(result.lost, false);
  assert.equal(result.records.length, 16);
  assert.ok(result.records.every(row => row.original.count === 64 && row.current.count === 64));
  assert.ok(result.records.every(row => row.addedMedianMs <= row.addedBudgetMs && row.addedP95Ms <= row.addedBudgetMs), JSON.stringify(result.records.map(({ samples, warmup, ...row }) => row)));
  console.log(JSON.stringify({ out, passed: true, records: result.records.map(row => ({ quality: row.quality, size: [row.width, row.height], mode: row.mode, oldMs: row.original.median, newMs: row.current.median, addedMs: row.addedMedianMs })) }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, error: String(error) }, null, 2));throw error;
} finally {
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
