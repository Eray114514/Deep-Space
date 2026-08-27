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
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};
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
const chasePose = await page.evaluate(() => ({
  p: NMS._internals.ship.group.position.toArray(),
  q: NMS._internals.ship.group.quaternion.toArray(),
}));
await page.keyboard.press('KeyV');
await page.waitForFunction(() => {
  const { viewBlend } = NMS.shipViewState();
  return viewBlend > 0.04 && viewBlend < 0.96;
}, null, { timeout: 15000 });
const viewMid = await page.evaluate(() => ({
  blend: NMS.shipViewState().viewBlend,
  p: NMS._internals.ship.group.position.toArray(),
}));
await page.waitForFunction('NMS.shipViewState().viewBlend >= 0.999', null, { timeout: 30000 });
await settle(300);
const cockpit = await page.evaluate(() => ({
  mode: window.NMS.shipViewState?.().viewMode,
  blend: window.NMS.shipViewState?.().viewBlend,
  state: window.NMS.state,
  p: NMS._internals.ship.group.position.toArray(),
  glass: (() => {
    const mesh = NMS._internals.ship.group.getObjectByName('canopy-glazing');
    return {
      exists: !!mesh,
      visible: mesh?.visible,
      cover: mesh?.material?.uniforms?.uCover?.value,
      envGain: mesh?.material?.uniforms?.uEnvGain?.value,
    };
  })(),
}));
console.log('cockpit:', JSON.stringify(cockpit));
const distance3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
check(viewMid.blend > 0 && viewMid.blend < 1
    && distance3(chasePose.p, viewMid.p) > 0.5
    && distance3(viewMid.p, cockpit.p) > 0.5,
  `V uses one continuous chase-to-cockpit path (mid blend ${viewMid.blend.toFixed(3)})`);
check(cockpit.glass.exists && cockpit.glass.visible
    && cockpit.glass.cover >= 0.18 && cockpit.glass.envGain >= 0.8,
  `canopy glazing is rendered with bright-scene coverage ${JSON.stringify(cockpit.glass)}`);
await shot('02-cockpit');

// A flight mouse gesture feeds the reference-style damped angular controller.
// The navigation attitude changes over time and the cockpit frame acquires a
// small relative sway, instead of the input cutting the universe camera alone.
const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.5;
const steerBefore = await page.evaluate('NMS._internals.nav.quat.toArray()');
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'left' });
await page.mouse.move(cx + 150, cy - 45, { steps: 4 });
await page.mouse.up({ button: 'left' });
await settle(1800);
const steering = await page.evaluate((before) => {
  const THREE = NMS._THREE;
  const { nav, camera, ship, spaceCtl } = NMS._internals;
  const q0 = new THREE.Quaternion().fromArray(before);
  const cockpitRelative = camera.quaternion.clone().invert().multiply(ship.group.quaternion);
  return {
    attitude: q0.angleTo(nav.quat),
    angularSpeed: spaceCtl.angularVelocity.length(),
    cockpitMotion: cockpitRelative.angleTo(new THREE.Quaternion()),
  };
}, steerBefore);
check(steering.attitude > 0.003 && steering.angularSpeed > 0.01,
  `cockpit steering builds damped ship angular velocity (${steering.attitude.toFixed(3)} rad, ${steering.angularSpeed.toFixed(3)} rad/s)`);
check(steering.cockpitMotion > 0.0005,
  `cockpit frame supplies physical turn feedback (${steering.cockpitMotion.toFixed(4)} rad relative motion)`);

// --- stand up into the interior (F)
await page.evaluate(() => {
  const { nav } = NMS._internals;
  nav.vel.set(0, 0, -60);
});
await page.keyboard.press('KeyF');
await page.waitForFunction('NMS.state === "shipwalk"');
const transitionStart = await page.evaluate(() => ({
  anchor: NMS._internals.shipView.anchorPos.toArray(),
  speed: NMS._internals.nav.vel.length(),
  foregroundOnly: NMS._internals.ship.foregroundOnly,
}));
await page.waitForFunction(() => {
  const { seatT } = NMS.shipViewState();
  return seatT > 0.06 && seatT < 0.94;
}, null, { timeout: 20000 });
const duringStand = await page.evaluate(() => {
  const { nav, shipView } = NMS._internals;
  return {
    state: NMS.state,
    seatT: NMS.shipViewState().seatT,
    anchor: shipView.anchorPos.toArray(),
    speed: nav.vel.length(),
  };
});
const cruiseDistance = Math.hypot(
  duringStand.anchor[0] - transitionStart.anchor[0],
  duringStand.anchor[1] - transitionStart.anchor[1],
  duringStand.anchor[2] - transitionStart.anchor[2],
);
check(duringStand.state === 'shipwalk' && duringStand.seatT > 0 && duringStand.seatT < 1,
  `F keeps the 0.8 s stand-up transition live (seatT=${duringStand.seatT.toFixed(3)})`);
check(transitionStart.foregroundOnly,
  'airborne F transition keeps the already-warmed foreground render variant');
check(cruiseDistance > 0.2 && Math.abs(duringStand.speed - transitionStart.speed) < 1e-6,
  `airborne hull cruises throughout stand-up (${cruiseDistance.toFixed(1)} m, ${duringStand.speed.toFixed(0)} m/s)`);
await page.waitForFunction('NMS.shipViewState().seatT >= 0.999', null, { timeout: 30000 });
await settle(500);
const walkState = await page.evaluate(() => ({
  mode: window.NMS.shipViewState?.().viewMode,
  shipwalk: window.NMS.shipViewState?.().shipwalk,
  state: window.NMS.state,
  pos: window.NMS.shipViewState?.().walkPos,
}));
console.log('shipwalk:', JSON.stringify(walkState));
await shot('03-interior-hold');

// Head-look changes only the local camera pose. The hull's universe attitude
// must remain the same while the standing player turns around inside it.
const hullBeforeLook = await page.evaluate('NMS._internals.ship.group.quaternion.toArray()');
await page.evaluate('NMS.lookYaw(95)');
await settle(1200);
const hullLook = await page.evaluate((before) => {
  const THREE = NMS._THREE;
  const q0 = new THREE.Quaternion().fromArray(before);
  const q1 = NMS._internals.ship.group.quaternion;
  return {
    angle: q0.angleTo(q1),
    walkYaw: NMS.shipViewState().walkYaw,
    speed: NMS._internals.nav.vel.length(),
  };
}, hullBeforeLook);
check(hullLook.angle < 1e-6,
  `interior head-look leaves hull attitude fixed (${hullLook.angle.toExponential(2)} rad)`);
check(Math.abs(hullLook.speed - transitionStart.speed) < 1e-6,
  `automatic cruise remains engaged after standing settles (${hullLook.speed.toFixed(0)} m/s)`);

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

console.log(errors.length || failures
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s)`
  : 'DONE - no page errors');
await browser.close();
server.close();
process.exit(errors.length || failures ? 1 : 0);
