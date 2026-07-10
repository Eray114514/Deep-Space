// Flora close-up probe: land on one planet of each vegetated type across a
// few seeds and shoot ground-level angles — verifies the per-planet species
// (trees, shrubs, pods, grass) read well from eye height.
// Usage: node tools/_flora_probe.mjs   (env: SEEDS=A,B  OUT=screenshots/flora)

import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';

const SEEDS = (process.env.SEEDS || 'EUCLID,ATLAS-7,VOYAGER-3').split(',');
const OUT = process.env.OUT || 'screenshots/flora';
const WANT = ['lush', 'toxic', 'exotic', 'desert', 'ice', 'ash'];

await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});

const errors = [];
const probed = new Set();

for (const seed of SEEDS) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => { errors.push(`[${seed}] ${e}`); console.error('PAGEERROR:', String(e).split('\n')[0]); });
  await page.goto(`http://127.0.0.1:${port}/?seed=${encodeURIComponent(seed)}&nolock=1&buildms=120`);
  await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });

  async function shot(name, timeout = 240000) {
    try { await page.waitForFunction('window.NMS.idle()', null, { timeout }); }
    catch { console.warn(`${name}: settle timeout (continuing)`); }
    await page.waitForTimeout(1400);   // scatter grow-in
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`✓ ${name}`);
  }

  const planets = await page.evaluate('window.NMS.planets()');
  console.log(`=== ${seed}:`, planets.map((p) => `${p.i}:${p.type}${p.isMoon ? '(m)' : ''}`).join(' '));

  let lands = 0;
  for (const p of planets) {
    if (p.isMoon || probed.has(p.type) || !WANT.includes(p.type) || lands >= 3) continue;
    probed.add(p.type);
    lands++;
    await page.evaluate(`NMS.land(${p.i})`);
    await shot(`${seed}-${p.type}-a`);
    await page.evaluate('NMS.lookYaw(130)');
    await shot(`${seed}-${p.type}-b`, 30000);
    await page.evaluate('NMS.lookYaw(110); NMS.lookPitch(-26);');
    await shot(`${seed}-${p.type}-c-ground`, 30000);
    await page.evaluate('NMS.lookPitch(26)');
  }
  await page.close();
}

console.log(errors.length ? `DONE WITH ${errors.length} PAGE ERROR(S)` : 'DONE — no page errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
