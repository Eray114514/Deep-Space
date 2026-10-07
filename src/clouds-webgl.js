import { namespacedAtmosphereUniforms } from './atmosphere-uniforms.js';
import { stellarOcclusionUniforms, bindStellarOcclusion, stellarOcclusionGLSL } from './stellar-occlusion.js';
import { cloudAtmosphereGLSL } from './atmosphere-transport-glsl.js';
import { weatherAtlasGLSL } from './cloud/weather-atlas.js';
import { productionCloudGLSL } from './cloud/production-medium-glsl.js';
import { buildCloudScatteringTable } from './cloud/cloud-scattering-lut.js';
import { productionSpeciesParameters, PRODUCTION_SHAPE_VERSION } from './cloud/production-shape.js';
import { cloudBeamGLSL } from './cloud/cloud-beam-glsl.js';
import {cloudLightCacheGLSL,cloudLightCacheUniforms} from './cloud/cloud-light-cache-glsl.js';
// Volumetric cloud baseline: a raymarched shell around the planet.
// Macro weather comes from the same atlas as remote decks and surface weather.
// Production shape/profile/extinction are shared with column/light baking and
// CPU transit queries. The legacy density kernel only serves explicit fixtures.
// Lighting uses the full physical beam and a stated plane-parallel multiple
// scattering closure; immutable caches accelerate supported queries.
// Everything is driven by the planet's cloud spin (frozen under ?freeze=1),
// so the seam test's static frames stay static.

import * as THREE from 'three';
import { cloudNoiseImage, cloudNoiseDistribution } from './cloud/cloud-noise.js';

let _noiseTex = null;
let _scatteringTex = null;
let _speciesTex=null;
function speciesParametersTexture() {
  if(_speciesTex)return _speciesTex;
  const parameters=productionSpeciesParameters(),data=new Float32Array(16*4*4);
  parameters.forEach((p,i)=>{data.set(p.optics,i*4);data.set(p.shape,(16+i)*4);data.set(p.structure,(32+i)*4);});
  data.set(cloudNoiseDistribution(),16*3*4);
  _speciesTex=new THREE.DataTexture(data,16,4,THREE.RGBAFormat,THREE.FloatType);
  _speciesTex.needsUpdate=true;return _speciesTex;
}
function cloudScatteringTexture() {
  if (_scatteringTex) return _scatteringTex;
  const table=buildCloudScatteringTable();
  const data=Uint16Array.from(table.data,x=>THREE.DataUtils.toHalfFloat(x));
  _scatteringTex=new THREE.Data3DTexture(data,table.depthCells,table.sunCells,table.tauCells);
  _scatteringTex.format=THREE.RGBAFormat;_scatteringTex.type=THREE.HalfFloatType;
  _scatteringTex.minFilter=_scatteringTex.magFilter=THREE.LinearFilter;
  _scatteringTex.colorSpace=THREE.NoColorSpace;_scatteringTex.needsUpdate=true;
  return _scatteringTex;
}

// 64³ RG texture: R = perlin-worley base lobes, G = high-frequency erosion.
// The larger volume removes the chunky cellular blocks visible from orbit.
export function cloudNoiseTexture() {
  if (_noiseTex) return _noiseTex;
  const {data,width:S}=cloudNoiseImage();
  _noiseTex = new THREE.Data3DTexture(data, S, S, S);
  _noiseTex.format = THREE.RGFormat;
  _noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  _noiseTex.magFilter = THREE.LinearFilter;
  _noiseTex.wrapS = _noiseTex.wrapT = _noiseTex.wrapR = THREE.RepeatWrapping;
  _noiseTex.generateMipmaps = true;
  _noiseTex.needsUpdate = true;
  return _noiseTex;
}

// Release the module-level 3D noise texture. For full-session teardown only
// (context-loss recovery, hot-reload) — every cloud ShaderMaterial that
// referenced this texture must itself be disposed first, since disposing
// here invalidates the GPU handle for all existing references.
export function disposeCloudNoiseTexture() {
  if (_noiseTex) { _noiseTex.dispose(); _noiseTex = null; }
  if (_scatteringTex) { _scatteringTex.dispose(); _scatteringTex = null; }
  if(_speciesTex){_speciesTex.dispose();_speciesTex=null;}
}

function stormCenters(offX, offY, offZ) {
  const a = new THREE.Vector3(
    Math.sin(offX * 1.31 + 0.4),
    Math.sin(offY * 1.17 - 1.2) * 0.72,
    Math.cos(offZ * 1.43 + 0.7),
  ).normalize();
  const ref = Math.abs(a.y) < 0.8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const b = new THREE.Vector3().crossVectors(a, ref).addScaledVector(a, 0.16).normalize();
  return [a, b];
}

export function makeCloudVolumeMaterial(planet, band, detailTex, weatherMap,
  weatherMapHi, { quality = 'ultra', steps = 124 } = {}) {
  const thick = band.rOut - band.rIn;
  const qualityValue = quality === 'performance' || quality === 'low' ? 0
    : quality === 'balanced' ? 0.55 : 1;
  const [stormA, stormB] = stormCenters(band.ox, band.oy, band.oz);
  const mat = new THREE.ShaderMaterial({
    defines: { PRODUCTION_CLOUD_MEDIUM: band.localWeather ? 1 : 0,
      CLOUD_FAR_VIEW: 0,
      CLOUD_FAR_CACHE: 0,
      STELLAR_UNION_OCCLUSION: (planet.stellarOccluders?.length || 0) > 1 ? 1 : 0,
      CLOUD_LIGHT_MAX_STEPS: 64, CLOUD_VIEW_MAX_STEPS: 8192 },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    uniforms: {
        ...stellarOcclusionUniforms(),
      ...namespacedAtmosphereUniforms(),
      ...cloudLightCacheUniforms(planet.cloudWeatherHiTex),
      uNoise3: { value: cloudNoiseTexture() },
      uSpeciesMap: { value: planet.cloudSpeciesTex || null },
      uBandBounds: { value: planet.cloudBoundsTex || null },
      uCandidateLayers: { value: 64 },
      uBandCandidates: { value: planet.cloudCandidatesTex || null },
      uCandidatesReady: { value: planet.cloudCandidatesTex ? 1 : 0 },
      uBandsReady: { value: planet.cloudSpeciesTex ? 1 : 0 },
      uSpeciesMask: { value: -1 },
      uMediumLayer: { value: 0 },
      uSpeciesCount: { value: 16 },
      uSpeciesPartition: { value: planet.weatherField?.synoptic ? 1 : 0 },
      uCloudAdvectionPhase: { value: (planet.weatherHours || 0)*(planet.weatherField?.windRadiansPerHour || 0) },
      uSpeciesParameters: { value: speciesParametersTexture() },
      uColumnHeights: { value: weatherMap || detailTex },
      uColumnHeightsNext: { value: weatherMap || detailTex },
      uCloudScattering: { value: cloudScatteringTexture() },
      uCloudNoise: { value: detailTex },
      uWeatherMap: { value: weatherMap || detailTex },
      uWeatherMapHi: { value: weatherMapHi || weatherMap || detailTex },
      uWeatherReady: { value: weatherMap ? 1 : 0 },
      uCov0: { value: band.cov0 },
      uCov1: { value: band.cov1 },
      uCOff: { value: new THREE.Vector3(band.ox, band.oy, band.oz) },
      uStormA: { value: stormA },
      uStormB: { value: stormB },
      uCameraLocal: { value: new THREE.Vector3() },
      uSpin: { value: new THREE.Matrix3() },       // same rotation as the shadows
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uRin: { value: band.rIn },
      uRout: { value: band.rOut },
      uBodyR: { value: planet.R },
      uSurfaceRange: { value: planet.weatherField?.surfaceRangeMeters || 1 },
      uLocalBands: { value: band.localWeather ? 1 : 0 },
      uGroundR: { value: planet.hasLiquid ? planet.seaRadius : planet.R },
      tSceneDepth: { value: null },
      uDepthReady: { value: 0 },
      uCameraFar: { value: 1.2e11 },
      uVolumeSize: { value: new THREE.Vector2(1, 1) },
      uDepthInvProjection: { value: new THREE.Matrix4() },
      uDepthViewToLocal: { value: new THREE.Matrix3() },
      uOpaqueMinR: { value: 0 },
      uOpaqueMaxR: { value: 0 },
      uSunC: { value: new THREE.Color(1, 0.98, 0.94) },
      uSunEnergy: { value: 1 },
      uStellarRadianceScale: { value: 3.2 },
      uSecondarySunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSecondarySunC: { value: new THREE.Color(1, 1, 1) },
      uSecondarySunEnergy: { value: 0 },
      uEclipseEnabled: { value: 0 },
      uEclipseCenter: { value: new THREE.Vector3() },
      uEclipseRadius: { value: 1 },
      uEclipseStarAngle: { value: 0 },
      uAmbC: { value: new THREE.Color(0.35, 0.42, 0.55) },
      uTint: { value: new THREE.Color(band.tint || 0xffffff) },
      uEngage: { value: 0 },
      uFrame: { value: 0 },
      // Both tiers execute this exact material and density field. The quality
      // value changes integration cost only; cloud placement and coverage do
      // not depend on it.
      uQuality: { value: qualityValue },
      uMaxSteps: { value: Math.max(16, Math.min(124, steps)) },
      uCloudLightSteps: { value: 12 },
      uViewCapacity: { value: 8192 },
      uColumnSteps: { value: 128 },
      uLightPathCount: { value: 4 },
      uLightQuadratureSteps: { value: 16 },
      uOpticalColumns: { value: weatherMap || detailTex },
      uOpticalColumnsNext: { value: weatherMap || detailTex },
      uColumnMix: { value: 0 },
      uColumnsReady: { value: 0 },
      uColumnsJointReady: { value: 0 },
    },
    vertexShader: /* glsl */`
      uniform vec3 uCameraLocal;
      varying vec3 vDirection;
      varying vec3 vViewDirection;
      void main() {
        vDirection = position - uCameraLocal;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDirection = viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      precision highp sampler3D;
      uniform sampler3D uNoise3;
      uniform sampler3D uCloudScattering;
      uniform sampler2D uCloudNoise;
      uniform sampler2D uWeatherMap, uWeatherMapHi;
      uniform float uWeatherReady;
      uniform sampler2D tSceneDepth;
      uniform float uCov0, uCov1, uRin, uRout, uBodyR, uGroundR, uSurfaceRange, uLocalBands;
      uniform float uEngage, uFrame, uQuality, uMaxSteps;
      uniform float uCloudLightSteps;
      uniform float uViewCapacity;
      uniform float uColumnSteps;
      uniform int uLightPathCount;
      uniform int uLightQuadratureSteps;
      uniform sampler2D uOpticalColumns,uOpticalColumnsNext,uColumnHeights,uColumnHeightsNext;
      uniform float uColumnMix;
      uniform float uColumnsReady,uColumnsJointReady;
      uniform float uSunEnergy, uSecondarySunEnergy, uStellarRadianceScale;
      uniform vec3 uSecondarySunDir, uSecondarySunC;
      uniform float uEclipseEnabled, uEclipseRadius, uEclipseStarAngle;
      uniform vec3 uEclipseCenter;
      uniform float uDepthReady, uCameraFar;
      uniform vec2 uVolumeSize;
      uniform mat4 uDepthInvProjection;
      uniform mat3 uDepthViewToLocal;
      uniform float uOpaqueMinR,uOpaqueMaxR;
      uniform vec3 uCOff, uStormA, uStormB, uCameraLocal, uSunDir, uSunC, uAmbC, uTint;
      uniform mat3 uSpin;
      varying vec3 vDirection;
      varying vec3 vViewDirection;

      ${stellarOcclusionGLSL}
      ${weatherAtlasGLSL}
      float eclipseVisibility(vec3 samplePosition, vec3 sunDirection) {
        if (uLocalOccluderCount > 0) return localStellarVisibility(samplePosition,sunDirection);
        if (uEclipseEnabled < 0.5) return 1.0;
        vec3 toOccluder = uEclipseCenter - samplePosition;
        float distanceToOccluder = length(toOccluder);
        if (distanceToOccluder <= uEclipseRadius) return 0.0;
        float angularRadius = asin(clamp(
          uEclipseRadius / distanceToOccluder, 0.0, 0.9999));
        float separation = acos(clamp(dot(
          normalize(toOccluder), sunDirection), -1.0, 1.0));
        float penumbra = max(uEclipseStarAngle, 0.00002);
        return smoothstep(max(angularRadius - penumbra, 0.0),
          angularRadius + penumbra, separation);
      }

      // the SAME coverage fbm the impostor deck, terrain shadows and the CPU
      // transit fog use — one sky, everywhere. Explicit LOD: implicit
      // derivatives are UNDEFINED in the divergent march loop and flicker.
      float cloudFbm(vec3 d) {
        float f = textureLod(uCloudNoise, d.xy * 0.55 + uCOff.xy, 0.0).g * 0.5;
        f += textureLod(uCloudNoise, d.yz * 1.15 + uCOff.yz, 0.0).r * 0.25;
        f += textureLod(uCloudNoise, d.zx * 2.35 + uCOff.zx, 0.0).g * 0.125;
        f += textureLod(uCloudNoise, d.xy * 4.8 - uCOff.xz, 0.0).r * 0.0625;
        return f / 0.9375;
      }

      float stormAt(vec3 d, vec3 center, float phase, float radius) {
        vec3 ref = abs(center.y) < 0.88 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 ta = normalize(cross(ref, center));
        vec3 tb = normalize(cross(center, ta));
        float z = clamp(dot(d, center), -1.0, 1.0);
        float x = dot(d, ta), y = dot(d, tb);
        float inv = 1.0 / max(x * x + y * y, 1e-5);
        float sin2 = 2.0 * x * y * inv;
        float cos2 = (x * x - y * y) * inv;
        float r = sqrt(max(0.0, 2.0 * (1.0 - z))) / radius;
        float shield = (1.0 - smoothstep(0.08, 0.5, r)) * 0.58;
        float turn = phase - r * 13.0;
        float arms = smoothstep(0.66, 0.94,
          0.5 + 0.5 * (sin2 * cos(turn) + cos2 * sin(turn)));
        arms *= smoothstep(0.1, 0.24, r) * (1.0 - smoothstep(0.62, 1.0, r));
        return max(shield, arms);
      }

      float weatherSystem(vec3 d) {
        return max(stormAt(d, uStormA, uCOff.z, 0.92),
          stormAt(d, uStormB, uCOff.x + uCOff.y, 0.68) * 0.72);
      }

      vec2 sphereHits(vec3 origin, float r, vec3 dir) {
        float b = dot(origin, dir);
        float radial = length(origin);
        float disc = b * b - (radial - r) * (radial + r);
        if (disc < 0.0) return vec2(-1.0);
        float s = sqrt(disc);
        return vec2(-b - s, -b + s);
      }

      vec4 opaqueLocalPosition(ivec2 cell,ivec2 size,float forwardZ) {
        vec2 uv=(vec2(clamp(cell,ivec2(0),size-1))+0.5)/vec2(size);
        vec4 view=uDepthInvProjection*vec4(uv*2.0-1.0,1.0,1.0);
        // Direction is homogeneous: dividing by far-plane w is unnecessary
        // and w rounds to zero with this game's astronomical far distance.
        vec3 ray=normalize(view.xyz);
        vec3 position=uCameraLocal+normalize(uDepthViewToLocal*ray)
          *(forwardZ/max(-ray.z,0.035));
        return vec4(position,length(position));
      }
      float sceneRayLimit() {
        if (uDepthReady < 0.5) return 1e20;
        vec2 uv = gl_FragCoord.xy / max(uVolumeSize, vec2(1.0));
        float depth = texture2D(tSceneDepth, clamp(uv, 0.0, 1.0)).x;
        if (depth >= 0.999999) return 1e20;
        // Three.js logarithmic depth: depth = log2(1 + clipW)/log2(1 + far).
        float forwardDistance = pow(uCameraFar + 1.0, depth) - 1.0;
        // A half-resolution ray usually lies between full-resolution depth
        // texel centres. A nearest fetch compares different rays; from orbit
        // that half pixel is kilometres and punches a grid through low clouds.
        // Reconstruct forward distance only across a continuous surface.
        ivec2 size=textureSize(tSceneDepth,0);
        vec2 p=clamp(uv,0.0,1.0)*vec2(size)-0.5,f=fract(p);
        ivec2 cell=ivec2(floor(p));
        vec4 depths=vec4(texelFetch(tSceneDepth,clamp(cell,ivec2(0),size-1),0).x,
          texelFetch(tSceneDepth,clamp(cell+ivec2(1,0),ivec2(0),size-1),0).x,
          texelFetch(tSceneDepth,clamp(cell+ivec2(0,1),ivec2(0),size-1),0).x,
          texelFetch(tSceneDepth,clamp(cell+ivec2(1,1),ivec2(0),size-1),0).x);
        if(max(max(depths.x,depths.y),max(depths.z,depths.w))<0.999999) {
          vec4 z=pow(vec4(uCameraFar+1.0),depths)-vec4(1);
          if(uOpaqueMaxR>uOpaqueMinR) {
            vec4 a=opaqueLocalPosition(cell,size,z.x),b=opaqueLocalPosition(cell+ivec2(1,0),size,z.y);
            vec4 c=opaqueLocalPosition(cell+ivec2(0,1),size,z.z),d=opaqueLocalPosition(cell+ivec2(1,1),size,z.w);
            float lo=min(min(a.w,b.w),min(c.w,d.w)),hi=max(max(a.w,b.w),max(c.w,d.w));
            float footprint=max(length(a.xyz-b.xyz),length(a.xyz-c.xyz));
            // Interpolate surface radius in its own frame. Interpolating view
            // Z near a planetary limb still has a large curvature error.
            // Reject foreign objects and sharp near-field height boundaries.
            if(lo>=uOpaqueMinR && hi<=uOpaqueMaxR && hi-lo<max(2.0,footprint*2.0)) {
              float r=mix(mix(a.w,b.w,f.x),mix(c.w,d.w,f.x),f.y);
              vec2 hits=sphereHits(uCameraLocal,r,normalize(vDirection));
              float t=hits.x>0.0?hits.x:hits.y;
              if(t>0.0)return t;
            }
          }
          float nearZ=min(min(z.x,z.y),min(z.z,z.w)),farZ=max(max(z.x,z.y),max(z.z,z.w));
          if(farZ-nearZ<max(2.0,nearZ*0.01))forwardDistance=mix(mix(z.x,z.y,f.x),mix(z.z,z.w,f.x),f.y);
        }
        float forwardCos = max(-normalize(vViewDirection).z, 0.035);
        return forwardDistance / forwardCos;
      }

      ${productionCloudGLSL}
      ${cloudLightCacheGLSL}

      vec2 cloudLayersAt(vec3 local) {
        float r = length(local);
        if (r <= uRin || r >= uRout) return vec2(0.0);
        #if PRODUCTION_CLOUD_MEDIUM == 1
        return productionCloudLayersAt(local);
        #else
        float shellH = (r - uRin) / (uRout - uRin);
        float h = shellH;
        vec3 radial = local / r;
        vec4 weather = textureLod(uWeatherMap, weatherAtlasUV(uSpin * radial), 0.0);
        vec4 highAtlas = textureLod(uWeatherMapHi, weatherAtlasUV(uSpin * radial), 0.0);
        float highWeather = uWeatherReady > 0.5 ? highAtlas.r : 0.0;
        float highH = h;
        float lowDepth = 1.0;
        float lowBase = 0.0;
        if (uLocalBands > 0.5) {
          float surface = (textureLod(uWeatherMapHi, weatherAtlasUV(radial), 0.0).g
            * 2.0 - 1.0) * uSurfaceRange;
          lowBase = surface + 350.0 + highAtlas.a * 3850.0 + 200.0;
          lowDepth = 2000.0 + weather.g * 1500.0;
          h = (r - uBodyR - max(250.0, lowBase)) / lowDepth;
          highH = (r - uBodyR - 8500.0) / 6000.0;
          // The later fine-noise shift is bounded by +/-180 m. Reject only
          // heights that cannot enter either layer under any such shift.
          float margin = 180.0 / lowDepth;
          if ((h < -0.1 - margin || h > 1.1 + margin)
            && (highH < -0.1 || highH > 1.1)) return vec2(0.0);
        }
        vec3 tangentA = normalize(cross(radial,
          abs(radial.y) < 0.88 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 tangentB = normalize(cross(radial, tangentA));
        float bend = shellH - 0.42;
        // A cloud footprint must not be the same 2D mask extruded straight
        // through the whole shell. Shift it laterally with altitude so anvils,
        // shelves and tilted billows replace the former vertical curtains.
        vec3 coverageDir = normalize(radial
          + tangentA * bend * 0.02
          + tangentB * (bend * bend - 0.08) * 0.015);
        vec3 sd = uSpin * coverageDir;
        float fine = cloudFbm(sd);
        // Both view and light rays sample the same world-point property.
        // A ray-midpoint mask changed density with viewing direction.
        if (uLocalBands > 0.5) {
          h = (r - uBodyR - max(250.0, lowBase + (fine - 0.5) * 360.0)) / lowDepth;
          if ((h < -0.1 || h > 1.1) && (highH < -0.1 || highH > 1.1)) return vec2(0.0);
        }
        float systemMask = uWeatherReady > 0.5 ? weather.g : weatherSystem(uSpin * radial);
        // Preserve the complete analytic weather footprint. Earlier the
        // volume raised this mask to 1.42 and then gated it again with Worley,
        // deleting most clouds that were visible in the orbit deck.
        float baseWeather = pow(smoothstep(uCov0, uCov1, fine), 1.34);
        float largeSystem = systemMask * smoothstep(0.30, 0.72, fine) * 0.72;
        // Macro occupation permits clouds; it is not unit condensate at every
        // point. Retain the mature regional carving inside the shared mask.
        float cov = uWeatherReady > 0.5
          ? weather.r * pow(smoothstep(0.25, 0.65, fine), 1.1)
          : max(baseWeather, largeSystem);
        if (max(cov, highWeather) < 0.01) return vec2(0.0);
        vec3 warp = vec3(
          textureLod(uCloudNoise, sd.yz * 3.1 + uCOff.xy, 0.0).r,
          textureLod(uCloudNoise, sd.zx * 3.7 + uCOff.yz, 0.0).g,
          textureLod(uCloudNoise, sd.xy * 4.3 - uCOff.xz, 0.0).r
        ) - 0.5;
        // Sample the base volume in a spherical weather frame: horizontal
        // scale follows the planet surface while height travels through a
        // separate oblique noise axis. Sampling raw world metres here made
        // ray steps line up into long radial brush strokes.
        // Planet-scale billows first; fine Worley erosion is added below.
        // Using a fixed 26 km cell size repeated identical popcorn all around
        // a large world and closed into a bright ring at the limb.
        vec3 q = uSpin * radial * (uRin / 118000.0)
          + vec3(0.37, 0.71, 0.53) * (h * 2.7)
          + warp * 1.4;
        vec2 n = textureLod(uNoise3, q, 0.8).rg;
        // Locally varied floor and ceiling prevent a single hard lower edge.
        float floorH = 0.025 + (1.0 - n.g) * 0.13;
        float ceilH = 0.44 + cov * 0.34 + (n.r - 0.5) * 0.18;
        float lowerProfile = smoothstep(floorH, floorH + 0.14, h)
          * (1.0 - smoothstep(ceilH - 0.18, ceilH, h));
        // Deep weather systems build a distinct, broad upper shelf. It shares
        // the same footprint and 3D field as the lower cloud, but a displaced
        // vertical profile creates towers, anvils and gaps instead of one
        // uniformly extruded layer.
        vec2 upperNoise = textureLod(uNoise3,
          q * 1.72 + vec3(5.7, 2.3, 8.1), 1.15).rg;
        float upperSource = uWeatherReady > 0.5 ? highWeather
          : smoothstep(0.28, 0.76, systemMask) * smoothstep(0.26, 0.74, cov);
        float upperFloor = 0.48 + (upperNoise.g - 0.5) * 0.12;
        float upperCeil = 0.91 + (upperNoise.r - 0.5) * 0.10;
        float upperProfile = smoothstep(upperFloor, upperFloor + 0.11, highH)
          * (1.0 - smoothstep(upperCeil - 0.11, upperCeil, highH));
        // Sparse high-altitude filaments soften storm tops without inventing
        // a second camera-facing weather map.
        float wisp = smoothstep(0.58, 0.88, upperNoise.g)
          * smoothstep(0.62, 0.73, highH) * (1.0 - smoothstep(0.91, 0.99, highH));
        // 3D noise shapes density inside the footprint; it must not decide
        // whether the footprint exists. A non-zero floor gives broad cloud
        // bodies real depth while Worley still sculpts billowing edges.
        float cells = mix(0.58, 1.22, smoothstep(0.18, 0.82, n.r));
        float verticalShape = max(lowerProfile * cells,
          upperSource * upperProfile * (0.54 + upperNoise.r * 0.52));
        verticalShape = max(verticalShape, upperSource * wisp * 0.34);
        float d = cov * verticalShape;
        float highDensity = highWeather
          * max(upperProfile * (0.54 + upperNoise.r * 0.52), wisp * 0.34);
        if (uWeatherReady > 0.5) d = cov * lowerProfile * cells;
        float ero = textureLod(uNoise3, q * 3.15, 1.25).g;
        d = clamp(d - (1.0 - ero) * 0.10 * (1.0 - d), 0.0, 1.0);
        // Very low density belongs to clear air, not a planet-wide translucent
        // veil. Preserve soft edges while forcing genuine holes between cloud
        // systems so ocean and terrain keep their native colour.
        // The high mask was calibrated as translucent ice, not another opaque
        // liquid deck. Keep its smaller condensate separate from low-cloud
        // erosion. Per-metre genus optics will replace these legacy amounts.
        return vec2(smoothstep(0.16, 0.62, d),
          uLocalBands > 0.5 ? highDensity : 0.0);
        #endif
      }

      float densityAt(vec3 local) {
        vec2 layers = cloudLayersAt(local);
        return max(layers.x, layers.y * 0.06);
      }

      float cloudExtinctionAt(vec3 local, float legacySigma) {
        if (uLocalBands < 0.5) return densityAt(local) * legacySigma;
        vec2 layers = cloudLayersAt(local);
        // Per-metre liquid and ice extinction. Condensate remains a separate
        // dimensionless field; the shell thickness cannot change this value.
        return layers.x * 0.025 + layers.y * 0.0006;
      }

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      ${cloudAtmosphereGLSL}

      float cloudPhase(float mu, float g) {
        return (1.0-g*g) / (12.5663706144 * pow(max(1.0+g*g-2.0*g*mu,0.001),1.5));
      }

      ${cloudBeamGLSL}

      float cloudScatteringPhase(float opticalDepth, float mu) {
        // Reduced-extinction scattering orders, a real-time approximation,
        // not an independent multiple-scattering solution. Every HG lobe is
        // normalized; gain and convergence are tested separately from air.
        float result=0.0, contribution=1.0, attenuation=1.0, angular=1.0;
        for(int order=0;order<8;order++) {
          float phase=mix(cloudPhase(mu,-0.25*angular),cloudPhase(mu,0.65*angular),0.80);
          result += contribution*exp(-opticalDepth*attenuation)*phase;
          contribution*=0.5; attenuation*=0.5; angular*=0.5;
        }
        return result;
      }
      float cloudMultipleSource(float above, float total, float solarCosine) {
        float fraction=clamp(above/max(total,0.0001),0.0,1.0);
        vec3 uv=vec3(acos(1.0-2.0*fraction)/3.14159265359,
          clamp((solarCosine-0.01)/0.99,0.0,1.0),clamp(log(1.0+total)/log(129.0),0.0,1.0));
        return textureLod(uCloudScattering,(uv*vec3(63,15,31)+0.5)/vec3(64,16,32),0.0).r;
      }
      float cloudVerticalAbove=0.0,cloudVerticalTotal=0.0;
      void cloudAirGap(vec3 origin,vec3 dir,float a,float b,out vec3 light,out vec3 transmission);
      vec2 cloudColumnDistribution(float opacity,float meanTau) {
        opacity=clamp(opacity,0.0,0.999999);
        meanTau=max(meanTau,-log(1.0-opacity));
        float lo=max(opacity,0.000001),hi=1.0;
        for(int j=0;j<10;j++) {
          float fill=(lo+hi)*0.5;
          if(fill*(1.0-exp(-meanTau/fill))<opacity) lo=fill;else hi=fill;
        }
        float fill=(lo+hi)*0.5;
        return vec2(fill,meanTau/fill);
      }
      vec3 cloudSlabLight(vec3 local,vec3 dir,float tau,vec3 sun,
        vec3 color,float energy,bool below) {
        if(energy<=0.0 || tau<=0.00001) return vec3(0);
        vec3 radial=normalize(local);
        float muSun=dot(radial,sun),muView=max(abs(dot(radial,dir)),0.01);
        float sampleR=length(local);
        float horizon=-sqrt(max(0.0,1.0-uGroundR*uGroundR/(sampleR*sampleR)));
        float visibility=smoothstep(horizon-0.018,horizon+0.018,muSun)*eclipseVisibility(local,sun);
        float solar=max(muSun,0.01),mu=dot(dir,sun);
        float phase=mix(cloudPhase(mu,-0.25),cloudPhase(mu,0.65),0.8);
        float single;
        if(!below) single=phase*(1.0-exp(-tau*(1.0/solar+1.0/muView)))/(1.0+muView/solar);
        else {
          float difference=1.0/solar-1.0/muView;
          single=phase*(abs(difference)<0.001
            ? exp(-tau/muView)*tau/muView
            : (exp(-tau/muView)-exp(-tau/solar))/(muView*difference));
        }
        vec3 uv=vec3(clamp((muView-0.01)/0.99,0.0,1.0),
          clamp((solar-0.01)/0.99,0.0,1.0),clamp(log(1.0+tau)/log(129.0),0.0,1.0));
        vec4 diffuse=textureLod(uCloudScattering,(uv*vec3(63,15,31)+0.5)/vec3(64,16,32),0.0);
        vec3 airT=vec3(1),sky=vec3(0);
        if(air_uEnabled>0.5) {
          vec3 od=air_sunlightOpticalDepth(max(sampleR-air_uGroundR,0.0),muSun).rgb
            *vec3(air_uRayleighScaleHeight,air_uMieScaleHeight,air_uOzoneHalfWidth)*air_uDensityScale;
          airT=exp(-(air_uBetaRayleigh*od.r+air_uBetaMieExtinction*od.g+air_uBetaOzone*od.b));
          sky=air_multipleRadiance(max(sampleR-air_uGroundR,0.0),muSun)*air_uRadianceScale;
        }
        return color*energy*(uStellarRadianceScale*airT*visibility
          *(single+(below?diffuse.b:diffuse.g))+sky*diffuse.a);
      }
      float cloudLastJointOpacity=0.0;
      void cloudCachedColumnAt(vec3 radial,out vec2 opacity,out vec2 meanTau,out vec2 heights) {
        vec4 a=weatherAtlasSample(uOpticalColumns,uSpin*radial);
        vec4 b=weatherAtlasSample(uOpticalColumnsNext,uSpin*radial);
        vec2 tauA=exp(a.zw*log(129.0))-vec2(1),tauB=exp(b.zw*log(129.0))-vec2(1);
        meanTau=mix(tauA,tauB,uColumnMix);
        opacity=mix(a.xy,b.xy,uColumnMix);
        vec4 heightA=weatherAtlasSample(uColumnHeights,uSpin*radial);
        vec4 heightB=weatherAtlasSample(uColumnHeightsNext,uSpin*radial);
        if(uColumnsJointReady>.5) {
          heights=mix(heightA.rg*a.xy,heightB.rg*b.xy,uColumnMix)/max(opacity,vec2(0.000001));
          cloudLastJointOpacity=mix(heightA.b,heightB.b,uColumnMix);
        } else heights=mix(heightA.rg*tauA,heightB.rg*tauB,uColumnMix)/max(meanTau,vec2(0.000001));
      }
      vec4 cloudCachedColumn(vec3 dir,float start,float end) {
        vec2 opacity,meanTau,heights;
        cloudCachedColumnAt(normalize(uCameraLocal+dir*start),opacity,meanTau,heights);
        float lowJoint=cloudLastJointOpacity,highJoint=lowJoint;
        float lowAltitude=heights.r,highAltitude=heights.g;
        vec2 lowHits=sphereHits(uCameraLocal,uBodyR+lowAltitude,dir);
        vec2 highHits=sphereHits(uCameraLocal,uBodyR+highAltitude,dir);
        vec2 lowOpacityTau=vec2(opacity.r,meanTau.r),highOpacityTau=vec2(opacity.g,meanTau.g);
        // The outer envelope and a local low deck intersect different radial
        // columns. Sampling both at the envelope makes clouds use a nearby
        // mountain's height/opacity and creates hard terrain-shaped holes.
        // Solve each deck's column at its own intersection before occlusion.
        for(int iteration=0;iteration<4;iteration++) {
          if(lowHits.x>=0.0) {
            cloudCachedColumnAt(normalize(uCameraLocal+dir*lowHits.x),opacity,meanTau,heights);
            lowOpacityTau=vec2(opacity.r,meanTau.r);
            lowJoint=cloudLastJointOpacity;
            lowHits=sphereHits(uCameraLocal,uBodyR+heights.r,dir);
          }
          if(highHits.x>=0.0) {
            cloudCachedColumnAt(normalize(uCameraLocal+dir*highHits.x),opacity,meanTau,heights);
            highOpacityTau=vec2(opacity.g,meanTau.g);
            highJoint=cloudLastJointOpacity;
            highHits=sphereHits(uCameraLocal,uBodyR+heights.g,dir);
          }
        }
        vec2 low=cloudColumnDistribution(lowOpacityTau.x,lowOpacityTau.y);
        vec2 high=cloudColumnDistribution(highOpacityTau.x,highOpacityTau.y);
        float lowT=1.0,highT=1.0,lowFilledT=1.0,highFilledT=1.0;
        vec3 lowLight=vec3(0),highLight=vec3(0);
        float highDistance=highHits.x,lowDistance=lowHits.x;
        if(highDistance>=start && highDistance<=end) {
          vec3 p=uCameraLocal+dir*highDistance;
          float view=max(abs(dot(normalize(p),dir)),0.01);
          highFilledT=exp(-high.y/view);highT=1.0-high.x*(1.0-highFilledT);
          highLight=high.x*(cloudSlabLight(p,dir,high.y,normalize(uSunDir),uSunC,uSunEnergy,false)
            +cloudSlabLight(p,dir,high.y,normalize(uSecondarySunDir),uSecondarySunC,uSecondarySunEnergy,false));
        }
        if(lowDistance>=start && lowDistance<=end) {
          vec3 p=uCameraLocal+dir*lowDistance;
          float view=max(abs(dot(normalize(p),dir)),0.01);
          lowFilledT=exp(-low.y/view);lowT=1.0-low.x*(1.0-lowFilledT);
          lowLight=low.x*(cloudSlabLight(p,dir,low.y,normalize(uSunDir),uSunC,uSunEnergy,false)
            +cloudSlabLight(p,dir,low.y,normalize(uSecondarySunDir),uSecondarySunC,uSecondarySunEnergy,false));
        }
        // These decks share the same footprint. Multiplying independently
        // averaged transmissions invents extra cloud cover when liquid and
        // ice occur in the same subpixels. Keep the measured cross opacity;
        // a binary occupancy fit cannot supply its own overlap bound when
        // the true footprint contains a continuum of optical depths.
        float crossOpacity=low.x*high.x*(1.0-lowFilledT)*(1.0-highFilledT);
        if(uColumnsJointReady>.5) {
          float aLow=1.0-exp(-low.y),aHigh=1.0-exp(-high.y);
          float joint=(lowJoint+highJoint)*.5;
          float measuredCross=clamp(lowOpacityTau.x+highOpacityTau.x-joint,
            0.0,min(lowOpacityTau.x,highOpacityTau.x));
          crossOpacity=measuredCross*(1.0-lowFilledT)*(1.0-highFilledT)/max(aLow*aHigh,1e-6);
        }
        crossOpacity=clamp(crossOpacity,max(0.0,1.0-lowT-highT),min(1.0-lowT,1.0-highT));
        float transmission=clamp(lowT+highT-1.0+crossOpacity,0.0,1.0);
        if(transmission>0.996) return vec4(0);
        bool highFirst=highT<0.999999 && (lowT>=0.999999 || highDistance<=lowDistance);
        float first=highFirst?highDistance:lowDistance;
        float last=highFirst?lowDistance:highDistance;
        vec3 nearLight=highFirst?highLight:lowLight,farLight=highFirst?lowLight:highLight;
        float farT=highFirst?lowT:highT;
        float farVisible=max(0.0,1.0-crossOpacity/max(1.0-farT,1e-6));
        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 beforeL,beforeT,gapL=vec3(0),gapT=vec3(1);
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(first,air.y),beforeL,beforeT);
        if(highT<0.999999 && lowT<0.999999 && last>first)
          cloudAirGap(uCameraLocal,dir,first,last,gapL,gapT);
        vec3 correction=beforeL*(1.0-transmission)+beforeT*
          (nearLight*uTint+gapL*max(0.0,1.0-farT-crossOpacity)+gapT*farLight*uTint*farVisible);
        return vec4(correction,1.0-transmission);
      }

      vec3 cloudSource(vec3 local, vec3 dir, float d, float thick, float sigma,
        vec3 sunDirection, vec3 sunColor, float sunEnergy, float sunOD) {
        if (sunEnergy <= 0.0) return vec3(0.0);
        float mu = dot(dir, sunDirection);
        float hg = (1.0 - 0.28) / (12.566 * pow(1.0 + 0.28 - 1.06 * mu, 1.5));
        float back = (1.0 - 0.16) / (12.566 * pow(1.0 + 0.16 + 0.8 * mu, 1.5));
        // Normalized dual-lobe phase; stellar irradiance supplies brightness.
        float phase = mix(back, hg, 0.76);
        float sampleRadius = length(local);
        float sunElevation = dot(local / max(sampleRadius, 1.0), sunDirection);
        float geometricHorizon = -sqrt(max(0.0,
          1.0 - uGroundR * uGroundR / (sampleRadius * sampleRadius)));
        // High clouds may stay sunlit shortly after surface sunset, but
        // the planet must fully shadow the deck on its night side.
        float horizonVisibility = smoothstep(geometricHorizon - 0.018,
          geometricHorizon + 0.018, sunElevation);
        float eclipseLight = eclipseVisibility(local, sunDirection);
        // Totality removes direct light. Indirect sky below remains an
        // explicitly artistic approximation, not a direct-light floor.
        float directVisibility = horizonVisibility * eclipseLight;
        float od = 0.0;
        float Tsun = 1.0;
        #if PRODUCTION_CLOUD_MEDIUM
          od = sunOD;
          phase = exp(-od)*mix(cloudPhase(mu,-0.25),cloudPhase(mu,0.65),0.80)
            + cloudMultipleSource(cloudVerticalAbove,cloudVerticalTotal,max(sunElevation,0.01));
        #else
        // Diagnostic legacy fixtures retain their authored optical kernel.
        float ls = uLocalBands > 0.5 ? 650.0 : thick * 0.35;
        od += cloudExtinctionAt(local + sunDirection * ls * 0.6, sigma) * ls * 0.6;
        od += cloudExtinctionAt(local + sunDirection * ls * 1.5, sigma) * ls * 0.9;
        if (uQuality > 0.5) {
          od += cloudExtinctionAt(local + sunDirection * ls * 2.8, sigma) * ls * 1.3;
        } else {
          // Preserve approximately the same optical depth with one fewer
          // lookup on the low tier, so the silhouette and coverage stay
          // stable while only fine self-shadow detail is reduced.
          od *= 1.18;
        }
        Tsun = exp(-od * 1.48);
        #endif
        // Clear-sky indirect radiance is supplied by the same air solution.
        float ambientVisibility = mix(0.08, 1.0, horizonVisibility);
        vec3 sunAir = vec3(1.0);
        if (air_uEnabled > 0.5) {
          vec4 airDepth = air_sunlightOpticalDepth(max(sampleRadius-air_uGroundR,0.0), sunElevation);
          sunAir = exp(-air_uDensityScale * (
            air_uBetaRayleigh * airDepth.r * air_uRayleighScaleHeight
            + air_uBetaMieExtinction * airDepth.g * air_uMieScaleHeight
            + air_uBetaOzone * airDepth.b * air_uOzoneHalfWidth));
        }
        vec3 skyAmbient = air_uEnabled > 0.5 && air_uMultipleEnabled > 0.5
          ? air_multipleRadiance(max(sampleRadius-air_uGroundR,0.0),sunElevation)*air_uRadianceScale*sunColor
          : uAmbC * ambientVisibility;
        if (uLocalBands > 0.5) {
          #if PRODUCTION_CLOUD_MEDIUM
          skyAmbient *= exp(-cloudVerticalAbove);
          #else
          float skyOD = cloudExtinctionAt(local + normalize(local) * 180.0, sigma) * 180.0
            + cloudExtinctionAt(local + normalize(local) * 700.0, sigma) * 520.0;
          skyAmbient *= 0.12 + 0.88 * exp(-skyOD);
          #endif
        }
        vec3 source = sunColor * sunAir * uStellarRadianceScale * Tsun * phase
          * directVisibility + skyAmbient;
        return source * sunEnergy;
      }

      vec3 cloudCombinedSource(vec3 local,vec3 dir,float d,float thick,float sigma) {
        vec4 depths=vec4(0);
        #if PRODUCTION_CLOUD_MEDIUM
        // One compiled density/light kernel, shared by both stars and the
        // vertical diffuse reference. Repeated inlining of the species loop
        // at each call site stalls the D3D shader compiler.
        for(int path=0;path<uLightPathCount;path++) {
          vec3 direction=path==0?normalize(uSunDir):path==1?normalize(uSecondarySunDir)
            :path==2?normalize(local):-normalize(local);
          if(path==1 && uSecondarySunEnergy<=0.0)continue;
          if(path<2) {
            float radius=length(local),muSun=dot(local/radius,direction);
            float horizon=-sqrt(max(0.0,1.0-uGroundR*uGroundR/(radius*radius)));
            // The source's direct term is exactly zero here. Sky radiance
            // still uses the two vertical fields; an unobservable solar beam
            // must not traverse the night-side shell for every source sample.
            if(muSun<=horizon-0.018 || eclipseVisibility(local,direction)<=0.0)continue;
          }
          // Keep the out parameter separate from the dynamically indexed
          // vector assignment. ANGLE/D3D's copy-back can otherwise discard
          // the fallback result, leaving zero optical depth outside the cache.
          float pathDepth=0.0;
          bool cached=cloudCachedLight(local,path,pathDepth);
          if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);
          depths[path]=pathDepth;
        }
        cloudVerticalAbove=depths.z;cloudVerticalTotal=depths.z+depths.w;
        #endif
        vec3 source=vec3(0);
        for(int star=0;star<2;star++) {
          source+=cloudSource(local,dir,d,thick,sigma,
            star==0?normalize(uSunDir):normalize(uSecondarySunDir),
            star==0?uSunC:uSecondarySunC,star==0?uSunEnergy:uSecondarySunEnergy,depths[star]);
        }
        return source;
      }

      void cloudAirGap(vec3 origin, vec3 dir, float a, float b,
        out vec3 light, out vec3 transmission) {
        light = vec3(0.0); transmission = vec3(1.0);
        if (air_uEnabled < 0.5 || b <= a) return;
        // A 100 m gap needs one air cell, not the entire 32-cell planetary
        // quadrature. Bound the cell by the shortest air density scale.
        float cellLimit = min(air_uRayleighScaleHeight, air_uMieScaleHeight) * 0.25;
        if(b-a>cellLimit*min(32.0,air_uViewSteps)) {
          airIntegrate(origin,dir,a,b,light,transmission);return;
        }
        int cells = int(clamp(ceil((b-a)/max(cellLimit,50.0)),1.0,32.0));
        float stride = (b-a)/float(cells);
        for(int k=0;k<cells;k++) {
          vec3 ext,source;
          airSample(origin+dir*(a+(float(k)+0.5)*stride),dir,stride,ext,source);
          mediumStep(light,transmission,ext,source,stride);
        }
      }

      // Consecutive cloud interaction quantiles often lie only metres apart.
      // Reuse a bounded homogeneous air cell rather than re-evaluating both
      // stellar LUTs at every quantile. Shadow crossings retain the original
      // interval quadrature, because its finite-cell visibility cannot be
      // reused for a partial interval on the other side of a crossing.
      void cloudAirAdvance(vec3 origin,vec3 dir,float a,float b,
        inout float cellEnd,inout vec3 cellExt,inout vec3 cellSource,
        out vec3 light,out vec3 transmission) {
        light=vec3(0);transmission=vec3(1);
        if(air_uEnabled<0.5 || b<=a)return;
        float limit=max(25.0,min(air_uRayleighScaleHeight,air_uMieScaleHeight)*0.1);
        float cursor=a;
        for(int k=0;k<64;k++) {
          if(cursor>=b)break;
          if(cellEnd<=cursor) {
            cellEnd=cursor+limit;
            vec3 start=origin+dir*cursor,end=origin+dir*cellEnd;
            bool crossing=false;
            for(int star=0;star<2;star++) {
              vec3 sun=star==0?air_uSunDirection0:air_uSunDirection1;
              float energy=star==0?air_uSunEnergy0:air_uSunEnergy1;
              if(energy<=0.0)continue;
              crossing=crossing || air_solarHorizonClearance(start,sun)
                *air_solarHorizonClearance(end,sun)<=0.0;
              float v0=air_eclipseVisibility(start,sun),v1=air_eclipseVisibility(end,sun);
              crossing=crossing || min(v0,v1)<0.999 && max(v0,v1)>0.001;
            }
            if(crossing) {
              vec3 restLight,restTransmission;
              cloudAirGap(origin,dir,cursor,b,restLight,restTransmission);
              light+=transmission*restLight;transmission*=restTransmission;
              cellEnd=b;return;
            }
            airSample(origin+dir*(cursor+limit*0.5),dir,limit,cellExt,cellSource);
          }
          float next=min(b,cellEnd);
          mediumStep(light,transmission,cellExt,cellSource,next-cursor);
          cursor=next;
        }
        if(cursor<b) {
          vec3 restL,restT;cloudAirGap(origin,dir,cursor,b,restL,restT);
          light+=transmission*restL;transmission*=restT;cellEnd=b;
        }
      }

      // Pixel columns retain the point-density field but compress illumination
      // once the individual cells are unresolved. This is a radiance LOD,
      // not a second coverage texture or an observer-dependent density.
      vec4 cloudFarColumn(vec3 dir, float start, float end) {
        float closest=-dot(uCameraLocal,dir);
        float impact2=dot(cross(uCameraLocal,dir),cross(uCameraLocal,dir));
        float radiusStart=length(uCameraLocal+dir*start);
        float radiusEnd=length(uCameraLocal+dir*min(end,closest));
        float T=1.0, moment=0.0, weightedDistance=0.0;
        float previous=start;
        int columns=int(uColumnSteps);
        for(int k=0;k<columns;k++) {
          float radius=mix(radiusStart,radiusEnd,float(k+1)/float(columns));
          float next=min(end,closest-sqrt(max(0.0,(radius-sqrt(impact2))*(radius+sqrt(impact2)))));
          float distance=max(0.0,next-previous);
          float middle=(next+previous)*0.5;
          float ext=cloudExtinctionAt(uCameraLocal+dir*middle,0.0);
          float weight=T*(1.0-exp(-ext*distance));
          weightedDistance+=middle*weight; moment+=weight; T-=weight;
          previous=next;
          if(T<0.0002) break;
        }
        // A grazing ray that misses the opaque body sees both shell halves.
        if(end>closest && T>=0.0002) {
          radiusStart=sqrt(impact2); radiusEnd=length(uCameraLocal+dir*end);
          previous=closest;
          for(int k=0;k<columns;k++) {
            float radius=mix(radiusStart,radiusEnd,float(k+1)/float(columns));
            float next=min(end,closest+sqrt(max(0.0,(radius-sqrt(impact2))*(radius+sqrt(impact2)))));
            float distance=max(0.0,next-previous),middle=(next+previous)*0.5;
            float ext=cloudExtinctionAt(uCameraLocal+dir*middle,0.0);
            float weight=T*(1.0-exp(-ext*distance));
            weightedDistance+=middle*weight; moment+=weight; T-=weight; previous=next;
            if(T<0.0002) break;
          }
        }
        if(moment<0.004) return vec4(0.0);
        float t=weightedDistance/max(moment,1e-9);
        vec3 local=uCameraLocal+dir*t;
        vec3 source=cloudCombinedSource(local,dir,0.0,uRout-uRin,0.0);
        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 light,transmission;
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(t,air.y),light,transmission);
        return vec4((light+transmission*source*uTint)*moment,moment);
      }

      void main() {
        cloudFootprint = 0.0;
        vec3 dir = normalize(vDirection);
        // Derivatives are undefined after neighbouring lanes have discarded
        // at opaque/cloud boundaries. Measure the ray cone before any discard.
        float rayCone=max(length(dFdx(dir)),length(dFdy(dir)));
        if (uEngage < 0.01) discard;
        // A camera below the opaque body has no line of sight to the shell.
        // sphereHits() otherwise reports an exit on the far side and the
        // ground.x > 0 test below cannot reject it from inside the sphere.
        if (length(uCameraLocal) < uGroundR) discard;
        float renderRout = uRout;
        vec2 outer = sphereHits(uCameraLocal, renderRout, dir);
        if (outer.y <= 0.0) discard;
        vec2 inner = sphereHits(uCameraLocal, uRin, dir);
        // march the FIRST pass through the shell only (the re-entry segment
        // on the far side is behind the planet for any ray that matters)
        float t0 = max(outer.x, 0.0);
        float t1 = (inner.x > 0.0) ? inner.x : outer.y;
        float camR = length(uCameraLocal);
        if (camR < uRin && inner.y > 0.0) { t0 = max(inner.y, 0.0); t1 = outer.y; }
        // From below the cloud base, rays aimed into the planet reach terrain
        // before reaching any cloud. Without this occlusion test the far-side
        // shell was integrated over the foreground and looked like a full-
        // screen cloud card.
        vec2 ground = sphereHits(uCameraLocal, uGroundR, dir);
        if (ground.x > 0.0) {
          if (ground.x <= t0) discard;
          t1 = min(t1, ground.x);
        }
        // Stop the ray at the first opaque scene surface. Trees, rocks,
        // terrain and the ship now occlude the volume instead of receiving a
        // half-resolution cloud layer over their silhouettes.
        t1 = min(t1, sceneRayLimit());
        // Integrate the visible shell to the actual opaque surface/exit.
        // A shell-thickness cutoff made a camera-centred disc of clouds.
        if (t1 <= t0) discard;

        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW
        {
          float footprint=rayCone*t0;
          vec4 column;
          #if CLOUD_FAR_CACHE
          // This variant is selected only after both immutable columns are
          // complete and a conservative whole-frame ray-cone bound is above
          // the existing unresolved threshold. Prune the point-light kernel
          // and its register footprint from this entirely unresolved draw.
          column=cloudCachedColumn(dir,t0,t1);
          #else
          if(uColumnsReady>0.5 && footprint>2400.0) column=cloudCachedColumn(dir,t0,t1);
          else {
            column=cloudFarColumn(dir,t0,t1);
            if(uColumnsReady>0.5 && footprint>900.0) column=mix(column,cloudCachedColumn(dir,t0,t1),smoothstep(900.0,2400.0,footprint));
          }
          #endif
          if(column.a<0.004) discard;
          gl_FragColor=column*uEngage;
          return;
        }
        #else

        float seg = t1 - t0;
        float thick = renderRout - uRin;
        // This material is rendered by the half-resolution temporal volume
        // pass. A fresh jittered 44–84 sample signal reconstructs more cleanly
        // than 120 static steps and avoids the old grazing-angle brush tails.
        float minSteps = max(18.0, uMaxSteps * mix(0.58, 0.38, uQuality));
        float maxSteps = uMaxSteps;
        int STEPS = int(clamp(seg / (thick * mix(0.052, 0.032, uQuality)),
          minSteps, maxSteps));
        if (uLocalBands > 0.5) {
          float radialRate = abs(dot(dir, normalize(uCameraLocal + dir * (t0+t1)*0.5)));
          float physicalStep = min(200.0, 80.0 / max(radialRate,0.08));
          physicalStep *= 124.0 / max(uMaxSteps,16.0);
          STEPS = int(clamp(ceil(seg/physicalStep), 16.0, uViewCapacity));
        }
        float dt = seg / float(STEPS);
        float framePhase = mod(uFrame, 16.0);
        float jitter = hash12(gl_FragCoord.xy
          + vec2(framePhase * 19.19, framePhase * 7.73));
        float relativeDistance=0.0,lastCloudEnd=0.0;
        // Legacy artistic column optical depth, now camera-independent.
        // B4 still must replace shell-normalized extinction with a calibrated
        // medium and bound the error of the long-path cutoff above.
        float sigma = 3.80 / thick;

        // Air before the cloud interval is restored after attenuation of the
        // full-resolution clear-air image. Within the cloud interval, sum
        // extinction/source before integration (not two independent overlays).
        vec2 airBounds = air_sphereHits(uCameraLocal, air_uTopR, dir);
        vec3 beforeL = vec3(0.0), beforeT = vec3(1.0);
        bool startedCloud = false;
        int lastOccupiedStep = -1;
        vec3 jointL = vec3(0.0), jointT = vec3(1.0);
        vec3 clearL = vec3(0.0), clearT = vec3(1.0);
        float T = 1.0;
        #if PRODUCTION_CLOUD_MEDIUM
        // Integrate the first cloud interaction in optical-depth coordinates.
        // C = integral Tc*sigmaC*(LairBefore + TairBefore*Scloud) dt.
        // This integration-by-parts identity is the same joint medium as the
        // cell transport below, while lighting is evaluated at probability
        // quantiles instead of at hundreds of opaque interior samples.
        float anchors[32];
        int bins=clamp(uLightQuadratureSteps,4,32);
        float totalOpacity=0.0;
        for(int pass=0;pass<2;pass++) {
          relativeDistance=0.0;T=1.0;int bin=0;
          for(int i=0;i<STEPS;i++) {
            if(relativeDistance>=seg)break;
            float cellLength=min(dt,seg-relativeDistance),cellStart=t0+relativeDistance;
            vec3 position=uCameraLocal+dir*cellStart;
            if(uBandsReady>0.5) {
              float radius=length(position),altitude=radius-uBodyR;
              vec3 radial=position/radius;
              vec2 bounds=productionAltitudeBounds(radial);
              if(altitude<bounds.x || altitude>bounds.y) {
                vec2 size=vec2(textureSize(uBandBounds,0));
                float tileLimit=uBodyR*0.20*min(3.14159265359/size.y,
                  6.28318530718/size.x*sqrt(max(0.0,1.0-radial.y*radial.y)));
                float skipLength=min(2000.0,min(tileLimit,seg-relativeDistance));
                if(bounds.x<=bounds.y) {
                  vec2 hits=sphereHits(position,uBodyR+(altitude<bounds.x?bounds.x:bounds.y),dir);
                  float next=hits.x>0.0?hits.x:hits.y>0.0?hits.y:1e20;
                  skipLength=min(skipLength,next);
                }
                if(skipLength>cellLength){relativeDistance+=skipLength;continue;}
              }
            }
            float ext=cloudExtinctionAt(uCameraLocal+dir*(cellStart+cellLength*jitter),sigma);
            float nextT=T*exp(-ext*cellLength);
            if(pass==1 && ext>0.0) {
              for(int b=bin;b<bins;b++) {
                float probability=totalOpacity*(float(b)+0.5)/float(bins);
                if(1.0-nextT<probability)break;
                float within=log(T/max(1.0-probability,0.000001))/ext;
                anchors[b]=cellStart+clamp(within,0.0,cellLength);bin=b+1;
              }
            }
            T=nextT;relativeDistance+=cellLength;
            if(T<0.0002)break;
          }
          if(pass==0)totalOpacity=1.0-T;
        }
        float alpha=totalOpacity*uEngage;
        if(alpha<0.004)discard;
        vec3 correction=vec3(0);
        vec3 frontLight=vec3(0),frontTransmission=vec3(1);
        float previousAnchor=max(airBounds.x,0.0);
        float airCellEnd=-1.0;vec3 airCellExt=vec3(0),airCellSource=vec3(0);
        for(int bin=0;bin<bins;bin++) {
          float distance=anchors[bin];vec3 local=uCameraLocal+dir*distance;
          float nextAnchor=min(distance,airBounds.y);
          vec3 gapLight,gapTransmission;
          if(bin==0)cloudAirGap(uCameraLocal,dir,previousAnchor,nextAnchor,gapLight,gapTransmission);
          else cloudAirAdvance(uCameraLocal,dir,previousAnchor,nextAnchor,
            airCellEnd,airCellExt,airCellSource,gapLight,gapTransmission);
          frontLight+=frontTransmission*gapLight;frontTransmission*=gapTransmission;
          previousAnchor=nextAnchor;
          vec3 source=cloudCombinedSource(local,dir,0.0,thick,sigma)*uTint;
          correction+=(frontLight+frontTransmission*source)*(totalOpacity/float(bins));
        }
        gl_FragColor = vec4(correction * uEngage, alpha);
        #else
        for (int i = 0; i < STEPS; i++) {
          if(relativeDistance>=seg) break;
          float cellLength=min(dt,seg-relativeDistance);
          float cellStart=t0+relativeDistance;
          #if PRODUCTION_CLOUD_MEDIUM
          if(uBandsReady>0.5) {
            vec3 position=uCameraLocal+dir*cellStart;
            float radius=length(position),altitude=radius-uBodyR;
            vec3 radial=position/radius;
            vec2 bounds=productionAltitudeBounds(radial);
            if(altitude<bounds.x || altitude>bounds.y) {
              vec2 size=vec2(textureSize(uBandBounds,0));
              float tileLimit=uBodyR*0.20*min(3.14159265359/size.y,
                6.28318530718/size.x*sqrt(max(0.0,1.0-radial.y*radial.y)));
              float skipLength=min(2000.0,min(tileLimit,seg-relativeDistance));
              if(bounds.x<=bounds.y) {
                float boundary=altitude<bounds.x?bounds.x:bounds.y;
                vec2 hits=sphereHits(position,uBodyR+boundary,dir);
                float next=hits.x>0.0?hits.x:hits.y>0.0?hits.y:1e20;
                skipLength=min(skipLength,next);
              }
              if(skipLength>cellLength) {relativeDistance+=skipLength;continue;}
            }
          }
          #endif
          float t=cellStart+cellLength*jitter;
          vec3 local = uCameraLocal + dir * t;
          vec2 layers = vec2(0.0);
          float d;
          if (uLocalBands > 0.5) {
            layers = cloudLayersAt(local);
            d = max(layers.x, layers.y * 0.06);
          } else d = densityAt(local);
          float cloudExtinction = uLocalBands > 0.5
            ? layers.x * 0.025 + layers.y * 0.0006 : (d > 0.003 ? d * sigma : 0.0);
          // Thin ice still scatters. A liquid-density visibility threshold
          // previously kept its extinction but removed all of its source.
          if (cloudExtinction < 1e-9) { relativeDistance+=cellLength; continue; }
          if (!startedCloud) {
            airIntegrate(uCameraLocal, dir, max(airBounds.x, 0.0),
              min(cellStart, airBounds.y), beforeL, beforeT);
            startedCloud = true;
          }
          if (lastOccupiedStep >= 0 && i > lastOccupiedStep + 1) {
            float gapStart = t0 + lastCloudEnd;
            vec3 gapL, gapT;
            cloudAirGap(uCameraLocal, dir, gapStart, cellStart, gapL, gapT);
            jointL += jointT * gapL; jointT *= gapT;
            clearL += clearT * gapL; clearT *= gapT;
          }
          vec3 cloudLight = vec3(0.0);
          {
            cloudLight = cloudCombinedSource(local,dir,d,thick,sigma);
            // The legacy powder factor discarded roughly half of the source
            // radiance even at an illuminated cloud top. Physical local bands
            // use the joint medium's extinction/source weighting directly.
            float powder = uLocalBands > 0.5 ? 1.0
              : mix(0.44, 0.68, 1.0 - exp(-d * 2.2));
            cloudLight *= powder * uTint;
          }
          vec3 airExtinction, airSource;
          // Air uses the cell centre; density jitter samples only cloud detail.
          airSample(uCameraLocal + dir * (cellStart+0.5*cellLength), dir, cellLength,
            airExtinction, airSource);
          mediumStep(jointL, jointT, airExtinction + vec3(cloudExtinction),
            airSource + cloudLight * cloudExtinction, cellLength);
          mediumStep(clearL, clearT, airExtinction, airSource, cellLength);
          T *= exp(-cloudExtinction * cellLength);
          lastOccupiedStep = i;
          lastCloudEnd=relativeDistance+cellLength;
          if (uLocalBands > 0.5 && T < 0.0002) break;
          relativeDistance+=cellLength;
        }
        float alpha = (1.0 - T) * uEngage;
        if (alpha < 0.004) discard;

        // For clear image B = Lair + Tair*background, output correction C:
        // C + Tc*B = Ljoint + Tjoint*background. Air behind the cloud cancels;
        // front air and air within the cloud are retained in the proper order.
        // No camera-dependent white cap: clipping would break this identity.
        vec3 correction = beforeL * (1.0-T) + beforeT * (jointL - T*clearL);
        gl_FragColor = vec4(correction * uEngage, alpha);
        #endif
        #endif
      }`,
  });
  mat.userData.band = band;
  mat.userData.productionShapeVersion = PRODUCTION_SHAPE_VERSION;
  return mat;
}
