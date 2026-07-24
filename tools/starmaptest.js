import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

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
    const localIds = new Set(map.localStars.map((star) => star.id));
    const regular = map.globalStars.find((star) => star.kind !== 'blackHole' && !localIds.has(star.id));
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
    const regularIndex = map.globalStars.findIndex((star) => star.id === regular.id);
    const regularPosition = map.globalMapPositions[regularIndex].clone();
    map.controls.target.copy(regularPosition);
    const regularSamples = [];
    for (const distance of [22, 60, 82, 96, 150]) {
      map.camera.position.set(regularPosition.x, regularPosition.y + distance, regularPosition.z + 0.01);
      map.controls.update();
      map.updateGalaxyOverview(true);
      map.scene.updateMatrixWorld(true);
      map.camera.updateMatrixWorld(true);
      const projected = project(regularPosition);
      const hit = map.pickStarAt({ clientX: rect.left + projected.x, clientY: rect.top + projected.y });
      const matrixOffset = regularIndex * 16;
      const matrixArray = map.globalStarLight.instanceMatrix.array;
      const instanceScale = Math.hypot(
        matrixArray[matrixOffset], matrixArray[matrixOffset + 1], matrixArray[matrixOffset + 2]);
      const worldPerPixel = 2 * distance * Math.tan(map.camera.fov * Math.PI / 360)
        / Math.max(1, map.renderer.domElement.clientHeight);
      regularSamples.push({
        distance,
        hit: hit?.star.id || null,
        inVisibleCatalogue: map.visibleStars.some((star) => star.id === regular.id),
        globalOpacity: map.globalStarLight.material.opacity,
        screenSize: instanceScale / worldPerPixel,
        count: map.els.count.textContent,
      });
    }
    const hoverPoint = project(regularPosition);
    map.renderer.domElement.dispatchEvent(new PointerEvent('pointermove', {
      clientX: rect.left + hoverPoint.x,
      clientY: rect.top + hoverPoint.y,
    }));
    return {
      id: bh.id,
      regularId: regular.id,
      samples,
      regularSamples,
      remoteLabelCount: map.labelData.filter((item) => !localIds.has(item.star.id)).length,
      labelRecordCount: map.labelData.length,
      globalCount: map.globalStars.length,
      previewCacheSize: map.previewCache.size,
      hoverVisible: !map.els.hoverMark.hidden,
      hoverName: map.els.hoverName.textContent,
      expectedHoverName: map.systemLabelIdentity(regular).properName,
    };
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
  for (const sample of audit.regularSamples) {
    assert.equal(sample.hit, audit.regularId,
      `ordinary non-local system was not pickable at zoom ${sample.distance}`);
    assert.equal(sample.inVisibleCatalogue, true,
      `ordinary non-local system left the visible catalogue at zoom ${sample.distance}`);
    assert(sample.globalOpacity >= 0.9,
      `ordinary systems faded below readable opacity at zoom ${sample.distance}`);
    assert(Math.abs(sample.screenSize - 5.6) < 0.08,
      `ordinary system changed screen size at zoom ${sample.distance}: ${sample.screenSize}`);
    assert.equal(sample.count, '1024 / 1024',
      `galaxy catalogue count switched at zoom ${sample.distance}`);
  }
  assert(audit.remoteLabelCount > 40,
    `far galaxy has too few distributed name labels (${audit.remoteLabelCount})`);
  assert(audit.labelRecordCount < audit.globalCount,
    'galaxy eagerly created a DOM label for every system');
  assert(audit.previewCacheSize < 500,
    `far labels eagerly generated too many full system previews (${audit.previewCacheSize})`);
  assert.equal(audit.hoverVisible, true, 'ordinary far-system hover label stayed hidden');
  assert.equal(audit.hoverName, audit.expectedHoverName, 'ordinary far-system hover name was missing');
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
  await new Promise((resolve) => server.close(resolve));
}
