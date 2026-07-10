// v0.20 visual probe: far-flora approach sequence (trees at every distance),
// professional grass close-up, and the reworked nebula/band skybox.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';

const OUT = process.env.OUT || 'screenshots/v20';
const SEED = process.env.SEED || 'EUCLID';
await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); console.error('PAGEERROR:', String(e).split('\n')[0]); });

await page.goto(`http://127.0.0.1:${port}/?seed=${encodeURIComponent(SEED)}&nolock=1&buildms=120`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });

async function shot(name, timeout = 240000) {
  try { await page.waitForFunction('window.NMS.idle()', null, { timeout }); }
  catch { console.warn(`${name}: settle timeout (continuing)`); }
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`✓ ${name}`);
}

// deep space: nebulae + galaxy band (no planet in frame)
await page.evaluate('NMS.teleport(0, 8)');
await page.evaluate('NMS.lookYaw(160); NMS.lookPitch(25);');
await shot('01-space-sky');

// the approach: the same forests must be there at EVERY altitude
await page.evaluate('NMS.teleport(0, 0.1, {horizon: true})');
await shot('02-approach-8km');
await page.evaluate('NMS.teleport(0, 0.028, {horizon: true})');
await shot('03-approach-2km');
await page.evaluate('NMS.teleport(0, 0.006, {horizon: true})');
await shot('04-low-500m');

// on foot in a meadow: grass + near/far tiers together
await page.evaluate("NMS.land(0, 0, 'meadow')");
await shot('05-meadow');
await page.evaluate('NMS.lookYaw(120)');
await shot('06-meadow-b', 30000);
await page.evaluate('NMS.lookPitch(-30)');
await shot('07-grass-closeup', 30000);

console.log(errors.length ? `DONE WITH ${errors.length} PAGE ERROR(S)` : 'DONE — no page errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
