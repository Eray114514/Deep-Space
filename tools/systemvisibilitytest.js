// Actual main ownership transitions. CPU-only scene objects, no renderer/GPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import * as transit from '../src/transit.js';

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

function portalFixture(fault) {
  const source = system('source'), fading = system('fading'), destination = system('destination', false);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();scene.fog = new THREE.Fog(0x123456, 1, 100);
  destination.child.visible = false;destination.child.layers.set(2);const expected = Error('portal ownership fault');
  const near = new THREE.ShaderMaterial(), direct = new THREE.ShaderMaterial();
  const cloud = new THREE.Mesh(new THREE.BufferGeometry(), near);
  destination.body.group.add(cloud);
  Object.assign(destination.body, { volCloudMesh: cloud, volCloudMat: near, getDirectCloudMaterial: () => direct });
  let clear = new THREE.Color(0x123456), alpha = .4;
  const context = helpers({ THREE, scene, universe: { system: source, fadingSystem: fading },
    riftPortalVisibility: [], riftPortalCloudState: [], riftPortalLayerState: [], riftPortalClearColor: new THREE.Color(), riftPortalSceneActive: false,
    ship: { group: group(true) }, weapons: { glowMesh: group(true), coreMesh: group(false) }, sunShadow: group(true), headlamp: group(false),
    skyDome: { mesh: group(true) }, hemi: group(true), ambient: group(false), riftPortalAmbient: group(false), RIFT_PORTAL_LAYER: 5,
    renderer: { toneMapping: THREE.ACESFilmicToneMapping, getClearColor(out) { return out.copy(clear); }, getClearAlpha: () => alpha,
      setClearColor(value, next) { clear.set(value);alpha = next; } },
  });
  for (const name of ['addRiftPortalHidden', 'moveToRiftPortalLayer', 'setRiftPreviewVisible', 'hideSystemForRiftPortal', 'beginRiftPortalScene', 'endRiftPortalScene']) context[name] = load(name, context);
  const realMove = context.moveToRiftPortalLayer;
  context.moveToRiftPortalLayer = object => { realMove(object);if (fault === 'partial-layer' && object === destination.orphan) throw expected; };
  context.spatialRift = { renderPortal(options) {
    try {
      options.beforeRender(camera);
      assert.equal(source.orphan.visible, false);assert.equal(fading.orphan.visible, false);assert.equal(destination.orphan.visible, true);
      assert.equal(destination.orphan.layers.mask, 1 << 5);assert.equal(destination.child.layers.mask, 1 << 5);
      assert.equal(destination.body.group.visible, true);assert.equal(destination.other.group.visible, false);
      assert.equal(cloud.material, direct);assert.equal(direct.depthTest, false);assert.equal(near.depthTest, true);
      if (fault === 'draw') throw expected;
    } finally { options.afterRender(); }
  } };
  return { context, source, fading, destination, expected, run() {
    return load('renderRiftDestinationPortal', context)({ previewSystem: destination, targetBodyId: destination.body.bodyId });
  }, restored() {
    assert.equal(source.orphan.visible, true);assert.equal(fading.orphan.visible, true);assert.equal(destination.orphan.visible, false);
    assert.equal(destination.orphan.layers.mask, 1);assert.equal(destination.child.layers.mask, 1 << 2);assert.equal(destination.child.visible, false);
    assert.equal(destination.body.group.visible, false);assert.equal(destination.other.group.visible, false);
    assert.equal(context.riftPortalSceneActive, false);assert.equal(context.renderer.toneMapping, THREE.ACESFilmicToneMapping);
    assert.equal(scene.fog.color.getHex(), 0x123456);assert.equal(clear.getHex(), 0x123456);assert.equal(alpha, .4);
    assert.equal(context.riftPortalVisibility.length, 0);assert.equal(context.riftPortalLayerState.length, 0);
    assert.equal(cloud.material, near);assert.equal(direct.depthTest, true);assert.equal(context.riftPortalCloudState.length, 0);
  } };
}
for (const fault of [null, 'draw', 'partial-layer']) await test(`portal owns standalone visibility/layers and restores after ${fault || 'success'}`, () => {
  const f = portalFixture(fault);if (fault) assert.throws(() => f.run(), error => error === f.expected);else f.run();f.restored();
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
await test('rift crossing transfers standalone ownership and retains deferred non-target bodies', () => {
  const f = adoptionFixture();f.context.riftPreviewSystem = f.destination;
  f.context.riftRoute = { arrived: false, anchorLocked: false, openStarted: true, lastHintBand: 0,
    arrival: { bodyId: f.destination.body.bodyId, entry: new THREE.Vector3(0, 0, 110), quat: new THREE.Quaternion() } };
  load('updateRiftRoute', f.context)(.016);f.verify();assert.equal(f.context.riftRoute.arrived, true);
});

const failures = cases.filter(row => !row.passed), sourceStable = (await readFile(mainPath)).equals(bytes)
  && (await readFile(new URL(import.meta.url))).equals(verifier);
const report = { passed: !failures.length && sourceStable, sourceStable, scope: 'Actual-main CPU ownership transitions; no GPU/image/cost acceptance',
  mainPath, mainSha256: hash(bytes), verifierSha256: hash(verifier), functions, counts: { passed: cases.length - failures.length, failed: failures.length }, cases };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));console.log(JSON.stringify({ directory: out, passed: report.passed, sourceStable,
  counts: report.counts, failures: failures.map(row => ({ name: row.name, error: row.error })) }));if (!report.passed) process.exitCode = 1;
