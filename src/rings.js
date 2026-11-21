import * as THREE from 'three';
import { makeRng, strHash32 } from './rng.js';

const _yAxis = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _right = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _localCam = new THREE.Vector3();
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpEuler = new THREE.Euler();
const _tmpScale = new THREE.Vector3();
const _tmpMatrix = new THREE.Matrix4();

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

// Deterministic ring parameters resolved from astronomy.js `ringSystem` (or a
// reproducible fallback for standalone body fixtures without an astronomy spec).
export function resolveRingSpec(body) {
  const R = Math.max(1, Number(body?.R || body?.radius) || 1e6);
  const sys = body?.ringSystem || null;
  const seedStr = `${body?.seed || 'ring'}:ring-profile:v2`;
  const rand = makeRng(seedStr);
  const seedHash = (strHash32(seedStr) % 10000) / 10000;

  let present = false;
  if (sys && typeof sys.present === 'boolean') {
    present = !body?.isMoon && sys.present;
  } else if (!body?.isMoon) {
    const giant = body?.type === 'gasGiant' || body?.type === 'iceGiant';
    present = rand() < (giant ? 0.58 : 0.24);
  }
  if (!present) {
    return {
      present: false,
      innerR: 0,
      outerR: 0,
      innerRadiusRatio: 0,
      outerRadiusRatio: 0,
      opticalDepth: 0,
      iceFraction: 0.5,
      gaps: [0.42, 0.74],
      seed: seedHash,
      source: 'none',
    };
  }

  const giant = body?.type === 'gasGiant' || body?.type === 'iceGiant';
  const innerRatio = (sys?.innerRadiusRatio > 1.05)
    ? sys.innerRadiusRatio
    : (giant ? 1.34 + rand() * 0.22 : 1.48 + rand() * 0.28);
  const outerRatio = (sys?.outerRadiusRatio > innerRatio + 0.15)
    ? sys.outerRadiusRatio
    : (innerRatio + (giant ? 0.82 + rand() * 0.92 : 0.56 + rand() * 0.62));
  const opticalDepth = (sys?.opticalDepth > 0)
    ? clamp(sys.opticalDepth, 0.2, 0.98)
    : clamp(0.36 + rand() * 0.52, 0.24, 0.94);
  const iceFraction = Number.isFinite(sys?.iceFraction)
    ? clamp(sys.iceFraction, 0.05, 0.98)
    : (body?.type === 'iceGiant' || body?.type === 'ice'
      ? clamp(0.68 + rand() * 0.28, 0.05, 0.98)
      : body?.type === 'gasGiant'
        ? clamp(0.45 + rand() * 0.42, 0.05, 0.98)
        : clamp(0.18 + rand() * 0.56, 0.05, 0.98));

  const rawGaps = Array.isArray(sys?.gaps) && sys.gaps.length >= 2
    ? [clamp(sys.gaps[0], 0.24, 0.58), clamp(sys.gaps[1], 0.60, 0.89)]
    : [0.36 + rand() * 0.14, 0.66 + rand() * 0.18];
  rawGaps.sort((a, b) => a - b);

  return {
    present: true,
    innerR: R * innerRatio,
    outerR: R * outerRatio,
    innerRadiusRatio: innerRatio,
    outerRadiusRatio: outerRatio,
    opticalDepth,
    iceFraction,
    gaps: rawGaps,
    seed: seedHash,
    source: sys?.source || 'tidal-disruption',
  };
}

// CPU mirror of the GLSL radial density & tint profile so sysview.js, tests,
// and close-approach 3D ice debris match the live shader band-for-band.
export function sampleRingProfileCPU(u, spec) {
  if (!spec?.present || u <= 0 || u >= 1) {
    return { density: 0, alpha: 0, color: [0, 0, 0] };
  }
  const seed = spec.seed ?? 0.37;
  const g1 = spec.gaps?.[0] ?? 0.44;
  const g2 = spec.gaps?.[1] ?? 0.76;
  const opt = clamp(spec.opticalDepth ?? 0.65, 0.18, 1.0);
  const ice = clamp(spec.iceFraction ?? 0.55, 0.05, 0.98);

  // Macro envelope: translucent inner crepe (C) -> lush bright core (B) ->
  // sleek outer sheet (A) -> delicate braided outer F-ring filament.
  const innerEdge = smoothstep(0.0, 0.045, u);
  const mainOuterEdge = 1.0 - smoothstep(0.905, 0.942, u);
  const crepe = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.19, 0.24, u)) * 0.28;
  const bRing = smoothstep(0.17, 0.24, u) * (1.0 - smoothstep(g1 - 0.028, g1 - 0.004, u)) * 0.96;
  const aRing = smoothstep(g1 + 0.018, g1 + 0.048, u) * mainOuterEdge * 0.72;
  const fRing = Math.exp(-Math.pow((u - 0.968) / 0.0075, 2.0)) * 0.58;

  // Multi-scale resonant ringlets & harmonic density waves
  const s1 = seed * 62.8318;
  const r1 = 0.5 + 0.5 * Math.sin(u * 34.0 + s1);
  const r2 = 0.5 + 0.5 * Math.sin(u * 89.0 - s1 * 1.73 + r1 * 1.4);
  const r3 = 0.5 + 0.5 * Math.sin(u * 211.0 + s1 * 3.11);
  const r4 = 0.5 + 0.5 * Math.sin(u * 467.0 - s1 * 2.07);
  const ringlets = 0.66 + 0.22 * r1 + 0.16 * r2 + 0.11 * r3 + 0.06 * r4;

  // Primary Cassini-like division + thin internal Huygens shepherd ringlet
  const cassiniGap = 1.0 - 0.95 * Math.exp(-Math.pow((u - g1) / 0.028, 2.0));
  const huygensThread = Math.exp(-Math.pow((u - (g1 - 0.009)) / 0.0032, 2.0)) * 0.42;

  // Secondary Encke-like narrow division + crisp outer Keeler-like hairline
  const enckeGap = 1.0 - 0.94 * Math.exp(-Math.pow((u - g2) / 0.0105, 2.0));
  const keelerGap = 1.0 - 0.82 * Math.exp(-Math.pow((u - 0.885) / 0.0042, 2.0));

  let density = (crepe + bRing + aRing) * ringlets * cassiniGap * enckeGap * keelerGap;
  density = Math.max(density, huygensThread) + fRing;
  density *= innerEdge;

  const tau = clamp(density * (0.48 + opt * 0.92), 0.0, 1.35);
  const alpha = clamp(1.0 - Math.exp(-tau * 1.38), 0.0, 0.97);

  // Composition color gradient: silicate dust -> Saturnian ochre-cream -> icy sapphire-pearl
  const rockA = [0.46, 0.36, 0.28];
  const rockB = [0.68, 0.53, 0.39];
  const midA = [0.75, 0.66, 0.54];
  const midB = [0.88, 0.82, 0.72];
  const iceA = [0.74, 0.83, 0.93];
  const iceB = [0.92, 0.95, 0.99];

  const bandMix = clamp(r1 * 0.45 + r2 * 0.35 + (u > g1 ? 0.15 : 0.0) - (u < 0.21 ? 0.22 : 0.0), 0, 1);
  const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const loCol = ice < 0.5
    ? mix3(rockA, midA, ice * 2.0)
    : mix3(midA, iceA, (ice - 0.5) * 2.0);
  const hiCol = ice < 0.5
    ? mix3(rockB, midB, ice * 2.0)
    : mix3(midB, iceB, (ice - 0.5) * 2.0);
  const col = mix3(loCol, hiCol, bandMix);
  // Crepe inner ring is darker & dustier
  const crepeDark = 1.0 - 0.34 * (1.0 - smoothstep(0.16, 0.25, u));
  return {
    density: tau,
    alpha,
    color: [col[0] * crepeDark, col[1] * crepeDark, col[2] * crepeDark],
  };
}

// Shared GLSL radial optical depth + ring shadow ray-plane test.
// Used by ring rendering, planet terrain/ocean (surface-atmosphere.js),
// gas giant bands (gas-giant-webgl.js), and clouds (clouds-webgl.js / lite-cloud-pass.js).
export const RING_PROFILE_GLSL = /* glsl */`
float ringOpticalDensityAt(float u, float seed, vec2 gaps, float opticalDepth) {
  if (u <= 0.001 || u >= 0.999) return 0.0;
  float innerEdge = smoothstep(0.0, 0.045, u);
  float mainOuterEdge = 1.0 - smoothstep(0.905, 0.942, u);
  float crepe = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.19, 0.24, u)) * 0.28;
  float bRing = smoothstep(0.17, 0.24, u) * (1.0 - smoothstep(gaps.x - 0.028, gaps.x - 0.004, u)) * 0.96;
  float aRing = smoothstep(gaps.x + 0.018, gaps.x + 0.048, u) * mainOuterEdge * 0.72;
  float df = (u - 0.968) / 0.0075;
  float fRing = exp(-df * df) * 0.58;

  float s1 = seed * 62.8318;
  float r1 = 0.5 + 0.5 * sin(u * 34.0 + s1);
  float r2 = 0.5 + 0.5 * sin(u * 89.0 - s1 * 1.73 + r1 * 1.4);
  float r3 = 0.5 + 0.5 * sin(u * 211.0 + s1 * 3.11);
  float r4 = 0.5 + 0.5 * sin(u * 467.0 - s1 * 2.07);
  float ringlets = 0.66 + 0.22 * r1 + 0.16 * r2 + 0.11 * r3 + 0.06 * r4;

  float d1 = (u - gaps.x) / 0.028;
  float cassiniGap = 1.0 - 0.95 * exp(-d1 * d1);
  float dh = (u - (gaps.x - 0.009)) / 0.0032;
  float huygensThread = exp(-dh * dh) * 0.42;

  float d2 = (u - gaps.y) / 0.0105;
  float enckeGap = 1.0 - 0.94 * exp(-d2 * d2);
  float dk = (u - 0.885) / 0.0042;
  float keelerGap = 1.0 - 0.82 * exp(-dk * dk);

  float density = (crepe + bRing + aRing) * ringlets * cassiniGap * enckeGap * keelerGap;
  density = max(density, huygensThread) + fRing;
  density *= innerEdge;
  return clamp(density * (0.48 + opticalDepth * 0.92), 0.0, 1.35);
}
`;

export const RING_SHADOW_GLSL = /* glsl */`
uniform float uRingShadowEnabled;
uniform vec3 uRingNormal;
uniform vec4 uRingParams; // x: innerR, y: outerR, z: opticalDepth, w: seed
uniform vec3 uRingGaps;   // x: gap1, y: gap2, z: iceFraction

// Single-tap penumbra-smoothed ring optical depth for planet/ocean/cloud/gas-giant
// shadow receivers (avoids 3x FXC AST inlining across every surface shader).
float ringShadowTransmission(vec3 localPos, vec3 lightDir) {
  if (uRingShadowEnabled < 0.5) return 1.0;
  float denom = dot(lightDir, uRingNormal);
  if (abs(denom) < 1e-4) return 1.0;
  float t = -dot(localPos, uRingNormal) / denom;
  if (t <= 0.0) return 1.0;
  vec3 hit = localPos + lightDir * t;
  float r = length(hit);
  float span = max(uRingParams.y - uRingParams.x, 1.0);
  float u = (r - uRingParams.x) / span;
  if (u < -0.025 || u > 1.025) return 1.0;
  float penU = clamp(t * 0.0045 / span, 0.004, 0.022);
  float innerEdge = smoothstep(-penU, 0.045 + penU, u);
  float mainOuterEdge = 1.0 - smoothstep(0.905 - penU, 0.942 + penU, u);
  float crepe = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.19, 0.24, u)) * 0.28;
  float bRing = smoothstep(0.17, 0.24, u) * (1.0 - smoothstep(uRingGaps.x - 0.028 - penU, uRingGaps.x, u)) * 0.96;
  float aRing = smoothstep(uRingGaps.x + 0.012, uRingGaps.x + 0.048 + penU, u) * mainOuterEdge * 0.72;
  float df = (u - 0.968) / (0.0075 + penU * 0.7);
  float fRing = exp(-df * df) * 0.52;
  float s1 = uRingParams.w * 62.8318;
  float r1 = 0.5 + 0.5 * sin(u * 34.0 + s1);
  float r2 = 0.5 + 0.5 * sin(u * 89.0 - s1 * 1.73 + r1 * 1.4);
  float ringlets = 0.74 + 0.22 * r1 + 0.14 * r2 * (1.0 - smoothstep(0.006, 0.022, penU));
  float d1 = (u - uRingGaps.x) / (0.028 + penU * 0.85);
  float cassiniGap = 1.0 - 0.93 * exp(-d1 * d1);
  float d2 = (u - uRingGaps.y) / (0.011 + penU * 0.85);
  float enckeGap = 1.0 - 0.88 * exp(-d2 * d2);
  float density = ((crepe + bRing + aRing) * ringlets * cassiniGap * enckeGap + fRing) * innerEdge;
  float tau = clamp(density * (0.48 + uRingParams.z * 0.92), 0.0, 1.35);
  float softEdge = smoothstep(-0.02, 0.01, u) * (1.0 - smoothstep(0.99, 1.02, u));
  float slant = clamp(1.0 / max(abs(denom), 0.28), 1.0, 2.2);
  float trans = clamp(exp(-tau * 1.18 * slant), 0.14, 1.0);
  return mix(1.0, trans, softEdge);
}
`;

export function ringShadowUniforms() {
  return {
    uRingShadowEnabled: { value: 0 },
    uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
    uRingParams: { value: new THREE.Vector4(1, 2, 0, 0) },
    uRingGaps: { value: new THREE.Vector3(0.44, 0.76, 0.55) },
  };
}

export function bindRingShadow(uniforms, body) {
  if (!uniforms?.uRingShadowEnabled) return;
  const spec = body?.ringSpec;
  if (!spec?.present || !body?.ringMesh) {
    uniforms.uRingShadowEnabled.value = 0;
    return;
  }
  uniforms.uRingShadowEnabled.value = 1;
  if (body.ringNormalLocal) {
    uniforms.uRingNormal.value.copy(body.ringNormalLocal);
  } else {
    uniforms.uRingNormal.value.set(0, 1, 0);
  }
  uniforms.uRingParams.value.set(spec.innerR, spec.outerR, spec.opticalDepth, spec.seed);
  uniforms.uRingGaps.value.set(spec.gaps[0], spec.gaps[1], spec.iceFraction);
}

// Compute exact orthonormal planet-local basis matching `axisQuat * rotX(+PI/2)`:
// mesh-local +X -> axisQuat * (1, 0, 0), mesh-local +Y -> axisQuat * (0, 0, 1),
// ring plane normal -> axisQuat * (0, 1, 0).
function ringBasisFromQuat(axisQuat) {
  if (axisQuat) {
    _normal.copy(_yAxis).applyQuaternion(axisQuat).normalize();
    _right.copy(_xAxis).applyQuaternion(axisQuat).normalize();
    _forward.copy(_zAxis).applyQuaternion(axisQuat).normalize();
  } else {
    _normal.set(0, 1, 0);
    _right.set(1, 0, 0);
    _forward.set(0, 0, 1);
  }
  return {
    normal: _normal.clone(),
    right: _right.clone(),
    forward: _forward.clone(),
  };
}

export function createRingMaterial(spec, {
  planetRadius = 1e6,
  planetTint = null,
  atmoColor = null,
  hasAtmosphere = true,
  axisQuat = null,
} = {}) {
  const basis = ringBasisFromQuat(axisQuat);
  const tint = planetTint ? planetTint.clone() : new THREE.Color(0.82, 0.78, 0.72);
  const rimCol = atmoColor
    ? atmoColor.clone().lerp(new THREE.Color(1.0, 0.42, 0.14), 0.65)
    : new THREE.Color(1.0, 0.45, 0.16);
  const uniforms = {
    uInnerR: { value: spec.innerR },
    uOuterR: { value: spec.outerR },
    uPlanetR: { value: planetRadius },
    uOpticalDepth: { value: spec.opticalDepth },
    uIceFraction: { value: spec.iceFraction },
    uSeed: { value: spec.seed },
    uGaps: { value: new THREE.Vector2(spec.gaps[0], spec.gaps[1]) },
    uPlanetTint: { value: tint },
    uAtmoRimColor: { value: rimCol },
    uAtmoRimStrength: { value: hasAtmosphere ? 0.55 : 0.0 },
    uOpacity: { value: 1.0 },
    uTime: { value: 0.0 },
    uCameraLocal: { value: new THREE.Vector3(0, planetRadius * 3, planetRadius * 3) },
    uRingNormal: { value: basis.normal },
    uRingRight: { value: basis.right },
    uRingForward: { value: basis.forward },
    uStarDir0: { value: new THREE.Vector3(0.7, 0.4, 0.58).normalize() },
    uStarColor0: { value: new THREE.Color(1, 0.97, 0.92) },
    uStarEnergy0: { value: 1.0 },
    uStarDir1: { value: new THREE.Vector3(0, 1, 0) },
    uStarColor1: { value: new THREE.Color(1, 1, 1) },
    uStarEnergy1: { value: 0.0 },
    uStarAngularRadius: { value: 0.0095 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec3 uRingRight;
      uniform vec3 uRingForward;
      varying vec3 vPlanetPos;
      varying vec2 vRingXY;
      void main() {
        // RingGeometry lives in XY plane; map deterministically into planet-local 3D coordinates.
        vRingXY = position.xy;
        vPlanetPos = uRingRight * position.x + uRingForward * position.y;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uInnerR;
      uniform float uOuterR;
      uniform float uPlanetR;
      uniform float uOpticalDepth;
      uniform float uIceFraction;
      uniform float uSeed;
      uniform vec2 uGaps;
      uniform vec3 uPlanetTint;
      uniform vec3 uAtmoRimColor;
      uniform float uAtmoRimStrength;
      uniform float uOpacity;
      uniform float uTime;
      uniform vec3 uCameraLocal;
      uniform vec3 uRingNormal;
      uniform vec3 uStarDir0;
      uniform vec3 uStarColor0;
      uniform float uStarEnergy0;
      uniform vec3 uStarDir1;
      uniform vec3 uStarColor1;
      uniform float uStarEnergy1;
      uniform float uStarAngularRadius;
      varying vec3 vPlanetPos;
      varying vec2 vRingXY;

      ${RING_PROFILE_GLSL}

      float ringHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float ringNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(ringHash(i), ringHash(i + vec2(1.0, 0.0)), f.x),
          mix(ringHash(i + vec2(0.0, 1.0)), ringHash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      float ringHG(float cosTheta, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(0.04, 1.0 + g2 - 2.0 * g * cosTheta), 1.5));
      }

      // Soft-penumbra planet shadow cast onto the ring plane, plus subtle
      // atmospheric sunset-refraction rim along the shadow boundary.
      void planetShadowOnRing(vec3 p, vec3 lightDir, out float vis, out float limbGlow) {
        float tProj = -dot(p, lightDir);
        if (tProj <= 0.0) {
          vis = 1.0;
          limbGlow = 0.0;
          return;
        }
        vec3 closest = p + lightDir * tProj;
        float dPerp = length(closest);
        float pen = max(uPlanetR * 0.016, tProj * uStarAngularRadius);
        vis = smoothstep(uPlanetR - pen * 0.55, uPlanetR + pen * 1.25, dPerp);
        float rimBand = (dPerp - uPlanetR * 1.004) / max(pen * 1.4, uPlanetR * 0.025);
        limbGlow = exp(-rimBand * rimBand * 2.4) * uAtmoRimStrength;
      }

      vec3 shadeRingStar(vec3 p, vec3 viewDir, vec3 N, vec3 albedo, float tau,
        float nearGlint, vec3 lightDir, vec3 starColor, float starEnergy) {
        if (starEnergy <= 0.0005) return vec3(0.0);
        float shadowVis;
        float limbGlow;
        planetShadowOnRing(p, lightDir, shadowVis, limbGlow);

        float ndl = dot(N, lightDir);
        float ndv = dot(N, viewDir);
        bool sameSide = (ndl * ndv) >= 0.0;
        float cosL = max(abs(ndl), 0.08);
        float cosV = max(abs(ndv), 0.08);
        // cosTheta = +1 when camera looks toward the star through the ring (forward scatter)
        float cosTheta = dot(-viewDir, lightDir);

        // Henyey-Greenstein forward scattering (g=+0.58) & Seeliger opposition backscatter (g=-0.38)
        float forwardPhase = ringHG(cosTheta, 0.58) * 1.95;
        float backPhase = ringHG(cosTheta, -0.38) * 1.45;
        float oppositionSurge = pow(max(0.0, -cosTheta), 18.0) * (0.28 + 0.35 * uIceFraction);

        // Optical slab scattering:
        // - Sunlit face reflects proportionally to (1 - exp(-tau * (1/cosL + 1/cosV)))
        // - Transmitted/unlit face glows via single-scatter slab transmittance tau * exp(-tau / cosL)
        float litReflect = (1.0 - exp(-tau * min(4.5, 0.9 / cosL + 0.6 / cosV)))
          * (0.58 + 0.42 * clamp(abs(ndl) * 2.2, 0.0, 1.0));
        float backlitTransmit = clamp(tau * 1.25, 0.0, 1.6)
          * exp(-tau * min(2.4, 0.48 / max(cosL, 0.24)));

        float scatterMix = sameSide
          ? (litReflect * (0.72 + backPhase * 0.46 + oppositionSurge) + backlitTransmit * forwardPhase * 0.42)
          : (backlitTransmit * (0.38 + forwardPhase * 1.25) + litReflect * 0.14);

        vec3 direct = albedo * starColor * starEnergy * scatterMix * shadowVis;
        // Close-approach sparkling ice crystals catching sunlight
        direct += starColor * starEnergy * nearGlint * (0.45 + 0.75 * uIceFraction) * shadowVis;
        // Warm atmospheric refraction tint kissing the edge of the planet's shadow
        direct += albedo * uAtmoRimColor * starEnergy * limbGlow * (0.4 + 0.6 * tau) * 0.55;
        // Subtle planetary daylight bounce (planetshine) so shadowed ring bands keep faint presence
        vec3 radial = normalize(p);
        float planetDay = max(0.0, dot(radial, lightDir));
        float distFalloff = pow(uPlanetR / max(length(p), uPlanetR), 1.8);
        vec3 planetShine = albedo * mix(vec3(0.42, 0.52, 0.68), uPlanetTint, 0.55)
          * starColor * starEnergy * (0.045 + 0.11 * planetDay) * distFalloff;
        return direct + planetShine;
      }

      void main() {
        float r = length(vRingXY);
        float span = max(uOuterR - uInnerR, 1.0);
        float u = (r - uInnerR) / span;
        if (u <= 0.001 || u >= 0.999) discard;

        float phi = atan(vRingXY.y, vRingXY.x);
        // Subtle spiral resonance wave perturbation (authentic Cassini density wave texture)
        float spiralWave = sin(u * 180.0 + phi * 2.0 + uSeed * 25.0) * 0.0018
          + sin(u * 420.0 - phi * 3.0) * 0.0007;
        float uPerturbed = clamp(u + spiralWave * smoothstep(0.18, 0.32, u), 0.001, 0.999);
        float tau = ringOpticalDensityAt(uPerturbed, uSeed, uGaps, uOpticalDepth);
        if (tau < 0.003) discard;

        // Close-approach micro-structure: crisp fine concentric ringlets + dusty clumps + icy crystal glitter
        float camDist = length(vPlanetPos - uCameraLocal);
        float nearFade = 1.0 - smoothstep(span * 0.03, span * 0.55, camDist);
        float microClump = 1.0;
        float nearGlint = 0.0;
        if (nearFade > 0.002) {
          float arcCoord = phi * (r / max(span * 0.035, 100.0));
          float fineGrooves = 0.5 + 0.5 * sin(u * 920.0 + uSeed * 41.0);
          float finerGrooves = 0.5 + 0.5 * sin(u * 2340.0 - uSeed * 19.0 + fineGrooves * 1.5);
          float clumpA = ringNoise(vec2(u * 680.0, arcCoord * 0.55 + uTime * 0.02));
          float clumpB = ringNoise(vec2(u * 1750.0, arcCoord * 2.1 - uTime * 0.03));
          float sparkle = ringHash(floor(vec2(u * 4200.0, arcCoord * 11.0)));
          float grooveContrast = 0.58 + 0.44 * fineGrooves + 0.24 * finerGrooves;
          microClump = mix(1.0, grooveContrast * (0.68 + 0.58 * (clumpA * 0.6 + clumpB * 0.4)), nearFade * 0.82);
          nearGlint = pow(smoothstep(0.88, 0.992, sparkle), 2.0) * nearFade * clamp(tau * 1.5, 0.0, 1.0);
        }
        float tauDetail = tau * microClump;

        // Composition-driven multi-band ring color with crisp alternating mineral contrast
        float s1 = uSeed * 62.8318;
        float r1 = 0.5 + 0.5 * sin(uPerturbed * 34.0 + s1);
        float r2 = 0.5 + 0.5 * sin(uPerturbed * 89.0 - s1 * 1.73 + r1 * 1.4);
        float r3 = 0.5 + 0.5 * sin(uPerturbed * 235.0 + s1 * 2.7);
        vec3 rockA = vec3(0.42, 0.32, 0.24);
        vec3 rockB = vec3(0.72, 0.55, 0.40);
        vec3 midA = vec3(0.64, 0.55, 0.44);
        vec3 midB = vec3(0.92, 0.86, 0.76);
        vec3 iceA = vec3(0.66, 0.78, 0.91);
        vec3 iceB = vec3(0.95, 0.97, 1.0);
        float ice = uIceFraction;
        vec3 loCol = ice < 0.5
          ? mix(rockA, midA, ice * 2.0)
          : mix(midA, iceA, (ice - 0.5) * 2.0);
        vec3 hiCol = ice < 0.5
          ? mix(rockB, midB, ice * 2.0)
          : mix(midB, iceB, (ice - 0.5) * 2.0);
        float bandMix = clamp(r1 * 0.40 + r2 * 0.32 + r3 * 0.24 + (u > uGaps.x ? 0.14 : 0.0) - (u < 0.21 ? 0.26 : 0.0), 0.0, 1.0);
        vec3 albedo = mix(loCol, hiCol, bandMix);
        albedo = mix(albedo, albedo * normalize(max(uPlanetTint, vec3(0.18))) * 1.32, 0.14);
        float crepeDark = 1.0 - 0.42 * (1.0 - smoothstep(0.16, 0.25, u));
        albedo *= crepeDark;

        vec3 viewDir = normalize(uCameraLocal - vPlanetPos);
        vec3 N = normalize(uRingNormal);
        vec3 color = shadeRingStar(vPlanetPos, viewDir, N, albedo, tauDetail, nearGlint,
          normalize(uStarDir0), uStarColor0, uStarEnergy0);
        color += shadeRingStar(vPlanetPos, viewDir, N, albedo, tauDetail, nearGlint,
          normalize(uStarDir1), uStarColor1, uStarEnergy1);
        // Subtle galactic starlight floor so night-side rings are still gently legible
        color += albedo * vec3(0.016, 0.020, 0.028);

        // View-angle path optical depth: grazing views thicken gently without edge-on aliasing
        float absNdv = abs(dot(N, viewDir));
        float grazingBoost = clamp(1.0 / max(absNdv, 0.18), 1.0, 2.6);
        float alpha = clamp(1.0 - exp(-tauDetail * 1.28 * grazingBoost), 0.0, 0.95);
        // Softly dissolve exact 0-degree edge-on razor line as camera crosses ring plane
        float edgeFade = smoothstep(0.004, 0.026, absNdv);
        // Gentle close-up dissolve so the flat sheet blends into the 3D ice debris field
        float insideFade = smoothstep(140.0, 950.0, camDist);
        alpha *= mix(0.26, 1.0, insideFade) * mix(0.55, 1.0, edgeFade) * uOpacity;
        if (alpha < 0.004) discard;

        gl_FragColor = vec4(color, alpha);
        #include <logdepthbuf_fragment>
      }
    `,
  });
  material.userData.ringSpec = spec;
  material.userData.baseOpacity = 1.0;
  return material;
}

// Camera-local 3D instanced ice/silicate ring debris field that wakes up ONLY
// when flying close to or inside a planetary ring plane. Gives true volumetric
// parallax & asteroid/ice-crystal presence right inside the ring bands (and
// physically empties out inside Cassini / Encke divisions!).
export class RingDebrisField {
  constructor(spec, {
    planetRadius = 1e6,
    axisQuat = null,
    count = 220,
    cellRadius = 720,
    bandThickness = 110,
  } = {}) {
    this.spec = spec;
    this.planetRadius = planetRadius;
    this.basis = ringBasisFromQuat(axisQuat);
    this.count = count;
    this.cellRadius = cellRadius;
    this.bandThickness = bandThickness;
    this.disposed = false;

    const rand = makeRng(`${spec.seed}:ring-debris:v1`);
    // Sculpted irregular asteroid / ice-chunk boulder geometry (smooth low-frequency
    // faceting so rocks read like real tumbling ice/silicate fragments, never spiky stars)
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      const lobe = 0.86
        + 0.11 * Math.sin(vx * 2.4 + vy * 1.9 + 0.5)
        + 0.08 * Math.cos(vy * 2.9 - vz * 2.2)
        + 0.06 * Math.sin(vz * 3.5 + vx * 2.7);
      // Slight natural flattening + subtle chipped rock planes
      const planeCut = Math.max(0.76, 1.0 - Math.max(0, vx * 0.55 + vy * 0.65 - 0.58) * 0.35);
      const rScale = lobe * planeCut;
      pos.setXYZ(i, vx * rScale * 1.12, vy * rScale * 0.78, vz * rScale * 0.96);
    }
    geo.computeVertexNormals();

    const ice = spec.iceFraction ?? 0.55;
    const baseColor = new THREE.Color().setRGB(
      0.55 + ice * 0.36,
      0.50 + ice * 0.40,
      0.44 + ice * 0.49,
    );
    this.material = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: clamp(0.86 - ice * 0.44, 0.28, 0.92),
      metalness: clamp(0.05 + (1 - ice) * 0.12, 0.02, 0.22),
      flatShading: true,
      transparent: true,
      opacity: 0,
      depthWrite: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, count);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;

    this.seeds = Array.from({ length: count }, () => ({
      ox: (rand() - 0.5) * cellRadius * 2,
      oz: (rand() - 0.5) * cellRadius * 2,
      oy: (rand() - 0.5) * bandThickness * 2,
      scale: Math.pow(rand(), 2.2) * 14.5 + 0.85,
      rx: rand() * Math.PI * 2,
      ry: rand() * Math.PI * 2,
      rz: rand() * Math.PI * 2,
      spinX: (rand() - 0.5) * 0.35,
      spinY: (rand() - 0.5) * 0.35,
      stretchY: 0.58 + rand() * 0.62,
      threshold: rand() * 0.85,
    }));
    const instanceColor = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const shade = 0.62 + rand() * 0.52;
      instanceColor.copy(baseColor).multiplyScalar(shade);
      this.mesh.setColorAt(i, instanceColor);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this._elapsed = 0;
  }

  update(camLocal, dt = 0) {
    if (this.disposed || !camLocal || !this.spec?.present) {
      if (this.mesh) this.mesh.visible = false;
      return;
    }
    const { normal, right, forward } = this.basis;
    const planeHeight = camLocal.dot(normal);
    const span = Math.max(this.spec.outerR - this.spec.innerR, 1);
    const maxPlaneDist = Math.min(Math.max(span * 0.08, 4500), 38000);
    if (Math.abs(planeHeight) > maxPlaneDist) {
      this.mesh.visible = false;
      return;
    }
    const px = camLocal.dot(right);
    const pz = camLocal.dot(forward);
    const radialDist = Math.hypot(px, pz);
    const margin = this.cellRadius * 1.5;
    if (radialDist < this.spec.innerR - margin || radialDist > this.spec.outerR + margin) {
      this.mesh.visible = false;
      return;
    }

    const uCam = (radialDist - this.spec.innerR) / span;
    const localProfile = sampleRingProfileCPU(clamp(uCam, 0.001, 0.999), this.spec);
    const proximity = (1 - smoothstep(this.bandThickness * 1.2, maxPlaneDist, Math.abs(planeHeight)))
      * smoothstep(-0.02, 0.02, uCam) * (1 - smoothstep(0.98, 1.02, uCam));
    if (proximity <= 0.01 || localProfile.density <= 0.02) {
      this.mesh.visible = false;
      return;
    }

    this._elapsed += dt;
    this.mesh.visible = true;
    this.material.opacity = clamp(proximity * 1.15, 0, 1);
    const wrap = this.cellRadius * 2;
    const half = this.cellRadius;
    const baseCellX = Math.floor(px / wrap) * wrap;
    const baseCellZ = Math.floor(pz / wrap) * wrap;

    for (let i = 0; i < this.count; i++) {
      const s = this.seeds[i];
      // Toroidal wrap around camera in ring-plane coordinates
      let wx = baseCellX + s.ox;
      if (wx - px > half) wx -= wrap;
      else if (wx - px < -half) wx += wrap;
      let wz = baseCellZ + s.oz;
      if (wz - pz > half) wz -= wrap;
      else if (wz - pz < -half) wz += wrap;

      const r = Math.hypot(wx, wz);
      const u = (r - this.spec.innerR) / span;
      const band = sampleRingProfileCPU(u, this.spec);
      // Physically thin out inside Cassini / Encke divisions!
      const visibleRock = band.density > s.threshold * 0.92;
      const distFade = 1 - smoothstep(half * 0.62, half * 0.98, Math.hypot(wx - px, wz - pz));
      const scale = visibleRock ? s.scale * distFade * clamp(band.density * 1.2, 0.35, 1.15) : 0;

      if (scale <= 0.05) {
        _tmpScale.set(0, 0, 0);
        _tmpPos.set(0, 0, 0);
        _tmpQuat.identity();
      } else {
        _tmpPos.set(0, 0, 0)
          .addScaledVector(right, wx)
          .addScaledVector(forward, wz)
          .addScaledVector(normal, s.oy);
        _tmpEuler.set(
          s.rx + this._elapsed * s.spinX,
          s.ry + this._elapsed * s.spinY,
          s.rz,
        );
        _tmpQuat.setFromEuler(_tmpEuler);
        _tmpScale.set(scale, scale * s.stretchY, scale);
      }
      _tmpMatrix.compose(_tmpPos, _tmpQuat, _tmpScale);
      this.mesh.setMatrixAt(i, _tmpMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh?.geometry?.dispose();
    this.material?.dispose();
  }
}

// High-level factory attaching both the procedural shader ring disc and the
// close-approach 3D ice debris field to any Planet or GasGiant.
export function buildPlanetaryRing(body, {
  axisQuat = null,
  planetTint = null,
  atmoColor = null,
  hasAtmosphere = true,
  segments = 256,
} = {}) {
  const spec = resolveRingSpec(body);
  if (!spec.present) return null;
  const R = Math.max(1, Number(body?.R || body?.radius) || 1e6);
  const geo = new THREE.RingGeometry(spec.innerR, spec.outerR, segments, 8);
  const material = createRingMaterial(spec, {
    planetRadius: R,
    planetTint,
    atmoColor,
    hasAtmosphere,
    axisQuat,
  });
  const mesh = new THREE.Mesh(geo, material);
  if (axisQuat) {
    mesh.quaternion.copy(axisQuat);
    mesh.rotateX(Math.PI / 2);
  } else {
    mesh.rotation.x = Math.PI / 2;
  }
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;

  const basis = ringBasisFromQuat(axisQuat);
  const debris = new RingDebrisField(spec, { planetRadius: R, axisQuat });
  return {
    spec,
    mesh,
    material,
    debris,
    normalLocal: basis.normal,
    setStellarLights(stellarLightField, fallbackSunDirLocal) {
      const u = material.uniforms;
      const sources = stellarLightField?.sources;
      if (sources?.length) {
        const primary = sources[0];
        const secondary = sources[1] || null;
        if (primary.localDirection) u.uStarDir0.value.copy(primary.localDirection);
        if (primary.colorValue) u.uStarColor0.value.copy(primary.colorValue);
        u.uStarEnergy0.value = primary.irradianceFraction ?? 1.0;
        if (secondary) {
          if (secondary.localDirection) u.uStarDir1.value.copy(secondary.localDirection);
          if (secondary.colorValue) u.uStarColor1.value.copy(secondary.colorValue);
          u.uStarEnergy1.value = secondary.irradianceFraction ?? 0.0;
        } else {
          u.uStarEnergy1.value = 0.0;
        }
      } else if (fallbackSunDirLocal) {
        u.uStarDir0.value.copy(fallbackSunDirLocal).normalize();
        u.uStarEnergy0.value = 1.0;
        u.uStarEnergy1.value = 0.0;
      }
    },
    setOpacity(opacity) {
      material.uniforms.uOpacity.value = clamp(opacity, 0, 1);
    },
    update(camLocal, dt = 0) {
      material.uniforms.uTime.value += dt;
      if (camLocal) {
        material.uniforms.uCameraLocal.value.copy(camLocal);
        debris.update(camLocal, dt);
      }
    },
    dispose() {
      geo.dispose();
      material.dispose();
      debris.dispose();
    },
  };
}
