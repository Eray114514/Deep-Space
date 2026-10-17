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
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      if (this.clearDepth) renderer.clearDepth();
      // One render call per semantic layer is intentional. Three gathers
      // lights against the camera mask, not per receiving object; rendering
      // exterior and cabin together would therefore let exterior fill lights
      // illuminate the enclosed room even when their Layers do not overlap.
      for (const layer of this.layers) {
        this.camera.layers.set(layer);
        renderer.render(this.scene, this.camera);
      }
    } finally {
      this.camera.layers.mask = oldMask;
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(oldTarget, oldFace, oldMip);
    }
  }
}
