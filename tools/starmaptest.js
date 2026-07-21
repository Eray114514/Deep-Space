import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1536, height: 960 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

try {
  await page.goto(`http://127.0.0.1:${port}/?quality=low&nolock=1&nohero=1&renderer=webgl&farflora=0&vclouds=0&freeze=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  await page.evaluate(() => NMS.openStarMap());
  await page.waitForFunction(() => {
    const map = document.querySelector('#starmap-overlay')?.__starMapController;
    return map?.rendererReady && map.mapPositions?.length > 0;
  });

  const audit = await page.evaluate(() => {
    const map = document.querySelector('#starmap-overlay').__starMapController;
    const bh = map.getUniverse().specialDestinations[0];
    map.selectStar(bh, false);
    const globalIndex = map.globalStars.findIndex((star) => star.id === bh.id);
    const localIndex = map.localStars.findIndex((star) => star.id === bh.id);
    const canonical = map.globalMapPositions[globalIndex].clone();
    map.controls.target.copy(canonical);
    const rect = map.renderer.domElement.getBoundingClientRect();
    const project = (position) => {
      const p = position.clone().project(map.camera);
      return {
        x: (p.x * 0.5 + 0.5) * rect.width,
        y: (-p.y * 0.5 + 0.5) * rect.height,
      };
    };
    const samples = [];
    for (const distance of [22, 60, 96, 150]) {
      map.camera.position.set(canonical.x, canonical.y + distance, canonical.z + 0.01);
      map.controls.update();
      map.updateGalaxyOverview(true);
      map.updateMapLabels();
      map.scene.updateMatrixWorld(true);
      map.camera.updateMatrixWorld(true);
      const local = project(map.localMapPositions[localIndex]);
      const global = project(map.globalMapPositions[globalIndex]);
      const special = project(map.centralMarker.position);
      const selection = map.world.getObjectByName('selection-marker');
      const selected = selection ? project(selection.position) : null;
      const hit = map.pickStarAt({ clientX: rect.left + global.x, clientY: rect.top + global.y });
      const labelItem = map.labelData.find((item) => item.star.id === bh.id);
      const labelDot = labelItem?.button.querySelector('i')?.getBoundingClientRect();
      const labelDelta = labelDot
        ? Math.hypot(labelDot.left + labelDot.width / 2 - (rect.left + global.x),
          labelDot.top + labelDot.height / 2 - (rect.top + global.y))
        : Infinity;
      const labelOffset = labelDot ? {
        x: labelDot.left + labelDot.width / 2 - (rect.left + global.x),
        y: labelDot.top + labelDot.height / 2 - (rect.top + global.y),
      } : null;
      samples.push({
        distance,
        layerDelta: Math.hypot(local.x - global.x, local.y - global.y),
        specialDelta: Math.hypot(special.x - global.x, special.y - global.y),
        selectionDelta: selected ? Math.hypot(selected.x - global.x, selected.y - global.y) : Infinity,
        centerDelta: Math.hypot(global.x - rect.width / 2, global.y - rect.height / 2),
        labelDelta,
        labelOffset,
        hit: hit?.star.id || null,
      });
    }
    return { id: bh.id, samples };
  });

  for (const sample of audit.samples) {
    assert(sample.layerDelta < 0.05, `local/global star layers split at zoom ${sample.distance}`);
    assert(sample.specialDelta < 0.05, `black-hole marker drifted at zoom ${sample.distance}`);
    assert(sample.selectionDelta < 0.05, `selection marker drifted at zoom ${sample.distance}`);
    assert(sample.centerDelta < 0.1, `zoom-to-target moved the black hole at zoom ${sample.distance}`);
    assert(sample.labelDelta < 1.5,
      `label added a second displaced star point at zoom ${sample.distance} (${JSON.stringify(sample.labelOffset)})`);
    assert.equal(sample.hit, audit.id, `visible black-hole point was not pickable at zoom ${sample.distance}`);
  }
  assert.equal(errors.length, 0, `star map emitted page errors: ${errors.join('\n')}`);

  await mkdir('test-results/starmap', { recursive: true });
  await page.evaluate(() => {
    const map = document.querySelector('#starmap-overlay').__starMapController;
    const target = map.controls.target;
    map.camera.position.set(target.x, target.y + 22, target.z + 0.01);
    map.controls.update();
    map.updateGalaxyOverview(true);
    map.updateMapLabels();
    map.renderer.render(map.scene, map.camera);
  });
  await page.screenshot({ path: 'test-results/starmap/black-hole-near.png' });
  await page.evaluate(() => {
    const map = document.querySelector('#starmap-overlay').__starMapController;
    const target = map.controls.target;
    map.camera.position.set(target.x, target.y + 150, target.z + 0.01);
    map.controls.update();
    map.updateGalaxyOverview(true);
    map.updateMapLabels();
    map.renderer.render(map.scene, map.camera);
  });
  await page.screenshot({ path: 'test-results/starmap/galaxy-overview.png' });
  console.log(`PASS: canonical star-map projection and picking stay aligned across ${audit.samples.length} zoom levels`);
} finally {
  await browser.close();
  try {
    const webgpuBrowser = process.env.SKIP_WEBGPU_STAR_MAP === '1'
      ? null
      : await launchWebGPUHardwareBrowser({ headless: true });
    if (webgpuBrowser) {
    const webgpuPage = await webgpuBrowser.newPage({ viewport: { width: 1536, height: 960 } });
    const webgpuErrors = [];
    webgpuPage.on('pageerror', (error) => webgpuErrors.push(`page: ${error}`));
    webgpuPage.on('console', (message) => {
      if (message.type() === 'error') webgpuErrors.push(`console: ${message.text()}`);
    });
    try {
      await webgpuPage.goto(`http://127.0.0.1:${port}/?quality=low&nolock=1&nohero=1&renderer=webgpu&farflora=0&vclouds=0&freeze=1`, {
        waitUntil: 'domcontentloaded',
      });
      await webgpuPage.waitForFunction(() => window.NMS?.booted === true, null, { timeout: 90000 });
      await webgpuPage.evaluate(() => window.NMS.openStarMap());
      await webgpuPage.waitForFunction(() => {
        const map = document.querySelector('#starmap-overlay')?.__starMapController;
        return map?.rendererReady && map.mapPositions?.length > 0;
      }, null, { timeout: 90000 });
      await webgpuPage.waitForTimeout(1000);
      const webgpuAudit = await webgpuPage.evaluate(() => {
        const map = document.querySelector('#starmap-overlay').__starMapController;
        const bh = map.getUniverse().specialDestinations[0];
        const index = map.globalStars.findIndex((star) => star.id === bh.id);
        const position = map.globalMapPositions[index].clone();
        map.controls.target.copy(position);
        map.camera.position.set(position.x, position.y + 150, position.z + 0.01);
        map.controls.update();
        map.updateGalaxyOverview(true);
        map.updateMapLabels();
        const rect = map.renderer.domElement.getBoundingClientRect();
        const projected = position.clone().project(map.camera);
        const hit = map.pickStarAt({
          clientX: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
          clientY: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
        });
        return {
          gameBackend: window.NMS.stats().rendererBackend,
          mapBackend: map.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'other',
          hit: hit?.star.id || null,
          target: bh.id,
        };
      });
      assert.equal(webgpuAudit.gameBackend, 'webgpu', 'production scene did not use real WebGPU');
      assert.equal(webgpuAudit.mapBackend, 'webgpu', 'star map did not use real WebGPU');
      assert.equal(webgpuAudit.hit, webgpuAudit.target, 'real-WebGPU visible black-hole point was not pickable');
      assert.equal(webgpuErrors.length, 0, `real-WebGPU star map emitted errors: ${webgpuErrors.join('\n')}`);
      console.log('PASS: real WebGPU star-map rendering and picking');
    } finally {
      await webgpuBrowser.close();
    }
    } else if (process.env.SKIP_WEBGPU_STAR_MAP === '1') {
      console.log('SKIP: real WebGPU star-map validation disabled for isolated fallback audit');
    } else {
      console.log('SKIP: no installed Chrome/Edge for real WebGPU star-map validation');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
