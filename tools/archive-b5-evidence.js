// Archive only completed full runs; all original hashes are verified before
// selecting representative images. Full originals stay in the capture folder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const source = process.argv[2];
assert.ok(source, 'Usage: node tools/archive-b5-evidence.js test-results/b5-baseline/<digest>');
const destination = process.argv[3] || 'docs/baselines/b5-2026-09-21';
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json')));
if (manifest.phase === 'B4') {
  const weather = JSON.parse(await readFile(`test-results/b4-weather/${manifest.fingerprint.sourceDigest.slice(0, 12)}/report.json`));
  assert.deepEqual(weather.fingerprint, await evidenceFingerprint('tools/b4weathergputest.js'));
  await mkdir(destination, { recursive: true });
  await writeFile(`${destination}/weather.json`, JSON.stringify(weather, null, 2));
}
const reports = await Promise.all(['transport', 'radiance', 'lighting', 'resources'].map(async (name) => ({ name,
  report: JSON.parse(await readFile(`test-results/b5/${name}.json`)) })));
for (const { name, report } of reports) {
  const script = name === 'resources' ? 'tools/b5resourcetest.js' : name === 'transport' ? 'tools/b5transporttest.js'
    : name === 'radiance' ? 'tools/b5radiancetest.js' : 'tools/b5lightingtest.js';
  const expected = await evidenceFingerprint(script);
  assert.equal(report.fingerprint.sourceDigest, expected.sourceDigest);
  assert.equal(report.fingerprint.verifierDigest, expected.verifierDigest);
}
const foundation = JSON.parse(await readFile('test-results/stage-b-foundation/report.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
manifest.referenceDependencies = await Promise.all([
  'tools/medium-reference.js', 'tools/atmosphere-reference.js', 'tools/atmosphere-radiance-reference.js',
].map(async (file) => ({ file, sha256: hash(await readFile(file)) })));
assert.equal(manifest.completed, true);
assert.equal(manifest.probe, false);
assert.equal(manifest.records.length, 63);
assert.equal(manifest.traversals.length, 2);
assert.equal(manifest.fingerprint.sourceDigest, (await evidenceFingerprint('tools/b0baselinetest.js')).sourceDigest);
assert.equal(manifest.fingerprint.sourceDigest, foundation.fingerprint.sourceDigest);
assert.equal(manifest.fingerprint.verifierDigest, (await evidenceFingerprint('tools/b0baselinetest.js')).verifierDigest);
assert.equal(foundation.fingerprint.verifierDigest, (await evidenceFingerprint('tools/stagebfoundationtest.js')).verifierDigest);
assert.equal(manifest.helperDigest, hash(await readFile('tools/b0-browser.js')));
const captures = [...manifest.records.flatMap((r) => r.captures), ...manifest.traversals.flatMap((t) => t.frames)];
for (const { image, state } of captures) {
  assert.equal(state.render.webglError, 0);
  assert.equal(hash(await readFile(path.join(source, image.path))), image.sha256, image.path);
}
await mkdir(destination, { recursive: true });
const selected = manifest.records.filter((r) =>
  (r.light === 'day' && r.scene === 'S4-globe')
  || (r.index === 0 && r.light === 'day' && ['S1-ground', 'S2-inside', 'S2-above', 'S2-side'].includes(r.scene))
  || (r.index === 0 && r.light === 'twilight' && r.scene === 'S2-above')
  || (r.index === 0 && r.light === 'night' && r.scene === 'S4-globe'))
  .flatMap((r) => r.index === 0 && r.light === 'day' && r.scene === 'S2-above' ? r.captures : [r.captures[0]]);
for (const traversal of manifest.traversals) {
  const inside = manifest.columns.find((c) => c.index === 0 && c.light === 'day').insideAltitude;
  selected.push([...traversal.frames].sort((a, b) =>
    Math.abs(a.state.camera.altitudeMeters - inside) - Math.abs(b.state.camera.altitudeMeters - inside))[0]);
}
const archived = [];
for (const { image } of selected) {
  await copyFile(path.join(source, image.path), path.join(destination, image.path));
  archived.push(image);
}
await copyFile(path.join(source, 'matrix.png'), path.join(destination, 'matrix.png'));
// Contact sheet contains every sampled continuous frame, in time order.
const tiles = manifest.traversals.flatMap((t) => t.frames.map((f) =>
  `<figure><img src="/${source.replaceAll('\\', '/')}/${f.image.path}"><figcaption>${t.direction} ${(f.state.camera.altitudeMeters / 1000).toFixed(2)} km</figcaption></figure>`));
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 600 } });
  await page.route('**/__b5-motion-gallery', (r) => r.fulfill({ contentType: 'text/html', body:
    `<meta charset="utf-8"><style>body{background:#111;color:#eee;font:12px sans-serif}main{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}figure{margin:0}img{width:100%}</style><h2>${manifest.phase} scripted up/down — sampled continuous frames</h2><main>${tiles.join('')}</main>` }));
  await page.goto(`http://127.0.0.1:${port}/__b5-motion-gallery`);
  await page.locator('img').evaluateAll((images) => Promise.all(images.map((i) => i.decode())));
  await page.screenshot({ path: `${destination}/motion.png`, fullPage: true });
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
for (const name of ['matrix.png', 'motion.png']) {
  const bytes = await readFile(`${destination}/${name}`);
  archived.push({ path: name, sha256: hash(bytes), bytes: bytes.length });
}
manifest.archive = { originalsDirectory: source, archived,
  note: `Only archive.archived paths exist alongside this manifest. Other full-resolution originals are local; reproduce with STAGE_B_PHASE=${manifest.phase} node tools/b0baselinetest.js. Matrix and motion sheets retain all normal poses and sampled trajectory frames.` };
await writeFile(`${destination}/manifest.json`, JSON.stringify(manifest));
for(const {name,report} of reports) await writeFile(`${destination}/${name}.json`, JSON.stringify(report,null,2));
await writeFile(`${destination}/foundation.json`, JSON.stringify(foundation, null, 2));
console.log(`Archived ${archived.length} images to ${destination}; verified ${captures.length} original hashes.`);
