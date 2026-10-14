// Half-resolution cloud pass with camera reprojection.
//
// Clouds are rendered into a smaller HDR target, reprojected from the previous
// frame and edge-aware upsampled. Physical atmosphere scattering owns a
// separate full-resolution depth-aware pass; this pass must not bind or render
// the legacy atmosphere shell.

import * as THREE from 'three';
import { CloudColumnBank } from './cloud/cloud-column-bank.js';
import {minimumCloudRayCone} from './cloud/cloud-footprint.js';
import {CloudLightBatchRenderer} from './cloud/cloud-light-batch-renderer.js';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';

export const VOLUME_LAYER = 2;

const _clear = new THREE.Color();
const _savedClear = new THREE.Color();
const _depthRotation = new THREE.Matrix4();

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
  constructor(scene, camera, { scale = 0.5 } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.scale = scale;
    this.width = 1;
    this.height = 1;
    this.current = target(1, 1, 'volume.current');
    this.historyA = target(1, 1, 'volume.historyA', true);
    this.historyB = target(1, 1, 'volume.historyB', true);
    this.historyRead = this.historyA;
    this.historyWrite = this.historyB;
    this.historyValid = false;
    this.enabled = true;
    this.needsSwap = true;

    this.nav = new THREE.Vector3();
    this.prevNav = new THREE.Vector3();
    this.center = new THREE.Vector3();
    this.radius = 1;
    this.motion = 1;
    this.frame = 0;
    this.activePlanet = null;
    this.columnMaps=new Map();
    this.columnRelease=new Map();
    this.lightBatchesEnabled=false;
    this.lightBatchOptions={budgetBytes:64*1024*1024,maxBatchTiles:128};
    this.lightBatch=null;
    this.lightBatchStatus={reason:'disabled',submitted:false};
    this.prevViewProjection = new THREE.Matrix4();

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
        uCameraFar: { value: camera.far },
        uHistoryValid: { value: 0 },
        uMotion: { value: 1 },
        uCenter: { value: this.center },
        uRadius: { value: this.radius },
        uNavDelta: { value: new THREE.Vector3() },
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: this.prevViewProjection },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tCurrent, tHistory, tSceneDepth, tHistoryDepth;
        uniform float uCameraFar;
        uniform float uHistoryValid, uMotion, uRadius;
        uniform vec3 uCenter, uNavDelta;
        uniform mat4 uInvProjection, uCameraWorld, uPrevViewProjection;
        varying vec2 vUv;

        vec2 sphereHits(vec3 origin, float r, vec3 dir) {
          vec3 oc = origin - uCenter;
          float b = dot(oc, dir);
          float d = b * b - dot(oc, oc) + r * r;
          if (d < 0.0) return vec2(-1.0);
          float s = sqrt(d);
          return vec2(-b - s, -b + s);
        }

        void main() {
          float currentDepth=texture2D(tSceneDepth,vUv).r;
          gl_FragDepth=currentDepth;
          vec4 cur = texture2D(tCurrent, vUv);
          vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec4 view = uInvProjection * clip;
          vec3 dirView = normalize(view.xyz / max(abs(view.w), 1e-5));
          vec3 dirWorld = normalize((uCameraWorld * vec4(dirView, 0.0)).xyz);
          vec2 hit = sphereHits(vec3(0.0), uRadius, dirWorld);

          vec2 prevUv = vec2(-2.0);
          if (hit.y > 0.0) {
            // Outside: the near shell is a good stable reprojection surface.
            // Inside: bias into the volume instead of using the far boundary.
            float nearT = max(hit.x, 0.0);
            float t = hit.x > 0.0 ? nearT : mix(nearT, hit.y, 0.42);
            vec3 prevRelative = dirWorld * t + uNavDelta;
            vec4 prevClip = uPrevViewProjection * vec4(prevRelative, 1.0);
            if (prevClip.w > 0.0) prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
          }

          float inside = step(0.0, prevUv.x) * step(prevUv.x, 1.0)
            * step(0.0, prevUv.y) * step(prevUv.y, 1.0);
          vec4 hist = texture2D(tHistory, clamp(prevUv, 0.0, 1.0));
          float uvMotion = length(prevUv - vUv);
          float alphaReject = smoothstep(0.34, 0.04, abs(hist.a - cur.a));
          float stable = exp(-uvMotion * 48.0) * alphaReject;
          float historyWeight = uHistoryValid * inside * stable
            * mix(0.86, 0.18, clamp(uMotion, 0.0, 1.0));
          // Current samples always dominate newly revealed edges.
          historyWeight *= smoothstep(0.0, 0.12, cur.a + hist.a);
          // Opaque silhouettes and disocclusions must not inherit a cloudy
          // sky sample. World-surface motion reprojection is a B7 concern;
          // until then reuse sky-to-sky history or a stationary matching ray.
          float previousDepth=texture2D(tHistoryDepth,clamp(prevUv,0.0,1.0)).r;
          float skyMatch=step(0.999999,currentDepth)*step(0.999999,previousDepth);
          float stillMatch=(1.0-smoothstep(0.000001,0.00001,abs(currentDepth-previousDepth)))
            *exp(-uvMotion*1000.0)*(1.0-step(0.001,uMotion));
          historyWeight *= max(skyMatch,stillMatch);
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
      this.prevNav.copy(nav);
    } else if (this.historyValid && this.prevNav.distanceTo(nav) > this.radius * 0.18) {
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
    this.releaseLightBatches();
    this.lightBatchesEnabled=!!enabled;
    Object.assign(this.lightBatchOptions,options);
    this.historyValid=false;
  }

  releaseLightBatches() {
    this.lightBatch?.dispose();this.lightBatch=null;
  }

  renderLightBatches(renderer) {
    const planet=this.activePlanet,mesh=planet?.volCloudMesh,material=mesh?.material;
    const refuse=reason=>{
      this.releaseLightBatches();this.lightBatchStatus={reason,submitted:false};return false;
    };
    if(!this.lightBatchesEnabled)return refuse('disabled');
    if(!mesh?.visible||material!==planet.volCloudMat||material.defines.PRODUCTION_CLOUD_MEDIUM!==1
      ||material.defines.CLOUD_FAR_VIEW||material.uniforms.uLightQuadratureSteps.value!==16)return refuse('representation');
    if(mesh.onBeforeRender!==THREE.Object3D.prototype.onBeforeRender
      ||mesh.onAfterRender!==THREE.Object3D.prototype.onAfterRender
      ||material.onBeforeRender!==THREE.Material.prototype.onBeforeRender
      ||material.onBeforeCompile!==THREE.Material.prototype.onBeforeCompile
      ||this.scene.onBeforeRender!==THREE.Object3D.prototype.onBeforeRender
      ||this.scene.onAfterRender!==THREE.Object3D.prototype.onAfterRender)return refuse('custom-render-callback');
    let owners=0,foreign=false;
    this.scene.traverseVisible(object=>{
      if(!(object.isMesh||object.isLine||object.isPoints||object.isSprite)||!object.layers.test(this.camera.layers))return;
      owners++;if(object!==mesh)foreign=true;
    });
    if(owners!==1||foreign)return refuse('multiple-volume-owners');
    const gl=renderer.getContext();
    if(gl.getParameter(gl.MAX_DRAW_BUFFERS)<4||!gl.getExtension('EXT_color_buffer_float'))return refuse('capabilities');
    const signature=JSON.stringify(material.defines);
    const current=this.lightBatch;
    if(current&&(current.source!==material||current.plan.width!==this.width||current.plan.height!==this.height
      ||current.fragment!==material.fragmentShader||current.vertex!==material.vertexShader||current.signature!==signature))
      this.releaseLightBatches();
    if(!this.lightBatch) {
      this.lightBatch=new CloudLightBatchRenderer(material,{width:this.width,height:this.height,
        maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),...this.lightBatchOptions});
      this.lightBatch.fragment=material.fragmentShader;this.lightBatch.vertex=material.vertexShader;this.lightBatch.signature=signature;
    }
    const submitted=this.lightBatch.render(renderer,this.camera,mesh,this.current);
    this.lightBatchStatus={reason:submitted?'same-frame':'budget',submitted,plan:this.lightBatch.plan};
    return submitted;
  }

  setSize(width, height) {
    const nextWidth=Math.max(1,Math.round(width*this.scale)),nextHeight=Math.max(1,Math.round(height*this.scale));
    if(nextWidth!==this.width||nextHeight!==this.height)this.releaseLightBatches();
    this.width=nextWidth;this.height=nextHeight;
    this.current.setSize(this.width, this.height);
    resizeVolumeHistoryTarget(this.historyA,this.width,this.height);
    resizeVolumeHistoryTarget(this.historyB,this.width,this.height);
    this.compositeMaterial.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.historyValid = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    for(const [planet,frame] of this.columnRelease)if(this.frame>=frame) {
      this.columnMaps.get(planet)?.dispose();this.columnMaps.delete(planet);
      this.columnRelease.delete(planet);planet.volCloudMat.uniforms.uColumnsReady.value=0;
    }
    const oldTarget = renderer.getRenderTarget();
    const oldMask = this.camera.layers.mask;
    const oldAutoClear = renderer.autoClear;
    const oldAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_savedClear);

    // The opaque scene was rendered into readBuffer immediately before this
    // pass. Feed its logarithmic depth texture into the cloud shader so ray
    // integration terminates at terrain, flora, props and the ship instead of
    // compositing as a screen-front layer.
    const depthTexture = this.sceneDepthSource?.sceneDepthTexture
      || readBuffer.depthTexture || null;
    const bindSceneDepth = (material) => {
      const uniforms = material?.uniforms;
      if (!uniforms?.tSceneDepth) return;
      uniforms.tSceneDepth.value = depthTexture;
      uniforms.uDepthReady.value = depthTexture ? 1 : 0;
      uniforms.uCameraFar.value = this.camera.far;
      uniforms.uVolumeSize.value.set(this.width, this.height);
    };
    bindSceneDepth(this.activePlanet?.volCloudMat);
    const cloudUniforms = this.activePlanet?.volCloudMat?.uniforms;
    const planet=this.activePlanet;
    if(cloudUniforms?.uDepthInvProjection && planet?.volCloudMesh) {
      this.camera.updateMatrixWorld(true);planet.volCloudMesh.updateWorldMatrix(true,false);
      _depthRotation.copy(planet.volCloudMesh.matrixWorld).invert().multiply(this.camera.matrixWorld);
      cloudUniforms.uDepthInvProjection.value.copy(this.camera.projectionMatrixInverse);
      cloudUniforms.uDepthViewToLocal.value.setFromMatrix4(_depthRotation);
      cloudUniforms.uOpaqueMinR.value=planet.R-Math.max(1000,(planet.hAmp||0)*2);
      cloudUniforms.uOpaqueMaxR.value=planet.R+Math.max(1000,(planet.hAmp||0)*2);
    }
    if(planet?.volCloudMesh && planet.volCloudFarMat) {
      const far=planet.volCloudMat.uniforms.uCameraLocal.value.length()
        -planet.volCloudBand.rOut>200000;
      planet.volCloudMesh.material=far?planet.volCloudFarMat:planet.volCloudMat;
    }
    if(planet?.weatherField?.synoptic && planet.weatherStream?.ready
      && planet.volCloudMesh.material===planet.volCloudFarMat) {
      let columns=this.columnMaps.get(planet);
      if(!columns || columns.disposed) {
        columns=new CloudColumnBank(planet);this.columnMaps.set(planet,columns);
        planet.cloudColumnMap=columns;
      }
      columns.update(renderer);
      const minimumCone=minimumCloudRayCone(this.camera.projectionMatrix.elements,this.width,this.height);
      const nearestDistance=Math.max(0,planet.volCloudMat.uniforms.uCameraLocal.value.length()-planet.volCloudBand.rOut);
      const cacheOnly=planet.volCloudMat.uniforms.uColumnsReady.value>.5
        && nearestDistance*minimumCone>2400;
      if(planet.volCloudFarMat.defines.CLOUD_FAR_CACHE!==Number(cacheOnly)) {
        planet.volCloudFarMat.defines.CLOUD_FAR_CACHE=Number(cacheOnly);
        planet.volCloudFarMat.needsUpdate=true;
      }
      if(this.columnMaps.size>2) {
        const oldest=[...this.columnMaps.keys()].find(p=>p!==planet);
        this.columnMaps.get(oldest).dispose();this.columnMaps.delete(oldest);
        oldest.volCloudMat.uniforms.uColumnsReady.value=0;
      }
    } else if(planet && this.columnMaps.has(planet)) {
      // Near sunlight transport and far optical columns have separate owners.
      // Retain neither unused baking snapshots nor far targets in a near view.
      this.columnMaps.get(planet).dispose();this.columnMaps.delete(planet);
    }
    const air = this.sceneDepthSource;
    if (cloudUniforms) {
      if (air?.activePlanet === this.activePlanet) {
        for (const [name, uniform] of Object.entries(air.material.uniforms)) {
          if (name.startsWith('u') || name === 'tOpticalDepth' || name === 'tMultipleScattering') cloudUniforms['air_' + name] = uniform;
        }
      } else cloudUniforms.air_uEnabled = { value: 0 };
    }

    // Render only cloud volume meshes into a half-resolution HDR
    // buffer. Clear alpha is important: discarded rays must stay transparent.
    this.camera.layers.set(VOLUME_LAYER);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.current);
    renderer.clear(true, false, false);
    if(!this.renderLightBatches(renderer))renderer.render(this.scene, this.camera);

    this.camera.layers.mask = oldMask;
    renderer.autoClear = oldAutoClear;
    renderer.setClearColor(_savedClear, oldAlpha);

    this.camera.updateMatrixWorld(true);
    const u = this.resolveMaterial.uniforms;
    u.tSceneDepth.value = depthTexture;
    u.tHistoryDepth.value = this.historyRead.depthTexture;
    u.uCameraFar.value = this.camera.far;
    u.tCurrent.value = this.current.texture;
    u.tHistory.value = this.historyRead.texture;
    u.uHistoryValid.value = this.historyValid ? 1 : 0;
    u.uMotion.value = this.motion;
    u.uCenter.value.copy(this.center);
    u.uRadius.value = this.radius;
    u.uNavDelta.value.copy(this.nav).sub(this.prevNav);
    u.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    u.uPrevViewProjection.value.copy(this.prevViewProjection);
    renderer.setRenderTarget(this.historyWrite);
    this.resolveQuad.render(renderer);

    this.compositeMaterial.uniforms.tBase.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tVolume.value = this.historyWrite.texture;
    this.compositeMaterial.uniforms.tSceneDepth.value = depthTexture;
    this.compositeMaterial.uniforms.uDepthReady.value = depthTexture ? 1 : 0;
    this.compositeMaterial.uniforms.uCameraFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.compositeQuad.render(renderer);

    this.prevNav.copy(this.nav);
    this.prevViewProjection.multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.historyValid = true;
    const swap = this.historyRead;
    this.historyRead = this.historyWrite;
    this.historyWrite = swap;
    this.frame++;
    renderer.setRenderTarget(oldTarget);
  }

  releaseTargets() {
    this.releaseLightBatches();
    for(const columns of this.columnMaps.values())columns.dispose();
    this.columnMaps.clear();this.columnRelease.clear();
    this.current.dispose();
    this.historyA.dispose();
    this.historyB.dispose();
    this.historyValid = false;
  }

  dispose() {
    this.releaseTargets();
    this.resolveMaterial.dispose();
    this.compositeMaterial.dispose();
    this.resolveQuad.dispose();
    this.compositeQuad.dispose();
  }
}

