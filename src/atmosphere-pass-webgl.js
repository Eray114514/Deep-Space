import { atmosphereUniforms } from './atmosphere-uniforms.js';
import { bindStellarOcclusion } from './stellar-occlusion.js';
import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';
import { atmosphereTransportGLSL, atmosphereUniformGLSL } from './atmosphere-transport-glsl.js';
import { createMultipleScatteringLut } from './atmosphere-multiple-scattering.js';
import { createAtmosphereProfile } from './atmosphere-physics.js';
import {
  ATMOSPHERE_VIEW_STEPS, ATMOSPHERE_LUT_STEPS,
  atmosphereSampleBoundary, atmosphereQuadratureGLSL,
} from './atmosphere-quadrature.js';

const LUT_WIDTH = 256;
const LUT_HEIGHT = 96;
const LUT_STEPS = ATMOSPHERE_LUT_STEPS;
const VIEW_STEPS = ATMOSPHERE_VIEW_STEPS;
const LUT_CACHE_LIMIT = 4;

const _cameraOffset = new THREE.Vector3();
const _eyeOffset = new THREE.Vector3();
const _localCamera = new THREE.Vector3();
const _rotation = new THREE.Matrix4();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function raySphereDistance(radius, radialCosine, sphereRadius) {
  const b = radius * radialCosine;
  const discriminant = b * b + sphereRadius * sphereRadius - radius * radius;
  if (discriminant < 0) return Infinity;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  if (near > 1e-6) return near;
  return far > 1e-6 ? far : Infinity;
}

function pathHitsGround(radius, radialCosine, groundRadius) {
  const b = radius * radialCosine;
  const discriminant = b * b + groundRadius * groundRadius - radius * radius;
  return discriminant >= 0 && -b - Math.sqrt(discriminant) > 1e-6;
}

function ozoneDensity(profile, altitude) {
  return Math.max(0,
    1 - Math.abs(altitude - profile.ozoneCenterMeters) / profile.ozoneHalfWidthMeters);
}

// Authored atmosphereHeight remains a gameplay/cloud envelope. It must not
// stretch the molecular scale heights used for optical scattering.
export function atmosphereRenderProfile(planet) {
  const pressureBar = Number(planet?.atmosphere?.pressureBar);
  const pressure = Number.isFinite(pressureBar) && pressureBar > 0
    ? pressureBar : Math.max(0.02, Number(planet?.atmoDensity) || 1);
  const groundRadiusMeters = Math.max(1000, Number(planet?.R) || 6371000);
  const maxTerrainMeters = Math.max(0, Number(planet?.hAmp) || 0);
  // The canonical 6,000 km world receives a 100 km optical top. Compressed
  // procedural bodies retain enough clearance for relief without inheriting
  // the old 9–13.5% uniform shell.
  const topAltitudeMeters = clamp(Math.max(
    groundRadiusMeters * (100000 / 6000000),
    maxTerrainMeters * 2.4 + 6000,
  ), 26000, 120000);
  const type = planet?.type || 'lush';
  const temperatureK = clamp(
    Number(planet?.weatherProfile?.temperatureK) || 286, 170, 700);
  const temperatureScale = clamp(temperatureK / 286, 0.68, 1.45);
  // Ideal-gas reference density at the authored surface pressure/temperature.
  // atmoDensity is only the fallback for worlds without a physical pressure.
  const densityScale = pressure * 286 / temperatureK;
  const rayleighScaleHeightMeters = 8000 * temperatureScale;
  const mieScaleHeightMeters = (type === 'desert' || type === 'toxic' ? 1800 : 1200)
    * Math.sqrt(temperatureScale);
  const profile = createAtmosphereProfile({
    groundRadiusMeters,
    topAltitudeMeters,
    rayleighScaleHeightMeters,
    mieScaleHeightMeters,
    ozoneCenterMeters: Math.min(25000, topAltitudeMeters * 0.42),
    ozoneHalfWidthMeters: Math.min(15000, topAltitudeMeters * 0.28),
    multipleScatteringFactor: 0.1,
  });
  return { profile, densityScale };
}

// RGB stores normalized Rayleigh/Mie/ozone optical depth; alpha marks rays
// which reach space without intersecting the ground.
export function createAtmosphereOpticalDepthLut(profile,
  width = LUT_WIDTH, height = LUT_HEIGHT, steps = LUT_STEPS) {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const altitude = profile.topAltitudeMeters * (y / Math.max(1, height - 1)) ** 2;
    const radius = profile.groundRadiusMeters + altitude;
    for (let x = 0; x < width; x++) {
      const angularCoordinate = -1 + 2 * x / Math.max(1, width - 1);
      const mu = angularCoordinate * Math.abs(angularCoordinate);
      const offset = (y * width + x) * 4;
      const blocked = pathHitsGround(radius, mu, profile.groundRadiusMeters);
      // Retain a valid limiting optical depth on the shadow side. Zero RGB
      // texels mixed with lit neighbours falsely remove atmospheric extinction
      // exactly at sunset. Visibility is integrated separately in the shader.
      const horizonMu = -Math.sqrt(Math.max(0,
        1 - (profile.groundRadiusMeters / radius) ** 2));
      const opticalMu = Math.max(mu, horizonMu + 1e-7);
      const distance = raySphereDistance(radius, opticalMu, profile.topRadiusMeters);
      if (!Number.isFinite(distance)) {
        data[offset + 3] = 1;
        continue;
      }
      let rayleigh = 0;
      let mie = 0;
      let ozone = 0;
      let previous = 0;
      for (let i = 0; i < steps; i++) {
        const next = atmosphereSampleBoundary(0, distance, -radius * opticalMu, (i + 1) / steps);
        const stepLength = next - previous;
        const t = (previous + next) * 0.5;
        previous = next;
        const sampleRadius = Math.sqrt(radius * radius + t * t + 2 * radius * t * opticalMu);
        const sampleAltitude = Math.max(0, sampleRadius - profile.groundRadiusMeters);
        rayleigh += Math.exp(-sampleAltitude / profile.rayleighScaleHeightMeters) * stepLength;
        mie += Math.exp(-sampleAltitude / profile.mieScaleHeightMeters) * stepLength;
        ozone += ozoneDensity(profile, sampleAltitude) * stepLength;
      }
      data[offset] = rayleigh / profile.rayleighScaleHeightMeters;
      data[offset + 1] = mie / profile.mieScaleHeightMeters;
      data[offset + 2] = ozone / profile.ozoneHalfWidthMeters;
      data[offset + 3] = blocked ? 0 : 1;
    }
  }
  return { data, width, height };
}

function makeLutTexture(profile) {
  const lut = createAtmosphereOpticalDepthLut(profile);
  const texture = new THREE.DataTexture(
    lut.data, lut.width, lut.height, THREE.RGBAFormat, THREE.FloatType,
  );
  texture.name = 'atmosphere.optical-depth';
  // The dense LUT uses portable nearest sampling so the WebGL2 baseline does
  // not depend on the optional OES_texture_float_linear extension.
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function groundAlbedo(planet) {
  const palette = planet?.palU;
  if (!palette) return new THREE.Color(0.18, 0.2, 0.16);
  const average = (colors, count) => {
    const result = new THREE.Color(0, 0, 0);
    const total = Math.max(1, Math.min(colors?.length || 0, Math.round(count || 0)));
    for (let index = 0; index < total; index++) {
      result.add(colors?.[index] || new THREE.Color(0.18, 0.2, 0.16));
    }
    return result.multiplyScalar(1 / total);
  };
  const land = average(palette.landC, palette.landN);
  if (!palette.hasSea) return land;
  const sea = average(palette.seaC, palette.seaN);
  return land.multiplyScalar(0.42).add(sea.multiplyScalar(0.58));
}

export class AtmospherePass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.activePlanet = null;
    this.profileState = null;
    this.lutTexture = null;
    // Bounded profile LRU: keys must not retain entire inactive planet graphs.
    // WeakMap planet keys alone did not release the former Set-held textures.
    // Four 256x96 RGBA32F LUTs occupy at most 1.5 MiB before driver overhead.
    this.profileCache = new Map();
    this.visualEnabled = true;
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      name: 'Atmosphere physical transport',
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      blending: THREE.NoBlending,
      uniforms: { ...atmosphereUniforms(camera), tBase: { value: null }, tSceneDepth: { value: null } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        #define VIEW_STEPS ${VIEW_STEPS}
        uniform sampler2D tBase, tSceneDepth;
        ${atmosphereUniformGLSL}
        varying vec2 vUv;

        ${atmosphereTransportGLSL}

        void main() {
          vec4 base = texture2D(tBase, vUv);
          if (any(isnan(base.rgb)) || any(isinf(base.rgb))) base.rgb = vec3(0.0);
          base.rgb = max(base.rgb, vec3(0.0));
          float sceneDepth = texture2D(tSceneDepth, vUv).x;
          gl_FragDepth = sceneDepth;
          if (uEnabled < 0.5) {
            gl_FragColor = base;
            return;
          }
          vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec4 view = uInvProjection * clip;
          vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
          vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
          vec3 direction = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
          vec2 outer = sphereHits(uCameraLocal, uTopR, direction);
          if (outer.y <= 0.0) {
            gl_FragColor = base;
            return;
          }
          float t0 = max(outer.x, 0.0);
          float t1 = outer.y;
          vec2 ground = sphereHits(uCameraLocal, uGroundR, direction);
          if (ground.x > t0) t1 = min(t1, ground.x);
          if (sceneDepth < 0.999999) {
            float forwardDistance = pow(uCameraFar + 1.0, sceneDepth) - 1.0;
            float forwardCosine = max(-directionView.z, 0.0005);
            t1 = min(t1, forwardDistance / forwardCosine);
          }
          if (t1 <= t0) {
            gl_FragColor = base;
            return;
          }

          vec3 radiance, transmittance;
          airIntegrate(uCameraLocal, direction, t0, t1, radiance, transmittance);
          gl_FragColor = vec4(radiance + base.rgb * transmittance, base.a);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setActivePlanet(planet, nav) {
    if (this.activePlanet === planet && planet) {
      this.updatePlanetUniforms(planet, nav);
      return;
    }
    if (this.activePlanet?.atmoMesh) this.activePlanet.atmoMesh.visible = true;
    if (this.activePlanet) this.activePlanet.atmosphereTransportUniforms = null;
    this.activePlanet = planet?.atmoMesh ? planet : null;
    this.material.uniforms.uEnabled.value
      = this.activePlanet && this.visualEnabled ? 1 : 0;
    if (!this.activePlanet) {
      this.activeCache = null;
      this.lutTexture = null;
      this.profileState = null;
      this.material.uniforms.tOpticalDepth.value = null;
      this.material.uniforms.tMultipleScattering.value = null;
      this.material.uniforms.uMultipleEnabled.value = 0;
      return;
    }
    this.activePlanet.atmoMesh.visible = false;
    this.profileState = atmosphereRenderProfile(this.activePlanet);
    const cacheKey = JSON.stringify(this.profileState.profile);
    const multipleKey = JSON.stringify([this.profileState.densityScale, groundAlbedo(this.activePlanet).toArray()]);
    let cached = this.profileCache.get(cacheKey);
    if (!cached) {
      cached = { texture: makeLutTexture(this.profileState.profile) };
    }
    if (cached.multipleKey !== multipleKey) {
      cached.multiple?.dispose(); cached.multiple = null;
      cached.multipleKey = multipleKey;
    }
    this.profileCache.delete(cacheKey);
    this.profileCache.set(cacheKey, cached);
    if (this.profileCache.size > LUT_CACHE_LIMIT) {
      const oldest = this.profileCache.keys().next().value;
      this.profileCache.get(oldest).texture.dispose();
      this.profileCache.get(oldest).multiple?.dispose();
      this.profileCache.delete(oldest);
    }
    this.lutTexture = cached.texture;
    this.activeCache = cached;
    this.material.uniforms.tMultipleScattering.value = cached.multiple?.texture || null;
    this.material.uniforms.uMultipleEnabled.value = cached.multiple ? 1 : 0;
    this.material.uniforms.tOpticalDepth.value = this.lutTexture;
    const { profile, densityScale } = this.profileState;
    const uniforms = this.material.uniforms;
    uniforms.uGroundR.value = profile.groundRadiusMeters;
    uniforms.uTopR.value = profile.topRadiusMeters;
    uniforms.uTopAltitude.value = profile.topAltitudeMeters;
    uniforms.uRayleighScaleHeight.value = profile.rayleighScaleHeightMeters;
    uniforms.uMieScaleHeight.value = profile.mieScaleHeightMeters;
    uniforms.uOzoneCenter.value = profile.ozoneCenterMeters;
    uniforms.uOzoneHalfWidth.value = profile.ozoneHalfWidthMeters;
    uniforms.uBetaRayleigh.value.fromArray(profile.rayleigh);
    uniforms.uBetaMieScatter.value.fromArray(profile.mie.scattering);
    uniforms.uBetaMieExtinction.value.fromArray(profile.mie.extinction);
    uniforms.uBetaOzone.value.fromArray(profile.ozoneAbsorption);
    uniforms.uDensityScale.value = densityScale;
    uniforms.uGroundAlbedo.value.copy(groundAlbedo(this.activePlanet));
    this.updatePlanetUniforms(this.activePlanet, nav);
  }

  setVisualEnabled(enabled) {
    this.visualEnabled = !!enabled;
    this.material.uniforms.uEnabled.value
      = this.activePlanet && this.visualEnabled ? 1 : 0;
  }

  updatePlanetUniforms(planet, nav) {
    if (!planet) return;
    const uniforms = this.material.uniforms;
    planet.atmosphereTransportUniforms = uniforms;
    _cameraOffset.copy(nav || planet.posUniv).sub(planet.posUniv);
    this.camera.updateWorldMatrix(true, false);
    _cameraOffset.add(_eyeOffset.setFromMatrixPosition(this.camera.matrixWorld));
    planet.worldOffsetToLocal?.(_cameraOffset, _localCamera);
    uniforms.uCameraLocal.value.copy(_localCamera);
    _rotation.makeRotationFromQuaternion(planet._invFrame);
    uniforms.uWorldToLocal.value.copy(_rotation);
    uniforms.uRadianceScale.value = planet.stellarLightField?.radianceScale ?? 3.2;
    const sources = planet.stellarLightField?.sources || [];
    const primary = sources[0] || null;
    const secondary = sources[1] || null;
    uniforms.uSunDirection0.value.copy(primary?.localDirection || planet.sunDirLocal);
    uniforms.uSunColor0.value.copy(primary?.colorValue || new THREE.Color(1, 1, 1));
    uniforms.uSunEnergy0.value = primary?.irradianceFraction ?? 1;
    uniforms.uSunDirection1.value.copy(secondary?.localDirection || planet.sunDirLocal);
    uniforms.uSunColor1.value.copy(secondary?.colorValue || new THREE.Color(1, 1, 1));
    uniforms.uSunEnergy1.value = secondary?.irradianceFraction ?? 0;
    bindStellarOcclusion(uniforms, planet, this.material);
    const eclipse = planet.eclipseOccluder;
    uniforms.uEclipseEnabled.value = eclipse ? 1 : 0;
    if (eclipse) {
      uniforms.uEclipseCenter.value.copy(eclipse.centerLocal);
      uniforms.uEclipseRadius.value = eclipse.radius;
      uniforms.uEclipseStarAngle.value = eclipse.starAngularRadius;
    }
  }

  prepareTransport(renderer, profiler = null) {
    if (!this.activePlanet || !this.activeCache) return;
    const uniforms = this.material.uniforms;
    if (!this.contextRenderer) {
      this.contextRenderer = renderer;
      this.onContextLost = () => {
        this.quad.dispose();
        for (const entry of this.profileCache.values()) {
          // Remove the old context's dispose listeners before Three resets
          // its property registry; the CPU optical columns remain reusable.
          entry.texture.dispose();
          entry.multiple?.dispose(); entry.multiple = null;
        }
        uniforms.uMultipleEnabled.value = 0;
        uniforms.tMultipleScattering.value = null;
      };
      renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    }
    if (!this.activeCache.multiple) {
      const bake = () => createMultipleScatteringLut(renderer, uniforms);
      this.activeCache.multiple = profiler ? profiler.run('air-transport', bake) : bake();
    }
    uniforms.tMultipleScattering.value = this.activeCache.multiple.texture;
    uniforms.uMultipleEnabled.value = 1;
  }

  render(renderer, writeBuffer, readBuffer) {
    this.prepareTransport(renderer);
    const uniforms = this.material.uniforms;
    // Copy opaque logarithmic depth along with colour. The following volume
    // composite writes back into the original target: retaining its original
    // depth for sampling there would create a WebGL framebuffer feedback loop.
    const inputDepth = readBuffer.depthTexture || null;
    uniforms.tBase.value = readBuffer.texture;
    uniforms.tSceneDepth.value = inputDepth;
    uniforms.uCameraFar.value = this.camera.far;
    this.camera.updateMatrixWorld(true);
    uniforms.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    uniforms.uCameraWorld.value.copy(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
    this.sceneDepthTexture = !this.renderToScreen && writeBuffer.depthTexture
      ? writeBuffer.depthTexture : inputDepth;
  }

  dispose() {
    this.contextRenderer?.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    if (this.activePlanet?.atmoMesh) this.activePlanet.atmoMesh.visible = true;
    for (const cached of this.profileCache.values()) {
      cached.texture.dispose(); cached.multiple?.dispose();
    }
    this.profileCache.clear();
    this.lutTexture = null;
    this.profileState = null;
    if (this.activePlanet) this.activePlanet.atmosphereTransportUniforms = null;
    this.activePlanet = null;
    this.activeCache = null;
    this.contextRenderer = null;
    this.material.uniforms.tOpticalDepth.value = null;
    this.material.uniforms.tMultipleScattering.value = null;
    this.material.uniforms.uMultipleEnabled.value = 0;
    this.material.uniforms.uEnabled.value = 0;
    this.sceneDepthTexture = null;
    this.material.dispose();
    this.quad.dispose();
  }
}
