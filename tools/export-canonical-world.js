import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_WORLD_LOCK,
  buildCanonicalWorldLock,
} from './canonical-world.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, CANONICAL_WORLD_LOCK);
const lock = buildCanonicalWorldLock();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
console.log(`WROTE: ${CANONICAL_WORLD_LOCK} (${lock.fingerprintSha256})`);
