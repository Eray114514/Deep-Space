import { Pass } from '../vendor/jsm/postprocessing/Pass.js';

// Re-renders camera-local hero geometry after participating media. The main
// volume buffer is intentionally half-resolution and has no scene depth; this
// pass restores the cockpit/ship silhouette at full resolution instead of
// letting distant clouds composite across it like a screen overlay.
export class ForegroundPass extends Pass {
  constructor(scene, camera, layers, { clearDepth = true } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.layers = Array.isArray(layers) ? [...layers] : [layers];
    this.layer = this.layers[0];
    this.clearDepth = clearDepth;
    this.needsSwap = false;
    this.enabled = false;
  }

  setLayers(layers) {
    this.layers = Array.isArray(layers) ? [...layers] : [layers];
    this.layer = this.layers[0];
  }

  // A layer may be drawn through its own camera (same pose, different
  // projection: e.g. a first-person viewmodel with a tighter near plane).
  // Depth is cleared before such a layer because its depth range differs.
  setLayerCamera(layer, camera) {
    if (!this.layerCameras) this.layerCameras = new Map();
    if (camera) this.layerCameras.set(layer, camera); else this.layerCameras.delete(layer);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.renderLayer(renderer, this.renderToScreen ? null : readBuffer);
  }

  renderDirect(renderer) {
    this.renderLayer(renderer, null);
  }

  renderLayer(renderer, target) {
    const oldAutoClear = renderer.autoClear;
    const oldMask = this.camera.layers.mask;
    const oldTarget = renderer.getRenderTarget();
    const oldFace = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
    // Skip massive Layer-0-only world subtrees (planet terrain/water/flora,
    // outpost camps, robots) during foreground layer passes so Three.js does
    // not traverse thousands of world meshes on every foreground layer.
    const hiddenWorldRoots = [];
    const hideWorldOnly = (list) => {
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const child = list[i];
        if (!child.visible) continue;
        if (child.userData?.worldLayerOnly) {
          child.visible = false;
          hiddenWorldRoots.push(child);
        } else if (child.userData?.hasWorldLayerChildren) {
          hideWorldOnly(child.children);
        }
      }
    };
    hideWorldOnly(this.scene?.children);
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      if (this.clearDepth) renderer.clearDepth();
      // One render call per semantic layer is intentional. Three gathers
      // lights against the camera mask, not per receiving object; rendering
      // exterior and cabin together would therefore let exterior fill lights
      // illuminate the enclosed room even when their Layers do not overlap.
      for (const layer of this.layers) {
        const camera = this.layerCameras?.get(layer) || this.camera;
        if (camera !== this.camera) {
          renderer.clearDepth();
          const ownMask = camera.layers.mask;
          camera.layers.set(layer);
          renderer.render(this.scene, camera);
          camera.layers.mask = ownMask;
          continue;
        }
        this.camera.layers.set(layer);
        renderer.render(this.scene, this.camera);
      }
    } finally {
      for (let i = 0; i < hiddenWorldRoots.length; i++) hiddenWorldRoots[i].visible = true;
      this.camera.layers.mask = oldMask;
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(oldTarget, oldFace, oldMip);
    }
  }
}
