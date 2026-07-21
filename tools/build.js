import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const OUT = resolve(ROOT, 'dist');
if (relative(ROOT, OUT) !== 'dist') throw new Error(`Refusing to replace unexpected output path: ${OUT}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const file of ['index.html', 'renderlab.html', 'style.css']) {
  await cp(join(ROOT, file), join(OUT, file));
}
for (const folder of ['src', 'vendor', 'assets', 'worlds']) {
  await cp(join(ROOT, folder), join(OUT, folder), { recursive: true });
}

// The import map resolves `three/addons/*` to `./node_modules/three/examples/jsm/`.
// Copying the entire jsm tree drags in ~14 MB of unused decoders (rhino3dm, draco,
// ammo, basis, lottie, ...). Instead, expand the explicit entry list into the full
// transitive closure of relative-path imports so runtime-only dependencies such
// as GLTFLoader -> SkeletonUtils are never left behind on Vercel.
const JSM_SRC = join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
const JSM_DST = join(OUT, 'node_modules', 'three', 'examples', 'jsm');
const ADDON_ENTRIES = [
  'postprocessing/SMAAPass.js',
  'tsl/display/BloomNode.js',
  'controls/OrbitControls.js',
  'geometries/RoundedBoxGeometry.js',
  'loaders/GLTFLoader.js',
  'libs/meshopt_decoder.module.js',
];

const relativeImportRe = /import\s+(?:[^'"]*\{|[^'"]*\}\s+from\s+)?['"](\.+\/[^'"]+)['"];?/g;
const addonsNeeded = new Set();

function resolveAddon(rel, importedBy) {
  const baseDir = dirname(join(JSM_SRC, importedBy));
  const resolved = resolve(baseDir, rel);
  if (!resolved.startsWith(JSM_SRC + '\\') && !resolved.startsWith(JSM_SRC + '/')) return null;
  return relative(JSM_SRC, resolved).replace(/\\/g, '/');
}

async function collectAddons() {
  const queue = [...ADDON_ENTRIES];
  for (const rel of queue) addonsNeeded.add(rel);
  while (queue.length) {
    const current = queue.pop();
    const text = await readFile(join(JSM_SRC, current), 'utf8').catch(() => '');
    for (const match of text.matchAll(relativeImportRe)) {
      const dep = resolveAddon(match[1], current);
      if (dep && !addonsNeeded.has(dep)) {
        addonsNeeded.add(dep);
        queue.push(dep);
      }
    }
  }
}

await collectAddons();
for (const rel of addonsNeeded) {
  await mkdir(dirname(join(JSM_DST, rel)), { recursive: true });
  await cp(join(JSM_SRC, rel), join(JSM_DST, rel));
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
await writeFile(join(OUT, 'build.json'), `${JSON.stringify({ version: pkg.version }, null, 2)}\n`);
console.log(`Built static game ${pkg.version} → ${OUT} (${addonsNeeded.size} addon files)`);
