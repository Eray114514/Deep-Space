import * as THREE from 'three';
import {cloudSunCacheSamplingGLSL} from './cloud-sun-cache.js';

export function cloudLightCacheUniforms(fallback=null) {
  return {
    uSunTransport:{value:fallback},uSunCacheReady:{value:0},uSunCacheDepth:{value:128},
    uSunCacheMix:{value:0},uSunCacheOffsets:{value:new THREE.Vector2()},
    uSunCacheEncoded:{value:0},
    uSunCacheMatrixA:{value:Array.from({length:4},()=>new THREE.Matrix4())},
    uSunCacheMatrixB:{value:Array.from({length:4},()=>new THREE.Matrix4())},
    uSunCacheValidA:{value:new THREE.Vector4()},uSunCacheValidB:{value:new THREE.Vector4()},
    uSunCacheMarginA:{value:new THREE.Vector4()},uSunCacheMarginB:{value:new THREE.Vector4()},
  };
}

export const cloudLightCacheGLSL=/* glsl */`
  uniform sampler2D uSunTransport;
  uniform float uSunCacheReady,uSunCacheDepth,uSunCacheMix,uSunCacheEncoded;
  uniform vec2 uSunCacheOffsets;
  uniform mat4 uSunCacheMatrixA[4],uSunCacheMatrixB[4];
  uniform vec4 uSunCacheValidA,uSunCacheValidB,uSunCacheMarginA,uSunCacheMarginB;
  ${cloudSunCacheSamplingGLSL}
  bool cloudCachedLight(vec3 local,int field,out float opticalDepth) {
    opticalDepth=0.0;
    if(uSunCacheReady<.5 || uSunCacheValidA[field]<.5 || uSunCacheValidB[field]<.5)return false;
    vec3 a=(uSunCacheMatrixA[field]*vec4(local,1)).xyz,b=(uSunCacheMatrixB[field]*vec4(local,1)).xyz;
    float ma=uSunCacheMarginA[field],mb=uSunCacheMarginB[field],mz=.5/uSunCacheDepth;
    if(any(lessThan(a,vec3(ma,ma,mz))) || any(greaterThan(a,vec3(1.0-ma,1.0-ma,1.0-mz)))
      || any(lessThan(b,vec3(mb,mb,mz))) || any(greaterThan(b,vec3(1.0-mb,1.0-mb,1.0-mz))))return false;
    a.x=(float(field)+a.x)/4.0;b.x=(float(field)+b.x)/4.0;
    float va=sampleCloudSunCacheAt(uSunTransport,a,uSunCacheDepth,uSunCacheOffsets.x);
    float vb=sampleCloudSunCacheAt(uSunTransport,b,uSunCacheDepth,uSunCacheOffsets.y);
    float oa=uSunCacheEncoded>.5?exp(clamp(va,0.0,1.0)*log(129.0))-1.0:va;
    float ob=uSunCacheEncoded>.5?exp(clamp(vb,0.0,1.0)*log(129.0))-1.0:vb;
    opticalDepth=field>=2?mix(oa,ob,uSunCacheMix)
      :-log(max(mix(exp(-oa),exp(-ob),uSunCacheMix),1e-14));return true;
  }
`;
