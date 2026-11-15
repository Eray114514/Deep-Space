import * as THREE from 'three';
import { cloudAtmosphereGLSL } from './atmosphere-transport-glsl.js';
import { namespacedAtmosphereUniforms } from './atmosphere-uniforms.js';
import { stellarOcclusionGLSL, stellarOcclusionUniforms, bindStellarOcclusion } from './stellar-occlusion.js';
import { surfaceCloudGLSL, surfaceCloudLightingGLSL, surfaceCloudUniforms, bindSurfaceClouds,
  hasSurfaceCloudMedium, registerSurfaceCloudOwner } from './cloud/surface-clouds.js';
const preparedSurfaces = new WeakSet();
let _fallbackMacroTex = null;
function fallbackMacroTerrainTexture() {
  if (!_fallbackMacroTex) {
    _fallbackMacroTex = new THREE.DataTexture(new Uint8Array([0, 128, 0, 255]), 1, 1);
    _fallbackMacroTex.colorSpace = THREE.NoColorSpace;
    _fallbackMacroTex.needsUpdate = true;
  }
  return _fallbackMacroTex;
}

function bindMacroTerrainUniforms(uniforms, planet) {
  if (!uniforms?.uMacroTerrainMap) return;
  uniforms.uMacroBodyR.value = planet?.R || 0;
  if (planet?.weatherField?.synoptic && planet.cloudWeatherHiTex) {
    uniforms.uMacroTerrainMap.value = planet.cloudWeatherHiTex;
    uniforms.uMacroTerrainRange.value = planet.weatherField.surfaceRangeMeters || 0;
  } else if (planet?.macroReliefTex) {
    uniforms.uMacroTerrainMap.value = planet.macroReliefTex;
    uniforms.uMacroTerrainRange.value = planet.macroReliefRange || 0;
  } else {
    uniforms.uMacroTerrainMap.value = fallbackMacroTerrainTexture();
    uniforms.uMacroTerrainRange.value = 0;
  }
}

function surfaceMediumUniforms(material, planet) {
  if (!material.userData.surfaceMedium) {
    const uniforms = {
      ...namespacedAtmosphereUniforms(),
      ...stellarOcclusionUniforms(),
      ...surfaceCloudUniforms(planet),
      uSurfaceViewToLocal: { value: new THREE.Matrix3() },
      uMacroTerrainMap: { value: fallbackMacroTerrainTexture() },
      uMacroTerrainRange: { value: 0 },
      uMacroBodyR: { value: planet?.R || 0 },
    };
    bindMacroTerrainUniforms(uniforms, planet);
    material.userData.surfaceMedium = uniforms;
  }
  return material.userData.surfaceMedium;
}

// Register the receiver and draw binder before the first compile. Three calls
// material.onBeforeRender BEFORE compiling a cold material, so installation in
// onBeforeCompile is too late for the first receiver-depth draw's screen mode.
// Uniforms stay lazy: a planet's material predates its published cloud textures.
export function prepareSurfaceAtmosphere(material, planet) {
  registerSurfaceCloudOwner(material, planet);
  if (!preparedSurfaces.has(material)) {
    const rotation = new THREE.Matrix4();
    const previous = material.onBeforeRender;
    let lastPassFrame = -1;
    let lastPassCamera = null;
    let lastPassTarget = null;
    let lastOccluders = null;
    let lastSpeciesTex = null;
    material.onBeforeRender = function (renderer, scene, camera, ...args) {
      previous?.call(this, renderer, scene, camera, ...args);
      const renderInfo = renderer?.info?.render;
      const currentTarget = typeof renderer?.getRenderTarget === 'function'
        ? renderer.getRenderTarget() : null;
      if (renderInfo && renderInfo.calls > 0
        && renderInfo.frame === lastPassFrame
        && camera === lastPassCamera
        && currentTarget === lastPassTarget
        && planet.stellarOccluders === lastOccluders
        && planet.cloudSpeciesTex === lastSpeciesTex
        && material.userData.surfaceMedium) {
        return;
      }
      const uniforms = surfaceMediumUniforms(material, planet);
      rotation.makeRotationFromQuaternion(planet._invFrame).multiply(camera.matrixWorld);
      uniforms.uSurfaceViewToLocal.value.setFromMatrix4(rotation);
      bindStellarOcclusion(uniforms, planet, material);
      bindSurfaceClouds(uniforms, planet, renderer, camera, material);
      bindMacroTerrainUniforms(uniforms, planet);
      const air = planet.atmosphereTransportUniforms;
      if (air) {
        for (const [name, uniform] of Object.entries(air)) {
          if (uniforms['air_' + name]) uniforms['air_' + name].value = uniform.value;
        }
      } else uniforms.air_uEnabled.value = 0;
      if (renderInfo) {
        lastPassFrame = renderInfo.frame;
        lastPassCamera = camera;
        lastPassTarget = currentTarget;
        lastOccluders = planet.stellarOccluders;
        lastSpeciesTex = planet.cloudSpeciesTex;
      }
    };
    preparedSurfaces.add(material);
  }
  return material;
}

// Bind shared solar transmission, macro relief shadow, directional sky irradiance,
// and physical water sky/cloud reflection to world surfaces.
export function installSurfaceAtmosphere(material, planet, shader) {
  prepareSurfaceAtmosphere(material, planet);
  Object.assign(shader.uniforms, surfaceMediumUniforms(material, planet));
  shader.defines = { ...shader.defines, SURFACE_CLOUD_MEDIUM: Number(hasSurfaceCloudMedium(planet)) };
  const transport = /* glsl */`
    ${cloudAtmosphereGLSL}
    ${stellarOcclusionGLSL}
    ${surfaceCloudGLSL}
    ${surfaceCloudLightingGLSL}
    uniform mat3 uSurfaceViewToLocal;
    uniform float uSurfaceDepthOnly;
    #if !SURFACE_CLOUD_MEDIUM
    uniform sampler2D uMacroTerrainMap;
    uniform float uMacroTerrainRange;
    uniform float uMacroBodyR;
    #endif

    // Multi-kilometre planetary relief horizon self-shadowing (1.4 km .. 16.5 km)
    // from the shared published weather/terrain atlas (.g = stationary normalized elevation).
    float surfaceMacroTerrainShadow(vec3 localPos, vec3 direction) {
      #if SURFACE_CLOUD_MEDIUM
      float bodyR = cloud_uBodyR;
      float surfaceRange = cloud_uSurfaceRange;
      #else
      float bodyR = uMacroBodyR;
      float surfaceRange = uMacroTerrainRange;
      #endif
      if (surfaceRange <= 1.0 || bodyR <= 1000.0) return 1.0;
      vec3 radial = normalize(localPos);
      float sunMu = dot(radial, direction);
      if (sunMu <= -0.08 || sunMu >= 0.62) return 1.0;
      vec3 horizDir = direction - radial * sunMu;
      float horizLen = length(horizDir);
      if (horizLen < 1e-4) return 1.0;
      horizDir /= horizLen;
      float raySlope = sunMu / horizLen;
      #if SURFACE_CLOUD_MEDIUM
      float atlasSelf = (weatherAtlasSample(cloud_uWeatherMapHi, radial).g * 2.0 - 1.0) * surfaceRange;
      #else
      float atlasSelf = (weatherAtlasSample(uMacroTerrainMap, radial).g * 2.0 - 1.0) * surfaceRange;
      #endif
      float hSelf = max(length(localPos) - bodyR, atlasSelf);
      float maxExcess = 0.0;
      for (int s = 0; s < 4; s++) {
        float dist = s == 0 ? 1400.0 : s == 1 ? 3400.0 : s == 2 ? 7800.0 : 16500.0;
        vec3 sampleDir = normalize(radial + horizDir * (dist / bodyR));
        #if SURFACE_CLOUD_MEDIUM
        float hSample = (weatherAtlasSample(cloud_uWeatherMapHi, sampleDir).g * 2.0 - 1.0) * surfaceRange;
        #else
        float hSample = (weatherAtlasSample(uMacroTerrainMap, sampleDir).g * 2.0 - 1.0) * surfaceRange;
        #endif
        float curvatureDrop = (dist * dist) / (2.0 * bodyR);
        float sampleSlope = (hSample - curvatureDrop - hSelf) / dist;
        maxExcess = max(maxExcess, sampleSlope - raySlope);
      }
      float lowSunWeight = 1.0 - smoothstep(0.42, 0.62, sunMu);
      float penumbra = 1.0 - smoothstep(0.008, 0.085, maxExcess) * 0.82 * lowSunWeight;
      return clamp(penumbra, 0.18, 1.0);
    }

    vec3 surfaceSunTransmission(vec3 direction) {
      float cloud = surfaceCloudLighting(direction);
      float macroTerrain = length(vViewPosition) < 220000.0
        ? surfaceMacroTerrainShadow(vLocalPos, direction) : 1.0;
      if (air_uEnabled < 0.5) return vec3(cloud * macroTerrain);
      float h = max(length(vLocalPos) - air_uGroundR, 0.0);
      float mu = dot(normalize(vLocalPos), direction);
      float visible = step(0.0, air_solarHorizonClearance(vLocalPos, direction));
      if (visible <= 0.0) return vec3(0.0);
      vec3 od = air_sunlightOpticalDepth(h, mu).rgb
        * vec3(air_uRayleighScaleHeight, air_uMieScaleHeight, air_uOzoneHalfWidth) * air_uDensityScale;
      return exp(-(air_uBetaRayleigh * od.r + air_uBetaMieExtinction * od.g + air_uBetaOzone * od.b))
        * (visible * cloud * macroTerrain);
    }

    vec3 gStarDir0 = vec3(0.0, 1.0, 0.0);
    vec3 gStarDir1 = vec3(0.0, 1.0, 0.0);
    float gStarVis0 = 1.0;
    float gStarVis1 = 1.0;
    vec3 gStarTrans0 = vec3(1.0);
    vec3 gStarTrans1 = vec3(1.0);
    vec3 gFallbackSunTrans = vec3(1.0);

    // Pre-evaluate solar transmission and multi-moon disc occlusion once per
    // fragment instead of re-inlining macro-relief + union-occlusion loops at
    // every directional/point/glint/sky/reflection call site (cuts D3D11 FXC
    // link time by 5x-30x while keeping per-star lighting exact).
    void initializeSurfaceMedium(vec3 localPos) {
      if (uLocalStarCount <= 0) {
        #if NUM_DIR_LIGHTS > 0
        gFallbackSunTrans = surfaceSunTransmission(normalize(uSurfaceViewToLocal * directionalLights[0].direction));
        #else
        gFallbackSunTrans = surfaceSunTransmission(normalize(air_uSunDirection0));
        #endif
        return;
      }
      for (int star = 0; star < 2; star++) {
        if (star >= uLocalStarCount) break;
        vec4 starData = star == 0 ? uLocalStars[0] : uLocalStars[1];
        vec3 d = normalize(starData.xyz - localPos);
        float vis = localStellarVisibility(localPos, d);
        vec3 trans = vis > 0.0 ? surfaceSunTransmission(d) * vis : vec3(0.0);
        if (star == 0) {
          gStarDir0 = d;
          gStarVis0 = vis;
          gStarTrans0 = trans;
        } else {
          gStarDir1 = d;
          gStarVis1 = vis;
          gStarTrans1 = trans;
        }
      }
    }

    vec3 surfaceStellarTransmission(vec3 direction) {
      if (uLocalStarCount > 0) {
        // A light belongs to the star whose direction it is closest to. First
        // match within a fixed cone handed a close binary's companion (8-11
        // degrees away) the primary's horizon and eclipse state.
        float d0 = dot(direction, gStarDir0);
        float d1 = uLocalStarCount > 1 ? dot(direction, gStarDir1) : -2.0;
        if (max(d0, d1) <= 0.98) return vec3(1.0);   // not a star (fill light)
        return d1 > d0 ? gStarTrans1 : gStarTrans0;
      }
      return gFallbackSunTrans;
    }

    // Normal-aware directional hemispheric sky + ground-bounce irradiance
    vec3 surfaceSkyIrradiance(vec3 localNormal) {
      float h = max(length(vLocalPos) - air_uGroundR, 0.0);
      vec3 radial = normalize(vLocalPos);
      float upDot = clamp(dot(localNormal, radial), -1.0, 1.0);
      float skyHemi = 0.5 + 0.5 * upDot;
      float groundHemi = 0.5 - 0.5 * upDot;

      vec3 totalSky = vec3(0.0);
      for (int star = 0; star < 2; star++) {
        vec3 sunDir = star == 0 ? normalize(air_uSunDirection0) : normalize(air_uSunDirection1);
        vec3 sunColor = star == 0 ? air_uSunColor0 : air_uSunColor1;
        float sunEnergy = star == 0 ? air_uSunEnergy0 : air_uSunEnergy1;
        if (sunEnergy <= 0.0001) continue;
        float sunMu = dot(radial, sunDir);
        vec3 multi = air_multipleRadiance(h, sunMu) * sunColor * sunEnergy;
        // Directional solar-azimuth sky dipole: forward-scattered circumsolar & horizon warmth
        // vs cool Rayleigh zenith/anti-solar hemisphere
        float horizonBoost = 1.0 - clamp(abs(sunMu), 0.0, 1.0) * 0.55;
        float sunAlign = dot(localNormal, sunDir);
        float starVis = star < uLocalStarCount ? (star == 0 ? gStarVis0 : gStarVis1) : 1.0;
        float dipole = 1.0 + 0.32 * sunAlign * horizonBoost * starVis;
        vec3 tint = mix(vec3(0.88, 0.96, 1.10), vec3(1.12, 1.01, 0.90), clamp(0.5 + 0.5 * sunAlign, 0.0, 1.0));
        vec3 skyPart = multi * skyHemi * dipole * tint;
        vec3 bouncePart = multi * air_uGroundAlbedo * groundHemi * 0.32 * max(0.15, sunMu + 0.25);
        totalSky += skyPart + bouncePart;
      }

      // Attenuate diffuse sky subtly under thick local cloud cover using shared cloud sun transmission
      float cloudSkyFactor = 1.0;
      #if SURFACE_CLOUD_MEDIUM
      if (uSurfaceCloudEnabled > 0.5) {
        vec3 overheadSample = weatherAtlasSample(cloud_uWeatherMapHi, cloud_uSpin * radial).rgb;
        float localCover = clamp(overheadSample.r, 0.0, 1.0);
        cloudSkyFactor = mix(1.0, 0.58, localCover * 0.65);
      }
      #endif
      return totalSky * air_uRadianceScale * 3.141592653589793 * cloudSkyFactor;
    }

    // Shared physical atmosphere + ray-shell parallax cloud + coastal horizon water reflection
    vec3 surfaceWaterReflectedSky(vec3 localPos, vec3 localReflectDir, float roughness, float fallbackCloud, vec3 fallbackSky) {
      if (air_uEnabled < 0.5) return fallbackSky;
      vec3 radial = normalize(localPos);
      float h = max(length(localPos) - air_uGroundR, 0.0);
      vec3 rDir = normalize(mix(localReflectDir, radial, clamp(roughness * roughness * 0.68, 0.0, 0.52)));
      float muR = max(dot(rDir, radial), 0.018);

      float rayleighD = exp(-h / max(air_uRayleighScaleHeight, 1.0)) * air_uDensityScale;
      float mieD = exp(-h / max(air_uMieScaleHeight, 1.0)) * air_uDensityScale;
      vec3 ext = air_uBetaRayleigh * rayleighD + air_uBetaMieExtinction * mieD
        + air_uBetaOzone * air_ozoneDensity(h) * air_uDensityScale;
      float effPath = min(48000.0, air_uRayleighScaleHeight * 1.15 / max(muR, 0.055));
      vec3 pathT = exp(-min(ext * effPath, vec3(20.0)));
      vec3 pathIntegral = (vec3(1.0) - pathT) / max(ext, vec3(1e-12));

      vec3 skyRadiance = vec3(0.0);
      vec3 cloudBaseLit = vec3(0.0);
      for (int star = 0; star < 2; star++) {
        vec3 sunDir = star == 0 ? normalize(air_uSunDirection0) : normalize(air_uSunDirection1);
        vec3 sunColor = star == 0 ? air_uSunColor0 : air_uSunColor1;
        float sunEnergy = star == 0 ? air_uSunEnergy0 : air_uSunEnergy1;
        if (sunEnergy <= 0.0001) continue;
        float sunMu = dot(radial, sunDir);
        vec3 sunOd = air_sunlightOpticalDepth(h, sunMu).rgb
          * vec3(air_uRayleighScaleHeight, air_uMieScaleHeight, air_uOzoneHalfWidth) * air_uDensityScale;
        vec3 sunTrans = exp(-min(air_uBetaRayleigh * sunOd.r + air_uBetaMieExtinction * sunOd.g + air_uBetaOzone * sunOd.b, vec3(40.0)));
        float vis = smoothstep(-0.04, 0.02, sunMu) * (star < uLocalStarCount ? (star == 0 ? gStarVis0 : gStarVis1) : 1.0);
        float cosTheta = dot(rDir, sunDir);
        float phaseR = 3.0 / (16.0 * 3.14159265) * (1.0 + cosTheta * cosTheta);
        float g = 0.76 * (1.0 - roughness * 0.45);
        float phaseM = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(0.04, 1.0 + g * g - 2.0 * g * cosTheta), 1.5));
        vec3 single = (air_uBetaRayleigh * rayleighD * phaseR + air_uBetaMieScatter * mieD * phaseM) * sunTrans * vis;
        vec3 multi = (air_uBetaRayleigh * rayleighD + air_uBetaMieScatter * mieD) * air_multipleRadiance(h, sunMu);
        vec3 starRad = (single + multi) * sunColor * sunEnergy * air_uRadianceScale;
        skyRadiance += starRad * pathIntegral;
        cloudBaseLit += (sunTrans * vis * max(0.08, sunMu * 0.55 + 0.18) + air_multipleRadiance(h + 1400.0, sunMu) * 2.2)
          * sunColor * sunEnergy * air_uRadianceScale;
      }

      // Ray-shell parallax cloud reflection using shared weather atlas
      float reflCloud = fallbackCloud;
      float tCloud = 6000.0;
      #if SURFACE_CLOUD_MEDIUM
      if (uSurfaceCloudEnabled > 0.5 && cloud_uBodyR > 1000.0) {
        float rCloud = max(length(localPos) + 350.0, cloud_uBodyR + 1450.0);
        float b = dot(localPos, rDir);
        float c = dot(localPos, localPos) - rCloud * rCloud;
        float disc = b * b - c;
        if (disc > 0.0) {
          tCloud = max(200.0, -b + sqrt(disc));
          vec3 hitDir = normalize(localPos + rDir * min(tCloud, 45000.0));
          reflCloud = clamp(weatherAtlasSample(cloud_uWeatherMapHi, cloud_uSpin * hitDir).r * 0.85, 0.0, 0.92);
        }
      }
      #endif
      if (reflCloud > 0.005) {
        vec3 airToCloudT = exp(-min(ext * min(tCloud, 32000.0), vec3(12.0)));
        vec3 cloudRad = cloudBaseLit * 0.42;
        skyRadiance = mix(skyRadiance, skyRadiance * (1.0 - airToCloudT) + cloudRad * airToCloudT, reflCloud * (1.0 - roughness * 0.35));
      }

      // Coastal mountain horizon occlusion on low-elevation reflection rays
      if (muR < 0.38 && length(vViewPosition) < 120000.0) {
        float coastOcc = mix(0.45, 1.0, surfaceMacroTerrainShadow(localPos, rDir));
        skyRadiance *= mix(coastOcc, 1.0, smoothstep(0.08, 0.38, muR));
      }
      return max(vec3(0.0), skyRadiance);
    }
  `;
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>',
    '#include <lights_physical_pars_fragment>\n' + transport);
  shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>',
    '#include <logdepthbuf_fragment>\nif(uSurfaceDepthOnly>0.5){gl_FragColor=vec4(0.0);return;}\ninitializeSurfaceCloudLighting(vLocalPos);\ninitializeSurfaceMedium(vLocalPos);');
  const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );', `getDirectionalLightInfo( directionalLight, directLight );
    if (directLight.visible) {
      vec3 localLightDirection=normalize(uSurfaceViewToLocal*directLight.direction);
      directLight.color *= surfaceStellarTransmission(localLightDirection);
    }`).replace(
    'getPointLightInfo( pointLight, geometryPosition, directLight );', `getPointLightInfo( pointLight, geometryPosition, directLight );
    if (directLight.visible) {
      vec3 localPointDirection=normalize(uSurfaceViewToLocal*directLight.direction);
      float pointDistance=length(pointLight.position-geometryPosition);
      bool isStar=false;
      for(int star=0;star<2;star++) {
        if(star>=uLocalStarCount) break;
        float distanceToStar=length(uLocalStars[star].xyz-vLocalPos);
        if(abs(pointDistance-distanceToStar)<max(10.0,distanceToStar*0.001)) isStar=true;
      }
      if(isStar) directLight.color*=surfaceStellarTransmission(localPointDirection);
    }`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lights + `
    #if defined(RE_IndirectDiffuse)
    if(air_uEnabled>0.5 && air_uMultipleEnabled>0.5) {
      irradiance = surfaceSkyIrradiance(normalize(uSurfaceViewToLocal * geometryNormal));
    }
    #endif
  `);
}
