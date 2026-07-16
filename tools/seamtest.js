// The seamlessness test: approach and take off from a planet and PROVE the
// terrain never visibly jumps.
//
// Phase 1 — static shimmer: with all scenery-in-motion frozen (?freeze=1),
//   park at ~15 altitudes from high orbit down to head height. After the
//   build queue drains and morphs relax, two frames taken 0.5 s apart must
//   be pixel-identical: ANY residual difference is LOD activity.
// Phase 2 — descent counters: fly the whole column down with no settling.
//   The engine counts every unmorphed level change with its apparent size;
//   nothing bigger than ~4 px may ever swap hard.
// Phase 3 — the real thing: land, take off, boost to orbit. Same counters.
//
// Usage: npm run seamtest   (env: SEED=..., OUT=screenshots/seam)

import { mkdir, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { chromium } from 'playwright';

const SEED = process.env.SEED || 'EUCLID';
const OUT = process.env.OUT || 'screenshots/seam';
const DIFF_TOLERANCE = 50;     // pixels allowed to change between static frames
const PX_LIMIT = 4.5;          // biggest allowed hard-swap apparent size

await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath(),
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.error('PAGEERROR:', String(e).split('\n')[0]); });

await page.goto(`http://127.0.0.1:${port}/?seed=${encodeURIComponent(SEED)}&nolock=1&freeze=1&buildms=120`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
// the frame must contain nothing but the world: no HUD, no labels, no ship
await page.addStyleTag({ content: 'body *:not(canvas){visibility:hidden!important} canvas{visibility:visible!important}' });
await page.evaluate('NMS.shipVisible(false)');

function diffPNG(bufA, bufB) {
  const a = PNG.sync.read(bufA), b = PNG.sync.read(bufB);
  const out = new PNG({ width: a.width, height: a.height });
  let n = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > max) max = d;
    const bad = d > 8;
    if (bad) n++;
    out.data[i] = bad ? 255 : a.data[i] >> 1;
    out.data[i + 1] = bad ? 40 : a.data[i + 1] >> 1;
    out.data[i + 2] = bad ? 40 : a.data[i + 2] >> 1;
    out.data[i + 3] = 255;
  }
  return { n, max, out };
}

async function settle(timeout = 240000) {
  try {
    await page.waitForFunction('window.NMS.idle()', null, { timeout });
  } catch { console.warn('  settle timeout (continuing)'); }
  await page.waitForTimeout(1800);   // let the last geomorphs relax
}

// ---- phase 1: static shimmer ------------------------------------------------
const FACTORS = [2.0, 1.2, 0.7, 0.4, 0.22, 0.12, 0.065, 0.035, 0.018, 0.009,
  0.0045, 0.002, 0.0008, 0.0003, 0.0001];
let failed = 0;
console.log(`phase 1 — static shimmer at ${FACTORS.length} altitudes (seed=${SEED})`);
for (const f of FACTORS) {
  await page.evaluate(`NMS.teleport(0, ${f})`);
  await settle();
  const a = await page.screenshot();
  await page.waitForTimeout(500);
  const b = await page.screenshot();
  const { n, max, out } = diffPNG(a, b);
  const alt = await page.evaluate('Math.round(window.NMS.alt())');
  const tag = `alt ${String(alt).padStart(9)} m  (factor ${f})`;
  if (n > DIFF_TOLERANCE) {
    failed++;
    await writeFile(`${OUT}/shimmer-${f}-a.png`, a);
    await writeFile(`${OUT}/shimmer-${f}-diff.png`, PNG.sync.write(out));
    console.error(`✗ ${tag}: ${n} px changed while parked (max Δ${max}) — saved diff`);
  } else {
    console.log(`✓ ${tag}: static (${n} px, max Δ${max})`);
  }
}

// ---- phase 2: continuous descent, engine counters ---------------------------
console.log('phase 2 — continuous descent (no settling)');
await page.evaluate('NMS.teleport(0, 2.2)');
await settle(120000);
await page.evaluate('NMS.lodReset()');
const DESC = [];
for (let i = 0; i <= 30; i++) DESC.push(2.2 * Math.pow(0.0001 / 2.2, i / 30));
for (const f of DESC) {
  await page.evaluate(`NMS.teleport(0, ${f})`);
  await page.waitForTimeout(350);
}
await settle();
let s = await page.evaluate('NMS.lod()');
console.log(`  descent: hardSwaps=${s.hardSwaps} (worst ${s.worstSwapPx.toFixed(1)}px), ` +
  `instantCollapses=${s.instantCollapses} (worst ${s.worstCollapsePx.toFixed(1)}px)`);
if (s.hardSwaps > 0 || s.worstCollapsePx > PX_LIMIT) { failed++; console.error('✗ descent popped'); }
else console.log('✓ descent seamless');

// ---- phase 3: land, take off for real, boost to orbit -----------------------
console.log('phase 3 — landing + takeoff flow');
await page.evaluate('NMS.land(0)');
await settle();
await page.evaluate('NMS.lodReset()');
await page.evaluate('NMS.takeoff()');
try {
  await page.waitForFunction('window.NMS.state === "space"', null, { timeout: 150000 });
} catch { console.warn('  takeoff state timeout'); }
for (const f of [...DESC].reverse()) {
  await page.evaluate(`NMS.teleport(0, ${f})`);
  await page.waitForTimeout(300);
}
await settle(120000);
s = await page.evaluate('NMS.lod()');
console.log(`  takeoff: hardSwaps=${s.hardSwaps} (worst ${s.worstSwapPx.toFixed(1)}px), ` +
  `instantCollapses=${s.instantCollapses} (worst ${s.worstCollapsePx.toFixed(1)}px)`);
if (s.hardSwaps > 0 || s.worstCollapsePx > PX_LIMIT) { failed++; console.error('✗ takeoff popped'); }
else console.log('✓ takeoff seamless');

console.log(failed ? `SEAM TEST: ${failed} FAILURE(S)` : 'SEAM TEST: all seamless');
await browser.close();
server.close();
process.exit(failed || errors.length ? 1 : 0);
