import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const OUT = resolve(ROOT, 'dist');
if (relative(ROOT, OUT) !== 'dist') throw new Error(`Refusing to replace unexpected output path: ${OUT}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const file of ['index.html', 'style.css']) {
  await cp(join(ROOT, file), join(OUT, file));
}
for (const folder of ['src', 'vendor', 'assets']) {
  await cp(join(ROOT, folder), join(OUT, folder), { recursive: true });
}

// The import map resolves `three/addons/*` to `./node_modules/three/examples/jsm/`.
// Copying the entire jsm tree drags in ~14 MB of unused decoders (rhino3dm, draco,
// ammo, basis, lottie, ...). Copy only the files actually reachable from the
// runtime import graph so dist stays small and Vercel deploys clean.
const JSM_SRC = join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
const JSM_DST = join(OUT, 'node_modules', 'three', 'examples', 'jsm');
const ADDONS_USED = [
  'postprocessing/SMAAPass.js',
  'postprocessing/Pass.js',
  'shaders/SMAAShader.js',
  'controls/OrbitControls.js',
  'geometries/RoundedBoxGeometry.js',
  'loaders/GLTFLoader.js',
  'utils/BufferGeometryUtils.js',
  'libs/meshopt_decoder.module.js',
];
for (const rel of ADDONS_USED) {
  await mkdir(dirname(join(JSM_DST, rel)), { recursive: true });
  await cp(join(JSM_SRC, rel), join(JSM_DST, rel));
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
await writeFile(join(OUT, 'build.json'), `${JSON.stringify({ version: pkg.version }, null, 2)}\n`);
console.log(`Built static game ${pkg.version} → ${OUT}`);
