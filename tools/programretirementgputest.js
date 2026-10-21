import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
const out = `test-results/program-retirement-gpu/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });const before = await evidenceFingerprint('tools/programretirementgputest.js');
const { server, port } = await startServer(0);let browser;const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage();page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' || /GL_INVALID_/.test(m.text())) errors.push(m.text()); });
  await page.route('**/retirement-gpu.html', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><canvas id="fixture"></canvas>' }));
  await page.goto(`http://127.0.0.1:${port}/retirement-gpu.html`);
  const result = await page.evaluate(async () => {
    const T = await import('three'), { createGameRenderer } = await import('/src/renderer-runtime.js');
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const { OwnedScreenTriangle } = await import('/src/owned-screen-triangle.js');
    const { renderer: r } = await createGameRenderer({ reason: 'retirement-fixture' }, { canvas: document.querySelector('canvas') });
    r.setSize(64, 64);const gl = r.getContext(), service = r.programRetirement;
    const material = new T.ShaderMaterial({ vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'varying vec2 vUv;void main(){gl_FragColor=vec4(vUv.x*2.0,vUv.y*.7,-vUv.x*.25,1.0);}', depthTest: false, depthWrite: false });
    const old = new FullScreenQuad(material), owned = new OwnedScreenTriangle(material), target = new T.WebGLRenderTarget(64, 64, { type: T.HalfFloatType });
    const read = quad => { r.setRenderTarget(target);quad.render(r);const bytes = new Uint16Array(64 * 64 * 4);r.readRenderTargetPixels(target, 0, 0, 64, 64, bytes);return bytes; };
    const a = read(old), b = read(owned), differences = a.reduce((sum, v, i) => sum + (v !== b[i] ? 1 : 0), 0);
    const makeProgram = () => {
      const p = gl.createProgram(), v = gl.createShader(gl.VERTEX_SHADER), f = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(v, '#version 300 es\nvoid main(){gl_Position=vec4(0,0,0,1);}');
      gl.shaderSource(f, '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1);}');
      gl.compileShader(v);gl.compileShader(f);gl.attachShader(p, v);gl.attachShader(p, f);gl.linkProgram(p);
      gl.deleteShader(v);gl.deleteShader(f);return p;
    };
    r.setRenderTarget(null);gl.deleteProgram(makeProgram());const queuedBeforeLoss = service.snapshot().pending;
    const restored = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Restore deadline')), 6000);
      r.domElement.addEventListener('webglcontextrestored', () => { clearTimeout(timeout);resolve(); }, { once: true });
    });
    r.forceContextLoss();await new Promise(resolve => setTimeout(resolve, 100));
    const lost = service.snapshot();
    // Match production's context-lost cleanup: detach the old context's buffer,
    // target and material listeners while native deletion is still a no-op.
    // Their CPU objects remain reusable after restoration.
    old.dispose();owned.dispose();target.dispose();material.dispose();
    r.forceContextRestore();await restored;
    const c = read(owned), restoreDifference = a.reduce((sum, v, i) => sum + (v !== c[i] ? 1 : 0), 0);
    const rawCreate = gl.createProgram;gl.deleteProgram(makeProgram());
    old.dispose();owned.dispose();target.dispose();material.dispose();r.dispose();
    const hooksRestored = gl.createProgram !== rawCreate;
    const start = performance.now();while (service.snapshot().pending) {
      if (performance.now() - start > 6000) throw Error('Retirement drain deadline');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { differences, restoreDifference, finite: [...a].every(v => (v & 0x7c00) !== 0x7c00),
      queuedBeforeLoss, lost, final: service.snapshot(), hooksRestored, gl: gl.getError(), contextLost: gl.isContextLost() };
  });
  await page.screenshot({ path: `${out}/fixture.png` });const after = await evidenceFingerprint('tools/programretirementgputest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);assert.equal(result.differences, 0);assert.equal(result.restoreDifference, 0);
  assert.ok(result.finite && result.queuedBeforeLoss > 0 && result.lost.abandonedOnLoss > 0);
  assert.equal(result.hooksRestored, true);assert.equal(result.final.stopped, true);assert.equal(result.final.pending, 0);
  assert.deepEqual(result.final.faults, []);assert.equal(result.gl, 0);assert.equal(result.contextLost, false);
  console.log(JSON.stringify({ out, result, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
