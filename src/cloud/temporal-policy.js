// FAILED phase-2 temporal prototype policy. Pure CPU, no renderer, no TSL.
// Production keeps the corresponding resolve disabled. This module remains
// only as tested bookkeeping that phase 7 may selectively reuse; its passing
// Node tests are not evidence that shell reprojection works in real motion.
//
// docs/cloud-atmosphere-rewrite.md §4 phase 2.
//
// WHY THIS IS A SEPARATE FILE FROM temporal-resolve.js
// ----------------------------------------------------
// The rewrite plan names one file, `src/cloud/temporal-resolve.js`. That file
// has to import `three/webgpu` and `three/tsl` to build the resolve graph, and
// once it does, nothing in it can be imported by a Node test. The part of
// temporal accumulation that is actually easy to get wrong is not the shader —
// it is the bookkeeping: when history is valid, how fast it converges, and what
// counts as a discontinuity. The Node contract verifies only those local rules
// (for example, "history invalidates within 1 frame of a camera jump"), so it
// lives here in a module a test can drive without a GPU. `temporal-resolve.js`
// re-exports this module's surface, but production callers must leave it off.
//
// ORIGINAL INVALIDATION MODEL — RETAINED FOR PHASE-7 REVIEW
// ---------------------------------------------------------
// The prototype assumed that pure camera/FOV motion left samples reusable via
// the previous view-projection matrix. That mathematical premise did not make
// this shell implementation correct: continuous +/-27.5 degree hardware sweeps
// exposed correspondence/rejection errors and visible history pollution.
// `test:atmosphere-motion` only proves repeated-pose determinism and resource
// stability; it is not a reprojection or motion-quality gate.
//
// So history is discarded only when correspondence genuinely does not exist:
//
//   FIRST_FRAME        nothing to reproject from.
//   VOLUME_CHANGED     the active body changed. The previous frame's pixels are
//                      a different planet's atmosphere; reprojecting them is
//                      not stale data, it is wrong data.
//   RESIZE             the history targets were rebuilt. Their contents are
//                      undefined and their texel grid no longer matches.
//   CAMERA_JUMP        warp arrival, rift crossing, teleport. Not "the camera
//                      moved fast" — the camera-relative origin moved so far
//                      that the fp32 reprojection of a planet-scale offset has
//                      lost the precision to land on the right texel. This is a
//                      precision criterion, not a speed criterion, which is why
//                      it is expressed as a fraction of the volume radius
//                      rather than as metres per frame.
//   EXPLICIT           caller-driven (planet switch bookkeeping, hero handoff,
//                      offscreen bootstrap draws that must not poison history).
//
// CONVERGENCE, AND THE 0 px STATIC-CAMERA GATE
// ---------------------------------------------
// `alpha` is the weight given to the CURRENT frame: result = mix(history,
// current, alpha). It is 1/n for the first n frames, so the accumulator is a
// true running mean rather than an exponential blur that never settles. The cap
// differs by motion state on purpose:
//
//   moving   -> alpha floors at 1/maxMovingFrames. A running mean that never
//               forgets would smear across a moving camera; 1/8 keeps roughly
//               an 8-frame memory, short enough that disocclusion clears.
//   parked   -> alpha keeps falling to 1/maxStaticFrames. This is what makes
//               `npm run seamtest` phase 1 pass with temporal jitter enabled.
//               Two screenshots half a second apart differ by at most the
//               jitter-induced radiance spread times alpha; with the defaults
//               that bound is checked arithmetically by
//               `tools/temporalresolvetest.js` against seamtest's own 8/255
//               per-channel threshold. Without the falling alpha, per-frame
//               jitter is the 75-138 px shimmer the previous round measured.

import { Matrix4, Vector3, Vector4 } from 'three';

export const TEMPORAL_POLICY_VERSION = 1;

export const INVALIDATION = Object.freeze({
  NONE: 'none',
  FIRST_FRAME: 'first-frame',
  EXPLICIT: 'explicit',
  RESIZE: 'resize',
  CAMERA_JUMP: 'camera-jump',
  VOLUME_CHANGED: 'volume-changed',
});

// Shared with the TSL graph in temporal-resolve.js. Exported so the shader and
// the CPU reference below cannot drift apart on the numbers; the formula shape
// is short enough to review side by side, but a silently retuned constant in
// one of two copies is the classic way a rejection policy stops agreeing with
// itself.
export const DEPTH_EDGE_FLOOR_METERS = 2;
export const DEPTH_EDGE_SLOPE = 0.0125;
export const GUIDED_WEIGHT_EPSILON = 0.0025;
// Coverage disagreement above which reprojected history is treated as a
// different ray rather than a noisier estimate of the same one. Cloud alpha is
// the cheapest available proxy for "is this the same participating medium",
// and an edge that just moved across this pixel changes it far more than
// sampling noise does.
export const HISTORY_ALPHA_REJECT = 0.28;
// Same idea applied to radiance rather than coverage. A 1/n running mean
// forgets stale content only as fast as 1/n, so once the accumulator is deep
// (n ~ 20+) a genuine change in what the pixel shows — terrain streaming in,
// weather advancing, a species popping — is dragged toward the old image for
// tens of frames. On a PARKED camera that is visible directly: seamtest phase 1
// measured 10 changed pixels at factor 2.0 against a 0 px baseline, and pinning
// history off drove it to 0, proving the blend and not the reprojection was the
// source. Rejecting history whose radiance disagrees with the live sample by
// more than this fraction bounds the lag to a single frame for real changes
// while leaving sampling noise — which is far smaller — free to average.
export const HISTORY_COLOR_REJECT = 0.12;

const _point = new Vector4();

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// Van der Corput radical inverse — the standard low-discrepancy sequence for
// sub-pixel sample placement. Successive indices land far apart, so a short
// accumulation window still covers the texel evenly; a random offset would
// clump and a regular grid would alias against the cloud's own periodicity.
function radicalInverse(index, base) {
  let result = 0;
  let denominator = 1;
  let i = index;
  while (i > 0) {
    denominator *= base;
    result += (i % base) / denominator;
    i = Math.floor(i / base);
  }
  return result;
}

export function haltonJitter(index) {
  return {
    x: radicalInverse(index + 1, 2) - 0.5,
    y: radicalInverse(index + 1, 3) - 0.5,
  };
}

// Per-tap weight for the depth-guided upsample. CPU authority; the TSL graph in
// temporal-resolve.js transcribes this using the constants above.
//
// The two depth classes are not interchangeable. A background ray (no opaque
// depth) integrated the whole atmosphere; an opaque-clipped ray stopped at
// terrain. Borrowing one for the other is what drew a blue halo along every
// silhouette at half resolution, so class disagreement rejects outright rather
// than being softened by the distance falloff.
export function guidedTapWeight(
  centerViewDepth, tapViewDepth, centerHasDepth, tapHasDepth,
) {
  if (centerHasDepth !== tapHasDepth) return 0;
  if (!centerHasDepth) return 1;
  // Relative, not absolute: the same threshold has to behave from cockpit
  // metres out to a 900 km planet, and log-depth quantisation at range would
  // reject coplanar neighbours under any fixed epsilon.
  const scale = Math.max(centerViewDepth, tapViewDepth) * DEPTH_EDGE_SLOPE
    + DEPTH_EDGE_FLOOR_METERS;
  const delta = Math.abs(centerViewDepth - tapViewDepth) / scale;
  return Math.exp(-delta * delta);
}

// Whether the guided reconstruction is usable at all, given the four spatial
// weights already multiplied by their tap weights.
//
// Every tap can be rejected: a sky pixel whose four half-resolution neighbours
// all landed on the planet has no same-class tap anywhere. Returning zero there
// erased the atmosphere for exactly those pixels, and which pixels qualify
// changes every frame as the camera turns — that is the reported "atmosphere
// flickers whenever the view moves". The co-located texel is at worst one
// half-resolution sample of this very ray, which is strictly better than a hole.
export function guidedUpsampleUsable(weightSum) {
  return finite(weightSum, 0) > GUIDED_WEIGHT_EPSILON;
}

// Is reprojected history a noisier estimate of the SAME thing the live sample
// sees, or different content? The CPU reference for the two rejection tests the
// TSL graph applies per pixel; `rgba` values are linear radiance and coverage.
//
// Without the colour half, a deep running mean (n ~ 20+, alpha ~ 0.05) drags
// genuinely changed content for tens of frames, which seamtest phase 1 catches
// directly on a parked camera. See HISTORY_COLOR_REJECT.
export function historyUsable(history, current) {
  if (!history || !current) return false;
  const coverage = Math.abs(finite(history.a, 0) - finite(current.a, 0));
  if (!(coverage < HISTORY_ALPHA_REJECT)) return false;
  const color = Math.max(
    Math.abs(finite(history.r, 0) - finite(current.r, 0)),
    Math.abs(finite(history.g, 0) - finite(current.g, 0)),
    Math.abs(finite(history.b, 0) - finite(current.b, 0)));
  return color < HISTORY_COLOR_REJECT;
}

export class TemporalPolicy {
  constructor({
    maxMovingFrames = 8,
    maxStaticFrames = 64,
    jumpFraction = 0.05,
    jitter = false,
  } = {}) {
    this.maxMovingFrames = Math.max(1, Math.round(maxMovingFrames));
    this.maxStaticFrames = Math.max(this.maxMovingFrames, Math.round(maxStaticFrames));
    this.jumpFraction = Math.max(1e-6, jumpFraction);
    // Opt-in in the prototype API, but production must leave this off. Enabling
    // temporal jitter without a phase-7 unified combiner repeats the mistake
    // that produced 75-138 changed pixels on a parked camera; the current local
    // shell reprojection also failed continuous wide-angle motion.
    this.jitterEnabled = !!jitter;

    this.frames = 0;
    this.historyValid = false;
    this.reason = INVALIDATION.FIRST_FRAME;
    this.alpha = 1;
    this.directSample = true;
    this.jitter = { x: 0, y: 0 };

    this.hasPrevious = false;
    this.prevViewProjection = new Matrix4();
    this.prevNav = new Vector3();
    this.navDelta = new Vector3();
    this.activeVolumeKey = null;

    // Last frame's pose, held back until the START of the next update. It is
    // promoted into prevViewProjection/prevNav there, not at the end of the
    // frame that produced it: the resolve pass runs AFTER update() within the
    // same frame, so latching at the end would make every frame reproject into
    // its own camera. That is an identity transform — reprojection silently off
    // — while the frame counter, alpha and every invalidation metric still read
    // perfectly healthy. Asserted by tools/temporalresolvetest.js against a
    // ground-truth THREE.PerspectiveCamera projection at the previous pose.
    this._staged = false;
    this._stagedViewProjection = new Matrix4();
    this._stagedNav = new Vector3();

    this._pending = null;
    this._invalidationCount = 0;
  }

  // Force history invalidation. Called on warp, rift handoff, planet switch,
  // volume-scale resize, or any offscreen bootstrap draw whose pixels must not
  // become the next frame's history.
  invalidate(reason = INVALIDATION.EXPLICIT) {
    this._pending = reason;
    return this;
  }

  get invalidationCount() {
    return this._invalidationCount;
  }

  // Advance one frame. Everything the resolve pass needs is returned; nothing
  // is read back out of the renderer.
  //
  //   viewProjection  current camera-relative view-projection matrix
  //   nav             world-space origin of the camera-relative frame
  //   volumeRadius    active shell radius, the scale the jump test is relative to
  //   volumeKey       identity of the active body (null when no volume is active)
  //   moving          true while the camera or the world is in motion
  //   resized         true on the frame the history targets were rebuilt
  update({
    viewProjection = null,
    nav = null,
    volumeRadius = 0,
    volumeKey = null,
    moving = false,
    resized = false,
  } = {}) {
    // Promote the pose staged by the previous call. After this line
    // prevViewProjection/prevNav describe frame N-1, which is exactly what this
    // frame's resolve pass has to reproject into.
    if (this._staged) {
      this.prevViewProjection.copy(this._stagedViewProjection);
      this.prevNav.copy(this._stagedNav);
      this.hasPrevious = true;
    }

    if (nav) this.navDelta.copy(nav).sub(this.prevNav);
    else this.navDelta.set(0, 0, 0);

    let reason = INVALIDATION.NONE;
    if (!this.hasPrevious) {
      reason = INVALIDATION.FIRST_FRAME;
    } else if (volumeKey !== this.activeVolumeKey) {
      reason = INVALIDATION.VOLUME_CHANGED;
    } else if (this._pending) {
      reason = this._pending;
    } else if (resized) {
      reason = INVALIDATION.RESIZE;
    } else if (this.navDelta.length()
      > Math.max(1, finite(volumeRadius, 0)) * this.jumpFraction) {
      reason = INVALIDATION.CAMERA_JUMP;
    }
    this._pending = null;
    this.activeVolumeKey = volumeKey;

    if (reason === INVALIDATION.NONE) {
      this.historyValid = true;
      this.frames += 1;
    } else {
      this.historyValid = false;
      this.frames = 1;
      this._invalidationCount += 1;
    }
    this.reason = reason;

    // alpha is the CURRENT frame's weight. 1 on an invalidated frame means the
    // result IS the current frame — a rejected history must fall back to the
    // live sample, never to zero.
    const cap = moving ? this.maxMovingFrames : this.maxStaticFrames;
    this.alpha = this.historyValid ? 1 / Math.min(this.frames, cap) : 1;
    // A resize frame must also bypass the depth-guided reconstruction: its taps
    // would be read against a target that was just rebuilt at another size.
    this.directSample = reason === INVALIDATION.RESIZE || reason === INVALIDATION.FIRST_FRAME;
    this.jitter = this.jitterEnabled
      ? haltonJitter(this.frames) : { x: 0, y: 0 };

    if (viewProjection && nav) {
      this._stagedViewProjection.copy(viewProjection);
      this._stagedNav.copy(nav);
      this._staged = true;
    } else {
      // No pose this frame means nothing to reproject into next frame either.
      this._staged = false;
      this.hasPrevious = false;
    }

    return {
      historyValid: this.historyValid,
      alpha: this.alpha,
      reason: this.reason,
      frames: this.frames,
      directSample: this.directSample,
      jitter: this.jitter,
    };
  }

  // Project a camera-relative point through the PREVIOUS frame's camera.
  //
  // The offset, not the absolute position, is what gets transformed. A world
  // position 900 km out has metre-scale quantisation in fp32, and reprojecting
  // it directly smears history along the limb; the camera-relative offset plus
  // the small inter-frame nav delta keeps every term near the magnitudes the
  // float actually resolves.
  reproject(point) {
    if (!this.hasPrevious) return { u: 0, v: 0, w: 0, inside: false };
    _point.set(
      point.x + this.navDelta.x,
      point.y + this.navDelta.y,
      point.z + this.navDelta.z,
      1,
    ).applyMatrix4(this.prevViewProjection);
    if (!(_point.w > 0)) return { u: 0, v: 0, w: _point.w, inside: false };
    const u = (_point.x / _point.w) * 0.5 + 0.5;
    const v = (_point.y / _point.w) * 0.5 + 0.5;
    return { u, v, w: _point.w, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1 };
  }

  // Upper bound on how much a parked camera's accumulated pixel can still move
  // between two frames, given the radiance spread the jitter induces. This is
  // the seamtest phase 1 argument stated as arithmetic rather than as hope.
  staticResidual(radianceSpread = 1) {
    if (!this.jitterEnabled) return 0;
    return radianceSpread / this.maxStaticFrames;
  }
}

export function createTemporalPolicy(options) {
  return new TemporalPolicy(options);
}
