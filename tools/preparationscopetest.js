// Actual main functions with a controlled submission/readiness queue. CPU only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
const mainBytes = await readFile('src/main.js'), main = mainBytes.toString(), verifierBytes = await readFile(new URL(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const directory = `test-results/preparation-scope/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(directory, { recursive: true });await writeFile(`${directory}/main.js`, mainBytes);await writeFile(`${directory}/verifier.js`, verifierBytes);
const cases = [], functions = {};
function load(name, context) {
  const signature = main.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = main.indexOf(signature), end = main.indexOf('\n}', start);assert.ok(start >= 0 && end > start, name);
  const source = main.slice(start, end + 2);functions[name] = { bytes: Buffer.byteLength(source), sha256: hash(source) };
  return vm.runInNewContext(`(${source})`, context);
}
async function test(name, work) { try { await work();cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, error: String(error), stack: error.stack }); } }
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferredFinisher(context) {
  if (main.includes('function finishDeferredSystemMaterialPreparation(')) return load('finishDeferredSystemMaterialPreparation', context);
  // Before extraction, execute the actual inline finally body with its captured
  // body/system bindings; a missing helper is never counted as an old failure.
  const anchor = main.indexOf('Promise.resolve(prewarmWorldMaterials(body, system))');
  const start = main.indexOf('.finally(() => {', anchor), open = main.indexOf('{', start), end = main.indexOf('\n        });', open);
  assert.ok(anchor >= 0 && start >= 0 && end > open, 'Actual deferred finally callback');
  const source = main.slice(open, end + '\n        }'.length);functions.deferredInlineFinally = { bytes: Buffer.byteLength(source), sha256: hash(source) };
  return vm.runInNewContext(`(function(body, system) ${source})`, context);
}
await test('retired deferred owner releases its global gate without revealing old body or shortening next cooldown', () => {
  const system = {}, body = { group: { visible: false } }, context = { deferredSystemBuildActive: true, universe: { system: {} }, performance: { now: () => 1000 }, systemBuildResumeAt: 2800 };
  deferredFinisher(context)(body, system);assert.equal(context.deferredSystemBuildActive, false);assert.equal(body.group.visible, false);assert.equal(context.systemBuildResumeAt, 2800);
});
await test('current deferred owner retains a longer handoff cooldown while revealing its body', () => {
  const system = {}, body = { group: { visible: false } }, context = { deferredSystemBuildActive: true, universe: { system }, performance: { now: () => 1000 }, systemBuildResumeAt: 2800 };
  deferredFinisher(context)(body, system);assert.equal(context.deferredSystemBuildActive, false);assert.equal(body.group.visible, true);assert.equal(context.systemBuildResumeAt, 2800);
});
await test('current deferred owner establishes the ordinary 120ms cooldown when no longer delay exists', () => {
  const system = {}, body = { group: { visible: false } }, context = { deferredSystemBuildActive: true, universe: { system }, performance: { now: () => 1000 }, systemBuildResumeAt: 500 };
  deferredFinisher(context)(body, system);assert.equal(context.deferredSystemBuildActive, false);assert.equal(body.group.visible, true);assert.equal(context.systemBuildResumeAt, 1120);
});
function controlledQueue() {
  const jobs = [];let executing = false;
  const problem = code => Object.assign(new Error(`controlled ${code}`), { code });
  const valid = job => !job.options.signal?.aborted && (!job.options.isCurrent || job.options.isCurrent());
  return { jobs, get executing() { return executing; }, prepare(work, options = {}) {
    let resolve, reject;const promise = new Promise((yes, no) => { resolve = yes;reject = no; });
    jobs.push({ work, options, resolve, reject, promise, executed: false });return promise;
  }, admit() {
    const job = jobs.shift();assert.ok(job, 'Expected queued submission');
    if (!valid(job)) { job.reject(problem(job.options.signal?.aborted ? 'aborted' : 'obsolete'));return job; }
    executing = true;job.executed = true;
    try { job.result = job.work(() => assert.fail('Unexpected world draw')); } catch (error) { job.reject(error);return job; } finally { executing = false; }
    Promise.resolve(job.result).then(value => { if (valid(job)) job.resolve(value);else job.reject(problem(job.options.signal?.aborted ? 'aborted' : 'obsolete')); }, job.reject);
    return job;
  } };
}
function fixture(fault = 'none') {
  const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material), group = new THREE.Group();group.add(mesh);scene.add(group);
  group.visible = false;group.position.set(12, 34, 56);group.scale.setScalar(3);mesh.visible = false;
  const targetBody = { group, lod: { roots: [{ mesh }] }, waterLod: { roots: [{ mesh }] } };
  const star = visible => ({ light: { visible }, group: { visible } });
  const oldStar = star(false), newStar = star(true), oldBody = new THREE.Group();oldBody.visible = true;
  const system = { starViews: [oldStar], planets: [{ group: oldBody }], compactObjects: [] }, universe = { system, group: new THREE.Group() };
  const prepared = { starViews: [newStar] }, route = { warpRequested: false }, queue = controlledQueue(), readiness = [], destinationCaptures = [];
  let seen = 0, active = true;
  const context = { THREE, scene, camera: new THREE.PerspectiveCamera(), renderer: {}, universe,
    nodePipeline: { prepare: queue.prepare, programPreparation: new AbortController(), composer: { readBuffer: {} } }, warpCompile: new AbortController(),
    ship: { group: new THREE.Group() }, sunShadow: { visible: false }, surfaceBootstrapGroup: new THREE.Group(),
    preparedDestinationIsActive(token, passedRoute, passedPrepared) { assert.equal(token, 1);assert.equal(passedRoute, route);assert.equal(passedPrepared, prepared);return active; },
    warpPreparedWaterWarmMesh: null, warpPreparedWaterWarmPlanet: null, warpPreparedWaterWarmState: '', warpPreparedWaterWarmError: null,
    console: { error() {}, warn() {} }, clearPreparedWaterWarmMesh() { context.warpPreparedWaterWarmMesh?.removeFromParent();context.warpPreparedWaterWarmMesh = null; },
    compileDestinationVariant(renderer, options, preparation) {
      assert.equal(queue.executing, true, 'Destination selection executes inside the queue callback');
      assert.equal(renderer, context.renderer);assert.equal(options.scene, scene);assert.equal(options.camera, context.camera);
      assert.equal(options.universeRoot, universe.group);assert.equal(options.body, targetBody);assert.equal(options.destination, prepared);
      assert.equal(options.ship, context.ship);assert.equal(options.shadowLight, context.sunShadow);
      assert.equal(options.target, context.nodePipeline.composer.readBuffer);assert.deepEqual([...options.exclude], [context.surfaceBootstrapGroup]);
      assert.equal(preparation.signal, context.warpCompile.signal);
      const roots = ['lod', 'waterLod'].flatMap(kind => targetBody[kind]?.roots || []).map(root => root.mesh).filter(Boolean);
      destinationCaptures.push({ ...options, bodyGroup: options.body.group, roots });context.onDestinationCapture?.(options);
      seen++;
      if (fault === 'sync') throw Error('sync fault');
      let resolve, reject;const promise = new Promise((yes, no) => { resolve = yes;reject = no; });
      readiness.push({ resolve, reject, promise, source: options.body, shadows: options.shadows });return promise;
    },
    compilePrograms(renderer, source, camera, targetScene, options) {
      assert.equal(queue.executing, true, 'Program capture executes inside the queue callback');seen++;
      assert.equal(renderer, context.renderer);assert.equal(camera, context.camera);
      if (source !== scene) assert.equal(targetScene, scene, 'Mesh capture inherits scene lights');
      if (options) assert.equal(options.signal, context.warpCompile.signal);
      if (fault === 'sync') throw Error('sync fault');
      let resolve, reject;const promise = new Promise((yes, no) => { resolve = yes;reject = no; });
      readiness.push({ resolve, reject, promise, source });return promise;
    } };
  context.standaloneSiteGroups = load('standaloneSiteGroups', context);
  return { context, queue, scene, mesh, group, targetBody, prepared, system, route, oldStar, newStar, oldBody, readiness, destinationCaptures,
    get seen() { return seen; }, cancel() { active = false; }, dispose() { geometry.dispose();material.dispose(); } };
}
async function drainReadyPreparations(f) {
  for (let pass = 0; pass < 8; pass++) {
    while (f.queue.jobs.length) f.queue.admit();
    for (const ready of f.readiness) ready.resolve();
    await microtasks();
  }
  assert.equal(f.queue.jobs.length, 0, 'All admitted readiness continuations drained');
}
function lodContinuationFixture() {
  const f = fixture(), timers = [];
  for (const [kind, priority] of [['lod', 41], ['waterLod', 17]]) Object.assign(f.targetBody[kind], {
    startupPriority: false, buildPriority: priority, update() {}, debugStats() { return { visibleLevels: [1], pending: 0, activeMorphs: 0 }; },
  });
  f.targetBody.posUniv = new THREE.Vector3();f.targetBody.worldOffsetToLocal = (value, out) => out.copy(value);
  f.route.target = { entry: new THREE.Vector3(0, 0, 10), center: new THREE.Vector3() };
  Object.assign(f.context, { performance: { now: () => 0 }, QUALITY_LOW: false, transferredPreparedDestination: null,
    warpPreparedLodWarmPlanet: null, warpPreparedLodWarmState: 'idle', warpPreparedLodWarmError: null,
    warpPreparedRiftWarmState: 'compiling', warpPreparedRiftWarmError: null, warpPreparedRiftStructureState: 'complete', warpPreparedRiftStructurePromise: Promise.resolve(),
    setTimeout(work) { timers.push(work); }, flushChunkQueue() {} });
  f.context.uploadPreparedLodMeshes = load('uploadPreparedLodMeshes', f.context);
  f.context.prewarmPreparedRiftPortal = load('prewarmPreparedRiftPortal', f.context);
  return { ...f, timers, start() {
    load('prewarmPreparedLod', f.context)(f.targetBody, 1, f.route, f.prepared);assert.equal(timers.length, 1);timers.shift()();
    assert.equal(f.queue.jobs.length, 1);assert.equal(f.context.warpPreparedLodWarmState, 'uploading');
  }, prioritiesRestored() {
    assert.equal(f.targetBody.lod.startupPriority, false);assert.equal(f.targetBody.lod.buildPriority, 41);
    assert.equal(f.targetBody.waterLod.startupPriority, false);assert.equal(f.targetBody.waterLod.buildPriority, 17);
  } };
}
await test('fulfilled old LOD upload cannot enter portal after a microtask transfers route ownership', async () => {
  const f = lodContinuationFixture();f.start();f.queue.admit();assert.equal(f.readiness.length, 1);
  f.readiness[0].resolve();await microtasks();assert.equal(f.queue.jobs.length, 1);f.queue.admit();assert.equal(f.readiness.length, 2);
  f.readiness[1].resolve();queueMicrotask(() => {
    f.cancel();f.context.warpPreparedRiftWarmState = 'waiting';f.context.warpPreparedLodWarmState = 'waiting';
  });await microtasks();
  assert.equal(f.context.warpPreparedRiftWarmState, 'waiting');assert.equal(f.context.warpPreparedLodWarmState, 'waiting');
  f.prioritiesRestored();assert.equal(f.queue.jobs.length, 0);f.dispose();
});
await test('obsolete LOD upload rejection still returns its CPU priorities without writing a new route', async () => {
  const f = lodContinuationFixture();f.start();f.queue.admit();f.cancel();
  f.context.warpPreparedRiftWarmState = 'waiting';f.context.warpPreparedLodWarmState = 'waiting';f.readiness[0].resolve();await microtasks();
  f.prioritiesRestored();assert.equal(f.context.warpPreparedRiftWarmState, 'waiting');assert.equal(f.context.warpPreparedLodWarmState, 'waiting');
  assert.equal(f.queue.jobs.length, 0);assert.equal(f.destinationCaptures.length, 1);f.dispose();
});
for (const name of ['prewarmPreparedRiftStructure', 'prewarmPreparedWater', 'prewarmPreparedRiftPortal', 'prewarmPreparedLod']) await test(`${name} stale entry does not claim the next route's global state`, async () => {
  const f = lodContinuationFixture();f.cancel();
  Object.assign(f.context, { warpPreparedRiftStructureState: 'new-structure', warpPreparedWaterWarmState: 'new-water', warpPreparedRiftWarmState: 'new-rift', warpPreparedLodWarmState: 'new-lod' });
  const work = load(name, f.context), pending = name === 'prewarmPreparedRiftStructure'
    ? work(1, f.route, f.prepared) : work(f.targetBody, 1, f.route, f.prepared);
  const entry = { structure: f.context.warpPreparedRiftStructureState, water: f.context.warpPreparedWaterWarmState, rift: f.context.warpPreparedRiftWarmState,
    lod: f.context.warpPreparedLodWarmState, queued: f.queue.jobs.length, timers: f.timers.length };
  while (f.queue.jobs.length) f.queue.admit();while (f.timers.length) f.timers.shift()();await pending;await microtasks();
  assert.deepEqual(entry, { structure: 'new-structure', water: 'new-water', rift: 'new-rift', lod: 'new-lod', queued: 0, timers: 0 });
  f.prioritiesRestored();f.dispose();
});
for (const fault of ['none', 'sync', 'async']) await test(`LOD queued ${fault}: neither capture nor readiness borrows the live scene`, async () => {
  const f = fixture(fault), before = f.group.position.clone();
  let authoredX = 12, authoredVisible = false, authoredOldLight = false;
  f.context.onDestinationCapture = () => {
    assert.equal(f.group.position.x, authoredX);assert.equal(f.group.visible, authoredVisible);assert.equal(f.mesh.visible, authoredVisible);
    assert.equal(f.oldStar.light.visible, authoredOldLight);assert.equal(f.newStar.light.visible, true);assert.equal(f.oldBody.visible, true);
    assert.equal(f.group.scale.x, 3);assert.equal(f.mesh.frustumCulled, true);assert.equal(f.scene.children.length, 1);
  };
  const pending = load('uploadPreparedLodMeshes', f.context)(f.targetBody, f.prepared, 1, f.route), settled = pending.catch(error => assert.match(error.message, /fault/));
  assert.equal(f.seen, 0);assert.equal(f.queue.jobs.length, 1);assert.equal(f.group.visible, false);assert.ok(f.group.position.equals(before));
  assert.equal(f.oldStar.light.visible, false);assert.equal(f.oldBody.visible, true);assert.equal(f.queue.jobs[0].options.signal, f.context.warpCompile.signal);
  f.queue.admit();assert.equal(f.seen, 1);assert.equal(f.group.visible, false);assert.ok(f.group.position.equals(before));assert.equal(f.group.scale.x, 3);
  assert.equal(f.mesh.visible, false);assert.equal(f.mesh.frustumCulled, true);assert.equal(f.oldStar.light.visible, false);assert.equal(f.newStar.light.visible, true);assert.equal(f.oldBody.visible, true);
  f.group.position.set(7, 8, 9);f.group.visible = true;f.mesh.visible = true;f.oldStar.light.visible = true;
  authoredX = 7;authoredVisible = true;authoredOldLight = true;
  if (fault === 'async') f.readiness[0].reject(Error('async fault'));else f.readiness[0]?.resolve();
  if (fault === 'none') await drainReadyPreparations(f);await settled;
  assert.equal(f.destinationCaptures.length, fault === 'none' ? 2 : 1);
  assert.equal(f.group.position.x, 7);assert.equal(f.group.visible, true);assert.equal(f.mesh.visible, true);assert.equal(f.oldStar.light.visible, true);f.dispose();
});
for (const cancellation of ['token', 'signal']) await test(`LOD ${cancellation} before execution borrows nothing`, async () => {
  const f = fixture(), pending = load('uploadPreparedLodMeshes', f.context)(f.targetBody, f.prepared, 1, f.route);
  const settled = assert.rejects(pending, error => error.code === (cancellation === 'token' ? 'obsolete' : 'aborted'));
  if (cancellation === 'token') f.cancel();else f.context.warpCompile.abort();f.queue.admit();await settled;
  assert.equal(f.seen, 0);assert.equal(f.group.position.x, 12);assert.equal(f.group.visible, false);f.dispose();
});
await test('LOD warp request remains eligible after adoption transfer', async () => {
  const f = fixture();f.route.warpRequested = true;
  const pending = load('uploadPreparedLodMeshes', f.context)(f.targetBody, f.prepared, 1, f.route);f.queue.admit();assert.equal(f.seen, 1);
  await drainReadyPreparations(f);await pending;assert.deepEqual(f.destinationCaptures.map(capture => capture.shadows), [false, true]);f.dispose();
});
await test('LOD empty roots at execution retain both persistent WORLD preparations without borrowing the body', async () => {
  const f = fixture(), pending = load('uploadPreparedLodMeshes', f.context)(f.targetBody, f.prepared, 1, f.route);
  f.targetBody.lod.roots = [];f.targetBody.waterLod.roots = [];await drainReadyPreparations(f);await pending;
  assert.equal(f.seen, 2);assert.equal(f.destinationCaptures.length, 2);assert.ok(f.destinationCaptures.every(capture => capture.roots.length === 0));assert.equal(f.group.position.x, 12);f.dispose();
});
await test('LOD without a destination group queues no destination preparation', async () => {
  const f = fixture(), pending = load('uploadPreparedLodMeshes', f.context)(null, f.prepared, 1, f.route);
  assert.equal(f.queue.jobs.length, 0);await pending;assert.equal(f.destinationCaptures.length, 0);assert.equal(f.seen, 0);f.dispose();
});
await test('LOD captures shadow-off before shadow-on, selecting replacements separately after each admission', async () => {
  const f = fixture();let currentRoots = [];
  Object.defineProperty(f.targetBody.lod, 'roots', { get() {
    assert.equal(f.queue.executing, true, 'Root selection must not run before admission');return currentRoots;
  }, set(value) { currentRoots = value; } });
  const pending = load('uploadPreparedLodMeshes', f.context)(f.targetBody, f.prepared, 1, f.route);
  assert.equal(f.destinationCaptures.length, 0);assert.equal(f.queue.jobs.length, 1);
  const firstRoot = new THREE.Mesh(f.mesh.geometry, f.mesh.material), secondRoot = new THREE.Mesh(f.mesh.geometry, f.mesh.material);
  const firstGroup = new THREE.Group(), secondGroup = new THREE.Group();firstGroup.add(firstRoot);secondGroup.add(secondRoot);
  const firstTarget = {}, secondTarget = {}, secondShip = { group: new THREE.Group() };
  f.targetBody.group = firstGroup;f.targetBody.lod.roots = [{ mesh: firstRoot }];f.context.nodePipeline.composer.readBuffer = firstTarget;f.queue.admit();
  assert.equal(f.destinationCaptures.length, 1);assert.equal(f.destinationCaptures[0].shadows, false);
  assert.equal(f.destinationCaptures[0].roots[0], firstRoot);assert.equal(f.destinationCaptures[0].bodyGroup.children[0], firstRoot);
  assert.equal(f.destinationCaptures[0].target, firstTarget);assert.equal(f.queue.jobs.length, 0);
  await microtasks();assert.equal(f.queue.jobs.length, 0, 'Shadow-on must wait for shadow-off readiness');
  f.readiness[0].resolve();await microtasks();assert.equal(f.queue.jobs.length, 1);
  f.targetBody.group = secondGroup;f.targetBody.lod.roots = [{ mesh: secondRoot }];f.context.nodePipeline.composer.readBuffer = secondTarget;f.context.ship = secondShip;
  f.queue.admit();assert.deepEqual(f.destinationCaptures.map(capture => capture.shadows), [false, true]);
  assert.equal(f.destinationCaptures[1].roots[0], secondRoot);assert.equal(f.destinationCaptures[1].bodyGroup.children[0], secondRoot);
  assert.equal(f.destinationCaptures[1].target, secondTarget);assert.equal(f.destinationCaptures[1].ship, secondShip);
  f.readiness[1].resolve();await pending;f.dispose();
});
for (const cancellation of ['token', 'signal']) await test(`LOD ${cancellation} cancellation after shadow-off prevents the queued shadow-on capture`, async () => {
  const f = fixture(), pending = load('uploadPreparedLodMeshes', f.context)(f.targetBody, f.prepared, 1, f.route);
  const settled = assert.rejects(pending, error => error.code === (cancellation === 'token' ? 'obsolete' : 'aborted'));
  f.queue.admit();f.readiness[0].resolve();await microtasks();assert.equal(f.queue.jobs.length, 1);
  if (cancellation === 'token') f.cancel();else f.context.warpCompile.abort();f.queue.admit();await settled;
  assert.equal(f.destinationCaptures.length, 1);assert.equal(f.destinationCaptures[0].shadows, false);assert.equal(f.seen, 1);f.dispose();
});
for (const fault of ['none', 'sync', 'async']) await test(`world queued ${fault}: temporary clone never survives the callback`, async () => {
  const f = fixture(fault), body = { lod: f.targetBody.lod }, pending = load('prewarmWorldMaterials', f.context)(body, f.system);
  const settled = pending.catch(error => assert.match(error.message, /fault/));assert.equal(f.scene.children.length, 1);assert.equal(f.seen, 0);
  f.queue.admit();assert.equal(f.seen, 1);assert.equal(f.scene.children.length, 1);
  if (fault === 'async') f.readiness[0].reject(Error('async fault'));else f.readiness[0]?.resolve();await microtasks();
  if (fault === 'none') { assert.equal(f.queue.jobs.length, 1);f.queue.admit(); }await settled;assert.equal(f.scene.children[0], f.group);f.dispose();
});
await test('world replacement material/root and camera pose are chosen after waiting', async () => {
  const f = fixture(), body = { lod: f.targetBody.lod }, pending = load('prewarmWorldMaterials', f.context)(body, f.system);
  const replacement = new THREE.Mesh(new THREE.SphereGeometry(2), new THREE.MeshBasicMaterial());body.lod.roots = [{ mesh: replacement }];f.context.camera.near = 5;
  f.queue.admit();const source = f.readiness[0].source;assert.equal(source.geometry, replacement.geometry);assert.equal(source.material, replacement.material);assert.equal(source.position.z, -20);
  f.readiness[0].resolve();await microtasks();f.queue.admit();await pending;replacement.geometry.dispose();replacement.material.dispose();f.dispose();
});
await test('system replacement between roots prevents the next stale world compile', async () => {
  const f = fixture(), pending = load('prewarmWorldMaterials', f.context)(f.targetBody, f.system), settled = assert.rejects(pending, error => error.code === 'obsolete');
  f.queue.admit();f.readiness[0].resolve();await microtasks();assert.equal(f.queue.jobs.length, 1);f.context.universe.system = {};f.queue.admit();await settled;
  assert.equal(f.seen, 1);assert.equal(f.scene.children.length, 1);f.dispose();
});
for (const fault of ['none', 'sync', 'async']) await test(`water queued ${fault}: authored lights/scene restored before readiness`, async () => {
  const f = fixture(fault), pending = load('prewarmPreparedWater', f.context)(f.targetBody, 1, f.route, f.prepared);
  assert.equal(f.seen, 0);assert.equal(f.scene.children.length, 1);assert.equal(f.context.warpPreparedWaterWarmMesh, null);
  f.queue.admit();assert.equal(f.seen, 1);assert.equal(f.oldStar.light.visible, false);assert.equal(f.newStar.light.visible, true);assert.equal(f.scene.children.length, 1);
  f.oldStar.light.visible = true;f.newStar.light.visible = false;if (fault === 'async') f.readiness[0].reject(Error('async fault'));else f.readiness[0]?.resolve();await pending;
  assert.equal(f.oldStar.light.visible, true);assert.equal(f.newStar.light.visible, false);assert.equal(f.context.warpPreparedWaterWarmState, fault === 'none' ? 'complete' : 'failed');f.dispose();
});
await test('water warp request does not strand queued warp launch readiness', async () => {
  const f = fixture();f.route.warpRequested = true;const pending = load('prewarmPreparedWater', f.context)(f.targetBody, 1, f.route, f.prepared);
  f.queue.admit();f.readiness[0].resolve();await pending;assert.equal(f.context.warpPreparedWaterWarmState, 'complete');f.dispose();
});
await test('queued water token cancellation never creates mesh or reports complete', async () => {
  const f = fixture(), pending = load('prewarmPreparedWater', f.context)(f.targetBody, 1, f.route, f.prepared);f.cancel();f.queue.admit();await pending;
  assert.equal(f.seen, 0);assert.equal(f.scene.children.length, 1);assert.equal(f.context.warpPreparedWaterWarmMesh, null);assert.notEqual(f.context.warpPreparedWaterWarmState, 'complete');f.dispose();
});
await test('water captures a replacement root selected after the queue wait', async () => {
  const f = fixture(), pending = load('prewarmPreparedWater', f.context)(f.targetBody, 1, f.route, f.prepared);
  const replacement = new THREE.Mesh(new THREE.BoxGeometry(3), new THREE.MeshBasicMaterial());f.targetBody.waterLod.roots = [{ mesh: replacement }];f.queue.admit();
  assert.equal(f.readiness[0].source.geometry, replacement.geometry);assert.equal(f.readiness[0].source.material, replacement.material);f.readiness[0].resolve();await pending;
  replacement.geometry.dispose();replacement.material.dispose();f.dispose();
});
await test('prime texture references are read after admission; retired system uploads are skipped', async () => {
  const f = fixture(), oldTexture = {}, nextTexture = {}, seen = [];let reads = 0, texture = oldTexture;
  f.context.renderer.initTexture = value => { assert.equal(f.queue.executing, true);seen.push(value); };
  f.context.warpPreparedSystem = null;f.context.riftPreviewSystem = null;f.context.transferredPreparedDestination = null;
  Object.defineProperty(f.targetBody, 'cloudShadowTex', { get() { reads++;return texture; } });const prime = load('primePreparedBodyTextures', f.context);
  prime(f.targetBody, f.system);assert.equal(reads, 0);texture = nextTexture;f.queue.admit();await microtasks();assert.deepEqual(seen, [nextTexture]);
  prime(f.targetBody, f.system);f.context.universe.system = {};f.queue.admit();await microtasks();assert.equal(reads, 1);assert.equal(seen.length, 1);f.dispose();
});
await test('expired ship preparation neither retries nor enters queue', async () => {
  const queue = controlledQueue(), context = { ship: { heroLoaded: true }, shipPipelinesWarmed: false, shipPipelineWarmPending: false,
    surfacePipelinesReady: true, startupPrewarmExpired: true, nodePipeline: { prepare: queue.prepare } };
  load('prewarmLoadedShipPipelines', context)();assert.equal(context.shipPipelinesWarmed, true);assert.equal(context.surfacePipelinesReady, true);assert.equal(queue.jobs.length, 0);
});
function shipFixture(fault = 'none') {
  const queue = controlledQueue(), group = new THREE.Group(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  group.add(new THREE.Mesh(geometry, material));
  const initialTexture = {}, replacementTexture = {}, uploads = [], captures = [], errors = [], readiness = [];
  let texture = initialTexture, textureReads = 0, lightConfigurations = 0;
  Object.defineProperty(material, 'map', { configurable: true, get() { textureReads++;return texture; }, set(value) { texture = value; } });
  const ship = { heroLoaded: true, heroLoadFailed: false, foregroundOnly: true, group, setForegroundOnly(value) { this.foregroundOnly = value; } };
  const context = { ship, shipPipelinesWarmed: false, shipPipelineWarmPending: false, surfacePipelinesReady: true, startupPrewarmExpired: false,
    startupCompile: new AbortController(), nodePipeline: { prepare: queue.prepare, composer: { readBuffer: {}, writeBuffer: {} } },
    RENDER_LOOK_NEXT: true, SHIP_FOREGROUND_LAYER: 3, SHIP_INTERIOR_LAYER: 6, sunShadow: { visible: false }, scene: new THREE.Scene(), camera: {},
    renderer: { initTexture(value) { assert.equal(queue.executing, true);uploads.push(value); } }, console: { warn(...args) { errors.push(args); } },
    configureShipForegroundLightingLayers() { assert.equal(queue.executing, true);lightConfigurations++; },
    compileRenderVariant(renderer, source, camera, scene, options) {
      assert.equal(queue.executing, true);assert.equal(renderer, context.renderer);assert.equal(source, group);assert.equal(camera, context.camera);assert.equal(scene, context.scene);
      captures.push({ ...options, foreground: ship.foregroundOnly, sunVisible: context.sunShadow.visible });
      if (fault === 'sync') throw Error('ship sync fault');
      let resolve, reject;const promise = new Promise((yes, no) => { resolve = yes;reject = no; });readiness.push({ resolve, reject });return promise;
    } };
  return { context, queue, ship, uploads, captures, errors, readiness, initialTexture, replacementTexture,
    get textureReads() { return textureReads; }, get lightConfigurations() { return lightConfigurations; },
    replaceTexture() { texture = replacementTexture; }, dispose() { geometry.dispose();material.dispose(); } };
}
await test('ship texture and all four pass variants select live resources after admission and restore before readiness', async () => {
  const f = shipFixture(), capturedSignal = f.context.startupCompile.signal;
  load('prewarmLoadedShipPipelines', f.context)();assert.equal(f.textureReads, 0);assert.equal(f.uploads.length, 0);assert.equal(f.lightConfigurations, 0);
  assert.equal(f.context.shipPipelineWarmPending, true);assert.equal(f.context.surfacePipelinesReady, false);f.replaceTexture();f.queue.admit();await microtasks();
  assert.deepEqual(f.uploads, [f.replacementTexture]);assert.equal(f.captures.length, 0);
  for (const [index, layer] of [3, 6, 0, 6].entries()) {
    assert.equal(f.queue.jobs.length, 1);assert.equal(f.queue.jobs[0].options.signal, capturedSignal);
    const readBuffer = { name: `live-read-${index}` }, writeBuffer = { name: `live-write-${index}` };
    f.context.nodePipeline.composer.readBuffer = readBuffer;f.context.nodePipeline.composer.writeBuffer = writeBuffer;
    f.queue.admit();const capture = f.captures[index];assert.equal(capture.layer, layer);assert.equal(capture.target, index < 2 ? readBuffer : writeBuffer);
    assert.equal(capture.signal, capturedSignal);assert.equal(capture.foreground, layer !== 0);assert.equal(capture.sunVisible, layer === 0);
    assert.equal(capture.shadowLight, layer === 0 ? f.context.sunShadow : null);assert.equal(f.ship.foregroundOnly, true);assert.equal(f.context.sunShadow.visible, false);
    assert.equal(f.context.shipPipelinesWarmed, false);f.readiness[index].resolve();await microtasks();
  }
  assert.equal(f.lightConfigurations, 4);assert.equal(f.context.shipPipelinesWarmed, true);assert.equal(f.context.shipPipelineWarmPending, false);assert.equal(f.context.surfacePipelinesReady, true);f.dispose();
});
for (const fault of ['sync', 'async']) await test(`ship ${fault} failure restores domain state and releases readiness flags`, async () => {
  const f = shipFixture(fault);load('prewarmLoadedShipPipelines', f.context)();f.queue.admit();await microtasks();f.queue.admit();
  assert.equal(f.ship.foregroundOnly, true);assert.equal(f.context.sunShadow.visible, false);
  if (fault === 'async') { f.ship.foregroundOnly = false;f.context.sunShadow.visible = true;f.readiness[0].reject(Error('ship async fault')); }
  await microtasks();assert.equal(f.errors.length, 1);assert.equal(f.context.shipPipelinesWarmed, false);assert.equal(f.context.shipPipelineWarmPending, false);assert.equal(f.context.surfacePipelinesReady, true);
  assert.equal(f.ship.foregroundOnly, fault !== 'async');assert.equal(f.context.sunShadow.visible, fault === 'async');assert.equal(f.queue.jobs.length, 0);f.dispose();
});
await test('ship expiry while texture job waits reads no maps and never sets warmed', async () => {
  const f = shipFixture();load('prewarmLoadedShipPipelines', f.context)();f.context.startupPrewarmExpired = true;f.context.startupCompile.abort();f.queue.admit();await microtasks();
  assert.equal(f.textureReads, 0);assert.equal(f.uploads.length, 0);assert.equal(f.captures.length, 0);assert.equal(f.context.shipPipelinesWarmed, false);assert.equal(f.errors.length, 0);
  assert.equal(f.context.shipPipelineWarmPending, false);assert.equal(f.context.surfacePipelinesReady, true);f.dispose();
});
await test('ship expiry after compile capture consumes late readiness without overwriting later live domains', async () => {
  const f = shipFixture();load('prewarmLoadedShipPipelines', f.context)();f.queue.admit();await microtasks();f.queue.admit();
  f.ship.foregroundOnly = false;f.context.sunShadow.visible = true;f.context.startupPrewarmExpired = true;f.context.startupCompile.abort();f.readiness[0].resolve();await microtasks();
  assert.equal(f.ship.foregroundOnly, false);assert.equal(f.context.sunShadow.visible, true);assert.equal(f.context.shipPipelinesWarmed, false);assert.equal(f.queue.jobs.length, 0);assert.equal(f.errors.length, 0);f.dispose();
});
for (const fault of ['none', 'sync', 'async']) await test(`startup queued ${fault}: borrow current target/light only during capture`, async () => {
  const light = { visible: false, intensity: 7 }, queue = controlledQueue();let disposed = 0, reject, resolve, submitted, target = 'player', face = 3, mip = 2;
  const context = { QUALITY_LOW: false, warmedSurfacePlanet: null, surfacePipelinesReady: true, loadingCleared: false, startupPrewarmExpired: false,
    THREE, scene: new THREE.Scene(), surfaceBootstrapGroup: new THREE.Group(), surfaceBootstrapMeshes: [], scatter: { meshes: {} }, farFlora: {}, sunShadow: light,
    renderer: { getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
      setRenderTarget(value, nextFace = 0, nextMip = 0) { target = value;face = nextFace;mip = nextMip; } },
    nodePipeline: { prepare: queue.prepare }, surfaceBootstrapTarget: 'linear-hdr', camera: {}, startupCompile: new AbortController(), surfaceBootstrapPending: false,
    withSurfaceWarmupVariant: (_source, work) => work(), disposeSurfaceBootstrap() { disposed++;context.surfaceBootstrapGroup.removeFromParent(); }, console: { warn() {} },
    compilePrograms() { assert.equal(queue.executing, true);submitted = { target, face, mip };if (fault === 'sync') throw Error('sync fault');return new Promise((yes, fail) => { resolve = yes;reject = fail; }); } };
  load('prewarmSurfacePipelines', context)({ group: new THREE.Group() });assert.equal(submitted, undefined);assert.equal(light.visible, false);assert.equal(light.intensity, 7);assert.equal(target, 'player');
  context.renderer.setRenderTarget('later-player', 1, 4);queue.admit();assert.deepEqual(submitted, { target: 'linear-hdr', face: 0, mip: 0 });
  assert.equal(light.visible, false);assert.equal(light.intensity, 7);assert.equal(target, 'later-player');assert.equal(face, 1);assert.equal(mip, 4);
  context.renderer.setRenderTarget('next-player', 2, 5);if (fault === 'none') resolve();if (fault === 'async') reject(Error('async fault'));await microtasks();
  assert.equal(target, 'next-player');assert.equal(face, 2);assert.equal(mip, 5);assert.equal(disposed, fault === 'none' ? 0 : 1);
  assert.equal(context.surfacePipelinesReady, fault !== 'none');assert.equal(context.surfaceBootstrapPending, fault === 'none');
});
await test('startup expiry cancels queued compile before light or target borrow', async () => {
  const queue = controlledQueue(), controller = new AbortController();let compiled = 0;
  const context = { QUALITY_LOW: false, warmedSurfacePlanet: null, surfacePipelinesReady: true, loadingCleared: false, startupPrewarmExpired: false,
    THREE, scene: new THREE.Scene(), surfaceBootstrapGroup: new THREE.Group(), surfaceBootstrapMeshes: [], scatter: { meshes: {} }, farFlora: {},
    nodePipeline: { prepare: queue.prepare }, startupCompile: controller, console: { warn() {} }, surfaceBootstrapPending: false,
    sunShadow: new Proxy({}, { get() { assert.fail('Expired startup borrowed light'); } }), renderer: new Proxy({}, { get() { assert.fail('Expired startup borrowed renderer'); } }),
    compilePrograms() { compiled++; }, disposeSurfaceBootstrap() {} };
  load('prewarmSurfacePipelines', context)({ group: new THREE.Group() });context.startupPrewarmExpired = true;controller.abort();queue.admit();await microtasks();assert.equal(compiled, 0);
});
await test('adoption retains old signal; disposal aborts it before replacing generation', async () => {
  const context = { warpPreparationToken: 4, warpCompile: new AbortController(), warpPreparedSystem: { star: { id: 'destination' }, dispose() {} },
    transferredPreparedDestination: null, resetPreparedDestinationWarmState() {}, AbortController };
  const route = { star: { id: 'destination' } }, signal = context.warpCompile.signal;load('takePreparedDestination', context)(route, 'test');assert.equal(signal.aborted, false);
  load('disposePreparedWarpSystem', context)();assert.equal(signal.aborted, true);assert.equal(context.warpCompile.signal.aborted, false);
});
const sourceStable = (await readFile('src/main.js')).equals(mainBytes) && (await readFile(new URL(import.meta.url))).equals(verifierBytes), failures = cases.filter(row => !row.passed);
const report = { passed: sourceStable && !failures.length, sourceStable, scope: 'Actual-main CPU queue/lease contracts; renderer/readiness doubles, no GPU/image/cost acceptance',
  mainSha256: hash(mainBytes), verifierSha256: hash(verifierBytes), functions, counts: { passed: cases.length - failures.length, failed: failures.length }, cases };
await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));console.log(JSON.stringify({ directory, passed: report.passed, sourceStable, counts: report.counts,
  failures: failures.map(row => ({ name: row.name, error: row.error.slice(0, 1000) })) }));if (!report.passed) process.exitCode = 1;
