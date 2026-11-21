import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  resolveRingSpec, sampleRingProfileCPU, RING_PROFILE_GLSL, RING_SHADOW_GLSL,
  ringShadowUniforms, bindRingShadow, createRingMaterial, buildPlanetaryRing,
} from '../src/rings.js';
import { Planet } from '../src/planet.js';
import { GasGiant } from '../src/gas-giant-webgl.js';
import { GalaxyCatalog } from '../src/galaxy-layout.js';
import { generateSystemSpec } from '../src/astronomy.js';

// 1. Profile math & Cassini/Encke divisions
const saturnSpec = resolveRingSpec({
  seed: 'saturn-test',
  type: 'gasGiant',
  radius: 5.8e7,
  ringSystem: {
    present: true,
    innerRadiusRatio: 1.38,
    outerRadiusRatio: 2.42,
    opticalDepth: 0.78,
    iceFraction: 0.86,
    gaps: [0.44, 0.76],
    source: 'tidal-disruption',
  },
});
assert.equal(saturnSpec.present, true);
assert.equal(saturnSpec.innerR, 5.8e7 * 1.38);
assert.equal(saturnSpec.outerR, 5.8e7 * 2.42);
const bRing = sampleRingProfileCPU(0.32, saturnSpec);
const cassini = sampleRingProfileCPU(0.44, saturnSpec);
const aRing = sampleRingProfileCPU(0.62, saturnSpec);
const encke = sampleRingProfileCPU(0.76, saturnSpec);
const fRing = sampleRingProfileCPU(0.968, saturnSpec);
assert.ok(bRing.density > 0.55, `B-ring should be optically dense (${bRing.density})`);
assert.ok(cassini.density < bRing.density * 0.16, `Cassini gap must cut density sharply (${cassini.density} vs ${bRing.density})`);
assert.ok(aRing.density > 0.35, `A-ring should carry clear density (${aRing.density})`);
assert.ok(encke.density < aRing.density * 0.22, `Encke gap must carve cleanly (${encke.density} vs ${aRing.density})`);
assert.ok(fRing.density > 0.3, `Outer F-ring shepherd thread must resolve (${fRing.density})`);
assert.equal(sampleRingProfileCPU(-0.1, saturnSpec).density, 0);
assert.equal(sampleRingProfileCPU(1.1, saturnSpec).density, 0);

// Ice vs silicate composition color differentiation
const rockySpec = resolveRingSpec({
  seed: 'rocky-ring',
  type: 'desert',
  radius: 6e6,
  ringSystem: {
    present: true, innerRadiusRatio: 1.5, outerRadiusRatio: 2.2,
    opticalDepth: 0.65, iceFraction: 0.10, gaps: [0.42, 0.74],
  },
});
const iceCol = sampleRingProfileCPU(0.32, saturnSpec).color;
const rockCol = sampleRingProfileCPU(0.32, rockySpec).color;
assert.ok(iceCol[2] > iceCol[0] * 0.95 && iceCol[2] > rockCol[2] + 0.25,
  'Icy rings must read distinctly brighter & cooler than silicate dust rings');
assert.ok(rockCol[0] > rockCol[2] * 1.25,
  'Silicate debris rings must carry warm ochre-brown chromaticity');

// 2. Shader chunks & logdepthbuf contract
assert.ok(RING_PROFILE_GLSL.includes('ringOpticalDensityAt'));
assert.ok(RING_SHADOW_GLSL.includes('ringShadowTransmission'));
const ringMat = createRingMaterial(saturnSpec, { planetRadius: 5.8e7 });
assert.ok(ringMat.vertexShader.includes('#include <logdepthbuf_vertex>'));
assert.ok(ringMat.fragmentShader.includes('#include <logdepthbuf_fragment>'));
assert.ok(ringMat.fragmentShader.includes('planetShadowOnRing'));
assert.ok(ringMat.fragmentShader.includes('ringHG'));
ringMat.dispose();

// 3. Planet & GasGiant integration, stellar sync, debris activation, and disposal
const giant = new GasGiant({
  seed: 'ring-giant-1',
  name: 'Test Saturn',
  catalogName: 'TS-1',
  posUniv: new THREE.Vector3(),
  type: 'gasGiant',
  radius: 2.2e7,
  ringSystem: {
    present: true, innerRadiusRatio: 1.4, outerRadiusRatio: 2.5,
    opticalDepth: 0.82, iceFraction: 0.78, gaps: [0.45, 0.78],
  },
});
assert.ok(giant.ring && giant.ringMesh && giant.ringSpec?.present);
const shadowU = ringShadowUniforms();
bindRingShadow(shadowU, giant);
assert.equal(shadowU.uRingShadowEnabled.value, 1);
assert.equal(shadowU.uRingParams.value.x, giant.ringSpec.innerR);
// Debris field stays hidden far away and activates inside ring band
giant.ring.update(new THREE.Vector3(0, 2.2e7 * 5, 0), 0.016);
assert.equal(giant.ring.debris.mesh.visible, false, 'Debris stays culled in distant orbit');
const midRingR = (giant.ringSpec.innerR + giant.ringSpec.outerR) * 0.42;
giant.ring.update(new THREE.Vector3(midRingR, 25, 0), 0.016);
assert.equal(giant.ring.debris.mesh.visible, true, 'Debris activates when flying inside a ring band');
// Binary star sync updates both star directions
giant.setStellarLights({
  sources: [
    { direction: [1, 0.2, 0], color: [1, 0.95, 0.85], irradianceFraction: 0.85 },
    { direction: [-0.8, 0.4, 0.3], color: [0.7, 0.85, 1], irradianceFraction: 0.15 },
  ],
  dominantIndex: 0,
});
assert.ok(giant.ring.material.uniforms.uStarEnergy1.value > 0.1);
giant.dispose();
assert.equal(giant.ring, null);

// Unringed GasGiant respects astronomy.js ringSystem.present === false
const unringedGiant = new GasGiant({
  seed: 'ring-giant-none',
  name: 'Bare Jupiter',
  catalogName: 'BJ-1',
  posUniv: new THREE.Vector3(),
  type: 'gasGiant',
  radius: 2.2e7,
  ringSystem: { present: false, innerRadiusRatio: 0, outerRadiusRatio: 0, opticalDepth: 0, iceFraction: 0, gaps: [] },
});
assert.equal(unringedGiant.ring, null);
assert.equal(unringedGiant.ringMesh, undefined);
unringedGiant.dispose();

// Ringed terrestrial Planet builds shader ring + debris and syncs lighting
const ringedPlanet = new Planet({
  seed: 'ring-terrestrial-1',
  name: 'Ringed Terra',
  posUniv: new THREE.Vector3(),
  type: 'lush',
  radius: 6e5,
  deferRoots: true,
  ringSystem: {
    present: true, innerRadiusRatio: 1.52, outerRadiusRatio: 2.32,
    opticalDepth: 0.68, iceFraction: 0.62, gaps: [0.41, 0.73],
  },
});
assert.ok(ringedPlanet.ring && ringedPlanet.ringMesh && ringedPlanet.ringSpec?.present);
assert.ok(ringedPlanet.ringNormalLocal.length() > 0.99);
ringedPlanet.setSunDir(new THREE.Vector3(0.6, 0.5, 0.62).normalize());
ringedPlanet.dispose();
assert.equal(ringedPlanet.ring, null);

// Verify real Milky Way catalog systems produce ringed planets/giants cleanly
const catalog = new GalaxyCatalog('MILKY-038');
const systems = catalog.allSystems();
let ringedGiants = 0, ringedRocky = 0;
for (let i = 0; i < 40; i++) {
  const sys = generateSystemSpec('MILKY-038', systems[i]);
  for (const b of sys.bodies) {
    if (b.ringSystem?.present) {
      if (b.type === 'gasGiant' || b.type === 'iceGiant') ringedGiants++;
      else ringedRocky++;
    }
  }
}
assert.ok(ringedGiants > 0, 'Catalog must contain ringed gas/ice giants');
const standaloneRing = buildPlanetaryRing({ seed: 's', radius: 1e6, ringSystem: saturnSpec });
standaloneRing.dispose();

console.log(`PASS: planetary ring shader, Cassini/Encke gaps, ice/silicate tints, planet/ring shadows, 3D debris field, disposal (40 systems: ${ringedGiants} ringed giants, ${ringedRocky} ringed rocky)`);
