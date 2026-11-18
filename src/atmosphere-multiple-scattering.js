import * as THREE from 'three';
import { OwnedScreenTriangle as FullScreenQuad } from './owned-screen-triangle.js';
import { atmosphereUniformGLSL, atmosphereTransportGLSL } from './atmosphere-transport-glsl.js';
import { atmosphereUniforms } from './atmosphere-uniforms.js';

const FIXED_BAKE_UNIFORMS = new Set([
  'uEnabled', 'uMultipleEnabled', 'uMultipleDirections', 'uMultipleSteps',
  'uLocalOccluderCount', 'uEclipseEnabled', 'uRadianceScale',
  'uSunDirection0', 'uSunEnergy0', 'uSunColor0', 'uSunEnergy1',
]);

const rendererBakeCache = new WeakMap();

function getBakeEntry(renderer, directions, steps) {
  let cache = rendererBakeCache.get(renderer);
  if (!cache) {
    const map = new Map();
    const onLost = () => {
      for (const item of map.values()) {
        item.material.dispose();
        item.quad.dispose();
      }
      map.clear();
    };
    renderer?.domElement?.addEventListener?.('webglcontextlost', onLost);
    cache = { map };
    if (renderer && typeof renderer === 'object') rendererBakeCache.set(renderer, cache);
  }
  const key = `${directions}:${steps}`;
  let entry = cache.map.get(key);
  if (entry) return entry;
  const baseUniforms = atmosphereUniforms();
  const material = new THREE.ShaderMaterial({
    name: 'Atmosphere multiple-scattering LUT',
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    defines: { STELLAR_UNION_OCCLUSION: 0 },
    uniforms: { ...baseUniforms,
      uEnabled: { value: 1 }, uMultipleEnabled: { value: 0 },
      uMultipleDirections: { value: directions },
      uMultipleSteps: { value: steps },
      uLocalOccluderCount: { value: 0 }, uEclipseEnabled: { value: 0 }, uRadianceScale: { value: 1 },
      uSunDirection0: { value: new THREE.Vector3() }, uSunEnergy0: { value: 1 },
      uSunColor0: { value: new THREE.Color(1, 1, 1) }, uSunEnergy1: { value: 0 },
    },
    vertexShader: 'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader: `precision highp float;
      #define VIEW_STEPS ${steps}
      uniform int uMultipleDirections, uMultipleSteps;
      ${atmosphereUniformGLSL}
      ${atmosphereTransportGLSL}
      void main() {
        float altitude = pow((gl_FragCoord.y-0.5)/31.0,2.0)*uTopAltitude;
        vec3 origin = vec3(0,uGroundR+max(altitude,1.0),0);
        float sunMu = (gl_FragCoord.x-0.5)/31.0*2.0-1.0;
        vec3 sun = vec3(sqrt(max(0.0,1.0-sunMu*sunMu)),sunMu,0);
        vec3 meanL=vec3(0), meanReturn=vec3(0);
        float invSteps = 1.0 / float(uMultipleSteps);
        for(int j=0;j<uMultipleDirections;j++) {
          float y=1.0-2.0*(float(j)+0.5)/float(${directions});
          float phi=float(j)*2.399963229728653;
          vec3 dir=vec3(sqrt(1.0-y*y)*cos(phi),y,sqrt(1.0-y*y)*sin(phi));
          vec2 outer=sphereHits(origin,uTopR,dir), ground=sphereHits(origin,uGroundR,dir);
          float end=outer.y;
          bool groundHit=ground.x>0.0;
          if(groundHit) end=min(end,ground.x);
          vec3 L=vec3(0), T=vec3(1), returned=vec3(0);
          float previous=0.0;
          for(int i=0;i<uMultipleSteps;i++) {
            float next=atmosphereSampleBoundary(0.0,end,-dot(origin,dir),float(i+1)*invSteps);
            float ds=next-previous;
            vec3 pos=origin+dir*(previous+next)*0.5;
            float h=max(0.0,length(pos)-uGroundR);
            float r=exp(-h/uRayleighScaleHeight)*uDensityScale;
            float m=exp(-h/uMieScaleHeight)*uDensityScale;
            vec3 scatter=uBetaRayleigh*r+uBetaMieScatter*m;
            vec3 ext=uBetaRayleigh*r+uBetaMieExtinction*m+uBetaOzone*ozoneDensity(h)*uDensityScale;
            vec3 source=starScatter(pos,dir,ds,r,m,sun,vec3(1),1.0);
            returned+=T*scatter*mediumIntegral(ext,ds);
            mediumStep(L,T,ext,source,ds);
            previous=next;
          }
          if(groundHit) {
            vec3 pos=origin+dir*end, radial=normalize(pos);
            float mu=dot(radial,sun);
            vec3 depth=sunlightOpticalDepth(0.0,mu).rgb
              *vec3(uRayleighScaleHeight,uMieScaleHeight,uOzoneHalfWidth)*uDensityScale;
            vec3 sunT=exp(-(uBetaRayleigh*depth.r+uBetaMieExtinction*depth.g+uBetaOzone*depth.b));
            L+=T*uGroundAlbedo*sunT*max(mu,0.0)/PI;
            returned+=T*uGroundAlbedo;
          }
          meanL+=L/float(${directions}); meanReturn+=returned/float(${directions});
        }
        gl_FragColor=vec4(meanL/max(vec3(0.001),vec3(1)-meanReturn),1);
      }`,
  });
  const quad = new FullScreenQuad(material);
  entry = { material, quad };
  cache.map.set(key, entry);
  return entry;
}

export function prewarmMultipleScatteringLut(renderer, { directions = 128, steps = 48, signal } = {}) {
  const { quad } = getBakeEntry(renderer, directions, steps);
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
  let pending;
  try {
    renderer.setRenderTarget(target);
    pending = quad.prepare(renderer, { signal });
  } finally {
    renderer.setRenderTarget(previous, face, mip);
    target.dispose();
  }
  return pending;
}

// Hillaire's isotropic higher-order closure: sphere-mean incident radiance
// divided by one minus the mean scattering return probability. This is an
// approximation to higher orders, not an observer-dependent ambient floor.
export function createMultipleScatteringLut(renderer, uniforms, { directions = 128, steps = 48 } = {}) {
  const target = new THREE.WebGLRenderTarget(32, 32, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  target.texture.name = 'atmosphere.multiple-scattering';
  const { material, quad } = getBakeEntry(renderer, directions, steps);
  const dst = material.uniforms;
  for (const [name, src] of Object.entries(uniforms || {})) {
    if (FIXED_BAKE_UNIFORMS.has(name) || !(name in dst)) continue;
    const cur = dst[name].value, val = src?.value;
    if (cur?.copy && val && typeof cur.copy === 'function' && cur.constructor === val.constructor) {
      cur.copy(val);
    } else {
      dst[name].value = val;
    }
  }
  dst.uMultipleDirections.value = directions;
  dst.uMultipleSteps.value = steps;
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
  const scissor = renderer.getScissorTest();
  try {
    renderer.setScissorTest(false); renderer.setRenderTarget(target); quad.render(renderer);
  } catch (error) {
    target.dispose(); throw error;
  } finally {
    dst.tOpticalDepth.value = null;
    dst.tMultipleScattering.value = null;
    renderer.setRenderTarget(previous, face, mip); renderer.setScissorTest(scissor);
  }
  return target;
}
