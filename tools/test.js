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
const { stabilizeHorizon } = await import('../src/controls.js');
const rolled = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.2);
const forwardBefore = new THREE.Vector3(0, 0, -1).applyQuaternion(rolled);
stabilizeHorizon(rolled, new THREE.Vector3(0, 1, 0), 1);
const forwardAfter = new THREE.Vector3(0, 0, -1).applyQuaternion(rolled);
const upAfter = new THREE.Vector3(0, 1, 0).applyQuaternion(rolled);
if (forwardBefore.angleTo(forwardAfter) > 1e-6 || upAfter.angleTo(new THREE.Vector3(0, 1, 0)) > 1e-6) {
  throw new Error('Horizon stabilization changed heading or failed to remove roll');
}

console.log(`PASS: ${sourceFiles.length} modules parse; version ${runtimeVersion} and horizon stabilization are valid.`);
