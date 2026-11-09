import * as THREE from 'three';
import { OwnedScreenTriangle } from '../owned-screen-triangle.js';
import { productionCloudGLSL } from './production-medium-glsl.js';
import { weatherAtlasGLSL } from './weather-atlas.js';
import { cloudBeamGLSL } from './cloud-beam-glsl.js';

const sweepPrefix=/* glsl */`
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

export function createCloudSunSweepMaterial(uniforms) {
  return new THREE.ShaderMaterial({uniforms,
      vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:sweepPrefix+/* glsl */`
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
}

export function createCloudSunCopyMaterial(uniforms) {
  return new THREE.ShaderMaterial({uniforms,
        vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:'uniform sampler2D tPlane;uniform vec2 uCopyOrigin;uniform float uCopySize;void main(){float tau=texture2D(tPlane,(gl_FragCoord.xy-uCopyOrigin)/uCopySize).r;gl_FragColor=vec4(log(1.0+tau)/log(129.0),0,0,1);}',
        depthTest:false,depthWrite:false,blending:THREE.NoBlending});
}

// Compile the same programs as the real cache, with no atlas, weather
// snapshots, or render submissions. Retaining these materials retains the
// native handles and their reflection caches across the first real draw.
export async function prepareCloudSunPrograms(renderer, signal) {
  const programs = { sweep:createCloudSunSweepMaterial({}), copy:createCloudSunCopyMaterial({}) };
  const saved = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
  const pending = [], handles = [];
  let retained = false;
  try {
    try {
      for (const [key,material] of Object.entries(programs)) {
        const triangle = new OwnedScreenTriangle(material);
        const target = new THREE.WebGLRenderTarget(1,1,{format:THREE.RedFormat,
          type:key==='sweep'?THREE.HalfFloatType:THREE.UnsignedByteType,depthBuffer:false});
        try {
          renderer.setRenderTarget(target);
          const ready = triangle.prepare(renderer,{signal});
          ready.catch(() => {});pending.push(ready);
          handles.push(renderer.properties.get(material).currentProgram);
        } finally {
          renderer.setRenderTarget(saved,face,mip);
          target.dispose();triangle.dispose();
        }
      }
    } finally { renderer.setRenderTarget(saved,face,mip); }
    await Promise.all(pending);
    if (signal.aborted || renderer.getContext().isContextLost()) throw Error('Cloud lighting preparation retired');
    for (const handle of handles) {
      handle.getUniforms();
      if (handle.diagnostics?.runnable === false) throw Error('Cloud lighting program link failed');
    }
    retained = true;
    return programs;
  } finally {
    if (!retained) for (const material of Object.values(programs)) material.dispose();
  }
}
