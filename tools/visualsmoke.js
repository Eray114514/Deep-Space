import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge with WebGPU is required.');
const outDir = new URL('../test-results/visual-smoke/', import.meta.url);
await mkdir(outDir, { recursive: true });
const volumeClouds = process.env.NMS_VCLOUDS === '0' ? '0' : '1';
const focus = process.env.NMS_SMOKE_FOCUS || 'all';
const atmosphereAltitude = Math.max(0, Number(process.env.NMS_ALTITUDE) || 2000);

async function capture(page, name) {
  await writeFile(new URL(`${name}.png`, outDir), await page.screenshot());
  const stats = await page.evaluate(() => NMS.stats());
  console.log(JSON.stringify({ name, stats }, null, 2));
}

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/?renderer=auto&quality=ultra`
    + `&nohero=1&vclouds=${volumeClouds}&farflora=1&post=1&freeze=1`);
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });

  if (focus === 'all') {
    await page.evaluate(() => NMS.teleport(0, 0.72));
    await page.waitForTimeout(700);
    await capture(page, '01-orbit-volume');
  }

  if (focus === 'all' || focus === 'atmosphere') {
    await page.evaluate((altitude) => NMS.setAtmosphereAltitude(0, altitude, { pitch: -0.2 }),
      atmosphereAltitude);
    await page.waitForTimeout(700);
    await capture(page, '02-lowflight-down');
    await page.evaluate(() => NMS.lookPitch(38));
    await page.waitForTimeout(500);
    await capture(page, '03-lowflight-up');
  }

  let wakeReady = null;
  if (focus === 'all' || focus === 'vegetation') {
    await page.evaluate(() => NMS.land(0, 0, 'meadow'));
    await page.waitForFunction(() => NMS.stats().grassField.total > 50,
      null, { timeout: 12000 });
    await page.waitForTimeout(500);
    await capture(page, '04-walk-meadow');

  }
  if (focus === 'all' || focus === 'water') {
    await page.evaluate(() => NMS.setSunAltitude(0, 35));
    wakeReady = await page.evaluate(() => NMS.setWaterWake(0, { height: 8, speed: 150 }));
    if (wakeReady) {
      await page.waitForTimeout(3800);
      await capture(page, '05-water-wake');
      console.log(JSON.stringify({ waterField: await page.evaluate(() => NMS.waterField()) }, null, 2));
    }
  }

  console.log(JSON.stringify({ errors, wakeReady }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
