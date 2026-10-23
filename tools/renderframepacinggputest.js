// Actual foreground-frame admission, native RGBA16F and history ownership.
// This is a small deterministic pipeline fixture, never whole-game timing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/renderframepacinggputest.js';
const directory = `test-results/render-frame-pacing/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const addonInputs = ['node_modules/three/package.json', 'node_modules/three/examples/jsm/postprocessing/SMAAPass.js',
  'node_modules/three/examples/jsm/postprocessing/Pass.js', 'node_modules/three/examples/jsm/shaders/SMAAShader.js'];
const addonFingerprint = async () => Promise.all(addonInputs.map(async file => {
  const bytes = await readFile(file);return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}));
await mkdir(`${directory}/inputs`, { recursive: true });
const verifierBytes = await readFile(new URL(import.meta.url));
await writeFile(`${directory}/verifier.js`, verifierBytes);
const report = {
  scope: 'Actual GameLegacyPipeline, synthetic signed cloud pixels and real constant opaque depth; production temporal resolve/composite, native RGBA16F off/on/off/on, native fence admission and retirement. Not authored physical clouds, column throughput, default-player, latency or frame-rate acceptance.',
  busyEvidence: 'Only unmodified native clientWaitSync TIMEOUT_EXPIRED followed by render(false) counts. No fake wait status, forced GPU workload or CPU mock is accepted as hardware busy coverage; missing natural coverage fails explicitly.',
  cpuMock: { executed: false, reason: 'This tool accepts native WebGL evidence only. CPU fault/reentry contracts live separately in tools/gpuframepacertest.js.' },
  verifier: { path: `${directory}/verifier.js`, bytes: verifierBytes.length, sha256: sha256(verifierBytes) },
  before: await evidenceFingerprint(verifier), addonBefore: await addonFingerprint(), errors: [], warnings: [], driverWarnings: [],
};
let browser, server, page;
try {
  const manifest = [];
  // Preserve all fingerprint inputs, not just a digest of later mutable files.
  for (const file of [...new Set([...report.before.sourceFiles, ...addonInputs, 'tools/browser.js', 'tools/server.js',
    'tools/evidence-fingerprint.js', 'tools/canonical-planet-fixture.js'])]) {
    const bytes = await readFile(file), destination = `${directory}/inputs/${file}`;
    await mkdir(path.dirname(destination), { recursive: true });await writeFile(destination, bytes);
    manifest.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await writeFile(`${directory}/inputs/manifest.json`, JSON.stringify(manifest, null, 2));
  const serving = await startServer(0);server = serving.server;
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  report.browserVersion = browser.version();
  page = await browser.newPage({ viewport: { width: 640, height: 420 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push(message.text());
    else if (message.type() === 'warning') {
      report.warnings.push(message.text());
      if (/GL_INVALID|GL_CONTEXT_LOST|Program object expected|INVALID_(?:ENUM|VALUE|OPERATION)|GL_OUT_OF_MEMORY|WebGL.*(?:error|lost)/i.test(message.text()))
        report.driverWarnings.push(message.text());
    }
  });
  await page.route('**/__render-frame-pacing', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><link rel="icon" href="data:,"><title>Actual foreground frame pacing</title>'
    + '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
    + '<style>body{background:#172332;color:#d5e5ef;font:15px system-ui}canvas{width:160px;height:160px;image-rendering:pixelated;margin:8px;vertical-align:top}#preview{width:256px;height:256px}</style>'
    + '<p>Actual pipeline: synthetic volume / real depth / native HDR / native zero-timeout fences</p><canvas id="fixture"></canvas><canvas id="preview" width="32" height="32"></canvas><pre id="status">running</pre>' }));
  await page.goto(`http://127.0.0.1:${serving.port}/__render-frame-pacing`);
  report.result = await page.evaluate(async () => {
    const T = await import('three');
    const { createGameRenderer } = await import('/src/renderer-runtime.js');
    const { GameLegacyPipeline } = await import('/src/legacy-render-pipeline.js');
    const { VOLUME_LAYER } = await import('/src/volumetric-pass-webgl.js');
    const result = { checks: [], cases: [], comparisons: [], busy: [], transitions: [], gl: [],
      shaderErrors: [], contextLosses: [], native: { fences: [], waits: [], deletes: [], forbidden: [] },
      input: { width: 32, height: 32, volumeScale: 1, successfulFramesPerCase: 3,
        maxNaturalBusyTrialsPerTransition: 24, deadlineMs: 10000,
        depth: .5, source: 'Signed deterministic cloud pixels; fixed HDR opaque source and real depth. No production weather/column workload.' } };
    const check = (name, condition, details = null) => {
      result.checks.push({ name, pass: Boolean(condition), ...(details ? { details } : {}) });
      if (!condition) throw Error(name);
    };
    const pause = () => new Promise(resolve => setTimeout(resolve, 0));
    const hash = async bits => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bits.buffer))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const ids = new WeakMap();let nextId = 0;
    const id = value => {
      if (value === null || value === undefined) return null;
      if (!ids.has(value)) ids.set(value, ++nextId);return ids.get(value);
    };
    let renderer, gl, pipeline, cube, geometry, source, base, label = 'setup', nativeMethods, nativeOrder = 0;
    const pipelines = [], pacers = [], captures = [], resolveObservations = [], disposedPipelines = new Set();
    const counts = { draws: 0, queryBegins: 0, queryEnds: 0, fences: 0 };
    const checkpoint = name => {
      const errors = [];for (let i = 0; i < 16; i++) { const value = gl.getError();if (!value) break;errors.push(value); }
      const lost = gl.isContextLost();result.gl.push({ name, errors, lost });
      check(`GL0 and context live: ${name}`, errors.length === 0 && !lost);
    };
    const read = async target => {
      const bits = new Uint16Array(target.width * target.height * 4);
      const caller = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      // The vendor readback finally restores __webglFramebuffer directly;
      // a current cube stores six FBOs there. Make its current target the
      // ordinary target being read, then restore the caller through the real
      // setRenderTarget API, which selects the requested cube face/mip.
      try {
        renderer.setRenderTarget(target, 0, 0);
        renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, bits);
      } finally {
        renderer.setRenderTarget(caller, face, mip);
        check('Native readback restores caller target/face/mip', renderer.getRenderTarget() === caller
          && renderer.getActiveCubeFace() === face && renderer.getActiveMipmapLevel() === mip);
      }
      let nonfinite = 0, nonzeroRGB = 0, negativeRGB = 0, hdrRGB = 0, maximumRGB = -Infinity;
      for (let i = 0; i < bits.length; i++) {
        const value = T.DataUtils.fromHalfFloat(bits[i]);if (!Number.isFinite(value)) nonfinite++;
        if (i % 4 === 3) continue;
        if (value !== 0) nonzeroRGB++;if (value < 0) negativeRGB++;if (value > 1) hdrRGB++;
        maximumRGB = Math.max(maximumRGB, value);
      }
      return { bits, metadata: { type: 'native Uint16Array/RGBA16F', width: target.width, height: target.height,
        elements: bits.length, sha256: await hash(bits), nonfinite, nonzeroRGB, negativeRGB, hdrRGB, maximumRGB } };
    };
    const compare = (a, b) => {
      check('Native target dimensions match', a.length === b.length);
      let changed = 0, alphaChanged = 0, maximumError = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
        changed++;if (i % 4 === 3) alphaChanged++;
        maximumError = Math.max(maximumError, Math.abs(T.DataUtils.fromHalfFloat(a[i]) - T.DataUtils.fromHalfFloat(b[i])));
      }
      return { changed, alphaChanged, maximumError };
    };
    const frameSnapshot = state => ({
      origin: state.origin.toArray(), cameraWorld: state.cameraWorld.toArray(), projection: state.projection.toArray(),
      inverseProjection: state.inverseProjection.toArray(), viewProjection: state.viewProjection.toArray(),
      bodyPosition: state.bodyPosition.toArray(), bodyOrientation: state.bodyOrientation.toArray(),
      context: id(state.context), timeEpoch: state.timeEpoch, body: id(state.body), medium: id(state.medium), near: state.near, far: state.far,
    });
    const stateSnapshot = () => {
      const frame = pipeline.frameState, volume = pipeline.volumePass, budget = pipeline.columnWorkBudget, profiler = pipeline.profiler;
      const clear = new T.Color();renderer.getClearColor(clear);
      return {
        frame: { sequence: frame.sequence, valid: frame.valid, pending: frame.pending, epoch: frame.epoch,
          reason: frame.reason, beginEpoch: frame._beginEpoch, current: frameSnapshot(frame.current), previous: frameSnapshot(frame.previous) },
        volume: { frame: volume.frame, historySequence: volume.historySequence, historyValid: volume.historyValid,
          historyRead: id(volume.historyRead), historyWrite: id(volume.historyWrite),
          previousMaterial: id(volume.previousVolumeMaterial), previousVersion: volume.previousVolumeVersion,
          previousRadius: volume.previousRadius, historyUniform: volume.resolveMaterial.uniforms.uHistoryValid.value,
          stationaryUniform: volume.resolveMaterial.uniforms.uStationaryHistory.value,
          columnMaps: [...volume.columnMaps].map(([body, bank]) => [id(body), id(bank)]),
          columnRelease: [...volume.columnRelease].map(([body, frame]) => [id(body), frame]) },
        profiler: profiler ? { frame: profiler.frame, sample: profiler.sample, pending: profiler.pending.length,
          records: profiler.records.map(row => ({ ...row })), skipped: profiler.skipped, discarded: profiler.discarded,
          active: profiler.active, disposed: profiler.disposed } : null,
        budget: budget?.snapshot() || null, cloudLightFrame: pipeline.cloudLightFrame,
        composer: { read: id(pipeline.composer.readBuffer), write: id(pipeline.composer.writeBuffer) },
        renderer: { target: id(renderer.getRenderTarget()), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
          viewport: renderer.getViewport(new T.Vector4()).toArray(), scissor: renderer.getScissor(new T.Vector4()).toArray(),
          scissorTest: renderer.getScissorTest(), autoClear: renderer.autoClear, clear: clear.toArray(), alpha: renderer.getClearAlpha(),
          cameraLayers: pipeline.camera.layers.mask, info: { ...renderer.info.render } },
        counts: { ...counts }, resolveDraws: resolveObservations.length,
      };
    };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const awaitReady = async (pacer, name) => {
      const deadline = performance.now() + result.input.deadlineMs;label = `poll:${name}`;
      while (!pacer.poll()) {
        check(`${name}: healthy pending owner`, !pacer.snapshot().fault && !gl.isContextLost());
        if (performance.now() > deadline) throw Error(`Native frame fence deadline: ${name}`);
        await pause();
      }
    };
    const awaitReleased = async (pacer, name) => {
      const deadline = performance.now() + result.input.deadlineMs;label = `drain:${name}`;
      // Exercise the runtime's own asynchronous drain, not a synchronous poll loop.
      while (!pacer.snapshot().released) {
        check(`${name}: healthy retirement`, !pacer.snapshot().fault && !gl.isContextLost());
        if (performance.now() > deadline) throw Error(`Retired frame owner deadline: ${name}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const stop = async name => {
      const pacer = pipeline.framePacer;if (!pacer) return;
      const before = pacer.snapshot();label = `stop:${name}`;pipeline.stopFramePacing();
      check(`${name}: stop detaches public owner`, pipeline.framePacer === null && pacer.snapshot().disposed);
      await awaitReleased(pacer, name);result.retirements ||= [];
      result.retirements.push({ name, before, after: pacer.snapshot() });
    };
    try {
      ({ renderer } = await createGameRenderer({}, { canvas: document.querySelector('#fixture'), antialias: false }));
      renderer.setPixelRatio(1);renderer.setSize(32, 32, false);renderer.toneMapping = T.NoToneMapping;
      gl = renderer.getContext();renderer.debug.checkShaderErrors = true;
      renderer.debug.onShaderError = (context, program, vertex, fragment) => result.shaderErrors.push({
        program: context.getProgramInfoLog(program), vertex: context.getShaderInfoLog(vertex), fragment: context.getShaderInfoLog(fragment) });
      renderer.domElement.addEventListener('webglcontextlost', event => result.contextLosses.push({ time: event.timeStamp, statusMessage: event.statusMessage }));
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      result.gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      result.userAgent = navigator.userAgent;
      check('Real hardware WebGL2', renderer.capabilities.isWebGL2 && !/swiftshader|llvmpipe|software/i.test(result.gpu));
      check('Half-float color targets available', Boolean(gl.getExtension('EXT_color_buffer_float')));
      nativeMethods = Object.fromEntries(['fenceSync', 'clientWaitSync', 'deleteSync', 'flush', 'finish', 'waitSync',
        'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'beginQuery', 'endQuery'].map(name => [name, gl[name]]));
      // Forward the real calls and real statuses. None of these wrappers changes
      // scheduling, inserts a flush, fabricates a fence or alters a wait result.
      gl.fenceSync = function(condition, flags) {
        const sync = nativeMethods.fenceSync.call(this, condition, flags);counts.fences++;
        result.native.fences.push({ order: ++nativeOrder, label, id: id(sync), condition, flags });return sync;
      };
      gl.clientWaitSync = function(sync, flags, timeout) {
        const status = nativeMethods.clientWaitSync.call(this, sync, flags, timeout);
        result.native.waits.push({ order: ++nativeOrder, label, id: id(sync), flags, timeout, status });return status;
      };
      gl.deleteSync = function(sync) { result.native.deletes.push({ order: ++nativeOrder, label, id: id(sync) });return nativeMethods.deleteSync.call(this, sync); };
      for (const name of ['flush', 'finish', 'waitSync']) gl[name] = function(...args) {
        result.native.forbidden.push({ label, name, args });return nativeMethods[name].apply(this, args);
      };
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) gl[name] = function(...args) {
        counts.draws++;return nativeMethods[name].apply(this, args);
      };
      gl.beginQuery = function(...args) { counts.queryBegins++;return nativeMethods.beginQuery.apply(this, args); };
      gl.endQuery = function(...args) { counts.queryEnds++;return nativeMethods.endQuery.apply(this, args); };

      const scene = new T.Scene(), camera = new T.PerspectiveCamera(60, 1, .12, 1e7);
      const origin = new T.Vector3(), context = {}, options = { origin, context, timeEpoch: 0 };
      geometry = new T.PlaneGeometry(2, 2);
      const vertexShader = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
      base = new T.ShaderMaterial({ vertexShader, fragmentShader:
        'varying vec2 vUv;void main(){gl_FragDepth=.5;gl_FragColor=vec4(2.75+vUv.x,1.4+vUv.y,.9,1.0);}',
      depthTest: true, depthWrite: true, blending: T.NoBlending });
      const opaque = new T.Mesh(geometry, base);opaque.frustumCulled = false;scene.add(opaque);
      source = new T.ShaderMaterial({ uniforms: { uShift: { value: 0 }, uCameraLocal: { value: new T.Vector3() }, uColumnsReady: { value: 0 } },
        vertexShader, fragmentShader: 'varying vec2 vUv;uniform float uShift;void main(){gl_FragColor=vec4(.4+vUv.x*.25+uShift,-.05+vUv.y*.02,.2,.35);}',
        depthTest: false, depthWrite: false, blending: T.NoBlending });
      const cloud = new T.Mesh(geometry, source);cloud.layers.set(VOLUME_LAYER);cloud.frustumCulled = false;scene.add(cloud);
      const body = { R: 800, posUniv: new T.Vector3(0, 0, -100), frameOrientation: new T.Quaternion(),
        weatherField: {}, volCloudMesh: cloud, volCloudMat: source, volCloudBand: { rOut: 1000 } };
      const otherBody = { ...body, weatherField: {} };
      const makePipeline = () => {
        const value = new GameLegacyPipeline(renderer, scene, camera, { volume: true, volumeScale: 1, bloomEnabled: false });
        pipelines.push(value);value.setSize(32, 32);value.composer.renderToScreen = false;
        for (const pass of value.composer.passes) pass.enabled = pass === value.renderPass || pass === value.volumePass;
        value.volumePass.setActivePlanet(body, origin, 0);
        value.volumePass.resolveQuad._mesh.onBeforeRender = () => resolveObservations.push({
          history: value.volumePass.resolveMaterial.uniforms.uHistoryValid.value,
          stationary: value.volumePass.resolveMaterial.uniforms.uStationaryHistory.value,
          sequence: value.frameState.sequence, previousOrigin: value.frameState.previous.origin.toArray(),
          currentOrigin: value.frameState.current.origin.toArray(), previousBody: id(value.frameState.previous.body),
          currentBody: id(value.frameState.current.body), previousTime: value.frameState.previous.timeEpoch,
          currentTime: value.frameState.current.timeEpoch,
        });
        return value;
      };
      pipeline = makePipeline();const volume = pipeline.volumePass;
      cube = new T.WebGLCubeRenderTarget(8);renderer.setRenderTarget(cube, 3, 0);
      const assertCallerTarget = name => check(`${name}: caller target/face/mip restored`, renderer.getRenderTarget() === cube
        && renderer.getActiveCubeFace() === 3 && renderer.getActiveMipmapLevel() === 0);
      const submit = async name => {
        if (pipeline.framePacer) await awaitReady(pipeline.framePacer, name);
        label = `render:${name}`;const sequence = pipeline.frameState.sequence;
        const accepted = pipeline.render(options);
        check(`${name}: accepted render returns true`, accepted === true);
        check(`${name}: exactly one frame transaction committed`, pipeline.frameState.sequence === sequence + 1 && !pipeline.frameState.pending);
        assertCallerTarget(name);return resolveObservations.at(-1);
      };
      for (const [index, enabled] of [false, true, false, true].entries()) {
        await stop(`parity-case-${index}`);
        camera.position.set(0, 0, 0);camera.quaternion.identity();camera.updateMatrixWorld(true);
        origin.set(0, 0, 0);options.timeEpoch = 0;source.uniforms.uShift.value = 0;
        volume.setActivePlanet(body, origin, 0);pipeline.invalidateVolumeHistory(`independent-case-${index}`);
        if (enabled) pacers.push(pipeline.startFramePacing());
        const first = await submit(`case-${index}-first`);check(`case ${index}: first frame does not reuse history`, first.history === 0);
        await submit(`case-${index}-second`);const last = await submit(`case-${index}-third`);
        check(`case ${index}: true stationary history branch exercised`, last.history === 1 && last.stationary === 1);
        label = `native-readback:case-${index}`;
        const capture = { current: await read(volume.current), resolved: await read(volume.historyRead), final: await read(pipeline.composer.readBuffer) };
        check(`case ${index}: finite occupied signed/HDR native targets`, Object.values(capture).every(item => !item.metadata.nonfinite
          && item.metadata.nonzeroRGB > 1000) && capture.current.metadata.negativeRGB > 0 && capture.final.metadata.hdrRGB > 1000);
        captures.push(capture);result.cases.push({ index, pacing: enabled, sequence: pipeline.frameState.sequence,
          fence: pipeline.framePacer?.snapshot() || null, targets: Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, value.metadata])) });
        checkpoint(`parity case ${index}`);
      }
      for (const [a, b, name] of [[0, 1, 'off/on'], [0, 2, 'off native repeat'], [1, 3, 'on native repeat'], [2, 3, 'repeat off/on']]) {
        const stages = Object.fromEntries(['current', 'resolved', 'final'].map(stage => [stage, compare(captures[a][stage].bits, captures[b][stage].bits)]));
        result.comparisons.push({ name, stages });check(`${name}: all RGBA16F native bits equal`, Object.values(stages).every(delta => delta.changed === 0));
      }

      // Real budget/profiler owners must not begin a frame when foreground
      // admission is denied. No column work is manufactured for this fixture.
      pipeline.startColumnWork({ budgetMs: 1, initialUnitMs: 1, maxUnits: 1 });
      pipeline.startProfiling({ every: 1, maxPending: 256, history: 160 });
      check('Actual budget and profiler owners installed', Boolean(pipeline.columnWorkBudget && pipeline.profiler));
      const resetInput = async name => {
        await awaitReady(pipeline.framePacer, `${name}-reset`);
        camera.position.set(0, 0, 0);camera.quaternion.identity();camera.updateMatrixWorld(true);
        origin.set(0, 0, 0);options.timeEpoch = 0;source.uniforms.uShift.value = 0;
        volume.setActivePlanet(body, origin, 0);pipeline.invalidateVolumeHistory(`${name}-reset`);
        await submit(`${name}-initial`);await submit(`${name}-stable`);
      };
      const exerciseBusy = async (name, mutate, expectedHistory, expectedStationary) => {
        let observed = false;
        for (let trial = 0; trial < result.input.maxNaturalBusyTrialsPerTransition && !observed; trial++) {
          await resetInput(`${name}-${trial}`);
          // submit() returned without a readback, getError, yield or other
          // driver query. This is the first native wait after its real fence.
          mutate();volume.setActivePlanet(name === 'body' ? otherBody : body, origin, 0);
          const before = stateSnapshot(), waitsBefore = result.native.waits.length, fenceBefore = pipeline.framePacer.snapshot();
          const predecessorFence = result.native.fences.at(-1)?.id;
          label = `busy-attempt:${name}-${trial}`;
          const accepted = pipeline.render(options), after = stateSnapshot();
          const waits = result.native.waits.slice(waitsBefore), fenceAfter = pipeline.framePacer.snapshot();
          const timeout = waits.some(row => row.id === predecessorFence && row.status === gl.TIMEOUT_EXPIRED);
          const record = { name, trial, accepted, nativeTimeout: timeout, waits, fenceBefore, fenceAfter,
            before, after, unchanged: equal(before, after), mutationScope: 'Input mutation and setActivePlanet occur before the before snapshot; no skipped render is credited with their changes.' };
          result.busy.push(record);
          if (accepted) {
            check(`${name}: admitted only after native fence completion`, !timeout && pipeline.frameState.sequence === before.frame.sequence + 1);
            continue;
          }
          check(`${name}: false is backed by the real foreground TIMEOUT`, timeout && fenceAfter.pending === 1 && !fenceAfter.fault);
          check(`${name}: rejected frame does not advance any transaction/budget/profile/RT/draw`, record.unchanged);
          check(`${name}: only skipped counter advances`, fenceAfter.stats.skipped === fenceBefore.stats.skipped + 1
            && fenceAfter.stats.begun === fenceBefore.stats.begun && fenceAfter.stats.submitted === fenceBefore.stats.submitted);
          observed = true;
          const previous = frameSnapshot(pipeline.frameState.previous), sequence = pipeline.frameState.sequence;
          const submitted = await submit(`${name}-after-busy`);
          const transition = { name, skippedSequence: sequence, submittedSequence: pipeline.frameState.sequence,
            expectedHistory, expectedStationary, observation: submitted, previous, committed: frameSnapshot(pipeline.frameState.previous) };
          result.transitions.push(transition);
          check(`${name}: next submitted history uses preceding actual frame`, submitted.history === expectedHistory
            && submitted.stationary === expectedStationary && submitted.sequence === sequence
            && equal(submitted.previousOrigin, previous.origin) && submitted.previousBody === previous.body
            && submitted.previousTime === previous.timeEpoch);
          check(`${name}: next commit publishes current inputs once`, pipeline.frameState.sequence === sequence + 1
            && pipeline.frameState.previous.origin.equals(origin) && pipeline.frameState.previous.body === volume.activePlanet
            && pipeline.frameState.previous.timeEpoch === options.timeEpoch);
          label = `native-readback:after-busy-${name}`;
          const actual = { resolved: await read(volume.historyRead), final: await read(pipeline.composer.readBuffer) };
          const resolveProgram = renderer.properties.get(volume.resolveMaterial).currentProgram?.program;
          const uploaded = uniform => {
            const location = resolveProgram && gl.getUniformLocation(resolveProgram, uniform);
            return location ? gl.getUniform(resolveProgram, location) : null;
          };
          transition.uploaded = { history: uploaded('uHistoryValid'), stationary: uploaded('uStationaryHistory') };
          transition.native = Object.fromEntries(Object.entries(actual).map(([stage, value]) => [stage, value.metadata]));
          check(`${name}: actual resolve GPU branch uniforms match history contract`, transition.uploaded.history === expectedHistory
            && transition.uploaded.stationary === expectedStationary);
          check(`${name}: actual post-skip native targets finite and occupied`, Object.values(actual)
            .every(value => value.metadata.nonfinite === 0 && value.metadata.nonzeroRGB > 1000));
          const recovered = await submit(`${name}-recovered`);
          check(`${name}: next stationary actual frame recovers history`, recovered.history === 1 && recovered.stationary === 1);
        }
        check(`${name}: naturally busy native branch observed`, observed,
          { coverage: observed ? 'native TIMEOUT_EXPIRED' : 'uncovered: all native fences already signaled', trials: result.input.maxNaturalBusyTrialsPerTransition });
      };
      await exerciseBusy('stationary', () => {}, 1, 1);
      await exerciseBusy('moving', () => { origin.x = 3;camera.position.x = 2;camera.updateMatrixWorld(true); }, 1, 0);
      await exerciseBusy('body', () => {}, 0, 0);
      await exerciseBusy('time', () => { options.timeEpoch = 1; }, 0, 0);
      check('Actual budget/profiler frames equal admitted instrumented frames', pipeline.columnWorkBudget.frame === pipeline.profiler.frame);
      result.instrumentation = { budget: pipeline.columnWorkBudget.snapshot(),
        profiler: { frame: pipeline.profiler.frame, pending: pipeline.profiler.pending.length, records: pipeline.profiler.records.length,
          supported: Boolean(pipeline.profiler.ext), skipped: pipeline.profiler.skipped, discarded: pipeline.profiler.discarded } };

      // Readback positive control: a real uploaded source change must reach
      // current, production resolve and final HDR; parity cannot pass on black.
      await resetInput('negative');source.uniforms.uShift.value = .25;volume.resetHistory();
      await submit('negative-source');label = 'native-readback:negative';
      const changed = { current: await read(volume.current), resolved: await read(volume.historyRead), final: await read(pipeline.composer.readBuffer) };
      const program = renderer.properties.get(source).currentProgram;
      const location = program?.program && gl.getUniformLocation(program.program, 'uShift');
      result.negative = { uploadedShift: location ? gl.getUniform(program.program, location) : null,
        stages: Object.fromEntries(['current', 'resolved', 'final'].map(stage => [stage,
          { ...compare(captures[3][stage].bits, changed[stage].bits), ...changed[stage].metadata }])) };
      check('Positive native source-change control actually uploaded', result.negative.uploadedShift === .25);
      check('Positive source-change control changes each native HDR stage', Object.values(result.negative.stages)
        .every(delta => delta.changed > 900 && delta.alphaChanged === 0 && delta.nonfinite === 0));
      const preview = document.querySelector('#preview').getContext('2d'), image = preview.createImageData(32, 32);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 4; c++) {
        const sourceIndex = ((31 - y) * 32 + x) * 4 + c, targetIndex = (y * 32 + x) * 4 + c;
        const value = T.DataUtils.fromHalfFloat(captures[3].final.bits[sourceIndex]);
        image.data[targetIndex] = c === 3 ? 255 : Math.round(Math.pow(Math.max(0, value) / (1 + Math.max(0, value)), 1 / 2.2) * 255);
      }
      preview.putImageData(image, 0, 0);

      // Dispose immediately after a real successful submission, before any
      // native completion poll/readback. The old completion lease must survive
      // public pipeline teardown and block a second foreground owner.
      await awaitReady(pipeline.framePacer, 'dispose-predecessor');
      source.uniforms.uShift.value = 0;label = 'render:dispose-in-flight';
      check('Retirement has a real submitted frame', pipeline.render(options) === true);
      const retiredPipeline = pipeline, retired = pipeline.framePacer;result.dispose = { before: retired.snapshot() };
      check('Disposal starts with one native pending fence', result.dispose.before.pending === 1);
      label = 'dispose:in-flight';pipeline.dispose();disposedPipelines.add(pipeline);result.dispose.afterDispose = retired.snapshot();
      check('Pipeline disposal detaches and retains completion ownership', pipeline.framePacer === null
        && result.dispose.afterDispose.disposed && !result.dispose.afterDispose.released && result.dispose.afterDispose.pending === 1);
      pipeline = makePipeline();let blocked = null;
      try { pipeline.startFramePacing(); } catch (error) { blocked = String(error); }
      result.dispose.newOwnerWhilePending = blocked;
      check('A new actual pipeline cannot take a retiring foreground lease', Boolean(blocked?.includes('already has a GPU frame pacer'))
        && pipeline.framePacer === null);
      await awaitReleased(retired, 'disposed-pipeline');result.dispose.drained = retired.snapshot();
      const replacement = pipeline.startFramePacing();pacers.push(replacement);
      const observation = await submit('new-owner-after-drain');
      check('Replacement pipeline submits fresh history', observation.history === 0 && pipeline.frameState.sequence === 1);
      label = 'native-readback:replacement';const replacementCapture = await read(pipeline.composer.readBuffer);
      result.dispose.replacement = { fence: replacement.snapshot(), final: replacementCapture.metadata,
        nativeDeltaFromIndependentFirst: compare(captures[0].final.bits, replacementCapture.bits) };
      check('Replacement pipeline outputs finite nonempty native HDR', !replacementCapture.metadata.nonfinite && replacementCapture.metadata.hdrRGB > 1000);
      check('Replacement native output matches fixed independent fixture', result.dispose.replacement.nativeDeltaFromIndependentFirst.changed === 0);
      await stop('replacement');
      check('Disposed old pipeline stays detached', retiredPipeline.framePacer === null);
      checkpoint('before cleanup');
    } catch (error) { result.failure = { message: String(error.message || error), stack: String(error.stack || error) }; }
    finally {
      try {
        label = 'cleanup';
        for (const value of pipelines) if (!disposedPipelines.has(value)) {
          if (value.framePacer) await stopOwner(value);value.dispose();disposedPipelines.add(value);
        }
        async function stopOwner(value) {
          const owner = value.framePacer;value.stopFramePacing();await awaitReleased(owner, 'cleanup-owner');
        }
        for (const owner of pacers) if (!owner.snapshot().released) { owner.dispose();await awaitReleased(owner, 'cleanup-captured'); }
        renderer?.setRenderTarget(null);cube?.dispose();source?.dispose();base?.dispose();geometry?.dispose();
        if (renderer) {
          const deadline = performance.now() + result.input.deadlineMs;
          while (renderer.programRetirement.snapshot().pending) {
            if (performance.now() > deadline) throw Error('Native program retirement deadline');await pause();
          }
          result.programRetirementBeforeRendererDispose = renderer.programRetirement.snapshot();
          renderer.dispose();
          while (renderer.programRetirement.snapshot().pending) {
            if (performance.now() > deadline) throw Error('Final native program retirement deadline');await pause();
          }
          result.programRetirement = renderer.programRetirement.snapshot();
          check('Native program retirement drains without faults', result.programRetirement.pending === 0
            && result.programRetirement.blocked === 0 && result.programRetirement.faults.length === 0 && result.programRetirement.stopped);
          checkpoint('after cleanup');
        }
        check('No explicit flush/finish/server wait', result.native.forbidden.length === 0);
        check('Every actual native client fence wait has flags0/timeout0', result.native.waits.length > 0
          && result.native.waits.every(row => row.flags === 0 && row.timeout === 0));
        check('Native fence condition/flags preserved', result.native.fences.length > 0
          && result.native.fences.every(row => row.id && row.condition === gl.SYNC_GPU_COMMANDS_COMPLETE && row.flags === 0));
        check('Each native sync deleted exactly once after completion', result.native.deletes.length === result.native.fences.length
          && new Set(result.native.deletes.map(row => row.id)).size === result.native.deletes.length
          && result.native.fences.every(row => result.native.deletes.some(deleted => deleted.id === row.id
            && result.native.waits.some(wait => wait.id === row.id && wait.order > row.order && wait.order < deleted.order
              && (wait.status === gl.ALREADY_SIGNALED || wait.status === gl.CONDITION_SATISFIED)))));
        result.pacers = pacers.map(owner => owner.snapshot());
        check('All actual foreground owners drain and release cleanly', result.pacers.length === 3 && result.pacers.every(owner => owner.disposed
          && owner.released && !owner.pending && !owner.active && !owner.fault && owner.stats.abandoned === 0
          && owner.stats.completed === owner.stats.submitted));
        result.native.statusNames = { TIMEOUT_EXPIRED: gl.TIMEOUT_EXPIRED, ALREADY_SIGNALED: gl.ALREADY_SIGNALED,
          CONDITION_SATISFIED: gl.CONDITION_SATISFIED, WAIT_FAILED: gl.WAIT_FAILED };
        result.counts = counts;
      } catch (error) { result.cleanupFailure = { message: String(error.message || error), stack: String(error.stack || error) }; }
      finally {
        if (gl && nativeMethods) for (const [name, method] of Object.entries(nativeMethods)) gl[name] = method;
        document.querySelector('#status').textContent = JSON.stringify({ passed: !result.failure && !result.cleanupFailure,
          parityCases: result.cases.length, nativeBusyTransitions: result.transitions.map(row => row.name),
          failure: result.failure?.message || result.cleanupFailure?.message || null }, null, 2);
      }
    }
    return result;
  });
  await page.screenshot({ path: `${directory}/fixture.png` });
  report.after = await evidenceFingerprint(verifier);report.addonAfter = await addonFingerprint();
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  assert.equal(report.after.sourceDigest, report.before.sourceDigest, 'Runtime changed during capture');
  assert.equal(report.after.verifierDigest, report.before.verifierDigest, 'Verifier changed during capture');
  assert.deepEqual(report.addonAfter, report.addonBefore, 'Imported addon sources changed during capture');
  assert.deepEqual(report.errors, []);assert.deepEqual(report.driverWarnings, []);
  assert.equal(report.result.failure, undefined, report.result.failure?.stack);
  assert.equal(report.result.cleanupFailure, undefined, report.result.cleanupFailure?.stack);
  assert.deepEqual(report.result.shaderErrors, []);assert.deepEqual(report.result.contextLosses, []);
  assert.equal(report.result.cases.length, 4);assert.equal(report.result.comparisons.length, 4);
  assert.deepEqual(report.result.transitions.map(row => row.name), ['stationary', 'moving', 'body', 'time']);
  assert.ok(report.result.checks.every(row => row.pass));
  assert.ok(report.result.gl.length >= 6 && report.result.gl.every(row => !row.errors.length && !row.lost));
  console.log(`PASS actual pipeline native HDR parity, naturally busy fences/history and asynchronous ownership drain: ${directory}/report.json`);
} catch (error) {
  report.failure = { message: String(error.message || error), stack: String(error.stack || error) };
  if (page) try { await page.screenshot({ path: `${directory}/failure.png`, timeout: 10000 }); } catch (cause) { report.screenshotFailure = String(cause); }
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));throw error;
} finally { await browser?.close();if (server) await new Promise(resolve => server.close(resolve)); }
