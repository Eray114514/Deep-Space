// Nebula/band verification: shots at several yaws from deep space, away
// from both the sun and the planet.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';
await mkdir('screenshots/v20', { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1&buildms=60&vclouds=0`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
await page.evaluate('NMS.teleport(3, 1.5)');   // a barren outer planet: dim sun
await page.waitForTimeout(4000);
for (const [name, js] of [
  ['sky-a', 'NMS.lookPitch(65)'],
  ['sky-b', 'NMS.lookYaw(90)'],
  ['sky-c', 'NMS.lookYaw(90)'],
  ['sky-d', 'NMS.lookYaw(90); NMS.lookPitch(-40);'],
]) {
  await page.evaluate(js);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `screenshots/v20/_${name}.png` });
  console.log('✓', name);
}
await browser.close();
server.close();
process.exit(0);
