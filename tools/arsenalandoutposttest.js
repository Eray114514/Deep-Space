// End-to-end browser verification & visual capture suite for the complete
// Saltline + Golden Hour surface gameplay integration:
//  - All 6 first-person weapons (Saltline gloved hands + Golden Hour guns + L-7 sky optics)
//  - KR-7 VANTAGE live 2.5x magnified picture-in-picture scope (`surfaceScopeSample`)
//  - M12 BREACHER 9-pellet buckshot + pump rack + per-shell reload
//  - First-person explorer lower body (`FirstPersonBody`), crouch (`KeyC`), sprint-slide
//  - Frontier Survey & Habitation Outpost (Saltline props + Golden Hour furniture +
//    Voronoi destructible glass + Verlet physics props + Colonist crew + K9 unit)
//  - Throwable Frag Grenade (`KeyQ`) terrain bounce & detonation FX
//  - Active Hound & Gull robot combat encounter AI
//
// Usage:
//   node tools/arsenalandoutposttest.js [--gpu] [--out docs/reviews/saltline-golden-hour-2026-11-17]

import { mkdirSync } from 'node:fs';
import { launchBrowser, launchHardwareBrowser } from './browser.js';
import { startServer } from './server.js';

const argv = process.argv.slice(2);
const gpu = argv.includes('--gpu');
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? argv[outIdx + 1] : null;
if (out) mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures++;
};

const { server, port } = await startServer(0);
const browser = gpu ? await launchHardwareBrowser() : await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const shaderErrors = [];
page.on('pageerror', (err) => {
  console.error('[PAGEERROR]', err);
  pageErrors.push(String(err));
});
page.on('console', (msg) => {
  const txt = msg.text();
  if (msg.type() === 'error') console.error('[CONSOLE_ERROR]', txt);
  if (/WebGLProgram|shader error|INVALID_OPERATION/i.test(txt)) shaderErrors.push(txt);
});

const frames = (n = 4) => page.evaluate((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const shot = async (name) => {
  if (!out) return;
  await frames(3);
  await page.screenshot({ path: `${out}/${name}.png` });
};

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });
  await page.evaluate(() => {
    NMS.setLocalSunAltitude?.(0, 34);
    NMS.land(0);
  });
  await page.waitForFunction(() => {
    const st = NMS.surfaceWeaponState();
    return st.rendered && (st.equip === 'ready' || st.equip === 'lowered');
  }, null, { timeout: 60000 });
  await page.waitForTimeout(gpu ? 1200 : 2500);

  const wState0 = await page.evaluate(() => NMS.surfaceWeaponState());
  check(wState0.weaponCount === 6, `arsenal exposes all 6 weapons (${wState0.weaponCount})`);

  const gState0 = await page.evaluate(() => NMS.surfaceGameplayState());
  check(gState0.campDeployed && gState0.campColliders >= 10, `Frontier Camp deployed near landing pad (${gState0.campColliders} colliders, K9=${gState0.k9Deployed})`);
  check(gState0.fpBodyVisible === true, 'FirstPersonBody is active in walk mode');

  // 1. Exercise all 6 weapons: select, wait for draw -> ready, hip shot, ADS shot, fire!
  const expectedIds = ['PAC9', 'KR7', 'KR7_VANTAGE', 'VESPER9', 'M12', 'STRIX9'];
  for (let slot = 0; slot < expectedIds.length; slot++) {
    if (slot > 0) {
      await page.evaluate((s) => NMS.surfaceWeapon(s), slot);
      await page.waitForFunction((s) => NMS.surfaceWeaponState().index === s && NMS.surfaceWeaponState().equip === 'ready', slot, { timeout: 20000 });
    }
    const st = await page.evaluate(() => NMS.surfaceWeaponState());
    check(st.weaponId === expectedIds[slot] && st.rendered, `Slot ${slot + 1} (${st.weaponName}) draws to ready`);
    await shot(`weapon-${slot + 1}-${st.weaponId.toLowerCase()}-hip`);

    // Aim down sights (advance at least 8 simulation frames so ADS fully settles)
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await frames(8);
    await shot(`weapon-${slot + 1}-${st.weaponId.toLowerCase()}-ads`);

    if (st.weaponId === 'KR7_VANTAGE') {
      const scope = await page.evaluate(() => ({
        sample: NMS.surfaceScopeSample(),
        eyeBox: NMS.surfaceWeaponState().scopeEyeBox,
      }));
      check(scope.sample && scope.sample.litPixels > 16, `KR-7 VANTAGE live 2.5x scope renders planetary scene (litPixels=${scope.sample?.litPixels}, lum=${scope.sample?.luminance?.toFixed(1)}, eyeBox=${scope.eyeBox?.toFixed(2)})`);
    }

    // Fire 1 burst / shot (ensure at least 2 rendered frames see the mouse press)
    const ammoBefore = (await page.evaluate(() => NMS.surfaceWeaponState())).ammo;
    await page.mouse.down({ button: 'left' });
    await frames(3);
    await page.waitForTimeout(80);
    await page.mouse.up({ button: 'left' });
    await page.mouse.up({ button: 'right' });
    await frames(3);
    const ammoAfter = (await page.evaluate(() => NMS.surfaceWeaponState())).ammo;
    check(ammoAfter < ammoBefore, `Slot ${slot + 1} (${st.weaponId}) fires and consumes ammo (${ammoBefore} -> ${ammoAfter})`);

    if (st.weaponId === 'M12') {
      // Wait for pump cycle then verify per-shell reload
      await page.waitForTimeout(550);
      await page.evaluate(() => NMS.surfaceReload());
      await page.waitForTimeout(300);
      const rel = await page.evaluate(() => NMS.surfaceWeaponState());
      check(rel.reloading || rel.ammo === 8, `M12 Breacher per-shell reload active or refilled (ammo=${rel.ammo})`);
      await page.waitForFunction(() => !NMS.surfaceWeaponState().reloading, null, { timeout: 15000 });
    }
  }

  // Switch back to KR-7 Carbine (slot 1) for camp & combat inspection
  await page.evaluate(() => NMS.surfaceWeapon(1));
  await page.waitForFunction(() => NMS.surfaceWeaponState().index === 1 && NMS.surfaceWeaponState().equip === 'ready', null, { timeout: 15000 });

  // 2. Look down at explorer's legs & boots (FirstPersonBody) + Crouch + Sprint-Slide!
  await page.evaluate(() => {
    const ctl = NMS._internals.walkCtl;
    ctl.pitch = -1.18;
    ctl.updateQuat();
  });
  await frames(6);
  await shot('fpbody-legs-standing');

  await page.keyboard.down('KeyC');
  await page.waitForTimeout(350);
  const crouchState = await page.evaluate(() => NMS.surfaceWeaponState());
  check(crouchState.crouching && crouchState.stance === 'crouch', `KeyC crouches smoothly (stance=${crouchState.stance})`);
  await page.keyboard.up('KeyC');
  await page.waitForTimeout(250);

  // Sprint + Slide
  await page.evaluate(() => { NMS._internals.walkCtl.pitch = -0.12; NMS._internals.walkCtl.updateQuat(); });
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(450);
  await page.keyboard.down('KeyC');
  await page.waitForTimeout(120);
  const slideState = await page.evaluate(() => NMS.surfaceWeaponState());
  check(slideState.sliding && slideState.stance === 'slide', `Shift+W+C triggers tactical sprint-slide (stance=${slideState.stance})`);
  await shot('movement-sprint-slide');
  await page.keyboard.up('KeyC');
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(350);

  // 3. Walk up to the Frontier Outpost Camp, inspect props/furniture/K9/Colonists & shoot Voronoi glass!
  await page.evaluate(() => {
    const { walkCtl, surfaceGameplay } = NMS._internals;
    const p = walkCtl.planet;
    const [e, n, f] = surfaceGameplay.campAxes;
    const standPos = surfaceGameplay.campOriginLocal.clone()
      .addScaledVector(f, 15.5)
      .addScaledVector(e, -2.5);
    const dir = standPos.clone().normalize();
    standPos.copy(dir).multiplyScalar(p.R + p.height(dir, p.fullMaxFreq) + walkCtl.standEyeHeight);
    const lookDir = surfaceGameplay.campOriginLocal.clone().sub(standPos).normalize();
    walkCtl.enter(p, standPos, lookDir);
  });
  await page.waitForTimeout(gpu ? 500 : 900);
  await frames(6);
  await shot('outpost-camp-exterior');

  // Aim directly at the front-left Voronoi glass window and fire!
  const glassShot = await page.evaluate(() => {
    const { walkCtl, surfaceGameplay, camera, nav } = NMS._internals;
    const winWorld = surfaceGameplay.campToWorldPoint(new NMS._THREE.Vector3(-3.9, 1.85, 4.0));
    const eye = camera.getWorldPosition(new NMS._THREE.Vector3());
    const dir = winWorld.clone().sub(eye).normalize();
    let panesBrokenBefore = 0;
    for (const pane of surfaceGameplay.destructibles.panes) if (pane.broken || pane.cracked) panesBrokenBefore++;
    for (let i = 0; i < 3; i++) {
      surfaceGameplay.resolveShot(eye, dir, {
        planet: walkCtl.planet,
        navPos: nav.pos,
        damage: 34,
        impulse: 8,
        maxRange: 120,
      });
    }
    let panesDamagedAfter = 0;
    for (const pane of surfaceGameplay.destructibles.panes) {
      if (pane.shattered || pane.cracks > 0 || pane.hp < 30 || pane.holes?.length) panesDamagedAfter++;
    }
    return { panesBrokenBefore, panesDamagedAfter, activeShards: surfaceGameplay.destructibles.active };
  });
  check(glassShot.panesDamagedAfter > 0 || glassShot.activeShards > 0,
    `Voronoi glass window fractures/shatters on gunfire (${JSON.stringify(glassShot)})`);
  await page.waitForTimeout(220);
  await shot('outpost-glass-shatter');

  // 4. Throw a Frag Grenade (`NMS.throwGrenade()`) and capture detonation!
  const grenBefore = (await page.evaluate(() => NMS.surfaceGameplayState())).grenades;
  const threw = await page.evaluate(() => NMS.throwGrenade());
  const grenMid = await page.evaluate(() => NMS.surfaceGameplayState());
  check(threw && grenMid.grenades === grenBefore - 1 && grenMid.liveGrenades === 1,
    `Frag grenade thrown cleanly (supply ${grenBefore} -> ${grenMid.grenades})`);
  await page.waitForFunction(() => NMS.surfaceGameplayState().liveGrenades === 0, null, { timeout: 25000 });
  await frames(2);
  await shot('grenade-explosion-fx');
  const grenAfter = await page.evaluate(() => NMS.surfaceGameplayState());
  check(grenAfter.liveGrenades === 0, 'Frag grenade detonates after fuse and clears live list');

  // 5. Spawn active Hound + Gull robot combat encounter & verify weakpoint/armor hit + AI!
  const spawned = await page.evaluate(() => NMS.spawnCombatEncounter({ hounds: 2, gulls: 2, passive: false }));
  check(spawned === 4, `spawnCombatEncounter deploys 2 hounds + 2 gulls (${spawned})`);
  await frames(10);
  const combatHit = await page.evaluate(() => {
    const { surfaceGameplay, camera, walkCtl, nav } = NMS._internals;
    const robots = surfaceGameplay.outpostRobots;
    const eye = camera.getWorldPosition(new NMS._THREE.Vector3());
    // Pick a spawned combat robot with an unobstructed sightline from eye (e.g. hovering Gull or visible Hound)
    let chosen = null;
    let aimDir = null;
    for (const u of robots.units) {
      if (!u.alive) continue;
      const aimLocal = u.headPos ? u.headPos.clone() : u.pos.clone();
      const targetWorld = robots.localToWorldPoint(aimLocal, new NMS._THREE.Vector3());
      const dir = targetWorld.clone().sub(eye).normalize();
      const rHit = robots.raycastWorld(eye, dir, 180);
      if (rHit && rHit.enemy === u) {
        chosen = u;
        aimDir = dir;
        break;
      }
    }
    if (!chosen || !aimDir) return null;
    // Shoot from just in front of any camp prop if standing next to sandbags, or directly from eye
    const hpBefore = chosen.hp;
    const shotOrigin = robots.localToWorldPoint(chosen.pos.clone(), new NMS._THREE.Vector3())
      .addScaledVector(aimDir, -3.5);
    const shotDir = robots.localToWorldPoint(chosen.headPos ? chosen.headPos.clone() : chosen.pos.clone(), new NMS._THREE.Vector3())
      .sub(shotOrigin).normalize();
    surfaceGameplay.resolveShot(shotOrigin, shotDir, {
      planet: walkCtl.planet,
      navPos: nav.pos,
      damage: 35,
      impulse: 7,
      maxRange: 180,
    });
    return { type: chosen.type, mode: chosen.mode, hpBefore, hpAfter: chosen.hp };
  });
  check(Boolean(combatHit && combatHit.hpAfter < combatHit.hpBefore),
    `Surface shot damages active combat robot (${JSON.stringify(combatHit)})`);
  await frames(5);
  await shot('outpost-robot-combat');

  check(pageErrors.length === 0, `zero page errors (${pageErrors.slice(0, 2).join('; ')})`);
  check(shaderErrors.length === 0, `zero WebGL shader errors (${shaderErrors.slice(0, 2).join('; ')})`);
} finally {
  await browser.close();
  server.close();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('arsenal & outpost E2E: ALL CHECKS PASSED');
