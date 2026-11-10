// Actual queued destination functions. The controlled queue models admission
// and readiness only; real renderer/queue/fence behavior has separate tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import { SpatialRift } from '../src/spatial-rift-webgl.js';
const mainBytes = await readFile('src/main.js'), main = mainBytes.toString(), verifierBytes = await readFile(new URL(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const referenceBytes = await readFile(new URL('fixtures/portal-prewarm-dfc9e5c.json', import.meta.url));
const reference = JSON.parse(referenceBytes);
for (const value of Object.values(reference.sources)) assert.equal(sha(value.source), value.sha256);
const out = `test-results/destination-frame-pacing/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });await writeFile(`${out}/main.js`, mainBytes);await writeFile(`${out}/verifier.js`, verifierBytes);
await writeFile(`${out}/portal-prewarm-dfc9e5c.json`, referenceBytes);
const functions = {}, results = [];
function load(name, context) {
  const signature = main.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = main.indexOf(signature);let end = main.indexOf('\n}', start);
  assert.equal(main.split(signature).length - 1, 1, `Unique actual ${name}`);assert.ok(start >= 0 && end > start, name);
  // A multiline destructured parameter also has a column-zero closing brace.
  // Ask the JS parser for a complete function, rather than truncating there.
  while (end > start) {
    try { new vm.Script(`(${main.slice(start, end + 2)})`);break; }
    catch (error) { if (!(error instanceof SyntaxError)) throw error;end = main.indexOf('\n}', end + 2); }
  }
  assert.ok(end > start, `Complete actual ${name}`);
  const source = main.slice(start, end + 2);functions[name] = { sha256: sha(source), bytes: Buffer.byteLength(source) };
  return vm.runInNewContext(`(${source})`, context);
}
async function test(name, work) { try { await work();results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: String(error), stack: error?.stack }); } }
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(options = {}) {
  const { mrt = true, volume = true, fault = null, renderResult = true, portalResult = true } = options;
  const error = Object.hasOwn(options, 'error') ? options.error : Error(`expected ${fault}`);
  let active = true, executing = false, target = { name: 'player-target' }, face = 3, mip = 2, currentMrt = { name: 'player-mrt' }, faultUsed = false;
  let volumePlanet = { name: 'live-volume', syncAtmoMaterial() {}, syncVolCloudMaterial() {} }, atmospherePlanet = { name: 'live-atmosphere' };
  const events = [], touches = [], cells = [], errors = [], jobs = [];
  const borrow = name => { touches.push(name);assert.equal(executing, true, `Borrowed ${name} outside admitted callback`); };
  const fail = name => { if (fault === name && !faultUsed) { faultUsed = true;throw error; } };
  const visible = (name, value) => { const cell = { name, raw: value };cells.push(cell);
    return Object.defineProperty(new THREE.Group(), 'visible', { enumerable: true, configurable: true,
      get() { borrow(`${name}.read`);return cell.raw; }, set(next) { borrow(`${name}.write`);cell.raw = next; } }); };
  const oldStar = { group: visible('old-star', true), light: visible('old-light', false) }, fadeStar = { group: visible('fade-star', false), light: visible('fade-light', true) };
  const destinationStar = { group: visible('destination-star', false), light: visible('destination-light', false) };
  const targetBody = { group: visible('destination-body', false), posUniv: new THREE.Vector3(),
    syncAtmoMaterial() { events.push('target-atmosphere');fail('target-atmosphere'); }, syncVolCloudMaterial() { events.push('target-volume');fail('target-volume'); }, update() { events.push('target-update'); } };
  const otherBody = { group: visible('destination-other', true) }, oldBody = { group: visible('old-body', true) }, fadeBody = { group: visible('fade-body', false) };
  const oldOrphan = visible('old-orphan', true), fadeOrphan = visible('fade-orphan', false), destinationOrphan = visible('destination-orphan', false);
  const prepared = { starViews: [destinationStar], planets: [targetBody, otherBody], compactObjects: [],
    artificialSites: [{ parentBody: null, group: destinationOrphan }], updateCelestial() { events.push('celestial'); } };
  const universeBase = { system: { starViews: [oldStar], planets: [oldBody], compactObjects: [], artificialSites: [{ parentBody: null, group: oldOrphan }] },
    fadingSystem: { starViews: [fadeStar], planets: [fadeBody], compactObjects: [], artificialSites: [{ parentBody: null, group: fadeOrphan }] }, relativizeSystem() {} };
  const universe = new Proxy(universeBase, { get(owner, name) { if (name === 'system' || name === 'fadingSystem') borrow(`universe.${name}`);return owner[name]; } });
  const rawCamera = new THREE.PerspectiveCamera(63, 1.6, .2, 1e6);rawCamera.position.set(1, 2, 3);rawCamera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), .3);
  const camera = new Proxy(rawCamera, { get(owner, name) { borrow(`camera.${String(name)}`);return Reflect.get(owner, name); }, set(owner, name, value) { borrow(`camera.${String(name)}.write`);return Reflect.set(owner, name, value); } });
  const shadowRaw = { visible: true, intensity: 7 }, sunShadow = new Proxy(shadowRaw, { get(owner, name) { borrow(`shadow.${String(name)}`);return owner[name]; }, set(owner, name, value) { borrow(`shadow.${String(name)}.write`);owner[name] = value;return true; } });
  const route = { warpRequested: false, bodyId: 'destination', target: { entry: new THREE.Vector3(5, 6, 7), center: new THREE.Vector3() } };
  const renderer = { getRenderTarget() { borrow('target.read');return target; }, getActiveCubeFace() { borrow('target.face');return face; }, getActiveMipmapLevel() { borrow('target.mip');return mip; },
    setRenderTarget(value, nextFace = 0, nextMip = 0) { borrow('target.write');events.push(value === context.surfaceBootstrapTarget ? 'private-target' : 'restore-target');
      fail(value === context.surfaceBootstrapTarget ? 'private-target' : 'restore-target');target = value;face = nextFace;mip = nextMip; } };
  if (mrt) { renderer.getMRT = () => { borrow('mrt.read');return currentMrt; };renderer.setMRT = value => { borrow('mrt.write');fail(value === null ? 'private-mrt' : 'restore-mrt');currentMrt = value; }; }
  const volumePass = volume ? { get activePlanet() { borrow('volume-owner.read');return volumePlanet; }, setActivePlanet(body, origin) { borrow('volume-owner.write');assert.ok(origin === route.target.entry || origin === context.nav.pos);volumePlanet = body; } } : null;
  const atmospherePass = { get activePlanet() { borrow('atmosphere-owner.read');return atmospherePlanet; } };
  const pipeline = { renderCalls: 0, programPreparation: new AbortController(),
    render() { assert.fail('Private preparation must use the admitted one-use draw capability'); },
    prepare(work, options) { let resolve, reject;const promise = new Promise((yes, no) => { resolve = yes;reject = no; });jobs.push({ work, options, resolve, reject, promise });return promise; },
    setActiveAtmosphere(body, origin) { borrow('atmosphere-owner.write');assert.ok(origin === route.target.entry || origin === context.nav.pos);atmospherePlanet = body; },
    bindVolumeDepth(body) { borrow('volume-depth');events.push(body === targetBody ? 'private-depth' : 'restore-depth');fail(body === targetBody ? 'private-depth' : 'restore-depth'); },
    invalidateVolumeHistory(reason) { borrow('history');assert.equal(reason, 'private-prewarm');events.push('history'); },
  };
  const context = { THREE, universe, camera, sunShadow, renderer, volumePass, atmospherePass, nodePipeline: pipeline, warpCompile: new AbortController(),
    nav: { pos: new THREE.Vector3(20, 30, 40), quat: new THREE.Quaternion() }, surfaceBootstrapTarget: { name: 'private-target' },
    spatialRift: { group: visible('rift', true), setTransform() { events.push('rift-transform'); } },
    lookQuatAt(_from, _to, out) { return out.setFromAxisAngle(new THREE.Vector3(1, 0, 0), .6); },
    preparedDestinationIsActive(token, receivedRoute, receivedPrepared) { assert.equal(token, 4);assert.equal(receivedRoute, route);assert.equal(receivedPrepared, prepared);return active; },
    warpPreparedRiftWarmState: 'idle', warpPreparedRiftWarmError: null, warpPreparedRiftStructurePromise: Promise.resolve(),
    uploadPreparedLodMeshes: async () => {}, celestialClock: { hours: 1 }, RIFT_SPAWN_DISTANCE: 25,
    renderRiftDestinationPortal() { assert.equal(executing, true);events.push('portal');fail('portal');return portalResult; }, console: { error(...args) { errors.push(args); } } };
  context.standaloneSiteGroups = load('standaloneSiteGroups', context);
  const warm = load('renderPreparedDestinationWarmFrame', context);context.renderPreparedDestinationWarmFrame = warm;
  const portal = load('prewarmPreparedRiftPortal', context);
  const capture = () => ({ visibility: cells.map(cell => [cell.name, cell.raw]), camera: { position: rawCamera.position.toArray(), quaternion: rawCamera.quaternion.toArray(), fov: rawCamera.fov,
    projection: rawCamera.projectionMatrix.toArray(), inverseProjection: rawCamera.projectionMatrixInverse.toArray() }, shadow: { ...shadowRaw }, target, face, mip, mrt: currentMrt, volume: volumePlanet, atmosphere: atmospherePlanet });
  const valid = job => !job.options.signal?.aborted && job.options.isCurrent();
  const problem = code => Object.assign(Error(`controlled ${code}`), { code });
  const admit = () => {
    const job = jobs.shift();assert.ok(job, 'Expected queued preparation');
    if (!valid(job)) { job.reject(problem(job.options.signal?.aborted ? 'aborted' : 'obsolete'));return job; }
    let drawUsed = false, closed = false;executing = true;
    const draw = () => {
      assert.equal(closed, false);assert.equal(drawUsed, false);drawUsed = true;borrow('draw');pipeline.renderCalls++;events.push('draw');
      assert.equal(target, context.surfaceBootstrapTarget);if (mrt) assert.equal(currentMrt, null);
      assert.equal(atmospherePlanet, targetBody);if (volume) assert.equal(volumePlanet, targetBody);assert.equal(shadowRaw.visible, false);assert.equal(shadowRaw.intensity, 0);
      assert.equal(cells.find(cell => cell.name === 'old-body').raw, false);assert.equal(cells.find(cell => cell.name === 'destination-body').raw, true);assert.equal(cells.find(cell => cell.name === 'destination-other').raw, false);
      assert.equal(cells.find(cell => cell.name === 'old-orphan').raw, false);assert.equal(cells.find(cell => cell.name === 'fade-orphan').raw, false);
      assert.equal(cells.find(cell => cell.name === 'destination-orphan').raw, true);
      rawCamera.position.set(91, 92, 93);rawCamera.fov = 17;rawCamera.updateProjectionMatrix();rawCamera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), .9);shadowRaw.intensity = 44;
      fail('draw');return renderResult;
    };
    try { job.result = job.work(draw); }
    catch (cause) { job.reject(cause);return job; }
    finally { executing = false;closed = true; }
    Promise.resolve(job.result).then(value => { if (valid(job)) job.resolve(value);else job.reject(problem(job.options.signal?.aborted ? 'aborted' : 'obsolete')); }, job.reject);return job;
  };
  return { context, pipeline, route, prepared, targetBody, events, touches, errors, rawCamera, rawUniverse: universeBase, shadowRaw, cells, jobs, capture, admit,
    run() { const promise = warm(targetBody, route, prepared, 4);promise.catch(() => {});return promise; },
    portal() { const promise = portal(targetBody, 4, route, prepared);promise.catch(() => {});return promise; },
    cancel() { active = false; }, restored(expected) { assert.deepEqual(capture(), expected); },
    setLiveState() { rawCamera.position.set(11, 12, 13);rawCamera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), .7);rawCamera.fov = 31;rawCamera.updateProjectionMatrix();
      shadowRaw.visible = false;shadowRaw.intensity = 11;target = { name: 'later-player' };face = 5;mip = 4;currentMrt = { name: 'later-mrt' };
      for (const cell of cells) cell.raw = !cell.raw;volumePlanet = { name: 'later-volume' };atmospherePlanet = { name: 'later-atmosphere' }; },
    async reachPrivateFromPortal() { await microtasks();assert.equal(jobs.length, 1);assert.notEqual(jobs[0].options.label, 'destination-private-frame');admit();await microtasks();assert.equal(jobs.length, 1);assert.equal(jobs[0].options.label, 'destination-private-frame'); },
  };
}

// Compose the actual prewarm + main wrapper + destination scene lease + actual
// SpatialRift method. Only queue admission and the native renderer are doubles.
// This catches the old closed gate, which an always-drawing portal stub hid.
function integratedPortalFixture({ old = false, traversed = false, portalFault = null } = {}) {
  const f = fixture(), context = f.context, renderer = context.renderer, scene = new THREE.Scene();
  let color = new THREE.Color(.1, .2, .3), alpha = .4, portalDraws = 0;
  renderer.xr = { enabled: true };renderer.autoClear = false;renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.getClearColor = out => out.copy(color);renderer.getClearAlpha = () => alpha;
  renderer.setClearColor = (value, next) => { color.set(value);alpha = next; };
  renderer.clear = () => {};
  const rift = new SpatialRift({ scene, renderer, mainCamera: f.rawCamera });
  if (old) rift.renderPortal = new Function('_center', `return ({${reference.sources.renderPortal.source}}).renderPortal;`)(new THREE.Vector3());
  rift.traversed = traversed;
  context.spatialRift = rift;context.scene = scene;context.RIFT_PORTAL_LAYER = 7;
  context.ship = { group: new THREE.Group() };context.weapons = {};
  context.headlamp = new THREE.Group();context.skyDome = { mesh: new THREE.Group() };
  context.hemi = new THREE.Group();context.ambient = new THREE.Group();context.riftPortalAmbient = new THREE.Group();
  context.riftPortalAmbient.visible = false;
  context.riftPortalVisibility = [];context.riftPortalCloudState = [];context.riftPortalLayerState = [];
  context.riftPortalClearColor = new THREE.Color();context.riftPortalSceneActive = false;
  f.targetBody.bodyId = f.route.bodyId;
  f.prepared.planets[1].bodyId = 'destination-other';
  f.targetBody.volCloudMat = new THREE.ShaderMaterial({ depthTest: true });
  const directCloud = f.targetBody.volCloudMat.clone();
  const targetMesh = new THREE.Mesh(new THREE.BoxGeometry(), f.targetBody.volCloudMat);
  f.targetBody.volCloudMesh = targetMesh;
  f.targetBody.getDirectCloudMaterial = () => directCloud;
  targetMesh.layers.set(2);f.targetBody.group.add(targetMesh);
  for (const system of [f.rawUniverse.system, f.rawUniverse.fadingSystem, f.prepared]) {
    for (const view of system.starViews) scene.add(view.group, view.light);
    for (const body of system.planets) scene.add(body.group);
    for (const site of system.artificialSites) scene.add(site.group);
  }
  scene.add(context.riftPortalAmbient, context.ship.group, context.headlamp, context.skyDome.mesh, context.hemi, context.ambient);
  const fog = new THREE.Fog(0x102030, 10, 20);scene.fog = fog;
  for (const name of ['setRiftPreviewVisible', 'addRiftPortalHidden', 'moveToRiftPortalLayer',
    'hideSystemForRiftPortal', 'beginRiftPortalScene', 'endRiftPortalScene']) context[name] = load(name, context);
  context.renderRiftDestinationPortal = old
    ? vm.runInNewContext(`(${reference.sources.renderRiftDestinationPortal.source})`, context)
    : load('renderRiftDestinationPortal', context);
  const run = old ? vm.runInNewContext(`(${reference.sources.prewarmPreparedRiftPortal.source})`, context)
    : load('prewarmPreparedRiftPortal', context);
  renderer.render = (receivedScene, camera) => {
    portalDraws++;assert.equal(receivedScene, scene);assert.equal(camera, rift.portalCamera);
    assert.equal(renderer.getRenderTarget(), rift.portalRT);assert.equal(camera.layers.mask, 1 << 7);
    assert.equal(rift.group.visible, false);assert.equal(f.targetBody.group.visible, true);
    assert.equal(f.prepared.planets[1].group.visible, false);
    assert.equal(context.universe.system.planets[0].group.visible, false);
    assert.equal(targetMesh.layers.mask, 1 << 7);assert.equal(targetMesh.material, directCloud);
    assert.equal(directCloud.depthTest, false);assert.equal(f.targetBody.volCloudMat.depthTest, true);
    assert.equal(scene.fog, null);assert.equal(renderer.toneMapping, THREE.NoToneMapping);
    if (portalFault) throw portalFault;
  };
  const layerState = [];scene.traverse(object => layerState.push([object, object.layers.mask]));
  return { ...f, rift, get portalDraws() { return portalDraws; },
    portal() { return run(f.targetBody, 4, f.route, f.prepared); },
    portalRestored() {
      for (const [object, mask] of layerState) assert.equal(object.layers.mask, mask);
      assert.equal(targetMesh.material, f.targetBody.volCloudMat);assert.equal(directCloud.depthTest, true);
      assert.equal(f.targetBody.volCloudMat.depthTest, true);assert.equal(scene.fog, fog);
      assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);assert.equal(renderer.xr.enabled, true);assert.equal(renderer.autoClear, false);
      assert.equal(color.getHex(), new THREE.Color(.1, .2, .3).getHex());assert.equal(alpha, .4);
      assert.equal(context.riftPortalSceneActive, false);assert.equal(rift.open, 0);assert.equal(rift.traversed, traversed);assert.equal(rift.group.visible, false);
    },
    dispose() { rift.dispose();targetMesh.geometry.dispose();f.targetBody.volCloudMat.dispose();directCloud.dispose(); },
  };
}

await test('queued private draw waits without borrowing visibility/camera/shadow/target/medium state', async () => {
  const f = fixture(), before = f.capture(), pending = f.run();assert.equal(f.jobs.length, 1);assert.equal(f.touches.length, 0);f.restored(before);
  await microtasks();assert.equal(f.touches.length, 0);assert.equal(f.pipeline.renderCalls, 0);f.admit();f.restored(before);assert.equal(await pending, true);assert.equal(f.pipeline.renderCalls, 1);
});
await test('private restoration captures the live state at execution, including cube face and mip', async () => {
  const f = fixture(), pending = f.run();f.setLiveState();const later = f.capture();f.admit();assert.equal(await pending, true);f.restored(later);
});
for (const cancel of ['token', 'warp-request']) await test(`${cancel} while queued returns false with zero borrowed state`, async () => {
  const f = fixture(), before = f.capture(), pending = f.run();if (cancel === 'token') f.cancel();else f.route.warpRequested = true;
  f.admit();assert.equal(await pending, false);assert.equal(f.touches.length, 0);assert.equal(f.pipeline.renderCalls, 0);f.restored(before);
});
for (const cancel of ['token', 'warp-request']) await test(`already cancelled ${cancel} never enqueues private work`, async () => {
  const f = fixture();if (cancel === 'token') f.cancel();else f.route.warpRequested = true;
  assert.equal(await f.run(), false);assert.equal(f.jobs.length, 0);assert.equal(f.touches.length, 0);
});
await test('a queued private frame retains its captured signal rather than a new global generation', async () => {
  const f = fixture(), signal = f.context.warpCompile.signal, pending = f.run();f.context.warpCompile = new AbortController();assert.equal(f.jobs[0].options.signal, signal);
  f.admit();assert.equal(await pending, true);
});
await test('queue admission failure preserves its identity without borrowing or invalidating history', async () => {
  const f = fixture(), error = Error('native queue unavailable'), pending = f.run();f.jobs.shift().reject(error);
  await assert.rejects(pending, cause => cause === error);assert.equal(f.touches.length, 0);assert.equal(f.events.includes('history'), false);
});
await test('signal abort while queued rejects before private leases', async () => {
  const f = fixture(), pending = f.run();f.context.warpCompile.abort();f.admit();await assert.rejects(pending, cause => cause.code === 'aborted');assert.equal(f.touches.length, 0);
});
for (const fault of ['target-atmosphere', 'target-volume', 'private-depth', 'private-target', 'private-mrt', 'draw']) await test(`private ${fault} failure restores all finally-owned state and invalidates private history`, async () => {
  const error = Error(`expected ${fault}`), f = fixture({ fault, error }), before = f.capture(), pending = f.run();f.admit();await assert.rejects(pending, cause => cause === error);
  f.restored(before);assert.equal(f.events.filter(event => event === 'history').length, 1);
});
for (const error of [null, undefined, false, 0]) await test(`private draw preserves a falsy original throw (${String(error)})`, async () => {
  const f = fixture({ fault: 'draw', error }), before = f.capture(), pending = f.run();let caught = false, value;
  const settled = pending.catch(cause => { caught = true;value = cause; });f.admit();await settled;assert.equal(caught, true);assert.equal(value, error);f.restored(before);
});
await test('false private production result rejects and cannot count as a completed warm frame', async () => {
  const f = fixture({ renderResult: false }), before = f.capture(), pending = f.run();f.admit();await assert.rejects(pending, /was not submitted/);f.restored(before);assert.equal(f.events.filter(event => event === 'history').length, 1);
});
await test('optional MRT and absent volume retain complete restoration', async () => {
  const f = fixture({ mrt: false, volume: false }), before = f.capture(), pending = f.run();f.admit();assert.equal(await pending, true);f.restored(before);
});
await test('actual portal cannot complete before both queued portal view and private world draw', async () => {
  const f = fixture(), before = f.capture(), pending = f.portal();await microtasks();assert.equal(f.touches.length, 0);assert.equal(f.context.warpPreparedRiftWarmState, 'compiling');
  f.admit();await microtasks();assert.equal(f.pipeline.renderCalls, 0);assert.equal(f.context.warpPreparedRiftWarmState, 'compiling');assert.equal(f.touches.length, 0);
  f.admit();await pending;assert.equal(f.context.warpPreparedRiftWarmState, 'complete');assert.equal(f.context.warpPreparedRiftWarmError, null);assert.equal(f.pipeline.renderCalls, 1);f.restored(before);
});
await test('actual portal reports false private draw as failure after full restoration', async () => {
  const f = fixture({ renderResult: false }), before = f.capture(), pending = f.portal();await f.reachPrivateFromPortal();f.admit();await pending;
  assert.equal(f.context.warpPreparedRiftWarmState, 'failed');assert.match(f.context.warpPreparedRiftWarmError, /was not submitted/);assert.equal(f.errors.length, 1);f.restored(before);
});
await test('a portal no-draw result cannot become complete or enqueue the private world warm frame', async () => {
  const f = fixture({ portalResult: false }), pending = f.portal();await microtasks();f.admit();await microtasks();
  // Drain the old path as a negative control too: it incorrectly queues the
  // private draw despite the portal result, rather than leaving this test hung.
  if (f.jobs.length) f.admit();await pending;
  assert.equal(f.context.warpPreparedRiftWarmState, 'failed');assert.match(f.context.warpPreparedRiftWarmError, /portal warm frame was not submitted/);
  assert.equal(f.jobs.length, 0);assert.equal(f.pipeline.renderCalls, 0);assert.equal(f.errors.length, 1);
});

for (const traversed of [false, true]) await test(`frozen dfc9e5c negative: closed portal marked complete without any portal draw (${traversed})`, async () => {
  const f = integratedPortalFixture({ old: true, traversed });
  try {
    const pending = f.portal();await microtasks();f.admit();await microtasks();
    assert.equal(f.portalDraws, 0);assert.equal(f.jobs.length, 1);f.admit();await pending;
    assert.equal(f.context.warpPreparedRiftWarmState, 'complete');assert.equal(f.portalDraws, 0);assert.equal(f.pipeline.renderCalls, 1);f.portalRestored();
  } finally { f.dispose(); }
});

for (const traversed of [false, true]) await test(`actual forced closed destination draws before completion and preserves the passage (${traversed})`, async () => {
  const f = integratedPortalFixture({ traversed });
  try {
    const before = f.capture(), pending = f.portal();await microtasks();assert.equal(f.portalDraws, 0);assert.equal(f.touches.length, 0);
    assert.equal(f.context.warpPreparedRiftWarmState, 'compiling');f.admit();await microtasks();
    const firstDraws = f.portalDraws, firstState = f.context.warpPreparedRiftWarmState;
    if (f.jobs.length) f.admit();await pending;
    assert.equal(firstDraws, 1);assert.equal(firstState, 'compiling');
    assert.equal(f.context.warpPreparedRiftWarmState, 'complete');assert.equal(f.portalDraws, 1);f.portalRestored();f.restored(before);
  } finally { f.dispose(); }
});

await test('actual forced portal renderer failure restores the destination scene and prevents completion', async () => {
  const error = Error('actual portal native failure'), f = integratedPortalFixture({ portalFault: error });
  try {
    const before = f.capture(), pending = f.portal();await microtasks();f.admit();await microtasks();if (f.jobs.length) f.admit();await pending;
    assert.equal(f.context.warpPreparedRiftWarmState, 'failed');assert.equal(f.portalDraws, 1);
    assert.equal(f.jobs.length, 0);assert.equal(f.pipeline.renderCalls, 0);f.portalRestored();f.restored(before);
  } finally { f.dispose(); }
});

for (const cancel of ['token', 'warp-request']) await test(`actual forced portal ${cancel} while queued draws nothing`, async () => {
  const f = integratedPortalFixture();
  try {
    const pending = f.portal();await microtasks();if (cancel === 'token') f.cancel();else f.route.warpRequested = true;
    f.admit();await pending;assert.equal(f.portalDraws, 0);assert.equal(f.pipeline.renderCalls, 0);assert.equal(f.touches.length, 0);
    assert.notEqual(f.context.warpPreparedRiftWarmState, 'complete');f.portalRestored();
  } finally { f.dispose(); }
});
for (const cancel of ['token', 'warp-request']) await test(`portal ${cancel} while private work waits never publishes completion`, async () => {
  const f = fixture(), before = f.capture(), pending = f.portal();await f.reachPrivateFromPortal();assert.equal(f.touches.length, 0);
  if (cancel === 'token') f.cancel();else f.route.warpRequested = true;f.admit();await pending;
  assert.notEqual(f.context.warpPreparedRiftWarmState, 'complete');assert.equal(f.pipeline.renderCalls, 0);assert.equal(f.errors.length, 0);f.restored(before);
});
for (const cancel of ['token', 'warp-request']) await test(`portal ${cancel} before queued view executes never borrows its destination`, async () => {
  const f = fixture(), pending = f.portal();await microtasks();if (cancel === 'token') f.cancel();else f.route.warpRequested = true;f.admit();await pending;
  assert.equal(f.events.includes('portal'), false);assert.equal(f.events.includes('celestial'), false);assert.equal(f.touches.length, 0);assert.notEqual(f.context.warpPreparedRiftWarmState, 'complete');
});
const sourceStable = (await readFile('src/main.js')).equals(mainBytes) && (await readFile(new URL(import.meta.url))).equals(verifierBytes), failed = results.filter(row => !row.passed);
const report = { passed: !failed.length && sourceStable, scope: 'Pure CPU actual-main queue/capability/lease contracts. No GL, native pacing, visual or performance acceptance.', sourceStable,
  prewarmReference: { ref: reference.ref, commit: reference.commit, fixtureSha256: sha(referenceBytes), sources: reference.sources },
  mainSha256: sha(mainBytes), verifierSha256: sha(verifierBytes), functions, counts: { passed: results.length - failed.length, failed: failed.length }, results };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));console.log(JSON.stringify({ out, passed: report.passed, sourceStable, counts: report.counts, failures: failed.map(row => ({ name: row.name, error: row.error })) }));
if (!report.passed) process.exitCode = 1;
