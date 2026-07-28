import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('Cloud visual diagnostic skipped: no hardware WebGPU browser.');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const outputDir = new URL('../test-results/cloud-diagnostic/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + '&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=0.86&time=9.5');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 60000 });
  await page.evaluate(() => NMS.setAdaptiveQualityLocked(true));
  for (const fixture of ['cumulus', 'stratus', 'storm', 'clear']) {
    const state = await page.evaluate((name) => {
      NMS.setWeatherFixture(0, name);
      const planet = NMS._planet(0);
      const lo = planet.cloudShadowTex?.image;
      const hi = planet.cloudWeatherHiTex?.image;
      const read = (canvas) => {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const sums = [0, 0, 0, 0];
        const active = [0, 0, 0, 0];
        const count = data.length / 4;
        for (let index = 0; index < data.length; index += 4) {
          for (let channel = 0; channel < 4; channel++) {
            const value = data[index + channel];
            sums[channel] += value;
            if (value > 32) active[channel]++;
          }
        }
        return {
          mean: sums.map((value) => Number((value / count / 255).toFixed(4))),
          active: active.map((value) => Number((value / count).toFixed(4))),
        };
      };
      return {
        lo: lo ? read(lo) : null,
        hi: hi ? read(hi) : null,
        engage: planet.volCloudMat?.uniforms?.uEngage?.value,
        steps: planet.volCloudMat?.uniforms?.uMaxSteps?.value,
        depthReversed: planet.volCloudMat?.uniforms?.uDepthReversed?.value,
        band: planet.volCloudMat?.userData?.band,
        volumeVisible: planet.volCloudMesh?.visible,
      };
    }, fixture);
    await page.waitForTimeout(1600);
    await writeFile(new URL(`${fixture}-orbit.png`, outputDir), await page.screenshot());
    console.log(fixture, JSON.stringify(state));
  }
  await page.evaluate(() => {
    const planet = NMS._planet(0);
    NMS.setWeatherFixture(0, 'storm');
    planet.atmoMesh.visible = false;
  });
  await page.waitForTimeout(800);
  await writeFile(new URL('storm-volume-only.png', outputDir), await page.screenshot());
  await page.evaluate(() => {
    const planet = NMS._planet(0);
    planet.volCloudMesh.visible = false;
    planet.cloudMesh.visible = true;
    planet.cloudMesh.material.opacity = 0.88;
  });
  await page.waitForTimeout(400);
  await writeFile(new URL('storm-analytic-only.png', outputDir), await page.screenshot());
  await page.evaluate(() => {
    const planet = NMS._planet(0);
    planet.cloudMesh.visible = false;
    planet.volCloudMesh.visible = true;
    planet.volCloudMat.uniforms.uDebugShell.value = 1;
  });
  await page.waitForTimeout(400);
  await writeFile(new URL('storm-debug-shell.png', outputDir), await page.screenshot());
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
