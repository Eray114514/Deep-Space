// Browser regression for the manual spatial-rift passage: shader compilation,
// living edge motion, destination-light continuity and the closing lifecycle.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startServer } from './server.js';
import { launchBrowser, launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const webgpuBrowser = await launchWebGPUHardwareBrowser({ headless: true });
const browser = webgpuBrowser || await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  window.__riftGpuErrors = [];
  const adapterPrototype = globalThis.GPUAdapter?.prototype;
  const requestDevice = adapterPrototype?.requestDevice;
  if (typeof requestDevice !== 'function') return;
  adapterPrototype.requestDevice = async function tracedRequestDevice(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', (event) => {
      window.__riftGpuErrors.push(event.error?.message || String(event.error || event));
    });
    return device;
  };
});
const page = await context.newPage();
const errors = [];
const shaderErrors = [];
const shaderWarnings = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  const text = message.text();
  const precisionWarningOnly = text.replaceAll('\0', '').split('\n')
    .map((line) => line.trim()).filter(Boolean)
    .every((line) => /^(?:THREE\.WebGLProgram: Program Info Log: )?\(\d+,\d+(?:-\d+)?\): warning X4122: sum of .* cannot be represented accurately in double precision$/.test(line));
  // NVIDIA's GLSL compiler emits X4122 for constant-folding differences at
  // ~1e-17. It is a warning (not a shader failure) and is reproducible on the
  // untouched WebGL baseline. Keep it visible without turning it into an
  // error; every other program log remains fatal.
  if (precisionWarningOnly) {
    shaderWarnings.push(text);
    return;
  }
  if (message.type() === 'error' || /WebGLProgram|shader error|GPUValidationError/i.test(text)) {
    shaderErrors.push(text);
  }
});

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

const frameA = path.join(os.tmpdir(), 'deep-space-rift-open-a.png');
const frameB = path.join(os.tmpdir(), 'deep-space-rift-open-b.png');
const openingFrame = path.join(os.tmpdir(), 'deep-space-rift-opening.png');
const thresholdFrame = path.join(os.tmpdir(), 'deep-space-rift-threshold.png');
const arrivalFrame = path.join(os.tmpdir(), 'deep-space-rift-arrival.png');
const routeFrame = path.join(os.tmpdir(), 'deep-space-route-choice.png');
const routeMobileFrame = path.join(os.tmpdir(), 'deep-space-route-choice-mobile.png');
const warpTunnelFrameA = path.join(os.tmpdir(), 'deep-space-warp-tunnel-a.png');
const warpTunnelFrameB = path.join(os.tmpdir(), 'deep-space-warp-tunnel-b.png');
const warpArrivalFrame = path.join(os.tmpdir(), 'deep-space-warp-arrival.png');
const warpMovedFrame = path.join(os.tmpdir(), 'deep-space-warp-moved.png');

try {
  const rendererQuery = webgpuBrowser ? '&renderer=webgpu' : '';
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&nohero=1&quality=low&vclouds=1&farflora=0&freeze=1&buildms=25${rendererQuery}`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  const target = await page.evaluate(() => {
    const { universe, starMap } = NMS._internals;
    for (const star of universe.nearStarsList) {
      const preview = starMap.systemPreview(star);
      const body = preview.bodies.find((candidate) => !candidate.isMoon
        && !['gasGiant', 'iceGiant', 'blackHole'].includes(candidate.type)
        && (candidate.clouds?.coverage || 0) > 0.12);
      if (body) return { starId: star.id, bodyIndex: body.index, coverage: body.clouds.coverage };
    }
    return null;
  });
  check(!!target, 'a cloudy neighboring planet is available for the rift route');
  await page.evaluate((id) => {
    NMS.openStarMap();
    NMS.selectStarMapTarget(id);
  }, target.starId);
  await page.locator(`#sm-systemGlyph [data-glyph-index="${target.bodyIndex}"]`).click({ force: true });
  await page.waitForFunction(() => document.querySelector('#sm-planetLeft')?.classList.contains('active'));
  await page.locator('#sm-routeAction').click({ force: true });
  await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'));
  await page.waitForTimeout(260);
  const routeFocusState = await page.evaluate(() => ({
    active: document.body.classList.contains('route-choice-active'),
    hudDisplay: getComputedStyle(document.getElementById('ship-hud-stage')).display,
    hudVisibility: getComputedStyle(document.getElementById('ship-hud-stage')).visibility,
    hudOpacity: getComputedStyle(document.getElementById('ship-hud-stage')).opacity,
  }));
  const routeHudRetired = routeFocusState.hudDisplay === 'none'
    || routeFocusState.hudVisibility === 'hidden'
    || Number(routeFocusState.hudOpacity) < 0.05;
  check(routeFocusState.active && routeHudRetired,
  'route protocol takes visual focus and retires the flight HUD');
  await page.locator('#route-rift-btn').hover();
  await page.waitForTimeout(220);
  const routeHoverState = await page.locator('#route-rift-btn').evaluate((button) => ({
    filter: getComputedStyle(button).filter,
    transform: getComputedStyle(button).transform,
  }));
  check(routeHoverState.filter !== 'none' && routeHoverState.transform !== 'none',
    'hovering a route gives the chosen protocol a distinct active state');
  await page.screenshot({ path: routeFrame });
  await page.setViewportSize({ width: 640, height: 720 });
  const mobileRouteBounds = await page.locator('#route-choice').boundingBox();
  check(mobileRouteBounds && mobileRouteBounds.x >= 0
      && mobileRouteBounds.x + mobileRouteBounds.width <= 640
      && mobileRouteBounds.y >= 0
      && mobileRouteBounds.y + mobileRouteBounds.height <= 720,
  'route choice remains fully inside a 640 px viewport');
  await page.screenshot({ path: routeMobileFrame });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#route-rift-btn').click();
  await page.waitForFunction(() => document.body.classList.contains('travel-cinematic'));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('ship-hud-stage')).visibility === 'hidden',
    null, { timeout: 3000 }).catch(() => {});
  const riftHudHidden = await page.evaluate(() => ({
    // The HUD collapses via visibility (it stays in layout so the exit can animate).
    display: getComputedStyle(document.getElementById('ship-hud-stage')).visibility === 'hidden' ? 'none' : 'shown',
    routeHidden: getComputedStyle(document.getElementById('route-choice')).display,
  }));
  check(riftHudHidden.display === 'none' && riftHudHidden.routeHidden === 'none',
    'rift passage hides the complete cockpit HUD and route selector');
  await page.waitForFunction(() => {
    const rift = NMS.riftState();
    return rift.phase === 'opening' && rift.seam > 0.9 && rift.open > 0.10 && rift.open < 0.85;
  }, null, { timeout: 20000 });
  const openingState = await page.evaluate('NMS.riftState()');
  await page.screenshot({ path: openingFrame });
  check(openingState.composite && openingState.farRendered && openingState.seam > 0.9 && openingState.burst <= 1.0,
    `rift opening tears from seam with live far composite (seam ${openingState.seam.toFixed(2)}, open ${openingState.open.toFixed(2)}, burst ${openingState.burst.toFixed(2)})`);
  await page.waitForFunction(() => {
    const rift = NMS.riftState();
    return rift.phase === 'open' && rift.open > 0.985 && rift.burst < 0.001 && rift.anchorLocked;
  }, null, { timeout: 20000 });
  await page.waitForFunction(() => NMS.riftState().previewVolume?.ready,
    null, { timeout: 20000 });

  check(await page.evaluate('NMS.stats().audio'), 'route gesture unlocks procedural audio');
  const stable = await page.evaluate('NMS.riftState()');
  check(stable.visible && stable.composite && stable.farRendered && stable.phase === 'open' && stable.destinationLight.length > 0,
    'stable passage renders a live destination system through the far-view composite');
  const portalContract = await page.evaluate(() => {
    const { scene, ship, universe, riftPreviewSystem } = NMS._internals;
    const pipeline = NMS._pipeline;
    const composite = pipeline.portalComposite;
    const targetBodyId = NMS.riftState().previewVolume?.bodyId;
    const targetBody = riftPreviewSystem?.bodyById.get(targetBodyId);
    const previewBodies = [
      ...(riftPreviewSystem?.planets || []),
      ...(riftPreviewSystem?.compactObjects || []),
    ];
    return {
      compositeActive: !!composite?.enabled && !!composite.uniforms.tPortal.value && composite.uniforms.uPortalReady.value === 1,
      previewSceneHidden: previewBodies.every((body) => !body.group.visible)
        && (riftPreviewSystem?.starViews || []).every((view) =>
          !view.group.visible && !view.light.visible),
      mainSceneIntact: !!ship.group.visible && !!scene.fog
        && (universe.system?.starViews || []).every((view) => view.group.visible && view.light.visible),
      radius: targetBody?.R || 0,
      atmosphereRadius: targetBody?.atmoMesh?.geometry?.parameters?.radius || 0,
      cloudRadius: targetBody?.cloudMesh?.geometry?.parameters?.radius || 0,
      volumeCloudRadius: targetBody?.volCloudMesh?.geometry?.parameters?.radius || 0,
      cloudPassEnabled: !!pipeline.cloudPass,
    };
  });
  check(portalContract.compositeActive,
    'per-pixel portal composite is active with a rendered far-view texture');
  check(portalContract.previewSceneHidden,
    'destination scene remains isolated from the source-world main pass');
  check(portalContract.mainSceneIntact,
    'far-view lease restores source-world stars, ship and fog after drawing');
  const targetShellsBounded = portalContract.radius > 0
    && portalContract.atmosphereRadius / portalContract.radius < 1.2
    && portalContract.cloudRadius / portalContract.radius < 1.08
    && (!portalContract.volumeCloudRadius || portalContract.volumeCloudRadius / portalContract.radius < 1.08);
  check(targetShellsBounded,
    'destination atmosphere and cloud shells stay bounded to the selected planet');
  check(stable.previewVolume?.preloaded && stable.previewVolume?.ready,
    'rift reuses the destination prepared when the route selector opened');
  check(stable.previewVolume?.cloudCoverage > 0.12
      && stable.previewVolume?.farAtmosphereBody === stable.previewVolume?.bodyId
      && (!portalContract.cloudPassEnabled || stable.previewVolume?.farCloudBody === stable.previewVolume?.bodyId),
  `far view binds the selected planet's atmosphere and clouds (${stable.previewVolume?.cloudCoverage?.toFixed(2) || 'missing'} coverage, atmo=${stable.previewVolume?.farAtmosphereBody}, cloud=${stable.previewVolume?.farCloudBody})`);

  const portalOcclusion = await page.evaluate(async () => {
    const THREE = NMS._THREE;
    const renderer = NMS._renderer;
    const { PortalCompositePass } = await import('/src/portal/portal-composite-pass.js');
    const width = 128, height = 128;
    const cam = new THREE.PerspectiveCamera(60, 1, 0.5, 10000);
    cam.position.set(0, 0, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const baseTarget = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
    });
    baseTarget.depthTexture.format = THREE.DepthFormat;
    const farTarget = new THREE.WebGLRenderTarget(width, height);
    const outTarget = new THREE.WebGLRenderTarget(width, height);
    const pass = new PortalCompositePass(cam);
    pass.enabled = true;
    pass.renderToScreen = false;
    const u = pass.uniforms;
    u.uCenter.value.set(0, 0, -100);
    u.uRight.value.set(1, 0, 0);
    u.uUp.value.set(0, 1, 0);
    u.uNormal.value.set(0, 0, 1);
    u.uHalf.value.set(28, 28);
    u.uOpen.value.set(1, 1);
    u.uPortalReady.value = 1;
    u.uRimIntensity.value = 0;
    u.uLensing.value = 0;

    const scene = new THREE.Scene();
    const occluderMat = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uLogDepth;
        void main() {
          gl_FragDepth = uLogDepth;
          gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
        }
      `,
      uniforms: { uLogDepth: { value: 0 } },
      depthTest: true,
      depthWrite: true,
    });
    const occluder = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), occluderMat);
    occluder.position.set(0, 0, -30);
    scene.add(occluder);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    const prevTone = renderer.toneMapping;

    const readCenterAndCorner = (target) => {
      const px = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, px);
      const sample = (x, y) => {
        const i = (y * width + x) * 4;
        return [px[i], px[i + 1], px[i + 2]];
      };
      return {
        center: sample(width >> 1, height >> 1),
        corner: sample(4, 4),
      };
    };

    try {
      renderer.autoClear = true;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(farTarget);
      renderer.setClearColor(0x00ffff, 1);
      renderer.clear(true, true, false);
      u.tPortal.value = farTarget.texture;

      // Case 1: unoccluded (depth = 1.0 clear, magenta base) -> center shows cyan portal, corner shows magenta base
      renderer.setRenderTarget(baseTarget);
      renderer.setClearColor(0xff00ff, 1);
      occluder.visible = false;
      renderer.render(scene, cam);
      pass.render(renderer, outTarget, baseTarget);
      const unoccluded = readCenterAndCorner(outTarget);

      // Case 2: near source occluder at z = -30 in front of portal at z = -100 -> center shows magenta source
      occluder.visible = true;
      occluderMat.uniforms.uLogDepth.value = Math.log2(30 + 1) / Math.log2(cam.far + 1);
      renderer.setRenderTarget(baseTarget);
      renderer.setClearColor(0xff00ff, 1);
      renderer.render(scene, cam);
      pass.render(renderer, outTarget, baseTarget);
      const occluded = readCenterAndCorner(outTarget);

      return { unoccluded, occluded };
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.toneMapping = prevTone;
      occluder.geometry.dispose();
      occluderMat.dispose();
      baseTarget.dispose();
      farTarget.dispose();
      outTarget.dispose();
      pass.dispose();
    }
  });
  const isCyan = (rgb) => rgb[0] < 30 && rgb[1] > 210 && rgb[2] > 210;
  const isMagenta = (rgb) => rgb[0] > 210 && rgb[1] < 30 && rgb[2] > 210;
  check(isCyan(portalOcclusion.unoccluded.center) && isMagenta(portalOcclusion.unoccluded.corner)
      && isMagenta(portalOcclusion.occluded.center),
  `portal composite occludes behind near source geometry and reveals far pixels through the opening (${JSON.stringify(portalOcclusion)})`);

  await page.screenshot({ path: frameA });
  await page.waitForTimeout(420);
  await page.screenshot({ path: frameB });
  const [a, b] = await Promise.all([readFile(frameA), readFile(frameB)])
    .then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i])
      + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 24) changed++;
  }
  check(changed > 1200, `stable passage edge remains visibly alive (${changed} changed pixels)`);

  check(await page.evaluate('NMS.approachRift(38)'), 'test pilot can stage immediately before the threshold');
  await page.waitForTimeout(120);
  await page.screenshot({ path: thresholdFrame });
  await page.evaluate('NMS.approachRift(-10)');
  await page.waitForFunction(() => NMS.riftState().arrived, null, { timeout: 10000 });
  const arrived = await page.evaluate('NMS.riftState()');
  const maxLightDelta = Math.max(0, ...stable.destinationLight.map((value, index) =>
    Math.abs(value - (arrived.destinationLight[index] ?? value))));
  check(maxLightDelta < 0.002,
    `destination stellar light is continuous across the threshold (max Δ ${maxLightDelta.toFixed(5)})`);
  check(arrived.audioCue === 'rift-close', 'threshold crossing triggers the dedicated closing cue');
  const closingPoseChecks = await page.evaluate(() => new Promise((resolve) => {
    const samples = [];
    const THREE = NMS._THREE;
    const fwd = new THREE.Vector3();
    const sample = () => requestAnimationFrame(() => {
      const rift = NMS.riftState();
      const u = NMS._pipeline.portalComposite.uniforms;
      const denom = fwd.set(0, 0, -1).applyQuaternion(NMS._internals.camera.quaternion).dot(u.uNormal.value);
      const tPlane = Math.abs(denom) > 1e-6 ? u.uCenter.value.dot(u.uNormal.value) / denom : -1;
      if (rift.visible) samples.push({ phase: rift.phase, open: rift.open, distanceToThreshold: rift.distanceToThreshold, tPlane });
      if (!rift.visible || samples.length >= 8) resolve(samples);
      else sample();
    });
    sample();
  }));
  check(closingPoseChecks.length > 0 && closingPoseChecks.every((s) => s.distanceToThreshold === null && s.tPlane < 0),
    `closing fold stays behind the forward view after crossing (${closingPoseChecks.length} sampled frames)`);
  await page.evaluate(() => NMS._internals.nav.vel.set(0, 0, 0));
  await page.waitForTimeout(80);
  await page.screenshot({ path: arrivalFrame });
  const [thresholdPng, arrivalPng] = await Promise.all([readFile(thresholdFrame), readFile(arrivalFrame)])
    .then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  const continuity = (aPng, bPng) => {
    const sumA = [0, 0, 0], sumB = [0, 0, 0];
    let pixelDiffSum = 0, changedPixels = 0, count = 0;
    // Sample central sky/planet area above the foreground ship hull (y: 120..380, x: 280..1000)
    // and full inner portal box (y: 190..650, x: 300..980) for exposure.
    for (let y = 190; y < 650; y++) {
      for (let x = 300; x < 980; x++) {
        const i = (y * aPng.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          sumA[channel] += aPng.data[i + channel];
          sumB[channel] += bPng.data[i + channel];
        }
        count++;
      }
    }
    let farCount = 0;
    for (let y = 120; y < 380; y++) {
      for (let x = 280; x < 1000; x++) {
        const i = (y * aPng.width + x) * 4;
        const d = (Math.abs(aPng.data[i] - bPng.data[i])
          + Math.abs(aPng.data[i + 1] - bPng.data[i + 1])
          + Math.abs(aPng.data[i + 2] - bPng.data[i + 2])) / 3;
        pixelDiffSum += d;
        if (d > 12) changedPixels++;
        farCount++;
      }
    }
    const meanA = sumA.map((v) => v / count);
    const meanB = sumB.map((v) => v / count);
    return {
      exposureDelta: Math.max(...meanA.map((v, idx) => Math.abs(v - meanB[idx]))),
      meanPixelDelta: pixelDiffSum / farCount,
      changedPct: (changedPixels / farCount) * 100,
    };
  };
  const cont = continuity(thresholdPng, arrivalPng);
  check(cont.exposureDelta < 8,
    `destination final-image exposure stays continuous across threshold (max RGB mean Δ ${cont.exposureDelta.toFixed(2)})`);
  check(cont.meanPixelDelta < 8 && cont.changedPct < 15,
    `destination pixels stay continuous across threshold (mean Δ ${cont.meanPixelDelta.toFixed(2)}, >12/255: ${cont.changedPct.toFixed(2)}%)`);
  await page.waitForFunction(() => !NMS.riftState().active, null, { timeout: 5000 });
  const closed = await page.evaluate('NMS.riftState()');
  check(!closed.visible && !closed.composite && closed.phase === 'closed' && closed.open === 0 && closed.seam === 0,
    'fold closes and composites off cleanly after traversal');

  // Giants have a countChunks-only LOD facade. Exercise both types through the
  // real buttons; the terrain-only route above cannot catch this deadlock.
  for (const type of ['gasGiant', 'iceGiant']) {
    await page.waitForFunction(() => !document.body.classList.contains('travel-cinematic'));
    const giantTarget = await page.evaluate((type) => {
      const { universe, starMap } = NMS._internals;
      for (const star of universe.nearStarsList) {
        if (star.id === universe.system.star.id) continue;
        const body = starMap.systemPreview(star).bodies.find((body) => body.type === type);
        if (body) return { starId: star.id, bodyIndex: body.index, bodyId: body.bodyId };
      }
      return null;
    }, type);
    check(!!giantTarget, `${type} destination is available`);
    await page.evaluate((id) => {
      NMS.openStarMap();
      NMS.selectStarMapTarget(id);
      // Hold the queued destination portal preparation to verify the waiting UI
      // deterministically, even on a driver with a warm shader cache.
      const pipeline = NMS._pipeline;
      const prepare = pipeline.prepare.bind(pipeline);
      const gate = new Promise((resolve) => { window.__releaseRiftWarmup = resolve; });
      pipeline.prepare = function (work, options) {
        if (options?.label === 'destination-lod' || options?.label === 'destination-portal') {
          pipeline.prepare = prepare;
          return Promise.all([prepare(work, options), gate]).then(([value]) => value);
        }
        return prepare(work, options);
      };
    }, giantTarget.starId);
    await page.locator(`#sm-systemGlyph [data-glyph-index="${giantTarget.bodyIndex}"]`).click({ force: true });
    await page.waitForFunction((bodyId) => NMS._internals.starMap.mode === 'system'
      && NMS._internals.starMap.selectedPlanet?.bodyId === bodyId
      && document.querySelector('#sm-planetLeft')?.classList.contains('active')
      && !document.getElementById('sm-routeAction')?.disabled, giantTarget.bodyId);
    await page.locator('#sm-routeAction').click({ force: true });
    await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'));
    await page.locator('#route-rift-btn').click();
    await page.waitForTimeout(240);
    const waiting = await page.evaluate(() => ({
      rift: NMS.riftState(),
      cinematic: document.body.classList.contains('travel-cinematic'),
      hud: getComputedStyle(document.getElementById('ship-hud-stage')).visibility === 'hidden' ? 'none' : 'shown',
      hint: document.getElementById('hint').textContent,
    }));
    check(waiting.rift.active && !waiting.rift.visible && !waiting.cinematic
        && waiting.hud !== 'none' && waiting.hint.includes('正在预载'),
    `${type} keeps the HUD and loading hint visible during preparation`);
    if (type === 'gasGiant') {
      await page.screenshot({ path: path.join(os.tmpdir(), 'deep-space-rift-loading.png') });
    }
    await page.evaluate(() => window.__releaseRiftWarmup());
    await page.waitForFunction(() => NMS.riftState().anchorLocked, null, { timeout: 30000 });
    const preparation = await page.evaluate(() => NMS.warpPreparationState());
    check(preparation.lodWarmState === 'complete' && preparation.riftWarmState === 'complete'
        && !preparation.lodWarmError && !preparation.riftWarmError,
    `${type} completes portal preparation without terrain-quadtree calls`);
    check(await page.evaluate(() => NMS.riftState().visible && NMS.riftState().composite && NMS.riftState().open > 0.985),
      `${type} passage opens and renders`);
    check(await page.evaluate((bodyId) => {
      const body = NMS._internals.riftPreviewSystem.bodyById.get(bodyId);
      return body.appear === 1 && (!body.terrainMaterial || body.terrainMaterial.opacity === 1);
    }, giantTarget.bodyId), `${type} destination surface is opaque inside the portal`);
    await page.screenshot({ path: path.join(os.tmpdir(), `deep-space-rift-${type}.png`) });
    await page.evaluate(() => NMS.approachRift(-10));
    await page.waitForFunction(() => NMS.riftState().arrived, null, { timeout: 10000 });
    check(await page.evaluate((target) => NMS._internals.universe.system.star.id === target.starId
        && NMS._internals.universe.system.bodyById.has(target.bodyId), giantTarget),
    `${type} passage reaches the selected destination`);
    await page.waitForFunction(() => !NMS.riftState().active
      && !document.body.classList.contains('travel-cinematic'), null, { timeout: 10000 });
    check(await page.locator('#ship-hud-stage').isVisible(), `${type} arrival restores the flight HUD`);
  }

  // Reload and exercise the sibling route through the real star-map choice.
  // Both travel methods share the cinematic state, but this guards against a
  // future route handler forgetting to enter it before starting the tween.
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&nohero=1&quality=low&vclouds=1&farflora=0&freeze=1&buildms=1.6${rendererQuery}`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  const warpTarget = await page.evaluate(() => {
    const { universe, starMap } = NMS._internals;
    const star = universe.nearStarsList.find((candidate) => candidate.id === 'MW-0919')
      || universe.nearStarsList[0];
    const preview = starMap.systemPreview(star);
    const body = preview.bodies.find((candidate) => candidate.bodyId === 'planet-4')
      || preview.bodies.find((candidate) => !candidate.isMoon
        && !['gasGiant', 'iceGiant', 'blackHole'].includes(candidate.type));
    return { starId: star.id, bodyIndex: body.index, bodyId: body.bodyId };
  });
  await page.evaluate((id) => {
    NMS.openStarMap();
    NMS.selectStarMapTarget(id);
  }, warpTarget.starId);
  await page.locator(`#sm-systemGlyph [data-glyph-index="${warpTarget.bodyIndex}"]`).click({ force: true });
  await page.waitForFunction(() => document.querySelector('#sm-planetLeft')?.classList.contains('active'));
  await page.evaluate(() => NMS._internals.starMap.warpToSelection());
  await page.waitForFunction(() => !document.getElementById('route-choice').classList.contains('hidden'), null,
    { timeout: 60000 });
  const immediatePreparation = await page.evaluate(() => NMS.warpPreparationState());
  await page.evaluate(() => {
    window.__warpFrameGaps = [];
    window.__warpFrameGapsPhase1 = [];
    window.__warpLongFrames = [];
    window.__warpTracePaused = false;
    window.__warpTraceReset = false;
    let previous = performance.now();
    let started = false;
    const sample = (now) => {
      if (NMS.state === 'warp') started = true;
      if (started && NMS.state !== 'warp') return;
      if (started && window.__warpTraceReset) {
        window.__warpFrameGapsPhase1 = window.__warpFrameGaps;
        window.__warpFrameGaps = [];
        window.__warpLongFrames = [];
        window.__warpTraceReset = false;
        previous = now;
      }
      if (started && !window.__warpTracePaused) {
        const gap = now - previous;
        window.__warpFrameGaps.push(gap);
        if (gap > 100) {
          const system = NMS._internals.universe.system;
          window.__warpLongFrames.push({
            gap,
            systemId: system?.star?.id || null,
            builtBodies: system?.bodyById?.size || 0,
            totalBodies: system?._specs?.length || 0,
            built: system?.built || false,
            warp: NMS.warp(),
            pendingChunks: NMS.stats().pending,
          });
        }
      }
      previous = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator('#route-warp-btn').click();
  await page.waitForFunction(() => NMS.state === 'warp'
    && document.body.classList.contains('travel-cinematic'), null, { timeout: 10000 });
  check(immediatePreparation.routeStarId === warpTarget.starId,
    `stellar warp accepts the real button immediately (pre-click terrain ${immediatePreparation.lodWarmState}, water ${immediatePreparation.waterWarmState})`);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('ship-hud-stage')).visibility === 'hidden',
    null, { timeout: 3000 }).catch(() => {});
  const warpHudHidden = await page.evaluate(() => (getComputedStyle(
    document.getElementById('ship-hud-stage'),
  ).visibility === 'hidden' ? 'none' : 'shown'));
  check(warpHudHidden === 'none', 'stellar warp hides the complete cockpit HUD');
  await page.waitForFunction(() => NMS.state === 'warp' && NMS.warp() > 0.72,
    null, { timeout: 20000 });
  await page.evaluate(() => { window.__warpTracePaused = true; });
  await page.screenshot({ path: warpTunnelFrameA });
  await page.waitForTimeout(180);
  await page.screenshot({ path: warpTunnelFrameB });
  const [warpTunnelA, warpTunnelB] = await Promise.all([
    readFile(warpTunnelFrameA),
    readFile(warpTunnelFrameB),
  ]).then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  let warpTunnelChanged = 0;
  for (let i = 0; i < warpTunnelA.data.length; i += 4) {
    const delta = Math.abs(warpTunnelA.data[i] - warpTunnelB.data[i])
      + Math.abs(warpTunnelA.data[i + 1] - warpTunnelB.data[i + 1])
      + Math.abs(warpTunnelA.data[i + 2] - warpTunnelB.data[i + 2]);
    if (delta > 24) warpTunnelChanged++;
  }
  check(warpTunnelChanged > 1200,
    `perspective warp starflow remains visibly alive (${warpTunnelChanged} changed pixels)`);
  await page.evaluate(() => {
    window.__warpTracePaused = false;
    window.__warpTraceReset = true;
  });
  await page.waitForFunction((target) => NMS.state === 'space'
    && NMS.system().id === target.starId
    && (NMS.volumeState().activeBodyId
      || NMS._pipeline?.cloudPass?.activePlanet?.bodyId
      || NMS._pipeline?.atmospherePass?.activePlanet?.bodyId) === target.bodyId,
  warpTarget, { timeout: 90000 });
  const arrival = await page.evaluate((target) => {
    const { universe, nav, camera } = NMS._internals;
    const body = universe.system.bodyById.get(target.bodyId);
    const stalePlanets = universe.fadingSystem?.planets?.map((planet) => ({
      bodyId: planet.bodyId,
      distance: nav.pos.distanceTo(planet.posUniv),
      radius: planet.R,
      ring: !!planet.ringMesh,
    })) || [];
    const activeMediumBodyId = NMS.volumeState().activeBodyId
      || NMS._pipeline?.cloudPass?.activePlanet?.bodyId
      || NMS._pipeline?.atmospherePass?.activePlanet?.bodyId
      || null;
    return {
      state: NMS.state,
      systemId: NMS.system().id,
      bodyId: body?.bodyId || null,
      bodyName: body?.name || null,
      position: NMS.pos(),
      distanceRatio: body ? nav.pos.distanceTo(body.posUniv) / body.R : null,
      fov: camera.fov,
      warp: NMS.warp(),
      volume: NMS.volumeState(),
      activeMediumBodyId,
      stalePlanets,
      gpuErrors: window.__riftGpuErrors || [],
      frameGaps: window.__warpFrameGaps || [],
      phase1FrameGaps: window.__warpFrameGapsPhase1 || [],
      longFrames: window.__warpLongFrames || [],
    };
  }, warpTarget);
  check(arrival.state === 'space' && arrival.systemId === warpTarget.starId,
    'stellar warp completes in the selected destination system');
  check(arrival.position.every(Number.isFinite) && arrival.warp === 0 && Math.abs(arrival.fov - 62) < 0.1,
    'stellar warp restores finite navigation state and the base camera');
  check(arrival.bodyId === warpTarget.bodyId && arrival.activeMediumBodyId === warpTarget.bodyId,
    `arrival medium belongs to the selected body (${arrival.bodyName || arrival.bodyId})`);
  check(arrival.gpuErrors.length === 0,
    `stellar warp arrival produces no uncaptured WebGPU errors (${arrival.gpuErrors.length})`);
  const sortedWarpGaps = arrival.frameGaps.filter((gap) => gap >= 0)
    .sort((a, b) => a - b);
  const phase1WarpMax = Math.max(0, ...arrival.phase1FrameGaps);
  const warpP95 = sortedWarpGaps[Math.floor(sortedWarpGaps.length * 0.95)] || 0;
  const warpMaxGap = sortedWarpGaps.at(-1) || 0;
  const warpFrozenGaps = sortedWarpGaps.filter((gap) => gap > 250).length;
  check(warpFrozenGaps === 0,
    `stellar warp has no frozen-effect frame gaps (p95 ${warpP95.toFixed(1)} ms, max ${warpMaxGap.toFixed(1)} ms, spool ${phase1WarpMax.toFixed(1)} ms)`);
  if (arrival.longFrames.length) console.log('warp long frames:', arrival.longFrames);
  const visibleStalePlanets = arrival.stalePlanets.filter((planet) =>
    planet.distance < Math.max(planet.radius * 64, 1.4e9));
  check(visibleStalePlanets.length === 0,
    `stellar warp leaves no old-system planet or ring near the arrival camera (${visibleStalePlanets.length})`);
  if (arrival.gpuErrors.length) {
    console.log('warp GPU errors:', [...new Set(arrival.gpuErrors)].slice(0, 5));
  }
  if (arrival.stalePlanets.length) {
    console.log('warp fading-system planets:', arrival.stalePlanets);
  }
  await page.screenshot({ path: warpArrivalFrame });
  const beforeMove = await page.evaluate('NMS.pos()');
  const frameBeforeMove = await page.evaluate('NMS.frame()');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1600);
  await page.keyboard.up('KeyW');
  const afterMove = await page.evaluate('NMS.pos()');
  const frameAfterMove = await page.evaluate('NMS.frame()');
  await page.screenshot({ path: warpMovedFrame });
  const [warpBeforePng, warpAfterPng] = await Promise.all([
    readFile(warpArrivalFrame),
    readFile(warpMovedFrame),
  ]).then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  let warpChangedPixels = 0;
  for (let i = 0; i < warpBeforePng.data.length; i += 4) {
    const delta = Math.abs(warpBeforePng.data[i] - warpAfterPng.data[i])
      + Math.abs(warpBeforePng.data[i + 1] - warpAfterPng.data[i + 1])
      + Math.abs(warpBeforePng.data[i + 2] - warpAfterPng.data[i + 2]);
    if (delta > 24) warpChangedPixels++;
  }
  const moved = Math.hypot(...afterMove.map((value, index) => value - beforeMove[index]));
  check(moved > 100 && frameAfterMove > frameBeforeMove + 2,
    `post-warp controls and rendered frames remain live (${moved.toFixed(1)} m, ${frameAfterMove - frameBeforeMove} frames)`);
  check(warpChangedPixels > 1200,
    `post-warp forward flight visibly changes the final image (${warpChangedPixels} changed pixels)`);

  check(shaderErrors.length === 0, 'rift shaders compile without browser errors');
  check(errors.length === 0, 'rift traversal produces no page errors');
  console.log(`captures: ${routeFrame}, ${routeMobileFrame}, ${openingFrame}, ${frameA}, ${frameB}, ${thresholdFrame}, ${arrivalFrame}, ${warpTunnelFrameA}, ${warpTunnelFrameB}, ${warpArrivalFrame}, ${warpMovedFrame}`);
} finally {
  await context.close();
  await browser.close();
  server.close();
}

console.log(failures || errors.length || shaderErrors.length
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s), ${shaderErrors.length} shader/console error(s)`
  : 'DONE - spatial-rift browser checks passed');
if (shaderErrors.length) console.error(JSON.stringify({ shaderErrors }, null, 2));
if (shaderWarnings.length) console.warn(`non-fatal GLSL precision warnings: ${shaderWarnings.length}`);
process.exit(failures || errors.length || shaderErrors.length ? 1 : 0);
