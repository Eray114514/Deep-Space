// Targeted visual QA for the HALCYON first-person layer: cockpit view,
// interior walk, ramp. Boots the game, drives the new NMS.shipView API and
// captures screenshots.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const OUT = 'screenshots/halcyon';
await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.error('PAGEERROR:', String(e).split('\n')[0]); });
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 300)); });

await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&post=0&farflora=0&buildms=25`);
await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
console.log('booted');

async function settle(ms = 1200) { await page.waitForTimeout(ms); }
async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`✓ ${name}`);
}

// --- third person (formation) reference
await settle(800);
await shot('01-chase');

// --- cockpit: press V, wait, capture
await page.keyboard.press('KeyV');
await settle(1500);
const cockpit = await page.evaluate(() => ({
  mode: window.NMS.shipViewState?.().viewMode,
  state: window.NMS.state,
}));
console.log('cockpit:', JSON.stringify(cockpit));
await shot('02-cockpit');

// --- stand up into the interior (F)
await page.keyboard.press('KeyF');
await settle(3000);
const walkState = await page.evaluate(() => ({
  mode: window.NMS.shipViewState?.().viewMode,
  shipwalk: window.NMS.shipViewState?.().shipwalk,
  state: window.NMS.state,
  pos: window.NMS.shipViewState?.().walkPos,
}));
console.log('shipwalk:', JSON.stringify(walkState));
await shot('03-interior-hold');

// --- walk forward through the corridor toward the cockpit
for (let i = 0; i < 10; i++) { await page.keyboard.down('KeyW'); await page.waitForTimeout(120); await page.keyboard.up('KeyW'); }
await settle(600);
await shot('04-interior-corridor');

// --- sit back down (teleport near seat first for determinism)
await page.evaluate(() => window.NMS.shipViewDebug?.teleportNearSeat?.());
await settle(300);
await page.keyboard.press('KeyF');
await settle(12000); // dt clamps to 0.1s: 0.8s anim needs ~8 sim frames; SwiftShader at ~1fps needs ~8s wall time
const backInSeat = await page.evaluate(() => ({
  mode: window.NMS.shipViewState?.().viewMode,
  shipwalk: window.NMS.shipViewState?.().shipwalk,
  state: window.NMS.state,
}));
console.log('back in seat:', JSON.stringify(backInSeat));
await shot('05-back-in-seat');

// --- land, board through the ramp, capture the hold
await page.evaluate('NMS.land(0)');
await page.waitForFunction('NMS.state === "walk"', null, { timeout: 60000 });
await settle(1500);
await page.evaluate('NMS.board()');
await page.waitForFunction('NMS.state === "shipwalk"', null, { timeout: 30000 });
await settle(1500);
const boarded = await page.evaluate(() => ({
  state: window.NMS.state,
  shipwalk: window.NMS.shipViewState?.().shipwalk,
  ramp: window.NMS.shipViewState?.().rampT,
  pos: window.NMS.shipViewState?.().walkPos,
}));
console.log('boarded:', JSON.stringify(boarded));
await shot('06-boarded-hold');

// --- open the ramp and look aft
await page.evaluate(() => window.NMS.shipViewDebug?.teleportNearRamp?.());
await settle(400);
await page.keyboard.press('KeyF');   // toggle ramp open
await settle(2500);
const ramp = await page.evaluate(() => ({
  rampT: window.NMS.shipViewState?.().rampT,
  rampTarget: window.NMS.shipViewState?.().rampTarget,
}));
console.log('ramp:', JSON.stringify(ramp));
await shot('07-ramp-open');

// --- exit back to the surface
await page.keyboard.press('KeyE');
await page.waitForFunction('NMS.state === "walk"', null, { timeout: 30000 });
await settle(1500);
console.log('exited, state =', await page.evaluate('NMS.state'));
await shot('08-exited-surface');

console.log(errors.length ? `DONE: ${errors.length} page error(s)` : 'DONE - no page errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
