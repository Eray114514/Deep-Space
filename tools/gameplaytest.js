// Focused regression for boarding, procedural audio unlock and RMB boost.
import { startServer } from './server.js';
import { chromium } from 'playwright';

const { server, port } = await startServer(0);
const chrome = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

try {
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&quality=low&post=0&vclouds=0&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  // A trusted keyboard gesture both unlocks WebAudio and invokes boarding.
  await page.evaluate('NMS.land(0)');
  await page.waitForTimeout(100);
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
  await page.waitForTimeout(1200);
  const duringBoost = await page.evaluate('NMS.stats().boost');
  const speedBoost = await page.evaluate('NMS._internals.nav.vel.length()');
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(300);
  const afterRelease = await page.evaluate('NMS.stats().boost');
  check(duringBoost > 0.65, `RMB drives boost state (${duringBoost.toFixed(2)})`);
  check(speedBoost > Math.max(speedBefore * 1.5, speedBefore + 100),
    `RMB materially accelerates ship (${speedBefore.toFixed(0)} -> ${speedBoost.toFixed(0)} m/s)`);
  check(afterRelease < duringBoost, 'RMB release clears boost cleanly');

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
    await page.waitForTimeout(2600);
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
} finally {
  await browser.close();
  server.close();
}

console.log(errors.length || failures
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s)`
  : 'DONE - gameplay loop checks passed, no page errors');
process.exit(errors.length || failures ? 1 : 0);
