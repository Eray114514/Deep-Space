import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import * as THREE from '../vendor/three.module.js';
import { selectStellarOccluders } from '../src/stellar-occlusion.js';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const planet = { R: 100000, posUniv: new THREE.Vector3(), worldOffsetToLocal: (v, out) => out.copy(v) };
const stars = [{ positionUniv: new THREE.Vector3(0, 1e8, 0), spec: { radiusRender: 1e6 } },
  { positionUniv: new THREE.Vector3(1e8, 0, 0), spec: { radiusRender: 2e6 } }];
const blockers = [[0, 1e7, 0], [1e7, 0, 0], [0, -1e7, 0], [0, 1.5e8, 0], [0, 1e7, 3e7]]
  .map((p) => ({ R: 2e5, posUniv: new THREE.Vector3(...p) }));
assert.equal(selectStellarOccluders(planet, [planet, ...blockers], stars).length, 2,
  'whole-world selector must include companion blockers and exclude behind/beyond/off-axis bodies');
const primary = [0, 1e7, 0, 2e5], companion = [1e7, 0, 0, 3e5];
const partial = [150000, 1e7, 0, 100000], opposite = [-150000, 1e7, 0, 100000];
const fixtures = [
  { name: 'clear', blockers: [], expected: [1, 1] },
  { name: 'primary-only-totality', blockers: [primary], expected: [0, 1] },
  { name: 'companion-only-totality', blockers: [companion], expected: [1, 0] },
  { name: 'two-stars-totality', blockers: [primary, companion], expected: [0, 0] },
  { name: 'partial', blockers: [partial] },
  { name: 'overlapping-duplicate', blockers: [partial, partial] },
  { name: 'two-partial', blockers: [partial, opposite] },
];
// Independent area sampling of projected stellar/occluder discs, with hard
// visibility. Production smooth edges are compared to this dense limit.
function referenceVisibility(blockers, count = 200000) {
  let visible = 0;
  for (let i = 0; i < count; i++) {
    const r = Math.asin(0.01) * Math.sqrt((i + 0.5) / count), phi = i * 2.399963229728653;
    const x = r * Math.cos(phi), y = r * Math.sin(phi);
    const blocked = blockers.some(([bx, by, bz, radius]) => {
      const distance = Math.hypot(bx, by, bz), angle = Math.acos(by / distance);
      const cx = angle * bx / Math.max(Math.hypot(bx, bz), 1e-9);
      const cy = angle * bz / Math.max(Math.hypot(bx, bz), 1e-9);
      return Math.hypot(x - cx, y - cy) < Math.asin(radius / distance);
    });
    if (!blocked) visible++;
  }
  return visible / count;
}
for (const f of fixtures) if (!f.expected) f.expected = [referenceVisibility(f.blockers), 1];
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__b5-light', (r) => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__b5-light`);
  const cases = await page.evaluate(async (fixtures) => {
    const THREE = await import('three');
    const { stellarOcclusionGLSL, stellarOcclusionUniforms, bindStellarOcclusion } = await import('/src/stellar-occlusion.js');
    const { Planet } = await import('/src/planet.js');
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(1, 1);
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const uniforms = stellarOcclusionUniforms();
    const p = { _invFrame: new THREE.Quaternion(), sunDirWorld: new THREE.Vector3(), sunDirLocal: new THREE.Vector3(),
      volCloudUniforms: uniforms };
    Planet.prototype.setStellarLights.call(p, { sources: [
      { direction: [0, 1, 0], radius: 1e6, distance: 1e8, irradianceFraction: 0.65 },
      { direction: [1, 0, 0], radius: 2e6, distance: 1e8, irradianceFraction: 0.35 },
    ] });
    const material = new THREE.ShaderMaterial({ uniforms, depthTest: false, depthWrite: false,
      vertexShader: 'void main(){gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: `precision highp float; ${stellarOcclusionGLSL}
      void main(){gl_FragColor=vec4(localStellarVisibility(vec3(0),vec3(0,1,0)),localStellarVisibility(vec3(0),vec3(1,0,0)),0,1);}` });
    const quad = new FullScreenQuad(material), results = [];
    for (const fixture of fixtures) {
      p.stellarOccluders = fixture.blockers.map((b) => ({ centerLocal: new THREE.Vector3(...b.slice(0, 3)), radius: b[3] }));
      bindStellarOcclusion(uniforms, p);
      renderer.setRenderTarget(rt); quad.render(renderer);
      const data = new Float32Array(4); renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, data);
      results.push(Array.from(data));
    }
    if (renderer.getContext().getError()) throw Error('WebGL draw/read error');
    material.dispose(); quad.dispose(); rt.dispose(); renderer.dispose(); return results;
  }, fixtures);
  assert.deepEqual(errors, []);
  cases.forEach((actual, i) => {
    assert.equal(actual[3], 1);
    actual.slice(0, 2).forEach((v, c) => assert.ok(Math.abs(v - fixtures[i].expected[c]) < 0.015,
      `${fixtures[i].name}: star ${c} actual ${v}, expected ${fixtures[i].expected[c]}`));
  });
  assert.deepEqual(cases[4], cases[5], 'overlapping blockers must not double-count the same disc');
  await mkdir('test-results/b5', { recursive: true });
  await writeFile('test-results/b5/lighting.json', JSON.stringify({ fingerprint: await evidenceFingerprint('tools/b5lightingtest.js'),
    cases: fixtures.map((f, i) => ({ ...f, actual: cases[i] })), errors }, null, 2));
  console.log('PASS: two-star selection, per-star radii, totality and union of partial occluders');
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
