// Native 2K startup before placement, followed by normal flight input.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { installFoundationFirstDrawProbe } from './foundation-first-draw-probe.js';
import { instrumentFoundationFirstDraw, installFoundationMainResponse } from './foundation-first-draw-route.js';

const viewport = { width: 2560, height: 1440 };
const limitMs = 120_000;
const split = process.argv.includes('--cloudsplit');
const output = `test-results/f3-native-startup/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const fingerprint = () => evidenceFingerprint('tools/f3startupgputest.js',
  'tools/foundation-first-draw-probe.js', 'tools/foundation-first-draw-route.js');
const before = await fingerprint();
const main = instrumentFoundationFirstDraw(await readFile('src/main.js', 'utf8'));
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const response = installFoundationMainResponse(server, main);
const errors = [];
let browser, page, failure, startup, input;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  page = await browser.newPage({ viewport });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' || /GL_INVALID_|CONTEXT_LOST/.test(message.text())) errors.push(message.text());
  });
  await page.addInitScript(installFoundationFirstDrawProbe);
  const url = new URL(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=1&farflora=1&post=1`);
  if (split) url.searchParams.set('cloudsplit', '1');
  await page.goto(url.href, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.NMS?.booted
    && Number.isFinite(window.__foundationFirstDrawProbe?.snapshot().firstPostCloudTaskAtMs),
  null, { timeout: limitMs });
  startup = await page.evaluate(() => {
    const { _renderer: renderer, _pipeline: pipeline } = NMS;
    const probe = window.__foundationFirstDrawProbe;
    const firstDraw = probe.endStartup();
    probe.dispose();
    return {
      drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
      firstDraw, probeRestored: probe.snapshot().restored, activeVolume: !!pipeline.volumePass?.activePlanet,
      stats: NMS.stats(),
    };
  });
  assert.deepEqual(startup.drawingBuffer, [viewport.width, viewport.height]);
  assert.ok(startup.activeVolume && startup.probeRestored && startup.firstDraw.deadline.passed);
  const initialSpeed = await page.evaluate(() => NMS._internals.nav.vel.length());
  await page.keyboard.down('KeyW');
  try {
    await page.waitForFunction(speed => NMS._internals.nav.vel.length() > speed + 1,
      initialSpeed, { timeout: 15_000 });
  } finally {
    await page.keyboard.up('KeyW');
  }
  await page.screenshot({ path: `${output}/startup-player.png`, timeout: 15_000 });
  input = await page.evaluate(() => {
    const gl = NMS._renderer.getContext();
    return { speed: NMS._internals.nav.vel.length(), gl: gl.getError(), contextLost: gl.isContextLost() };
  });
  assert.equal(input.gl, 0);
  assert.equal(input.contextLost, false);
  assert.deepEqual(errors, []);
} catch (error) {
  failure = String(error);
  if (page && !startup) {
    let timer;
    try {
      startup = await Promise.race([
        page.evaluate(() => {
          const renderer = window.NMS?._renderer;
          return { stats: window.NMS?.stats(), firstDraw: window.__foundationFirstDrawProbe?.snapshot(),
            drawingBuffer: renderer && [renderer.domElement.width, renderer.domElement.height],
            contextLost: renderer?.getContext().isContextLost() };
        }).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 12_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  await page?.screenshot({ path: `${output}/failure-player.png`, timeout: 12_000 }).catch(() => {});
} finally {
  response.restore();
  const after = await fingerprint();
  await writeFile(`${output}/report.json`, JSON.stringify({
    before, after, viewport, limitMs, split, startup, input, errors, failure,
    stableSource: before.sourceDigest === after.sourceDigest && before.verifierDigest === after.verifierDigest,
    response: response.snapshot(),
  }, null, 2));
  try { await browser?.close(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
console.log(JSON.stringify({ output, split, failure, input, deadline: startup?.firstDraw?.deadline }));
assert.deepEqual(before, await fingerprint());
assert.equal(failure, undefined);
