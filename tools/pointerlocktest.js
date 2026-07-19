import { chromium } from 'playwright';
import { startServer } from './server.js';

const { server, port } = await startServer(0);
const chrome = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });

try {
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&quality=low&post=0&vclouds=0&farflora=0`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  await page.locator('#app canvas').click({ position: { x: 550, y: 350 } });
  await page.waitForFunction(() => document.pointerLockElement === document.querySelector('#app canvas'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.pointerLockElement && !document.getElementById('pause-overlay').classList.contains('hidden'));
  const resumeBox = await page.locator('#resume-btn').boundingBox();
  if (!resumeBox) throw new Error('Resume button has no clickable bounds.');
  await page.mouse.move(resumeBox.x + resumeBox.width / 2, resumeBox.y + resumeBox.height / 2);
  // Reproduce the browser race directly: pointer lock may suppress the click
  // after this trusted pointerdown, so resuming must not depend on pointerup.
  await page.mouse.down();
  await page.waitForFunction(() => document.pointerLockElement === document.querySelector('#app canvas')
    && document.getElementById('pause-overlay').classList.contains('hidden'));
  await page.mouse.up();
  const before = await page.evaluate('NMS._internals.nav.quat.toArray()');
  await page.mouse.move(780, 420);
  await page.waitForTimeout(100);
  const after = await page.evaluate('NMS._internals.nav.quat.toArray()');
  const state = await page.evaluate(() => ({
    locked: document.pointerLockElement === document.querySelector('#app canvas'),
    pauseHidden: document.getElementById('pause-overlay').classList.contains('hidden'),
  }));
  const moved = after.some((value, index) => Math.abs(value - before[index]) > 1e-5);
  if (!state.locked || !state.pauseHidden || !moved) {
    throw new Error(`Pointer Lock resume failed: ${JSON.stringify({ ...state, moved })}`);
  }
  console.log('PASS: resume reacquires Pointer Lock and immediately restores camera input.');
} finally {
  await browser.close();
  server.close();
}
