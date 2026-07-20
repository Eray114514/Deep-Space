import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_WORLD_LOCK,
  buildCanonicalWorldLock,
} from './canonical-world.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(await readFile(resolve(root, CANONICAL_WORLD_LOCK), 'utf8'));
const actual = buildCanonicalWorldLock();

try {
  assert.deepStrictEqual(actual, expected);
} catch (error) {
  const expectedFingerprint = expected.fingerprintSha256 || 'missing';
  const actualFingerprint = actual.fingerprintSha256;
  throw new Error(
    `Canonical universe drifted (${expectedFingerprint} -> ${actualFingerprint}). `
    + 'If this was accidental, preserve the existing RNG streams or authored config. '
    + 'If it was intentional, re-curate and visually review the universe before running npm run world:lock; '
    + 'never regenerate the lock only to silence this test.',
    { cause: error },
  );
}

console.log(`PASS: canonical universe lock ${actual.fingerprintSha256}`);
