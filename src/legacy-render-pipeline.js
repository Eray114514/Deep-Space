import * as THREE from 'three';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ForegroundPass } from './foreground-pass.js';
import { VolumetricPass } from './volumetric-pass-webgl.js';
import { AtmospherePass } from './atmosphere-pass-webgl.js';
import { RiftDistortionShader, WarpDriveShader } from './legacy-post-shaders.js';
import { gradePass } from './halcyon/gfx/grade.js';
import { hardenBloom } from './halcyon/gfx/sanitize.js';
import {CloudLightBank} from './cloud/cloud-light-bank.js';
import {CloudSurfaceShadowPass} from './cloud/cloud-surface-shadow-pass.js';
import {RenderProfiler} from './render-profiler.js';
import {GpuWorkBudget} from './gpu-work-budget.js';
import {GpuFramePacer} from './gpu-frame-pacer.js';
import {withPreparedShadows} from './render-shadow-state.js';
import { RenderFrameState } from './render-frame-state.js';
import { compilePrograms } from './program-preparation.js';

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
    interiorLayer = null,
    realisticGrade = false,
  } = {}) {
    this.renderer = renderer;
    this.framePacer = null;
    this.frameSubmissionActive = false;
    this.scene = scene;
    this.camera = camera;
    this.frameState = new RenderFrameState();
    this.programPreparation = new AbortController();
    this.cloudLightBanks=new Map();this.cloudLightFrame=0;this.cloudLightPrograms={};
    this.cloudSurfaceShadow=new CloudSurfaceShadowPass(scene,camera);
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
    this.onContextLost = () => {
      this.frameState.abort('context-lost');
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.volumePass?.releaseTargets();
      for(const bank of this.cloudLightBanks.values())bank.dispose();this.cloudLightBanks.clear();
      this.releaseCloudLightPrograms();
      this.cloudSurfaceShadow.dispose();
    };
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderPass = new RenderPass(scene, camera);
    const renderOpaque=this.renderPass.render;
    this.renderPass.render=(...args)=>{
      try {return withPreparedShadows(this.renderer,this.cloudSurfaceShadow.depthValid,
        ()=>renderOpaque.apply(this.renderPass,args));}
      finally {this.cloudSurfaceShadow.depthValid=false;}
    };
    this.composer.addPass(this.renderPass);

    // Parked ships participate in the world depth buffer, but their cabin
    // still needs an isolated light list. Render the cabin after the opaque
    // world without clearing depth, before participating media consumes it.
    this.parkedInteriorPass = interiorLayer === null ? null
      : new ForegroundPass(scene, camera, interiorLayer, { clearDepth: false });
    if (this.parkedInteriorPass) this.composer.addPass(this.parkedInteriorPass);

    // Full-resolution air transmittance/scattering owns the opaque depth. The
    // half-resolution pass after it integrates the cloud/air correction.
    this.atmospherePass = new AtmospherePass(camera);
    this.composer.addPass(this.atmospherePass);

    this.volumePass = volume ? new VolumetricPass(scene, camera, { scale: volumeScale, frameState: this.frameState }) : null;
    if (this.volumePass) {
      this.volumePass.sceneDepthSource = this.atmospherePass;
      this.composer.addPass(this.volumePass);
    }

    this.warp = new ShaderPass(WarpDriveShader);
    this.warp.enabled = false;
    aliasUniforms(this.warp.uniforms, {
      time: 'uTime', warp: 'uWarp', pulse: 'uPulse', arrival: 'uArrival', aspect: 'uAspect',
    });
    this.composer.addPass(this.warp);

    this.foregroundPass = new ForegroundPass(
      scene, camera,
      interiorLayer === null ? foregroundLayer : [foregroundLayer, interiorLayer],
    );
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
    // Harden the bloom high-pass against NaN/Inf coming from additive surfaces
    // that can straddle the near plane (engine plumes, canopy glass, the
    // ramp's force field). Without this one bad pixel blacks out the whole
    // frame through the bloom downsample chain — see halcyon/gfx/sanitize.js.
    hardenBloom(this.bloom, 64);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // grade pass (radial CA / vignette / film grain): display-referred lens
    // character, so it runs after the tonemap in OutputPass.
    this.grade = gradePass({ realistic: realisticGrade });
    this.composer.addPass(this.grade);
    this.smaa = !matchMedia('(pointer: coarse)').matches
      ? new SMAAPass(1, 1)
      : null;
    if (this.smaa) this.composer.addPass(this.smaa);
    renderer.info.autoReset = false;
  }

  setSize(width, height, dpr = 1) {
    this.frameState.invalidate('resize');
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
  }

  setVolumeScale(scale) {
    if (!this.volumePass) return;
    this.volumePass.scale = THREE.MathUtils.clamp(scale, 0.3, 1);
  }

  setActiveAtmosphere(planet, nav) {
    this.atmospherePass.setActivePlanet(planet, nav);
  }

  invalidateVolumeHistory(reason = 'explicit') {
    this.frameState.invalidate(reason);
    this.volumePass?.resetHistory();
  }

  // All synchronous views of this renderer share one admission and completion
  // fence. A startup-only submission may omit draw; it must not publish world
  // history or count as a presented frame. No scene lease survives this scope.
  submitFrame(work) {
    if(typeof work!=='function')throw new TypeError('Frame submission requires synchronous work');
    if(this.frameSubmissionActive)throw Error('Frame submission is already active');
    const pacer=this.framePacer;
    let failed=false,active=true,drawn=false,admitted=false;
    this.frameSubmissionActive=true;
    try {
      // Admission itself calls native queries, whose observers may stop or
      // replace the public owner. They cannot reenter an unpaced submission.
      if(pacer&&!pacer.beginFrame())return false;
      admitted=true;
      const target = this.renderer.getRenderTarget();
      const face = this.renderer.getActiveCubeFace(), mip = this.renderer.getActiveMipmapLevel();
      try {
        const result=work(options=>{
          if(!active)throw Error('Frame draw is no longer active');
          if(drawn)throw Error('Frame has already been drawn');
          drawn=true;
          return this.#renderScene(options);
        });
        if(result&&typeof result.then==='function')throw new TypeError('Frame submission work must be synchronous');
      } catch(error) {
        failed=true;throw error;
      } finally {
        active=false;
        // Auxiliary views must also restore their own visibility and camera
        // leases. This outer guard preserves the complete caller target tuple.
        try {this.renderer.setRenderTarget(target,face,mip);}
        catch(error){if(!failed){failed=true;throw error;}}
      }
      return true;
    } catch(error) {
      failed=true;throw error;
    } finally {
      active=false;
      // stop/dispose may detach this owner from inside any auxiliary view. Its
      // submitted work still belongs to the captured owner until this fence.
      try {
        if(pacer&&admitted)try {pacer.endFrame();} catch(error){if(!failed)throw error;}
      } finally {this.frameSubmissionActive=false;}
    }
  }

  render(options) {
    return this.submitFrame(draw=>draw(options));
  }

  // Internal world graph. Only submitFrame's one-use draw capability enters it.
  #renderScene({ origin = this.volumePass?.nav || this.camera.position, context = this.scene, timeEpoch = null } = {}) {
    let failed=false;
    const target = this.renderer.getRenderTarget();
    const face = this.renderer.getActiveCubeFace(), mip = this.renderer.getActiveMipmapLevel();
    this.frameState.begin(this.camera, origin, { context, timeEpoch, body: this.volumePass?.activePlanet });
    try {
      try {
        const body = this.volumePass?.activePlanet;
        const localEye = body?.volCloudMat?.uniforms.uCameraLocal;
        if (localEye) this.frameState.localEye(body, localEye.value);
        const airBody = this.atmospherePass.activePlanet;
        if (airBody) this.frameState.localEye(airBody, this.atmospherePass.material.uniforms.uCameraLocal.value);
        this.profiler?.beginFrame();
        this.columnWorkBudget?.beginFrame();
        this.profilePhase('cloud-cache',()=>this.updateCloudLighting());
        // RenderPass writes readBuffer. Preserve the receiver depth in the other
        // target during that draw; sampling its own depth attachment is feedback.
        // The depth is no longer consumed once AtmospherePass reuses writeBuffer.
        this.cloudSurfaceShadow.render(this.renderer,this.composer.writeBuffer,
          this.volumePass?.activePlanet,this.profiler);
        this.composer.render();
      } catch(error) {
        failed=true;throw error;
      } finally {
        try {this.renderer.setRenderTarget(target, face, mip);}
        catch(error){if(!failed)throw error;}
      }
      this.frameState.commit();
    } catch (error) {
      this.frameState.abort();
      this.volumePass?.resetHistory();
      throw error;
    }
    return true;
  }

  startFramePacing() {
    if(this.framePacer)throw Error('Frame pacing is already enabled');
    const pacer=new GpuFramePacer(this.renderer);this.framePacer=pacer;return pacer;
  }

  stopFramePacing() {
    const pacer=this.framePacer;this.framePacer=null;pacer?.dispose();
  }

  profilePhase(name,work,options) {return this.profiler?this.profiler.run(name,work,options):work();}

  startProfiling(options={}) {
    this.stopProfiling();this.profiler=new RenderProfiler(this.renderer,options);
    if(this.volumePass)this.volumePass.profiler=this.profiler;
    this.profiledPasses=this.composer.passes.map((pass,index)=>{
      const render=pass.render,name=`${index}:${pass.constructor.name}`;
      // Retain the parent CPU total, including its children. Only the four
      // non-overlapping volume subphases own GPU intervals; do not sum the
      // inclusive parent CPU record with those child CPU records.
      const scope=pass===this.volumePass?{gpu:false}:undefined;
      pass.render=(...args)=>this.profilePhase(name,()=>render.apply(pass,args),scope);
      return {pass,render};
    });
  }

  stopProfiling() {
    for(const {pass,render} of this.profiledPasses||[])pass.render=render;
    if(this.volumePass)this.volumePass.profiler=null;
    this.profiledPasses=[];this.profiler?.dispose();this.profiler=null;
  }

  performanceSnapshot() {return this.profiler?.snapshot()||null;}

  startColumnWork({tileRows=64,footprintBatch=2,forecastSteps=3,cacheSteps=2,...options}={}) {
    if(!this.volumePass)throw Error('Column work requires a volume pass');
    if(this.columnWorkBudget)throw Error('Column work is already enabled');
    if(!Number.isInteger(tileRows)||tileRows<1||!Number.isInteger(footprintBatch)||footprintBatch<1
      ||![2,3].includes(forecastSteps)||![2,3].includes(cacheSteps)||cacheSteps>forecastSteps)throw Error('Invalid column work shape');
    const budget=new GpuWorkBudget(this.renderer,options);
    this.columnWorkBudget=budget;
    try {this.volumePass.configureColumnWork({budget,tileRows,footprintBatch,forecastSteps,cacheSteps});}
    catch(error) {if(this.columnWorkBudget===budget)this.columnWorkBudget=null;budget.dispose();throw error;}
    return budget;
  }

  stopColumnWork() {
    if(!this.columnWorkBudget)return;
    const budget=this.columnWorkBudget;this.columnWorkBudget=null;
    try {this.volumePass.configureColumnWork(null);} finally {budget.dispose();}
  }

  updateCloudLighting() {
    this.cloudLightFrame++;
    const p=this.volumePass?.activePlanet;
    const local=p?.volCloudMat?.uniforms.uCameraLocal.value;
    const eligible=p?.weatherField?.synoptic && p.weatherStream?.ready
      && local?.length()>0 && local.length()-p.R<200000;
    for(const [body,bank] of this.cloudLightBanks) {
      if(body===p && eligible) {bank.retireAt=null;continue;}
      bank.unbind();bank.retireAt??=this.cloudLightFrame+2;
      if(this.cloudLightFrame>=bank.retireAt) {bank.dispose();this.cloudLightBanks.delete(body);}
    }
    if(eligible) {
      let bank=this.cloudLightBanks.get(p);
      if(bank?.needsReset()) {bank.dispose();bank=null;this.cloudLightBanks.delete(p);}
      if(!bank || bank.disposed) {
        bank=new CloudLightBank(p,{programOwner:this.cloudLightPrograms});this.cloudLightBanks.set(p,bank);p.cloudLightBank=bank;
      }
      bank.update(this.renderer);
    }
  }

  async compileAsync() {
    await compilePrograms(this.renderer, this.scene, this.camera, null, {signal:this.programPreparation.signal});
  }

  releaseCloudLightPrograms() {
    // These two empty-uniform material leases retain only the stable sweep/R8
    // copy programs across bank, weather and body replacement. They are never
    // drawn with another snapshot's data. Epoch/context teardown owns release.
    for(const material of Object.values(this.cloudLightPrograms))material.dispose();
    this.cloudLightPrograms={};
  }

  dispose() {
    this.stopFramePacing();
    this.programPreparation.abort();
    this.stopProfiling();
    this.stopColumnWork();
    this.cloudSurfaceShadow.dispose();
    for(const bank of this.cloudLightBanks.values())bank.dispose();this.cloudLightBanks.clear();
    this.releaseCloudLightPrograms();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.composer.dispose();
    this.volumePass?.dispose();
    this.atmospherePass.dispose();
    this.parkedInteriorPass?.dispose?.();
    this.foregroundPass.dispose?.();
    this.target.dispose();
  }
}
