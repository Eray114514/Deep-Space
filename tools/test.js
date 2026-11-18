import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const SRC = join(ROOT, 'src');

// Recursive: the cloud/atmosphere rewrite lives in src/cloud/, and a
// non-recursive scan silently exempted every file in it from the parse gate.
const sourceFiles = (await readdir(SRC, { withFileTypes: true, recursive: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => join(entry.parentPath ?? entry.path ?? SRC, entry.name));

for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
const versionSource = await readFile(join(SRC, 'version.js'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const runtimeVersion = versionSource.match(/VERSION\s*=\s*['"]([^'"]+)/)?.[1];
const cacheVersion = html.match(/main\.js\?v=([0-9.]+)/)?.[1];
const cssCacheVersions = [...html.matchAll(/\.css\?v=([0-9.]+)/g)].map((m) => m[1]);

if (!runtimeVersion || pkg.version !== runtimeVersion || lock.version !== runtimeVersion
    || lock.packages?.['']?.version !== runtimeVersion || cacheVersion !== runtimeVersion
    || cssCacheVersions.length === 0 || cssCacheVersions.some((v) => v !== runtimeVersion)) {
  throw new Error(`Version mismatch: package=${pkg.version}, lock=${lock.version}, runtime=${runtimeVersion}, html=${cacheVersion}, css=${cssCacheVersions.join(',')}`);
}

const THREE = await import('three');
const { startDevServer, startServer } = await import('./server.js');
const { applyFlightThrusters, guidePlanetApproach, stabilizeHorizon,
  applyFlightSteering, flightBoostSpeedLimit, pulseBurstDistance } = await import('../src/controls.js');
const { Ship, landingDescentProgress, SHIP_LANDING_PROFILE } = await import('../src/effects.js');
const { PULSE_TIMING, pulseChannels, pulseChargeFromHold, pulseChargeScaling, pulseDisplacement, warpApproachRemaining, warpChannels,
  warpDepartureTravel, warpPlan } = await import('../src/transit.js');
const { cockpitShakeAmplitude, solveHullQuaternion } = await import('../src/ship-view.js');
const { DEFAULT_POWER, powerEffectsFor } = await import('../src/ship-hud.js');

const defaultPowerEffects = powerEffectsFor(DEFAULT_POWER);
for (const system of ['weapon', 'navigation', 'thermal', 'gravity', 'shield']) {
  if (defaultPowerEffects[system] !== 1) {
    throw new Error(`Default HUD power changed established ${system} feel`);
  }
}

const vacuumCockpitShake = cockpitShakeAmplitude(1, 0);
const atmosphericCockpitShake = cockpitShakeAmplitude(1, 1);
if (vacuumCockpitShake >= atmosphericCockpitShake * 0.06
    || atmosphericCockpitShake < 0.0034) {
  throw new Error('Cockpit shake no longer follows atmospheric density');
}

// Pulse is a fold, not a sprint: almost nothing moves while it charges, most
// of the distance is covered inside the short streak window, and the release
// is pure visuals. It stays a bounded displacement near terrain and is never
// disabled merely because the player is in atmosphere.
if (pulseDisplacement(0) !== 0 || pulseDisplacement(PULSE_TIMING.total) !== 1
    || pulseDisplacement(0.18) > 0.05
    || pulseDisplacement(0.34) - pulseDisplacement(0.22) < 0.75) {
  throw new Error('Pulse displacement is no longer concentrated in the fold window');
}
{
  const rest = pulseChannels(PULSE_TIMING.total + 0.01);
  if (rest.streak || rest.fold || rest.kick || rest.fov) {
    throw new Error('Pulse visuals outlive the pulse timeline');
  }
  // The camera is pushed once and settles; no sustained high-frequency shake.
  let signChanges = 0, last = 0;
  for (let t = 0; t < PULSE_TIMING.total; t += 1 / 240) {
    const kick = pulseChannels(t).kick;
    if (Math.sign(kick) && Math.sign(kick) !== Math.sign(last) && last !== 0) signChanges++;
    if (kick) last = kick;
  }
  if (signChanges > 2) throw new Error(`Pulse camera kick oscillates (${signChanges} sign changes)`);
}
// Holding the pulse charges a longer fold: a tap stays the base reach, a full
// hold reaches 8x for 2.5x the fuel, and the charge never moves the ship
// before release (the timeline parks before the jump window).
if (pulseChargeFromHold(0.1) !== 0 || pulseChargeFromHold(PULSE_TIMING.tapWindow + PULSE_TIMING.fullCharge + 1) !== 1
    || pulseChargeScaling(0).distance !== 1 || Math.abs(pulseChargeScaling(1).distance - 8) > 1e-9
    || Math.abs(pulseChargeScaling(1).fuel - 2.5) > 1e-9
    || pulseDisplacement(PULSE_TIMING.hold) !== 0) {
  throw new Error('Pulse charge contract drifted');
}
{
  const tap = pulseChannels(0.28), charged = pulseChannels(0.28, undefined, { power: pulseChargeScaling(1).power });
  if (!(charged.fold > tap.fold && charged.fov > tap.fov)) throw new Error('A charged pulse does not fold harder than a tap');
}
const openPulseDistance = pulseBurstDistance(620, Infinity, false);
const atmosphericPulseDistance = pulseBurstDistance(620, 1000, true);
if (openPulseDistance !== 6200 || atmosphericPulseDistance !== 400) {
  throw new Error('Pulse distance scaling or terrain clearance cap drifted');
}

// Full gauge deflection is the real RMB governor in every atmosphere and at
// every gravity allocation; pulse speed may exceed it only in the readout.
if (Math.abs(flightBoostSpeedLimit(620, 0, 1) - 6832.4) > 1e-8
    || Math.abs(flightBoostSpeedLimit(620, 1, 1) - 5208) > 1e-8
    || Math.abs(flightBoostSpeedLimit(620, 0.5, 1.2) - 7224.24) > 1e-8) {
  throw new Error('RMB boost governor no longer owns the HUD full-scale speed');
}

// Warp is one continuous shot: no channel may jump between frames at any
// phase boundary, the destination is swapped while the tunnel is opaque, and
// the approach brakes to exactly zero speed at the authored framing.
for (const distance of [2e11, 5e12, 8e13]) {
  const plan = warpPlan(distance);
  const dt = 1 / 120;
  const limits = { streak: 0.05, aberr: 0.05, tunnel: 0.05, fov: 0.9, blur: 0.05, endGlow: 0.12, colorMix: 0.05 };
  let previous = warpChannels(0, plan);
  for (let t = dt; t <= plan.total; t += dt) {
    const current = warpChannels(t, plan);
    for (const [key, limit] of Object.entries(limits)) {
      if (Math.abs(current[key] - previous[key]) > limit) {
        throw new Error(`Warp channel ${key} jumps at ${t.toFixed(3)} s (${previous[key]} -> ${current[key]})`);
      }
    }
    previous = current;
  }
  const atSwap = warpChannels(plan.swapAt, plan);
  if (atSwap.tunnel < 0.999 || atSwap.conduitEnter < 0.999 || atSwap.conduitExit > 0.001) {
    throw new Error('Warp swaps the destination while the conduit does not fully cover the view');
  }
  let lastRemaining = 1;
  for (let t = 0; t <= plan.total; t += dt) {
    const remaining = warpApproachRemaining(t, plan);
    if (remaining > lastRemaining + 1e-12) throw new Error('Warp approach is not monotonic');
    lastRemaining = remaining;
  }
  const endSpeed = (warpApproachRemaining(plan.total - dt, plan) - warpApproachRemaining(plan.total, plan)) / dt;
  if (warpApproachRemaining(plan.total, plan) > 1e-12 || endSpeed > 1e-6) {
    throw new Error('Warp approach does not brake to rest at the arrival framing');
  }
  if (warpDepartureTravel(0, plan) !== 0) throw new Error('Warp departure does not start at rest');
  const settled = warpChannels(plan.total, plan);
  if (settled.streak > 1e-6 || settled.tunnel > 1e-6 || Math.abs(settled.fov) > 1e-6) {
    throw new Error('Warp visuals do not settle at arrival');
  }
}

// Landing is a world-space third-person shot, with enough authored clearance
// to keep the lowest GLB vertex above every sampled point under the footprint.
let lastDescent = -1;
for (let i = 0; i <= 100; i++) {
  const progress = landingDescentProgress(i / 100);
  if (progress + 1e-9 < lastDescent || progress < 0 || progress > 1.000001) {
    throw new Error(`Landing descent curve is invalid at ${i}%`);
  }
  lastDescent = progress;
}
if (landingDescentProgress(0) !== 0 || landingDescentProgress(1) !== 1
    || SHIP_LANDING_PROFILE.bounds.minY > 0
    || SHIP_LANDING_PROFILE.footprint.length < 9
    || SHIP_LANDING_PROFILE.colliders.length < 2) {
  throw new Error('Ship landing clearance or compound walk collider contract drifted');
}
const rolled = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.2);
const forwardBefore = new THREE.Vector3(0, 0, -1).applyQuaternion(rolled);
stabilizeHorizon(rolled, new THREE.Vector3(0, 1, 0), 1);
const forwardAfter = new THREE.Vector3(0, 0, -1).applyQuaternion(rolled);
const upAfter = new THREE.Vector3(0, 1, 0).applyQuaternion(rolled);
if (forwardBefore.angleTo(forwardAfter) > 1e-6 || upAfter.angleTo(new THREE.Vector3(0, 1, 0)) > 1e-6) {
  throw new Error('Horizon stabilization changed heading or failed to remove roll');
}

// Approach behavior must be rotationally invariant: aiming at a pole, the
// opposite pole or the equator produces the same inward path and never an
// artificial outward kick from the speed limiter.
const approachResults = [];
for (const radial of [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
]) {
  const forward = radial.clone().negate();
  const reference = Math.abs(radial.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(radial, reference).normalize();
  const velocity = forward.clone().multiplyScalar(4200).addScaledVector(tangent, 9000);
  const beforeAngle = velocity.angleTo(forward);
  const intersects = guidePlanetApproach(velocity, forward, radial, 480000, 390000, 1400, 0.2);
  const inward = -velocity.dot(radial);
  const afterAngle = velocity.angleTo(forward);
  if (!intersects || inward <= 0 || inward > 1400.0001 || afterAngle >= beforeAngle) {
    throw new Error(`Planet approach guidance failed for radial ${radial.toArray()}`);
  }
  approachResults.push({ speed: velocity.length(), inward, angle: afterAngle });
}
for (const result of approachResults.slice(1)) {
  if (Math.abs(result.speed - approachResults[0].speed) > 1e-6
      || Math.abs(result.inward - approachResults[0].inward) > 1e-6
      || Math.abs(result.angle - approachResults[0].angle) > 1e-6) {
    throw new Error('Planet approach changes with world-axis orientation');
  }
}

// A/D must produce equal, opposite lateral thrust in the ship's local frame.
const thrustQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.7, -0.1));
const localRight = new THREE.Vector3(1, 0, 0).applyQuaternion(thrustQuat);
const dVelocity = applyFlightThrusters(new THREE.Vector3(), thrustQuat, 0, 1, 100, 0.1).clone();
const aVelocity = applyFlightThrusters(new THREE.Vector3(), thrustQuat, 0, -1, 100, 0.1).clone();
if (dVelocity.dot(localRight) < 41.99 || aVelocity.dot(localRight) > -41.99
    || dVelocity.clone().add(aVelocity).length() > 1e-8) {
  throw new Error('A/D lateral thrusters are missing, too weak, or asymmetric');
}

// Mouse steering is a damped flight-stick request, not an immediate camera
// rotation. It must build finite angular velocity, keep turning briefly after
// release, then settle without leaving residual input.
const steerQuat = new THREE.Quaternion();
const steerVelocity = new THREE.Vector3();
for (let i = 0; i < 60; i++) {
  applyFlightSteering(steerQuat, steerVelocity, 0.62, -0.24, 1 / 60);
}
if (steerQuat.angleTo(new THREE.Quaternion()) < 0.12
    || steerVelocity.y > -0.22 || steerVelocity.x < 0.08) {
  throw new Error('Damped flight steering does not build weighted pitch/yaw response');
}
const atRelease = steerQuat.clone();
for (let i = 0; i < 12; i++) {
  applyFlightSteering(steerQuat, steerVelocity, 0, 0, 1 / 60);
}
if (steerQuat.angleTo(atRelease) < 0.025) {
  throw new Error('Flight steering stops immediately instead of carrying finite inertia');
}
for (let i = 0; i < 240; i++) {
  applyFlightSteering(steerQuat, steerVelocity, 0, 0, 1 / 60);
}
if (steerVelocity.length() > 1e-4) {
  throw new Error('Flight steering fails to settle after input returns to neutral');
}

// A walking camera is composed as hull * localCamera. Solving the hull with
// the operands reversed makes it follow head-look, which was the reported
// interior-view failure.
const fixedHullQuat = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0.31, -0.72, 0.18, 'YXZ'));
for (const localEuler of [
  new THREE.Euler(-0.2, 0.8, 0.03, 'YXZ'),
  new THREE.Euler(0.4, -1.1, -0.08, 'YXZ'),
]) {
  const localCameraQuat = new THREE.Quaternion().setFromEuler(localEuler);
  const cameraWorldQuat = fixedHullQuat.clone().multiply(localCameraQuat);
  const solvedHullQuat = solveHullQuaternion(cameraWorldQuat, localCameraQuat);
  if (solvedHullQuat.angleTo(fixedHullQuat) > 1e-7) {
    throw new Error('Interior head-look changes the solved hull orientation');
  }
}

// A stationary ship attached to a rotating planet frame must stay rigid with
// no player input, but a zero-speed player turn must still move the hull in
// cockpit space. This separates intentional mass response from hover shake.
const hoverShip = Object.assign(Object.create(Ship.prototype), {
  group: new THREE.Group(),
  smQuat: new THREE.Quaternion(),
  roll: 0,
  lookYaw: 0,
  lookPitch: 0,
  loadedEmissives: [],
  loadedGear: [],
  loadedRamp: [],
  parkedPosUniv: null,
  parkedQuat: new THREE.Quaternion(),
  parkAmt: 0,
});
const hoverNav = {
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  vel: new THREE.Vector3(),
};
const identityQuat = new THREE.Quaternion();
for (let i = 0; i < 120; i++) {
  hoverNav.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), 0.0004));
  hoverShip.update(1 / 60, hoverNav, 'space', 0, 0, 0, {
    throttle: 0, strafe: 0, yaw: 0, pitch: 0,
  });
  const cockpitRelative = hoverNav.quat.clone().invert().multiply(hoverShip.group.quaternion);
  if (cockpitRelative.angleTo(identityQuat) > 1e-7 || Math.abs(hoverShip.roll) > 1e-8) {
    throw new Error('Stationary surface hover leaves residual ship roll or orientation lag');
  }
}
const lowNavVelocity = applyFlightThrusters(
  new THREE.Vector3(), thrustQuat, 0, 1, 100, 0.1, 1, .5,
);
if (Math.abs(lowNavVelocity.dot(localRight) - dVelocity.dot(localRight) * .5) > 1e-6) {
  throw new Error('Navigation power does not scale lateral thruster authority');
}
if (hoverShip.group.layers.isEnabled(0)
    || !hoverShip.group.layers.isEnabled(3)) {
  throw new Error('Flying ship still leaks into the base scene layer before warp compositing');
}
const neutralHullPosition = hoverShip.group.position.clone()
  .applyQuaternion(hoverNav.quat.clone().invert());

const landingPose = new THREE.Vector3(42, 18, -11);
const landingQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.4, 0.03));
hoverShip.setLandingPose(landingPose, landingQuat, 0.64);
hoverShip.update(1 / 60, hoverNav, 'landing', 0, 0, 0, null);
if (hoverShip.group.position.distanceTo(landingPose.clone().sub(hoverNav.pos)) > 1e-8
    || hoverShip.group.quaternion.angleTo(landingQuat) > 1e-8
    || hoverShip.foregroundOnly !== false
    || Math.abs(hoverShip.parkAmt - 0.64) > 1e-8) {
  throw new Error('Third-person landing pose is still coupled to flight-camera formation');
}
hoverShip.finishLanding();

for (let i = 0; i < 12; i++) {
  hoverShip.update(1 / 60, hoverNav, 'space', 0, 0, 0, {
    throttle: 0, strafe: 0, yaw: 0.8, pitch: -0.45,
  });
}
const steeredRelative = hoverNav.quat.clone().invert().multiply(hoverShip.group.quaternion);
const steeredHullPosition = hoverShip.group.position.clone()
  .applyQuaternion(hoverNav.quat.clone().invert());
const steeredAngle = steeredRelative.angleTo(identityQuat);
const steeredOffset = steeredHullPosition.distanceTo(neutralHullPosition);
if (steeredAngle < 0.008 || Math.abs(hoverShip.roll) < 0.007
    || Math.abs(hoverShip.lookYaw) < 0.006 || Math.abs(hoverShip.lookPitch) < 0.002
    || steeredOffset < 0.02) {
  throw new Error('Zero-speed player steering has no visible hull mass response');
}
// The HALCYON is a corvette: presentation may lag, but it must not stack a
// fighter-scale local roll/yaw on top of the actual navigation attitude.
if (steeredAngle > 0.04 || Math.abs(hoverShip.roll) > 0.03
    || Math.abs(hoverShip.lookYaw) > 0.025 || Math.abs(hoverShip.lookPitch) > 0.015
    || steeredOffset > 0.12) {
  throw new Error('Large-ship steering presentation twists too far around the flight attitude');
}
for (let i = 0; i < 120; i++) {
  hoverShip.update(1 / 60, hoverNav, 'space', 0, 0, 0, {
    throttle: 0, strafe: 0, yaw: 0, pitch: 0,
  });
}
if (Math.abs(hoverShip.roll) > 1.5e-4 || Math.abs(hoverShip.lookYaw) > 1.5e-4
    || Math.abs(hoverShip.lookPitch) > 1.5e-4) {
  throw new Error('Player steering mass response does not settle after input stops');
}
hoverShip.setForegroundOnly(false);
if (!hoverShip.group.layers.isEnabled(0)
    || hoverShip.group.layers.isEnabled(3)) {
  throw new Error('Parked ship does not return to the terrain-occluded base layer');
}

// Opening another terminal while the dev server is still running must not
// turn into an EADDRINUSE dead end. Occupy a real ephemeral port and prove the
// CLI helper selects a neighbouring one without disturbing the first server.
// Also verify the infinite-pulse playtest flag is injected only for
// startDevServer (`npm run dev`), keeping test `startServer` runs on the
// real fuel economy.
const occupied = await startServer(0);
let fallback;
try {
  fallback = await startDevServer(occupied.port, 10);
  if (!fallback.usedFallback || fallback.port === occupied.port) {
    throw new Error('Development server did not avoid an occupied port');
  }
  const [testHtml, devHtml] = await Promise.all([
    fetch(`http://127.0.0.1:${occupied.port}/`).then((res) => res.text()),
    fetch(`http://127.0.0.1:${fallback.port}/`).then((res) => res.text()),
  ]);
  if (!testHtml.includes('window.__NMS_DEV_SERVER__=true;')
      || testHtml.includes('__NMS_DEV_INFINITE_PULSE__')) {
    throw new Error('startServer must inject DEV_SERVER without infinite pulse');
  }
  if (!devHtml.includes('window.__NMS_DEV_SERVER__=true;')
      || !devHtml.includes('window.__NMS_DEV_INFINITE_PULSE__=true;')) {
    throw new Error('startDevServer did not inject infinite pulse bootstrap');
  }
} finally {
  fallback?.server.close();
  occupied.server.close();
}

// Keep the shared terrain sampling and soundtrack contracts in the fast default gate.
await import('./terraindetailframetest.js');
await import('./oceanrenderframetest.js');
await import('./musictest.js');

console.log(`PASS: ${sourceFiles.length} modules parse; version ${runtimeVersion}, flight controls, stationary hover, polar approach guidance, horizon stabilization, terrain detail phases, and dev-port fallback are valid.`);
