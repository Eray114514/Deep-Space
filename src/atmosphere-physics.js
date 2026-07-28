// Renderer-neutral physical atmosphere reference model. It is deliberately
// deterministic, has no RNG/Three.js dependency, and can be shared by TSL,
// WebGL fallback parameterization and numerical acceptance tests.

const DEFAULT_WAVELENGTHS_NM = Object.freeze([680, 550, 440]);
const DEFAULT_NIGHT_RGB = Object.freeze([1.2e-4, 1.7e-4, 3.1e-4]);
const PI = Math.PI;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function rgbMul(a, b) {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

function rgbScale(a, scale) {
  return [a[0] * scale, a[1] * scale, a[2] * scale];
}

function rgbAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function rgbExpNeg(a) {
  return a.map((value) => Math.exp(-Math.max(0, value)));
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a) {
  const magnitude = Math.max(1e-12, length(a));
  return a.map((value) => value / magnitude);
}

function addScaled(a, b, scale) {
  return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
}

/**
 * Molecular Rayleigh scattering coefficients in inverse metres.
 * The default channels are 680/550/440 nm and reproduce the common Earth
 * reference coefficients near [5.8, 13.6, 33.1] × 10⁻⁶ m⁻¹.
 */
export function rayleighCoefficients(wavelengthsNm = DEFAULT_WAVELENGTHS_NM,
  coefficientAt550 = 13.558e-6) {
  return wavelengthsNm.map((wavelength) =>
    coefficientAt550 * Math.pow(550 / Math.max(100, wavelength), 4));
}

/**
 * Aerosol Mie coefficients in inverse metres using an Angstrom spectral slope.
 */
export function mieCoefficients({
  wavelengthsNm = DEFAULT_WAVELENGTHS_NM,
  scatteringAt550 = 3.996e-6,
  extinctionAt550 = 4.4e-6,
  angstromExponent = 0.84,
  asymmetry = 0.8,
} = {}) {
  const spectral = wavelengthsNm.map((wavelength) =>
    Math.pow(550 / Math.max(100, wavelength), angstromExponent));
  const scattering = spectral.map((scale) => scatteringAt550 * scale);
  const extinction = spectral.map((scale) => extinctionAt550 * scale);
  return {
    scattering,
    extinction,
    absorption: extinction.map((value, index) =>
      Math.max(0, value - scattering[index])),
    asymmetry: clamp(asymmetry, -0.98, 0.98),
  };
}

export function createAtmosphereProfile({
  groundRadiusMeters = 6.371e6,
  topAltitudeMeters = 100000,
  rayleighScaleHeightMeters = 8000,
  mieScaleHeightMeters = 1200,
  ozoneCenterMeters = 25000,
  ozoneHalfWidthMeters = 15000,
  wavelengthsNm = DEFAULT_WAVELENGTHS_NM,
  rayleigh = null,
  mie = null,
  ozoneAbsorption = [0.650e-6, 1.881e-6, 0.085e-6],
  groundAlbedo = [0.1, 0.1, 0.1],
  multipleScatteringFactor = 0.08,
} = {}) {
  const safeGroundRadius = Math.max(1000, Number(groundRadiusMeters) || 0);
  const safeTop = Math.max(1000, Number(topAltitudeMeters) || 0);
  return Object.freeze({
    groundRadiusMeters: safeGroundRadius,
    topAltitudeMeters: safeTop,
    topRadiusMeters: safeGroundRadius + safeTop,
    rayleighScaleHeightMeters: Math.max(100, rayleighScaleHeightMeters),
    mieScaleHeightMeters: Math.max(50, mieScaleHeightMeters),
    ozoneCenterMeters: Math.max(0, ozoneCenterMeters),
    ozoneHalfWidthMeters: Math.max(1, ozoneHalfWidthMeters),
    wavelengthsNm: Object.freeze([...wavelengthsNm]),
    rayleigh: Object.freeze([...(rayleigh || rayleighCoefficients(wavelengthsNm))]),
    mie: Object.freeze(mie || mieCoefficients({ wavelengthsNm })),
    ozoneAbsorption: Object.freeze([...ozoneAbsorption]),
    groundAlbedo: Object.freeze([...groundAlbedo]),
    multipleScatteringFactor: clamp(multipleScatteringFactor, 0, 1),
  });
}

/**
 * Normalized constituent densities at altitude.
 */
export function atmosphereDensityAt(profile, altitudeMeters) {
  const altitude = clamp(Number(altitudeMeters) || 0, 0, profile.topAltitudeMeters);
  const ozoneDistance = Math.abs(altitude - profile.ozoneCenterMeters);
  return {
    rayleigh: Math.exp(-altitude / profile.rayleighScaleHeightMeters),
    mie: Math.exp(-altitude / profile.mieScaleHeightMeters),
    ozone: Math.max(0, 1 - ozoneDistance / profile.ozoneHalfWidthMeters),
  };
}

function extinctionAt(profile, altitudeMeters) {
  const density = atmosphereDensityAt(profile, altitudeMeters);
  return profile.rayleigh.map((rayleigh, channel) =>
    rayleigh * density.rayleigh
    + profile.mie.extinction[channel] * density.mie
    + profile.ozoneAbsorption[channel] * density.ozone);
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

function pathHitsGround(radius, radialCosine, profile) {
  const b = radius * radialCosine;
  const discriminant = b * b + profile.groundRadiusMeters ** 2 - radius ** 2;
  if (discriminant < 0) return false;
  return -b - Math.sqrt(discriminant) > 1e-6;
}

/**
 * Integrate RGB transmittance from a radial altitude toward the atmosphere top.
 */
export function atmosphereTransmittance(profile, altitudeMeters,
  radialDirectionCosine, steps = 32) {
  const altitude = clamp(Number(altitudeMeters) || 0, 0, profile.topAltitudeMeters);
  const radius = profile.groundRadiusMeters + altitude;
  const cosine = clamp(Number(radialDirectionCosine) || 0, -1, 1);
  if (pathHitsGround(radius, cosine, profile)) return [0, 0, 0];
  const distance = raySphereDistance(radius, cosine, profile.topRadiusMeters);
  if (!Number.isFinite(distance)) return [1, 1, 1];
  const count = Math.max(4, Math.min(256, Math.floor(steps)));
  const stepLength = distance / count;
  const opticalDepth = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const sampleDistance = (i + 0.5) * stepLength;
    const sampleRadius = Math.sqrt(radius * radius + sampleDistance * sampleDistance
      + 2 * radius * sampleDistance * cosine);
    const extinction = extinctionAt(profile,
      Math.max(0, sampleRadius - profile.groundRadiusMeters));
    for (let channel = 0; channel < 3; channel++) {
      opticalDepth[channel] += extinction[channel] * stepLength;
    }
  }
  return rgbExpNeg(opticalDepth);
}

/**
 * Small physically ordered night-sky floor (stars + airglow + optional moon).
 */
export function nightSkyIrradiance({
  stellarScale = 1,
  airglowScale = 1,
  moonIlluminance = 0,
  moonColor = [0.78, 0.84, 1],
} = {}) {
  const stellar = rgbScale(DEFAULT_NIGHT_RGB, Math.max(0, stellarScale));
  const airglow = rgbScale([0.45e-4, 0.9e-4, 0.65e-4], Math.max(0, airglowScale));
  const moon = rgbScale(moonColor, Math.max(0, moonIlluminance) * 1e-3);
  return rgbAdd(rgbAdd(stellar, airglow), moon);
}

/**
 * Numerical single-scattering sky reference. This is intentionally a compact
 * CPU/reference approximation, not a replacement for the production LUT path.
 */
export function approximateSkyRadiance(profile, {
  altitudeMeters = 0,
  viewZenithCosine = 0.25,
  sunZenithCosine = 0.5,
  relativeAzimuthRadians = 0,
  sunColor = [1, 1, 1],
  sunIrradiance = 1,
  backgroundRadiance = nightSkyIrradiance(),
  steps = 24,
} = {}) {
  const altitude = clamp(altitudeMeters, 0, profile.topAltitudeMeters);
  const cameraRadius = profile.groundRadiusMeters + altitude;
  const viewCos = clamp(viewZenithCosine, -1, 1);
  const sunCos = clamp(sunZenithCosine, -1, 1);
  const viewSin = Math.sqrt(Math.max(0, 1 - viewCos * viewCos));
  const sunSin = Math.sqrt(Math.max(0, 1 - sunCos * sunCos));
  const camera = [0, cameraRadius, 0];
  const view = normalize([viewSin, viewCos, 0]);
  const sun = normalize([
    sunSin * Math.cos(relativeAzimuthRadians),
    sunCos,
    sunSin * Math.sin(relativeAzimuthRadians),
  ]);
  const groundDistance = pathHitsGround(cameraRadius, viewCos, profile)
    ? raySphereDistance(cameraRadius, viewCos, profile.groundRadiusMeters)
    : Infinity;
  const topDistance = raySphereDistance(cameraRadius, viewCos, profile.topRadiusMeters);
  const distance = Math.min(groundDistance, topDistance);
  if (!Number.isFinite(distance)) return [0, 0, 0];

  const count = Math.max(4, Math.min(128, Math.floor(steps)));
  const stepLength = distance / count;
  const viewOpticalDepth = [0, 0, 0];
  let radiance = [0, 0, 0];
  const scatteringCosine = clamp(dot(view, sun), -1, 1);
  const rayleighPhase = 3 / (16 * PI) * (1 + scatteringCosine * scatteringCosine);
  const g = profile.mie.asymmetry;
  const miePhase = (1 - g * g) / (4 * PI
    * Math.pow(Math.max(0.02, 1 + g * g - 2 * g * scatteringCosine), 1.5));

  for (let i = 0; i < count; i++) {
    const sampleDistance = (i + 0.5) * stepLength;
    const sample = addScaled(camera, view, sampleDistance);
    const sampleRadius = length(sample);
    const sampleUp = normalize(sample);
    const sampleAltitude = Math.max(0, sampleRadius - profile.groundRadiusMeters);
    const density = atmosphereDensityAt(profile, sampleAltitude);
    const extinction = extinctionAt(profile, sampleAltitude);
    for (let channel = 0; channel < 3; channel++) {
      viewOpticalDepth[channel] += extinction[channel] * stepLength;
    }
    const viewTransmission = rgbExpNeg(viewOpticalDepth);
    const sunTransmission = atmosphereTransmittance(profile, sampleAltitude,
      dot(sampleUp, sun), 16);
    const scatter = profile.rayleigh.map((coefficient, channel) =>
      coefficient * density.rayleigh * rayleighPhase
      + profile.mie.scattering[channel] * density.mie * miePhase);
    const direct = rgbMul(rgbMul(viewTransmission, sunTransmission), sunColor);
    radiance = rgbAdd(radiance, rgbScale(rgbMul(direct, scatter),
      stepLength * Math.max(0, sunIrradiance)));
  }

  const exitsToSpace = topDistance <= groundDistance;
  if (exitsToSpace) {
    const viewTransmission = rgbExpNeg(viewOpticalDepth);
    radiance = rgbAdd(radiance, rgbMul(backgroundRadiance, viewTransmission));
  } else {
    const bounce = profile.multipleScatteringFactor
      * Math.max(0, sunZenithCosine) * 0.025;
    radiance = rgbAdd(radiance, rgbScale(profile.groundAlbedo, bounce));
  }
  return radiance.map((channel) => Math.max(0, channel));
}
