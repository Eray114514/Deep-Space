import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const SRC = join(ROOT, 'src');

const sourceFiles = (await readdir(SRC, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => join(SRC, entry.name));

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
const { applyFlightThrusters, guidePlanetApproach, stabilizeHorizon } = await import('../src/controls.js');
const { Ship } = await import('../src/effects.js');
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
const neutralHullPosition = hoverShip.group.position.clone()
  .applyQuaternion(hoverNav.quat.clone().invert());

for (let i = 0; i < 12; i++) {
  hoverShip.update(1 / 60, hoverNav, 'space', 0, 0, 0, {
    throttle: 0, strafe: 0, yaw: 0.8, pitch: -0.45,
  });
}
const steeredRelative = hoverNav.quat.clone().invert().multiply(hoverShip.group.quaternion);
const steeredHullPosition = hoverShip.group.position.clone()
  .applyQuaternion(hoverNav.quat.clone().invert());
if (steeredRelative.angleTo(identityQuat) < 0.035 || Math.abs(hoverShip.roll) < 0.05
    || Math.abs(hoverShip.lookYaw) < 0.02 || Math.abs(hoverShip.lookPitch) < 0.01
    || steeredHullPosition.distanceTo(neutralHullPosition) < 0.15) {
  throw new Error('Zero-speed player steering has no visible hull mass response');
}
for (let i = 0; i < 120; i++) {
  hoverShip.update(1 / 60, hoverNav, 'space', 0, 0, 0, {
    throttle: 0, strafe: 0, yaw: 0, pitch: 0,
  });
}
if (Math.abs(hoverShip.roll) > 1e-5 || Math.abs(hoverShip.lookYaw) > 1e-5
    || Math.abs(hoverShip.lookPitch) > 1e-5) {
  throw new Error('Player steering mass response does not settle after input stops');
}

// Opening another terminal while the dev server is still running must not
// turn into an EADDRINUSE dead end. Occupy a real ephemeral port and prove the
// CLI helper selects a neighbouring one without disturbing the first server.
const occupied = await startServer(0);
let fallback;
try {
  fallback = await startDevServer(occupied.port, 10);
  if (!fallback.usedFallback || fallback.port === occupied.port) {
    throw new Error('Development server did not avoid an occupied port');
  }
} finally {
  fallback?.server.close();
  occupied.server.close();
}

console.log(`PASS: ${sourceFiles.length} modules parse; version ${runtimeVersion}, flight controls, stationary hover, polar approach guidance, horizon stabilization, and dev-port fallback are valid.`);
