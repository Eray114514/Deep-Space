import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const OUT = 'test-results/stage-a-coast-diag';
await mkdir(OUT, { recursive: true });

function blackPixelCount(buffer) {
  const png = PNG.sync.read(buffer);
  let black = 0, coastBand = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const isBlack = png.data[i] <= 2 && png.data[i + 1] <= 2 && png.data[i + 2] <= 2
        && png.data[i + 3] > 250;
      if (!isBlack) continue;
      black++;
      if (y >= 850 && y <= 1030 && ((x >= 180 && x <= 610) || (x >= 1440 && x <= 1870))) {
        coastBand++;
      }
    }
  }
  return { black, coastBand };
}

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) throw new Error('Hardware WebGPU browser required.');
const page = await browser.newPage({ viewport: { width: 2048, height: 1200 } });

async function capture(name) {
  await page.waitForTimeout(700);
  const buffer = await page.screenshot();
  await writeFile(join(OUT, `${name}.png`), buffer);
  return { name, ...blackPixelCount(buffer) };
}

try {
  const url = `http://127.0.0.1:${port}/?renderer=webgpu&quality=high&worldlab=1`
    + '&nolock=1&nohero=1&farflora=0&freeze=1&vclouds=0&post=0&buildms=120';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 90000 });
  try {
    await page.waitForFunction('NMS.idle()', null, { timeout: 180000 });
  } catch {
    console.warn('startup LOD did not fully settle before coast placement');
  }
  const coast = await page.evaluate(() => NMS.setWade(0, { depth: 0.9, overview: true }));
  if (!coast?.overview) throw new Error(`Unable to resolve deterministic coast: ${JSON.stringify(coast)}`);
  // Let one near-surface frame enqueue the newly required LOD before asking
  // whether the queue is idle; checking immediately observes the old orbit.
  await page.waitForTimeout(1200);
  console.warn('coast fixture', JSON.stringify(await page.evaluate(() => ({
    stats: NMS.stats(),
    pos: NMS.pos(),
  }))));
  try {
    await page.waitForFunction('NMS.idle()', null, { timeout: 600000 });
  } catch {
    console.warn('coast settle timeout; capturing the completed visible LOD state');
  }
  await page.waitForTimeout(1800);

  const results = [];
  results.push(await capture('baseline'));

  await page.evaluate(() => {
    const planet = NMS._internals.universe.system.planets[0];
    const trimSkirts = (node) => {
      if (node.mesh) {
        const n = planet.gridCellsAtLevel(node.level);
        node.mesh.geometry.setDrawRange(0, n * n * 6);
      }
      node.children?.forEach(trimSkirts);
    };
    planet.lod.roots.forEach(trimSkirts);
  });
  results.push(await capture('terrain-no-skirts'));

  await page.evaluate(() => {
    const planet = NMS._internals.universe.system.planets[0];
    planet.lod.setVisible(false);
  });
  results.push(await capture('water-only'));

  await page.evaluate(() => {
    const planet = NMS._internals.universe.system.planets[0];
    planet.lod.setVisible(true);
    planet.waterLod.setVisible(false);
  });
  results.push(await capture('terrain-only'));

  console.log(JSON.stringify(results, null, 2));
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
