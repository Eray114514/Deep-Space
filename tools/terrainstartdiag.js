import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';
import assert from 'node:assert/strict';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('System Chrome/Edge is required for terrain startup diagnostics.');
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

async function sample(label) {
  return page.evaluate((sampleLabel) => {
    const { universe } = NMS._internals;
    const planet = universe.system.planets[0];
    return {
      label: sampleLabel,
      time: Math.round(performance.now()),
      frame: NMS.frame(),
      booted: NMS.booted,
      planet: planet.lod.debugStats(),
      water: planet.waterLod?.debugStats?.() || null,
    };
  }, label);
}

try {
  const started = performance.now();
  await page.goto(`http://127.0.0.1:${port}/?renderer=auto&quality=high&farflora=0`);
  await page.waitForFunction('Boolean(window.NMS)', null, { timeout: 90000 });
  const timeline = [];
  for (let tick = 0; tick < 30; tick++) {
    const state = await sample(`loading+${(tick * 0.5).toFixed(1)}s`);
    timeline.push(state);
    if (state.booted) break;
    await page.waitForTimeout(500);
  }
  if (!timeline.at(-1).booted) throw new Error('startup did not clear within the diagnostic window');
  if (process.env.TERRAIN_HOLD_MS) {
    for (let elapsed = 1000; elapsed <= Number(process.env.TERRAIN_HOLD_MS); elapsed += 1000) {
      await page.waitForTimeout(1000);
      timeline.push(await sample(`hero-idle+${elapsed / 1000}s`));
    }
  } else {
    await page.click('#hero-start-btn');
    for (const [label, delay] of [
      ['start+0.25s', 250], ['start+0.75s', 500], ['start+1.5s', 750],
      ['start+2.8s', 1300], ['control+1s', 1000], ['control+2s', 1000],
    ]) {
      await page.waitForTimeout(delay);
      timeline.push(await sample(label));
    }
  }
  const cleared = timeline.find((entry) => entry.booted);
  assert.ok(cleared, 'loading mask never cleared');
  for (const stats of [cleared.planet, cleared.water]) {
    if (!stats) continue;
    assert.equal(stats.pending, 0, 'startup released with terrain still building');
    assert.equal(stats.activeMorphs, 0, 'startup released during a visible LOD morph');
  }
  const handoff = timeline.find((entry) => entry.label === 'start+2.8s');
  if (handoff) {
    for (const stats of [handoff.planet, handoff.water]) {
      if (!stats) continue;
      assert.equal(stats.pending, 0, 'control handoff still has queued visible terrain');
      assert.equal(stats.activeMorphs, 0, 'control handoff still has a visible LOD morph');
    }
  }
  console.log(JSON.stringify({
    loadMs: Math.round(performance.now() - started), timeline, errors,
  }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
