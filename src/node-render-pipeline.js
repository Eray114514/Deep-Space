import * as THREE from 'three/webgpu';
import { float, max, mix, pass, rtt, uniform, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { VOLUME_LAYER } from './volumetric-pass.js';
import { createSunShaftNode } from './sun-shafts-node.js';

function over(base, overlay) {
  // Render-pass textures store premultiplied RGB.  Multiplying overlay.rgb by
  // alpha here a second time attenuated the atmosphere and soft cloud edges
  // only on the WebGPU path (the legacy volume composite has always used the
  // premultiplied equation below).
  return vec4(overlay.rgb.add(base.rgb.mul(float(1).sub(overlay.a))),
    max(base.a, overlay.a));
}

export class GameNodePipeline {
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
    this.camera = camera;
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.scenePass = pass(scene, camera, { samples: 4 });
    this.scenePass.name = 'Main scene';
    this.scenePass.setLayers(new THREE.Layers());
    const sceneColor = this.scenePass.getTextureNode('output');
    this.sceneDepthTexture = this.scenePass.getTexture('depth');
    let colorNode = sceneColor;

    this.volumePass = null;
    if (volume) {
      const layers = new THREE.Layers();
      layers.set(VOLUME_LAYER);
      this.volumePass = pass(scene, camera, { depthBuffer: false, samples: 0 });
      this.volumePass.name = 'Local volume layer';
      this.volumePass.setLayers(layers);
      this.volumePass.setResolutionScale(volumeScale);
      colorNode = over(colorNode, this.volumePass.getTextureNode('output'));
    }

    // Travel distortion owns the complete world image. Applying it before
    // atmosphere/cloud compositing left the solid planet warped while its
    // participating media stayed pinned to the screen.
    this.worldBase = rtt(colorNode);
    this.sunShafts = createSunShaftNode(
      this.worldBase,
      this.scenePass.getTextureNode('depth'),
      renderer.reversedDepthBuffer,
    );
    this.worldComposite = rtt(this.sunShafts.outputNode);
    const warp = createWarpDriveNode(this.worldComposite);
    this.warp = {
      enabled: false,
      uniforms: warp.uniforms,
    };
    const rift = createRiftDistortionNode(this.worldComposite);
    this.rift = {
      enabled: false,
      node: rift.node || rift.outputNode,
      uniforms: rift.uniforms,
    };
    const warpActivity = max(max(warp.uniforms.warp, warp.uniforms.pulse), warp.uniforms.arrival);
    colorNode = mix(this.rift.node, warp.outputNode || warp.node, warpActivity.clamp(0, 1));

    const foregroundLayers = new THREE.Layers();
    foregroundLayers.set(foregroundLayer);
    this.foregroundPass = pass(scene, camera, { depthBuffer: true, samples: 0 });
    this.foregroundPass.name = 'Cockpit foreground';
    this.foregroundPass.setLayers(foregroundLayers);
    colorNode = over(colorNode, this.foregroundPass.getTextureNode('output'));

    this._bloomEnabled = uniform(bloomEnabled ? 1 : 0);
    this._bloomStrength = uniform(bloomStrength);
    this._bloomRadius = uniform(bloomRadius);
    this._bloomThreshold = uniform(bloomThreshold);
    this.bloomNode = bloom(colorNode,
      this._bloomStrength.mul(this._bloomEnabled),
      this._bloomRadius,
      this._bloomThreshold);
    const bloomed = colorNode.add(this.bloomNode);
    this.pipeline.outputNode = mix(colorNode, bloomed, this._bloomEnabled);

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

  setSize() {
    // PassNode and BloomNode follow the renderer drawing-buffer size.
  }

  setVolumeScale(scale) {
    this.volumePass?.setResolutionScale(THREE.MathUtils.clamp(scale, 0.3, 1));
  }

  setSunShafts({ x = 0.5, y = 0.5, strength = 0, color = null } = {}) {
    this.sunShafts.uniforms.uSunUv.value.set(x, y);
    this.sunShafts.uniforms.uStrength.value = THREE.MathUtils.clamp(strength, 0, 1);
    if (color) this.sunShafts.uniforms.uTint.value.copy(color);
  }

  bindVolumeDepth(planet) {
    if (!planet || !this.volumePass) return false;
    let bound = false;
    for (const material of [planet.atmoMesh?.material, planet.volCloudMat]) {
      const uniforms = material?.uniforms;
      if (!uniforms?.tSceneDepth || !uniforms?.uDepthReady) continue;
      uniforms.tSceneDepth.value = this.sceneDepthTexture;
      uniforms.uDepthReady.value = 1;
      if (uniforms.uCameraNear) uniforms.uCameraNear.value = this.camera.near;
      if (uniforms.uCameraFar) uniforms.uCameraFar.value = this.camera.far;
      if (uniforms.uDepthReversed) {
        uniforms.uDepthReversed.value = this.renderer.reversedDepthBuffer ? 1 : 0;
      }
      bound = true;
    }
    return bound;
  }

  render() {
    this.pipeline.render();
  }

  async compileAsync() {
    await this.scenePass.compileAsync(this.renderer);
    if (this.volumePass) await this.volumePass.compileAsync(this.renderer);
    await this.foregroundPass.compileAsync(this.renderer);
    this.pipeline.render();
  }

  dispose() {
    this.scenePass.dispose();
    this.volumePass?.dispose();
    this.worldBase?.dispose();
    this.worldComposite?.dispose();
    this.foregroundPass.dispose();
    this.bloomNode.dispose();
    this.pipeline.dispose();
  }
}
