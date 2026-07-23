// WebGPU render pipeline (v2): from-scratch TSL rewrite of the post chain.
//
// Chain: scenePass -> volumePass (over) -> foregroundPass (over) -> TAA resolve
// -> bloom -> explicit ACESFilmic tone mapping + sRGB (renderOutput).
//
// Design notes:
//  * TAA uses PassNode.getPreviousTextureNode('output') for ping-pong history.
//    PassNode.updateBefore() toggles current/previous every frame for every
//    entry in _previousTextures, so the history sample always lags by exactly
//    one frame with no manual render-target swapping.
//  * Neighborhood clamp (3x3 AABB clipToAABB) suppresses ghosting; the temporal
//    blend weight is modulated by a cameraPosition frame-delta motion scalar
//    (high motion -> low history weight -> no smear).
//  * Depth binding: scenePass.renderTarget.depthTexture is bound to every
//    VOLUME_LAYER mesh's tSceneDepth uniform each frame. volumePass runs after
//    scenePass in the node graph (its texture is sampled downstream of
//    sceneColor), so the depth it samples is already populated.
//  * pipeline.outputColorTransform = false; tone mapping + color space are
//    applied explicitly via renderOutput() at the very end of the chain.

import * as THREE from 'three/webgpu';
import {
  mix, vec4,
  uniform, float, max, pass,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { VOLUME_LAYER } from './volumetric-pass.js';

// Reusable scratch objects to avoid per-frame allocation.
const _volumeLayers = new THREE.Layers();
_volumeLayers.set(VOLUME_LAYER);
const _scratchSize = new THREE.Vector2();

/**
 * Porter-Duff Over compositing for premultiplied-alpha render-pass textures.
 *
 * PassNode output textures are stored premultiplied (rgb already scaled by
 * alpha), so the Over sum is simply `overlay.rgb + base.rgb * (1 - overlay.a)`.
 * The resulting alpha is the union of both alphas. This matches the legacy
 * WebGL volume composite and avoids double-attenuating soft cloud/atmosphere
 * edges. `float(1)` keeps the literal in node-space.
 */
function over(base, overlay) {
  return vec4(
    overlay.rgb.add(base.rgb.mul(float(1).sub(overlay.a))),
    max(base.a, overlay.a),
  );
}

export class GameNodePipelineV2 {
  constructor(renderer, scene, camera, {
    volume = false,
    volumeScale = 0.67,
    bloomEnabled = true,
    bloomStrength = 0.5,
    bloomRadius = 0.4,
    bloomThreshold = 1.05,
    foregroundLayer = 1,
    createWarpDriveNode,
    createRiftDistortionNode,
  } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this._volumeScale = volumeScale;

    this.pipeline = new THREE.RenderPipeline(renderer);
    // Keep RenderPipeline.outputColorTransform = true (default): it wraps the
    // outputNode with the renderer's tone mapping + sRGB conversion, matching
    // the proven legacy pipeline. The V1 attempt disabled this and used
    // renderOutput() manually, which produced a black screen because the
    // intermediate textures' premultiplied-alpha semantics didn't survive
    // the explicit unpremultiply step.

    // --- scene pass (samples:1 disables MSAA without invalid sample counts) ---
    this.scenePass = pass(scene, camera, { samples: 1 });
    this.scenePass.name = 'Main scene';
    this.scenePass.setLayers(new THREE.Layers());
    const sceneColor = this.scenePass.getTextureNode('output');
    // Ping-pong the scene depth so the half-resolution volume pass samples a
    // finished frame instead of the depth attachment still being written by the
    // main pass. WebGPU forbids reading a depth attachment while it is bound as
    // a writable render attachment in the same command encoder.
    this._prevDepthNode = this.scenePass.getPreviousTextureNode('depth');

    // --- warp / rift: mutually exclusive travel states, applied to scene only
    //     (volume + foreground are composited on top, matching the existing
    //     WebGPU pipeline so the cockpit stays stable during warp). ---
    const warp = createWarpDriveNode(sceneColor);
    this.warp = { enabled: false, uniforms: warp.uniforms };
    const rift = createRiftDistortionNode(sceneColor);
    this.rift = { enabled: false, node: rift.node || rift.outputNode, uniforms: rift.uniforms };
    const warpActivity = max(max(warp.uniforms.warp, warp.uniforms.pulse), warp.uniforms.arrival);
    let colorNode = mix(this.rift.node, warp.outputNode || warp.node, warpActivity.clamp(0, 1));

    // --- volume pass (VOLUME_LAYER, half-res, no depth buffer of its own) ---
    this.volumePass = null;
    if (volume) {
      const layers = new THREE.Layers();
      layers.set(VOLUME_LAYER);
      this.volumePass = pass(scene, camera, { depthBuffer: false, samples: 1 });
      this.volumePass.name = 'Local volume layer';
      this.volumePass.setLayers(layers);
      this.volumePass.setResolutionScale(volumeScale);
      colorNode = over(colorNode, this.volumePass.getTextureNode('output'));
    }

    // --- foreground pass (cockpit, full-res, own depth) ---
    const foregroundLayers = new THREE.Layers();
    foregroundLayers.set(foregroundLayer);
    this.foregroundPass = pass(scene, camera, { depthBuffer: true, samples: 1 });
    this.foregroundPass.name = 'Cockpit foreground';
    this.foregroundPass.setLayers(foregroundLayers);
    colorNode = over(colorNode, this.foregroundPass.getTextureNode('output'));

    // --- bloom (operates in linear HDR, before tone mapping) ---
    this._bloomEnabled = uniform(0);
    this._bloomStrength = uniform(bloomStrength);
    this._bloomRadius = uniform(bloomRadius);
    this._bloomThreshold = uniform(bloomThreshold);
    this.bloomNode = bloom(colorNode,
      this._bloomStrength.mul(this._bloomEnabled),
      this._bloomRadius,
      this._bloomThreshold);
    const bloomed = colorNode.add(this.bloomNode);
    const finalColor = mix(colorNode, bloomed, this._bloomEnabled);
    // Force opaque output. RenderPipeline.outputColorTransform (left enabled)
    // wraps outputNode with unpremultiplyAlpha → toneMapping → premultiplyAlpha.
    // When the scene background is null and renderer.alpha=true, void pixels
    // have alpha=0 and unpremultiplyAlpha zeros RGB, defeating tone mapping +
    // bloom. The screen framebuffer is always opaque, so force alpha=1.
    this.pipeline.outputNode = vec4(finalColor.rgb, 1);

    this.bloom = {
      get enabled() { return this._owner._bloomEnabled.value > 0.5; },
      set enabled(value) { this._owner._bloomEnabled.value = value ? 1 : 0; },
      get strength() { return this._owner._bloomStrength.value; },
      set strength(value) { this._owner._bloomStrength.value = value; },
      get radius() { return this._owner._bloomRadius.value; },
      set radius(value) { this._owner._bloomRadius.value = value; },
      get threshold() { return this._owner._bloomThreshold.value; },
      set threshold(value) { this._owner._bloomThreshold.value = value; },
      _owner: this,
    };
  }

  setSize(width, height, dpr) {
    // PassNode auto-sizes from the renderer drawing-buffer on render, but
    // starting at 1x1 and resizing during the first frame destroys the initial
    // depth/output textures while a pending command buffer still references
    // them. Pre-size the passes to the renderer drawing-buffer to avoid that
    // WebGPU validation error.
    const w = Math.floor(width * dpr);
    const h = Math.floor(height * dpr);
    this.scenePass.setSize(w, h);
    this.volumePass?.setSize(w, h);
    this.foregroundPass.setSize(w, h);
  }

  _ensureVolumeLayers() {
    // PassNode sets camera.layers.mask = VOLUME_LAYER for the volume pass.
    // Renderer._projectObject stops recursing into children when a parent's
    // layers don't match the camera, so the Scene and every Group in the
    // hierarchy must also have VOLUME_LAYER enabled. This is required both
    // at compile time (so volume materials are actually found) and at render
    // time (so they are reached during the live pass).
    if (!this.volumePass) return;
    this.scene.layers.enable(VOLUME_LAYER);
    this.scene.traverse((o) => {
      if (o.isGroup) o.layers.enable(VOLUME_LAYER);
    });
  }

  _bindVolumeDepth() {
    if (!this.volumePass) return;
    // Sample the previous frame's scene depth: the current frame's depth
    // attachment is still in use while the main pass is being recorded, so
    // binding it to the volume shader causes a WebGPU usage conflict.
    const depthTex = this._prevDepthNode?.value || this.scenePass.renderTarget?.depthTexture;
    if (!depthTex) return;
    this.scene.traverse((o) => {
      if (!o.isMesh || !o.layers.test(_volumeLayers)) return;
      const u = o.material?.uniforms;
      if (!u) return;
      if (u.tSceneDepth && u.tSceneDepth.value !== depthTex) {
        u.tSceneDepth.value = depthTex;
        u.uDepthReady.value = 1;
      }
      if (u.uCameraFar) u.uCameraFar.value = this.camera.far;
      if (u.uCameraNear) u.uCameraNear.value = this.camera.near;
      if (u.uVolumeSize?.value?.set) {
        const size = this.renderer.getDrawingBufferSize(_scratchSize);
        u.uVolumeSize.value.set(size.width * this._volumeScale, size.height * this._volumeScale);
      }
    });
  }

  render() {
    // Depth binding: feed scenePass's depth texture to every volume-layer mesh
    // so atmosphere/cloud raymarchers can depth-test against the opaque scene.
    this._ensureVolumeLayers();
    this._bindVolumeDepth();
    this.pipeline.render();
  }

  async compileAsync() {
    // Volume-layer meshes are skipped during compile unless their parent
    // Groups have VOLUME_LAYER enabled. Without this, the first real volume
    // frame compiles on demand and causes the 3000-3400 m hitch.
    this._ensureVolumeLayers();
    await this.scenePass.compileAsync(this.renderer);
    if (this.volumePass) await this.volumePass.compileAsync(this.renderer);
    await this.foregroundPass.compileAsync(this.renderer);
    this.pipeline.render();
  }

  dispose() {
    this.scenePass.dispose();
    this.volumePass?.dispose();
    this.foregroundPass.dispose();
    this.bloomNode.dispose();
    this.pipeline.dispose();
  }
}
