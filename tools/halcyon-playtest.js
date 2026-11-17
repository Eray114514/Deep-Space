// Targeted visual QA for the HALCYON first-person layer: cockpit view,
// interior walk, ramp. Boots the game, drives the new NMS.shipView API and
// captures screenshots.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser } from './browser.js';

const gpu = process.argv.includes('--gpu');
const OUT = 'screenshots/halcyon';
await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const browser = gpu ? await launchHardwareBrowser() : await launchBrowser();
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

// --- face aft again (the head-look check turned the walker 95 deg), then
// walk out of the flight deck and down the corridor
await page.evaluate(() => { NMS._internals.shipView.walkYaw = Math.PI; });
for (let i = 0; i < 10; i++) { await page.keyboard.down('KeyW'); await page.waitForTimeout(120); await page.keyboard.up('KeyW'); }
await settle(600);
// the flight-deck door must actually let the walker through (the rooms are
// inset by the walker's radius, so a too-thin doorway room seals the deck)
const walked = await page.evaluate(() => NMS.shipViewState().walkPos);
check(walked && walked[2] > -5.0,
  `standing pilot walks from the flight deck into the mid-deck (z ${walked?.[2]?.toFixed?.(2)})`);
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

// --- seamless 3rd-person landing (one unbroken shot -> cockpit seat), manual
// cabin exit, ramp walkout + weapon draw, ramp walk-in + auto-holster, and
// 3rd/1st-person liftoff.
await page.evaluate(() => {
  const THREE = NMS._THREE;
  const p = NMS._planet(0);
  const v = new THREE.Vector3();
  let best = [1, 0, 0];
  let bestScore = -Infinity;
  for (let k = 0; k < 2400; k++) {
    const y = 1 - (2 * (k + 0.5)) / 2400;
    const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
    v.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
    const h = p.height(v, p.fullMaxFreq);
    if (p.hasLiquid && h < p.seaLevel + 18) continue;
    const sun = v.dot(p.sunDirLocal);
    if (sun < 0.25) continue;
    const score = sun * 10 - Math.abs(h - (p.seaLevel || 0)) * 0.002;
    if (score > bestScore) { bestScore = score; best = v.toArray(); }
  }
  window.__dryLandingDir = best;
  const dirVec = new THREE.Vector3(...best);
  const groundR = p.surfaceRadius(dirVec);
  NMS.teleport(0, (groundR + 145 - p.R) / p.R, { dir: best, horizon: true, pitch: -0.14 });
  NMS.shipViewDebug.setViewMode('chase');
});
await settle(600);

// Install an in-page per-frame camera continuity monitor in planet-local space
// (subtracting solar orbit + axial rotation) across landing.
await page.evaluate(() => {
  const THREE = NMS._THREE;
  const { nav, camera } = NMS._internals;
  const p = NMS._planet(0);
  const localPos = () => p.worldPositionToLocal(nav.pos.clone().add(camera.position), new THREE.Vector3());
  const localQuat = () => p.frameOrientation.clone().invert().multiply(camera.quaternion).normalize();
  let prevP = localPos();
  let prevQ = localQuat();
  const trace = { frames: 0, maxPosStepLocal: 0, maxAngRadPerFrame: 0, states: [] };
  window.__camTrace = trace;
  window.__camTraceActive = true;
  const step = () => {
    if (!window.__camTraceActive) return;
    const curP = localPos();
    const curQ = localQuat();
    trace.frames++;
    trace.maxPosStepLocal = Math.max(trace.maxPosStepLocal, curP.distanceTo(prevP));
    trace.maxAngRadPerFrame = Math.max(trace.maxAngRadPerFrame, curQ.angleTo(prevQ));
    if (trace.states.at(-1) !== NMS.state) trace.states.push(NMS.state);
    prevP = curP;
    prevQ = curQ;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});

await page.keyboard.press('KeyL');
check(await page.evaluate(() => NMS.state === 'landing'), 'KeyL from 3rd-person chase enters seamless landing');
await page.waitForFunction('NMS._internals.ship.parkAmt > 0.52 || NMS.state === "landed"', null, { timeout: 45000 });
await shot('06-landing-chase-sweep');
await page.waitForFunction('NMS.state === "landed"', null, { timeout: 60000 });
await settle(400);
const landingTrace = await page.evaluate(() => {
  window.__camTraceActive = false;
  return {
    trace: window.__camTrace,
    state: NMS.state,
    shipView: NMS.shipViewState(),
    weapon: NMS.surfaceWeaponState(),
    hudWalkClass: document.body.classList.contains('ui-walk'),
  };
});
console.log('landed from chase:', JSON.stringify(landingTrace));
check(landingTrace.state === 'landed' && landingTrace.shipView.viewMode === 'cockpit',
  `3rd-person landing finishes seated in 1st-person cockpit (${landingTrace.state}, ${landingTrace.shipView.viewMode})`);
check(landingTrace.trace.maxAngRadPerFrame < 0.45 && landingTrace.trace.maxPosStepLocal < 28,
  `zero camera cut across 3rd-person landing -> cockpit glide (max dPos=${landingTrace.trace.maxPosStepLocal.toFixed(2)} m, max dAngle=${landingTrace.trace.maxAngRadPerFrame.toFixed(3)} rad)`);
check(!landingTrace.weapon.rendered && landingTrace.weapon.equip === 'holstered' && !landingTrace.hudWalkClass,
  `rifle stays holstered and hidden while seated in landed ship ${JSON.stringify(landingTrace.weapon)}`);
await shot('07-landed-cockpit');

// --- leave pilot's chair manually (F) -> verify no-gun-in-ship -> open ramp (F) -> walk out
await page.keyboard.press('KeyF');
await page.waitForFunction('NMS.state === "shipwalk" && NMS.shipViewState().seatT >= 0.999', null, { timeout: 30000 });
await page.keyboard.press('KeyG');
await page.mouse.down({ button: 'left' });
await settle(250);
await page.mouse.up({ button: 'left' });
const cabinWeaponCheck = await page.evaluate(() => ({
  weapon: NMS.surfaceWeaponState(),
  hudWalk: document.body.classList.contains('ui-walk'),
  hudShipwalk: document.body.classList.contains('ui-shipwalk'),
}));
check(!cabinWeaponCheck.weapon.rendered && cabinWeaponCheck.weapon.equip === 'holstered'
    && !cabinWeaponCheck.hudWalk && cabinWeaponCheck.hudShipwalk,
  `rifle cannot be drawn or fired inside the ship cabin ${JSON.stringify(cabinWeaponCheck)}`);

// Walk aft to the cargo ramp (walkYaw = Math.PI faces +Z aft) and press F to open it.
await page.evaluate(() => {
  const sv = NMS._internals.shipView;
  sv.walkPos.set(0, 0, 4.6);
  sv.walkYaw = Math.PI;
  sv.walkPitch = -0.08;
});
await settle(250);
await page.keyboard.press('KeyF');
await page.waitForFunction('NMS.shipViewState().rampWalkable', null, { timeout: 30000 });
await shot('08-cabin-ramp-open');

// Walk straight down the sloped cargo ramp onto the planet surface!
const localBeforeWalkout = await page.evaluate(() => {
  const THREE = NMS._THREE;
  const p = NMS._planet(0);
  return p.worldPositionToLocal(NMS._internals.nav.pos, new THREE.Vector3()).toArray();
});
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyW');
await page.waitForFunction('NMS.state === "walk"', null, { timeout: 30000 });
// Keep walking a moment off the ramp foot, then stop and let the PAC-9 finish drawing.
await settle(350);
await page.keyboard.up('KeyW');
await page.keyboard.up('ShiftLeft');
const drawDuringExit = await page.evaluate('NMS.surfaceWeaponState()');
check(drawDuringExit.rendered && (drawDuringExit.equip === 'drawing' || drawDuringExit.equip === 'ready'),
  `stepping off the ramp onto the planet triggers the PAC-9 draw animation ${JSON.stringify(drawDuringExit)}`);
await page.waitForFunction(() => {
  const w = NMS.surfaceWeaponState();
  return w.rendered && w.equip === 'ready';
}, null, { timeout: 25000 });
const afterWalkout = await page.evaluate(() => {
  const THREE = NMS._THREE;
  const p = NMS._planet(0);
  return {
    localPos: p.worldPositionToLocal(NMS._internals.nav.pos, new THREE.Vector3()).toArray(),
    shipGroupLen: NMS._internals.ship.group.position.length(),
    weapon: NMS.surfaceWeaponState(),
    hudWalk: document.body.classList.contains('ui-walk'),
  };
});
check(distance3(localBeforeWalkout, afterWalkout.localPos) < 16 && afterWalkout.shipGroupLen > 8 && afterWalkout.hudWalk,
  `walking down the cargo ramp hands off seamlessly to surface walk (${distance3(localBeforeWalkout, afterWalkout.localPos).toFixed(2)} m walked, ship ${afterWalkout.shipGroupLen.toFixed(1)} m behind)`);
// Turn around on foot to frame the parked ship with open cargo ramp + drawn PAC-9!
await page.evaluate('NMS.faceShip()');
await settle(250);
await shot('09-walked-out-rifle-drawn');

// Test manual G holster/draw toggle on foot before re-boarding.
await page.keyboard.press('KeyG');
await page.waitForFunction('NMS.surfaceWeaponState().equip === "holstered"', null, { timeout: 15000 });
await page.keyboard.press('KeyG');
await page.waitForFunction(() => {
  const w = NMS.surfaceWeaponState();
  return w.rendered && w.equip === 'ready';
}, null, { timeout: 25000 });
check(true, 'G key toggles manual holster and draw on foot');

// --- step to the ramp foot facing into the hold, walk back up -> auto-holster in cabin!
await page.evaluate(() => {
  const THREE = NMS._THREE;
  const { ship, walkCtl, nav } = NMS._internals;
  const planet = walkCtl.planet;
  const tip = NMS._internals.shipView.rampTipLocal();
  const footShipLocal = new THREE.Vector3(0, 0, tip.z + 0.85);
  const worldTarget = footShipLocal.applyQuaternion(ship.parkedLocalQuat).add(ship.parkedLocal);
  const dir = worldTarget.clone().normalize();
  const groundR = planet.surfaceRadius(dir);
  walkCtl.posLocal.copy(dir).multiplyScalar(groundR + walkCtl.eyeHeight);
  const forwardToHold = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.parkedLocalQuat)
    .projectOnPlane(dir).normalize();
  walkCtl.enter(planet, walkCtl.posLocal.clone(), forwardToHold);
  planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
  nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);
});
await settle(250);
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyW');
await page.waitForFunction('NMS.state === "shipwalk"', null, { timeout: 30000 });
await page.keyboard.up('KeyW');
await page.keyboard.up('ShiftLeft');
const rightAfterRampEntry = await page.evaluate('NMS.surfaceWeaponState()');
check(rightAfterRampEntry.equip === 'holstering' || rightAfterRampEntry.equip === 'holstered',
  `stepping onto the ramp into the cabin automatically holsters the rifle ${JSON.stringify(rightAfterRampEntry)}`);
await page.waitForFunction('!NMS.surfaceWeaponState().rendered && NMS.surfaceWeaponState().equip === "holstered"', null, { timeout: 20000 });
await shot('10-walked-in-auto-holster');

// --- sit in pilot's seat (F), toggle V to 3rd-person chase on the pad, launch (Space)!
await page.evaluate(() => window.NMS.shipViewDebug?.teleportNearSeat?.());
await settle(250);
await page.keyboard.press('KeyF');
await page.waitForFunction('NMS.state === "landed"', null, { timeout: 30000 });
await settle(300);
await page.keyboard.press('KeyV');
await page.waitForFunction('NMS.shipViewState().viewMode === "chase" && NMS.shipViewState().parkedCamBlend >= 0.99', null, { timeout: 25000 });
await shot('11-landed-chase');

await page.keyboard.press('Space');
check(await page.evaluate(() => NMS.state === 'takeoff' && NMS.shipViewState().viewMode === 'chase'),
  'Space launches from parked 3rd-person chase view');
await settle(900);
await shot('12-takeoff-chase');
await page.waitForFunction('NMS.state === "space"', null, { timeout: 60000 });
check(await page.evaluate(() => NMS.state === 'space' && NMS.shipViewState().viewMode === 'chase'),
  '3rd-person takeoff hands off seamlessly to 3rd-person space flight');

// --- verify 1st-person cockpit landing AND 1st-person cockpit takeoff!
await page.evaluate(() => {
  const THREE = NMS._THREE;
  const p = NMS._planet(0);
  const dir = window.__dryLandingDir;
  const groundR = p.surfaceRadius(new THREE.Vector3(...dir));
  NMS.teleport(0, (groundR + 120 - p.R) / p.R, { dir, horizon: true, pitch: -0.12 });
  NMS.shipViewDebug.setViewMode('cockpit');
});
await settle(400);
await page.keyboard.press('KeyL');
check(await page.evaluate(() => NMS.state === 'landing' && NMS.shipViewState().viewMode === 'cockpit'),
  '1st-person cockpit landing stays in 1st-person cockpit');
await page.waitForFunction('NMS.state === "landed"', null, { timeout: 60000 });
check(await page.evaluate(() => NMS.shipViewState().viewMode === 'cockpit'),
  '1st-person landing settles directly in 1st-person cockpit');
await page.keyboard.press('Space');
check(await page.evaluate(() => NMS.state === 'takeoff' && NMS.shipViewState().viewMode === 'cockpit'),
  'Space launches directly from 1st-person cockpit');
await page.waitForFunction('NMS.state === "space"', null, { timeout: 60000 });
check(await page.evaluate(() => NMS.state === 'space' && NMS.shipViewState().viewMode === 'cockpit'),
  '1st-person takeoff hands off seamlessly to 1st-person cockpit flight');

console.log(errors.length || failures
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s)`
  : 'DONE - no page errors');
await browser.close();
server.close();
process.exit(errors.length || failures ? 1 : 0);
