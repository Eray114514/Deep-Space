import * as THREE from 'three/webgpu';
import { float, max, mix, pass, uniform, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { VOLUME_LAYER } from './volumetric-pass.js';

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
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.scenePass = pass(scene, camera, { samples: 0 });
    this.scenePass.name = 'Main scene';
    this.scenePass.setLayers(new THREE.Layers());
    const sceneColor = this.scenePass.getTextureNode('output');
    const warp = createWarpDriveNode(sceneColor);
    this.warp = {
      enabled: false,
      uniforms: warp.uniforms,
    };
    const rift = createRiftDistortionNode(sceneColor);
    this.rift = {
      enabled: false,
      node: rift.node || rift.outputNode,
      uniforms: rift.uniforms,
    };

    // Warp and rift are mutually exclusive travel states. Both need random
    // access to the original pass texture, so blend their independently
    // sampled results before layering volume and foreground geometry.
    const warpActivity = max(max(warp.uniforms.warp, warp.uniforms.pulse), warp.uniforms.arrival);
    let colorNode = mix(this.rift.node, warp.outputNode || warp.node, warpActivity.clamp(0, 1));

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
    this.foregroundPass.dispose();
    this.bloomNode.dispose();
    this.pipeline.dispose();
  }
}
