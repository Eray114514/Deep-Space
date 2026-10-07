// Constant weather leaves only microscopic advection. Follow each family's
// independently prescribed characteristic; a shared low-cloud flow must fail.
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
  await page.route('**/__flow', r => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__flow`);
  const records = await page.evaluate(async () => {
    const THREE = await import('three');
    const { makeCloudVolumeMaterial, disposeCloudNoiseTexture } = await import('/src/clouds-webgl.js');
    const { sampleProductionMedium } = await import('/src/cloud/production-shape.js');
    const { CLOUD_SPECIES } = await import('/src/cloud/cloud-species.js');
    const renderer = new THREE.WebGLRenderer();
    const atlas = new THREE.DataTexture(new Float32Array([1, .5, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    atlas.needsUpdate = true;
    const data = new Float32Array(16 * 4);
    for (let i = 0; i < 16; i++) data.set([1, 1000, 3500, 1], i * 4);
    const bands = new THREE.DataArrayTexture(data, 1, 1, 16);
    bands.type = THREE.FloatType; bands.format = THREE.RGBAFormat; bands.needsUpdate = true;
    const bounds = new THREE.DataTexture(new Float32Array([0, 4000, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    bounds.needsUpdate = true;
    const candidates = new THREE.DataArrayTexture(new Uint16Array(64).fill(65535), 1, 1, 64);
    candidates.type = THREE.UnsignedShortType; candidates.format = THREE.RedIntegerFormat;
    candidates.minFilter = candidates.magFilter = THREE.NearestFilter; candidates.needsUpdate = true;
    const p = { R: 6000000, weatherHours: 0, cloudSpinBase: 0,
      weatherField: { windRadiansPerHour: 1.9, surfaceAt: () => 0, surfaceRangeMeters: 1 },
      cloudSpeciesTex: bands, cloudBoundsTex: bounds, cloudCandidatesTex: candidates };
    p.volCloudMat = makeCloudVolumeMaterial(p, { rIn: p.R, rOut: p.R + 4000, localWeather: true,
      ox: .1, oy: -.2, oz: .3, cov0: .3, cov1: .7 }, atlas, atlas, atlas);
    const u = p.volCloudMat.uniforms, target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const prefix = p.volCloudMat.fragmentShader.slice(0, p.volCloudMat.fragmentShader.lastIndexOf('void main()'));
    const uniforms = { ...u, uPoint: { value: new THREE.Vector3() } };
    const material = new THREE.ShaderMaterial({ uniforms, defines: p.volCloudMat.defines,
      vertexShader: 'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: prefix + 'uniform vec3 uPoint;void main(){gl_FragColor=vec4(cloudExtinctionAt(uPoint,0.0),0,0,1);}',
      depthTest: false, depthWrite: false });
    const scene = new THREE.Scene(), camera = new THREE.Camera(), geometry = new THREE.PlaneGeometry(2, 2);
    scene.add(new THREE.Mesh(geometry, material));
    const query = (index, point, hours) => {
      p.weatherHours = hours; u.uCloudAdvectionPhase.value = hours * 1.9;
      u.uSpin.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-hours * 1.9));
      u.uSpeciesMask.value = index; uniforms.uPoint.value.copy(point);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const output = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, output);
      if (output[3] !== 1 || !Number.isFinite(output[0])) throw Error('Invalid flow readback');
      return { gpu: output[0], cpu: sampleProductionMedium(p, point, { speciesMask: index }).extinctionPerMeter };
    };
    const rows = [], dt = .003;
    for (const [id, scale] of [['stratocumulus', 1], ['altocumulus', 1.25], ['cirrus', 1.65]]) {
      const index = CLOUD_SPECIES.findIndex(s => s.id === id);
      for (let i = 0; i < 24; i++) for (const altitude of [1300, 1900, 2700]) {
        const y = 1 - 2 * (i + .5) / 24, angle = i * 2.399963229728653;
        const point = new THREE.Vector3(Math.sqrt(1 - y * y) * Math.cos(angle), y,
          Math.sqrt(1 - y * y) * Math.sin(angle)).multiplyScalar(p.R + altitude);
        const a = query(index, point, 0);
        const moved = point.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(1.9 * dt * scale));
        const b = query(index, moved, dt);
        const wrong = point.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(1.9 * dt));
        const control = query(index, wrong, dt);
        rows.push({ id, scale, altitude, initial: a, advected: b, control });
      }
    }
    const glError = renderer.getContext().getError();
    renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); material.dispose();
    p.volCloudMat.dispose(); bands.dispose(); bounds.dispose(); candidates.dispose(); atlas.dispose();
    disposeCloudNoiseTexture(); renderer.dispose();
    return { rows, glError };
  });
  const maximum = Math.max(...records.rows.map(r => Math.abs(r.initial.gpu - r.advected.gpu)));
  const cpuError = Math.max(...records.rows.flatMap(r => [r.initial, r.advected]).map(r => Math.abs(r.cpu - r.gpu)));
  const occupied = records.rows.filter(r => r.initial.gpu > .000001).length;
  const failedControls = records.rows.filter(r => Math.abs(r.initial.gpu - r.control.gpu) > .0001).length;
  await mkdir('test-results/b4-species-flow', { recursive: true });
  await writeFile('test-results/b4-species-flow/report.json', JSON.stringify({ fingerprint:
    await evidenceFingerprint('tools/b4speciesflowtest.js'), ...records, maximum, cpuError, occupied, failedControls, errors }, null, 2));
  console.log({ cases: records.rows.length, maximum, cpuError, occupied, failedControls, errors });
  assert.deepEqual(errors, []); assert.equal(records.glError, 0);
  assert.ok(occupied > 40, 'nonempty advected density required');
  assert.ok(maximum < .00002 && cpuError < .00002, 'family characteristics and CPU/GPU density must agree');
  assert.ok(failedControls > 20, 'one common velocity must fail mid/high controls');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
