import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
const out = `test-results/cloud-cache-ownership/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/cloudcacheownershipgputest.js');
const reference = execFileSync('git', ['show', '11169f9:src/cloud/cloud-sun-cache.js']);
await writeFile(`${out}/reference-cloud-sun-cache.js`, reference);
const { server, port } = await startServer(0);let browser;const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage();page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' || /GL_INVALID_/.test(m.text())) errors.push(m.text()); });
  await page.route('**/cache-ownership.html', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><canvas id="fixture"></canvas>' }));
  await page.route('**/src/cloud/cache-ownership-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: reference }));
  await page.goto(`http://127.0.0.1:${port}/cache-ownership.html`);
  const result = await page.evaluate(async () => {
    const T = await import('three'), { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const { CloudSunCache: Original } = await import('/src/cloud/cache-ownership-reference.js');
    const { CloudSunCache: Current } = await import('/src/cloud/cloud-sun-cache.js');
    const { makeCloudVolumeMaterial, disposeCloudNoiseTexture } = await import('/src/clouds-webgl.js');
    const { installProgramRetirement } = await import('/src/program-retirement.js');
    const r = new T.WebGLRenderer({ canvas: document.querySelector('#fixture') });r.setSize(64, 64);
    const retirement = installProgramRetirement(r), gl = r.getContext();
    const atlas = new T.DataTexture(new Float32Array([0, .5, 0, 0]), 1, 1, T.RGBAFormat, T.FloatType);atlas.needsUpdate = true;
    const bands = new T.DataArrayTexture(new Float32Array(16 * 4), 1, 1, 16);
    bands.image.data.set([1, 1000, 1600, 1]);bands.format = T.RGBAFormat;bands.type = T.FloatType;bands.needsUpdate = true;
    const bounds = new T.DataTexture(new Float32Array([800, 1800, 0, 0]), 1, 1, T.RGBAFormat, T.FloatType);bounds.needsUpdate = true;
    const candidates = new T.DataArrayTexture(new Uint16Array([65535]), 1, 1, 1);
    candidates.format = T.RedIntegerFormat;candidates.type = T.UnsignedShortType;candidates.internalFormat = 'R16UI';candidates.needsUpdate = true;
    const p = { R: 6000000, weatherHours: 0, weatherField: { surfaceRangeMeters: 1 }, cloudSpeciesTex: bands, cloudBoundsTex: bounds, cloudCandidatesTex: candidates };
    p.volCloudMat = makeCloudVolumeMaterial(p, { rIn: p.R, rOut: p.R + 2000, localWeather: true, ox: 0, oy: 0, oz: 0, cov0: .3, cov1: .7 }, atlas, atlas, atlas);
    const noise = new T.Data3DTexture(new Uint8Array([128, 128]), 1, 1, 1);noise.format = T.RGFormat;noise.needsUpdate = true;
    p.volCloudMat.uniforms.uNoise3.value = noise;p.volCloudMat.uniforms.uSunDir.value.set(0, 1, 0);
    p.volCloudMat.uniforms.uSecondarySunDir.value.set(Math.sqrt(.84), .4, 0);
    const target = new T.WebGLRenderTarget(8 * 32, 8, { format: T.RedFormat, type: T.UnsignedByteType, depthBuffer: false });
    const displayMaterial = new T.ShaderMaterial({ uniforms: { map: { value: target.texture } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'uniform sampler2D map;varying vec2 vUv;void main(){float v=texture2D(map,vUv).r;gl_FragColor=vec4(v,v*v,-v*.5,1);}',
      depthTest: false, depthWrite: false });
    const display = new FullScreenQuad(displayMaterial), color = new T.WebGLRenderTarget(64, 64, { type: T.HalfFloatType });
    let geometryDisposals = 0, links = 0, uploads = 0;
    display._mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
    const link = gl.linkProgram, buffer = gl.bufferData;
    gl.linkProgram = function(...args) { links++;return link.apply(this, args); };
    gl.bufferData = function(...args) { uploads++;return buffer.apply(this, args); };
    const draw = () => { r.setRenderTarget(color);display.render(r); };
    draw();const records = [], outputs = [];
    for (const [name, Cache] of [['original', Original], ['current', Current]]) for (const sharedPool of [false, true]) {
      const pool = {}, baseline = { links, geometryDisposals }, generations = [];
      for (let generation = 0; generation < 3; generation++) {
        const owner = sharedPool ? pool : {};
        const cache = new Cache(p, new T.Vector3(0, p.R + 1300, 0), { size: 8, depth: 8, spacing: 50, target, programOwner: owner });
        let steps = 0;while (!cache.ready) { cache.bakeSlice(r, { boundaryRows: 8, slices: 8 });if (++steps > 40) throw Error('Cache stalled'); }
        const beforeDraw = uploads;draw();const unrelatedUploads = uploads - beforeDraw;
        const bytes = new Uint8Array(8 * 32 * 8);r.readRenderTargetPixels(target, 0, 0, target.width, target.height, bytes);
        r.setRenderTarget(color);const native = new Uint16Array(64 * 64 * 4);r.readRenderTargetPixels(color, 0, 0, 64, 64, native);
        outputs.push({ bytes, native });generations.push({ steps, unrelatedUploads });cache.dispose();
        if (!sharedPool) for (const material of Object.values(owner)) material.dispose();
      }
      records.push({ name, sharedPool, links: links - baseline.links, persistentDisposals: geometryDisposals - baseline.geometryDisposals,
        leaseCount: Object.keys(pool).length, releasedUniforms: Object.values(pool).every(m => Object.keys(m.uniforms).length === 0), generations });
      for (const material of Object.values(pool)) material.dispose();
    }
    const difference = (a, b) => a.reduce((n, value, i) => n + (value !== b[i] ? 1 : 0), 0);
    const comparisons = outputs.map(value => ({ atlas: difference(outputs[0].bytes, value.bytes), native: difference(outputs[0].native, value.native) }));
    const occupied = outputs[0].bytes.filter(v => v > 0).length, maximum = Math.max(...outputs[0].bytes);
    r.setRenderTarget(null);display.render(r);await new Promise(resolve => setTimeout(resolve, 80));
    const result = { records, comparisons, occupied, maximum, gl: gl.getError(), lost: gl.isContextLost(), retirement: retirement.snapshot(),
      scope: 'Unchanged physical constant-noise production sweep and R8 codec; geometry ownership x cross-generation program retention. Native atlas/final HDR equality, not all climates or whole-page FPS.' };
    gl.linkProgram = link;gl.bufferData = buffer;
    display.dispose();displayMaterial.dispose();target.dispose();color.dispose();p.volCloudMat.dispose();
    for (const texture of [atlas, bands, bounds, candidates, noise]) texture.dispose();disposeCloudNoiseTexture();r.dispose();return result;
  });
  await page.screenshot({ path: `${out}/fixture.png` });
  const after = await evidenceFingerprint('tools/cloudcacheownershipgputest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);assert.equal(result.gl, 0);assert.equal(result.lost, false);
  assert.ok(result.occupied > 0 && result.maximum > 0);assert.ok(result.comparisons.every(row => row.atlas === 0 && row.native === 0));
  for (const row of result.records) {
    assert.equal(row.links, row.sharedPool ? 2 : 6);assert.equal(row.persistentDisposals, row.name === 'original' ? 6 : 0);
    assert.ok(row.generations.every(g => g.unrelatedUploads === (row.name === 'original' ? 2 : 0)));
    assert.ok(row.releasedUniforms);
  }
  assert.deepEqual(result.retirement.faults, []);assert.equal(result.retirement.pending, 0);
  console.log(JSON.stringify({ out, result, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
