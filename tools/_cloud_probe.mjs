// One-off: volumetric cloud smoke test — four altitudes on EUCLID planet 0,
// timing each frame so we know what SwiftShader CI can bear.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';

await mkdir('screenshots/clouds', { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 400)); });

await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1&buildms=120`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
const planets = await page.evaluate('window.NMS.planets()');
console.log('cloudAlt of planet 0:', planets[0].cloudAlt, 'm; R =', planets[0].R);

async function snap(name, expr, timeout = 240000) {
  await page.evaluate(expr);
  try { await page.waitForFunction('window.NMS.idle()', null, { timeout }); }
  catch { console.warn(`${name}: settle timeout`); }
  await page.waitForTimeout(600);
  const t0 = Date.now();
  await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const ms = (Date.now() - t0) / 2;
  await page.screenshot({ path: `screenshots/clouds/${name}.png` });
  console.log(`✓ ${name}  (~${ms.toFixed(0)} ms/frame)`);
}

await snap('c1-orbit-impostor', 'NMS.teleport(0, 1.2)');
await snap('c2-volume-above', 'NMS.teleport(0, 0.08, {horizon:true, pitch:-0.15})');
const f = (planets[0].cloudAlt / planets[0].R).toFixed(6);
await snap('c3-transit', `NMS.teleport(0, ${f}, {horizon:true, pitch:-0.05})`);
await snap('c4-under-deck', `NMS.teleport(0, ${(planets[0].cloudAlt * 0.25 / planets[0].R).toFixed(6)}, {horizon:true, pitch:0.25})`);
console.log('done');
await browser.close();
server.close();
process.exit(0);
