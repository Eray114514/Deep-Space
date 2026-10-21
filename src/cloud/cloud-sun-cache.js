import * as THREE from 'three';
import { OwnedScreenTriangle as FullScreenQuad } from '../owned-screen-triangle.js';
import { productionCloudGLSL } from './production-medium-glsl.js';
import { weatherAtlasGLSL } from './weather-atlas.js';
import { cloudBeamGLSL } from './cloud-beam-glsl.js';
import {packProductionAcceleration,PRODUCTION_PARAMETER_LAYERS} from './production-bands.js';

export const cloudSunCacheSamplingGLSL=/* glsl */`
  float cloudSunCachePlaneAt(sampler2D cache,vec3 coordinate,float size,float layer,float offset) {
    vec2 dimensions=vec2(textureSize(cache,0));
    float cellSize=dimensions.x/32.0;
    float field=floor(coordinate.x*4.0),u=coordinate.x*4.0-field;
    float tile=offset+field*size+clamp(layer,0.0,size-1.0);
    vec2 cell=vec2(mod(tile,32.0),floor(tile/32.0));
    vec2 local=clamp(vec2(u,coordinate.y),vec2(.5/cellSize),vec2(1.0-.5/cellSize));
    return textureLod(cache,(cell+local)*cellSize/dimensions,0.0).r;
  }
  float sampleCloudSunCacheAt(sampler2D cache,vec3 coordinate,float size,float offset) {
    float z=coordinate.z*size-.5,k=floor(z),t=fract(z);
    float a=cloudSunCachePlaneAt(cache,coordinate,size,k-1.0,offset);
    float b=cloudSunCachePlaneAt(cache,coordinate,size,k,offset);
    float c=cloudSunCachePlaneAt(cache,coordinate,size,k+1.0,offset);
    float d=cloudSunCachePlaneAt(cache,coordinate,size,k+2.0,offset);
    float delta=c-b,m0=(c-a)*.5,m1=(d-b)*.5;
    if(abs(delta)<.000001){m0=0.0;m1=0.0;}
    else {m0=clamp(m0/delta,0.0,3.0)*delta;m1=clamp(m1/delta,0.0,3.0)*delta;}
    float t2=t*t,t3=t2*t;
    return max(0.0,(2.0*t3-3.0*t2+1.0)*b+(t3-2.0*t2+t)*m0
      +(-2.0*t3+3.0*t2)*c+(t3-t2)*m1);
  }
  float sampleCloudSunCache(sampler2D cache,vec3 coordinate,float size) {
    return sampleCloudSunCacheAt(cache,coordinate,size,0.0);
  }
`;

// Candidate local solar transport cache. A common radial grid resolves thin
// vertical profiles; each light follows its characteristic between planes.
// Exact incoming boundaries include light beyond the volume. This candidate
// is not bound to production until density, motion and cost errors are tested.
export class CloudSunCache {
  constructor(planet,center,{size=128,spacing=100,depth=256,verticalSpacing=50,shearSolar=true,
    target=null,tileOffset=0,hours=planet.weatherHours,forecast=null,encodeOpticalDepth=false,programOwner=null}={}) {
    this.planet=planet;this.size=size;this.spacing=spacing;this.depth=depth;this.verticalSpacing=verticalSpacing;
    this.center=center.clone();this.field=0;this.layer=depth-1;this.boundaryRow=0;
    this.ready=false;this.disposed=false;this.snapshots=[];
    this.programOwner=programOwner;
    // ANGLE/D3D11 copyTexSubImage3D can copy an entire volume on each plane
    // update. A slice atlas stores identical R16F data using cheap 2D copies.
    this.ownsTarget=!target;this.tileOffset=tileOffset;
    this.target=target||new THREE.WebGLRenderTarget(size*32,size*Math.ceil(depth*4/32),{format:THREE.RedFormat,
      type:encodeOpticalDepth?THREE.UnsignedByteType:THREE.HalfFloatType,
      minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});
    this.encodeOpticalDepth=this.target.texture.type===THREE.UnsignedByteType;
    if(this.encodeOpticalDepth) {
      // Preserve thick-column optical depth for the scattering closure. R8
      // transmission rounds tau > ~6.2 to zero, which was decoded as tau 32
      // and produced a bright patch wherever the local cache was available.
      // Sweep in R16F; only the finished log(1+tau) is quantized into R8.
      this.copyMaterial=new THREE.ShaderMaterial({uniforms:{tPlane:{value:null},
        uCopyOrigin:{value:new THREE.Vector2()},uCopySize:{value:size}},
        vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:'uniform sampler2D tPlane;uniform vec2 uCopyOrigin;uniform float uCopySize;void main(){float tau=texture2D(tPlane,(gl_FragCoord.xy-uCopyOrigin)/uCopySize).r;gl_FragColor=vec4(log(1.0+tau)/log(129.0),0,0,1);}',
        depthTest:false,depthWrite:false,blending:THREE.NoBlending});
      this.copyQuad=new FullScreenQuad(this.copyMaterial);
    }
    this.planes=[0,1].map(()=>new THREE.WebGLRenderTarget(size,size,{format:THREE.RedFormat,
      type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false}));
    const source=planet.volCloudMat.uniforms;
    const uniforms={};
    for(const [name,uniform] of Object.entries(source)) {
      const value=uniform.value;
      uniforms[name]={value:value?.isTexture?value:value?.clone?value.clone():value};
    }
    // A complete weather generation is held until all fields are ready.
    uniforms.uCloudAdvectionPhase.value=hours*planet.weatherField.windRadiansPerHour;
    const forecastBytes={};
    if(forecast) {
      const {first,second,mix}=forecast;
      if(!first || !second || !Number.isFinite(mix) || mix<0 || mix>1)
        throw Error('Solar cache requires a complete bracketed weather forecast');
      const bounds=first.bounds.map((v,i)=>i%2===0?Math.min(v,second.bounds[i]):Math.max(v,second.bounds[i]));
      const candidates=first.candidates.map((v,i)=>v|second.candidates[i]);
      const bands=first.bands.slice(),image=source.uSpeciesMap.value.image;
      for(let i=0;i<image.width*image.height*4*PRODUCTION_PARAMETER_LAYERS;i++)
        bands[i]=first.bands[i]*(1-mix)+second.bands[i]*mix;
      packProductionAcceleration(bands,image.width,image.height,bounds,candidates);
      const high=first.high.map((v,i)=>v*(1-mix)+second.high[i]*mix),highImage=source.uWeatherMapHi.value.image;
      const north=new Float32Array(high.length);
      for(let y=0;y<highImage.height;y++)north.set(high.subarray(y*highImage.width*4,(y+1)*highImage.width*4),
        (highImage.height-1-y)*highImage.width*4);
      Object.assign(forecastBytes,{uSpeciesMap:bands,uBandBounds:bounds,uBandCandidates:candidates,uWeatherMapHi:north});
    }
    for(const name of ['uSpeciesMap','uBandBounds','uBandCandidates','uWeatherMapHi']) {
      const original=source[name].value,image=original.image;
      const bytes=forecastBytes[name]||image.data.slice();
      const texture=image.depth
        ?new THREE.DataArrayTexture(bytes,image.width,image.height,image.depth)
        :new THREE.DataTexture(bytes,image.width,image.height,original.format,original.type);
      for(const key of ['format','type','internalFormat','wrapS','wrapT','minFilter','magFilter','colorSpace'])texture[key]=original[key];
      texture.needsUpdate=true;this.snapshots.push(texture);uniforms[name]={value:texture};
    }
    this.hours=hours;
    if(forecast) {
      uniforms.uSpin.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(
        -(planet.cloudSpinBase+hours*planet.weatherField.windRadiansPerHour)));
      uniforms.uSunDir.value.fromArray(forecast.directions[0].direction).normalize();
      uniforms.uSecondarySunDir.value.fromArray((forecast.directions[1]||forecast.directions[0]).direction).normalize();
    }
    this.directions=[uniforms.uSunDir.value.clone().normalize(),uniforms.uSecondarySunDir.value.clone().normalize(),
      center.clone().normalize(),center.clone().normalize().negate()];
    this.transforms=[];this.frames=[];this.inverseFrames=[];
    const up=center.clone().normalize();
    this.available=this.directions.map(direction=>Math.abs(direction.dot(up))>=.08);
    // Radial characteristics drift at most span*tan(theta) in the tangent
    // plane. Edge values may clamp; consumers must stay inside this support
    // margin so no such value can reach a valid sample's characteristic.
    const minimumRadius=Math.max(1,center.length()-depth*verticalSpacing*.5);
    const radialDrift=depth*verticalSpacing*(size*spacing/Math.SQRT2)/minimumRadius;
    const radialMargin=Math.ceil(radialDrift/spacing+2)/size;
    this.interiorMargins=[1/size,1/size,radialMargin,radialMargin];
    if(radialMargin>=.5){this.available[2]=false;this.available[3]=false;}
    for(let field=0;field<this.directions.length;field++) {
      const direction=this.directions[field];
      const helper=Math.abs(up.y)<.9?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);
      const x=new THREE.Vector3().crossVectors(helper,up).normalize();
      const y=new THREE.Vector3().crossVectors(up,x).normalize();
      // Solar characteristics are straight grid columns. Shearing the grid
      // keeps 50 m radial resolution without solving a full external beam at
      // every side pixel of every slice.
      const mu=direction.dot(up);
      const z=shearSolar && field<2 && Math.abs(mu)>=.08?direction.clone().multiplyScalar(1/mu):up;
      const basis=new THREE.Matrix3().set(x.x,y.x,z.x,x.y,y.y,z.y,x.z,y.z,z.z);
      this.frames.push(basis);
      const inverse=basis.clone().invert();this.inverseFrames.push(inverse);
      const extent=size*spacing;
      const transform=new THREE.Matrix4().setFromMatrix3(inverse);
      transform.premultiply(new THREE.Matrix4().makeScale(1/extent,1/extent,1/(depth*verticalSpacing)));
      const origin=center.clone().applyMatrix4(transform);
      transform.setPosition(.5-origin.x,.5-origin.y,.5-origin.z);
      this.transforms.push(transform);
    }
    const prefix=/* glsl */`
      precision highp sampler3D;
      uniform sampler3D uNoise3;
      uniform sampler2D uWeatherMapHi;
      uniform mat3 uSpin;
      uniform vec3 uCOff;
      uniform float uBodyR,uSurfaceRange,uRin,uRout,uGroundR,uCloudLightSteps;
      ${weatherAtlasGLSL}
      ${productionCloudGLSL}
      vec2 sphereHits(vec3 origin,float r,vec3 direction) {
        float b=dot(origin,direction),radius=length(origin);
        float d=b*b-(radius-r)*(radius+r);
        if(d<0.0)return vec2(-1);
        float root=sqrt(d);return vec2(-b-root,-b+root);
      }
      float cloudExtinctionAt(vec3 point,float unused) {
        float radius=length(point);if(radius<=uRin || radius>=uRout)return 0.0;
        vec2 layers=productionCloudLayersAt(point);return layers.x*.025+layers.y*.0006;
      }
      ${cloudBeamGLSL}
    `;
    this.material=new THREE.ShaderMaterial({uniforms:{...uniforms,uPrevious:{value:this.planes[0].texture},
      uCacheCenter:{value:this.center},uCacheBasis:{value:this.frames[0]},uCacheInverse:{value:this.inverseFrames[0]},
      uCacheUp:{value:up},uCacheSize:{value:size},
      uCacheSpacing:{value:spacing},uCacheDepth:{value:depth},uVerticalSpacing:{value:verticalSpacing},
      uCacheDirection:{value:this.directions[0]},uCacheRadial:{value:0},uCacheLayer:{value:depth-1},uCacheBoundary:{value:1}},
      vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:prefix+/* glsl */`
        uniform sampler2D uPrevious;
        uniform vec3 uCacheCenter;
        uniform mat3 uCacheBasis,uCacheInverse;
        uniform vec3 uCacheUp;
        uniform vec3 uCacheDirection;
        uniform float uCacheSize,uCacheSpacing,uCacheDepth,uVerticalSpacing,uCacheLayer,uCacheBoundary,uCacheRadial;
        void main() {
          vec3 q=vec3((gl_FragCoord.xy-uCacheSize*.5)*uCacheSpacing,
            (uCacheLayer+.5-uCacheDepth*.5)*uVerticalSpacing);
          vec3 point=uCacheCenter+uCacheBasis*q;
          vec3 direction=uCacheRadial>.5?normalize(point)*(uCacheRadial>1.5?-1.0:1.0):uCacheDirection;
          float mu=dot(direction,uCacheUp);
          float distance=uVerticalSpacing/max(abs(mu),.0001);
          vec3 stepVector=direction*distance;
          vec2 shift=(uCacheInverse*stepVector).xy;
          vec2 previousUv=(gl_FragCoord.xy+shift/uCacheSpacing)/uCacheSize;
          float opticalDepth;
          if(uCacheBoundary>.5 || (uCacheRadial<.5 && (any(lessThan(previousUv,vec2(.49/uCacheSize)))
            || any(greaterThan(previousUv,vec2(1.0-.49/uCacheSize))))))opticalDepth=
              cloudSunOpticalDepthLimit(point,direction,0.0,uCacheRadial>.5?128.0:12.0);
          else {
            float previous=textureLod(uPrevious,previousUv,0.0).r;
            float weighted=0.0;
            for(int node=0;node<int(max(uCloudLightSteps,4.0));node++) {
              if(node>=3)break;
              float location=node==0?.1127016654:node==1?.5:.8872983346;
              weighted+=cloudExtinctionAt(point+stepVector*location,0.0)*(node==1?8.0:5.0);
            }
            float od=weighted*distance/18.0;
            opticalDepth=previous+od;
          }
          gl_FragColor=vec4(min(opticalDepth,128.0),0,0,1);
        }`,depthTest:false,depthWrite:false,blending:THREE.NoBlending});
    this.quad=new FullScreenQuad(this.material);this.previous=0;this.submissions=[];
  }
  bakeSlice(renderer,{boundaryRows=4,slices=1}={}) {
    if(this.disposed || this.ready)return;
    const started=performance.now(),saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace();
    const mip=renderer.getActiveMipmapLevel(),auto=renderer.autoClear;
    try {
      renderer.autoClear=false;
      while(this.field<4 && !this.available[this.field])this.field++;
      if(this.field===4){this.finish();return;}
      const u=this.material.uniforms;
      u.uCacheBasis.value=this.frames[this.field];u.uCacheDirection.value=this.directions[this.field];
      u.uCacheInverse.value=this.inverseFrames[this.field];
      u.uCacheRadial.value=this.field<2?0:this.field===2?1:2;
      const sign=this.directions[this.field].dot(this.center.clone().normalize())>=0?-1:1;
      const front=sign<0?this.depth-1:0;
      if(this.boundaryRow===0 && (this.layer===this.depth-1 || this.layer===0))this.layer=front;
      u.uCacheLayer.value=this.layer;
      if(this.layer===front) {
        const plane=this.planes[this.previous],rows=Math.min(boundaryRows,this.size-this.boundaryRow);
        u.uCacheBoundary.value=1;
        u.uPrevious.value=this.planes[1-this.previous].texture;
        plane.viewport.set(0,0,this.size,this.size);plane.scissor.set(0,this.boundaryRow,this.size,rows);
        plane.scissorTest=true;renderer.setRenderTarget(plane);this.quad.render(renderer);
        this.boundaryRow+=rows;
        if(this.boundaryRow<this.size)return;
        this.copyPlane(renderer,plane,this.layer);this.layer+=sign;
      } else {
        for(let i=0;i<slices && this.layer>=0 && this.layer<this.depth;i++) {
          const next=1-this.previous,plane=this.planes[next];
          u.uCacheBoundary.value=0;u.uCacheLayer.value=this.layer;u.uPrevious.value=this.planes[this.previous].texture;
          plane.scissorTest=false;plane.viewport.set(0,0,this.size,this.size);
          renderer.setRenderTarget(plane);this.quad.render(renderer);
          this.copyPlane(renderer,plane,this.layer);this.previous=next;this.layer+=sign;
        }
      }
      if(this.layer<0 || this.layer>=this.depth) {
        this.field++;this.layer=this.depth-1;this.boundaryRow=0;
        if(this.field===4) {
          this.finish();
        }
      }
    } finally {
      renderer.setRenderTarget(saved,face,mip);renderer.autoClear=auto;
      this.submissions.push(performance.now()-started);
    }
  }
  copyPlane(renderer,plane,layer) {
    renderer.initRenderTarget(this.target);
    const tile=this.tileOffset+this.field*this.depth+layer;
    if(this.encodeOpticalDepth) {
      const x=(tile%32)*this.size,y=Math.floor(tile/32)*this.size;
      this.target.viewport.set(0,0,this.target.width,this.target.height);
      this.target.scissor.set(x,y,this.size,this.size);this.target.scissorTest=true;
      this.copyMaterial.uniforms.tPlane.value=plane.texture;
      this.copyMaterial.uniforms.uCopyOrigin.value.set(x,y);
      renderer.setRenderTarget(this.target);this.copyQuad.render(renderer);return;
    }
    renderer.copyTextureToTexture(plane.texture,this.target.texture,null,
      new THREE.Vector2((tile%32)*this.size,Math.floor(tile/32)*this.size));
  }
  finish() {
    this.ready=true;for(const texture of this.snapshots)texture.dispose();this.snapshots=[];
    this.releaseProgram('sweep',this.material);this.quad.dispose();
    this.material=null;this.quad=null;
    this.releaseProgram('copy',this.copyMaterial);this.copyQuad?.dispose();this.copyMaterial=null;this.copyQuad=null;
    for(const plane of this.planes)plane.dispose();this.planes=[];
  }
  releaseProgram(key,material) {
    if(!material)return;
    // Keep one compiled material per bank so completing an endpoint does not
    // evict the identical program needed by the next field. Uniforms belong
    // to the finished snapshot, not this program lease, and must be released.
    // Three retains this uniform dictionary in renderer properties too.
    // Empty that same object, rather than only replacing the public pointer.
    for(const name of Object.keys(material.uniforms))delete material.uniforms[name];
    if(this.programOwner && !this.programOwner[key])this.programOwner[key]=material;
    else material.dispose();
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    for(const texture of this.snapshots)texture.dispose();this.snapshots=[];
    if(this.ownsTarget)this.target.dispose();for(const plane of this.planes)plane.dispose();
    this.material?.dispose();this.quad?.dispose();
    this.copyMaterial?.dispose();this.copyQuad?.dispose();
  }
}
