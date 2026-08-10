// Temporal accumulation invariants (phase 2).
//
// docs/cloud-atmosphere-rewrite.md §4 phase 2. The phase gate is "history
// invalidates within 1 frame of a camera jump and produces no ghosting", plus
// the seamtest 0 px static-camera regression that the previous round failed.
// Both are properties of the POLICY, not of the shader, which is why
// src/cloud/temporal-policy.js is a GPU-free module: everything below runs the
// accumulator frame by frame in Node and checks it against ground truth from a
// real THREE.PerspectiveCamera.
//
// Each assertion pins a specific way this can silently look fine:
//   - reprojection that is quietly an identity transform
//   - history discarded on every camera rotation, i.e. exactly when it is needed
//   - a rejected pixel resolving to zero instead of to the live sample
//   - jitter enabled before the combiner exists (the 75-138 px shimmer)

import assert from 'node:assert/strict';
import { Matrix4, PerspectiveCamera, Vector3, Vector4 } from 'three';
import {
  DEPTH_EDGE_FLOOR_METERS, GUIDED_WEIGHT_EPSILON, INVALIDATION,
  createTemporalPolicy, guidedTapWeight, guidedUpsampleUsable, haltonJitter,
  historyUsable,
} from '../src/cloud/temporal-policy.js';

const RADIUS = 6.4e6;
const KEY = 'homeworld';

function poseCamera(offset, target, fov = 60) {
  const camera = new PerspectiveCamera(fov, 16 / 9, 1, 1e9);
  camera.position.copy(offset);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function viewProjection(camera) {
  return new Matrix4().multiplyMatrices(
    camera.projectionMatrix, camera.matrixWorldInverse);
}

// Ground truth: where does a camera-relative point land on screen? Vector4, not
// Vector3 — Vector3.applyMatrix4 performs the perspective divide internally and
// discards w, which would hide a sign error behind a wrapped-around uv.
function projectTo(camera, point) {
  const clip = new Vector4(point.x, point.y, point.z, 1)
    .applyMatrix4(viewProjection(camera));
  return { u: clip.x / clip.w * 0.5 + 0.5, v: clip.y / clip.w * 0.5 + 0.5 };
}

// --- frame lifecycle ---------------------------------------------------------
{
  const policy = createTemporalPolicy();
  const nav = new Vector3(1e7, 2e7, -5e6);
  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));

  const first = policy.update({
    viewProjection: viewProjection(camera), nav, volumeRadius: RADIUS, volumeKey: KEY,
  });
  assert.equal(first.historyValid, false, 'frame 1 has nothing to reproject from');
  assert.equal(first.reason, INVALIDATION.FIRST_FRAME);
  assert.equal(first.alpha, 1,
    'an invalidated frame must weight the CURRENT sample fully; anything less '
    + 'blends toward undefined history, which is the black/holey atmosphere');
  assert.equal(first.directSample, true,
    'frame 1 must bypass the guided reconstruction');

  const second = policy.update({
    viewProjection: viewProjection(camera), nav, volumeRadius: RADIUS, volumeKey: KEY,
  });
  assert.equal(second.historyValid, true, 'frame 2 must reuse frame 1');
  assert.equal(second.reason, INVALIDATION.NONE);
  assert.equal(second.alpha, 0.5, 'running mean: the second sample weighs 1/2');
  assert.equal(second.directSample, false);
}

// --- convergence: a true running mean, capped by motion state ----------------
//
// The falling alpha is the whole argument for seamtest's 0 px gate. An
// exponential blur with a fixed alpha never settles, so a parked camera keeps
// producing per-frame deltas forever.
{
  const policy = createTemporalPolicy({ maxMovingFrames: 8, maxStaticFrames: 64 });
  const nav = new Vector3(0, 0, 0);
  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const step = (moving) => policy.update({
    viewProjection: viewProjection(camera), nav, volumeRadius: RADIUS,
    volumeKey: KEY, moving,
  });

  step(false);
  for (let frame = 2; frame <= 64; frame++) {
    const result = step(false);
    assert.equal(result.alpha, 1 / frame,
      `parked frame ${frame} must weight the current sample 1/${frame}`);
  }
  assert.equal(step(false).alpha, 1 / 64, 'parked alpha floors at 1/maxStaticFrames');

  const moving = step(true);
  assert.equal(moving.alpha, 1 / 8,
    'a moving camera must floor at 1/maxMovingFrames so disocclusion clears; '
    + 'a 64-frame memory would smear the limb across the manoeuvre');
}

// --- what must NOT invalidate ------------------------------------------------
//
// The failed prototype's CPU policy deliberately preserves history for ordinary
// camera/FOV motion. These assertions cover that policy choice only; they do
// not prove per-pixel volume correspondence. The wide-angle hardware sweep
// failed, and `test:atmosphere-motion` is now only a determinism/resource gate.
{
  const policy = createTemporalPolicy();
  const nav = new Vector3(1e7, 0, 0);
  const forward = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  policy.update({
    viewProjection: viewProjection(forward), nav, volumeRadius: RADIUS, volumeKey: KEY,
  });

  const turned = poseCamera(new Vector3(0, 0, 0), new Vector3(1, 0.4, 0.2));
  assert.equal(policy.update({
    viewProjection: viewProjection(turned), nav, volumeRadius: RADIUS, volumeKey: KEY,
  }).reason, INVALIDATION.NONE, 'a pure rotation must keep history');

  const zoomed = poseCamera(new Vector3(0, 0, 0), new Vector3(1, 0.4, 0.2), 20);
  assert.equal(policy.update({
    viewProjection: viewProjection(zoomed), nav, volumeRadius: RADIUS, volumeKey: KEY,
  }).reason, INVALIDATION.NONE, 'a field-of-view change must keep history');

  // Ordinary flight: fast, but tiny against the shell it is orbiting.
  const cruised = nav.clone().add(new Vector3(4000, 0, 0));
  assert.equal(policy.update({
    viewProjection: viewProjection(zoomed), nav: cruised,
    volumeRadius: RADIUS, volumeKey: KEY,
  }).reason, INVALIDATION.NONE,
  '4 km against a 6400 km shell is flight, not a jump');
}

// --- what must invalidate, and within exactly one frame ----------------------
{
  const policy = createTemporalPolicy({ jumpFraction: 0.05 });
  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const vp = viewProjection(camera);
  let nav = new Vector3(1e7, 0, 0);
  const step = (overrides = {}) => policy.update({
    viewProjection: vp, nav, volumeRadius: RADIUS, volumeKey: KEY, ...overrides,
  });

  step(); step();
  assert.equal(policy.historyValid, true, 'settled before the jump');

  nav = nav.clone().add(new Vector3(RADIUS * 0.5, 0, 0));
  const jumped = step();
  assert.equal(jumped.reason, INVALIDATION.CAMERA_JUMP,
    'a warp/rift arrival must be detected as a jump');
  assert.equal(jumped.historyValid, false);
  assert.equal(jumped.frames, 1, 'the frame counter must restart, not continue');
  assert.equal(jumped.alpha, 1,
    'no ghosting: the jump frame is the live sample, with zero history mixed in');

  // "Within 1 frame" cuts both ways — it must also RECOVER immediately, or a
  // jump would cost the accumulation for as long as the camera kept coasting.
  const after = step();
  assert.equal(after.reason, INVALIDATION.NONE, 'history must resume the very next frame');
  assert.equal(after.alpha, 0.5);
}

{
  const policy = createTemporalPolicy();
  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const vp = viewProjection(camera);
  const nav = new Vector3(0, 0, 0);
  const step = (overrides = {}) => policy.update({
    viewProjection: vp, nav, volumeRadius: RADIUS, volumeKey: KEY, ...overrides,
  });

  step(); step();
  const switched = step({ volumeKey: 'other-planet' });
  assert.equal(switched.reason, INVALIDATION.VOLUME_CHANGED,
    'another body\'s atmosphere is wrong data, not stale data');
  step({ volumeKey: 'other-planet' });

  const resized = step({ volumeKey: 'other-planet', resized: true });
  assert.equal(resized.reason, INVALIDATION.RESIZE);
  assert.equal(resized.directSample, true,
    'the resize frame must bypass the guided taps: they would read a target '
    + 'that was just rebuilt at another size, blinking the atmosphere out');
  assert.equal(step({ volumeKey: 'other-planet' }).directSample, false,
    'direct sampling lasts exactly one frame');
}

// Explicit invalidation is consumed once, not sticky. A latched flag would pin
// alpha at 1 forever and disable accumulation without any metric noticing.
{
  const policy = createTemporalPolicy();
  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const vp = viewProjection(camera);
  const nav = new Vector3(0, 0, 0);
  const step = () => policy.update({
    viewProjection: vp, nav, volumeRadius: RADIUS, volumeKey: KEY,
  });
  step(); step();
  policy.invalidate(INVALIDATION.EXPLICIT);
  assert.equal(step().reason, INVALIDATION.EXPLICIT);
  assert.equal(step().reason, INVALIDATION.NONE, 'invalidation must not latch');
}

// Every invalidated frame, whatever the cause, must resolve to the live sample.
{
  const policy = createTemporalPolicy();
  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const vp = viewProjection(camera);
  let nav = new Vector3(0, 0, 0);
  const seen = new Set();
  for (let frame = 0; frame < 40; frame++) {
    if (frame === 7) policy.invalidate();
    if (frame === 15) nav = nav.clone().add(new Vector3(RADIUS, 0, 0));
    const result = policy.update({
      viewProjection: vp, nav, volumeRadius: RADIUS,
      volumeKey: frame === 23 ? 'elsewhere' : KEY,
      resized: frame === 30,
    });
    seen.add(result.reason);
    if (!result.historyValid) {
      assert.equal(result.alpha, 1,
        `frame ${frame} (${result.reason}) must fall back to the current sample`);
    }
    assert.ok(result.alpha > 0 && result.alpha <= 1,
      `alpha out of range on frame ${frame}: ${result.alpha}`);
  }
  for (const reason of [INVALIDATION.FIRST_FRAME, INVALIDATION.EXPLICIT,
    INVALIDATION.CAMERA_JUMP, INVALIDATION.VOLUME_CHANGED, INVALIDATION.RESIZE]) {
    assert.ok(seen.has(reason), `the sweep never exercised ${reason}`);
  }
}

// --- reprojection against ground truth ---------------------------------------
//
// The failure this catches: reprojecting through the CURRENT frame's camera
// instead of the previous one. That is an identity transform, so history lines
// up perfectly, nothing is ever rejected, every metric reads healthy — and no
// accumulation actually happens because each frame just re-reads itself.
{
  const policy = createTemporalPolicy();
  const navA = new Vector3(9.1e6, -3.4e6, 2.2e6);
  const navB = navA.clone().add(new Vector3(310, -124, 87));

  const camA = poseCamera(new Vector3(8, 3, -2), new Vector3(0, 0, -4e6));
  const camB = poseCamera(new Vector3(11, 1, -5), new Vector3(1e5, 2e4, -4e6));

  policy.update({
    viewProjection: viewProjection(camA), nav: navA,
    volumeRadius: RADIUS, volumeKey: KEY,
  });
  const second = policy.update({
    viewProjection: viewProjection(camB), nav: navB,
    volumeRadius: RADIUS, volumeKey: KEY,
  });
  assert.equal(second.historyValid, true, 'a 330 m step is not a jump');

  // A point fixed in the world, expressed in each frame's camera-relative space.
  const world = navA.clone().add(new Vector3(4.2e4, -1.1e4, -3.6e6));
  const inA = world.clone().sub(navA);
  const inB = world.clone().sub(navB);

  const expected = projectTo(camA, inA);
  const actual = policy.reproject(inB);
  assert.ok(actual.inside, 'the test point must land on screen in the previous frame');
  assert.ok(Math.abs(actual.u - expected.u) < 1e-6
    && Math.abs(actual.v - expected.v) < 1e-6,
    'reprojection must land where the point actually appeared last frame: '
    + `expected (${expected.u.toFixed(9)}, ${expected.v.toFixed(9)}), `
    + `got (${actual.u.toFixed(9)}, ${actual.v.toFixed(9)})`);

  // And it must not be an identity: if it were, this would equal the CURRENT
  // projection instead, and every check above would still pass.
  const current = projectTo(camB, inB);
  assert.ok(Math.hypot(current.u - actual.u, current.v - actual.v) > 1e-3,
    'reprojection collapsed to the current frame — history is not being '
    + 'transformed at all');

  // Behind the camera must report outside rather than a wrapped-around uv.
  const behind = policy.reproject(new Vector3(0, 0, 4e6));
  assert.equal(behind.inside, false, 'a point behind the previous camera is not reusable');
}

// Camera-relative, not absolute. In fp32 the numbers in [2^23, 2^24) — which is
// where a 9000 km orbital offset lands — have a 1 metre ulp, so reprojecting the
// absolute world position quantises history to whole metres and smears it along
// the limb. The offset-plus-nav-delta form keeps every term near magnitudes fp32
// still resolves. This asserts the two forms genuinely differ, so the choice in
// TemporalPolicy.reproject() (and in the TSL graph that mirrors it) is not
// cosmetic.
{
  const navA = new Vector3(9123456.789, -3411022.317, 2200311.653);
  const inB = new Vector3(42137.31, -11004.87, -3600291.44);
  const absolute = new Float32Array([
    navA.x + inB.x, navA.y + inB.y, navA.z + inB.z]);
  const roundTrip = new Vector3(
    absolute[0] - navA.x, absolute[1] - navA.y, absolute[2] - navA.z);
  const error = roundTrip.distanceTo(inB);
  assert.ok(error > 0.05,
    'fp32 world-space round trip should lose > 5 cm at planet range, otherwise '
    + `the camera-relative argument would not hold (lost ${error.toFixed(4)} m)`);
}

// --- depth-guided upsample rejection ----------------------------------------
{
  // Ownership classes never mix, at any distance.
  assert.equal(guidedTapWeight(100, 100, true, false), 0,
    'an opaque centre must not borrow a background tap');
  assert.equal(guidedTapWeight(100, 100, false, true), 0,
    'a sky pixel must not borrow an opaque tap');
  assert.equal(guidedTapWeight(0, 0, false, false), 1,
    'two background rays integrated the same atmosphere');

  assert.equal(guidedTapWeight(500, 500, true, true), 1,
    'coplanar taps must be fully accepted');
  assert.ok(guidedTapWeight(500, 5000, true, true) < 0.01,
    'a 10x depth jump is a silhouette, not a neighbour');

  // Scale invariance: the same RELATIVE step must weigh the same at 100 km and
  // at 900 km. A fixed metre epsilon fails one end or the other, and that is
  // what drew halos along distant silhouettes.
  const mid = guidedTapWeight(100000, 100000 * 1.02, true, true);
  const far = guidedTapWeight(900000, 900000 * 1.02, true, true);
  assert.ok(Math.abs(mid - far) < 0.01,
    `the depth threshold must be scale-relative: ${mid.toFixed(4)} at 100 km vs `
    + `${far.toFixed(4)} at 900 km`);

  // Up close the metre floor deliberately dominates, making the same relative
  // step MORE forgiving. That is its job: at cockpit range a 2% depth step is a
  // few centimetres, well inside log-depth quantisation, and rejecting it would
  // strand the reconstruction on the co-located texel across flat surfaces.
  const near = guidedTapWeight(1000, 1000 * 1.02, true, true);
  assert.ok(near > far,
    `the metre floor must make short range more forgiving, not less `
    + `(${near.toFixed(4)} at 1 km vs ${far.toFixed(4)} at 900 km)`);

  // The metre floor keeps log-depth quantisation from rejecting coplanar taps.
  assert.ok(guidedTapWeight(2, 2 + DEPTH_EDGE_FLOOR_METERS * 0.1, true, true) > 0.98,
    'sub-metre quantisation must not reject a coplanar neighbour up close');

  // All taps rejected: the reconstruction is unusable and the caller must fall
  // back to the co-located texel. Returning zero here is the hole that read as
  // "the atmosphere flickers whenever the view moves".
  assert.equal(guidedUpsampleUsable(0), false);
  assert.equal(guidedUpsampleUsable(GUIDED_WEIGHT_EPSILON * 0.5), false);
  assert.equal(guidedUpsampleUsable(1), true);
  assert.equal(guidedUpsampleUsable(Number.NaN), false,
    'a NaN weight sum must reject rather than propagate into the composite');
}

// --- history content rejection -----------------------------------------------
//
// The residual seamtest phase 1 actually caught: with only a coverage test, a
// deep running mean (n ~ 20, alpha ~ 0.05) keeps dragging content that has
// genuinely changed, and on a PARKED camera that reads as per-frame delta.
// Measured 10 px at factor 2.0 against a 0 px baseline; pinning history off
// drove it to 0, which is what identified the blend rather than the
// reprojection as the source.
{
  const rgba = (r, g, b, a) => ({ r, g, b, a });

  assert.equal(historyUsable(rgba(0.4, 0.5, 0.6, 0.8), rgba(0.4, 0.5, 0.6, 0.8)), true,
    'identical samples must accumulate — this is the no-jitter no-op case');

  // Sampling noise is what the accumulator exists to average. It must survive.
  assert.equal(historyUsable(
    rgba(0.40, 0.50, 0.60, 0.80),
    rgba(0.41, 0.49, 0.61, 0.82)), true,
  'sub-threshold noise must be averaged, not rejected; rejecting it would '
    + 'make the accumulator a passthrough and waste the whole phase');

  // A cloud edge crossing the pixel: coverage moves.
  assert.equal(historyUsable(
    rgba(0.4, 0.5, 0.6, 0.10),
    rgba(0.4, 0.5, 0.6, 0.80)), false,
  'a coverage jump is a different ray, not a noisier estimate of this one');

  // Same opacity, different radiance — a shadow sweeping a deck, or terrain
  // resolving under a thin layer. Coverage alone cannot see this.
  assert.equal(historyUsable(
    rgba(0.20, 0.22, 0.25, 0.80),
    rgba(0.70, 0.72, 0.75, 0.80)), false,
  'a radiance change at constant coverage must reject: this is exactly the '
    + 'case a coverage-only test misses, and it is what left 10 px of '
    + 'per-frame delta on a parked camera');

  assert.equal(historyUsable(
    rgba(Number.NaN, 0.5, 0.6, 0.8), rgba(0.4, 0.5, 0.6, 0.8)), false,
  'a NaN in history must reject rather than propagate into the composite');
  assert.equal(historyUsable(null, rgba(0.4, 0.5, 0.6, 0.8)), false);
}

// --- jitter gating and the static-camera residual ----------------------------
{
  const off = createTemporalPolicy();
  assert.equal(off.jitterEnabled, false,
    'jitter must be OFF by default. Enabling per-frame ray-start jitter before '
    + 'this combiner was verified is exactly what produced 75-138 px of shimmer '
    + 'on a parked camera last round');
  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const result = off.update({
    viewProjection: viewProjection(camera), nav: new Vector3(),
    volumeRadius: RADIUS, volumeKey: KEY,
  });
  assert.deepEqual(result.jitter, { x: 0, y: 0 },
    'a disabled accumulator must place every sample at the texel centre, so the '
    + 'volume march is bit-identical frame to frame');
  assert.equal(off.staticResidual(1), 0,
    'with no jitter there is no per-frame residual at all');
}

{
  // Low discrepancy, not randomness: successive indices must land far apart so
  // a short accumulation window still covers the texel. Random offsets clump;
  // a regular grid aliases against the cloud's own periodicity.
  const samples = Array.from({ length: 32 }, (unused, i) => haltonJitter(i));
  for (const sample of samples) {
    assert.ok(sample.x >= -0.5 && sample.x <= 0.5
      && sample.y >= -0.5 && sample.y <= 0.5,
      `jitter must stay inside the texel, got (${sample.x}, ${sample.y})`);
  }
  let minSeparation = Infinity;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      minSeparation = Math.min(minSeparation,
        Math.hypot(samples[i].x - samples[j].x, samples[i].y - samples[j].y));
    }
  }
  assert.ok(minSeparation > 0.02,
    `32 jitter samples must not collide inside a texel (closest pair ${minSeparation.toFixed(4)})`);
  // Balanced about the centre, or accumulation would converge to a biased ray.
  const meanX = samples.reduce((sum, s) => sum + s.x, 0) / samples.length;
  const meanY = samples.reduce((sum, s) => sum + s.y, 0) / samples.length;
  assert.ok(Math.abs(meanX) < 0.05 && Math.abs(meanY) < 0.05,
    `jitter must be centred, got mean (${meanX.toFixed(4)}, ${meanY.toFixed(4)})`);
}

{
  // The seamtest phase 1 argument, as arithmetic rather than as hope. seamtest
  // counts a pixel as changed when any channel moves by more than 8/255 between
  // two frames half a second apart. Once jitter is enabled in phase 3/4, the
  // per-frame delta on a parked camera is bounded by the jitter-induced radiance
  // spread times alpha, and alpha has fallen to 1/maxStaticFrames by then.
  const policy = createTemporalPolicy({ jitter: true, maxStaticFrames: 64 });
  const seamThreshold = 8 / 255;
  // Generous: the per-sample radiance spread of a cloud march under sub-pixel
  // jitter, as a fraction of full scale.
  const worstSpread = 0.5;
  const residual = policy.staticResidual(worstSpread);
  assert.ok(residual < seamThreshold,
    `a parked camera's settled per-frame delta (${residual.toFixed(5)}) must sit `
    + `under seamtest's ${seamThreshold.toFixed(5)} threshold, or phase 3 cannot `
    + 'enable jitter without reintroducing the shimmer');

  const camera = poseCamera(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const jittered = policy.update({
    viewProjection: viewProjection(camera), nav: new Vector3(),
    volumeRadius: RADIUS, volumeKey: KEY,
  });
  assert.ok(jittered.jitter.x !== 0 || jittered.jitter.y !== 0,
    'an enabled accumulator must actually offset the sample');
}

console.log('PASS: failed temporal prototype CPU policy only — invalidation within '
  + '1 frame on jump/switch/resize, isolated point projection matches ground '
  + 'truth to 1e-6, rejection falls back to the live sample, and jitter defaults '
  + 'off. This does not validate continuous-motion correspondence or the '
  + 'production resolve, which remain disabled until phase 7.');
