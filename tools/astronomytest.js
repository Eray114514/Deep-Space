import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BodyFrame,
  CelestialClock,
  eclipseFraction,
  generateStellarSpec,
  generateBlackHoleSystemSpec,
  generateSystemSpec,
  orbitalPosition,
  orientationAt,
} from '../src/astronomy.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning } from '../src/world-config.js';

const galaxy = getGalaxyConfig();
assert.equal(galaxy.id, ACTIVE_GALAXY_ID, 'default galaxy must resolve explicitly');
assert.equal(galaxy.seed, 'NAVEMI-382', 'Milky Way must retain its curated seed');
assert.deepEqual(resolveBodyTuning({
  galaxyId: galaxy.id, seed: galaxy.seed, systemId: '0,0,0', bodyId: 'planet-0',
}), { seaLevelOffset: -420 }, 'curated home-world tuning must resolve by stable IDs');
assert.deepEqual(resolveBodyTuning({
  galaxyId: galaxy.id, seed: 'ANOTHER-SEED', systemId: '0,0,0', bodyId: 'planet-0',
}), {}, 'authored tuning must not leak into another seed');
assert.deepEqual(resolveBodyTuning({
  galaxyId: galaxy.id,
  seed: galaxy.seed,
  systemId: '0,0,0',
  bodyId: 'planet-0',
  worldLabParams: new URLSearchParams('system=0,0,0&body=planet-0&sea=-610&clouds=0.58'),
}), { seaLevelOffset: -610, cloudCoverage: 0.58 }, 'world lab must preview bounded body tuning');

const seed = 'ASTRONOMY-REGRESSION';
const home = generateSystemSpec(seed, { id: '0,0,0' });
assert.deepEqual(home, generateSystemSpec(seed, { id: '0,0,0' }), 'system generation must be deterministic');
assert.deepEqual(home.compactObjects, [], 'ordinary systems must never gain probabilistic black holes');
assert.match(home.name, /[\u3400-\u9fff].*星系$/, 'system should expose a Chinese proper name');
assert.match(home.catalogId, /^AF J\d{4}[+-]\d{4}-[PM0-9A-Z]+$/, 'catalogue ID should be visibly fictional and stable');
assert.doesNotMatch(home.name, /玄|沧|赤霄/, 'fantasy-style procedural roots are forbidden');
assert.deepEqual(home.stars, generateStellarSpec(seed, '0,0,0', home.properName).stars,
  'distant star appearance and instantiated system stars must share one generator');

const blackHoleDestination = { ...galaxy.blackHoleSystem, kind: 'blackHole' };
const blackHoleSystem = generateSystemSpec(seed, blackHoleDestination);
assert.deepEqual(blackHoleSystem, generateBlackHoleSystemSpec(seed, blackHoleDestination),
  'the special destination and direct compact-system generator must agree');
assert.equal(blackHoleSystem.compactObjects.length, 1, 'the galaxy has one authored central black hole');
assert.equal(blackHoleSystem.compactObjects[0].orbit.renderRadius, 0, 'the black hole must occupy the system center');
assert.equal(blackHoleSystem.stars.length, 3, 'captured stars should orbit the central black hole');
assert(blackHoleSystem.stars.every((star) => star.orbit?.renderRadius > blackHoleSystem.compactObjects[0].accretionRadius),
  'captured stellar orbits must remain outside the rendered accretion disc');
assert.deepEqual(generateSystemSpec(seed, { id: '0,0,0' }).bodies, home.bodies,
  'generating the compact destination must not consume or mutate ordinary-system RNG');

const catalogues = new Set();
const properSystemNames = new Set();
let foundBinary = false;
let foundGiant = false;
let lockedMoon = null;
let weakFieldCloudWorld = null;
for (let x = -5; x <= 5; x++) {
  for (let z = -5; z <= 5; z++) {
    const spec = generateSystemSpec(seed, { id: `${x},0,${z}` });
    assert(!catalogues.has(spec.catalogId), `duplicate catalogue ID ${spec.catalogId}`);
    catalogues.add(spec.catalogId);
    assert(!properSystemNames.has(spec.name), `duplicate reachable proper name ${spec.name}`);
    properSystemNames.add(spec.name);
    assert.equal(new Set(spec.bodies.map((body) => body.properName)).size, spec.bodies.length,
      `${spec.systemId}: proper names must be unique inside a system`);
    const primaries = spec.bodies.filter((body) => !body.isMoon);
    for (let i = 1; i < primaries.length; i++) {
      const innerApo = primaries[i - 1].orbit.semiMajorAU * (1 + primaries[i - 1].orbit.eccentricity);
      const outerPeri = primaries[i].orbit.semiMajorAU * (1 - primaries[i].orbit.eccentricity);
      assert(innerApo < outerPeri, `${spec.systemId}: primary orbits must not cross`);
    }
    if (spec.binaryOrbit) {
      foundBinary = true;
      const stableInner = spec.binaryOrbit.semiMajorAU * (1 + spec.binaryOrbit.eccentricity) * 3;
      assert(primaries[0].orbit.semiMajorAU > stableInner, `${spec.systemId}: circumbinary orbit is unstable`);
    }
    for (const body of primaries) {
      assert(['微弱', '中等', '强烈'].includes(body.magnetosphere?.label),
        `${spec.systemId}/${body.bodyId}: magnetic field must come from the physical dossier`);
      assert(body.clouds && body.clouds.coverage >= 0 && body.clouds.coverage <= 0.85,
        `${spec.systemId}/${body.bodyId}: cloud coverage must be bounded`);
      if (body.clouds.coverage > 0.05 && body.atmosphere?.pressureBar != null) {
        assert(body.atmosphere.pressureBar > 0.002,
          `${spec.systemId}/${body.bodyId}: a stable cloud deck needs atmospheric pressure`);
      }
      if (body.type === 'ice' && body.magnetosphere.label === '微弱' && body.clouds.coverage > 0.05) {
        weakFieldCloudWorld ||= body;
      }
      if (body.type === 'gasGiant' || body.type === 'iceGiant') {
        foundGiant = true;
        assert(body.orbit.semiMajorAU >= spec.snowLineAU * 0.82,
          `${spec.systemId}: giant formed implausibly far inside the snow line`);
      }
    }
    lockedMoon ||= spec.bodies.find((body) => body.isMoon && body.tidallyLocked) || null;
  }
}
assert(foundBinary, 'sample should contain a binary system');
assert(foundGiant, 'sample should contain a gas or ice giant');
assert(weakFieldCloudWorld, 'weak-field ice worlds may retain condensable atmospheres and clouds');

const curatedSystem = generateSystemSpec('NAVEMI-382', '0,0,0');
const curatedIceWorld = curatedSystem.bodies.find((body) => body.type === 'ice'
  && body.magnetosphere.label === '微弱' && body.clouds.coverage > 0.05);
assert(curatedIceWorld, 'NAVEMI-382 should retain a physically supported weak-field cloudy ice world');
const frozenOuterWorld = curatedSystem.bodies.find((body) => body.bodyId === 'planet-7');
assert(frozenOuterWorld.atmosphere.pressureBar < 0.002 && frozenOuterWorld.clouds.coverage === 0,
  'extreme cold should collapse the outer ice world atmosphere instead of preserving an arbitrary cloud deck');

const homeWorld = home.bodies.find((body) => !body.isMoon);
assert.equal(homeWorld.type, 'lush');
assert(homeWorld.equilibriumK >= 235 && homeWorld.equilibriumK <= 330,
  `home world should truly be temperate (${homeWorld.equilibriumK.toFixed(1)} K)`);
const start = orbitalPosition(homeWorld.orbit, 12);
const closed = orbitalPosition(homeWorld.orbit, 12 + homeWorld.orbit.periodHours);
assert(start.distanceTo(closed) < 1e-4, 'Kepler orbit should close after one period');

assert(lockedMoon, 'sample should contain a tidally locked moon');
if (lockedMoon) {
  const t = 31.25;
  const towardParent = orbitalPosition(lockedMoon.orbit, t).negate().normalize();
  const facing = new THREE.Vector3(-1, 0, 0).applyQuaternion(orientationAt(lockedMoon, t));
  assert(facing.angleTo(towardParent) < 1e-6, 'tidally locked moon must keep one face toward its parent');
}

const frame = new BodyFrame(homeWorld).update(42, new THREE.Vector3(11, 22, 33));
const local = new THREE.Vector3(13, -7, 29);
const roundTrip = frame.worldToLocal(frame.localToWorld(local));
assert(roundTrip.distanceTo(local) < 1e-6, 'body local/world transforms must round-trip without drift');

const clock = new CelestialClock('clock-test', { persist: false });
clock.update(60);
assert.equal(clock.hours, 1, '60 real seconds must advance exactly one universe hour');
clock.frozen = true;
clock.update(60);
assert.equal(clock.hours, 1, 'frozen clock must not advance');

const observer = new THREE.Vector3(0, 0, 0);
const star = new THREE.Vector3(10, 0, 0);
const totality = eclipseFraction(observer, star, 1, [{ position: new THREE.Vector3(5, 0, 0), radius: 1 }]);
const clear = eclipseFraction(observer, star, 1, [{ position: new THREE.Vector3(5, 5, 0), radius: 1 }]);
assert(totality < 0.01 && clear > 0.99, 'eclipse geometry should distinguish totality from a clear line of sight');

console.log(`PASS: ${catalogues.size} deterministic systems, orbits, clock, frames, climate and eclipses are valid.`);
