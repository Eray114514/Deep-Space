import { productionCloudGLSL } from './production-medium-glsl.js';
import { cloudBeamGLSL } from './cloud-beam-glsl.js';
import { productionSpeciesParameters } from './production-shape.js';
import { cloudNoiseDistribution } from './cloud-noise.js';
import { PRODUCTION_PARAMETER_LAYERS } from './production-bands.js';
import {cloudLightCacheGLSL,cloudLightCacheUniforms} from './cloud-light-cache-glsl.js';
import * as THREE from 'three';
import { SurfaceViewFrame } from '../surface-view-frame.js';
const surfaceViews = new WeakMap();
let preparingSurface=false;
export function setCloudSurfacePreparation(value) {preparingSurface=Boolean(value);}

const names=['uNoise3','uSpeciesMap','uBandsReady','uCandidatesReady','uCandidateLayers',
  'uSpeciesMask','uSpeciesCount','uMediumLayer','uWeatherMapHi','uCloudAdvectionPhase','uSpeciesPartition',
  'uSpin','uCOff','uBodyR','uSurfaceRange','uRin','uRout','uGroundR','uCloudLightSteps'];
names.push('uCameraLocal','uCameraFar');
names.push('uSunDir','uSecondarySunDir',...Object.keys(cloudLightCacheUniforms()));
const prefix=source=>source.replace(/\bu[A-Z]\w*\b/g,name=>'cloud_'+name);
export function hasSurfaceCloudMedium(planet) {
  // Weather bands can exist with volumetrics disabled. A surface variant may
  // declare the mixed sampler types only when their uniform owner exists.
  return Boolean(planet.cloudSpeciesTex && (planet.volCloudUniforms || planet.volCloudMat?.uniforms));
}
// Surface PBR owns other material textures. Store the small species parameter
// table in uniforms so the same conservative bounds/candidates fit WebGL2's
// sixteen fragment samplers. Acceleration is also packed in unused array
// slices of the species texture. Removing it made every surface pixel
// walk sixteen species through kilometres of empty air.
const surfaceDensity = productionCloudGLSL
  .replace('if(size.z<=16)return (weatherAtlasSample(uWeatherMapHi,radial).g*2.0-1.0)*uSurfaceRange;', '')
  .replace('uniform usampler2DArray uBandCandidates;', '')
  .replace('uniform sampler2D uBandBounds;', '')
  .replace('textureLod(uBandBounds,weatherAtlasUV(uSpin*radial),0.0)',
    'packedCloudBounds(weatherAtlasUV(uSpin*radial))')
  .replaceAll('textureSize(uBandCandidates,0)', 'ivec3(64,32,64)')
  .replaceAll(/texelFetch\(uBandCandidates,ivec3\(cell,([^\n]+?)\),0\)\.r/g,
    'packedCloudCandidates(ivec3(cell,$1))')
  .replace('uniform sampler2D uSpeciesParameters;',
    'uniform vec4 uSpeciesOptics[16],uSpeciesShapes[16],uSpeciesStructures[16],uSelectionCDF[16];')
  .replace('texelFetch(uSpeciesParameters,ivec2(i,0),0)', 'uSpeciesOptics[i]')
  .replace('texelFetch(uSpeciesParameters,ivec2(i,1),0)', 'uSpeciesShapes[i]')
  .replace('texelFetch(uSpeciesParameters,ivec2(i,2),0)', 'uSpeciesStructures[i]')
  .replace('texelFetch(uSpeciesParameters,ivec2(a/4,3),0)[a%4]', 'uSelectionCDF[a/4][a%4]')
  .replace('texelFetch(uSpeciesParameters,ivec2(b/4,3),0)[b%4]', 'uSelectionCDF[b/4][b%4]')
  .replace('vec4 speciesOpticsAt(int i)', `
    vec4 packedCloudBounds(vec2 uv) {
      ivec3 size=textureSize(uSpeciesMap,0);
      ivec2 cell=clamp(ivec2(floor(uv*vec2(size.xy))),ivec2(0),size.xy-1);
      return texelFetch(uSpeciesMap,ivec3(cell,size.z-2),0);
    }
    uint packedCloudCandidates(ivec3 cell) {
      ivec3 size=textureSize(uSpeciesMap,0);
      int index=(cell.z*32+cell.y)*64+cell.x,pixel=index/4;
      ivec3 location=ivec3(pixel%size.x,(pixel/size.x)%size.y,${PRODUCTION_PARAMETER_LAYERS}+pixel/(size.x*size.y));
      return uint(texelFetch(uSpeciesMap,location,0)[index%4]);
    }
    vec4 speciesOpticsAt(int i)`);
const shared=/* glsl */`
  precision highp sampler3D;
  uniform sampler3D uNoise3;
  uniform sampler2D uWeatherMapHi;
  uniform mat3 uSpin;
  uniform vec3 uCOff;
  uniform float uBodyR,uSurfaceRange,uRin,uRout,uGroundR,uCloudLightSteps;
  uniform vec3 uSunDir,uSecondarySunDir;
  uniform vec3 uCameraLocal;uniform float uCameraFar;
  ${surfaceDensity}
  ${cloudLightCacheGLSL}
  vec2 sphereHits(vec3 origin,float r,vec3 direction) {
    float b=dot(origin,direction),radius=length(origin);
    float discriminant=b*b-(radius-r)*(radius+r);
    if(discriminant<0.0)return vec2(-1);
    float root=sqrt(discriminant);return vec2(-b-root,-b+root);
  }
  float cloudExtinctionAt(vec3 point,float unused) {
    if(length(point)<=uRin || length(point)>=uRout)return 0.0;
    vec2 layers=productionCloudLayersAt(point);return layers.x*.025+layers.y*.0006;
  }
  ${cloudBeamGLSL}
`;
// weatherAtlasGLSL is already installed by terrain/water. Namespaced uniforms
// are refreshed from the live owner after fixture and weather transactions.
export const surfaceCloudGLSL=/* glsl */`
  #ifndef SURFACE_CLOUD_SCREEN
    #define SURFACE_CLOUD_SCREEN 0
  #endif
  uniform float uSurfaceCloudEnabled;
  uniform vec2 uCloudShadowViewport;
  uniform vec3 uCloudShadowForward;
  uniform float uCloudForeignReceiver,uCloudBodyBoundRadius;
  uniform float uCloudReceiverId;
  #if SURFACE_CLOUD_MEDIUM
  #if SURFACE_CLOUD_SCREEN
  uniform sampler2D cloud_uSunTransport;
  uniform vec3 cloud_uSunDir,cloud_uSecondarySunDir;
  uniform float cloud_uSunCacheReady;
  #else
  ${prefix(shared)}
  #endif
  bool cloudScreenShadowAt(vec2 uv,float depth,int field,out float transmission) {
    ivec2 size=textureSize(cloud_uSunTransport,0);
    vec2 p=uv*vec2(size)-.5;ivec2 cell=ivec2(floor(p));vec2 f=fract(p);
    // Normalize depth weights before exponentiation. Hidden terrain can lie
    // behind the water depth captured by the receiver pass. Its common depth
    // offset must not underflow all four weights and launch a full solar march
    // for fragments that the depth test will subsequently reject.
    float nearest=1e20;
    for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
      vec4 tap=texelFetch(cloud_uSunTransport,clamp(cell+ivec2(x,y),ivec2(0),size-1),0);
      if(tap.a>.5 && (uCloudReceiverId<.5 || abs(tap.a-uCloudReceiverId)<.1))
        nearest=min(nearest,abs(tap.b-depth));
    }
    if(nearest==1e20){transmission=1.0;return false;}
    float total=0.0,weights=0.0;
    for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
      vec4 tap=texelFetch(cloud_uSunTransport,clamp(cell+ivec2(x,y),ivec2(0),size-1),0);
      if(tap.a<.5 || (uCloudReceiverId>.5 && abs(tap.a-uCloudReceiverId)>=.1))continue;
      float w=(x==1?f.x:1.0-f.x)*(y==1?f.y:1.0-f.y);
      w*=exp(-(abs(tap.b-depth)-nearest)*600.0);
      total+=tap[field]*w;weights+=w;
    }
    transmission=total/max(weights,1e-20);return weights>0.0;
  }
  #endif
  float surfaceCloudTransmission(vec3 local,vec3 direction) {
    if(uSurfaceCloudEnabled<0.5)return 1.0;
    #if SURFACE_CLOUD_MEDIUM
    #if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
    float fragmentDepth=gl_FragDepth;
    #else
    float fragmentDepth=gl_FragCoord.z;
    #endif
    #if !SURFACE_CLOUD_SCREEN
    if(uCloudForeignReceiver>.5) {
      ivec2 size=textureSize(cloud_uSunTransport,0);
      ivec2 pixel=clamp(ivec2(gl_FragCoord.xy),ivec2(0),size-1);
      float front=texelFetch(cloud_uSunTransport,pixel,0).r;
      if(front+0.000001<fragmentDepth) {
        float nearDistance=pow(cloud_uCameraFar+1.0,front)-1.0;
        float ownDistance=pow(cloud_uCameraFar+1.0,fragmentDepth)-1.0;
        vec3 receiver=mix(cloud_uCameraLocal,local,nearDistance/max(ownDistance,1e-20));
        // Do not elide a body's own underwater bed or terrain. Only a
        // receiver outside its conservative bound proves foreign occlusion.
        if(length(receiver)>uCloudBodyBoundRadius)return 1.0;
      }
    }
    #endif
    float od;
    int field=dot(direction,cloud_uSunDir)>=dot(direction,cloud_uSecondarySunDir)?0:1;
    if(cloud_uSunCacheReady<-.5) {
      vec2 uv=gl_FragCoord.xy/uCloudShadowViewport;
      // StandardMaterial writes its logarithmic depth before lighting. Read
      // that value: gl_FragCoord.z is the pre-log interpolation, and repeating
      // a large body-local subtraction can reject a valid current-frame tap.
      float depth=fragmentDepth;
      float transmission;
      if(cloudScreenShadowAt(uv,depth,field,transmission))return transmission;
      // The current receiver pass conservatively covers every opaque pixel.
      // No supported tap means this fragment is outside the visible receiver
      // silhouette. A late depth test can still shade hidden terrain here.
      return 1.0;
    }
    #if !SURFACE_CLOUD_SCREEN
    if(cloudCachedLight(local,field,od))return exp(-od);
    return exp(-cloudSunOpticalDepth(local,direction,0.0));
    #else
    return 1.0;
    #endif
    #else
    return 1.0;
    #endif
  }
`;
// StandardMaterial asks for the same two stellar transmissions in multiple
// light branches and water glints. Evaluate each actual star once, after the
// fragment has written its depth, rather than inlining the full beam at every
// PBR call site. Stellar IDs/order come from bindStellarOcclusion.
export const surfaceCloudLightingGLSL=/* glsl */`
  vec2 surfaceCloudSunT=vec2(1.0);
  void initializeSurfaceCloudLighting(vec3 local) {
    for(int star=0;star<uLocalStarCount;star++) {
      vec3 direction=normalize(uLocalStars[star].xyz-local);
      surfaceCloudSunT[star]=surfaceCloudTransmission(local,direction);
    }
  }
  float surfaceCloudLighting(vec3 direction) {
    #if SURFACE_CLOUD_MEDIUM
    int field=dot(direction,cloud_uSunDir)>=dot(direction,cloud_uSecondarySunDir)?0:1;
    return surfaceCloudSunT[field];
    #else
    return 1.0;
    #endif
  }
`;
export function surfaceCloudUniforms(planet) {
  const source=planet.volCloudUniforms || planet.volCloudMat?.uniforms,result={};
  result.uSurfaceCloudEnabled={value:planet.cloudVisualEnabled===false?0:1};
  result.uCloudShadowViewport={value:new THREE.Vector2(1,1)};
  result.uCloudShadowForward={value:new THREE.Vector3(0,0,-1)};
  result.uCloudForeignReceiver={value:0};
  result.uCloudReceiverId={value:0};
  result.uCloudBodyBoundRadius={value:planet.R+Math.max(1000,(planet.hAmp||0)*4)};
  if(source)for(const name of names)result['cloud_'+name]={value:source[name]?.value};
  // This is view-local, unlike the borrowed weather and lighting resources.
  result.cloud_uCameraLocal={value:source?.uCameraLocal?.value?.clone() || new THREE.Vector3()};
  const parameters=productionSpeciesParameters();
  result.cloud_uSpeciesOptics={value:new Float32Array(parameters.flatMap(p=>p.optics))};
  result.cloud_uSpeciesShapes={value:new Float32Array(parameters.flatMap(p=>p.shape))};
  result.cloud_uSpeciesStructures={value:new Float32Array(parameters.flatMap(p=>p.structure))};
  result.cloud_uSelectionCDF={value:cloudNoiseDistribution()};
  result.uCloudSkyEnv={value:null};result.uCloudSkyReady={value:0};
  result.uCloudSkyMaxLod={value:6};return result;
}
export function bindSurfaceClouds(uniforms,planet,renderer=null,camera=null,material=null) {
  uniforms.uSurfaceCloudEnabled.value=preparingSurface||planet.cloudVisualEnabled===false?0:1;
  const source=planet.volCloudUniforms || planet.volCloudMat?.uniforms;
  uniforms.uCloudForeignReceiver.value=0;
  if(source)for(const name of names)if(name!=='uCameraLocal' && uniforms['cloud_'+name])uniforms['cloud_'+name].value=source[name]?.value;
  if(camera && planet.group) {
    let view=surfaceViews.get(planet);
    if(!view){view=new SurfaceViewFrame(planet);surfaceViews.set(planet,view);}
    view.sync(camera);uniforms.cloud_uCameraLocal.value.copy(view.origin);
  } else if(source?.uCameraLocal)uniforms.cloud_uCameraLocal.value.copy(source.uCameraLocal.value);
  if(camera && uniforms.cloud_uCameraFar)uniforms.cloud_uCameraFar.value=camera.far;
  const sharedScreen=renderer?.cloudSurfaceReceiver;
  const screen=sharedScreen?.receiverIds?.has(planet)?sharedScreen:planet.cloudSurfaceShadowCache;
  const screenMode=Boolean(preparingSurface || (screen?.ready && screen.camera===camera));
  if(material) {
    material.defines ||= {};
    if(material.defines.SURFACE_CLOUD_SCREEN!==Number(screenMode)) {
      material.defines.SURFACE_CLOUD_SCREEN=Number(screenMode);material.needsUpdate=true;
    }
  }
  uniforms.uCloudReceiverId.value=0;
  const receiver=renderer?.cloudSurfaceReceiver;
  if(!preparingSurface && receiver?.depthValid && receiver.camera===camera
    && receiver.owner!==planet && source) {
    // A foreign body has no active local sunlight bank in this draw. Reuse its
    // existing transport sampler for depth rather than exceeding WebGL2's
    // sixteen-sampler minimum when terrain shadow maps are also enabled.
    uniforms.cloud_uSunTransport.value=receiver.opaqueDepth;
    uniforms.cloud_uSunCacheReady.value=0;
    uniforms.uCloudForeignReceiver.value=1;
  }
  if(!preparingSurface && screen?.ready && screen.camera===camera) {
    uniforms.cloud_uSunTransport.value=screen.target.texture;
    uniforms.cloud_uSunCacheReady.value=-1;
    uniforms.uCloudShadowViewport.value=screen.viewport;
    uniforms.uCloudReceiverId.value=screen.receiverIds?.get(planet)||1;
    camera.getWorldDirection(uniforms.uCloudShadowForward.value).applyQuaternion(planet._invFrame);
  }
  uniforms.uCloudSkyEnv.value=planet.cloudSkyCache?.texture||null;
  uniforms.uCloudSkyReady.value=planet.cloudSkyCache?.ready?1:0;
}
