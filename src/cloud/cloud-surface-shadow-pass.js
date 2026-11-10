import * as THREE from 'three';
import {FullScreenQuad} from '../../vendor/jsm/postprocessing/Pass.js';
import {productionCloudGLSL} from './production-medium-glsl.js';
import {weatherAtlasGLSL} from './weather-atlas.js';
import {cloudBeamGLSL} from './cloud-beam-glsl.js';
import {cloudLightCacheGLSL} from './cloud-light-cache-glsl.js';
import {withCloudSurfacePreparation, surfaceCloudOwner} from './surface-clouds.js';

// Forecast readiness owns cache endpoints, not the currently published field.
// Before a forecast bracket is ready, the receiver can integrate that field's
// full physical beam. Legacy/clear materials do not publish production bands.
export function cloudSurfaceReceiverReady(body) {
  const material = body?.volCloudMat, u = material?.uniforms;
  return Boolean(body?.volCloudMesh && body.cloudVisualEnabled !== false
    && material?.defines?.PRODUCTION_CLOUD_MEDIUM === 1 && body.cloudSpeciesTex
    && u.uBandsReady?.value > 0.5 && u.uSpeciesMap?.value === body.cloudSpeciesTex
    && u.uNoise3?.value && u.uWeatherMapHi?.value);
}

// Compute the same two physical solar beams on a depth-guided screen grid.
// The opaque depth is current-frame, from the original displaced materials.
// Reuse the composer's target; do not add a second full-resolution depth owner.
export class CloudSurfaceShadowPass {
  constructor(scene,camera,{scale=.25}={}) {
    this.scene=scene;this.camera=camera;this.scale=scale;this.ready=false;
    this.depthValid=false;
    this.receiverIds=new Map();
    this.receiverTransforms=new Map();
    this.viewport=new THREE.Vector2();
    this.target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false,
      minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    this.material=new THREE.ShaderMaterial({uniforms:{},depthTest:false,depthWrite:false,
      vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:`precision highp sampler3D;uniform sampler3D uNoise3;
        uniform sampler2D uWeatherMapHi,tOpaqueDepth;uniform mat3 uSpin,uViewToLocal;
        uniform mat4 uInvProjection;uniform vec3 uCOff,uCameraLocal,uSunDir,uSecondarySunDir;
        uniform vec2 uShadowSize,uDepthSize;
        uniform float uBodyR,uSurfaceRange,uRin,uRout,uGroundR,uCloudLightSteps,uCameraFar,uSecondarySunEnergy;
        uniform float uReceiverId,uReceiverBound;
        ${weatherAtlasGLSL}\n${productionCloudGLSL}
        vec2 sphereHits(vec3 o,float r,vec3 d) {
          float b=dot(o,d),radius=length(o),disc=b*b-(radius-r)*(radius+r);
          if(disc<0.0)return vec2(-1);float q=sqrt(disc);return vec2(-b-q,-b+q);
        }
        float cloudExtinctionAt(vec3 p,float unused) {
          if(length(p)<=uRin||length(p)>=uRout)return 0.0;
          vec2 density=productionCloudLayersAt(p);return density.x*.025+density.y*.0006;
        }
        ${cloudBeamGLSL}
        ${cloudLightCacheGLSL}
        void main() {
          // Keep a receiver for every occupied full-resolution pixel in this
          // block, including a coastline or silhouette narrower than one
          // shadow texel. Centre-only downsampling silently lost those pixels.
          ivec2 first=ivec2(floor(floor(gl_FragCoord.xy)*uDepthSize/uShadowSize));
          ivec2 last=ivec2(ceil((floor(gl_FragCoord.xy)+1.0)*uDepthSize/uShadowSize));
          ivec2 pixel=first;float depth=1.0;
          for(int y=0;y<8;y++)for(int x=0;x<8;x++) {
            ivec2 candidate=first+ivec2(x,y);
            if(any(greaterThanEqual(candidate,last)))continue;
            candidate=clamp(candidate,ivec2(0),ivec2(uDepthSize)-1);
            float z=texelFetch(tOpaqueDepth,candidate,0).r;
            if(z<depth){depth=z;pixel=candidate;}
          }
          if(depth>=.999999)discard;
          vec2 uv=(vec2(pixel)+.5)/uDepthSize;
          vec4 view=uInvProjection*vec4(uv*2.0-1.0,1,1);
          vec3 ray=view.xyz/max(abs(view.z),1e-20);
          vec3 point=uCameraLocal+uViewToLocal*ray*(pow(uCameraFar+1.0,depth)-1.0);
          if(length(point)>uReceiverBound)discard;
          vec2 transmission=vec2(1);
          for(int star=0;star<2;star++) {
            if(star==1&&uSecondarySunEnergy<=0.0)continue;
            vec3 sun=normalize(star==0?uSunDir:uSecondarySunDir);
            float od;
            if(!cloudCachedLight(point,star,od))od=cloudSunOpticalDepth(point,sun,0.0);
            transmission[star]=exp(-od);
          }
          gl_FragColor=vec4(transmission,depth,uReceiverId);
        }`});
    this.quad=new FullScreenQuad(this.material);this.rotation=new THREE.Matrix4();
  }
  render(renderer,opaque,planet,profiler=null) {
    this.ready=false;this.depthValid=false;this.receiverIds.clear();this.receiverTransforms.clear();
    if(this.owner&&this.owner!==planet)this.owner.cloudSurfaceShadowCache=null;
    this.owner=planet;
    const bodies=new Set();
    const add=body=>{
      if(cloudSurfaceReceiverReady(body))bodies.add(body);
    };
    add(planet);
    this.scene.traverseVisible(object=>{
      for(const material of [object.material].flat())add(surfaceCloudOwner(material));
    });
    if(!bodies.size||!opaque?.depthTexture)return;
    // This depth belongs to a composer attachment. Canvas dimensions can
    // change independently while an offscreen view or resize is in flight.
    const size=this.viewport.set(opaque.width,opaque.height);
    const width=Math.max(1,Math.ceil(size.x*this.scale)),height=Math.max(1,Math.ceil(size.y*this.scale));
    if(this.target.width!==width||this.target.height!==height)this.target.setSize(width,height);
    const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const auto=renderer.autoClear;
    try {
      renderer.setRenderTarget(opaque);renderer.autoClear=true;
      const depth=()=>withCloudSurfacePreparation(true,()=>renderer.render(this.scene,this.camera));
      if(profiler)profiler.run('cloud-receiver-depth',depth);else depth();
      // One depth owner and one transport image for every actual receiver.
      // Remote bodies otherwise retained the enormous point-density kernel in
      // every PBR fragment, including late-depth-rejected fragments.
      this.camera.updateMatrixWorld(true);
      const clear=new THREE.Color();renderer.getClearColor(clear);const alpha=renderer.getClearAlpha();
      renderer.setRenderTarget(this.target);renderer.setClearColor(0x000000,0);renderer.clear(true,false,false);
      renderer.setClearColor(clear,alpha);renderer.autoClear=false;
      let receiverId=1;
      for(const body of bodies) {
        const source=body.volCloudMat.uniforms,u=this.material.uniforms;
        for(const [name,uniform] of Object.entries(source))u[name]=uniform;
        body.volCloudMesh.updateWorldMatrix(true,false);
        this.rotation.copy(body.volCloudMesh.matrixWorld).invert().multiply(this.camera.matrixWorld);
        // Reconstruct receivers from the same real eye as opaque rendering,
        // including chase/cockpit offsets; the source uniform may be nav-local
        // for another visible body's inactive cloud representation.
        u.uCameraLocal={value:new THREE.Vector3().setFromMatrixPosition(this.rotation)};
        u.uInvProjection={value:this.camera.projectionMatrixInverse};
        u.uViewToLocal={value:new THREE.Matrix3().setFromMatrix4(this.rotation)};
        this.receiverTransforms.set(body,u.uViewToLocal.value);
        u.uShadowSize={value:new THREE.Vector2(width,height)};u.uDepthSize={value:size};
        u.tOpaqueDepth={value:opaque.depthTexture};u.uCameraFar={value:this.camera.far};
        u.uReceiverBound={value:body.R+Math.max(1000,(body.hAmp||0)*4)};
        u.uReceiverId={value:receiverId};this.receiverIds.set(body,receiverId++);
        // Uniform objects change between bodies even when the shader program
        // is shared. ShaderMaterial must explicitly upload each receiver.
        this.material.uniformsNeedUpdate=true;
        const transport=()=>this.quad.render(renderer);
        if(profiler)profiler.run('cloud-receiver-transport',transport);else transport();
      }
      this.ready=true;this.depthValid=true;this.opaqueDepth=opaque.depthTexture;
      this.renderer=renderer;renderer.cloudSurfaceReceiver=this;
      if(planet)planet.cloudSurfaceShadowCache=this;
    } finally {
      renderer.setRenderTarget(saved,face,mip);renderer.autoClear=auto;
    }
  }
  dispose() {
    this.ready=false;this.depthValid=false;if(this.owner)this.owner.cloudSurfaceShadowCache=null;
    if(this.renderer?.cloudSurfaceReceiver===this)this.renderer.cloudSurfaceReceiver=null;
    this.receiverIds.clear();this.receiverTransforms.clear();
    this.target.dispose();this.material.dispose();this.quad.dispose();
  }
}
