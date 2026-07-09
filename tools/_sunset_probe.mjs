// One-off: re-shoot EUCLID's golden-hour landing on the current build.
// (The full pass had already taken this scene before the region-skyline fix.)
import { startServer } from './server.js';
import { chromium } from 'playwright';

const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1&buildms=120`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
await page.evaluate("NMS.land(0, 0, 'sunset')");
try {
  await page.waitForFunction('window.NMS.idle()', null, { timeout: 240000 });
} catch { console.warn('settle timeout (continuing)'); }
await page.waitForTimeout(1300);
await page.screenshot({ path: 'screenshots/explore/EUCLID/81-sunset-landing.png' });
await page.evaluate('NMS.lookYaw(35)');
await page.waitForTimeout(600);
await page.screenshot({ path: 'screenshots/explore/EUCLID/81-sunset-landing-b.png' });
console.log('sunset probe done');
await browser.close();
server.close();
process.exit(0);
