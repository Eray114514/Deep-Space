import * as THREE from 'three';
import { cloudAtmosphereGLSL } from './atmosphere-transport-glsl.js';
import { namespacedAtmosphereUniforms } from './atmosphere-uniforms.js';
import { stellarOcclusionGLSL, stellarOcclusionUniforms, bindStellarOcclusion } from './stellar-occlusion.js';
import { surfaceCloudGLSL,surfaceCloudLightingGLSL,surfaceCloudUniforms,bindSurfaceClouds,
  hasSurfaceCloudMedium } from './cloud/surface-clouds.js';

// Bind the same solar transmission and isotropic sky field to world surfaces.
// Portal/remote bodies without an active air context retain their own lighting.
export function installSurfaceAtmosphere(material, planet, shader) {
  material.userData.surfaceCloudOwner=planet;
  if (!material.userData.surfaceMedium) {
    const uniforms = { ...namespacedAtmosphereUniforms(), ...stellarOcclusionUniforms(),
      ...surfaceCloudUniforms(planet),
      uSurfaceViewToLocal: { value: new THREE.Matrix3() } };
    const rotation = new THREE.Matrix4();
    const previous = material.onBeforeRender;
    material.onBeforeRender = function (renderer, scene, camera, ...args) {
      previous?.call(this, renderer, scene, camera, ...args);
      rotation.makeRotationFromQuaternion(planet._invFrame).multiply(camera.matrixWorld);
      uniforms.uSurfaceViewToLocal.value.setFromMatrix4(rotation);
      bindStellarOcclusion(uniforms, planet, material);
      bindSurfaceClouds(uniforms,planet,renderer,camera,material);
      const air = planet.atmosphereTransportUniforms;
      if (air) {
        for (const [name, uniform] of Object.entries(air)) {
          if (uniforms['air_' + name]) uniforms['air_' + name].value = uniform.value;
        }
      } else uniforms.air_uEnabled.value = 0;
    };
    material.userData.surfaceMedium = uniforms;
  }
  Object.assign(shader.uniforms, material.userData.surfaceMedium);
  shader.defines ||= {};
  shader.defines.SURFACE_CLOUD_MEDIUM=Number(hasSurfaceCloudMedium(planet));
  const transport = /* glsl */`
    ${cloudAtmosphereGLSL}
    ${stellarOcclusionGLSL}
    ${surfaceCloudGLSL}
    ${surfaceCloudLightingGLSL}
    uniform mat3 uSurfaceViewToLocal;
    vec3 surfaceSunTransmission(vec3 direction) {
      float cloud=surfaceCloudLighting(direction);
      if(air_uEnabled<0.5) return vec3(cloud);
      float h=max(length(vLocalPos)-air_uGroundR,0.0);
      float mu=dot(normalize(vLocalPos),direction);
      vec3 od=air_sunlightOpticalDepth(h,mu).rgb
        *vec3(air_uRayleighScaleHeight,air_uMieScaleHeight,air_uOzoneHalfWidth)*air_uDensityScale;
      float visible=step(0.0,air_solarHorizonClearance(vLocalPos,direction));
      return exp(-(air_uBetaRayleigh*od.r+air_uBetaMieExtinction*od.g+air_uBetaOzone*od.b))*visible*cloud;
    }
    vec3 surfaceSkyIrradiance() {
      float h=max(length(vLocalPos)-air_uGroundR,0.0);
      vec3 radial=normalize(vLocalPos);
      vec3 mean=air_multipleRadiance(h,dot(radial,air_uSunDirection0))*air_uSunColor0*air_uSunEnergy0;
      mean+=air_multipleRadiance(h,dot(radial,air_uSunDirection1))*air_uSunColor1*air_uSunEnergy1;
      return mean*air_uRadianceScale*3.141592653589793;
    }
  `;
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',
    '#include <lights_physical_pars_fragment>\n' + transport);
  shader.fragmentShader=shader.fragmentShader.replace('#include <logdepthbuf_fragment>',
    '#include <logdepthbuf_fragment>\ninitializeSurfaceCloudLighting(vLocalPos);');
  const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );', `getDirectionalLightInfo( directionalLight, directLight );
    {
    vec3 localLightDirection=normalize(uSurfaceViewToLocal*directLight.direction);
    directLight.color *= surfaceSunTransmission(localLightDirection)
      * localStellarVisibility(vLocalPos,localLightDirection);
    }`).replace(
    'getPointLightInfo( pointLight, geometryPosition, directLight );', `getPointLightInfo( pointLight, geometryPosition, directLight );
    {
    vec3 localPointDirection=normalize(uSurfaceViewToLocal*directLight.direction);
    float pointDistance=length(pointLight.position-geometryPosition);
    bool isStar=false;
    for(int star=0;star<2;star++) {
      if(star>=uLocalStarCount) break;
      float distanceToStar=length(uLocalStars[star].xyz-vLocalPos);
      if(abs(pointDistance-distanceToStar)<max(10.0,distanceToStar*0.001)) isStar=true;
    }
    if(isStar) directLight.color*=surfaceSunTransmission(localPointDirection)
      *localStellarVisibility(vLocalPos,localPointDirection);
    }`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lights + `
    #if defined(RE_IndirectDiffuse)
    if(air_uEnabled>0.5 && air_uMultipleEnabled>0.5) irradiance=surfaceSkyIrradiance();
    #endif
  `);
}
