// Browser regression for the manual spatial-rift passage: shader compilation,
// living edge motion, destination-light continuity and the closing lifecycle.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
const shaderErrors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error' || /WebGLProgram|shader error/i.test(text)) shaderErrors.push(text);
});

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

const frameA = path.join(os.tmpdir(), 'deep-space-rift-open-a.png');
const frameB = path.join(os.tmpdir(), 'deep-space-rift-open-b.png');
const openingFrame = path.join(os.tmpdir(), 'deep-space-rift-opening.png');
const thresholdFrame = path.join(os.tmpdir(), 'deep-space-rift-threshold.png');
const arrivalFrame = path.join(os.tmpdir(), 'deep-space-rift-arrival.png');

try {
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&nohero=1&quality=low&vclouds=0&farflora=0&freeze=1&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  const targetId = await page.evaluate(() => NMS._internals.universe.nearStarsList[0]?.id || null);
  check(!!targetId, 'a neighboring system is available for the rift route');
  await page.evaluate((id) => {
    NMS.openStarMap();
    NMS.selectStarMapTarget(id);
  }, targetId);
  await page.locator('#sm-systemGlyph [data-glyph-index]').first().click({ force: true });
  await page.waitForFunction(() => document.querySelector('#sm-planetLeft')?.classList.contains('active'));
  await page.locator('#sm-routeAction').click({ force: true });
  await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'));
  await page.locator('#route-rift-btn').click();
  await page.waitForFunction(() => {
    const rift = NMS.riftState();
    return rift.tension > 0.45 && rift.open > 0.10 && rift.open < 0.82;
  }, null, { timeout: 20000 });
  await page.screenshot({ path: openingFrame });
  await page.waitForFunction(() => NMS.riftState().open > 0.985 && NMS.riftState().burst < 0.001,
    null, { timeout: 20000 });

  check(await page.evaluate('NMS.stats().audio'), 'route gesture unlocks procedural audio');
  const stable = await page.evaluate('NMS.riftState()');
  check(stable.visible && stable.destinationLight.length > 0,
    'stable passage renders a live destination system');

  await page.screenshot({ path: frameA });
  await page.waitForTimeout(420);
  await page.screenshot({ path: frameB });
  const [a, b] = await Promise.all([readFile(frameA), readFile(frameB)])
    .then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i])
      + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 24) changed++;
  }
  check(changed > 1200, `stable passage edge remains visibly alive (${changed} changed pixels)`);

  check(await page.evaluate('NMS.approachRift(38)'), 'test pilot can stage immediately before the threshold');
  await page.waitForTimeout(120);
  await page.screenshot({ path: thresholdFrame });
  await page.evaluate('NMS.approachRift(-10)');
  await page.waitForFunction(() => NMS.riftState().arrived, null, { timeout: 10000 });
  const arrived = await page.evaluate('NMS.riftState()');
  const maxLightDelta = Math.max(0, ...stable.destinationLight.map((value, index) =>
    Math.abs(value - (arrived.destinationLight[index] ?? value))));
  check(maxLightDelta < 0.002,
    `destination stellar light is continuous across the threshold (max Δ ${maxLightDelta.toFixed(5)})`);
  check(arrived.audioCue === 'rift-close', 'threshold crossing triggers the dedicated closing cue');
  const exitDepths = await page.evaluate(() => new Promise((resolve) => {
    const samples = [];
    const sample = () => requestAnimationFrame(() => {
      const rift = NMS.riftState();
      if (rift.exitDepth) samples.push(rift.exitDepth);
      if (!rift.visible || samples.length >= 8) resolve(samples);
      else sample();
    });
    sample();
  }));
  check(exitDepths.length > 0 && exitDepths.every((range) => range.min > 0),
    `collapsing exit stays fully behind the camera (${exitDepths.length} sampled frames)`);
  await page.evaluate(() => NMS._internals.nav.vel.set(0, 0, 0));
  await page.waitForTimeout(80);
  await page.screenshot({ path: arrivalFrame });
  const [thresholdPng, arrivalPng] = await Promise.all([readFile(thresholdFrame), readFile(arrivalFrame)])
    .then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  const mean = (png) => {
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = 190; y < 650; y++) {
      for (let x = 300; x < 980; x++) {
        const i = (y * png.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) sum[channel] += png.data[i + channel];
        count++;
      }
    }
    return sum.map((value) => value / count);
  };
  const beforeMean = mean(thresholdPng);
  const afterMean = mean(arrivalPng);
  const exposureDelta = Math.max(...beforeMean.map((value, index) => Math.abs(value - afterMean[index])));
  check(exposureDelta < 8,
    `destination final-image exposure stays continuous (max RGB mean Δ ${exposureDelta.toFixed(2)})`);
  await page.waitForFunction(() => !NMS.riftState().active, null, { timeout: 5000 });
  const closed = await page.evaluate('NMS.riftState()');
  check(!closed.visible && closed.open === 0, 'exit collapses fully after traversal');

  check(shaderErrors.length === 0, 'rift shaders compile without browser errors');
  check(errors.length === 0, 'rift traversal produces no page errors');
  console.log(`captures: ${openingFrame}, ${frameA}, ${frameB}, ${thresholdFrame}, ${arrivalFrame}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures || errors.length || shaderErrors.length
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s), ${shaderErrors.length} shader/console error(s)`
  : 'DONE - spatial-rift browser checks passed');
process.exit(failures || errors.length || shaderErrors.length ? 1 : 0);
