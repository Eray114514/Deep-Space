import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function modules(directory) {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) files.push(...await modules(`${path}/`));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

async function digest(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const bytes = await readFile(new URL(file, root));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

// Every acceptance report uses the same complete runtime source set. A short
// hand-picked list omitted planet/near-patch/settings changes and different
// verifier filenames made otherwise identical builds appear incomparable.
export async function evidenceFingerprint(verifier) {
  const sourceFiles = [...await modules('src/'), ...await modules('vendor/'),
    'index.html', 'style.css', 'package.json'].sort();
  return {
    sourceDigest: await digest(sourceFiles),
    sourceFiles,
    verifierDigest: await digest([verifier, 'tools/browser.js',
      'tools/server.js', 'tools/evidence-fingerprint.js']),
  };
}
