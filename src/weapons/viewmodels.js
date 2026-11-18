// First-person viewmodel controllers for the modular surface arsenal,
// combining procedural receivers/parts/attachments/camos (`./weapons-engine.js`)
// with articulated gloved hands, optic shaders, magnified scope display, and
// 9-spring weapon dynamics (`./viewmodel-kit.js`).
import * as THREE from 'three';
import {
  SHARED_RAIN_WETNESS,
  VIEWMODEL_BASE_COLOURS,
  applyDetailShader,
  createRightHandRig,
  createLeftHandRig,
  dirInFrame,
  buildMuzzleFlash,
  buildOpticLens,
  buildMagnifiedScopeDisplay,
  rectWindowPoly,
  spring,
  stepSpring,
  smootherstep,
  smoothstep,
  damp,
  clamp,
  lerp,
  saturate,
  quatEuler,
  countObjectTriangles,
} from './viewmodel-kit.js';
import { buildProceduralWeapon } from './weapons-engine.js';

const Vec3 = THREE.Vector3;
const Quaternion = THREE.Quaternion;

const SPRINGS = ['kZ', 'kP', 'kY', 'kR', 'swY', 'swP', 'jY', 'jP', 'bump'];

// ---------------------------------------------------- shared tactical helpers

function buildTacticalLaser(originVec, { color = 0x38ff7a, length = 2.6 } = {}) {
  const group = new THREE.Group();
  group.name = 'tactical-laser';
  group.position.copy(originVec);
  group.visible = false;

  const beamGeo = new THREE.PlaneGeometry(0.0036, length);
  beamGeo.rotateX(Math.PI / 2);
  beamGeo.translate(0, 0, -length * 0.5);
  const crossGeo = beamGeo.clone();
  crossGeo.rotateZ(Math.PI / 2);

  const beamMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uAlpha: { value: 0.52 },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uAlpha;
      void main(){
        #include <logdepthbuf_fragment>
        float core = exp(-pow((vUv.x - 0.5) * 5.2, 2.0));
        float fade = smoothstep(0.0, 0.03, 1.0 - vUv.y) * exp(-(1.0 - vUv.y) * 3.4);
        vec3 col = uColor * core * fade * uAlpha * 2.4;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  const b1 = new THREE.Mesh(beamGeo, beamMat);
  const b2 = new THREE.Mesh(crossGeo, beamMat);
  b1.frustumCulled = false;
  b2.frustumCulled = false;
  b1.renderOrder = 8;
  b2.renderOrder = 8;

  const dotGeo = new THREE.CircleGeometry(0.0022, 12);
  dotGeo.translate(0, 0, -0.002);
  const dotMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const emitterDot = new THREE.Mesh(dotGeo, dotMat);
  emitterDot.frustumCulled = false;
  emitterDot.renderOrder = 9;

  group.add(b1, b2, emitterDot);
  return {
    group,
    setIntensity(v) {
      const a = clamp(v, 0, 1);
      beamMat.uniforms.uAlpha.value = 0.52 * a;
      dotMat.opacity = 0.95 * a;
      group.visible = a > 0.02;
    },
  };
}

function upgradeAttachmentOptic(gun, { reticle = 'dot', color = [1, 0.16, 0.08] } = {}) {
  const optic = gun.attachments?.optic;
  if (!optic?.group) return null;
  const oldLens = optic.group.getObjectByName('lens');
  if (oldLens) oldLens.visible = false;

  let cy = 0.0345, w = 0.0336, h = 0.0236, rc = 0.0038, zPos = -0.0175;
  if (optic.kind === 'holo') {
    cy = 0.038; w = 0.0292; h = 0.0214; rc = 0.0014; zPos = 0.001;
  } else if (optic.kind === 'microdot') {
    cy = 0.0173; w = 0.0206; h = 0.0132; rc = 0.0018; zPos = -0.0144;
  }
  const lens = buildOpticLens(rectWindowPoly(0, cy, w, h, rc), zPos, { reticle, color });
  optic.group.add(lens);
  return lens;
}

function upgradePrismScope(gun, { reticleColor = [1, 0.22, 0.12] } = {}) {
  const optic = gun.attachments?.optic;
  if (!optic?.group) return null;
  const oldLens = optic.group.getObjectByName('lens');
  if (oldLens) oldLens.visible = false;

  // Front coated objective cap so viewing the rifle externally still shows dark optics
  const frontCapGeo = new THREE.CircleGeometry(0.0146, 32);
  frontCapGeo.rotateY(Math.PI);
  frontCapGeo.translate(0, 0.04, -0.0445);
  const frontCapMat = new THREE.MeshStandardMaterial({
    color: 0x0b1d19,
    roughness: 0.08,
    metalness: 0.85,
  });
  const frontCap = new THREE.Mesh(frontCapGeo, frontCapMat);
  frontCap.name = 'scope-objective-cap';
  frontCap.frustumCulled = false;
  optic.group.add(frontCap);

  const scope = buildMagnifiedScopeDisplay({
    radius: 0.0136,
    y: 0.04,
    z: 0.0472,
    objectiveY: 0.04,
    objectiveZ: -0.054,
    reticleColor,
  });
  optic.group.add(scope.opticGlass, scope.objective);
  return scope;
}

function makeKeyHelpers(defaultAnchor = new Vec3(0, -0.015, -0.055)) {
  const key = (q, p, anchor = defaultAnchor) => ({
    q: q.clone(),
    p: new Vec3(p[0], p[1], p[2]).sub(anchor.clone().applyQuaternion(q)),
  });
  const offset = (k, dx, dy, dz, q = null) => ({
    q: q ? q.clone() : k.q.clone(),
    p: k.p.clone().add(new Vec3(dx, dy, dz)),
  });
  const sample = (keys, t, outPos, outQ) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const a = keys[i], b = keys[i + 1];
    const w = smootherstep((t - a[0]) / Math.max(1e-4, b[0] - a[0]));
    outPos.copy(a[1].p).lerp(b[1].p, w);
    outQ.copy(a[1].q).slerp(b[1].q, w);
  };
  return { key, offset, sample };
}

function makeGloveMaterial(ctx, wetUniform) {
  const custom = ctx?.material?.('glove_fabric');
  if (custom) return custom;
  return applyDetailShader(VIEWMODEL_BASE_COLOURS.glove_fabric(), 2, wetUniform);
}

function makeViewProjector(root, ctx, fallbackCam) {
  return function viewToWorld(localArrOrVec, out) {
    if (Array.isArray(localArrOrVec)) out.fromArray(localArrOrVec);
    else out.copy(localArrOrVec);
    root.updateWorldMatrix(true, false);
    root.localToWorld(out);
    const cam = ctx?.camera || fallbackCam;
    const view = ctx?.viewCamera || cam;
    cam.worldToLocal(out);
    const k = Math.tan(cam.fov * Math.PI / 360) / Math.tan(view.fov * Math.PI / 360);
    out.x *= k;
    out.y *= k;
    return cam.localToWorld(out);
  };
}

function createSpringBank(cfg = {}) {
  return {
    kZ: spring(cfg.kZ?.[0] ?? 520, cfg.kZ?.[1] ?? 30),
    kP: spring(cfg.kP?.[0] ?? 380, cfg.kP?.[1] ?? 26),
    kY: spring(cfg.kY?.[0] ?? 300, cfg.kY?.[1] ?? 22),
    kR: spring(cfg.kR?.[0] ?? 300, cfg.kR?.[1] ?? 20),
    swY: spring(110, 15),
    swP: spring(110, 15),
    jY: spring(140, 13),
    jP: spring(140, 13),
    bump: spring(600, 30),
  };
}

function stepMotionAndPose(s, dt, input, poses, root, rand) {
  const onGround = input.onGround !== false;
  const speed = input.speed || 0;
  const velY = input.velY || 0;
  const look = input.look || { dx: 0, dy: 0 };

  s.bobAmt = damp(s.bobAmt, onGround ? saturate(speed / 3.6) : 0, 8, dt);
  s.bobPhase += dt * (speed > 0.3 && onGround ? 5.2 + speed * 1.55 : 0);
  const ph = s.bobPhase;
  const bob = s.bobAmt * lerp(1, 0.12, s.adsE) * (1 + s.sprintT * 1.4);
  const bobX = Math.sin(ph) * 6e-3 * bob;
  const bobY = (Math.sin(2 * ph) * 42e-4 - Math.pow(0.5 + 0.5 * Math.cos(2 * ph + 0.6), 4) * 48e-4) * bob;
  const breathe = lerp(1, 0.25, s.adsE);
  const swayK = lerp(1, 0.35, s.adsE);

  s.swY.v += clamp(look.dx || 0, -0.2, 0.2) * 3.2 * swayK;
  s.swP.v += clamp(look.dy || 0, -0.2, 0.2) * 2.6 * swayK;
  stepSpring(s.swY, 0, dt);
  stepSpring(s.swP, 0, dt);
  s.swY.x = clamp(s.swY.x, -0.09, 0.09);
  s.swP.x = clamp(s.swP.x, -0.07, 0.07);

  if (s.wasGround && !onGround && velY > 1) {
    s.jY.v -= 0.22;
    s.jP.v += 0.7;
  }
  if (!s.wasGround && onGround) {
    const land = clamp(-s.lastVy * 0.06, 0, 0.6);
    s.jY.v -= land;
    s.jP.v -= land * 3.2;
    s.kR.v += (rand() - 0.5) * land * 2;
  }
  s.wasGround = onGround;
  if (!onGround) s.lastVy = velY;

  stepSpring(s.jY, onGround ? 0 : clamp(-velY * 45e-4, -0.02, 0.024), dt);
  stepSpring(s.jP, onGround ? 0 : clamp(velY * 0.012, -0.06, 0.06), dt);
  for (const k of ['kZ', 'kP', 'kY', 'kR', 'bump']) stepSpring(s[k], 0, dt);

  let inspectRoll = 0, inspectFlip = 0, inspectLift = 0;
  if (s.inspect >= 0) {
    const it = (s.inspect += dt);
    inspectRoll = smootherstep(it / 0.5) * (1 - smootherstep((it - 1.4) / 0.5));
    inspectFlip = smootherstep((it - 1.5) / 0.5) * (1 - smootherstep((it - 2.8) / 0.5));
    inspectLift = smootherstep(it / 0.5) * (1 - smootherstep((it - 2.9) / 0.5));
    if (it > 3.5) { s.inspect = -1; s.idleT = 0; }
  }

  const mx = input.move ? input.move.x : 0;
  const my = input.move ? input.move.y : 0;
  const hip = 1 - s.adsE, ads = s.adsE, spr = s.sprintT, rl = s.reloadW, rk = s.rackW;
  const hol = 1 - s.equipW, lw = s.relaxW * (1 - s.adsE);
  const t = s.t;

  const x = lerp(poses.hip.p[0], poses.ads.p[0], ads)
    + poses.sprint.p[0] * spr + poses.reload.p[0] * rl + bobX
    + Math.sin(t * 0.85 + 1) * 12e-4 * breathe - s.swY.x * 0.06
    - mx * 4e-3 * hip - 0.035 * inspectLift
    + poses.holster.p[0] * hol + poses.lower.p[0] * lw;
  const y = lerp(poses.hip.p[1], poses.ads.p[1], ads)
    + poses.sprint.p[1] * spr + poses.reload.p[1] * rl + bobY
    + Math.sin(t * 1.7) * 16e-4 * breathe + s.swP.x * 0.05
    + s.jY.x + s.bump.x * 0.6 + 0.045 * inspectLift
    + poses.holster.p[1] * hol + poses.lower.p[1] * lw;
  const z = lerp(poses.hip.p[2], poses.ads.p[2], ads)
    + poses.sprint.p[2] * spr + poses.reload.p[2] * rl + s.kZ.x * 0.55
    + my * 4e-3 * hip * (1 - spr)
    + poses.holster.p[2] * hol + poses.lower.p[2] * lw;

  const rx = poses.hip.r[0] * hip + poses.sprint.r[0] * spr + poses.reload.r[0] * rl
    - 0.16 * rk + Math.sin(t * 1.7 + 0.8) * 35e-4 * breathe
    + Math.sin(2 * ph + 0.5) * 8e-3 * bob + s.swP.x + s.jP.x + s.kP.x + s.bump.x * 1.5
    + 0.3 * inspectLift + poses.holster.r[0] * hol + poses.lower.r[0] * lw;
  const ry = poses.hip.r[1] * hip + poses.sprint.r[1] * spr + poses.reload.r[1] * rl
    + Math.sin(t * 0.6) * 2e-3 * breathe + Math.sin(ph) * 0.01 * bob
    + s.swY.x + s.kY.x + 0.18 * inspectLift + 0.25 * inspectFlip
    + poses.holster.r[1] * hol + poses.lower.r[1] * lw;
  const rz = poses.hip.r[2] * hip + poses.sprint.r[2] * spr + poses.reload.r[2] * rl
    + 0.56 * rk + Math.sin(ph) * 0.014 * bob + s.swY.x * 0.7 - mx * 0.035 * hip + s.kR.x
    - 0.75 * inspectRoll + 0.55 * inspectFlip + Math.sin(t * 0.5) * 4e-3 * breathe
    + poses.holster.r[2] * hol + poses.lower.r[2] * lw;

  root.position.set(x, y, z);
  root.rotation.set(rx, ry, rz, 'YXZ');
}

// ============================================================================
// 1. KR-7 CARBINE & 2. KR-7 VANTAGE (shared AR platform factory)
// ============================================================================

function createArPlatformViewmodel(ctx = {}, variant = 'carbine') {
  const isVantage = variant === 'vantage';
  const name = isVantage ? 'KR-7 VANTAGE' : 'KR-7 CARBINE';
  const magSize = isVantage ? 20 : 30;
  const rpm = isVantage ? 330 : 720;
  const range = isVantage ? 480 : 320;
  const reloadTime = isVantage ? 1.72 : 2.05;
  const reloadEmptyTime = isVantage ? 2.24 : 2.58;
  const adsSpeed = isVantage ? 0.21 : 0.18;

  const wetUniform = { value: SHARED_RAIN_WETNESS.value };
  const buildSpec = isVantage
    ? { optic: 'prism', muzzle: 'suppressor', underbarrel: 'laser', magazine: 'fast', stock: 'heavy', camo: 'timberline' }
    : { optic: 'holo', muzzle: 'comp', underbarrel: 'vgrip', magazine: 'std', stock: 'std', camo: 'factory' };

  const root = new THREE.Group();
  root.name = isVantage ? 'viewmodel-kr7-vantage' : 'viewmodel-kr7-carbine';

  const gun = buildProceduralWeapon('ar', buildSpec, { wetUniform });
  root.add(gun.root);

  let scopeDisplay = null;
  if (isVantage) {
    scopeDisplay = upgradePrismScope(gun, { reticleColor: [1, 0.22, 0.12] });
  } else {
    upgradeAttachmentOptic(gun, { reticle: 'holo', color: [1, 0.16, 0.08] });
  }

  let laserFx = null;
  if (gun.anchors.laser) {
    laserFx = buildTacticalLaser(gun.anchors.laser, { color: 0x38ff7a, length: 2.6 });
    root.add(laserFx.group);
  }

  const flash = buildMuzzleFlash({ suppressed: isVantage });
  flash.position.copy(gun.anchors.muzzle);
  flash.visible = false;
  root.add(flash);

  // ---- Articulated Gloved Hands
  const gloveMat = makeGloveMaterial(ctx, wetUniform);
  const gripQ = quatEuler(-0.26, 0, 0).multiply(quatEuler(0, 0, -Math.PI / 2));
  const rightRig = createRightHandRig({
    gripPos: [0, -0.036, 0.0065],
    gripQuat: gripQ,
    gloveMaterial: gloveMat,
  });
  root.add(rightRig.group);

  // Carbine wraps vertical foregrip; Vantage uses thumb-over-bore C-clamp on handguard
  const supportQ = isVantage
    ? quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.08, 0, 0))
    : quatEuler(-0.14, 0.08, 0.12);
  const leftRig = createLeftHandRig({
    supportQuat: supportQ,
    fingers: isVantage
      ? [[1.25, 1.4, 0.75, 0.02], [1.3, 1.44, 0.75, 0], [1.3, 1.45, 0.75, -0.02], [1.34, 1.45, 0.75, -0.05]]
      : [[1.38, 1.52, 0.82, 0.03], [1.42, 1.55, 0.82, 0], [1.42, 1.55, 0.82, -0.02], [1.44, 1.52, 0.82, -0.05]],
    thumb: isVantage
      ? [dirInFrame(supportQ, [0.1, 0.3, -0.95], true), dirInFrame(supportQ, [0.08, 0.12, -0.99], true), dirInFrame(supportQ, [0, 0, -1], true)]
      : [dirInFrame(supportQ, [0.35, 0.45, -0.82], true), dirInFrame(supportQ, [0.55, 0.25, -0.79], true), dirInFrame(supportQ, [0.7, 0.05, -0.71], true)],
    forearm: dirInFrame(supportQ, [-0.48, -0.36, 0.8], true),
    gloveMaterial: gloveMat,
  });
  root.add(leftRig.group);

  const { parts } = gun;
  const magazine = parts.mag;
  const magHome = magazine.userData.rest.clone();
  const boltRestZ = parts.bolt.userData.rest.z;
  const chRestZ = parts.chargingHandle.userData.rest.z;
  const magRelRestX = parts.magRelease.userData.rest.x;

  // ---- Keyframed left-hand trajectories
  const { key, offset, sample } = makeKeyHelpers();
  const kGuard = isVantage
    ? key(supportQ, [-0.015, 0.034, -0.285])
    : key(supportQ, [-0.014, -0.032, -0.292], new Vec3(0, -0.022, -0.068));

  const magGripQ = quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.14, 0, 0));
  const kMag = key(magGripQ, [-0.013, -0.105, -0.126]);
  const kMagPull = offset(kMag, -0.028, -0.045, 0.012);
  const kMagAway = offset(kMag, -0.065, -0.29, 0.12, magGripQ.clone().multiply(quatEuler(-0.48, 0, 0.24)));
  const kMagSeat = offset(kMag, 0, -0.042, 0.006);
  const kMagTap = offset(kMag, 0, -0.014, 0);

  // Bolt-catch paddle slap on left receiver (`[-0.0172, 0.0234, -0.106]`)
  const slapQ = quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(-0.18, 0.22, 0));
  const kSlapReady = key(slapQ, [-0.052, 0.028, -0.106], new Vec3(0, -0.01, -0.05));
  const kSlapHit = key(slapQ, [-0.019, 0.024, -0.106], new Vec3(0, -0.01, -0.05));

  // Rear T-charging-handle pull on draw (`[0, 0.062, 0.045]`)
  const chQ = quatEuler(-0.48, 0, 0).multiply(quatEuler(0, 0, Math.PI * 0.42));
  const kCh = key(chQ, [-0.016, 0.064, 0.045], new Vec3(0, -0.02, -0.095));
  const kChBack = offset(kCh, 0, 0, gun.dims.CH_PULL);

  const sK = reloadTime / 2.05;
  const T_MAG_OUT = 0.44 * sK;
  const T_MAG_IN = 1.32 * sK;
  const T_TAP = 1.50 * sK;
  const T_SLAP_AT = reloadTime + 0.16;

  const TACTICAL_KEYS = [
    [0, kGuard], [0.09 * sK, kGuard], [0.34 * sK, kMagPull], [0.42 * sK, kMag],
    [0.48 * sK, kMag], [0.78 * sK, kMagAway], [0.96 * sK, kMagAway],
    [1.24 * sK, kMagSeat], [1.32 * sK, kMag], [1.44 * sK, kMagPull],
    [1.50 * sK, kMagTap], [1.62 * sK, kMagPull], [reloadTime - 0.04, kGuard], [9, kGuard],
  ];
  const EMPTY_KEYS = [
    ...TACTICAL_KEYS.slice(0, 12),
    [reloadTime - 0.12, kSlapReady],
    [T_SLAP_AT, kSlapHit],
    [T_SLAP_AT + 0.07, kSlapReady],
    [reloadEmptyTime - 0.04, kGuard],
    [9, kGuard],
  ];

  const T_DRAW = 0.98, T_DRAW_RACK = 0.42, T_DRAW_BACK = 0.55, T_DRAW_RELEASE = 0.61, T_HOLSTER = 0.4;
  const DRAW_KEYS = [
    [0, kCh], [T_DRAW_RACK, kCh], [T_DRAW_BACK, kChBack],
    [T_DRAW_RELEASE, kChBack], [0.69, kCh], [T_DRAW, kGuard], [9, kGuard],
  ];

  const poses = {
    hip: { p: [0.114, -0.146, -0.275], r: [0.032, 0.078, -0.028] },
    ads: { p: [0, isVantage ? -0.117 : -0.115, isVantage ? -0.008 : -0.07], r: [0, 0, 0] },
    sprint: { p: [-0.036, 0.006, 0.032], r: [-0.05, 0.62, 0.26] },
    reload: { p: [-0.028, 0.088, -0.018], r: [0.42, 0.22, -0.74] },
    holster: { p: [0.07, -0.34, 0.1], r: [-0.85, 0.6, 0.55] },
    lower: { p: [-0.01, -0.028, 0.02], r: [-0.22, 0.26, 0.15] },
  };

  const magGripInv = magGripQ.clone().invert();
  const keyPos = new Vec3(), keyQ = new Quaternion(), magQ = new Quaternion(), camQ = new Quaternion();
  const fallbackCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 1000);
  const viewToWorld = makeViewProjector(root, ctx, fallbackCam);
  const muzzleArr = gun.anchors.muzzle.toArray();
  const ejectArr = gun.anchors.eject.toArray();

  const totalTris = countObjectTriangles(root);
  const rand = ctx.rng || Math.random;

  const s = {
    draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
    t: 0, cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9,
    bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
    bobPhase: 0, bobAmt: 0, finger: 0, boltT: 9, boltLocked: false, dustOpen: false,
    wasFire: false, flashT: 0, flashDur: 0.045, recPhase: 0, wasGround: true, lastVy: 0,
    spreadS: isVantage ? 0.009 : 0.013, idleT: 0, inspect: -1,
    ...createSpringBank(isVantage ? { kZ: [460, 28], kP: [340, 25] } : { kZ: [540, 30], kP: [390, 26] }),
  };

  const api = {
    name,
    root,
    gun,
    parts,
    ammo: magSize,
    magSize,
    reserve: Infinity,
    state: 'idle',
    ads: 0,
    spread: s.spreadS,
    info: { tris: totalTris },
    magazine,
    leftHand: leftRig.group,
    opticGlass: scopeDisplay ? scopeDisplay.opticGlass : null,
    objective: scopeDisplay ? scopeDisplay.objective : null,
    objectiveOffset: isVantage ? new Vec3(0, 0.117, -0.1546) : null,
    update,
    reset,
    reloadNow,
    cancelReload,
    muzzleWorld: (out = new Vec3()) => viewToWorld(muzzleArr, out),
    isReloading: () => !!s.reload,
    reloadProgress: () => (s.reload ? Math.min(1, s.reload.t / s.reload.T) : 0),
    reloadDuration: () => (s.reload ? s.reload.T : 0),
    draw: drawNow,
    holster: holsterNow,
    isHolstered: () => s.holstered,
    isHolstering: () => !!s.holster,
    equipState: () => (s.draw ? 'drawing' : s.holster ? 'holstering' : s.holstered ? 'holstered' : s.relaxW > 0.5 ? 'lowered' : 'ready'),
    setWetness(w) {
      const cw = clamp(+w || 0, 0, 1);
      wetUniform.value = cw;
      SHARED_RAIN_WETNESS.value = cw;
    },
    snap(input = {}) {
      s.adsLin = input.ads ? 1 : 0;
      s.adsE = smootherstep(s.adsLin);
      api.ads = s.adsE;
      for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
      s.sprintT = input.sprinting ? 1 : 0;
    },
  };

  function syncMagVisuals(ammoCount) {
    if (parts.magRounds) parts.magRounds.visible = ammoCount > 0;
    if (parts.magFillFull) parts.magFillFull.visible = ammoCount > magSize * 0.45;
    if (parts.magFillPart) parts.magFillPart.visible = ammoCount > 0 && ammoCount <= magSize * 0.45;
    if (parts.magFillEmpty) parts.magFillEmpty.visible = ammoCount <= 0;
  }

  function restPose() {
    magazine.visible = true;
    magazine.position.copy(magHome);
    magazine.quaternion.identity();
    leftRig.group.position.copy(kGuard.p);
    leftRig.group.quaternion.copy(kGuard.q);
    parts.chargingHandle.position.z = chRestZ;
    parts.chLatch.rotation.y = 0;
    parts.magRelease.position.x = magRelRestX;
  }

  function reset() {
    Object.assign(s, {
      draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
      cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9,
      bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
      boltT: 9, boltLocked: false, dustOpen: false, wasFire: false, flashT: 0, idleT: 0, inspect: -1,
    });
    api.ammo = magSize;
    api.state = 'idle';
    api.ads = 0;
    for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
    parts.dustCover.rotation.z = 0;
    parts.boltCatch.rotation.z = 0;
    syncMagVisuals(api.ammo);
    restPose();
    if (scopeDisplay) scopeDisplay.update({ ads: 0, eyeBox: 1 });
  }

  function drawNow() {
    if (s.draw || (!s.holstered && !s.holster)) return false;
    const from = s.equipW;
    s.holster = null;
    s.holstered = false;
    s.draw = { t: from * T_DRAW_RACK * 0.999, f: {} };
    ctx.emit?.('weapon:draw', { phase: 'start' });
    return true;
  }

  function holsterNow() {
    if (s.holstered || s.holster) return false;
    if (s.reload) cancelReload();
    s.draw = null;
    s.relaxW = 0;
    s.holster = { t: (1 - s.equipW) * T_HOLSTER };
    restPose();
    ctx.emit?.('weapon:holster', { phase: 'start' });
    return true;
  }

  function cancelReload() {
    if (!s.reload) return;
    s.reload = null;
    s.reloadW = 0;
    s.rackW = 0;
    syncMagVisuals(api.ammo);
    restPose();
  }

  function reloadNow() {
    if (s.holstered || s.holster || s.draw || s.reload || api.ammo >= api.magSize || api.reserve <= 0) {
      return false;
    }
    const empty = api.ammo <= 0;
    s.reload = { t: 0, T: empty ? reloadEmptyTime : reloadTime, empty, f: {} };
    s.autoReload = -1;
    ctx.emit?.('weapon:reload', { phase: 'start', empty });
    return true;
  }

  const shotDir = new Vec3(), muzzle = new Vec3(), hit = new Vec3(), eject = new Vec3(), shellVel = new Vec3(), eye = new Vec3();

  function fireRound(input) {
    const cam = ctx.camera || fallbackCam;
    api.ammo--;
    s.burst++;
    s.lastShot = s.t;
    s.dustOpen = true;
    s.heat = Math.min(1.4, s.heat + (isVantage ? 0.08 : 0.05));
    cam.getWorldQuaternion(camQ);

    const a = rand() * Math.PI * 2;
    const r = Math.tan(api.spread) * Math.sqrt(rand());
    shotDir.set(Math.cos(a) * r, Math.sin(a) * r, -1).normalize().applyQuaternion(camQ);
    if (input.eye) eye.copy(input.eye);
    else cam.getWorldPosition(eye);

    const point = ctx.shot?.(eye, shotDir) || null;
    if (point) hit.copy(point);
    else hit.copy(eye).addScaledVector(shotDir, range);
    api.muzzleWorld(muzzle);
    ctx.tracer?.(muzzle, hit);

    if (ctx.shell) {
      viewToWorld(ejectArr, eject);
      shellVel.set(2.2 + rand() * 1.1, 1.3 + rand() * 0.7, 0.45 - rand() * 0.5).applyQuaternion(camQ);
      if (input.vel) shellVel.add(input.vel);
      ctx.shell(eject, shellVel);
    }
    ctx.emit?.('weapon:fire', { origin: eye, dir: shotDir, muzzle, ads: s.adsE, suppressed: isVantage });

    const k = lerp(1, isVantage ? 0.45 : 0.55, s.adsE) * (input.crouching ? 0.84 : 1);
    const pitchKick = (isVantage ? 0.0105 : 0.0066) * (s.burst <= 8 ? 1 : 0.45) * k * (0.86 + rand() * 0.28);
    const yawKick = ((rand() - 0.5) * (isVantage ? 0.0022 : 0.0032) + Math.sin(s.burst * 0.6 + s.recPhase) * 0.0028) * k;
    ctx.recoil?.(pitchKick, yawKick);

    s.kZ.v += (isVantage ? 1.85 : 1.5) * lerp(1, 0.6, s.adsE);
    s.kP.v += (isVantage ? 1.95 : 1.48) * k;
    s.kY.v += (rand() - 0.5) * 1.0 * k;
    s.kR.v += (rand() - 0.5) * 1.7 * k;
    s.bloom = Math.min(1, s.bloom + (isVantage ? 0.24 : 0.16));

    s.flashT = s.flashDur = isVantage ? 0.028 + rand() * 0.012 : 0.036 + rand() * 0.018;
    const u = flash.material.uniforms;
    u.uSeed.value = rand() * 100;
    u.uJet.value = isVantage ? 0.18 + rand() * 0.15 : 0.65 + rand() * 0.55;
    flash.rotation.z = (rand() - 0.5) * 0.45;
    const fs = (isVantage ? 0.45 : 0.85 + rand() * 0.45) * lerp(1, 0.6, s.adsE);
    flash.scale.set(fs, fs, fs);

    s.boltT = 0;
    syncMagVisuals(api.ammo);
    if (api.ammo <= 0) s.boltLocked = true;
  }

  function update(dt, input = {}) {
    dt = Math.max(0, dt || 0);
    s.t += dt;
    let drawRack = 0;
    if (s.draw) {
      const D = s.draw;
      D.t += dt;
      const t = D.t;
      s.equipW = smootherstep(t / T_DRAW_RACK);
      sample(DRAW_KEYS, t, keyPos, keyQ);
      leftRig.group.position.copy(keyPos);
      leftRig.group.quaternion.copy(keyQ);
      if (t >= T_DRAW_RACK) {
        drawRack = t < T_DRAW_BACK
          ? smootherstep((t - T_DRAW_RACK) / (T_DRAW_BACK - T_DRAW_RACK))
          : t < T_DRAW_RELEASE ? 1 : Math.max(0, 1 - (t - T_DRAW_RELEASE) / 0.04);
      }
      parts.chargingHandle.position.z = chRestZ + gun.dims.CH_PULL * drawRack;
      parts.chLatch.rotation.y = 0.22 * smoothstep(0.05, 0.35, drawRack);
      if (t >= T_DRAW_BACK) s.dustOpen = true;
      if (t >= T_DRAW_RELEASE && !D.f.rack) {
        D.f.rack = 1;
        s.bump.v += 0.32;
        s.kZ.v -= 0.5;
        ctx.emit?.('weapon:draw', { phase: 'rack' });
      }
      if (t >= T_DRAW) {
        s.draw = null;
        s.equipW = 1;
        restPose();
        ctx.emit?.('weapon:draw', { phase: 'done' });
      }
    } else if (s.holster) {
      const H = s.holster;
      H.t += dt;
      s.equipW = 1 - smootherstep(H.t / T_HOLSTER);
      if (H.t >= T_HOLSTER) {
        s.holster = null;
        s.holstered = true;
        s.equipW = 0;
        ctx.emit?.('weapon:holster', { phase: 'done' });
      }
    }

    const equipped = !s.holstered && !s.holster && (!s.draw || s.draw.t > 0.76);
    const fire = !!input.fire && root.visible !== false && equipped;
    if (!fire) s.dryDone = false;
    const wantsSprint = !!input.sprinting && !fire && !input.ads && !s.reload;
    s.sprintT = damp(s.sprintT, wantsSprint ? 1 : 0, 9, dt);

    if (input.reload && equipped) reloadNow();
    if (s.autoReload >= 0) {
      s.autoReload -= dt;
      if (s.autoReload < 0) reloadNow();
    }

    if (s.reload) {
      const R = s.reload;
      R.t += dt;
      const t = R.t;
      const phase = (pName, at) => (t >= at && !R.f[pName]
        ? ((R.f[pName] = 1), ctx.emit?.('weapon:reload', { phase: pName, empty: R.empty }), true)
        : false);

      parts.magRelease.position.x = magRelRestX - 0.0022 * smoothstep(0.28 * sK, 0.42 * sK, t) * (1 - smoothstep(0.48 * sK, 0.6 * sK, t));
      if (phase('magout', T_MAG_OUT)) s.bump.v -= 0.25;
      if (t > 0.86 * sK && !R.f.fresh) {
        R.f.fresh = 1;
        syncMagVisuals(magSize);
      }
      if (phase('magin', T_MAG_IN)) {
        s.bump.v += 0.55;
        const added = Math.min(api.magSize - api.ammo, api.reserve);
        api.ammo += added;
        api.reserve -= added;
        syncMagVisuals(api.ammo);
        if (!R.empty) s.boltLocked = false;
      }
      if (t >= T_TAP && !R.f.tap) { R.f.tap = 1; s.bump.v += 0.38; }
      if (R.empty && phase('bolt', T_SLAP_AT)) {
        s.boltLocked = false;
        s.bump.v += 0.35;
        s.kZ.v -= 0.52;
      }

      sample(R.empty ? EMPTY_KEYS : TACTICAL_KEYS, t, keyPos, keyQ);
      leftRig.group.position.copy(keyPos);
      leftRig.group.quaternion.copy(keyQ);
      if (t >= T_MAG_OUT && t < T_MAG_IN) {
        magQ.copy(keyQ).multiply(magGripInv);
        magazine.quaternion.copy(magQ);
        magazine.position.copy(magHome).sub(kMag.p).applyQuaternion(magQ).add(keyPos);
      } else {
        magazine.quaternion.identity();
        magazine.position.copy(magHome);
      }

      const inW = smootherstep(t / 0.28);
      const outW = 1 - smootherstep((t - (R.T - 0.42)) / 0.38);
      s.reloadW = Math.min(inW, outW);
      s.rackW = R.empty ? smootherstep((t - (reloadTime - 0.2)) / 0.25) * outW : 0;
      if (t >= R.T) {
        s.reload = null;
        s.reloadW = 0;
        s.rackW = 0;
        ctx.emit?.('weapon:reload', { phase: 'done' });
        restPose();
      }
    }

    s.cooldown -= dt;
    const canFire = !s.reload && s.sprintT < 0.45 && s.relaxW < 0.3;
    if (fire && canFire) {
      if (api.ammo > 0) {
        if (isVantage && !s.wasFire && s.cooldown < 0.04) s.cooldown = 0;
        let n = 0;
        while (s.cooldown <= 0 && api.ammo > 0 && n < 3) {
          fireRound(input);
          s.cooldown += 60 / rpm;
          n++;
        }
      } else if (!s.dryDone) {
        s.dryDone = true;
        ctx.emit?.('weapon:dry', {});
        s.bump.v -= 0.08;
        if (api.reserve > 0) s.autoReload = 0.32;
      }
    }
    s.wasFire = fire;
    if (s.cooldown < 0) s.cooldown = Math.max(s.cooldown, -1e-3);
    if (s.t - s.lastShot > 0.25) {
      if (s.burst > 0) s.recPhase = rand() * 6.28;
      s.burst = 0;
    }
    s.bloom = Math.max(0, s.bloom - dt * (isVantage ? 1.8 : 1.5));
    s.heat = Math.max(0, s.heat - dt * 0.22);

    const adsHeld = !!input.ads && !s.reload && s.sprintT < 0.35 && equipped;
    s.adsLin = clamp(s.adsLin + (adsHeld ? dt : -dt) / adsSpeed, 0, 1);
    s.adsE = smootherstep(s.adsLin);
    api.ads = s.adsE;

    const speed = input.speed || 0;
    const moving = saturate(speed / 6);
    const onGround = input.onGround !== false;
    const baseHip = isVantage ? 0.0095 : 0.012;
    const baseAds = isVantage ? 3.5e-4 : 1.1e-3;
    const targetSpread = lerp(baseHip, baseAds, s.adsE)
      + moving * lerp(0.012, 0.0032, s.adsE)
      + s.bloom * lerp(0.006, 0.0018, s.adsE)
      + (onGround ? 0 : 0.02)
      - (input.crouching ? 0.002 * (1 - s.adsE) : 0);
    s.spreadS = damp(s.spreadS, Math.max(2e-4, targetSpread), 18, dt);
    api.spread = s.spreadS;

    const look = input.look || { dx: 0, dy: 0 };
    if (fire || input.ads || s.reload || speed > 0.2 || Math.abs(look.dx || 0) + Math.abs(look.dy || 0) > 2e-3 || s.sprintT > 0.1) {
      s.idleT = 0;
      if (s.inspect >= 0) s.inspect = Math.max(s.inspect, 2.9);
    } else s.idleT += dt;
    if (s.inspect < 0 && s.idleT > 24) s.inspect = 0;

    const quiet = !input.fire && !input.ads && !s.reload && !s.draw && s.inspect < 0;
    s.quietT = quiet ? s.quietT + dt : 0;
    const relaxTarget = s.quietT > 3.5 && s.sprintT < 0.5 ? 1 : 0;
    s.relaxW = damp(s.relaxW, relaxTarget, relaxTarget > s.relaxW ? 1.4 : 24, dt);

    api.state = s.reload ? 'reloading'
      : s.inspect >= 0 ? 'inspect'
      : s.sprintT > 0.5 ? 'sprinting'
      : s.t - s.lastShot < 0.14 ? 'firing'
      : 'idle';

    // Articulated bolt, bolt catch, dust cover, trigger & morphing finger
    s.boltT += dt;
    const boltDur = 0.074;
    let boltW = s.boltT < boltDur ? Math.sin(Math.PI * s.boltT / boltDur) : 0;
    if (s.boltLocked && s.boltT > boltDur * 0.5) boltW = Math.max(boltW, 0.92);
    parts.bolt.position.z = boltRestZ + gun.dims.BOLT_TRAVEL * Math.max(boltW, drawRack);
    parts.boltCatch.rotation.z = damp(parts.boltCatch.rotation.z, s.boltLocked ? 0.095 : 0, 26, dt);
    const dustTarget = s.dustOpen ? -2.42 - boltW * 0.12 : 0;
    parts.dustCover.rotation.z = damp(parts.dustCover.rotation.z, dustTarget, 34, dt);

    s.finger = damp(s.finger, fire && canFire ? 1 : 0, 30, dt);
    rightRig.setTriggerFinger(s.finger);
    parts.trigger.rotation.x = -0.22 * s.finger;

    const fu = flash.material.uniforms;
    s.flashT -= dt;
    const peakFlash = isVantage ? 2.4 : 9.2;
    fu.uInt.value = s.flashT > 0 ? peakFlash * Math.sqrt(Math.max(0, s.flashT / s.flashDur)) : 0;
    fu.uHeat.value = saturate((s.heat - 0.45) / 0.8) * 2.1;
    flash.visible = fu.uInt.value > 0 || fu.uHeat.value > 0.02;

    if (laserFx) {
      laserFx.setIntensity(equipped ? lerp(0.95, 0.35, s.sprintT) * (1 - 0.5 * s.reloadW) : 0);
    }

    stepMotionAndPose(s, dt, input, poses, root, rand);

    if (scopeDisplay) {
      const offX = clamp((s.swY.x + s.swY.v * 0.08 + s.kY.x * 1.4) * 3.8, -0.75, 0.75);
      const offY = clamp((s.swP.x + s.swP.v * 0.08 + s.kP.x * 1.3) * 3.8, -0.75, 0.75);
      const offMag = Math.hypot(offX, offY);
      const eyeBox = clamp(1 - offMag * 0.72 - Math.abs(s.kZ.x) * 4.2, 0.16, 1) * smoothstep(0.08, 0.94, s.adsE);
      scopeDisplay.update({
        ads: s.adsE,
        eyeBox,
        eyeOffsetX: offX,
        eyeOffsetY: offY,
      });
    }
  }

  reset();
  return api;
}

export function createKr7CarbineViewmodel(ctx) {
  return createArPlatformViewmodel(ctx, 'carbine');
}

export function createKr7VantageViewmodel(ctx) {
  return createArPlatformViewmodel(ctx, 'vantage');
}

// ============================================================================
// 3. VESPER 9 (910 RPM suppressed CQB SMG with HK charging-handle slap)
// ============================================================================

export function createVesper9Viewmodel(ctx = {}) {
  const name = 'VESPER 9';
  const magSize = 36;
  const rpm = 910;
  const range = 220;
  const reloadTime = 1.82;
  const reloadEmptyTime = 2.42;

  const wetUniform = { value: SHARED_RAIN_WETNESS.value };
  const root = new THREE.Group();
  root.name = 'viewmodel-vesper9';

  const gun = buildProceduralWeapon(
    'smg',
    { optic: 'reflex', muzzle: 'suppressor', underbarrel: 'none', magazine: 'ext', stock: 'light', camo: 'fracture' },
    { wetUniform }
  );
  root.add(gun.root);
  upgradeAttachmentOptic(gun, { reticle: 'dot', color: [1, 0.14, 0.06] });

  const flash = buildMuzzleFlash({ suppressed: true });
  flash.position.copy(gun.anchors.muzzle);
  flash.visible = false;
  root.add(flash);

  const gloveMat = makeGloveMaterial(ctx, wetUniform);
  const gripQ = quatEuler(-0.24, 0, 0).multiply(quatEuler(0, 0, -Math.PI / 2));
  const rightRig = createRightHandRig({
    gripPos: [0, -0.039, 0.001],
    gripQuat: gripQ,
    gloveMaterial: gloveMat,
  });
  root.add(rightRig.group);

  const supportQ = quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.06, 0, 0));
  const leftRig = createLeftHandRig({
    supportQuat: supportQ,
    gloveMaterial: gloveMat,
  });
  root.add(leftRig.group);

  const { parts, dims } = gun;
  const magazine = parts.mag;
  const magHome = magazine.userData.rest.clone();
  const boltRestZ = parts.bolt.userData.rest.z;
  const chRestZ = parts.chargingHandle.userData.rest.z;

  const { key, offset, sample } = makeKeyHelpers();
  const kGuard = key(supportQ, [-0.014, 0.022, -0.242]);

  const magGripQ = quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.18, 0, 0));
  const kMag = key(magGripQ, [-0.012, -0.125, -0.122]);
  const kMagPull = offset(kMag, -0.025, -0.048, 0.018);
  const kMagAway = offset(kMag, -0.06, -0.28, 0.11, magGripQ.clone().multiply(quatEuler(-0.5, 0, 0.22)));
  const kMagSeat = offset(kMag, 0, -0.042, 0.01);

  const chQ = quatEuler(-0.35, 0.15, 0).multiply(quatEuler(0, 0, Math.PI * 0.44));
  const kChFront = key(chQ, [-0.026, 0.064, -0.292], new Vec3(0, -0.02, -0.095));
  const kChLocked = offset(kChFront, 0, 0.012, dims.CH_PULL);
  const kSlapWindup = offset(kChLocked, -0.042, 0.048, 0.005);
  const kSlapDown = offset(kChLocked, -0.004, -0.016, -0.02);

  const T_MAG_OUT = 0.38, T_MAG_IN = 1.18;
  const TACTICAL_KEYS = [
    [0, kGuard], [0.08, kGuard], [0.28, kMagPull], [0.36, kMag],
    [0.42, kMag], [0.68, kMagAway], [0.84, kMagAway],
    [1.10, kMagSeat], [1.18, kMag], [1.34, kMagPull], [1.76, kGuard], [9, kGuard],
  ];
  // Empty reload: lock handle up -> swap 36rd curved mag -> iconic HK downward slap!
  const T_LOCK_CH = 0.26, T_E_MAG_OUT = 0.68, T_E_MAG_IN = 1.48, T_SLAP = 1.98;
  const EMPTY_KEYS = [
    [0, kGuard], [0.12, kChFront], [T_LOCK_CH, kChLocked], [0.34, kChLocked],
    [0.56, kMag], [T_E_MAG_OUT, kMagPull], [0.94, kMagAway], [1.12, kMagAway],
    [1.40, kMagSeat], [T_E_MAG_IN, kMag], [1.62, kMagPull],
    [1.84, kSlapWindup], [T_SLAP, kSlapDown], [2.08, kChFront], [2.38, kGuard], [9, kGuard],
  ];

  const T_DRAW = 0.86, T_DRAW_RACK = 0.36, T_DRAW_BACK = 0.48, T_DRAW_RELEASE = 0.54, T_HOLSTER = 0.35;
  const DRAW_KEYS = [
    [0, kChFront], [T_DRAW_RACK, kChFront], [T_DRAW_BACK, kChLocked],
    [T_DRAW_RELEASE, kChLocked], [0.64, kChFront], [T_DRAW, kGuard], [9, kGuard],
  ];

  const poses = {
    hip: { p: [0.11, -0.138, -0.285], r: [0.028, 0.072, -0.025] },
    ads: { p: [0, -0.1175, -0.11], r: [0, 0, 0] },
    sprint: { p: [-0.032, 0.008, 0.028], r: [-0.04, 0.58, 0.24] },
    reload: { p: [-0.026, 0.082, -0.015], r: [0.38, 0.2, -0.68] },
    holster: { p: [0.07, -0.32, 0.1], r: [-0.82, 0.55, 0.5] },
    lower: { p: [-0.01, -0.026, 0.02], r: [-0.2, 0.24, 0.14] },
  };

  const magGripInv = magGripQ.clone().invert();
  const keyPos = new Vec3(), keyQ = new Quaternion(), magQ = new Quaternion(), camQ = new Quaternion();
  const fallbackCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 1000);
  const viewToWorld = makeViewProjector(root, ctx, fallbackCam);
  const muzzleArr = gun.anchors.muzzle.toArray();
  const ejectArr = gun.anchors.eject.toArray();
  const totalTris = countObjectTriangles(root);
  const rand = ctx.rng || Math.random;

  const s = {
    draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
    t: 0, cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9,
    bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
    bobPhase: 0, bobAmt: 0, finger: 0, boltT: 9, chLocked: false,
    flashT: 0, flashDur: 0.03, recPhase: 0, wasGround: true, lastVy: 0,
    spreadS: 0.014, idleT: 0, inspect: -1,
    ...createSpringBank({ kZ: [620, 34], kP: [440, 28], kY: [340, 24] }),
  };

  const api = {
    name,
    root,
    gun,
    parts,
    ammo: magSize,
    magSize,
    reserve: Infinity,
    state: 'idle',
    ads: 0,
    spread: s.spreadS,
    info: { tris: totalTris },
    magazine,
    leftHand: leftRig.group,
    opticGlass: null,
    objective: null,
    update,
    reset,
    reloadNow,
    cancelReload,
    muzzleWorld: (out = new Vec3()) => viewToWorld(muzzleArr, out),
    isReloading: () => !!s.reload,
    reloadProgress: () => (s.reload ? Math.min(1, s.reload.t / s.reload.T) : 0),
    reloadDuration: () => (s.reload ? s.reload.T : 0),
    draw: drawNow,
    holster: holsterNow,
    isHolstered: () => s.holstered,
    isHolstering: () => !!s.holster,
    equipState: () => (s.draw ? 'drawing' : s.holster ? 'holstering' : s.holstered ? 'holstered' : s.relaxW > 0.5 ? 'lowered' : 'ready'),
    setWetness(w) {
      const cw = clamp(+w || 0, 0, 1);
      wetUniform.value = cw;
      SHARED_RAIN_WETNESS.value = cw;
    },
    snap(input = {}) {
      s.adsLin = input.ads ? 1 : 0;
      s.adsE = smootherstep(s.adsLin);
      api.ads = s.adsE;
      for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
      s.sprintT = input.sprinting ? 1 : 0;
    },
  };

  function syncMagVisuals(ammoCount) {
    if (parts.magRounds) parts.magRounds.visible = ammoCount > 0;
    if (parts.magFollower) parts.magFollower.visible = ammoCount <= 2;
  }

  function restPose() {
    magazine.visible = true;
    magazine.position.copy(magHome);
    magazine.quaternion.identity();
    leftRig.group.position.copy(kGuard.p);
    leftRig.group.quaternion.copy(kGuard.q);
    parts.chargingHandle.position.z = chRestZ;
    parts.chargingHandle.rotation.z = 0;
    parts.magPaddle.rotation.x = 0;
  }

  function reset() {
    Object.assign(s, {
      draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
      cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9,
      bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
      boltT: 9, chLocked: false, flashT: 0, idleT: 0, inspect: -1,
    });
    api.ammo = magSize;
    api.state = 'idle';
    api.ads = 0;
    for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
    syncMagVisuals(api.ammo);
    restPose();
  }

  function drawNow() {
    if (s.draw || (!s.holstered && !s.holster)) return false;
    const from = s.equipW;
    s.holster = null;
    s.holstered = false;
    s.draw = { t: from * T_DRAW_RACK * 0.999, f: {} };
    ctx.emit?.('weapon:draw', { phase: 'start' });
    return true;
  }

  function holsterNow() {
    if (s.holstered || s.holster) return false;
    if (s.reload) cancelReload();
    s.draw = null;
    s.relaxW = 0;
    s.holster = { t: (1 - s.equipW) * T_HOLSTER };
    restPose();
    ctx.emit?.('weapon:holster', { phase: 'start' });
    return true;
  }

  function cancelReload() {
    if (!s.reload) return;
    s.reload = null;
    s.reloadW = 0;
    s.rackW = 0;
    s.chLocked = false;
    syncMagVisuals(api.ammo);
    restPose();
  }

  function reloadNow() {
    if (s.holstered || s.holster || s.draw || s.reload || api.ammo >= api.magSize || api.reserve <= 0) {
      return false;
    }
    const empty = api.ammo <= 0;
    s.reload = { t: 0, T: empty ? reloadEmptyTime : reloadTime, empty, f: {} };
    s.autoReload = -1;
    ctx.emit?.('weapon:reload', { phase: 'start', empty });
    return true;
  }

  const shotDir = new Vec3(), muzzle = new Vec3(), hit = new Vec3(), eject = new Vec3(), shellVel = new Vec3(), eye = new Vec3();

  function fireRound(input) {
    const cam = ctx.camera || fallbackCam;
    api.ammo--;
    s.burst++;
    s.lastShot = s.t;
    s.heat = Math.min(1.3, s.heat + 0.042);
    cam.getWorldQuaternion(camQ);

    const a = rand() * Math.PI * 2, r = Math.tan(api.spread) * Math.sqrt(rand());
    shotDir.set(Math.cos(a) * r, Math.sin(a) * r, -1).normalize().applyQuaternion(camQ);
    if (input.eye) eye.copy(input.eye);
    else cam.getWorldPosition(eye);
    const point = ctx.shot?.(eye, shotDir) || null;
    if (point) hit.copy(point);
    else hit.copy(eye).addScaledVector(shotDir, range);
    api.muzzleWorld(muzzle);
    ctx.tracer?.(muzzle, hit);

    if (ctx.shell) {
      viewToWorld(ejectArr, eject);
      shellVel.set(2.4 + rand() * 1.1, 1.1 + rand() * 0.6, 0.5 - rand() * 0.4).applyQuaternion(camQ);
      if (input.vel) shellVel.add(input.vel);
      ctx.shell(eject, shellVel);
    }
    ctx.emit?.('weapon:fire', { origin: eye, dir: shotDir, muzzle, ads: s.adsE, suppressed: true });

    const k = lerp(1, 0.52, s.adsE) * (input.crouching ? 0.85 : 1);
    const falloff = s.burst <= 11 ? 1 : 0.42;
    const yaw = (Math.sin(s.burst * 0.65 + s.recPhase) * 0.0036 + (rand() - 0.5) * 0.0024) * k;
    ctx.recoil?.(0.0049 * falloff * k * (0.88 + rand() * 0.24), yaw);

    s.kZ.v += 1.25 * lerp(1, 0.58, s.adsE);
    s.kP.v += 1.18 * k;
    s.kY.v += (rand() - 0.5) * 1.15 * k;
    s.kR.v += (rand() - 0.5) * 1.55 * k;
    s.bloom = Math.min(1, s.bloom + 0.13);

    s.flashT = s.flashDur = 0.025 + rand() * 0.012;
    const u = flash.material.uniforms;
    u.uSeed.value = rand() * 100;
    u.uJet.value = 0.22 + rand() * 0.2;
    flash.rotation.z = (rand() - 0.5) * 0.5;
    const fs = (0.48 + rand() * 0.2) * lerp(1, 0.6, s.adsE);
    flash.scale.set(fs, fs, fs);

    s.boltT = 0;
    syncMagVisuals(api.ammo);
  }

  function update(dt, input = {}) {
    dt = Math.max(0, dt || 0);
    s.t += dt;
    let chPull = 0, chRot = 0;
    if (s.draw) {
      const D = s.draw;
      D.t += dt;
      const t = D.t;
      s.equipW = smootherstep(t / T_DRAW_RACK);
      sample(DRAW_KEYS, t, keyPos, keyQ);
      leftRig.group.position.copy(keyPos);
      leftRig.group.quaternion.copy(keyQ);
      if (t >= T_DRAW_RACK) {
        chPull = t < T_DRAW_BACK
          ? smootherstep((t - T_DRAW_RACK) / (T_DRAW_BACK - T_DRAW_RACK))
          : t < T_DRAW_RELEASE ? 1 : Math.max(0, 1 - (t - T_DRAW_RELEASE) / 0.04);
      }
      if (t >= T_DRAW_RELEASE && !D.f.rack) {
        D.f.rack = 1;
        s.bump.v += 0.28;
        s.kZ.v -= 0.45;
        ctx.emit?.('weapon:draw', { phase: 'rack' });
      }
      if (t >= T_DRAW) {
        s.draw = null;
        s.equipW = 1;
        restPose();
        ctx.emit?.('weapon:draw', { phase: 'done' });
      }
    } else if (s.holster) {
      const H = s.holster;
      H.t += dt;
      s.equipW = 1 - smootherstep(H.t / T_HOLSTER);
      if (H.t >= T_HOLSTER) {
        s.holster = null;
        s.holstered = true;
        s.equipW = 0;
        ctx.emit?.('weapon:holster', { phase: 'done' });
      }
    }

    const equipped = !s.holstered && !s.holster && (!s.draw || s.draw.t > 0.68);
    const fire = !!input.fire && root.visible !== false && equipped;
    if (!fire) s.dryDone = false;
    const wantsSprint = !!input.sprinting && !fire && !input.ads && !s.reload;
    s.sprintT = damp(s.sprintT, wantsSprint ? 1 : 0, 10, dt);

    if (input.reload && equipped) reloadNow();
    if (s.autoReload >= 0) {
      s.autoReload -= dt;
      if (s.autoReload < 0) reloadNow();
    }

    if (s.reload) {
      const R = s.reload;
      R.t += dt;
      const t = R.t;
      const tOut = R.empty ? T_E_MAG_OUT : T_MAG_OUT;
      const tIn = R.empty ? T_E_MAG_IN : T_MAG_IN;
      const phase = (pName, at) => (t >= at && !R.f[pName]
        ? ((R.f[pName] = 1), ctx.emit?.('weapon:reload', { phase: pName, empty: R.empty }), true)
        : false);

      parts.magPaddle.rotation.x = 0.24 * smoothstep(tOut - 0.12, tOut, t) * (1 - smoothstep(tOut + 0.04, tOut + 0.14, t));
      if (R.empty) {
        if (t >= 0.12 && t < T_LOCK_CH) chPull = smootherstep((t - 0.12) / (T_LOCK_CH - 0.12));
        else if (t >= T_LOCK_CH && t < T_SLAP) {
          chPull = 1;
          chRot = dims.CH_LOCK * smootherstep((t - T_LOCK_CH) / 0.08);
        } else if (t >= T_SLAP) {
          chPull = Math.max(0, 1 - (t - T_SLAP) / 0.035);
          chRot = 0;
        }
        if (phase('bolt', T_SLAP)) {
          s.bump.v += 0.42;
          s.kZ.v -= 0.55;
        }
      }

      if (phase('magout', tOut)) s.bump.v -= 0.22;
      if (t > (tOut + tIn) * 0.5 && !R.f.fresh) {
        R.f.fresh = 1;
        syncMagVisuals(magSize);
      }
      if (phase('magin', tIn)) {
        s.bump.v += 0.5;
        const added = Math.min(api.magSize - api.ammo, api.reserve);
        api.ammo += added;
        api.reserve -= added;
        syncMagVisuals(api.ammo);
      }

      sample(R.empty ? EMPTY_KEYS : TACTICAL_KEYS, t, keyPos, keyQ);
      leftRig.group.position.copy(keyPos);
      leftRig.group.quaternion.copy(keyQ);
      if (t >= tOut && t < tIn) {
        magQ.copy(keyQ).multiply(magGripInv);
        magazine.quaternion.copy(magQ);
        magazine.position.copy(magHome).sub(kMag.p).applyQuaternion(magQ).add(keyPos);
      } else {
        magazine.quaternion.identity();
        magazine.position.copy(magHome);
      }

      const inW = smootherstep(t / 0.24);
      const outW = 1 - smootherstep((t - (R.T - 0.36)) / 0.32);
      s.reloadW = Math.min(inW, outW);
      s.rackW = R.empty ? smootherstep((t - 1.65) / 0.22) * outW : 0;
      if (t >= R.T) {
        s.reload = null;
        s.reloadW = 0;
        s.rackW = 0;
        ctx.emit?.('weapon:reload', { phase: 'done' });
        restPose();
      }
    }

    s.cooldown -= dt;
    const canFire = !s.reload && s.sprintT < 0.45 && s.relaxW < 0.3;
    if (fire && canFire) {
      if (api.ammo > 0) {
        let n = 0;
        while (s.cooldown <= 0 && api.ammo > 0 && n < 4) {
          fireRound(input);
          s.cooldown += 60 / rpm;
          n++;
        }
      } else if (!s.dryDone) {
        s.dryDone = true;
        ctx.emit?.('weapon:dry', {});
        s.bump.v -= 0.08;
        if (api.reserve > 0) s.autoReload = 0.3;
      }
    }
    if (s.cooldown < 0) s.cooldown = Math.max(s.cooldown, -1e-3);
    if (s.t - s.lastShot > 0.22) {
      if (s.burst > 0) s.recPhase = rand() * 6.28;
      s.burst = 0;
    }
    s.bloom = Math.max(0, s.bloom - dt * 1.7);
    s.heat = Math.max(0, s.heat - dt * 0.24);

    const adsHeld = !!input.ads && !s.reload && s.sprintT < 0.35 && equipped;
    s.adsLin = clamp(s.adsLin + (adsHeld ? dt : -dt) / 0.14, 0, 1);
    s.adsE = smootherstep(s.adsLin);
    api.ads = s.adsE;

    const speed = input.speed || 0;
    const moving = saturate(speed / 6);
    const onGround = input.onGround !== false;
    const targetSpread = lerp(0.0135, 0.0014, s.adsE)
      + moving * lerp(0.011, 0.0035, s.adsE)
      + s.bloom * lerp(0.006, 0.0022, s.adsE)
      + (onGround ? 0 : 0.018);
    s.spreadS = damp(s.spreadS, targetSpread, 20, dt);
    api.spread = s.spreadS;

    const look = input.look || { dx: 0, dy: 0 };
    if (fire || input.ads || s.reload || speed > 0.2 || Math.abs(look.dx || 0) + Math.abs(look.dy || 0) > 2e-3 || s.sprintT > 0.1) {
      s.idleT = 0;
      if (s.inspect >= 0) s.inspect = Math.max(s.inspect, 2.9);
    } else s.idleT += dt;
    if (s.inspect < 0 && s.idleT > 24) s.inspect = 0;

    const quiet = !input.fire && !input.ads && !s.reload && !s.draw && s.inspect < 0;
    s.quietT = quiet ? s.quietT + dt : 0;
    const relaxTarget = s.quietT > 3.5 && s.sprintT < 0.5 ? 1 : 0;
    s.relaxW = damp(s.relaxW, relaxTarget, relaxTarget > s.relaxW ? 1.4 : 24, dt);

    api.state = s.reload ? 'reloading'
      : s.inspect >= 0 ? 'inspect'
      : s.sprintT > 0.5 ? 'sprinting'
      : s.t - s.lastShot < 0.12 ? 'firing'
      : 'idle';

    s.boltT += dt;
    const boltDur = 0.062;
    const boltW = s.boltT < boltDur ? Math.sin(Math.PI * s.boltT / boltDur) : 0;
    parts.bolt.position.z = boltRestZ + dims.BOLT_TRAVEL * Math.max(boltW, chPull);
    parts.chargingHandle.position.z = chRestZ + dims.CH_PULL * chPull;
    parts.chargingHandle.rotation.z = chRot;

    s.finger = damp(s.finger, fire && canFire ? 1 : 0, 32, dt);
    rightRig.setTriggerFinger(s.finger);
    parts.trigger.rotation.x = -0.22 * s.finger;

    const fu = flash.material.uniforms;
    s.flashT -= dt;
    fu.uInt.value = s.flashT > 0 ? 2.6 * Math.sqrt(Math.max(0, s.flashT / s.flashDur)) : 0;
    fu.uHeat.value = saturate((s.heat - 0.5) / 0.8) * 1.8;
    flash.visible = fu.uInt.value > 0 || fu.uHeat.value > 0.02;

    stepMotionAndPose(s, dt, input, poses, root, rand);
  }

  reset();
  return api;
}

// ============================================================================
// 4. M12 BREACHER (8-shell 9-pellet pump shotgun + per-shell interruptible reload)
// ============================================================================

export function createM12BreacherViewmodel(ctx = {}) {
  const name = 'M12 BREACHER';
  const magSize = 8;
  const pellets = 9;
  const range = 95;
  const fireCadence = 60 / 75; // ~75 RPM (0.80s cycle including pump)

  const wetUniform = { value: SHARED_RAIN_WETNESS.value };
  const root = new THREE.Group();
  root.name = 'viewmodel-m12-breacher';

  const gun = buildProceduralWeapon(
    'shotgun',
    { optic: 'reflex', muzzle: 'choke', underbarrel: 'laser', magazine: 'std', stock: 'heavy', camo: 'dune' },
    { wetUniform }
  );
  root.add(gun.root);
  upgradeAttachmentOptic(gun, { reticle: 'dot', color: [1, 0.18, 0.08] });

  let laserFx = null;
  if (gun.anchors.laser) {
    laserFx = buildTacticalLaser(gun.anchors.laser, { color: 0x38ff7a, length: 2.6 });
    root.add(laserFx.group);
  }

  const flash = buildMuzzleFlash({ suppressed: false });
  flash.position.copy(gun.anchors.muzzle);
  flash.visible = false;
  root.add(flash);

  const gloveMat = makeGloveMaterial(ctx, wetUniform);
  const gripQ = quatEuler(-0.38, 0, 0).multiply(quatEuler(0, 0, -Math.PI / 2));
  const rightRig = createRightHandRig({
    gripPos: [0, -0.024, 0.002],
    gripQuat: gripQ,
    gloveMaterial: gloveMat,
  });
  root.add(rightRig.group);

  const supportQ = quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.05, 0, 0));
  const leftRig = createLeftHandRig({
    supportQuat: supportQ,
    gloveMaterial: gloveMat,
  });
  root.add(leftRig.group);

  const { parts, dims } = gun;
  const pumpRestZ = parts.pump.userData.rest.z;
  const boltRestZ = parts.bolt.userData.rest.z;
  const shellPart = parts.shell;
  const shellGatePos = shellPart.userData.rest.clone(); // [0, 0.0145, -0.166]
  const shellPouchPos = new Vec3(-0.052, -0.22, -0.08);

  const { key, offset, sample } = makeKeyHelpers();
  const kForend = key(supportQ, [-0.012, -0.008, -0.394]);
  const kForendBack = offset(kForend, 0, 0, dims.STROKE);

  const shellGripQ = quatEuler(0.28, 0.12, Math.PI * 0.46);
  const kShellPouch = key(shellGripQ, [-0.052, -0.22, -0.08], new Vec3(0, -0.015, -0.055));
  const kShellApproach = key(shellGripQ, [-0.01, -0.042, -0.155], new Vec3(0, -0.015, -0.055));
  const kShellSeat = key(shellGripQ, [0, -0.004, -0.178], new Vec3(0, -0.015, -0.055));

  const SHELL_LOOP_DUR = 0.44;
  const SHELL_SEAT_AT = 0.25;
  const SHELL_KEYS = [
    [0, kShellPouch],
    [0.14, kShellApproach],
    [SHELL_SEAT_AT, kShellSeat],
    [0.32, kShellApproach],
    [SHELL_LOOP_DUR, kShellPouch],
  ];

  const T_DRAW = 0.94, T_DRAW_RACK = 0.34, T_DRAW_BACK = 0.50, T_DRAW_FWD = 0.68, T_HOLSTER = 0.42;
  const DRAW_KEYS = [
    [0, kForend], [T_DRAW_RACK, kForend], [T_DRAW_BACK, kForendBack],
    [0.55, kForendBack], [T_DRAW_FWD, kForend], [T_DRAW, kForend], [9, kForend],
  ];

  const poses = {
    hip: { p: [0.106, -0.124, -0.31], r: [0.032, 0.085, -0.02] },
    ads: { p: [0, -0.101, -0.03], r: [0, 0, 0] },
    sprint: { p: [-0.038, 0.008, 0.035], r: [-0.06, 0.64, 0.28] },
    reload: { p: [-0.024, 0.072, -0.02], r: [0.34, 0.26, -0.78] },
    holster: { p: [0.075, -0.35, 0.11], r: [-0.86, 0.6, 0.55] },
    lower: { p: [-0.012, -0.03, 0.022], r: [-0.22, 0.26, 0.15] },
  };

  const keyPos = new Vec3(), keyQ = new Quaternion(), camQ = new Quaternion();
  const fallbackCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 1000);
  const viewToWorld = makeViewProjector(root, ctx, fallbackCam);
  const muzzleArr = gun.anchors.muzzle.toArray();
  const ejectArr = gun.anchors.eject.toArray();
  const totalTris = countObjectTriangles(root);
  const rand = ctx.rng || Math.random;

  const s = {
    draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
    t: 0, cooldown: 0, dryDone: false, autoReload: -1, reload: null, pump: null,
    lastShot: -9, bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
    bobPhase: 0, bobAmt: 0, finger: 0, flashT: 0, flashDur: 0.055,
    wasGround: true, lastVy: 0, spreadS: 0.028, idleT: 0, inspect: -1,
    ...createSpringBank({ kZ: [420, 26], kP: [320, 22], kY: [280, 20], kR: [280, 19] }),
  };

  const api = {
    name,
    root,
    gun,
    parts,
    ammo: magSize,
    magSize,
    reserve: Infinity,
    state: 'idle',
    ads: 0,
    spread: s.spreadS,
    info: { tris: totalTris },
    magazine: shellPart, // live 12ga shell carrier moved > 20 cm on each shell insert
    leftHand: leftRig.group,
    opticGlass: null,
    objective: null,
    update,
    reset,
    reloadNow,
    cancelReload,
    muzzleWorld: (out = new Vec3()) => viewToWorld(muzzleArr, out),
    isReloading: () => !!s.reload,
    reloadProgress: () => (s.reload ? Math.min(1, s.reload.elapsed / Math.max(0.01, s.reload.totalDur)) : 0),
    reloadDuration: () => (s.reload ? s.reload.totalDur : 0),
    draw: drawNow,
    holster: holsterNow,
    isHolstered: () => s.holstered,
    isHolstering: () => !!s.holster,
    equipState: () => (s.draw ? 'drawing' : s.holster ? 'holstering' : s.holstered ? 'holstered' : s.relaxW > 0.5 ? 'lowered' : 'ready'),
    setWetness(w) {
      const cw = clamp(+w || 0, 0, 1);
      wetUniform.value = cw;
      SHARED_RAIN_WETNESS.value = cw;
    },
    snap(input = {}) {
      s.adsLin = input.ads ? 1 : 0;
      s.adsE = smootherstep(s.adsLin);
      api.ads = s.adsE;
      for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
      s.sprintT = input.sprinting ? 1 : 0;
    },
  };

  function setPumpDisplacement(disp) {
    const d = clamp(disp, 0, dims.STROKE);
    parts.pump.position.z = pumpRestZ + d;
    parts.bolt.position.z = boltRestZ + Math.max(0, d - dims.UNLOCK);
  }

  function restPose() {
    setPumpDisplacement(0);
    shellPart.visible = false;
    shellPart.position.copy(shellGatePos);
    shellPart.quaternion.identity();
    if (parts.hull) parts.hull.visible = false;
    parts.lifter.rotation.x = 0;
    leftRig.group.position.copy(kForend.p);
    leftRig.group.quaternion.copy(kForend.q);
  }

  function reset() {
    Object.assign(s, {
      draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
      cooldown: 0, dryDone: false, autoReload: -1, reload: null, pump: null, wantReload: false,
      lastShot: -9, bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
      flashT: 0, idleT: 0, inspect: -1,
    });
    api.ammo = magSize;
    api.state = 'idle';
    api.ads = 0;
    for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
    restPose();
  }

  function drawNow() {
    if (s.draw || (!s.holstered && !s.holster)) return false;
    const from = s.equipW;
    s.holster = null;
    s.holstered = false;
    s.draw = { t: from * T_DRAW_RACK * 0.999, f: {} };
    ctx.emit?.('weapon:draw', { phase: 'start' });
    return true;
  }

  function holsterNow() {
    if (s.holstered || s.holster) return false;
    if (s.reload) cancelReload();
    s.draw = null;
    s.pump = null;
    s.wantReload = false;
    s.relaxW = 0;
    s.holster = { t: (1 - s.equipW) * T_HOLSTER };
    restPose();
    ctx.emit?.('weapon:holster', { phase: 'start' });
    return true;
  }

  function cancelReload() {
    s.wantReload = false;
    if (!s.reload) return;
    s.reload = null;
    s.reloadW = 0;
    s.rackW = 0;
    restPose();
  }

  function reloadNow() {
    if (s.holstered || s.holster || s.draw || s.reload || api.ammo >= api.magSize || api.reserve <= 0) {
      return false;
    }
    if (s.pump) {
      s.wantReload = true;
      return true;
    }
    const empty = api.ammo <= 0;
    const toLoad = Math.min(api.magSize - api.ammo, api.reserve);
    const totalDur = 0.24 + toLoad * SHELL_LOOP_DUR + (empty ? 0.44 : 0.22);
    s.reload = {
      stage: 'enter',
      t: 0,
      elapsed: 0,
      totalDur,
      empty,
      shellSeated: false,
      rackBackEmitted: false,
      rackFwdEmitted: false,
    };
    s.autoReload = -1;
    ctx.emit?.('weapon:reload', { phase: 'start', empty });
    return true;
  }

  const centerDir = new Vec3(), pelletDir = new Vec3(), muzzle = new Vec3(), hit = new Vec3();
  const eject = new Vec3(), shellVel = new Vec3(), eye = new Vec3();

  function fireBuckshot(input) {
    const cam = ctx.camera || fallbackCam;
    api.ammo--;
    s.lastShot = s.t;
    s.heat = Math.min(1.4, s.heat + 0.14);
    cam.getWorldQuaternion(camQ);
    if (input.eye) eye.copy(input.eye);
    else cam.getWorldPosition(eye);
    api.muzzleWorld(muzzle);

    const cone = api.spread;
    centerDir.set(0, 0, -1).applyQuaternion(camQ);

    // 9 pellets in a tight Full-Choke buckshot cone (1 center + 8 ring pellets)
    for (let p = 0; p < pellets; p++) {
      let a, r;
      if (p === 0) {
        a = rand() * Math.PI * 2;
        r = Math.tan(cone * 0.25) * rand();
      } else {
        a = ((p - 1) / (pellets - 1)) * Math.PI * 2 + (rand() - 0.5) * 0.42;
        r = Math.tan(cone) * (0.45 + 0.55 * Math.sqrt(rand()));
      }
      pelletDir.set(Math.cos(a) * r, Math.sin(a) * r, -1).normalize().applyQuaternion(camQ);
      const pt = ctx.shot?.(eye, pelletDir) || null;
      if (pt) hit.copy(pt);
      else hit.copy(eye).addScaledVector(pelletDir, range);
      ctx.tracer?.(muzzle, hit);
    }

    ctx.emit?.('weapon:fire', { origin: eye, dir: centerDir, muzzle, ads: s.adsE, pellets });

    const k = lerp(1, 0.72, s.adsE) * (input.crouching ? 0.86 : 1);
    ctx.recoil?.(0.032 * k * (0.9 + rand() * 0.2), (rand() - 0.5) * 0.008 * k);
    s.kZ.v += 3.8 * lerp(1, 0.72, s.adsE);
    s.kP.v += 3.6 * k;
    s.kY.v += (rand() - 0.5) * 2.1 * k;
    s.kR.v += (rand() - 0.5) * 2.8 * k;
    s.bloom = Math.min(1, s.bloom + 0.45);

    s.flashT = s.flashDur = 0.052 + rand() * 0.018;
    const u = flash.material.uniforms;
    u.uSeed.value = rand() * 100;
    u.uJet.value = 1.15 + rand() * 0.4;
    flash.rotation.z = (rand() - 0.5) * 0.6;
    const fs = (1.28 + rand() * 0.35) * lerp(1, 0.78, s.adsE);
    flash.scale.set(fs, fs, fs * 1.15);

    // Schedule pump-action stroke ~0.18s after the shot!
    s.pump = { t: 0, delay: 0.18, backAt: 0.31, fwdAt: 0.46, endAt: 0.52, f: {} };
  }

  function update(dt, input = {}) {
    dt = Math.max(0, dt || 0);
    s.t += dt;

    // ---- Draw / Holster
    if (s.draw) {
      const D = s.draw;
      D.t += dt;
      const t = D.t;
      s.equipW = smootherstep(t / T_DRAW_RACK);
      sample(DRAW_KEYS, t, keyPos, keyQ);
      leftRig.group.position.copy(keyPos);
      leftRig.group.quaternion.copy(keyQ);
      let pumpW = 0;
      if (t >= T_DRAW_RACK && t < T_DRAW_BACK) pumpW = smootherstep((t - T_DRAW_RACK) / (T_DRAW_BACK - T_DRAW_RACK));
      else if (t >= T_DRAW_BACK && t < 0.55) pumpW = 1;
      else if (t >= 0.55 && t < T_DRAW_FWD) pumpW = 1 - smootherstep((t - 0.55) / (T_DRAW_FWD - 0.55));
      setPumpDisplacement(dims.STROKE * pumpW);
      if (t >= T_DRAW_BACK && !D.f.back) {
        D.f.back = 1;
        s.bump.v -= 0.25;
        ctx.emit?.('weapon:pump', { phase: 'back' });
      }
      if (t >= T_DRAW_FWD && !D.f.fwd) {
        D.f.fwd = 1;
        s.bump.v += 0.35;
        s.kZ.v -= 0.45;
        ctx.emit?.('weapon:pump', { phase: 'fwd' });
        ctx.emit?.('weapon:draw', { phase: 'rack' });
      }
      if (t >= T_DRAW) {
        s.draw = null;
        s.equipW = 1;
        restPose();
        ctx.emit?.('weapon:draw', { phase: 'done' });
      }
    } else if (s.holster) {
      const H = s.holster;
      H.t += dt;
      s.equipW = 1 - smootherstep(H.t / T_HOLSTER);
      if (H.t >= T_HOLSTER) {
        s.holster = null;
        s.holstered = true;
        s.equipW = 0;
        ctx.emit?.('weapon:holster', { phase: 'done' });
      }
    }

    const equipped = !s.holstered && !s.holster && (!s.draw || s.draw.t > 0.75);
    const fire = !!input.fire && root.visible !== false && equipped;
    if (!fire) s.dryDone = false;

    // ---- Pump-action stroke after firing
    if (s.pump && !s.draw && !s.holster) {
      const P = s.pump;
      P.t += dt;
      let pumpW = 0;
      if (P.t >= P.delay && P.t < P.backAt) {
        pumpW = smootherstep((P.t - P.delay) / (P.backAt - P.delay));
      } else if (P.t >= P.backAt && P.t < P.backAt + 0.04) {
        pumpW = 1;
      } else if (P.t >= P.backAt + 0.04 && P.t < P.fwdAt) {
        pumpW = 1 - smootherstep((P.t - (P.backAt + 0.04)) / (P.fwdAt - (P.backAt + 0.04)));
      }
      setPumpDisplacement(dims.STROKE * pumpW);
      leftRig.group.position.copy(kForend.p).lerp(kForendBack.p, pumpW);
      leftRig.group.quaternion.copy(kForend.q);
      parts.lifter.rotation.x = -0.18 * Math.sin(Math.PI * pumpW);

      if (P.t >= P.backAt && !P.f.back) {
        P.f.back = 1;
        s.bump.v -= 0.28;
        s.kZ.v += 0.45;
        ctx.emit?.('weapon:pump', { phase: 'back' });
        if (ctx.shell) {
          const cam = ctx.camera || fallbackCam;
          cam.getWorldQuaternion(camQ);
          viewToWorld(ejectArr, eject);
          shellVel.set(2.0 + rand() * 0.9, 1.3 + rand() * 0.6, 0.35 - rand() * 0.4).applyQuaternion(camQ);
          if (input.vel) shellVel.add(input.vel);
          ctx.shell(eject, shellVel);
        }
      }
      if (P.t >= P.fwdAt && !P.f.fwd) {
        P.f.fwd = 1;
        s.bump.v += 0.38;
        s.kZ.v -= 0.55;
        ctx.emit?.('weapon:pump', { phase: 'fwd' });
      }
      if (P.t >= P.endAt) {
        s.pump = null;
        restPose();
        if (s.wantReload) {
          s.wantReload = false;
          reloadNow();
        }
      }
    }

    // ---- Per-shell interruptible reload
    if (s.reload) {
      // Pulling fire when ammo > 0 cleanly interrupts reload so the player shoots immediately!
      if (fire && api.ammo > 0) {
        s.reload = null;
        s.reloadW = 0;
        s.rackW = 0;
        s.cooldown = 0;
        restPose();
        ctx.emit?.('weapon:reload', { phase: 'interrupted', ammo: api.ammo });
      } else {
        const R = s.reload;
        R.t += dt;
        R.elapsed += dt;

        if (R.stage === 'enter') {
          s.reloadW = smootherstep(R.t / 0.24);
          leftRig.group.position.copy(kForend.p).lerp(kShellPouch.p, s.reloadW);
          leftRig.group.quaternion.copy(kForend.q).slerp(kShellPouch.q, s.reloadW);
          if (R.t >= 0.24) {
            R.stage = 'shell';
            R.t = 0;
            R.shellSeated = false;
          }
        } else if (R.stage === 'shell') {
          s.reloadW = 1;
          sample(SHELL_KEYS, R.t, keyPos, keyQ);
          leftRig.group.position.copy(keyPos);
          leftRig.group.quaternion.copy(keyQ);

          if (R.t < SHELL_SEAT_AT) {
            shellPart.visible = true;
            const sw = smootherstep(R.t / SHELL_SEAT_AT);
            shellPart.position.copy(shellPouchPos).lerp(shellGatePos, sw);
            parts.lifter.rotation.x = -0.26 * smoothstep(0.12, SHELL_SEAT_AT, R.t);
          } else {
            shellPart.visible = false;
            shellPart.position.copy(shellGatePos);
            parts.lifter.rotation.x = -0.26 * (1 - smoothstep(SHELL_SEAT_AT, SHELL_SEAT_AT + 0.08, R.t));
            if (!R.shellSeated) {
              R.shellSeated = true;
              if (api.ammo < api.magSize && api.reserve > 0) {
                api.ammo++;
                api.reserve--;
              }
              s.bump.v += 0.42;
              ctx.emit?.('weapon:reload', { phase: 'shell', ammo: api.ammo, magSize: api.magSize });
            }
          }

          if (R.t >= SHELL_LOOP_DUR) {
            if (api.ammo < api.magSize && api.reserve > 0) {
              R.t -= SHELL_LOOP_DUR;
              R.shellSeated = false;
            } else {
              R.stage = R.empty ? 'rack' : 'exit';
              R.t = 0;
            }
          }
        } else if (R.stage === 'rack') {
          const dur = 0.44;
          s.reloadW = 1 - smootherstep((R.t - 0.16) / 0.28);
          s.rackW = Math.sin(Math.PI * saturate(R.t / dur));
          let pumpW = 0;
          if (R.t < 0.08) {
            const w = smootherstep(R.t / 0.08);
            leftRig.group.position.copy(kShellPouch.p).lerp(kForend.p, w);
            leftRig.group.quaternion.copy(kShellPouch.q).slerp(kForend.q, w);
          } else {
            if (R.t < 0.22) pumpW = smootherstep((R.t - 0.08) / 0.14);
            else if (R.t < 0.26) pumpW = 1;
            else if (R.t < 0.39) pumpW = 1 - smootherstep((R.t - 0.26) / 0.13);
            setPumpDisplacement(dims.STROKE * pumpW);
            leftRig.group.position.copy(kForend.p).lerp(kForendBack.p, pumpW);
            leftRig.group.quaternion.copy(kForend.q);
          }
          if (R.t >= 0.22 && !R.rackBackEmitted) {
            R.rackBackEmitted = true;
            s.bump.v -= 0.26;
            ctx.emit?.('weapon:pump', { phase: 'back' });
          }
          if (R.t >= 0.39 && !R.rackFwdEmitted) {
            R.rackFwdEmitted = true;
            s.bump.v += 0.42;
            s.kZ.v -= 0.55;
            ctx.emit?.('weapon:pump', { phase: 'fwd' });
          }
          if (R.t >= dur) {
            s.reload = null;
            s.reloadW = 0;
            s.rackW = 0;
            restPose();
            ctx.emit?.('weapon:reload', { phase: 'done' });
          }
        } else {
          const dur = 0.22;
          const w = smootherstep(R.t / dur);
          s.reloadW = 1 - w;
          leftRig.group.position.copy(kShellPouch.p).lerp(kForend.p, w);
          leftRig.group.quaternion.copy(kShellPouch.q).slerp(kForend.q, w);
          if (R.t >= dur) {
            s.reload = null;
            s.reloadW = 0;
            restPose();
            ctx.emit?.('weapon:reload', { phase: 'done' });
          }
        }
      }
    }

    const wantsSprint = !!input.sprinting && !fire && !input.ads && !s.reload && !s.pump;
    s.sprintT = damp(s.sprintT, wantsSprint ? 1 : 0, 8.5, dt);

    if (input.reload && equipped) reloadNow();
    if (s.autoReload >= 0) {
      s.autoReload -= dt;
      if (s.autoReload < 0) reloadNow();
    }

    s.cooldown -= dt;
    const canFire = !s.reload && !s.pump && s.sprintT < 0.45 && s.relaxW < 0.3;
    if (fire && canFire) {
      if (api.ammo > 0) {
        if (s.cooldown <= 0) {
          fireBuckshot(input);
          s.cooldown = fireCadence;
        }
      } else if (!s.dryDone) {
        s.dryDone = true;
        ctx.emit?.('weapon:dry', {});
        s.bump.v -= 0.1;
        if (api.reserve > 0) s.autoReload = 0.32;
      }
    }
    if (s.cooldown < 0) s.cooldown = 0;
    s.bloom = Math.max(0, s.bloom - dt * 1.4);
    s.heat = Math.max(0, s.heat - dt * 0.2);

    const adsHeld = !!input.ads && !s.reload && s.sprintT < 0.35 && equipped;
    s.adsLin = clamp(s.adsLin + (adsHeld ? dt : -dt) / 0.22, 0, 1);
    s.adsE = smootherstep(s.adsLin);
    api.ads = s.adsE;

    // Full-choke buckshot cone
    const speed = input.speed || 0;
    const moving = saturate(speed / 6);
    const targetSpread = lerp(0.029, 0.0185, s.adsE) + moving * 0.004 + s.bloom * 0.005;
    s.spreadS = damp(s.spreadS, targetSpread, 16, dt);
    api.spread = s.spreadS;

    const look = input.look || { dx: 0, dy: 0 };
    if (fire || input.ads || s.reload || s.pump || speed > 0.2 || Math.abs(look.dx || 0) + Math.abs(look.dy || 0) > 2e-3 || s.sprintT > 0.1) {
      s.idleT = 0;
      if (s.inspect >= 0) s.inspect = Math.max(s.inspect, 2.9);
    } else s.idleT += dt;
    if (s.inspect < 0 && s.idleT > 24) s.inspect = 0;

    const quiet = !input.fire && !input.ads && !s.reload && !s.pump && !s.draw && s.inspect < 0;
    s.quietT = quiet ? s.quietT + dt : 0;
    const relaxTarget = s.quietT > 3.5 && s.sprintT < 0.5 ? 1 : 0;
    s.relaxW = damp(s.relaxW, relaxTarget, relaxTarget > s.relaxW ? 1.4 : 24, dt);

    api.state = s.reload ? 'reloading'
      : s.inspect >= 0 ? 'inspect'
      : s.sprintT > 0.5 ? 'sprinting'
      : (s.t - s.lastShot < 0.2 || s.pump) ? 'firing'
      : 'idle';

    s.finger = damp(s.finger, fire && canFire ? 1 : 0, 28, dt);
    rightRig.setTriggerFinger(s.finger);
    parts.trigger.rotation.x = -0.24 * s.finger;

    const fu = flash.material.uniforms;
    s.flashT -= dt;
    fu.uInt.value = s.flashT > 0 ? 11.5 * Math.sqrt(Math.max(0, s.flashT / s.flashDur)) : 0;
    fu.uHeat.value = saturate((s.heat - 0.4) / 0.8) * 2.4;
    flash.visible = fu.uInt.value > 0 || fu.uHeat.value > 0.02;

    if (laserFx) {
      laserFx.setIntensity(equipped ? lerp(0.95, 0.35, s.sprintT) * (1 - 0.65 * s.reloadW) : 0);
    }

    stepMotionAndPose(s, dt, input, poses, root, rand);
  }

  reset();
  return api;
}

// ============================================================================
// 5. STRIX 9 (18-rd tactical 9mm pistol, 0.48s draw, slide lock on empty)
// ============================================================================

export function createStrix9Viewmodel(ctx = {}) {
  const name = 'STRIX 9';
  const magSize = 18;
  const rpm = 380;
  const range = 180;
  const reloadTime = 1.48;
  const reloadEmptyTime = 1.78;

  const wetUniform = { value: SHARED_RAIN_WETNESS.value };
  const root = new THREE.Group();
  root.name = 'viewmodel-strix9';

  const gun = buildProceduralWeapon(
    'pistol',
    { optic: 'reflex', muzzle: 'comp', underbarrel: 'laser', magazine: 'ext', camo: 'carbon' },
    { wetUniform }
  );
  root.add(gun.root);
  upgradeAttachmentOptic(gun, { reticle: 'microdot', color: [1, 0.16, 0.07] });

  let laserFx = null;
  if (gun.anchors.laser) {
    laserFx = buildTacticalLaser(gun.anchors.laser, { color: 0x38ff7a, length: 2.6 });
    root.add(laserFx.group);
  }

  const flash = buildMuzzleFlash({ suppressed: false });
  flash.position.copy(gun.anchors.muzzle);
  flash.visible = false;
  root.add(flash);

  // Two-handed thumbs-forward gloved pistol grip!
  const gloveMat = makeGloveMaterial(ctx, wetUniform);
  const gripQ = quatEuler(-0.26, 0, 0).multiply(quatEuler(0, 0, -Math.PI / 2));
  const rightRig = createRightHandRig({
    gripPos: [0, -0.038, -0.002],
    gripQuat: gripQ,
    gloveMaterial: gloveMat,
  });
  root.add(rightRig.group);

  // Support hand wraps right hand fingers with forward-pointing support thumb along frame
  const supportQ = quatEuler(-0.18, 0.12, Math.PI * 0.48);
  const leftRig = createLeftHandRig({
    supportQuat: supportQ,
    fingers: [
      [1.35, 1.48, 0.78, 0.03],
      [1.38, 1.5, 0.78, 0],
      [1.38, 1.5, 0.78, -0.02],
      [1.42, 1.48, 0.78, -0.05],
    ],
    thumb: [
      dirInFrame(supportQ, [0.08, 0.18, -0.98], true),
      dirInFrame(supportQ, [0.04, 0.06, -0.99], true),
      dirInFrame(supportQ, [0, 0, -1], true),
    ],
    forearm: dirInFrame(supportQ, [-0.34, -0.44, 0.83], true),
    gloveMaterial: gloveMat,
  });
  root.add(leftRig.group);

  const { parts, dims } = gun;
  const magazine = parts.mag;
  const magHome = magazine.userData.rest.clone();
  const magRelRestX = parts.magRelease.userData.rest.x;

  const { key, offset, sample } = makeKeyHelpers();
  const kSupportGrip = key(supportQ, [-0.017, -0.038, -0.022], new Vec3(0, -0.014, -0.052));

  // Overhand slide rack on fast 0.48s draw
  const rackQ = quatEuler(-0.32, 0.25, -Math.PI * 0.46);
  const kSlideGrab = key(rackQ, [-0.012, 0.032, -0.012], new Vec3(0, -0.018, -0.085));
  const kSlidePulled = offset(kSlideGrab, 0, 0, dims.TRAVEL);

  // Angled magazine extraction along 16.5° pistol grip channel
  const magRake = Math.tan(16.5 * Math.PI / 180);
  const magGripQ = quatEuler(0.24, 0, Math.PI * 0.5);
  const kMagBase = key(magGripQ, [-0.01, -0.118, 0.012], new Vec3(0, -0.015, -0.055));
  const kMagOut = offset(kMagBase, -0.012, -0.09, 0.09 * magRake);
  const kMagAway = offset(kMagBase, -0.048, -0.24, 0.08, magGripQ.clone().multiply(quatEuler(-0.42, 0, 0.2)));
  const kMagAlign = offset(kMagBase, 0, -0.075, 0.075 * magRake);

  // Slide-stop thumb release on empty reload
  const kSlideStop = key(supportQ, [-0.02, -0.016, -0.042], new Vec3(0, -0.014, -0.052));

  const T_MAG_OUT = 0.28, T_MAG_IN = 1.02, T_SLIDE_STOP = 1.38;
  const TACTICAL_KEYS = [
    [0, kSupportGrip], [0.16, kMagBase], [T_MAG_OUT, kMagOut],
    [0.54, kMagAway], [0.68, kMagAway], [0.90, kMagAlign],
    [T_MAG_IN, kMagBase], [1.14, kMagBase], [1.44, kSupportGrip], [9, kSupportGrip],
  ];
  const EMPTY_KEYS = [
    ...TACTICAL_KEYS.slice(0, 8),
    [1.30, kSlideStop],
    [T_SLIDE_STOP, offset(kSlideStop, 0.004, -0.008, 0)],
    [1.48, kSupportGrip],
    [reloadEmptyTime, kSupportGrip],
    [9, kSupportGrip],
  ];

  // Fast 0.48s draw with crisp overhand slide rack!
  const T_DRAW = 0.48, T_DRAW_RACK = 0.14, T_DRAW_BACK = 0.25, T_DRAW_REL = 0.29, T_HOLSTER = 0.28;
  const DRAW_KEYS = [
    [0, kSlideGrab], [T_DRAW_RACK, kSlideGrab], [T_DRAW_BACK, kSlidePulled],
    [T_DRAW_REL, kSlidePulled], [0.35, kSlideGrab], [T_DRAW, kSupportGrip], [9, kSupportGrip],
  ];

  const poses = {
    hip: { p: [0.068, -0.078, -0.285], r: [0.025, 0.062, -0.02] },
    ads: { p: [0, -0.0501, -0.24], r: [0, 0, 0] },
    sprint: { p: [0.015, -0.055, 0.04], r: [0.38, 0.24, -0.18] },
    reload: { p: [-0.022, 0.052, 0.015], r: [0.32, 0.28, -0.56] },
    holster: { p: [0.08, -0.28, 0.12], r: [-0.95, 0.4, 0.35] },
    lower: { p: [-0.008, -0.024, 0.02], r: [-0.2, 0.2, 0.12] },
  };

  const magGripInv = magGripQ.clone().invert();
  const keyPos = new Vec3(), keyQ = new Quaternion(), magQ = new Quaternion(), camQ = new Quaternion();
  const fallbackCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 1000);
  const viewToWorld = makeViewProjector(root, ctx, fallbackCam);
  const muzzleArr = gun.anchors.muzzle.toArray();
  const ejectArr = gun.anchors.eject.toArray();
  const totalTris = countObjectTriangles(root);
  const rand = ctx.rng || Math.random;

  const s = {
    draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
    t: 0, cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9,
    bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
    bobPhase: 0, bobAmt: 0, finger: 0, slideT: 9, slideLocked: false, wasFire: false,
    flashT: 0, flashDur: 0.032, wasGround: true, lastVy: 0, spreadS: 0.011, idleT: 0, inspect: -1,
    ...createSpringBank({ kZ: [680, 36], kP: [520, 30], kY: [380, 26], kR: [380, 24] }),
  };

  const api = {
    name,
    root,
    gun,
    parts,
    ammo: magSize,
    magSize,
    reserve: Infinity,
    state: 'idle',
    ads: 0,
    spread: s.spreadS,
    info: { tris: totalTris },
    magazine,
    leftHand: leftRig.group,
    opticGlass: null,
    objective: null,
    isSlideLocked: () => s.slideLocked,
    update,
    reset,
    reloadNow,
    cancelReload,
    muzzleWorld: (out = new Vec3()) => viewToWorld(muzzleArr, out),
    isReloading: () => !!s.reload,
    reloadProgress: () => (s.reload ? Math.min(1, s.reload.t / s.reload.T) : 0),
    reloadDuration: () => (s.reload ? s.reload.T : 0),
    draw: drawNow,
    holster: holsterNow,
    isHolstered: () => s.holstered,
    isHolstering: () => !!s.holster,
    equipState: () => (s.draw ? 'drawing' : s.holster ? 'holstering' : s.holstered ? 'holstered' : s.relaxW > 0.5 ? 'lowered' : 'ready'),
    setWetness(w) {
      const cw = clamp(+w || 0, 0, 1);
      wetUniform.value = cw;
      SHARED_RAIN_WETNESS.value = cw;
    },
    snap(input = {}) {
      s.adsLin = input.ads ? 1 : 0;
      s.adsE = smootherstep(s.adsLin);
      api.ads = s.adsE;
      for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
      s.sprintT = input.sprinting ? 1 : 0;
    },
  };

  function syncMagVisuals(ammoCount) {
    if (parts.magRounds) parts.magRounds.visible = ammoCount > 0;
    if (parts.magFollower) parts.magFollower.visible = ammoCount <= 1;
    if (parts.chamberRound) parts.chamberRound.visible = ammoCount > 0;
  }

  function restPose() {
    magazine.visible = true;
    magazine.position.copy(magHome);
    magazine.quaternion.identity();
    leftRig.group.position.copy(kSupportGrip.p);
    leftRig.group.quaternion.copy(kSupportGrip.q);
    parts.magRelease.position.x = magRelRestX;
  }

  function reset() {
    Object.assign(s, {
      draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
      cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9,
      bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0,
      slideT: 9, slideLocked: false, wasFire: false, flashT: 0, idleT: 0, inspect: -1,
    });
    api.ammo = magSize;
    api.state = 'idle';
    api.ads = 0;
    for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
    gun.setSlide(0);
    parts.slideStop.rotation.x = 0;
    syncMagVisuals(api.ammo);
    restPose();
  }

  function drawNow() {
    if (s.draw || (!s.holstered && !s.holster)) return false;
    const from = s.equipW;
    s.holster = null;
    s.holstered = false;
    s.draw = { t: from * T_DRAW_RACK * 0.999, f: {} };
    ctx.emit?.('weapon:draw', { phase: 'start' });
    return true;
  }

  function holsterNow() {
    if (s.holstered || s.holster) return false;
    if (s.reload) cancelReload();
    s.draw = null;
    s.relaxW = 0;
    s.holster = { t: (1 - s.equipW) * T_HOLSTER };
    restPose();
    ctx.emit?.('weapon:holster', { phase: 'start' });
    return true;
  }

  function cancelReload() {
    if (!s.reload) return;
    s.reload = null;
    s.reloadW = 0;
    s.rackW = 0;
    syncMagVisuals(api.ammo);
    restPose();
  }

  function reloadNow() {
    if (s.holstered || s.holster || s.draw || s.reload || api.ammo >= api.magSize || api.reserve <= 0) {
      return false;
    }
    const empty = api.ammo <= 0;
    s.reload = { t: 0, T: empty ? reloadEmptyTime : reloadTime, empty, f: {} };
    s.autoReload = -1;
    ctx.emit?.('weapon:reload', { phase: 'start', empty });
    return true;
  }

  const shotDir = new Vec3(), muzzle = new Vec3(), hit = new Vec3(), eject = new Vec3(), shellVel = new Vec3(), eye = new Vec3();

  function fireRound(input) {
    const cam = ctx.camera || fallbackCam;
    api.ammo--;
    s.burst++;
    s.lastShot = s.t;
    s.heat = Math.min(1.2, s.heat + 0.06);
    cam.getWorldQuaternion(camQ);

    const a = rand() * Math.PI * 2, r = Math.tan(api.spread) * Math.sqrt(rand());
    shotDir.set(Math.cos(a) * r, Math.sin(a) * r, -1).normalize().applyQuaternion(camQ);
    if (input.eye) eye.copy(input.eye);
    else cam.getWorldPosition(eye);
    const point = ctx.shot?.(eye, shotDir) || null;
    if (point) hit.copy(point);
    else hit.copy(eye).addScaledVector(shotDir, range);
    api.muzzleWorld(muzzle);
    ctx.tracer?.(muzzle, hit);

    if (ctx.shell) {
      viewToWorld(ejectArr, eject);
      shellVel.set(1.9 + rand() * 0.9, 1.5 + rand() * 0.7, 0.4 - rand() * 0.4).applyQuaternion(camQ);
      if (input.vel) shellVel.add(input.vel);
      ctx.shell(eject, shellVel);
    }
    ctx.emit?.('weapon:fire', { origin: eye, dir: shotDir, muzzle, ads: s.adsE });

    const k = lerp(1, 0.62, s.adsE) * (input.crouching ? 0.85 : 1);
    ctx.recoil?.(0.0092 * k * (0.88 + rand() * 0.24), (rand() - 0.5) * 0.0038 * k);

    s.kZ.v += 1.65 * lerp(1, 0.65, s.adsE);
    s.kP.v += 2.35 * k;
    s.kY.v += (rand() - 0.5) * 1.1 * k;
    s.kR.v += (rand() - 0.5) * 1.8 * k;
    s.bloom = Math.min(1, s.bloom + 0.22);

    s.flashT = s.flashDur = 0.03 + rand() * 0.012;
    const u = flash.material.uniforms;
    u.uSeed.value = rand() * 100;
    u.uJet.value = 0.75 + rand() * 0.5;
    flash.rotation.z = (rand() - 0.5) * 0.5;
    const fs = (0.62 + rand() * 0.28) * lerp(1, 0.68, s.adsE);
    flash.scale.set(fs, fs, fs);

    s.slideT = 0;
    syncMagVisuals(api.ammo);
    if (api.ammo <= 0) s.slideLocked = true;
  }

  function update(dt, input = {}) {
    dt = Math.max(0, dt || 0);
    s.t += dt;
    let drawRack = 0;
    if (s.draw) {
      const D = s.draw;
      D.t += dt;
      const t = D.t;
      s.equipW = smootherstep(t / T_DRAW_RACK);
      sample(DRAW_KEYS, t, keyPos, keyQ);
      leftRig.group.position.copy(keyPos);
      leftRig.group.quaternion.copy(keyQ);
      if (t >= T_DRAW_RACK) {
        drawRack = t < T_DRAW_BACK
          ? smootherstep((t - T_DRAW_RACK) / (T_DRAW_BACK - T_DRAW_RACK))
          : t < T_DRAW_REL ? 1 : Math.max(0, 1 - (t - T_DRAW_REL) / 0.032);
      }
      if (t >= T_DRAW_REL && !D.f.rack) {
        D.f.rack = 1;
        s.bump.v += 0.28;
        s.kZ.v -= 0.42;
        ctx.emit?.('weapon:draw', { phase: 'rack' });
      }
      if (t >= T_DRAW) {
        s.draw = null;
        s.equipW = 1;
        restPose();
        ctx.emit?.('weapon:draw', { phase: 'done' });
      }
    } else if (s.holster) {
      const H = s.holster;
      H.t += dt;
      s.equipW = 1 - smootherstep(H.t / T_HOLSTER);
      if (H.t >= T_HOLSTER) {
        s.holster = null;
        s.holstered = true;
        s.equipW = 0;
        ctx.emit?.('weapon:holster', { phase: 'done' });
      }
    }

    // Fast 0.48s draw means Strix 9 is ready at ~0.38s!
    const equipped = !s.holstered && !s.holster && (!s.draw || s.draw.t > 0.38);
    const fire = !!input.fire && root.visible !== false && equipped;
    if (!fire) s.dryDone = false;
    const wantsSprint = !!input.sprinting && !fire && !input.ads && !s.reload;
    s.sprintT = damp(s.sprintT, wantsSprint ? 1 : 0, 11, dt);

    if (input.reload && equipped) reloadNow();
    if (s.autoReload >= 0) {
      s.autoReload -= dt;
      if (s.autoReload < 0) reloadNow();
    }

    if (s.reload) {
      const R = s.reload;
      R.t += dt;
      const t = R.t;
      const phase = (pName, at) => (t >= at && !R.f[pName]
        ? ((R.f[pName] = 1), ctx.emit?.('weapon:reload', { phase: pName, empty: R.empty }), true)
        : false);

      parts.magRelease.position.x = magRelRestX + 0.0018 * smoothstep(0.14, 0.26, t) * (1 - smoothstep(0.30, 0.40, t));
      if (phase('magout', T_MAG_OUT)) s.bump.v -= 0.2;
      if (t > 0.62 && !R.f.fresh) {
        R.f.fresh = 1;
        syncMagVisuals(magSize);
      }
      if (phase('magin', T_MAG_IN)) {
        s.bump.v += 0.46;
        const added = Math.min(api.magSize - api.ammo, api.reserve);
        api.ammo += added;
        api.reserve -= added;
        syncMagVisuals(api.ammo);
        if (!R.empty) s.slideLocked = false;
      }
      if (R.empty && phase('bolt', T_SLIDE_STOP)) {
        s.slideLocked = false;
        s.bump.v += 0.35;
        s.kZ.v -= 0.5;
      }

      sample(R.empty ? EMPTY_KEYS : TACTICAL_KEYS, t, keyPos, keyQ);
      leftRig.group.position.copy(keyPos);
      leftRig.group.quaternion.copy(keyQ);
      if (t >= T_MAG_OUT && t < T_MAG_IN) {
        magQ.copy(keyQ).multiply(magGripInv);
        magazine.quaternion.copy(magQ);
        magazine.position.copy(magHome).sub(kMagBase.p).applyQuaternion(magQ).add(keyPos);
      } else {
        magazine.quaternion.identity();
        magazine.position.copy(magHome);
      }

      const inW = smootherstep(t / 0.2);
      const outW = 1 - smootherstep((t - (R.T - 0.3)) / 0.26);
      s.reloadW = Math.min(inW, outW);
      s.rackW = R.empty ? smootherstep((t - 1.18) / 0.18) * outW : 0;
      if (t >= R.T) {
        s.reload = null;
        s.reloadW = 0;
        s.rackW = 0;
        ctx.emit?.('weapon:reload', { phase: 'done' });
        restPose();
      }
    }

    s.cooldown -= dt;
    const canFire = !s.reload && s.sprintT < 0.45 && s.relaxW < 0.3;
    if (fire && canFire) {
      if (api.ammo > 0) {
        // Snappy semi-auto on trigger press edge + controlled ~380 RPM cadence if held
        if (!s.wasFire && s.cooldown < 0.045) s.cooldown = 0;
        let n = 0;
        while (s.cooldown <= 0 && api.ammo > 0 && n < 2) {
          fireRound(input);
          s.cooldown += 60 / rpm;
          n++;
        }
      } else if (!s.dryDone) {
        s.dryDone = true;
        ctx.emit?.('weapon:dry', {});
        s.bump.v -= 0.08;
        if (api.reserve > 0) s.autoReload = 0.28;
      }
    }
    s.wasFire = fire;
    if (s.cooldown < 0) s.cooldown = Math.max(s.cooldown, -1e-3);
    if (s.t - s.lastShot > 0.24) s.burst = 0;
    s.bloom = Math.max(0, s.bloom - dt * 2.1);
    s.heat = Math.max(0, s.heat - dt * 0.25);

    const adsHeld = !!input.ads && !s.reload && s.sprintT < 0.35 && equipped;
    s.adsLin = clamp(s.adsLin + (adsHeld ? dt : -dt) / 0.12, 0, 1);
    s.adsE = smootherstep(s.adsLin);
    api.ads = s.adsE;

    const speed = input.speed || 0;
    const moving = saturate(speed / 6);
    const onGround = input.onGround !== false;
    const targetSpread = lerp(0.011, 0.0013, s.adsE)
      + moving * lerp(0.009, 0.0028, s.adsE)
      + s.bloom * lerp(0.006, 0.002, s.adsE)
      + (onGround ? 0 : 0.015);
    s.spreadS = damp(s.spreadS, targetSpread, 22, dt);
    api.spread = s.spreadS;

    const look = input.look || { dx: 0, dy: 0 };
    if (fire || input.ads || s.reload || speed > 0.2 || Math.abs(look.dx || 0) + Math.abs(look.dy || 0) > 2e-3 || s.sprintT > 0.1) {
      s.idleT = 0;
      if (s.inspect >= 0) s.inspect = Math.max(s.inspect, 2.9);
    } else s.idleT += dt;
    if (s.inspect < 0 && s.idleT > 24) s.inspect = 0;

    const quiet = !input.fire && !input.ads && !s.reload && !s.draw && s.inspect < 0;
    s.quietT = quiet ? s.quietT + dt : 0;
    const relaxTarget = s.quietT > 3.5 && s.sprintT < 0.5 ? 1 : 0;
    s.relaxW = damp(s.relaxW, relaxTarget, relaxTarget > s.relaxW ? 1.4 : 24, dt);

    api.state = s.reload ? 'reloading'
      : s.inspect >= 0 ? 'inspect'
      : s.sprintT > 0.5 ? 'sprinting'
      : s.t - s.lastShot < 0.12 ? 'firing'
      : 'idle';

    // Reciprocating slide + tilting barrel + slide lock on ammo === 0
    s.slideT += dt;
    const slideDur = 0.068;
    let slideW = s.slideT < slideDur ? Math.sin(Math.PI * s.slideT / slideDur) : 0;
    if (s.slideLocked && s.slideT > slideDur * 0.5) slideW = Math.max(slideW, 0.948);
    const totalSlide = dims.TRAVEL * Math.max(slideW, drawRack);
    gun.setSlide(totalSlide);
    parts.slideStop.rotation.x = damp(parts.slideStop.rotation.x, s.slideLocked ? -0.11 : 0, 28, dt);

    s.finger = damp(s.finger, fire && canFire ? 1 : 0, 34, dt);
    rightRig.setTriggerFinger(s.finger);
    parts.trigger.rotation.x = -0.24 * s.finger;
    if (parts.trigBlade) parts.trigBlade.rotation.x = -0.18 * s.finger;

    const fu = flash.material.uniforms;
    s.flashT -= dt;
    fu.uInt.value = s.flashT > 0 ? 7.8 * Math.sqrt(Math.max(0, s.flashT / s.flashDur)) : 0;
    fu.uHeat.value = saturate((s.heat - 0.45) / 0.8) * 1.9;
    flash.visible = fu.uInt.value > 0 || fu.uHeat.value > 0.02;

    if (laserFx) {
      laserFx.setIntensity(equipped ? lerp(0.95, 0.4, s.sprintT) * (1 - 0.6 * s.reloadW) : 0);
    }

    stepMotionAndPose(s, dt, input, poses, root, rand);
  }

  reset();
  return api;
}

// ============================================================================
// SURFACE_WEAPONS Descriptors
// ============================================================================

export const KR7_SPEC = {
  id: 'KR7',
  name: 'KR-7 CARBINE',
  short: 'KR-7',
  kind: 'viewmodel',
  create: createKr7CarbineViewmodel,
  viewFov: 54,
  adsFov: 49,
  magSize: 30,
  hasScope: false,
  muzzle: [0, 0.046, -0.508],
  eject: [0.019, 0.049, -0.096],
  tracerColor: 0xffcf7c,
  tracerRadius: 0.014,
  tracerLife: 0.06,
  sfx: { shot: 'kr7_shot' },
  spec: {
    name: 'KR-7 CARBINE',
    muzzle: [0, 0.046, -0.508],
    eject: [0.019, 0.049, -0.096],
    sightY: 0.115,
  },
};

export const KR7_VANTAGE_SPEC = {
  id: 'KR7_VANTAGE',
  name: 'KR-7 VANTAGE',
  short: 'VANTAGE',
  kind: 'viewmodel',
  create: createKr7VantageViewmodel,
  viewFov: 52,
  adsFov: 38,
  scopeFov: 4.2,
  magSize: 20,
  hasScope: true,
  muzzle: [0, 0.046, -0.62],
  eject: [0.019, 0.049, -0.096],
  tracerColor: 0xffe2a8,
  tracerRadius: 0.013,
  tracerLife: 0.075,
  sfx: { shot: 'suppressed_shot' },
  spec: {
    name: 'KR-7 VANTAGE',
    muzzle: [0, 0.046, -0.62],
    eject: [0.019, 0.049, -0.096],
    sightY: 0.117,
  },
};

export const VESPER9_SPEC = {
  id: 'VESPER9',
  name: 'VESPER 9',
  short: 'VESPER 9',
  kind: 'viewmodel',
  create: createVesper9Viewmodel,
  viewFov: 55,
  adsFov: 53,
  magSize: 36,
  hasScope: false,
  muzzle: [0, 0.036, -0.5025],
  eject: [0.02, 0.0425, -0.094],
  tracerColor: 0xffd896,
  tracerRadius: 0.012,
  tracerLife: 0.052,
  sfx: { shot: 'vesper_shot' },
  spec: {
    name: 'VESPER 9',
    muzzle: [0, 0.036, -0.5025],
    eject: [0.02, 0.0425, -0.094],
    sightY: 0.1175,
  },
};

export const M12_SPEC = {
  id: 'M12',
  name: 'M12 BREACHER',
  short: 'M12',
  kind: 'viewmodel',
  create: createM12BreacherViewmodel,
  viewFov: 54,
  adsFov: 52,
  magSize: 8,
  pellets: 9,
  hasScope: false,
  muzzle: [0, 0.042, -0.683],
  eject: [0.0225, 0.042, -0.17],
  tracerColor: 0xffb86c,
  tracerRadius: 0.01,
  tracerLife: 0.048,
  sfx: {
    shot: 'shotgun_shot',
    pumpBack: 'shotgun_pump_back',
    pumpFwd: 'shotgun_pump_fwd',
    shell: 'shotgun_shell',
  },
  spec: {
    name: 'M12 BREACHER',
    muzzle: [0, 0.042, -0.683],
    eject: [0.0225, 0.042, -0.17],
    sightY: 0.101,
  },
};

export const STRIX9_SPEC = {
  id: 'STRIX9',
  name: 'STRIX 9',
  short: 'STRIX 9',
  kind: 'viewmodel',
  create: createStrix9Viewmodel,
  viewFov: 56,
  adsFov: 54,
  magSize: 18,
  hasScope: false,
  muzzle: [0, 0.0235, -0.1935],
  eject: [0.0105, 0.0315, -0.039],
  tracerColor: 0xffd38a,
  tracerRadius: 0.011,
  tracerLife: 0.05,
  sfx: {
    shot: 'pistol_shot',
    slide: 'pistol_slide',
  },
  spec: {
    name: 'STRIX 9',
    muzzle: [0, 0.0235, -0.1935],
    eject: [0.0105, 0.0315, -0.039],
    sightY: 0.0501,
  },
};

export const ARSENAL_WEAPONS = [
  KR7_SPEC,
  KR7_VANTAGE_SPEC,
  VESPER9_SPEC,
  M12_SPEC,
  STRIX9_SPEC,
];
