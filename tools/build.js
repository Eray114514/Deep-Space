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

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const BUILD_VERSION = pkg.version;

// These are the public addon entry points imported by runtime source. Exact
// import-map entries let the built site version those URLs as well as their
// transitive relative imports. A prefix mapping cannot safely carry a query
// string because import-map prefix substitution must keep the trailing slash.
const ADDON_ENTRIES = [
  'postprocessing/SMAAPass.js',
  'tsl/display/BloomNode.js',
  'controls/OrbitControls.js',
  'geometries/RoundedBoxGeometry.js',
  'loaders/GLTFLoader.js',
  'loaders/KTX2Loader.js',
  'libs/meshopt_decoder.module.js',
];

// The source import map points into node_modules for local dev. The built
// output vendors the needed addons under vendor/three-addons/ so static hosts
// that honour .gitignore still upload them. Version every exact Three entry so
// direct imports and addon imports resolve to one module identity in production.
// Loading both `three.webgpu.js` and `three.webgpu.js?v=...` creates separate TSL
// class graphs and can make RenderPipeline output a transparent frame.
const indexHtmlPath = join(OUT, 'index.html');
let indexHtml = await readFile(indexHtmlPath, 'utf8');
const importMapMatch = indexHtml.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
if (!importMapMatch) throw new Error('Build failed: index.html import map is missing.');
const importMap = JSON.parse(importMapMatch[1]);
const imports = importMap.imports || (importMap.imports = {});
for (const [specifier, target] of [
  ['three', './vendor/three.module.js'],
  ['three/webgpu', './vendor/three.webgpu.js'],
  ['three/tsl', './vendor/three.tsl.js'],
]) {
  imports[specifier] = `${target}?v=${BUILD_VERSION}`;
}
for (const entry of ADDON_ENTRIES) {
  imports[`three/addons/${entry}`] = `./vendor/three-addons/${entry}?v=${BUILD_VERSION}`;
}
imports['three/addons/'] = './vendor/three-addons/';
const formattedImportMap = JSON.stringify(importMap, null, 2)
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n');
indexHtml = indexHtml.replace(
  importMapMatch[0],
  `<script type="importmap">\n${formattedImportMap}\n  </script>`,
);
await writeFile(indexHtmlPath, indexHtml, 'utf8');

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

// Fail the deployment build if a runtime addon entry can still pull an
// unversioned Three/TSL graph. This is intentionally checked in the build
// itself because both Vercel and Pages run this file as their final packager.
const builtIndexHtml = await readFile(indexHtmlPath, 'utf8');
const builtImportMapMatch = builtIndexHtml.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/);
const builtImports = JSON.parse(builtImportMapMatch?.[1] || '{}').imports || {};
for (const specifier of ['three', 'three/webgpu', 'three/tsl']) {
  if (!builtImports[specifier]?.endsWith(`?v=${BUILD_VERSION}`)) {
    throw new Error(`Build failed: ${specifier} is not versioned in the import map.`);
  }
}
for (const entry of ADDON_ENTRIES) {
  const specifier = `three/addons/${entry}`;
  if (builtImports[specifier] !== `./vendor/three-addons/${entry}?v=${BUILD_VERSION}`) {
    throw new Error(`Build failed: ${specifier} does not resolve to its versioned vendor entry.`);
  }
}

await writeFile(join(OUT, 'build.json'), `${JSON.stringify({ version: BUILD_VERSION }, null, 2)}\n`);
console.log(`Built static game ${BUILD_VERSION} → ${OUT} (${addonsNeeded.size} addon files)`);
