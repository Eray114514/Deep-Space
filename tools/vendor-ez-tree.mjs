// Vendors the ez-tree generator library (MIT, Daniel Greenheck) into
// vendor/ez-tree as browser-ready native ES modules: relative imports gain
// their .js extension and the JSON presets become JS modules, since the game
// ships without a bundler. Re-run after updating the reference checkout.
//
//   node tools/vendor-ez-tree.mjs "<path to ez-tree>/src/lib"

import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('usage: node tools/vendor-ez-tree.mjs <ez-tree/src/lib>');
const target = new URL('../vendor/ez-tree/', import.meta.url);
await mkdir(new URL('presets/', target), { recursive: true });

const fixImports = (code) => code
  .replace(/from '(\.\.?\/[^']+?)\.json';/g, "from '$1.js';")
  .replace(/from '(\.\.?\/[^']+?)';/g, (match, path) => (path.endsWith('.js') ? match : `from '${path}.js';`));

for (const name of await readdir(source)) {
  if (!name.endsWith('.js')) continue;
  await writeFile(new URL(name, target), fixImports(await readFile(join(source, name), 'utf8')));
}
for (const name of await readdir(join(source, 'presets'))) {
  const body = await readFile(join(source, 'presets', name), 'utf8');
  if (name.endsWith('.json')) {
    await writeFile(new URL(`presets/${name.replace(/\.json$/, '.js')}`, target), `export default ${body.trim()};\n`);
  } else if (name.endsWith('.js')) {
    await writeFile(new URL(`presets/${name}`, target), fixImports(body));
  }
}
await copyFile(join(source, '..', '..', 'LICENSE'), new URL('LICENSE', target));
await writeFile(new URL('README.md', target), `# ez-tree (vendored)

Procedural tree generator by Daniel Greenheck, MIT licence (see LICENSE).
Source: https://github.com/dgreenheck/ez-tree, \`src/lib\`, version 1.1.0.

Converted by \`tools/vendor-ez-tree.mjs\` (import extensions, JSON presets as
modules). Do not edit by hand. Only the generator is vendored; the project's
textures are not used. Bark and leaf maps are generated at runtime in
\`src/vegetation/tree-atlas.js\`.
`);
console.log('vendored ez-tree into vendor/ez-tree');
