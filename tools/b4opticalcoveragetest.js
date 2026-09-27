// Measure the actual production extinction field on equal-area radial columns.
// This does not use the weather model's proxy obstruction estimate.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const fingerprint = await evidenceFingerprint('tools/b4opticalcoveragetest.js');
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  const results = await page.evaluate(() => {
    const THREE = NMS._THREE, renderer = NMS._renderer;
    const geometry = new THREE.PlaneGeometry(2, 2);
    const scene = new THREE.Scene(), camera = new THREE.Camera();
    const records = [];
    for (const index of [0, 2, 4]) {
      NMS.land(index);
      const p = NMS._planet(index), source = p.volCloudMat;
      const spin = p.cloudSpinBase + p.weatherHours
        * p.weatherField.windRadiansPerHour;
      source.uniforms.uSpin.value.setFromMatrix4(
        new THREE.Matrix4().makeRotationY(-spin));
      const prefix = source.fragmentShader.slice(0, source.fragmentShader.lastIndexOf('void main()'));
      const material = new THREE.ShaderMaterial({
        uniforms: { ...source.uniforms, uSamples: { value: 128 }, uDirections: { value: 512 } },
        vertexShader: 'varying vec3 vDirection,vViewDirection; void main(){vDirection=vec3(0.,1.,0.);vViewDirection=vec3(0.,0.,-1.);gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader: prefix + `
          uniform int uSamples; uniform float uDirections;
          void main() {
            float i=floor(gl_FragCoord.x);
            float y=1.0-2.0*(i+0.5)/uDirections;
            float phi=i*2.399963229728653;
            vec3 dir=vec3(sqrt(max(0.0,1.0-y*y))*cos(phi),y,
              sqrt(max(0.0,1.0-y*y))*sin(phi));
            float low=0.0, high=0.0;
            float stepMeters=(uRout-uBodyR)/float(uSamples);
            for(int k=0;k<256;k++) {
              if(k>=uSamples) break;
              vec2 layers=cloudLayersAt(dir*(uBodyR+(float(k)+0.5)*stepMeters));
              low+=layers.x*0.025*stepMeters;
              high+=layers.y*0.0006*stepMeters;
            }
            gl_FragColor=vec4(1.0-exp(-low),1.0-exp(-high),
              1.0-exp(-low-high),1.0);
          }`, depthTest: false, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material); scene.add(mesh);
      const count = 512;
      const target = new THREE.WebGLRenderTarget(count, 1, { type: THREE.FloatType, depthBuffer: false });
      const pixels = new Float32Array(count * 4);
      const savedTarget = renderer.getRenderTarget();
      const values = [];
      for (const samples of [64, 128, 256]) {
        material.uniforms.uSamples.value = samples;
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, count, 1, pixels);
        const stats = { samples, lowCovered: 0, highCovered: 0, covered: 0,
          clear: 0, meanObstruction: 0, opacity: [] };
        for (let i = 0; i < count; i++) {
          const low = pixels[i * 4], high = pixels[i * 4 + 1], alpha = pixels[i * 4 + 2];
          if (![low, high, alpha].every(Number.isFinite) || pixels[i * 4 + 3] !== 1) {
            throw Error(`invalid optical column at body ${index}, direction ${i}`);
          }
          stats.lowCovered += low >= 0.5;
          stats.highCovered += high >= 0.5;
          stats.covered += alpha >= 0.5;
          stats.clear += alpha < 0.05;
          stats.meanObstruction += alpha / count;
          stats.opacity.push(alpha);
        }
        for (const key of ['lowCovered', 'highCovered', 'covered', 'clear']) stats[key] /= count;
        values.push(stats);
      }
      renderer.setRenderTarget(savedTarget);
      const glError = renderer.getContext().getError();
      records.push({ index, seed: p.seed, weatherHours: p.weatherHours,
        targetCoverage: p.cloudCoverage,
        coverageProxy: p.cloudCoverageStats, values, glError });
      target.dispose(); material.dispose(); scene.remove(mesh);
    }
    geometry.dispose();
    return records;
  });
  assert.deepEqual(errors, []);
  for (const body of results) {
    assert.equal(body.glError, 0);
    for (const value of body.values) {
      assert.ok(value.covered > 0.1 && value.clear > 0.1,
        `body ${body.index} needs occupied and clear production columns`);
    }
    const coarse = body.values[1], reference = body.values[2];
    const meanError = coarse.opacity.reduce((sum, opacity, i) =>
      sum + Math.abs(opacity - reference.opacity[i]), 0) / coarse.opacity.length;
    assert.ok(meanError < 0.01, `body ${body.index} optical column mean error ${meanError}`);
    assert.ok(Math.abs(coarse.covered - reference.covered) < 0.02,
      `body ${body.index} occupied area did not converge`);
  }
  const output = `test-results/b4-optical-coverage/${fingerprint.sourceDigest.slice(0, 12)}`;
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify({ fingerprint, results, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ output, results: results.map(({ index, targetCoverage, values }) => ({
    index, targetCoverage, values: values.map(({ samples, lowCovered, highCovered,
      covered, clear, meanObstruction }) => ({ samples, lowCovered, highCovered,
      covered, clear, meanObstruction })),
  })) }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
