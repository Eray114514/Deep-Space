// PAC-9 viewmodel check (Saltline port): boots, lands, and exercises the
// first-person weapon in walk mode — hip, ADS, automatic fire, tactical and
// empty reloads — asserting the controller state and saving captures.
//
//   node tools/pac9viewmodeltest.js [--gpu] [--out docs/captures/pac9]
import { mkdirSync } from 'node:fs';
import { launchBrowser } from './browser.js';
import { startServer } from './server.js';

const argv = process.argv.slice(2);
const gpu = argv.includes('--gpu');
const outIndex = argv.indexOf('--out');
const out = outIndex >= 0 ? argv[outIndex + 1] : null;
if (out) mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`);
  if (!ok) failures++;
};

const { server, port } = await startServer(0);
const browser = await launchBrowser(gpu ? { args: ['--use-angle=d3d11', '--enable-gpu'] } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const frames = (n = 2) => page.evaluate((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);
const shot = async (name) => { if (out) await page.screenshot({ path: `${out}/${name}.png` }); };
const state = () => page.evaluate('NMS.surfaceWeaponState()');

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });
  await page.evaluate('NMS.land(0)');
  await page.waitForFunction(() => NMS.surfaceWeaponState().rendered, null, { timeout: 60000 });
  await page.evaluate((slot) => NMS.surfaceWeapon(slot), 0);
  await page.waitForTimeout(gpu ? 3000 : 6000);
  await frames(10);

  const s0 = await state();
  check(s0.index === 0 && s0.rendered, `PAC-9 is slot 1 and rendered ${JSON.stringify({ index: s0.index, rendered: s0.rendered })}`);
  check(s0.ammo === 30, `starts with a full 30-round magazine (${s0.ammo})`);
  await shot('01-hip');

  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(600);
  await frames(4);
  check((await state()).ads === true, 'right mouse raises the sight');
  await shot('02-ads');

  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(450);
  await shot('03-ads-fire');
  await page.mouse.up({ button: 'left' });
  await page.mouse.up({ button: 'right' });
  const fired = await state();
  check(fired.ammo < 30, `holding the trigger fires automatically (ammo ${fired.ammo})`);

  const magHome = (await state()).magazine;
  await page.evaluate('NMS.surfaceReload()');
  // track the magazine every frame in-page; screenshots are too slow to sample it
  const magTravel = page.evaluate((home) => new Promise((resolve) => {
    let max = 0;
    const t0 = performance.now();
    const tick = () => {
      const m = NMS.surfaceWeaponState().magazine;
      if (m) max = Math.max(max, Math.hypot(m[0] - home[0], m[1] - home[1], m[2] - home[2]));
      if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else resolve(max);
    };
    tick();
  }), magHome);
  const reloadStates = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(gpu ? 330 : 500);
    reloadStates.push(await state());
    await shot(`04-reload-${i}`);
  }
  check(reloadStates[0].reloading, 'tactical reload starts');
  const travel = await magTravel;
  check(travel > 0.05, `magazine leaves the receiver in the support hand during reload (max ${travel.toFixed(3)} m)`);
  await page.waitForFunction(() => !NMS.surfaceWeaponState().reloading, null, { timeout: 20000 });
  check((await state()).ammo === 30, 'reload refills the magazine');

  // empty the magazine to exercise the empty reload (bolt release)
  await page.mouse.down({ button: 'left' });
  await page.waitForFunction(() => NMS.surfaceWeaponState().ammo === 0 || NMS.surfaceWeaponState().reloading, null, { timeout: 30000 });
  await page.waitForTimeout(700); // keep pulling on an empty magazine: the dry click arms the auto-reload
  await page.mouse.up({ button: 'left' });
  await page.waitForFunction(() => NMS.surfaceWeaponState().reloading, null, { timeout: 10000 });
  check(true, 'dry trigger auto-starts the empty reload');
  await page.waitForTimeout(gpu ? 2000 : 3000);
  await shot('05-empty-reload');
  await page.waitForFunction(() => !NMS.surfaceWeaponState().reloading, null, { timeout: 20000 });
  check((await state()).ammo === 30, 'empty reload refills the magazine');

  check(errors.length === 0, `no page errors ${JSON.stringify(errors.slice(0, 3))}`);
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('pac9 viewmodel: all checks passed');
