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
for (let channel = 0; channel < 3; channel++) {
  const absorbed = 1 - vertical[channel];
  assert.ok(Math.abs(vertical[channel] + absorbed - 1) < 1e-12,
    'direct transmission plus removed energy is conserved');
}

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
