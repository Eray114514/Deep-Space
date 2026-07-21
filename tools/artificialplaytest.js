import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

function check(condition, message) {
  console.log(`${condition ? '✓' : '✗'} ${message}`);
  if (!condition) process.exitCode = 1;
}

try {
  const url = `http://127.0.0.1:${port}/?quality=low&nolock=1&nohero=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  const heroes = await page.evaluate(() => NMS._internals.universe.civilizationSites
    .filter((site) => site.role === 'hero')
    .map((site) => ({ id: site.id, type: site.type, systemId: site.systemId })));
  check(heroes.length === 2, 'the live catalogue exposes both hero destinations');

  for (const hero of heroes) {
    await page.evaluate((systemId) => {
      const { universe, nav } = NMS._internals;
      const star = universe.starById(systemId);
      universe.setSystem(star, false);
      nav.pos.copy(star.pos).add(new NMS._THREE.Vector3(0, 0, 5e8));
    }, hero.systemId);
    await page.waitForFunction((siteId) => {
      const entry = NMS._internals.universe.system.artificialSites
        .find((item) => item.site.id === siteId);
      return entry?.group.userData.heroAssetReady === true;
    }, hero.id, { timeout: 30000 });
    const asset = await page.evaluate((siteId) => {
      const entry = NMS._internals.universe.system.artificialSites
        .find((item) => item.site.id === siteId);
      return { ready: entry?.group.userData.heroAssetReady, error: entry?.group.userData.heroAssetError };
    }, hero.id);
    check(asset.ready && !asset.error, `${hero.type} decodes and mounts its Meshopt hero asset`);
  }

  const frame = await page.evaluate(() => {
    const system = NMS._internals.universe.system;
    const index = system.planets.findIndex((body) => body.type === 'artificialHabitat');
    return { start: NMS.frame(), landed: NMS.land(index), index };
  });
  await page.waitForFunction((start) => NMS.frame() > start + 5, frame.start, { timeout: 30000 });
  const landing = await page.evaluate(() => {
    const { universe, scene } = NMS._internals;
    scene.updateMatrixWorld(true);
    const habitat = universe.system.planets.find((body) => body.type === 'artificialHabitat');
    const deck = universe.system.artificialSites[0].group.getWorldPosition(new NMS._THREE.Vector3());
    return {
      state: NMS.state,
      deckDistance: deck.length(),
      expected: habitat.deckTop + 1.7,
      altitude: NMS.alt(),
    };
  });
  check(frame.landed && landing.state === 'walk', 'floating-city landing enters walk mode');
  check(Math.abs(landing.deckDistance - landing.expected) < 0.05,
    `walk collision matches the visible deck (${landing.deckDistance.toFixed(2)} m)`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  const reloaded = await page.evaluate(() => NMS._internals.universe.civilizationSites
    .filter((site) => site.role === 'hero')
    .map((site) => ({ id: site.id, type: site.type, systemId: site.systemId })));
  check(JSON.stringify(reloaded) === JSON.stringify(heroes), 'hero destinations remain stable across a real reload');
  check(errors.length === 0, 'artificial-world traversal produces no page errors');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

