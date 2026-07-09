// Touch/mobile test: emulates a phone (Pixel 7 descriptor + CDP-dispatched
// trusted touch events) and exercises every gesture: drag-look, pinch-fly,
// tap-to-travel, virtual joystick walking, jump and take-off buttons.

import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium, devices } from 'playwright';

const OUT = 'screenshots/phone';
await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);

const phone = devices['Pixel 7'];
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
// deviceScaleFactor 1: SwiftShader can't push a real phone's pixel count;
// CSS layout (what we test) is identical
const ctx = await browser.newContext({ ...phone, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.error('PAGEERROR:', String(e).split('\n')[0]); });

const cdp = await ctx.newCDPSession(page);
const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
const sleep = (ms) => page.waitForTimeout(ms);

async function dragTouch(x0, y0, x1, y1, steps = 12, holdMs = 0) {
  await touch('touchStart', [{ x: x0, y: y0, id: 1 }]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, id: 1 }]);
    await sleep(16);
  }
  if (holdMs) await sleep(holdMs);
  await touch('touchEnd', []);
}

async function pinch(cx, cy, gap0, gap1, steps = 14) {
  const pts = (g) => [{ x: cx - g / 2, y: cy, id: 1 }, { x: cx + g / 2, y: cy, id: 2 }];
  await touch('touchStart', pts(gap0));
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', pts(gap0 + (gap1 - gap0) * i / steps));
    await sleep(16);
  }
  await touch('touchEnd', []);
}

async function tap(x, y) {
  await touch('touchStart', [{ x, y, id: 1 }]);
  await sleep(60);
  await touch('touchEnd', []);
}

async function rectOf(sel) {
  return page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
}

let failed = 0;
function check(cond, msg) {
  console.log(cond ? `✓ ${msg}` : `✗ FAIL: ${msg}`);
  if (!cond) failed++;
}

// post=0 & vclouds=0: this suite verifies gestures; visuals are the desktop
// suite's job, and SwiftShader can't afford bloom or the volumetric raymarch
// on a phone viewport (heavy frames coarsen the synthesized joystick drags)
await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&buildms=25&post=0&vclouds=0`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
const W = phone.viewport.width, H = phone.viewport.height;
const CX = W / 2, CY = H / 2;

// -- detection & layout ------------------------------------------------------
check(await page.evaluate('NMS.isTouch'), 'touch mode detected');
check((await page.evaluate('document.getElementById("hint").textContent')).includes('pinch'),
  'touch hints shown');
check(await page.evaluate('document.getElementById("touch-ui").classList.contains("hidden")'),
  'joystick hidden in space');
await page.waitForFunction('window.NMS.idle()', null, { timeout: 150000 });
await page.screenshot({ path: `${OUT}/phone-01-space.png` });

// -- one-finger drag = look ---------------------------------------------------
const q0 = await page.evaluate('NMS.quat()');
await dragTouch(CX - 120, CY, CX + 120, CY + 40);
const q1 = await page.evaluate('NMS.quat()');
check(Math.abs(q0[0] - q1[0]) + Math.abs(q0[1] - q1[1]) + Math.abs(q0[3] - q1[3]) > 0.01,
  'drag rotates the view');

// -- pinch = fly --------------------------------------------------------------
await page.evaluate('NMS.teleport(0, 2.2)');
const p0 = await page.evaluate('NMS.pos()');
const altBefore = await page.evaluate('NMS.alt()');
await pinch(CX, CY, 90, 360);
await sleep(1300);
const p1 = await page.evaluate('NMS.pos()');
const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
check(d > 150, `pinch-out flies forward (moved ${d.toFixed(0)} m)`);
const altAfter = await page.evaluate('NMS.alt()');
check(altAfter < altBefore * 0.85,
  `altitude dropped toward planet (${(altBefore / 1000).toFixed(0)} → ${(altAfter / 1000).toFixed(0)} km)`);

// -- tap a planet = travel ----------------------------------------------------
await page.evaluate('NMS.teleport(0, 6)');
// settle first: a tap must not straddle the post-teleport chunk-build stalls
try {
  await page.waitForFunction('window.NMS.idle()', null, { timeout: 120000 });
} catch { console.warn('tap-settle timeout (continuing)'); }
await sleep(300);
await page.evaluate(`window.__evt = [];
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    window.addEventListener(t, (e) => window.__evt.push(
      [t, e.pointerId, Math.round(e.clientX), Math.round(e.clientY), Math.round(performance.now())]), true);
  }`);
await tap(CX, CY);                       // the planet fills the view center
await sleep(400);
const tapState = await page.evaluate('NMS.state');
check(tapState === 'flyto', 'tap on planet starts fly-to');
if (tapState !== 'flyto') {
  console.log('  debug __lastClick:', JSON.stringify(await page.evaluate('window.__lastClick || null')));
  console.log('  debug events:', JSON.stringify(await page.evaluate('window.__evt')));
}
await page.evaluate('NMS.teleport(0, 2.2)');   // cancel via teleport

// -- walking with the virtual joystick ----------------------------------------
await page.evaluate('NMS.land(0)');
await sleep(300);
check(!(await page.evaluate('document.getElementById("touch-ui").classList.contains("hidden")')),
  'joystick visible when walking');
try {
  await page.waitForFunction('window.NMS.idle()', null, { timeout: 150000 });
} catch { console.warn('surface settle timeout (continuing)'); }
await page.screenshot({ path: `${OUT}/phone-02-surface.png` });

const joy = await rectOf('#joystick');
const w0 = await page.evaluate('NMS.pos()');
await touch('touchStart', [{ x: joy.x, y: joy.y, id: 1 }]);
await touch('touchMove', [{ x: joy.x, y: joy.y - 30, id: 1 }]);
await sleep(1200);
// speed-based check is fps-independent (SwiftShader clamps dt hard)
const stickSpeed = await page.evaluate('NMS.walkSpeed()');
await sleep(1200);
await touch('touchEnd', []);
const w1 = await page.evaluate('NMS.pos()');
const walked = Math.hypot(w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]);
check(stickSpeed > 3, `joystick drives the walker (speed ${stickSpeed.toFixed(1)} m/s)`);
check(walked > 1.2, `walker actually moved (${walked.toFixed(1)} m)`);

// -- jump button ---------------------------------------------------------------
const jumpBtn = await rectOf('#btn-jump');
await touch('touchStart', [{ x: jumpBtn.x, y: jumpBtn.y, id: 1 }]);
await sleep(80);
await touch('touchEnd', []);
let maxAlt = 0;
for (let i = 0; i < 14; i++) {
  maxAlt = Math.max(maxAlt, await page.evaluate('NMS.alt()'));
  await sleep(50);
}
check(maxAlt > 2.3, `jump button jumps (peak ${maxAlt.toFixed(2)} m)`);

// -- take-off button -------------------------------------------------------------
const toBtn = await rectOf('#btn-takeoff');
await tap(toBtn.x, toBtn.y);
await sleep(200);
const st = await page.evaluate('NMS.state');
check(st === 'takeoff' || st === 'space', `take-off button lifts off (state=${st})`);
try {
  // the 1.5 s tween needs many frames; SwiftShader fps makes that wall-clock slow
  await page.waitForFunction('window.NMS.state === "space"', null, { timeout: 90000 });
  check(await page.evaluate('document.getElementById("touch-ui").classList.contains("hidden")'),
    'joystick hides after take-off');
} catch {
  check(false, 'take-off completed within 90 s');
}
await sleep(600);
await page.screenshot({ path: `${OUT}/phone-03-takeoff.png` });

console.log(errors.length || failed
  ? `DONE: ${failed} check failure(s), ${errors.length} page error(s)`
  : 'DONE — all touch checks passed, no page errors');
await browser.close();
server.close();
process.exit(errors.length || failed ? 1 : 0);
