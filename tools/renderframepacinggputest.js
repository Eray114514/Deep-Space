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
  'node_modules/three/examples/jsm/postprocessing/Pass.js', 'node_modules/three/examples/jsm/shaders/SMAAShader.js',
  'node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js', 'node_modules/three/examples/jsm/loaders/GLTFLoader.js',
  'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js', 'node_modules/three/examples/jsm/utils/SkeletonUtils.js'];
const addonFingerprint = async () => Promise.all(addonInputs.map(async file => {
  const bytes = await readFile(file);return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
}));
await mkdir(`${directory}/inputs`, { recursive: true });
const verifierBytes = await readFile(new URL(import.meta.url));
await writeFile(`${directory}/verifier.js`, verifierBytes);
const report = {
  scope: 'Actual GameLegacyPipeline, synthetic signed cloud pixels and real constant opaque depth; production resolve/composite, native RGBA16F plain off/on then weapon/portal-auxiliary scope off/on, real WeaponLighting/WeaponSkyProbe PMREM, SurfaceWeapons.renderScopeView with a minimal optical rig and SpatialRift.renderPortal with real matrices/cameras plus one synthetic HDR destination plane, native fence admission and retirement. Queued real compilePrograms, private preparation draw and player-history recovery share that same owner. No weapon GLB or rift structure is constructed. Not authored physical clouds, column throughput, default-player, latency or frame-rate acceptance.',
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
    const { WeaponLighting } = await import('/src/weapon-lighting.js');
    const { SurfaceWeapons, SURFACE_WEAPONS } = await import('/src/surface-weapons.js');
    const { SpatialRift } = await import('/src/spatial-rift.js');
    const { compilePrograms } = await import('/src/program-preparation.js');
    const result = { checks: [], cases: [], comparisons: [], busy: [], transitions: [], scopes: [], scopeBusy: [], auxiliary: [], gl: [],
      shaderErrors: [], contextLosses: [], native: { fences: [], waits: [], deletes: [], draws: [], clears: [], forbidden: [] },
      input: { width: 32, height: 32, volumeScale: 1, successfulFramesPerCase: 3,
        maxNaturalBusyTrialsPerTransition: 24, deadlineMs: 10000,
          depth: .5, source: 'Signed deterministic cloud pixels; fixed HDR opaque source and real depth. No production weather/column workload.',
          auxiliaries: 'Real WeaponLighting.update(deferEnvironment)/prepareEnvironment and WeaponSkyProbe.fromEquirectangular; actual SurfaceWeapons.prototype.renderScopeView with the authored hasScope definition and a primitive optical rig; actual SpatialRift.prototype.renderPortal with real source/target transforms and a projection-dependent HDR destination. No weapon/rift constructor or GLB.',
          weaponEnvironment: { atmosphere: 1, skyIrradiance: 1.8, sunset: .15, up: [0, 1, 0], parityDaySequence: [.75, 1, .875] },
          portal: { destinationTranslation: [0, 0, 8], sourceRotationY: .2, depth: 2, destinationLayer: 2,
            callerCameraLayer: 5, borrowedXr: true, borrowedAutoClear: false, positiveControlFov: 42 } } };
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
    let renderer, gl, pipeline, cube, geometry, source, base, lighting, scopeRig, scopeTarget, scopeMaterial, equipmentMaterial,
      portalTarget, portalMaterial, portalGroup, preparationTarget, preparationMaterial,
      label = 'setup', nativeMethods, nativeOrder = 0;
    const pipelines = [], pacers = [], captures = [], resolveObservations = [], disposedPipelines = new Set();
    const counts = { draws: 0, queryBegins: 0, queryEnds: 0, fences: 0, auxiliaryCallbacks: 0 };
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
    const graphSnapshot = () => {
      const state = stateSnapshot();return { frame: state.frame, volume: state.volume, profiler: state.profiler,
        budget: state.budget, cloudLightFrame: state.cloudLightFrame, composer: state.composer };
    };
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
        'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'clear', 'beginQuery', 'endQuery'].map(name => [name, gl[name]]));
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
        counts.draws++;result.native.draws.push({ order: ++nativeOrder, label, call: name });return nativeMethods[name].apply(this, args);
      };
      gl.clear = function(mask) { result.native.clears.push({ order: ++nativeOrder, label, mask });return nativeMethods.clear.call(this, mask); };
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
      scopeTarget = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: true });
      scopeTarget.texture.colorSpace = T.NoColorSpace;scopeTarget.texture.name = 'fixture-actual-scope';
      scopeRig = new T.Group();scopeRig.visible = true;camera.add(scopeRig);scene.add(camera);
      const modelGroup = new T.Group();scopeRig.add(modelGroup);
      scopeMaterial = new T.MeshBasicMaterial({ map: scopeTarget.texture, toneMapped: false });
      const lens = new T.Mesh(geometry, scopeMaterial);modelGroup.add(lens);
      equipmentMaterial = new T.MeshStandardMaterial({ metalness: .8, roughness: .3 });
      modelGroup.add(new T.Mesh(geometry, equipmentMaterial));
      lighting = new WeaponLighting(scene, camera);lighting.register(scopeRig);
      const scopeIndex = SURFACE_WEAPONS.findIndex(definition => definition.hasScope), models = [];
      models[scopeIndex] = { group: modelGroup, opticGlass: lens };
      const scopeObject = { models, index: scopeIndex, rig: scopeRig, scopeTarget, scene, camera,
        scopeCamera: new T.PerspectiveCamera(4.2, 1, .12, camera.far) };
      check('Actual authored scope input selected without weapon constructor or GLB', scopeIndex >= 0
        && SURFACE_WEAPONS[scopeIndex].hasScope && lens.material.map === scopeTarget.texture && scopeRig.visible);
      // A separate tiny destination keeps the main native pixel controls
      // unchanged. The actual portal method owns all camera/texture matrices;
      // its real ShaderMaterial consumes both projectionMatrix and the
      // uTextureMatrix it publishes, without constructing the rift geometry.
      const portalScene = new T.Scene(), portalCamera = new T.PerspectiveCamera();portalCamera.layers.set(5);
      portalGroup = new T.Group();portalGroup.position.set(3, 2, -5);
      portalGroup.quaternion.setFromAxisAngle(new T.Vector3(0, 1, 0), result.input.portal.sourceRotationY);
      const portalVisual = new T.Group();portalVisual.position.set(1, 4, -2);portalGroup.add(portalVisual);portalScene.add(portalGroup);
      const hiddenSentinel = new T.Mesh(geometry, base);hiddenSentinel.layers.set(2);hiddenSentinel.frustumCulled = false;portalVisual.add(hiddenSentinel);
      portalGroup.updateMatrixWorld(true);
      const portalAnchor = portalVisual.localToWorld(new T.Vector3(0, 0, -result.input.portal.depth))
        .add(new T.Vector3(...result.input.portal.destinationTranslation));
      const portalOffset = new T.Matrix4().makeTranslation(...result.input.portal.destinationTranslation);
      portalTarget = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: true, stencilBuffer: false });
      portalTarget.texture.colorSpace = T.NoColorSpace;portalTarget.texture.name = 'fixture-actual-portal';
      portalMaterial = new T.ShaderMaterial({ uniforms: { uTextureMatrix: { value: new T.Matrix4() },
        uDestinationToSource: { value: portalOffset.clone().invert() } },
      vertexShader: 'varying vec2 vUv;varying vec4 vProjected;uniform mat4 uTextureMatrix;uniform mat4 uDestinationToSource;'
        + 'void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.0);vProjected=uTextureMatrix*uDestinationToSource*world;'
        + 'gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'varying vec2 vUv;varying vec4 vProjected;void main(){vec2 projected=vProjected.xy/vProjected.w;'
        + 'gl_FragColor=vec4(2.5+vUv.x*2.0+.125*projected.x,1.25+vUv.y*1.75+.125*projected.y,.5+vUv.x*.5,1.0);}',
      depthTest: true, depthWrite: true, blending: T.NoBlending, toneMapped: false });
      const portalDestination = new T.Mesh(geometry, portalMaterial);portalDestination.scale.set(5, 5, 1);
      portalDestination.layers.set(2);portalScene.add(portalDestination);
      const portalObject = { renderer, scene: portalScene, mainCamera: camera, group: portalGroup, visual: portalVisual,
        portalCamera, portalRT: portalTarget, portalMat: portalMaterial, open: 1, traversed: false, depth: result.input.portal.depth,
        sourceQuaternion: new T.Quaternion(), targetQuaternion: portalGroup.quaternion.clone(), unitScale: new T.Vector3(1, 1, 1),
        targetAnchor: portalAnchor, sourceFrameMatrix: new T.Matrix4(), targetFrameMatrix: new T.Matrix4(),
        inverseSourceMatrix: new T.Matrix4(), offsetMatrix: new T.Matrix4(), frameRotation: new T.Quaternion(), textureMatrix: new T.Matrix4(),
        biasMatrix: new T.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1), portalVolumeLayerRendered: false };
      const portalObservations = [];
      portalDestination.onBeforeRender = (actualRenderer, actualScene, actualCamera) => portalObservations.push({
        order: nativeOrder, label, renderer: actualRenderer === renderer, scene: actualScene === portalScene, camera: actualCamera === portalCamera,
        target: actualRenderer.getRenderTarget() === portalTarget, xr: actualRenderer.xr.enabled, autoClear: actualRenderer.autoClear,
        layers: actualCamera.layers.mask, groupVisible: portalGroup.visible, projection: actualCamera.projectionMatrix.toArray(),
        modelView: new T.Matrix4().multiplyMatrices(actualCamera.matrixWorldInverse, portalDestination.matrixWorld).toArray(),
        texture: portalMaterial.uniforms.uTextureMatrix.value.toArray(), position: actualCamera.position.toArray() });
      const matrixClose = (actual, expected, tolerance = 1e-5) => actual?.length === 16 && expected.length === 16
        && actual.every((value, index) => Number.isFinite(value) && Math.abs(value - expected[index]) <= tolerance * Math.max(1, Math.abs(expected[index])));
      const updateWeaponEnvironment = day => {
        const nativeBefore = nativeOrder, before = graphSnapshot();
        lighting.update({ renderer, sources: [], environmentIntensity: .7,
          components: { direct: true, indirect: true, reflections: true } },
        { day, atmosphere: 1, skyIrradiance: 1.8, sunset: .15 }, true, new T.Vector3(0, 1, 0), { deferEnvironment: true });
        check('Deferred real weapon environment update issues no GPU work or world transaction', nativeOrder === nativeBefore
          && equal(before, graphSnapshot()));
      };
      const renderWeaponEnvironment = name => {
        const before = graphSnapshot(), caller = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        const oldTarget = lighting.skyProbe.target, start = result.native.draws.length;label = `aux-pmrem:${name}`;
        lighting.prepareEnvironment();const target = lighting.skyProbe.target;
        const record = { name, kind: 'WeaponLighting.prepareEnvironment/WeaponSkyProbe.fromEquirectangular', target: id(target),
          key: lighting.skyProbe.key, rebuilt: target !== oldTarget, nativeDraws: result.native.draws.slice(start),
          targetRestored: renderer.getRenderTarget() === caller && renderer.getActiveCubeFace() === face && renderer.getActiveMipmapLevel() === mip,
          graphUnchanged: equal(before, graphSnapshot()) };result.auxiliary.push(record);
        check(`${name}: real weapon PMREM has a registered half-float output`, target && target.texture === equipmentMaterial.envMap
          && target.texture.name === 'weapon-outdoor-sky-pmrem' && target.texture.type === T.HalfFloatType);
        check(`${name}: real PMREM rebuild submits native draws`, !record.rebuilt || record.nativeDraws.length > 0);
        check(`${name}: vendor PMREM preserves complete caller target/face/mip`, record.targetRestored);
        check(`${name}: real PMREM does not publish a world frame`, record.graphUnchanged);
      };
      const renderActualScope = name => {
        const before = graphSnapshot(), caller = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        const rigVisible = scopeRig.visible, lensVisible = lens.visible, mask = camera.layers.mask,
          start = result.native.draws.length, clearStart = result.native.clears.length;label = `aux-scope:${name}`;
        SurfaceWeapons.prototype.renderScopeView.call(scopeObject, renderer);
        const draws = result.native.draws.slice(start), clears = result.native.clears.slice(clearStart);
        const record = { name, kind: 'SurfaceWeapons.prototype.renderScopeView', target: id(scopeTarget), draws, clears,
          visibilityRestored: scopeRig.visible === rigVisible && lens.visible === lensVisible,
          cameraLayersRestored: camera.layers.mask === mask,
          targetRestored: renderer.getRenderTarget() === caller && renderer.getActiveCubeFace() === face && renderer.getActiveMipmapLevel() === mip,
          graphUnchanged: equal(before, graphSnapshot()) };result.auxiliary.push(record);
        check(`${name}: actual scope clears then renders real geometry`, clears.length > 0 && draws.length > 0 && clears[0].order < draws[0].order);
        check(`${name}: actual scope restores complete target, rig, lens and camera layers`, record.targetRestored && record.visibilityRestored && record.cameraLayersRestored);
        check(`${name}: actual scope does not publish world history`, record.graphUnchanged);
      };
      const renderActualPortal = name => {
        const before = graphSnapshot(), caller = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel(),
          oldXr = renderer.xr.enabled, oldAutoClear = renderer.autoClear, oldLayers = portalCamera.layers.mask, oldVisible = portalGroup.visible,
          start = result.native.draws.length, clearStart = result.native.clears.length, observationStart = portalObservations.length;
        let beforeHooks = 0, afterHooks = 0, beforeHookState, afterHookState;
        const borrowedState = () => ({ target: renderer.getRenderTarget() === caller, face: renderer.getActiveCubeFace(),
          mip: renderer.getActiveMipmapLevel(), xr: renderer.xr.enabled, autoClear: renderer.autoClear,
          layers: portalCamera.layers.mask, groupVisible: portalGroup.visible });
        // Exercise real XR=true/autoClear=false borrowed state. No XR session is
        // presented. Check the method's restoration before restoring the test's
        // preparation, so these assignments cannot conceal a portal leak.
        renderer.xr.enabled = result.input.portal.borrowedXr;renderer.autoClear = result.input.portal.borrowedAutoClear;
        label = `aux-portal:${name}`;
        try {
          SpatialRift.prototype.renderPortal.call(portalObject, {
            beforeRender: actualCamera => {
              beforeHooks++;beforeHookState = { ...borrowedState(), camera: actualCamera === portalCamera };
            },
            afterRender: () => { afterHooks++;afterHookState = borrowedState(); },
          });
          const draws = result.native.draws.slice(start), clears = result.native.clears.slice(clearStart), observations = portalObservations.slice(observationStart),
            expectedWorld = new T.Matrix4().multiplyMatrices(portalOffset, camera.matrixWorld),
            expectedProjection = new T.PerspectiveCamera(camera.fov, camera.aspect, camera.near, camera.far).projectionMatrix,
            expectedTexture = portalObject.biasMatrix.clone().multiply(expectedProjection).multiply(expectedWorld.clone().invert()).multiply(portalOffset),
            program = renderer.properties.get(portalMaterial).currentProgram?.program;
          const uploaded = uniform => {
            const location = program && gl.getUniformLocation(program, uniform), value = location ? gl.getUniform(program, location) : null;
            return value ? Array.from(value) : null;
          };
          const record = { name, kind: 'SpatialRift.prototype.renderPortal', target: id(portalTarget), draws, clears, beforeHooks, afterHooks,
            beforeHookState, afterHookState, observations, projectionFov: camera.fov, portalVolumeLayerRendered: portalObject.portalVolumeLayerRendered,
            actualOffset: portalObject.offsetMatrix.toArray(), expectedOffset: portalOffset.toArray(), actualWorld: portalCamera.matrixWorld.toArray(),
            expectedWorld: expectedWorld.toArray(), expectedProjection: expectedProjection.toArray(), expectedTexture: expectedTexture.toArray(),
            nativeUniforms: { projection: uploaded('projectionMatrix'), modelView: uploaded('modelViewMatrix'), texture: uploaded('uTextureMatrix'),
              destinationToSource: uploaded('uDestinationToSource') },
            targetRestored: renderer.getRenderTarget() === caller && renderer.getActiveCubeFace() === face && renderer.getActiveMipmapLevel() === mip,
            xrRestored: renderer.xr.enabled === result.input.portal.borrowedXr, autoClearRestored: renderer.autoClear === result.input.portal.borrowedAutoClear,
            layersRestored: portalCamera.layers.mask === oldLayers, groupRestored: portalGroup.visible === oldVisible,
            graphUnchanged: equal(before, graphSnapshot()) };result.auxiliary.push(record);
          check(`${name}: actual portal clears then draws exactly its visible destination`, clears.length > 0 && draws.length === 1
            && clears[0].order < draws[0].order && observations.length === 1 && observations[0].order < draws[0].order);
          check(`${name}: real portal draw disables XR, enables volume layer and hides its group`, observations.every(row => row.renderer && row.scene
            && row.camera && row.target && !row.xr && !row.autoClear && row.layers === (oldLayers | (1 << 2)) && !row.groupVisible)
            && record.portalVolumeLayerRendered);
          check(`${name}: actual portal hooks observe the production borrow/restore order`, beforeHooks === 1 && afterHooks === 1
            && beforeHookState.camera && beforeHookState.target && beforeHookState.face === face && beforeHookState.mip === mip
            && beforeHookState.xr && !beforeHookState.autoClear && beforeHookState.layers === (oldLayers | (1 << 2)) && !beforeHookState.groupVisible
            && afterHookState.target && afterHookState.face === face && afterHookState.mip === mip && afterHookState.xr
            && !afterHookState.autoClear && afterHookState.layers === oldLayers && !afterHookState.groupVisible);
          check(`${name}: actual portal restores complete target, XR, autoClear, layers and group`, record.targetRestored && record.xrRestored
            && record.autoClearRestored && record.layersRestored && record.groupRestored);
          check(`${name}: actual portal transports source/target frames and projection`, matrixClose(record.actualOffset, record.expectedOffset, 1e-10)
            && matrixClose(record.actualWorld, record.expectedWorld, 1e-10) && matrixClose(observations[0].projection, record.expectedProjection, 1e-10)
            && matrixClose(observations[0].texture, record.expectedTexture, 1e-10));
          check(`${name}: native destination shader consumes the actual portal camera and texture projections`, matrixClose(record.nativeUniforms.projection,
            record.expectedProjection) && matrixClose(record.nativeUniforms.modelView, observations[0].modelView)
            && matrixClose(record.nativeUniforms.texture, record.expectedTexture)
            && matrixClose(record.nativeUniforms.destinationToSource, portalMaterial.uniforms.uDestinationToSource.value.toArray()));
          check(`${name}: actual portal does not publish world history`, record.graphUnchanged);
        } finally { renderer.xr.enabled = oldXr;renderer.autoClear = oldAutoClear; }
      };
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
      cube = new T.WebGLCubeRenderTarget(8, { generateMipmaps: true, minFilter: T.LinearMipmapLinearFilter });
      let callerFace = 3, callerMip = 0;renderer.setRenderTarget(cube, callerFace, callerMip);
      const assertCallerTarget = name => check(`${name}: caller target/face/mip restored`, renderer.getRenderTarget() === cube
        && renderer.getActiveCubeFace() === callerFace && renderer.getActiveMipmapLevel() === callerMip);
      const scopedSubmission = (name, { drawGraph = true } = {}) => {
        const owner = pipeline.framePacer, sequence = pipeline.frameState.sequence, graphBefore = graphSnapshot(),
          fencesBefore = result.native.fences.length, drawsBefore = result.native.draws.length,
          clearsBefore = result.native.clears.length, waitsBefore = result.native.waits.length, callbacksBefore = counts.auxiliaryCallbacks;
        label = `scope-admission:${name}`;
        const accepted = pipeline.submitFrame(draw => {
          counts.auxiliaryCallbacks++;renderWeaponEnvironment(name);renderActualScope(name);renderActualPortal(name);
          if (drawGraph) { label = `scope-graph:${name}`;check(`${name}: actual scope draw capability returns true`, draw(options) === true); }
          label = `scope-completion:${name}`;
        });
        const fences = result.native.fences.slice(fencesBefore), draws = result.native.draws.slice(drawsBefore), clears = result.native.clears.slice(clearsBefore),
          callbacks = counts.auxiliaryCallbacks - callbacksBefore;
        const record = { name, mode: drawGraph ? 'actual weapon/portal auxiliaries + graph' : 'actual weapon/portal auxiliaries only',
          pacing: Boolean(owner), accepted, callbacks, sequenceBefore: sequence, sequenceAfter: pipeline.frameState.sequence,
          owner: owner?.snapshot() || null, fences, draws, clears, waits: result.native.waits.slice(waitsBefore),
          graphUnchanged: equal(graphBefore, graphSnapshot()), callerFace, callerMip };result.scopes.push(record);
        if (!accepted) {
          check(`${name}: rejected scope executes no auxiliary callback, clear, draw or fence`, callbacks === 0 && !clears.length && !draws.length && !fences.length);
          return record;
        }
        check(`${name}: all auxiliaries share one actual synchronous callback`, callbacks === 1);
        check(`${name}: one native fence covers the admitted auxiliary/graph scope`, fences.length === Number(Boolean(owner)));
        check(`${name}: real scope GPU clears/draws precede its sole completion fence`, draws.length > 0 && (!owner
          || [...clears, ...draws].every(row => row.order < fences[0].order) && fences[0].label === `scope-completion:${name}`));
        const pmremDraws = draws.filter(row => row.label === `aux-pmrem:${name}`),
          scopeDraws = draws.filter(row => row.label === `aux-scope:${name}`),
          portalDraws = draws.filter(row => row.label === `aux-portal:${name}`),
          graphDraws = draws.filter(row => row.label === `scope-graph:${name}`);
        check(`${name}: native PMREM, actual scope, portal and graph preserve production submission order`, scopeDraws.length > 0 && portalDraws.length === 1
          && pmremDraws.every(row => row.order < scopeDraws[0].order)
          && scopeDraws.every(row => row.order < portalDraws[0].order)
          && (drawGraph ? graphDraws.length > 0 && portalDraws.every(row => row.order < graphDraws[0].order) : graphDraws.length === 0));
        if (drawGraph) check(`${name}: world graph publishes exactly once inside scope`, pipeline.frameState.sequence === sequence + 1);
        else check(`${name}: auxiliary-only scope preserves all history/budget/profiler state`, record.graphUnchanged);
        assertCallerTarget(name);return record;
      };
      const submit = async (name, { scoped = false } = {}) => {
        if (pipeline.framePacer) await awaitReady(pipeline.framePacer, name);
        label = `render:${name}`;const sequence = pipeline.frameState.sequence;
        const accepted = scoped ? scopedSubmission(name).accepted : pipeline.render(options);
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
        const scoped = index >= 2;
        callerFace = scoped ? 4 : 3;callerMip = scoped ? 1 : 0;renderer.setRenderTarget(cube, callerFace, callerMip);
        const scopeOptions = { scoped };
        if (scoped) updateWeaponEnvironment(result.input.weaponEnvironment.parityDaySequence[0]);
        const first = await submit(`case-${index}-first`, scopeOptions);check(`case ${index}: first frame does not reuse history`, first.history === 0);
        if (scoped) updateWeaponEnvironment(result.input.weaponEnvironment.parityDaySequence[1]);
        await submit(`case-${index}-second`, scopeOptions);
        if (scoped) updateWeaponEnvironment(result.input.weaponEnvironment.parityDaySequence[2]);
        const last = await submit(`case-${index}-third`, scopeOptions);
        check(`case ${index}: true stationary history branch exercised`, last.history === 1 && last.stationary === 1);
        label = `native-readback:case-${index}`;
        const capture = { current: await read(volume.current), resolved: await read(volume.historyRead), final: await read(pipeline.composer.readBuffer) };
        check(`case ${index}: finite occupied signed/HDR native targets`, Object.values(capture).every(item => !item.metadata.nonfinite
          && item.metadata.nonzeroRGB > 1000) && capture.current.metadata.negativeRGB > 0 && capture.final.metadata.hdrRGB > 1000);
        captures.push(capture);result.cases.push({ index, pacing: enabled, submission: scoped ? 'actual weapon/portal auxiliary scope' : 'plain render',
          callerFace, callerMip, sequence: pipeline.frameState.sequence,
          fence: pipeline.framePacer?.snapshot() || null, targets: Object.fromEntries(Object.entries(capture).map(([name, value]) => [name, value.metadata])) });
        checkpoint(`parity case ${index}`);
      }
      callerFace = 3;callerMip = 0;renderer.setRenderTarget(cube, callerFace, callerMip);
      check('A paced scope includes real weapon PMREM native draws', result.auxiliary.some(row => row.kind.startsWith('WeaponLighting')
        && row.name.startsWith('case-3-') && row.rebuilt && row.nativeDraws.length > 0));
      check('Both repeated native cases include three actual portal renders', [2, 3].every(index => result.auxiliary.filter(row =>
        row.kind === 'SpatialRift.prototype.renderPortal' && row.name.startsWith(`case-${index}-`) && row.draws.length === 1).length === 3));
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
      // Keep the four original graph-only native TIMEOUT trials unchanged.
      // This separate trial admits real auxiliary work only after the same
      // normal predecessor graph fence. No extra busy-making draw is inserted.
      let scopeTimeoutObserved = false;
      for (let trial = 0; trial < result.input.maxNaturalBusyTrialsPerTransition && !scopeTimeoutObserved; trial++) {
        await resetInput(`scope-busy-${trial}`);updateWeaponEnvironment(trial % 2 ? .9375 : .75);
        const before = stateSnapshot(), ownerBefore = pipeline.framePacer.snapshot(), predecessor = result.native.fences.at(-1)?.id;
        const record = scopedSubmission(`natural-busy-${trial}`), after = stateSnapshot(), ownerAfter = pipeline.framePacer.snapshot();
        const timeout = record.waits.some(row => row.id === predecessor && row.status === gl.TIMEOUT_EXPIRED);
        const observation = { trial, accepted: record.accepted, timeout, predecessor, callbacks: record.callbacks,
          ownerBefore, ownerAfter, before, after, unchanged: equal(before, after) };result.scopeBusy.push(observation);
        if (record.accepted) {
          check('An admitted scope follows a real completed predecessor', !timeout && record.callbacks === 1);
          continue;
        }
        check('Rejected real auxiliary scope is backed by native TIMEOUT', timeout && ownerAfter.pending === 1 && !ownerAfter.fault);
        check('Native scope TIMEOUT executes zero auxiliary callbacks and changes no work state', record.callbacks === 0 && observation.unchanged);
        check('Native scope TIMEOUT advances only the skip counter', ownerAfter.stats.skipped === ownerBefore.stats.skipped + 1
          && ownerAfter.stats.begun === ownerBefore.stats.begun && ownerAfter.stats.submitted === ownerBefore.stats.submitted);
        scopeTimeoutObserved = true;
      }
      check('Real auxiliary submission naturally busy branch observed', scopeTimeoutObserved,
        { coverage: scopeTimeoutObserved ? 'native TIMEOUT_EXPIRED / auxiliary callback zero' : 'uncovered: every native predecessor already completed' });

      await awaitReady(pipeline.framePacer, 'auxiliary-only');updateWeaponEnvironment(.625);
      const auxiliaryOnlyBefore = graphSnapshot(), sequenceBeforeAux = pipeline.frameState.sequence;
      const auxiliaryOnly = scopedSubmission('auxiliary-only', { drawGraph: false });
      result.auxiliaryOnly = { ...auxiliaryOnly, before: auxiliaryOnlyBefore, after: graphSnapshot() };
      check('Actual auxiliary-only work admits one fence without advancing world history', auxiliaryOnly.accepted
        && auxiliaryOnly.fences.length === 1 && pipeline.frameState.sequence === sequenceBeforeAux
        && equal(result.auxiliaryOnly.before, result.auxiliaryOnly.after));
      label = 'native-readback:real-weapon-portal-auxiliaries';
      const pmremNative = await read(lighting.skyProbe.target), scopeNative = await read(scopeTarget), portalNative = await read(portalTarget);
      result.auxiliaryNative = { pmrem: { ...pmremNative.metadata, nativeBits: Array.from(pmremNative.bits) },
        scope: { ...scopeNative.metadata, nativeBits: Array.from(scopeNative.bits) },
        portal: { ...portalNative.metadata, nativeBits: Array.from(portalNative.bits) } };
      check('Actual weapon PMREM native output is finite occupied HDR', pmremNative.metadata.nonfinite === 0
        && pmremNative.metadata.nonzeroRGB > 1000 && pmremNative.metadata.hdrRGB > 0);
      check('Actual scope native output is finite occupied HDR after real clear/render', scopeNative.metadata.nonfinite === 0
        && scopeNative.metadata.nonzeroRGB > 1000 && scopeNative.metadata.hdrRGB > 1000);
      check('Actual portal native output is finite occupied HDR after real clear/render', portalNative.metadata.nonfinite === 0
        && portalNative.metadata.nonzeroRGB > 1000 && portalNative.metadata.hdrRGB > 1000);
      assertCallerTarget('native real auxiliary readback');checkpoint('actual auxiliaries and auxiliary-only submission');
      // Isolate a genuine camera projection change in another admitted
      // auxiliary-only scope. The destination is world-space geometry, so its
      // native UV gradient must change; merely storing matrices cannot pass.
      const projectionBefore = graphSnapshot(), originalFov = camera.fov;
      let narrowedPortal, restoredPortal, narrowedSubmission, restoredSubmission;
      try {
        await awaitReady(pipeline.framePacer, 'portal-projection-positive');
        camera.fov = result.input.portal.positiveControlFov;camera.updateProjectionMatrix();
        narrowedSubmission = scopedSubmission('portal-projection-positive', { drawGraph: false });
        check('Native portal projection control is an admitted auxiliary-only frame', narrowedSubmission.accepted && narrowedSubmission.fences.length === 1);
        label = 'native-readback:portal-projection-positive';narrowedPortal = await read(portalTarget);
      } finally { camera.fov = originalFov;camera.updateProjectionMatrix(); }
      await awaitReady(pipeline.framePacer, 'portal-projection-restored');
      restoredSubmission = scopedSubmission('portal-projection-restored', { drawGraph: false });
      check('Native portal projection repeat is an admitted auxiliary-only frame', restoredSubmission.accepted && restoredSubmission.fences.length === 1);
      label = 'native-readback:portal-projection-restored';restoredPortal = await read(portalTarget);
      result.portalProjectionControl = { baselineFov: originalFov, changedFov: result.input.portal.positiveControlFov,
        narrowed: { ...narrowedPortal.metadata, nativeBits: Array.from(narrowedPortal.bits), delta: compare(portalNative.bits, narrowedPortal.bits) },
        restored: { ...restoredPortal.metadata, nativeBits: Array.from(restoredPortal.bits), delta: compare(portalNative.bits, restoredPortal.bits) },
        graphUnchanged: equal(projectionBefore, graphSnapshot()), submissions: [narrowedSubmission.name, restoredSubmission.name] };
      check('Actual portal projection FOV change reaches finite native HDR pixels', narrowedPortal.metadata.nonfinite === 0
        && narrowedPortal.metadata.nonzeroRGB > 1000 && narrowedPortal.metadata.hdrRGB > 1000
        && result.portalProjectionControl.narrowed.delta.changed > 1000 && result.portalProjectionControl.narrowed.delta.alphaChanged === 0);
      check('Restored actual portal projection repeats native bits exactly', result.portalProjectionControl.restored.delta.changed === 0
        && restoredPortal.metadata.nonfinite === 0);
      check('Native portal projection controls publish no graph history/budget/profiler', result.portalProjectionControl.graphUnchanged);
      assertCallerTarget('portal projection controls');checkpoint('actual portal projection native positive/repeat');

      // Real renderer compilation is a queued synchronous state lease, whose
      // Promise is only link readiness. A returned false may mean an admitted
      // preparation slot; native TIMEOUT proof additionally requires zero work.
      preparationTarget = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: true });
      preparationTarget.texture.colorSpace = T.NoColorSpace;
      preparationMaterial = new T.ShaderMaterial({ vertexShader, fragmentShader:
        'varying vec2 vUv;void main(){gl_FragColor=vec4(1.5+vUv.x,.8+vUv.y,.4,1.0);}',
      depthTest: false, depthWrite: false, blending: T.NoBlending });
      const preparationScene = new T.Scene(), preparationCamera = camera.clone();
      preparationScene.add(new T.Mesh(geometry, preparationMaterial));
      const preparation = result.preparation = { attempts: [], compilations: [], playerCallbacks: 0,
        scope: 'Actual compilePrograms and actual private world graph with a 32x32 synthetic HDR upload witness; not real destination content or native compile-latency acceptance.' };
      let queuedCompile, compileCalls = 0, compileOutcome = null, queuedBusyObserved = false;
      const enqueueCompile = name => {
        let workCalls = 0;
        const promise = pipeline.prepare(() => {
          workCalls++;compileCalls++;
          const before = graphSnapshot(), caller = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
          label = `prepare-compile:${name}`;
          try {
            renderer.setRenderTarget(preparationTarget);
            return compilePrograms(renderer, preparationScene, preparationCamera, null, { timeoutMs: result.input.deadlineMs });
          } finally {
            renderer.setRenderTarget(caller, face, mip);label = `prepare-compile-restored:${name}`;
            const program = renderer.properties.get(preparationMaterial).currentProgram;
            const record = { name, program: id(program), nativeHandle: id(program?.program),
              targetRestored: renderer.getRenderTarget() === caller && renderer.getActiveCubeFace() === face && renderer.getActiveMipmapLevel() === mip,
              graphUnchanged: equal(before, graphSnapshot()) };
            preparation.compilations.push(record);
            check(`${name}: queued actual compiler captures a native program`, Boolean(record.nativeHandle));
            check(`${name}: compile target lease restores synchronously before readiness`, record.targetRestored && record.graphUnchanged);
          }
        }, { label: name });
        const observed = promise.then(value => ({ success: true, value }), error => ({ success: false, error: String(error) }));
        return { observed, calls: () => workCalls };
      };
      for (let trial = 0; trial < result.input.maxNaturalBusyTrialsPerTransition && !queuedBusyObserved; trial++) {
        await submit(`preparation-predecessor-${trial}`);
        const before = stateSnapshot(), beforeQueue = pipeline.preparations.snapshot(),
          fence = result.native.fences.at(-1), waitsBefore = result.native.waits.length,
          fencesBefore = result.native.fences.length, playerBefore = preparation.playerCallbacks;
        queuedCompile = enqueueCompile(`native-program-${trial}`);
        check('Enqueuing a real compilation performs no renderer submission', queuedCompile.calls() === 0
          && result.native.fences.length === fencesBefore && equal(before, stateSnapshot()));
        label = `prepare-admission:${trial}`;
        const accepted = pipeline.submitFrame(draw => { preparation.playerCallbacks++;return draw(options); });
        const after = stateSnapshot(), waits = result.native.waits.slice(waitsBefore),
          timeout = waits.some(row => row.id === fence.id && row.status === gl.TIMEOUT_EXPIRED);
        const record = { trial, accepted, timeout, callbacks: queuedCompile.calls(), beforeQueue,
          afterQueue: pipeline.preparations.snapshot(), waits, fences: result.native.fences.slice(fencesBefore),
          unchanged: equal(before, after), playerCallbacks: preparation.playerCallbacks - playerBefore };
        preparation.attempts.push(record);
        check('Preparation requests never execute the caller player callback in their reserved slot', accepted === false && record.playerCallbacks === 0);
        if (timeout) {
          check('Queued preparation native TIMEOUT has no compile, draw, clear, new fence or transaction mutation', record.callbacks === 0
            && record.fences.length === 0 && record.unchanged && record.afterQueue.queued === 1
            && record.afterQueue.stats.executed === record.beforeQueue.stats.executed);
          queuedBusyObserved = true;
        } else {
          check('A preparation false after native completion is classified as admitted work rather than busy', record.callbacks === 1
            && record.fences.length === 1 && record.afterQueue.stats.executed === record.beforeQueue.stats.executed + 1);
          const outcome = await queuedCompile.observed;check('Actual native program readiness succeeds', outcome.success);
        }
      }
      check('Queued compiler naturally busy native branch observed', queuedBusyObserved,
        { coverage: queuedBusyObserved ? 'native TIMEOUT_EXPIRED / zero preparation callback' : 'uncovered native busy', trials: result.input.maxNaturalBusyTrialsPerTransition });
      await awaitReady(pipeline.framePacer, 'queued-compile-admission');
      if (queuedCompile.calls() === 0) {
        label = 'prepare-compile:admit';const calls = preparation.playerCallbacks;
        check('Ready queued compiler consumes only a preparation slot', pipeline.submitFrame(draw => {
          preparation.playerCallbacks++;return draw(options);
        }) === false && preparation.playerCallbacks === calls);
      }
      check('The queued compiler executes once after native readiness', queuedCompile.calls() === 1);
      const beforePlayer = pipeline.frameState.sequence;
      await submit('player-after-queued-compile');
      check('Unrelated player rendering continues after compiler submission', pipeline.frameState.sequence === beforePlayer + 1);
      compileOutcome = await queuedCompile.observed;check('Real queued compilePrograms readiness succeeds', compileOutcome.success);
      const preparedProgram = renderer.properties.get(preparationMaterial).currentProgram;
      preparation.compile = { calls: compileCalls, program: id(preparedProgram), nativeHandle: id(preparedProgram?.program),
        queue: pipeline.preparations.snapshot(), resultSceneMatches: compileOutcome.value === preparationScene };
      check('Native readiness settles the original source and releases the preparation job', preparation.compile.resultSceneMatches
        && preparation.compile.nativeHandle && preparation.compile.queue.pending === 0);
      assertCallerTarget('after actual queued compiler');checkpoint('actual queued compile and normal player frame');

      await awaitReady(pipeline.framePacer, 'queued-private-admission');
      const privateSequence = pipeline.frameState.sequence, privateFences = result.native.fences.length,
        privateGraphContext = {}, privatePlayerCallbacks = preparation.playerCallbacks;
      const previousPlayerFrame = frameSnapshot(pipeline.frameState.previous);
      let privateDrawCalls = 0, privateScopeRestored = false;
      const privateJob = pipeline.prepare(draw => {
        privateDrawCalls++;const caller = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel(), shift = source.uniforms.uShift.value;
        try {
          label = 'prepare-private:upload-witness';renderer.setRenderTarget(preparationTarget);renderer.clear();renderer.render(preparationScene, preparationCamera);
          source.uniforms.uShift.value = .125;label = 'prepare-private:production-graph';
          check('Queued private work receives the actual admitted one-use graph', draw({ ...options, context: privateGraphContext }) === true);
          return true;
        } finally {
          source.uniforms.uShift.value = shift;
          renderer.setRenderTarget(caller, face, mip);label = 'prepare-private:restored';
          privateScopeRestored = renderer.getRenderTarget() === caller && renderer.getActiveCubeFace() === face && renderer.getActiveMipmapLevel() === mip;
        }
      }, { label: 'private-destination-fixture' }).then(value => ({ success: true, value }), error => ({ success: false, error: String(error) }));
      check('Private preparation enqueue borrows no scene state', privateDrawCalls === 0 && pipeline.frameState.sequence === privateSequence);
      label = 'prepare-private:admission';
      const privateAccepted = pipeline.submitFrame(draw => { preparation.playerCallbacks++;return draw(options); });
      const privateOutcome = await privateJob, privateFencesAfter = result.native.fences.slice(privateFences);
      preparation.private = { callerAccepted: privateAccepted, workCalls: privateDrawCalls, scopeRestored: privateScopeRestored,
        sequenceBefore: privateSequence, sequenceAfter: pipeline.frameState.sequence, historyValidAfter: pipeline.frameState.valid,
        previousPlayerPreserved: equal(previousPlayerFrame, frameSnapshot(pipeline.frameState.previous)),
        historyReason: pipeline.frameState.reason, volumeHistoryValidAfter: volume.historyValid,
        playerCallbacks: preparation.playerCallbacks - privatePlayerCallbacks, outcome: privateOutcome,
        fences: privateFencesAfter, queue: pipeline.preparations.snapshot() };
      check('A queued private graph is never counted as the requested player graph', privateAccepted === false
        && privateDrawCalls === 1 && preparation.private.playerCallbacks === 0 && privateOutcome.success && privateOutcome.value === true);
      check('Private native graph preserves the player snapshot and invalidates its borrowed history',
        preparation.private.sequenceAfter === privateSequence && preparation.private.previousPlayerPreserved
        && preparation.private.historyReason === 'private-prewarm' && !preparation.private.historyValidAfter
        && !preparation.private.volumeHistoryValidAfter && privateScopeRestored);
      check('One captured native fence follows the entire private upload/graph/restore scope', privateFencesAfter.length === 1
        && privateFencesAfter[0].label === 'prepare-private:restored');
      const privateCurrent = await read(volume.current), privateFinal = await read(pipeline.composer.readBuffer), uploadWitness = await read(preparationTarget);
      preparation.private.native = { current: { ...privateCurrent.metadata, delta: compare(captures[3].current.bits, privateCurrent.bits) },
        final: { ...privateFinal.metadata, delta: compare(captures[3].final.bits, privateFinal.bits) }, upload: uploadWitness.metadata };
      check('Queued prepared material is exercised by finite occupied native HDR upload witness', uploadWitness.metadata.nonfinite === 0
        && uploadWitness.metadata.nonzeroRGB > 1000 && uploadWitness.metadata.hdrRGB > 1000);
      check('Private source mutation reaches actual native current/final output', privateCurrent.metadata.nonfinite === 0
        && privateFinal.metadata.nonfinite === 0 && preparation.private.native.current.delta.changed > 900
        && preparation.private.native.final.delta.changed > 900);
      const recoveredPlayer = await submit('player-after-private-preparation');
      check('The first returned player frame rejects private preparation history', recoveredPlayer.history === 0);
      check('Only the recovered player frame advances the player sequence', pipeline.frameState.sequence === privateSequence + 1);
      const recoveredNative = { current: await read(volume.current), resolved: await read(volume.historyRead), final: await read(pipeline.composer.readBuffer) };
      preparation.recoveredPlayer = Object.fromEntries(Object.entries(recoveredNative).map(([stage, value]) => [stage,
        { ...value.metadata, delta: compare(captures[3][stage].bits, value.bits) }]));
      check('Restored player current/resolve/final exactly match independent native baseline after private work', Object.values(preparation.recoveredPlayer)
        .every(stage => stage.nonfinite === 0 && stage.nonzeroRGB > 1000 && stage.delta.changed === 0));
      check('Actual queued preparation jobs are all settled with no remaining state lease', pipeline.preparations.snapshot().pending === 0
        && !pipeline.preparations.snapshot().active && !pipeline.preparations.snapshot().fault);
      assertCallerTarget('queued private draw and player recovery');checkpoint('queued private native graph and player recovery');
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
        renderer?.setRenderTarget(null);lighting?.dispose();scopeRig?.removeFromParent();scopeTarget?.dispose();
        portalGroup?.removeFromParent();portalTarget?.dispose();portalMaterial?.dispose();
        preparationTarget?.dispose();preparationMaterial?.dispose();
        scopeMaterial?.dispose();equipmentMaterial?.dispose();cube?.dispose();source?.dispose();base?.dispose();geometry?.dispose();
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
