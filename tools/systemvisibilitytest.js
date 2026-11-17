// Actual main ownership transitions. CPU-only scene objects, no renderer/GPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import * as transit from '../src/transit.js';
import { SpacePortal } from '../src/portal/space-portal.js';

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
  const other = { bodyId: `${id}-other`, group: group(visible) };
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
    skyDome: { mesh: group(true) }, hemi: group(true), ambient: group(false), riftPortalAmbient: group(false) });
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
    state: 'space', BASE_FOV: 63, RIFT_SPAWN_DISTANCE: 7000,
    nav: { pos: new THREE.Vector3(0, 0, 500), quat: new THREE.Quaternion(), vel: new THREE.Vector3() }, camera: new THREE.PerspectiveCamera(),
    ui: { beginWarpPower() {}, showArrival() {}, setHint() {} }, spaceCtl: {}, clock: { elapsedTime: 0 }, celestialClock: { hours: 0 },
    performance: { now: () => 1000 }, clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
    smoothstep: (low, high, value) => Math.max(0, Math.min(1, (value - low) / (high - low))), ...transit,
    TRANSIT_COOL: new THREE.Color(0.55, 0.7, 1), transitColorA: new THREE.Color(), transitColorB: new THREE.Color(),
    shipView: { fovOffset: () => 0 }, nodePipeline: {},
    lookQuatAt: (_from, _to, out) => out.identity(), blackHoleArrivalDistance: () => 10,
    universe: { system: source, fadingSystem: null, relativizeSystem() {}, planets: () => [], adoptSystem(prepared) { this.fadingSystem = this.system;this.system = prepared;return prepared; } },
    deferredSystemWarmQueue: [], transferredPreparedDestination: {}, retiredRiftSystem: null, cancelPulseBurst() {},
    riftEntranceUniv: new THREE.Vector3(), riftTargetUniv: new THREE.Vector3(), riftPreviewOriginUniv: new THREE.Vector3(),
    riftOrientation: new THREE.Quaternion(), riftAssistQuat: new THREE.Quaternion(), prevNavPos: new THREE.Vector3(), _v2: new THREE.Vector3(), _v3: new THREE.Vector3(),
    audio: { cue() {} }, syncRiftDestination() {}, riftDestinationPreparationReady: () => false, riftPreviewReady: true,
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
await test('rift crossing maps the pose through the fold and keeps the departure world as the closing far side', () => {
  const f = adoptionFixture(), portal = new SpacePortal({ halfWidth: 500, halfHeight: 400 });
  const source = new THREE.Vector3(0, 0, -1000), target = new THREE.Vector3(5e9, 0, 0);
  const targetQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  portal.setFrames(source, new THREE.Quaternion(), target, targetQuat);
  portal.phase = 'open';portal.open = { x: 1, y: 1, tension: 0, flash: 0 };
  let exchanged = 0;
  Object.assign(f.context, { riftPortal: portal, riftPreviewSystem: f.destination, riftPreviewReady: true, riftBackSystem: null,
    riftEntranceUniv: source.clone(), riftOrientation: new THREE.Quaternion(), riftInverse: new THREE.Quaternion(), riftLocalVel: new THREE.Vector3(),
    RIFT_CAPTURE_DISTANCE: 1900, lerp: (a, b, t) => a + (b - a) * t, riftSpill: new THREE.Color(), clock: { elapsedTime: 10 },
    nodePipeline: { setActiveAtmosphere() {}, cloudPass: { exchangeTemporalState() { exchanged++; } }, portalComposite: { enabled: true } },
    portalView: { pipeline: { cloudPass: {} } }, systemBuildResumeAt: 0, focusPlanet: null, _v: new THREE.Vector3() });
  f.context.riftRoute = { arrived: false, anchorLocked: true, openStarted: true, lastHintBand: 0, label: 'route',
    arrival: { bodyId: f.destination.body.bodyId, entry: target.clone(), quat: targetQuat.clone() } };
  f.context.prevNavPos.set(0, 0, -995);f.context.nav.pos.set(0, 0, -1004);f.context.nav.vel.set(0, 0, -76);
  f.context.finishRiftCrossing = load('finishRiftCrossing', f.context);
  load('updateRiftRoute', f.context)(.016);
  assert.equal(f.context.riftRoute.arrived, true);assert.equal(f.context.universe.system, f.destination);
  assert.equal(f.context.riftBackSystem, f.source, 'the departure world stays drawable behind the fold');
  assert.equal(f.context.universe.fadingSystem, null);assert.equal(f.source.orphan.visible, false);assert.equal(f.source.body.group.visible, false);
  assert.equal(f.destination.orphan.visible, true);assert.equal(f.destination.body.group.visible, true);assert.equal(f.destination.other.group.visible, false);
  assert.equal(f.context.deferredSystemWarmQueue.length, 1);assert.equal(exchanged, 1);
  // 4 m past the opening along the source normal == 4 m past the target frame
  const expected = new THREE.Vector3(0, 0, -4).applyQuaternion(targetQuat).add(target);
  assert.ok(f.context.nav.pos.distanceTo(expected) < 1e-6, 'position continues through the fold');
  assert.ok(f.context.nav.vel.clone().normalize().distanceTo(new THREE.Vector3(0, 0, -1).applyQuaternion(targetQuat)) < 1e-9, 'velocity is carried, not re-aimed');
  assert.ok(f.context.prevNavPos.distanceTo(new THREE.Vector3(0, 0, 5).applyQuaternion(targetQuat).add(target)) < 1e-6, 'frame history follows the fold');
});

const failures = cases.filter(row => !row.passed), sourceStable = (await readFile(mainPath)).equals(bytes)
  && (await readFile(new URL(import.meta.url))).equals(verifier);
const report = { passed: !failures.length && sourceStable, sourceStable, scope: 'Actual-main CPU ownership transitions; no GPU/image/cost acceptance',
  mainPath, mainSha256: hash(bytes), verifierSha256: hash(verifier), functions, counts: { passed: cases.length - failures.length, failed: failures.length }, cases };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));console.log(JSON.stringify({ directory: out, passed: report.passed, sourceStable,
  counts: report.counts, failures: failures.map(row => ({ name: row.name, error: row.error })) }));if (!report.passed) process.exitCode = 1;
