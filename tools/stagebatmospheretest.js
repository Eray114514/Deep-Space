import assert from 'node:assert/strict';
import {
  blackbodyLinearRgb,
  buildStellarLightField,
  stellarIrradiance,
} from '../src/stellar-radiometry.js';
import {
  approximateSkyRadiance,
  atmosphereDensityAt,
  atmosphereTransmittance,
  createAtmosphereProfile,
  mieCoefficients,
  nightSkyIrradiance,
  rayleighCoefficients,
} from '../src/atmosphere-physics.js';
import {
  atmosphereRenderProfile,
  createAtmosphereOpticalDepthLut,
} from '../src/atmosphere-pass-webgl.js';

const luminance = (rgb) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
const finiteRgb = (rgb) => rgb.length === 3
  && rgb.every((channel) => Number.isFinite(channel) && channel >= 0);

const warm = blackbodyLinearRgb(3000);
const solar = blackbodyLinearRgb(5800);
const hot = blackbodyLinearRgb(12000);
assert.ok(finiteRgb(warm) && finiteRgb(solar) && finiteRgb(hot));
assert.ok(warm[0] / Math.max(warm[2], 1e-9) > solar[0] / solar[2],
  'cool black bodies are redder than solar-temperature stars');
assert.ok(solar[2] / solar[0] < hot[2] / hot[0],
  'hot black bodies are bluer than solar-temperature stars');
assert.notDeepEqual(blackbodyLinearRgb(5478), blackbodyLinearRgb(5790),
  'actual temperature, not only spectral class, determines chromaticity');

const unitFlux = stellarIrradiance(1, 10);
assert.ok(Math.abs(stellarIrradiance(1, 20) / unitFlux - 0.25) < 1e-12,
  'stellar irradiance follows inverse square distance');
assert.equal(stellarIrradiance(1, 10, 0), 0, 'eclipse visibility removes direct flux');

const lightField = buildStellarLightField([
  { starId: 'warm', temperatureK: 4200, luminositySolar: 0.7, position: [10, 0, 0] },
  { starId: 'hot', temperatureK: 9000, luminositySolar: 2.2, position: [0, 20, 0] },
  { starId: 'ignored-third', temperatureK: 3000, luminositySolar: 99, position: [0, 0, 1] },
]);
assert.equal(lightField.count, 2, 'the physical light field is deliberately capped at two stars');
assert.equal(lightField.dominantIndex, 0, 'dominant source follows received flux, not luminosity alone');
assert.ok(Math.abs(lightField.sources.reduce((sum, source) =>
  sum + source.irradianceFraction, 0) - 1) < 1e-12);
assert.ok(Math.abs(lightField.sources.reduce((sum, source) =>
  sum + luminance(source.radiance), 0) - 1) < 1e-10,
  'normalized stellar RGB radiance conserves total luminance');
assert.ok(lightField.sources.every((source) =>
  Math.abs(Math.hypot(...source.direction) - 1) < 1e-12));
const eclipsedField = buildStellarLightField([
  {
    starId: 'eclipsed',
    temperatureK: 5800,
    luminositySolar: 1,
    position: [10, 0, 0],
    visibility: 0,
  },
]);
assert.equal(eclipsedField.sources[0].irradianceFraction, 0,
  'a single fully eclipsed star must not renormalize itself to full irradiance');
assert.ok(eclipsedField.totalClearFlux > eclipsedField.totalFlux,
  'stellar field preserves its unobscured flux reference through an eclipse');

const rayleigh = rayleighCoefficients();
assert.ok(rayleigh[0] < rayleigh[1] && rayleigh[1] < rayleigh[2],
  'Rayleigh scattering strengthens toward short wavelengths');
const mie = mieCoefficients();
assert.ok(mie.extinction.every((value, index) => value >= mie.scattering[index]));

const profile = createAtmosphereProfile({
  groundRadiusMeters: 900000,
  topAltitudeMeters: 120000,
});
const runtimeProfile = atmosphereRenderProfile({
  R: 6000000,
  hAmp: 12000,
  atmoHeight: 630000,
  atmoDensity: 1,
  type: 'lush',
  atmosphere: { pressureBar: 1 },
  weatherProfile: { temperatureK: 286 },
});
assert.equal(runtimeProfile.profile.topAltitudeMeters, 100000,
  'the 630 km authored gameplay envelope must not stretch the optical atmosphere');
assert.equal(runtimeProfile.profile.rayleighScaleHeightMeters, 8000);
assert.equal(runtimeProfile.profile.mieScaleHeightMeters, 1200);
const runtimeLut = createAtmosphereOpticalDepthLut(runtimeProfile.profile, 32, 12, 24);
assert.equal(runtimeLut.data.length, 32 * 12 * 4);
assert.ok(runtimeLut.data.every(Number.isFinite),
  'the production sunlight optical-depth LUT contains only finite values');
let shadowTexels = 0;
for (let i = 0; i < runtimeLut.data.length; i += 4) {
  if (runtimeLut.data[i + 3] !== 0) continue;
  shadowTexels++;
  assert.ok(runtimeLut.data[i] > 0 && runtimeLut.data[i + 1] > 0,
    'shadow-side LUT neighbours retain limiting optical depth, never zero-extinction bleed');
}
assert.ok(shadowTexels > 0, 'the LUT still records physical ground occlusion independently of RGB');
const groundDensity = atmosphereDensityAt(profile, 0);
const highDensity = atmosphereDensityAt(profile, 40000);
assert.ok(highDensity.rayleigh < groundDensity.rayleigh
  && highDensity.mie < groundDensity.mie);
assert.ok(atmosphereDensityAt(profile, 25000).ozone
  > atmosphereDensityAt(profile, 0).ozone,
  'ozone layer peaks above the lower atmosphere');

const vertical = atmosphereTransmittance(profile, 0, 1, 64);
const tangent = atmosphereTransmittance(profile, 0, 0.02, 64);
assert.ok(finiteRgb(vertical) && finiteRgb(tangent));
assert.ok(tangent.every((channel, index) => channel < vertical[index]),
  'a tangent ray crosses more atmosphere than a zenith ray');
assert.ok(vertical[2] < vertical[0],
  'short wavelengths lose more direct energy to Rayleigh scattering');
// Numerical convergence of the production march and LUT is exercised by
// atmospherequadraturetest.js. T + (1 - T) is not an energy-conservation test.

const night = nightSkyIrradiance();
assert.ok(finiteRgb(night) && luminance(night) > 0 && luminance(night) < 0.001,
  'night floor is visible to adapted exposure but far below daylight');
const daySky = approximateSkyRadiance(profile, {
  altitudeMeters: 1000, viewZenithCosine: 0.2, sunZenithCosine: 0.7,
  relativeAzimuthRadians: Math.PI * 0.5,
});
const twilightSky = approximateSkyRadiance(profile, {
  altitudeMeters: 1000, viewZenithCosine: 0.2, sunZenithCosine: -0.02,
  relativeAzimuthRadians: 0,
});
const nightSky = approximateSkyRadiance(profile, {
  altitudeMeters: 1000, viewZenithCosine: 0.2, sunZenithCosine: -0.6,
  relativeAzimuthRadians: Math.PI,
});
assert.ok(finiteRgb(daySky) && finiteRgb(twilightSky) && finiteRgb(nightSky));
assert.ok(luminance(daySky) > luminance(nightSky) * 4,
  'day sky remains materially brighter than the night floor');
assert.ok(luminance(twilightSky) >= luminance(nightSky),
  'twilight never falls below the adapted night-sky floor');

// Universal planetary atmosphere contracts: radius-proportional scale heights,
// seamless zero-edge optical tops, vacuum fade on airless bodies, and genuine
// chemical diversity across non-Earth planet and moon classes.
{
  const smallMoon = atmosphereRenderProfile({
    seed: 'MILKY-038:m:0,0,0:0:0',
    R: 37600,
    hAmp: 1900,
    type: 'exotic',
    isMoon: true,
    atmosphere: { pressureBar: 1.47 },
    weatherProfile: { temperatureK: 281 },
  });
  assert.ok(smallMoon.profile.topAltitudeMeters < smallMoon.profile.groundRadiusMeters * 0.22,
    'small moons must never wear a giant bloated atmosphere bubble');
  assert.ok(smallMoon.profile.topAltitudeMeters >= smallMoon.profile.rayleighScaleHeightMeters * 9.5,
    'optical top must exceed 9.5 scale heights so the outer limb fades cleanly without a hard edge');
  assert.ok(smallMoon.profile.rayleighScaleHeightMeters / smallMoon.profile.groundRadiusMeters < 0.025,
    'small-moon scale height must scale proportionally with moon radius');

  const desert = atmosphereRenderProfile({
    seed: 'MILKY-038:p:MW-0001:0',
    R: 276000,
    hAmp: 9000,
    type: 'desert',
    atmosphere: { pressureBar: 0.73 },
    weatherProfile: { temperatureK: 298 },
  });
  assert.ok(desert.profile.mie.scattering[0] > desert.profile.mie.scattering[2] * 2,
    'desert dust atmospheres must scatter red/amber stronger than blue');
  assert.ok(desert.profile.mie.extinction[2] > desert.profile.mie.scattering[2] * 1.5,
    'desert dust aerosols must physically absorb short wavelengths');

  const toxic = atmosphereRenderProfile({
    seed: 'MILKY-038:p:MW-0001:1',
    R: 375000,
    hAmp: 9500,
    type: 'toxic',
    atmosphere: { pressureBar: 7.29 },
    weatherProfile: { temperatureK: 305 },
  });
  assert.ok(toxic.profile.mie.extinction[2] > toxic.profile.mie.extinction[1],
    'toxic chlorine/sulfur extinction must absorb blue strongest to prevent magenta horizon inversion');
  assert.ok(toxic.densityScale < 3.0,
    'high-pressure atmospheres must compress smoothly instead of washing out to opaque soup');

  const airless = atmosphereRenderProfile({
    seed: 'MILKY-038:m:airless:0',
    R: 42000,
    hAmp: 1500,
    type: 'barren',
    isMoon: true,
    atmosphere: { pressureBar: 0.0004 },
    weatherProfile: { temperatureK: 220 },
  });
  assert.equal(airless.densityScale, 0, 'near-vacuum barren rocks must fade to zero atmosphere');
  assert.equal(airless.hasSignificantAtmosphere, false);
}

console.log('PASS: Stage B stellar radiometry and physical atmosphere reference contracts');
console.log(JSON.stringify({
  blackbody: { warm, solar, hot },
  lightField: {
    totalFlux: lightField.totalFlux,
    dominantIndex: lightField.dominantIndex,
    fractions: lightField.sources.map((source) => source.irradianceFraction),
  },
  transmittance: { vertical, tangent },
  skyLuminance: {
    day: luminance(daySky),
    twilight: luminance(twilightSky),
    night: luminance(nightSky),
  },
}, null, 2));
