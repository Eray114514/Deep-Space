// Fresh surface preparation identity, native HDR and physical input coverage.
// Optional --candidate-dir permits isolated ignored candidates without install.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/surfaceprepareidentitygputest.js';
const directory = `test-results/surface-prepare-identity/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const referenceRef = arg('reference-ref') || '6c5124f', candidateDirectory = arg('candidate-dir');
const referenceCommit = execFileSync('git', ['rev-parse', `${referenceRef}^{commit}`], { encoding: 'utf8' }).trim();
const modules = ['stellar-occlusion.js', 'render-prewarm.js'], original = {}, candidate = {};
const hash = value => createHash('sha256').update(value).digest('hex');
await mkdir(`${directory}/inputs`, { recursive: true });
const bytes = await readFile(new URL(import.meta.url));await writeFile(`${directory}/verifier.js`, bytes);
const classifierPath = 'tools/surface-preparation-control.js', classifierBytes = await readFile(classifierPath);
const { classifySurfacePreparationPair } = await import('./surface-preparation-control.js');
await writeFile(`${directory}/surface-preparation-control.js`, classifierBytes);
for (const name of modules) {
  original[name] = execFileSync('git', ['show', `${referenceCommit}:src/${name}`]);
  candidate[name] = await readFile(candidateDirectory ? path.join(candidateDirectory, name) : `src/${name}`);
  await writeFile(`${directory}/inputs/reference-${name}`, original[name]);await writeFile(`${directory}/inputs/candidate-${name}`, candidate[name]);
}
const report = { scope: 'Fresh actual Planet terrain/water, HDR+SCREEN1 preparation-to-draw identity, exact known-reference selector-order transition, three native RGBA16F draws and controlled single-star 0/1/2 physical occluders. Candidate retains strict initial/repeat identity. No prebinding. Not cloud-column throughput, destination whole-scene preparation, whole-player or cold-performance acceptance.',
  reference: { ref: referenceRef, commit: referenceCommit }, candidate: { directory: candidateDirectory || 'installed src/' },
  verifier: { sha256: hash(bytes), path: `${directory}/verifier.js` },
  classifier: { sha256: hash(classifierBytes), path: `${directory}/surface-preparation-control.js` },
  before: await evidenceFingerprint(verifier), errors: [], warnings: [], driverWarnings: [], pages: [], comparisons: [] };
let browser, server, implementation = 'reference';
try {
  assert.ok(!original['render-prewarm.js'].includes(Buffer.from('selectStellarOcclusionVariant')), 'Reference must retain the original missing macro preparation');
  assert.ok(candidate['stellar-occlusion.js'].includes(Buffer.from('export function selectStellarOcclusionVariant(')),
    'Install candidate or pass --candidate-dir=test-results/surface-preparation-dependency-6c5124f/candidate');
  assert.ok(candidate['render-prewarm.js'].includes(Buffer.from('selectStellarOcclusionVariant(material,owner)')));
  const manifest = [], digests = { reference: createHash('sha256'), candidate: createHash('sha256') };
  for (const file of report.before.sourceFiles) {
    const installed = await readFile(file), name = file.startsWith('src/') ? file.slice(4) : null;
    const old = original[name] || installed, next = candidate[name] || installed;
    manifest.push({ path: file, installedSha256: hash(installed), referenceSha256: hash(old), candidateSha256: hash(next) });
    for (const [kind, value] of [['reference', old], ['candidate', next]]) digests[kind].update(`${file}\0${value.length}\0`).update(value);
  }
  report.reference.effectiveSourceDigest = digests.reference.digest('hex');report.candidate.effectiveSourceDigest = digests.candidate.digest('hex');
  report.moduleInputs = modules.map(name => ({ name, referenceSha256: hash(original[name]), candidateSha256: hash(candidate[name]) }));
  const stellarTail = value => value.toString('utf8').replace(/\r\n/g, '\n').split('export const stellarOcclusionGLSL')[1];
  assert.equal(stellarTail(original['stellar-occlusion.js']), stellarTail(candidate['stellar-occlusion.js']), 'No optical GLSL edits');
  await writeFile(`${directory}/inputs/dependency-manifest.json`, JSON.stringify(manifest, null, 2));
  const serving = await startServer(0);server = serving.server;
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  report.browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });page.setDefaultTimeout(240000);
  page.on('pageerror', error => report.errors.push({ implementation, text: String(error) }));
  page.on('console', message => {
    const row = { implementation, text: message.text() };
    if (message.type() === 'error') report.errors.push(row);
    else if (message.type() === 'warning') {
      report.warnings.push(row);
      if (/GL_INVALID|GL_CONTEXT_LOST|Program object expected|INVALID_(?:ENUM|VALUE|OPERATION)|GL_OUT_OF_MEMORY|WebGL.*(?:error|lost)/i.test(row.text)) report.driverWarnings.push(row);
    }
  });
  await page.route('**/__surface-prepare-identity*', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>' }));
  for (const name of modules) await page.route(`**/src/${name}`, route => route.fulfill({ contentType: 'application/javascript',
    body: (implementation === 'reference' ? original : candidate)[name] }));
  for (implementation of ['reference', 'candidate']) {
    await page.goto(`http://127.0.0.1:${serving.port}/__surface-prepare-identity?vclouds=1&implementation=${implementation}`);
    const result = await page.evaluate(async implementation => {
      const T = await import('three');
      const { Planet } = await import('/src/planet.js');
      const { createGameRenderer } = await import('/src/renderer-runtime.js');
      const { compilePrograms } = await import('/src/program-preparation.js');
      const { withSurfaceWarmupVariant } = await import('/src/render-prewarm.js');
      const result = { implementation, cases: [], checks: [], gl: [], sources: {}, shaderErrors: [], contextLosses: [],
        input: { width: 32, height: 32, seed: 'surface-program-key-physical', radiusMeters: 6e6, cloudCoverage: .64,
          freshPlanetPerControl: true, materialFamilies: ['terrain', 'water'], blockers: [0, 1, 2],
          noPrebinding: true, worldHours: 0, worker: false, source: 'Real root meshes with nonempty positions; constructor empty near-water patch explicitly excluded',
          starDistanceMeters: 1e12, starRadiusMeters: 2e10, blockerDistanceFromVisibleSurfaceMeters: 2e7,
          blockerRadiusMeters: 8e5, blockerTangentOffsetsMeters: [-350000, 350000] } };
      const check = (name, passed) => result.checks.push({ name, passed: Boolean(passed) });
      let r, gl, target;const live = [], geometries = [], nativeIds = new WeakMap();let nextId = 1;
      const id = value => { if (!nativeIds.has(value)) nativeIds.set(value, nextId++);return nativeIds.get(value); };
      const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(value => value.toString(16).padStart(2, '0')).join('');
      const checkpoint = name => {
        const errors = [];for (let i = 0; i < 16; i++) { const value = gl.getError();if (!value) break;errors.push(value); }
        const lost = gl.isContextLost();result.gl.push({ name, errors, lost });check(`GL/context ${name}`, !errors.length && !lost);
      };
      const read = () => { const value = new Uint16Array(32 * 32 * 4);r.readRenderTargetPixels(target, 0, 0, 32, 32, value);return value; };
      const changed = (a, b) => a.reduce((sum, value, i) => sum + Number(value !== b[i]), 0);
      const meta = (value, clear) => {
        let nonfinite = 0, nonclearRgb = 0, nonzeroRgb = 0;const red = new Set();
        value.forEach((bits, i) => { const x = T.DataUtils.fromHalfFloat(bits);nonfinite += Number(!Number.isFinite(x));
          if (i % 4 !== 3) { nonclearRgb += Number(bits !== clear[i]);nonzeroRgb += Number(x !== 0); }if (i % 4 === 0) red.add(bits); });
        return { nonfinite, nonclearRgb, nonzeroRgb, distinctRed: red.size };
      };
      const programs = material => [...(r.properties.get(material).programs?.values() || [])];
      const snapshot = async material => {
        const rows = [];
        for (const program of programs(material)) {
          const vertex = gl.getShaderSource(program.vertexShader), fragment = gl.getShaderSource(program.fragmentShader);
          const vertexSha256 = await sha(vertex || ''), fragmentSha256 = await sha(fragment || '');
          result.sources[vertexSha256] = vertex;result.sources[fragmentSha256] = fragment;
          const uniform = name => { const location = gl.getUniformLocation(program.program, name);return location ? gl.getUniform(program.program, location) : null; };
          rows.push({ id: program.id, nativeId: id(program.program), cacheKey: program.cacheKey,
            linkStatus: gl.getProgramParameter(program.program, gl.LINK_STATUS), vertexSha256, fragmentSha256,
            unionDefine: fragment?.match(/^#define STELLAR_UNION_OCCLUSION ([01])$/m)?.[1] ?? null,
            screenDefine: fragment?.match(/^#define SURFACE_CLOUD_SCREEN ([01])$/m)?.[1] ?? null,
            uploaded: { starCount: uniform('uLocalStarCount'), blockerCount: uniform('uLocalOccluderCount'),
              star: Array.from(uniform('uLocalStars[0]') || []), blockers: [0, 1].map(i => Array.from(uniform(`uLocalOccluders[${i}]`) || [])) } });
        }
        return rows;
      };
      try {
        const canvas = document.querySelector('#fixture');canvas.addEventListener('webglcontextlost', event => result.contextLosses.push({ timeStamp: event.timeStamp, statusMessage: event.statusMessage }));
        ({ renderer: r } = await createGameRenderer({}, { canvas, logarithmicDepthBuffer: true, antialias: false }));
        gl = r.getContext();r.setPixelRatio(1);r.setSize(32, 32);r.setClearColor(0x15202b, 0);r.shadowMap.enabled = false;r.toneMapping = T.ACESFilmicToneMapping;
        r.debug.checkShaderErrors = true;r.debug.onShaderError = (context, program, vertex, fragment) => result.shaderErrors.push({ program: context.getProgramInfoLog(program),
          vertex: context.getShaderInfoLog(vertex), fragment: context.getShaderInfoLog(fragment) });
        target = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: true });target.texture.colorSpace = T.NoColorSpace;
        const eye = new T.Vector3(.35, .5, .8).normalize(), sunDirection = new T.Vector3(.25, .65, .72).normalize();
        const tangent = new T.Vector3().crossVectors(sunDirection, new T.Vector3(0, 1, 0)).normalize();
        const scene = new T.Scene(), camera = new T.PerspectiveCamera(50, 1, .12, 1e8);camera.position.copy(eye).multiplyScalar(6e6 * 1.35);camera.lookAt(0, 0, 0);camera.updateMatrixWorld(true);
        const sun = new T.DirectionalLight(0xffeed9, 3);sun.position.copy(sunDirection).multiplyScalar(1e8);scene.add(sun, new T.AmbientLight(0x8bacdd, .7));
        for (const family of ['terrain', 'water']) for (const blockerCount of [0, 1, 2]) {
          const p = new Planet({ seed: 'surface-program-key-physical', name: 'Fresh surface preparation', posUniv: new T.Vector3(), type: 'lush', radius: 6e6,
            tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });live.push(p);
          p.setStellarLights({ sources: [{ direction: sunDirection.toArray(), color: [1, .98, .94], distance: 1e12, radius: 2e10, irradianceFraction: 1 }], radianceScale: 3.2 });
          const referencePoint = eye.clone().multiplyScalar(p.R), blockers = [-350000, 350000].slice(0, blockerCount).map(offset => ({
            centerLocal: referencePoint.clone().addScaledVector(sunDirection, 2e7).addScaledVector(tangent, offset), radius: 8e5 }));
          p.setStellarOccluders(blockers);p.group.updateMatrixWorld(true);
          const material = family === 'terrain' ? p.terrainMaterial : p.liquidMat, group = new T.Group(), included = [], excluded = [];
          p.group.traverse(mesh => {
            if (!mesh.isMesh || mesh.material !== material) return;
            if (!(mesh.geometry.getAttribute('position')?.count > 0)) { excluded.push({ name: mesh.name, nearWaterPatch: mesh.userData.nearWaterPatch === true,
              attributes: Object.keys(mesh.geometry.attributes) });return; }
            const copy = mesh.clone(false);copy.geometry = mesh.geometry.clone();geometries.push(copy.geometry);
            copy.onBeforeRender = mesh.onBeforeRender;copy.onBeforeShadow = mesh.onBeforeShadow;copy.visible = true;copy.frustumCulled = false;
            copy.castShadow = false;copy.receiveShadow = false;group.add(copy);included.push({ name: mesh.name, attributes: Object.keys(mesh.geometry.attributes) });
          });
          const row = { family, blockerCount, included, excluded, fresh: { hasSurfaceUniforms: Boolean(material.userData.surfaceMedium),
            defines: { ...material.defines } }, physicalOccluders: blockers.map(value => ({ centerLocal: value.centerLocal.toArray(), radius: value.radius })) };
          result.cases.push(row);scene.add(group);
          const saved = { target: r.getRenderTarget(), face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), autoClear: r.autoClear };
          try {
            check(`${family}/${blockerCount} unprimed surface owner`, !row.fresh.hasSurfaceUniforms && !Object.hasOwn(row.fresh.defines, 'STELLAR_UNION_OCCLUSION'));
            check(`${family}/${blockerCount} actual nonempty root geometry`, included.length > 0 && included.every(value => value.attributes.includes('normal') && value.attributes.includes('aLocal')));
            check(`${family}/${blockerCount} excluded geometry is only empty near-water placeholder`, excluded.every(value => value.nearWaterPatch && value.attributes.length === 0));
            r.setRenderTarget(target);r.autoClear = true;r.clear(true, true, false);const clear = read();
            let pending;
            try { pending = withSurfaceWarmupVariant(group, () => compilePrograms(r, group, camera, scene)); }
            finally { r.setRenderTarget(saved.target, saved.face, saved.mip); }
            await pending;
            const prepared = new Set(programs(material));row.prepared = await snapshot(material);row.afterPreparationDefines = { ...material.defines };
            r.setRenderTarget(target);withSurfaceWarmupVariant(group, () => r.render(scene, camera));const first = read();
            const drawn = programs(material), current = r.properties.get(material).currentProgram;
            row.drawn = await snapshot(material);row.currentId = current?.id;row.currentNativeId = current ? id(current.program) : null;
            row.addedOnDraw = drawn.filter(value => !prepared.has(value)).map(value => value.id);
            row.objectRetention = { preparedToDrawn: [...prepared].every(value => drawn.includes(value)) };
            row.currentPrepared = prepared.has(current);row.afterDrawDefines = { ...material.defines };
            const actual = row.drawn.find(value => value.id === row.currentId), uniforms = material.userData.surfaceMedium;
            row.expectedUploaded = { star: Array.from(new Float32Array(uniforms.uLocalStars.value[0].toArray())),
              blockers: blockers.map((_value, i) => Array.from(new Float32Array(uniforms.uLocalOccluders.value[i].toArray()))) };
            check(`${family}/${blockerCount} native union/SCREEN/stellar branch`, actual?.unionDefine === String(Number(blockerCount > 1)) && actual?.screenDefine === '1'
              && actual?.uploaded.starCount === 1 && actual?.uploaded.blockerCount === blockerCount);
            check(`${family}/${blockerCount} physical star and occluder bytes uploaded`, actual && JSON.stringify(actual.uploaded.star) === JSON.stringify(row.expectedUploaded.star)
              && row.expectedUploaded.blockers.every((value, i) => JSON.stringify(value) === JSON.stringify(actual.uploaded.blockers[i])));
            check(`${family}/${blockerCount} linked programs`, row.prepared.concat(row.drawn).every(value => value.linkStatus === true));
            if (implementation === 'reference') {
              check(`${family}/${blockerCount} original fresh preparation misses the actual draw key`, row.addedOnDraw.length > 0 && !row.currentPrepared);
              check(`${family}/${blockerCount} original compile has no selected union prefix`, row.prepared.every(value => value.unionDefine === null));
            } else {
              check(`${family}/${blockerCount} candidate prepares the actual first draw family`, row.addedOnDraw.length === 0 && row.currentPrepared);
              check(`${family}/${blockerCount} candidate compile selects actual owner topology`, row.prepared.every(value => value.unionDefine === String(Number(blockerCount > 1))));
            }
            const firstDrawPrograms = new Set(drawn);material.needsUpdate = true;
            let repeated;
            try { repeated = withSurfaceWarmupVariant(group, () => compilePrograms(r, group, camera, scene)); }
            finally { r.setRenderTarget(saved.target, saved.face, saved.mip); }
            await repeated;r.setRenderTarget(target);withSurfaceWarmupVariant(group, () => r.render(scene, camera));const second = read();
            const repeatedPrograms = programs(material), repeatedCurrent = r.properties.get(material).currentProgram;
            row.repeated = await snapshot(material);row.repeatedCurrentId = repeatedCurrent?.id;
            row.repeatedCurrentNativeId = repeatedCurrent ? id(repeatedCurrent.program) : null;
            row.repeatChanged = changed(first, second);row.nativeBits = Array.from(first);row.secondNativeBits = Array.from(second);
            row.objectRetention.drawnToRepeated = [...firstDrawPrograms].every(value => repeatedPrograms.includes(value));
            row.currentObjects = { repeatedMatchesFirst: repeatedCurrent === current };
            check(`${family}/${blockerCount} all first-draw program objects survive repeat`, row.objectRetention.drawnToRepeated);
            if (implementation === 'candidate') {
              check(`${family}/${blockerCount} candidate repeat adds no programs and preserves current object`, repeatedPrograms.every(value => firstDrawPrograms.has(value))
                && repeatedCurrent === current);
            } else {
              const added = repeatedPrograms.filter(value => !firstDrawPrograms.has(value));
              check(`${family}/${blockerCount} original repeat introduces and actually selects exactly one program`, added.length === 1 && added[0] === repeatedCurrent);
            }
            const secondDrawPrograms = new Set(repeatedPrograms);material.needsUpdate = true;
            let thirdPreparation;
            try { thirdPreparation = withSurfaceWarmupVariant(group, () => compilePrograms(r, group, camera, scene)); }
            finally { r.setRenderTarget(saved.target, saved.face, saved.mip); }
            await thirdPreparation;r.setRenderTarget(target);withSurfaceWarmupVariant(group, () => r.render(scene, camera));const third = read();
            const thirdPrograms = programs(material), thirdCurrent = r.properties.get(material).currentProgram;
            row.third = await snapshot(material);row.thirdCurrentId = thirdCurrent?.id;
            row.thirdCurrentNativeId = thirdCurrent ? id(thirdCurrent.program) : null;
            row.thirdChanged = changed(second, third);row.thirdNativeBits = Array.from(third);
            row.objectRetention.repeatedToThird = [...secondDrawPrograms].every(value => thirdPrograms.includes(value));
            row.currentObjects.thirdMatchesRepeated = thirdCurrent === repeatedCurrent;
            row.metadata = [meta(first, clear), meta(second, clear), meta(third, clear)];
            check(`${family}/${blockerCount} all repeated program objects survive third draw`, row.objectRetention.repeatedToThird);
            check(`${family}/${blockerCount} third repeat adds no programs and preserves current object`, thirdPrograms.every(value => secondDrawPrograms.has(value))
              && thirdCurrent === repeatedCurrent);
            check(`${family}/${blockerCount} native repeat is bit-exact`, row.repeatChanged === 0);
            check(`${family}/${blockerCount} native third draw is bit-exact`, row.thirdChanged === 0);
            check(`${family}/${blockerCount} finite nonempty material output`, row.metadata.every(value => value.nonfinite === 0 && value.nonclearRgb > 1000 && value.nonzeroRgb > 1000 && value.distinctRed > 16));
            checkpoint(`${family}/${blockerCount}`);
          } finally { scene.remove(group);group.clear();r.setRenderTarget(saved.target, saved.face, saved.mip);r.autoClear = saved.autoClear;p.dispose();live.splice(live.indexOf(p), 1); }
        }
      } catch (error) { result.exception = { message: String(error), stack: error.stack }; }
      finally {
        for (const geometry of geometries) geometry.dispose();for (const p of live) p.dispose();target?.dispose();
        if (r) {
          const deadline = performance.now() + 5000;
          while (r.programRetirement.snapshot().pending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          result.retirement = r.programRetirement.snapshot();check('Program retirement drains', result.retirement.pending === 0 && result.retirement.faults.length === 0);
          checkpoint('cleanup');r.dispose();
        }
      }
      check('No shader errors or context loss', !result.shaderErrors.length && !result.contextLosses.length);
      check('All six fresh controls completed', result.cases.length === 6 && result.cases.every(value => value.nativeBits && value.thirdNativeBits));
      result.passed = !result.exception && result.checks.every(value => value.passed);return result;
    }, implementation);
    report.pages.push(result);await writeFile(`${directory}/${implementation}.json`, JSON.stringify(result, null, 2));
    await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  }
  const [old, next] = report.pages;
  report.classifications = [];
  for (const row of old.cases) {
    const current = next.cases.find(value => value.family === row.family && value.blockerCount === row.blockerCount);
    report.classifications.push(classifySurfacePreparationPair({ reference: row, candidate: current,
      referenceSources: old.sources, candidateSources: next.sources }));
    const changed = !row.nativeBits || !current?.nativeBits || row.nativeBits.length !== current.nativeBits.length ? null
      : row.nativeBits.reduce((sum, value, i) => sum + Number(value !== current.nativeBits[i]), 0);
    report.comparisons.push({ family: row.family, blockerCount: row.blockerCount, nativeUint16Changed: changed });
  }
  report.physicalControls = [];
  for (const page of report.pages) for (const family of ['terrain', 'water']) {
    const cases = [0, 1, 2].map(count => page.cases.find(value => value.family === family && value.blockerCount === count));
    const difference = (a, b) => !a?.nativeBits || !b?.nativeBits ? null : a.nativeBits.reduce((sum, value, i) => sum + Number(i % 4 !== 3 && value !== b.nativeBits[i]), 0);
    report.physicalControls.push({ implementation: page.implementation, family, noBlockerVsOneRgb: difference(cases[0], cases[1]), oneVsUnionRgb: difference(cases[1], cases[2]) });
  }
  report.after = await evidenceFingerprint(verifier);
  report.classifier.afterSha256 = hash(await readFile(classifierPath));
  report.classifier.stable = report.classifier.sha256 === report.classifier.afterSha256;
  report.passed = report.pages.every(value => value.passed) && report.comparisons.length === 6 && report.comparisons.every(value => value.nativeUint16Changed === 0)
    && report.classifications.length === 6 && report.classifications.every(value => value.passed) && report.classifier.stable
    && report.physicalControls.every(value => value.noBlockerVsOneRgb > 0 && value.oneVsUnionRgb > 0)
    && !report.errors.length && !report.driverWarnings.length && JSON.stringify(report.before) === JSON.stringify(report.after);
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  assert.ok(report.passed, `Fresh surface preparation controls failed; see ${directory}/report.json`);
  console.log(JSON.stringify({ directory, passed: true, cases: 6, scope: 'Program preparation identity/native HDR only; no timing or whole-page performance claim.' }));
} catch (error) {
  report.failure = { message: String(error), stack: error.stack };await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));throw error;
} finally { await browser?.close();if (server) await new Promise(resolve => server.close(resolve)); }
