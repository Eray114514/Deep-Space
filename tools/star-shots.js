// Fixed-camera captures of the home star on the real GPU at several
// distances, for judging the photosphere / corona / flare look.
//
//   node tools/star-shots.js [label]
//
// Output: screenshots/star/<label>/star-<factor>R.png
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';

const label = process.argv[2] || 'current';
const factors = process.env.STAR_FACTORS ? process.env.STAR_FACTORS.split(",").map(Number) : [1.7, 2.6, 5, 14, 60];
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 300)); });

const frames = (n = 2) => page.evaluate((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0${process.env.STAR_QS || ''}`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 180000 });
  await page.addStyleTag({ content: 'body > *:not(#app) { visibility: hidden !important; }' });
  await page.waitForTimeout(2500);
  const out = `screenshots/star/${label}`;
  await mkdir(out, { recursive: true });
  for (const factor of factors) {
    await page.evaluate((f) => NMS.approachStar(0, f), factor);
    await frames(40);
    const name = `${out}/star-${String(factor).replace('.', '_')}R.png`;
    await page.screenshot({ path: name });
    console.log('✓', name, JSON.stringify(await page.evaluate(() => { const r = NMS.renderLookState(); return { tm: r.toneMapping, exposure: r.exposure }; })));
  }
  // Off-axis: star near the frame edge, as seen while flying past.
  await page.evaluate(() => NMS.approachStar(0, 9, { yaw: 0.35, pitch: 0.12 }));
  await frames(40);
  await page.screenshot({ path: `${out}/star-offaxis.png` });
  console.log('✓', `${out}/star-offaxis.png`);
} finally {
  await browser.close();
  server.close();
}
