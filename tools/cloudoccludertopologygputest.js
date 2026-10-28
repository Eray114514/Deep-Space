// Native optical-kernel regression, using each real Planet cloud material's
// defines and shared inputs. The old Planet module is an explicit negative arm.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { cloudOcclusionCandidateSource } from './cloud-occlusion-candidate.js';

const out = `test-results/cloud-occluder-topology-gpu/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const referenceCommit = 'dfc9e5c', reference = execFileSync('git', ['show', `${referenceCommit}:src/planet.js`]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const before = await evidenceFingerprint('tools/cloudoccludertopologygputest.js');
const candidateSource = cloudOcclusionCandidateSource(await readFile('src/planet.js', 'utf8'));
const candidateHelper = await readFile('tools/cloud-occlusion-candidate.js');
await writeFile(`${out}/verifier.js`, await readFile('tools/cloudoccludertopologygputest.js'));
await writeFile(`${out}/reference-planet.js.gz`, gzipSync(reference, { level: 9 }));
await writeFile(`${out}/candidate-planet.js.gz`, gzipSync(Buffer.from(candidateSource), { level: 9 }));
await writeFile(`${out}/candidate-helper.js`, candidateHelper);
const { server, port } = await startServer(0);
const errors = [], warnings = [], cases = [];
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  for (const mode of ['reference', 'candidate']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
      else if (message.type() === 'warning') warnings.push(message.text());
    });
    if (mode === 'reference') await page.route('**/src/planet.js', route => route.fulfill({
      contentType: 'text/javascript', body: reference }));
    else await page.route('**/src/planet.js', route => route.fulfill({ contentType: 'text/javascript', body: candidateSource }));
    await page.route('**/cloud-occluder-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
      '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
      + '<style>body{background:#14202b;color:white;font:15px sans-serif}.row{display:flex;gap:16px;align-items:center}canvas{width:192px;height:192px;image-rendering:pixelated}p{width:270px}</style>'
      + `<h2>${mode}: actual Planet near / far stellar visibility</h2><p>Red: primary star, green: companion. Controlled optical kernel; no full cloud draw.</p>` }));
    await page.goto(`http://127.0.0.1:${port}/cloud-occluder-fixture.html`);
    const result = await page.evaluate(async mode => {
      const T = await import('three');
      const { Planet, setVolumetricCloudsEnabled } = await import('/src/planet.js');
      const { stellarOcclusionGLSL } = await import('/src/stellar-occlusion.js');
      const { compilePrograms } = await import('/src/program-preparation.js');
      const { installProgramRetirement } = await import('/src/program-retirement.js');
      const renderer = new T.WebGLRenderer({ antialias: false });renderer.setSize(32, 32);
      const gl = renderer.getContext(), retirement = installProgramRetirement(renderer);
      if (!gl.getExtension('EXT_color_buffer_float')) throw Error('Native Float32 color target required');
      const sources = [], shaderSource = gl.shaderSource;
      gl.shaderSource = function (shader, source) { sources.push({ source });return shaderSource.call(this, shader, source); };
      setVolumetricCloudsEnabled(true);
      const planet = new Planet({ seed: 'far-occluder-topology', name: 'Optical topology fixture',
        posUniv: new T.Vector3(), type: 'lush', radius: 6e6,
        tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
      planet.setStellarLights({ sources: [
        { direction: [0, 1, 0], color: [1, .98, .94], distance: 1e12, radius: 2e10, irradianceFraction: .7 },
        { direction: [1, 0, 0], color: [.8, .9, 1], distance: 2e12, radius: 3e10, irradianceFraction: .3 },
      ], radianceScale: 3.2 });
      const origin = new T.Vector3(0, planet.R + 20000, 0);
      const makeBlocker = (position, radius) => ({ centerLocal: origin.clone().add(new T.Vector3(...position)), radius });
      const primary = (offset, radius = 1.8e5) => makeBlocker([offset, 2e7, 0], radius);
      const companion = offset => makeBlocker([2e7, 0, offset], 1.4e5);
      const fixtures = [
        { name: 'clear', blockers: [] },
        { name: 'single-partial', blockers: [primary(1e5)] },
        { name: 'overlapping-partial', blockers: [primary(-1e5), primary(1e5)], quadrature: true },
        { name: 'separate-partial', blockers: [primary(-3.5e5), primary(3.5e5)], quadrature: true },
        { name: 'duplicate-contained', blockers: [primary(1e5), primary(1e5)] },
        { name: 'both-stars-partial', blockers: [primary(-1e5), primary(1e5), companion(-1e5), companion(1e5)], quadrature: true },
        { name: 'primary-totality', blockers: [primary(0, 1e6), companion(0)] },
        { name: 'return-to-single', blockers: [primary(1e5)] },
        { name: 'return-to-clear', blockers: [] },
      ];
      const probe = { uProbeOrigin: { value: origin }, uProbeScale: { value: 3e5 } };
      if (![planet.volCloudMat, planet.volCloudFarMat].every(material => material.fragmentShader.includes(stellarOcclusionGLSL)))
        throw Error('Fixture must use the exact stellar kernel embedded in both production cloud shaders');
      const materials = [planet.volCloudMat, planet.volCloudFarMat].map(material => new T.ShaderMaterial({
        defines: { ...material.defines }, uniforms: { ...material.uniforms, ...probe }, depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: 'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader: `precision highp float;varying vec2 vUV;uniform vec3 uProbeOrigin;uniform float uProbeScale;
          ${stellarOcclusionGLSL}
          void main(){vec3 p=uProbeOrigin+vec3((vUV.x-.5)*uProbeScale,0.,(vUV.y-.5)*uProbeScale);
            gl_FragColor=vec4(localStellarVisibility(p,normalize(uLocalStars[0].xyz)),
              localStellarVisibility(p,normalize(uLocalStars[1].xyz)),0.,1.);}`,
      }));
      const scene = new T.Scene(), mesh = new T.Mesh(new T.PlaneGeometry(2, 2), materials[0]);scene.add(mesh);
      const camera = new T.OrthographicCamera(-1, 1, 1, -1, .1, 2);camera.position.z = 1;
      const target = new T.WebGLRenderTarget(32, 32, { type: T.FloatType, depthBuffer: false });
      const records = [];
      const draw = () => {
        renderer.setRenderTarget(target);renderer.render(scene, camera);
        const pixels = new Float32Array(32 * 32 * 4);renderer.readRenderTargetPixels(target, 0, 0, 32, 32, pixels);return pixels;
      };
      for (const fixture of fixtures) {
        planet.setStellarOccluders(fixture.blockers);
        const row = { name: fixture.name, quadrature: fixture.quadrature || false,
          blockers: fixture.blockers.map(value => [...value.centerLocal.toArray(), value.radius]), families: [] };
        const display = document.createElement('div');display.className = 'row';
        const label = document.createElement('p');label.textContent = fixture.name;display.append(label);document.body.append(display);
        for (const [family, owner] of [planet.volCloudMat, planet.volCloudFarMat].entries()) {
          const material = materials[family];material.defines = { ...owner.defines };material.needsUpdate = true;mesh.material = material;
          renderer.setRenderTarget(target);await compilePrograms(renderer, mesh, camera, scene);
          const pixels = draw(), repeat = draw();
          if (pixels.some((value, i) => !Number.isFinite(value) || value !== repeat[i])) throw Error('Native finite/repeat failure');
          const program = renderer.properties.get(material).currentProgram.program;
          const uploadedCount = gl.getUniform(program, gl.getUniformLocation(program, 'uLocalOccluderCount'));
          const uploadedStars = gl.getUniform(program, gl.getUniformLocation(program, 'uLocalStarCount'));
          const channels = [0, 1].map(channel => {
            const values = Array.from({ length: 1024 }, (_, i) => pixels[i * 4 + channel]);
            return { minimum: Math.min(...values), maximum: Math.max(...values), partial: values.filter(value => value > 0 && value < 1).length };
          });
          row.families.push({ family: family ? 'far' : 'near', defines: { ...material.defines }, uploadedCount, uploadedStars,
            channels, pixels: Array.from(pixels), repeatChanged: 0 });
          const canvas = document.createElement('canvas');canvas.width = 32;canvas.height = 32;
          const context = canvas.getContext('2d'), image = context.createImageData(32, 32);
          for (let i = 0; i < pixels.length; i++) image.data[i] = i % 4 === 3 ? 255 : Math.round(pixels[i] * 255);
          context.putImageData(image, 0, 0);display.append(canvas);
        }
        records.push(row);
      }
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const result = { mode, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, records, nativeSources: sources,
        gl: gl.getError(), lost: gl.isContextLost(), sharedUniforms: planet.volCloudMat.uniforms === planet.volCloudFarMat.uniforms,
        boundary: 'Production stellar GLSL with actual Planet topology/inputs. Output contains only stellar visibility; no full cloud transport or player performance acceptance.' };
      for (const material of materials) material.dispose();mesh.geometry.dispose();target.dispose();planet.dispose();renderer.dispose();
      for (let i = 0; i < 200 && retirement.snapshot().pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
      result.retirement = retirement.snapshot();result.finalGL = gl.getError();result.finalLost = gl.isContextLost();return result;
    }, mode);
    cases.push(result);await page.screenshot({ path: `${out}/${mode}.png`, fullPage: true });await page.close();
  }
  const comparisons = [];
  for (let i = 0; i < cases[0].records.length; i++) {
    const old = cases[0].records[i], current = cases[1].records[i];
    assert.deepEqual(old.families[0].pixels, current.families[0].pixels, `${old.name}: near unchanged`);
    assert.deepEqual(current.families[0].pixels, current.families[1].pixels, `${old.name}: near/far exact`);
    assert.ok(current.families.every(value => value.uploadedCount === current.blockers.length && value.uploadedStars === 2));
    const changed = old.families[1].pixels.filter((value, j) => value !== current.families[1].pixels[j]).length;
    if (old.blockers.length > 1) assert.ok(changed > 0, `${old.name}: real old far negative must differ`);
    else assert.equal(changed, 0, `${old.name}: unaffected topology`);
    if (current.quadrature) assert.ok(current.families[1].channels[0].partial > 0, `${old.name}: actual partial union samples`);
    if (current.name === 'both-stars-partial') assert.ok(current.families[1].channels.every(value => value.partial > 0));
    comparisons.push({ name: current.name, nearChanged: 0, currentNearFarChanged: 0, oldFarChanged: changed });
  }
  assert.ok(cases.every(value => value.sharedUniforms && !value.gl && !value.lost && !value.finalGL && !value.finalLost
    && !value.retirement.pending && !value.retirement.faults.length));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter(value => /GL_INVALID_|CONTEXT_LOST/.test(value)), []);
  const after = await evidenceFingerprint('tools/cloudoccludertopologygputest.js');assert.deepEqual(after, before);
  assert.deepEqual(await readFile('tools/cloud-occlusion-candidate.js'), candidateHelper);
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, installedInRuntime: false,
    candidateSha256: hash(candidateSource), candidateHelperSha256: hash(candidateHelper),
    referenceCommit, referenceSha256: hash(reference), cases, comparisons, errors, warnings, passed: true }, null, 2));
  console.log(JSON.stringify({ out, comparisons, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, cases, errors, warnings, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();server.close(); }
