// One-off: same landed scene with and without the experimental GTAO pass.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';

await mkdir('screenshots/clouds', { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox'],
});

for (const gtao of [0, 1]) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1&buildms=120&gtao=${gtao}`);
  await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
  await page.evaluate('NMS.land(0)');
  try { await page.waitForFunction('window.NMS.idle()', null, { timeout: 240000 }); }
  catch { console.warn('settle timeout'); }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `screenshots/clouds/gtao-${gtao}.png` });
  console.log(`✓ gtao=${gtao}`);
  await page.close();
}
await browser.close();
server.close();
process.exit(0);
