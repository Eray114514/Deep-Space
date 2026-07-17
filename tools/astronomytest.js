import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  BodyFrame,
  CelestialClock,
  eclipseFraction,
  generateStellarSpec,
  generateSystemSpec,
  orbitalPosition,
  orientationAt,
} from '../src/astronomy.js';

const seed = 'ASTRONOMY-REGRESSION';
const home = generateSystemSpec(seed, { id: '0,0,0' });
assert.deepEqual(home, generateSystemSpec(seed, { id: '0,0,0' }), 'system generation must be deterministic');
assert.match(home.name, /[\u3400-\u9fff].*星系$/, 'system should expose a Chinese proper name');
assert.match(home.catalogId, /^AF J\d{4}[+-]\d{4}-[PM0-9A-Z]+$/, 'catalogue ID should be visibly fictional and stable');
assert.doesNotMatch(home.name, /玄|沧|赤霄/, 'fantasy-style procedural roots are forbidden');
assert.deepEqual(home.stars, generateStellarSpec(seed, '0,0,0', home.properName).stars,
  'distant star appearance and instantiated system stars must share one generator');

const catalogues = new Set();
const properSystemNames = new Set();
let foundBinary = false;
let foundGiant = false;
let lockedMoon = null;
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
