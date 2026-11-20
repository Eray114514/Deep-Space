// End-to-end browser verification for:
//   1. 3-pad tripod sloped landing + telescopic gear pistons (zero floating pads)
//   2. Rugged/steep terrain rejection -> Hover -> HALO skydive -> Parafoil canopy -> PAC-9 draw
//   3. Unmanned hover ship auto-departure to orbital standby
//   4. Out-of-sight cinematic fly-in recall (T): Steep-slope Hot Extraction hover & flat-pad open-ramp landing
//
//   node tools/skydivetest.js [--gpu]

import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser } from './browser.js';

const gpu = process.argv.includes('--gpu');
const OUT = 'screenshots/skydive';
await mkdir(OUT, { recursive: true });

const { server, port } = await startServer(0);
const browser = gpu ? await launchHardwareBrowser() : await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const shaderErrors = [];
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

page.on('pageerror', (e) => {
  errors.push(String(e));
  console.error('PAGEERROR:', String(e).split('\n')[0]);
});
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') console.error('CONSOLE:', t.slice(0, 300));
  if (/WebGLProgram|shader error|INVALID_OPERATION/i.test(t)) shaderErrors.push(t);
});

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  [shot] ${OUT}/${name}.png`);
}

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&post=0&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });
  console.log('booted');

  // Locate:
  //   (A) a moderate 7°..13° dry sunlit slope (should allow tripod landing with 0 floating!)
  //   (B) a genuinely steep > 22° sunlit mountain slope (should reject landing -> hover skydive!)
  const sites = await page.evaluate(() => {
    const THREE = NMS._THREE;
    const p = NMS._planet(0);
    const sv = new THREE.Vector3();
    const se1 = new THREE.Vector3();
    const se2 = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const sampleSlopeDeg = (dir, span = 8) => {
      if (Math.abs(dir.y) < 0.93) se1.set(dir.z, 0, -dir.x).normalize();
      else se1.set(0, -dir.z, dir.y).normalize();
      se2.crossVectors(dir, se1).normalize();
      const hX1 = p.height(sv.copy(dir).addScaledVector(se1, span / p.R).normalize(), p.fullMaxFreq);
      const hX0 = p.height(sv.copy(dir).addScaledVector(se1, -span / p.R).normalize(), p.fullMaxFreq);
      const hZ1 = p.height(sv.copy(dir).addScaledVector(se2, span / p.R).normalize(), p.fullMaxFreq);
      const hZ0 = p.height(sv.copy(dir).addScaledVector(se2, -span / p.R).normalize(), p.fullMaxFreq);
      const grad = Math.hypot((hX1 - hX0) / (2 * span), (hZ1 - hZ0) / (2 * span));
      return (Math.atan(grad) * 180) / Math.PI;
    };

    let moderate = null;
    let steep = null;
    const cand = new THREE.Vector3();
    const N = 24000;
    for (let k = 0; k < N && (!moderate || !steep); k++) {
      const y = 1 - (2 * (k + 0.5)) / N;
      const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
      cand.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
      if (cand.dot(p.sunDirLocal) < 0.25) continue;
      const h = p.height(cand, p.fullMaxFreq);
      if (p.hasLiquid && h < p.seaLevel + 35) continue;
      const deg = sampleSlopeDeg(cand, 9);

      if (!moderate && deg >= 7.0 && deg <= 11.5) {
        const deg2 = sampleSlopeDeg(cand, 32);
        if (deg2 >= 6.5 && deg2 <= 12.0) moderate = { dir: cand.toArray(), deg };
      }
      if (!steep && deg >= 22.0 && sampleSlopeDeg(cand, 90) >= 19.5) {
        // Ensure an entire 110 m mountainside around this point is > 17.5° steep
        let allSteep = true;
        if (Math.abs(cand.y) < 0.93) e1.set(cand.z, 0, -cand.x).normalize();
        else e1.set(0, -cand.z, cand.y).normalize();
        e2.crossVectors(cand, e1).normalize();
        for (const rad of [24, 52, 82, 110]) {
          for (let a = 0; a < 10; a++) {
            const ang = (a / 10) * Math.PI * 2;
            const sub = cand.clone()
              .addScaledVector(e1, (Math.cos(ang) * rad) / p.R)
              .addScaledVector(e2, (Math.sin(ang) * rad) / p.R)
              .normalize();
            if (sampleSlopeDeg(sub, 8) < 17.5) { allSteep = false; break; }
          }
          if (!allSteep) break;
        }
        if (allSteep) steep = { dir: cand.toArray(), deg };
      }
    }
    return { moderate, steep };
  });

  console.log('sites:', JSON.stringify(sites));
  check(Boolean(sites.moderate), `found moderate slope test site (${sites.moderate?.deg?.toFixed(1)}°)`);
  check(Boolean(sites.steep), `found steep rugged mountainside test site (${sites.steep?.deg?.toFixed(1)}°)`);

  // =========================================================================
  // 1. Moderate slope landing: verify tripod tilt + zero floating gear pads!
  // =========================================================================
  await page.evaluate((dir) => {
    const THREE = NMS._THREE;
    const p = NMS._planet(0);
    const groundR = p.surfaceRadius(new THREE.Vector3(...dir));
    NMS.teleport(0, (groundR + 130 - p.R) / p.R, { dir, horizon: true, pitch: -0.14 });
    NMS.shipViewDebug.setViewMode('chase');
  }, sites.moderate.dir);
  await page.waitForTimeout(350);
  const slopePrompt = await page.evaluate(() => document.getElementById('land-btn').textContent.trim());
  check(slopePrompt === '自动驾驶着陆  [L]', `moderate slope offers normal landing (${slopePrompt})`);

  await page.keyboard.press('KeyL');
  await page.waitForFunction('NMS.state === "landed"', null, { timeout: 60000 });
  await page.keyboard.press('KeyV');
  await page.waitForFunction('NMS.shipViewState().viewMode === "chase" && NMS.shipViewState().parkedCamBlend >= 0.99', null, { timeout: 25000 });
  await page.waitForTimeout(450);

  const slopedLand = await page.evaluate(() => {
    const THREE = NMS._THREE;
    const { ship } = NMS._internals;
    const sphereUp = ship.parkedLocal.clone().normalize();
    const shipUp = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.parkedLocalQuat).normalize();
    const tiltDeg = (Math.acos(Math.min(1, Math.max(-1, sphereUp.dot(shipUp)))) * 180) / Math.PI;
    return {
      tiltDeg: +tiltDeg.toFixed(2),
      landing: NMS.shipLandingState(),
    };
  });
  console.log('slopedLand:', JSON.stringify(slopedLand));
  check(slopedLand.tiltDeg > 3.5, `ship tilts naturally with sloped ground (${slopedLand.tiltDeg}°)`);
  check(slopedLand.landing.padGaps.length === 3
      && slopedLand.landing.padGaps.every((g) => Math.abs(g) < 0.04),
    `all 3 landing-gear footpads sit flush on sloped terrain (< 4 cm gap): ${JSON.stringify(slopedLand.landing.padGaps)}`);
  await shot('01-sloped-tripod-landed');

  // Launch back to space
  await page.keyboard.press('Space');
  await page.waitForFunction('NMS.state === "space"', null, { timeout: 60000 });

  // =========================================================================
  // 2. Steep mountainside (> 24°): reject landing -> Hover -> Open Ramp ->
  //    HALO Skydive -> Parafoil Canopy -> Touchdown + PAC-9 Draw!
  // =========================================================================
  await page.evaluate((dir) => {
    const THREE = NMS._THREE;
    const p = NMS._planet(0);
    const groundR = p.surfaceRadius(new THREE.Vector3(...dir));
    NMS.teleport(0, (groundR + 175 - p.R) / p.R, { dir, horizon: true, pitch: -0.16 });
    NMS.shipViewDebug.setViewMode('chase');
  }, sites.steep.dir);
  await page.waitForTimeout(400);

  const ruggedPrompt = await page.evaluate(() => ({
    visible: !document.getElementById('land-btn').classList.contains('hidden'),
    text: document.getElementById('land-btn').textContent.trim(),
  }));
  check(ruggedPrompt.visible && ruggedPrompt.text === '地形崎岖 · 悬停跳伞  [L]',
    `steep mountainside switches L prompt to hover-skydive (${JSON.stringify(ruggedPrompt)})`);

  await page.keyboard.press('KeyL');
  await page.waitForFunction('NMS.state === "landed"', null, { timeout: 60000 });
  const hoverState = await page.evaluate(() => NMS.shipLandingState());
  check(hoverState.hoverMode === 'high' && hoverState.gearT < 0.08,
    `ship settles in level high-hover with landing gear stowed ${JSON.stringify(hoverState)}`);

  // Stand up (F), walk to cargo hold, open jump ramp (F), and leap out!
  await page.keyboard.press('KeyF');
  await page.waitForFunction('NMS.state === "shipwalk" && NMS.shipViewState().seatT >= 0.999', null, { timeout: 30000 });
  await page.evaluate(() => {
    const sv = NMS._internals.shipView;
    sv.walkPos.set(0, 0, 4.6);
    sv.walkYaw = Math.PI;
    sv.walkPitch = -0.22;
  });
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyF');
  await page.waitForFunction('NMS.shipViewState().rampWalkable', null, { timeout: 30000 });
  await shot('02-hover-ramp-abyss');

  await page.evaluate(() => {
    window.jumpTrace = { rise: 0, minShoulderZ: Infinity, gripGap: 0, heldFrames: 0,
      minLeapSpan: Infinity, maxTumble: 0 };
    const { scene, camera, skydiveCtl } = NMS._internals;
    const sample = () => {
      const s = NMS.skydiveState();
      if (s.active) {
        jumpTrace.rise = Math.max(jumpTrace.rise, -s.sinkRate);
        jumpTrace.maxTumble = Math.max(jumpTrace.maxTumble, skydiveCtl.exitMotion().tip);
        const hL = scene.getObjectByName('jump-glove-left');
        const hR = scene.getObjectByName('jump-glove-right');
        if (skydiveCtl.time > 0.05 && skydiveCtl.time < 0.55) {
          jumpTrace.minLeapSpan = Math.min(jumpTrace.minLeapSpan, Math.abs(hR.position.x - hL.position.x));
        }
        for (const side of ['left', 'right']) {
          const hand = scene.getObjectByName('jump-glove-' + side);
          const socket = hand.geometry.userData.shoulderSocket.clone().add(hand.material.uniforms.shoulderOffset.value);
          jumpTrace.minShoulderZ = Math.min(jumpTrace.minShoulderZ, camera.worldToLocal(hand.localToWorld(socket)).z);
          if (s.deployT >= .58) {
            const grip = hand.localToWorld(new NMS._THREE.Vector3(0, -.026, -.106));
            const toggle = scene.getObjectByName('jump-toggle-' + side);
            jumpTrace.gripGap = Math.max(jumpTrace.gripGap, grip.distanceTo(toggle.getWorldPosition(socket)));
            jumpTrace.heldFrames++;
          }
        }
      }
      if (s.deployT < 1) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForFunction('NMS.state === "skydive"', null, { timeout: 30000 });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');

  const freefall0 = await page.evaluate(() => NMS.skydiveState());
  check(freefall0.active && freefall0.phase === 'freefall' && freefall0.agl > 60
      && freefall0.handsVisible && !freefall0.canopyVisible,
    `running off open hover ramp enters seamless freefall ${JSON.stringify(freefall0)}`);
  // Verify freefall camera pitch/yaw decoupling: looking up or sideways does not drag hands with camera!
  const freefallLookCheck = await page.evaluate(() => {
    const THREE = NMS._THREE;
    const { scene, camera, skydiveCtl: ctl, skydiveViewCamera: cam } = NMS._internals;
    const syncPose = () => {
      ctl.updateQuat();
      ctl.syncRig();
      camera.quaternion.copy(ctl.planet.frameOrientation).multiply(ctl.quat);
      scene.updateMatrixWorld(true);
      cam.updateMatrixWorld(true);
    };
    const handR = ctl.rig.root.getObjectByName('jump-glove-right');
    const handYInCam = () => {
      const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
      return handR.localToWorld(new THREE.Vector3()).applyMatrix4(inv).y;
    };
    const origPitch = ctl.pitch;
    const origYaw = ctl.yaw;
    ctl.pitch = -0.18;
    syncPose();
    const levelHandY = handYInCam();
    // Look sharply up (+60 deg): hands stay in belly pose below camera instead of rising skyward.
    NMS.lookPitch(60);
    syncPose();
    const lookupHandY = handYInCam();
    // Look down sharply (-75 deg): sleeve socket stays behind eye plane.
    ctl.pitch = -1.32;
    syncPose();
    const sock = handR.geometry.userData.shoulderSocket.clone().add(handR.material.uniforms.shoulderOffset.value);
    const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
    const sockZDown = handR.localToWorld(sock).applyMatrix4(inv).z;
    // Turn head +22 deg sideways: body heading lags independently of camera yaw.
    ctl.pitch = origPitch;
    ctl.yaw = origYaw;
    NMS.lookYaw(22);
    syncPose();
    const headYawAfter = (ctl.yaw - ctl.glideYaw) * 180 / Math.PI;
    ctl.yaw = origYaw;
    syncPose();
    return { levelHandY, lookupHandY, sockZDown, headYawAfter };
  });
  check(freefallLookCheck.lookupHandY < freefallLookCheck.levelHandY - 0.15
      && freefallLookCheck.sockZDown > 0.10
      && Math.abs(freefallLookCheck.headYawAfter - 22) < 1.5,
    `freefall hands stay anchored to body across up/down/yaw camera motion ${JSON.stringify(freefallLookCheck)}`);
  await page.evaluate('NMS.lookPitch(-35)');
  await page.waitForTimeout(700);
  await shot('03-skydive-freefall');

  await page.waitForFunction('NMS.skydiveState().sinkRate > 14');
  const freefallPeak = await page.evaluate(() => NMS.skydiveState());
  check(freefallPeak.airspeed > 14, `freefall builds downward airspeed (${freefallPeak.airspeed} m/s)`);

  // Deploy the parafoil canopy manually with Space!
  await page.keyboard.press('Space');
  await page.waitForFunction('NMS.skydiveState().phase === "canopy" && NMS.skydiveState().deployT > 0.65', null, { timeout: 20000 });
  const canopyState = await page.evaluate(() => NMS.skydiveState());
  check(canopyState.canopyVisible && canopyState.handsVisible && !canopyState.aadTriggered,
    `manual deployment raises the nine-cell wing and keeps both gloves visible ${JSON.stringify(canopyState)}`);

  const yawStops = await page.evaluate(() => [360, -720, 26].map(delta => {
    NMS.lookYaw(delta);
    return NMS.skydiveState().headYaw * 180 / Math.PI;
  }));
  check(yawStops.every((angle, i) => Math.abs(angle - [26, -26, 0][i]) < .001),
    'canopy look stops on both sides and releases immediately on reversal');
  const pitchFloorOk = await page.evaluate(() => {
    const startPitch = NMS._internals.skydiveCtl.pitch;
    NMS.lookPitch(-300);
    const clamped = NMS._internals.skydiveCtl.pitch;
    NMS.lookPitch(Math.round((startPitch - clamped) * 180 / Math.PI));
    return Math.abs(clamped + 0.62) < 0.01;
  });
  check(pitchFloorOk, 'canopy downward look pitch is clamped at -0.62 rad to prevent sleeve/riser clipping');
  // Look up overhead to capture the inflated wing and the loaded line groups.
  await page.evaluate(() => {
    const sd = NMS._internals;
    NMS.lookPitch(120);
    void sd;
  });
  await page.waitForTimeout(300);
  await shot('04-parafoil-canopy-overhead');
  await page.waitForFunction('NMS.skydiveState().deployT === 1 && jumpTrace.heldFrames > 0');
  const trace = await page.evaluate(() => jumpTrace);
  check(trace.rise > 4 && trace.minShoulderZ > .05 && trace.gripGap < .001
      && trace.minLeapSpan < 0.55 && trace.maxTumble > 0.30,
    `ramp pushes off upward with forward leap throw, sleeve ends stay behind the eye, toggles stay in the grasp ${JSON.stringify(trace)}`);

  // Look toward the mountain horizon (-6° pitch so peripheral risers/toggles + mountain both show) and bank right!
  await page.evaluate('NMS.lookPitch(-76)');
  await page.keyboard.down('KeyD');
  await page.waitForFunction('NMS.skydiveState().brakeRight > 0.8 && NMS.skydiveState().brakeLeft < 0.1');
  await shot('05-parafoil-glide-mountain');
  await page.keyboard.up('KeyD');

  // Hold W to swoop down faster to touchdown on the mountain!
  await page.keyboard.down('KeyW');
  await page.waitForFunction('NMS.state === "walk"', null, { timeout: 90000 });
  await page.keyboard.up('KeyW');

  const postTouchdown = await page.evaluate(() => ({
    state: NMS.state,
    weapon: NMS.surfaceWeaponState(),
    shipLanding: NMS.shipLandingState(),
    landDip: NMS._internals.walkCtl.landDip,
    runOut: NMS._internals.walkCtl.runOut,
    collapsing: NMS.skydiveState().collapsing,
  }));
  check(postTouchdown.state === 'walk' && postTouchdown.weapon.rendered
      && (postTouchdown.weapon.equip === 'drawing' || postTouchdown.weapon.equip === 'ready')
      && (postTouchdown.landDip > 0.05 || postTouchdown.runOut > 0.05 || postTouchdown.collapsing),
    `parachute touchdown transitions seamlessly to walk with knee dip, run-out, canopy collapse and PAC-9 draw ${JSON.stringify(postTouchdown)}`);
  await page.waitForFunction(() => !NMS.skydiveState().collapsing
      && !NMS._internals.skydiveCtl.rig.root.visible
      && Math.abs(NMS._internals.walkCtl.eyeHeight - NMS._internals.walkCtl.standEyeHeight) < 0.06,
    null, { timeout: 10000 });
  check(true, 'touchdown canopy collapse clears cleanly and knees recover to standing height');

  await page.waitForFunction('NMS.shipLandingState().orbitalStandby === true', null, { timeout: 30000 });
  check(true, 'unmanned hover ship automatically seals ramp and climbs to orbital standby');

  // =========================================================================
  // 3. Stand on the steep (> 25°) mountainside and press T -> Out-of-sight
  //    fly-in Hot Extraction hover (`hoverMode === 'extract'`) -> sprint up
  //    open hovering ramp -> sit -> takeoff!
  // =========================================================================
  await page.waitForFunction('NMS.surfaceWeaponState().equip === "ready"', null, { timeout: 25000 });
  await page.evaluate((dirArr) => {
    const THREE = NMS._THREE;
    const { walkCtl, nav } = NMS._internals;
    const p = walkCtl.planet;
    const dir = new THREE.Vector3(...dirArr).normalize();
    const e1 = Math.abs(dir.y) < 0.93
      ? new THREE.Vector3(dir.z, 0, -dir.x).normalize()
      : new THREE.Vector3(0, -dir.z, dir.y).normalize();
    const e2 = new THREE.Vector3().crossVectors(dir, e1).normalize();
    const h0 = p.surfaceRadius(dir);
    let downhill = e1.clone();
    let bestDrop = -Infinity;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const candFwd = e1.clone().multiplyScalar(Math.cos(ang))
        .addScaledVector(e2, Math.sin(ang)).normalize();
      const drop = h0 - p.surfaceRadius(dir.clone().addScaledVector(candFwd, 12 / p.R).normalize());
      if (drop > bestDrop) {
        bestDrop = drop;
        downhill = candFwd;
      }
    }
    const pos = dir.clone().multiplyScalar(h0 + walkCtl.eyeHeight);
    walkCtl.enter(p, pos, downhill);
    p.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
  }, sites.steep.dir);
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyT');
  check(await page.evaluate(() => NMS.shipLandingState().recallInFlight === true),
    'KeyT starts out-of-sight recall fly-in sequence');
  await page.waitForTimeout(1900);
  await page.evaluate('NMS.faceShip()');
  await page.waitForTimeout(250);
  await shot('06-recall-flyin');

  await page.waitForFunction('!NMS.shipLandingState().recallInFlight', null, { timeout: 60000 });
  await page.evaluate('NMS.faceShip()');
  await page.waitForTimeout(300);
  const extractState = await page.evaluate(() => ({
    landing: NMS.shipLandingState(),
    shipView: NMS.shipViewState(),
    dist: NMS.shipDistance(),
  }));
  console.log('extractState:', JSON.stringify(extractState));
  check(extractState.landing.hoverMode === 'extract'
      && extractState.shipView.rampWalkable
      && extractState.dist < 30,
    `steep-cliff recall executes Hot Extraction Hover with open ramp (${extractState.landing.hoverMode}, dist=${extractState.dist.toFixed(1)} m)`);
  await shot('07-hot-extraction-hover');

  // Position right in front of the open extraction ramp tip and sprint up into the cabin!
  await page.evaluate(() => {
    const THREE = NMS._THREE;
    const { ship, walkCtl, nav, shipView } = NMS._internals;
    const planet = walkCtl.planet;
    const tip = shipView.rampTipLocal();
    const footLocal = new THREE.Vector3(0, 0, tip.z + 0.75)
      .applyQuaternion(ship.parkedLocalQuat).add(ship.parkedLocal);
    const dir = footLocal.clone().normalize();
    const groundR = planet.surfaceRadius(dir);
    const pos = dir.clone().multiplyScalar(groundR + walkCtl.eyeHeight);
    const toHold = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.parkedLocalQuat)
      .projectOnPlane(dir).normalize();
    walkCtl.enter(planet, pos, toHold);
    planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);
  });
  await page.waitForTimeout(180);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForFunction('NMS.state === "shipwalk"', null, { timeout: 30000 });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  check(await page.evaluate(() => {
    const w = NMS.surfaceWeaponState();
    return NMS.state === 'shipwalk' && (w.equip === 'holstering' || w.equip === 'holstered');
  }), 'running up recalled ramp boards seamlessly into shipwalk and auto-holsters PAC-9');

  await page.evaluate(() => window.NMS.shipViewDebug?.teleportNearSeat?.());
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyF');
  await page.waitForFunction('NMS.state === "landed"', null, { timeout: 30000 });
  await page.keyboard.press('Space');
  await page.waitForFunction('NMS.state === "space"', null, { timeout: 60000 });
  check(true, 'seated pilot launches cleanly from recalled ship back into space');

  // =========================================================================
  // 4. Flat clearing recall (T): verify cloud-layer ordering during fly-in
  //    AND tripod-flush open-ramp landing!
  // =========================================================================
  await page.evaluate('NMS.land(0)');
  await page.waitForFunction('NMS.state === "walk"', null, { timeout: 30000 });
  // Force heavy cloud cover overhead and move 95 m away so recall flies right across the clouds!
  await page.evaluate(() => {
    const THREE = NMS._THREE;
    const { walkCtl, nav } = NMS._internals;
    const p = walkCtl.planet;
    p.setWeatherFixture?.('cumulus');
    const up = walkCtl.posLocal.clone().normalize();
    const east = new THREE.Vector3(up.z, 0, -up.x).normalize();
    const farDir = up.clone().addScaledVector(east, 95 / p.R).normalize();
    const pos = farDir.clone().multiplyScalar(p.surfaceRadius(farDir) + walkCtl.eyeHeight);
    walkCtl.enter(p, pos, east);
    p.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
  });
  await page.waitForTimeout(250);
  await page.keyboard.press('KeyT');
  await page.waitForTimeout(1600);
  await page.evaluate('NMS.faceShip()');
  await page.waitForTimeout(150);
  const recallCloudOrder = await page.evaluate(() => {
    const { ship, nodePipeline } = NMS._internals;
    return {
      recallInFlight: NMS.shipLandingState().recallInFlight,
      foregroundOnly: ship.foregroundOnly,
      foregroundPassEnabled: nodePipeline.foregroundPass.enabled,
      clearDepth: nodePipeline.foregroundPass.clearDepth,
      liteCloudEnabled: Boolean(nodePipeline.cloudPass?.enabled),
    };
  });
  console.log('recallCloudOrder:', JSON.stringify(recallCloudOrder));
  check(recallCloudOrder.recallInFlight
      && recallCloudOrder.foregroundOnly === true
      && recallCloudOrder.foregroundPassEnabled === true
      && recallCloudOrder.clearDepth === false,
    `recalled ship renders after LiteCloudPass with scene-depth occlusion preserved ${JSON.stringify(recallCloudOrder)}`);
  await shot('09-recall-flyin-in-front-of-clouds');

  await page.waitForFunction('!NMS.shipLandingState().recallInFlight', null, { timeout: 60000 });
  await page.evaluate('NMS.faceShip()');
  await page.waitForTimeout(350);
  const flatRecall = await page.evaluate(() => ({
    landing: NMS.shipLandingState(),
    shipView: NMS.shipViewState(),
    dist: NMS.shipDistance(),
  }));
  check(!flatRecall.landing.hoverMode
      && flatRecall.shipView.rampWalkable
      && flatRecall.landing.padGaps.every((g) => Math.abs(g) < 0.04),
    `flat clearing recall lands tripod-flush with open ramp facing player ${JSON.stringify(flatRecall)}`);
  await shot('08-recall-flat-open-ramp');
  await page.evaluate(() => NMS._planet(0).setWeatherFixture?.(null));

  // =========================================================================
  // 5. Ultra-low-altitude 3rd-person landing (~5 m AGL, nose pitched -20°):
  //    verify hull NEVER sinks underground and NEVER balloons upward!
  // =========================================================================
  await page.evaluate((dir) => {
    const THREE = NMS._THREE;
    const p = NMS._planet(0);
    const groundR = p.surfaceRadius(new THREE.Vector3(...dir));
    NMS.teleport(0, (groundR + 5.2 - p.R) / p.R, { dir, horizon: true, pitch: -0.35 });
    NMS.shipViewDebug.setViewMode('chase');
    NMS._internals.shipView.viewBlend = 0;
  }, sites.moderate.dir);
  await page.waitForTimeout(320);

  const preLandClearance = await page.evaluate(() => {
    const THREE = NMS._THREE;
    const { ship, nav } = NMS._internals;
    const p = NMS._planet(0);
    const hullLocal = p.worldPositionToLocal(nav.pos.clone().add(ship.group.position), new THREE.Vector3());
    const r = hullLocal.length();
    const dir = hullLocal.clone().multiplyScalar(1 / r);
    const bellyClearance = r - 1.05 - p.surfaceRadius(dir);
    return +bellyClearance.toFixed(3);
  });
  console.log('preLandClearance:', preLandClearance);
  check(preLandClearance >= 0.8,
    `3rd-person ground-effect keeps low-flying hull belly above ground before L (${preLandClearance} m belly clearance)`);

  // Sample hull belly clearance & 3 gear footpads on EVERY animation frame from KeyL to landed!
  const lowTracePromise = page.evaluate(() => new Promise((resolve) => {
    const THREE = NMS._THREE;
    const { ship, nav } = NMS._internals;
    const p = NMS._planet(0);
    const invFrame = p.frameOrientation.clone().invert();
    const pads = [[0, -1.60, -9.30], [2.45, -1.60, 3.60], [-2.45, -1.60, 3.60]];
    const bellySamples = [];
    const minPadSamples = [];
    const tick = () => {
      invFrame.copy(p.frameOrientation).invert();
      const worldPos = ship.landingPose ? ship.landingPose.posUniv : nav.pos.clone().add(ship.group.position);
      const worldQuat = ship.landingPose ? ship.landingPose.quat : ship.group.quaternion;
      const hullLocal = p.worldPositionToLocal(worldPos, new THREE.Vector3());
      const localQuat = invFrame.clone().multiply(worldQuat).normalize();
      const r = hullLocal.length();
      const dir = hullLocal.clone().multiplyScalar(1 / r);
      bellySamples.push(+(r - 1.05 - p.surfaceRadius(dir)).toFixed(3));

      let minPad = Infinity;
      for (let i = 0; i < pads.length; i++) {
        const [px, py, pz] = pads[i];
        const pt = new THREE.Vector3(px, py + (ship.gearOffsets?.[i] || 0), pz)
          .applyQuaternion(localQuat).add(hullLocal);
        const pr = pt.length();
        const pdir = pt.clone().multiplyScalar(1 / pr);
        minPad = Math.min(minPad, pr - p.surfaceRadius(pdir));
      }
      minPadSamples.push(+minPad.toFixed(3));

      if (NMS.state === 'landed' && bellySamples.length > 5) {
        resolve({
          count: bellySamples.length,
          bellyFirst: bellySamples[0],
          bellyMin: Math.min(...bellySamples),
          bellyMax: Math.max(...bellySamples),
          padFirst: minPadSamples[0],
          padMin: Math.min(...minPadSamples),
          padMax: Math.max(...minPadSamples),
          padLast: minPadSamples[minPadSamples.length - 1],
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));

  await page.keyboard.press('KeyL');
  await page.waitForTimeout(260);
  await shot('10-ultra-low-landing-start');
  const lowTrace = await lowTracePromise;
  console.log('lowTrace:', JSON.stringify(lowTrace));
  check(lowTrace.bellyMin >= 0.30
      && lowTrace.padMin >= -0.08
      && lowTrace.bellyMax <= lowTrace.bellyFirst + 1.2,
    `ultra-low landing never sinks into terrain or balloons upward ${JSON.stringify(lowTrace)}`);

  // Both voluntary entries must work over the same terrain that accepted a
  // normal tripod landing earlier. Only the close approach has a landing hint.
  for (const [height, key] of [[7300, 'KeyL'], [130, 'Shift+KeyL']]) {
    await page.evaluate(({ dir, height }) => {
      const p = NMS._planet(0);
      const radius = p.surfaceRadius(new NMS._THREE.Vector3(...dir));
      NMS.teleport(0, (radius + height - p.R) / p.R, { dir, horizon: true });
    }, { dir: sites.moderate.dir, height });
    await page.waitForFunction(h => Math.abs(NMS.alt() - h) < 5, height);
    if (height > 420) {
      await page.waitForFunction(() => document.getElementById('land-btn').classList.contains('hidden'));
    }
    const hoverStartMs = Date.now();
    await page.keyboard.press(key);
    if (height === 130) {
      await page.keyboard.press('KeyF');
      await page.waitForFunction('NMS.state === "shipwalk"');
      check(await page.evaluate(h => NMS.shipLandingState().hoverMode === 'high' && Math.abs(NMS.alt() - h) < 12, height),
        'stand input during hover capture carries through to the cabin at the held altitude');
      continue;
    }
    await page.waitForFunction('NMS.state === "landed"', null, { timeout: 60000 });
    const hoverElapsedMs = Date.now() - hoverStartMs;
    check(await page.evaluate(h => NMS.shipLandingState().hoverMode === 'high'
        && Math.abs(NMS.alt() - h) < 12
        && !NMS.surfaceGameplayState().campDeployed
        && NMS._internals.ship.foregroundOnly === true, height) && hoverElapsedMs < 5000,
      `voluntary hover preserves ${height} m over landable terrain without ground-camp stall (${hoverElapsedMs} ms)`);
    await page.keyboard.press('KeyV');
    await page.evaluate(() => { NMS._internals.shipView.parkedOrbitYaw = 0.8; });
    await page.keyboard.down('KeyW');
    await page.waitForFunction('NMS.state === "space"');
    await page.keyboard.up('KeyW');
    check(await page.evaluate(h => Math.abs(NMS.alt() - h) < 15
        && !NMS.shipLandingState().hoverMode
        && Math.abs(NMS._internals.shipView.parkedOrbitYaw) < 1e-4, height),
      'forward input releases high hover at the held altitude from chase/orbited view');
  }

  check(errors.length === 0, `no page errors ${JSON.stringify(errors.slice(0, 3))}`);
  check(shaderErrors.length === 0, `no shader errors ${JSON.stringify(shaderErrors.slice(0, 3))}`);
} finally {
  await browser.close();
  server.close();
}

console.log(errors.length || shaderErrors.length || failures
  ? `DONE: ${failures} check failure(s), ${errors.length} page error(s), ${shaderErrors.length} shader error(s)`
  : 'DONE - all tripod landing, skydive, parafoil and recall checks passed');
process.exit(errors.length || shaderErrors.length || failures ? 1 : 0);
