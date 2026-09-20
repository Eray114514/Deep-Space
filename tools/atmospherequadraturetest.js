import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AtmospherePass, atmosphereRenderProfile, createAtmosphereOpticalDepthLut }
  from '../src/atmosphere-pass-webgl.js';
import { ATMOSPHERE_VIEW_STEPS, atmosphereSampleBoundary } from '../src/atmosphere-quadrature.js';
import { referenceColumn, columnFixtures } from './atmosphere-reference.js';

const profiles = [
  { R: 6000000, type: 'lush', weatherProfile: { temperatureK: 286 } },
  { R: 900000, type: 'ice', weatherProfile: { temperatureK: 190 } },
  { R: 7000000, type: 'desert', weatherProfile: { temperatureK: 410 } },
].map((planet) => atmosphereRenderProfile(planet).profile);
let maxViewError = 0;
let maxLutError = 0;
for (const profile of profiles) {
  for (const ray of columnFixtures(profile)) {
    const expected = referenceColumn(profile, ray.radius, ray.mu, ray.distance);
    const actual = [0, 0, 0];
    let previous = 0;
    for (let i = 1; i <= ATMOSPHERE_VIEW_STEPS; i++) {
      const next = atmosphereSampleBoundary(0, ray.distance, -ray.radius * ray.mu, i / ATMOSPHERE_VIEW_STEPS);
      const t = (previous + next) / 2;
      const h = Math.max(0, Math.sqrt(ray.radius ** 2 + t ** 2 + 2 * ray.radius * ray.mu * t)
        - profile.groundRadiusMeters);
      const density = [Math.exp(-h / profile.rayleighScaleHeightMeters),
        Math.exp(-h / profile.mieScaleHeightMeters),
        Math.max(0, 1 - Math.abs(h - profile.ozoneCenterMeters) / profile.ozoneHalfWidthMeters)];
      density.forEach((d, c) => { actual[c] += d * (next - previous); });
      previous = next;
    }
    actual.forEach((value, c) => {
      const error = Math.abs(value - expected[c]) / Math.max(expected[c], 100);
      maxViewError = Math.max(maxViewError, error);
      assert.ok(error < 0.02, `${ray.name} channel ${c}: column error ${error}`);
    });
  }
  const lut = createAtmosphereOpticalDepthLut(profile);
  const scales = [profile.rayleighScaleHeightMeters, profile.mieScaleHeightMeters, profile.ozoneHalfWidthMeters];
  // Off-grid points exercise interpolation, especially the near-ground aerosol layer.
  for (const altitude of [0, 120, 800, 2400, 12000, 22000]) {
    for (const mu of [1, 0.53, 0.05, 0, -0.005]) {
      const radius = profile.groundRadiusMeters + altitude;
      const horizon = -Math.sqrt(1 - (profile.groundRadiusMeters / radius) ** 2);
      if (mu < horizon) continue;
      const distance = -radius * mu + Math.sqrt((radius * mu) ** 2 + profile.topRadiusMeters ** 2 - radius ** 2);
      const expected = referenceColumn(profile, radius, mu, distance);
      const x = (Math.sign(mu) * Math.sqrt(Math.abs(mu)) + 1) * 0.5 * (lut.width - 1);
      const y = Math.sqrt(altitude / profile.topAltitudeMeters) * (lut.height - 1);
      for (let c = 0; c < 3; c++) {
        let value = 0;
        for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
          const ix = Math.min(lut.width - 1, Math.floor(x) + dx);
          const iy = Math.min(lut.height - 1, Math.floor(y) + dy);
          value += lut.data[(iy * lut.width + ix) * 4 + c]
            * (dx ? x % 1 : 1 - x % 1) * (dy ? y % 1 : 1 - y % 1) * scales[c];
        }
        const error = Math.abs(value - expected[c]) / Math.max(expected[c], 100);
        maxLutError = Math.max(maxLutError, error);
        assert.ok(error < 0.04, `LUT R=${profile.groundRadiusMeters} h=${altitude} mu=${mu} channel ${c}: ${error}`);
      }
    }
  }
}

// Analytic control catches the original under-sampled vertical aerosol column.
const p = profiles[0];
const exactMie = p.mieScaleHeightMeters * (1 - Math.exp(-p.topAltitudeMeters / p.mieScaleHeightMeters));
const oldUniform = Array.from({ length: 20 }, (_, i) =>
  Math.exp(-(i + 0.5) * p.topAltitudeMeters / 20 / p.mieScaleHeightMeters)
    * p.topAltitudeMeters / 20).reduce((a, b) => a + b, 0);
assert.ok(Math.abs(oldUniform / exactMie - 1) > 0.4, 'bad control must fail the 2% column gate');

// Texture disposal ownership, including revisits and full-session teardown.
const pass = new AtmospherePass(new THREE.PerspectiveCamera());
const bodies = Array.from({ length: 7 }, (_, i) => ({ R: 6000000 + i, atmoMesh: { visible: true },
  posUniv: new THREE.Vector3(), _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(0, 1, 0),
  worldOffsetToLocal: (offset, out) => out.copy(offset) }));
let disposals = 0;
for (const body of bodies) {
  pass.setActivePlanet(body, new THREE.Vector3());
  pass.lutTexture.addEventListener('dispose', () => disposals++);
  assert.ok(pass.profileCache.size <= 4);
}
assert.equal(disposals, 3, 'evicted LUTs are released');
const recent = pass.lutTexture;
pass.setActivePlanet(bodies[5], new THREE.Vector3());
pass.setActivePlanet(bodies[6], new THREE.Vector3());
assert.equal(pass.lutTexture, recent, 'recent body reuses its LUT');
pass.setActivePlanet({ ...bodies[6], atmoMesh: { visible: true }, atmoDensity: 0.5 }, new THREE.Vector3());
assert.equal(pass.lutTexture, recent, 'equal optical profiles share LUTs without retaining planet objects');
assert.equal(pass.profileState.densityScale, 0.5, 'shared LUT must not share planet density scale');
pass.dispose();
assert.equal(disposals, 7, 'each allocated LUT is released exactly once');
console.log('PASS: atmosphere column quadrature, LUT interpolation and bounded LUT ownership',
  { maxViewError, maxLutError, oldMieError: oldUniform / exactMie - 1 });
