// Focused regression for boarding, procedural audio unlock and RMB boost.
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

try {
  // SwiftShader is identified by the runtime auto-tier. Do not force a URL
  // quality here: this catches the adapter-detected cloud/profile handoff.
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&post=0&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  // A trusted keyboard gesture both unlocks WebAudio and invokes boarding.
  await page.evaluate('NMS.land(0)');
  await page.waitForTimeout(100);
  const cloudFallback = await page.evaluate(() => {
    const planet = NMS._internals.universe.system.planets[0];
    return {
      quality: NMS.stats().quality,
      coverage: planet.cloudCoverage,
      volumeExists: !!planet.volCloudMesh,
      volumeVisible: planet.volCloudMesh?.visible,
      rayQuality: planet.volCloudMat?.uniforms?.uQuality?.value,
      analyticVisible: planet.cloudMesh?.visible,
      upperVisible: planet.cloudMesh2?.visible,
      ok: planet.cloudCoverage <= 0.05 || (
        planet.volCloudMesh?.visible
        && planet.volCloudMat?.uniforms?.uQuality?.value === 0
        && !planet.cloudMesh?.visible
        && (!planet.cloudMesh2 || !planet.cloudMesh2.visible)
      ),
    };
  });
  check(cloudFallback.quality === 'auto-low' && cloudFallback.ok,
    `auto-low keeps the shared volumetric cloud field visible from the surface ${JSON.stringify(cloudFallback)}`);
  const surfaceWeaponVisibility = [];
  for (let index = 0; index < 4; index++) {
    await page.evaluate((slot) => NMS.surfaceWeapon(slot), index);
    await page.waitForFunction((slot) => NMS.surfaceWeaponState().index === slot,
      index, { timeout: 3000 });
    if (index === 3) {
      await page.waitForFunction(() => NMS.surfaceWeaponState().assetLoaded,
        null, { timeout: 5000 });
    }
    surfaceWeaponVisibility.push(await page.evaluate('NMS.surfaceWeaponState()'));
  }
  check(surfaceWeaponVisibility.every((weapon) => weapon.rendered && weapon.assetLoaded),
    `all four first-person weapons own an active foreground pass ${JSON.stringify(surfaceWeaponVisibility)}`);
  const initialShipDistance = await page.evaluate('NMS.shipDistance()');
  check(initialShipDistance < 46, `parked ship is in boarding range (${initialShipDistance.toFixed(1)} m)`);
  await page.keyboard.press('KeyE');
  check(['boarding', 'takeoff', 'space'].includes(await page.evaluate('NMS.state')),
    'E starts the board/takeoff sequence');
  await page.waitForFunction('NMS.state === "space"', null, { timeout: 30000 });
  check(await page.evaluate('NMS.stats().audio'), 'user gesture unlocks procedural WebAudio');

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const contextSuppressed = await page.evaluate(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    return !document.querySelector('canvas').dispatchEvent(event);
  });
  check(contextSuppressed, 'browser context menu is suppressed on the flight canvas');

  await page.waitForTimeout(500);
  const speedBefore = await page.evaluate('NMS._internals.nav.vel.length()');
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => window.shipHUD?.getTelemetry().speedRatio > 0.995,
    null, { timeout: 5000 });
  const duringBoost = await page.evaluate('NMS.stats().boost');
  const speedBoost = await page.evaluate('NMS._internals.nav.vel.length()');
  const boostGauge = await page.evaluate('shipHUD.getTelemetry()');
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
  const afterRelease = await page.evaluate('NMS.stats().boost');
  check(duringBoost > 0.65, `RMB drives boost state (${duringBoost.toFixed(2)})`);
  check(speedBoost > Math.max(speedBefore * 1.5, speedBefore + 100),
    `RMB materially accelerates ship (${speedBefore.toFixed(0)} -> ${speedBoost.toFixed(0)} m/s)`);
  check(boostGauge.speedRatio > 0.995
      && Math.abs(boostGauge.speedPointerY - boostGauge.speedTopY) < 0.5,
  `RMB reaches the physical governor and full gauge deflection (${boostGauge.speed.toFixed(0)} / ${boostGauge.speedLimit.toFixed(0)} m/s)`);
  check(afterRelease < duringBoost, 'RMB release clears boost cleanly');

  // Space is a discrete pulse even below the atmospheric boundary. It spends
  // one fixed fuel charge, moves immediately, then ends without leaving a
  // hidden cruise mode engaged.
  await page.evaluate(() => {
    const { universe, nav } = NMS._internals;
    const p = universe.system.planets[0];
    const THREE = NMS._THREE;
    const radial = p.localOffsetToWorld(new THREE.Vector3(1, 0, 0), new THREE.Vector3()).normalize();
    const position = p.posUniv.clone().addScaledVector(radial, p.R + p.atmoHeight * 0.5);
    const look = position.clone().addScaledVector(radial, 1000);
    NMS.setPosition(position.x, position.y, position.z, look.x, look.y, look.z);
    nav.vel.set(0, 0, 0);
  });
  await page.waitForTimeout(120);
  const pulseBefore = await page.evaluate(() => ({ alt: NMS.alt(), fuel: NMS.pulseFuel() }));
  await page.keyboard.press('Space');
  await page.waitForFunction('NMS.stats().pulseVisual > 0.25', null, { timeout: 5000 });
  const pulseDuring = await page.evaluate('NMS.stats().pulse');
  const pulseGauge = await page.evaluate('shipHUD.getTelemetry()');
  check(pulseGauge.speed > pulseGauge.speedLimit
      && pulseGauge.speedRatio === 1
      && Math.abs(pulseGauge.speedPointerY - pulseGauge.speedTopY) < 0.5,
  `pulse raises the numeric speed above the governor without over-driving the pointer (${pulseGauge.speed.toFixed(0)} > ${pulseGauge.speedLimit.toFixed(0)} m/s)`);
  // Wait for the simulation-owned burst state instead of assuming 620 ms of
  // wall time also contained the full 560 ms of rendered simulation time.
  await page.waitForFunction(() => !window.NMS.stats().pulse, null, { timeout: 5000 });
  const pulseAfter = await page.evaluate(() => ({
    alt: NMS.alt(), fuel: NMS.pulseFuel(), active: NMS.stats().pulse,
  }));
  check(pulseBefore.alt > 0 && pulseDuring,
    `Space pulse engages inside atmosphere (${Math.round(pulseBefore.alt)} m altitude)`);
  check(pulseAfter.alt > pulseBefore.alt + 70,
    `Space pulse produces a bounded forward displacement (${Math.round(pulseAfter.alt - pulseBefore.alt)} m)`);
  check(Math.abs((pulseBefore.fuel - pulseAfter.fuel) - 18) < 0.1 && !pulseAfter.active,
    `Space pulse spends one fuel charge and ends (${pulseBefore.fuel.toFixed(1)} -> ${pulseAfter.fuel.toFixed(1)})`);

  check(await page.evaluate(() => !document.getElementById('labels')
      && !document.getElementById('target-card')
      && document.querySelectorAll('.planet-label').length === 0),
  'normal space view contains no planet identifiers or target card');

  for (const [label, axis] of [
    ['north pole', [0, 1, 0]],
    ['south pole', [0, -1, 0]],
    ['equator', [1, 0, 0]],
  ]) {
    const startAlt = await page.evaluate((localAxis) => {
      const { universe, nav } = NMS._internals;
      const p = universe.planets()[0];
      const THREE = NMS._THREE;
      const radial = p.localOffsetToWorld(new THREE.Vector3(...localAxis), new THREE.Vector3()).normalize();
      const center = p.posUniv.clone();
      const position = center.clone().addScaledVector(radial, p.R + p.atmoHeight * 2.2);
      NMS.setPosition(position.x, position.y, position.z, center.x, center.y, center.z);
      const reference = Math.abs(radial.y) < 0.9
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
      const tangent = new THREE.Vector3().crossVectors(radial, reference).normalize();
      nav.vel.copy(radial).multiplyScalar(-2200).addScaledVector(tangent, 9000);
      return position.distanceTo(center) - p.R;
    }, axis);
    // Shader compilation and GPU scheduling can reduce the number of simulation
    // frames inside a fixed wall-time sleep. Observe the actual approach state.
    await page.waitForFunction(({ initialAltitude }) => {
      const { universe, nav } = window.NMS._internals;
      const p = universe.planets()[0];
      const THREE = window.NMS._THREE;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quat).normalize();
      const toCenter = p.posUniv.clone().sub(nav.pos).normalize();
      const pathError = nav.vel.lengthSq() > 1 ? nav.vel.angleTo(forward) * 180 / Math.PI : 0;
      return nav.pos.distanceTo(p.posUniv) - p.R < initialAltitude
        && pathError < 28 && forward.angleTo(toCenter) * 180 / Math.PI < 2;
    }, { initialAltitude: startAlt }, { timeout: 6000 });
    const result = await page.evaluate(() => {
      const { universe, nav } = NMS._internals;
      const p = universe.planets()[0];
      const THREE = NMS._THREE;
      const toCenter = p.posUniv.clone().sub(nav.pos).normalize();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quat).normalize();
      return {
        altitude: nav.pos.distanceTo(p.posUniv) - p.R,
        pathErrorDeg: nav.vel.lengthSq() > 1 ? nav.vel.angleTo(forward) * 180 / Math.PI : 0,
        aimErrorDeg: forward.angleTo(toCenter) * 180 / Math.PI,
      };
    });
    check(result.altitude < startAlt && result.pathErrorDeg < 28 && result.aimErrorDeg < 2,
      `${label} approach follows the crosshair without climbing (${Math.round(startAlt)} -> ${Math.round(result.altitude)} m, ${result.pathErrorDeg.toFixed(1)}° slip)`);
  }

  await page.evaluate('NMS.land(0)');
  const recalled = await page.evaluate('NMS.recallShip()');
  check(recalled && await page.evaluate('NMS.shipDistance()') < 180,
    'recall returns the ship to a nearby safe landing candidate');

  // Waiting from pause is a visible in-world fast-forward, not a clock jump
  // while the menu remains open.
  await page.keyboard.press('Escape');
  check(await page.locator('#pause-overlay').isVisible(), 'Escape opens the flight-computer pause surface');
  await page.locator('#wait-sunset-btn').click();
  await page.waitForFunction(() => document.getElementById('pause-overlay').classList.contains('hidden')
    && !document.getElementById('time-warp-indicator').classList.contains('hidden'));
  check((await page.evaluate('NMS.stats().timeScale')) > 60,
    'sunset command resumes play and engages accelerated ephemeris time');
  await page.waitForFunction(() => document.getElementById('time-warp-indicator').classList.contains('hidden'),
    null, { timeout: 12000 });
  check(await page.evaluate('NMS.stats().timeScale') === 60,
    'ephemeris time returns to normal after the sunset crossing');

  // Exercise the real desktop Pointer Lock path. The regression was a half-
  // locked state: cursor hidden, but the flight controller still disabled.
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&quality=low&post=0&vclouds=0&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  await page.locator('#app canvas').click({ position: { x: 550, y: 350 } });
  await page.waitForFunction(() => document.pointerLockElement === document.querySelector('#app canvas'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.pointerLockElement && !document.getElementById('pause-overlay').classList.contains('hidden'));
  await page.locator('#resume-btn').click();
  await page.waitForFunction(() => document.pointerLockElement === document.querySelector('#app canvas')
    && document.getElementById('pause-overlay').classList.contains('hidden'));
  const quatBeforeResumeMove = await page.evaluate('NMS._internals.nav.quat.toArray()');
  await page.mouse.move(780, 420);
  await page.waitForTimeout(100);
  const quatAfterResumeMove = await page.evaluate('NMS._internals.nav.quat.toArray()');
  check(quatAfterResumeMove.some((value, index) => Math.abs(value - quatBeforeResumeMove[index]) > 1e-5),
    'resumed Pointer Lock immediately owns camera look input');
} finally {
  await browser.close();
  server.close();
}

console.log(errors.length || failures
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s)`
  : 'DONE - gameplay loop checks passed, no page errors');
process.exit(errors.length || failures ? 1 : 0);
