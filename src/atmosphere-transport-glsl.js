import { stellarOcclusionGLSL } from './stellar-occlusion.js';
// Shared physical single-scattering transport. No observer-dependent colour/opacity weights.
import { ATMOSPHERE_VIEW_STEPS, atmosphereQuadratureGLSL } from './atmosphere-quadrature.js';
const VIEW_STEPS = ATMOSPHERE_VIEW_STEPS;
export const atmosphereUniformGLSL = `        uniform sampler2D tOpticalDepth, tMultipleScattering;
        uniform float uMultipleEnabled;
        uniform float uEnabled, uCameraFar, uViewSteps;
        uniform vec3 uCameraLocal;
        uniform mat4 uInvProjection, uCameraWorld, uWorldToLocal;
        uniform float uGroundR, uTopR, uTopAltitude;
        uniform float uRayleighScaleHeight, uMieScaleHeight;
        uniform float uOzoneCenter, uOzoneHalfWidth;
        uniform vec3 uBetaRayleigh, uBetaMieScatter, uBetaMieExtinction, uBetaOzone;
        uniform float uDensityScale;
        uniform vec3 uGroundAlbedo;
        uniform vec3 uSunDirection0, uSunColor0;
        uniform float uSunEnergy0;
        uniform vec3 uSunDirection1, uSunColor1;
        uniform float uSunEnergy1;
        uniform float uEclipseEnabled, uEclipseRadius, uEclipseStarAngle;
        uniform vec3 uEclipseCenter;
        uniform float uRadianceScale;
`;
export const atmosphereTransportGLSL = `
        ${stellarOcclusionGLSL}
        const float PI = 3.141592653589793;
        ${atmosphereQuadratureGLSL}

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
          // Quadratic altitude and signed-quadratic cosine grids resolve
          // the aerosol layer and solar horizon without enlarging the LUT.
          vec2 uv = vec2(sign(radialCosine) * sqrt(abs(radialCosine)) * 0.5 + 0.5,
            sqrt(max(altitude / uTopAltitude, 0.0)));
          vec2 size = vec2(256.0, 96.0);
          vec2 sampleUv = (clamp(uv, vec2(0.0), vec2(1.0)) * (size - 1.0) + 0.5) / size;
          return texture2D(tOpticalDepth, sampleUv);
        }

        vec3 multipleRadiance(float altitude, float mu) {
          if (uMultipleEnabled < 0.5) return vec3(0.0);
          vec2 uv = vec2(mu*0.5+0.5, sqrt(clamp(altitude/uTopAltitude,0.0,1.0)));
          return texture2D(tMultipleScattering, (uv*31.0+0.5)/32.0).rgb;
        }

        float eclipseVisibility(vec3 samplePosition, vec3 sunDirection) {
          if (uLocalOccluderCount > 0) return localStellarVisibility(samplePosition,sunDirection);
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

        float solarHorizonClearance(vec3 position, vec3 sunDirection) {
          float radius = max(length(position), uGroundR);
          float horizonMu = -sqrt(max(0.0, 1.0 - (uGroundR / radius) * (uGroundR / radius)));
          return dot(position / radius, sunDirection) - horizonMu;
        }

        vec3 starScatterWithPhase(vec3 position, vec3 viewDirection, float segmentLength,
          float radius, float altitude, vec3 radial,
          float rayleighDensity, float mieDensity, vec3 sunDirection,
          float rayleighPhase, float miePhase, vec3 sunRadiance) {
          float sunMu = dot(radial, sunDirection);
          float clampedR = max(radius, uGroundR);
          float ratio = uGroundR / clampedR;
          float horizonMu = -sqrt(max(0.0, 1.0 - ratio * ratio));
          float clearance = sunMu - horizonMu;
          float band = (segmentLength / clampedR) * 2.0 + 0.025;
          float visibility;
          if (clearance >= band) {
            visibility = 1.0;
          } else if (clearance <= -band) {
            visibility = 0.0;
          } else {
            vec3 halfSegment = viewDirection * (segmentLength * 0.5);
            float edge0 = solarHorizonClearance(position - halfSegment, sunDirection);
            float edge1 = solarHorizonClearance(position + halfSegment, sunDirection);
            visibility = clamp(0.5 + clearance / max(abs(edge1 - edge0), 1e-6), 0.0, 1.0);
          }

          vec3 direct = vec3(0.0);
          if (visibility > 0.0) {
            float eclipse = (uLocalOccluderCount > 0 || uEclipseEnabled >= 0.5)
              ? eclipseVisibility(position, sunDirection) : 1.0;
            if (eclipse > 0.0) {
              vec4 lightDepth = sunlightOpticalDepth(altitude, sunMu);
              vec3 sunDepth = vec3(
                lightDepth.r * uRayleighScaleHeight,
                lightDepth.g * uMieScaleHeight,
                lightDepth.b * uOzoneHalfWidth
              ) * uDensityScale;
              vec3 opticalDepth = uBetaRayleigh * sunDepth.x
                + uBetaMieExtinction * sunDepth.y
                + uBetaOzone * sunDepth.z;
              vec3 transmission = exp(-min(opticalDepth, vec3(50.0)));
              vec3 coefficient = uBetaRayleigh * rayleighDensity * rayleighPhase
                + uBetaMieScatter * mieDensity * miePhase;
              direct = coefficient * transmission * (visibility * eclipse);
            }
          }
          vec3 indirect = uMultipleEnabled >= 0.5
            ? (uBetaRayleigh * rayleighDensity + uBetaMieScatter * mieDensity)
              * multipleRadiance(altitude, sunMu)
            : vec3(0.0);
          return (direct + indirect) * sunRadiance;
        }

        vec3 starScatter(vec3 position, vec3 viewDirection, float segmentLength,
          float rayleighDensity, float mieDensity, vec3 sunDirection,
          vec3 sunColor, float sunEnergy) {
          if (sunEnergy <= 0.00001) return vec3(0.0);
          float radius = length(position);
          float altitude = clamp(radius - uGroundR, 0.0, uTopAltitude);
          vec3 radial = position / max(radius, 1.0);
          float mu = dot(viewDirection, sunDirection);
          float rayleighPhase = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
          float g = 0.8;
          float miePhase = (1.0 - g * g) / (4.0 * PI
            * pow(max(0.025, 1.0 + g * g - 2.0 * g * mu), 1.5));
          return starScatterWithPhase(position, viewDirection, segmentLength,
            radius, altitude, radial, rayleighDensity, mieDensity,
            sunDirection, rayleighPhase, miePhase, sunColor * sunEnergy);
        }


        // Homogeneous-cell exact transfer, including the zero-extinction limit.
        // Radiance is unexposed; extinction is inverse metres.
        vec3 mediumIntegral(vec3 extinction, float distance) {
          vec3 tau = extinction * distance;
          vec3 small = vec3(distance) * (vec3(1.0) - tau * 0.5 + tau * tau / 6.0);
          vec3 exact = (vec3(1.0) - exp(-tau)) / max(extinction, vec3(1e-30));
          return mix(exact, small, lessThan(abs(tau), vec3(0.001)));
        }
        void mediumStep(inout vec3 L, inout vec3 T, vec3 extinction, vec3 source, float distance) {
          L += T * source * mediumIntegral(extinction, distance);
          T *= exp(-extinction * distance);
        }
        bool gAirPhasesReady = false;
        bool gAirHasSun0 = false, gAirHasSun1 = false;
        vec3 gAirSunDir0 = vec3(0.0, 1.0, 0.0), gAirSunDir1 = vec3(0.0, 1.0, 0.0);
        float gAirRayleighPhase0 = 0.0, gAirMiePhase0 = 0.0;
        float gAirRayleighPhase1 = 0.0, gAirMiePhase1 = 0.0;
        vec3 gAirSunRad0 = vec3(0.0), gAirSunRad1 = vec3(0.0);

        void airSample(vec3 position, vec3 direction, float distance, out vec3 extinction, out vec3 source) {
          extinction = vec3(0.0); source = vec3(0.0);
          float radius = length(position);
          float altitude = radius - uGroundR;
          if (uEnabled < 0.5 || altitude < 0.0 || altitude > uTopAltitude) return;
          float rayleighDensity = exp(-altitude / uRayleighScaleHeight) * uDensityScale;
          float mieDensity = exp(-altitude / uMieScaleHeight) * uDensityScale;
          extinction = uBetaRayleigh * rayleighDensity + uBetaMieExtinction * mieDensity
            + uBetaOzone * ozoneDensity(altitude) * uDensityScale;
          if (gAirPhasesReady) {
            vec3 radial = position / max(radius, 1.0);
            if (gAirHasSun0) {
              source += starScatterWithPhase(position, direction, distance, radius, altitude, radial,
                rayleighDensity, mieDensity, gAirSunDir0, gAirRayleighPhase0, gAirMiePhase0, gAirSunRad0);
            }
            if (gAirHasSun1) {
              source += starScatterWithPhase(position, direction, distance, radius, altitude, radial,
                rayleighDensity, mieDensity, gAirSunDir1, gAirRayleighPhase1, gAirMiePhase1, gAirSunRad1);
            }
            return;
          }
          source = starScatter(position, direction, distance, rayleighDensity, mieDensity,
            normalize(uSunDirection0), uSunColor0, uSunEnergy0);
          source += starScatter(position, direction, distance, rayleighDensity, mieDensity,
            normalize(uSunDirection1), uSunColor1, uSunEnergy1);
          source *= uRadianceScale;
        }
        void airIntegrateSteps(vec3 origin, vec3 direction, float t0, float t1, int steps, out vec3 L, out vec3 T) {
          L = vec3(0.0); T = vec3(1.0);
          if (uEnabled < 0.5 || t1 <= t0 || steps <= 0) return;
          gAirHasSun0 = uSunEnergy0 > 0.00001;
          gAirHasSun1 = uSunEnergy1 > 0.00001;
          gAirSunDir0 = gAirHasSun0 ? normalize(uSunDirection0) : vec3(0.0, 1.0, 0.0);
          gAirSunDir1 = gAirHasSun1 ? normalize(uSunDirection1) : vec3(0.0, 1.0, 0.0);
          float g = 0.8, g2 = g * g;
          float mu0 = dot(direction, gAirSunDir0);
          gAirRayleighPhase0 = 3.0 / (16.0 * PI) * (1.0 + mu0 * mu0);
          gAirMiePhase0 = (1.0 - g2) / (4.0 * PI * pow(max(0.025, 1.0 + g2 - 2.0 * g * mu0), 1.5));
          gAirSunRad0 = uSunColor0 * (uSunEnergy0 * uRadianceScale);
          float mu1 = dot(direction, gAirSunDir1);
          gAirRayleighPhase1 = 3.0 / (16.0 * PI) * (1.0 + mu1 * mu1);
          gAirMiePhase1 = (1.0 - g2) / (4.0 * PI * pow(max(0.025, 1.0 + g2 - 2.0 * g * mu1), 1.5));
          gAirSunRad1 = uSunColor1 * (uSunEnergy1 * uRadianceScale);
          gAirPhasesReady = true;

          float closest = -dot(origin, direction), previous = t0;
          float invSteps = 1.0 / float(steps);
          for (int i = 0; i < VIEW_STEPS; i++) {
            if (i >= steps) break;
            float next = atmosphereSampleBoundary(t0, t1, closest, float(i + 1) * invSteps);
            float distance = next - previous;
            vec3 position = origin + direction * (previous + next) * 0.5;
            vec3 extinction, source;
            airSample(position, direction, distance, extinction, source);
            mediumStep(L, T, extinction, source, distance);
            previous = next;
          }
          gAirPhasesReady = false;
        }
        void airIntegrate(vec3 origin, vec3 direction, float t0, float t1, out vec3 L, out vec3 T) {
          airIntegrateSteps(origin, direction, t0, t1, VIEW_STEPS, L, T);
        }
`;
// Cloud material has its own geometry/light uniforms; bind this namespaced view
// to the active atmosphere pass without owning its LUT or duplicating its model.
export const cloudAtmosphereGLSL = ('#define VIEW_STEPS '+VIEW_STEPS+'\n' + atmosphereUniformGLSL + atmosphereTransportGLSL)
  .replace(/\bu[A-Z]\w*|\bgAir[A-Z]\w*|\btOpticalDepth|\btMultipleScattering|\bPI|\bsphereHits|\bozoneDensity|\beclipseVisibility|\bsolarHorizonClearance|\bsunlightOpticalDepth|\bstarScatterWithPhase|\bstarScatter|\bairIntegrateSteps|\blocalStellarVisibility|\bstellarDiscVisibility|\bmultipleRadiance/g, (name) => 'air_' + name)
  // Keep the same 48-cell quadrature but avoid expanding it inside every
  // cloud view/light loop in ANGLE's D3D compiler.
  .replace('for (int i = 0; i < VIEW_STEPS; i++)', 'for (int i = 0; i < int(air_uViewSteps); i++)')
  .replace('if (i >= steps) break;', 'if (i >= steps) break;');
