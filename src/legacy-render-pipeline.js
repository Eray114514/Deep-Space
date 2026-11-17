import * as THREE from 'three';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ForegroundPass } from './foreground-pass.js';
import { VolumetricPass, lightBatchNoLongerPrepared } from './volumetric-pass-webgl.js';
import { LiteCloudPass } from './cloud/lite-cloud-pass.js';
import { AtmospherePass } from './atmosphere-pass-webgl.js';
import { TransitShader } from './transit-shader.js';
import { PortalCompositePass } from './portal/portal-composite-pass.js';
import { BlackHolePass } from './black-hole-pass.js';
import { gradePass } from './halcyon/gfx/grade.js';
import { hardenBloom } from './halcyon/gfx/sanitize.js';
import {CloudLightBank} from './cloud/cloud-light-bank.js';
import { prepareCloudSunPrograms } from './cloud/cloud-sun-programs.js';
import {CloudSurfaceShadowPass} from './cloud/cloud-surface-shadow-pass.js';
import {RenderProfiler} from './render-profiler.js';
import {GpuWorkBudget} from './gpu-work-budget.js';
import {GpuFramePacer} from './gpu-frame-pacer.js';
import {GpuPreparationQueue} from './gpu-preparation-queue.js';
import {withPreparedShadows} from './render-shadow-state.js';
import { RenderFrameState } from './render-frame-state.js';
import { compilePrograms } from './program-preparation.js';
import { CloudProgramPreparation } from './cloud-program-preparation.js';
import { TemporalAAPass } from './temporal-aa-pass.js';


// Exact WebGL production chain from the pre-WebGPU renderer. The small alias
// layer keeps the current game state machine renderer-agnostic without
// changing the authored GLSL passes.
export class GameLegacyPipeline {
  constructor(renderer, scene, camera, {
    volume = false,
    liteClouds = false,
    liteCloudOptions = {},
    cloudProgramPreparation = false,
    cloudFarSplit = false,
    volumeScale = 0.67,
    bloomEnabled = true,
    bloomStrength = 0.5,
    bloomRadius = 0.4,
    bloomThreshold = 1.05,
    foregroundLayer = 1,
    interiorLayer = null,
    realisticGrade = false,
    temporalAA = false,
  } = {}) {
    this.renderer = renderer;
    this.framePacer = null;
    this.frameSubmissionActive = false;
    this.preparationTurn = true;
    this.preparations = new GpuPreparationQueue(renderer, {
      submit: () => this.#submitFrame(() => {}, true),
    });
    this.scene = scene;
    this.camera = camera;
    this.frameState = new RenderFrameState();
    this.programPreparation = new AbortController();
    this.cloudProgramsEnabled = cloudProgramPreparation || cloudFarSplit;
    this.cloudPrograms = new CloudProgramPreparation(renderer, {
      prepare: (work, options) => this.prepare(work, options), signal: this.programPreparation.signal,
    });
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
      this.cloudReceiverPreparation?.controller.abort();
      this.cloudReceiverPreparation = null;
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.volumePass?.releaseTargets();
      this.cloudPass?.releaseTargets();
      this.temporalAA?.releaseTargets();
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
      if (cloudFarSplit) this.volumePass.enableFarSplit(renderer);
      this.volumePass.sceneDepthSource = this.atmospherePass;
      this.composer.addPass(this.volumePass);
    }

    // Default cloud renderer: one low-resolution shell march, composited over
    // the lit scene. The legacy VolumetricPass above only exists with ?clouds=legacy.
    this.cloudPass = liteClouds ? new LiteCloudPass(camera, this.atmospherePass, liteCloudOptions) : null;
    if (this.cloudPass) this.composer.addPass(this.cloudPass);

    // Relativistic black hole & background star lensing (enabled only when a
    // compact object is visible in the scene; zero cost in planetary systems).
    this.blackHolePass = new BlackHolePass(camera, this.atmospherePass);
    this.composer.addPass(this.blackHolePass);

    // Portal openings: the far side (rendered by a second pipeline instance)
    // replaces the pixels whose view ray meets the opening before any opaque
    // geometry. Linear HDR, so both spaces share the display transforms below.
    this.portalComposite = new PortalCompositePass(camera);
    this.composer.addPass(this.portalComposite);

    // Pulse/warp transit: tunnel, fold and motion blur of the lit scene. It
    // runs before the foreground ship pass so the hull stays in front of it.
    this.warp = new ShaderPass(TransitShader);
    this.warp.enabled = false;
    this.composer.addPass(this.warp);

    this.foregroundPass = new ForegroundPass(
      scene, camera,
      interiorLayer === null ? foregroundLayer : [foregroundLayer, interiorLayer],
    );
    this.composer.addPass(this.foregroundPass);

    this.temporalAA = new TemporalAAPass(camera, this.frameState, { foregroundLayer });
    this.temporalAA.sceneDepthSource = this.atmospherePass;
    this.temporalAA.volumeSource = this.volumePass;
    this.composer.addPass(this.temporalAA);

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
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
    // grade pass (radial CA / vignette / film grain): display-referred lens
    // character, so it runs after the tonemap in OutputPass.
    this.grade = gradePass({ realistic: realisticGrade });
    this.smaa = !matchMedia('(pointer: coarse)').matches
      ? new SMAAPass()
      : null;
    if (this.smaa) {
      // Catch low-contrast wing edges and panel boundaries in display space.
      // Apply grain afterwards so it cannot mask or trigger edge detection.
      this.smaa._materialEdges.defines.SMAA_THRESHOLD = '0.05';
      this.composer.addPass(this.smaa);
    }
    this.composer.addPass(this.grade);
    if (temporalAA) this.setTemporalAAEnabled(true);
    renderer.info.autoReset = false;
  }

  setTemporalAAEnabled(enabled, { debugMode } = {}) {
    const next = Boolean(enabled);
    const changed = next !== this.temporalAA.enabled;
    this.temporalAA.enabled = next;
    this.frameState.jitterEnabled = next;
    if (this.volumePass) this.volumePass.externalTaaActive = next;
    if (this.smaa) this.smaa.enabled = !next;
    if (debugMode !== undefined) this.temporalAA.setDebugMode(debugMode);
    if (changed) this.invalidateTemporalHistory('taa-toggle');
    return this.temporalState();
  }

  temporalState() {
    return {
      enabled: Boolean(this.temporalAA?.enabled),
      debugMode: this.temporalAA?.debugMode || 'off',
      jitterEnabled: Boolean(this.frameState.jitterEnabled),
      jitterPixels: this.frameState.previous.jitterPixels.toArray(),
      historyValid: Boolean(this.temporalAA?.historyValid),
      sequence: this.frameState.sequence,
      epoch: this.frameState.epoch,
      reason: this.frameState.reason,
      exposure: this.frameState.previous.exposure,
    };
  }

  setSize(width, height, dpr = 1) {
    this.invalidateTemporalHistory('resize');
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
  }

  setVolumeScale(scale) {
    if (!this.volumePass) return;
    const next = THREE.MathUtils.clamp(scale, 0.3, 1);
    if (next !== this.volumePass.scale) this.invalidateTemporalHistory('volume-scale');
    this.volumePass.scale = next;
  }

  setActiveAtmosphere(planet, nav) {
    this.atmospherePass.setActivePlanet(planet, nav);
    this.cloudPass?.setActivePlanet(this.atmospherePass.activePlanet);
  }

  invalidateTemporalHistory(reason = 'explicit') {
    this.frameState.invalidate(reason);
    this.volumePass?.resetHistory();
    this.cloudPass?.resetHistory();
    this.temporalAA?.resetHistory();
  }

  invalidateVolumeHistory(reason = 'explicit') {
    this.invalidateTemporalHistory(reason);
  }

  // All synchronous views of this renderer share one admission and completion
  // fence. A startup-only submission may omit draw; it must not publish world
  // history or count as a presented frame. No scene lease survives this scope.
  submitFrame(work) {
    this.preparations.noteForeground();
    return this.#submitFrame(work);
  }

  prepare(work, options) {
    return this.preparations.enqueue(work, options);
  }

  #submitFrame(work, maintenance = false) {
    if(typeof work!=='function')throw new TypeError('Frame submission requires synchronous work');
    if(this.frameSubmissionActive)throw Error('Frame submission is already active');
    const pacer=this.framePacer;
    let failed=false,failure,active=true,drawn=false,admitted=false,preparation=null,worldBlocked=false;
    this.frameSubmissionActive=true;
    try {
      // Admission itself calls native queries, whose observers may stop or
      // replace the public owner. They cannot reenter an unpaced submission.
      if(pacer&&!pacer.beginFrame()) {
        const status=pacer.snapshot();
        if(status.fault||status.disposed)this.preparations.fail(Error(`GPU preparation unavailable: ${status.fault||'disposed owner'}`));
        return false;
      }
      admitted=true;
      const target = this.renderer.getRenderTarget();
      const face = this.renderer.getActiveCubeFace(), mip = this.renderer.getActiveMipmapLevel();
      try {
        const draw=(options,privateFrame)=>{
          if(!active)throw Error('Frame draw is no longer active');
          if(drawn)throw Error('Frame has already been drawn');
          drawn=true;
          const rendered=this.#renderScene(options,privateFrame);
          if(rendered===false)worldBlocked=true;
          return rendered;
        };
        // A preparation owns the whole synchronous state lease. Alternate it
        // with foreground work, rather than draining a burst into one frame or
        // compiling against a private destination's borrowed lighting state.
        if(this.preparations.hasQueued&&(maintenance||this.preparationTurn)) {
          preparation=this.preparations.runNext(options=>draw(options,true));
          if(preparation) {
            this.preparationTurn=false;
            return maintenance;
          }
        }
        if(maintenance)return false;
        this.preparationTurn=true;
        const result=work(options=>draw(options,false));
        if(result&&typeof result.then==='function')throw new TypeError('Frame submission work must be synchronous');
      } catch(error) {
        failed=true;failure=error;throw error;
      } finally {
        active=false;
        // Auxiliary views must also restore their own visibility and camera
        // leases. This outer guard preserves the complete caller target tuple.
        try {this.renderer.setRenderTarget(target,face,mip);}
        catch(error){if(!failed){failed=true;failure=error;throw error;}}
      }
      return !worldBlocked;
    } catch(error) {
      failed=true;failure=error;throw error;
    } finally {
      active=false;
      // stop/dispose may detach this owner from inside any auxiliary view. Its
      // submitted work still belongs to the captured owner until this fence.
      try {
        if(pacer&&admitted)try {pacer.endFrame();} catch(error){if(!failed){failed=true;failure=error;throw error;}}
        if(preparation&&!failed&&pacer?.snapshot().fault) {
          failed=true;failure=Error('GPU preparation completion fence failed');
        }
      } finally {
        this.frameSubmissionActive=false;
        this.preparations.finish(preparation,{failed,error:failure});
      }
    }
  }

  render(options) {
    return this.submitFrame(draw=>draw(options));
  }

  // Internal world graph. Only submitFrame's one-use draw capability enters it.
  #renderScene({ origin = this.volumePass?.nav || this.camera.position, context = this.scene,
    timeEpoch = null, rigidObjects = null } = {}, privateFrame) {
    if(!privateFrame&&this.volumePass?.enabled&&this.volumePass.lightBatchesEnabled)
      this.volumePass.prefetchLightBatches(this.renderer,origin,(work,options)=>this.prepare(work,options));
    let batchOnly=false;
    if (this.cloudProgramsEnabled && this.volumePass?.enabled) {
      const volume = this.volumePass, requests = volume.requiredProgramRequests(origin, volume.farSplit);
      const plan = volume.farSplit?.plan, material = volume.activePlanet?.volCloudMat;
      const canPrefetch = plan && material && this.renderer.extensions?.has('KHR_parallel_shader_compile');
      const batchState=volume.lightBatchPrefetch?.state;
      const wantsBatch=!privateFrame&&volume.lightBatchesEnabled&&!this.requireDirectCloudPreparation
        &&batchState!=='unavailable'&&batchState!=='failed';
      const prefetch = canPrefetch&&!wantsBatch ? { mesh:plan.mesh, material } : null;
      batchOnly=wantsBatch&&volume.usesPreparedLightBatch(requests);
      const batchPreparing=!batchOnly&&wantsBatch
        &&(batchState==='queued'||batchState==='preparing')&&Boolean(volume.eligibleForLightBatch?.(requests));
      if (!this.cloudPrograms.ensure({ scene:this.scene, camera:this.camera, target:volume.current,
        requests:(batchOnly||batchPreparing)?[]:requests, prefetch })) return false;
      if (batchPreparing) return false;
      if (canPrefetch) {
        this.prefetchCloudLightingPrograms();
        this.prefetchCloudReceiverProgram();
      }
    }
    let failed=false;
    const target = this.renderer.getRenderTarget();
    const face = this.renderer.getActiveCubeFace(), mip = this.renderer.getActiveMipmapLevel();
    const bufW = this.composer.readBuffer?.width || 0;
    const bufH = this.composer.readBuffer?.height || 0;
    this.frameState.begin(this.camera, origin, {
      context,
      timeEpoch,
      body: this.volumePass?.activePlanet || this.atmospherePass?.activePlanet,
      exposure: this.renderer?.toneMappingExposure ?? 1,
      jitterWidth: !privateFrame && this.temporalAA?.enabled ? bufW : 0,
      jitterHeight: !privateFrame && this.temporalAA?.enabled ? bufH : 0,
    });
    let jitterApplied = false;
    try {
      try {
        if (!privateFrame && rigidObjects) this.frameState.captureRigidObjects(rigidObjects, this.scene);
        if (!privateFrame && this.temporalAA?.enabled) {
          jitterApplied = this.frameState.applyCameraJitter(this.camera);
        }
        if(batchOnly)this.volumePass.requirePreparedLightBatch=true;
        const body = this.volumePass?.activePlanet;
        const localEye = body?.volCloudMat?.uniforms.uCameraLocal;
        if (localEye) this.frameState.localEye(body, localEye.value);
        const airBody = this.atmospherePass.activePlanet;
        if (airBody) this.frameState.localEye(airBody, this.atmospherePass.material.uniforms.uCameraLocal.value);
        this.profiler?.beginFrame();
        this.columnWorkBudget?.beginFrame();
        // Opaque surface materials borrow the same transport as the later
        // atmosphere and volume passes, including the first frame of a body.
        if (this.atmospherePass.enabled && airBody)
          this.atmospherePass.prepareTransport(this.renderer, this.profiler);
        this.profilePhase('cloud-cache',()=>this.updateCloudLighting());
        // RenderPass writes readBuffer. Preserve the receiver depth in the other
        // target during that draw; sampling its own depth attachment is feedback.
        // The depth is no longer consumed once AtmospherePass reuses writeBuffer.
        this.cloudSurfaceShadow.render(this.renderer,this.composer.writeBuffer,
          this.volumePass?.activePlanet,this.profiler);
        if (this.blackHolePass && (this.scene?.userData?.blackHoles?.size || this.blackHolePass.activeBlackHole)) {
          this.blackHolePass.syncFromScene(this.scene);
        }
        this.composer.render();
      } catch(error) {
        failed=true;throw error;
      } finally {
        if (jitterApplied) this.frameState.restoreCameraProjection(this.camera);
        if(batchOnly)this.volumePass.requirePreparedLightBatch=false;
        if (this.volumePass?.farSplit) this.volumePass.farSplit.plan = null;
        try {this.renderer.setRenderTarget(target, face, mip);}
        catch(error){if(!failed)throw error;}
      }
      if(privateFrame) {
        // The private graph may overwrite a history attachment, but its pose
        // and sampling phase must never become the previous player frame.
        this.frameState.abort('private-prewarm');
        this.volumePass?.resetHistory();
        this.temporalAA?.resetHistory();
      } else {
        this.frameState.commit();
        this.requireDirectCloudPreparation=false;
      }
    } catch (error) {
      this.frameState.abort();
      this.volumePass?.resetHistory();
      this.temporalAA?.resetHistory();
      if(error===lightBatchNoLongerPrepared) {
        this.requireDirectCloudPreparation=true;
        return false;
      }
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
        bank=new CloudLightBank(p,{interval:0.1,lazyBootstrap:true,programOwner:this.cloudLightPrograms});this.cloudLightBanks.set(p,bank);p.cloudLightBank=bank;
      }
      bank.update(this.renderer);
    }
  }

  primeCloudPrograms({ origin = this.volumePass?.nav || this.camera.position } = {}) {
    if (!this.cloudProgramsEnabled || !this.volumePass?.enabled) return;
    const volume = this.volumePass, requests = volume.requiredProgramRequests(origin, volume.farSplit);
    const plan = volume.farSplit?.plan, material = volume.activePlanet?.volCloudMat;
    const canPrefetch = plan && material && this.renderer.extensions?.has('KHR_parallel_shader_compile');
    const wantsBatch = volume.lightBatchesEnabled && !this.requireDirectCloudPreparation;
    const prefetch = canPrefetch && !wantsBatch ? { mesh: plan.mesh, material } : null;
    this.cloudPrograms.ensure({ scene: this.scene, camera: this.camera, target: volume.current, requests, prefetch });
    if (canPrefetch) {
      this.prefetchCloudLightingPrograms();
      this.prefetchCloudReceiverProgram();
    }
    if (volume.lightBatchesEnabled) {
      volume.prefetchLightBatches(this.renderer, origin, (work, options) => this.prepare(work, options));
    }
  }

  prefetchCloudReceiverProgram() {
    if (this.cloudReceiverPreparation || !this.renderer.extensions?.has('KHR_parallel_shader_compile')) return;
    const body = this.volumePass?.activePlanet;
    const source = body?.volCloudMat?.uniforms;
    if (!source || !this.cloudSurfaceShadow?.material) return;
    const controller = new AbortController(), { signal } = controller;
    const job = { controller, state: 'pending' };
    this.cloudReceiverPreparation = job;
    this.prepare(() => {
      const pass = this.cloudSurfaceShadow;
      const u = pass.material.uniforms;
      for (const [name, uniform] of Object.entries(source)) if (!(name in u)) u[name] = uniform;
      u.uCameraLocal ??= { value: new THREE.Vector3() };
      u.uInvProjection ??= { value: new THREE.Matrix4() };
      u.uViewToLocal ??= { value: new THREE.Matrix3() };
      u.uShadowSize ??= { value: new THREE.Vector2(1, 1) };
      u.uDepthSize ??= { value: new THREE.Vector2(1, 1) };
      u.tOpaqueDepth ??= { value: this.composer.writeBuffer?.depthTexture || null };
      u.uCameraFar ??= { value: this.camera.far };
      u.uReceiverBound ??= { value: body.R + 1000 };
      u.uReceiverId ??= { value: 1 };
      const saved = this.renderer.getRenderTarget(), face = this.renderer.getActiveCubeFace(), mip = this.renderer.getActiveMipmapLevel();
      try {
        this.renderer.setRenderTarget(pass.target);
        return compilePrograms(this.renderer, pass.quad._mesh, this.camera, null, { signal });
      } finally {
        this.renderer.setRenderTarget(saved, face, mip);
      }
    }, { signal, label: 'cloud-receiver-program' }).then(() => {
      if (!signal.aborted) job.state = 'ready';
    }).catch(error => {
      if (!signal.aborted) { job.state = 'failed'; job.error = String(error); }
      controller.abort();
    });
  }

  prefetchCloudLightingPrograms() {
    if (this.cloudLightPreparation || this.cloudLightPrograms.sweep) return;
    const controller = new AbortController(), {signal} = controller;
    const job = {controller,state:'pending'};
    this.cloudLightPreparation = job;
    this.prepare(() => prepareCloudSunPrograms(this.renderer,signal), {signal,label:'cloud-light-cache-programs'}).then(programs => {
      for (const [key,material] of Object.entries(programs)) {
        if (signal.aborted || this.cloudLightPrograms[key]) material.dispose();
        else this.cloudLightPrograms[key] = material;
      }
      if (!signal.aborted) job.state = 'ready';
    }).catch(error => {
      if (!signal.aborted) { job.state = 'failed';job.error = String(error); }
      controller.abort();
    });
  }

  async compileAsync() {
    const signal=this.programPreparation.signal;
    await this.prepare(()=>compilePrograms(this.renderer,this.scene,this.camera,null,{signal}),
      {signal,label:'pipeline-programs'});
  }

  prewarmPostPasses({ signal = this.programPreparation.signal, isCurrent } = {}) {
    return this.prepare(() => {
      if (this.atmospherePass?.activePlanet) {
        this.atmospherePass.prepareTransport(this.renderer);
      }
      const group = new THREE.Group();
      const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const seen = new Set();
      const addQuad = (quad) => {
        const mesh = quad?._mesh || (quad?.isMesh ? quad : null);
        if (!mesh?.geometry || !mesh.material || seen.has(mesh.material)) return;
        seen.add(mesh.material);
        const wrapper = new THREE.Mesh(mesh.geometry, mesh.material);
        wrapper.frustumCulled = false;
        group.add(wrapper);
      };
      addQuad(this.atmospherePass?.quad);
      if (this.cloudPass) {
        for (const value of Object.values(this.cloudPass)) {
          if (value && typeof value === 'object' && ('_mesh' in value || value.isMesh)) addQuad(value);
        }
      }
      addQuad(this.grade?.fsQuad);
      addQuad(this.warp?.fsQuad);
      addQuad(this.blackHolePass?.quad);
      addQuad(this.portalComposite?.quad);
      if (!group.children.length) return Promise.resolve(group);
      const saved = this.renderer.getRenderTarget();
      const face = this.renderer.getActiveCubeFace(), mip = this.renderer.getActiveMipmapLevel();
      try {
        this.renderer.setRenderTarget(this.composer.writeBuffer);
        return compilePrograms(this.renderer, group, ortho, null, { signal });
      } finally {
        this.renderer.setRenderTarget(saved, face, mip);
        group.clear();
      }
    }, { signal, label: 'startup-post-passes', isCurrent });
  }

  releaseCloudLightPrograms() {
    // These two empty-uniform material leases retain only the stable sweep/R8
    // copy programs across bank, weather and body replacement. They are never
    // drawn with another snapshot's data. Epoch/context teardown owns release.
    this.cloudLightPreparation?.controller.abort();this.cloudLightPreparation=null;
    for(const material of Object.values(this.cloudLightPrograms))material.dispose();
    this.cloudLightPrograms={};
  }

  dispose() {
    this.cloudReceiverPreparation?.controller.abort();
    this.cloudReceiverPreparation = null;
    this.cloudPrograms.dispose();
    this.preparations.dispose();
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
    this.cloudPass?.dispose();
    this.temporalAA?.dispose();
    this.atmospherePass.dispose();
    this.blackHolePass?.dispose?.();
    this.parkedInteriorPass?.dispose?.();
    this.foregroundPass.dispose?.();
    this.target.dispose();
  }
}
