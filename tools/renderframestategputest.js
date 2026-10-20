import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = `test-results/render-frame/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/renderframestategputest.js');
const reference = execFileSync('git', ['show', 'f0e76e8:src/volumetric-pass-webgl.js']);
await writeFile(`${out}/reference-volumetric-pass-webgl.js`, reference);
const { server, port } = await startServer(0);
const errors = [];
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/tools/frame-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><link rel="icon" href="data:,"><title>Render frame ownership</title>'
    + '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
    + '<style>body{background:#172332;color:#d5e5ef;font:16px system-ui}canvas{width:320px;height:320px;image-rendering:pixelated}</style>'
    + '<p>Actual pipeline / volume history, controlled frame transitions</p><canvas id="test"></canvas>' }));
  await page.route('**/src/frame-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: reference }));
  await page.goto(`http://127.0.0.1:${port}/tools/frame-fixture.html`);
  const result = await page.evaluate(async () => {
    const T = await import('three');
    const { GameLegacyPipeline } = await import('/src/legacy-render-pipeline.js');
    const { VolumetricPass: Original } = await import('/src/frame-reference.js');
    const { VolumetricPass: Current } = await import('/src/volumetric-pass-webgl.js');
    const { FullScreenQuad, Pass } = await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('#test') });
    renderer.setSize(32, 32, false);renderer.debug.checkShaderErrors = true;
    const gl = renderer.getContext(), scene = new T.Scene();
    const camera = new T.PerspectiveCamera(60, 1, .12, 1e7);
    const geometry = new T.PlaneGeometry(2, 2);
    const material = new T.ShaderMaterial({ depthWrite: false, depthTest: false,
      uniforms: { change: { value: 0 }, uCameraLocal: { value: new T.Vector3(0, 0, 100) }, uColumnsReady: { value: 0 } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'varying vec2 vUv;uniform float change;void main(){gl_FragColor=vec4(.05+vUv.x*.3+change,.1+vUv.y*.3,.2,.7);}' });
    const mesh = new T.Mesh(geometry, material);mesh.layers.set(2);mesh.frustumCulled = false;scene.add(mesh);
    const body = { posUniv: new T.Vector3(0, 0, -100), frameOrientation: new T.Quaternion(),
      weatherField: {}, volCloudMesh: mesh, volCloudMat: material, volCloudBand: { rOut: 1000 } };
    const nav = new T.Vector3(), context = {};
    const pipeline = new GameLegacyPipeline(renderer, scene, camera, { volume: true, volumeScale: 1, bloomEnabled: false });
    pipeline.setSize(32, 32);
    const volume = pipeline.volumePass;
    for (const pass of pipeline.composer.passes) pass.enabled = pass === pipeline.renderPass || pass === volume;
    const observations = [];
    volume.resolveQuad._mesh.onBeforeRender = () => observations.push({
      valid: volume.resolveMaterial.uniforms.uHistoryValid.value,
      pending: pipeline.frameState.pending, sequence: pipeline.frameState.sequence,
      reason: pipeline.frameState.reason });
    const transitions = [];
    const draw = (name, expected, options = {}) => {
      volume.setActivePlanet(options.body === undefined ? body : options.body, nav, 0);
      pipeline.render({ origin: nav, context, timeEpoch: 0, ...options });
      const observed = observations.at(-1);
      transitions.push({ name, expected, ...observed, historyPublished: volume.historyValid });
    };
    draw('first', 0);draw('stationary', 1);
    volume.enabled = false;pipeline.render({ origin: nav, context, timeEpoch: 0 });volume.enabled = true;
    draw('after-skipped-volume', 0);draw('skipped-volume-recovered', 1);
    volume.resetHistory();draw('explicit-reset', 0);draw('reset-recovered', 1);
    pipeline.setSize(32, 32);draw('resize', 0);draw('resize-recovered', 1);
    draw('time-change', 0, { timeEpoch: 1 });draw('time-stable', 1, { timeEpoch: 1 });
    draw('time-return', 0);draw('time-return-stable', 1);
    const otherContext = {};draw('context-change', 0, { context: otherContext });
    draw('context-stable', 1, { context: otherContext });draw('context-return', 0);draw('context-return-stable', 1);
    body.weatherField = {};draw('medium-change', 0);draw('medium-stable', 1);
    material.needsUpdate = true;draw('representation-change', 0);draw('representation-stable', 1);
    camera.fov = 63;camera.updateProjectionMatrix();draw('continuous-fov', 1);draw('projection-stable', 1);
    camera.far *= 2;camera.updateProjectionMatrix();draw('depth-encoding-change', 0);draw('depth-encoding-stable', 1);
    pipeline.invalidateVolumeHistory('teleport');nav.x += 1;draw('small-teleport', 0);draw('teleport-stable', 1);
    nav.x += 500;draw('large-teleport', 0);draw('large-teleport-stable', 1);
    draw('inactive', 0, { body: null });draw('reactivate', 0);draw('reactivated-stable', 1);
    const otherBody = { ...body };draw('body-change', 0, { body: otherBody });
    draw('body-stable', 1, { body: otherBody });draw('body-return', 0);draw('body-return-stable', 1);

    const failure = new Error('controlled later pass failure');
    const bad = new Pass();bad.needsSwap = false;bad.render = () => { throw failure; };
    pipeline.composer.addPass(bad);
    const sequence = pipeline.frameState.sequence, previousOrigin = pipeline.frameState.previous.origin.clone();
    const cube = new T.WebGLCubeRenderTarget(16);renderer.setRenderTarget(cube, 3, 0);
    let caught = false, failureObserved = null;
    try { draw('not-published', 1); } catch (error) { caught = error === failure;failureObserved = String(error.stack); }
    const abort = { caught, historyInvalid: !volume.historyValid, frameInvalid: !pipeline.frameState.valid,
      sequenceUnchanged: pipeline.frameState.sequence === sequence,
      previousUnchanged: previousOrigin.equals(pipeline.frameState.previous.origin), pending: pipeline.frameState.pending,
      targetRestored: renderer.getRenderTarget() === cube && renderer.getActiveCubeFace() === 3 && renderer.getActiveMipmapLevel() === 0 };
    renderer.setRenderTarget(null);cube.dispose();
    pipeline.composer.removePass(bad);draw('after-later-failure', 0);draw('later-failure-recovered', 1);
    const originalTarget = renderer.setRenderTarget, restoreError = new Error('controlled target restore failure');
    const restoreCube = new T.WebGLCubeRenderTarget(16);renderer.setRenderTarget(restoreCube, 4, 0);
    let returns = 0, restoreCaught = false;
    const restoreSequence = pipeline.frameState.sequence;
    renderer.setRenderTarget = function(value, ...args) {
      if (value === restoreCube && ++returns === 2) throw restoreError;
      return originalTarget.call(this, value, ...args);
    };
    try { draw('restore-failure-unpublished', 1); } catch (error) { restoreCaught = error === restoreError; }
    finally { renderer.setRenderTarget = originalTarget;renderer.setRenderTarget(null);restoreCube.dispose(); }
    const restoreFailure = { caught: restoreCaught, sequenceUnchanged: pipeline.frameState.sequence === restoreSequence,
      historyInvalid: !volume.historyValid, pending: pipeline.frameState.pending, frameInvalid: !pipeline.frameState.valid };
    draw('after-restore-failure', 0);draw('restore-failure-recovered', 1);
    draw('private-view', 0, { context: {} });pipeline.invalidateVolumeHistory('private-prewarm');
    draw('after-private-warmup', 0);draw('warmup-recovered', 1);
    pipeline.onContextLost();draw('after-context-resource-release', 0);draw('context-recovered', 1);

    // Static old/new/old/new: unchanged scene must remain native-identical.
    const target = () => new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType,
      depthTexture: new T.DepthTexture(32, 32, T.UnsignedIntType) });
    const read = target(), write = target();
    camera.position.set(0, 0, 0);camera.quaternion.identity();camera.fov = 60;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    nav.set(0, 0, 0);renderer.setRenderTarget(read);renderer.setClearColor(0x123456, 1);renderer.clear(true, true, false);
    const native = [];
    for (const Type of [Original, Current, Original, Current]) {
      const pass = new Type(scene, camera, { scale: 1 });pass.setSize(32, 32);pass.setActivePlanet(body, nav, 0);
      material.uniforms.change.value = 0;pass.render(renderer, write, read);
      pass.render(renderer, write, read);
      const pixels = new Uint16Array(32 * 32 * 4);renderer.setRenderTarget(pass.historyRead);
      renderer.readRenderTargetPixels(pass.historyRead, 0, 0, 32, 32, pixels);native.push(pixels);pass.dispose();
    }
    const differences = native.slice(1).map(pixels => pixels.reduce((count, value, i) => count + (value !== native[0][i]), 0));
    // A small supported change separately proves reuse. A large unsupported
    // change intentionally clips now, so it is no longer an equality oracle.
    const accumulating = new Current(scene, camera, { scale: 1 });accumulating.setSize(32, 32);accumulating.setActivePlanet(body, nav, 0);
    accumulating.render(renderer, write, read);material.uniforms.change.value = .002;accumulating.render(renderer, write, read);
    const accumulated = new Uint16Array(32 * 32 * 4);renderer.setRenderTarget(accumulating.historyRead);
    renderer.readRenderTargetPixels(accumulating.historyRead, 0, 0, 32, 32, accumulated);accumulating.dispose();
    const noHistory = new Current(scene, camera, { scale: 1 });noHistory.setSize(32, 32);noHistory.setActivePlanet(body, nav, 0);
    noHistory.render(renderer, write, read);const unfiltered = new Uint16Array(32 * 32 * 4);
    renderer.setRenderTarget(noHistory.historyRead);renderer.readRenderTargetPixels(noHistory.historyRead, 0, 0, 32, 32, unfiltered);
    const historyContribution = unfiltered.reduce((count, value, i) => count + (i % 4 !== 3 && value !== accumulated[i]), 0);
    noHistory.dispose();
    const noDepth = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: false });
    renderer.setRenderTarget(noDepth);renderer.clear();
    const depthOwner = new Current(scene, camera, { scale: 1 });depthOwner.setSize(32, 32);depthOwner.setActivePlanet(body, nav, 0);
    const missingDepthSequence = [];
    depthOwner.resolveQuad._mesh.onBeforeRender = () => missingDepthSequence.push({ valid: depthOwner.resolveMaterial.uniforms.uHistoryValid.value });
    for (const source of [noDepth, noDepth, read, read]) {
      depthOwner.render(renderer, write, source);missingDepthSequence.at(-1).published = depthOwner.historyValid;
    }
    depthOwner.dispose();noDepth.dispose();
    const standalone = new Current(scene, camera, { scale: 1 });standalone.setSize(32, 32);standalone.setActivePlanet(body, nav, 0);
    const standaloneCube = new T.WebGLCubeRenderTarget(16);renderer.setRenderTarget(standaloneCube, 2, 0);
    const standaloneRead = standalone.historyRead;let standaloneCaught = false;
    renderer.setRenderTarget = function(value, ...args) {
      if (value === standaloneCube) throw restoreError;
      return originalTarget.call(this, value, ...args);
    };
    try { standalone.render(renderer, write, read); } catch (error) { standaloneCaught = error === restoreError; }
    finally { renderer.setRenderTarget = originalTarget;renderer.setRenderTarget(null);standaloneCube.dispose(); }
    const standaloneFailure = { caught: standaloneCaught, frameUncommitted: standalone.frame === 0,
      historyUnswapped: standalone.historyRead === standaloneRead, historyInvalid: !standalone.historyValid,
      stateUncommitted: standalone.frameState.sequence === 0 && !standalone.frameState.pending && !standalone.frameState.valid };
    standalone.dispose();

    // Diagnostic output from the ACTUAL resolve body: only its last output is
    // replaced. Compare previous UV with a CPU local-point projection oracle.
    volume.setActivePlanet(body, nav, 0);volume.resetHistory();
    pipeline.frameState.abort();pipeline.render({ origin: nav, context });
    const previous = { pos: body.posUniv.clone(), q: body.frameOrientation.clone(), nav: nav.clone(),
      vp: pipeline.frameState.previous.viewProjection.clone() };
    body.posUniv.add(new T.Vector3(100, -20, 30));
    body.frameOrientation.setFromAxisAngle(new T.Vector3(0, 1, 0), .15);
    nav.copy(new T.Vector3(0, 0, 100).applyQuaternion(body.frameOrientation)).add(body.posUniv);
    camera.position.set(3, 2, -4).applyQuaternion(body.frameOrientation);
    camera.quaternion.copy(body.frameOrientation);camera.updateMatrixWorld(true);
    volume.setActivePlanet(body, nav, 0);pipeline.render({ origin: nav, context });
    const diagnostic = volume.resolveMaterial.clone();diagnostic.depthTest = false;diagnostic.depthWrite = false;
    const output = 'gl_FragColor = mix(cur, hist, historyWeight);';
    if (diagnostic.fragmentShader.split(output).length !== 2) throw Error('Resolve diagnostic output authority changed');
    diagnostic.fragmentShader = diagnostic.fragmentShader.replace(output, 'gl_FragColor=vec4(prevUv,historyWeight,1.0);');
    const floatTarget = new T.WebGLRenderTarget(32, 32, { type: T.FloatType, depthBuffer: false });
    const quad = new FullScreenQuad(diagnostic);renderer.setRenderTarget(floatTarget);quad.render(renderer);
    const uv = new Float32Array(32 * 32 * 4);renderer.readRenderTargetPixels(floatTarget, 0, 0, 32, 32, uv);
    let maximumUvError = 0, oldMaximumUvError = 0, samples = 0;
    const eye = camera.position.clone(), center = body.posUniv.clone().sub(nav);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const dir = new T.Vector3((x + .5) / 16 - 1, (y + .5) / 16 - 1, 1)
        .applyMatrix4(camera.projectionMatrixInverse).normalize().transformDirection(camera.matrixWorld);
      const ray = new T.Ray(eye, dir), sphere = new T.Sphere(center, volume.radius);
      const exit = ray.intersectSphere(sphere, new T.Vector3());
      const point = eye.clone().lerp(exit, .42);
      const local = point.clone().add(nav.clone().sub(body.posUniv)).applyQuaternion(body.frameOrientation.clone().invert());
      const prevPoint = local.applyQuaternion(previous.q).add(previous.pos.clone().sub(previous.nav));
      const expected = prevPoint.applyMatrix4(previous.vp).multiplyScalar(.5).addScalar(.5);
      const oldPoint = dir.clone().multiplyScalar(new T.Ray(new T.Vector3(), dir).intersectSphere(sphere, new T.Vector3()).length() * .42)
        .add(nav.clone().sub(previous.nav)).applyMatrix4(previous.vp).multiplyScalar(.5).addScalar(.5);
      const i = (y * 32 + x) * 4;
      maximumUvError = Math.max(maximumUvError, Math.abs(uv[i] - expected.x), Math.abs(uv[i + 1] - expected.y));
      oldMaximumUvError = Math.max(oldMaximumUvError, Math.abs(oldPoint.x - expected.x), Math.abs(oldPoint.y - expected.y));samples++;
    }
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const result = { transitions, abort, restoreFailure, standaloneFailure, missingDepthSequence, historyContribution, failureObserved, differences, samples, maximumUvError, oldMaximumUvError,
      finite: native.every(pixels => pixels.every(value => Number.isFinite(T.DataUtils.fromHalfFloat(value)))),
      nonempty: native[0].some((value, i) => i % 4 !== 3 && value > 0), gl: gl.getError(), lost: gl.isContextLost(),
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      scope: 'Actual pipeline/resolve with synthetic cloud pixels and real opaque depth. Tests state ownership and rigid reprojection, not weather advection, art or frame-rate acceptance.' };
    quad.dispose();diagnostic.dispose();floatTarget.dispose();read.dispose();write.dispose();pipeline.dispose();geometry.dispose();material.dispose();
    return result;
  });
  await page.screenshot({ path: `${out}/fixture.png` });
  const after = await evidenceFingerprint('tools/renderframestategputest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);assert.equal(result.gl, 0);assert.equal(result.lost, false);
  assert.ok(result.transitions.every(row => row.valid === row.expected && row.pending), JSON.stringify(result.transitions));
  assert.deepEqual(result.abort, { caught: true, historyInvalid: true, frameInvalid: true, sequenceUnchanged: true, previousUnchanged: true, pending: false, targetRestored: true });
  assert.deepEqual(result.restoreFailure, { caught: true, sequenceUnchanged: true, historyInvalid: true, pending: false, frameInvalid: true });
  assert.ok(Object.values(result.standaloneFailure).every(Boolean));assert.ok(result.historyContribution > 900);
  assert.deepEqual(result.missingDepthSequence, [{ valid: 0, published: false }, { valid: 0, published: false }, { valid: 0, published: true }, { valid: 1, published: true }]);
  assert.deepEqual(result.differences, [0, 0, 0]);assert.ok(result.finite && result.nonempty);
  assert.ok(result.maximumUvError < 2e-6);assert.ok(result.oldMaximumUvError > .01);
  console.log(`PASS actual pipeline transitions, native static output and GPU rigid mapping: ${out}`);
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, error: String(error), stack: error.stack }, null, 2));
  throw error;
} finally {
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
