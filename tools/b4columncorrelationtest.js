// Independent footprint reference for correlated/anticorrelated decks. A
// product of separately averaged transmissions must fail these controls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath(), headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__joint', r => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__joint`);
  const records = await page.evaluate(async () => {
    const THREE = await import('three');
    const { makeCloudVolumeMaterial, disposeCloudNoiseTexture } = await import('/src/clouds-webgl.js');
    const { CloudColumnMap } = await import('/src/cloud/cloud-column-map.js');
    const r = new THREE.WebGLRenderer();
    const atlas = new THREE.DataTexture(new Float32Array([1, .5, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    atlas.needsUpdate = true;
    const width = 16, height = 8, stride = width * height * 4;
    const bands = new THREE.DataArrayTexture(new Float32Array(stride * 16), width, height, 16);
    bands.type = THREE.FloatType; bands.format = THREE.RGBAFormat;
    bands.wrapS = THREE.RepeatWrapping; bands.minFilter = bands.magFilter = THREE.LinearFilter;
    const p = { R: 6000000, weatherHours: 0, cloudSpinBase: 0,
      weatherField: { windRadiansPerHour: 0, surfaceRangeMeters: 1 }, cloudSpeciesTex: bands, cloudBoundsTex: atlas };
    p.volCloudMat = makeCloudVolumeMaterial(p, { rIn: p.R, rOut: p.R + 2000, localWeather: true,
      ox: 0, oy: 0, oz: 0, cov0: .3, cov1: .7 }, atlas, atlas, atlas);
    const noise = new THREE.Data3DTexture(new Uint8Array([128, 128]), 1, 1, 1);
    noise.format = THREE.RGFormat; noise.needsUpdate = true;
    const u = p.volCloudMat.uniforms;
    u.uNoise3.value = noise; u.uSpeciesCount.value = 2;
    const parameters = u.uSpeciesParameters.value, pw = parameters.image.width;
    // Both controlled genera are exact, constant-noise sheet profiles. Their
    // optical families differ, but their occupied subpixels can coincide.
    for (let i = 0; i < 2; i++) {
      parameters.image.data.set([40000, 0, 0, .025], i * 4);
      parameters.image.data.set([0, i, 0, 0], (pw + i) * 4);
    }
    parameters.needsUpdate = true;
    const n = 128 / 255, tau = 600 * .025 * .2 * (.45 + .55 * n) * (1 - .14 / 2 - .2 / 2);
    const mask = x => x % 8 < 4 ? 1 : 0;
    const interpolate = (uv, inverse) => {
      const q = uv * width - .5, cell = Math.floor(q), f = q - cell;
      const a = mask((cell % width + width) % width), b = mask((cell + 1 + width) % width);
      const v = a * (1 - f) + b * f; return inverse ? 1 - v : v;
    };
    const records = [];
    for (const inverse of [false, true]) {
      for (let layer = 0; layer < 2; layer++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const coverage = layer === 1 && inverse ? 1 - mask(x) : mask(x);
        bands.image.data.set([coverage, 1000, 1600, 1], layer * stride + (y * width + x) * 4);
      }
      bands.needsUpdate = true;
      const map = new CloudColumnMap(p, { width: 2, samples: 256, footprintSamples: 64 });
      map.bakeSlice(r, 1);
      const optical = new Uint8Array(8), heights = new Uint16Array(8);
      r.setRenderTarget(map.target);
      r.readRenderTargetPixels(map.target, 0, 0, 2, 1, optical);
      r.readRenderTargetPixels(map.target, 0, 0, 2, 1, heights, undefined, 1);
      const prefix = p.volCloudMat.fragmentShader.slice(0, p.volCloudMat.fragmentShader.lastIndexOf('void main()'));
      const cacheUniforms = { ...u, uCameraLocal: { value: new THREE.Vector3(p.R + 10000, 0, 0) },
        uColumnsReady: { value: 1 }, uColumnsJointReady: { value: 1 }, uColumnMix: { value: 0 },
        uOpticalColumns: { value: map.target.textures[0] }, uOpticalColumnsNext: { value: map.target.textures[0] },
        uColumnHeights: { value: map.target.textures[1] }, uColumnHeightsNext: { value: map.target.textures[1] },
        uSunEnergy: { value: 0 }, uSecondarySunEnergy: { value: 0 }, air_uEnabled: { value: 0 } };
      const material = new THREE.ShaderMaterial({ uniforms: cacheUniforms, defines: p.volCloudMat.defines,
        vertexShader: 'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
        fragmentShader: prefix + 'void main(){vec4 c=cloudCachedColumn(vec3(-1,0,0),0.0,11000.0);gl_FragColor=vec4(c.a,0,0,1);}',
        depthTest: false, depthWrite: false });
      const geometry = new THREE.PlaneGeometry(2, 2), mesh = new THREE.Mesh(geometry, material);
      const scene = new THREE.Scene(), camera = new THREE.Camera(); scene.add(mesh);
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
      const samples = [];
      for (const enabled of [1, 0]) {
        cacheUniforms.uColumnsJointReady.value = enabled;
        r.setRenderTarget(target); r.render(scene, camera);
        const output = new Float32Array(4); r.readRenderTargetPixels(target, 0, 0, 1, 1, output);
        if (output[3] !== 1 || !Number.isFinite(output[0])) throw Error('Invalid cached-column shader');
        samples.push(output[0]);
      }
      for (let x = 0; x < 2; x++) {
        let low = 0, high = 0, joint = 0;
        for (let k = 0; k < 64; k++) {
          const uv = (x + (k + .5) / 64) / 2;
          const tl = tau * interpolate(uv, false), th = tau * interpolate(uv, inverse);
          low += -Math.expm1(-tl) / 64; high += -Math.expm1(-th) / 64;
          joint += -Math.expm1(-tl - th) / 64;
        }
        records.push({ inverse, x, low, high, joint, independent: low + high - low * high,
          actualLow: optical[x * 4] / 255, actualHigh: optical[x * 4 + 1] / 255,
          actualJoint: THREE.DataUtils.fromHalfFloat(heights[x * 4 + 2]),
          cachedJoint: samples[0], independentCached: samples[1] });
      }
      geometry.dispose(); material.dispose(); target.dispose();
      map.dispose();
    }
    r.setRenderTarget(null);
    const glError = r.getContext().getError();
    p.volCloudMat.dispose(); parameters.dispose(); bands.dispose(); noise.dispose(); atlas.dispose();
    disposeCloudNoiseTexture(); r.dispose();
    return { records, glError };
  });
  assert.deepEqual(errors, []); assert.equal(records.glError, 0);
  for (const row of records.records) {
    assert.ok(Math.abs(row.actualLow - row.low) < .008, 'liquid footprint opacity');
    assert.ok(Math.abs(row.actualHigh - row.high) < .008, 'ice footprint opacity');
    assert.ok(Math.abs(row.actualJoint - row.joint) < .008, 'same-footprint joint opacity');
    assert.ok(Math.abs(row.cachedJoint - row.joint) < .012, 'production cached-column composition');
    assert.ok(Math.abs(row.independent - row.joint) > .07, 'independent-deck control must fail');
    assert.ok(Math.abs(row.independentCached - row.joint) > .07, 'old production composition must fail');
  }
  await mkdir('test-results/b4-column-correlation', { recursive: true });
  await writeFile('test-results/b4-column-correlation/report.json', JSON.stringify({
    fingerprint: await evidenceFingerprint('tools/b4columncorrelationtest.js'), ...records, errors }, null, 2));
  console.log('PASS same-footprint opacity: correlated and anticorrelated liquid/ice decks; independent controls fail.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
