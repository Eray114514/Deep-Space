// Actual volume selection and pipeline transaction contracts, with CPU renderer
// doubles. These checks do not establish native compilation, HDR, or GPU cost.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { VolumetricPass, VOLUME_LAYER } from '../src/volumetric-pass-webgl.js';
import { RenderFrameState } from '../src/render-frame-state.js';
import { minimumCloudRayCone } from '../src/cloud/cloud-footprint.js';

// Exact #renderScene from 36e76cc, SHA-256 over this method including its two
// leading spaces, excluding the final newline. This is an executable old graph,
// not a mirror of the proposed gate and not a missing-new-API negative control.
const referenceGraph = `  #renderScene({ origin = this.volumePass?.nav || this.camera.position, context = this.scene, timeEpoch = null } = {}) {
    let failed=false;
    const target = this.renderer.getRenderTarget();
    const face = this.renderer.getActiveCubeFace(), mip = this.renderer.getActiveMipmapLevel();
    this.frameState.begin(this.camera, origin, { context, timeEpoch, body: this.volumePass?.activePlanet });
    try {
      try {
        const body = this.volumePass?.activePlanet;
        const localEye = body?.volCloudMat?.uniforms.uCameraLocal;
        if (localEye) this.frameState.localEye(body, localEye.value);
        const airBody = this.atmospherePass.activePlanet;
        if (airBody) this.frameState.localEye(airBody, this.atmospherePass.material.uniforms.uCameraLocal.value);
        this.profiler?.beginFrame();
        this.columnWorkBudget?.beginFrame();
        this.profilePhase('cloud-cache',()=>this.updateCloudLighting());
        // RenderPass writes readBuffer. Preserve the receiver depth in the other
        // target during that draw; sampling its own depth attachment is feedback.
        // The depth is no longer consumed once AtmospherePass reuses writeBuffer.
        this.cloudSurfaceShadow.render(this.renderer,this.composer.writeBuffer,
          this.volumePass?.activePlanet,this.profiler);
        this.composer.render();
      } catch(error) {
        failed=true;throw error;
      } finally {
        try {this.renderer.setRenderTarget(target, face, mip);}
        catch(error){if(!failed)throw error;}
      }
      this.frameState.commit();
    } catch (error) {
      this.frameState.abort();
      this.volumePass?.resetHistory();
      throw error;
    }
    return true;
  }`;
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(referenceGraph), 'da3d5d32f97ad160b056f7046fedc99db2c69dcc4cd0627dee0fb13d1f3b27ab');
const oldGraph = new Function(`return ({${referenceGraph.replace('#renderScene', 'renderScene')}}).renderScene;`)();
const out = `test-results/cloud-frame-preparation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const paths = ['src/legacy-render-pipeline.js', 'src/volumetric-pass-webgl.js', 'src/cloud-program-preparation.js',
  'src/render-frame-state.js', 'src/cloud/cloud-footprint.js', 'src/gpu-preparation-queue.js',
  'src/gpu-frame-pacer.js', 'src/program-preparation.js', 'tools/cloudframepreparationtest.js'];
const frozen = new Map();
for (const path of paths) {
  try {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    frozen.set(path, bytes);await writeFile(`${out}/${path.split('/').at(-1)}`, bytes);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(`${out}/reference-render-scene.js`, `${referenceGraph}\n`);
const cases = [], fixtures = [], resources = [], rafs = new Map(), timers = new Map();
let nextTask = 0, GameLegacyPipeline = null, importFailure = null;
try { ({ GameLegacyPipeline } = await import('../src/legacy-render-pipeline.js')); }
catch (error) { importFailure = String(error); }
const original = Object.fromEntries(['matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout']
  .map(name => [name, globalThis[name]]));
globalThis.matchMedia = () => ({ matches: true });
globalThis.requestAnimationFrame = work => { const id = ++nextTask;rafs.set(id, work);return id; };
globalThis.cancelAnimationFrame = id => rafs.delete(id);
globalThis.setTimeout = (work, ms) => { const id = ++nextTask;timers.set(id, { work, ms });return id; };
globalThis.clearTimeout = id => timers.delete(id);
function caught(work) {
  let threw = false, value;try { work(); } catch (error) { threw = true;value = error; }
  assert.equal(threw, true, 'Expected the original exception');return value;
}
function test(name, work, category = 'current-contract') {
  const first = fixtures.length, allocated = resources.length;
  try { work();cases.push({ name, category, passed: true }); }
  catch (error) { cases.push({ name, category, passed: false, error: String(error), stack: error?.stack }); }
  finally {
    for (const fixture of fixtures.slice(first)) try { fixture.cleanup(); } catch (error) {
      cases.push({ name: `${name}: cleanup`, category, passed: false, error: String(error), stack: error?.stack });
    }
    for (const resource of resources.slice(allocated).reverse()) resource.dispose();
    rafs.clear();timers.clear();
  }
}
function cloudMaterial(view, cache = 0) {
  const material = new THREE.ShaderMaterial({ defines: { CLOUD_FAR_VIEW: view, CLOUD_FAR_CACHE: cache,
    PRODUCTION_CLOUD_MEDIUM: 1, STELLAR_UNION_OCCLUSION: view },
  uniforms: { uCameraLocal: { value: new THREE.Vector3(4, 5, 6) }, uColumnsReady: { value: 0 },
    uColumnMix: { value: .375 }, uEngage: { value: .75 } },
  vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'void main(){gl_FragColor=vec4(1.);}', side: THREE.BackSide, transparent: true,
  premultipliedAlpha: true, depthWrite: false });
  resources.push(material);return material;
}
function body(scene, { distance = 100000, outer = 1024, cache = 0, farCurrent = false, visible = true,
  layer = VOLUME_LAYER, parent = scene, pos = new THREE.Vector3(1e12, -2e12, 3e12) } = {}) {
  const near = cloudMaterial(0), far = cloudMaterial(1, cache);far.uniforms = near.uniforms;
  const geometry = new THREE.SphereGeometry(1, 8, 4);resources.push(geometry);
  const mesh = new THREE.Mesh(geometry, farCurrent ? far : near);mesh.layers.set(layer);mesh.visible = visible;parent.add(mesh);
  return { posUniv: pos, frameOrientation: new THREE.Quaternion(), weatherField: {}, weatherStream: { ready: false, disposed: false },
    volCloudBand: { rOut: outer }, volCloudMat: near, volCloudFarMat: far, volCloudMesh: mesh,
    origin: pos.clone().add(new THREE.Vector3(outer + distance, 0, 0)) };
}
function planFixture(options = {}) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, .1, 1e12);
  camera.projectionMatrix.identity();camera.projectionMatrixInverse.identity();
  const pass = new VolumetricPass(scene, camera);pass.width = pass.height = 64;
  const b = body(scene, options);pass.setActivePlanet(b, b.origin);camera.updateWorldMatrix(true, false);
  const f = { scene, camera, pass, body: b, plan(origin) { return pass.requiredProgramRequests(origin); },
    cleanup() { pass.dispose();scene.clear(); } };
  fixtures.push(f);return f;
}
function sameRequests(requests, expected) {
  assert.equal(requests.length, expected.length, 'Only actual required cloud owners belong in the closure');
  expected.forEach(([mesh, material, variants]) => {
    const found = requests.filter(item => item.mesh === mesh && item.material === material);
    assert.equal(found.length, 1, 'Each required mesh/material identity occurs exactly once');
    assert.deepEqual([...found[0].cacheVariants].sort(), [...variants].sort());
    assert.equal(new Set(found[0].cacheVariants).size, found[0].cacheVariants.length);
  });
}
function liveState(f) {
  const p = f.pass || f.pipeline.volumePass, b = f.body;
  const state = p.frameState;
  return { meshMaterial: b.volCloudMesh.material, meshVisible: b.volCloudMesh.visible, meshLayers: b.volCloudMesh.layers.mask,
    near: b.volCloudMat, far: b.volCloudFarMat, nearDefines: b.volCloudMat.defines, farDefines: b.volCloudFarMat.defines,
    nearDefineValues: { ...b.volCloudMat.defines }, farDefineValues: { ...b.volCloudFarMat.defines },
    versions: [b.volCloudMat.version, b.volCloudFarMat.version], uniforms: b.volCloudMat.uniforms,
    eye: b.volCloudMat.uniforms.uCameraLocal.value.toArray(), columns: b.volCloudMat.uniforms.uColumnsReady.value,
    mix: b.volCloudMat.uniforms.uColumnMix.value, engage: b.volCloudMat.uniforms.uEngage.value,
    position: b.posUniv.toArray(), orientation: b.frameOrientation.toArray(), origin: p.nav.toArray(),
    frame: p.frame, historyValid: p.historyValid, historySequence: p.historySequence,
    historyRead: p.historyRead, historyWrite: p.historyWrite, banks: [...p.columnMaps], retirement: [...p.columnRelease],
    transaction: { pending: state.pending, valid: state.valid, sequence: state.sequence, epoch: state.epoch, reason: state.reason,
      current: state.current.origin.toArray(), previous: state.previous.origin.toArray() },
    camera: { position: f.camera.position.toArray(), quaternion: f.camera.quaternion.toArray(), layers: f.camera.layers.mask,
      projection: f.camera.projectionMatrix.elements.slice(), world: f.camera.matrixWorld.elements.slice() } };
}
function pipelineFixture({ volume = true, active = true, experimental = true } = {}) {
  assert.equal(typeof GameLegacyPipeline, 'function', `Pipeline import unavailable: ${importFailure}`);
  let target = { name: 'caller' }, face = 4, mip = 2, status = true, gateError = null, throwGate = false;
  const initial = { target, face, mip }, events = [], counts = {}, listeners = new Map(), properties = new Map(), ensured = [];
  const invoke = (name, work = () => {}) => { events.push(name);counts[name] = (counts[name] || 0) + 1;return work(); };
  const gl = { isContextLost: () => false, getExtension() { assert.fail('Renderer double must not poll/compile native GPU work'); },
    finish() { assert.fail('No finish'); }, flush() { assert.fail('No flush'); }, getError() { assert.fail('No getError'); } };
  const renderer = { getContext: () => gl, getPixelRatio: () => 1, info: {}, properties,
    domElement: { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set());listeners.get(name).add(fn); },
      removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } },
    getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(value, nextFace = 0, nextMip = 0) { target = value;face = nextFace;mip = nextMip; },
    compile() { assert.fail('The gate double must not submit compilation'); }, render() { assert.fail('Only the composer CPU double may draw'); } };
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, .1, 1e12);
  camera.projectionMatrix.identity();camera.projectionMatrixInverse.identity();
  const pipeline = new GameLegacyPipeline(renderer, scene, camera, { volume,
    ...(experimental ? { cloudProgramPreparation: true } : {}) });
  const actualManager = pipeline.cloudPrograms;
  actualManager?.dispose();
  pipeline.cloudPrograms = { ensure(config) { invoke('gate.ensure');ensured.push(config);if (throwGate) throw gateError;return status; },
    snapshot: () => ({ blocked: !status, failed: !status, disposed: false }), dispose: () => invoke('gate.dispose') };
  const b = body(scene);if (!active) scene.remove(b.volCloudMesh);
  if (volume && active) pipeline.volumePass.setActivePlanet(b, b.origin);
  for (const method of ['begin', 'localEye', 'commit', 'abort']) {
    const real = pipeline.frameState[method];
    pipeline.frameState[method] = function(...args) { return invoke(`frame.${method}`, () => real.apply(this, args)); };
  }
  if (volume) {
    const reset = pipeline.volumePass.resetHistory;
    pipeline.volumePass.resetHistory = function(...args) { return invoke('history.reset', () => reset.apply(this, args)); };
    if (pipeline.volumePass.requiredProgramRequests) {
      const required = pipeline.volumePass.requiredProgramRequests;
      pipeline.volumePass.requiredProgramRequests = function(...args) { return invoke('plan', () => required.apply(this, args)); };
    }
  }
  const lighting = pipeline.updateCloudLighting;
  pipeline.updateCloudLighting = function(...args) { return invoke('cache.update', () => lighting.apply(this, args)); };
  pipeline.cloudSurfaceShadow.render = () => invoke('receiver.render');
  pipeline.composer.render = () => invoke('composer.render', () => renderer.setRenderTarget(null));
  pipeline.profiler = { beginFrame: () => invoke('profiler.begin'), run: (_name, work) => work(), dispose() {} };
  if (volume) pipeline.columnWorkBudget = { beginFrame: () => invoke('budget.begin'), dispose() {} };
  camera.updateWorldMatrix(true, false);
  const f = { pipeline, renderer, scene, camera, body: b, events, counts, ensured, actualManager,
    count: name => counts[name] || 0,
    gate(value) { status = value;throwGate = false; }, fail(value) { gateError = value;throwGate = true; },
    restored() { assert.deepEqual({ target, face, mip }, initial);assert.equal(pipeline.frameSubmissionActive, false); },
    cleanup() { pipeline.dispose();scene.clear();assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 0); } };
  fixtures.push(f);return f;
}
const graphCalls = ['frame.begin', 'frame.localEye', 'frame.commit', 'frame.abort', 'history.reset', 'profiler.begin',
  'budget.begin', 'cache.update', 'receiver.render', 'composer.render'];
const graphCounters = f => Object.fromEntries(graphCalls.map(name => [name, f.count(name)]));

try {
  // The reference is deliberately expected to violate the new contract. Missing
  // requiredProgramRequests/manager APIs cannot make this positive control pass.
  test('frozen old graph commits a frame even when the explicit manager says not ready', () => {
    const state = new RenderFrameState(), calls = {};
    const hit = name => { calls[name] = (calls[name] || 0) + 1; };
    const renderer = { getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget() {} };
    const p = { renderer, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), frameState: state,
      volumePass: { nav: new THREE.Vector3(), activePlanet: null, resetHistory: () => hit('reset') },
      atmospherePass: { activePlanet: null }, profiler: { beginFrame: () => hit('profiler') },
      columnWorkBudget: { beginFrame: () => hit('budget') }, cloudPrograms: { ensure: () => { hit('ensure');return false; } },
      profilePhase: (_name, work) => work(), updateCloudLighting: () => hit('cache'),
      cloudSurfaceShadow: { render: () => hit('receiver') }, composer: { writeBuffer: {}, render: () => hit('composer') } };
    assert.equal(oldGraph.call(p), true);assert.equal(state.sequence, 1);assert.equal(calls.ensure || 0, 0);
    for (const name of ['profiler', 'budget', 'cache', 'receiver', 'composer']) assert.equal(calls[name], 1);
  }, 'frozen-reference-negative-control');

  if (typeof VolumetricPass.prototype.requiredProgramRequests !== 'function') {
    cases.push({ name: 'requiredProgramRequests API pending', category: 'harness-pending', passed: false });
  } else {
    test('no visible cloud returns an empty plan', () => {
      const f = planFixture();f.scene.clear();assert.deepEqual(f.plan(), []);
    });
    test('ordinary materials and ShaderMaterials without the cloud view define are excluded', () => {
      const f = planFixture();f.scene.clear();f.pass.activePlanet = null;
      for (const material of [new THREE.MeshBasicMaterial(), new THREE.ShaderMaterial()]) {
        resources.push(material);const mesh = new THREE.Mesh(f.body.volCloudMesh.geometry, material);mesh.layers.set(VOLUME_LAYER);f.scene.add(mesh);
      }
      assert.deepEqual(f.plan(), []);
    });
    test('clouds outside volume layer are excluded including the active mesh', () => {
      const f = planFixture({ layer: 0 });assert.deepEqual(f.plan(), []);
    });
    test('hidden active mesh does not prepare programs', () => {
      const f = planFixture({ visible: false });assert.deepEqual(f.plan(), []);
    });
    test('a hidden ancestor suppresses its otherwise visible cloud', () => {
      const f = planFixture(), group = new THREE.Group();group.visible = false;f.scene.add(group);group.add(f.body.volCloudMesh);
      assert.deepEqual(f.plan(), []);
    });
    test('the exact 200000 metre boundary selects the near physical family', () => {
      const f = planFixture({ distance: 200000, farCurrent: true, cache: 1 });
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
    });
    test('a distance strictly above 200000 selects far even with a stale near mesh material', () => {
      const f = planFixture({ distance: 200001 });
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
    });
    test('the exact 2400 metre cone boundary cannot select cached far', () => {
      const f = planFixture(), cone = minimumCloudRayCone(f.camera.projectionMatrix.elements, 64, 64), distance = 2400 / cone;
      assert.equal(distance, 240150);f.pass.nav.copy(f.body.posUniv).add(new THREE.Vector3(f.body.volCloudBand.rOut + distance, 0, 0));
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
    });
    test('far cache closure includes both outcomes when this frame may finish the pair', () => {
      const f = planFixture({ distance: 240151 });assert.equal(f.body.volCloudMat.uniforms.uColumnsReady.value, 0);
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0, 1]]]);
    });
    test('cache already ready does not remove the physical fallback from the closure', () => {
      const f = planFixture({ distance: 300000, cache: 1, farCurrent: true });f.body.volCloudMat.uniforms.uColumnsReady.value = 1;
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0, 1]]]);
    });
    test('invalid projection conservatively prepares the physical far family only', () => {
      const f = planFixture({ distance: 1000000 });f.camera.projectionMatrix.elements[0] = 0;
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
    });
    test('missing far material preserves the real near-material route at any distance', () => {
      const f = planFixture({ distance: 1000000 });f.body.volCloudFarMat = null;
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
    });
    test('stale uCameraLocal cannot force a near pose into far preparation', () => {
      const f = planFixture();f.body.volCloudMat.uniforms.uCameraLocal.value.set(1e10, 0, 0);
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
    });
    test('stale near uniforms cannot hide a real far pose', () => {
      const f = planFixture({ distance: 300000 });f.body.volCloudMat.uniforms.uCameraLocal.value.set(0, 0, 0);
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0, 1]]]);
    });
    test('actual camera world offset crosses the near/far boundary', () => {
      const f = planFixture({ distance: 195000 });f.camera.position.set(10000, 0, 0);
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
    });
    test('camera parent rotation and translation contribute the actual world eye', () => {
      const f = planFixture({ distance: 205000 }), parent = new THREE.Group();parent.position.x = -1000;
      parent.rotation.z = Math.PI / 2;parent.add(f.camera);f.camera.position.set(0, 10000, 0);
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
      const oracleParent = new THREE.Group().copy(parent, false), oracleCamera = new THREE.PerspectiveCamera().copy(f.camera, false);
      oracleParent.add(oracleCamera);const oracle = new RenderFrameState();oracle.begin(oracleCamera, f.pass.nav, { body: f.body });
      const eye = new THREE.Vector3().setFromMatrixPosition(oracle.current.cameraWorld);assert.ok(Math.abs(eye.x + 11000) < 1e-8);
    });
    test('a manually maintained camera world matrix is honored instead of its stale position', () => {
      const f = planFixture({ distance: 195000 });f.camera.matrixWorldAutoUpdate = false;
      f.camera.matrixWorld.makeTranslation(10000, 0, 0);f.camera.position.x = -10000;
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
      assert.equal(f.camera.position.x, -10000);assert.equal(f.camera.matrixWorld.elements[12], 10000);
    });
    test('a manual local camera matrix contributes through its parent transform', () => {
      const f = planFixture({ distance: 195000 }), parent = new THREE.Group();parent.position.x = 20000;parent.add(f.camera);
      f.camera.matrixAutoUpdate = false;f.camera.matrix.makeTranslation(-10000, 0, 0);f.camera.matrixWorldNeedsUpdate = true;
      f.camera.position.x = -100000;
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
      assert.equal(f.camera.position.x, -100000);
    });
    test('planning from dirty camera ancestors does not update their live matrix caches', () => {
      const f = planFixture({ distance: 195000 }), parent = new THREE.Group();parent.position.x = 20000;
      parent.add(f.camera);f.camera.position.x = -10000;
      const capture = object => ({ matrix: object.matrix.elements.slice(), world: object.matrixWorld.elements.slice(),
        inverse: object.matrixWorldInverse?.elements.slice(), dirty: object.matrixWorldNeedsUpdate });
      const before = [capture(parent), capture(f.camera)];
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
      assert.deepEqual([capture(parent), capture(f.camera)], before, 'A pending plan must not update live ancestor/camera caches');
    });
    test('manual non-dirty camera uses the cached world eye that actual begin would read', () => {
      const f = planFixture({ distance: 195000 }), parent = new THREE.Group();parent.position.x = 20000;parent.add(f.camera);
      f.camera.matrixAutoUpdate = false;f.camera.matrix.makeTranslation(-50000, 0, 0);
      f.camera.matrixWorld.makeTranslation(10000, 0, 0);f.camera.matrixWorldNeedsUpdate = false;
      // Verify the expectation through the actual frame transaction on an
      // independent camera chain, including Three's manual dirty semantics.
      const oracleParent = new THREE.Group().copy(parent, false), oracleCamera = new THREE.PerspectiveCamera().copy(f.camera, false);
      oracleParent.add(oracleCamera);const oracle = new RenderFrameState();oracle.begin(oracleCamera, f.pass.nav, { body: f.body });
      const eye = oracle.localEye(f.body, new THREE.Vector3());assert.equal(eye.length() - f.body.volCloudBand.rOut, 205000);
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
    });
    test('an explicit origin overrides nav and camera world offset remains additive', () => {
      const f = planFixture(), origin = f.body.posUniv.clone().add(new THREE.Vector3(f.body.volCloudBand.rOut + 195000, 0, 0));
      f.camera.position.x = 10000;sameRequests(f.plan(origin), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0]]]);
      assert.deepEqual(f.pass.nav.toArray(), f.body.origin.toArray());
    });
    test('body rotation preserves the radial selection and does not rewrite its orientation', () => {
      const f = planFixture({ distance: 300000 });f.body.frameOrientation.setFromEuler(new THREE.Euler(.4, -.7, 1.2));
      const before = f.body.frameOrientation.toArray();sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0, 1]]]);
      assert.deepEqual(f.body.frameOrientation.toArray(), before);
    });
    test('a fading nonactive CACHE1 far body retains current plus retirement CACHE0', () => {
      const f = planFixture(), old = body(f.scene, { farCurrent: true, cache: 1 });
      f.pass.columnRelease.set(old, f.pass.frame);sameRequests(f.plan(), [[old.volCloudMesh, old.volCloudFarMat, [0, 1]],
        [f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
    });
    test('a fading physical far body does not invent a new CACHE1 outcome', () => {
      const f = planFixture(), old = body(f.scene, { farCurrent: true });
      sameRequests(f.plan(), [[old.volCloudMesh, old.volCloudFarMat, [0]], [f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
    });
    test('a nonactive near material uses its actual owner and full existing defines', () => {
      const f = planFixture(), old = body(f.scene);old.volCloudMat.defines.STELLAR_UNION_OCCLUSION = 7;
      sameRequests(f.plan(), [[old.volCloudMesh, old.volCloudMat, [0]], [f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
      assert.equal(old.volCloudMat.defines.STELLAR_UNION_OCCLUSION, 7);
    });
    test('array materials preserve both actual cloud material identities', () => {
      const f = planFixture(), old = body(f.scene, { cache: 1 });old.volCloudMesh.material = [old.volCloudMat, old.volCloudFarMat];
      sameRequests(f.plan(), [[old.volCloudMesh, old.volCloudMat, [0]], [old.volCloudMesh, old.volCloudFarMat, [0, 1]],
        [f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
    });
    test('no active planet still prepares every visible fading cloud', () => {
      const f = planFixture({ farCurrent: true, cache: 1 });f.pass.activePlanet = null;
      sameRequests(f.plan(), [[f.body.volCloudMesh, f.body.volCloudFarMat, [0, 1]]]);
    });
    test('pure planning preserves material identities versions uniforms history maps and pose', () => {
      const f = planFixture({ distance: 300000, cache: 1 });const before = liveState(f);
      Object.freeze(f.body.volCloudMat.defines);Object.freeze(f.body.volCloudFarMat.defines);
      const one = f.plan(), two = f.plan();assert.notEqual(one, two);assert.notEqual(one[0].cacheVariants, two[0].cacheVariants);
      assert.deepEqual(liveState(f), before);assert.equal(one[0].material.defines, before.farDefines);
    });
  }

  if (!GameLegacyPipeline) cases.push({ name: 'current pipeline module import pending', category: 'harness-pending', passed: false, error: importFailure });
  else {
    test('the actual pipeline constructor owns the manager interface', () => {
      const f = pipelineFixture();assert.ok(f.actualManager);assert.equal(typeof f.actualManager.ensure, 'function');
      assert.equal(typeof f.actualManager.snapshot, 'function');
    });
    test('pending programs prevent every world transaction and preserve the caller RT tuple', () => {
      const f = pipelineFixture();f.gate(false);const before = liveState(f), graph = graphCounters(f);
      assert.equal(f.pipeline.render(), false);assert.equal(f.count('gate.ensure'), 1);assert.deepEqual(graphCounters(f), graph);
      assert.deepEqual(liveState(f), before);f.restored();
    });
    test('failure reported as not-ready also preserves existing valid history', () => {
      const f = pipelineFixture();assert.equal(f.pipeline.render(), true);f.gate(false);
      const before = liveState(f), graph = graphCounters(f);assert.equal(f.pipeline.render(), false);
      assert.deepEqual(liveState(f), before);assert.deepEqual(graphCounters(f), graph);f.restored();
    });
    test('ready programs enter the complete real graph exactly once in the original order', () => {
      const f = pipelineFixture();assert.equal(f.pipeline.render(), true);assert.equal(f.pipeline.frameState.sequence, 1);
      for (const name of ['frame.begin', 'frame.commit', 'profiler.begin', 'budget.begin', 'cache.update', 'receiver.render', 'composer.render']) assert.equal(f.count(name), 1);
      assert.equal(f.count('frame.abort'), 0);assert.equal(f.count('history.reset'), 0);
      const sequence = ['plan', 'gate.ensure', 'frame.begin', 'profiler.begin', 'budget.begin', 'cache.update', 'receiver.render', 'composer.render', 'frame.commit'];
      for (let i = 1; i < sequence.length; i++) assert.ok(f.events.indexOf(sequence[i - 1]) < f.events.indexOf(sequence[i]), sequence.join(' -> '));
      f.restored();
    });
    test('manager receives the actual scene camera HDR target and planned identities', () => {
      const f = pipelineFixture();f.gate(false);assert.equal(f.pipeline.render(), false);const config = f.ensured[0];
      assert.equal(config.scene, f.scene);assert.equal(config.camera, f.camera);assert.equal(config.target, f.pipeline.volumePass.current);
      sameRequests(config.requests, [[f.body.volCloudMesh, f.body.volCloudMat, [0]]]);
    });
    test('retrying false false true false true advances exactly two actual world frames', () => {
      const f = pipelineFixture(), sequences = [];
      for (const ready of [false, false, true, false, true]) { f.gate(ready);assert.equal(f.pipeline.render(), ready);sequences.push(f.pipeline.frameState.sequence); }
      assert.deepEqual(sequences, [0, 0, 1, 1, 2]);assert.equal(f.count('gate.ensure'), 5);assert.equal(f.count('frame.begin'), 2);
      assert.equal(f.count('frame.commit'), 2);assert.equal(f.count('history.reset'), 0);assert.equal(f.count('frame.abort'), 0);f.restored();
    });
    test('a submitted world attempt reports false when its draw is blocked', () => {
      const f = pipelineFixture();f.gate(false);let actual;
      assert.equal(f.pipeline.submitFrame(draw => { actual = draw(); }), false);assert.equal(actual, false);
      assert.equal(f.pipeline.frameState.sequence, 0);assert.equal(f.count('frame.begin'), 0);f.restored();
    });
    test('auxiliary-only submitFrame does not consult cloud readiness or publish history', () => {
      const f = pipelineFixture();f.gate(false);let auxiliary = 0;
      assert.equal(f.pipeline.submitFrame(() => { auxiliary++; }), true);assert.equal(auxiliary, 1);
      assert.equal(f.count('gate.ensure'), 0);assert.equal(f.pipeline.frameState.sequence, 0);f.restored();
    });
    test('the ready graph uses the same explicit origin as the preflight selector', () => {
      const f = pipelineFixture(), origin = f.body.posUniv.clone().add(new THREE.Vector3(f.body.volCloudBand.rOut + 300000, 0, 0));
      assert.equal(f.pipeline.render({ origin, context: 'origin-control', timeEpoch: 7 }), true);
      sameRequests(f.ensured[0].requests, [[f.body.volCloudMesh, f.body.volCloudFarMat, [0, 1]]]);
      assert.deepEqual(f.pipeline.frameState.previous.origin.toArray(), origin.toArray());
      assert.equal(f.pipeline.frameState.previous.context, 'origin-control');assert.equal(f.pipeline.frameState.previous.timeEpoch, 7);
    });
    test('empty scene submits an empty cloud plan without inventing a cloud draw owner', () => {
      const f = pipelineFixture({ active: false });assert.equal(f.pipeline.render(), true);assert.deepEqual(f.ensured[0].requests, []);
    });
    test('disabled volume pass bypasses its cloud gate and preserves ordinary graph rendering', () => {
      const f = pipelineFixture();f.pipeline.volumePass.enabled = false;f.gate(false);
      assert.equal(f.pipeline.render(), true);assert.equal(f.count('gate.ensure'), 0);assert.equal(f.pipeline.frameState.sequence, 1);
    });
    test('the experimental gate is disabled by default and does not block the production graph', () => {
      const f = pipelineFixture({ experimental: false });f.gate(false);
      assert.equal(f.pipeline.cloudProgramsEnabled, false);assert.equal(f.pipeline.render(), true);
      assert.equal(f.count('gate.ensure'), 0);assert.equal(f.pipeline.frameState.sequence, 1);
    });
    test('a pipeline without volume has no cloud readiness dependency', () => {
      const f = pipelineFixture({ volume: false });f.gate(false);
      assert.equal(f.pipeline.render(), true);assert.equal(f.count('gate.ensure'), 0);assert.equal(f.pipeline.frameState.sequence, 1);
    });
    for (const error of [new Error('readiness diagnostic'), null, undefined, false]) {
      test(`a thrown gate value (${String(error)}) is preserved before any graph begins`, () => {
        const f = pipelineFixture();f.fail(error);const before = liveState(f), graph = graphCounters(f);
        assert.equal(caught(() => f.pipeline.render()), error);assert.deepEqual(graphCounters(f), graph);
        assert.deepEqual(liveState(f), before);f.restored();
      });
    }
  }
} finally {
  for (const [name, value] of Object.entries(original)) { if (value === undefined) delete globalThis[name];else globalThis[name] = value; }
}
const sources = [];
for (const [path, bytes] of frozen) {
  const after = await readFile(new URL(`../${path}`, import.meta.url));
  sources.push({ path, bytes: bytes.length, sha256: hash(bytes), afterSha256: hash(after), stable: hash(bytes) === hash(after) });
}
const report = { kind: 'cpu-cloud-frame-preparation-contracts',
  scope: 'Actual VolumetricPass selector and GameLegacyPipeline/RenderFrameState with CPU renderer and manager doubles; no native readiness, image parity, throughput, or cold-time acceptance',
  reference: { commit: '36e76cc', path: 'src/legacy-render-pipeline.js',
    moduleSha256: '846559627eb4acd246345ecaa89e0364fe90d330d152e7049acfa4dee4043bc0', methodSha256: hash(referenceGraph),
    method: '#renderScene', transformedOnly: 'private name -> public object method for isolated execution' },
  threeRevision: THREE.REVISION, harnessPending: cases.some(item => item.category === 'harness-pending'),
  passed: cases.filter(item => item.passed).length, total: cases.length, sources, cases };
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, ...report }, null, 2));
assert.equal(sources.every(item => item.stable), true, 'Cloud preparation inputs changed during this contract run');
assert.equal(report.passed, report.total, 'Cloud frame preparation contracts failed (missing APIs are harness pending only)');
