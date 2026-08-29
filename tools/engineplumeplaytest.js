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
try {
  await page.goto(`http://127.0.0.1:${port}/?quality=balanced&nolock=1&nohero=1`
    + '&post=1&vclouds=0&farflora=0&freeze=1&buildms=25&shaderchecks=1');
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 120000 });
  await page.evaluate(() => {
    document.body.classList.add('hide-hud');
    NMS.setAdaptiveQualityLocked(true);
    if (NMS._pipeline.grade) NMS._pipeline.grade.enabled = false;
    const { ship } = NMS._internals;
    const THREE = NMS._THREE;
    const originalFx = ship.updateEngineFx.bind(ship);
    ship.updateEngineFx = (dt) => originalFx(dt, 1.34e6, 0, 0);
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
      roots,
      authoredRoots: ship.ext.plumes[0].userData.nozzleRoots,
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
  check(contract.roots.every((rig) => rig.every((instance, index) =>
    instance.position.every((value, axis) =>
      Math.abs(value - contract.authoredRoots[index][axis]) < 1e-5)
      && instance.scale.every((value) => value > 0))),
  'every plume instance is rooted at its authored nozzle throat');
  check(contract.power > 1.45, `high-power proof reached ${contract.power.toFixed(3)} drive`);
  check(contract.uniformPowers.every((power) => power > 1.45),
    `all plume uniforms received live power ${contract.uniformPowers.map((power) => power.toFixed(3)).join('/')}`);
  check(contract.visible.every(Boolean), 'all plume rigs remain visible after ship pipeline prewarm');

  await page.screenshot({ path: path.join(output, '01-high-power-oblique.png') });
  await page.evaluate(() => NMS._internals.ship.engineProofPose.identity());
  await page.waitForTimeout(240);
  const chaseVisible = await page.screenshot({ path: path.join(output, '02-high-power-chase.png') });
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = false;
  });
  await page.waitForTimeout(120);
  const chaseHidden = await page.screenshot({ path: path.join(output, '02a-chase-disabled-control.png') });
  const chaseDelta = imageDelta(readPng(chaseVisible), readPng(chaseHidden), 5);
  check(chaseDelta.ratio > 0.00008 && chaseDelta.ratio < 0.035,
    `axial chase view retains a bounded hot-throat signature (${(chaseDelta.ratio * 100).toFixed(3)}% pixels)`);
  await page.evaluate(() => {
    const { ship } = NMS._internals;
    for (const rig of [...ship.ext.plumes, ...ship.ext.glowRings]) rig.visible = true;
    ship.engineProofPose.setFromEuler(new NMS._THREE.Euler(-0.07, -0.34, -0.025, 'YXZ'));
  });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    const { scene, ship } = NMS._internals;
    for (const child of scene.children) {
      if (child === ship.group || child.isLight) continue;
      child.visible = false;
    }
    for (const strobe of ship.ext.strobes) strobe.visible = false;
    scene.background = new NMS._THREE.Color(0x02050a);
  });
  await page.waitForTimeout(240);
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
