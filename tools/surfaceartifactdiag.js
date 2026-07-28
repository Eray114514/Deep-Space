import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('Surface artifact diagnostic skipped: no hardware WebGPU browser.');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const outputDir = new URL('../test-results/surface-artifact/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const factor = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 0.86;
const suffix = factor.toFixed(3).replace('.', '-');
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + `&nohero=1&farflora=0&vclouds=0&scene=orbit&planet=0&factor=${factor}&time=9.5`);
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  await page.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    NMS.setWeatherFixture(0, 'clear');
  });
  // Global NMS.idle() includes every background body. A close-orbit surface
  // capture only needs the focused planet's visible quadtree to settle; after
  // the universe grew to 10 bodies, waiting for unrelated hidden queues could
  // time out long after the photographed surface had stopped changing.
  let stableSamples = 0;
  let previousFocusedChunks = -1;
  for (let attempt = 0; attempt < 90 && stableSamples < 5; attempt++) {
    await page.waitForTimeout(1000);
    const focusedChunks = await page.evaluate(() => NMS._planet(0).lod.countChunks());
    if (focusedChunks === previousFocusedChunks) stableSamples++;
    else stableSamples = 0;
    previousFocusedChunks = focusedChunks;
  }
  if (stableSamples < 5) {
    throw new Error(`Focused terrain did not settle; last chunk count ${previousFocusedChunks}.`);
  }
  await writeFile(new URL(`all-layers-${suffix}.png`, outputDir), await page.screenshot());
  const baseline = await page.evaluate(() => {
    const planet = NMS._planet(0);
    return {
      terrainChunks: planet.lod.countChunks(),
      waterChunks: planet.waterLod?.countChunks(),
      terrainLevelCap: planet.lod._levelCap,
      waterLevelCap: planet.waterLod?._levelCap,
      orbitLevelCap: planet.orbitLevelCap,
      waterOrbitLevelCap: planet.waterLod?.planet?.orbitLevelCap,
      runtime: NMS.stats(),
    };
  });
  await page.evaluate(() => {
    const planet = NMS._planet(0);
    planet.waterLod?.setVisible(false);
  });
  await page.waitForTimeout(300);
  await writeFile(new URL(`water-hidden-${suffix}.png`, outputDir), await page.screenshot());
  await page.evaluate(() => {
    const planet = NMS._planet(0);
    planet.waterLod?.setVisible(true);
    if (planet.volCloudMesh) planet.volCloudMesh.visible = false;
    if (planet.cloudMesh) planet.cloudMesh.visible = false;
    if (planet.cloudMesh2) planet.cloudMesh2.visible = false;
    planet.atmoMesh.visible = false;
  });
  await page.waitForTimeout(300);
  await writeFile(new URL(`surface-only-${suffix}.png`, outputDir), await page.screenshot());
  await page.evaluate(() => {
    const planet = NMS._planet(0);
    planet.group.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
  });
  await page.waitForTimeout(300);
  await writeFile(new URL(`surface-no-shadows-${suffix}.png`, outputDir), await page.screenshot());
  console.log(JSON.stringify(baseline, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
