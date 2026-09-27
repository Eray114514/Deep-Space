// Probe production far-cloud VERTICES on every cloudy body, including moons.
// A focused-body volume/fragment test cannot catch an exploding distant deck.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const fingerprint = await evidenceFingerprint('tools/b4cloudgeometrytest.js');
const output = `test-results/b4-cloud-geometry/${fingerprint.sourceDigest.slice(0, 12)}`;
await mkdir(output, { recursive: true });
const baseline = JSON.parse(await readFile('docs/baselines/b4-local-2026-09-27/manifest.json'));
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&quality=ultra&freeze=1&time=9.5&nohero=1&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  console.log('Booted; probing all production cloud decks.');
  const geometry = await page.evaluate(() => {
    const THREE = NMS._THREE, renderer = NMS._renderer;
    const savedTarget = renderer.getRenderTarget();
    const results = [];
    for (const p of NMS._internals.universe.system.planets) {
      if (!p.cloudMesh || !p.weatherField.synoptic) continue;
      const field = p.weatherField, quantization = field.surfaceRangeMeters / 255;
      let surfaceMin = Infinity, surfaceMax = -Infinity;
      const data = p.cloudWeatherHiTex.userData.weatherAtlas.data;
      for (let i = 1; i < data.length; i += 4) {
        const height = (data[i] / 255 * 2 - 1) * field.surfaceRangeMeters;
        surfaceMin = Math.min(surfaceMin, height); surfaceMax = Math.max(surfaceMax, height);
      }
      for (const [layer, deck] of [['low', p.cloudMesh], ['high', p.cloudMesh2]]) {
        if (!deck) continue;
        const original = deck.material.userData.shader;
        const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader,
          fragmentShader: THREE.ShaderLib.basic.fragmentShader };
        deck.material.onBeforeCompile(shader, renderer);
        deck.material.userData.shader = original;
        shader.uniforms.uSurfaceSpin.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(deck.quaternion));
        const width = deck.geometry.parameters.widthSegments + 1;
        const height = deck.geometry.parameters.heightSegments + 1;
        const material = new THREE.ShaderMaterial({ uniforms: shader.uniforms,
          // Keep the real onBeforeCompile displacement. Only replace projection
          // to give every original vertex one pixel in a float readback target.
          vertexShader: shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec4 vProbe;')
            .replace('#include <project_vertex>', `
              vProbe=vec4(length(transformed)-${p.R.toFixed(8)},0.,0.,1.);
              vec4 mvPosition=vec4(transformed,1.);
              vec2 pixel=vec2(gl_VertexID % ${width},gl_VertexID / ${width})+0.5;
              gl_Position=vec4(pixel/vec2(${width}.,${height}.)*2.-1.,0.,1.);
              gl_PointSize=1.;`),
          fragmentShader: 'varying vec4 vProbe; void main(){gl_FragColor=vProbe;}',
          depthTest: false, depthWrite: false, toneMapped: false,
        });
        const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, depthBuffer: false });
        const pointsGeometry = deck.geometry.clone(); pointsGeometry.setIndex(null);
        const points = new THREE.Points(pointsGeometry, material); points.frustumCulled = false;
        const scene = new THREE.Scene(); scene.add(points);
        const pixels = new Float32Array(width * height * 4);
        const probe = () => {
          renderer.setRenderTarget(target); renderer.render(scene, new THREE.Camera());
          renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
          let min = Infinity, max = -Infinity;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] !== 1 || !Number.isFinite(pixels[i])) throw Error('Missing/nonfinite cloud vertex');
            min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]);
          }
          return { min, max };
        };
        const actual = probe(), relief = shader.uniforms.uCloudRelief.value;
        const allowedMin = layer === 'high' ? 11200 : Math.max(250, field.surfaceBoundsMeters[0] + 1450 - quantization);
        const allowedMax = (layer === 'high' ? 11200
          : Math.max(250, field.surfaceBoundsMeters[1] + 5300 + quantization)) + relief;
        let sentinelControl = null;
        if (!p.hasLiquid && layer === 'low') {
          shader.uniforms.uSurfaceRange.value = 1e9;
          sentinelControl = probe();
        }
        results.push({ bodyId: p.bodyId, name: p.name, layer, hasLiquid: p.hasLiquid,
          radius: p.R, surfaceRange: field.surfaceRangeMeters, surfaceBounds: field.surfaceBoundsMeters,
          surfaceMin, surfaceMax, quantization, vertices: width * height, actual, allowedMin, allowedMax, sentinelControl });
        pointsGeometry.dispose(); material.dispose(); target.dispose();
      }
    }
    renderer.setRenderTarget(savedTarget);
    return results;
  });
  assert.ok(geometry.some((r) => !r.hasLiquid), 'Must include dry bodies, not just the three main visual worlds');
  for (const row of geometry) {
    const label = `${row.name} ${row.layer}`;
    assert.ok(row.surfaceMin >= row.surfaceBounds[0] - row.quantization - 0.001, `${label}: atlas lowered terrain`);
    assert.ok(row.surfaceMax <= row.surfaceBounds[1] + row.quantization + 0.001, `${label}: atlas raised terrain`);
    // Float32 radial subtraction at planetary radii has metre-level roundoff.
    assert.ok(row.actual.min >= row.allowedMin - 4 && row.actual.max <= row.allowedMax + 4,
      `${label}: vertex altitude ${JSON.stringify(row.actual)} outside physical bounds`);
  }
  assert.ok(geometry.some((r) => r.sentinelControl?.max > r.allowedMax * 100),
    'Known-bad sentinel must fail the geometry gate');
  console.log(`Bounded ${geometry.length} cloud decks; known-bad sentinel rejected.`);
  await page.evaluate(async () => {
    window.B0 = await import('/tools/b0-browser.js'); B0.installCaptureHold(); NMS.setAdaptiveQualityLocked(true);
  });
  const captures = [];
  for (const column of baseline.columns) {
    await page.evaluate((column) => B0.cloudPose(column.index, column, 'S4-globe'), column);
    const start = await page.evaluate(() => __b0RenderedFrames);
    await page.waitForFunction((start) => __b0RenderedFrames >= start + 24, start, { timeout: 150000 });
    const path = `p${column.index}-${column.light}-S4-globe.png`;
    const bytes = await page.screenshot({ path: `${output}/${path}` });
    captures.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'),
      state: await page.evaluate((index) => B0.snapshot(index), column.index) });
    console.log(path);
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ fingerprint, geometry, captures, errors }, null, 2) + '\n');
  console.log(output);
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
