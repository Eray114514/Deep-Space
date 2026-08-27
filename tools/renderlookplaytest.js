import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const output = path.resolve('test-results/render-look');
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const errors = [];
const check = (condition, message) => {
  if (condition) console.log(`✓ ${message}`);
  else { failures.push(message); console.error(`✗ ${message}`); }
};
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/?quality=performance&nolock=1&nohero=1`
    + '&post=1&vclouds=0&farflora=0&freeze=1&buildms=25');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 120000 });
  await page.waitForTimeout(800);
  const { state, agx } = await page.evaluate(() => ({
    state: NMS.renderLookState(),
    agx: NMS._THREE.AgXToneMapping,
  }));
  check(state.production && state.enabled, 'unified render look is the production default');
  check(state.toneMapping === agx, 'AgX owns production tone mapping');
  check(state.space?.minLuma > 0.003, 'every generated sky direction stays above black');
  check(state.space?.bandMeanLuma > state.space?.outsideMeanLuma * 3.5,
    'the Milky Way remains dominant over the diffuse floor');
  check(state.cabinBake?.fixtures >= 10 && state.cabinBake?.vertices > 1000,
    'cabin indirect irradiance is baked from the real fixture rig');

  const layers = await page.evaluate(() => {
    const { ship } = NMS._internals;
    const collect = (root) => {
      const masks = new Set();
      root.traverse((object) => masks.add(object.layers.mask));
      return [...masks];
    };
    return {
      exterior: collect(ship.ext.group),
      interior: collect(ship.int.group),
      sun: ship.sun.layers.mask,
      cabinLights: ship.int.lights.map((light) => light.layers.mask),
    };
  });
  check(layers.exterior.every((mask) => mask === (1 << 3)),
    'flying exterior remains in the foreground light domain');
  check(layers.interior.every((mask) => mask === (1 << 6)),
    'cabin geometry and fixtures occupy only the isolated interior domain');
  check(layers.cabinLights.every((mask) => mask === (1 << 6)),
    'cabin lights cannot leak onto the hull or world');

  await page.screenshot({ path: path.join(output, '01-chase.png') });
  for (const component of ['direct', 'indirect', 'reflections', 'background']) {
    const isolated = await page.evaluate((name) => ({
      selected: NMS.setRenderLookIsolation(name),
      state: NMS.renderLookState(),
    }), component);
    check(isolated.selected === component
      && Object.entries(isolated.state.components)
        .every(([name, enabled]) => enabled === (name === component)),
    `${component} can be isolated at the fixed chase camera`);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(output, `isolate-chase-${component}.png`) });
  }
  await page.evaluate(() => NMS.setRenderLookIsolation('all'));
  await page.keyboard.press('KeyV');
  await page.waitForFunction('NMS.shipViewState().viewBlend >= 0.999', null, { timeout: 30000 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, '02-cockpit.png') });
  await page.keyboard.press('KeyF');
  await page.waitForFunction('NMS.shipViewState().seatT >= 0.999 && NMS.state === "shipwalk"',
    null, { timeout: 30000 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, '03-cabin.png') });
  for (const component of ['localLights', 'indirect', 'reflections']) {
    await page.evaluate((name) => NMS.setRenderLookIsolation(name), component);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(output, `isolate-cabin-${component}.png`) });
  }
  await page.evaluate(() => NMS.setRenderLookIsolation('all'));
  check(errors.length === 0, `render look has no browser/shader errors (${errors.length})`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length || errors.length) {
  throw new Error(`Render-look playtest failed: ${[...failures, ...errors].join('; ')}`);
}
console.log('PASS: fixed chase/cockpit/cabin render-look matrix');
