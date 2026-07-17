// Focused regression for boarding, procedural audio unlock and RMB boost.
import { startServer } from './server.js';
import { chromium } from 'playwright';

const { server, port } = await startServer(0);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath(),
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
