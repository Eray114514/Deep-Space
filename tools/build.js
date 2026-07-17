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
for (const folder of ['src', 'vendor', 'public']) {
  await cp(join(ROOT, folder), join(OUT, folder), { recursive: true });
}

// The import map needs only Three.js browser addons, not the package's Node
// metadata or the rest of node_modules.
await cp(
  join(ROOT, 'node_modules', 'three', 'examples', 'jsm'),
  join(OUT, 'node_modules', 'three', 'examples', 'jsm'),
  { recursive: true },
);

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
await writeFile(join(OUT, 'build.json'), `${JSON.stringify({ version: pkg.version }, null, 2)}\n`);
console.log(`Built static game ${pkg.version} → ${OUT}`);
