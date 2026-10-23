// Real surface program identity/HDR regression, not a speed or whole-page gate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/surfaceprogramkeygputest.js';
const directory = `test-results/surface-program-key-gpu/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const referenceRef = process.argv.find(value => value.startsWith('--reference-ref='))?.slice('--reference-ref='.length) || '246125c';
const referenceCommit = execFileSync('git', ['rev-parse', `${referenceRef}^{commit}`], { encoding: 'utf8' }).trim();
const referenceBytes = execFileSync('git', ['show', `${referenceCommit}:src/surface-atmosphere.js`]);
const candidateBytes = await readFile('src/surface-atmosphere.js');
const verifierBytes = await readFile(new URL(import.meta.url));
await mkdir(`${directory}/inputs`, { recursive: true });
await writeFile(`${directory}/verifier.js`, verifierBytes);
await writeFile(`${directory}/inputs/reference-surface-atmosphere.js`, referenceBytes);
await writeFile(`${directory}/inputs/installed-surface-atmosphere.js`, candidateBytes);
const report = {
  scope: 'Actual Planet terrain/water materials and geometry, production material hooks, native WebGL program/cache-key identity and RGBA16F bit comparisons. Frozen synthetic single-star lighting and constructor hour-zero weather. No weather worker, column producer, full receiver pass, whole-player, cold-start or performance acceptance.',
  verifier: { path: `${directory}/verifier.js`, sha256: sha256(verifierBytes), bytes: verifierBytes.length },
  reference: { ref: referenceRef, commit: referenceCommit, path: 'src/surface-atmosphere.js',
    sha256: sha256(referenceBytes), bytes: referenceBytes.length, routing: 'Only this module is replaced on the reference navigation' },
  candidate: { sha256: sha256(candidateBytes), bytes: candidateBytes.length },
  before: await evidenceFingerprint(verifier), errors: [], warnings: [], driverWarnings: [], pages: [], comparisons: [],
};
let server, browser, referenceActive = false;
try {
  assert.match(referenceBytes.toString('utf8'), /shader\.defines \|\|= \{\};\s*shader\.defines\.SURFACE_CLOUD_MEDIUM=/,
    'Reference must be the original mutating installer; use --reference-ref=<old commit> after committing the fix');
  assert.match(candidateBytes.toString('utf8'), /shader\.defines=\{\.\.\.shader\.defines,SURFACE_CLOUD_MEDIUM:/,
    'Installed candidate must use compile-local copy-on-write');
  assert.notEqual(report.reference.sha256, report.candidate.sha256);
  const digest = createHash('sha256'), dependencies = [];
  for (const path of report.before.sourceFiles) {
    const bytes = await readFile(path), reference = path === report.reference.path ? referenceBytes : bytes;
    digest.update(`${path}\0${reference.length}\0`).update(reference);
    dependencies.push({ path, bytes: bytes.length, sha256: sha256(bytes),
      ...(path === report.reference.path ? { referenceBytes: reference.length, referenceSha256: sha256(reference) } : {}) });
  }
  report.reference.effectiveSourceDigest = digest.digest('hex');
  await writeFile(`${directory}/inputs/dependency-manifest.json`, JSON.stringify(dependencies, null, 2));
  const serving = await startServer(0);server = serving.server;
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  report.browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240000);
  page.on('pageerror', error => report.errors.push({ implementation: referenceActive ? 'reference' : 'installed', text: String(error) }));
  page.on('console', message => {
    const row = { implementation: referenceActive ? 'reference' : 'installed', text: message.text() };
    if (message.type() === 'error') report.errors.push(row);
    else if (message.type() === 'warning') {
      report.warnings.push(row);
      if (/GL_INVALID|GL_CONTEXT_LOST|Program object expected|INVALID_(?:ENUM|VALUE|OPERATION)|GL_OUT_OF_MEMORY|WebGL.*(?:error|lost)/i.test(row.text)) report.driverWarnings.push(row);
    }
  });
  await page.route('**/__surface-program-key*', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>' }));
  await page.route('**/src/surface-atmosphere.js', route => referenceActive
    ? route.fulfill({ contentType: 'application/javascript', body: referenceBytes }) : route.continue());

  // One page is reused; navigation gives each module implementation its own
  // ESM/GL context. All eight cases share one renderer inside that navigation.
  for (const implementation of ['reference', 'installed']) {
    referenceActive = implementation === 'reference';
    await page.goto(`http://127.0.0.1:${serving.port}/__surface-program-key?vclouds=1&implementation=${implementation}`);
    const result = await page.evaluate(async ({ implementation }) => {
      const T = await import('three');
      const { Planet } = await import('/src/planet.js');
      const { createGameRenderer } = await import('/src/renderer-runtime.js');
      const { withSurfaceWarmupVariant } = await import('/src/render-prewarm.js');
      const { hasSurfaceCloudMedium, registerSurfaceCloudOwner, withCloudSurfacePreparation } = await import('/src/cloud/surface-clouds.js');
      const result = { implementation, checks: [], cases: [], sources: {}, gl: [], shaderErrors: [],
        contextLosses: [], identityBoundary: 'Per-navigation JS/native program identities are not compared across GL contexts',
        input: { width: 32, height: 32, radiusMeters: 6e6, seed: 'surface-program-key-physical',
          cloudCoverage: [0, .64], materialFamilies: ['terrain', 'water'],
          scopes: ['preparation-SCREEN1', 'normal-SCREEN0'], repeatCompilations: 2,
          frozenWeatherHours: 0, worker: false, singleStar: true,
          normalScope: 'No screen receiver, so the real SCREEN0 fallback is exercised',
          preparationScope: 'Actual withSurfaceWarmupVariant; a hidden eligible marker selects shared SCREEN1 for the cloudless material too. Marker is not a tested surface material or visible geometry.',
          prebinding: 'Actual material.onBeforeRender is called once before the first measured draw, to seed STELLAR and SCREEN without compilation. This isolates MEDIUM aliasing from unrelated first-draw binder variants.' } };
      const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); };
      let r, gl, target, markerMaterial, markerGeometry;
      const planets = [], copies = [], nativePrograms = new WeakMap();let nextNativeId = 1;
      const nativeId = program => { if (!nativePrograms.has(program)) nativePrograms.set(program, nextNativeId++);return nativePrograms.get(program); };
      const hash = async source => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const checkpoint = name => {
        const errors = [];
        for (let i = 0; i < 16; i++) { const value = gl.getError();if (!value) break;errors.push(value); }
        const lost = gl.isContextLost();result.gl.push({ name, errors, lost });
        check(`GL0/context ${name}`, !errors.length && !lost);
      };
      const read = () => {
        const bits = new Uint16Array(32 * 32 * 4);r.readRenderTargetPixels(target, 0, 0, 32, 32, bits);return bits;
      };
      const differences = (a, b) => {
        let changed = 0, alphaChanged = 0, maxError = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) { changed++;if (i % 4 === 3) alphaChanged++; }
          maxError = Math.max(maxError, Math.abs(T.DataUtils.fromHalfFloat(a[i]) - T.DataUtils.fromHalfFloat(b[i])));
        }
        return { changed, alphaChanged, maxError };
      };
      const metadata = (bits, clear) => {
        let nonfinite = 0, nonclearRgb = 0, nonzeroRgb = 0, maxRgb = 0;const red = new Set();
        for (let i = 0; i < bits.length; i++) {
          const value = T.DataUtils.fromHalfFloat(bits[i]);if (!Number.isFinite(value)) nonfinite++;
          if (i % 4 !== 3) { nonclearRgb += Number(bits[i] !== clear[i]);nonzeroRgb += Number(value !== 0);maxRgb = Math.max(maxRgb, Math.abs(value)); }
          if (i % 4 === 0) red.add(bits[i]);
        }
        return { nonfinite, nonclearRgb, nonzeroRgb, maxRgb, distinctRed: red.size };
      };
      try {
        const canvas = document.querySelector('#fixture');
        canvas.addEventListener('webglcontextlost', event => result.contextLosses.push({ timeStamp: event.timeStamp, statusMessage: event.statusMessage }));
        ({ renderer: r } = await createGameRenderer({}, { canvas, logarithmicDepthBuffer: true, antialias: false }));
        gl = r.getContext();r.setPixelRatio(1);r.setSize(32, 32);r.setClearColor(0x15202b, 0);
        r.toneMapping = T.ACESFilmicToneMapping;r.shadowMap.enabled = false;
        r.debug.checkShaderErrors = true;
        r.debug.onShaderError = (context, program, vertex, fragment) => result.shaderErrors.push({
          program: context.getProgramInfoLog(program), vertex: context.getShaderInfoLog(vertex), fragment: context.getShaderInfoLog(fragment) });
        target = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: true, stencilBuffer: false });
        target.texture.colorSpace = T.NoColorSpace;
        const direction = new T.Vector3(.35, .5, .8).normalize(), sunDirection = new T.Vector3(.25, .65, .72).normalize();
        for (const coverage of [0, .64]) {
          const p = new Planet({ seed: 'surface-program-key-physical', name: 'Surface key fixture',
            posUniv: new T.Vector3(), type: 'lush', radius: 6e6,
            tuning: { cloudCoverage: coverage, weatherStyle: 'temperate-synoptic' } });
          p.setStellarLights({ sources: [{ direction: sunDirection.toArray(), color: [1, .98, .94],
            distance: 1e12, radius: 6e8, irradianceFraction: 1 }], radianceScale: 3.2 });
          p.group.updateMatrixWorld(true);planets.push(p);
          check(`Constructor medium ${Number(coverage > 0)} exists`, Number(hasSurfaceCloudMedium(p)) === Number(coverage > 0));
          check(`Constructor water material ${coverage}`, Boolean(p.liquidMat?.userData?.waterUniforms));
          check(`No forecast worker ${coverage}`, !p.weatherStream);
        }
        markerGeometry = new T.BoxGeometry();markerMaterial = new T.MeshBasicMaterial();
        registerSurfaceCloudOwner(markerMaterial, planets[1]);
        const scene = new T.Scene(), camera = new T.PerspectiveCamera(50, 1, .12, 1e8);
        camera.position.copy(direction).multiplyScalar(planets[0].R * 1.35);camera.lookAt(0, 0, 0);camera.updateMatrixWorld(true);
        const sun = new T.DirectionalLight(0xffeed9, 3);sun.position.copy(sunDirection).multiplyScalar(1e8);
        scene.add(sun, new T.AmbientLight(0x8bacdd, .7));
        // compile() also traverses the constructor's empty near-water mesh.
        // It has neither position nor normal, whereas every actual root draw
        // has both. Accept only this exact source/key family difference; never
        // treat an arbitrary extra water program as legitimate.
        function classifyEmptyGeometryProgram(draw, extra, sources) {
          const drawVertex = sources[draw.vertexSha256], extraVertex = sources[extra.vertexSha256];
          const drawFragment = sources[draw.fragmentSha256], extraFragment = sources[extra.fragmentSha256];
          const first = draw.cacheKey.split(','), second = extra.cacheKey.split(',');
          const keyChanges = [];
          for (let i = 0; i < Math.max(first.length, second.length); i++) {
            if (first[i] !== second[i]) keyChanges.push({ index: i, draw: first[i], extra: second[i] });
          }
          const sourceMatches = /^#define HAS_NORMAL$/m.test(drawVertex) && !/^#define FLAT_SHADED$/m.test(drawVertex)
            && !/^#define HAS_NORMAL$/m.test(extraVertex) && /^#define FLAT_SHADED$/m.test(extraVertex)
            && !/^#define FLAT_SHADED$/m.test(drawFragment) && /^#define FLAT_SHADED$/m.test(extraFragment)
            && drawVertex.replace(/^#define HAS_NORMAL\n/m, '') === extraVertex.replace(/^#define FLAT_SHADED\n/m, '')
            && drawFragment === extraFragment.replace(/^#define FLAT_SHADED\n/m, '');
          const masksMatch = keyChanges.length === 2
            && Number(keyChanges[0].draw) !== Number(keyChanges[0].extra)
            && (Number(keyChanges[0].draw) & ~(1 << 23)) === Number(keyChanges[0].extra)
            && ((Number(keyChanges[1].draw) & ~(1 << 23)) | (1 << 2)) === Number(keyChanges[1].extra);
          return { valid: sourceMatches && masksMatch, sourceMatches, masksMatch, keyChanges,
            family: 'Empty near-water geometry: no vertex normal/position; FLAT_SHADED enabled, vertexNormals/hasPosition bits removed',
            drawId: draw.id, extraId: extra.id, vertexSha256: extra.vertexSha256, fragmentSha256: extra.fragmentSha256 };
        }
        const snapshot = async material => {
          const rows = [];
          for (const [leaseKey, program] of r.properties.get(material).programs || []) {
            check('Program lease has a native handle', Boolean(program.program));
            if (!program.program) continue;
            const vertex = gl.getShaderSource(program.vertexShader), fragment = gl.getShaderSource(program.fragmentShader);
            check('Native shader sources are captured', typeof vertex === 'string' && typeof fragment === 'string' && vertex.length > 100 && fragment.length > 100);
            const vertexSha256 = await hash(vertex || ''), fragmentSha256 = await hash(fragment || '');
            result.sources[vertexSha256] = vertex;result.sources[fragmentSha256] = fragment;
            const linkStatus = gl.getProgramParameter(program.program, gl.LINK_STATUS);
            check('Native program linked', linkStatus === true);
            const uploaded = name => { const location = gl.getUniformLocation(program.program, name);return location ? gl.getUniform(program.program, location) : null; };
            rows.push({ id: program.id, nativeId: nativeId(program.program), leaseKey, cacheKey: program.cacheKey,
              usedTimes: program.usedTimes, linkStatus, vertexSha256, fragmentSha256,
              uploadedUniforms: { starCount: uploaded('uLocalStarCount'), surfaceCloudEnabled: uploaded('uSurfaceCloudEnabled') },
              actualMedium: fragment?.match(/^#define SURFACE_CLOUD_MEDIUM (\d)$/m)?.[1] ?? null,
              actualScreen: fragment?.match(/^#define SURFACE_CLOUD_SCREEN (\d)$/m)?.[1] ?? null });
          }
          return rows;
        };
        for (const [medium, p] of planets.entries()) for (const family of ['terrain', 'water']) for (const scope of ['preparation-SCREEN1', 'normal-SCREEN0']) {
          const material = family === 'terrain' ? p.terrainMaterial : p.liquidMat;
          material.dispose();material.defines = {};material.needsUpdate = true;
          const group = new T.Group(), sources = [];
          p.group.traverse(mesh => { if (mesh.isMesh && mesh.material === material) sources.push(mesh); });
          for (const source of sources) {
            const copy = source.clone(false);copy.geometry = source.geometry.clone();copies.push(copy);
            copy.onBeforeRender = source.onBeforeRender;copy.onBeforeShadow = source.onBeforeShadow;
            copy.visible = true;copy.frustumCulled = false;copy.castShadow = false;copy.receiveShadow = false;group.add(copy);
          }
          const marker = new T.Mesh(markerGeometry, markerMaterial);marker.visible = false;group.add(marker);scene.add(group);
          const sourceGeometry = sources.map(source => ({ nearWaterPatch: source.userData.nearWaterPatch === true,
            positionCount: source.geometry.getAttribute('position')?.count ?? 0,
            attributes: Object.keys(source.geometry.attributes).sort(),
            hasPosition: Boolean(source.geometry.getAttribute('position')), hasNormal: Boolean(source.geometry.getAttribute('normal')) }));
          const row = { medium, family, scope, rootMeshes: sources.length, sourceGeometry, snapshots: [], nativeDifferences: [],
            inputCustomKey: material.customProgramCacheKey(), materialIdentity: material.uuid };
          result.cases.push(row);
          const saved = { target: r.getRenderTarget(), face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), autoClear: r.autoClear };
          const inScope = work => scope === 'preparation-SCREEN1' ? withSurfaceWarmupVariant(group, work) : work();
          try {
            check(`${family}/${medium}/${scope} has actual geometry`, sources.length > 0);
            r.setRenderTarget(target);r.autoClear = true;r.clear(true, true, false);const clear = read();
            const firstMesh = group.children.find(object => object.material === material);
            const bind = () => material.onBeforeRender(r, scene, camera, firstMesh.geometry, firstMesh, null);
            if (scope === 'preparation-SCREEN1') withCloudSurfacePreparation(true, bind);else bind();
            row.preboundDefines = { ...material.defines };
            check(`${family}/${medium}/${scope} starts without MEDIUM material pollution`, !Object.hasOwn(material.defines, 'SURFACE_CLOUD_MEDIUM'));
            check(`${family}/${medium}/${scope} actual hook selects requested SCREEN`, material.defines.SURFACE_CLOUD_SCREEN === Number(scope === 'preparation-SCREEN1'));
            const captures = [], firstPrograms = new Set();
            for (let iteration = 0; iteration < 3; iteration++) {
              if (iteration) { material.needsUpdate = true;inScope(() => r.compile(group, camera, scene)); }
              inScope(() => r.render(scene, camera));captures.push(read());
              const programs = [...(r.properties.get(material).programs?.values() || [])];
              if (!iteration) for (const program of programs) firstPrograms.add(program);
              const currentProgram = r.properties.get(material).currentProgram;
              const snap = { iteration, programObjects: programs.length, addedObjects: programs.filter(program => !firstPrograms.has(program)).length,
                currentProgramRetained: firstPrograms.has(currentProgram), currentId: currentProgram?.id,
                boundUniforms: { starCount: material.userData.surfaceMedium?.uLocalStarCount?.value,
                  surfaceCloudEnabled: material.userData.surfaceMedium?.uSurfaceCloudEnabled?.value },
                programs: await snapshot(material), defines: { ...material.defines } };
              row.snapshots.push(snap);checkpoint(`${family}/${medium}/${scope}/${iteration}`);
              check(`${family}/${medium}/${scope} actual stellar hook exercised`, snap.boundUniforms.starCount === 1);
              const active = snap.programs.find(value => value.id === currentProgram?.id);
              check(`${family}/${medium}/${scope} native stellar upload agrees when active`, active?.uploadedUniforms.starCount === null
                || active?.uploadedUniforms.starCount === 1);
              if (medium === 1) {
                check(`${family}/${medium}/${scope} native medium branch and stellar input active`, active?.uploadedUniforms.starCount === 1
                  && active?.uploadedUniforms.surfaceCloudEnabled === Number(scope === 'normal-SCREEN0'));
              }
              check(`${family}/${medium}/${scope} program macro identity`, snap.programs.length > 0 && snap.programs.every(value => value.actualMedium === String(medium)
                && value.actualScreen === String(Number(scope === 'preparation-SCREEN1'))));
            }
            row.nativeDifferences = [differences(captures[0], captures[1]), differences(captures[0], captures[2])];
            row.metadata = captures.map(bits => metadata(bits, clear));row.nativeBits = Array.from(captures[0]);
            const unique = [...new Map(row.snapshots.flatMap(value => value.programs).map(value => [value.id, value])).values()];
            row.sameSourceDifferentKeys = unique.flatMap((a, i) => unique.slice(i + 1).filter(b => a.vertexSha256 === b.vertexSha256
              && a.fragmentSha256 === b.fragmentSha256 && a.cacheKey !== b.cacheKey && a.nativeId !== b.nativeId)
              .map(b => ({ firstId: a.id, secondId: b.id, firstNativeId: a.nativeId, secondNativeId: b.nativeId,
                vertexSha256: a.vertexSha256, fragmentSha256: a.fragmentSha256 })));
            check(`${family}/${medium}/${scope} finite/nonempty native image`, row.metadata.every(value => value.nonfinite === 0
              && value.nonclearRgb > 1000 && value.nonzeroRgb > 1000 && value.distinctRed > 16));
            check(`${family}/${medium}/${scope} repeated native bits unchanged`, row.nativeDifferences.every(value => value.changed === 0));
            if (implementation === 'reference') {
              check(`${family}/${medium}/${scope} original same-source different-key control`, row.sameSourceDifferentKeys.length > 0);
              check(`${family}/${medium}/${scope} original constructs another program`, row.snapshots.slice(1).some(value => value.addedObjects > 0));
            } else {
              const first = row.snapshots[0], draw = first.programs.find(value => value.id === first.currentId);
              check(`${family}/${medium}/${scope} actual draw program object/key/source retained`, row.snapshots.slice(1).every(value => {
                const current = value.programs.find(program => program.id === value.currentId);
                return value.currentProgramRetained && current?.id === draw?.id && current?.nativeId === draw?.nativeId
                  && current?.cacheKey === draw?.cacheKey && current?.vertexSha256 === draw?.vertexSha256
                  && current?.fragmentSha256 === draw?.fragmentSha256;
              }));
              const firstIds = new Set(first.programs.map(value => value.id));
              const extra = unique.filter(value => !firstIds.has(value.id));
              row.extraCompileFamilies = extra.map(value => classifyEmptyGeometryProgram(draw, value, result.sources));
              const emptyNearPatch = sourceGeometry.filter(value => value.nearWaterPatch && !value.hasPosition && !value.hasNormal);
              if (family === 'water') {
                check(`${family}/${medium}/${scope} only the proven empty-geometry compile family may be added`,
                  emptyNearPatch.length === 1 && extra.length === 1 && row.extraCompileFamilies.every(value => value.valid));
              } else check(`${family}/${medium}/${scope} no extra terrain compile family`, extra.length === 0);
              const afterFirstCompile = row.snapshots[1].programs, afterSecondCompile = row.snapshots[2].programs;
              check(`${family}/${medium}/${scope} repeated compile retains every program family`,
                afterFirstCompile.length === afterSecondCompile.length && afterFirstCompile.every(value =>
                  afterSecondCompile.some(next => next.id === value.id && next.nativeId === value.nativeId && next.cacheKey === value.cacheKey
                    && next.vertexSha256 === value.vertexSha256 && next.fragmentSha256 === value.fragmentSha256)));
              check(`${family}/${medium}/${scope} no duplicate same-source key`, row.sameSourceDifferentKeys.length === 0);
              check(`${family}/${medium}/${scope} installer never writes material MEDIUM`, row.snapshots.every(value => !Object.hasOwn(value.defines, 'SURFACE_CLOUD_MEDIUM')));
            }
          } finally {
            scene.remove(group);group.clear();
            r.setRenderTarget(saved.target, saved.face, saved.mip);r.autoClear = saved.autoClear;
            material.dispose();
          }
        }
        checkpoint('before-cleanup');
      } catch (error) { result.exception = { message: String(error), stack: error.stack }; }
      finally {
        for (const copy of copies) copy.geometry.dispose();
        target?.dispose();markerMaterial?.dispose();markerGeometry?.dispose();for (const p of planets) p.dispose();
        if (r) {
          const deadline = performance.now() + 5000;
          while (r.programRetirement.snapshot().pending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          result.retirement = r.programRetirement.snapshot();
          check('Retired programs drain without faults', result.retirement.pending === 0 && result.retirement.faults.length === 0);
          checkpoint('after-cleanup');r.dispose();
        }
      }
      check('No shader errors/context loss', result.shaderErrors.length === 0 && result.contextLosses.length === 0);
      check('All eight cases completed', result.cases.length === 8 && result.cases.every(value => value.nativeBits));
      result.passed = !result.exception && result.checks.every(value => value.passed);return result;
    }, { implementation });
    report.pages.push(result);
    await writeFile(`${directory}/${implementation}.json`, JSON.stringify(result, null, 2));
    // Persist before asserting: a failed positive control remains inspectable.
    await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  }
  const [reference, installed] = report.pages;
  for (const old of reference.cases) {
    const next = installed.cases.find(value => value.medium === old.medium && value.family === old.family && value.scope === old.scope);
    let changed = 0;
    if (!next?.nativeBits || !old.nativeBits || next.nativeBits.length !== old.nativeBits.length) changed = null;
    else for (let i = 0; i < old.nativeBits.length; i++) changed += Number(old.nativeBits[i] !== next.nativeBits[i]);
    report.comparisons.push({ medium: old.medium, family: old.family, scope: old.scope, nativeUint16Changed: changed });
  }
  report.after = await evidenceFingerprint(verifier);
  report.passed = report.pages.length === 2 && report.pages.every(value => value.passed) && report.comparisons.length === 8
    && report.comparisons.every(value => value.nativeUint16Changed === 0) && report.errors.length === 0 && report.driverWarnings.length === 0
    && JSON.stringify(report.before) === JSON.stringify(report.after);
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  assert.ok(report.passed, `Surface program key/native HDR controls failed; see ${directory}/report.json`);
  console.log(JSON.stringify({ directory, passed: true, cases: report.comparisons.length,
    scope: 'Program identity/native HDR only; program counts are not timing or whole-page performance evidence.' }));
} catch (error) {
  report.failure = { message: String(error), stack: error.stack };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));throw error;
} finally { await browser?.close();if (server) await new Promise(resolve => server.close(resolve)); }
