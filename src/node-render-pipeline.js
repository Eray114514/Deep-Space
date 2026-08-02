import * as THREE from 'three/webgpu';
import {
  abs, exp, float, floor, fract, logarithmicDepthToViewZ, max, mix, pass, rtt,
  screenUV, uniform, vec2, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { VOLUME_LAYER } from './volumetric-pass.js';
import { SKY_BACKDROP_LAYER } from './render-layers.js';
import { createSunShaftNode } from './sun-shafts-node.js';

function over(base, overlay) {
  // Render-pass textures store premultiplied RGB.  Multiplying overlay.rgb by
  // alpha here a second time attenuated the atmosphere and soft cloud edges
  // only on the WebGPU path (the legacy volume composite has always used the
  // premultiplied equation below).
  return vec4(overlay.rgb.add(base.rgb.mul(float(1).sub(overlay.a))),
    overlay.a.add(base.a.mul(float(1).sub(overlay.a))));
}

function depthGuidedVolumeUpsample(volumeTexture, sceneDepthTexture, nodes) {
  // Reconstruct the four texels that hardware bilinear filtering would blend,
  // then reject taps across an opaque-depth discontinuity. A half-resolution
  // cloud texel at the planet limb otherwise contains a long background ray
  // and gets interpolated across nearby terrain as a blue/white halo.
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
    centerRawDepth,
    nodes.uCameraNear,
    nodes.uCameraFar,
  ).negate().max(0);

  const guidedTap = (uv, spatialWeight) => {
    const tapRawDepth = sceneDepthTexture.sample(uv).r;
    const tapHasDepth = nodes.uDepthReversed.greaterThan(0.5)
      .select(tapRawDepth.greaterThan(0.000001),
        tapRawDepth.lessThan(0.999999));
    const tapViewDepth = logarithmicDepthToViewZ(
      tapRawDepth,
      nodes.uCameraNear,
      nodes.uCameraFar,
    ).negate().max(0);
    // Relative view-space depth makes the edge threshold stable from cockpit
    // metres to a 900 km planet. Two metres keep nearby coplanar geometry from
    // being rejected by float/log-depth quantisation.
    const depthScale = max(centerViewDepth, tapViewDepth).mul(0.0125).add(2);
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
    return { color: volumeTexture.sample(uv).mul(weight), weight };
  };

  const tap00 = guidedTap(uv00, oneMinusX.mul(oneMinusY));
  const tap10 = guidedTap(uv10, fraction.x.mul(oneMinusY));
  const tap01 = guidedTap(uv01, oneMinusX.mul(fraction.y));
  const tap11 = guidedTap(uv11, fraction.x.mul(fraction.y));
  const weightSum = tap00.weight.add(tap10.weight).add(tap01.weight).add(tap11.weight);
  // If a sub-pixel opaque feature has no matching low-resolution tap, zero
  // volume is the conservative result. Dividing by epsilon preserves that
  // transparent result instead of falling back to the leaking center sample.
  return tap00.color.add(tap10.color).add(tap01.color).add(tap11.color)
    .div(weightSum.max(0.00001));
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
    this.volumeScale = volumeScale;
    this._volumeResolution = uniform(new THREE.Vector2(1, 1));
    this._volumeUpsample = uniform(volumeScale < 0.999 ? 1 : 0);
    this._volumeNear = uniform(camera.near);
    this._volumeFar = uniform(camera.far);
    this._volumeDepthReversed = uniform(renderer.reversedDepthBuffer ? 1 : 0);
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.scenePass = pass(scene, camera, { samples: 4 });
    this.scenePass.name = 'Main scene';
    const worldLayers = new THREE.Layers();
    this.scenePass.setLayers(worldLayers);
    const sceneColor = this.scenePass.getTextureNode('output');
    // WebGPU cannot sample the multisampled depth attachment, nor let volume
    // materials read the same depth resource while Main scene writes it. A
    // separate single-sample pass gives all depth consumers unambiguous read
    // ownership while the visible world keeps 4x MSAA color quality.
    this.depthPass = pass(scene, camera, { samples: 0 });
    this.depthPass.name = 'Opaque world depth';
    this.depthPass.setLayers(worldLayers);
    // Transparent atmosphere, cloud and ring materials are not depth owners.
    // Excluding them also prevents a dormant volume material from sampling the
    // depth attachment while this pass is writing it.
    this.depthPass.transparent = false;
    const depthAttachmentNode = this.depthPass.getTextureNode('depth');
    // A DepthTexture cannot be bound to the regular float texture uniforms used
    // by the volume materials. Copy raw depth into a filterable color RTT first;
    // all later consumers then read this texture in a separate render scope.
    // RTTNode defaults to HalfFloatType. That is not enough for logarithmic
    // world depth: half-float quantises a planet disk into large radial steps,
    // which the atmosphere/cloud ray limits then reveal as moving contour
    // rings over oceans and clouds. Preserve the raw depth in 32-bit float and
    // never interpolate encoded depth values across neighbouring surfaces.
    this.readableDepth = rtt(depthAttachmentNode, null, null, { type: THREE.FloatType });
    this.readableDepth.name = 'Readable world depth';
    this.sceneDepthTexture = this.readableDepth.value;
    this.sceneDepthTexture.minFilter = THREE.NearestFilter;
    this.sceneDepthTexture.magFilter = THREE.NearestFilter;
    this.sceneDepthTexture.generateMipmaps = false;
    const sceneDepthNode = this.readableDepth;
    const skyLayers = new THREE.Layers();
    skyLayers.set(SKY_BACKDROP_LAYER);
    this.skyPass = pass(scene, camera, { depthBuffer: false, samples: 0 });
    this.skyPass.name = 'Atmosphere sky backdrop';
    this.skyPass.setLayers(skyLayers);
    // Sky is explicitly under the opaque world. A transparent sphere can no
    // longer cover terrain merely because its finite radius is closer.
    let colorNode = over(this.skyPass.getTextureNode('output'), sceneColor);

    this.volumePass = null;
    if (volume) {
      const layers = new THREE.Layers();
      layers.set(VOLUME_LAYER);
      this.volumePass = pass(scene, camera, { depthBuffer: false, samples: 0 });
      this.volumePass.name = 'Local volume layer';
      this.volumePass.setLayers(layers);
      this.volumePass.setResolutionScale(volumeScale);
      const volumeTexture = this.volumePass.getTextureNode('output');
      const guidedVolume = depthGuidedVolumeUpsample(
        volumeTexture,
        sceneDepthNode,
        {
          uVolumeResolution: this._volumeResolution,
          uCameraNear: this._volumeNear,
          uCameraFar: this._volumeFar,
          uDepthReversed: this._volumeDepthReversed,
        },
      );
      // Full-resolution volume needs no reconstruction. Keeping the direct
      // path also makes scale=1 an exact reference for visual diagnostics.
      const reconstructedVolume = mix(
        volumeTexture.sample(screenUV),
        guidedVolume,
        this._volumeUpsample,
      );
      colorNode = over(colorNode, reconstructedVolume);
    }
    this._syncVolumeResolution();

    // Travel distortion owns the complete world image. Applying it before
    // atmosphere/cloud compositing left the solid planet warped while its
    // participating media stayed pinned to the screen.
    this.worldBase = rtt(colorNode);
    this.sunShafts = createSunShaftNode(
      this.worldBase,
      sceneDepthNode,
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

  _syncVolumeResolution() {
    this.renderer.getDrawingBufferSize(this._volumeResolution.value);
    this._volumeResolution.value.multiplyScalar(this.volumeScale).floor();
    this._volumeResolution.value.max(new THREE.Vector2(1, 1));
    this._volumeNear.value = this.camera.near;
    this._volumeFar.value = this.camera.far;
    this._volumeDepthReversed.value = this.renderer.reversedDepthBuffer ? 1 : 0;
  }

  setSize() {
    // PassNode and BloomNode follow the renderer drawing-buffer size.
    this._syncVolumeResolution();
  }

  setVolumeScale(scale) {
    this.volumeScale = THREE.MathUtils.clamp(scale, 0.3, 1);
    this.volumePass?.setResolutionScale(this.volumeScale);
    this._volumeUpsample.value = this.volumeScale < 0.999 ? 1 : 0;
    this._syncVolumeResolution();
  }

  setSunShafts({ x = 0.5, y = 0.5, strength = 0, color = null } = {}) {
    this.sunShafts.uniforms.uSunUv.value.set(x, y);
    this.sunShafts.uniforms.uStrength.value = THREE.MathUtils.clamp(strength, 0, 1);
    if (color) this.sunShafts.uniforms.uTint.value.copy(color);
  }

  bindVolumeDepth(planet) {
    if (!planet || !this.volumePass) return false;
    this._syncVolumeResolution();
    let bound = false;
    const targets = [
      planet.atmoUniforms || planet.atmoMesh?.material?.uniforms,
      planet.volCloudUniforms || planet.volCloudMat?.uniforms,
    ];
    for (const uniforms of targets) {
      if (!uniforms?.tSceneDepth || !uniforms?.uDepthReady) continue;
      uniforms.tSceneDepth.value = this.sceneDepthTexture;
      uniforms.uDepthReady.value = 1;
      if (uniforms.uCameraNear) uniforms.uCameraNear.value = this.camera.near;
      if (uniforms.uCameraFar) uniforms.uCameraFar.value = this.camera.far;
      if (uniforms.uVolumeSize?.value) {
        this.renderer.getDrawingBufferSize(uniforms.uVolumeSize.value);
        // PassNode rounds its physical render target to integer texels. Keep
        // shader reconstruction on that exact grid; fractional sizes shift
        // depth-guided taps by a sub-texel while the camera moves.
        uniforms.uVolumeSize.value.multiplyScalar(this.volumeScale).floor();
        uniforms.uVolumeSize.value.max(new THREE.Vector2(1, 1));
      }
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

  async compileWorldObjectAsync(object) {
    if (!object) return;
    const currentRenderTarget = this.renderer.getRenderTarget();
    const currentMRT = this.renderer.getMRT();
    const compilePass = async (renderPass) => {
      this.renderer.setRenderTarget(renderPass.renderTarget);
      this.renderer.setMRT(renderPass._mrt);
      const compilation = this.renderer.compileAsync(
        object,
        this.camera,
        renderPass.scene,
      );
      // Renderer.compileAsync captures its render context before its first
      // await. Restore the live frame target immediately so route-time async
      // compilation cannot redirect an intervening animation frame.
      this.renderer.setRenderTarget(currentRenderTarget);
      this.renderer.setMRT(currentMRT);
      await compilation;
    };
    // A world object participates in two production contexts: visible 4x MSAA
    // color and single-sample opaque depth. WebGPU keys RenderObjects/pipelines
    // by render context, so warming only the color pass still leaves hundreds
    // of destination chunks cold when the depth pass first sees them.
    // Capture both production contexts before yielding. Route-time callers may
    // temporarily expose destination lights/materials for this exact topology;
    // awaiting the color pass first let the live source scene leak back into
    // the depth compile and left half of the hand-off pipelines cold.
    const sceneCompilation = compilePass(this.scenePass);
    const depthCompilation = compilePass(this.depthPass);
    await Promise.all([sceneCompilation, depthCompilation]);
  }

  async compileAsync() {
    await this.skyPass.compileAsync(this.renderer);
    await this.scenePass.compileAsync(this.renderer);
    await this.depthPass.compileAsync(this.renderer);
    if (this.volumePass) await this.volumePass.compileAsync(this.renderer);
    await this.foregroundPass.compileAsync(this.renderer);
    this.pipeline.render();
  }

  dispose() {
    this.skyPass.dispose();
    this.scenePass.dispose();
    this.depthPass.dispose();
    this.readableDepth.dispose();
    this.volumePass?.dispose();
    this.worldBase?.dispose();
    this.worldComposite?.dispose();
    this.foregroundPass.dispose();
    this.bloomNode.dispose();
    this.pipeline.dispose();
  }
}

// A rift preview is a second camera into the same physical destination, not a
// translucent billboard. Keep a compact copy of the production world graph so
// its opaque depth, sky backdrop and local-volume ownership match the frame
// rendered immediately after crossing. The optional full-screen travel,
// foreground and bloom stages are intentionally omitted: the portal surface
// participates in those stages once, as part of the main camera's frame.
export class RiftPortalNodePipeline {
  constructor(renderer, scene, camera, target, {
    volume = false,
    volumeScale = 0.67,
  } = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.target = target;
    this.volumeScale = volumeScale;
    this._baseScale = 1;
    this._volumeResolution = uniform(new THREE.Vector2(1, 1));
    this._volumeUpsample = uniform(volumeScale < 0.999 ? 1 : 0);
    this._volumeNear = uniform(camera.near);
    this._volumeFar = uniform(camera.far);
    this._volumeDepthReversed = uniform(renderer.reversedDepthBuffer ? 1 : 0);

    this.pipeline = new THREE.RenderPipeline(renderer);
    // The target is half-float linear HDR. The main pipeline owns the single
    // display transform after sampling it through the aperture.
    this.pipeline.outputColorTransform = false;

    const worldLayers = new THREE.Layers();
    this.scenePass = pass(scene, camera, { samples: 4 });
    this.scenePass.name = 'Rift destination world';
    this.scenePass.setLayers(worldLayers);
    const sceneColor = this.scenePass.getTextureNode('output');

    this.depthPass = pass(scene, camera, { samples: 0 });
    this.depthPass.name = 'Rift destination depth';
    this.depthPass.setLayers(worldLayers);
    this.depthPass.transparent = false;
    const depthAttachmentNode = this.depthPass.getTextureNode('depth');
    this.readableDepth = rtt(depthAttachmentNode, null, null, { type: THREE.FloatType });
    this.readableDepth.name = 'Rift readable depth';
    this.sceneDepthTexture = this.readableDepth.value;
    this.sceneDepthTexture.minFilter = THREE.NearestFilter;
    this.sceneDepthTexture.magFilter = THREE.NearestFilter;
    this.sceneDepthTexture.generateMipmaps = false;
    const sceneDepthNode = this.readableDepth;

    const skyLayers = new THREE.Layers();
    skyLayers.set(SKY_BACKDROP_LAYER);
    this.skyPass = pass(scene, camera, { depthBuffer: false, samples: 0 });
    this.skyPass.name = 'Rift atmosphere backdrop';
    this.skyPass.setLayers(skyLayers);
    let colorNode = over(this.skyPass.getTextureNode('output'), sceneColor);

    this.volumePass = null;
    if (volume) {
      const volumeLayers = new THREE.Layers();
      volumeLayers.set(VOLUME_LAYER);
      this.volumePass = pass(scene, camera, { depthBuffer: false, samples: 0 });
      this.volumePass.name = 'Rift local volume';
      this.volumePass.setLayers(volumeLayers);
      const volumeTexture = this.volumePass.getTextureNode('output');
      const guidedVolume = depthGuidedVolumeUpsample(
        volumeTexture,
        sceneDepthNode,
        {
          uVolumeResolution: this._volumeResolution,
          uCameraNear: this._volumeNear,
          uCameraFar: this._volumeFar,
          uDepthReversed: this._volumeDepthReversed,
        },
      );
      const reconstructedVolume = mix(
        volumeTexture.sample(screenUV),
        guidedVolume,
        this._volumeUpsample,
      );
      colorNode = over(colorNode, reconstructedVolume);
    }

    this.pipeline.outputNode = colorNode;
    this._syncResolution();
  }

  _syncResolution() {
    const drawingSize = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(drawingSize);
    const targetWidth = Math.max(1, this.target?.width || drawingSize.x);
    const targetHeight = Math.max(1, this.target?.height || drawingSize.y);
    this._baseScale = Math.min(
      targetWidth / Math.max(1, drawingSize.x),
      targetHeight / Math.max(1, drawingSize.y),
    );
    for (const renderPass of [this.scenePass, this.depthPass, this.skyPass]) {
      renderPass.setResolutionScale(this._baseScale);
    }
    this.volumePass?.setResolutionScale(this._baseScale * this.volumeScale);
    this._volumeResolution.value.set(drawingSize.x, drawingSize.y)
      .multiplyScalar(this._baseScale * this.volumeScale).floor()
      .max(new THREE.Vector2(1, 1));
    this._volumeNear.value = this.camera.near;
    this._volumeFar.value = this.camera.far;
    this._volumeDepthReversed.value = this.renderer.reversedDepthBuffer ? 1 : 0;
  }

  setVolumeScale(scale) {
    this.volumeScale = THREE.MathUtils.clamp(scale, 0.3, 1);
    this._volumeUpsample.value = this.volumeScale < 0.999 ? 1 : 0;
    this._syncResolution();
  }

  bindVolumeDepth(planet) {
    if (!planet || !this.volumePass) return false;
    this._syncResolution();
    let bound = false;
    const targets = [
      planet.atmoUniforms || planet.atmoMesh?.material?.uniforms,
      planet.volCloudUniforms || planet.volCloudMat?.uniforms,
    ];
    for (const uniforms of targets) {
      if (!uniforms?.tSceneDepth || !uniforms?.uDepthReady) continue;
      uniforms.tSceneDepth.value = this.sceneDepthTexture;
      uniforms.uDepthReady.value = 1;
      if (uniforms.uCameraNear) uniforms.uCameraNear.value = this.camera.near;
      if (uniforms.uCameraFar) uniforms.uCameraFar.value = this.camera.far;
      if (uniforms.uVolumeSize?.value) {
        uniforms.uVolumeSize.value.copy(this._volumeResolution.value);
      }
      if (uniforms.uDepthReversed) {
        uniforms.uDepthReversed.value = this.renderer.reversedDepthBuffer ? 1 : 0;
      }
      bound = true;
    }
    return bound;
  }

  render() {
    this._syncResolution();
    this.pipeline.render();
  }

  dispose() {
    this.skyPass.dispose();
    this.scenePass.dispose();
    this.depthPass.dispose();
    this.readableDepth.dispose();
    this.volumePass?.dispose();
    this.pipeline.dispose();
  }
}
