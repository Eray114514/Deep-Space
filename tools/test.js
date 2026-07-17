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
const versionSource = await readFile(join(SRC, 'version.js'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const runtimeVersion = versionSource.match(/VERSION\s*=\s*['"]([^'"]+)/)?.[1];
const cacheVersion = html.match(/main\.js\?v=([0-9.]+)/)?.[1];

if (!runtimeVersion || pkg.version !== runtimeVersion || cacheVersion !== runtimeVersion) {
  throw new Error(`Version mismatch: package=${pkg.version}, runtime=${runtimeVersion}, html=${cacheVersion}`);
}

const THREE = await import('three');
const { startDevServer, startServer } = await import('./server.js');
const { guidePlanetApproach, stabilizeHorizon } = await import('../src/controls.js');
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

console.log(`PASS: ${sourceFiles.length} modules parse; version ${runtimeVersion}, polar approach guidance, horizon stabilization, and dev-port fallback are valid.`);
