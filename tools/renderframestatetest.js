import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RenderFrameState } from '../src/render-frame-state.js';
import { CelestialClock } from '../src/astronomy.js';
import { surfaceCloudUniforms, bindSurfaceClouds } from '../src/cloud/surface-clouds.js';

const camera = new THREE.PerspectiveCamera(65, 1.6, .12, 1.2e11);
camera.position.set(3, 2, -4);
const frame = new RenderFrameState(), context = {}, medium = {};
const body = { posUniv: new THREE.Vector3(1e12, -2e12, 3e12),
  frameOrientation: new THREE.Quaternion(), weatherField: medium };
const origin = body.posUniv.clone().add(new THREE.Vector3(0, 6000100, 0));
const begin = (options = {}) => frame.begin(camera, origin, { context, body, timeEpoch: 0, ...options });
assert.equal(begin(), false);assert.equal(frame.mapBody(), false);
assert.throws(() => begin(), /already pending/);
frame.commit();
const firstOrigin = frame.previous.origin.clone(), firstMatrix = frame.previous.viewProjection.clone();
origin.x += 20;camera.rotation.y = .1;
assert.equal(begin(), true);assert.equal(frame.mapBody(), true);
assert.deepEqual(frame.translation.toArray(), [20, 0, 0]);
assert.deepEqual(frame.rotation.elements, new THREE.Matrix3().elements);
assert.deepEqual(frame.previous.origin.toArray(), firstOrigin.toArray());
frame.abort();
assert.equal(frame.sequence, 1);assert.equal(frame.valid, false);
assert.ok(frame.previous.viewProjection.equals(firstMatrix), 'A failed frame must retain the last successful matrices');
assert.equal(begin(), false);frame.commit();

for (const [name, options, mutate, undo] of [
  ['context', { context: {} }, () => {}, () => {}],
  ['time', { timeEpoch: 1 }, () => {}, () => {}],
  ['depth-encoding', {}, () => { camera.far *= 2;camera.updateProjectionMatrix(); }, () => { camera.far /= 2;camera.updateProjectionMatrix(); }],
]) {
  begin();frame.commit();mutate();
  assert.equal(begin(options), false);assert.equal(frame.reason, name);
  frame.commit();undo();begin();frame.commit();
}
camera.fov = 70;camera.updateProjectionMatrix();
assert.equal(begin(), true, 'A continuous FOV change uses the two projections rather than discarding all history');frame.commit();
begin();frame.invalidate('private-prewarm');
assert.equal(frame.commit(), false);assert.equal(frame.valid, false);
begin();frame.commit();body.weatherField = {};
assert.equal(begin(), true);assert.equal(frame.mapBody(), false, 'Changed medium cannot reuse the old cloud history');
frame.commit();assert.equal(begin(), true);assert.equal(frame.mapBody(), true);frame.commit();

const weatherOwner={};
body.cloudWeatherPublication={owner:weatherOwner,first:1,second:2};
begin();assert.equal(frame.mapBody(),false,'First forecast publication retires the initial cloud history');frame.commit();
begin();assert.equal(frame.mapBody(),true);frame.commit();
body.cloudWeatherPublication={owner:weatherOwner,first:2,second:3};
begin();assert.equal(frame.mapBody(),true,'A normal rollover keeps its common endpoint');frame.commit();
body.cloudWeatherPublication={owner:weatherOwner,first:2,second:4};
begin();assert.equal(frame.mapBody(),false,'A same-bracket replacement invalidates correspondence');frame.commit();
body.cloudWeatherPublication={owner:{},first:4,second:5};
begin();assert.equal(frame.mapBody(),false,'A restarted stream cannot match recycled revision numbers');frame.commit();
delete body.cloudWeatherPublication;
begin();frame.commit();

// Independent local-point oracle: make each frame's render position directly
// from the known local point and its pose, without using the tested mapping.
let maximumError = 0, oldMaximumError = 0, cases = 0;
for (const radius of [6e6, 20e6]) for (const distance of [1e9, 1e12, 1e15]) for (let i = 0; i < 60; i++) {
  const local = new THREE.Vector3(Math.sin(i * .71), .8, Math.cos(i * .39)).normalize().multiplyScalar(radius + 1000);
  body.posUniv.set(distance, -distance * .5, distance * .25);
  body.frameOrientation.setFromEuler(new THREE.Euler(.1, .2 + i * .003, -.07));
  origin.copy(body.posUniv).add(new THREE.Vector3(130, radius + 50, -210));
  frame.invalidate();begin();frame.commit();
  const prevPoint = local.clone().applyQuaternion(body.frameOrientation)
    .add(body.posUniv.clone().sub(origin));
  const oldOrigin = origin.clone();
  body.posUniv.add(new THREE.Vector3(5000, -2600, 1900));
  body.frameOrientation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .013));
  origin.add(new THREE.Vector3(4990, -2603, 1904));
  const currentPoint = local.clone().applyQuaternion(body.frameOrientation)
    .add(body.posUniv.clone().sub(origin));
  begin();assert.equal(frame.mapBody(), true);
  const mapped = currentPoint.clone().applyMatrix3(frame.rotation).add(frame.translation);
  maximumError = Math.max(maximumError, mapped.distanceTo(prevPoint));
  oldMaximumError = Math.max(oldMaximumError, currentPoint.clone().add(origin.clone().sub(oldOrigin)).distanceTo(prevPoint));
  frame.commit();cases++;
}
assert.ok(maximumError < 2e-8, `Rigid mapping error ${maximumError}`);
assert.ok(oldMaximumError > 10000, 'The old origin-only control must detect body motion');

begin();frame.commit();begin();assert.equal(frame.stationaryBodyView(), true);frame.commit();
camera.position.x += 1e-8;begin();assert.equal(frame.stationaryBodyView(), false, 'Tiny real motion is not snapped to stationary');frame.commit();
camera.fov += 1e-8;camera.updateProjectionMatrix();begin();
assert.equal(frame.stationaryBodyView(), false, 'Projection changes keep real reprojection');frame.commit();

// Surface receivers can belong to an inactive body or a second camera. Their
// eye uniform must not alias/mutate that body's borrowed cloud field uniforms.
body.group = new THREE.Group();
body.group.position.copy(body.posUniv).sub(origin);body.group.quaternion.copy(body.frameOrientation);body.group.updateMatrixWorld(true);
body.volCloudMat = { uniforms: { uCameraLocal: { value: new THREE.Vector3(1, 2, 3) } } };
const surface = surfaceCloudUniforms(body), surface2 = surfaceCloudUniforms(body);
begin();const localEye = frame.localEye(body, new THREE.Vector3());
bindSurfaceClouds(surface, body, null, camera);
assert.ok(surface.cloud_uCameraLocal.value.distanceTo(localEye) < 1e-7);
assert.notEqual(surface.cloud_uCameraLocal.value, body.volCloudMat.uniforms.uCameraLocal.value);
const surfaceEye = surface.cloud_uCameraLocal.value.clone();
camera.position.x += 20;camera.updateMatrixWorld(true);bindSurfaceClouds(surface2, body, null, camera);
assert.ok(surface2.cloud_uCameraLocal.value.distanceTo(surfaceEye) > 19);
assert.ok(surface.cloud_uCameraLocal.value.equals(surfaceEye));
assert.deepEqual(body.volCloudMat.uniforms.uCameraLocal.value.toArray(), [1, 2, 3]);frame.commit();

const clock = new CelestialClock('frame-state-control', { persist: false, initialHours: 2 });
clock.update(.1);clock.update(.1, false);assert.equal(clock.epoch, 0);
clock.set(clock.hours);assert.equal(clock.epoch, 1);
clock.advance(-2);assert.equal(clock.epoch, 2);

const rigid = new RenderFrameState();
const scene = new THREE.Scene();
const carrier = new THREE.Group();
const hull = new THREE.Group();
scene.add(carrier);carrier.add(hull);
carrier.position.set(4, 6, -80);
hull.position.set(1, -.5, 2);
const worldPass = {}, foregroundPass = {}, rigidContext = {};
const tracked = new Map([[hull, worldPass]]);
const currentClip = new THREE.Matrix4(), previousClip = new THREE.Matrix4();
const hullPoint = new THREE.Vector3(.3, -.9, 1.2);
const rigidCamera = new THREE.PerspectiveCamera(60, 1.6, .12, 1.2e11);
const rigidOrigin = new THREE.Vector3(1e15, -1e15, 1e15);
const startRigid = (objects = tracked, context = rigidContext) => {
  rigid.begin(rigidCamera, rigidOrigin, { context });
  if (objects) rigid.captureRigidObjects(objects, scene);
  return rigid.rigidProjection(hull, currentClip, previousClip);
};
const screenPoint = () => hull.localToWorld(hullPoint.clone()).project(rigidCamera);
assert.equal(startRigid(), false);
const initialHullScreen = screenPoint();
rigid.commit();
// Translate the floating origin while the parent, ship and camera also move.
const rebase = new THREE.Vector3(12, -8, 16);
rigidOrigin.add(rebase);carrier.position.sub(rebase);rigidCamera.position.sub(rebase);
carrier.rotateY(.11);hull.position.x += 6;hull.rotateZ(.2);rigidCamera.rotateY(-.04);
assert.equal(startRigid(), true);
const movedHullScreen = screenPoint();
assert.ok(hullPoint.clone().applyMatrix4(currentClip).distanceTo(movedHullScreen) < 1e-12);
assert.ok(hullPoint.clone().applyMatrix4(previousClip).distanceTo(initialHullScreen) < 1e-12);
assert.ok(movedHullScreen.distanceTo(initialHullScreen) > .01);
rigid.commit();
for (const [hide, show] of [
  [() => carrier.visible = false, () => carrier.visible = true],
  [() => scene.remove(carrier), () => scene.add(carrier)],
]) {
  hide();assert.equal(startRigid(), false);rigid.commit();
  show();assert.equal(startRigid(), false);rigid.commit();
  assert.equal(startRigid(), true);rigid.commit();
}
tracked.set(hull, foregroundPass);
assert.equal(startRigid(), false);rigid.commit();
assert.equal(startRigid(), true);rigid.commit();
assert.equal(startRigid(null), false);rigid.commit();
assert.equal(startRigid(), false);rigid.commit();
assert.equal(startRigid(), true);rigid.abort();
assert.equal(startRigid(), false);rigid.commit();
assert.equal(startRigid(tracked, {}), false);rigid.commit();
assert.equal(rigid.rigidProjection(hull, currentClip, previousClip), false);
console.log(JSON.stringify({ passed: true, cases, maximumError, oldMaximumError,
  controls: 'Committed snapshots, failed/mid-frame invalidation, context/time/projection, medium identity, 360 independent body mappings, rigid object origin/visibility/pass ownership, clock continuity' }));
