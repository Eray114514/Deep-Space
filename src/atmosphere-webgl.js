import * as THREE from 'three';
import { resolveAtmosphereModel } from './atmosphere-chemistry.js';
import { atmosphereQuadratureGLSL } from './atmosphere-quadrature.js';

export function makeAtmosphereMaterialWebGL(color, density, groundR, atmoR, profileState = null) {
  const resolved = profileState || resolveAtmosphereModel({
    R: groundR,
    atmoDensity: density,
    type: 'lush',
  });
  const { profile, densityScale } = resolved;
  const effectiveAtmoR = profileState ? profile.topRadiusMeters : Math.min(atmoR, profile.topRadiusMeters);
  const fadeDensity = profileState ? 1 : clamp(Number(density) || 1, 0, 2);

  return new THREE.ShaderMaterial({
    name: 'Atmosphere physical shell',
    uniforms: {
      atmoColor: { value: color instanceof THREE.Color ? color.clone() : new THREE.Color(color || 0x69b4ff) },
      // Multiplicative appear/fade envelope (0..1); physical density lives in uDensityScale.
      density: { value: fadeDensity },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },   // planet-local, set by the system
      uStellarDirections0: { value: new THREE.Vector3(0, 1, 0) },
      uStellarRadiance0: { value: new THREE.Color(1, 1, 1) },
      uStarIrradiance0: { value: 1 },
      uStellarDirections1: { value: new THREE.Vector3(0, 1, 0) },
      uStellarRadiance1: { value: new THREE.Color(1, 1, 1) },
      uStarIrradiance1: { value: 0 },
      uEclipseEnabled: { value: 0 },
      uEclipseCenter: { value: new THREE.Vector3() },
      uEclipseRadius: { value: 1 },
      uEclipseStarAngle: { value: 0 },
      uCameraLocal: { value: new THREE.Vector3() },
      uGroundR: { value: profile.groundRadiusMeters },
      uAtmoR: { value: effectiveAtmoR },
      uTopR: { value: profile.topRadiusMeters },
      uTopAltitude: { value: profile.topAltitudeMeters },
      uRayleighScaleHeight: { value: profile.rayleighScaleHeightMeters },
      uMieScaleHeight: { value: profile.mieScaleHeightMeters },
      uOzoneCenter: { value: profile.ozoneCenterMeters },
      uOzoneHalfWidth: { value: profile.ozoneHalfWidthMeters },
      uBetaRayleigh: { value: new THREE.Vector3().fromArray(profile.rayleigh) },
      uBetaMieScatter: { value: new THREE.Vector3().fromArray(profile.mie.scattering) },
      uBetaMieExtinction: { value: new THREE.Vector3().fromArray(profile.mie.extinction) },
      uBetaOzone: { value: new THREE.Vector3().fromArray(profile.ozoneAbsorption) },
      uMieAsymmetry: { value: profile.mie.asymmetry ?? 0.8 },
      uDensityScale: { value: densityScale },
      uRadianceScale: { value: 3.2 },
      tSceneDepth: { value: null },
      uDepthReady: { value: 0 },
      uCameraFar: { value: 1.2e11 },
      uVolumeSize: { value: new THREE.Vector2(1, 1) },
      uCamProx: { value: 1 },
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
      const float PI = 3.141592653589793;
      const float HALF_PI = 1.5707963267948966;

      uniform vec3 atmoColor;
      uniform float density, uGroundR, uAtmoR, uTopR, uTopAltitude, uCamProx;
      uniform float uRayleighScaleHeight, uMieScaleHeight;
      uniform float uOzoneCenter, uOzoneHalfWidth;
      uniform vec3 uBetaRayleigh, uBetaMieScatter, uBetaMieExtinction, uBetaOzone;
      uniform float uMieAsymmetry, uDensityScale, uRadianceScale;
      uniform sampler2D tSceneDepth;
      uniform float uDepthReady, uCameraFar;
      uniform vec2 uVolumeSize;
      uniform vec3 sunDir, uCameraLocal;
      uniform vec3 uStellarDirections0, uStellarRadiance0;
      uniform vec3 uStellarDirections1, uStellarRadiance1;
      uniform float uStarIrradiance0, uStarIrradiance1;
      uniform float uEclipseEnabled, uEclipseRadius, uEclipseStarAngle;
      uniform vec3 uEclipseCenter;
      varying vec3 vDirection;
      varying vec3 vViewDirection;

      ${atmosphereQuadratureGLSL}

      vec2 sphereHits(vec3 origin, float r, vec3 dir) {
        float b = dot(origin, dir);
        float disc = b * b - dot(origin, origin) + r * r;
        if (disc < 0.0) return vec2(-1.0);
        float s = sqrt(disc);
        return vec2(-b - s, -b + s);
      }

      float ozoneDensity(float altitude) {
        return max(0.0, 1.0 - abs(altitude - uOzoneCenter) / max(uOzoneHalfWidth, 1.0));
      }

      float chapmanPositive(float x, float mu) {
        float c = sqrt(HALF_PI * max(x, 1.0));
        return c / (c * max(mu, 0.0) + 1.0);
      }

      // C1-continuous analytical spherical column depth for an exponential layer.
      float exponentialSunColumn(float r, float h, float mu, float H) {
        float safeH = max(H, 1.0);
        if (mu >= 0.0) {
          return safeH * exp(-h / safeH) * chapmanPositive(r / safeH, mu);
        }
        float sinTheta = sqrt(max(0.0, 1.0 - mu * mu));
        float rTangent = max(r * sinTheta, uGroundR);
        float hTangent = max(0.0, rTangent - uGroundR);
        float tangentAirmass = 2.0 * sqrt(HALF_PI * rTangent / safeH);
        float backPart = exp(-max(0.0, h - hTangent) / safeH) * chapmanPositive(r / safeH, -mu);
        return safeH * exp(-hTangent / safeH) * max(0.0, tangentAirmass - backPart);
      }

      float eclipseVisibility(vec3 samplePosition, vec3 lightDirection) {
        if (uEclipseEnabled < 0.5) return 1.0;
        vec3 toOccluder = uEclipseCenter - samplePosition;
        float distanceToOccluder = length(toOccluder);
        if (distanceToOccluder <= uEclipseRadius) return 0.0;
        float angularRadius = asin(clamp(
          uEclipseRadius / distanceToOccluder, 0.0, 0.9999));
        float separation = acos(clamp(dot(normalize(toOccluder),
          normalize(lightDirection)), -1.0, 1.0));
        float penumbra = max(uEclipseStarAngle, 0.00002);
        return smoothstep(max(angularRadius - penumbra, 0.0),
          angularRadius + penumbra, separation);
      }

      vec3 mediumIntegral(vec3 extinction, float distance) {
        vec3 tau = extinction * distance;
        vec3 small = vec3(distance) * (vec3(1.0) - tau * 0.5 + tau * tau / 6.0);
        vec3 exact = (vec3(1.0) - exp(-tau)) / max(extinction, vec3(1e-30));
        return mix(exact, small, lessThan(abs(tau), vec3(0.001)));
      }

      vec3 stellarScatter(vec3 position, vec3 viewDirection, vec3 radial,
        float radius, float altitude, float rhoR, float rhoM,
        float effDensity, vec3 lightDirection, vec3 lightColor, float energy) {
        if (energy <= 0.00001) return vec3(0.0);
        vec3 lightDir = normalize(lightDirection);
        float sunMu = dot(radial, lightDir);
        float clampedR = max(radius, uGroundR);
        float ratio = uGroundR / clampedR;
        float horizonMu = -sqrt(max(0.0, 1.0 - ratio * ratio));
        float visibility = smoothstep(horizonMu - 0.018, horizonMu + 0.022, sunMu);

        vec3 direct = vec3(0.0);
        if (visibility > 0.0) {
          float eclipse = eclipseVisibility(position, lightDir);
          if (eclipse > 0.0) {
            float colR = exponentialSunColumn(clampedR, altitude, sunMu, uRayleighScaleHeight) * effDensity;
            float colM = exponentialSunColumn(clampedR, altitude, sunMu, uMieScaleHeight) * effDensity;
            float ozoneWeight = ozoneDensity(altitude);
            float colO = uOzoneHalfWidth * chapmanPositive(clampedR / max(uRayleighScaleHeight, 1.0), max(sunMu, 0.02))
              * mix(0.45, 1.0, ozoneWeight) * effDensity;
            vec3 sunTau = uBetaRayleigh * colR + uBetaMieExtinction * colM + uBetaOzone * colO;
            vec3 sunTrans = exp(-min(sunTau, vec3(45.0)));

            float mu = dot(viewDirection, lightDir);
            float rayleighPhase = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
            float g = clamp(uMieAsymmetry, -0.95, 0.95);
            float g2 = g * g;
            float miePhase = (1.0 - g2) / (4.0 * PI * pow(max(0.025, 1.0 + g2 - 2.0 * g * mu), 1.5));
            vec3 scatter = uBetaRayleigh * rhoR * rayleighPhase + uBetaMieScatter * rhoM * miePhase;
            direct = scatter * sunTrans * (visibility * eclipse);
          }
        }

        // Physical isotropic multi-scatter approximation matches the hue and
        // smooth terminator wrap of AtmospherePass's multiple-scattering LUT.
        float wrap = smoothstep(horizonMu - 0.22, horizonMu + 0.35, sunMu);
        float colRef = exponentialSunColumn(clampedR, altitude, max(sunMu, 0.04), uRayleighScaleHeight) * effDensity;
        vec3 msTint = exp(-min((uBetaRayleigh * 0.42 + uBetaOzone * 0.35) * colRef, vec3(8.0)));
        vec3 indirect = (uBetaRayleigh * rhoR + uBetaMieScatter * rhoM)
          * (0.045 * wrap * msTint);

        return (direct + indirect) * lightColor * (energy * uRadianceScale);
      }

      float sceneRayLimit() {
        if (uDepthReady < 0.5) return 1e20;
        vec2 uv = gl_FragCoord.xy / max(uVolumeSize, vec2(1.0));
        float depth = texture2D(tSceneDepth, clamp(uv, 0.0, 1.0)).x;
        if (depth >= 0.999999) return 1e20;
        float forwardDistance = pow(uCameraFar + 1.0, depth) - 1.0;
        float forwardCos = max(-normalize(vViewDirection).z, 0.035);
        return forwardDistance / forwardCos;
      }

      void main() {
        float effDensity = uDensityScale * density;
        if (effDensity <= 0.0001) discard;
        vec3 dir = normalize(vDirection);
        float outerR = max(uTopR, uGroundR + 100.0);
        vec2 outer = sphereHits(uCameraLocal, outerR, dir);
        if (outer.y <= 0.0) discard;
        vec2 ground = sphereHits(uCameraLocal, uGroundR, dir);
        float t0 = max(outer.x, 0.0);
        float t1 = outer.y;
        if (ground.x > t0) t1 = min(t1, ground.x);
        t1 = min(t1, sceneRayLimit() + 1.5);
        if (t1 <= t0) discard;

        const int STEPS = 28;
        float closest = -dot(uCameraLocal, dir);
        float previous = t0;
        float invSteps = 1.0 / float(STEPS);
        vec3 L = vec3(0.0);
        vec3 T = vec3(1.0);
        for (int i = 0; i < STEPS; i++) {
          float next = atmosphereSampleBoundary(t0, t1, closest, float(i + 1) * invSteps);
          float ds = next - previous;
          vec3 p = uCameraLocal + dir * ((previous + next) * 0.5);
          float r = length(p);
          float altitude = clamp(r - uGroundR, 0.0, uTopAltitude);
          float rhoR = exp(-altitude / max(uRayleighScaleHeight, 1.0)) * effDensity;
          float rhoM = exp(-altitude / max(uMieScaleHeight, 1.0)) * effDensity;
          vec3 extinction = uBetaRayleigh * rhoR
            + uBetaMieExtinction * rhoM
            + uBetaOzone * ozoneDensity(altitude) * effDensity;
          vec3 radial = p / max(r, 1.0);
          vec3 source = stellarScatter(p, dir, radial, r, altitude, rhoR, rhoM, effDensity,
            uStellarDirections0, uStellarRadiance0, uStarIrradiance0);
          source += stellarScatter(p, dir, radial, r, altitude, rhoR, rhoM, effDensity,
            uStellarDirections1, uStellarRadiance1, uStarIrradiance1);
          L += T * source * mediumIntegral(extinction, ds);
          T *= exp(-extinction * ds);
          previous = next;
        }
        float meanT = dot(T, vec3(0.2126, 0.7152, 0.0722));
        float alpha = clamp(1.0 - meanT, 0.0, 0.99);
        float peak = max(L.r, max(L.g, L.b));
        if (alpha < 0.0005 && peak < 0.0005) discard;
        gl_FragColor = vec4(L, alpha);
      }`,
    side: THREE.FrontSide,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
  });
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
