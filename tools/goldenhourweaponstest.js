// Pure-Node verification suite for the shared Saltline viewmodel kit and the
// ported Golden Hour weapon arsenal, frag grenade, and 48 kHz stereo weapon SFX:
//   node tools/goldenhourweaponstest.js
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  SHARED_LENS_SUN,
  SHARED_LENS_SKY,
  SHARED_RAIN_WETNESS,
  setLensEnvironment,
  buildHand,
  buildOpticLens,
  buildMagnifiedScopeDisplay,
  rectWindowPoly,
} from '../src/saltline/viewmodel-kit.js';
import {
  buildGoldenHourGun,
  buildFragGrenade,
  GH_WEAPON_SPECS,
  GH_ATTACHMENTS,
  GH_CAMOS,
} from '../src/golden-hour/weapons-engine.js';
import {
  createKr7CarbineViewmodel,
  createKr7VantageViewmodel,
  createVesper9Viewmodel,
  createM12BreacherViewmodel,
  createStrix9Viewmodel,
  KR7_SPEC,
  KR7_VANTAGE_SPEC,
  VESPER9_SPEC,
  M12_SPEC,
  STRIX9_SPEC,
  GOLDEN_HOUR_WEAPONS,
} from '../src/golden-hour/viewmodels.js';
import {
  GH_SOUND_TABLE,
  renderGoldenHourSound,
} from '../src/golden-hour/weapon-sfx.js';
import { SurfaceWeapons } from '../src/surface-weapons.js';

let passed = 0;
let failed = 0;

function check(ok, msg) {
  if (ok) {
    passed++;
    console.log(`PASS: ${msg}`);
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function assertFiniteGeometryAndHands(root, label, { requireHands = true } = {}) {
  let meshCount = 0;
  let skinnedCount = 0;
  let boneCount = 0;
  let nonFiniteVerts = 0;
  let rightGloveFound = false;
  let triggerFingerFound = false;
  let leftGloveFound = false;

  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (obj.isSkinnedMesh) skinnedCount++;
    if (obj.isBone) boneCount++;
    if (obj.name === 'saltline-right-glove') rightGloveFound = true;
    if (obj.name === 'saltline-trigger-finger') triggerFingerFound = true;
    if (obj.name === 'saltline-left-glove') leftGloveFound = true;
    if (obj.isMesh && obj.geometry) {
      meshCount++;
      for (const attrName of ['position', 'normal']) {
        const attr = obj.geometry.attributes[attrName];
        if (!attr) continue;
        const arr = attr.array;
        for (let i = 0; i < arr.length; i++) {
          if (!Number.isFinite(arr[i])) nonFiniteVerts++;
        }
      }
    }
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const finiteBox = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite)
    && size.length() > 0.05 && size.length() < 5;

  check(meshCount > 0 && nonFiniteVerts === 0 && finiteBox, `${label}: finite non-NaN geometry bounds (${meshCount} meshes, size ${size.toArray().map((v) => v.toFixed(3)).join('x')}m)`);
  check(skinnedCount === 0 && boneCount === 0, `${label}: zero Golden Hour SkinnedMesh/Bone rig remnants`);
  if (requireHands) {
    check(rightGloveFound && triggerFingerFound && leftGloveFound, `${label}: uses Saltline articulated gloved right+left hands with morphing trigger finger`);
  }
}

function makeTestContext() {
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 2000);
  camera.position.set(0, 1.7, 0);
  camera.updateMatrixWorld(true);
  const viewCamera = new THREE.PerspectiveCamera(54, 16 / 9, 0.01, 50);
  camera.add(viewCamera);
  viewCamera.updateMatrixWorld(true);

  let seed = 1337;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  const log = { events: [], shots: 0, tracers: 0, shells: 0, recoilPitch: 0, recoilYaw: 0 };
  return {
    log,
    ctx: {
      camera,
      viewCamera,
      rng,
      emit: (type, data) => log.events.push({ type, data }),
      shot: (eye, dir) => {
        log.shots++;
        return eye.clone().addScaledVector(dir, 50);
      },
      tracer: () => { log.tracers++; },
      shell: () => { log.shells++; },
      recoil: (p, y) => { log.recoilPitch += p; log.recoilYaw += y; },
    },
  };
}

function stepSeconds(vm, seconds, input = {}, dt = 1 / 120) {
  const steps = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < steps; i++) vm.update(dt, input);
}

// ----------------------------------------------------------------------------
// 1. Shared Saltline Viewmodel Kit & Lens Environment / Wetness Shader Checks
// ----------------------------------------------------------------------------
console.log('\n--- 1. Saltline Viewmodel Kit ---');
{
  const hand = buildHand({
    mirror: false,
    fingers: [[0.2, 0.3, 0.2, 0], [0.6, 1.5, 0.8, 0], [0.65, 1.5, 0.8, 0], [0.7, 1.5, 0.8, 0]],
    thumb: [[-0.5, -0.2, -0.8], [-0.3, -0.2, -0.9], [0, -0.1, -1]],
    forearm: [0.2, -0.4, 0.88],
  });
  check(hand.fabric.attributes.position.count > 1000, `buildHand produces detailed gloved geometry (${hand.fabric.attributes.position.count} verts)`);

  const holoLens = buildOpticLens(rectWindowPoly(0, 0.038, 0.029, 0.021), 0.001, { reticle: 'holo' });
  setLensEnvironment({
    sunDir: [0.2, 0.8, 0.5],
    sunColor: [1.0, 0.92, 0.78],
    skyZenith: [0.08, 0.18, 0.42],
    skyHorizon: [0.85, 0.58, 0.36],
    skyHorizonAway: [0.18, 0.26, 0.38],
    worldUp: [0, 1, 0],
  });
  check(
    holoLens.material.uniforms.uSun.value === SHARED_LENS_SUN.dir
      && Math.abs(SHARED_LENS_SKY.zenith.b - 0.42) < 1e-6,
    'setLensEnvironment updates SHARED_LENS_SUN and SHARED_LENS_SKY live on optic lenses'
  );

  const scope = buildMagnifiedScopeDisplay({ radius: 0.015, z: 0.04 });
  check(
    scope.opticGlass.isMesh && scope.objective.isObject3D
      && 'tScope' in scope.opticGlass.material.uniforms
      && 'eyeBox' in scope.opticGlass.material.uniforms
      && 'ads' in scope.opticGlass.material.uniforms,
    'buildMagnifiedScopeDisplay exposes opticGlass (tScope, eyeBox, ads) + objective Object3D'
  );
}

// ----------------------------------------------------------------------------
// 2. Golden Hour Weapons Engine & Frag Grenade
// ----------------------------------------------------------------------------
console.log('\n--- 2. Golden Hour Weapons Engine & Frag Grenade ---');
{
  check(Object.keys(GH_WEAPON_SPECS).length === 4 && Object.keys(GH_ATTACHMENTS).length === 5 && GH_CAMOS.length >= 8,
    `GH_WEAPON_SPECS (4), GH_ATTACHMENTS (5 slots), GH_CAMOS (${GH_CAMOS.length} finishes) exported`);

  const frag = buildFragGrenade();
  check(frag.tris > 2000, `buildFragGrenade() has >2,000 triangles (${frag.tris} tris)`);
  assertFiniteGeometryAndHands(frag.root, 'Frag Grenade', { requireHands: false });

  // Verify camo + detail wetness onBeforeCompile shader chain compiles clean GLSL hooks
  const damascusAr = buildGoldenHourGun('ar', { camo: 'damascus', optic: 'irons', muzzle: 'brake', underbarrel: 'angled' });
  let wetShaderVerified = false;
  damascusAr.root.traverse((obj) => {
    if (wetShaderVerified || !obj.isMesh || !obj.material?.onBeforeCompile) return;
    if (!obj.material.userData?._vmDetailPatched) return;
    const mockShader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    obj.material.onBeforeCompile(mockShader, {});
    if (mockShader.uniforms.uRain && mockShader.fragmentShader.includes('vmDrops') && mockShader.fragmentShader.includes('vmBump')) {
      wetShaderVerified = true;
    }
  });
  check(damascusAr.tris > 2000 && wetShaderVerified, `Camo + rain-bead wetness shader chains cleanly (${damascusAr.tris} tris)`);
}

// ----------------------------------------------------------------------------
// 3. Full Lifecycle Verification Across All 5 Weapon Viewmodels
// ----------------------------------------------------------------------------
console.log('\n--- 3. All 5 First-Person Weapon Viewmodels ---');

const WEAPON_CASES = [
  { spec: KR7_SPEC, create: createKr7CarbineViewmodel, expectedMag: 30 },
  { spec: KR7_VANTAGE_SPEC, create: createKr7VantageViewmodel, expectedMag: 20 },
  { spec: VESPER9_SPEC, create: createVesper9Viewmodel, expectedMag: 36 },
  { spec: M12_SPEC, create: createM12BreacherViewmodel, expectedMag: 8 },
  { spec: STRIX9_SPEC, create: createStrix9Viewmodel, expectedMag: 18 },
];

check(GOLDEN_HOUR_WEAPONS.length === 5, 'GOLDEN_HOUR_WEAPONS exports all 5 weapon descriptors');

for (const { spec, create, expectedMag } of WEAPON_CASES) {
  const { ctx, log } = makeTestContext();
  const vm = create(ctx);
  vm.root.visible = true;

  check(
    vm.name === spec.name && vm.magSize === expectedMag && vm.ammo === expectedMag && vm.info.tris > 2000,
    `${vm.name}: constructs with ${vm.info.tris} tris (>2,000) and ${vm.magSize}-rd capacity`
  );
  check(
    Array.isArray(spec.eject) && spec.eject.length === 3 && Number.isFinite(spec.viewFov) && Number.isFinite(spec.adsFov),
    `${vm.name}: descriptor exports viewFov=${spec.viewFov}, adsFov=${spec.adsFov}, eject=${JSON.stringify(spec.eject)}`
  );
  assertFiniteGeometryAndHands(vm.root, vm.name);

  // Draw -> ready
  check(vm.isHolstered() && vm.equipState() === 'holstered', `${vm.name}: starts holstered`);
  const drew = vm.draw();
  check(drew && vm.equipState() === 'drawing', `${vm.name}: draw() enters drawing state`);
  stepSeconds(vm, 1.15, {});
  check(vm.equipState() === 'ready' && !vm.isHolstered(), `${vm.name}: update() advances draw to 'ready'`);

  // ADS
  const hipSpread = vm.spread;
  stepSeconds(vm, 0.35, { ads: true });
  check(vm.ads > 0.98 && vm.spread < hipSpread, `${vm.name}: ADS blends to ${vm.ads.toFixed(2)} and tightens spread (${hipSpread.toFixed(4)} -> ${vm.spread.toFixed(4)})`);

  // Fire
  const ammoBefore = vm.ammo;
  stepSeconds(vm, 0.16, { ads: true, fire: true });
  stepSeconds(vm, 0.6, { ads: false, fire: false }); // allow pump/bolt to settle
  check(vm.ammo < ammoBefore && log.shots > 0 && log.tracers > 0, `${vm.name}: firing consumes ammo (${ammoBefore} -> ${vm.ammo}) and emits shots/tracers`);

  // Tactical reload (magazine / shell carrier moves > 3 cm!)
  const magHome = vm.magazine.position.clone();
  const startedTac = vm.reloadNow();
  check(startedTac && vm.isReloading(), `${vm.name}: tactical reloadNow() starts`);
  let maxMagTravel = 0;
  for (let i = 0; i < 420 && vm.isReloading(); i++) {
    vm.update(1 / 120, {});
    const d = vm.magazine.position.distanceTo(magHome);
    if (d > maxMagTravel) maxMagTravel = d;
  }
  // Finish remaining shells if M12 needed >3.5s
  let guard = 0;
  while (vm.isReloading() && guard++ < 600) {
    vm.update(1 / 120, {});
    const d = vm.magazine.position.distanceTo(magHome);
    if (d > maxMagTravel) maxMagTravel = d;
  }
  check(
    !vm.isReloading() && vm.ammo === vm.magSize && maxMagTravel > 0.03,
    `${vm.name}: tactical reload refills to ${vm.ammo}/${vm.magSize} with ${(maxMagTravel * 100).toFixed(1)} cm (>3 cm) mag/shell travel`
  );

  // Wetness & Holster
  vm.setWetness(0.8);
  check(Math.abs(SHARED_RAIN_WETNESS.value - 0.8) < 1e-6, `${vm.name}: setWetness(0.8) updates wetness uniform`);
  const holstering = vm.holster();
  check(holstering && vm.isHolstering(), `${vm.name}: holster() starts holstering`);
  stepSeconds(vm, 0.55, {});
  check(vm.isHolstered() && vm.equipState() === 'holstered', `${vm.name}: holster completes to 'holstered'`);
}

// ----------------------------------------------------------------------------
// 4. Weapon-Specific Deep Mechanics (KR-7 Vantage Scope, M12 Shotgun, Strix 9, Empty Reloads)
// ----------------------------------------------------------------------------
console.log('\n--- 4. Weapon-Specific Mechanics ---');

// 4a. KR-7 VANTAGE Scope Contract + SurfaceWeapons.renderScopeView integration
{
  const { ctx } = makeTestContext();
  const vantage = createKr7VantageViewmodel(ctx);
  vantage.root.visible = true;
  vantage.draw();
  stepSeconds(vantage, 1.1, {});

  check(
    KR7_VANTAGE_SPEC.hasScope === true
      && vantage.opticGlass?.isMesh
      && vantage.objective?.isObject3D,
    'KR-7 VANTAGE: exposes hasScope=true, ocular opticGlass Mesh, and front objective Object3D'
  );

  // Verify objective points forward (-Z in gun space, in front of ocular)
  vantage.root.updateMatrixWorld(true);
  const ocularWorld = vantage.opticGlass.getWorldPosition(new THREE.Vector3());
  const objectiveWorld = vantage.objective.getWorldPosition(new THREE.Vector3());
  check(objectiveWorld.z < ocularWorld.z - 0.08, `KR-7 VANTAGE: objective sits ${((ocularWorld.z - objectiveWorld.z) * 100).toFixed(1)} cm forward of ocular lens`);

  // Verify eye-box shadow & live ADS scope uniforms + SurfaceWeapons.renderScopeView compatibility
  const scopeTarget = new THREE.WebGLRenderTarget(256, 256);
  vantage.opticGlass.material.map = scopeTarget.texture;
  check(
    vantage.opticGlass.material.map === scopeTarget.texture
      && vantage.opticGlass.material.uniforms.tScope.value === scopeTarget.texture,
    'KR-7 VANTAGE: opticGlass.material.map syncs bidirectionally with uniforms.tScope.value'
  );

  stepSeconds(vantage, 0.35, { ads: true });
  const steadyEyeBox = vantage.opticGlass.material.uniforms.eyeBox.value;
  vantage.update(1 / 60, { ads: true, look: { dx: 0.16, dy: -0.12 } });
  const offAxisEyeBox = vantage.opticGlass.material.uniforms.eyeBox.value;
  check(
    steadyEyeBox > 0.95 && offAxisEyeBox < steadyEyeBox,
    `KR-7 VANTAGE: physical eyeBox opens at full ADS (${steadyEyeBox.toFixed(3)}) and vignettes off-axis (${offAxisEyeBox.toFixed(3)})`
  );

  // Exercise actual SurfaceWeapons.prototype.renderScopeView against KR-7 VANTAGE!
  let renderedScopeScene = 0;
  const mockRenderer = {
    target: null,
    getRenderTarget() { return this.target; },
    getActiveCubeFace() { return 0; },
    getActiveMipmapLevel() { return 0; },
    setRenderTarget(t) { this.target = t; },
    clear() {},
    render() { renderedScopeScene++; },
  };
  const swHarness = {
    index: 0,
    rig: new THREE.Group(),
    scene: new THREE.Scene(),
    camera: ctx.camera,
    scopeCamera: new THREE.PerspectiveCamera(4.2, 1, 0.01, 2000),
    scopeTarget,
    models: [{
      group: vantage.root,
      hasScope: true,
      opticGlass: vantage.opticGlass,
      objective: vantage.objectiveOffset,
    }],
  };
  swHarness.rig.visible = true;
  SurfaceWeapons.prototype.renderScopeView.call(swHarness, mockRenderer);
  check(renderedScopeScene === 1 && mockRenderer.target === null, 'KR-7 VANTAGE: passes SurfaceWeapons.renderScopeView guard and restores render target');
  scopeTarget.dispose();
}

// 4b. M12 BREACHER: 9-pellet buckshot + pump cycle + per-shell reload + fire interruption + empty rack
{
  const { ctx, log } = makeTestContext();
  const m12 = createM12BreacherViewmodel(ctx);
  m12.root.visible = true;
  m12.draw();
  stepSeconds(m12, 1.05, {});
  log.events.length = 0;
  log.shots = 0;
  log.tracers = 0;
  log.shells = 0;

  // Fire 1 shell -> 9 pellets, 1 weapon:fire event
  m12.update(1 / 60, { fire: true });
  const fireEvents = log.events.filter((e) => e.type === 'weapon:fire');
  check(
    m12.ammo === 7 && log.shots === 9 && log.tracers === 9 && fireEvents.length === 1,
    `M12 BREACHER: single trigger pull fires 9 pellets (${log.shots} shots, ${log.tracers} tracers, ${fireEvents.length} fire event)`
  );

  // Advance through pump-action cycle (~0.18s..0.52s)
  let maxPumpSlide = 0;
  const pumpRestZ = m12.parts.pump.userData.rest.z;
  for (let i = 0; i < 70; i++) {
    m12.update(1 / 120, { fire: false });
    maxPumpSlide = Math.max(maxPumpSlide, m12.parts.pump.position.z - pumpRestZ);
  }
  const pumpPhases = log.events.filter((e) => e.type === 'weapon:pump').map((e) => e.data.phase);
  check(
    maxPumpSlide > 0.07 && pumpPhases.includes('back') && pumpPhases.includes('fwd') && log.shells === 1,
    `M12 BREACHER: pump-action slides ${(maxPumpSlide * 100).toFixed(1)} cm, emits ${JSON.stringify(pumpPhases)}, and ejects spent hull`
  );

  // Fire 3 more shells down to ammo = 4, then test per-shell reload + fire-interruption!
  for (let k = 0; k < 3; k++) {
    stepSeconds(m12, 0.35, { fire: false });
    m12.update(1 / 60, { fire: true });
    stepSeconds(m12, 0.6, { fire: false });
  }
  assert.equal(m12.ammo, 4);
  log.events.length = 0;
  m12.reloadNow();
  // Step long enough to seat 2 shells (ammo 4 -> 6), still reloading (needs 8)
  while (m12.isReloading() && m12.ammo < 6) {
    m12.update(1 / 120, { fire: false });
  }
  const shellEvents = log.events.filter((e) => e.type === 'weapon:reload' && e.data.phase === 'shell');
  check(m12.isReloading() && m12.ammo === 6 && shellEvents.length === 2, 'M12 BREACHER: per-shell reload inserts shells one by one');

  // Pull trigger mid-reload -> immediately aborts reload and fires!
  const shotsBeforeInterrupt = log.shots;
  m12.update(1 / 60, { fire: true });
  check(
    !m12.isReloading() && m12.ammo === 5 && log.shots === shotsBeforeInterrupt + 9,
    'M12 BREACHER: pulling fire during reload with ammo > 0 cleanly interrupts reload and fires immediately'
  );

  // Empty all remaining shells and verify empty reload ends with pump rack!
  while (m12.ammo > 0) {
    stepSeconds(m12, 0.85, { fire: false });
    m12.update(1 / 60, { fire: true });
  }
  stepSeconds(m12, 0.65, { fire: false });
  assert.equal(m12.ammo, 0);
  log.events.length = 0;
  check(m12.reloadNow(), 'M12 BREACHER: starts empty 8-shell reload');
  stepSeconds(m12, 5.0, { fire: false });
  const emptyPumps = log.events.filter((e) => e.type === 'weapon:pump').map((e) => e.data.phase);
  check(
    !m12.isReloading() && m12.ammo === 8 && emptyPumps.includes('back') && emptyPumps.includes('fwd'),
    `M12 BREACHER: empty reload loads 8/8 shells and finishes with pump rack (${JSON.stringify(emptyPumps)})`
  );
}

// 4c. STRIX 9: 0.48s fast draw + slide lock on empty + slide-stop release on empty reload
{
  const { ctx, log } = makeTestContext();
  const strix = createStrix9Viewmodel(ctx);
  strix.root.visible = true;
  strix.draw();
  stepSeconds(strix, 0.50, {});
  check(strix.equipState() === 'ready', 'STRIX 9: fast 0.48s overhand-rack draw completes within 0.50s');

  // Empty all 18 rounds
  for (let i = 0; i < 18; i++) {
    strix.update(1 / 60, { fire: true });
    strix.update(1 / 60, { fire: false });
    stepSeconds(strix, 0.16, { fire: false });
  }
  const slideRestZ = strix.parts.slide.userData.rest.z;
  const lockedDisp = strix.parts.slide.position.z - slideRestZ;
  check(
    strix.ammo === 0 && strix.isSlideLocked() && lockedDisp > 0.035 && strix.parts.slideStop.rotation.x < -0.05,
    `STRIX 9: slide locks rearward on empty (${(lockedDisp * 1000).toFixed(1)} mm travel, slideStop engaged)`
  );

  // Empty reload releases slide lock
  log.events.length = 0;
  check(strix.reloadNow(), 'STRIX 9: starts empty reload');
  stepSeconds(strix, 1.9, {});
  const boltReleased = log.events.some((e) => e.type === 'weapon:reload' && e.data.phase === 'bolt');
  const batteryDisp = Math.abs(strix.parts.slide.position.z - slideRestZ);
  check(
    !strix.isReloading() && strix.ammo === 18 && !strix.isSlideLocked() && boltReleased && batteryDisp < 1e-3,
    'STRIX 9: empty reload swaps 18-rd mag and slams slide-stop to return slide to battery'
  );
}

// 4d. Empty reload bolt/HK-slap verification on KR-7 CARBINE & VESPER 9
for (const [label, factory] of [['KR-7 CARBINE', createKr7CarbineViewmodel], ['VESPER 9', createVesper9Viewmodel]]) {
  const { ctx, log } = makeTestContext();
  const vm = factory(ctx);
  vm.root.visible = true;
  vm.draw();
  stepSeconds(vm, 1.05, {});
  while (vm.ammo > 0) stepSeconds(vm, 0.1, { fire: true });
  stepSeconds(vm, 0.1, { fire: false });
  log.events.length = 0;
  check(vm.reloadNow(), `${label}: starts empty reload from 0 ammo`);
  stepSeconds(vm, 2.8, { fire: false });
  const phases = log.events.filter((e) => e.type === 'weapon:reload').map((e) => e.data.phase);
  check(
    !vm.isReloading() && vm.ammo === vm.magSize && phases.includes('magout') && phases.includes('magin') && phases.includes('bolt') && phases.includes('done'),
    `${label}: empty reload executes ${JSON.stringify(phases)} and refills ${vm.ammo}/${vm.magSize}`
  );
}

// ----------------------------------------------------------------------------
// 5. Golden Hour Synthesized Stereo 48 kHz Weapon Audio (`GH_SOUND_TABLE`)
// ----------------------------------------------------------------------------
console.log('\n--- 5. Golden Hour Synthesized Weapon Audio ---');

const EXPECTED_SOUNDS = [
  'kr7_shot',
  'suppressed_shot',
  'vesper_shot',
  'shotgun_shot',
  'shotgun_pump_back',
  'shotgun_pump_fwd',
  'shotgun_shell',
  'pistol_shot',
  'pistol_slide',
  'grenade_pin',
  'grenade_bounce',
  'grenade_explode',
  'bullet_impact_rock',
  'bullet_impact_metal',
  'bullet_ricochet',
  'glass_crack',
  'glass_shatter',
  'hitmarker',
];

for (const soundName of EXPECTED_SOUNDS) {
  const rendered = renderGoldenHourSound(soundName, 0);
  const renderedV1 = renderGoldenHourSound(soundName, 1);
  const validStruct = Boolean(
    rendered
      && rendered.sr === 48000
      && Array.isArray(rendered.ch)
      && rendered.ch.length === 2
      && rendered.ch[0] instanceof Float32Array
      && rendered.ch[1] instanceof Float32Array
      && rendered.ch[0].length === rendered.ch[1].length
      && rendered.ch[0].length > 1000
      && renderedV1
  );

  let nonFinite = 0;
  let peak = 0;
  let sumL = 0;
  let sumR = 0;
  if (validStruct) {
    const [L, R] = rendered.ch;
    for (let i = 0; i < L.length; i++) {
      const l = L[i], r = R[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite++;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      sumL += l * l;
      sumR += r * r;
    }
  }
  const len = validStruct ? rendered.ch[0].length : 1;
  const rmsL = Math.sqrt(sumL / len);
  const rmsR = Math.sqrt(sumR / len);

  check(
    validStruct && nonFinite === 0 && rmsL > 0.004 && rmsR > 0.004 && peak > 0.1 && peak <= 1.000001,
    `SFX ${soundName}: 48 kHz stereo (${(len / 48000).toFixed(2)}s), rmsL=${rmsL.toFixed(3)}, rmsR=${rmsR.toFixed(3)}, peak=${peak.toFixed(3)} <= 1.0`
  );
}

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
