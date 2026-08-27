import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const output = path.resolve('test-results/render-look');
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser({ headless: true });
const errors = [];

function attachErrors(page) {
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
}

function frameStats(buffer) {
  const png = PNG.sync.read(buffer);
  let black = 0, luma = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const value = png.data[i] * 0.2126 + png.data[i + 1] * 0.7152 + png.data[i + 2] * 0.0722;
    if (value <= 1) black++;
    luma += value;
  }
  const pixels = png.width * png.height;
  return { blackRatio: black / pixels, meanLuma: luma / pixels };
}

async function boot(page, extra = '') {
  await page.goto(`http://127.0.0.1:${port}/?quality=performance&nolock=1&nohero=1`
    + `&post=1&vclouds=0&freeze=1&buildms=25${extra}`);
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 120000 });
}

try {
  const world = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  attachErrors(world);
  await boot(world);

  assert.equal(await world.evaluate(() => NMS.land(2, 0, 'sunset')), true);
  await world.evaluate(() => {
    NMS.setSunAltitude(2, 32);
    NMS.faceShip();
  });
  await world.keyboard.down('KeyS');
  await world.waitForTimeout(900);
  await world.keyboard.up('KeyS');
  await world.evaluate(() => NMS.faceShip());
  await world.waitForTimeout(500);
  await world.screenshot({ path: path.join(output, '04-parked-day.png') });
  const parked = await world.evaluate(() => ({
    state: NMS.state,
    foreground: NMS._internals.ship.foregroundOnly,
    interiorLayer: NMS._internals.ship.int.group.layers.mask,
  }));
  assert.equal(parked.state, 'walk');
  assert.equal(parked.foreground, false);
  assert.equal(parked.interiorLayer, 1 << 6);

  await world.evaluate(() => {
    NMS.setSunAltitude(2, -10);
    NMS.faceShip();
  });
  await world.waitForTimeout(650);
  await world.screenshot({ path: path.join(output, '05-parked-night.png') });

  assert.equal(await world.evaluate(() => NMS.land(0, 0, 'meadow')), true);
  await world.waitForTimeout(650);
  await world.screenshot({ path: path.join(output, '06-terrain-vegetation.png') });

  const waterIndex = await world.evaluate(() => NMS.planets()
    .find((planet) => planet.liquid === 'water' || planet.liquid === 'toxic')?.i ?? -1);
  if (waterIndex >= 0) {
    const water = await world.evaluate((index) => NMS.setWade(index, {
      depth: 0.9,
      overview: true,
    }), waterIndex);
    assert(water?.actualDepth > 0.3 && water.actualDepth < 2.5,
      'fixed water camera did not reach the shoreline');
    await world.waitForTimeout(900);
    await world.screenshot({ path: path.join(output, '07-water.png') });
  }

  const floatingHero = await world.evaluate(() => NMS._internals.universe.civilizationSites
    .find((site) => site.type === 'hero-floating-city'));
  assert(floatingHero, 'curated artificial hero destination is missing');
  await world.evaluate((systemId) => {
    const { universe, nav } = NMS._internals;
    const star = universe.starById(systemId);
    universe.setSystem(star, false);
    nav.pos.copy(star.pos).add(new NMS._THREE.Vector3(0, 0, 5e8));
  }, floatingHero.systemId);
  await world.waitForFunction((siteId) => {
    const entry = NMS._internals.universe.system.artificialSites
      .find((item) => item.site.id === siteId);
    return entry?.group.userData.heroAssetReady === true;
  }, floatingHero.id, { timeout: 30000 });
  const artificial = await world.evaluate((normal) => {
    const { universe } = NMS._internals;
    const index = universe.system.planets.findIndex((body) => body.type === 'artificialHabitat');
    const landed = NMS.teleport(index, 0.32, { dir: normal });
    const profiles = new Set();
    let profiledWithEnvironment = 0;
    for (const entry of universe.system.artificialSites) {
      entry.group.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material
          : object.material ? [object.material] : [];
        for (const material of materials) {
          if (!material.userData?.pbrProfile) continue;
          profiles.add(material.userData.pbrProfile);
          if (material.envMap) profiledWithEnvironment++;
        }
      });
    }
    return { landed, profiles: [...profiles], profiledWithEnvironment };
  }, floatingHero.landingZone.normal);
  assert(artificial.landed && artificial.profiles.length >= 3,
    'artificial site did not retain the shared material profiles');
  assert(artificial.profiledWithEnvironment > 0,
    'artificial PBR assets did not receive the explicit deep-space probe');
  await world.waitForTimeout(800);
  await world.screenshot({ path: path.join(output, '08-artificial-site.png') });
  await world.close();

  const sky = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  attachErrors(sky);
  await boot(sky, '&farflora=0');
  await sky.evaluate(() => {
    const { universe, scene, ship } = NMS._internals;
    const allowed = new Set([universe.spaceRadiance?.mesh, universe.backdropMesh, universe.nebulas]);
    for (const object of scene.children) object.visible = allowed.has(object);
    ship.group.visible = false;
    NMS.setAtmosphereVisible?.(false);
  });
  const faces = [
    ['px', [1, 0, 0], [0, 1, 0]], ['nx', [-1, 0, 0], [0, 1, 0]],
    ['py', [0, 1, 0], [0, 0, 1]], ['ny', [0, -1, 0], [0, 0, -1]],
    ['pz', [0, 0, 1], [0, 1, 0]], ['nz', [0, 0, -1], [0, 1, 0]],
  ];
  const skyStats = [];
  for (const [name, direction, up] of faces) {
    await sky.evaluate(({ direction: d, up: u }) => {
      const { nav, camera } = NMS._internals;
      const direction = new NMS._THREE.Vector3(...d);
      const matrix = new NMS._THREE.Matrix4().lookAt(
        new NMS._THREE.Vector3(), direction, new NMS._THREE.Vector3(...u),
      );
      nav.quat.setFromRotationMatrix(matrix);
      camera.quaternion.copy(nav.quat);
    }, { direction, up });
    await sky.waitForTimeout(180);
    const buffer = await sky.locator('canvas').first().screenshot({
      path: path.join(output, `sky-${name}.png`),
    });
    skyStats.push({ name, ...frameStats(buffer) });
  }
  assert(skyStats.every((face) => face.blackRatio < 0.01),
    `one or more sky faces contain a pure-black field: ${JSON.stringify(skyStats)}`);
  const means = skyStats.map((face) => face.meanLuma);
  assert(Math.max(...means) > Math.min(...means) * 1.12,
    'six-face sky lost the Milky Way versus diffuse-space brightness hierarchy');
  await sky.close();
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log(`PASS: parked day/night, water/vegetation, artificial PBR and six-face sky; `
    + `black max ${(Math.max(...skyStats.map((face) => face.blackRatio)) * 100).toFixed(3)}%`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
