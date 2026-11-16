// Actual main-loop wiring and auxiliary view methods. Render doubles validate
// admission and exception leases; native GPU/image checks live separately.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { SurfaceWeapons, SURFACE_WEAPONS } from '../src/surface-weapons.js';
import { WeaponLighting } from '../src/weapon-lighting.js';
import { WeaponSkyProbe } from '../src/weapon-sky-probe.js';

const main = await readFile('src/main.js', 'utf8');
let passed = 0;
const test = work => { work();passed++; };
function load(name, context) {
  const start = main.indexOf(`function ${name}(`), end = main.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name);
  return vm.runInNewContext(`(${main.slice(start, end + 2)})`, context);
}
function captured(work) {
  let caught = false, value;
  try { work(); } catch (error) { caught = true;value = error; }
  assert.equal(caught, true);return value;
}
function worldFixture({ busy = false, ready = true, shipPending = false, bootstrapReady = false, fault = null } = {}) {
  const events = [], context = {
    renderer: { info: { reset() { events.push('reset'); } } },
    surfaceWeapons: { prepareLighting() { events.push('lighting');if (fault === 'lighting') throw null; },
      renderScopeView() { events.push('scope');if (fault === 'scope') throw null; } },
    renderRiftPortal() { events.push('portal');if (fault === 'portal') throw null; },
    finishSurfaceBootstrap() { events.push('bootstrap');if (bootstrapReady) context.surfacePipelinesReady = true; },
    pipelineResizePending: true, pipelineResourcesBusy: () => false, sizePost() { events.push('resize'); },
    surfacePipelinesReady: ready, shipPipelineWarmPending: shipPending,
    bloomPass: { enabled: false }, gradePass_: { enabled: false, uniforms: { uTime: { value: -1 } } },
    usePost: true, QUALITY_LOW: false, DEV_SERVER: true, devWaterWakeFixture: null, clock: { elapsedTime: 12 },
    nav: { pos: {} }, universe: { system: {} }, celestialClock: { epoch: 5 },
    ship: { group: {}, foregroundOnly: true }, foregroundPass: {}, rigidWorldObjects: new Map(),
  };
  context.nodePipeline = { renderPass: {}, submitFrame(work) {
    if (busy) return false;
    events.push('admitted');
    work(options => {
      events.push('graph');assert.equal(options.origin, context.nav.pos);
      assert.equal(options.context, context.universe.system);assert.equal(options.timeEpoch, 5);
      assert.equal(options.rigidObjects.get(context.ship.group), context.ship.foregroundOnly
        ? context.foregroundPass : context.nodePipeline.renderPass);
      return true;
    });
    events.push('fence');return true;
  } };
  return { context, events, run: load('renderWorldFrame', context) };
}
test(() => {
  const f = worldFixture({ busy: true });assert.equal(f.run(), false);assert.deepEqual(f.events, []);
  assert.equal(f.context.gradePass_.uniforms.uTime.value, -1);
});
test(() => {
  const f = worldFixture();assert.equal(f.run(), true);
  assert.deepEqual(f.events, ['admitted', 'reset', 'lighting', 'portal', 'scope', 'bootstrap', 'resize', 'graph', 'fence']);
  assert.equal(f.context.gradePass_.uniforms.uTime.value, 12);
  f.context.ship.foregroundOnly = false;assert.equal(f.run(), true);
});
test(() => {
  const f = worldFixture({ ready: false, bootstrapReady: true });assert.equal(f.run(), true);
  assert.ok(f.events.indexOf('bootstrap') < f.events.indexOf('graph'), 'Bootstrap readiness cannot depend on a main graph admission');
});
for (const options of [{ ready: false }, { shipPending: true }]) test(() => {
  const f = worldFixture(options);assert.equal(f.run(), false);
  assert.equal(f.events.includes('graph'), false);assert.equal(f.events.at(-1), 'fence');
});
for (const fault of ['lighting', 'portal', 'scope']) test(() => {
  const f = worldFixture({ fault });assert.equal(captured(f.run), null);assert.equal(f.events.includes('graph'), false);
});

function scopeFixture(fault, error, lensVisible = true) {
  const scopeTarget = { texture: {} }, lens = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  lens.material.map = scopeTarget.texture;lens.visible = lensVisible;
  const group = new THREE.Group();group.add(lens);
  const caller = {}, initial = { target: caller, face: 4, mip: 2 };
  let target = caller, face = 4, mip = 2, draws = 0;
  const subject = { index: 0, models: [],
    rig: new THREE.Group(), scopeTarget, scopeCamera: new THREE.PerspectiveCamera(),
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene() };
  subject.models[subject.index] = { group, opticGlass: lens, hasScope: true };
  const renderer = {
    getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(value, nextFace = 0, nextMip = 0) {
      target = value;face = nextFace;mip = nextMip;
      if (fault === 'bind' && value === scopeTarget) throw error;
      if (value === caller) {
        if (fault === 'restore') throw error;
        if (fault === 'draw-and-restore') throw new Error('secondary restore failure');
      }
    },
    clear() { if (fault === 'clear') throw error; },
    render(scene, camera) {
      draws++;assert.equal(scene, subject.scene);assert.equal(camera, subject.scopeCamera);
      assert.equal(subject.rig.visible, false);assert.equal(lens.visible, false);
      if (fault === 'draw' || fault === 'draw-and-restore') throw error;
    },
  };
  return { subject, renderer, run: () => SurfaceWeapons.prototype.renderScopeView.call(subject, renderer),
    restored() { assert.deepEqual({ target, face, mip }, initial);assert.equal(subject.rig.visible, true);assert.equal(lens.visible, lensVisible); },
    get draws() { return draws; }, dispose() { lens.geometry.dispose();lens.material.dispose(); } };
}
for (const fault of [null, 'bind', 'clear', 'draw', 'restore', 'draw-and-restore']) {
  for (const error of [null, undefined, false, new Error('scope draw')]) test(() => {
    const f = scopeFixture(fault, error, false);
    try {
      if (fault) assert.equal(captured(f.run), error);else { f.run();assert.equal(f.draws, 1); }
      f.restored();
    } finally { f.dispose(); }
  });
}
test(() => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), lighting = new WeaponLighting(scene, camera);
  const material = new THREE.MeshStandardMaterial(), source = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const weapon = { rig: { visible: true }, lighting }, records = [], space = new THREE.Texture(), outdoor = new THREE.Texture();
  const radiance = { renderer: {}, sources: [], spaceEnvironment: space, environmentIntensity: .3 };
  lighting.register(source);
  lighting.skyProbe.update = (renderer, environment, up) => { records.push({ renderer, day: environment.day, up: up.toArray() });return outdoor; };
  try {
    SurfaceWeapons.prototype.updateLighting.call(weapon, radiance, { day: 1, atmosphere: 1 }, new THREE.Vector3(0, 1, 0));
    SurfaceWeapons.prototype.updateLighting.call(weapon, radiance, { day: .5, atmosphere: 1 }, new THREE.Vector3(1, 0, 0));
    assert.equal(records.length, 0, 'CPU updates do not generate the PMREM');assert.equal(material.envMap, null);
    SurfaceWeapons.prototype.prepareLighting.call(weapon);
    assert.deepEqual(records, [{ renderer: radiance.renderer, day: .5, up: [1, 0, 0] }]);assert.equal(material.envMap, outdoor);
    lighting.root.visible = false;SurfaceWeapons.prototype.prepareLighting.call(weapon);
    assert.equal(records.length, 1);assert.equal(material.envMap, space);
  } finally { lighting.dispose();material.dispose();source.geometry.dispose();space.dispose();outdoor.dispose(); }
});
test(() => {
  const probe = new WeaponSkyProbe(), oldTarget = { texture: {} }, error = new Error('PMREM draw');let disposed = 0;
  probe.target = oldTarget;probe.key = 'old';
  probe.generator = { fromEquirectangular(source) { source.addEventListener('dispose', () => disposed++);throw error; } };
  assert.equal(captured(() => probe.update({}, { day: 1, atmosphere: 1 }, new THREE.Vector3(0, 1, 0))), error);
  assert.equal(disposed, 1);assert.equal(probe.target, oldTarget);assert.equal(probe.key, 'old');
});

for (const failBegin of [false, true]) test(() => {
  const group = () => new THREE.Group(), source = group(), target = group(), extra = group(), sourceOrphan = group(), targetOrphan = group();
  const stationLight = new THREE.PointLight();stationLight.layers.set(2);stationLight.visible = false;targetOrphan.add(stationLight);
  const star = { group: group(), light: new THREE.DirectionalLight() }, planet = { group: target, volCloudMat: { depthTest: true } };
  const preview = { starViews: [star], planets: [planet], compactObjects: [{ group: extra }], artificialSites: [{ parentBody: null, group: targetOrphan }] };
  target.visible = false;extra.visible = true;star.light.visible = false;targetOrphan.visible = false;
  const clear = new THREE.Color(.1, .2, .3), originalClear = clear.clone(), fog = {};
  let alpha = .4, injected = false;
  const context = { THREE, RIFT_PORTAL_LAYER: 7, scene: { fog }, universe: {
    system: { starViews: [], planets: [{ group: source }], compactObjects: [], artificialSites: [{ parentBody: null, group: sourceOrphan }] }, fadingSystem: null },
    ship: { group: group() }, weapons: {}, sunShadow: group(), headlamp: group(), skyDome: {}, hemi: group(), ambient: group(),
    riftPortalAmbient: group(), riftPortalVisibility: [], riftPortalCloudState: [], riftPortalLayerState: [],
    riftPortalClearColor: new THREE.Color(), riftPortalClearAlpha: 1, riftPortalFog: null, riftPortalToneMapping: 0,
    riftPortalSceneActive: false, renderer: {
      toneMapping: THREE.ACESFilmicToneMapping, getClearColor: color => color.copy(clear), getClearAlpha: () => alpha,
      setClearColor(color, nextAlpha) { clear.set(color);alpha = nextAlpha;
        if (failBegin && !injected) { injected = true;throw null; } },
    } };
  context.skyDome.mesh = group();context.riftPortalAmbient.visible = false;
  for (const name of ['standaloneSiteGroups', 'addRiftPortalHidden', 'moveToRiftPortalLayer', 'hideSystemForRiftPortal', 'setRiftPreviewVisible']) context[name] = load(name, context);
  const before = [source, target, extra, sourceOrphan, targetOrphan, stationLight, star.group, star.light, context.riftPortalAmbient].map(object => ({ object, visible: object.visible, mask: object.layers.mask }));
  const begin = load('beginRiftPortalScene', context), end = load('endRiftPortalScene', context), camera = new THREE.PerspectiveCamera();
  if (failBegin) assert.equal(captured(() => begin(camera, preview, null)), null);else begin(camera, preview, null);
  assert.equal(sourceOrphan.visible, false);
  if (!failBegin) { assert.equal(targetOrphan.visible, true);assert.equal(targetOrphan.layers.mask, 1 << 7);assert.equal(stationLight.layers.mask, 1 << 7); }
  end(preview, null);end(preview, null);
  for (const row of before) { assert.equal(row.object.visible, row.visible);assert.equal(row.object.layers.mask, row.mask); }
  assert.equal(planet.volCloudMat.depthTest, true);assert.equal(context.scene.fog, fog);
  assert.equal(context.renderer.toneMapping, THREE.ACESFilmicToneMapping);assert.ok(clear.equals(originalClear));assert.equal(alpha, .4);
  assert.equal(context.riftPortalSceneActive, false);
});
console.log(JSON.stringify({ passed: true, cases: passed, scope: 'Actual main/auxiliary CPU contracts; no native GPU, image or performance claim' }));
