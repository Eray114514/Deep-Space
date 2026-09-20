// Player-chain evidence: QA chooses only initial locations/light. All motion
// and view changes after each fixture use keyboard input, never wake fixtures.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { PNG } from 'pngjs';

const out = `test-results/ocean-player/${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/oceanplaytest.js');
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
const page = await context.newPage();
const errors = [], samples = [], checks = [], fixtures = [];
let wakeAttribution = null;
const check = (name, passed, detail = null) => checks.push({ name, passed: !!passed, detail });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
const snapshot = async (label) => {
  const result = await page.evaluate(async () => {
    const { waterInteraction: field } = await import('/src/water-interaction.js');
    const { nav, ship, camera, shipView } = NMS._internals;
    const p = NMS._planet(0), T = NMS._THREE;
    const eye = p.worldPositionToLocal(nav.pos, new T.Vector3());
    const hull = p.worldPositionToLocal(nav.pos.clone().add(ship.group.position), new T.Vector3());
    const serializeSurface = (position) => {
      const surface = p.sampleWaterSurface(position, p.weatherHours, { normal: false });
      return surface ? { wet: surface.wet, clearance: surface.clearance, depth: surface.depth,
        waveHeight: surface.waveHeight, surfaceRadius: surface.surfaceRadius } : null;
    };
    return { state: NMS.state, stats: NMS.stats(), view: NMS.shipViewState(), time: NMS.time(),
      nav: { position: nav.pos.toArray(), velocity: nav.vel.toArray(), speed: nav.vel.length(),
        quaternion: nav.quat.toArray() },
      camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() },
      pointerEvents: window.oceanPlayerPointerEvents || [],
      freeLook: { yaw: shipView.freeYaw, pitch: shipView.freePitch, rmb: shipView.rmb,
        pointerLocked: document.pointerLockElement === NMS._renderer.domElement },
      shipOffset: ship.group.position.toArray(), eye: eye.toArray(), hull: hull.toArray(),
      radialAtmosphereHeight: eye.length() - p.R,
      eyeSurface: serializeSurface(eye), hullSurface: serializeSurface(hull),
      water: NMS.waterState(0), surface: NMS.surfaceState(0),
      fixtureActive: NMS.waterWakeDebug() !== null,
      field: field.positions.flatMap((position, i) => field.data[i].z > 0.001 ? [{
        position: position.toArray(), data: field.data[i].toArray(),
        direction: field.directions[i].toArray(),
        radialError: Math.abs(position.length() - p.seaRadius),
        hullDistance: position.distanceTo(hull.clone().normalize().multiplyScalar(p.seaRadius)),
        // Projection only; it does not establish visibility through the hull,
        // foam contrast, or wake readability. Preserve it for artifact review.
        screen: p.group.localToWorld(position.clone()).project(camera).toArray(),
      }] : []),
    };
  });
  samples.push({ label, ...result });
  return result;
};
const capture = async (label) => {
  const state = await snapshot(label);
  await page.screenshot({ path: `${out}/${label}.png` });
  return state;
};
const move = async (key, seconds, label, stopWhen = null) => {
  await page.keyboard.down(key);
  try {
    for (let second = 1; second <= seconds; second++) {
      await page.waitForTimeout(1000);
      const state = await snapshot(`${label}-${second}s`);
      if (second % 10 === 0 || second === seconds || stopWhen?.(state)) {
        await page.screenshot({ path: `${out}/${label}-${second}s.png` });
      }
      if (stopWhen?.(state)) break;
    }
  } finally { await page.keyboard.up(key); }
};

try {
  await page.goto(`http://127.0.0.1:${port}/?quality=ultra&nohero=1&post=1&vclouds=1&farflora=1&buildms=80`);
  await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 120000 });
  fixtures.push(await page.evaluate(() => {
    const p = NMS._planet(0);
    const dir = [0.34669148, 0.07291667, -0.93514073];
    NMS.teleport(0, (p.seaLevel + 17) / p.R, { dir, horizon: true, pitch: 0 });
    const light = NMS.setLocalSunAltitude(0, 34);
    return { name: 'deep-lowflight', dir, seaClearance: 17, light };
  }));
  await page.waitForFunction(() => {
    const w = NMS.waterState(0);
    return w?.near?.visible && !w.near.pending && w.global.pending === 0;
  }, null, { timeout: 180000 });
  await page.evaluate(() => NMS.setBuildBudget(0));
  await page.waitForTimeout(3000);
  const initial = await capture('01-deep-idle');
  await move('KeyW', 8, '02-real-throttle');
  // Capture the actual moving player's frame synchronously: no camera lead,
  // repositioning, replacement impulses, time jump, or intervening simulation.
  // The repeated ON frame measures compositor noise independently of the wake.
  const wakeFrames = await page.evaluate(() => {
    const p = NMS._planet(0), u = p.liquidMat.userData.waterUniforms;
    const count = u.uRippleCount.value, pipeline = NMS._pipeline;
    const canvas = NMS._renderer.domElement;
    const images = [];
    try {
      for (const enabled of [true, false, true]) {
        u.uRippleCount.value = enabled ? count : 0;
        pipeline.render();
        images.push(canvas.toDataURL('image/png').split(',')[1]);
      }
    } finally { u.uRippleCount.value = count; }
    return { images, count, fixtureActive: NMS.waterWakeDebug() !== null };
  });
  const wakePNGs = [];
  for (let i = 0; i < wakeFrames.images.length; i++) {
    const buffer = Buffer.from(wakeFrames.images[i], 'base64');
    await writeFile(`${out}/02-wake-${['on', 'off', 'repeat'][i]}-same-frame.png`, buffer);
    wakePNGs.push(PNG.sync.read(buffer));
  }
  let signal = 0, background = 0, changedPixels = 0, pixelCount = 0;
  const [on, off, repeat] = wakePNGs;
  for (let y = Math.floor(on.height * 0.55); y < on.height; y++) {
    for (let x = 0; x < on.width; x++) {
      const index = (y * on.width + x) * 4;
      let delta = 0, noise = 0;
      for (let c = 0; c < 3; c++) {
        delta += Math.abs(on.data[index + c] - off.data[index + c]) / 765;
        noise += Math.abs(on.data[index + c] - repeat.data[index + c]) / 765;
      }
      signal += delta; background += noise; pixelCount++;
      if (delta > noise + 0.025) changedPixels++;
    }
  }
  wakeAttribution = { scope: 'Actual default chase frame, synchronous ON/OFF/ON; canvas includes production post, HUD remains in ordinary capture.',
    sourceCount: wakeFrames.count, signal: signal / pixelCount,
    background: background / pixelCount, changedPixels, pixelCount };
  check('default chase wake is visibly attributable to actual pressure sources',
    !wakeFrames.fixtureActive && wakeFrames.count > 0 && changedPixels > 100
      && signal > background * 3, wakeAttribution);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(3000);
  const cockpit = await capture('03-view-toggle');
  await move('KeyW', 4, '04-cockpit-throttle');
  // Use the actual advertised RMB free-look path. In nolock mode the current
  // cockpit implementation ignores mousemove, so no debug yaw/pitch fallback
  // is permitted if pointer lock fails. Failure is a player-chain finding.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  const mx = box.x + box.width * 0.5, my = box.y + box.height * 0.5;
  await page.evaluate(() => {
    window.oceanPlayerPointerEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'pointerlockchange']) {
      document.addEventListener(type, (event) => {
        window.oceanPlayerPointerEvents.push({ type, button: event.button,
          buttons: event.buttons, defaultPrevented: event.defaultPrevented,
          locked: !!document.pointerLockElement, trusted: event.isTrusted });
      });
    }
  });
  await page.mouse.move(mx, my);
  await page.keyboard.down('KeyW');
  await page.mouse.down({ button: 'right' });
  try {
    await page.waitForFunction(() => document.pointerLockElement === NMS._renderer.domElement,
      null, { timeout: 10000 });
    await snapshot('04a-first-lock-input-state');
    // A fresh press after acquiring lock separates lock-entry input clearing
    // from the established-lock gesture. Both are real trusted input events.
    await page.mouse.up({ button: 'right' });
    await page.mouse.down({ button: 'right' });
    await snapshot('04a-second-press-input-state');
    await page.mouse.move(mx + 450, my + 180, { steps: 12 });
    await page.waitForTimeout(500);
    const side = await capture('04a-rmb-side-down');
    check('RMB pointer-lock side look operates', side.freeLook.pointerLocked
      && Math.abs(side.freeLook.yaw) > 0.7 && side.freeLook.pitch < -0.2, side.freeLook);
    await page.mouse.move(mx + 750, my + 220, { steps: 8 });
    await page.waitForTimeout(500);
    await capture('04b-rmb-aft-down');
    await page.mouse.move(mx - 450, my + 180, { steps: 24 });
    await page.waitForTimeout(500);
    await capture('04c-rmb-other-side-down');
  } finally {
    await page.mouse.up({ button: 'right' });
    await page.keyboard.up('KeyW');
  }
  await page.waitForTimeout(2000);
  const restoredLook = await capture('04d-rmb-released');
  check('RMB release restores centered view', Math.abs(restoredLook.freeLook.yaw) < 0.05
    && Math.abs(restoredLook.freeLook.pitch) < 0.05, restoredLook.freeLook);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(3000);
  await capture('05-return-view');
  check('W produces actual motion', samples.some((s) => s.nav.speed > initial.nav.speed + 10));
  check('V changes player view', cockpit.view.viewMode !== initial.view.viewMode);
  const flight = samples.filter((s) => s.state === 'space');
  check('real low-flight creates directional pressure', flight.some((s) => s.field.some((f) => f.direction[3] > 0.5)));
  check('pressure stays on base sphere', flight.every((s) => s.field.every((f) => f.radialError < 0.01)));
  // This tests the real public clock API, separately from normal input.
  // Generate fresh input-driven pressure immediately before the clock jump;
  // an already empty field cannot prove stale-event removal.
  await move('KeyW', 3, '05a-pre-clock-throttle');
  const jump = await page.evaluate(async () => {
    const { waterInteraction: field } = await import('/src/water-interaction.js');
    const before = field.activeCount();
    NMS.setTime(NMS.time().hours + 0.01);
    return { before, immediatelyAfter: field.activeCount(), time: NMS.time() };
  });
  check('QA clock jump clears existing pre-jump impulses synchronously', jump.before > 0
    && jump.immediatelyAfter === 0, jump);

  fixtures.push(await page.evaluate(() => NMS.setWade(0, { depth: 1.4, overview: false, look: 'sea' })));
  // setWade's authored arrival impulse expires naturally. It cannot count as
  // evidence of a player-generated step or hull pressure source.
  await page.waitForTimeout(10000);
  await capture('06-shallow-idle');
  await move('KeyW', 45, '07-walk-into-sea', (s) => s.eyeSurface?.clearance < -0.35);
  await capture('08-seaward-end');
  await move('KeyS', 90, '09-back-to-shore', (s) => s.surface.height > s.surface.seaLevel + 0.25);
  await capture('10-shore-end');
  const walking = samples.filter((s) => s.state === 'walk');
  check('walking crosses below moving water surface', walking.some((s) => s.eyeSurface?.clearance < -0.08));
  check('walking returns to dry terrain', walking.some((s) => s.surface.height > s.surface.seaLevel + 0.25));
  check('real steps produce impact impulses', walking.some((s) => s.label.startsWith('07-')
    && s.field.some((f) => f.direction[3] < 0.5 && f.data[0] < 1)));
  check('no wake fixture used', samples.every((s) => !s.fixtureActive));
  check('ocean lighting uses radial altitude, independent of seabed depth',
    samples.every((s) => Math.abs(s.stats.environment.cameraHeight - s.radialAtmosphereHeight) < 0.5));
  check('production WebGL2 throughout', samples.every((s) => s.stats.rendererBackend === 'webgl2'));
  check('no browser errors', errors.length === 0, errors);
} catch (error) {
  checks.push({ name: 'execution completed', passed: false, detail: String(error.stack || error) });
} finally {
  const finalFingerprint = await evidenceFingerprint('tools/oceanplaytest.js');
  check('source unchanged during evidence', fingerprint.sourceDigest === finalFingerprint.sourceDigest);
  await writeFile(`${out}/report.json`, JSON.stringify({ ...fingerprint,
    scope: 'Normal HUD/post/clouds/farflora. Initial QA locations/light; keyboard-only movement and V. Clock jump is a separate diagnostic. Screenshots require visual review; numerical checks are not an aesthetic PASS.',
    fixtures, checks, samples, wakeAttribution, errors }, null, 2));
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ out, checks }, null, 2));
assert.ok(checks.every((c) => c.passed), 'Ocean player-chain has unmet checks; inspect report and screenshots.');
