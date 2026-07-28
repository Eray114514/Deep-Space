// Pure stellar-radiometry helpers shared by rendering and deterministic tests.
// This module intentionally has no Three.js or RNG dependency.

const PLANCK_C2 = 1.438776877e-2; // h*c/k, metres * kelvin
const LUMA = [0.2126, 0.7152, 0.0722];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function gaussian(wavelengthNm, mean, leftSigma, rightSigma) {
  const sigma = wavelengthNm < mean ? leftSigma : rightSigma;
  const x = (wavelengthNm - mean) / sigma;
  return Math.exp(-0.5 * x * x);
}

// Wyman, Sloan & Shirley's compact analytic approximation to the CIE 1931
// 2-degree colour matching functions. It is accurate enough for black-body
// chromaticity while avoiding a bundled spectral lookup table.
function cie1931Approx(wavelengthNm) {
  const x = 1.056 * gaussian(wavelengthNm, 599.8, 37.9, 31.0)
    + 0.362 * gaussian(wavelengthNm, 442.0, 16.0, 26.7)
    - 0.065 * gaussian(wavelengthNm, 501.1, 20.4, 26.2);
  const y = 0.821 * gaussian(wavelengthNm, 568.8, 46.9, 40.5)
    + 0.286 * gaussian(wavelengthNm, 530.9, 16.3, 31.1);
  const z = 1.217 * gaussian(wavelengthNm, 437.0, 11.8, 36.0)
    + 0.681 * gaussian(wavelengthNm, 459.0, 26.0, 13.8);
  return [Math.max(0, x), Math.max(0, y), Math.max(0, z)];
}

function linearRgbFromXyz([x, y, z]) {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

function luminance(rgb) {
  return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
}

function unitLuminance(rgb) {
  const y = Math.max(1e-12, luminance(rgb));
  return rgb.map((channel) => Math.max(0, channel) / y);
}

/**
 * Convert black-body temperature to linear-sRGB chromaticity.
 *
 * Planck radiance is integrated from 380-780 nm against an analytic CIE 1931
 * observer, then transformed to linear sRGB. The brightest channel is one;
 * callers should apply physical intensity separately.
 *
 * @param {number} temperatureK
 * @returns {[number, number, number]} linear RGB
 */
export function blackbodyLinearRgb(temperatureK) {
  const temperature = clamp(Number(temperatureK) || 6500, 1000, 50000);
  const samples = [];
  let maxLogRadiance = -Infinity;

  for (let wavelengthNm = 380; wavelengthNm <= 780; wavelengthNm += 5) {
    const wavelengthM = wavelengthNm * 1e-9;
    const exponent = PLANCK_C2 / (wavelengthM * temperature);
    // The wavelength-independent 2hc² factor cancels during normalization.
    const logRadiance = -5 * Math.log(wavelengthM) - Math.log(Math.expm1(exponent));
    samples.push([wavelengthNm, logRadiance]);
    maxLogRadiance = Math.max(maxLogRadiance, logRadiance);
  }

  const xyz = [0, 0, 0];
  for (const [wavelengthNm, logRadiance] of samples) {
    const radiance = Math.exp(logRadiance - maxLogRadiance);
    const matching = cie1931Approx(wavelengthNm);
    xyz[0] += matching[0] * radiance;
    xyz[1] += matching[1] * radiance;
    xyz[2] += matching[2] * radiance;
  }

  const rgb = linearRgbFromXyz(xyz).map((channel) => Math.max(0, channel));
  const peak = Math.max(1e-12, ...rgb);
  return rgb.map((channel) => channel / peak);
}

/**
 * Relative irradiance from a star. Units cancel when every source uses the
 * same distance unit; the default result is luminositySolar / distance².
 */
export function stellarIrradiance(luminositySolar, distance, visibility = 1) {
  const luminosity = Math.max(0, Number(luminositySolar) || 0);
  const range = Math.max(1e-9, Number(distance) || 0);
  return luminosity * clamp(Number(visibility), 0, 1) / (range * range);
}

function positionOf(source) {
  const value = source?.position ?? source?.positionUniv ?? source?.worldPosition;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }
  if (value && typeof value === 'object') {
    return [Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0];
  }
  return [0, 0, 0];
}

function observerOf(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }
  return value && typeof value === 'object'
    ? [Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0]
    : [0, 0, 0];
}

/**
 * Build a renderer-neutral light field for at most two stars.
 *
 * Input stars may use array positions or `{x,y,z}` objects. Output order
 * preserves component identity; `dominantIndex` refers to that output order.
 * Each source carries raw inverse-square flux, a normalized fraction and a
 * unit-luminance HDR RGB radiance whose total luminance sums to one.
 */
export function buildStellarLightField(stars, observerPosition = [0, 0, 0]) {
  const observer = observerOf(observerPosition);
  const sources = (stars || []).slice(0, 2).map((source, index) => {
    const position = positionOf(source);
    const delta = [
      position[0] - observer[0],
      position[1] - observer[1],
      position[2] - observer[2],
    ];
    const distance = Math.max(1e-9, Math.hypot(...delta));
    const visibility = clamp(source?.visibility ?? 1, 0, 1);
    const flux = stellarIrradiance(source?.luminositySolar ?? source?.luminosity ?? 0,
      distance, visibility);
    const temperatureK = clamp(Number(source?.temperatureK) || 6500, 1000, 50000);
    const color = blackbodyLinearRgb(temperatureK);
    return {
      index,
      id: source?.starId ?? source?.id ?? `star-${index}`,
      direction: delta.map((component) => component / distance),
      distance,
      temperatureK,
      visibility,
      flux,
      color,
    };
  });

  const totalFlux = sources.reduce((sum, source) => sum + source.flux, 0);
  let dominantIndex = -1;
  let dominantFlux = -1;
  for (let i = 0; i < sources.length; i++) {
    if (sources[i].flux > dominantFlux) {
      dominantFlux = sources[i].flux;
      dominantIndex = i;
    }
  }

  for (const source of sources) {
    source.irradianceFraction = totalFlux > 0 ? source.flux / totalFlux : 0;
    const chromaticity = unitLuminance(source.color);
    source.radiance = chromaticity.map((channel) =>
      channel * source.irradianceFraction);
  }

  return {
    count: sources.length,
    sources,
    totalFlux,
    dominantIndex: totalFlux > 0 ? dominantIndex : -1,
  };
}
