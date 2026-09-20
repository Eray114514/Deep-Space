// Characterizes the known legacy composition gap, not a B5 acceptance PASS.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { integrateMediumSlabs, MEDIUM_FIXTURES } from './medium-reference.js';

const inputs = MEDIUM_FIXTURES.map((f) => ({ ...f,
  reference: integrateMediumSlabs(f.slabs, f.depth, f.background),
  air: integrateMediumSlabs(f.slabs.filter((s) => s.kind === 'air'), f.depth, f.background),
  cloud: integrateMediumSlabs(f.slabs.filter((s) => s.kind === 'cloud'), f.depth),
}));
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__b0', (r) => r.fulfill({ contentType: 'text/html',
    body: '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__b0`);
  const gpu = await page.evaluate(async (inputs) => {
    const THREE = await import('three');
    const { VolumetricPass } = await import('/src/volumetric-pass-webgl.js');
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(1, 1);
    const pass = new VolumetricPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const texture = (rgb, alpha) => {
      const t = new THREE.DataTexture(new Float32Array([...rgb, alpha]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
      t.needsUpdate = true; return t;
    };
    const results = [];
    for (const f of inputs) {
      const base = texture(f.air.radiance, 1);
      const volume = texture(f.cloud.L, 1 - f.cloud.T[0]);
      pass.compositeMaterial.uniforms.tBase.value = base;
      pass.compositeMaterial.uniforms.tVolume.value = volume;
      renderer.setRenderTarget(target); pass.compositeQuad.render(renderer);
      const data = new Float32Array(4);
      renderer.readRenderTargetPixels(target, 0, 0, 1, 1, data);
      results.push(Array.from(data)); base.dispose(); volume.dispose();
    }
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const adapter = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    pass.dispose(); target.dispose(); renderer.dispose();
    return { results, adapter };
  }, inputs);
  assert.deepEqual(errors, []);
  const cases = inputs.map((f, i) => {
    const actual = gpu.results[i];
    assert.equal(actual[3], 1, 'valid GPU readback');
    assert.ok(actual.every(Number.isFinite));
    const maxError = Math.max(...f.reference.radiance.map((v, c) => Math.abs(v - actual[c])));
    if (f.expectLegacyGap) assert.ok(maxError > 0.001, `${f.name}: expected old-model defect must be detected; review if fixed`);
    else assert.ok(maxError < 1e-6, `${f.name}: control failed`);
    return { name: f.name, slabs: f.slabs, depthMeters: f.depth, background: f.background,
      reference: f.reference, actual: actual.slice(0, 3), maxAbsoluteRgbError: maxError,
      status: f.expectLegacyGap ? 'known-production-gap' : 'control-pass' };
  });
  const report = { phase: 'B0', productionCompositionAccepted: false, browser: browser.version(),
    gpu: gpu.adapter, fingerprint: await evidenceFingerprint('tools/b0compositiontest.js'),
    referenceDigest: createHash('sha256').update(await readFile('tools/medium-reference.js')).digest('hex'), cases, errors,
    scope: 'Analytic controlled path oracle and actual final composite GLSL. Depth clips reference inputs; real depth producer/consumer integration remains a B5 gate.' };
  await mkdir('test-results/b0-composition', { recursive: true });
  await writeFile('test-results/b0-composition/report.json', JSON.stringify(report, null, 2));
  console.log('B0 reference/control checks passed; production composition remains NOT ACCEPTED.',
    cases.map((c) => ({ name: c.name, error: c.maxAbsoluteRgbError, status: c.status })));
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
