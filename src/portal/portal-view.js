// The far side of a portal, drawn by a second instance of the production
// pipeline. It renders the same passes at the same resolution as the main
// view (opaque world, atmosphere, clouds) and stops before display transforms
// (transit, foreground ship, bloom, tone mapping, grade, SMAA): the main view
// composites its linear HDR result and then applies those once for both
// spaces. Consequently the pixels seen through an opening are the pixels the
// main view will produce after crossing, and the hand-off is invisible.


export class PortalView {
  // createPipeline(camera) must return a GameLegacyPipeline configured like
  // the main one; it is invoked lazily on first use.
  constructor({ createPipeline, mainCamera }) {
    this.createPipeline = createPipeline;
    this.mainCamera = mainCamera;
    this.camera = mainCamera.clone();
    this.camera.name = 'portal-view-camera';
    this.pipeline = null;
    this.size = null;
    this.rendered = false;
  }

  ensure() {
    if (this.pipeline) return this.pipeline;
    const pipeline = this.createPipeline(this.camera);
    // Everything after the participating media is a display transform owned
    // by the main view, plus the ship, which only exists on the viewer's side.
    for (const pass of [pipeline.warp, pipeline.foregroundPass, pipeline.parkedInteriorPass,
      pipeline.temporalAA, pipeline.bloom, pipeline.outputPass, pipeline.grade, pipeline.smaa,
      pipeline.portalComposite]) {
      if (pass) pass.enabled = false;
    }
    // Disabled passes must stay disabled whatever the main loop toggles.
    pipeline.portalView = true;
    pipeline.composer.renderToScreen = false;
    this.pipeline = pipeline;
    if (this.size) pipeline.setSize(...this.size);
    return pipeline;
  }

  setSize(width, height, dpr) {
    this.size = [width, height, dpr];
    this.pipeline?.setSize(width, height, dpr);
  }

  // The view's linear HDR output after the last render.
  get texture() {
    return this.pipeline?.composer.readBuffer.texture || null;
  }

  // Place the far-side camera: same projection as the main camera, mapped
  // orientation, at the scene origin (the far system is relativized around
  // the mapped universe position by the caller).
  syncCamera(quaternion) {
    const cam = this.camera, main = this.mainCamera;
    cam.fov = main.fov;
    cam.aspect = main.aspect;
    cam.near = main.near;
    cam.far = main.far;
    cam.zoom = main.zoom;
    cam.layers.mask = main.layers.mask;
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(quaternion);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  // Render the far side. `setup` prepares the shared scene for the far world
  // and returns a restore function; it runs inside the frame fence.
  render({ origin, context, timeEpoch = null, setup }) {
    const pipeline = this.ensure();
    let restore = null;
    this.rendered = false;
    try {
      restore = setup?.(pipeline) || null;
      this.rendered = pipeline.render({ origin, context, timeEpoch }) !== false;
    } finally {
      restore?.();
    }
    return this.rendered;
  }

  dispose() {
    this.pipeline?.dispose?.();
    this.pipeline = null;
  }
}

