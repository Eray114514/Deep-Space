import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const fingerprint = await evidenceFingerprint('tools/b4weathergputest.js');
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  const result = await page.evaluate(async () => {
    const THREE = NMS._THREE;
    const { sampleWeatherAtlas } = await import('/src/cloud/weather-atlas.js');
    const renderer = NMS._renderer;
    NMS.land(0);
    const p = NMS._planet(0), source = p.volCloudMat;
    const prefix = source.fragmentShader.slice(0, source.fragmentShader.lastIndexOf('void main()'));
    const geometry = new THREE.PlaneGeometry(2, 2), scene = new THREE.Scene(), camera = new THREE.Camera();
    const material = new THREE.ShaderMaterial({
      uniforms: { ...source.uniforms, uProbe: { value: new THREE.Vector3() }, uProbeMode: { value: 0 } },
      vertexShader: 'varying vec3 vDirection,vViewDirection; void main(){ vDirection=vec3(0.,1.,0.); vViewDirection=vec3(0.,0.,-1.); gl_Position=vec4(position.xy,0.,1.); }',
      fragmentShader: prefix + '\nuniform vec3 uProbe; uniform float uProbeMode; void main(){ if(uProbeMode < 0.5) gl_FragColor=vec4(textureLod(uWeatherMap,weatherAtlasUV(uSpin*uProbe),0.0).rgb,1.0); else if(uProbeMode < 1.5) gl_FragColor=vec4(densityAt(uProbe),0.0,0.0,1.0); else { float surface=(textureLod(uWeatherMapHi,weatherAtlasUV(uProbe),0.0).g*2.0-1.0)*uSurfaceRange; float lcl=350.0+textureLod(uWeatherMapHi,weatherAtlasUV(uSpin*uProbe),0.0).a*3850.0; gl_FragColor=vec4(surface,lcl,max(250.0,surface+lcl+200.0),1.0); } }',
      depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material); scene.add(mesh);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const pixels = new Float32Array(4);
    const savedTarget = renderer.getRenderTarget();
    function read(direction, mode = 0) {
      material.uniforms.uProbe.value.copy(direction);
      material.uniforms.uProbeMode.value = mode;
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixels);
      if (pixels[3] !== 1 || pixels.some((v) => !Number.isFinite(v))) throw Error('Empty/invalid GPU probe');
      return [...pixels];
    }
    let maxError = 0, gameplayError = 0, farError = 0, localBaseError = 0, cases = 0;
    const deckShader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader };
    const savedDeckShader = p.cloudMesh.material.userData.shader;
    p.cloudMesh.material.onBeforeCompile(deckShader, renderer);
    p.cloudMesh.material.userData.shader = savedDeckShader;
    const farFunctions = deckShader.fragmentShader.split('#include <common>')[1].split('#include')[0];
    const farMaterial = new THREE.ShaderMaterial({
      uniforms: { ...deckShader.uniforms, uProbe: { value: new THREE.Vector3() } },
      vertexShader: 'varying vec3 vCDir; void main(){ vCDir=vec3(0.,1.,0.); gl_Position=vec4(position.xy,0.,1.); }',
      fragmentShader: farFunctions + '\nuniform vec3 uProbe; void main(){ gl_FragColor=vec4(cloudAmount(normalize(uProbe)),0.,0.,1.); }',
      depthTest: false, depthWrite: false,
    });
    for (const spin of [0, 0.71, -3.4]) {
      material.uniforms.uSpin = { value: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(-spin)) };
      for (let i = 0; i < 134; i++) {
        const y = 1 - 2 * (i + 0.5) / 128, r = Math.sqrt(1 - y * y), phi = i * 2.399963229728653;
        const d = i < 128 ? new THREE.Vector3(r * Math.cos(phi), y, r * Math.sin(phi))
          : new THREE.Vector3(...[[1, 0.3, 1e-7], [1, 0.3, -1e-7], [-1, 0.3, 1e-7],
            [-1, 0.3, -1e-7], [0, 1, 0], [0, -1, 0]][i - 128]).normalize();
        const expected = sampleWeatherAtlas(p.cloudShadowTex.userData.weatherAtlas, d, spin);
        const actual = read(d);
        const local = read(d, 2);
        const stationary = sampleWeatherAtlas(p.cloudWeatherHiTex.userData.weatherAtlas, d);
        const advected = sampleWeatherAtlas(p.cloudWeatherHiTex.userData.weatherAtlas, d, spin);
        const surface = (stationary[1] * 2 - 1) * source.uniforms.uSurfaceRange.value;
        const lcl = 350 + advected[3] * 3850;
        localBaseError = Math.max(localBaseError,
          Math.abs(local[0] - surface), Math.abs(local[1] - lcl),
          Math.abs(local[2] - Math.max(250, surface + lcl + 200)));
        const gameplay = p.weatherAt(d, spin / p.weatherField.windRadiansPerHour);
        gameplayError = Math.max(gameplayError, Math.abs(gameplay.coverage - expected[0]));
        farMaterial.uniforms.uProbe.value.copy(d).applyMatrix3(material.uniforms.uSpin.value);
        mesh.material = farMaterial;
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixels);
        farError = Math.max(farError, Math.abs(pixels[0] - expected[0]));
        mesh.material = material;
        maxError = Math.max(maxError, ...actual.slice(0, 3).map((v, k) => Math.abs(v - expected[k])));
        cases++;
      }
    }
    // Known-bad controls: unrelated channels cannot create a cloud in R=0.
    // Conversely R=1 must generate real volume even when G/B/A are zero.
    const constant = (rgba) => {
      const tex = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
      tex.needsUpdate = true; return tex;
    };
    const clear = constant([0, 255, 255, 255]);
    const neutral = constant([0, 128, 0, 0]);
    const cloud = constant([255, 0, 0, 0]);
    const highCloud = constant([255, 128, 0, 0]);
    let clearMax = 0, cloudMax = 0, highOnlyMax = 0;
    material.uniforms.uWeatherMap = { value: clear };
    material.uniforms.uWeatherMapHi = { value: clear };
    for (let i = 0; i < 48; i++) {
      const d = new THREE.Vector3(Math.cos(i), 0.3, Math.sin(i)).normalize();
      const lowD = d.clone().multiplyScalar(source.uniforms.uBodyR.value
        + Math.max(250, source.uniforms.uSurfaceRange.value / 255 + 550) + 850);
      clearMax = Math.max(clearMax, read(lowD, 1)[0]);
      material.uniforms.uWeatherMapHi.value = neutral;
      material.uniforms.uWeatherMap.value = cloud;
      cloudMax = Math.max(cloudMax, read(lowD, 1)[0]);
      material.uniforms.uWeatherMap.value = clear;
      material.uniforms.uWeatherMapHi.value = highCloud;
      const highD = d.clone().multiplyScalar(source.uniforms.uBodyR.value + 12000);
      highOnlyMax = Math.max(highOnlyMax, read(highD, 1)[0]);
      material.uniforms.uWeatherMapHi.value = clear;
    }
    const deckSharesAtlas = p.cloudMesh.material.userData.weatherSystemTextureNode.value === p.cloudShadowTex;
    const volumeSharesAtlas = source.uniforms.uWeatherMap.value === p.cloudShadowTex;
    const firstTexture = p.cloudShadowTex;
    p.setWeatherFixture('clear');
    const fixtureRebound = p.cloudMesh.material.userData.weatherSystemTextureNode.value === p.cloudShadowTex
      && source.uniforms.uWeatherMap.value === p.cloudShadowTex && p.cloudShadowTex !== firstTexture
      && source.uniforms.uLocalBands.value === 0
      && (!p.cloudMesh.material.userData.shader?.uniforms.uLocalLayer
        || p.cloudMesh.material.userData.shader.uniforms.uLocalLayer.value === 0)
      && (!p.terrainMaterial.userData.shader
        || p.terrainMaterial.userData.shader.uniforms.uCloudTex.value === p.cloudShadowTex)
      && (!p.liquidMat?.userData.shader
        || p.liquidMat.userData.shader.uniforms.uCloudTex.value === p.cloudShadowTex);
    const fixtureWeather = p.weatherAt(new THREE.Vector3(1, 0, 0), 0);
    p.setWeatherFixture(null);
    const restoredLocal = source.uniforms.uLocalBands.value === 1
      && (!p.cloudMesh.material.userData.shader?.uniforms.uLocalLayer
        || p.cloudMesh.material.userData.shader.uniforms.uLocalLayer.value === 1);
    renderer.setRenderTarget(savedTarget);
    clear.dispose(); neutral.dispose(); cloud.dispose(); highCloud.dispose();
    material.dispose(); farMaterial.dispose(); geometry.dispose(); target.dispose();
    return { maxError, gameplayError, farError, localBaseError, cases, clearMax, cloudMax, highOnlyMax, deckSharesAtlas, volumeSharesAtlas,
      fixtureRebound, restoredLocal, fixturePrecipitation: fixtureWeather.precipitation,
      webglError: renderer.getContext().getError() };
  });
  console.log('B4 local-band controls', JSON.stringify(result));
  assert.ok(result.maxError < 0.006, `CPU/GPU bilinear atlas error ${result.maxError}`);
  assert.ok(result.farError < 0.006, `Far cloud production helper error ${result.farError}`);
  assert.ok(result.gameplayError < 1e-10, 'Gameplay must use the same field at the same absolute time');
  // The stationary surface channel is 8-bit over each body's full relief
  // range; a sub-texel CPU/GPU filter difference can move the base by ~100 m.
  assert.ok(result.localBaseError < 120, `Local surface/LCL GPU error ${result.localBaseError}m`);
  assert.equal(result.clearMax, 0, 'Empty shared weather cannot become a procedural storm');
  assert.ok(result.cloudMax > 0.1, 'Nonempty atlas must feed actual production density');
  assert.ok(result.highOnlyMax > 0.005 && result.highOnlyMax < 0.15,
    'High-only cloud must survive clear low weather without becoming an opaque low deck');
  for (const key of ['deckSharesAtlas', 'volumeSharesAtlas', 'fixtureRebound', 'restoredLocal']) assert.equal(result[key], true, key);
  assert.equal(result.fixturePrecipitation, 0);
  assert.equal(result.webglError, 0);
  assert.deepEqual(errors, []);
  const output = `test-results/b4-weather/${fingerprint.sourceDigest.slice(0, 12)}`;
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify({ fingerprint, result, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...result }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
