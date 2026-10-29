// Same stellar quadrature in actual Planet near/far inputs and the atmosphere
// namespace. Both arms include the separate Far topology correction, so this
// comparison isolates loop structure, not the known macro omission.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { cloudOcclusionCandidateSource } from './cloud-occlusion-candidate.js';
import { stellarDiscLoopCandidateSource } from './stellar-disc-loop-candidate.js';
import { stellarBlockerLoopCandidateSource } from './stellar-blocker-loop-candidate.js';

const variant = process.argv.find(arg => arg.startsWith('--variant='))?.slice(10) || 'uniform64';
assert.ok(['uniform64', 'blockers', 'combined'].includes(variant), 'Unknown stellar loop variant');
const uniformSamples = variant !== 'blockers', dynamicBlockers = variant !== 'uniform64';
const out = `test-results/stellar-disc-loop-gpu/${variant}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
// Set before any GPU capture. Fixed versus uniform loops may evaluate sin/cos
// with different rounding. Preserve exact differences alongside this optical
// visibility tolerance; native repeats/restoration must still be exact.
const opticalTolerance = 1e-6;
const verifier = 'tools/stellardiscloopgputest.js', hash = bytes => createHash('sha256').update(bytes).digest('hex');
const before = await evidenceFingerprint(verifier);
const reference = await readFile('src/stellar-occlusion.js', 'utf8');
let candidate = reference;
if (uniformSamples) candidate = stellarDiscLoopCandidateSource(candidate);
if (dynamicBlockers) candidate = stellarBlockerLoopCandidateSource(candidate);
const planet = cloudOcclusionCandidateSource(await readFile('src/planet.js', 'utf8'));
const helpers = {};
for (const path of ['tools/stellar-disc-loop-candidate.js', 'tools/stellar-blocker-loop-candidate.js', 'tools/cloud-occlusion-candidate.js',
  'tools/browser.js', 'tools/server.js', 'tools/evidence-fingerprint.js']) {
  helpers[path] = await readFile(path);
  await writeFile(`${out}/${path.slice(6)}`, helpers[path]);
}
await writeFile(`${out}/verifier.js`, await readFile(verifier));
for (const [name, source] of [['reference-stellar', reference], ['candidate-stellar', candidate], ['shared-candidate-planet', planet]])
  await writeFile(`${out}/${name}.js.gz`, gzipSync(Buffer.from(source), { level: 9 }));
const provenance = { installedInRuntime: false, variant, uniformSamples, dynamicBlockers,
  referenceStellarSha256: hash(reference),
  candidateStellarSha256: hash(candidate), sharedPlanetSha256: hash(planet),
  opticalTolerance,
  helpers: Object.fromEntries(Object.entries(helpers).map(([path, bytes]) => [path, hash(bytes)])),
  boundary: 'Both arms serve corrected Far topology. Candidate ' + variant + ' changes '
    + (uniformSamples ? 'the two stellar sample-loop bounds to owned uniforms fixed at 64' : '')
    + (uniformSamples && dynamicBlockers ? ' and ' : '')
    + (dynamicBlockers ? 'the collection/containment/coverage bounds to dynamic counts capped at16' : '')
    + '. Sample positions,64-point divisor,blocker order and body arithmetic are retained. No full cloud transport or player performance acceptance.' };
const { server, port } = await startServer(0);
const errors = [], warnings = [], cases = [];
let browser, page;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  for (const mode of ['reference', 'candidate']) {
    page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
      else if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.route('**/src/planet.js', route => route.fulfill({ contentType: 'text/javascript', body: planet }));
    await page.route('**/src/stellar-occlusion.js', route => route.fulfill({
      contentType: 'text/javascript', body: mode === 'candidate' ? candidate : reference }));
    await page.route('**/stellar-disc-loop-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
      '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
      + '<style>body{background:#14202b;color:white;font:15px sans-serif}.row{display:flex;gap:16px;align-items:center}canvas{width:192px;height:192px;image-rendering:pixelated}p{width:270px}</style>'
      + `<h2>${mode}: ${variant}, same 64 stellar samples</h2><p>Near / far: red primary, green companion. Native RGBA also checks both atmosphere channels.</p>` }));
    await page.goto(`http://127.0.0.1:${port}/stellar-disc-loop-fixture.html`);
    const result = await page.evaluate(async ({ mode, variant, uniformSamples, dynamicBlockers }) => {
      const T = await import('three');
      const { Planet, setVolumetricCloudsEnabled } = await import('/src/planet.js');
      const { stellarOcclusionGLSL, bindStellarOcclusion } = await import('/src/stellar-occlusion.js');
      const { atmosphereUniforms } = await import('/src/atmosphere-uniforms.js');
      const { cloudAtmosphereGLSL } = await import('/src/atmosphere-transport-glsl.js');
      const { compilePrograms } = await import('/src/program-preparation.js');
      const { installProgramRetirement } = await import('/src/program-retirement.js');
      const renderer = new T.WebGLRenderer({ antialias: false });renderer.setSize(32, 32);
      const gl = renderer.getContext(), retirement = installProgramRetirement(renderer);
      if (!gl.getExtension('EXT_color_buffer_float')) throw Error('Native Float32 color target required');
      const nativeSources = [], shaderSource = gl.shaderSource;
      gl.shaderSource = function (shader, source) { nativeSources.push({ source });return shaderSource.call(this, shader, source); };
      setVolumetricCloudsEnabled(true);
      const planet = new Planet({ seed: 'far-occluder-topology', name: 'Stellar quadrature fixture',
        posUniv: new T.Vector3(), type: 'lush', radius: 6e6,
        tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
      planet.setStellarLights({ sources: [
        { direction: [0, 1, 0], color: [1, .98, .94], distance: 1e12, radius: 2e10, irradianceFraction: .7 },
        { direction: [1, 0, 0], color: [.8, .9, 1], distance: 2e12, radius: 3e10, irradianceFraction: .3 },
      ], radianceScale: 3.2 });
      const origin = new T.Vector3(0, planet.R + 20000, 0);
      const makeBlocker = (position, radius) => ({ centerLocal: origin.clone().add(new T.Vector3(...position)), radius });
      const primary = (offset, radius = 1.8e5) => makeBlocker([offset, 2e7, 0], radius);
      const companion = (offset, radius = 1.4e5) => makeBlocker([2e7, 0, offset], radius);
      const fixtures = [
        { name: 'clear', blockers: [] },
        { name: 'single-partial', blockers: [primary(1e5)] },
        { name: 'overlapping-partial', blockers: [primary(-1e5), primary(1e5)], quadrature: true, blockerNegative: true },
        { name: 'separate-partial', blockers: [primary(-3.5e5), primary(3.5e5)], quadrature: true },
        { name: 'duplicate-contained', blockers: [primary(1e5), primary(1e5)] },
        { name: 'nested-large-first', blockers: [primary(1e5, 2e5), primary(1e5, 1e5)] },
        { name: 'nested-small-first', blockers: [primary(1e5, 1e5), primary(1e5, 2e5)] },
        { name: 'both-stars-partial', blockers: [primary(-1e5), primary(1e5), companion(-1e5), companion(1e5)], quadrature: true, blockerNegative: true },
        { name: 'moving-partial', blockers: [primary(-.8e5), primary(1.4e5)], quadrature: true },
        { name: 'capacity-sixteen', blockers: Array.from({ length: 16 }, (_, i) =>
          (i < 8 ? primary : companion)(((i % 8) - 3.5) * .85e5, .6e5 + (i % 2) * .1e5)), quadrature: true },
        { name: 'primary-sixteen-noncontained', blockers: Array.from({ length: 16 }, (_, i) =>
          makeBlocker([2.4e5 * Math.cos(i * Math.PI / 8), 2e7, 2.4e5 * Math.sin(i * Math.PI / 8)], 4e4)),
        quadrature: true, blockerNegative: true },
        { name: 'primary-totality', blockers: [primary(0, 1e6), companion(0)] },
        { name: 'return-to-single', blockers: [primary(1e5)] },
        { name: 'return-to-clear', blockers: [] },
      ];
      const probe = { uProbeOrigin: { value: origin }, uProbeScale: { value: 3e5 } };
      // A fixture construction check at the four central native pixel centres:
      // all16 primary discs intersect the star, none gives totality and none is
      // contained. The split-star fixture above only retains8 per star.
      const capacityFixture = fixtures.find(fixture => fixture.name === 'primary-sixteen-noncontained');
      const capacityChecks = [];
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
        const position = origin.clone().add(new T.Vector3(dx * 3e5 / 64, 0, dz * 3e5 / 64));
        const star = planet.volCloudMat.uniforms.uLocalStars.value[0];
        const delta = new T.Vector3(star.x, star.y, star.z).sub(position), distance = delta.length();
        const starAngle = Math.asin(star.w / distance), sun = delta.multiplyScalar(1 / distance);
        const axis = Math.abs(sun.y) < .9 ? new T.Vector3(0, 1, 0) : new T.Vector3(1, 0, 0);
        const x = new T.Vector3().crossVectors(sun, axis).normalize(), y = new T.Vector3().crossVectors(sun, x);
        const discs = [];
        for (const blocker of capacityFixture.blockers) {
          const vector = blocker.centerLocal.clone().sub(position), d = vector.length(), along = vector.dot(sun);
          if (d <= blocker.radius || along <= 0 || along >= distance) throw Error('Invalid capacity fixture blocker');
          const angle = Math.asin(blocker.radius / d), normal = vector.multiplyScalar(1 / d);
          const separation = Math.acos(Math.max(-1, Math.min(1, normal.dot(sun))));
          if (separation >= angle + starAngle || angle >= separation + starAngle) throw Error('Capacity fixture must retain every partial disc');
          const nx = normal.dot(x), ny = normal.dot(y), scale = separation / Math.max(Math.hypot(nx, ny), 1e-9);
          const disc = new T.Vector3(nx * scale, ny * scale, angle);
          if (discs.some(old => Math.hypot(disc.x - old.x, disc.y - old.y) + disc.z <= old.z + 1e-7))
            throw Error('Capacity fixture disc unexpectedly contained');
          discs.push(disc);
        }
        capacityChecks.push({ dx, dz, retainedDiscs: discs.length });
      }
      const air = atmosphereUniforms();
      const owners = [planet.volCloudMat, planet.volCloudFarMat];
      if (!owners.every(material => material.fragmentShader.includes(stellarOcclusionGLSL)
        && material.fragmentShader.includes(cloudAtmosphereGLSL))) throw Error('Actual cloud stellar/air kernel identity changed');
      const initialSamples = owners.map(material => ({ cloud: material.uniforms.uStellarDiscSamples?.value ?? null,
        air: material.uniforms.air_uStellarDiscSamples?.value ?? null }));
      // Reproduce the actual volume-pass air uniform binding using the actual
      // atmosphere factory. Both namespaces receive the same physical inputs.
      const materials = owners.map(material => new T.ShaderMaterial({
        defines: { ...material.defines }, uniforms: { ...material.uniforms,
          ...Object.fromEntries(Object.entries(air).map(([name, uniform]) => ['air_' + name, uniform])), ...probe },
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: 'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader: `precision highp float;varying vec2 vUV;uniform vec3 uProbeOrigin;uniform float uProbeScale;
          ${stellarOcclusionGLSL}
          ${cloudAtmosphereGLSL}
          void main(){vec3 p=uProbeOrigin+vec3((vUV.x-.5)*uProbeScale,0.,(vUV.y-.5)*uProbeScale);
            gl_FragColor=vec4(localStellarVisibility(p,normalize(uLocalStars[0].xyz)),
              localStellarVisibility(p,normalize(uLocalStars[1].xyz)),
              air_localStellarVisibility(p,normalize(air_uLocalStars[0].xyz)),
              air_localStellarVisibility(p,normalize(air_uLocalStars[1].xyz)));}`,
      }));
      const scene = new T.Scene(), mesh = new T.Mesh(new T.PlaneGeometry(2, 2), materials[0]);scene.add(mesh);
      const camera = new T.OrthographicCamera(-1, 1, 1, -1, .1, 2);camera.position.z = 1;
      const target = new T.WebGLRenderTarget(32, 32, { type: T.FloatType, depthBuffer: false });
      const records = [];
      window.__stellarDiscLoopDiagnostic = { mode, variant, records, nativeSources, initialSamples, capacityChecks };
      const draw = () => {
        renderer.setRenderTarget(target);renderer.render(scene, camera);
        const pixels = new Float32Array(32 * 32 * 4);renderer.readRenderTargetPixels(target, 0, 0, 32, 32, pixels);return pixels;
      };
      const changes = (a, b) => a.reduce((count, value, i) => count + (value !== b[i] ? 1 : 0), 0);
      const difference = (a, b) => ({ changed: changes(a, b),
        maximumError: a.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - b[i])), 0) });
      for (const fixture of fixtures) {
        planet.setStellarOccluders(fixture.blockers);bindStellarOcclusion(air, planet);
        const row = { name: fixture.name, quadrature: fixture.quadrature || false, blockerNegative: fixture.blockerNegative || false,
          blockers: fixture.blockers.map(value => [...value.centerLocal.toArray(), value.radius]), families: [] };
        records.push(row);
        const display = document.createElement('div');display.className = 'row';
        const label = document.createElement('p');label.textContent = fixture.name;display.append(label);document.body.append(display);
        for (const [family, owner] of owners.entries()) {
          const material = materials[family];material.defines = { ...owner.defines };material.needsUpdate = true;mesh.material = material;
          renderer.setRenderTarget(target);await compilePrograms(renderer, mesh, camera, scene);
          const pixels = draw(), repeat = draw();
          if (pixels.some((value, i) => !Number.isFinite(value) || value !== repeat[i])) throw Error('Native finite/repeat failure');
          const plain = Array.from(pixels).filter((_, i) => i % 4 < 2);
          const namespaced = Array.from(pixels).filter((_, i) => i % 4 > 1);
          const cloudAir = difference(plain, namespaced);
          const program = renderer.properties.get(material).currentProgram.program;
          const get = name => {
            const location = gl.getUniformLocation(program, name);
            return location === null ? null : gl.getUniform(program, location);
          };
          const uploads = Object.fromEntries(['uLocalOccluderCount', 'uLocalStarCount', 'uStellarDiscSamples',
            'air_uLocalOccluderCount', 'air_uLocalStarCount', 'air_uStellarDiscSamples'].map(name => [name, get(name)]));
          const negatives = [];
          const negativeInputs = [];
          if (mode === 'candidate' && uniformSamples && fixture.quadrature)
            for (const name of ['uStellarDiscSamples', 'air_uStellarDiscSamples'])
              negativeInputs.push({ name, kind: 'sample-count', value: 32, restore: 64 });
          if (mode === 'candidate' && dynamicBlockers && fixture.blockerNegative)
            for (const name of ['uLocalOccluderCount', 'air_uLocalOccluderCount'])
              negativeInputs.push({ name, kind: 'blocker-count', value: 1, restore: fixture.blockers.length });
          for (const { name, kind, value, restore } of negativeInputs) {
            material.uniforms[name].value = value;material.uniformsNeedUpdate = true;
            const wrong = draw(), uploaded = get(name);
            material.uniforms[name].value = restore;material.uniformsNeedUpdate = true;
            const restored = draw();
            if (changes(pixels, restored)) throw Error('Negative control restoration changed native output');
            negatives.push({ uniform: name, kind, expectedUpload: value, uploaded,
              restoredUpload: get(name), ...difference(pixels, wrong), restoredChanged: 0 });
          }
          const channels = [0, 1, 2, 3].map(channel => {
            const values = Array.from({ length: 1024 }, (_, i) => pixels[i * 4 + channel]);
            return { minimum: Math.min(...values), maximum: Math.max(...values), partial: values.filter(value => value > 0 && value < 1).length };
          });
          row.families.push({ family: family ? 'far' : 'near', defines: { ...material.defines }, uploads,
            channels, pixels: Array.from(pixels), repeatChanged: 0, cloudAir, negatives });
          const canvas = document.createElement('canvas');canvas.width = 32;canvas.height = 32;
          const context = canvas.getContext('2d'), image = context.createImageData(32, 32);
          for (let i = 0; i < pixels.length; i++) image.data[i] = i % 4 === 3 ? 255 : i % 4 === 2 ? 0 : Math.round(pixels[i] * 255);
          context.putImageData(image, 0, 0);display.append(canvas);
        }
      }
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const result = { mode, variant, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        records, nativeSources, initialSamples, capacityChecks, gl: gl.getError(), lost: gl.isContextLost(),
        sharedUniforms: planet.volCloudMat.uniforms === planet.volCloudFarMat.uniforms };
      for (const material of materials) material.dispose();mesh.geometry.dispose();target.dispose();planet.dispose();renderer.dispose();
      for (let i = 0; i < 200 && retirement.snapshot().pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
      result.retirement = retirement.snapshot();result.finalGL = gl.getError();result.finalLost = gl.isContextLost();return result;
    }, { mode, variant, uniformSamples, dynamicBlockers });
    cases.push(result);await page.screenshot({ path: `${out}/${mode}.png`, fullPage: true });await page.close();
  }
  const comparisons = [];
  const compare = (a, b) => {
    assert.equal(a.length, b.length);
    return { changed: a.reduce((count, value, i) => count + (value !== b[i] ? 1 : 0), 0),
      maximumError: a.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - b[i])), 0) };
  };
  const expectedSamples = uniformSamples ? 64 : null;
  assert.ok(cases[1].initialSamples.every(value => value.cloud === expectedSamples && value.air === expectedSamples));
  assert.ok(cases.every(arm => arm.capacityChecks.length === 4 && arm.capacityChecks.every(value => value.retainedDiscs === 16)));
  assert.equal(cases[0].records.length, 14);assert.equal(cases[1].records.length, 14);
  for (let i = 0; i < cases[0].records.length; i++) {
    const old = cases[0].records[i], current = cases[1].records[i];assert.equal(old.name, current.name);
    assert.deepEqual(old.blockers, current.blockers);
    const oldNew = [];
    for (let family = 0; family < 2; family++) {
      const delta = compare(old.families[family].pixels, current.families[family].pixels);oldNew.push(delta);
      assert.ok(delta.maximumError <= opticalTolerance, `${old.name}: native64 optical tolerance`);
      for (const arm of [old, current]) {
        const value = arm.families[family];
        assert.ok(value.cloudAir.maximumError <= opticalTolerance, `${old.name}: cloud/air optical tolerance`);
        assert.equal(value.defines.STELLAR_UNION_OCCLUSION, current.blockers.length > 1 ? 1 : 0);
        for (const prefix of ['', 'air_']) {
          assert.equal(value.uploads[prefix + 'uLocalOccluderCount'], current.blockers.length);
          assert.equal(value.uploads[prefix + 'uLocalStarCount'], 2);
        }
      }
      const value = current.families[family];
      for (const name of ['uStellarDiscSamples', 'air_uStellarDiscSamples'])
        assert.equal(value.uploads[name], uniformSamples && current.blockers.length > 1 ? 64 : null, `${old.name}: actual ${name}`);
      const expectedNegatives = (uniformSamples && current.quadrature ? 2 : 0)
        + (dynamicBlockers && current.blockerNegative ? 2 : 0);
      assert.equal(value.negatives.length, expectedNegatives);
      for (const negative of value.negatives) {
        const samples = negative.kind === 'sample-count';
        assert.equal(negative.expectedUpload, samples ? 32 : 1);
        assert.equal(negative.uploaded, samples ? 32 : 1);
        assert.equal(negative.restoredUpload, samples ? 64 : current.blockers.length);
        assert.ok(negative.maximumError > opticalTolerance && !negative.restoredChanged,
          `${old.name}: ${negative.uniform} must reject truncated ${negative.kind}`);
      }
      if (current.quadrature) {
        assert.ok(value.channels[0].partial > 0 && value.channels[2].partial > 0);
      }
      if (current.name === 'both-stars-partial') assert.ok(value.channels.every(channel => channel.partial > 0));
    }
    const nearFar = [old, current].map(arm => compare(arm.families[0].pixels, arm.families[1].pixels));
    assert.ok(nearFar.every(delta => delta.maximumError <= opticalTolerance), `${old.name}: near/far optical tolerance`);
    comparisons.push({ name: current.name, cloudAir: [old, current].map(arm => arm.families.map(value => value.cloudAir)),
      nearFar, oldNew,
      negatives: current.families.map(value => value.negatives) });
  }
  assert.ok(cases.every(value => value.sharedUniforms && !value.gl && !value.lost && !value.finalGL && !value.finalLost
    && !value.retirement.pending && !value.retirement.faults.length));
  assert.deepEqual(errors, []);assert.deepEqual(warnings.filter(value => /GL_INVALID_|CONTEXT_LOST/.test(value)), []);
  const after = await evidenceFingerprint(verifier);assert.deepEqual(after, before);
  for (const [path, bytes] of Object.entries(helpers)) assert.deepEqual(await readFile(path), bytes);
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, ...provenance,
    cases, comparisons, errors, warnings, passed: true }, null, 2));
  console.log(JSON.stringify({ out, comparisons, passed: true }));
} catch (error) {
  const partial = await page?.evaluate(() => window.__stellarDiscLoopDiagnostic).catch(() => null);
  await page?.screenshot({ path: `${out}/failure.png`, fullPage: true, timeout: 30000 }).catch(() => {});
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, ...provenance,
    cases, partial, errors, warnings, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
