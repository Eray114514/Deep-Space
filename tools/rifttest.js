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
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  const text = message.text();
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
  const riftHudHidden = await page.evaluate(() => ({
    display: getComputedStyle(document.getElementById('ship-hud-stage')).display,
    routeHidden: getComputedStyle(document.getElementById('route-choice')).display,
  }));
  check(riftHudHidden.display === 'none' && riftHudHidden.routeHidden === 'none',
    'rift passage hides the complete cockpit HUD and route selector');
  await page.waitForFunction(() => {
    const rift = NMS.riftState();
    return rift.tension > 0.45 && rift.open > 0.10 && rift.open < 0.82;
  }, null, { timeout: 20000 });
  const openingState = await page.evaluate('NMS.riftState()');
  await page.screenshot({ path: openingFrame });
  check(openingState.burst < 0.30,
    `rift opening keeps its release pulse local (open ${openingState.open.toFixed(2)}, burst ${openingState.burst.toFixed(2)})`);
  await page.waitForFunction(() => NMS.riftState().open > 0.985 && NMS.riftState().burst < 0.001,
    null, { timeout: 20000 });
  await page.waitForFunction(() => (NMS.riftState().previewVolume?.portalReadiness || 0) > 0.96,
    null, { timeout: 20000 });

  check(await page.evaluate('NMS.stats().audio'), 'route gesture unlocks procedural audio');
  const stable = await page.evaluate('NMS.riftState()');
  check(stable.visible && stable.destinationLight.length > 0,
    'stable passage renders a live destination system');
  const portalContract = await page.evaluate(() => {
    const { scene, riftPreviewSystem } = NMS._internals;
    const targetBodyId = NMS.riftState().previewVolume?.bodyId;
    const targetBody = riftPreviewSystem?.bodyById.get(targetBodyId);
    const wall = scene.getObjectByName('spatial-rift-inner-wall');
    const portal = scene.getObjectByName('spatial-rift-portal-cutout');
    const previewBodies = [
      ...(riftPreviewSystem?.planets || []),
      ...(riftPreviewSystem?.compactObjects || []),
    ];
    return {
      wallOpaque: !!wall && !wall.material.transparent && wall.material.depthWrite,
      portalOpaqueCutout: !!portal
        && !portal.material.transparent
        && portal.material.depthWrite
        && portal.material.alphaTest >= 0.5
        && portal.material.alphaToCoverage
        && portal.renderOrder < wall.renderOrder,
      previewSceneHidden: previewBodies.every((body) => !body.group.visible)
        && (riftPreviewSystem?.starViews || []).every((view) =>
          !view.group.visible && !view.light.visible),
      radius: targetBody?.R || 0,
      atmosphereRadius: targetBody?.atmoMesh?.geometry?.parameters?.radius || 0,
      cloudRadius: targetBody?.cloudMesh?.geometry?.parameters?.radius || 0,
      volumeCloudRadius: targetBody?.volCloudMesh?.geometry?.parameters?.radius || 0,
    };
  });
  check(portalContract.wallOpaque,
    'rift thickness is an opaque depth-writing inner wall');
  check(portalContract.portalOpaqueCutout,
    'destination portal is an opaque cutout rendered before the inner wall');
  check(portalContract.previewSceneHidden,
    'destination scene remains isolated from the source-world main pass');
  const targetShellsBounded = portalContract.radius > 0
    && portalContract.atmosphereRadius / portalContract.radius < 1.2
    && portalContract.cloudRadius / portalContract.radius < 1.08
    && portalContract.volumeCloudRadius / portalContract.radius < 1.08;
  check(targetShellsBounded,
    'destination atmosphere and cloud shells stay bounded to the selected planet');
  check(stable.previewVolume?.preloaded && stable.previewVolume?.ready,
    'rift reuses the destination prepared when the route selector opened');
  check(stable.previewVolume?.cloudCoverage > 0.12
      && stable.previewVolume?.atmosphereVisible
      && stable.previewVolume?.volumeCloudVisible
      && stable.previewVolume?.portalVolumeLayerRendered,
  `portal renders the selected planet's atmosphere and volume clouds (${stable.previewVolume?.cloudCoverage?.toFixed(2) || 'missing'} coverage)`);

  await page.screenshot({ path: frameA });
  await page.waitForTimeout(420);
  await page.screenshot({ path: frameB });
  const [a, b] = await Promise.all([readFile(frameA), readFile(frameB)])
    .then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  let changed = 0;
  let opaqueWallPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i])
      + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 24) changed++;
    const red = a.data[i];
    const green = a.data[i + 1];
    const blue = a.data[i + 2];
    if (red < 24 && green < 62 && blue > 18 && blue > green * 1.15) {
      opaqueWallPixels++;
    }
  }
  check(opaqueWallPixels > 30000,
    `stable passage visibly contains an opaque inner wall (${opaqueWallPixels} pixels)`);
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
  const exitDepths = await page.evaluate(() => new Promise((resolve) => {
    const samples = [];
    const sample = () => requestAnimationFrame(() => {
      const rift = NMS.riftState();
      if (rift.exitDepth) samples.push(rift.exitDepth);
      if (!rift.visible || samples.length >= 8) resolve(samples);
      else sample();
    });
    sample();
  }));
  check(exitDepths.length > 0 && exitDepths.every((range) => range.min > 0),
    `collapsing exit stays fully behind the camera (${exitDepths.length} sampled frames)`);
  await page.evaluate(() => NMS._internals.nav.vel.set(0, 0, 0));
  await page.waitForTimeout(80);
  await page.screenshot({ path: arrivalFrame });
  const [thresholdPng, arrivalPng] = await Promise.all([readFile(thresholdFrame), readFile(arrivalFrame)])
    .then((buffers) => buffers.map((buffer) => PNG.sync.read(buffer)));
  const mean = (png) => {
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = 190; y < 650; y++) {
      for (let x = 300; x < 980; x++) {
        const i = (y * png.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) sum[channel] += png.data[i + channel];
        count++;
      }
    }
    return sum.map((value) => value / count);
  };
  const beforeMean = mean(thresholdPng);
  const afterMean = mean(arrivalPng);
  const exposureDelta = Math.max(...beforeMean.map((value, index) => Math.abs(value - afterMean[index])));
  check(exposureDelta < 8,
    `destination final-image exposure stays continuous (max RGB mean Δ ${exposureDelta.toFixed(2)})`);
  await page.waitForFunction(() => !NMS.riftState().active, null, { timeout: 5000 });
  const closed = await page.evaluate('NMS.riftState()');
  check(!closed.visible && closed.open === 0, 'exit collapses fully after traversal');

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
  const warpHudHidden = await page.evaluate(() => getComputedStyle(
    document.getElementById('ship-hud-stage'),
  ).display);
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
    && NMS.volumeState().activeBodyId === target.bodyId,
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
  check(arrival.bodyId === warpTarget.bodyId && arrival.volume.activeBodyId === warpTarget.bodyId,
    `arrival volume belongs to the selected body (${arrival.bodyName || arrival.bodyId})`);
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
process.exit(failures || errors.length || shaderErrors.length ? 1 : 0);
