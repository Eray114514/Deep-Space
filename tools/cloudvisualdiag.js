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
const factor = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 0.86;
const fixtures = (process.argv[3] || 'default,cumulus,stratus,storm,clear')
  .split(',').map((value) => value.trim()).filter(Boolean);
const referenceView = process.env.CLOUD_REFERENCE === '1'
  || process.argv.includes('--reference');
const horizonView = referenceView || process.env.CLOUD_HORIZON === '1';
const suffix = factor.toFixed(3).replace('.', '-');
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + `&nohero=1&farflora=0&vclouds=1&scene=orbit&planet=0&factor=${factor}&time=9.5`);
  try {
    await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 120000 });
  } catch (error) {
    const bootState = await page.evaluate(() => ({
      hasNms: Boolean(window.NMS),
      booted: window.NMS?.booted ?? null,
      bodyText: document.body?.innerText?.slice(0, 1200) || '',
      loading: document.querySelector('#loading')?.textContent || '',
    })).catch(() => null);
    console.error('cloud diagnostic boot state', JSON.stringify({ bootState, errors }, null, 2));
    throw error;
  }
  await page.evaluate(() => NMS.setAdaptiveQualityLocked(true));
  if (referenceView) {
    await page.evaluate(() => document.body.classList.add('hide-hud'));
  }
  for (const fixture of fixtures) {
    const state = await page.evaluate(({
      name, altitudeFactor, useHorizon, useReference,
    }) => {
      NMS.setWeatherFixture(0, name === 'default' ? null : name);
      const planet = NMS._planet(0);
      // Put the selected meteorological structure on the camera-facing
      // hemisphere. A fixed scenic direction can legitimately be clear while
      // a cyclone exists on the far side; that proves neither presence nor
      // visual quality of the requested cloud family.
      let targetDirection = null;
      let targetAtlasDirection = null;
      let targetScore = -Infinity;
      const cloudSpin = planet.weatherHours
        * (planet.weatherField?.windRadiansPerHour || 0.05);
      const spinCos = Math.cos(cloudSpin);
      const spinSin = Math.sin(cloudSpin);
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      for (let index = 0; index < 4096; index++) {
        const y = 1 - 2 * (index + 0.5) / 4096;
        const radius = Math.sqrt(Math.max(0, 1 - y * y));
        const angle = index * goldenAngle;
        const direction = [
          Math.cos(angle) * radius,
          y,
          Math.sin(angle) * radius,
        ];
        // The atlas stores weather hour zero and the production deck advects
        // it around local Y. Score the actual rendered direction, not the
        // unrotated source texel or the more complex CPU forecast evolution.
        const visibleDirection = [
          direction[0] * spinCos + direction[2] * spinSin,
          direction[1],
          -direction[0] * spinSin + direction[2] * spinCos,
        ];
        const weather = planet.weatherAt(direction, 0);
        const morphology = weather.morphology || {};
        const daylight = Math.max(0, Math.min(1,
          (visibleDirection[0] * planet.sunDirLocal.x
            + visibleDirection[1] * planet.sunDirLocal.y
            + visibleDirection[2] * planet.sunDirLocal.z + 0.08) / 0.38));
        let score = weather.coverage;
        if (name === 'storm') {
          score = (morphology.eyewall || 0) * 2.4
            + (morphology.spiral || 0) * 0.8
            + weather.coverage * 0.35;
        } else if (name === 'cumulus') {
          score = weather.coverage * (1 - weather.stratusMask * 0.75)
            + weather.convective * 0.55;
        } else if (name === 'stratus') {
          score = weather.coverage * 0.45 + weather.stratusMask;
        } else if (name === 'clear') {
          score = 1 - weather.coverage;
        }
        // Keep diagnostics on the lit hemisphere. The cloud field remains
        // global; this only prevents a valid nightside storm from turning a
        // visual-quality capture into an unreadable black frame.
        score *= daylight;
        if (score > targetScore) {
          targetScore = score;
          targetDirection = visibleDirection;
          targetAtlasDirection = direction;
        }
      }
      if (targetDirection) {
        NMS.teleport(0, altitudeFactor, {
          dir: targetDirection,
          horizon: useHorizon,
          // At 0.45 R altitude the geometric limb is about 46 degrees below a
          // tangent sightline. Pitching down roughly 60 degrees puts that limb
          // near the upper fifth and exposes oblique cloud-top relief.
          pitch: useReference ? -1.05 : useHorizon ? -0.14 : undefined,
        });
      }
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
      const sampleCanvasDirection = (canvas, direction) => {
        if (!canvas || !direction) return null;
        const u = ((Math.atan2(direction[2], direction[0])
          / (Math.PI * 2)) % 1 + 1) % 1;
        const v = Math.asin(Math.max(-1, Math.min(1, direction[1])))
          / Math.PI + 0.5;
        const x = Math.min(canvas.width - 1, Math.floor(u * canvas.width));
        const y = Math.min(canvas.height - 1, Math.floor(v * canvas.height));
        const pixel = canvas.getContext('2d', { willReadFrequently: true })
          .getImageData(x, y, 1, 1).data;
        return {
          uv: [u, v],
          rgba: Array.from(pixel, (value) => Number((value / 255).toFixed(4))),
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
        targetDirection,
        targetAtlasDirection,
        targetScore,
        targetWeather: targetAtlasDirection
          ? planet.weatherAt(targetAtlasDirection, 0) : null,
        targetAtlas: sampleCanvasDirection(lo, targetAtlasDirection),
        cloudQuaternion: planet.cloudMesh?.quaternion?.toArray?.() || null,
      };
    }, {
      name: fixture,
      altitudeFactor: factor,
      useHorizon: horizonView,
      useReference: referenceView,
    });
    await page.waitForFunction('NMS.idle()', null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    await writeFile(new URL(`${fixture}-orbit-${suffix}.png`, outputDir), await page.screenshot());
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      if (planet.volCloudMat) planet.volCloudMat.visible = false;
    });
    await page.waitForTimeout(180);
    await writeFile(new URL(`${fixture}-analytic-${suffix}.png`, outputDir),
      await page.screenshot());
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      if (planet.volCloudMat) planet.volCloudMat.visible = true;
      for (const mesh of [
        planet.cloudMesh, planet.cloudMesh2, planet.cloudMeshNoctilucent,
      ]) {
        if (mesh?.material) mesh.material.visible = false;
      }
    });
    await page.waitForTimeout(180);
    await writeFile(new URL(`${fixture}-volume-${suffix}.png`, outputDir),
      await page.screenshot());
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      for (const mesh of [
        planet.cloudMesh, planet.cloudMesh2, planet.cloudMeshNoctilucent,
      ]) {
        if (mesh?.material) mesh.material.visible = true;
      }
      if (planet.volCloudMat?.uniforms?.uDepthReady) {
        planet.volCloudMat.uniforms.uDepthReady.value = 0;
      }
    });
    await page.waitForTimeout(180);
    await writeFile(new URL(`${fixture}-cloud-depth-disabled-${suffix}.png`, outputDir),
      await page.screenshot());
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      if (planet.volCloudMat?.uniforms?.uDepthReady) {
        planet.volCloudMat.uniforms.uDepthReady.value = 1;
      }
    });
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      if (planet.terrainMaterial) planet.terrainMaterial.visible = false;
      if (planet.liquidMat) planet.liquidMat.visible = false;
      if (planet.atmoMesh?.material) planet.atmoMesh.material.visible = false;
    });
    await page.waitForTimeout(250);
    await writeFile(new URL(`${fixture}-cloud-only-${suffix}.png`, outputDir),
      await page.screenshot());
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      if (planet.terrainMaterial) planet.terrainMaterial.visible = true;
      if (planet.liquidMat) planet.liquidMat.visible = true;
      if (planet.atmoMesh?.material) planet.atmoMesh.material.visible = true;
    });
    if (fixture === 'default') {
      await page.evaluate(() => NMS._planet(0).waterLod?.setVisible(false));
      await page.waitForTimeout(200);
      await writeFile(new URL(`default-water-hidden-${suffix}.png`, outputDir),
        await page.screenshot());
      await page.evaluate(() => NMS._planet(0).waterLod?.setVisible(true));
    }
    console.log(fixture, JSON.stringify(state));
  }
  if (fixtures.includes('storm')) await page.evaluate(() => {
    const planet = NMS._planet(0);
    NMS.setWeatherFixture(0, 'storm');
    planet.atmoMesh.visible = false;
  });
  if (fixtures.includes('storm')) {
    await page.waitForTimeout(800);
    await writeFile(new URL('storm-volume-only.png', outputDir), await page.screenshot());
  }
  if (fixtures.includes('storm')) await page.evaluate(() => {
    const planet = NMS._planet(0);
    planet.volCloudMesh.visible = false;
    planet.cloudMesh.visible = true;
    planet.cloudMesh.material.opacity = 0.88;
    if (planet.cloudMesh.material.userData.opacityNodeUniform) {
      planet.cloudMesh.material.userData.opacityNodeUniform.value = 0.88;
    }
  });
  if (fixtures.includes('storm')) {
    await page.waitForTimeout(400);
    await writeFile(new URL('storm-analytic-only.png', outputDir), await page.screenshot());
  }
  if (fixtures.includes('storm')) await page.evaluate(() => {
    const planet = NMS._planet(0);
    planet.cloudMesh.visible = false;
    planet.volCloudMesh.visible = true;
    planet.volCloudMat.uniforms.uDebugShell.value = 1;
  });
  if (fixtures.includes('storm')) {
    await page.waitForTimeout(400);
    await writeFile(new URL('storm-debug-shell.png', outputDir), await page.screenshot());
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
