// Pure-Node verification suite for procedural cinematic stars (`src/star.js`)
// and cinematic stellar/orbital scale ratios (`src/astronomy.js`).
//   node tools/startest.js

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStarVisual } from '../src/star.js';
import { generateBlackHoleSystemSpec, generateSystemSpec } from '../src/astronomy.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { getGalaxyConfig } from '../src/world-config.js';

const CLASSES = [
  { spectralClass: 'M3V', temperatureK: 3100, radiusRender: 1.1e7, luminositySolar: 0.04 },
  { spectralClass: 'K4V', temperatureK: 4500, radiusRender: 1.5e7, luminositySolar: 0.35 },
  { spectralClass: 'G2V', temperatureK: 5780, radiusRender: 1.8e7, luminositySolar: 1.0 },
  { spectralClass: 'F5V', temperatureK: 6600, radiusRender: 2.3e7, luminositySolar: 2.8 },
  { spectralClass: 'A1V', temperatureK: 9200, radiusRender: 3.1e7, luminositySolar: 24 },
  { spectralClass: 'B2V', temperatureK: 18500, radiusRender: 4.4e7, luminositySolar: 2200 },
  { spectralClass: 'O6V', temperatureK: 36000, radiusRender: 5.2e7, luminositySolar: 90000 },
  { spectralClass: 'DA2', temperatureK: 14000, radiusRender: 5.8e6, luminositySolar: 0.04 },
];

for (let i = 0; i < CLASSES.length; i++) {
  const spec = { starId: `star-${i}`, displayName: `Test ${CLASSES[i].spectralClass}`, ...CLASSES[i] };
  const visual = createStarVisual({
    spec,
    referenceK: 5780,
    positionUniv: new THREE.Vector3(0, 0, 0),
    seed: `test:${i}`,
  });
  assert.ok(visual.mesh && visual.coronaShell && visual.prominences && visual.glow && visual.light);
  for (const part of [visual.mesh, visual.coronaShell, visual.prominences, visual.glow]) {
    assert.ok(part.material.vertexShader.includes('#include <logdepthbuf_vertex>'),
      `${spec.spectralClass} ${part.name} missing logdepthbuf_vertex`);
    assert.ok(part.material.fragmentShader.includes('#include <logdepthbuf_fragment>'),
      `${spec.spectralClass} ${part.name} missing logdepthbuf_fragment`);
    const pos = part.geometry.attributes.position.array;
    assert.ok(pos.length > 0 && pos.every(Number.isFinite),
      `${spec.spectralClass} ${part.name} non-finite positions`);
  }
  visual.group.position.set(spec.radiusRender * 3, 0, 0);
  visual.setExtinction(0.45);
  visual.update(12.5, 0.9, 0.7);
  assert.equal(visual.eclipseVis, 0.7);
  visual.dispose();
}

// Verify cinematic scale proportions in canonical Milky Way + Erebus Black Hole
const galaxy = getGalaxyConfig();
const catalog = new GalaxyCatalog(galaxy.seed);
const home = generateSystemSpec(galaxy.seed, catalog.getSystem(HOME_SYSTEM_ID));
const primary = home.stars[0];
const innerPlanet = home.bodies.find((b) => !b.isMoon);
assert.ok(primary.radiusRender >= 1.4e7 && primary.radiusRender <= 2.4e7,
  `home G-star radiusRender should be cinematic (~18,000 km), got ${primary.radiusRender}`);
assert.ok(innerPlanet.orbit.renderRadius >= primary.radiusRender * 15,
  `inner planet orbit (${innerPlanet.orbit.renderRadius}) must clear enlarged star corona`);
assert.ok(home.bodies.every((b) => b.isMoon || b.orbit.renderRadius <= 4.2e9),
  'all planet orbits must stay safely inside system approach boundary');

const bh = generateBlackHoleSystemSpec(galaxy.seed, { ...galaxy.blackHoleSystem, kind: 'blackHole' });
const centralBh = bh.compactObjects[0];
assert.ok(centralBh.radius >= 6e6, `black hole radius should be >= 6,000 km, got ${centralBh.radius}`);
for (const star of bh.stars) {
  assert.ok(star.orbit.renderRadius >= centralBh.accretionRadius * 4.5,
    `black hole companion star (${star.orbit.renderRadius}) must orbit well outside accretion disk (${centralBh.accretionRadius})`);
}

console.log(`PASS: cinematic star shaders (8 spectral classes), home star R=${Math.round(primary.radiusRender / 1e3)}km, inner orbit=${Math.round(innerPlanet.orbit.renderRadius / 1e3)}km, BH R=${Math.round(centralBh.radius / 1e3)}km, BH stars=[${bh.stars.map((s) => Math.round(s.orbit.renderRadius / 1e3) + 'km').join(', ')}].`);
