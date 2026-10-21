import * as THREE from 'three';
import { OwnedScreenTriangle as FullScreenQuad } from './owned-screen-triangle.js';
import { atmosphereUniformGLSL, atmosphereTransportGLSL } from './atmosphere-transport-glsl.js';

// Hillaire's isotropic higher-order closure: sphere-mean incident radiance
// divided by one minus the mean scattering return probability. This is an
// approximation to higher orders, not an observer-dependent ambient floor.
export function createMultipleScatteringLut(renderer, uniforms, { directions = 128, steps = 48 } = {}) {
  const target = new THREE.WebGLRenderTarget(32, 32, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  target.texture.name = 'atmosphere.multiple-scattering';
  const material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    uniforms: { ...uniforms,
      uEnabled: { value: 1 }, uMultipleEnabled: { value: 0 },
      uMultipleDirections: { value: directions },
      uLocalOccluderCount: { value: 0 }, uEclipseEnabled: { value: 0 }, uRadianceScale: { value: 1 },
      uSunDirection0: { value: new THREE.Vector3() }, uSunEnergy0: { value: 1 },
      uSunColor0: { value: new THREE.Color(1, 1, 1) }, uSunEnergy1: { value: 0 },
    },
    vertexShader: 'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader: `precision highp float;
      #define VIEW_STEPS ${steps}
      uniform int uMultipleDirections;
      ${atmosphereUniformGLSL}
      ${atmosphereTransportGLSL}
      void main() {
        float altitude = pow((gl_FragCoord.y-0.5)/31.0,2.0)*uTopAltitude;
        vec3 origin = vec3(0,uGroundR+max(altitude,1.0),0);
        float sunMu = (gl_FragCoord.x-0.5)/31.0*2.0-1.0;
        vec3 sun = vec3(sqrt(max(0.0,1.0-sunMu*sunMu)),sunMu,0);
        vec3 meanL=vec3(0), meanReturn=vec3(0);
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
          for(int i=0;i<VIEW_STEPS;i++) {
            float next=atmosphereSampleBoundary(0.0,end,-dot(origin,dir),float(i+1)/float(VIEW_STEPS));
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
  const quad = new FullScreenQuad(material), previous = renderer.getRenderTarget();
  // FullScreenQuad normally shares one geometry with every post pass. A
  // transient LUT bake must not dispose that shared geometry after each bake.
  quad._mesh.geometry = quad._mesh.geometry.clone();
  const scissor = renderer.getScissorTest();
  try {
    renderer.setScissorTest(false); renderer.setRenderTarget(target); quad.render(renderer);
  } catch (error) {
    target.dispose(); throw error;
  } finally {
    renderer.setRenderTarget(previous); renderer.setScissorTest(scissor);
    material.dispose(); quad.dispose();
  }
  return target;
}
