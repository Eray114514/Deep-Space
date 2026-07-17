import { Pass } from '../vendor/jsm/postprocessing/Pass.js';

// Re-renders camera-local hero geometry after participating media. The main
// volume buffer is intentionally half-resolution and has no scene depth; this
// pass restores the cockpit/ship silhouette at full resolution instead of
// letting distant clouds composite across it like a screen overlay.
export class ForegroundPass extends Pass {
  constructor(scene, camera, layer) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.layer = layer;
    this.needsSwap = false;
    this.enabled = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    const oldMask = this.camera.layers.mask;
    const oldTarget = renderer.getRenderTarget();
    renderer.autoClear = false;
    this.camera.layers.set(this.layer);
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    this.camera.layers.mask = oldMask;
    renderer.autoClear = oldAutoClear;
    renderer.setRenderTarget(oldTarget);
  }
}
