// Fixed-camera captures of the pulse and warp transit looks on the real GPU.
//
//   node tools/transit-shots.js [pulse|warp|live-pulse|live-warp ...]
//
// `pulse` / `warp` freeze the transit timeline at authored instants through
// NMS.holdTransit (the ship does not move), so every phase can be judged on
// its own. `live-*` runs the real transit and samples frames over time to
// check hand-overs and the arrival. Output: screenshots/transit/<mode>/.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';

const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['pulse', 'warp'];
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
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 180000 });
  await page.addStyleTag({ content: 'body > *:not(#app) { visibility: hidden !important; }' });
  await page.waitForTimeout(2500);

  for (const mode of modes) {
    const out = `screenshots/transit/${mode}`;
    await mkdir(out, { recursive: true });
    if (mode === 'pulse' || mode === 'warp') {
      const info = await page.evaluate((kind) => NMS.holdTransit(kind, 0), mode);
      const plan = info.plan;
      const instants = mode === 'pulse'
        ? [0.0, 0.12, 0.22, 0.27, 0.32, 0.4, 0.55, 0.75, 1.0]
        : [0.0, 1.2, 2.4, 3.2, 3.6, 3.95, plan.tunnelStart + 0.3, plan.tunnelStart + 2,
          plan.exitStart + 0.25, plan.exitStart + 0.6, plan.exitStart + 0.95,
          plan.arrivalStart + 0.4, plan.arrivalStart + 1.6];
      for (const t of instants) {
        await page.evaluate(([kind, time]) => NMS.holdTransit(kind, time), [mode, t]);
        await frames(24);
        const name = `${out}/${mode}-${t.toFixed(2).padStart(6, '0')}.png`;
        await page.screenshot({ path: name });
        console.log('✓', name);
      }
      await page.evaluate(() => NMS.releaseTransit());
      await frames(10);
    } else if (mode === 'live-pulse') {
      await page.evaluate(() => NMS.setPulse(true));
      const start = Date.now();
      for (let i = 0; i < 14; i++) {
        const name = `${out}/live-pulse-${String(Date.now() - start).padStart(5, '0')}.png`;
        await page.screenshot({ path: name });
        console.log('✓', name);
      }
      await page.waitForTimeout(1500);
    } else if (mode === 'live-warp') {
      const target = await page.evaluate(() => NMS.warpToStar());
      console.log('warp target', target);
      const start = Date.now();
      while (await page.evaluate(() => NMS.stats().state === 'warp')) {
        const stats = await page.evaluate(() => NMS.stats().transit);
        const name = `${out}/live-warp-${String(Date.now() - start).padStart(6, '0')}-t${(stats?.t ?? 0).toFixed(2)}.png`;
        await page.screenshot({ path: name });
        console.log('✓', name);
        await page.waitForTimeout(350);
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/live-warp-arrived.png` });
    }
  }
} finally {
  await browser.close();
  server.close();
}
