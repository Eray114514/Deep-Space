// HALCYON survey units (Saltline robot dog + drone): land, check they deploy
// around the parked ship, patrol (move, stay clear of the hull), carry their
// positional rotor/servo loops, use the outdoor reflection environment, and
// are recalled on takeoff.
//
//   node tools/surveyunitstest.js [--gpu] [--out dir]
import { mkdirSync } from 'node:fs';
import { launchBrowser } from './browser.js';
import { startServer } from './server.js';

const argv = process.argv.slice(2);
const gpu = argv.includes('--gpu');
const outIndex = argv.indexOf('--out');
const out = outIndex >= 0 ? argv[outIndex + 1] : null;
if (out) mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`); if (!ok) failures++; };

const { server, port } = await startServer(0);
const browser = await launchBrowser(gpu ? { args: ['--use-angle=d3d11', '--enable-gpu'] } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const stats = () => page.evaluate(() => NMS._internals.surveyUnits.stats());

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });
  await page.evaluate('NMS.land(0)');
  await page.waitForFunction(() => NMS._internals.surveyUnits.stats().deployed, null, { timeout: 60000 });
  await page.waitForTimeout(gpu ? 3000 : 6000);
  const s0 = await stats();
  check(s0.units.length === 2 && s0.units.some((u) => u.type === 'hound') && s0.units.some((u) => u.type === 'gull'),
    `a hound and a gull deploy around the parked ship ${JSON.stringify(s0.units)}`);
  check(s0.units.every((u) => u.mode === 'patrol'), 'both units patrol (passive mode)');
  await page.keyboard.press('KeyG'); // a trusted gesture unlocks WebAudio
  await page.waitForTimeout(gpu ? 6000 : 10000);
  const s1 = await stats();
  const moved = s1.units.map((u, i) => Math.hypot(u.pos[0] - s0.units[i].pos[0], u.pos[2] - s0.units[i].pos[2]));
  check(moved.every((m) => m > 0.3), `units move while patrolling (${moved.map((m) => m.toFixed(1)).join(', ')} m)`);
  check(s1.units.every((u) => Math.hypot(u.pos[0], u.pos[2]) > 8), `units keep clear of the hull ${JSON.stringify(s1.units.map((u) => Math.hypot(u.pos[0], u.pos[2]).toFixed(1)))}`);
  const env = await page.evaluate(() => {
    let withEnv = 0, total = 0;
    NMS._internals.surveyUnits.root.traverse((o) => { if (o.isMesh && o.material?.isMeshStandardMaterial) { total++; if (o.material.envMap) withEnv++; } });
    return { withEnv, total };
  });
  check(env.total > 0 && env.withEnv === env.total, `robot materials reflect the outdoor environment (${env.withEnv}/${env.total})`);
  const audioReady = await page.evaluate(() => NMS._internals.audio.ready);
  if (audioReady) check(s1.voices === 2, `rotor and servo loops are live (${s1.voices})`);
  else console.log('SKIP: WebAudio not unlocked, loop check skipped');
  if (out) await page.screenshot({ path: `${out}/survey-units.png` });

  await page.evaluate('NMS.takeoff()');
  await page.waitForFunction(() => !NMS._internals.surveyUnits.stats().deployed, null, { timeout: 90000 });
  check(true, 'takeoff recalls the survey units');
  check(errors.length === 0, `no page errors ${JSON.stringify(errors.slice(0, 3))}`);
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('survey units: all checks passed');
