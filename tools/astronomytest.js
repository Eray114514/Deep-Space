import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Planet } from '../src/planet.js';
import {
  BodyFrame, CelestialClock, eclipseFraction, generateBlackHoleSystemSpec,
  generateStellarSpec, generateSystemSpec, orbitalPosition, orientationAt,
} from '../src/astronomy.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning } from '../src/world-config.js';

const galaxy = getGalaxyConfig();
assert.equal(galaxy.id, ACTIVE_GALAXY_ID);
assert.equal(galaxy.seed, 'MILKY-038', 'release Milky Way must use the visually reviewed finite seed');
assert.deepEqual(resolveBodyTuning({
  galaxyId: galaxy.id, seed: galaxy.seed, systemId: HOME_SYSTEM_ID, bodyId: 'planet-0',
}), {}, 'the finite Milky Way catalogue must not carry inherited body tuning');
assert.deepEqual(resolveBodyTuning({
  galaxyId: galaxy.id, seed: galaxy.seed, systemId: HOME_SYSTEM_ID, bodyId: 'planet-0',
  worldLabParams: new URLSearchParams('system=0,0,0&body=planet-0&sea=-610&clouds=0.58'),
}), { seaLevelOffset: -610, cloudCoverage: 0.58 });

const catalog = new GalaxyCatalog(galaxy.seed);
const homeRecord = catalog.getSystem(HOME_SYSTEM_ID);
const home = generateSystemSpec(galaxy.seed, homeRecord);
assert.deepEqual(home, generateSystemSpec(galaxy.seed, homeRecord), 'system generation must be deterministic');
assert.deepEqual(home.compactObjects, [], 'ordinary systems must not gain random black holes');
assert.match(home.name, /[\u3400-\u9fff].*星系$/);
assert.match(home.catalogId, /^AF J\d{4}[+-]\d{4}-[PM0-9A-Z]+$/);
assert.deepEqual(home.stars, generateStellarSpec(galaxy.seed, homeRecord, home.properName).stars,
  'catalogue point and instantiated system must share stellar formation data');

const destination = { ...galaxy.blackHoleSystem, kind: 'blackHole' };
const blackHole = generateSystemSpec(galaxy.seed, destination);
assert.deepEqual(blackHole, generateBlackHoleSystemSpec(galaxy.seed, destination));
assert.equal(blackHole.compactObjects.length, 1);
assert.equal(blackHole.compactObjects[0].orbit.renderRadius, 0);
assert(blackHole.stars.every((star) => star.orbit.renderRadius > blackHole.compactObjects[0].accretionRadius));

const catalogues = new Set();
let foundBinary = false, foundGiant = false, foundRing = false, lockedMoon = null;
for (const record of catalog.nearestSystems(homeRecord.positionCells, 121)) {
  const spec = generateSystemSpec(galaxy.seed, record);
  assert(!catalogues.has(spec.catalogId), `duplicate catalogue ID ${spec.catalogId}`);
  catalogues.add(spec.catalogId);
  assert.deepEqual(spec.formation, record.formation);
  const primaries = spec.bodies.filter((body) => !body.isMoon);
  for (let i = 1; i < primaries.length; i++) {
    const innerApo = primaries[i - 1].orbit.semiMajorAU * (1 + primaries[i - 1].orbit.eccentricity);
    const outerPeri = primaries[i].orbit.semiMajorAU * (1 - primaries[i].orbit.eccentricity);
    assert(innerApo < outerPeri, `${record.id}: primary orbits cross`);
  }
  if (spec.binaryOrbit) {
    foundBinary = true;
    assert(primaries[0].orbit.semiMajorAU > spec.binaryOrbit.semiMajorAU * (1 + spec.binaryOrbit.eccentricity) * 3);
  }
  for (const body of spec.bodies) {
    assert(body.formation && body.formation.ageGyr > 0, `${record.id}/${body.bodyId}: missing formation profile`);
    assert(body.ringSystem, `${record.id}/${body.bodyId}: missing ring dossier`);
    assert(body.clouds.coverage >= 0 && body.clouds.coverage <= 0.85);
    assert(['微弱', '中等', '强烈'].includes(body.magnetosphere.label));
    if (!body.isMoon && (body.type === 'gasGiant' || body.type === 'iceGiant')) {
      foundGiant = true;
      assert(body.orbit.semiMajorAU >= spec.snowLineAU * 0.82);
    }
    if (body.ringSystem.present) {
      foundRing = true;
      assert(!body.isMoon && body.ringSystem.source !== 'none');
      assert(body.ringSystem.outerRadiusRatio > body.ringSystem.innerRadiusRatio);
    }
  }
  lockedMoon ||= spec.bodies.find((body) => body.isMoon && body.tidallyLocked) || null;
}
assert(foundBinary && foundGiant && foundRing && lockedMoon,
  'finite neighborhood must cover binaries, giants, physical rings and locked moons');

const homeWorld = home.bodies.find((body) => !body.isMoon);
assert.equal(homeWorld.type, 'lush');
assert(homeWorld.equilibriumK >= 235 && homeWorld.equilibriumK <= 330);
const planet = new Planet({
  seed: homeWorld.seed, name: homeWorld.name, posUniv: new THREE.Vector3(), type: homeWorld.type,
  radius: homeWorld.radius, atmosphere: homeWorld.atmosphere, clouds: homeWorld.clouds,
  formation: homeWorld.formation, ringSystem: homeWorld.ringSystem,
});
assert.equal(Boolean(planet.ringMesh), homeWorld.ringSystem.present,
  'renderer must consume the physical ring dossier instead of rolling again');
const terrain = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 1).normalize()]
  .map((direction) => planet.height(direction, planet.fullMaxFreq));
assert(terrain.every(Number.isFinite));
planet.dispose();

const start = orbitalPosition(homeWorld.orbit, 12);
const closed = orbitalPosition(homeWorld.orbit, 12 + homeWorld.orbit.periodHours);
assert(start.distanceTo(closed) < 1e-4);
const t = 31.25;
const towardParent = orbitalPosition(lockedMoon.orbit, t).negate().normalize();
const facing = new THREE.Vector3(-1, 0, 0).applyQuaternion(orientationAt(lockedMoon, t));
assert(facing.angleTo(towardParent) < 1e-6);

const frame = new BodyFrame(homeWorld).update(42, new THREE.Vector3(11, 22, 33));
const local = new THREE.Vector3(13, -7, 29);
assert(frame.worldToLocal(frame.localToWorld(local)).distanceTo(local) < 1e-6);
const clock = new CelestialClock('clock-test', { persist: false });
clock.update(60); assert.equal(clock.hours, 1); clock.frozen = true; clock.update(60); assert.equal(clock.hours, 1);
const observer = new THREE.Vector3(), star = new THREE.Vector3(10, 0, 0);
assert(eclipseFraction(observer, star, 1, [{ position: new THREE.Vector3(5, 0, 0), radius: 1 }]) < 0.01);
assert(eclipseFraction(observer, star, 1, [{ position: new THREE.Vector3(5, 5, 0), radius: 1 }]) > 0.99);

console.log(`PASS: ${catalogues.size} finite systems, formation, rings, orbits, clock, frames and eclipses are valid.`);
