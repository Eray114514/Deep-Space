// Actual production GLSL readback. Controlled non-empty fields isolate the
// repaired contracts; this does not accept final cloud/air composition or art.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { atmosphereRenderProfile } from '../src/atmosphere-pass-webgl.js';
import { columnFixtures, referenceColumn } from './atmosphere-reference.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const planets = [
  { R: 6000000, type: 'lush', weatherProfile: { temperatureK: 286 } },
  { R: 900000, type: 'ice', weatherProfile: { temperatureK: 190 } },
  { R: 7000000, type: 'desert', weatherProfile: { temperatureK: 410 } },
];
const fixtures = planets.flatMap((planet) => {
  const { profile, densityScale } = atmosphereRenderProfile(planet);
  return columnFixtures(profile).map((ray) => ({ planet, ray,
    expected: referenceColumn(profile, ray.radius, ray.mu, ray.distance).map((v) => v * densityScale) }));
});
const started = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({
    executablePath: resolveSystemChromePath() || undefined, headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (request) => console.error('Failed request:', request.url(), request.failure()));
  page.on('response', (response) => {
    if (response.status() >= 400) console.error('HTTP error:', response.status(), response.url());
  });
  await page.route('**/__stage-b-test', (route) => route.fulfill({
    contentType: 'text/html', body: '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>',
  }));
  await page.goto(`http://127.0.0.1:${started.port}/__stage-b-test`);
  const result = await page.evaluate(async (fixtures) => {
    const THREE = await import('three');
    const { AtmospherePass } = await import('/src/atmosphere-pass-webgl.js');
    const { makeCloudVolumeMaterial, disposeCloudNoiseTexture } = await import('/src/clouds-webgl.js');
    const { Planet } = await import('/src/planet.js');
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(64, 64);
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const geometry = new THREE.PlaneGeometry(2, 2);
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry);
    scene.add(mesh);
    const camera = new THREE.Camera();
    const target = new THREE.WebGLRenderTarget(64, 64, { type: THREE.FloatType, depthBuffer: false });
    const vertexShader = `varying vec2 vUv; varying vec3 vDirection, vViewDirection;
      void main() { vUv=uv; vDirection=vec3(0.,1.,0.); vViewDirection=vec3(0.,0.,-1.);
        gl_Position=vec4(position.xy,0.,1.); }`;
    function probe(source, main, extraUniforms = {}, declarations = '') {
      const prefix = source.fragmentShader.slice(0, source.fragmentShader.lastIndexOf('void main()'));
      return new THREE.ShaderMaterial({
        defines: source.defines,
        uniforms: { ...source.uniforms, ...extraUniforms }, vertexShader,
        fragmentShader: prefix + declarations + '\nvoid main() {\n' + main + '\n}',
        depthTest: false, depthWrite: false,
      });
    }
    function read(material) {
      mesh.material = material;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const data = new Float32Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, data);
      if (data.some((v) => !Number.isFinite(v)) || data[3] !== 1) throw Error('Invalid/empty GPU readback');
      return Array.from(data);
    }
    const pass = new AtmospherePass(new THREE.PerspectiveCamera());
    // Recover constituent columns from production RGB transmittance, using
    // orthogonal diagnostic coefficients to keep the three integrals separate.
    const integral = probe(pass.material, `vec3 L,T;
      airIntegrate(uCameraLocal,uTestDirection,0.0,uTestDistance,L,T);
      gl_FragColor=vec4(-log(max(T,vec3(1e-30)))*1e6,1.0);`, {
      uTestDistance: { value: 1 }, uTestDirection: { value: new THREE.Vector3() },
    }, 'uniform float uTestDistance; uniform vec3 uTestDirection;');
    const lutProbe = probe(pass.material, `vec3 od=sunlightOpticalDepth(uTestAltitude,uTestMu).rgb;
      gl_FragColor=vec4(od*vec3(uRayleighScaleHeight,uMieScaleHeight,uOzoneHalfWidth)*uDensityScale,1.0);`, {
      uTestAltitude: { value: 0 }, uTestMu: { value: 1 },
    }, 'uniform float uTestAltitude,uTestMu;');
    const columns = [];
    const sunlightColumns = [];
    for (const { planet, ray } of fixtures) {
      const body = { ...planet, atmoMesh: { visible: true }, posUniv: new THREE.Vector3(),
        _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(0, 1, 0),
        worldOffsetToLocal: (offset, out) => out.copy(offset) };
      pass.setActivePlanet(body, new THREE.Vector3(0, ray.radius, 0));
      integral.uniforms.uTestDirection.value.set(Math.sqrt(1 - ray.mu ** 2), ray.mu, 0);
      integral.uniforms.uTestDistance.value = ray.distance;
      pass.material.uniforms.uBetaRayleigh.value.set(1e-6,0,0);
      pass.material.uniforms.uBetaMieExtinction.value.set(0,1e-6,0);
      pass.material.uniforms.uBetaOzone.value.set(0,0,1e-6);
      columns.push(read(integral).slice(0, 3));
      if (!ray.name.startsWith('orbit-')) {
        lutProbe.uniforms.uTestAltitude.value = ray.radius - planet.R;
        lutProbe.uniforms.uTestMu.value = ray.mu;
        sunlightColumns.push({ index: columns.length - 1, actual: read(lutProbe).slice(0, 3) });
      }
    }
    integral.dispose(); lutProbe.dispose();
    pass.dispose();
    // Real WebGL upload/release plateau while visiting and revisiting bodies.
    const cachePass = new AtmospherePass(new THREE.PerspectiveCamera());
    const memoryBaseline = renderer.info.memory.textures;
    const textureCounts = [];
    for (let i = 0; i < 12; i++) {
      const body = { R: 6000000 + i, atmoMesh: { visible: true }, posUniv: new THREE.Vector3(),
        _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(0, 1, 0),
        worldOffsetToLocal: (offset, out) => out.copy(offset) };
      cachePass.setActivePlanet(body, new THREE.Vector3());
      renderer.initTexture(cachePass.lutTexture);
      textureCounts.push(renderer.info.memory.textures - memoryBaseline);
    }
    cachePass.dispose();
    const texturesAfterDispose = renderer.info.memory.textures - memoryBaseline;

    // Deliberately non-empty legacy fixture using the shared 3D shape noise.
    // Keep localWeather disabled: these camera-invariance and stellar-binding
    // controls do not provide the species/forecast inputs of the real medium.
    const detail = new THREE.DataTexture(new Uint8Array([230, 230, 230, 255]), 1, 1);
    detail.needsUpdate = true;
    const R = 6000000;
    const cloud = makeCloudVolumeMaterial({ R, hasLiquid: false }, {
      rIn: R + 12000, rOut: R + 68000, cov0: 0.2, cov1: 0.7, ox: 0.2, oy: 0.3, oz: 0.4,
    }, detail);
    const u = cloud.uniforms;
    const densityProbe = probe(cloud, `
      float i=floor(gl_FragCoord.x);
      float z=1.0-2.0*(i+0.5)/64.0;
      float phi=i*2.3999632297;
      vec3 radial=vec3(sqrt(1.0-z*z)*cos(phi),z,sqrt(1.0-z*z)*sin(phi));
      float h=(floor(gl_FragCoord.y)+0.5)/64.0;
      float d=densityAt(radial*mix(uRin,uRout,h));
      gl_FragColor=vec4(d,d*3.8/(uRout-uRin),0.0,1.0);`);
    const density = [];
    for (const thickness of [30000, 56000, 93000]) {
      u.uRout.value = u.uRin.value + thickness;
      const samples = [];
      for (const altitude of [1000, 220000, 1600000]) {
        u.uCameraLocal.value.set(0, R + altitude, 0);
        samples.push(read(densityProbe));
      }
      const values = samples[0].filter((_, i) => i % 4 === 0);
      const maxDifference = Math.max(...samples.slice(1).flatMap((s) => s.map((v, i) => Math.abs(v - samples[0][i]))));
      density.push({ thickness, occupied: values.filter((v) => v > 0.01).length,
        empty: values.filter((v) => v < 0.001).length, maxDifference });
    }
    u.uRout.value = R + 68000;
    // Reintroduce the removed mapping to prove this fixture catches the bug.
    const badDensity = densityProbe.clone();
    badDensity.uniforms = densityProbe.uniforms;
    badDensity.fragmentShader = badDensity.fragmentShader.replace(
      'float shellH = (r - uRin) / (uRout - uRin);',
      `float shellH = (r - uRin) / mix(min(uRout-uRin,45000.0),uRout-uRin,
        smoothstep(220000.0,1600000.0,length(uCameraLocal)-uGroundR));`);
    if (badDensity.fragmentShader === densityProbe.fragmentShader) {
      throw Error('Camera-dependent negative control did not modify the production field');
    }
    u.uCameraLocal.value.set(0, R + 1000, 0);
    const badNear = read(badDensity);
    u.uCameraLocal.value.set(0, R + 1600000, 0);
    const badFar = read(badDensity);
    const badCameraDifference = Math.max(...badNear.map((v, i) => Math.abs(v - badFar[i])));
    badDensity.dispose();
    // The combination owner supplies per-star optical depths to the current
    // nine-argument cloudSource helper. Calling that private helper with the
    // former eight-argument ABI made this verifier fail shader compilation.
    // Preserve the fixture's points, density, stars and optical parameters.
    const lightingProbe = probe(cloud, `
      vec3 p=vec3(0.0,uRin+18000.0,0.0);
      vec3 d=normalize(vec3(0.2,1.0,0.0));
      float thick=uRout-uRin;
      vec3 s=cloudCombinedSource(p,d,0.6,thick,3.8/thick);
      gl_FragColor=vec4(s,1.0);`);
    u.uAmbC.value.setRGB(0, 0, 0);
    const body = { _invFrame: new THREE.Quaternion(), sunDirWorld: new THREE.Vector3(),
      sunDirLocal: new THREE.Vector3(), volCloudUniforms: u };
    const field = { dominantIndex: 0, sources: [
      { direction: [0, 1, 0], color: [1, 0.7, 0.3], irradianceFraction: 0.65 },
      { direction: [0.8, 0.6, 0], color: [0.3, 0.6, 1], irradianceFraction: 0.35 },
    ] };
    Planet.prototype.setStellarLights.call(body, field);
    const lit = read(lightingProbe).slice(0, 3);
    Planet.prototype.setStellarLights.call(body, { ...field, dominantIndex: 1 });
    const swapped = read(lightingProbe).slice(0, 3);
    // Swapped primary now points away from the centered occluder.
    u.uSunEnergy.value = 0;
    const single = read(lightingProbe).slice(0, 3);
    u.uEclipseEnabled.value = 1;
    u.uEclipseCenter.value.set(0, R + 30000 + 1000000, 0);
    u.uEclipseRadius.value = 50000;
    u.uEclipseStarAngle.value = 0.001;
    const totality = read(lightingProbe).slice(0, 3);
    u.uSunEnergy.value = 0.35;
    const companion = read(lightingProbe).slice(0, 3);
    u.uSecondarySunEnergy.value = 0;
    const companionOnly = read(lightingProbe).slice(0, 3);
    Planet.prototype.setStellarLights.call(body, { sources: [field.sources[0]], dominantIndex: 0 });
    const staleCompanionEnergy = u.uSecondarySunEnergy.value;
    for (const material of [densityProbe, lightingProbe, cloud]) material.dispose();
    detail.dispose(); disposeCloudNoiseTexture();
    target.dispose(); geometry.dispose(); renderer.dispose();
    return { gpu, columns, sunlightColumns, density, badCameraDifference, textureCounts, texturesAfterDispose,
      lighting: { lit, swapped, single, totality, companion, companionOnly, staleCompanionEnergy } };
  }, fixtures);
  assert.deepEqual(errors, [], 'GLSL/runtime errors');
  let maxColumnError = 0;
  result.columns.forEach((actual, i) => actual.forEach((value, c) => {
    const expected = fixtures[i].expected[c];
    const error = Math.abs(value - expected) / Math.max(expected, 100);
    maxColumnError = Math.max(maxColumnError, error);
    assert.ok(error < 0.02, `GPU ${fixtures[i].ray.name} channel ${c}: ${error}`);
  }));
  for (const field of result.density) {
    assert.ok(field.occupied > 100 && field.empty > 100, 'positive and clear-air controls required');
    assert.equal(field.maxDifference, 0, 'fixed world-point density/extinction changes with camera');
  }
  let maxSunlightError = 0;
  for (const { index, actual } of result.sunlightColumns) {
    actual.forEach((value, c) => {
      const expected = fixtures[index].expected[c];
      const error = Math.abs(value - expected) / Math.max(expected, 100);
      maxSunlightError = Math.max(maxSunlightError, error);
      assert.ok(error < 0.04, `GPU LUT ${fixtures[index].ray.name} channel ${c}: ${error}`);
    });
  }
  assert.ok(result.badCameraDifference > 0.1, 'fixture must reject the old camera-dependent field');
  assert.deepEqual(result.textureCounts, [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  assert.equal(result.texturesAfterDispose, 0);
  const { lit, swapped, single, totality, companion, companionOnly } = result.lighting;
  assert.ok(lit.every((v) => v > 0.01) && single.every((v) => v > 0.01), 'illuminated positive controls');
  assert.deepEqual(lit, swapped, 'star identity/order must not change radiance');
  assert.ok(totality.every((v) => v < 1e-7), 'totality removes direct light');
  assert.ok(companion.every((v) => v > 0.001), 'uneclipsed companion still lights clouds');
  assert.deepEqual(companion, companionOnly, 'blocked primary must add no light');
  assert.equal(result.lighting.staleCompanionEnergy, 0, 'single-star handoff must clear the old companion');
  const report = { ...result, maxColumnError, maxSunlightError,
    fingerprint: await evidenceFingerprint('tools/stagebfoundationtest.js'),
    scope: 'Column integration, legacy-fixture density invariance and stellar binding/totality controls, LUT allocation. This fixture does not supply the real production medium species/forecast inputs or accept final RGB/composition/TAA.', errors };
  await mkdir('test-results/stage-b-foundation', { recursive: true });
  await writeFile('test-results/stage-b-foundation/report.json', JSON.stringify(report, null, 2));
  console.log('PASS: production WebGL B foundation', JSON.stringify({ ...report,
    fingerprint: report.fingerprint.sourceDigest, columns: undefined, sunlightColumns: undefined }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => started.server.close(resolve));
}
