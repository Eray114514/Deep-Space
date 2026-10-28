// CPU exception/ownership contracts for the actual SpatialRift render method.
// Geometry/cameras/matrices are real Three objects. Only the renderer and its
// GPU operations are doubles; this is not image or hardware acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';

const verifier = 'tools/portalrenderownershiptest.js', runtime = 'src/spatial-rift-webgl.js';
const requestedRef = process.argv.find(value => value.startsWith('--reference-ref='))?.slice(16);
// npm test must also work in shallow/source-only checkouts. The default control
// is the exact retained parent module, never a hand-maintained implementation.
const referenceFixture = JSON.parse(await readFile(new URL('fixtures/portal-render-29fbb0c.json', import.meta.url)));
const referenceRef = requestedRef || referenceFixture.ref;
const referenceCommit = requestedRef
  ? execFileSync('git', ['rev-parse', `${requestedRef}^{commit}`], { encoding: 'utf8' }).trim() : referenceFixture.commit;
const originalBytes = requestedRef ? execFileSync('git', ['show', `${referenceCommit}:${runtime}`])
  : gunzipSync(await readFile(new URL('fixtures/portal-render-29fbb0c.js.gz', import.meta.url)));
if (!requestedRef) {
  assert.equal(originalBytes.length, referenceFixture.bytes);
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'), referenceFixture.sha256);
}
const currentBytes = await readFile(new URL(`../${runtime}`, import.meta.url));
const verifierBytes = await readFile(new URL(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const prewarmFixtureBytes = await readFile(new URL('fixtures/portal-prewarm-dfc9e5c.json', import.meta.url));
const prewarmFixture = JSON.parse(prewarmFixtureBytes);
for (const value of Object.values(prewarmFixture.sources)) assert.equal(hash(value.source), value.sha256);
const prewarmReference = new Function('_center', `return ({${prewarmFixture.sources.renderPortal.source}}).renderPortal;`)(new THREE.Vector3());
const directory = `test-results/portal-render-ownership/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(directory, { recursive: true });
for (const [name, bytes] of [['reference-spatial-rift-webgl.js', originalBytes], ['spatial-rift-webgl.js', currentBytes], ['verifier.js', verifierBytes]])
  await writeFile(`${directory}/${name}`, bytes);
await writeFile(`${directory}/portal-prewarm-dfc9e5c.json`, prewarmFixtureBytes);

function method(bytes) {
  const source = bytes.toString('utf8'), start = source.indexOf('  renderPortal('), end = source.indexOf('\n  updateDistortion(', start);
  assert.ok(start > 0 && end > start, 'Actual renderPortal method boundary');
  const literal = source.slice(start, end).trim();
  return { source: literal, run: new Function('_center', `return ({${literal}}).renderPortal;`)(new THREE.Vector3()) };
}
const reference = method(originalBytes), current = method(currentBytes), cases = [], referenceControls = [];
const throwValues = [Error('controlled exception'), null, undefined, false, 0, ''];
function caught(work) {
  let threw = false, value;try { work(); } catch (error) { threw = true;value = error; }return { threw, value };
}
function fixture(run = current.run, { xr = true, autoClear = false, visible = true, target = 'cube' } = {}) {
  const events = [], hooks = new Map();let activeTarget = target ? { name: target } : null, face = target === 'cube' ? 3 : 0, mip = target === 'cube' ? 2 : 0;
  let renders = 0, clears = 0, afters = 0;
  const invoke = (name, work, args = []) => {
    events.push({ name, args });const hook = hooks.get(name);if (hook) { hooks.delete(name);hook(...args); }return work();
  };
  const renderer = { xr: { enabled: xr }, autoClear,
    getRenderTarget: () => activeTarget, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(value, nextFace = 0, nextMip = 0) {
      const name = value === f.rift.portalRT ? 'set-portal' : value === f.initial.target ? 'restore-target' : 'set-other';
      return invoke(name, () => { activeTarget = value;face = nextFace;mip = nextMip; }, [value?.name ?? null, nextFace, nextMip]);
    },
    clear() { return invoke('clear', () => { clears++; }); },
    render(scene, camera) { return invoke('draw', () => {
      assert.equal(scene, f.rift.scene);assert.equal(camera, f.rift.portalCamera);
      assert.equal(activeTarget, f.rift.portalRT);assert.equal(renderer.xr.enabled, false);
      assert.equal(f.rift.portalCamera.layers.mask, f.expectedDrawLayers);assert.equal(f.rift.group.visible, false);renders++;
    }); },
  };
  const group = new THREE.Group(), visual = new THREE.Group();group.add(visual);group.visible = visible;
  group.position.set(3, 2, -500);group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), .2);
  visual.position.set(1, 4, -2);const scene = new THREE.Scene();scene.add(group);
  const mainCamera = new THREE.PerspectiveCamera(64, 1.6, .12, 1e11);mainCamera.position.set(5, 1, 3);
  mainCamera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), .1);mainCamera.scale.set(1.1, .9, 1);
  const portalCamera = new THREE.PerspectiveCamera();portalCamera.layers.set(5);
  const rift = { renderer, scene, mainCamera, group, visual, portalCamera, open: 1, traversed: false, depth: 108,
    sourceQuaternion: new THREE.Quaternion(), targetQuaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -.3),
    unitScale: new THREE.Vector3(1, 1, 1), targetAnchor: new THREE.Vector3(1000, 2000, 3000),
    sourceFrameMatrix: new THREE.Matrix4(), targetFrameMatrix: new THREE.Matrix4(), inverseSourceMatrix: new THREE.Matrix4(),
    offsetMatrix: new THREE.Matrix4(), frameRotation: new THREE.Quaternion(), textureMatrix: new THREE.Matrix4(),
    biasMatrix: new THREE.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1),
    portalMat: { uniforms: { uTextureMatrix: { value: new THREE.Matrix4() } } }, portalRT: { name: 'portal-target' },
    portalVolumeLayerRendered: false, renderPortal: run };
  const f = { renderer, rift, events, expectedDrawLayers: (1 << 5) | (1 << 2),
    initial: { target: activeTarget, face, mip, xr, autoClear, visible, layers: portalCamera.layers.mask },
    before(name, hook) { assert.equal(hooks.has(name), false);hooks.set(name, hook); },
    state() { return { target: activeTarget, face, mip, xr: renderer.xr.enabled, autoClear: renderer.autoClear,
      visible: group.visible, layers: portalCamera.layers.mask }; },
    restored() { assert.deepEqual(f.state(), f.initial); },
    get renders() { return renders; }, get clears() { return clears; }, get afters() { return afters; },
    after() { afters++;events.push({ name: 'after-hook', args: [] }); },
    mutate() { renderer.setRenderTarget({ name: 'hook-temporary-target' }, 1, 4);renderer.xr.enabled = !xr;
      renderer.autoClear = !autoClear;portalCamera.layers.set(7);group.visible = !visible; },
    projected() { return { position: portalCamera.position.toArray(), quaternion: portalCamera.quaternion.toArray(),
      scale: portalCamera.scale.toArray(), projection: portalCamera.projectionMatrix.toArray(),
      texture: rift.portalMat.uniforms.uTextureMatrix.value.toArray(), offset: rift.offsetMatrix.toArray() }; },
  };
  return f;
}
function test(name, work) {
  try { work();cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error), actual: error?.actual, expected: error?.expected, stack: error?.stack }); }
}

// Frozen original positives prove that the fixture actually detects the old
// leak; they are not separate hand-written implementations of portal rendering.
for (const where of ['before', 'draw']) {
  const f = fixture(reference.run), failure = Error(`reference ${where}`);let afters = 0;
  const callbacks = { beforeRender: () => { if (where === 'before') throw failure; }, afterRender: () => afters++ };
  if (where === 'draw') f.before('draw', () => { throw failure; });
  const observed = caught(() => f.rift.renderPortal(callbacks));
  const leaked = f.state().layers !== f.initial.layers || f.state().visible !== f.initial.visible || f.state().xr !== f.initial.xr;
  assert.equal(observed.threw, true);assert.equal(observed.value, failure);assert.equal(afters, 0);assert.equal(leaked, true);
  referenceControls.push({ name: `Original ${where} throw leaks borrowed state and never runs afterRender`, detected: true });
}
{
  const f = fixture(reference.run);f.rift.renderPortal();assert.equal(f.state().target, f.initial.target);
  assert.notDeepEqual([f.state().face, f.state().mip], [f.initial.face, f.initial.mip]);
  referenceControls.push({ name: 'Original normal render loses caller cube face/mip', detected: true });
}
for (const options of [{ open: 0, traversed: false }, { open: 0, traversed: true }]) {
  const f = fixture(prewarmReference);Object.assign(f.rift, options);
  const returned = f.rift.renderPortal({ force: true, beforeRender: () => assert.fail('Old forced closed portal entered its scene lease') });
  assert.equal(returned, undefined);assert.equal(f.renders, 0);assert.equal(f.events.length, 0);f.restored();
  referenceControls.push({ name: `dfc9e5c ignores forced private portal render (${JSON.stringify(options)})`, detected: true,
    returned: 'undefined', renders: f.renders });
}

for (const options of [{ open: .024 }, { traversed: true }]) test(`no borrowed work on early return ${JSON.stringify(options)}`, () => {
  const f = fixture();Object.assign(f.rift, options);
  f.rift.portalVolumeLayerRendered = true;
  assert.equal(f.rift.renderPortal({ beforeRender: () => assert.fail('before'), afterRender: () => assert.fail('after') }), false);
  assert.equal(f.rift.portalVolumeLayerRendered, false, 'A skipped view cannot retain a previous successful draw marker');
  assert.equal(f.events.length, 0);assert.equal(f.renders, 0);f.restored();
});

for (const xr of [true, false]) for (const autoClear of [true, false]) for (const visible of [true, false])
  test(`normal actual method preserves projection/output inputs and caller tuple (${xr}/${autoClear}/${visible})`, () => {
    const f = fixture(current.run, { xr, autoClear, visible }), old = fixture(reference.run, { xr, autoClear, visible });
    const returned = f.rift.renderPortal({ beforeRender: camera => {
      assert.equal(camera, f.rift.portalCamera);assert.equal(camera.layers.isEnabled(2), true);assert.equal(f.rift.group.visible, false);
    }, afterRender: () => { f.after();assert.equal(f.state().target, f.initial.target);
      assert.equal(f.state().xr, xr);assert.equal(f.state().autoClear, autoClear);assert.equal(f.state().layers, f.initial.layers); } });
    old.rift.renderPortal();assert.equal(returned, true);f.restored();assert.equal(f.renders, 1);assert.equal(f.clears, 1);
    assert.equal(f.afters, 1);assert.equal(f.rift.portalVolumeLayerRendered, true);assert.deepEqual(f.projected(), old.projected());
    assert.deepEqual(f.events.filter(row => row.name === 'restore-target').map(row => row.args), [[f.initial.target.name, 3, 2]]);
  });

for (const target of [null, 'ordinary']) test(`ordinary/default caller target restored (${target})`, () => {
  const f = fixture(current.run, { target });f.rift.renderPortal();f.restored();assert.equal(f.renders, 1);
});

test('destination hook can remap camera and volume meshes to its private layer', () => {
  const f = fixture();f.expectedDrawLayers = 1 << 5;
  f.rift.renderPortal({ beforeRender: camera => { camera.layers.set(5); }, afterRender: () => f.after() });
  assert.equal(f.renders, 1);assert.equal(f.afters, 1);assert.equal(f.rift.portalVolumeLayerRendered, true);f.restored();
});

for (const traversed of [false, true]) test(`forced hidden portal renders from the actual collapsed aperture without changing animation (${traversed})`, () => {
  const f = fixture(current.run, { visible: false }), math = fixture(reference.run, { visible: false });
  for (const value of [f, math]) value.rift.visual.scale.set(.055, .045, .10).multiplyScalar(1.7);
  Object.assign(f.rift, { open: 0, targetOpen: 0, traversed, animating: false, animElapsed: 17,
    handoffActive: traversed, handoffFade: traversed ? 1 : 0 });
  const capture = () => ({ open: f.rift.open, targetOpen: f.rift.targetOpen, traversed: f.rift.traversed,
    animating: f.rift.animating, animElapsed: f.rift.animElapsed, handoffActive: f.rift.handoffActive,
    handoffFade: f.rift.handoffFade, visualPosition: f.rift.visual.position.toArray(), visualScale: f.rift.visual.scale.toArray(),
    visualRotation: f.rift.visual.quaternion.toArray(), mainPosition: f.rift.mainCamera.position.toArray(),
    mainRotation: f.rift.mainCamera.quaternion.toArray(), mainScale: f.rift.mainCamera.scale.toArray(),
    fov: f.rift.mainCamera.fov, aspect: f.rift.mainCamera.aspect });
  const before = capture();
  assert.equal(f.rift.renderPortal({ force: true, beforeRender: camera => {
    assert.equal(camera, f.rift.portalCamera);assert.equal(f.rift.group.visible, false);
    assert.ok(camera.matrixWorld.elements.every(Number.isFinite));
    assert.ok(camera.projectionMatrix.elements.every(Number.isFinite));
  }, afterRender: () => f.after() }), true);
  // The original normal math, at this identical actual aperture pose, is the
  // oracle. Force does not open/enlarge the animated aperture for a warm view.
  math.rift.renderPortal();assert.deepEqual(f.projected(), math.projected());
  assert.deepEqual(capture(), before);assert.equal(f.renders, 1);assert.equal(f.clears, 1);assert.equal(f.afters, 1);f.restored();
});

test('beforeRender admission false restores its scene lease without clear, draw, or a success marker', () => {
  const f = fixture();f.rift.portalVolumeLayerRendered = true;
  assert.equal(f.rift.renderPortal({ beforeRender: () => { f.mutate();return false; }, afterRender: () => f.after() }), false);
  assert.equal(f.renders, 0);assert.equal(f.clears, 0);assert.equal(f.afters, 1);
  assert.equal(f.rift.portalVolumeLayerRendered, false);f.restored();
});

for (const phase of ['before', 'set-portal', 'clear', 'draw', 'after'])
  for (const failure of throwValues) test(`forced private ${phase} failure preserves original throw and animation (${String(failure)})`, () => {
    const f = fixture(current.run, { visible: false });Object.assign(f.rift, { open: 0, traversed: true });
    const callbacks = { force: true, beforeRender: () => { if (phase === 'before') throw failure; },
      afterRender: () => { f.after();if (phase === 'after') throw failure; } };
    if (!['before', 'after'].includes(phase)) f.before(phase, () => { throw failure; });
    const observed = caught(() => f.rift.renderPortal(callbacks));
    assert.equal(observed.threw, true);assert.equal(observed.value, failure);assert.equal(f.afters, 1);
    assert.equal(f.rift.open, 0);assert.equal(f.rift.traversed, true);assert.equal(f.rift.portalVolumeLayerRendered, false);f.restored();
  });

for (const [index, value] of throwValues.entries()) {
  test(`beforeRender failure ${index} runs after exactly once and restores all states`, () => {
    const f = fixture();f.rift.portalVolumeLayerRendered = true;
    const observed = caught(() => f.rift.renderPortal({ beforeRender: () => { f.mutate();throw value; },
      afterRender: () => { f.after();assert.equal(f.state().target, f.initial.target);assert.equal(f.state().xr, f.initial.xr); } }));
    assert.equal(observed.threw, true);assert.equal(observed.value, value);assert.equal(f.afters, 1);assert.equal(f.renders, 0);f.restored();
    assert.equal(f.rift.portalVolumeLayerRendered, false);
  });
  test(`renderer failure ${index} plus after cleanup failure preserves the original value`, () => {
    const f = fixture(), cleanup = Error('after cleanup');f.before('draw', () => { throw value; });
    const observed = caught(() => f.rift.renderPortal({ beforeRender: () => {}, afterRender: () => { f.after();throw cleanup; } }));
    assert.equal(observed.threw, true);assert.equal(observed.value, value);assert.equal(f.afters, 1);f.restored();
    assert.equal(f.rift.portalVolumeLayerRendered, false);
  });
  test(`afterRender failure ${index} is propagated after remaining cleanup`, () => {
    const f = fixture();const observed = caught(() => f.rift.renderPortal({ afterRender: () => { f.after();f.mutate();throw value; } }));
    assert.equal(observed.threw, true);assert.equal(observed.value, value);assert.equal(f.afters, 1);assert.equal(f.renders, 1);f.restored();
    assert.equal(f.rift.portalVolumeLayerRendered, false);
  });
}

for (const phase of ['set-portal', 'clear', 'draw']) test(`${phase} native failure still releases the entered before hook`, () => {
  const f = fixture(), failure = Error(phase);let entered = 0;f.before(phase, () => { throw failure; });
  const observed = caught(() => f.rift.renderPortal({ beforeRender: () => entered++, afterRender: () => f.after() }));
  assert.equal(observed.threw, true);assert.equal(observed.value, failure);assert.equal(entered, 1);assert.equal(f.afters, 1);f.restored();
});

test('failure before entering beforeRender restores layers without inventing an after lease', () => {
  const f = fixture(), failure = Error('texture binding copy');
  f.rift.portalMat.uniforms.uTextureMatrix.value.copy = () => { throw failure; };
  const observed = caught(() => f.rift.renderPortal({ beforeRender: () => assert.fail('before not entered'), afterRender: () => f.after() }));
  assert.equal(observed.threw, true);assert.equal(observed.value, failure);assert.equal(f.afters, 0);f.restored();
});

test('normal afterRender edits to borrowed state cannot leak into the caller', () => {
  const f = fixture();f.rift.renderPortal({ afterRender: () => { f.after();f.mutate(); } });f.restored();
  assert.equal(f.afters, 1);assert.equal(f.rift.portalVolumeLayerRendered, true);
});

for (const primary of [null, undefined, false, 0, '', Error('draw primary')])
  test(`draw primary ${String(primary)} survives restore and after failures`, () => {
    const f = fixture(), restore = Error('target restore'), after = Error('after');
    f.before('draw', () => { throw primary; });f.before('restore-target', () => { throw restore; });
    const observed = caught(() => f.rift.renderPortal({ afterRender: () => { f.after();throw after; } }));
    assert.equal(observed.threw, true);assert.equal(observed.value, primary);assert.equal(f.afters, 1);f.restored();
    assert.equal(f.rift.portalVolumeLayerRendered, false);
  });

test('the first cleanup failure is propagated when the draw succeeded', () => {
  const f = fixture(), restore = Error('first cleanup'), after = Error('second cleanup');
  f.before('restore-target', () => { throw restore; });
  const observed = caught(() => f.rift.renderPortal({ afterRender: () => { f.after();throw after; } }));
  assert.equal(observed.threw, true);assert.equal(observed.value, restore);assert.equal(f.afters, 1);assert.equal(f.renders, 1);f.restored();
  assert.equal(f.rift.portalVolumeLayerRendered, false);
});

test('XR restore failure does not prevent target/autoClear/layers/after/group restoration', () => {
  const f = fixture(), error = Error('XR cleanup');let xr = f.initial.xr, fail = true;
  Object.defineProperty(f.renderer.xr, 'enabled', { get: () => xr, set(value) {
    if (value === f.initial.xr && fail) { fail = false;throw error; }xr = value;
  } });
  const observed = caught(() => f.rift.renderPortal({ afterRender: () => f.after() }));
  assert.equal(observed.threw, true);assert.equal(observed.value, error);assert.equal(f.afters, 1);f.restored();
});

test('hook promises are not awaited and cannot extend a synchronous render lease', () => {
  const f = fixture(), pending = new Promise(() => {});
  assert.equal(f.rift.renderPortal({ beforeRender: () => pending, afterRender: () => { f.after();return pending; } }), true);
  assert.equal(f.afters, 1);assert.equal(f.renders, 1);f.restored();
});

const report = { scope: 'CPU actual renderPortal method and Three transform math; renderer double. No GPU/browser/native output/performance acceptance.',
  reference: { ref: referenceRef, commit: referenceCommit, sourceSha256: hash(originalBytes), methodSha256: hash(reference.source) },
  prewarmReference: { ref: prewarmFixture.ref, commit: prewarmFixture.commit, fixtureSha256: hash(prewarmFixtureBytes),
    methodSha256: prewarmFixture.sources.renderPortal.sha256 },
  current: { path: runtime, sourceSha256: hash(currentBytes), methodSha256: hash(current.source) },
  verifier: { path: verifier, sha256: hash(verifierBytes) }, threeRevision: THREE.REVISION, referenceControls, cases };
await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
const failed = cases.filter(row => !row.passed);
for (const row of failed) console.error(`FAIL ${row.name}: ${row.error}`);
assert.equal(failed.length, 0, `Portal ownership contracts failed; ${directory}/report.json`);
console.log(`PASS ${cases.length} actual portal method CPU contracts + ${referenceControls.length} frozen-original positives: ${directory}/report.json`);
