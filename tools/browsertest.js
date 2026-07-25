// Fast browser smoke: one server + one Chromium + one boot, then the core
// assertions most likely to break in a large change (shader/runtime errors,
// galaxy+planet generation, render pipeline, flight input, pause UI).
//
//   npm run test:smoke
//
// This is NOT a replacement for the focused browser suites (gameplaytest,
// seamtest, touchtest, astroplaytest, starmaptest, pointerlocktest, rifttest).
// Those remain the full verification layer; test:smoke is the daily
// post-change check that runs in well under a minute once booted.

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
  if (message.type() === 'error') errors.push(text);
  if (/WebGLProgram|shader error|INVALID_OPERATION/i.test(text)) shaderErrors.push(text);
});

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

try {
  const bootStart = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&quality=low&post=0&vclouds=0&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
  console.log(`boot in ${((Date.now() - bootStart) / 1000).toFixed(1)}s`);

  // 1. No runtime or shader errors during boot — catches the bulk of large
  //    changes (broken modules, bad shader edits, copy/blit regressions).
  check(errors.length === 0, `no pageerror during boot${errors.length ? `: ${errors[0].split('\n')[0]}` : ''}`);
  check(shaderErrors.length === 0, `no shader errors during boot${shaderErrors.length ? `: ${shaderErrors[0].split('\n')[0]}` : ''}`);

  // 2. Galaxy + system + planet generation survived.
  const system = await page.evaluate('NMS.system()');
  check(/[\u3400-\u9fff].*星系$/.test(system.name), `system name generated (${system.name})`);
  check(system.stars.length >= 1 && system.bodies.length >= 1,
    `system has stars (${system.stars.length}) and bodies (${system.bodies.length})`);
  const planets = await page.evaluate('NMS.planets()');
  check(planets.length >= 1, `${planets.length} planets generated`);

  // 3. Render pipeline produces non-empty pixels — catches black-screen
  //    regressions (shader/copy/depth/occlusion) that boot without throwing.
  await page.waitForTimeout(500);
  const png = PNG.sync.read(await page.screenshot());
  let sumSq = 0;
  let samples = 0;
  for (let i = 0; i < png.data.length; i += 4 * 97) {
    const luma = png.data[i] * 0.3 + png.data[i + 1] * 0.59 + png.data[i + 2] * 0.11;
    sumSq += luma * luma;
    samples++;
  }
  const rms = Math.sqrt(sumSq / samples);
  check(rms > 5, `canvas renders non-empty content (luma RMS ${rms.toFixed(1)})`);

  // 4. Pointer lock + camera input — the flight input pipeline. mouse.click
  //    dispatches a trusted CDP event directly, bypassing Playwright's
  //    actionability wait (which stalls when a boot overlay or active canvas
  //    redraw keeps the element from settling). Do NOT pass nolock=1 in the
  //    boot URL: that sets window.NMS_NOLOCK and disables pointer lock entirely.
  await page.mouse.click(640, 360);
  await page.waitForFunction(
    () => document.pointerLockElement === document.querySelector('#app canvas'),
    null,
    { timeout: 10000 },
  );
  const quatBefore = await page.evaluate('NMS._internals.nav.quat.toArray()');
  await page.mouse.move(780, 420);
  await page.waitForTimeout(100);
  const quatAfter = await page.evaluate('NMS._internals.nav.quat.toArray()');
  const cameraMoved = quatAfter.some((value, index) => Math.abs(value - quatBefore[index]) > 1e-5);
  check(cameraMoved, 'pointer lock relays mouse motion to camera');

  // 5. Escape opens the pause surface — the UI pipeline.
  await page.keyboard.press('Escape');
  const pauseVisible = await page.evaluate(
    () => !document.getElementById('pause-overlay').classList.contains('hidden'),
  );
  check(pauseVisible, 'Escape opens the pause surface');
} finally {
  await browser.close();
  server.close();
}

if (failures) {
  console.error(`\nFAIL: ${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nPASS: browser smoke');
