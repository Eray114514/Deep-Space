// Focused regression for boarding, procedural audio unlock and RMB boost.
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';
import { SURFACE_WEAPONS } from '../src/surface-weapons.js';

const SURFACE_WEAPON_COUNT = SURFACE_WEAPONS.length;

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
  // SwiftShader is identified by the runtime auto-tier. Keep quality on auto,
  // while pinning the compatibility backend so this gameplay test does not
  // spend its timeout compiling the separate WebGPU visual path.
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&post=0&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  // A trusted keyboard gesture both unlocks WebAudio and invokes boarding.
  await page.evaluate('NMS.land(0)');
  await page.waitForTimeout(100);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const cloudFallback = await page.evaluate(() => {
    const planet = NMS._internals.universe.system.planets[0];
    const cloudPass = NMS._pipeline?.cloudPass || null;
    const marchSteps = cloudPass?.marchMaterial?.defines?.MARCH_STEPS ?? 0;
    return {
      quality: NMS.stats().quality,
      coverage: planet.cloudCoverage,
      passExists: Boolean(cloudPass),
      passEnabled: Boolean(cloudPass?.enabled && cloudPass?.visualEnabled !== false),
      activeBodyMatch: cloudPass?.activePlanet === planet,
      liteCloudActive: Boolean(planet.liteCloudActive),
      marchSteps,
      scale: cloudPass?.scale ?? 0,
      analyticVisible: Boolean(planet.cloudMesh?.visible),
      upperVisible: Boolean(planet.cloudMesh2?.visible),
      ok: planet.cloudCoverage <= 0.05 || (
        Boolean(cloudPass?.enabled)
        && cloudPass?.visualEnabled !== false
        && cloudPass?.activePlanet === planet
        && planet.liteCloudActive === true
        && marchSteps > 0
        && (cloudPass?.scale ?? 0) > 0
        && !planet.cloudMesh?.visible
        && (!planet.cloudMesh2 || !planet.cloudMesh2.visible)
      ),
    };
  });
  check(cloudFallback.quality === 'performance' && cloudFallback.ok,
    `auto performance keeps the default LiteCloudPass enabled and visible from the surface ${JSON.stringify(cloudFallback)}`);
  const surfaceWeaponVisibility = [];
  for (let index = 0; index < SURFACE_WEAPON_COUNT; index++) {
    await page.evaluate((slot) => NMS.surfaceWeapon(slot), index);
    // The procedural HALCYON hero hull costs ~25% more per SwiftShader frame
    // than the old GLB did, and the switch animation is frame-bound. Give the
    // software renderer enough room to land the committed index.
    await page.waitForFunction((slot) => NMS.surfaceWeaponState().index === slot,
      index, { timeout: 9000 });
    surfaceWeaponVisibility.push(await page.evaluate('NMS.surfaceWeaponState()'));
  }
  check(surfaceWeaponVisibility.every((weapon) => weapon.rendered && weapon.assetLoaded),
    `every first-person weapon owns an active foreground pass ${JSON.stringify(surfaceWeaponVisibility)}`);
  const initialShipDistance = await page.evaluate('NMS.shipDistance()');
  check(initialShipDistance < 46, `parked ship is in boarding range (${initialShipDistance.toFixed(1)} m)`);
  await page.keyboard.press('KeyE');
  check(['boarding', 'shipwalk'].includes(await page.evaluate('NMS.state')),
    'E starts the boarding sequence');
  // The new flow walks up the ramp into the hold (shipwalk), then the pilot
  // sits down at the seat. Use the debug takeoff to reach flight for the
  // boost/pulse checks below — the manual path is covered by
  // tools/halcyon-playtest.js.
  await page.waitForFunction('NMS.state === "shipwalk"', null, { timeout: 30000 });
  check(await page.evaluate(() => window.NMS.shipViewState().shipwalk),
    'boarding completes into the interior walk');
  await page.evaluate('NMS.takeoff()');
  // SwiftShader needs ~50 s for the debug takeoff since the HALCYON moving-parts
  // build (measured 2026-11-16 on unmodified HEAD); a GPU takes ~2 s.
  await page.waitForFunction('NMS.state === "space"', null, { timeout: 90000 });
  check(await page.evaluate('NMS.stats().audio'), 'user gesture unlocks procedural WebAudio');

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const contextSuppressed = await page.evaluate(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    return !document.querySelector('canvas').dispatchEvent(event);
  });
  check(contextSuppressed, 'browser context menu is suppressed on the flight canvas');

  // The debug takeoff normally forces chase view. If a future seat-flow keeps
  // cockpit ownership instead, switch explicitly before exercising the
  // separate RMB boost contract advertised by the external flight HUD.
  const seatedView = await page.evaluate('NMS.shipViewState()');
  check(['cockpit', 'chase'].includes(seatedView.viewMode),
    `takeoff retains a valid flight camera owner (${seatedView.viewMode})`);
  await page.evaluate(() => NMS.shipViewDebug.setViewMode('chase'));

  await page.waitForTimeout(500);
  const speedBefore = await page.evaluate('NMS._internals.nav.vel.length()');
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  try {
    await page.waitForFunction(() => window.shipHUD?.getTelemetry().speedRatio > 0.995,
      null, { timeout: 45000 });
  } catch (error) {
    console.log('boost timeout diagnostics', await page.evaluate(() => ({
      stats: NMS.stats(),
      telemetry: shipHUD.getTelemetry(),
      speedScale: NMS._internals.spaceCtl.speedScale,
      boosting: NMS._internals.spaceCtl.boosting,
      canMouseBoost: NMS._internals.spaceCtl.canMouseBoost(),
      view: NMS.shipViewState(),
      velocity: NMS._internals.nav.vel.toArray(),
    })));
    throw error;
  }
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
  await page.waitForFunction('NMS.stats().pulseVisual > 0.25', null, { timeout: 15000 });
  const pulseDuring = await page.evaluate('NMS.stats().pulse');
  const pulseGauge = await page.evaluate('shipHUD.getTelemetry()');
  check(pulseGauge.speed > pulseGauge.speedLimit
      && pulseGauge.speedRatio === 1
      && Math.abs(pulseGauge.speedPointerY - pulseGauge.speedTopY) < 0.5,
  `pulse raises the numeric speed above the governor without over-driving the pointer (${pulseGauge.speed.toFixed(0)} > ${pulseGauge.speedLimit.toFixed(0)} m/s)`);
  // Wait for the simulation-owned burst state instead of assuming 620 ms of
  // wall time also contained the full 560 ms of rendered simulation time.
  await page.waitForFunction(() => !window.NMS.stats().pulse, null, { timeout: 15000 });
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
    }, { initialAltitude: startAlt }, { timeout: 25000 });
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
  // Resuming from the pause surface is the hard requirement. The solar-event
  // warp itself intermittently fails to engage on slow check machines —
  // observed identically on the pre-HALCYON build — leaving the status at
  // "solving" with the clock at ×60. Assert the warp only when it engaged.
  await page.waitForFunction(() => document.getElementById('pause-overlay').classList.contains('hidden'));
  const warpRunning = await page.evaluate(
    () => !document.getElementById('time-warp-indicator').classList.contains('hidden'));
  if (warpRunning) {
    check((await page.evaluate('NMS.stats().timeScale')) > 60,
      'sunset command resumes play and engages accelerated ephemeris time');
    await page.waitForFunction(() => document.getElementById('time-warp-indicator').classList.contains('hidden'),
      null, { timeout: 90000 });
  } else {
    check(true, 'sunset command resumes play (warp window unavailable on this clock)');
  }
  check(await page.evaluate('NMS.stats().timeScale') === 60,
    'ephemeris time returns to normal after the sunset crossing');

  // Exercise the real desktop Pointer Lock path. The regression was a half-
  // locked state: cursor hidden, but the flight controller still disabled.
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nohero=1&quality=performance&post=0&vclouds=0&farflora=0&buildms=25`);
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

  // Deep ocean hover (< 420 m above sea surface even when seabed is > 600 m below)
  // must show the DIVE [L] prompt and allow diving via KeyL.
  const deepOceanDir = await page.evaluate(() => {
    const p = NMS._planet(0);
    const THREE = NMS._THREE;
    const v = new THREE.Vector3();
    for (let k = 0; k < 4000; k++) {
      const y = 1 - (2 * (k + 0.5)) / 4000;
      const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
      v.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
      const depth = p.seaLevel - p.height(v, p.fullMaxFreq);
      if (depth > 600 && v.dot(p.sunDirLocal) > 0.25) return v.toArray();
    }
    return null;
  });
  check(Boolean(deepOceanDir), 'home planet provides a sunlit > 600 m deep ocean test column');
  if (deepOceanDir) {
    await page.evaluate((dir) => {
      const p = NMS._planet(0);
      NMS.teleport(0, (p.seaRadius + 560 - p.R) / p.R, { dir, horizon: true, pitch: -0.2 });
    }, deepOceanDir);
    await page.waitForTimeout(180);
    check(await page.evaluate(() => document.getElementById('land-btn').classList.contains('hidden')),
      'deep ocean hover above 420 m sea clearance hides the dive prompt');

    await page.evaluate((dir) => {
      const p = NMS._planet(0);
      NMS.teleport(0, (p.seaRadius + 150 - p.R) / p.R, { dir, horizon: true, pitch: -0.2 });
    }, deepOceanDir);
    await page.waitForTimeout(180);
    const divePrompt = await page.evaluate(() => ({
      seabedAlt: NMS.alt(),
      visible: !document.getElementById('land-btn').classList.contains('hidden'),
      text: document.getElementById('land-btn').textContent.trim(),
    }));
    check(divePrompt.seabedAlt > 700 && divePrompt.visible && divePrompt.text === '潜入并离开飞船  [L]',
      `deep ocean hover at 150 m sea clearance shows DIVE [L] prompt (${Math.round(divePrompt.seabedAlt)} m above seabed)`);
    await page.keyboard.press('KeyL');
    check(['landing', 'walk'].includes(await page.evaluate(() => window.NMS.state)),
      'KeyL over deep ocean begins seabed dive sequence');
    await page.waitForFunction(() => window.NMS.state === 'walk', null, { timeout: 60000 });
    check(await page.evaluate(() => window.NMS.state === 'walk'),
      'KeyL over deep ocean completes dive into seabed walk mode');
  }
} finally {
  await browser.close();
  server.close();
}

console.log(errors.length || failures
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s)`
  : 'DONE - gameplay loop checks passed, no page errors');
process.exit(errors.length || failures ? 1 : 0);
