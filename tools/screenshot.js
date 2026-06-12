// Headless visual test: boots the universe in headless Chromium (SwiftShader
// WebGL), drives the in-page NMS debug API through real exploration scenarios
// and saves screenshots of each. `npm run shots` (env: SEED=..., SHOTS=...)

import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';

const SEED = process.env.SEED || 'EUCLID';
const OUT = process.env.OUT || 'screenshots';
const ONLY = process.env.SHOTS ? process.env.SHOTS.split(',') : null;

await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader-webgl',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.error('PAGEERROR:', String(e).split('\n')[0]); });
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 300)); });

console.log(`seed=${SEED} → http://127.0.0.1:${port}`);
await page.goto(`http://127.0.0.1:${port}/?seed=${encodeURIComponent(SEED)}&nolock=1&buildms=30`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });

async function shot(name, timeout = 150000) {
  if (ONLY && !ONLY.some((o) => name.includes(o))) return;
  try {
    await page.waitForFunction('window.NMS.idle()', null, { timeout });
  } catch {
    console.warn(`${name}: settle timeout (continuing)`);
  }
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const stats = await page.evaluate('window.NMS.stats()');
  console.log(`✓ ${name}  [${stats.calls} draws, ${(stats.tris / 1e6).toFixed(2)}Mtri, ${stats.chunks} chunks, alt=${Math.round(stats.alt)}]`);
}

const planets = await page.evaluate('window.NMS.planets()');
console.log('system:', planets.map((p) => `${p.i}:${p.type}${p.isMoon ? '(moon)' : ''}`).join(' '));

// 1. the spawn vista: sun, sister planets, stars
await shot('01-space-vista');

// 2..4: one planet from approach to low flight
await page.evaluate('NMS.teleport(0, 2.2)');
await shot('02-approach');
await page.evaluate('NMS.teleport(0, 0.45)');
await shot('03-orbit');
await page.evaluate('NMS.teleport(0, 0.05, {horizon: true})');
await shot('04-low-flight');

// 5..6: standing on the surface
await page.evaluate('NMS.land(0)');
await shot('05-surface');
await page.evaluate('NMS.lookYaw(150)');
await shot('06-surface-b');

// 7: consistency — the very same face of the same planet, far then near
await page.evaluate('NMS.teleport(0, 3.0)');
await shot('07-consistency-far');
await page.evaluate('NMS.teleport(0, 0.3)');
await shot('07-consistency-near');

// 8: every other body in the system, from orbit
for (const p of planets) {
  if (p.i === 0) continue;
  await page.evaluate(`NMS.teleport(${p.i}, 1.5)`);
  await shot(`08-${String(p.i).padStart(2, '0')}-${p.type}${p.isMoon ? '-moon' : ''}`);
}

// 9: surface of a second planet of a different type
const alt = planets.find((p) => p.type !== planets[0].type && !p.isMoon);
if (alt) {
  await page.evaluate(`NMS.land(${alt.i})`);
  await shot(`09-surface-${alt.type}`);
}

// 10: the real landing flow — low orbit, then the animated descent into walk
const dry = planets.find((p) => !p.hasLiquid && !p.isMoon) || planets[0];
await page.evaluate(`NMS.teleport(${dry.i}, 0.003)`);   // a few hundred metres up
try {
  await page.waitForTimeout(800);   // landing needs no settle, just the prompt range
  await page.evaluate('NMS.tryLand()');
  await page.waitForFunction('window.NMS.state === "walk"', null, { timeout: 60000 });
  await shot(`10-landed-${dry.type}`);
} catch (e) {
  errors.push('landing flow failed: ' + e);
  console.error('landing flow failed');
}

// 11: warp to a neighbouring star system
try {
  await page.evaluate('NMS.takeoff()');
  // the 1.5 s tween can take ~20 s of wall time under SwiftShader build load
  await page.waitForFunction('window.NMS.state === "space"', null, { timeout: 60000 });
  const target = await page.evaluate('NMS.warpToStar()');   // state flips to 'warp' synchronously
  console.log('warping to', target);
  // catch the flight at full burn: streaks, fov stretch, stars rushing past
  await page.waitForFunction('window.NMS.warp() > 0.85', null, { timeout: 90000 });
  await page.screenshot({ path: `${OUT}/11a-warp-flight.png` });
  console.log('✓ 11a-warp-flight (mid-burn)');
  await page.waitForFunction('window.NMS.state === "space"', null, { timeout: 150000 });
  await page.waitForTimeout(800);
  await shot('11-warp-arrival');
} catch (e) {
  errors.push('warp flow failed: ' + e);
  console.error('warp flow failed:', String(e).split('\n')[0]);
}

// 12: a dot in the sky is a real place — fly toward it manually (no warp)
// and its solar system must materialize around it
try {
  const stars = await page.evaluate('NMS.nearStars()');
  const target = stars[0];
  const myPos = await page.evaluate('NMS.pos()');
  const wp = [0, 1, 2].map((i) => myPos[i] + (target.pos[i] - myPos[i]) * 0.85);
  await page.evaluate(`NMS.setPosition(${wp[0]}, ${wp[1]}, ${wp[2]}, ${target.pos[0]}, ${target.pos[1]}, ${target.pos[2]})`);
  await page.waitForFunction(`window.NMS.system().id === ${JSON.stringify(target.id)}`, null, { timeout: 20000 });
  console.log(`✓ manual approach: system swapped to ${target.id} without warping`);
  await shot('12-manual-approach');
} catch (e) {
  errors.push('manual approach failed: ' + e);
  console.error('manual approach failed:', String(e).split('\n')[0]);
}

console.log(errors.length ? `DONE WITH ${errors.length} PAGE ERROR(S)` : 'DONE — no page errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
