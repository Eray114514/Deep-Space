// FAILED temporal-accumulation prototype for the WebGPU volume path (phase 2).
//
// docs/cloud-atmosphere-rewrite.md §4 phase 2. The bookkeeping — when history
// is valid, how fast it converges, what counts as a discontinuity — lives in
// `temporal-policy.js` so a Node test can drive it frame by frame with no GPU.
// This file owns the GPU side: the ping-pong targets, the reprojection graph,
// and the depth-guided upsample. Everything the policy exports is re-exported
// here so callers still have one entry point.
//
// WHY THIS IS PHASE 2 AND NOT PHASE 5
// -----------------------------------
// The WebGPU path had no temporal accumulation at all; reprojection existed
// only in `volumetric-pass-webgl.js`, the WebGL fallback. The previous round
// implemented per-frame ray-start jitter on the WebGPU path as if accumulation
// were present, and `npm run seamtest` measured 75-138 changed pixels with the
// camera PARKED against a 0 px baseline. Per-frame jitter without a combiner is
// not sampling, it is noise. This prototype later failed continuous wide-angle
// motion and is production-disabled in node-render-pipeline.js. Phase 4 reaches
// single-frame convergence without it; phase 7 may reuse bookkeeping only after
// full-screen motion vectors, rejection and volume history share one owner.
//
// HISTORICAL NO-OP PROPERTY — NOT A PRODUCTION ACCEPTANCE GATE
// ------------------------------------------------------------
// With `jitter: false` the volume march produces a bit-identical image every
// frame for a fixed camera. The accumulator computes mix(history, current,
// alpha); history was itself seeded from current, so the result is current
// exactly, for every alpha. `tools/temporalresolvetest.js` keeps that local
// identity and invalidation bookkeeping covered. It does NOT prove that the
// reprojection works during continuous motion; the wide-angle hardware test
// disproved that. Phase 3/4 must not enable jitter or this resolve pass. Phase 7
// may reuse only parts that survive the unified full-screen motion-vector gate.
//
// WHERE ACCUMULATION SITS IN THE GRAPH
//   volume pass (half res)
//     -> temporal resolve (half res, ping-pong)   <- this file
//     -> depth-guided upsample (full res)         <- this file
//     -> composite
// Accumulating at half resolution keeps the history texels aligned with the
// samples that produced them. Upsampling first would blend neighbours before
// reprojection and give history a rejection policy that disagreed with the
// upsample's — the two policies now share `guidedTapWeight`'s constants.

import {
  Matrix4, NodeMaterial, NodeUpdateType, QuadMesh, RenderTarget, RendererUtils,
  TempNode, Vector2, Vector3,
} from 'three/webgpu';
import {
  Fn, abs, exp, float, floor, fract, logarithmicDepthToViewZ, max, mix,
  nodeObject, passTexture, screenUV, texture, uniform, uv, vec2, vec4,
} from 'three/tsl';
import {
  DEPTH_EDGE_FLOOR_METERS, DEPTH_EDGE_SLOPE, GUIDED_WEIGHT_EPSILON,
  HISTORY_ALPHA_REJECT, HISTORY_COLOR_REJECT, INVALIDATION, TemporalPolicy,
  createTemporalPolicy,
} from './temporal-policy.js';

export {
  INVALIDATION, TemporalPolicy, createTemporalPolicy,
} from './temporal-policy.js';
export const TEMPORAL_RESOLVE_VERSION = 1;

const _size = new Vector2();
const _quad = new QuadMesh();
let _rendererState;

// Depth-guided reconstruction of a half-resolution volume buffer.
//
// Moved here from `node-render-pipeline.js` so that accumulation and upsample
// cannot end up with two rejection policies that disagree; the thresholds come
// from `temporal-policy.js`, which is also what the CPU reference in
// `guidedTapWeight` uses.
//
// A half-resolution cloud texel at the planet limb contains a long background
// ray. Hardware bilinear would smear it across nearby terrain as a blue/white
// halo, so the four taps are reconstructed by hand and rejected across opaque
// depth discontinuities.
export function depthGuidedVolumeUpsample(volumeTexture, sceneDepthTexture, nodes) {
  const volumePixel = screenUV.mul(nodes.uVolumeResolution).sub(0.5);
  const basePixel = floor(volumePixel);
  const fraction = fract(volumePixel);
  const invResolution = vec2(1).div(nodes.uVolumeResolution);
  const uv00 = basePixel.add(vec2(0.5, 0.5)).mul(invResolution).clamp(0, 1);
  const uv10 = basePixel.add(vec2(1.5, 0.5)).mul(invResolution).clamp(0, 1);
  const uv01 = basePixel.add(vec2(0.5, 1.5)).mul(invResolution).clamp(0, 1);
  const uv11 = basePixel.add(vec2(1.5, 1.5)).mul(invResolution).clamp(0, 1);
  const oneMinusX = float(1).sub(fraction.x);
  const oneMinusY = float(1).sub(fraction.y);

  const centerRawDepth = sceneDepthTexture.sample(screenUV).r;
  const centerHasDepth = nodes.uDepthReversed.greaterThan(0.5)
    .select(centerRawDepth.greaterThan(0.000001),
      centerRawDepth.lessThan(0.999999));
  const centerViewDepth = logarithmicDepthToViewZ(
    centerRawDepth, nodes.uCameraNear, nodes.uCameraFar,
  ).negate().max(0);

  const guidedTap = (tapUv, spatialWeight) => {
    const tapRawDepth = sceneDepthTexture.sample(tapUv).r;
    const tapHasDepth = nodes.uDepthReversed.greaterThan(0.5)
      .select(tapRawDepth.greaterThan(0.000001),
        tapRawDepth.lessThan(0.999999));
    const tapViewDepth = logarithmicDepthToViewZ(
      tapRawDepth, nodes.uCameraNear, nodes.uCameraFar,
    ).negate().max(0);
    // Relative view-space depth keeps one threshold stable from cockpit metres
    // to a 900 km planet; the metre floor stops log-depth quantisation from
    // rejecting coplanar neighbours. Mirrors guidedTapWeight().
    const depthScale = max(centerViewDepth, tapViewDepth).mul(DEPTH_EDGE_SLOPE)
      .add(DEPTH_EDGE_FLOOR_METERS);
    const relativeDelta = abs(centerViewDepth.sub(tapViewDepth)).div(depthScale);
    const sameSurfaceWeight = exp(relativeDelta.mul(relativeDelta).negate());
    // Background and opaque samples are different ownership classes. Never
    // borrow a full-atmosphere background ray for an opaque silhouette pixel,
    // or an opaque-clipped ray for a sky pixel.
    const depthWeight = centerHasDepth.select(
      tapHasDepth.select(sameSurfaceWeight, 0),
      tapHasDepth.select(0, 1),
    );
    const weight = spatialWeight.mul(depthWeight);
    return { color: volumeTexture.sample(tapUv).mul(weight), weight };
  };

  const tap00 = guidedTap(uv00, oneMinusX.mul(oneMinusY));
  const tap10 = guidedTap(uv10, fraction.x.mul(oneMinusY));
  const tap01 = guidedTap(uv01, oneMinusX.mul(fraction.y));
  const tap11 = guidedTap(uv11, fraction.x.mul(fraction.y));
  const weightSum = tap00.weight.add(tap10.weight).add(tap01.weight).add(tap11.weight);
  const guided = tap00.color.add(tap10.color).add(tap01.color).add(tap11.color)
    .div(weightSum.max(0.00001));
  // Every tap can be rejected at the limb: a sky pixel whose four neighbours
  // all landed on the planet has no same-class tap. Returning zero there erased
  // the atmosphere for exactly those pixels, and which pixels qualify changes
  // every frame as the camera turns — the reported "atmosphere flickers
  // whenever the view moves". Fall back to the co-located texel instead.
  const fallback = volumeTexture.sample(screenUV);
  return mix(fallback, guided,
    weightSum.greaterThan(GUIDED_WEIGHT_EPSILON).select(1, 0));
}

// Accumulation node. Follows the ping-pong shape three's own AfterImageNode
// uses: a TempNode with a FRAME-rate updateBefore that renders a quad into the
// write target and then swaps. A single target read and written in one pass is
// the ownership error already recorded in docs/optimization-roadmap.md; WebGPU
// is stricter about it than WebGL and will either warn or produce garbage.
class TemporalResolveNode extends TempNode {
  static get type() { return 'TemporalResolveNode'; }

  constructor(volumeTextureNode, policy, resolveResolution) {
    super('vec4');
    this.volumeTextureNode = volumeTextureNode;
    this.policy = policy;
    // Callback returning the current volume render-target size in texels. The
    // history must live on exactly the grid the samples were produced on;
    // deriving it from the drawing buffer would drift by a texel whenever the
    // adaptive volume scale lands on a fractional size.
    this.resolveResolution = resolveResolution;

    this._writeTarget = new RenderTarget(1, 1, { depthBuffer: false });
    this._writeTarget.texture.name = 'cloud.temporal.write';
    this._readTarget = new RenderTarget(1, 1, { depthBuffer: false });
    this._readTarget.texture.name = 'cloud.temporal.read';
    for (const target of [this._writeTarget, this._readTarget]) {
      target.texture.generateMipmaps = false;
    }

    this._outputNode = passTexture(this, this._writeTarget.texture);
    this._historyNode = texture(this._readTarget.texture);

    this.uniforms = {
      uHistoryValid: uniform(0),
      uAlpha: uniform(1),
      uNavDelta: uniform(new Vector3()),
      uVolumeCenter: uniform(new Vector3(0, 0, -1e12)),
      uVolumeRadius: uniform(1),
      uCameraPosition: uniform(new Vector3()),
      uPrevViewProjection: uniform(new Matrix4()),
      uInvProjection: uniform(new Matrix4()),
      uCameraWorld: uniform(new Matrix4()),
      uResolveResolution: uniform(new Vector2(1, 1)),
    };

    this._material = null;
    this._width = 0;
    this._height = 0;
    this.updateBeforeType = NodeUpdateType.FRAME;
  }

  getTextureNode() { return this._outputNode; }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this._width && h === this._height) return false;
    this._width = w;
    this._height = h;
    this._writeTarget.setSize(w, h);
    this._readTarget.setSize(w, h);
    // The history contents are undefined after a rebuild and the texel grid no
    // longer corresponds to the previous frame's samples.
    this.policy.invalidate(INVALIDATION.RESIZE);
    return true;
  }

  updateBefore(frame) {
    const { renderer } = frame;
    // Nothing to ping-pong until setup() has built the resolve material. The
    // node registers for FRAME updates at build time, so this only guards the
    // very first tick of a freshly constructed pipeline.
    if (!this._material) return;
    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);

    const map = this.volumeTextureNode.value;
    if (map) {
      this._writeTarget.texture.type = map.type;
      this._readTarget.texture.type = map.type;
    }
    const size = this.resolveResolution(_size);
    this.setSize(size.x, size.y);

    this._outputNode.value = this._writeTarget.texture;
    this._historyNode.value = this._readTarget.texture;
    this.uniforms.uResolveResolution.value.set(this._width, this._height);

    this.uniforms.uHistoryValid.value = this.policy.historyValid ? 1 : 0;
    this.uniforms.uAlpha.value = this.policy.alpha;
    this.uniforms.uNavDelta.value.copy(this.policy.navDelta);
    this.uniforms.uPrevViewProjection.value.copy(this.policy.prevViewProjection);

    _quad.material = this._material;
    _quad.name = 'Cloud temporal resolve';
    renderer.setRenderTarget(this._writeTarget);
    _quad.render(renderer);

    const swap = this._readTarget;
    this._readTarget = this._writeTarget;
    this._writeTarget = swap;

    RendererUtils.restoreRendererState(renderer, _rendererState);
  }

  setup() {
    const u = this.uniforms;
    const resolve = Fn(() => {
      const pixelUv = uv();
      const current = this.volumeTextureNode.sample(pixelUv).toVar();

      // Reconstruct this texel's view ray. The reprojection surface is the
      // atmosphere shell, not the opaque depth buffer: the signal being
      // accumulated is participating media, and most of these texels never hit
      // geometry at all. A shell hit gives every sky pixel a stable, physically
      // meaningful correspondence between frames.
      const clip = vec4(pixelUv.mul(2).sub(1), 1, 1);
      const viewPoint = u.uInvProjection.mul(clip);
      const dirView = viewPoint.xyz.div(viewPoint.w.abs().max(1e-5)).normalize();
      const dirWorld = u.uCameraWorld.mul(vec4(dirView, 0)).xyz.normalize();

      const oc = u.uCameraPosition.sub(u.uVolumeCenter);
      const b = oc.dot(dirWorld);
      const c = oc.dot(oc).sub(u.uVolumeRadius.mul(u.uVolumeRadius));
      const discriminant = b.mul(b).sub(c);
      const root = discriminant.max(0).sqrt();
      const tNear = b.negate().sub(root);
      const tFar = b.negate().add(root);
      // Outside the shell the near boundary is the stable surface. Inside it,
      // the near hit is behind the camera, so bias into the volume instead of
      // taking the far boundary, which sits on the opposite side of the planet
      // and reprojects to a completely unrelated screen position.
      const t = tNear.greaterThan(0)
        .select(tNear, mix(tNear.max(0), tFar, 0.42));
      const shellHit = discriminant.greaterThan(0).and(tFar.greaterThan(0));

      const point = u.uCameraPosition.add(dirWorld.mul(t));
      // Camera-relative, never absolute: a world position 900 km out has
      // metre-scale fp32 quantisation, which shows up as history smear along
      // the limb. Mirrors TemporalPolicy.reproject().
      const previousPoint = point.add(u.uNavDelta);
      const previousClip = u.uPrevViewProjection.mul(vec4(previousPoint, 1));
      const safeW = previousClip.w.abs().max(1e-6);
      const previousUv = previousClip.xy.div(safeW).mul(0.5).add(0.5);
      // Snap sub-texel motion back to the co-located texel.
      //
      // Reconstructing a ray, marching ~1e6 m to the shell and projecting back
      // through the previous matrices is not an exact fp32 round trip, so a
      // PARKED camera lands a fraction of a texel away from where it started.
      // That is enough to make the history read a bilinear blend of four texels
      // instead of itself, and a running mean of a repeatedly-resampled image is
      // a slow blur that never reaches a fixed point: measured as 10 changed
      // pixels at factor 2.0 in seamtest phase 1, against a 0 px baseline, and
      // rising the longer the camera sits still. Within half a texel there is no
      // real parallax to correct for, so the exact texel is both the cheaper and
      // the more accurate answer. Above that threshold reprojection is doing
      // genuine work and is left alone.
      const uvDelta = previousUv.sub(pixelUv).mul(u.uResolveResolution);
      const stationary = uvDelta.length().lessThan(0.5);
      const sampleUv = stationary.select(pixelUv, previousUv);
      const inFront = previousClip.w.greaterThan(0);
      const inBounds = previousUv.x.greaterThanEqual(0)
        .and(previousUv.x.lessThanEqual(1))
        .and(previousUv.y.greaterThanEqual(0))
        .and(previousUv.y.lessThanEqual(1));

      const history = this._historyNode.sample(sampleUv.clamp(0, 1)).toVar();
      // Coverage disagreement means an edge crossed this pixel: the history is
      // a different ray, not a noisier estimate of this one.
      const coverageDelta = abs(history.a.sub(current.a));
      const coverageOk = coverageDelta
        .lessThan(float(HISTORY_ALPHA_REJECT)).select(1, 0);
      // ...and the same test on radiance. Coverage alone misses a change that
      // keeps the medium's opacity but alters its colour — a shadow sweeping
      // across a deck, terrain resolving under a thin layer — which is exactly
      // the residual seamtest phase 1 caught on a parked camera.
      const colorDelta = max(
        max(abs(history.r.sub(current.r)), abs(history.g.sub(current.g))),
        abs(history.b.sub(current.b)));
      const colorOk = colorDelta
        .lessThan(float(HISTORY_COLOR_REJECT)).select(1, 0);

      const accept = u.uHistoryValid
        .mul(shellHit.and(inFront).and(inBounds).select(1, 0))
        .mul(coverageOk).mul(colorOk);
      // alpha is the CURRENT frame's weight. Rejection forces it to 1, so a
      // rejected pixel resolves to the live sample. It must never resolve to
      // zero — that is the hole that read as "the atmosphere flickers".
      const blend = mix(float(1), u.uAlpha, accept);
      return mix(history, current, blend);
    });

    const material = this._material || (this._material = new NodeMaterial());
    material.name = 'Cloud temporal resolve';
    material.fragmentNode = resolve();
    material.needsUpdate = true;
    return this._outputNode;
  }

  dispose() {
    this._writeTarget.dispose();
    this._readTarget.dispose();
    this._material?.dispose();
  }
}

// Build the accumulation stage for a volume pass.
//
//   volumeTextureNode   the volume pass output (half resolution)
//   resolveResolution   (out: Vector2) => Vector2, the volume target size
//   policy              optional pre-built TemporalPolicy
export function createTemporalResolve({
  volumeTextureNode,
  resolveResolution,
  policy = null,
  jitter = false,
} = {}) {
  if (!volumeTextureNode) {
    throw new TypeError('createTemporalResolve() needs the volume texture node');
  }
  if (typeof resolveResolution !== 'function') {
    throw new TypeError('createTemporalResolve() needs a resolveResolution(out) callback');
  }
  const activePolicy = policy || createTemporalPolicy({ jitter });
  const node = nodeObject(
    new TemporalResolveNode(volumeTextureNode, activePolicy, resolveResolution));

  return {
    policy: activePolicy,
    node,
    // Output as a texture node so the composite can sample it at arbitrary UVs
    // (the depth-guided upsample needs the four neighbouring texels).
    textureNode: node.getTextureNode(),
    uniforms: node.uniforms,

    // Call once per frame BEFORE render(). `camera` supplies the current
    // matrices; the rest describes the active volume so the policy can tell a
    // warp arrival from a fast pass.
    update({
      camera, nav = null, volumeCenter = null, volumeRadius = 0,
      volumeKey = null, moving = false,
    } = {}) {
      const uniforms = node.uniforms;
      if (camera) {
        camera.updateMatrixWorld();
        uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);
        uniforms.uCameraWorld.value.copy(camera.matrixWorld);
        uniforms.uCameraPosition.value.copy(camera.position);
      }
      if (volumeCenter) uniforms.uVolumeCenter.value.copy(volumeCenter);
      uniforms.uVolumeRadius.value = Math.max(1, volumeRadius);

      const viewProjection = camera
        ? _viewProjection(camera) : null;
      return activePolicy.update({
        viewProjection, nav, volumeRadius, volumeKey, moving,
      });
    },

    invalidate(reason) { activePolicy.invalidate(reason); },
    dispose() { node.dispose?.(); },
  };
}

const _viewProjectionScratch = { matrix: null };
function _viewProjection(camera) {
  if (!_viewProjectionScratch.matrix) {
    _viewProjectionScratch.matrix = camera.projectionMatrix.clone();
  }
  return _viewProjectionScratch.matrix
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}
