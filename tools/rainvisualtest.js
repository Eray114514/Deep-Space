// Surface rain check (GPU rain): forces rain with ?rain=, lands,
// asserts the rain/splash meshes are live and fixed in the world while the
// player walks, and saves captures facing toward and away from the sun.
//
//   node tools/rainvisualtest.js [--gpu] [--out dir] [--rain 0.8] [--time 15]
import { mkdirSync } from 'node:fs';
import { launchBrowser } from './browser.js';
import { startServer } from './server.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const gpu = argv.includes('--gpu');
const out = arg('--out', null);
const rain = Number(arg('--rain', '0.8'));
const time = arg('--time', null);
if (out) mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`); if (!ok) failures++; };

const { server, port } = await startServer(0);
const browser = await launchBrowser(gpu ? { args: ['--use-angle=d3d11', '--enable-gpu'] } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { if (out) await page.screenshot({ path: `${out}/${name}.png` }); };
const rainState = () => page.evaluate(() => {
  const scene = NMS._internals?.scene;
  let drops = null, splashes = null;
  scene?.traverse((o) => { if (o.name === 'rain-drops') drops = o; if (o.name === 'rain-splashes') splashes = o; });
  const u = drops?.material.uniforms;
  return {
    found: !!drops && !!splashes,
    visible: !!drops?.parent?.visible,
    level: u?.uRain.value ?? 0,
    groundValid: u?.uGroundValid.value ?? 0,
    offset: u ? u.uOffset.value.toArray() : null,
  };
});

try {
  const timeParam = time !== null ? `&time=${time}` : '';
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0&buildms=25&rain=${rain}${timeParam}`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });
  await page.evaluate('NMS.land(0)');
  await page.waitForFunction(() => NMS.surfaceWeaponState().rendered, null, { timeout: 60000 });
  await page.waitForTimeout(gpu ? 5000 : 9000);

  const s0 = await rainState();
  check(s0.found, 'rain drop and splash meshes exist');
  check(s0.visible && s0.level > 0.3, `forced rain is visible (level ${s0.level.toFixed(2)})`);
  check(s0.groundValid === 1, 'walk mode feeds the terrain height grid to splashes');
  await shot('rain-01-forward');

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  const s1 = await rainState();
  const wrap = (d) => ((d % 1040) + 1560) % 1040 - 520; // offsets wrap at 1040 m
  const moved = s0.offset && s1.offset ? Math.hypot(wrap(s1.offset[0] - s0.offset[0]), wrap(s1.offset[2] - s0.offset[2])) : 0;
  check(moved > 1, `walking shifts the rain field (world-fixed, moved ${moved.toFixed(2)} m)`);
  await shot('rain-02-walked');

  // turn around: toward/away from the sun read very differently (phase function)
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const w = NMS._internals?.walkCtl;
      if (w) w.yaw += Math.PI * 2 / 3;
    });
    await page.waitForTimeout(900);
    await shot(`rain-03-turn${i}`);
  }
  check(errors.length === 0, `no page errors ${JSON.stringify(errors.slice(0, 3))}`);
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('rain visual: all checks passed');
