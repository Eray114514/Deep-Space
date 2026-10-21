import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
const main = await readFile('src/main.js', 'utf8');
function load(name, context) {
  const start = main.indexOf(`async function ${name}(`) >= 0
    ? main.indexOf(`async function ${name}(`) : main.indexOf(`function ${name}(`);
  const end = main.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name);
  return vm.runInNewContext(`(${main.slice(start, end + 2)})`, context);
}
function fixture(fault) {
  const scene = new THREE.Scene(), geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material), group = new THREE.Group();group.add(mesh);scene.add(group);
  group.visible = false;group.position.set(12, 34, 56);group.scale.setScalar(3);mesh.visible = false;
  const targetBody = { group, lod: { roots: [{ mesh }] }, waterLod: { roots: [{ mesh }] } };
  const star = visible => ({ light: { visible }, group: { visible } });
  const oldStar = star(false), newStar = star(true), oldBody = new THREE.Group();oldBody.visible = true;
  const universe = { system: { starViews: [oldStar], planets: [{ group: oldBody }], compactObjects: [] } };
  const prepared = { starViews: [newStar] };
  let resolve, reject, seen = 0;
  const promise = new Promise((yes, no) => { resolve = yes;reject = no; });
  const context = { THREE, scene, camera: new THREE.PerspectiveCamera(), renderer: {}, universe,
    warpCompile: new AbortController(), preparedDestinationIsActive: () => true,
    warpPreparedWaterWarmMesh: null, warpPreparedWaterWarmPlanet: null, warpPreparedWaterWarmState: '',
    console: { error() {} }, clearPreparedWaterWarmMesh() { context.warpPreparedWaterWarmMesh?.removeFromParent(); },
    compilePrograms(renderer, source, camera, targetScene, options) {
      seen++;assert.equal(renderer, context.renderer);assert.equal(camera, context.camera);
      if (source !== scene) assert.equal(targetScene, scene, 'A mesh alone must inherit the production scene lights');
      if (options) assert.equal(options.signal, context.warpCompile.signal);
      if (fault === 'sync') throw Error('sync fault');return promise;
    } };
  return { context, scene, mesh, group, targetBody, prepared, oldStar, newStar, oldBody,
    resolve, reject, get seen() { return seen; }, dispose() { geometry.dispose();material.dispose(); } };
}
for (const fault of ['none', 'sync', 'async']) {
  const f = fixture(fault), before = f.group.position.clone();
  const pending = load('uploadPreparedLodMeshes', f.context)(f.targetBody, f.prepared);
  const settled = pending.catch(error => { assert.match(error.message, /fault/); });
  assert.equal(f.seen, 1);assert.equal(f.group.visible, false);assert.ok(f.group.position.equals(before));
  assert.equal(f.group.scale.x, 3);assert.equal(f.mesh.visible, false);assert.equal(f.mesh.frustumCulled, true);
  assert.equal(f.oldStar.light.visible, false);assert.equal(f.newStar.light.visible, true);assert.equal(f.oldBody.visible, true);
  // A later live frame owns these values. Completion/failure must not restore
  // an obsolete snapshot over them, including when the submission throws.
  f.group.position.set(7, 8, 9);f.group.visible = true;f.mesh.visible = true;f.oldStar.light.visible = true;
  if (fault === 'async') f.reject(Error('async fault'));else f.resolve();
  await settled;assert.equal(f.group.position.x, 7);assert.equal(f.group.visible, true);
  assert.equal(f.mesh.visible, true);assert.equal(f.oldStar.light.visible, true);f.dispose();
}
for (const fault of ['none', 'sync', 'async']) {
  const f = fixture(fault);
  const pending = load('prewarmWorldMaterials', f.context)({ lod: f.targetBody.lod });
  const settled = pending.catch(error => assert.match(error.message, /fault/));
  assert.equal(f.scene.children.length, 1, 'Private world clone must leave the live scene before awaiting');
  if (fault === 'async') f.reject(Error('async fault'));else f.resolve();
  await settled;assert.equal(f.scene.children[0], f.group);f.dispose();
}
for (const fault of ['none', 'sync', 'async']) {
  const f = fixture(fault);
  const pending = load('prewarmPreparedWater', f.context)(f.targetBody, 1, {}, f.prepared);
  assert.equal(f.oldStar.light.visible, false, 'Restore authored visibility, not hard-coded true');
  assert.equal(f.newStar.light.visible, true);assert.equal(f.scene.children.length, 1);
  f.oldStar.light.visible = true;f.newStar.light.visible = false;
  if (fault === 'async') f.reject(Error('async fault'));else f.resolve();
  await pending;assert.equal(f.oldStar.light.visible, true);assert.equal(f.newStar.light.visible, false);f.dispose();
}
{
  const context = { ship: { heroLoaded: true }, shipPipelinesWarmed: false, shipPipelineWarmPending: false,
    surfacePipelinesReady: true, startupPrewarmExpired: true };
  load('prewarmLoadedShipPipelines', context)();
  assert.equal(context.shipPipelinesWarmed, true);assert.equal(context.surfacePipelinesReady, true);
}
for (const fault of ['sync', 'async']) {
  const light = { visible: false, intensity: 7 };
  let disposed = 0, reject;
  const context = { QUALITY_LOW: false, warmedSurfacePlanet: null, surfacePipelinesReady: true,
    loadingCleared: false, startupPrewarmExpired: false, THREE, scene: new THREE.Scene(),
    surfaceBootstrapGroup: new THREE.Group(), surfaceBootstrapMeshes: [], scatter: { meshes: {} }, farFlora: {},
    sunShadow: light, renderer: {}, camera: {}, startupCompile: new AbortController(),
    disposeSurfaceBootstrap() { disposed++;context.surfaceBootstrapGroup.removeFromParent(); },
    console: { warn() {} }, compilePrograms() { if (fault === 'sync') throw Error('sync fault');return new Promise((_r, fail) => { reject = fail; }); } };
  const body = { group: new THREE.Group() };
  load('prewarmSurfacePipelines', context)(body);
  assert.equal(light.visible, false);assert.equal(light.intensity, 7);
  if (fault === 'async') { reject(Error('async fault'));await Promise.resolve();await Promise.resolve(); }
  assert.equal(disposed, 1);assert.equal(context.surfacePipelinesReady, true);
  assert.equal(context.surfaceBootstrapGroup.parent, null);
}
{
  const context = { warpPreparationToken: 4, warpCompile: new AbortController(),
    warpPreparedSystem: { star: { id: 'destination' }, dispose() {} }, transferredPreparedDestination: null,
    resetPreparedDestinationWarmState() {}, AbortController };
  const route = { star: { id: 'destination' } }, signal = context.warpCompile.signal;
  load('takePreparedDestination', context)(route, 'test');
  assert.equal(signal.aborted, false, 'Ownership transfer must preserve in-flight work');
  load('disposePreparedWarpSystem', context)();
  assert.equal(signal.aborted, true);assert.equal(context.warpCompile.signal.aborted, false);
}
console.log('PASS: production destination/world/water functions restore synchronously on success/submit throw/delayed reject; later frames retain state; expired ship preparation does not retry forever.');
