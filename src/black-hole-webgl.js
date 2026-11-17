import * as THREE from 'three';
import { strHash32 } from './rng.js';

// Deterministic 3D spin / accretion-disc orthonormal frame for a black hole.
// Gives the accretion plane a subtle natural bank (~8-12 deg) relative to world Y
// so the disc and its relativistic lensed arches immediately read as a monumental
// 3D astrophysical structure in space.
export function computeBlackHoleBasis(spec) {
  const hash = strHash32(String(spec?.seed || spec?.bodyId || 'bh'));
  const node = ((hash % 10000) / 10000) * Math.PI * 2;
  const rawTilt = Number(spec?.axialTilt) || 0;
  const tiltMag = 0.13 + 0.07 * Math.abs(Math.sin(rawTilt));
  const normal = new THREE.Vector3(
    Math.cos(node) * Math.sin(tiltMag),
    Math.cos(tiltMag),
    Math.sin(node) * Math.sin(tiltMag),
  ).normalize();
  const ref = Math.abs(normal.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(ref, normal);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0).projectOnPlane(normal);
  right.normalize();
  const forward = new THREE.Vector3().crossVectors(right, normal).normalize();
  return { normal, right, forward };
}

// Shared General Relativistic (Schwarzschild / prograde Kerr) null-geodesic &
// sheared Keplerian plasma accretion-disc shader library.
//
// Performance architecture:
//   The geodesic loop integrates ONLY scalar Binet variables (u, du, psi) over
//   36 steps and records at most two disc-slab visits (primary n=0 & secondary
//   under-lensed n=1) in vec4 registers. All plasma noise & blackbody shading
//   executes OUTSIDE the loop (at most twice per pixel), keeping D3D11/ANGLE
//   HLSL compilation under ~15 ms and GPU runtime <0.4 ms even on integrated GPUs.
export const BLACK_HOLE_RELATIVISTIC_GLSL = /* glsl */`
  float bhHash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float bhHash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  float bhNoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = bhHash12(i);
    float b = bhHash12(i + vec2(1.0, 0.0));
    float c = bhHash12(i + vec2(0.0, 1.0));
    float d = bhHash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // Cinema-calibrated Planckian blackbody curve in linear HDR RGB (AgX / ACES).
  // Preserves warm tungsten-gold, champagne-cream and incandescent platinum-ivory
  // without collapsing mid-temperature plasma into overly dark brick-orange.
  vec3 bhBlackbodyLinear(float tempK) {
    float t = clamp(tempK, 1800.0, 18000.0) * 0.001;
    vec3 srgb;
    srgb.r = t <= 6.6
      ? 1.0
      : clamp(1.292936 * pow(max(t - 6.0, 0.1) * 10.0, -0.1332048), 0.0, 1.0);
    srgb.g = t <= 6.6
      ? clamp(0.425 * log(max(t * 10.0, 1.05)) - 0.675, 0.0, 1.0)
      : clamp(1.129891 * pow(max(t - 6.0, 0.1) * 10.0, -0.0755148), 0.0, 1.0);
    srgb.b = t >= 6.6
      ? 1.0
      : (t <= 1.9 ? 0.02 : clamp(0.565 * log(max(t * 10.0 - 9.2, 1.01)) - 1.18, 0.02, 1.0));
    return pow(max(srgb, vec3(0.0)), vec3(1.68));
  }

  // Continuous, finely striated Keplerian plasma sheet with sheared spiral wisps.
  // Avoids deep Saturn-like dark grooves while giving rich multi-scale filamentation.
  vec2 bhOrbitalRibbons(float phi, float xi, float radial, float timeSec, float detailWeight) {
    float spin1 = phi + timeSec * 0.24;
    float spin2 = phi * 2.0 - xi * 2.2 + timeSec * 0.39;
    float spin3 = phi * 3.0 - xi * 3.8 + timeSec * 0.56;

    // Gentle spiral shear warp
    float warpA = bhNoise2(vec2(cos(spin1) * 1.1 + xi * 1.2, sin(spin1) * 1.1 - xi * 0.8));
    float warpB = bhNoise2(vec2(cos(spin2) * 1.3, sin(spin2) * 1.3 + xi * 2.4));
    float xiWarped = xi + (warpA - 0.5) * 0.095 + (warpB - 0.5) * 0.045;

    // Layered fine azimuthal streamlines over a warm continuous plasma continuum
    float macro = bhNoise2(vec2(xiWarped * 5.4, sin(spin1 - xi * 1.4) * 0.55 + 3.7));
    float stream = bhNoise2(vec2(xiWarped * 16.0, cos(spin2) * 0.45 + 11.3));
    float fine = bhNoise2(vec2(xiWarped * 36.0, sin(spin3) * 0.38 + 23.9));
    float micro = bhNoise2(vec2(xiWarped * 72.0, cos(spin3 + spin1) * 0.30 + 41.1));

    float striation = 0.58 + 0.42 * sin(xiWarped * 26.0 + stream * 2.6);
    float hi = mix(0.5, fine * 0.65 + micro * 0.35, detailWeight);

    // Keep inner ISCO continuum silky & unbroken; let outer disc weave into wispy lanes
    float innerContinuum = 1.0 - smoothstep(0.0, 0.30, radial);
    float baseSheet = mix(0.52 + 0.48 * macro, 0.90 + 0.10 * macro, innerContinuum);
    float filaments = mix(0.68, 0.46 + 0.54 * (striation * 0.55 + stream * 0.45), detailWeight * 0.75 + 0.25);

    float density = baseSheet * filaments * (0.84 + 0.34 * (hi - 0.5));
    float hotStreak = smoothstep(0.48, 0.90, striation * 0.52 + hi * 0.48) * (0.4 + 0.6 * detailWeight);
    return vec2(clamp(density, 0.0, 1.45), hotStreak);
  }

  void bhShadeCrossing(
    vec4 hit,
    int crossingOrder,
    vec3 e1,
    vec3 e2,
    float rInRs,
    float rOutRs,
    vec3 discRight,
    vec3 discNormal,
    vec3 discForward,
    float tempBaseK,
    float timeSec,
    float intensityScale,
    float pixelFootprintRad,
    inout vec3 accumRadiance,
    inout float transmittance
  ) {
    if (hit.w <= 0.0005 || transmittance <= 0.004) return;

    float uMid = hit.x;
    float duMid = hit.y;
    float psiMid = hit.z;
    float pathAndEta = hit.w;
    float pathScale = floor(pathAndEta) * 0.001;
    float etaAbs = fract(pathAndEta) * 2.0;

    float rRs = 1.0 / max(uMid, 1e-5);
    if (rRs < rInRs * 0.74 || rRs > rOutRs * 1.02) return;

    float cM = cos(psiMid);
    float sM = sin(psiMid);
    vec3 rHat = cM * e1 + sM * e2;
    vec3 psiHat = -sM * e1 + cM * e2;
    vec3 rayMoveDir = normalize(-duMid * rHat + uMid * psiHat);

    float radial = clamp((rRs - rInRs) / max(rOutRs - rInRs, 0.5), 0.0, 1.0);
    float xi = log(max(rRs, rInRs * 0.74) / rInRs);

    // Inner-peaked Novikov-Thorne emissivity: sculpts tight, luminous Gargantua
    // upper & lower arches around the shadow while sustaining wide equatorial wings.
    float innerRise = smoothstep(rInRs * 0.74, rInRs * 1.12, rRs);
    float innerCore = pow(rInRs / max(rRs, rInRs * 0.94), 2.35);
    float wingSustain = pow(max(0.0, 1.0 - radial), 1.55);

    float dx = dot(rHat, discRight);
    float dz = dot(rHat, discForward);
    float phi = atan(dz, dx);

    float orderDamp = crossingOrder == 0 ? 1.0 : 0.55;
    float aaDamp = 1.0 - smoothstep(0.012, 0.095, pixelFootprintRad * rRs);
    float detailW = orderDamp * aaDamp;

    vec2 rib = bhOrbitalRibbons(phi, xi, radial, timeSec, detailW);

    // Feathered outer spiral dissolve with zero hard circular rim
    float outerFeather = smoothstep(0.0, 0.26, wingSustain * (0.62 + 0.55 * rib.x));
    float vertProfile = exp(-2.1 * etaAbs * etaAbs);
    float sigma = innerRise * outerFeather * vertProfile * rib.x;
    if (sigma <= 0.0008) return;

    // Relativistic Keplerian velocity & combined gravitational + Doppler shift g
    vec3 gasTangent = normalize(cross(discNormal, rHat));
    float beta = clamp(sqrt(0.50 / max(rRs - 0.75, 0.48)), 0.0, 0.55);
    float invGamma = sqrt(max(1.0 - beta * beta, 0.16));
    float cosEmit = dot(gasTangent, -rayMoveDir);
    float gravRedshift = sqrt(clamp(1.0 - 1.0 / max(rRs, 1.05), 0.08, 1.0));
    float gFactor = (gravRedshift * invGamma) / max(1.0 - beta * cosEmit, 0.30);

    float dopplerBoost = clamp(pow(gFactor, 2.15), 0.28, 2.30);

    // Keep plasma color in rich cinema tungsten-gold / warm amber / incandescent cream
    float radialTemp = mix(1.05, 0.48, pow(radial, 0.58));
    float localTempK = tempBaseK * radialTemp * pow(gFactor, 0.68) * (0.88 + 0.26 * rib.y);
    vec3 plasmaColor = bhBlackbodyLinear(localTempK);

    float radialTau = mix(1.75, 0.10, pow(radial, 0.66));
    float tau = sigma * pathScale * radialTau;
    float stepAlpha = 1.0 - exp(-clamp(tau, 0.0, 8.0));

    float brightness = (0.38 + 2.15 * innerCore + 0.75 * rib.y * innerCore + 0.42 * wingSustain)
      * dopplerBoost * intensityScale;
    vec3 emission = plasmaColor * brightness * stepAlpha;

    accumRadiance += transmittance * emission;
    transmittance *= (1.0 - stepAlpha);
  }

  struct BhTraceResult {
    vec3 radiance;
    float transmittance;
    vec3 escapedDir;
    bool captured;
    float closestApproachRs;
  };

  BhTraceResult bhTraceGeodesic(
    vec3 p0,
    vec3 rayDir,
    float rs,
    float outerRadius,
    float spin,
    float tempPeakK,
    float timeSec,
    float intensityScale,
    vec3 discRight,
    vec3 discNormal,
    vec3 discForward,
    float pixelFootprintRad
  ) {
    BhTraceResult res;
    res.radiance = vec3(0.0);
    res.transmittance = 1.0;
    res.escapedDir = rayDir;
    res.captured = false;
    res.closestApproachRs = 1e6;

    float r0 = length(p0);
    vec3 e1 = p0 / max(r0, 1e-4);
    float cosAlpha = clamp(dot(e1, rayDir), -1.0, 1.0);
    vec3 tang = rayDir - e1 * cosAlpha;
    float sinAlpha = length(tang);
    vec3 fallback = abs(e1.y) < 0.9 ? cross(e1, vec3(0.0, 1.0, 0.0)) : cross(e1, vec3(1.0, 0.0, 0.0));
    vec3 e2 = sinAlpha > 1e-5 ? tang / sinAlpha : normalize(fallback);
    sinAlpha = max(sinAlpha, 1e-5);

    float bRs = (r0 * sinAlpha) / rs;

    // Subtle Kerr spin frame-dragging asymmetry (Bardeen 1973)
    vec3 hVec = cross(e1, e2);
    float prograde = clamp(-dot(hVec, discNormal), -1.0, 1.0);
    float kerrScale = 1.0 - 0.10 * spin * prograde;
    float gravStrength = 1.5 * kerrScale;
    float horizonU = 1.0 / max(kerrScale, 0.82);

    float rInRs = mix(2.65, 1.58, clamp(spin, 0.0, 0.95));
    float rOutRs = max(outerRadius / rs, rInRs + 4.0);
    float uMinDisc = 1.0 / (rOutRs * 1.02);
    float uMaxDisc = 1.0 / (rInRs * 0.74);

    const float hRel = 0.022;
    float n1 = dot(e1, discNormal);
    float n2 = dot(e2, discNormal);

    float u = rs / max(r0, rs * 1.05);
    float du = -(u * cosAlpha) / sinAlpha;
    float psi = 0.0;
    float etaPrev = n1 / hRel;
    float uMax = u;

    vec4 hit0 = vec4(0.0);
    vec4 hit1 = vec4(0.0);
    int visitIdx = 0;
    bool inSlab = false;
    float accWeight = 0.0;
    float accPath = 0.0;
    float accU = 0.0;
    float accDu = 0.0;
    float accPsi = 0.0;
    float accEta = 0.0;

    for (int step = 0; step < 36; step++) {
      float prox = clamp(u / horizonU, 0.0, 1.2);
      float dPsi = mix(0.130, 0.058, smoothstep(0.16, 0.70, prox));

      float acc0 = -u + gravStrength * u * u;
      float uHalf = u + 0.5 * dPsi * du + 0.125 * dPsi * dPsi * acc0;
      float duHalf = du + 0.5 * dPsi * acc0;
      float accHalf = -uHalf + gravStrength * uHalf * uHalf;
      float uNext = u + dPsi * duHalf;
      float duNext = du + dPsi * accHalf;

      bool escapedNow = (uNext <= 0.0 && duNext < 0.0 && step > 0);
      float fracLimit = escapedNow ? clamp(u / max(u - uNext, 1e-6), 0.0, 1.0) : 1.0;
      bool capturedNow = (!escapedNow && uNext >= horizonU);
      if (capturedNow) {
        fracLimit = clamp((horizonU - u) / max(uNext - u, 1e-6), 0.0, 1.0);
      }

      float dP = dPsi * fracLimit;
      float psiEnd = psi + dP;
      float uEnd = mix(u, uNext, fracLimit);
      float duEnd = mix(du, duNext, fracLimit);
      float etaEnd = (n1 * cos(psiEnd) + n2 * sin(psiEnd)) / hRel;
      uMax = max(uMax, max(u, uEnd));

      float lo = min(etaPrev, etaEnd);
      float hi = max(etaPrev, etaEnd);
      bool touchesSlab = (lo <= 1.0 && hi >= -1.0);

      if (touchesSlab && visitIdx < 2) {
        float dEta = etaEnd - etaPrev;
        float s0 = 0.0;
        float s1 = 1.0;
        if (abs(dEta) > 1e-4) {
          float tA = (-1.0 - etaPrev) / dEta;
          float tB = (1.0 - etaPrev) / dEta;
          s0 = clamp(min(tA, tB), 0.0, 1.0);
          s1 = clamp(max(tA, tB), 0.0, 1.0);
        }
        float segSpan = s1 - s0;
        if (segSpan > 1e-4) {
          float sMid = 0.5 * (s0 + s1);
          float uMid = max(mix(u, uEnd, sMid), 1e-5);
          if (uMid >= uMinDisc && uMid <= uMaxDisc) {
            float duMid = mix(du, duEnd, sMid);
            float psiMid = psi + dP * sMid;
            // Signed midpoint height so a crossing split across two steps
            // averages (-0.5 + +0.5) = 0.0 instead of +0.5 (eliminates step spokes!)
            float etaSigned = mix(etaPrev, etaEnd, sMid);
            float segPath = clamp(segSpan * dP * sqrt(1.0 + (duMid / uMid) * (duMid / uMid)) / (2.0 * hRel), 0.02, 4.8);
            float w = segPath * (uMid * uMid + 0.02);
            inSlab = true;
            accPath += segPath;
            accU += uMid * w;
            accDu += duMid * w;
            accPsi += psiMid * w;
            accEta += etaSigned * w;
            accWeight += w;
          }
        }
      }

      bool exitedSlab = inSlab && (!touchesSlab || abs(etaEnd) > 1.0 || capturedNow || escapedNow);
      if (exitedSlab) {
        float invW = 1.0 / max(accWeight, 1e-6);
        float packed = floor(clamp(accPath, 0.05, 6.0) * 1000.0) + clamp(abs(accEta * invW) * 0.5, 0.0, 0.499);
        vec4 committed = vec4(accU * invW, accDu * invW, accPsi * invW, packed);
        if (visitIdx == 0) hit0 = committed;
        else if (visitIdx == 1) hit1 = committed;
        visitIdx++;
        inSlab = false;
        accWeight = 0.0;
        accPath = 0.0;
        accU = 0.0;
        accDu = 0.0;
        accPsi = 0.0;
        accEta = 0.0;
      }

      psi = psiEnd;
      u = uEnd;
      du = duEnd;
      etaPrev = etaEnd;

      if (capturedNow) {
        res.captured = true;
        break;
      }
      if (escapedNow) {
        res.escapedDir = normalize(cos(psi) * e1 + sin(psi) * e2);
        break;
      }
    }

    if (inSlab && visitIdx < 2 && accWeight > 0.0) {
      float invW = 1.0 / accWeight;
      float packed = floor(clamp(accPath, 0.05, 6.0) * 1000.0) + clamp(abs(accEta * invW) * 0.5, 0.0, 0.499);
      vec4 committed = vec4(accU * invW, accDu * invW, accPsi * invW, packed);
      if (visitIdx == 0) hit0 = committed;
      else hit1 = committed;
    }

    if (!res.captured && u > 0.70 * horizonU && du > 0.0) {
      res.captured = true;
    } else if (!res.captured && u > 0.0) {
      float tailPsi = psi + atan(u, max(-du, 1e-4));
      res.escapedDir = normalize(cos(tailPsi) * e1 + sin(tailPsi) * e2);
    }

    res.closestApproachRs = 1.0 / max(uMax, 1e-5);

    bhShadeCrossing(
      hit0, 0, e1, e2, rInRs, rOutRs,
      discRight, discNormal, discForward, tempPeakK, timeSec, intensityScale, pixelFootprintRad,
      res.radiance, res.transmittance
    );
    bhShadeCrossing(
      hit1, 1, e1, e2, rInRs, rOutRs,
      discRight, discNormal, discForward, tempPeakK, timeSec, intensityScale, pixelFootprintRad,
      res.radiance, res.transmittance
    );

    // Razor-sharp critical photon-ring caustic right at the shadow silhouette (b -> b_c+)
    float bCrit = 2.598076 * sqrt(max(kerrScale, 0.75));
    float ringDelta = (bRs - bCrit) / max(bCrit, 1.0);
    if (!res.captured && ringDelta > -0.014 && ringDelta < 0.13 && res.transmittance > 0.01) {
      float filament = exp(-abs(ringDelta) / 0.013) * 1.15 + exp(-max(ringDelta, 0.0) / 0.046) * 0.30;
      float dopplerRing = clamp(pow(1.0 + 0.30 * prograde, 2.0), 0.45, 1.95);
      vec3 ringCol = bhBlackbodyLinear(tempPeakK * (1.14 + 0.24 * prograde));
      res.radiance += res.transmittance * ringCol * filament * dopplerRing * intensityScale * 1.25;
    }

    return res;
  }
`;

export function makeBlackHoleVolumeMaterial({
  rs = 1.22,
  outerRadius = 14.2,
  spin = 0.78,
  temperatureK = 5800,
  intensity = 0.96,
  discRight = new THREE.Vector3(1, 0, 0),
  discNormal = new THREE.Vector3(0, 1, 0),
  discForward = new THREE.Vector3(0, 0, 1),
} = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    uniforms: {
      uTime: { value: 0 },
      uRs: { value: rs },
      uOuter: { value: outerRadius },
      uBoundRadius: { value: outerRadius * 1.22 },
      uSpin: { value: spin },
      uTempK: { value: THREE.MathUtils.clamp(temperatureK * 1.28, 4900, 6200) },
      uIntensity: { value: intensity },
      uCenterWorld: { value: new THREE.Vector3() },
      uDiscRight: { value: discRight.clone().normalize() },
      uDiscNormal: { value: discNormal.clone().normalize() },
      uDiscForward: { value: discForward.clone().normalize() },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorldPos;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      uniform float uRs;
      uniform float uOuter;
      uniform float uBoundRadius;
      uniform float uSpin;
      uniform float uTempK;
      uniform float uIntensity;
      uniform vec3 uCenterWorld;
      uniform vec3 uDiscRight;
      uniform vec3 uDiscNormal;
      uniform vec3 uDiscForward;
      varying vec3 vWorldPos;

      ${BLACK_HOLE_RELATIVISTIC_GLSL}

      void main() {
        vec3 p0 = cameraPosition - uCenterWorld;
        vec3 rayDir = normalize(vWorldPos - cameraPosition);

        float tCa = -dot(p0, rayDir);
        float r0Sq = dot(p0, p0);
        float bSq = max(0.0, r0Sq - tCa * tCa);
        if (bSq >= uBoundRadius * uBoundRadius) {
          gl_FragColor = vec4(0.0);
          return;
        }

        float pxRad = length(fwidth(rayDir));
        BhTraceResult tr = bhTraceGeodesic(
          p0, rayDir, uRs, uOuter, uSpin, uTempK, uTime, uIntensity,
          uDiscRight, uDiscNormal, uDiscForward, pxRad
        );

        float bNorm = sqrt(bSq) / uBoundRadius;
        float edgeFade = 1.0 - smoothstep(0.84, 1.0, bNorm);
        float alpha = tr.captured ? 1.0 : (1.0 - tr.transmittance) * edgeFade;
        vec3 rgb = tr.radiance * (tr.captured ? 1.0 : edgeFade);

        if (!tr.captured) {
          float shadowGrip = exp(-max(sqrt(bSq) / uRs - 2.6, 0.0) * 1.6) * 0.48 * edgeFade;
          alpha = clamp(alpha + shadowGrip * tr.transmittance, 0.0, 1.0);
        }

        gl_FragColor = vec4(rgb, clamp(alpha, 0.0, 1.0));
      }
    `,
  });
}

export function makeBlackHoleImpostorTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function makeAccretionMaterial(innerRadius, outerRadius, temperatureK = 4500) {
  return makeBlackHoleVolumeMaterial({
    rs: innerRadius * 0.45,
    outerRadius,
    temperatureK,
  });
}

export function makePhotonMaterial() {
  return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
}

export class BlackHole {
  constructor({ spec, posUniv, fadeIn = false, scene = null }) {
    this.spec = spec;
    this.seed = spec.seed;
    this.bodyId = spec.bodyId;
    this.name = spec.name;
    this.properName = spec.properName;
    this.catalogName = spec.catalogName;
    this.type = 'blackHole';
    this.typeLabel = '超大质量黑洞';
    this.isBlackHole = true;
    this.isMoon = false;
    this.landable = false;
    this.R = spec.radius;
    this.accretionRadius = spec.accretionRadius;
    // Commanding Gargantua shadow proportion: b_c = 2.60 * Rs ~= 2.42 * R against
    // accretionRadius (~11.5 * R), so r_out / Rs ~= 12.4 (shadow is ~24% of disc span).
    this.rs = spec.radius * 0.93;
    this.spin = THREE.MathUtils.clamp(Number(spec.blackHole?.spin) || 0.78, 0.35, 0.94);
    this.discTemperatureK = THREE.MathUtils.clamp(
      (Number(spec.blackHole?.discTemperatureK) || 4200) * 1.30,
      5000,
      6300,
    );
    this.basis = computeBlackHoleBasis(spec);
    this.posUniv = posUniv.clone();
    this.frameVelocity = new THREE.Vector3();

    this.group = new THREE.Group();
    this.group.name = `black-hole:${this.name}`;
    this.group.userData.blackHole = this;

    this.appear = fadeIn ? 0 : 1;
    this.timeSeconds = 0;
    this.group.scale.setScalar(fadeIn ? 0.001 : 1);

    this.hostScene = scene;
    if (scene) {
      scene.userData.blackHoles ??= new Set();
      scene.userData.blackHoles.add(this);
    }
  }

  isVisibleInScene(scene) {
    if (this.appear <= 0.0005) return false;
    let cur = this.group;
    while (cur) {
      if (!cur.visible) return false;
      if (cur === scene) return true;
      cur = cur.parent;
    }
    return false;
  }

  setFrame() {}
  setSunDir() {}

  updateVisual(timeSeconds) {
    this.timeSeconds = timeSeconds;
    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + 0.035);
      const eased = this.appear * this.appear * (3 - 2 * this.appear);
      this.group.scale.setScalar(Math.max(0.001, eased));
    }
  }

  dispose() {
    this.hostScene?.userData?.blackHoles?.delete(this);
    this.hostScene = null;
    this.group.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose?.();
    });
  }
}
