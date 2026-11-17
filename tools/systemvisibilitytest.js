// Actual main ownership transitions. CPU-only scene objects, no renderer/GPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import * as transit from '../src/transit.js';
import { SpacePortal, createPortalProfile } from '../src/portal/space-portal.js';

const mainPath = process.argv.find(value => value.startsWith('--main-source='))?.slice('--main-source='.length) || 'src/main.js';
const bytes = await readFile(mainPath), main = bytes.toString(), verifier = await readFile(new URL(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const out = `test-results/system-visibility/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });await writeFile(`${out}/main.js`, bytes);await writeFile(`${out}/verifier.js`, verifier);
const cases = [], functions = {};
function load(name, context) {
  const signature = `function ${name}(`, start = main.indexOf(signature), end = start + main.slice(start).search(/\n}(?=\r?\n)/);
  assert.ok(start >= 0 && end > start, name);const source = main.slice(start, end + 2);
  functions[name] = { sha256: hash(source), bytes: Buffer.byteLength(source) };return vm.runInNewContext(`(${source})`, context);
}
function helpers(context) {
  // Old source executes without a synthetic ownership helper, so its failed
  // controls demonstrate actual visible orphans rather than a missing API.
  if (main.includes('function standaloneSiteGroups(')) context.standaloneSiteGroups = load('standaloneSiteGroups', context);
  return context;
}
async function test(name, work) {
  try { await work();cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error), stack: error.stack }); }
}
const group = visible => Object.assign(new THREE.Group(), { visible });
function system(id, visible = true) {
  const body = { bodyId: `${id}-body`, group: group(visible), posUniv: new THREE.Vector3(0, 0, 100), name: id, appear: 1 };
  const other = { bodyId: `${id}-other`, group: group(visible), posUniv: new THREE.Vector3(0, 0, 9e6) };
  const orphan = group(visible), child = new THREE.PointLight(0xffffff, 1);orphan.add(child);
  const attached = group(true);body.group.add(attached);
  const spec = { bodyId: body.bodyId, name: id, radius: 10, isMoon: false };
  return { star: { id, pos: new THREE.Vector3(0, 0, 100), radius: 1 }, name: id,
    starViews: [{ group: group(visible), light: Object.assign(new THREE.PointLight(), { visible }) }],
    planets: [body, other], compactObjects: [], bodyById: new Map([[body.bodyId, body], [other.bodyId, other]]),
    artificialSites: [{ parentBody: null, group: orphan }, { parentBody: body, group: attached }],
    _specs: [spec], frames: new Map([[body.bodyId, { position: body.posUniv }]]), built: true,
    updateCelestial() {}, body, other, orphan, attached, child,
  };
}

await test('route construction hides newly created standalone sites together with prepared bodies', () => {
  const prepared = system('destination'), timers = [], context = helpers({
    warpPreparationToken: 7, universe: { system: { star: { id: 'source' } } }, celestialClock: { hours: 0 },
    disposeRetiredRiftSystem() {}, disposePreparedWarpSystem() {}, StarSystem: function () { return prepared; },
    preparedDestinationIsActive: () => true, prewarmPreparedRiftStructure: () => Promise.resolve(),
    primePreparedBodyTextures() {}, prewarmPreparedLod() {}, prewarmPreparedWater() {}, performance: { now: () => 0 },
    setTimeout(work) { timers.push(work); },
  });
  const sites = prepared.artificialSites;prepared.artificialSites = [];
  prepared.buildNext = () => { prepared.artificialSites = sites; };
  load('prepareWarpDestination', context)({ star: prepared.star, bodyId: prepared.body.bodyId });timers.shift()();
  assert.equal(prepared.orphan.visible, false);assert.equal(prepared.body.group.visible, false);assert.equal(prepared.other.group.visible, false);
  assert.equal(prepared.attached.visible, true, 'Attached children inherit body ownership');assert.equal(prepared.starViews[0].light.visible, false);
});
await test('fallback rift construction hides standalone sites created by its last build', () => {
  const destination = system('rift'), body = destination.body, sites = destination.artificialSites;
  destination.bodyById.clear();destination.planets = [];destination.artificialSites = [];destination.built = false;
  destination.buildNext = () => { destination.planets.push(body);destination.bodyById.set(body.bodyId, body);destination.artificialSites = sites;destination.built = true; };
  const context = helpers({ THREE, riftPreviewSystem: destination, frameNo: 5, celestialClock: { hours: 0 },
    riftRoute: { arrival: { bodyId: body.bodyId, center: new THREE.Vector3(), entry: new THREE.Vector3(), offset: new THREE.Vector3(0, 0, 8) }, previewBuildFrame: -1 },
    riftTargetUniv: new THREE.Vector3(), riftPreviewOriginUniv: new THREE.Vector3(), primePreparedBodyTextures() {},
  });
  load('syncRiftDestination', context)();assert.equal(destination.orphan.visible, false);assert.equal(body.group.visible, false);
  assert.deepEqual(context.riftTargetUniv.toArray(), [0, 0, 108]);
});
await test('preview visibility owns standalone sites while keeping non-target bodies hidden', () => {
  const destination = system('preview', false), context = helpers({});
  const change = load('setRiftPreviewVisible', context);change(true, destination, destination.body.bodyId);
  assert.equal(destination.orphan.visible, true);assert.equal(destination.body.group.visible, true);assert.equal(destination.other.group.visible, false);
  change(false, destination, destination.body.bodyId);assert.equal(destination.orphan.visible, false);assert.equal(destination.body.group.visible, false);
});

function farViewFixture() {
  const source = system('source'), fading = system('fading'), destination = system('destination', false);
  const scene = new THREE.Scene();scene.fog = new THREE.Fog(0x123456, 1, 100);
  const stars = Object.assign(new THREE.Object3D(), { name: 'stars' });stars.position.set(-1, -2, -3);
  const backdrop = Object.assign(new THREE.Object3D(), { name: 'backdrop' });backdrop.position.set(-4, -5, -6);
  const live = { synced: 0, syncAtmoMaterial() { this.synced++; }, syncVolCloudMaterial() {} };
  const context = helpers({ THREE, scene, universe: { system: source, fadingSystem: fading, nearStarsMesh: stars, backdropMesh: backdrop, nebulas: new THREE.Group() },
    riftRoute: { arrived: false }, riftFarBodyId: destination.body.bodyId, atmospherePass: { activePlanet: live },
    ship: { group: group(true) }, weapons: { glowMesh: group(true), coreMesh: group(false) }, sunShadow: group(true), headlamp: group(false),
    skyDome: { mesh: group(true) }, hemi: group(true), ambient: group(false), riftPortalAmbient: group(false),
    scatter: { meshes: { grass: group(true) } } });
  return { context, source, fading, destination, scene, stars, backdrop, live };
}
await test('far view lease hides the near worlds, shows only the far target, moves the sky and restores everything', () => {
  const f = farViewFixture(), setup = load('setupRiftFarScene', f.context), farCamera = new THREE.Vector3(100, 200, 300);
  let bound = null;
  const restore = setup({ setActiveAtmosphere(body, origin) { bound = [body, origin.clone()]; } }, f.destination, farCamera, f.destination.body);
  assert.equal(f.source.orphan.visible, false);assert.equal(f.fading.orphan.visible, false);assert.equal(f.source.body.group.visible, false);
  assert.equal(f.destination.orphan.visible, true);assert.equal(f.destination.body.group.visible, true);assert.equal(f.destination.other.group.visible, false);
  assert.equal(f.destination.starViews[0].light.visible, true);assert.equal(f.context.ship.group.visible, false);assert.equal(f.context.sunShadow.visible, false);
  assert.equal(f.context.riftPortalAmbient.visible, true);assert.equal(f.scene.fog, null);
  assert.deepEqual(f.stars.position.toArray(), [-100, -200, -300]);assert.deepEqual(f.backdrop.position.toArray(), [-100, -200, -300]);
  assert.equal(bound[0], f.destination.body);assert.deepEqual(bound[1].toArray(), [100, 200, 300]);
  restore();
  assert.equal(f.source.orphan.visible, true);assert.equal(f.fading.orphan.visible, true);assert.equal(f.source.body.group.visible, true);
  assert.equal(f.destination.orphan.visible, false);assert.equal(f.destination.body.group.visible, false);assert.equal(f.destination.starViews[0].light.visible, false);
  assert.equal(f.context.ship.group.visible, true);assert.equal(f.context.sunShadow.visible, true);assert.equal(f.context.riftPortalAmbient.visible, false);
  assert.equal(f.scene.fog.color.getHex(), 0x123456);assert.deepEqual(f.stars.position.toArray(), [-1, -2, -3]);assert.deepEqual(f.backdrop.position.toArray(), [-4, -5, -6]);
  assert.equal(f.live.synced, 1, 'the near medium is rebound after the far draw');
});

function adoptionFixture() {
  const source = system('source'), destination = system('destination', false), context = helpers({ THREE,
    state: 'space', paused: false, riftFarBodyId: null, BASE_FOV: 63,
    nav: { pos: new THREE.Vector3(0, 0, 500), quat: new THREE.Quaternion(), vel: new THREE.Vector3() }, camera: new THREE.PerspectiveCamera(),
    ui: { beginWarpPower() {}, beginTravel() {}, endTravel() {}, showArrival() {}, setHint() {}, setCrosshair() {} }, spaceCtl: { enabled: true }, clock: { elapsedTime: 0 }, celestialClock: { hours: 0 },
    performance: { now: () => 1000 }, clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
    smoothstep: (low, high, value) => Math.max(0, Math.min(1, (value - low) / (high - low))), ...transit,
    TRANSIT_COOL: new THREE.Color(0.55, 0.7, 1), transitColorA: new THREE.Color(), transitColorB: new THREE.Color(),
    shipView: { fovOffset: () => 0, prevQuat: new THREE.Quaternion(), viewBlend: 1, shipwalk: false }, nodePipeline: {},
    lookQuatAt: (_from, _to, out) => out.identity(), blackHoleArrivalDistance: () => 10,
    universe: { system: source, fadingSystem: null, relativizeSystem() {}, planets: () => [], adoptSystem(prepared) { this.fadingSystem = this.system;this.system = prepared;return prepared; } },
    deferredSystemWarmQueue: [], transferredPreparedDestination: {}, retiredRiftSystem: null, cancelPulseBurst() {},
    riftEntranceUniv: new THREE.Vector3(), riftTargetUniv: new THREE.Vector3(), riftPreviewOriginUniv: new THREE.Vector3(),
    riftOrientation: new THREE.Quaternion(), riftAssistQuat: new THREE.Quaternion(), prevNavPos: new THREE.Vector3(), _v2: new THREE.Vector3(), _v3: new THREE.Vector3(),
    audio: { cue() {} }, syncRiftDestination() {}, riftDestinationPreparationReady: () => true, riftReadyToOpen: () => true,
    riftFarWarmState: 'complete', riftFarBodyId: null, riftPreviewReady: true,
    spatialRift: { open: 0, animating: false, depth: 108, group: group(true), update() {}, setTransform() {}, crossed: () => true, markTraversed() {} },
  });
  context.setState = state => { context.state = state; };
  return { context, source, destination, verify() {
    assert.equal(context.universe.system, destination);assert.equal(context.retiredRiftSystem, source);assert.equal(context.universe.fadingSystem, null);
    assert.equal(source.orphan.visible, false);assert.equal(destination.orphan.visible, true);assert.equal(source.body.group.visible, false);
    assert.equal(destination.body.group.visible, true);assert.equal(destination.other.group.visible, false);
    assert.equal(context.deferredSystemWarmQueue.length, 1);assert.equal(context.deferredSystemWarmQueue[0].body, destination.other);
  } };
}
await test('stellar warp transfers standalone ownership and retains deferred non-target bodies', () => {
  const f = adoptionFixture();let step;
  f.context.addTween = (_duration, update) => { step = update; };
  load('warpTo', f.context)(f.destination.star, f.destination.body.bodyId, f.destination);step(.6);f.verify();
});
await test('an early stellar warp hides sites produced while finishing the prepared target, then adopts them', () => {
  const f = adoptionFixture(), sites = f.destination.artificialSites;let step;
  f.destination.bodyById.delete(f.destination.body.bodyId);f.destination.planets = [f.destination.other];f.destination.built = false;f.destination.artificialSites = [];
  f.destination.orphan.visible = true;
  f.destination.buildNext = () => {
    f.destination.planets.push(f.destination.body);f.destination.bodyById.set(f.destination.body.bodyId, f.destination.body);
    f.destination.artificialSites = sites;f.destination.built = true;
  };
  f.context.primePreparedBodyTextures = () => {};
  f.context.addTween = (_duration, update) => { step = update; };
  load('warpTo', f.context)(f.destination.star, f.destination.body.bodyId, f.destination);step(.05);
  assert.equal(f.destination.orphan.visible, false);assert.equal(f.destination.body.group.visible, false);assert.equal(f.context.universe.system, f.source);
  step(.6);f.verify();
});
await test('direct planar lane crossing swaps immediately off-axis, keeps free lateral velocity and preserves cloud/camera handoff', () => {
  const reach = 2200;
  const f = adoptionFixture(), portal = new SpacePortal(createPortalProfile({
    shape: 'plane', openSeconds: 1.15, seamFraction: 0.26, halfWidth: 0.23 * reach, halfHeight: 0.14 * reach,
  }));
  const source = new THREE.Vector3(150, -80, -2200), target = new THREE.Vector3(5e9, -1e8, 3e9);
  const sourceQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, -0.35, 0.08, 'YXZ'));
  const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.24, 1.45, 0.19, 'YXZ'));
  portal.setFrames(source, sourceQuat, target, targetQuat);
  portal.phase = 'open';portal.open = { x: 1, y: 1, tension: 0, flash: 0 };
  let exchanged = 0, cloudReset = 0, frameInvalidated = 0, taaReset = 0;
  const mainCloud = { historyValid: true, exchangeTemporalState(other) { exchanged++;this.historyValid = other.historyValid; }, resetHistory() { cloudReset++;this.historyValid = false; } };
  const farCloud = { historyValid: true };
  Object.assign(f.context, { riftPortal: portal, riftPreviewSystem: f.destination, riftPreviewReady: true, riftBackSystem: null,
    riftEntranceUniv: source.clone(), riftOrientation: sourceQuat.clone(),
    lerp: (a, b, t) => a + (b - a) * t, riftSpill: new THREE.Color(), clock: { elapsedTime: 10 }, nearest: null, riftTargetUniv: target.clone(),
    nodePipeline: { setActiveAtmosphere() {}, invalidateTemporalHistory() { cloudReset++; },
      frameState: { invalidate() { frameInvalidated++; } }, temporalAA: { resetHistory() { taaReset++; } },
      cloudPass: mainCloud, portalComposite: { enabled: true } },
    portalView: { rendered: true, pipeline: { setActiveAtmosphere() {}, cloudPass: farCloud } },
    systemBuildResumeAt: 0, focusPlanet: null, _v: new THREE.Vector3() });
  f.context.riftRoute = { arrived: false, anchorLocked: true, openStarted: true, pendingCrossing: false, lastHintBand: 0, label: 'route', reach,
    arrival: { bodyId: f.destination.body.bodyId, entry: target.clone(), quat: targetQuat.clone() } };
  const atSource = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(sourceQuat).add(source);
  const dirSource = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(sourceQuat);
  // First step approaches off-axis inside the capture zone: lateral velocity must NOT be pulled.
  const velBefore = dirSource(42, -19, -85);
  f.context.prevNavPos.copy(atSource(110, -52, 95));
  f.context.nav.pos.copy(atSource(114, -54, 86));
  f.context.nav.vel.copy(velBefore);
  const shipQuat = sourceQuat.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.09, 0.28, 0.05, 'YXZ')));
  const prevShipQuat = sourceQuat.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.08, 0.27, 0.05, 'YXZ')));
  f.context.nav.quat.copy(shipQuat);
  f.context.shipView.prevQuat.copy(prevShipQuat);
  f.context.riftThresholdCrossing = load('riftThresholdCrossing', f.context);
  f.context.nearestBodyOf = load('nearestBodyOf', f.context);
  f.context.finishRiftCrossing = load('finishRiftCrossing', f.context);
  const update = load('updateRiftRoute', f.context);
  update(.016);
  assert.equal(f.context.riftRoute.arrived, false);
  assert.ok(f.context.nav.vel.distanceTo(velBefore) < 1e-9, 'free lateral approach preserves off-axis velocity');
  // Next step crosses the planar threshold off-axis at (130, -60).
  const crossPrev = atSource(122, -56, 8);
  const crossCurr = atSource(134, -62, -6);
  f.context.prevNavPos.copy(crossPrev);
  f.context.nav.pos.copy(crossCurr);
  const expectedPos = portal.mapPosition(crossCurr, new THREE.Vector3());
  const expectedPrev = portal.mapPosition(crossPrev, new THREE.Vector3());
  const expectedVel = portal.mapDirection(velBefore, new THREE.Vector3());
  const expectedQuat = portal.mapQuaternion(shipQuat, new THREE.Quaternion());
  const expectedPrevQuat = portal.mapQuaternion(prevShipQuat, new THREE.Quaternion());
  update(.016);
  assert.equal(f.context.riftRoute.arrived, true, 'crossing happens directly on the plane without throat delay');
  assert.equal(f.context.universe.system, f.destination);
  assert.equal(f.context.riftBackSystem, f.source, 'the departure world stays drawable behind the fold');
  assert.equal(f.context.universe.fadingSystem, null);
  assert.equal(f.source.orphan.visible, false);assert.equal(f.source.body.group.visible, false);
  assert.equal(f.destination.orphan.visible, true);assert.equal(f.destination.body.group.visible, true);assert.equal(f.destination.other.group.visible, false);
  assert.equal(f.context.deferredSystemWarmQueue.length, 1);
  assert.equal(exchanged, 1);assert.equal(cloudReset, 0, 'swapped LiteCloudPass history is preserved');assert.equal(mainCloud.historyValid, true);
  assert.equal(frameInvalidated, 1);assert.equal(taaReset, 1);
  assert.ok(f.context.nav.pos.distanceTo(expectedPos) < 1e-4, 'off-axis position maps continuously');
  assert.ok(f.context.prevNavPos.distanceTo(expectedPrev) < 1e-4, 'prevNavPos maps continuously');
  assert.ok(f.context.nav.vel.distanceTo(expectedVel) < 1e-8, 'off-axis velocity magnitude and direction are preserved');
  assert.ok(f.context.nav.quat.angleTo(expectedQuat) < 1e-6, 'off-axis heading is carried');
  assert.ok(f.context.shipView.prevQuat.angleTo(expectedPrevQuat) < 1e-6, 'cockpit angular-velocity history maps without jump');
});

await test('late destination holds crossing at near threshold and prevents black aperture while loading', () => {
  const reach = 2200;
  const f = adoptionFixture(), portal = new SpacePortal(createPortalProfile({
    shape: 'plane', openSeconds: 1.15, seamFraction: 0.26, halfWidth: 0.23 * reach, halfHeight: 0.14 * reach,
  }));
  const source = new THREE.Vector3(0, 0, -2200), target = new THREE.Vector3(5e9, 0, 0);
  const targetQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
  portal.setFrames(source, new THREE.Quaternion(), target, targetQuat);
  Object.assign(f.context, { riftPortal: portal, riftPreviewSystem: f.destination, riftPreviewReady: false, riftBackSystem: null,
    riftEntranceUniv: source.clone(), riftOrientation: new THREE.Quaternion(),
    riftSpill: new THREE.Color(), clock: { elapsedTime: 0 }, nearest: null, riftTargetUniv: target.clone(),
    nodePipeline: { setActiveAtmosphere() {}, cloudPass: { exchangeTemporalState() {} }, portalComposite: { enabled: true } },
    portalView: { rendered: false, pipeline: { setActiveAtmosphere() {}, cloudPass: {} } },
    systemBuildResumeAt: 0, focusPlanet: null, _v: new THREE.Vector3(),
    riftRoute: { arrived: false, anchorLocked: false, openStarted: true, pendingCrossing: false, lastHintBand: -1, label: 'route', reach,
      arrival: { bodyId: f.destination.body.bodyId, entry: target.clone(), quat: targetQuat.clone() } } });
  const foldEvents = [];
  f.context.emitFoldNav = (phase, label = '') => foldEvents.push({ phase, label });
  f.context.riftThresholdCrossing = load('riftThresholdCrossing', f.context);
  f.context.nearestBodyOf = load('nearestBodyOf', f.context);
  f.context.finishRiftCrossing = load('finishRiftCrossing', f.context);
  const update = load('updateRiftRoute', f.context);

  // Immediate forward input while loading & still at the seam: portal remains world-anchored,
  // momentum is captured, and crossing completes cleanly once open and ready.
  portal.beginOpening();
  f.context.prevNavPos.set(70, -25, source.z + 20);
  f.context.nav.pos.set(80, -30, source.z - 20);
  const approachVel = new THREE.Vector3(10, -5, -420);
  const expectedVel = portal.mapDirection(approachVel, new THREE.Vector3());
  f.context.nav.vel.copy(approachVel);
  update(0.05);
  assert.ok(f.context.riftEntranceUniv.equals(source), 'portal stays world-anchored even when ship rushes the unready seam');
  assert.equal(f.context.riftRoute.pendingCrossing, true, 'immediate forward input during load latches pendingCrossing');
  assert.ok(portal.locate(f.context.nav.pos).z >= 1, 'ship waits cleanly on near side of threshold');
  for (let i = 0; i < 20; i++) update(0.05);
  assert.ok(portal.open.y < 0.15, `expected seam hold below black-aperture tear, got y=${portal.open.y}`);
  // Once far view renders, portal opens cleanly to open phase, emits 'open', and crosses with heldVelocity preserved.
  f.context.portalView.rendered = true;
  f.context.riftPreviewReady = true;
  for (let i = 0; i < 30 && !f.context.riftRoute.arrived; i++) {
    f.context.prevNavPos.copy(f.context.nav.pos);
    update(0.05);
  }
  assert.equal(portal.phase, 'open');
  assert.equal(f.context.riftRoute.anchorLocked, true);
  assert.equal(f.context.riftRoute.arrived, true, 'latched crossing completes automatically once open and ready');
  assert.equal(f.context.universe.system, f.destination);
  assert.ok(f.context.nav.vel.distanceTo(expectedVel) < 1e-8, 'held forward velocity is restored and mapped on crossing');
  assert.deepEqual(foldEvents, [{ phase: 'open', label: 'route' }, { phase: 'clear', label: '' }]);
});

await test('cancelRiftRoute tears down portal state, restores flight HUD controls, and clears fold-nav', () => {
  const f = adoptionFixture(), portal = new SpacePortal(createPortalProfile({
    shape: 'plane', openSeconds: 1.15, seamFraction: 0.26, halfWidth: 506, halfHeight: 308,
  }));
  portal.phase = 'opening';portal.open = { x: 1, y: 0.012, tension: 0.4, flash: 0 };
  const foldEvents = [];
  let endTravelCalls = 0, disposed = 0, released = 0;
  Object.assign(f.context, {
    riftPortal: portal,
    riftPreviewSystem: f.destination,
    riftPreviewReady: false,
    riftBackSystem: null,
    riftFarBodyId: f.destination.body.bodyId,
    riftFarWarmToken: 3,
    riftFarWarmState: 'compiling',
    riftRoute: { arrived: false, anchorLocked: false, openStarted: true, label: 'route' },
    nodePipeline: { portalComposite: { enabled: true, uniforms: { tPortal: { value: {} } } } },
    portalView: { pipeline: { setActiveAtmosphere() {} }, release() { released++; } },
    disposeRiftPreview() { disposed++;f.context.riftPreviewSystem = null; },
    emitFoldNav: (phase, label = '') => foldEvents.push({ phase, label }),
    ui: { ...f.context.ui, endTravel() { endTravelCalls++; } },
  });
  const cancel = load('cancelRiftRoute', f.context);
  assert.equal(cancel(), true);
  assert.equal(f.context.riftRoute, null);
  assert.equal(portal.phase, 'closed');
  assert.equal(f.context.nodePipeline.portalComposite.enabled, false);
  assert.equal(f.context.nodePipeline.portalComposite.uniforms.tPortal.value, null);
  assert.equal(f.context.riftFarWarmState, 'idle');
  assert.equal(f.context.riftFarWarmToken, 4);
  assert.equal(disposed, 1);assert.equal(released, 1);assert.equal(endTravelCalls, 1);
  assert.equal(f.context.spaceCtl.enabled, true);
  assert.deepEqual(foldEvents, [{ phase: 'clear', label: '' }]);
});

const failures = cases.filter(row => !row.passed), sourceStable = (await readFile(mainPath)).equals(bytes)
  && (await readFile(new URL(import.meta.url))).equals(verifier);
const report = { passed: !failures.length && sourceStable, sourceStable, scope: 'Actual-main CPU ownership transitions; no GPU/image/cost acceptance',
  mainPath, mainSha256: hash(bytes), verifierSha256: hash(verifier), functions, counts: { passed: cases.length - failures.length, failed: failures.length }, cases };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));console.log(JSON.stringify({ directory: out, passed: report.passed, sourceStable,
  counts: report.counts, failures: failures.map(row => ({ name: row.name, error: row.error })) }));if (!report.passed) process.exitCode = 1;
