// Fixed-camera WebGL proof for the HALCYON engine plume.  The assertions cover
// authored nozzle attachment, instanced draw cost, shader/blend safety, visible
// transported turbulence, and bounded screen-space light spill.  Screenshots
// remain the primary acceptance artifact because those contracts alone cannot
// decide whether a plume looks physically convincing.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const output = path.resolve('test-results/engine-plume');
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser({ headless: true });
const page = await browser.newPage({ viewport: { width: 2048, height: 994 } });
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

const readPng = (buffer) => PNG.sync.read(buffer);
function imageDelta(a, b, threshold = 8) {
  let changed = 0;
  let totalDelta = 0;
  const pixels = a.width * a.height;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    const delta = Math.max(
      Math.abs(a.data[offset] - b.data[offset]),
      Math.abs(a.data[offset + 1] - b.data[offset + 1]),
      Math.abs(a.data[offset + 2] - b.data[offset + 2]),
    );
    if (delta > threshold) changed++;
    totalDelta += delta;
  }
  return { ratio: changed / pixels, mean: totalDelta / pixels };
}

const pixelDelta = (a, b, offset) => (
  Math.abs(a.data[offset] - b.data[offset]) * 0.2126
  + Math.abs(a.data[offset + 1] - b.data[offset + 1]) * 0.7152
  + Math.abs(a.data[offset + 2] - b.data[offset + 2]) * 0.0722
);

function nozzleSymmetry(visible, hidden, nozzles) {
  return nozzles.map(({ center, radius }) => {
    const [cx, cy] = center;
    const r = Math.max(5, radius * 0.78);
    const energy = { upper: 0, lower: 0, left: 0, right: 0 };
    for (let y = Math.max(0, Math.floor(cy - r));
      y <= Math.min(visible.height - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r));
        x <= Math.min(visible.width - 1, Math.ceil(cx + r)); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r * r) continue;
        const delta = pixelDelta(visible, hidden, (y * visible.width + x) * 4);
        if (dy < -1) energy.upper += delta;
        else if (dy > 1) energy.lower += delta;
        if (dx < -1) energy.left += delta;
        else if (dx > 1) energy.right += delta;
      }
    }
    const balance = (one, other) => Math.min(one, other) / Math.max(one, other, 1);
    return {
      vertical: balance(energy.upper, energy.lower),
      horizontal: balance(energy.left, energy.right),
      total: energy.upper + energy.lower + energy.left + energy.right,
    };
  });
}

function plumeCrossSectionSymmetry(visible, hidden, projections) {
  return projections.map(({ root, end, radius }) => {
    const axisX = end[0] - root[0];
    const axisY = end[1] - root[1];
    const axisLength = Math.hypot(axisX, axisY);
    if (axisLength < radius * 1.5) return { balance: 1, total: 0, axial: true };
    const tangentX = axisX / axisLength;
    const tangentY = axisY / axisLength;
    const normalX = -tangentY;
    const normalY = tangentX;
    const halfWidth = Math.max(5, radius * 1.15);
    const minX = Math.max(0, Math.floor(Math.min(root[0], end[0]) - halfWidth));
    const maxX = Math.min(visible.width - 1,
      Math.ceil(Math.max(root[0], end[0]) + halfWidth));
    const minY = Math.max(0, Math.floor(Math.min(root[1], end[1]) - halfWidth));
    const maxY = Math.min(visible.height - 1,
      Math.ceil(Math.max(root[1], end[1]) + halfWidth));
    let negative = 0;
    let positive = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const fromRootX = x + 0.5 - root[0];
        const fromRootY = y + 0.5 - root[1];
        const along = (fromRootX * tangentX + fromRootY * tangentY) / axisLength;
        if (along < 0.10 || along > 0.92) continue;
        const across = fromRootX * normalX + fromRootY * normalY;
        const localWidth = halfWidth * (0.55 + along * 0.45);
        if (Math.abs(across) > localWidth || Math.abs(across) < 1) continue;
        const delta = pixelDelta(visible, hidden, (y * visible.width + x) * 4);
        if (across < 0) negative += delta;
        else positive += delta;
      }
    }
    return {
      balance: Math.min(negative, positive) / Math.max(negative, positive, 1),
      total: negative + positive,
      axial: false,
    };
  });
}

async function projectEngines(mainOnly = true) {
  return page.evaluate((onlyMain) => {
    const { ship, camera } = NMS._internals;
    const THREE = NMS._THREE;
    ship.group.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    const project = (point) => {
      ship.group.localToWorld(point);
      point.project(camera);
      return [(point.x * 0.5 + 0.5) * innerWidth,
        (-point.y * 0.5 + 0.5) * innerHeight];
    };
    return ship.def.engines.filter((engine) => !onlyMain || engine.r > 0.5).map((engine) => {
      const root = project(new THREE.Vector3(engine.x, engine.y,
        engine.z + engine.r * 0.39));
      const centrePoint = new THREE.Vector3(engine.x, engine.y,
        engine.z + engine.r * 0.425);
      const center = project(centrePoint.clone());
      const rim = project(centrePoint.clone().add(new THREE.Vector3(engine.r * 0.9, 0, 0)));
      const end = project(new THREE.Vector3(engine.x, engine.y,
        engine.z + engine.r * 6.6));
      return {
        root,
        center,
        end,
        radius: Math.hypot(rim[0] - center[0], rim[1] - center[1]),
        authoredRadius: engine.r,
      };
    });
  }, mainOnly);
}
try {
  await page.goto(`http://127.0.0.1:${port}/?quality=balanced&nolock=1&nohero=1`
    + '&post=1&vclouds=0&farflora=0&freeze=1&buildms=25&shaderchecks=1');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 120000 });
  await page.evaluate(() => {
    NMS.setAdaptiveQualityLocked(true);
    if (NMS._pipeline.grade) NMS._pipeline.grade.enabled = false;
    const { ship } = NMS._internals;
    const THREE = NMS._THREE;
    const originalFx = ship.updateEngineFx.bind(ship);
    /* 877.4 km/s is the exact reported failure state.  The player-facing HUD
       frame is captured before any proof pose or scene isolation is applied. */
    ship.updateEngineFx = (dt) => originalFx(dt, 877400, 0, 0);
    const originalUpdate = ship.update.bind(ship);
    const proofPose = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-0.07, -0.34, -0.025, 'YXZ'));
    ship.engineProofPose = proofPose;
    ship.update = (...args) => {
      const result = originalUpdate(...args);
      ship.group.quaternion.multiply(ship.engineProofPose);
      return result;
    };
  });
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    const { scene, ship } = NMS._internals;
    ship.engineProofPose.identity();
    /* Preserve the real player HUD and reported 877.4 km/s state, but remove
       asynchronous planets from this acceptance frame.  The prior screenshot
       put a blown-out planet over nearly the whole image and proved nothing
       about the exhaust at the user's chase angle. */
    for (const child of scene.children) {
      if (child === ship.group || child.isLight) continue;
      child.visible = false;
    }
    for (const strobe of ship.ext.strobes) strobe.visible = false;
    scene.background = new NMS._THREE.Color(0x02050a);
  });
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(output, '00-player-hud-reported-angle.png') });
  await page.evaluate(() => {
    document.body.classList.add('hide-hud');
    NMS._internals.ship.engineProofPose
      .setFromEuler(new NMS._THREE.Euler(-0.07, -0.34, -0.025, 'YXZ'));
  });
  await page.waitForTimeout(260);

  const contract = await page.evaluate(() => {
    const { ship, camera } = NMS._internals;
    const THREE = NMS._THREE;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const roots = ship.ext.plumes.map((rig) => {
      const values = [];
      for (let i = 0; i < rig.count; i++) {
        rig.getMatrixAt(i, matrix);
        matrix.decompose(position, quaternion, scale);
        values.push({ position: position.toArray(), scale: scale.toArray() });
      }
      return values;
    });
    const triangleCount = (geometry) => geometry.index
      ? geometry.index.count / 3
      : geometry.getAttribute('position').count / 3;
    const boundsSize = (geometry) => {
      geometry.computeBoundingBox();
      return geometry.boundingBox.getSize(new THREE.Vector3()).toArray();
    };
    ship.group.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    const screenRoots = ship.def.engines.map((engine) => {
      const point = new THREE.Vector3(engine.x, engine.y,
        engine.z + engine.r * 0.64);
      ship.group.localToWorld(point);
      point.project(camera);
      return [(point.x * 0.5 + 0.5) * innerWidth, (-point.y * 0.5 + 0.5) * innerHeight];
    });
    return {
      plumeRigs: ship.ext.plumes.length,
      lipRigs: ship.ext.glowRings.length,
      instances: ship.ext.plumes.map((rig) => rig.count),
      instanced: [...ship.ext.plumes, ...ship.ext.glowRings]
        .every((rig) => rig.isInstancedMesh),
      premultiplied: [...ship.ext.plumes, ...ship.ext.glowRings]
        .every((rig) => rig.material.premultipliedAlpha),
      additive: [...ship.ext.plumes, ...ship.ext.glowRings]
        .some((rig) => rig.material.blending === THREE.AdditiveBlending),
      backFaceVolumes: ship.ext.plumes
        .every((rig) => rig.material.side === THREE.BackSide),
      roots,
      authoredRoots: ship.ext.plumes[0].userData.nozzleRoots,
      plumeTriangles: triangleCount(ship.ext.plumes[0].geometry),
      throatTriangles: triangleCount(ship.ext.glowRings[0].geometry),
      plumeBounds: boundsSize(ship.ext.plumes[0].geometry),
      throatBounds: boundsSize(ship.ext.glowRings[0].geometry),
      screenRoots,
      power: ship.enginePower,
      uniformPowers: [...ship.ext.plumes, ...ship.ext.glowRings]
        .map((rig) => rig.material.uniforms.uPower.value),
      visible: [...ship.ext.plumes, ...ship.ext.glowRings].map((rig) => rig.visible),
      programs: NMS._renderer.info.programs?.length || 0,
    };
  });
  check(contract.plumeRigs === 1 && contract.lipRigs === 1
      && contract.instances.every((count) => count === 4) && contract.instanced,
    'four engines render as two shared instanced rigs');
  check(contract.premultiplied && !contract.additive,
    'all plume layers use bounded premultiplied blending, not additive light spill');
  check(contract.plumeTriangles === 12 && contract.plumeBounds[0] > 2
      && contract.plumeBounds[1] > 7 && contract.plumeBounds[2] > 2,
    `plume raster hull remains a complete 3D volume (${contract.plumeTriangles} triangles, ${contract.plumeBounds.map((v) => v.toFixed(2)).join('×')})`);
  check(contract.throatTriangles >= 700 && contract.throatBounds[2] > 0.25,
    `nozzle throat remains a complete curved aperture (${contract.throatTriangles} triangles, ${contract.throatBounds[2].toFixed(3)} depth)`);
  check(contract.backFaceVolumes,
    'volume exit surfaces remain visible when a close chase camera enters the proxy');
  check(contract.roots.every((rig) => rig.every((instance, index) =>
    instance.position.every((value, axis) =>
      Math.abs(value - contract.authoredRoots[index][axis]) < 1e-5)
      && instance.scale.every((value) => value > 0))),
  'every plume instance is rooted at its authored nozzle throat');
  check(contract.power > 0.98, `reported-speed proof reached ${contract.power.toFixed(3)} drive`);
  check(contract.uniformPowers.every((power) => power > 0.98),
    `all plume uniforms received live power ${contract.uniformPowers.map((power) => power.toFixed(3)).join('/')}`);
  check(contract.visible.every(Boolean), 'all plume rigs remain visible after ship pipeline prewarm');

  await page.screenshot({ path: path.join(output, '01-high-power-oblique.png') });
  await page.evaluate(() => {
    /* All image deltas below this point run in a fixed foreground scene.  The
       procedural planet continues building after boot; leaving it visible made
       the old chase A/B compare unrelated terrain frames and occasionally turn
       a sound plume into an 18% false failure. */
    const { scene, ship } = NMS._internals;
    for (const child of scene.children) {
      if (child === ship.group || child.isLight) continue;
      child.visible = false;
    }
    for (const strobe of ship.ext.strobes) strobe.visible = false;
    scene.background = new NMS._THREE.Color(0x02050a);
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => NMS._internals.ship.engineProofPose.identity());
  await page.waitForTimeout(240);
  const chaseProjection = await projectEngines();
  const allChaseProjection = await projectEngines(false);
  const chaseVisible = await page.screenshot({ path: path.join(output, '02-high-power-chase.png') });
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = false;
  });
  await page.waitForTimeout(120);
  const chaseHidden = await page.screenshot({ path: path.join(output, '02a-chase-disabled-control.png') });
  const chaseVisiblePng = readPng(chaseVisible);
  const chaseHiddenPng = readPng(chaseHidden);
  const chaseDelta = imageDelta(chaseVisiblePng, chaseHiddenPng, 5);
  /* The Blender-built HALCYON (2026-11-15) roots the jet 0.3 R inside the
     bell and lets it be seen from the chase camera; the plume fades end-on
     but is no longer suppressed to a throat-only signature. */
  check(chaseDelta.ratio > 0.00008 && chaseDelta.ratio < 0.05,
    `axial chase view retains a bounded hot-throat signature (${(chaseDelta.ratio * 100).toFixed(3)}% pixels)`);
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of ship.ext.glowRings) rig.visible = true;
  });
  await page.waitForTimeout(90);
  const throatOnly = await page.screenshot({
    path: path.join(output, '02b-chase-throat-only.png'),
  });
  const throatBalances = nozzleSymmetry(
    readPng(throatOnly), chaseHiddenPng, allChaseProjection);
  const normalizedThroatEnergy = throatBalances.map((balance, index) =>
    balance.total / Math.max(16, allChaseProjection[index].radius ** 2));
  check(throatBalances.every((balance, index) =>
    /* the dorsal bells are 0.30 R engines whose throat dish sits 0.48 R deep:
       their absolute energy is small, their normalised energy matches the mains */
    balance.total > (allChaseProjection[index].authoredRadius > 0.5 ? 3000 : 350)
      && balance.vertical > 0.38 && balance.horizontal > 0.38)
      && Math.min(...normalizedThroatEnergy) / Math.max(...normalizedThroatEnergy) > 0.22,
  `all four apertures illuminate around their full circumference (${throatBalances.map((balance, index) => `${balance.total.toFixed(0)}e/${normalizedThroatEnergy[index].toFixed(2)}n/${balance.vertical.toFixed(2)}v/${balance.horizontal.toFixed(2)}h`).join(', ')})`);
  const chaseSections = plumeCrossSectionSymmetry(
    chaseVisiblePng, chaseHiddenPng, chaseProjection);
  check(chaseSections.every((section) => !section.axial
      && section.total > 1000 && section.balance > 0.40),
    `near-axis chase retains continuous two-sided exhaust beyond both mouths (${chaseSections.map((section) => `${section.total.toFixed(0)}e/${section.balance.toFixed(2)}b`).join(', ')})`);
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = true;
    ship.engineProofPose.setFromEuler(new NMS._THREE.Euler(-0.07, -0.34, -0.025, 'YXZ'));
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const strobe of ship.ext.strobes) strobe.visible = false;
  });
  await page.waitForTimeout(240);
  const leftProjection = await projectEngines();
  const highABuffer = await page.screenshot({ path: path.join(output, '03-dark-field-flow-a.png') });
  await page.waitForTimeout(420);
  const highBBuffer = await page.screenshot({ path: path.join(output, '04-dark-field-flow-b.png') });
  const dynamicDelta = imageDelta(readPng(highABuffer), readPng(highBBuffer), 3);
  check(dynamicDelta.ratio > 0.00008,
    `transported shear turbulence changes over time (${(dynamicDelta.ratio * 100).toFixed(3)}% pixels)`);

  const layerNames = ['integrated-plume', 'throat'];
  for (let active = 0; active < layerNames.length; active++) {
    await page.evaluate((activeLayer) => {
      const { ship } = NMS._internals;
      const layers = [...ship.ext.plumes, ...ship.ext.glowRings];
      layers.forEach((rig, index) => { rig.visible = index === activeLayer; });
    }, active);
    await page.waitForTimeout(90);
    await page.screenshot({
      path: path.join(output, `${String(7 + active).padStart(2, '0')}-layer-${layerNames[active]}.png`),
    });
  }
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = true;
  });
  await page.waitForTimeout(90);

  const visibleControl = highBBuffer;
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = false;
  });
  await page.waitForTimeout(180);
  const hiddenBuffer = await page.screenshot({ path: path.join(output, '05-plume-disabled-control.png') });
  const spill = imageDelta(readPng(visibleControl), readPng(hiddenBuffer), 8);
  const leftCrossSections = plumeCrossSectionSymmetry(
    readPng(visibleControl), readPng(hiddenBuffer), leftProjection);
  check(leftCrossSections.every((section) => section.axial
      || (section.total > 1000 && section.balance > 0.42)),
    `left-oblique volume carries energy across both sides of each axis (${leftCrossSections.map((section) => section.balance.toFixed(2)).join(', ')})`);

  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = true;
    ship.engineProofPose.setFromEuler(new NMS._THREE.Euler(-0.07, 0.34, 0.025, 'YXZ'));
  });
  await page.waitForTimeout(220);
  const rightProjection = await projectEngines();
  const rightVisible = await page.screenshot({ path: path.join(output, '09-dark-field-right-oblique.png') });
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = false;
  });
  await page.waitForTimeout(140);
  const rightHidden = await page.screenshot({ path: path.join(output, '09a-right-disabled-control.png') });
  const rightCrossSections = plumeCrossSectionSymmetry(
    readPng(rightVisible), readPng(rightHidden), rightProjection);
  check(rightCrossSections.every((section) => section.axial
      || (section.total > 1000 && section.balance > 0.42)),
    `right-oblique volume carries energy across both sides of each axis (${rightCrossSections.map((section) => section.balance.toFixed(2)).join(', ')})`);

  for (const [name, euler] of [
    ['10-dark-field-high-oblique.png', [0.24, -0.16, 0]],
    ['11-dark-field-low-oblique.png', [-0.24, 0.16, 0]],
  ]) {
    await page.evaluate((angles) => {
      const { ship } = NMS._internals;
      for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = true;
      ship.engineProofPose.setFromEuler(new NMS._THREE.Euler(...angles, 'YXZ'));
    }, euler);
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(output, name) });
  }

  await page.evaluate(() => {
    const { ship } = NMS._internals;
    ship.engineProofPose.setFromEuler(new NMS._THREE.Euler(0.02, -1.18, 0, 'YXZ'));
  });
  await page.waitForTimeout(180);
  const sideVisible = await page.screenshot({
    path: path.join(output, '11a-dark-field-side.png'),
  });
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = false;
  });
  await page.waitForTimeout(120);
  const sideHidden = await page.screenshot({
    path: path.join(output, '11b-side-disabled-control.png'),
  });
  const sideDelta = imageDelta(readPng(sideVisible), readPng(sideHidden), 5);
  check(sideDelta.ratio > 0.00012 && sideDelta.ratio < 0.035,
    `pure side view retains bounded plume energy (${(sideDelta.ratio * 100).toFixed(3)}% pixels)`);

  /* A dedicated all-engine layer prevents hull occlusion from turning the two
     small manoeuvring plumes into an untested assumption.  Roots were already
     checked against the authored table; this frame proves every instance also
     contributes a full two-sided volume at runtime. */
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = true;
    ship.engineProofPose.setFromEuler(new NMS._THREE.Euler(-0.12, -0.52, 0, 'YXZ'));
    ship.engineLayerVisibility = ship.ext.group.children.map((child) => child.visible);
    for (const child of ship.ext.group.children) {
      child.visible = ship.ext.plumes.includes(child);
    }
    for (const rig of ship.ext.plumes) rig.visible = true;
  });
  await page.waitForTimeout(180);
  const allEngineProjection = await projectEngines(false);
  const allEngineVisible = await page.screenshot({
    path: path.join(output, '12-four-engine-volume-isolation.png'),
  });
  await page.evaluate(() => {
    for (const rig of NMS._internals.ship.ext.plumes) rig.visible = false;
  });
  await page.waitForTimeout(120);
  const allEngineHidden = await page.screenshot({
    path: path.join(output, '12a-four-engine-disabled-control.png'),
  });
  const allEngineSections = plumeCrossSectionSymmetry(
    readPng(allEngineVisible), readPng(allEngineHidden), allEngineProjection);
  check(allEngineSections.every((section, index) => !section.axial
      && section.total > (allEngineProjection[index].authoredRadius > 0.5 ? 1000 : 80)
      && section.balance > 0.36),
    `all four engine instances contribute two-sided volume (${allEngineSections.map((section) => `${section.total.toFixed(0)}e/${section.balance.toFixed(2)}b`).join(', ')})`);
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    ship.ext.group.children.forEach((child, index) => {
      child.visible = ship.engineLayerVisibility[index];
    });
    delete ship.engineLayerVisibility;
  });

  const highA = readPng(visibleControl);
  const attachedRoots = contract.screenRoots.filter(([x, y]) =>
    x >= 0 && x < highA.width && y >= 0 && y < highA.height);
  check(contract.plumeRigs + contract.lipRigs === 2,
    'the complete plume remains capped at two instanced foreground draws');
  check(spill.ratio > 0.0002 && spill.ratio < 0.09,
    `visible energy stays spatially bounded (${(spill.ratio * 100).toFixed(2)}% affected pixels)`);
  check(attachedRoots.length === 4,
    'all four authored nozzle roots project into the proof frame');
  check(errors.length === 0, `WebGL plume has no shader/page errors (${errors.length})`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length || errors.length) {
  throw new Error(`Engine plume playtest failed: ${[...failures, ...errors].join('; ')}`);
}
console.log(`PASS: engine plume visual proof in ${output}`);
