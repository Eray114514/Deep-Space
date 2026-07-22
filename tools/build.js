import { cp, glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// The source import map points into node_modules for local dev. The built
// output vendors the needed addons under vendor/three-addons/ so static hosts
// that honour .gitignore still upload them; rewrite the map accordingly.
const indexHtmlPath = join(OUT, 'index.html');
let indexHtml = await readFile(indexHtmlPath, 'utf8');
indexHtml = indexHtml.replace(
  '"three/addons/": "./node_modules/three/examples/jsm/"',
  '"three/addons/": "./vendor/three-addons/"'
);
await writeFile(indexHtmlPath, indexHtml, 'utf8');

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const BUILD_VERSION = pkg.version;

// Cloudflare Pages / browsers cache JS modules by URL. When we fix a file
// such as sysview.js, unchanged parent importers keep serving the cached
// module unless the request URL changes. Append the release version to every
// relative ES module import so each deployment invalidates the module graph.
const staticImportRe = /((?:import|export)(?:\s+[^'"]+?from\s+)?)['"](\.{1,2}\/[^'"]+?)['"]/g;
const dynamicImportRe = /(import\s*\(\s*)['"](\.{1,2}\/[^'"]+?)['"]\s*\)/g;

function rewriteRelativeImports(text) {
  const appendVersion = (match, prefix, path) => {
    if (path.includes('?')) return match;
    return `${prefix}'${path}?v=${BUILD_VERSION}'`;
  };
  return text
    .replace(staticImportRe, appendVersion)
    .replace(dynamicImportRe, appendVersion);
}

async function versionModuleImports(dir) {
  for await (const file of glob(join(dir, '**/*.js'))) {
    const original = await readFile(file, 'utf8');
    const updated = rewriteRelativeImports(original);
    if (updated !== original) await writeFile(file, updated, 'utf8');
  }
}


// Copying the entire jsm tree drags in ~14 MB of unused decoders (rhino3dm, draco,
// ammo, basis, lottie, ...). Instead, expand the explicit entry list into the full
// transitive closure of relative-path imports so runtime-only dependencies such
// as GLTFLoader -> SkeletonUtils are never left behind. We place the addons under
// `vendor/` instead of `node_modules/` so static hosts that honour .gitignore
// (Cloudflare Pages, etc.) still upload the files.
const JSM_SRC = join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
const JSM_DST = join(OUT, 'vendor', 'three-addons');
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

// Append version query strings to every relative ES module import so each
// deployment invalidates the browser's cached module graph (Cloudflare Pages
// and browsers cache modules by URL, not by content hash).
await versionModuleImports(join(OUT, 'src'));
await versionModuleImports(join(OUT, 'vendor'));

await writeFile(join(OUT, 'build.json'), `${JSON.stringify({ version: BUILD_VERSION }, null, 2)}\n`);
console.log(`Built static game ${BUILD_VERSION} → ${OUT} (${addonsNeeded.size} addon files)`);
