// Beauty captures of the HALCYON VII in the real game renderer: boots once,
// then holds the hull at a series of poses in front of the flight camera so
// the same star, planet and post chain light every angle.
//
//   node tools/ship-shots.js [view,view,...]
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const OUT = 'screenshots/ship';
await mkdir(OUT, { recursive: true });
const VIEWS = {
  // name: [yaw°, pitch°, roll°, distance, right, up]   (ship pose relative to the camera)
  chase: [0, 14, 0, 30, 0, -3],
  rear34: [-32, 16, 0, 27, 0, -1],
  side: [-90, 5, 0, 30, 0, 0],
  front34: [-150, 14, 0, 27, 0, -1],
  front: [180, 9, 0, 26, 0, -1],
  top: [-90, 80, 0, 34, 0, 0],
  belly: [-140, -40, 0, 30, 0, 0],
  canopy: [-150, 12, 0, 13, 2.5, -1.2],
  engines: [-22, 8, 0, 13, -3, -1],
};
const wanted = (process.argv[2] || Object.keys(VIEWS).join(',')).split(',');

const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0&buildms=25`);
await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });
await page.addStyleTag({ content: 'body > *:not(#app) { visibility: hidden !important; }' });
await page.evaluate(() => {
  const { ship } = NMS._internals;
  const THREE = NMS._internals.THREE || window.THREE;
  const original = ship.update.bind(ship);
  window.__shipPose = null;
  ship.update = (dt, nav, ...rest) => {
    original(dt, nav, ...rest);
    const pose = window.__shipPose;
    if (!pose) return;
    const q = nav.quat;
    const Q = q.constructor, V = ship.group.position.constructor;
    const rad = Math.PI / 180;
    const rel = new Q().setFromAxisAngle(new V(1, 0, 0), pose[1] * rad)
      .multiply(new Q().setFromAxisAngle(new V(0, 1, 0), pose[0] * rad))
      .multiply(new Q().setFromAxisAngle(new V(0, 0, 1), pose[2] * rad));
    ship.group.quaternion.copy(q).multiply(rel);
    ship.group.position.set(pose[4], pose[5], -pose[3]).applyQuaternion(q);
  };
});
for (const name of wanted) {
  if (!VIEWS[name]) { console.error('unknown view', name); continue; }
  await page.evaluate((pose) => { window.__shipPose = pose; }, VIEWS[name]);
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('✓', name);
}
await browser.close();
server.close();
