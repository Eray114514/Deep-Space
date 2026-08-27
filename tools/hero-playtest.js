// WebGL title-screen -> flight hand-off regression.
//
// The ship must start moving immediately, follow one monotonic pull-back, and
// discover no new shader programs after the player presses "开始游戏". Those
// are the two player-visible causes of the old pause-then-pop entrance.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { startServer } from './server.js';

const outputDir = path.resolve('screenshots/halcyon');
await mkdir(outputDir, { recursive: true });

let browser;
let server;
const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`✓ ${message}`);
  else {
    failures.push(message);
    console.error(`✗ ${message}`);
  }
};

try {
  const started = await startServer(0);
  server = started.server;
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  const url = `http://127.0.0.1:${started.port}/?quality=low&post=0&vclouds=0&farflora=0`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 150000 });
  await page.click('#hero-splash');
  await page.waitForFunction(() => {
    const hero = document.querySelector('#hero-overlay');
    const start = document.querySelector('#hero-start-btn');
    return hero && start && !hero.classList.contains('hidden') && !start.disabled;
  }, null, { timeout: 10000 });
  await page.waitForTimeout(900);

  const before = await page.evaluate(() => ({
    programs: NMS._renderer.info.programs?.length || 0,
    programIds: (NMS._renderer.info.programs || []).map((program) => program.id),
    programKeys: (NMS._renderer.info.programs || []).map((program) => program.cacheKey || ''),
    offset: NMS._internals.ship.introOffset.length(),
  }));
  await page.evaluate((programIds) => {
    window.__heroProgramIds = programIds;
    const trace = { startedAt: 0, clickedAt: 0, frames: [] };
    window.__heroPlaytest = trace;
    document.querySelector('#hero-start-btn')?.addEventListener('click', () => {
      trace.clickedAt = performance.now();
    }, { capture: true, once: true });
    const sample = (now) => {
      if (!trace.startedAt) trace.startedAt = now;
      trace.frames.push({
        elapsed: now - trace.startedAt,
        offset: NMS._internals.ship.introOffset.length(),
        programs: NMS._renderer.info.programs?.length || 0,
        heroActive: document.body.classList.contains('hero-active'),
      });
      if (now - trace.startedAt < 3800) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, before.programIds);
  await page.click('#hero-start-btn');
  await page.waitForFunction(() => !document.body.classList.contains('hero-active')
    && NMS._internals.ship.introOffset.length() < 0.001, null, { timeout: 30000 });
  await page.waitForTimeout(900);

  const result = await page.evaluate(() => ({
    frames: window.__heroPlaytest.frames,
    programs: NMS._renderer.info.programs?.length || 0,
    newPrograms: (NMS._renderer.info.programs || [])
      .filter((program) => !window.__heroProgramIds?.includes(program.id))
      .map((program) => ({ id: program.id, name: program.name || '', cacheKey: program.cacheKey || '' })),
    clickedAt: window.__heroPlaytest.clickedAt,
    startedAt: window.__heroPlaytest.startedAt,
    offset: NMS._internals.ship.introOffset.length(),
  }));
  const offsets = result.frames.map((frame) => frame.offset);
  const clickElapsed = result.clickedAt - result.startedAt;
  const earlyMotion = result.frames.some((frame) => frame.elapsed >= clickElapsed
    && frame.elapsed - clickElapsed <= 850
    && frame.offset < before.offset - 0.1);
  const monotonic = offsets.every((value, index) => index === 0
    || value <= offsets[index - 1] + 0.025);

  check(before.offset > 120 && earlyMotion,
    'hero ship moves during the opening 850 ms instead of waiting then popping');
  check(monotonic && result.offset < 0.001,
    'hero ship follows one monotonic path into formation');
  check(result.programs === before.programs && result.newPrograms.length === 0,
    `hero click creates no shader programs (${before.programs} before / ${result.programs} after)`);
  if (result.programs !== before.programs) {
    console.log('new hero programs:', result.newPrograms);
    for (const program of result.newPrograms.filter((item) => item.cacheKey.includes('dress|'))) {
      const suffix = program.cacheKey.slice(program.cacheKey.indexOf('dress|'));
      const oldKey = before.programKeys.find((key) => key.endsWith(suffix));
      if (!oldKey) continue;
      const oldParts = oldKey.split(',');
      const newParts = program.cacheKey.split(',');
      console.log('matching prewarm variant differs at:', newParts
        .map((value, index) => value === oldParts[index] ? null : `${index}:${oldParts[index]}=>${value}`)
        .filter(Boolean));
    }
  }
  check(pageErrors.length === 0, `hero hand-off has no page errors (${pageErrors.length})`);

  await page.screenshot({
    path: path.join(outputDir, '00-hero-handoff.png'),
    fullPage: false,
  });
} finally {
  await browser?.close();
  server?.close();
}

if (failures.length) {
  throw new Error(`Hero hand-off failed: ${failures.join('; ')}`);
}
console.log('DONE - hero hand-off is continuous and prewarmed');
