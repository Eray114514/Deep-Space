import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';
import { createAtmosphereProfile } from './atmosphere-physics.js';

const LUT_WIDTH = 256;
const LUT_HEIGHT = 96;
const LUT_STEPS = 48;
const VIEW_STEPS = 20;

const _cameraOffset = new THREE.Vector3();
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
  const densityScale = clamp(
    Number(planet?.atmoDensity) || Math.pow(pressure, 0.22), 0.04, 2.4);
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
    const altitude = profile.topAltitudeMeters * y / Math.max(1, height - 1);
    const radius = profile.groundRadiusMeters + altitude;
    for (let x = 0; x < width; x++) {
      const mu = -1 + 2 * x / Math.max(1, width - 1);
      const offset = (y * width + x) * 4;
      if (pathHitsGround(radius, mu, profile.groundRadiusMeters)) {
        data[offset + 3] = 0;
        continue;
      }
      const distance = raySphereDistance(radius, mu, profile.topRadiusMeters);
      if (!Number.isFinite(distance)) {
        data[offset + 3] = 1;
        continue;
      }
      const stepLength = distance / steps;
      let rayleigh = 0;
      let mie = 0;
      let ozone = 0;
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) * stepLength;
        const sampleRadius = Math.sqrt(radius * radius + t * t + 2 * radius * t * mu);
        const sampleAltitude = Math.max(0, sampleRadius - profile.groundRadiusMeters);
        rayleigh += Math.exp(-sampleAltitude / profile.rayleighScaleHeightMeters) * stepLength;
        mie += Math.exp(-sampleAltitude / profile.mieScaleHeightMeters) * stepLength;
        ozone += ozoneDensity(profile, sampleAltitude) * stepLength;
      }
      data[offset] = rayleigh / profile.rayleighScaleHeightMeters;
      data[offset + 1] = mie / profile.mieScaleHeightMeters;
      data[offset + 2] = ozone / profile.ozoneHalfWidthMeters;
      data[offset + 3] = 1;
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

function scatterTint(planet) {
  const color = planet?.atmoColor?.clone?.() || new THREE.Color(0x69b4ff);
  const maximum = Math.max(color.r, color.g, color.b, 1e-5);
  color.multiplyScalar(1 / maximum);
  const authoredWeight = planet?.type === 'toxic' || planet?.type === 'exotic'
    ? 0.62 : planet?.type === 'desert' || planet?.type === 'lava' ? 0.46 : 0.22;
  return new THREE.Color(1, 1, 1).lerp(color, authoredWeight);
}

function groundAlbedo(planet) {
  const palette = planet?.palU;
  if (!palette) return new THREE.Color(0.18, 0.2, 0.16);
  const average = (colors, count) => {
    const result = new THREE.Color();
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
    this.profileCache = new WeakMap();
    this.lutTextures = new Set();
    this.visualEnabled = true;
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      name: 'Physical atmosphere composite',
      depthTest: false,
      depthWrite: true,
      blending: THREE.NoBlending,
      uniforms: {
        tBase: { value: null },
        tSceneDepth: { value: null },
        tOpticalDepth: { value: null },
        uEnabled: { value: 0 },
        uCameraFar: { value: camera.far },
        uCameraLocal: { value: new THREE.Vector3() },
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uWorldToLocal: { value: new THREE.Matrix4() },
        uGroundR: { value: 1 },
        uTopR: { value: 2 },
        uTopAltitude: { value: 1 },
        uRayleighScaleHeight: { value: 8000 },
        uMieScaleHeight: { value: 1200 },
        uOzoneCenter: { value: 25000 },
        uOzoneHalfWidth: { value: 15000 },
        uBetaRayleigh: { value: new THREE.Vector3() },
        uBetaMieScatter: { value: new THREE.Vector3() },
        uBetaMieExtinction: { value: new THREE.Vector3() },
        uBetaOzone: { value: new THREE.Vector3() },
        uDensityScale: { value: 1 },
        uScatterTint: { value: new THREE.Color(1, 1, 1) },
        uGroundAlbedo: { value: new THREE.Color(0.18, 0.2, 0.16) },
        uSunDirection0: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor0: { value: new THREE.Color(1, 1, 1) },
        uSunEnergy0: { value: 1 },
        uSunDirection1: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor1: { value: new THREE.Color(1, 1, 1) },
        uSunEnergy1: { value: 0 },
        uEclipseEnabled: { value: 0 },
        uEclipseCenter: { value: new THREE.Vector3() },
        uEclipseRadius: { value: 1 },
        uEclipseStarAngle: { value: 0 },
        uRadianceScale: { value: 14 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        #define VIEW_STEPS ${VIEW_STEPS}
        uniform sampler2D tBase, tSceneDepth, tOpticalDepth;
        uniform float uEnabled, uCameraFar;
        uniform vec3 uCameraLocal;
        uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal;
        uniform float uGroundR, uTopR, uTopAltitude;
        uniform float uRayleighScaleHeight, uMieScaleHeight;
        uniform float uOzoneCenter, uOzoneHalfWidth;
        uniform vec3 uBetaRayleigh, uBetaMieScatter, uBetaMieExtinction, uBetaOzone;
        uniform float uDensityScale;
        uniform vec3 uScatterTint, uGroundAlbedo;
        uniform vec3 uSunDirection0, uSunColor0;
        uniform float uSunEnergy0;
        uniform vec3 uSunDirection1, uSunColor1;
        uniform float uSunEnergy1;
        uniform float uEclipseEnabled, uEclipseRadius, uEclipseStarAngle;
        uniform vec3 uEclipseCenter;
        uniform float uRadianceScale;
        varying vec2 vUv;

        const float PI = 3.141592653589793;

        vec2 sphereHits(vec3 origin, float radius, vec3 direction) {
          float b = dot(origin, direction);
          float discriminant = b * b - dot(origin, origin) + radius * radius;
          if (discriminant < 0.0) return vec2(-1.0);
          float root = sqrt(discriminant);
          return vec2(-b - root, -b + root);
        }

        float ozoneDensity(float altitude) {
          return max(0.0, 1.0 - abs(altitude - uOzoneCenter) / uOzoneHalfWidth);
        }

        vec4 sunlightOpticalDepth(float altitude, float radialCosine) {
          vec2 uv = vec2(radialCosine * 0.5 + 0.5, altitude / uTopAltitude);
          // The portable LUT uses nearest texture filtering. Reconstruct the
          // four neighboring texels explicitly so solar-horizon visibility
          // changes continuously instead of exposing angular bands at the
          // limb. Fixed dimensions match the generated optical-depth LUT.
          vec2 size = vec2(256.0, 96.0);
          vec2 p = clamp(uv, vec2(0.0), vec2(1.0)) * size - 0.5;
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 p00 = (clamp(i, vec2(0.0), size - 1.0) + 0.5) / size;
          vec2 p10 = (clamp(i + vec2(1.0, 0.0), vec2(0.0), size - 1.0) + 0.5) / size;
          vec2 p01 = (clamp(i + vec2(0.0, 1.0), vec2(0.0), size - 1.0) + 0.5) / size;
          vec2 p11 = (clamp(i + vec2(1.0), vec2(0.0), size - 1.0) + 0.5) / size;
          vec4 a = mix(texture2D(tOpticalDepth, p00),
            texture2D(tOpticalDepth, p10), f.x);
          vec4 b = mix(texture2D(tOpticalDepth, p01),
            texture2D(tOpticalDepth, p11), f.x);
          return mix(a, b, f.y);
        }

        float eclipseVisibility(vec3 samplePosition, vec3 sunDirection) {
          if (uEclipseEnabled < 0.5) return 1.0;
          vec3 toOccluder = uEclipseCenter - samplePosition;
          float distanceToOccluder = length(toOccluder);
          if (distanceToOccluder <= uEclipseRadius) return 0.0;
          float angularRadius = asin(clamp(uEclipseRadius / distanceToOccluder, 0.0, 0.9999));
          float separation = acos(clamp(dot(normalize(toOccluder), sunDirection), -1.0, 1.0));
          float penumbra = max(uEclipseStarAngle, 0.00002);
          return smoothstep(max(angularRadius - penumbra, 0.0),
            angularRadius + penumbra, separation);
        }

        vec3 starScatter(vec3 position, vec3 viewDirection, vec3 viewDepth,
          float rayleighDensity, float mieDensity, vec3 sunDirection,
          vec3 sunColor, float sunEnergy) {
          if (sunEnergy <= 0.00001) return vec3(0.0);
          float radius = length(position);
          float altitude = clamp(radius - uGroundR, 0.0, uTopAltitude);
          vec3 radial = position / max(radius, 1.0);
          float sunMu = dot(radial, sunDirection);
          vec2 groundHit = sphereHits(position, uGroundR, sunDirection);
          if (groundHit.x > 0.001) return vec3(0.0);
          vec4 lightDepth = sunlightOpticalDepth(altitude, sunMu);
          if (lightDepth.a < 0.5) return vec3(0.0);
          vec3 sunDepth = vec3(
            lightDepth.r * uRayleighScaleHeight,
            lightDepth.g * uMieScaleHeight,
            lightDepth.b * uOzoneHalfWidth
          ) * uDensityScale;
          vec3 opticalDepth = uBetaRayleigh * (viewDepth.x + sunDepth.x)
            + uBetaMieExtinction * (viewDepth.y + sunDepth.y)
            + uBetaOzone * (viewDepth.z + sunDepth.z);
          vec3 transmission = exp(-min(opticalDepth, vec3(50.0)));
          float mu = dot(viewDirection, sunDirection);
          float rayleighPhase = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
          float g = 0.8;
          float miePhase = (1.0 - g * g) / (4.0 * PI
            * pow(max(0.025, 1.0 + g * g - 2.0 * g * mu), 1.5));
          vec3 coefficient = uBetaRayleigh * rayleighDensity * rayleighPhase
            + uBetaMieScatter * mieDensity * miePhase;
          return coefficient * transmission * sunColor * sunEnergy
            * eclipseVisibility(position, sunDirection);
        }

        void main() {
          vec4 base = texture2D(tBase, vUv);
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
          float hitsSurface = ground.x > t0 && ground.x < outer.y ? 1.0 : 0.0;
          if (ground.x > t0) t1 = min(t1, ground.x);
          if (sceneDepth < 0.999999) {
            float forwardDistance = pow(uCameraFar + 1.0, sceneDepth) - 1.0;
            float forwardCosine = max(-directionView.z, 0.0005);
            t1 = min(t1, forwardDistance / forwardCosine + 2.0);
          }
          if (t1 <= t0) {
            gl_FragColor = base;
            return;
          }

          float stepLength = (t1 - t0) / float(VIEW_STEPS);
          float observerAltitude = max(length(uCameraLocal) - uGroundR, 0.0);
          float spaceView = smoothstep(12000.0, 180000.0, observerAltitude);
          vec3 viewDepth = vec3(0.0);
          vec3 radiance = vec3(0.0);
          for (int i = 0; i < VIEW_STEPS; i++) {
            float t = t0 + (float(i) + 0.5) * stepLength;
            vec3 position = uCameraLocal + direction * t;
            float altitude = clamp(length(position) - uGroundR, 0.0, uTopAltitude);
            float rayleighDensity = exp(-altitude / uRayleighScaleHeight) * uDensityScale;
            float mieDensity = exp(-altitude / uMieScaleHeight) * uDensityScale;
            float ozone = ozoneDensity(altitude) * uDensityScale;
            vec3 segmentDepth = vec3(rayleighDensity, mieDensity, ozone) * stepLength;
            vec3 midpointDepth = viewDepth + segmentDepth * 0.5;
            vec3 source = starScatter(position, direction, midpointDepth,
              rayleighDensity, mieDensity, normalize(uSunDirection0),
              uSunColor0, uSunEnergy0);
            source += starScatter(position, direction, midpointDepth,
              rayleighDensity, mieDensity, normalize(uSunDirection1),
              uSunColor1, uSunEnergy1);
            vec3 radial = position / max(length(position), 1.0);
            float groundLight0 = max(dot(radial, normalize(uSunDirection0)), 0.0)
              * uSunEnergy0;
            float groundLight1 = max(dot(radial, normalize(uSunDirection1)), 0.0)
              * uSunEnergy1;
            vec3 indirectTint = uScatterTint * 0.72
              + uGroundAlbedo * (groundLight0 + groundLight1) * 0.28;
            // Multiple scattering illuminates a surface sky from every
            // direction, but it must not draw an equally bright ring around
            // the night side when viewed from space. Retain only a small,
            // sun-facing residual for an exterior observer.
            float indirectDay = clamp(groundLight0 + groundLight1, 0.0, 1.0);
            float indirectVisibility = mix(1.0,
              0.04 + 0.18 * smoothstep(0.0, 0.45, indirectDay), spaceView);
            source += uBetaRayleigh * rayleighDensity * 0.006
              * (uSunEnergy0 + uSunEnergy1) * indirectTint * indirectVisibility;
            radiance += source * stepLength;
            viewDepth += segmentDepth;
          }
          vec3 extinction = uBetaRayleigh * viewDepth.x
            + uBetaMieExtinction * viewDepth.y + uBetaOzone * viewDepth.z;
          vec3 transmittance = exp(-min(extinction, vec3(50.0)));

          // A real atmosphere has no visible geometric outer surface. For a
          // space observer, shape the already integrated signal by tangent
          // altitude and local illumination so its energy dissolves into
          // space instead of revealing uTopR as a uniform blue/purple ring.
          float closestT = max(-dot(uCameraLocal, direction), 0.0);
          vec3 closestPosition = uCameraLocal + direction * closestT;
          float tangentAltitude = max(length(closestPosition) - uGroundR, 0.0);
          float altitudeFade = exp(-tangentAltitude
            / max(uRayleighScaleHeight * 1.65, 1.0));
          altitudeFade *= 1.0 - smoothstep(0.62, 0.98,
            tangentAltitude / max(uTopAltitude, 1.0));
          vec3 closestRadial = normalize(closestPosition);
          float exteriorDay0 = smoothstep(-0.04, 0.20,
            dot(closestRadial, normalize(uSunDirection0))) * uSunEnergy0;
          float exteriorDay1 = smoothstep(-0.04, 0.20,
            dot(closestRadial, normalize(uSunDirection1))) * uSunEnergy1;
          float exteriorLight = clamp(exteriorDay0 + exteriorDay1, 0.0, 1.0);
          // At full phase the tangent circle is perpendicular to the star and
          // a uniform exterior signal reads as a shield. Suppress it for a
          // sunward observer; at quadrature the lit radial half instead forms
          // a directional arc, which is the useful atmospheric cue.
          float observerSun = dot(normalize(uCameraLocal),
            normalize(uSunDirection0));
          float exteriorPhase = 1.0 - smoothstep(0.28, 0.88, observerSun);

          float surfaceCosine = 1.0;
          if (hitsSurface > 0.5) {
            vec3 surfacePosition = uCameraLocal + direction * max(ground.x, 0.0);
            surfaceCosine = clamp(dot(normalize(surfacePosition), -direction), 0.0, 1.0);
          }
          float surfaceLimb = pow(1.0 - surfaceCosine, 2.2);
          // In a sun-behind-camera/full-phase shot the atmosphere is read
          // mostly through haze inside the geographical limb. Exterior glow
          // is intentionally weak; otherwise even a physically thin column
          // resolves as a graphic outline at game-camera scale.
          float discWeight = 0.008 + surfaceLimb * 0.42;
          float exteriorWeight = altitudeFade * mix(0.002, 3.20, exteriorLight)
            * exteriorPhase;
          float spaceScatterWeight = mix(exteriorWeight, discWeight, hitsSurface);

          // The opaque planet already owns its surface colour and lighting.
          // Only a grazing fraction of atmospheric extinction belongs on the
          // disc in orbit; applying the full sky-column attenuation there was
          // the grey film seen across land, ocean and clouds.
          float discExtinctionWeight = 0.018 + surfaceLimb * 0.12;
          float spaceExtinctionWeight = mix(1.0, discExtinctionWeight, hitsSurface);
          vec3 compositeTransmittance = mix(transmittance,
            mix(vec3(1.0), transmittance, spaceExtinctionWeight), spaceView);
          float radianceExposure = uRadianceScale * mix(1.0, 0.45, spaceView);
          float radianceWeight = mix(1.0, spaceScatterWeight, spaceView);
          radiance *= uScatterTint * radianceExposure * radianceWeight;
          gl_FragColor = vec4(radiance + base.rgb * compositeTransmittance, base.a);
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
    this.activePlanet = planet?.atmoMesh ? planet : null;
    this.material.uniforms.uEnabled.value
      = this.activePlanet && this.visualEnabled ? 1 : 0;
    if (!this.activePlanet) return;
    this.activePlanet.atmoMesh.visible = false;
    let cached = this.profileCache.get(this.activePlanet);
    if (!cached) {
      const profileState = atmosphereRenderProfile(this.activePlanet);
      cached = { profileState, texture: makeLutTexture(profileState.profile) };
      this.profileCache.set(this.activePlanet, cached);
      this.lutTextures.add(cached.texture);
    }
    this.profileState = cached.profileState;
    this.lutTexture = cached.texture;
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
    uniforms.uScatterTint.value.copy(scatterTint(this.activePlanet));
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
    _cameraOffset.copy(nav || planet.posUniv).sub(planet.posUniv);
    planet.worldOffsetToLocal?.(_cameraOffset, _localCamera);
    uniforms.uCameraLocal.value.copy(_localCamera);
    _rotation.makeRotationFromQuaternion(planet._invFrame);
    uniforms.uWorldToLocal.value.copy(_rotation);
    const sources = planet.stellarLightField?.sources || [];
    const primary = sources[0] || null;
    const secondary = sources[1] || null;
    uniforms.uSunDirection0.value.copy(primary?.localDirection || planet.sunDirLocal);
    uniforms.uSunColor0.value.copy(primary?.colorValue || new THREE.Color(1, 1, 1));
    uniforms.uSunEnergy0.value = primary?.irradianceFraction ?? 1;
    uniforms.uSunDirection1.value.copy(secondary?.localDirection || planet.sunDirLocal);
    uniforms.uSunColor1.value.copy(secondary?.colorValue || new THREE.Color(1, 1, 1));
    uniforms.uSunEnergy1.value = secondary?.irradianceFraction ?? 0;
    const eclipse = planet.eclipseOccluder;
    uniforms.uEclipseEnabled.value = eclipse ? 1 : 0;
    if (eclipse) {
      uniforms.uEclipseCenter.value.copy(eclipse.centerLocal);
      uniforms.uEclipseRadius.value = eclipse.radius;
      uniforms.uEclipseStarAngle.value = eclipse.starAngularRadius;
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    const uniforms = this.material.uniforms;
    // Composer ping-pongs colour between passes, but a fullscreen atmosphere
    // composite does not carry the RenderPass depth attachment into its output
    // target. Preserve the actual opaque-scene depth explicitly for the cloud
    // pass that follows; sampling readBuffer.depthTexture there would sample
    // the atmosphere target and let clouds leak over terrain and vegetation.
    this.sceneDepthTexture = readBuffer.depthTexture || null;
    uniforms.tBase.value = readBuffer.texture;
    uniforms.tSceneDepth.value = this.sceneDepthTexture;
    uniforms.uCameraFar.value = this.camera.far;
    this.camera.updateMatrixWorld(true);
    uniforms.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    uniforms.uCameraWorld.value.copy(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose() {
    if (this.activePlanet?.atmoMesh) this.activePlanet.atmoMesh.visible = true;
    for (const texture of this.lutTextures) texture.dispose();
    this.lutTextures.clear();
    this.material.dispose();
    this.quad.dispose();
  }
}
