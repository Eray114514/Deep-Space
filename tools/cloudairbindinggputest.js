// Actual volume-pass ownership and native upload/output control. Probe cloud
// shaders encode bindings; they do not validate full cloud transport or FPS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/cloudairbindinggputest.js', referenceCommit = '5bc09dd';
const before = await evidenceFingerprint(verifier), hash = value => createHash('sha256').update(value).digest('hex');
const reference = execFileSync('git', ['show', `${referenceCommit}:src/volumetric-pass-webgl.js`]);
const out = `test-results/cloud-air-binding-gpu/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/verifier.js`, await readFile(verifier));
await writeFile(`${out}/reference-volume.js.gz`, gzipSync(reference));
const { server, port } = await startServer(0), errors = [], warnings = [], cases = [];
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  for (const mode of ['reference', 'current']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
      else if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.route('**/src/cloud-air-binding-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: reference }));
    await page.route('**/cloud-air-binding-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
      '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
      + '<style>body{background:#14202b;color:white;font:15px sans-serif}.row{display:flex;gap:16px;align-items:center}canvas{width:384px;height:192px;image-rendering:pixelated}p{width:300px}</style>'
      + `<h2>${mode}: cloud atmosphere binding</h2><p>Left A, right B. Red: enabled air blocker count; green: body identity; blue: air enabled. Binding probe, not cloud imagery.</p>` }));
    await page.goto(`http://127.0.0.1:${port}/cloud-air-binding-fixture.html`);
    const result = await page.evaluate(async mode => {
      const T = await import('three');
      const { Planet, setVolumetricCloudsEnabled } = await import('/src/planet.js');
      const { AtmospherePass } = await import('/src/atmosphere-pass-webgl.js');
      const { VolumetricPass } = await import(mode === 'reference' ? '/src/cloud-air-binding-reference.js' : '/src/volumetric-pass-webgl.js');
      const { installProgramRetirement } = await import('/src/program-retirement.js');
      const renderer = new T.WebGLRenderer({ antialias: false });renderer.setSize(64, 32);
      const gl = renderer.getContext(), retirement = installProgramRetirement(renderer);
      const scene = new T.Scene(), camera = new T.PerspectiveCamera(80, 2, .1, 1e9);
      camera.updateMatrixWorld(true);
      const volume = new VolumetricPass(scene, camera), atmosphere = new AtmospherePass(camera);
      volume.setSize(64, 32);volume.sceneDepthSource = atmosphere;
      const read = new T.WebGLRenderTarget(64, 32, { type: T.HalfFloatType,
        depthTexture: new T.DepthTexture(64, 32, T.UnsignedIntType) });
      const write = new T.WebGLRenderTarget(64, 32, { type: T.HalfFloatType });
      renderer.setRenderTarget(read);renderer.setClearColor(0, 1);renderer.clear(true, true, false);
      setVolumetricCloudsEnabled(true);
      const planets = [], records = [];let uploads = [];
      function makePlanet(name, x, angle, blockers, probeX, identity) {
        const planet = new Planet({ seed: `air-binding-${name}`, name,
          posUniv: new T.Vector3(x, 0, -2e7), type: 'lush', radius: 6e6,
          ringSystem: { present: false }, tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
        planets.push(planet);scene.add(planet.group);
        planet.setFrame(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), angle));
        planet.setStellarLights({ sources: [{ direction: [0, 1, 0], color: [1, .98, .94],
          distance: 1e12, radius: 2e10, irradianceFraction: 1 }], radianceScale: 3.2 });
        planet.setStellarOccluders(Array.from({ length: blockers }, (_, i) => ({
          centerLocal: new T.Vector3(x * .1 + i * 5e5, 2e7 + i * 1e5, 3e5), radius: 2e5,
        })));
        // Keep actual Planet updates, near/far selection, uniforms and pass
        // binding. Only geometry/optical shader are diagnostic output probes.
        planet.volCloudMesh.geometry.dispose();planet.volCloudMesh.geometry = new T.PlaneGeometry(2, 2);
        planet.volCloudMat.uniforms.uProbeX = { value: probeX };
        planet.volCloudMat.uniforms.uProbeIdentity = { value: identity };
        for (const material of [planet.volCloudMat, planet.volCloudFarMat]) {
          material.vertexShader = 'uniform float uProbeX;void main(){gl_Position=vec4(position.x*.5+uProbeX,position.y,0.,1.);}';
          material.fragmentShader = 'uniform float air_uEnabled,uProbeIdentity;uniform int air_uLocalOccluderCount;void main(){gl_FragColor=vec4(air_uEnabled*float(air_uLocalOccluderCount)/16.,uProbeIdentity,air_uEnabled,1.);}';
          material.transparent = false;material.blending = T.NoBlending;material.depthTest = false;material.depthWrite = false;
          material.side = T.DoubleSide;material.toneMapped = false;material.needsUpdate = true;
        }
        planet.volCloudMesh.onAfterRender = (_renderer, _scene, _camera, _geometry, material) => {
          const program = renderer.properties.get(material).currentProgram.program;
          const get = name => gl.getUniform(program, gl.getUniformLocation(program, name));
          uploads.push({ planet: name, family: material === planet.volCloudFarMat ? 'far' : 'near',
            enabled: get('air_uEnabled'), count: get('air_uLocalOccluderCount'),
            identity: get('uProbeIdentity'), engage: material.uniforms.uEngage.value,
            sharedFlag: material.uniforms.air_uEnabled === atmosphere.material.uniforms.uEnabled });
        };
        return planet;
      }
      const a = makePlanet('A', -7e6, 0, 1, -.5, .25), b = makePlanet('B', 7e6, .6, 3, .5, .75);
      const navA = new T.Vector3(-1e6, 0, 0), navB = new T.Vector3(1e6, 0, 0);
      function draw(name, active, nav, airOwner = active, update = true) {
        if (update) for (const planet of planets) {
          planet.group.position.copy(planet.posUniv).sub(nav);
          planet.update(nav.clone().sub(planet.posUniv), 1 / 60, planet === active, 0);
        }
        atmosphere.setActivePlanet(airOwner, nav);volume.setActivePlanet(active, nav);volume.resetHistory();
        const flags = atmosphere.material.uniforms.uEnabled.value;
        renderer.setRenderTarget(write);renderer.autoClear = false;renderer.setClearColor(.125, .375);
        const before = { target: renderer.getRenderTarget() === write, mask: camera.layers.mask,
          auto: renderer.autoClear, alpha: renderer.getClearAlpha(), color: renderer.getClearColor(new T.Color()).toArray() };
        uploads = [];volume.render(renderer, write, read);
        const after = { target: renderer.getRenderTarget() === write, mask: camera.layers.mask,
          auto: renderer.autoClear, alpha: renderer.getClearAlpha(), color: renderer.getClearColor(new T.Color()).toArray() };
        renderer.setRenderTarget(volume.current);
        const pixels = new Uint16Array(volume.width * volume.height * 4);
        renderer.readRenderTargetPixels(volume.current, 0, 0, volume.width, volume.height, pixels);
        const row = { name, active: active?.name || null, airOwner: airOwner?.name || null, before, after,
          atmosphereEnabledBefore: flags, atmosphereEnabledAfter: atmosphere.material.uniforms.uEnabled.value,
          uploads, native: Array.from(pixels), gl: gl.getError(), lost: gl.isContextLost() };
        records.push(row);
        const display = document.createElement('div');display.className = 'row';
        const label = document.createElement('p');label.textContent = name;display.append(label);document.body.append(display);
        const canvas = document.createElement('canvas');canvas.width = volume.width;canvas.height = volume.height;
        const context = canvas.getContext('2d'), image = context.createImageData(volume.width, volume.height);
        for (let i = 0; i < pixels.length; i++) image.data[i] = Math.round(T.DataUtils.fromHalfFloat(pixels[i]) * 255);
        context.putImageData(image, 0, 0);display.append(canvas);
      }
      draw('A initial', a, navA);
      draw('B focus, A fading', b, navB);
      draw('B repeated bindings', b, navB, b, false);
      draw('Return to A', a, navA);
      draw('Return to B', b, navB);
      draw('Mismatched atmosphere A, cloud B', b, navB, a, false);
      draw('No active cloud, both fading', null, navB, a, false);
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const result = { mode, records, width: volume.width, height: volume.height,
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
      volume.dispose();atmosphere.dispose();for (const planet of planets) planet.dispose();
      read.dispose();write.dispose();renderer.dispose();
      for (let i = 0; i < 200 && retirement.snapshot().pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
      result.retirement = retirement.snapshot();result.gl = gl.getError();result.lost = gl.isContextLost();
      setVolumetricCloudsEnabled(false);return result;
    }, mode);
    cases.push(result);await page.screenshot({ path: `${out}/${mode}.png`, fullPage: true });await page.close();
  }
  const [old, current] = cases, differences = [];
  const changed = (a, b) => a.filter((value, i) => value !== b[i]).length;
  assert.deepEqual(old.records[0].native, current.records[0].native, 'Matching owner output must remain exact');
  for (const result of cases) {
    assert.deepEqual(result.records[1].native, result.records[2].native, 'Native repeated bindings must remain exact');
    for (const row of result.records) {
      assert.deepEqual(row.after, row.before, 'Full caller state restored');
      assert.equal(row.atmosphereEnabledAfter, row.atmosphereEnabledBefore, 'Borrowed enable flag must not be mutated');
      assert.ok(!row.gl && !row.lost);
    }
    assert.ok(!result.gl && !result.lost && !result.retirement.pending && !result.retirement.faults.length);
  }
  for (let i = 0; i < current.records.length; i++) {
    const row = current.records[i], expectedOwners = i === 0 ? ['A'] : ['A', 'B'];
    assert.deepEqual(row.uploads.map(value => value.planet).sort(), expectedOwners);
    for (const upload of row.uploads) {
      const expected = upload.planet === row.active && row.active === row.airOwner ? 1 : 0;
      assert.equal(upload.enabled, expected, `${row.name}/${upload.planet}: actual GPU enable`);
      assert.equal(upload.sharedFlag, expected === 1);
      const x = upload.planet === 'A' ? Math.floor(current.width / 4) : Math.floor(3 * current.width / 4);
      const index = (Math.floor(current.height / 2) * current.width + x) * 4;
      // All probe values are exactly representable in half-float.
      const half = value => value === 0 ? 0 : value === 1 ? 15360 : value === .25 ? 13312 : value === .75 ? 14848
        : value === 1 / 16 ? 11264 : value === 3 / 16 ? 12800 : NaN;
      assert.equal(row.native[index], half(expected * upload.count / 16));
      assert.equal(row.native[index + 1], half(upload.identity));
      assert.equal(row.native[index + 2], half(expected));
      assert.equal(row.native[index + 3], half(1));
    }
    differences.push({ name: row.name, changed: changed(old.records[i].native, row.native) });
  }
  assert.equal(old.records[1].uploads.find(value => value.planet === 'A').enabled, 1, 'Old leak must reach actual GPU');
  assert.equal(old.records[1].uploads.find(value => value.planet === 'A').count, 3);
  assert.ok(differences[1].changed > 0, 'Fix must change the stale owner output');
  // The active B half is unchanged even while inactive A changes.
  for (let y = 0; y < current.height; y++) for (let x = current.width / 2; x < current.width; x++) {
    const index = (y * current.width + x) * 4;
    assert.deepEqual(old.records[1].native.slice(index, index + 4), current.records[1].native.slice(index, index + 4));
  }
  assert.deepEqual(errors, []);assert.deepEqual(warnings.filter(value => /GL_INVALID_|CONTEXT_LOST|Program object expected/.test(value)), []);
  const after = await evidenceFingerprint(verifier);assert.deepEqual(after, before);
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, referenceCommit, referenceSha256: hash(reference),
    cases, differences, errors, warnings, passed: true,
    boundary: 'Actual Planet/fade, atmosphere owner, volume pass and native ShaderMaterial uploads/draws. Probe geometry/shaders encode bindings; no full physical cloud, real player visuals or performance acceptance.' }, null, 2));
  console.log(JSON.stringify({ out, differences, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, referenceCommit, cases, errors, warnings, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
