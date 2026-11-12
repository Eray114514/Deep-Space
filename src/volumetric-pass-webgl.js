// Half-resolution cloud pass with camera reprojection.
//
// Clouds are rendered into a smaller HDR target, reprojected from the previous
// frame and edge-aware upsampled. Physical atmosphere scattering owns a
// separate full-resolution depth-aware pass; this pass must not bind or render
// the legacy atmosphere shell.

import * as THREE from 'three';
import { CloudColumnBank, setCloudFarCacheEnabled } from './cloud/cloud-column-bank.js';
import {minimumCloudRayCone} from './cloud/cloud-footprint.js';
import {CloudLightBatchRenderer} from './cloud/cloud-light-batch-renderer.js';
import {planCloudLightBatches} from './cloud/cloud-light-batch-layout.js';
import { CloudFarSplitPass } from './cloud/cloud-far-split-pass.js';
import { encodeCandidateEmptyRuns } from './cloud/production-bands.js';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';
import { RenderFrameState } from './render-frame-state.js';
import { volumeHistoryGLSL } from './volume-history-glsl.js';

export const VOLUME_LAYER = 2;
export const lightBatchNoLongerPrepared = Symbol('light-batch-no-longer-prepared');

const _clear = new THREE.Color();
const _savedClear = new THREE.Color();
const _depthRotation = new THREE.Matrix4();
// Detach a cloud's enable flag without writing the borrowed atmosphere flag.
// Shared Near/Far dictionaries can use this immutable disabled value together.
const _disabledCloudAir = Object.freeze({ value: 0 });
const _disabledCloudAirSampler = Object.freeze({ value: null });

function disableCloudAir(uniforms) {
  uniforms.air_uEnabled = _disabledCloudAir;
  uniforms.air_uMultipleEnabled = _disabledCloudAir;
  // Disabled shader branches still have active sampler uniforms. Stop borrowing
  // the atmosphere owner's textures before Three binds this material for a draw.
  uniforms.air_tOpticalDepth = _disabledCloudAirSampler;
  uniforms.air_tMultipleScattering = _disabledCloudAirSampler;
}

function target(w, h, name, depth = false) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    ...(depth ? { depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType) } : {}),
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.generateMipmaps = false;
  return rt;
}

// RenderTarget.setSize resizes COLOR images but leaves DepthTexture metadata
// unchanged. History depth can be sampled before its owner FBO is next bound;
// that upload must already use the new size (immutable GPU storage).
export function resizeVolumeHistoryTarget(rt,width,height) {
  rt.setSize(width,height);
  const depth=rt.depthTexture;
  if(depth&&(depth.image.width!==width||depth.image.height!==height)) {
    depth.image.width=width;depth.image.height=height;depth.needsUpdate=true;
  }
}

export class VolumetricPass extends Pass {
  constructor(scene, camera, { scale = 0.5, frameState = null } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.scale = scale;
    this.frameState = frameState || new RenderFrameState();
    this.profiler = null; // Borrowed from the pipeline only while profiling.
    this.columnWork = null; // Optional measured work admission; ordinary rows remain the baseline.
    this.nearCandidateGrids = new Map();
    this.width = 1;
    this.height = 1;
    this.current = target(1, 1, 'volume.current');
    this.repDepth = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.repDepth.texture.name = 'volume.repDepth';
    this.repDepth.texture.generateMipmaps = false;
    this.latestResolvedTexture = null;
    this.latestRepDepthTexture = null;
    this.latestRepDepthMode = 0;
    this.externalTaaActive = false;
    this.historyA = target(1, 1, 'volume.historyA', true);
    this.historyB = target(1, 1, 'volume.historyB', true);
    this.historyRead = this.historyA;
    this.historyWrite = this.historyB;
    this.historyValid = false;
    this.historySequence = -1;
    this.enabled = true;
    this.needsSwap = true;

    this.nav = new THREE.Vector3();
    this.center = new THREE.Vector3();
    this.radius = 1;
    this.motion = 1;
    this.frame = 0;
    this.activePlanet = null;
    this.columnMaps=new Map();
    this.columnRelease=new Map();
    this.lightBatchesEnabled=false;
    this.lightBatchOptions={budgetBytes:64*1024*1024,maxBatchTiles:128,fusedDensity:false};
    this.lightBatch=null;
    this.lightBatchStatus={reason:'disabled',submitted:false};

    this.resolveMaterial = new THREE.ShaderMaterial({
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      blending: THREE.NoBlending,
      uniforms: {
        tCurrent: { value: this.current.texture },
        tHistory: { value: this.historyRead.texture },
        tSceneDepth: { value: null },
        tHistoryDepth: { value: this.historyRead.depthTexture },
        tRepDepth: { value: null },
        uRepDepthMode: { value: 0 },
        uExternalTaaActive: { value: 0 },
        uWeatherAdvectValid: { value: 0 },
        uWeatherWindDeltaRad: { value: 0 },
        uBodyRadius: { value: 6000000 },
        uCurBodyInv: { value: new THREE.Matrix3() },
        uPrevBodyRot: { value: new THREE.Matrix3() },
        uCurBodyCenter: { value: new THREE.Vector3() },
        uPrevBodyCenter: { value: new THREE.Vector3() },
        uCameraFar: { value: camera.far },
        uHistoryValid: { value: 0 },
        uDepthReady: { value: 0 },
        uStationaryHistory: { value: 0 },
        uMotion: { value: 1 },
        uCenter: { value: this.center },
        uRadius: { value: this.radius },
        uNavDelta: { value: new THREE.Vector3() },
        uCurrentToPrevious: { value: new THREE.Matrix3() },
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tCurrent, tHistory, tSceneDepth, tHistoryDepth, tRepDepth;
        uniform float uCameraFar, uRepDepthMode, uExternalTaaActive;
        uniform float uWeatherAdvectValid, uWeatherWindDeltaRad, uBodyRadius;
        uniform float uHistoryValid, uDepthReady, uStationaryHistory, uMotion, uRadius;
        uniform vec3 uCenter, uNavDelta, uCurBodyCenter, uPrevBodyCenter;
        uniform mat4 uInvProjection, uCameraWorld, uPrevViewProjection;
        uniform mat3 uCurrentToPrevious, uCurBodyInv, uPrevBodyRot;

        vec3 rotateCloudLocalY(vec3 v, float angle) {
          float c = cos(angle), s = sin(angle);
          return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
        }
        varying vec2 vUv;

        ${volumeHistoryGLSL}

        vec2 sphereHits(vec3 origin, float r, vec3 dir) {
          vec3 oc = origin - uCenter;
          float b = dot(oc, dir);
          float d = b * b - dot(oc, oc) + r * r;
          if (d < 0.0) return vec2(-1.0);
          float s = sqrt(d);
          return vec2(-b - s, -b + s);
        }

        void main() {
          float currentDepth=uDepthReady>0.5?texture2D(tSceneDepth,vUv).r:1.0;
          gl_FragDepth=currentDepth;
          vec4 cur = texture2D(tCurrent, vUv);
          if (uHistoryValid < 0.5 || uDepthReady < 0.5) { gl_FragColor = cur; return; }
          vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec4 view = uInvProjection * clip;
          vec3 dirView = normalize(view.xyz / max(abs(view.w), 1e-5));
          vec3 dirWorld = normalize((uCameraWorld * vec4(dirView, 0.0)).xyz);
          vec3 rayOrigin = uCameraWorld[3].xyz;
          vec2 hit = sphereHits(rayOrigin, uRadius, dirWorld);

          vec2 prevUv = vec2(-2.0);
          vec2 repInfo = uRepDepthMode > 0.5 ? texture2D(tRepDepth, vUv).rg : vec2(0.0);
          float repSpreadConfidence = uRepDepthMode > 0.5 && repInfo.x > 0.0
            ? mix(1.0, 0.52, smoothstep(4500.0, 24000.0, repInfo.y))
            : 1.0;
          if (hit.y > 0.0 || repInfo.x > 0.0) {
            float nearT = max(hit.x, 0.0);
            float t = (uRepDepthMode > 0.5 && repInfo.x > 0.0)
              ? repInfo.x
              : (hit.x > 0.0 ? nearT : mix(nearT, hit.y, 0.42));
            vec3 curPoint = rayOrigin + dirWorld * t;
            vec3 prevRelative = uCurrentToPrevious * curPoint + uNavDelta;
            if (uWeatherAdvectValid > 0.5 && abs(uWeatherWindDeltaRad) > 1e-8) {
              vec3 localPos = uCurBodyInv * (curPoint - uCurBodyCenter);
              float alt = max(0.0, length(localPos) - uBodyRadius);
              float shear = mix(1.0, 1.25, smoothstep(2200.0, 4200.0, alt))
                + 0.40 * smoothstep(5500.0, 8000.0, alt);
              vec3 advectedLocal = rotateCloudLocalY(localPos, -uWeatherWindDeltaRad * shear);
              prevRelative = uPrevBodyRot * advectedLocal + uPrevBodyCenter;
            }
            vec4 prevClip = uPrevViewProjection * vec4(prevRelative, 1.0);
            if (prevClip.w > 0.0) prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
          }

          float inside = step(0.0, prevUv.x) * step(prevUv.x, 1.0)
            * step(0.0, prevUv.y) * step(prevUv.y, 1.0);
          if (inside < 0.5) { gl_FragColor = cur; return; }
          float uvMotion = length(prevUv - vUv);
          if (uStationaryHistory > 0.5) uvMotion = 0.0;
          float depthSupport;
          vec4 hist = volumeHistorySample(prevUv, currentDepth, uvMotion, depthSupport);
          if (depthSupport < 1e-6) { gl_FragColor = cur; return; }
          float alphaReject = 1.0 - smoothstep(0.04, 0.34, abs(hist.a - cur.a));
          float stable = exp(-uvMotion * 48.0) * alphaReject * repSpreadConfidence;
          float maxFeedback = uExternalTaaActive > 0.5 ? 0.56 : 0.86;
          float historyWeight = uHistoryValid * inside * stable
            * mix(maxFeedback, 0.16, clamp(uMotion, 0.0, 1.0));
          // Current samples always dominate newly revealed edges.
          historyWeight *= smoothstep(0.0, 0.12, cur.a + hist.a);
          historyWeight *= depthSupport;
          hist = volumeHistoryClip(hist, cur, currentDepth);
          gl_FragColor = mix(cur, hist, historyWeight);
        }`,
    });
    this.resolveQuad = new FullScreenQuad(this.resolveMaterial);

    this.compositeMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tBase: { value: null },
        tVolume: { value: this.historyWrite.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        tSceneDepth: { value: null },
        uDepthReady: { value: 0 },
        uCameraFar: { value: camera.far },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tBase, tVolume, tSceneDepth;
        uniform float uDepthReady, uCameraFar;
        uniform vec2 uTexel;
        varying vec2 vUv;

        float depthWeight(vec2 uv,float centerDepth) {
          if(uDepthReady<0.5) return 1.0;
          float d=texture2D(tSceneDepth,uv).r;
          if((d>=0.999999)!=(centerDepth>=0.999999)) return 0.0;
          float z=pow(uCameraFar+1.0,centerDepth)-1.0;
          float other=pow(uCameraFar+1.0,d)-1.0;
          return exp(-abs(z-other)/max(2.0,z*0.005));
        }
        vec4 volumeSample(vec2 uv) {
          // Reconstruct around the four enclosing pixel centres. Alpha is a
          // filtered participating-medium signal, not an opaque edge: rejecting
          // its neighbours quantizes cloud contours into low-resolution cells.
          // Test opaque depth before mixing, so a thin foreground object still
          // rejects all cloud samples taken behind it.
          vec2 p=uv/uTexel-.5,f=fract(p),q=(floor(p)+.5)*uTexel;
          vec2 qa=q+vec2(uTexel.x,0),qb=q+vec2(0,uTexel.y),qc=q+uTexel;
          float centerDepth=texture2D(tSceneDepth,uv).r;
          float w0=(1.0-f.x)*(1.0-f.y)*depthWeight(q,centerDepth);
          float w1=f.x*(1.0-f.y)*depthWeight(qa,centerDepth);
          float w2=(1.0-f.x)*f.y*depthWeight(qb,centerDepth);
          float w3=f.x*f.y*depthWeight(qc,centerDepth);
          // No matching low-resolution support: retain the full-resolution
          // clear-air surface rather than painting a cloud over a thin object.
          return (texture2D(tVolume,q)*w0+texture2D(tVolume,qa)*w1
            +texture2D(tVolume,qb)*w2+texture2D(tVolume,qc)*w3)/max(w0+w1+w2+w3,1e-8);
        }

        void main() {
          vec4 base = texture2D(tBase, vUv);
          vec4 volume = volumeSample(vUv);
          gl_FragColor = vec4(volume.rgb + base.rgb * (1.0 - volume.a), base.a);
        }`,
    });
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
  }

  setActivePlanet(planet, nav, motion = 0) {
    if(this.activePlanet!==planet)this.lightBatchPrefetch=null;
    if (!planet?.volCloudMesh) {
      if(this.activePlanet)this.columnRelease.set(this.activePlanet,this.frame+2);
      this.activePlanet = null;
      this.historyValid = false;
      this.radius = 1;
      this.center.set(0, 0, -1e12);
      return;
    }
    if (this.activePlanet !== planet) {
      if(this.activePlanet)this.columnRelease.set(this.activePlanet,this.frame+2);
      this.columnRelease.delete(planet);
      this.activePlanet = planet;
      this.historyValid = false;
    } else if (this.historyValid && this.frameState.previous.origin.distanceTo(nav) > this.radius * 0.18) {
      // Teleports/warps have no valid correspondence in the old history.
      this.historyValid = false;
    }
    this.nav.copy(nav);
    this.center.copy(planet.posUniv).sub(nav);
    this.radius = planet.volCloudBand?.rOut
      || planet.volCloudMesh.geometry?.parameters?.radius
      || planet.R + planet.atmoHeight;
    this.motion = THREE.MathUtils.clamp(motion, 0, 1);
  }

  resetHistory() {
    this.historyValid = false;
  }

  setLightBatchesEnabled(enabled,options={}) {
    const next={...this.lightBatchOptions};
    for(const [name,value] of Object.entries(options)) {
      if(!Object.hasOwn(next,name))throw Error('Unknown cloud batch option: '+name);
      const valid=name==='fusedDensity'?typeof value==='boolean'
        :Number.isSafeInteger(value)&&value>=(name==='budgetBytes'?0:1);
      if(!valid)throw Error('Invalid cloud batch option: '+name);
      next[name]=value;
    }
    if(!!enabled===this.lightBatchesEnabled&&(enabled||!this.lightBatch)
      &&Object.keys(next).every(name=>next[name]===this.lightBatchOptions[name]))return;
    const modeChanged=next.fusedDensity!==this.lightBatchOptions.fusedDensity;
    this.lightBatchesEnabled=!!enabled;
    this.lightBatchOptions=next;
    this.lightBatchPrefetch=null;
    if(!enabled||modeChanged)this.releaseLightBatches();
    else this.lightBatch?.releaseScratch();
    this.lightBatchStatus={reason:enabled?'pending':'disabled',submitted:false};
    this.historyValid=false;
  }

  releaseLightBatches() {
    this.lightBatchPrefetch=null;
    this.lightBatch?.dispose();this.lightBatch=null;
  }

  configureLightBatch(renderer,material) {
    const gl=renderer.getContext();
    const drawBuffers=gl.getParameter(gl.MAX_DRAW_BUFFERS);
    if(drawBuffers<4||!gl.getExtension('EXT_color_buffer_float'))return null;
    const options={...this.lightBatchOptions,width:this.width,height:this.height,maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};
    options.fusedDensity=options.fusedDensity&&drawBuffers>=5&&gl.getParameter(gl.MAX_COLOR_ATTACHMENTS)>=5
      &&!planCloudLightBatches(options).direct;
    if(this.lightBatch&&this.lightBatch.fusedDensity!==options.fusedDensity) {
      this.lightBatch.dispose();
      this.lightBatch=null;
    }
    if(!this.lightBatch)this.lightBatch=new CloudLightBatchRenderer(material,options);
    else this.lightBatch.configure(material,options);
    return this.lightBatch;
  }

  prefetchLightBatches(renderer,origin,prepare) {
    if(!this.lightBatchesEnabled)return;
    const planet=this.activePlanet,mesh=planet?.volCloudMesh,material=planet?.volCloudMat;
    const distance=planet&&origin?origin.distanceTo(planet.posUniv)-this.radius:Infinity;
    if(distance>20000000||!mesh?.visible||material?.defines.PRODUCTION_CLOUD_MEDIUM!==1
      ||material.uniforms.uLightQuadratureSteps.value!==16) {
      if(this.lightBatchPrefetch) {
        this.lightBatchPrefetch=null;
        this.lightBatch?.releaseScratch();
      }
      return;
    }
    if(distance<=250000&&this.lightBatch?.programsReady&&!this.lightBatch.targets.length) {
      this.configureLightBatch(renderer,material);
      if(this.lightBatch?.mesh)this.lightBatch.mesh.geometry=mesh.geometry;
    }
    if(this.lightBatchPrefetch?.planet===planet&&this.lightBatchPrefetch.material===material)return;
    if(this.hasPreparedLightBatch(mesh,material))return;
    const claim={planet,material,state:'queued'};
    this.lightBatchPrefetch=claim;
    const current=()=>this.lightBatchesEnabled&&this.lightBatchPrefetch===claim
      &&this.activePlanet===planet&&planet.volCloudMat===material;
    prepare(()=>{
      claim.state='preparing';
      const batch=this.configureLightBatch(renderer,material);
      if(!batch||batch.plan.direct)return false;
      return batch.programsReady||batch.prepareAsync(renderer,this.camera,mesh,this.current,this.repDepth);
    },{isCurrent:current,label:'near-cloud-batch-prefetch'}).then(ready=>{
      if(current()) {
        claim.state=ready?'ready':'unavailable';
        const nowDist=origin?origin.distanceTo(planet.posUniv)-this.radius:Infinity;
        if(ready&&nowDist>250000)this.lightBatch?.releaseScratch();
      }
    }).catch(error=>{
      if(current()) {claim.state='failed';claim.error=String(error);}
    });
  }

  lightBatchRefusal(planet,mesh,material) {
    if(!this.lightBatchesEnabled)return 'disabled';
    if(!mesh?.visible||material!==planet.volCloudMat||material.defines.PRODUCTION_CLOUD_MEDIUM!==1
      ||material.defines.CLOUD_FAR_VIEW||material.uniforms.uLightQuadratureSteps.value!==16)return 'representation';
    if(mesh.onBeforeRender!==THREE.Object3D.prototype.onBeforeRender
      ||mesh.onAfterRender!==THREE.Object3D.prototype.onAfterRender
      ||material.onBeforeRender!==THREE.Material.prototype.onBeforeRender
      ||material.onBeforeCompile!==THREE.Material.prototype.onBeforeCompile
      ||this.scene.onBeforeRender!==THREE.Object3D.prototype.onBeforeRender
      ||this.scene.onAfterRender!==THREE.Object3D.prototype.onAfterRender)return 'custom-render-callback';
    let owners=0,foreign=false;
    this.scene.traverseVisible(object=>{
      if(!(object.isMesh||object.isLine||object.isPoints||object.isSprite)||!object.layers.isEnabled(VOLUME_LAYER))return;
      owners++;if(object!==mesh)foreign=true;
    });
    return owners!==1||foreign?'multiple-volume-owners':null;
  }

  eligibleForLightBatch(requests) {
    if(requests.length!==1||!this.lightBatchesEnabled)return false;
    const {mesh,material}=requests[0], planet=this.activePlanet;
    return Boolean(planet&&mesh===planet.volCloudMesh&&material===planet.volCloudMat
      &&!this.lightBatchRefusal(planet,mesh,material));
  }

  usesPreparedLightBatch(requests) {
    return Boolean(this.eligibleForLightBatch(requests)
      &&this.hasPreparedLightBatch(requests[0].mesh,requests[0].material));
  }

  hasPreparedLightBatch(mesh,material) {
    const batch=this.lightBatch;
    return batch?.programsReady&&batch.source===material&&batch.mesh.geometry===mesh.geometry
      &&batch.targets.length>0&&batch.plan.width===this.width&&batch.plan.height===this.height
      &&batch.matchesProgramSource(material);
  }

  renderLightBatches(renderer) {
    const planet=this.activePlanet,mesh=planet?.volCloudMesh,material=mesh?.material;
    const refuse=reason=>{
      if(reason==='disabled')this.lightBatch?.releaseScratch();
      else if(reason!=='representation'||this.lightBatchPrefetch?.planet!==planet)this.lightBatch?.releaseScratch();
      this.lightBatchStatus={reason,submitted:false};return false;
    };
    const refusal=this.lightBatchRefusal(planet,mesh,material);
    if(refusal)return refuse(refusal);
    if(this.requirePreparedLightBatch&&!this.hasPreparedLightBatch(mesh,material))return false;
    if(!this.configureLightBatch(renderer,material))return refuse('capabilities');
    if(!this.lightBatch.plan.direct&&!this.lightBatch.programsReady) {
      if(!this.lightBatch.preparationError)this.lightBatch.prepareAsync(renderer,this.camera,mesh,this.current,this.repDepth);
      this.lightBatchStatus={reason:this.lightBatch.preparationError?'preparation-error':'preparing',submitted:false,
        error:this.lightBatch.preparationError,plan:this.lightBatch.plan};
      return false;
    }
    const submitted=this.lightBatch.render(renderer,this.camera,mesh,this.current,null,this.repDepth);
    this.lightBatchStatus={reason:submitted?'same-frame':'budget',submitted,plan:this.lightBatch.plan};
    return submitted;
  }

  updateCloudColumns(renderer) {
    const planet=this.activePlanet;
    if(!planet)return;
    const mesh=planet.volCloudMesh,farMaterial=planet.volCloudFarMat;
    const far=Boolean(mesh && farMaterial && planet.volCloudMat.uniforms.uCameraLocal.value.length()
      -planet.volCloudBand.rOut>200000);
    if(mesh && farMaterial)mesh.material=far?farMaterial:planet.volCloudMat;
    const stream=planet.weatherStream;
    if(far && planet.weatherField?.synoptic && stream && !stream.disposed) {
      let columns=this.columnMaps.get(planet);
      if(!columns || columns.disposed) {
        columns=new CloudColumnBank(planet,this.columnWork?{producer:'tile',
          tileRows:this.columnWork.tileRows,footprintBatch:this.columnWork.footprintBatch,
          forecastSteps:this.columnWork.forecastSteps,cacheSteps:this.columnWork.cacheSteps,deadlineAware:true}:undefined);
        this.columnMaps.set(planet,columns);
        planet.cloudColumnMap=columns;
      }
      // The split experiment needs a completed pair before its cheaper cached
      // path can run. Use the measured larger slice only for admitted split
      // frames. Explicit GPU-budgeted tile production owns its own granularity.
      if (this.farSplit && !this.columnWork) columns.rows = this.farSplit.plan?.mesh === mesh ? 16 : 2;
      // A real immutable endpoint may bake before its forecast partner arrives.
      // The bank alone decides when the complete pair is safe to sample.
      if(this.columnWork) {
        columns.update(renderer,{admit:(request,produce)=>this.columnWork.budget.run(request.key,produce,
          {maxUnits:request.maxUnits}).value});
      } else columns.update(renderer);
      if(this.columnMaps.size>2) {
        const oldest=[...this.columnMaps.keys()].find(p=>p!==planet);
        this.columnMaps.get(oldest).dispose();this.columnMaps.delete(oldest);
      }
    } else if(this.columnMaps.has(planet)) {
      this.columnMaps.get(planet).dispose();this.columnMaps.delete(planet);
    }
    let cacheOnly=false;
    if(far && this.columnMaps.has(planet) && planet.volCloudMat.uniforms.uColumnsReady.value>.5) {
      const minimumCone=minimumCloudRayCone(this.camera.projectionMatrix.elements,this.width,this.height);
      const nearestDistance=Math.max(0,planet.volCloudMat.uniforms.uCameraLocal.value.length()-planet.volCloudBand.rOut);
      cacheOnly=nearestDistance*minimumCone>2400;
    }
    // This selection must also run on missing/replaced forecasts. CACHE1 has
    // no runtime ready branch and must never sample the unbound weather map.
    setCloudFarCacheEnabled(planet,cacheOnly);
  }

  // Plan the programs which the unchanged pass can select, before ANY world
  // pass starts. Column production and retirement stay in render(): either can
  // change the far-cache flag during this frame, so its closure belongs here.
  // This is deliberately independent of the previous draw's uCameraLocal.
  enableFarSplit(renderer, options = { splitPoint: true }) {
    this.farSplit ??= new CloudFarSplitPass(renderer, options);
  }

  requiredProgramRequests(origin = this.nav, split = null) {
    if (split) split.plan = null;
    const requests = [], active = this.activePlanet, activeMesh = active?.volCloudMesh;
    let activeVisible = false;
    const append = (mesh, material, cacheVariants) => {
      if (!material?.isShaderMaterial || material.defines?.CLOUD_FAR_VIEW === undefined) return;
      requests.push({ mesh, material, cacheVariants: [...new Set(cacheVariants)] });
    };
    this.scene.traverseVisible(object => {
      if (!object.isMesh || !object.layers.isEnabled(VOLUME_LAYER)) return;
      if (object === activeMesh) { activeVisible = true;return; }
      for (const material of [object.material].flat()) {
        // A retiring bank can reset a fading body's CACHE1 before the draw.
        const cache = Number(material?.defines?.CLOUD_FAR_CACHE || 0);
        append(object, material, material?.defines?.CLOUD_FAR_VIEW ? [cache, 0] : [cache]);
      }
    });
    if (activeVisible) {
      // Match updateWorldMatrix(true, false), including manually owned world
      // matrices, without updating live camera/rig caches on a blocked frame.
      const chain = [];let node = this.camera;
      while (node && node.matrixWorldAutoUpdate === true
          && (node.matrixAutoUpdate || node.matrixWorldNeedsUpdate)) { chain.push(node);node = node.parent; }
      const world = node ? node.matrixWorld.clone() : new THREE.Matrix4();
      for (const object of chain.reverse()) world.multiply(object.matrixAutoUpdate
        ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale) : object.matrix);
      const eye = new THREE.Vector3().setFromMatrixPosition(world);
      const local = new THREE.Vector3().copy(origin).sub(active.posUniv).add(eye);
      if (active.frameOrientation) local.applyQuaternion(active.frameOrientation.clone().invert());
      const outer = active.volCloudBand?.rOut || this.radius;
      const distance = local.length() - outer;
      const far = Boolean(active.volCloudFarMat && distance > 200000);
      const cone = minimumCloudRayCone(this.camera.projectionMatrix.elements, this.width, this.height);
      append(activeMesh, far ? active.volCloudFarMat : active.volCloudMat,
        far && Math.max(0, distance) * cone > 2400 ? [0, 1] : [0]);
    }
    if (split && requests.length === 1 && requests[0].mesh === activeMesh) {
      return split.requests(this.scene, requests[0], this.current) ?? requests;
    }
    return requests;
  }

  configureColumnWork(policy) {
    const banks=[...this.columnMaps.values()];
    this.columnMaps.clear();this.columnRelease.clear();this.columnWork=policy;
    for(const bank of banks)bank.dispose();
  }

  bindNearCandidates(uniforms, used) {
    const raw=uniforms.uBandCandidates.value, binding=uniforms.uNearBandCandidates;
    if(!raw || uniforms.uCandidatesReady.value<.5) {
      if(binding.value?.userData?.rawCandidates){binding.value.dispose();}
      binding.value=null;return;
    }
    let grid=this.nearCandidateGrids.get(raw);
    if(!grid) {
      const {data,width,height,depth}=raw.image;
      const owned=binding.value?.userData?.rawCandidates===raw?binding.value:null;
      if(!owned && binding.value?.userData?.rawCandidates)binding.value.dispose();
      const texture=owned||new THREE.DataArrayTexture(new Uint16Array(data.length),width,height,depth);
      texture.format=raw.format;texture.type=raw.type;texture.internalFormat=raw.internalFormat;
      this.nearCandidateGrids.set(raw,grid={texture,binding,version:owned?owned.userData.rawVersion:-1});
    }
    if(grid.version!==raw.version) {
      grid.texture.image.data.set(raw.image.data);
      encodeCandidateEmptyRuns(grid.texture.image.data);
      grid.texture.needsUpdate=true;
      grid.version=raw.version;
      if(grid.texture.userData)grid.texture.userData.rawVersion=raw.version;
    }
    binding.value=grid.texture;
    used.add(raw);
  }

  releaseNearCandidates(used) {
    for(const [raw,{texture,binding}] of this.nearCandidateGrids) {
      if(used?.has(raw))continue;
      if(binding.value===texture)binding.value=null;
      texture.dispose();this.nearCandidateGrids.delete(raw);
    }
  }

  profilePhase(name,work,options) {return this.profiler?this.profiler.run(name,work,options):work();}

  setSize(width, height) {
    const nextWidth=Math.max(1,Math.round(width*this.scale)),nextHeight=Math.max(1,Math.round(height*this.scale));
    if(nextWidth!==this.width||nextHeight!==this.height) {
      this.lightBatchPrefetch=null;
      this.lightBatch?.releaseScratch();
      this.farSplit?.releaseScratch();
    }
    this.width=nextWidth;this.height=nextHeight;
    this.current.setSize(this.width, this.height);
    this.repDepth.setSize(this.width, this.height);
    resizeVolumeHistoryTarget(this.historyA,this.width,this.height);
    resizeVolumeHistoryTarget(this.historyB,this.width,this.height);
    this.compositeMaterial.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.historyValid = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const ownFrame = !this.frameState.pending;
    for(const [planet,frame] of this.columnRelease)if(this.frame>=frame) {
      this.columnMaps.get(planet)?.dispose();this.columnMaps.delete(planet);
      this.columnRelease.delete(planet);planet.volCloudMat.uniforms.uColumnsReady.value=0;
    }
    const oldTarget = renderer.getRenderTarget();
    const oldFace = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
    const oldMask = this.camera.layers.mask;
    const oldAutoClear = renderer.autoClear;
    const oldAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_savedClear);

    // Keep scalar copies: nested draws can reuse the module scratch color.
    const oldClearR = _savedClear.r, oldClearG = _savedClear.g, oldClearB = _savedClear.b;
    let completed = false, restored = false, volumeMaterial, hasDepth = false, splitDraw = false;
    try {
      if (ownFrame) this.frameState.begin(this.camera, this.nav, { context: this.scene, body: this.activePlanet });
      // The opaque scene was rendered into readBuffer immediately before this
      // pass. Feed its logarithmic depth texture into the cloud shader so ray
      // integration terminates at terrain, flora, props and the ship instead of
      // compositing as a screen-front layer.
      const depthTexture = this.sceneDepthSource?.sceneDepthTexture
        || readBuffer.depthTexture || null;
      hasDepth = !!depthTexture;
      const cloudUniforms = this.activePlanet?.volCloudMat?.uniforms;
      const planet=this.activePlanet;
      // Column/representation selection needs the active eye before the draw
      // bindings below. Preserve the shared frame state's original calculation.
      if (cloudUniforms?.uCameraLocal) this.frameState.localEye(planet, cloudUniforms.uCameraLocal.value);
      // The work budget owns sparse GPU intervals inside this CPU parent.
      this.profilePhase('cloud-columns',()=>this.updateCloudColumns(renderer),this.columnWork?{gpu:false}:undefined);
      const air = this.sceneDepthSource;
      if (cloudUniforms) {
        if (air?.activePlanet === this.activePlanet) {
          for (const [name, uniform] of Object.entries(air.material.uniforms)) {
            if (name.startsWith('u') || name === 'tOpticalDepth' || name === 'tMultipleScattering') cloudUniforms['air_' + name] = uniform;
          }
        } else disableCloudAir(cloudUniforms);
      }
      // A previously active cloud can remain visible while it fades. Its air_
      // entries may still alias the single AtmospherePass, whose values now
      // describe another planet. Cloud positions are body-local, so using that
      // foreign atmosphere would mix coordinate frames. Apply the same no-
      // matching-owner policy to every cloud this volume draw can submit. Depth
      // and camera reconstruction also belong to the current draw, including
      // fading clouds whose active body changed before a resize or camera move.
      this.camera.updateMatrixWorld(true);
      const nearCandidatesUsed=new Set();
      const phase=this.frameState.sequence%16;
      const bindCloudDraw = (mesh, material) => {
        const uniforms = material?.uniforms;
        if (material?.defines?.CLOUD_FAR_VIEW === undefined || !uniforms) return;
        if (uniforms.air_uEnabled && uniforms !== cloudUniforms) disableCloudAir(uniforms);
        if (material.defines.CLOUD_FAR_VIEW===0) {
          if(uniforms.uFrame)uniforms.uFrame.value=phase;
          if(uniforms.uNearBandCandidates)this.bindNearCandidates(uniforms,nearCandidatesUsed);
        }
        if (uniforms.tSceneDepth) {
          uniforms.tSceneDepth.value = depthTexture;
          uniforms.uDepthReady.value = depthTexture ? 1 : 0;
          uniforms.uCameraFar.value = this.camera.far;
          uniforms.uVolumeSize.value.set(this.width, this.height);
        }
        if (uniforms.uDepthInvProjection) {
          mesh.updateWorldMatrix(true, false);
          _depthRotation.copy(mesh.matrixWorld).invert().multiply(this.camera.matrixWorld);
          uniforms.uDepthInvProjection.value.copy(this.camera.projectionMatrixInverse);
          uniforms.uDepthViewToLocal.value.setFromMatrix4(_depthRotation);
          if (uniforms !== cloudUniforms) uniforms.uCameraLocal.value.setFromMatrixPosition(_depthRotation);
        }
      };
      this.scene.traverseVisible(object => {
        if (!object.isMesh || !object.layers.isEnabled(VOLUME_LAYER)) return;
        if (Array.isArray(object.material)) {
          for (const material of object.material) bindCloudDraw(object, material);
        } else bindCloudDraw(object, object.material);
      });
      this.releaseNearCandidates(nearCandidatesUsed);

      // Render only cloud volume meshes into a half-resolution HDR
      // buffer. Clear alpha is important: discarded rays must stay transparent.
      this.camera.layers.set(VOLUME_LAYER);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.current);
      this.profilePhase('volume-current',()=>{
        renderer.clear(true, false, false);
        splitDraw = this.farSplit?.render(this.scene, this.camera, this.current, this.columnMaps.get(planet)) ?? false;
        if(!splitDraw && !this.renderLightBatches(renderer)) {
          if(this.requirePreparedLightBatch)throw lightBatchNoLongerPrepared;
          renderer.render(this.scene, this.camera);
        }
      });

      this.camera.layers.mask = oldMask;
      renderer.autoClear = oldAutoClear;
      _savedClear.setRGB(oldClearR, oldClearG, oldClearB);
      renderer.setClearColor(_savedClear, oldAlpha);

      this.camera.updateMatrixWorld(true);
      const u = this.resolveMaterial.uniforms;
      u.tSceneDepth.value = depthTexture;
      u.uDepthReady.value = depthTexture ? 1 : 0;
      u.tHistoryDepth.value = this.historyRead.depthTexture;
      u.uCameraFar.value = this.camera.far;
      u.tCurrent.value = this.current.texture;
      u.tHistory.value = this.historyRead.texture;
      const batchRepValid = !splitDraw && Boolean(this.lightBatchStatus?.submitted && this.lightBatch?.repDepthMaterial);
      const farRepValid = splitDraw && Boolean(this.farSplit?.rayTarget
        && (this.farSplit.lastRoute === 'pointDirect' || this.farSplit.lastRoute === 'combine'));
      const repTex = batchRepValid ? this.repDepth.texture : farRepValid ? this.farSplit.rayTarget.texture : null;
      const repMode = batchRepValid ? 1 : farRepValid ? 2 : 0;
      u.tRepDepth.value = repTex;
      u.uRepDepthMode.value = repMode;
      u.uExternalTaaActive.value = this.externalTaaActive ? 1 : 0;

      const correspondence = this.frameState.mapBody();
      const weatherAdvect = this.frameState.mapWeatherAdvection();
      u.uWeatherAdvectValid.value = weatherAdvect ? 1 : 0;
      if (weatherAdvect && this.activePlanet) {
        u.uWeatherWindDeltaRad.value = this.frameState.weatherWindDeltaRad;
        u.uBodyRadius.value = this.activePlanet.R || 6000000;
        u.uCurBodyInv.value.copy(this.frameState.curBodyInv);
        u.uPrevBodyRot.value.copy(this.frameState.prevBodyRot);
        u.uCurBodyCenter.value.copy(this.frameState.curBodyCenter);
        u.uPrevBodyCenter.value.copy(this.frameState.prevBodyCenter);
      }
      volumeMaterial = this.activePlanet?.volCloudMesh.material;
      const sameRepresentation = volumeMaterial === this.previousVolumeMaterial
        && volumeMaterial?.version === this.previousVolumeVersion && this.radius === this.previousRadius
        && splitDraw === this.previousSplitDraw;
      const precedingFrame = this.historySequence + 1 === this.frameState.sequence;
      u.uHistoryValid.value = this.historyValid && correspondence && sameRepresentation && precedingFrame ? 1 : 0;
      u.uStationaryHistory.value = this.frameState.stationaryBodyView() ? 1 : 0;
      u.uMotion.value = this.motion;
      u.uCenter.value.copy(this.center);
      u.uRadius.value = this.radius;
      u.uNavDelta.value.copy(this.frameState.translation);
      u.uCurrentToPrevious.value.copy(this.frameState.rotation);
      u.uInvProjection.value.copy(this.frameState.current.inverseProjection);
      u.uCameraWorld.value.copy(this.frameState.current.cameraWorld);
      u.uPrevViewProjection.value.copy(this.frameState.previous.viewProjection);
      renderer.setRenderTarget(this.historyWrite);
      this.profilePhase('volume-resolve',()=>this.resolveQuad.render(renderer));
      this.latestResolvedTexture = this.historyWrite.texture;
      this.latestRepDepthTexture = repTex;
      this.latestRepDepthMode = repMode;

      this.compositeMaterial.uniforms.tBase.value = readBuffer.texture;
      this.compositeMaterial.uniforms.tVolume.value = this.historyWrite.texture;
      this.compositeMaterial.uniforms.tSceneDepth.value = depthTexture;
      this.compositeMaterial.uniforms.uDepthReady.value = depthTexture ? 1 : 0;
      this.compositeMaterial.uniforms.uCameraFar.value = this.camera.far;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.profilePhase('volume-composite',()=>{
        if (this.clear) renderer.clear();
        this.compositeQuad.render(renderer);
      });

      completed = true;
    } finally {
      // A failed current/resolve/composite draw must not publish partial
      // history or leak the volume layer and framebuffer into later passes.
      try {
        this.camera.layers.mask = oldMask;
        renderer.autoClear = oldAutoClear;
        _savedClear.setRGB(oldClearR, oldClearG, oldClearB);
        renderer.setClearColor(_savedClear, oldAlpha);
        renderer.setRenderTarget(oldTarget, oldFace, oldMip);
        restored = true;
      } finally {
        if (!completed || !restored) {
          this.historyValid = false;
          if (ownFrame) this.frameState.abort();
        }
      }
    }
    this.historyValid = !!this.activePlanet && hasDepth;
    this.historySequence = this.frameState.sequence;
    this.previousVolumeMaterial = volumeMaterial;
    this.previousSplitDraw = splitDraw;
    this.previousVolumeVersion = volumeMaterial?.version;
    this.previousRadius = this.radius;
    const swap = this.historyRead;
    this.historyRead = this.historyWrite;
    this.historyWrite = swap;
    this.frame++;
    if (ownFrame) this.frameState.commit();
  }

  releaseTargets() {
    this.farSplit?.dispose();
    this.releaseLightBatches();
    this.releaseNearCandidates();
    for(const columns of this.columnMaps.values())columns.dispose();
    this.columnMaps.clear();this.columnRelease.clear();
    this.current.dispose();
    this.repDepth.dispose();
    this.latestResolvedTexture = null;
    this.latestRepDepthTexture = null;
    this.latestRepDepthMode = 0;
    this.historyA.dispose();
    this.historyB.dispose();
    this.historyValid = false;
  }

  dispose() {
    this.profiler=null;
    this.columnWork=null;
    this.releaseTargets();
    this.resolveMaterial.dispose();
    this.compositeMaterial.dispose();
    this.resolveQuad.dispose();
    this.compositeQuad.dispose();
  }
}

