import * as THREE from 'three';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ForegroundPass } from './foreground-pass.js';
import { VolumetricPass } from './volumetric-pass-webgl.js';
import { RiftDistortionShader, WarpDriveShader } from './legacy-post-shaders.js';

function aliasUniforms(uniforms, aliases) {
  for (const [alias, original] of Object.entries(aliases)) {
    if (uniforms[original]) uniforms[alias] = uniforms[original];
  }
}

// Exact WebGL production chain from the pre-WebGPU renderer. The small alias
// layer keeps the current game state machine renderer-agnostic without
// changing the authored GLSL passes.
export class GameLegacyPipeline {
  constructor(renderer, scene, camera, {
    volume = false,
    volumeScale = 0.67,
    bloomEnabled = true,
    bloomStrength = 0.5,
    bloomRadius = 0.4,
    bloomThreshold = 1.05,
    foregroundLayer = 1,
  } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      samples: 0,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    target.depthTexture.format = THREE.DepthFormat;
    target.depthTexture.name = 'scene.depth';
    this.target = target;
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.volumePass = volume ? new VolumetricPass(scene, camera, { scale: volumeScale }) : null;
    if (this.volumePass) this.composer.addPass(this.volumePass);

    this.warp = new ShaderPass(WarpDriveShader);
    this.warp.enabled = false;
    aliasUniforms(this.warp.uniforms, {
      time: 'uTime', warp: 'uWarp', pulse: 'uPulse', arrival: 'uArrival', aspect: 'uAspect',
    });
    this.composer.addPass(this.warp);

    this.foregroundPass = new ForegroundPass(scene, camera, foregroundLayer);
    this.composer.addPass(this.foregroundPass);

    this.rift = new ShaderPass(RiftDistortionShader);
    this.rift.enabled = false;
    aliasUniforms(this.rift.uniforms, {
      center: 'uCenter', radius: 'uRadius', open: 'uOpen', time: 'uTime',
      strength: 'uStrength', tension: 'uTension', burst: 'uBurst',
    });
    this.composer.addPass(this.rift);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1), bloomStrength, bloomRadius, bloomThreshold,
    );
    this.bloom.enabled = bloomEnabled;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.smaa = !matchMedia('(pointer: coarse)').matches
      ? new SMAAPass(1, 1)
      : null;
    if (this.smaa) this.composer.addPass(this.smaa);
    renderer.info.autoReset = false;
  }

  setSize(width, height, dpr = 1) {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
  }

  render() {
    this.composer.render();
  }

  async compileAsync() {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  dispose() {
    this.composer.dispose();
    this.volumePass?.dispose();
    this.foregroundPass.dispose?.();
    this.target.dispose();
  }
}
