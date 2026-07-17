// Entry point: renderer, the state machine (space flight → fly-to → landing →
// walking → takeoff → warp), camera-relative rendering (the camera never
// leaves the origin — the universe moves around it, so float precision holds
// from interstellar space down to boot level), and the ambience pass
// (atmosphere, fog, day/night, star dimming).

import * as THREE from 'three';
import { Universe } from './galaxy.js';
import { flushChunkQueue, pendingChunks, setGridCells, lodStats, lodStatsReset, setPxPerRad } from './quadtree.js';
import { SpaceControls, WalkControls, keys } from './controls.js';
import { Scatter } from './scatter.js';
import { FarFlora } from './farflora.js';
import { WarpStreaks, SkyDome, Ship, ShipWeapons, SHIP_FOREGROUND_LAYER } from './effects.js';
import { tickShaders } from './shaders.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from '../vendor/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UI } from './ui.js';
import { clamp, lerp, smoothstep } from './noise.js';
import { makeWord, systemName } from './names.js';
import { makeRng } from './rng.js';
import { VERSION } from './version.js';
import { FlightAudio } from './audio.js';
import { StarMap } from './starmap.js';
import { VolumetricPass } from './volumetric-pass.js';
import { ForegroundPass } from './foreground-pass.js';

// ---- error surface (also read by the headless test harness) ---------------
const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
  errBox.classList.remove('hidden');
  errBox.textContent += `${e.message} @ ${e.filename}:${e.lineno}\n`;
});

const qs = new URLSearchParams(location.search);
document.body.classList.toggle('debug-hud', qs.get('debug') === '1');
let SEED = qs.get('seed') || 'EUCLID';
window.NMS_NOLOCK = qs.get('nolock') === '1';
const BUILD_MS = Number(qs.get('buildms')) || 0;
// ?freeze=1: stop scenery-in-motion (waves, sway, cloud drift) so the seam
// test can pixel-compare static frames — any residual change is LOD activity
const FREEZE = qs.get('freeze') === '1';
// ?quality=low for integrated GPUs: coarser grids, no bloom, lower res
const QUALITY_LOW = qs.get('quality') === 'low';
if (QUALITY_LOW) setGridCells(18);

document.getElementById('version').textContent = 'v' + VERSION;
console.info(`No Man's Sky three.js v${VERSION}`);

// touch-first device? (gestures replace wheel/keys, virtual stick for walking)
const IS_TOUCH = qs.get('desktop') !== '1'
  && (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);

// ---- renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
const MAX_DPR = QUALITY_LOW ? 1.1 : IS_TOUCH ? 1.35 : 2.0;
// Mild supersampling on <=1440p desktop protects the hero ship even when the
// OS reports DPR 1. Very high-resolution displays stay at native scale.
const DESKTOP_DPR_FLOOR = !QUALITY_LOW && !IS_TOUCH
  && window.innerWidth * window.innerHeight <= 2560 * 1440 ? 1.25 : 1;
let renderDpr = Math.min(Math.max(window.devicePixelRatio, DESKTOP_DPR_FLOOR), MAX_DPR);
renderer.setPixelRatio(renderDpr);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);
const glInfo = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
const gpuName = glInfo
  ? renderer.getContext().getParameter(glInfo.UNMASKED_RENDERER_WEBGL)
  : 'WebGL high-performance adapter';
console.info('Renderer:', gpuName);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.0);
const BASE_FOV = 62;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.12, 1.2e11);
scene.add(camera);

const ambient = new THREE.AmbientLight(0x506080, 0.09);
const hemi = new THREE.HemisphereLight(0x88aaff, 0x223311, 0);
const headlamp = new THREE.PointLight(0xffeed0, 0, 110, 1.4);
scene.add(ambient, hemi, headlamp);

// near a surface the (shadowless) point sun crossfades into this
// shadow-casting directional light that follows the camera
const sunShadow = new THREE.DirectionalLight(0xffffff, 0);
sunShadow.castShadow = true;
sunShadow.visible = false;
const SHADOW_MAP = window.matchMedia('(pointer: coarse)').matches ? 1024 : 2048;
sunShadow.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sunShadow.shadow.camera.near = 100;
sunShadow.shadow.camera.far = 8500;
sunShadow.shadow.camera.left = sunShadow.shadow.camera.bottom = -300;
sunShadow.shadow.camera.right = sunShadow.shadow.camera.top = 300;
sunShadow.shadow.bias = -0.0002;
sunShadow.shadow.normalBias = 2.0;
scene.add(sunShadow, sunShadow.target);
let shadowBlend = 0;
const sunDirCam = new THREE.Vector3(0, 1, 0);

// ---- post-processing: HDR bloom (sun, lava, engines, stars) -----------------
// MSAA render target keeps antialiasing; OutputPass applies tone mapping/sRGB
const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
  samples: IS_TOUCH ? 1 : 4,
  type: THREE.HalfFloatType,
  depthBuffer: true,
  depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
});
sceneTarget.depthTexture.format = THREE.DepthFormat;
sceneTarget.depthTexture.name = 'scene.depth';
const composer = new EffectComposer(renderer, sceneTarget);
composer.addPass(new RenderPass(scene, camera));
const VOLUME_ENABLED = !QUALITY_LOW && qs.get('vclouds') !== '0';
const volumePass = VOLUME_ENABLED ? new VolumetricPass(scene, camera, { scale: 0.67 }) : null;
if (volumePass) composer.addPass(volumePass);
// EXPERIMENTAL ?gtao=1: ground-truth ambient occlusion for contact shadows
// on cliffs and props. Off by default: the logarithmic depth buffer skews
// its view-space reconstruction at distance — evaluate before trusting.
if (qs.get('gtao') === '1' && !QUALITY_LOW) {
  const gtaoPass = new GTAOPass(scene, camera, 1, 1);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.updateGtaoMaterial({
    radius: 3.0, distanceExponent: 1.2, thickness: 1.5,
    scale: 1.15, samples: 12, distanceFallOff: 1,
  });
  gtaoPass.blendIntensity = 0.85;
  composer.addPass(gtaoPass);
}
const foregroundPass = new ForegroundPass(scene, camera, SHIP_FOREGROUND_LAYER);
composer.addPass(foregroundPass);
// threshold above 1.0: only genuinely HDR pixels bloom (sun, lava, engines,
// specular glints) — daytime sky must NOT veil the terrain
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), IS_TOUCH ? 0.35 : 0.5, 0.4, 1.05);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
// Final-image morphological AA catches the thin diagonal silhouette and
// texture edges that MSAA misses after bloom/volume compositing.
const smaaPass = !QUALITY_LOW && !IS_TOUCH ? new SMAAPass(1, 1) : null;
if (smaaPass) composer.addPass(smaaPass);
// The volume pass needs the composer even when decorative bloom is disabled.
bloomPass.enabled = qs.get('post') !== '0' && !QUALITY_LOW;
let usePost = !QUALITY_LOW && (bloomPass.enabled || VOLUME_ENABLED);
renderer.info.autoReset = false;   // accumulate across composer passes
function sizePost() {
  composer.setPixelRatio(renderDpr);
  composer.setSize(window.innerWidth, window.innerHeight);
}
sizePost();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizePost();
  updateStarProj();
});

function setRenderDpr(next) {
  // The hero ship is a high-frequency foreground asset; dropping below the
  // display's normal desktop scaling makes its wing silhouette visibly stair-
  // stepped even with post AA. Low quality remains an explicit opt-in.
  const qualityFloor = QUALITY_LOW || IS_TOUCH
    ? Math.min(1, window.devicePixelRatio)
    : Math.max(DESKTOP_DPR_FLOOR, Math.min(1.35, window.devicePixelRatio));
  const qualityCeiling = Math.max(qualityFloor, Math.min(window.devicePixelRatio, MAX_DPR));
  const dpr = clamp(next, qualityFloor, qualityCeiling);
  if (Math.abs(dpr - renderDpr) < 0.04) return;
  renderDpr = dpr;
  renderer.setPixelRatio(renderDpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  sizePost();
}

// star sprites need the projection factor to match suns' true angular size;
// the LOD's seam accounting needs the same pixels-per-radian scale
function updateStarProj() {
  const pxPerRad = window.innerHeight / (2 * Math.tan(BASE_FOV * Math.PI / 360));
  setPxPerRad(pxPerRad);
  if (universe.starMaterial) {
    universe.starMaterial.uniforms.uProj.value = pxPerRad;
  }
}

// ---- navigation state -------------------------------------------------------
// nav.pos lives in universe coordinates (JS doubles); the camera itself stays
// at the scene origin and the world is repositioned around it every frame.
const nav = {
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  vel: new THREE.Vector3(),
};
let state = 'space';
let focusPlanet = null;
let focusStar = null;      // far star targeted once; targeting it again warps
let nearest = null;
let nearestAlt = Infinity;
let frameNo = 0;
let lastBuildFrame = 0;
let paused = false;
let boostVisual = 0;
let pulseVisual = 0;
let pulseFuel = 100;
let pulseActive = false;
let pulseEngaged = false;
let pulseRechargeDelay = 0;
let weaponCooldown = 0;
let weaponVisual = 0;
let activeBolts = 0;
let starMap = null;

// ---- world ------------------------------------------------------------------
let universe = new Universe(SEED, scene);
const scatter = new Scatter();
// far tier: proxy trees to the horizon (?farflora=0 spares SwiftShader tests)
const FARFLORA = qs.get('farflora') !== '0';
const farFlora = new FarFlora();
const warpStreaks = new WarpStreaks(scene);
const skyDome = new SkyDome(scene);
const ship = new Ship(scene, {
  anisotropy: Math.min(16, renderer.capabilities.getMaxAnisotropy()),
});
const weapons = new ShipWeapons(scene);
const audio = new FlightAudio();
const pulseFx = document.getElementById('pulse-fx');
let warpIntensity = 0;
let envInAtmo = 0;       // exported by the ambience pass for audio/effects
let envDay = 1;
let envUnderwater = false;
const prevNavPos = new THREE.Vector3();
const _velActual = new THREE.Vector3();

// ---- temps ------------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ex4 = new THREE.Vector4();
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _sky = new THREE.Color();
const _c2 = new THREE.Color();
const _zenithMul = new THREE.Color(0.3, 0.42, 0.78);
const _horC = new THREE.Color();
const _cloudCol = new THREE.Color();
const _warmA = new THREE.Color();
const _warmB = new THREE.Color();
const _warmC = new THREE.Color();
let envSunset = 0;

function lookQuatAt(fromUniv, targetUniv, out, upHint) {
  _m.lookAt(fromUniv, targetUniv, upHint || _v3.set(0, 1, 0));
  return out.setFromRotationMatrix(_m);
}

// quaternion standing on `up`, looking along the horizon toward fwdHint
function horizonQuat(up, fwdHint, out) {
  _v.copy(fwdHint).projectOnPlane(up);
  if (_v.lengthSq() < 1e-4) _v.set(up.y, up.z, -up.x).projectOnPlane(up);
  _v.normalize();
  _v2.crossVectors(_v, up).normalize();        // right
  _v3.crossVectors(_v2, _v);                   // cam up
  _m.makeBasis(_v2, _v3, _v.negate());
  return out.setFromRotationMatrix(_m);
}

// ---- tweens -----------------------------------------------------------------
const tweens = [];
function addTween(dur, fn, onDone) {
  tweens.push({ t: 0, dur, fn, onDone });
}
function stepTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dt;
    const k = clamp(tw.t / tw.dur, 0, 1);
    tw.fn(k);
    if (k >= 1) {
      tweens.splice(i, 1);
      if (tw.onDone) tw.onDone();
    }
  }
}
const easeInOut = (t) => t * t * (3 - 2 * t);

// ---- controls -----------------------------------------------------------------
const spaceCtl = new SpaceControls(renderer.domElement, nav, { onClick: handleClick });
const walkCtl = new WalkControls(renderer.domElement);

renderer.domElement.addEventListener('pointerdown', () => {
  audio.unlock();
  if (state === 'walk' && !document.pointerLockElement && !window.NMS_NOLOCK && !IS_TOUCH) {
    renderer.domElement.requestPointerLock();
  }
});

window.addEventListener('keydown', (e) => {
  audio.unlock();
  if (e.code === 'KeyM' || e.code === 'Tab') {
    e.preventDefault();
    if (starMap?.isOpen) closeStarMap();
    else if (!paused && !['warp', 'landing', 'takeoff', 'flyto'].includes(state)) openStarMap();
    return;
  }
  if (starMap?.isOpen) {
    if (e.code === 'Escape') closeStarMap();
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyL') tryLand();
  if (!e.repeat && e.code === 'KeyF' && state === 'space') {
    const allowed = !nearest || nearestAlt > nearest.atmoHeight * 1.08;
    if (!allowed) {
      pulseEngaged = false;
      ui.setHint('脉冲巡航受大气层干扰 · 升至外层大气后重试', true);
    } else if (pulseFuel > 0.01) {
      pulseEngaged = !pulseEngaged;
    }
  }
  if (!e.repeat && (e.code === 'KeyE' || e.code === 'KeyT') && state === 'walk') boardShip();
  if (!e.repeat && e.code === 'KeyR' && state === 'walk') recallShip();
  if (e.code === 'KeyH') document.body.classList.toggle('hide-hud');   // photo mode
  if (e.code === 'KeyB') usePost = !usePost;                           // bloom toggle
  if (e.code === 'Escape') {
    if (state === 'flyto') {
      tweens.length = 0;
      setState('space');
    } else if (paused) {
      resumeGame();
    } else if (!['warp', 'landing', 'takeoff'].includes(state)) {
      pauseGame();
    }
  }
});

// ---- UI ---------------------------------------------------------------------
const ui = new UI({
  onStart: async () => {
    await audio.unlock();
    audio.setPaused(false);
    spaceCtl.enabled = state === 'space';
    if (/Intel/i.test(gpuName)) {
      ui.setPerformanceNotice('当前浏览器正在使用 Intel 核显；在 Windows 图形设置中将浏览器设为“高性能”可启用 RTX 独显。', 12000);
    }
    if (!window.NMS_NOLOCK && !IS_TOUCH && (state === 'space' || state === 'walk')) {
      try { await renderer.domElement.requestPointerLock(); } catch { /* next canvas click retries */ }
    }
  },
  onLand: tryLand,
  onNewUniverse: () => {
    if (paused) {
      paused = false;
      document.getElementById('pause-overlay').classList.add('hidden');
      audio.setPaused(false);
    }
    newUniverse();
  },
  onStarMap: () => starMap?.isOpen ? closeStarMap() : openStarMap(),
  onLabelClick: (idx) => {
    const p = universe.planets()[idx];
    if (p) clickPlanet(p);
  },
  onJoystick: (x, y) => { walkCtl.touchMove.x = x; walkCtl.touchMove.y = y; },
});
starMap = new StarMap({
  getUniverse: () => universe,
  getNav: () => nav,
  getSeed: () => SEED,
  getState: () => state,
  onRequestClose: () => closeStarMap(),
  onWarpTarget: (star) => {
    closeStarMap(false);
    warpTo(star);
  },
});
const pauseOverlay = document.getElementById('pause-overlay');
document.getElementById('resume-btn').addEventListener('click', resumeGame);
document.getElementById('pause-map-btn').addEventListener('click', async () => {
  if (paused) {
    paused = false;
    pauseOverlay.classList.add('hidden');
    audio.setPaused(true);
  }
  openStarMap();
});

function clearFlightInput() {
  for (const code in keys) keys[code] = false;
  spaceCtl.boosting = false;
  spaceCtl.firing = false;
  spaceCtl.firePressed = false;
  spaceCtl.pulseDrive = false;
  pulseActive = false;
  pulseEngaged = false;
  spaceCtl.wheelImpulse = 0;
  nav.vel.set(0, 0, 0);
  walkCtl.hSpeed.set(0, 0, 0);
}

function openStarMap() {
  if (!starMap || starMap.isOpen || paused || ['warp', 'landing', 'takeoff', 'flyto'].includes(state)) return;
  clearFlightInput();
  spaceCtl.enabled = false;
  audio.setPaused(true);
  ui.setCrosshair(false);
  starMap.open();
  if (document.pointerLockElement) document.exitPointerLock();
}

async function closeStarMap(restoreInput = true) {
  if (!starMap?.isOpen) return;
  starMap.close();
  clearFlightInput();
  audio.setPaused(false);
  spaceCtl.enabled = state === 'space';
  ui.setCrosshair(state === 'space' || state === 'walk');
  if (restoreInput && !window.NMS_NOLOCK && !IS_TOUCH && (state === 'space' || state === 'walk')) {
    try { await renderer.domElement.requestPointerLock(); } catch { /* next click can reacquire */ }
  }
}

function pauseGame() {
  if (paused) return;
  paused = true;
  spaceCtl.enabled = false;
  pauseOverlay.classList.remove('hidden');
  audio.setPaused(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

async function resumeGame() {
  if (!paused) return;
  if (!window.NMS_NOLOCK && !IS_TOUCH && (state === 'space' || state === 'walk')) {
    try { await renderer.domElement.requestPointerLock(); } catch { return; }
  }
  paused = false;
  await audio.unlock();
  audio.setPaused(false);
  spaceCtl.enabled = state === 'space';
  pauseOverlay.classList.add('hidden');
}

document.addEventListener('pointerlockchange', () => {
  if (!window.NMS_NOLOCK && !IS_TOUCH && !document.pointerLockElement
      && !paused && !starMap?.isOpen && (state === 'space' || state === 'walk')) {
    pauseGame();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !paused && !['warp', 'landing', 'takeoff'].includes(state)) {
    if (starMap?.isOpen) closeStarMap(false);
    pauseGame();
  }
});

// universe → app notifications (system handoffs during warp / manual flight)
function wireUniverse(u) {
  u.onSystemChange = (sys) => ui.setSystem(sys.name, sys._specs.length, SEED);
  u.onBeforeSystemDispose = (sys) => {
    if (walkCtl.planet && sys.planets.includes(walkCtl.planet)) return false; // not under our feet
    if (focusPlanet && sys.planets.includes(focusPlanet)) {
      focusPlanet = null;
      spaceCtl.focus = null;
      ui.setTarget(null);
    }
    if (scatter.planet && sys.planets.includes(scatter.planet)) scatter.clear();
    return true;
  };
  updateStarProj();
}

function setState(s) {
  state = s;
  document.body.classList.toggle('walking', s === 'walk');
  if (s !== 'space') {
    pulseActive = false;
    pulseEngaged = false;
    spaceCtl.pulseDrive = false;
    spaceCtl.firing = false;
    spaceCtl.firePressed = false;
  }
  spaceCtl.enabled = s === 'space' && !starMap?.isOpen;
  ui.setCrosshair(s === 'walk' || s === 'space');
  ui.showTouchUI(IS_TOUCH && s === 'walk');
  const hints = IS_TOUCH ? {
    space: '<b>单指</b> 转向 · <b>双指缩放</b> 推进 · <b>轻触</b> 标记目标 · <b>M</b> 星图',
    flyto: '自动接近中…',
    landing: '正在执行降落程序…',
    walk: '<b>摇杆</b> 移动 · <b>拖动</b> 观察 · <b>空格</b> 跳跃 · 靠近飞船按 <b>E</b>',
    boarding: '正在登船…',
    takeoff: '垂直起飞中…',
    warp: '空间折叠中…',
  } : {
    space: '<b>鼠标</b> 船头 · <b>LMB</b> 射击 · <b>W/S</b> 推进/制动 · <b>RMB/SHIFT</b> 加力 · <b>F</b> 脉冲巡航 · <b>M/TAB</b> 星图',
    flyto: '自动接近中… <b>Esc</b> 中止',
    landing: '正在执行降落程序…',
    walk: '<b>WASD</b> 移动 · <b>SHIFT</b> 奔跑 · <b>空格</b> 跳跃 · 靠近飞船按 <b>E</b>',
    boarding: '正在登船…',
    takeoff: '垂直起飞中…',
    warp: '空间折叠中…',
  };
  ui.setHint(hints[s] || '', !['space', 'walk'].includes(s));
}

// ---- actions ------------------------------------------------------------------
function clickPlanet(planet) {
  focusPlanet = planet;
  spaceCtl.focus = planet;
  ui.setTarget(planet, nav.pos.distanceTo(planet.posUniv));
  const dist = nav.pos.distanceTo(planet.posUniv) - planet.R;
  if (dist > planet.R * 3.2) flyToPlanet(planet);
}

function flyToPlanet(planet) {
  if (state !== 'space') return;
  const startPos = nav.pos.clone();
  const startQuat = nav.quat.clone();
  const sunDir = planet.sunDirLocal.clone();
  const fromDir = _v2.copy(startPos).sub(planet.posUniv).normalize();
  // arrive on the sunlit side, offset from straight-in for a nicer reveal
  const targetDir = fromDir.add(sunDir.multiplyScalar(1.1)).normalize();
  const endPos = planet.posUniv.clone().addScaledVector(targetDir, planet.R * 3.1);
  const dur = clamp(startPos.distanceTo(endPos) / 65000 + 1.4, 1.8, 7);
  setState('flyto');
  nav.vel.set(0, 0, 0);
  addTween(dur, (k) => {
    nav.pos.lerpVectors(startPos, endPos, easeInOut(k));
    lookQuatAt(nav.pos, planet.posUniv, _q);
    nav.quat.copy(startQuat).slerp(_q, Math.min(1, k * 2.4));
  }, () => setState('space'));
}

// set the ship down on flat, dry ground ~22 m from where the player lands
function parkShipNear(planet, landDir) {
  const up = _v.copy(landDir);
  const e1 = new THREE.Vector3();
  if (Math.abs(up.y) < 0.93) e1.set(up.z, 0, -up.x).normalize();
  else e1.set(0, -up.z, up.y).normalize();
  const e2 = new THREE.Vector3().crossVectors(up, e1);
  const cand = new THREE.Vector3(), s = new THREE.Vector3();
  // scenic landings favour cliff perches — hunt outward until the ground is
  // genuinely FLAT, or the ship sits level on a slope with its nose in the air
  let best = null, bestH = 0, bestScore = Infinity;
  for (const rad of [22, 48, 95, 170]) {
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      cand.copy(up)
        .addScaledVector(e1, Math.cos(a) * rad / planet.R)
        .addScaledVector(e2, Math.sin(a) * rad / planet.R)
        .normalize();
      const h = planet.height(cand, planet.fullMaxFreq);
      if (planet.hasLiquid && h < planet.seaLevel + 1) continue;
      const st = 6 / planet.R;   // slope over the ship's own footprint
      const ha = planet.height(s.copy(cand).addScaledVector(e1, st).normalize(), planet.fullMaxFreq);
      const hb = planet.height(s.copy(cand).addScaledVector(e2, st).normalize(), planet.fullMaxFreq);
      const slope = (Math.abs(ha - h) + Math.abs(hb - h)) / 6;
      const score = slope * 30 + rad * 0.03;       // flat beats near — but a
      // gentle 4° pad 22 m away beats a runway 170 m out (ship stays IN frame)
      if (score < bestScore) {
        bestScore = score; best = cand.clone();
        bestH = Math.max(h, ha, hb);               // clear the whole footprint
      }
    }
    if (best && bestScore < 1.4) break;            // flat enough, stop early
  }
  if (!best) {   // everything around is wet (e.g. a dive) — park 22 m out anyway
    cand.copy(up).addScaledVector(e1, 22 / planet.R).normalize();
    best = cand.clone(); bestH = planet.height(cand, planet.fullMaxFreq);
  }
  const padUniv = planet.posUniv.clone().addScaledVector(best, planet.R + bestH + 1.3);
  // nose pointed at the player
  _v2.copy(landDir).sub(best).normalize();
  ship.setParked(padUniv, horizonQuat(best, _v2, new THREE.Quaternion()));
}

function tryLand() {
  if (state !== 'space' || !nearest || nearestAlt > 420) return;
  const planet = nearest;
  const startPos = nav.pos.clone();
  const startQuat = nav.quat.clone();
  const dirLocal = _v.copy(startPos).sub(planet.posUniv).normalize().clone();
  const ground = planet.surfaceRadius(dirLocal);
  const endPos = planet.posUniv.clone().addScaledVector(dirLocal, ground + 1.7);
  _v2.set(0, 0, -1).applyQuaternion(startQuat);
  const endQuat = horizonQuat(dirLocal, _v2, new THREE.Quaternion());
  if (!window.NMS_NOLOCK && !IS_TOUCH) renderer.domElement.requestPointerLock();
  parkShipNear(planet, dirLocal);
  setState('landing');
  ui.showLand(false);
  nav.vel.set(0, 0, 0);
  addTween(1.9, (k) => {
    const e = easeInOut(k);
    nav.pos.lerpVectors(startPos, endPos, e);
    nav.quat.copy(startQuat).slerp(endQuat, e);
  }, () => {
    _v.copy(nav.pos).sub(planet.posUniv);
    _v2.set(0, 0, -1).applyQuaternion(nav.quat);
    walkCtl.enter(planet, _v, _v2);
    setState('walk');
  });
}

const BOARD_DISTANCE = 46;

function parkedShipDistance() {
  return ship.parkedPosUniv ? ship.parkedPosUniv.distanceTo(nav.pos) : Infinity;
}

function recallShip() {
  if (state !== 'walk' || !walkCtl.planet) return false;
  const planet = walkCtl.planet;
  const playerDir = _v.copy(nav.pos).sub(planet.posUniv).normalize().clone();
  parkShipNear(planet, playerDir);
  audio.cue('recall');
  ui.setHint('飞船已响应召回信标，并在附近安全着陆', true);
  return true;
}

function boardShip() {
  if (state !== 'walk' || !walkCtl.planet) return false;
  const dist = parkedShipDistance();
  if (dist > BOARD_DISTANCE) {
    ui.setHint(`飞船距离 ${Number.isFinite(dist) ? Math.round(dist) + ' m' : '未知'} · 按 <b>R</b> 召回飞船`, true);
    audio.cue('denied');
    return false;
  }
  const planet = walkCtl.planet;
  const startPos = nav.pos.clone();
  const targetPos = ship.parkedPosUniv.clone();
  const up = _v.copy(targetPos).sub(planet.posUniv).normalize().clone();
  targetPos.addScaledVector(up, 2.2);
  const startQuat = nav.quat.clone();
  const targetQuat = ship.parkedQuat.clone();
  walkCtl.exit();
  nav.vel.set(0, 0, 0);
  setState('boarding');
  audio.cue('board');
  addTween(0.72, (k) => {
    const e = easeInOut(k);
    nav.pos.lerpVectors(startPos, targetPos, e);
    nav.quat.copy(startQuat).slerp(targetQuat, e);
  }, () => takeoff(planet, targetPos, up));
  return true;
}

function takeoff(planet = walkCtl.planet, launchPos = nav.pos.clone(), launchUp = null) {
  if (!planet) return false;
  if (walkCtl.active) walkCtl.exit();
  // Keep pointer lock across boarding/takeoff. Re-acquiring it at the end of
  // an async tween is no longer inside the user's gesture and browsers reject
  // the request, leaving the ship apparently unable to steer after launch.
  const startPos = launchPos.clone();
  nav.pos.copy(startPos);
  const up = launchUp ? launchUp.clone() : _v.copy(startPos).sub(planet.posUniv).normalize().clone();
  const endPos = startPos.clone().addScaledVector(up, 420);
  setState('takeoff');
  addTween(1.5, (k) => {
    nav.pos.lerpVectors(startPos, endPos, easeInOut(k));
  }, () => {
    setState('space');
    nav.vel.copy(up).multiplyScalar(140);
  });
  return true;
}

// A warp is a flight, not a teleport: align with the target, spool up, then
// cross real space at ferocious speed — every star in the sky parallaxes past,
// the destination sun grows from a dot — and decelerate into the new system.
function warpTo(star) {
  if (state !== 'space') return;
  setState('warp');
  focusPlanet = null;
  focusStar = null;
  spaceCtl.focus = null;
  ui.setTarget(null);
  const startPos = nav.pos.clone();
  const startQuat = nav.quat.clone();
  // Begin with a safe stellar-system arrival point. Once the destination
  // system exists, the trajectory is redirected toward its hero planet.
  const arriveDir = startPos.clone().sub(star.pos).normalize();
  let endPos = star.pos.clone().addScaledVector(arriveDir, Math.max(star.radius * 100, 2.2e9));
  const dist = startPos.distanceTo(endPos);
  const dur = clamp(8.5 + dist / 8e8, 10, 18);
  let targetQuat = lookQuatAt(startPos, star.pos, new THREE.Quaternion());
  const SPOOL = 0.12;
  let swapped = false;
  let arrivalPlanetName = null;
  nav.vel.set(0, 0, 0);
  warpStreaks.reset(_v.copy(star.pos).sub(startPos).normalize());

  addTween(dur, (k) => {
    if (k < SPOOL) {
      // turn toward the target and charge the jump
      nav.quat.copy(startQuat).slerp(targetQuat, smoothstep(0, 1, k / SPOOL));
      camera.fov = BASE_FOV - 4 * (k / SPOOL);
    } else {
      const kf = (k - SPOOL) / (1 - SPOOL);
      // quintic smootherstep: gentle ends, ferocious middle
      const s = kf * kf * kf * (kf * (kf * 6 - 15) + 10);
      nav.pos.lerpVectors(startPos, endPos, s);
      nav.quat.copy(targetQuat);
      const ramp = smoothstep(0, 0.2, kf) * (1 - smoothstep(0.78, 0.97, kf));
      camera.fov = BASE_FOV - 4 + 30 * ramp;
      warpIntensity = ramp;
      if (kf >= 0.04 && !swapped) {
        // Swap early enough that the real destination can materialise during
        // the tunnel, then converge on a large planet for the exit reveal.
        swapped = true;
        const destination = universe.setSystem(star, true);
        const hero = destination._specs.find((spec) => !spec.isMoon);
        if (hero) {
          const heroRadius = 160000 + makeRng(hero.seed)() * 240000;
          const revealDirection = startPos.clone().sub(hero.pos).normalize();
          endPos = hero.pos.clone().addScaledVector(revealDirection, heroRadius * 2.55);
          targetQuat = lookQuatAt(startPos, hero.pos, new THREE.Quaternion());
          arrivalPlanetName = hero.name;
        }
      }
    }
    camera.updateProjectionMatrix();
  }, () => {
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
    warpIntensity = 0;
    if (arrivalPlanetName) {
      const arrivalPlanet = universe.system.planets.find((planet) => planet.name === arrivalPlanetName);
      if (arrivalPlanet) {
        focusPlanet = arrivalPlanet;
        spaceCtl.focus = arrivalPlanet;
        ui.setTarget(arrivalPlanet, nav.pos.distanceTo(arrivalPlanet.posUniv));
        lookQuatAt(nav.pos, arrivalPlanet.posUniv, nav.quat);
      }
    }
    setState('space');
  });
}

function newUniverse(seed) {
  SEED = seed || (makeWord(Math.random, 2, 3).toUpperCase() + '-' + ((Math.random() * 999) | 0));
  const url = new URL(location.href);
  url.searchParams.set('seed', SEED);
  history.replaceState(null, '', url);
  if (walkCtl.active) walkCtl.exit();
  if (document.pointerLockElement) document.exitPointerLock();
  tweens.length = 0;
  scatter.clear();
  universe.dispose();
  universe = new Universe(SEED, scene);
  wireUniverse(universe);
  focusPlanet = null;
  focusStar = null;
  spaceCtl.focus = null;
  warpIntensity = 0;
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
  setState('space');
  spawn();
}

function handleClick(cx, cy) {
  window.__lastClick = { x: cx, y: cy, state, hit: null };
  if (state !== 'space') return;
  camera.updateMatrixWorld();
  _v.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1, 0.5)
    .unproject(camera).normalize();
  // planets: analytic ray/sphere in camera-relative space
  let hit = null, hitDist = Infinity;
  for (const p of universe.planets()) {
    _v2.copy(p.posUniv).sub(nav.pos);
    const b = _v2.dot(_v);
    if (b <= 0) continue;
    const r = p.R * 1.15;
    const d2 = _v2.lengthSq() - b * b;
    if (d2 < r * r) {
      const t = b - Math.sqrt(r * r - d2);
      if (t < hitDist) { hitDist = t; hit = p; }
    }
  }
  window.__lastClick.hit = hit ? hit.name : null;
  if (hit) { focusStar = null; clickPlanet(hit); return; }
  const star = universe.pickStar(nav.pos, _v);
  if (star) {
    window.__lastClick.hit = '★' + star.id;
    if (focusStar && focusStar.id === star.id) {
      warpTo(star);
    } else {
      // first tap targets; the same star again warps (saves stray thumbs)
      focusStar = star;
      focusPlanet = null;
      spaceCtl.focus = null;
      const name = systemName(makeRng(SEED + ':sys:' + star.id));
      ui.setStarTarget(name, nav.pos.distanceTo(star.pos),
        IS_TOUCH ? 'tap again to warp' : 'click again to warp');
    }
    return;
  }
  focusPlanet = null;
  focusStar = null;
  spaceCtl.focus = null;
  ui.setTarget(null);
}

// ---- spawn --------------------------------------------------------------------
function spawn() {
  const sys = universe.system;
  const planet = sys.planets[0];
  const sunDir = sys.sunDirFrom(planet.posUniv, _v).clone();
  const side = _v2.crossVectors(sunDir, _v3.set(0, 1, 0)).normalize();
  const dir = sunDir.clone().addScaledVector(side, 0.85).normalize();
  nav.pos.copy(planet.posUniv).addScaledVector(dir, planet.R * 2.45);
  lookQuatAt(nav.pos, planet.posUniv, nav.quat);
  nav.quat.multiply(_q.setFromAxisAngle(_v3.set(0, 1, 0), 0.18));
  nav.vel.set(0, 0, 0);
  focusPlanet = planet;
  spaceCtl.focus = planet;
  ui.setSystem(sys.name, sys.planets.length, SEED);
  ui.setTarget(planet, nav.pos.distanceTo(planet.posUniv));
  setState('space');
}

// ---- ambience: atmosphere entry, sky color, fog, star dimming ------------------
function ambience() {
  let inAtmo = 0, day = 1, skyStrength = 0;
  envUnderwater = false;
  scene.fog.density = 0;
  if (nearest) {
    const p = nearest;
    // The sky transition belongs to the actual atmospheric shell. The old
    // 2.4× multiplier started the blue clear-color far above it and made entry
    // feel like a long opaque loading tunnel.
    const x = clamp(nearestAlt / Math.max(p.atmoHeight, 1), 0, 1.2);
    inAtmo = (1 - smoothstep(0.14, 1.04, x)) * p.atmoDensity;
    _up.copy(nav.pos).sub(p.posUniv).normalize();
    // the sun that matters is the one this planet orbits
    const sunDir = nearest.sunDirLocal || universe.system.sunDirFrom(nav.pos, _v);
    day = smoothstep(-0.22, 0.28, _up.dot(sunDir));

    if (!p.skyColorLin) p.skyColorLin = p.skyColor.clone().convertSRGBToLinear();
    // dense atmospheres read as thicker fog, NOT as an overbright sky —
    // sky luminance stays below the bloom threshold
    skyStrength = Math.min(inAtmo, 1) * (0.035 + 0.965 * day) * 0.92;
    _sky.copy(p.skyColorLin).multiplyScalar(skyStrength);

    // golden hour: sun near the horizon reddens sky, fog and light
    const sunElev = _up.dot(sunDir);
    envSunset = (1 - smoothstep(0.12, 0.38, sunElev))
      * smoothstep(-0.22, -0.04, sunElev) * inAtmo;
    _sky.lerp(_warmA.setRGB(0.55, 0.2, 0.08).multiplyScalar(Math.max(skyStrength, 0.12)), envSunset * 0.45);

    let fogDensity = inAtmo * lerp(0.00005, 0.00001, clamp(nearestAlt / 2500, 0, 1)) * (0.25 + 0.75 * day);

    // flying through a cloud deck: local density whites out the world
    const transit = p.cloudTransit ? p.cloudTransit(_v2.copy(nav.pos).sub(p.posUniv)) : 0;
    if (transit > 0.004) {
      fogDensity += transit * 0.0045;
      _sky.lerp(_cloudCol.setRGB(0.6, 0.64, 0.7).multiplyScalar(0.2 + 0.8 * day),
        Math.min(1, transit * 1.5));
    }

    // submerged?
    const camR = _v2.copy(nav.pos).sub(p.posUniv).length();
    if (p.hasLiquid && camR < p.seaRadius + 0.4) {
      envUnderwater = true;
      if (!p.liquidColorLin) p.liquidColorLin = p.liquidColor.clone().convertSRGBToLinear();
      _sky.copy(p.liquidColorLin).multiplyScalar(0.25 + 0.55 * day);
      if (p.liquid === 'lava') _sky.set(1.2, 0.25, 0.02);
      fogDensity = p.liquid === 'lava' ? 0.2 : 0.03;
      skyStrength = 1;
    }

    scene.fog.color.copy(_sky);
    scene.fog.density = fogDensity;

    // valley mist tracks the live fog/sky tint (sunset mist comes free)
    const tsh = p.terrainMaterial.userData.shader;
    if (tsh && tsh.uniforms.uMistColor) {
      tsh.uniforms.uMistColor.value.copy(_sky).multiplyScalar(1.06);
    }

    hemi.intensity = inAtmo * 1.15 * (0.12 + 0.88 * day);
    hemi.color.copy(p.skyColorLin || _sky);
    hemi.groundColor.copy(p.pal.land[Math.min(2, p.pal.land.length - 1)].c);

    // the sky dome: horizon glow, deeper zenith, sun halo
    _horC.copy(p.skyColorLin).lerp(_warmB.setRGB(1.0, 0.42, 0.16), envSunset * 0.75);
    _c2.copy(p.skyColorLin).multiply(_zenithMul);
    skyDome.update(_up, sunDir, _horC, _c2,
      envUnderwater ? 0 : Math.min(inAtmo, 1) * (0.04 + 0.96 * day), envSunset);
  } else {
    hemi.intensity = 0;
    envSunset = 0;
    skyDome.update(_up, _up, _sky, _sky, 0, 0);
  }
  renderer.setClearColor(_sky.multiplyScalar(nearest ? 1 : 0));
  if (!nearest) renderer.setClearColor(0x000000);
  universe.setStarDimming(clamp(skyStrength * 1.25, 0, 1));
  // a horizon sun seen through air dims and reddens — otherwise sunsets are
  // a white bloom explosion swallowing a third of the sky
  universe.setSunExtinction(nearest ? envSunset : 0);
  // candela-scale: with physical decay, ~2 units of intensity is invisible —
  // a real lamp needs tens of candela to paint a pool on the ground
  headlamp.intensity = state === 'walk' && day < 0.4 ? (0.4 - day) * 80 : 0;
  ambient.intensity = 0.09 + inAtmo * 0.24;   // fill so cast shadows aren't pitch black
  envInAtmo = inAtmo;
  envDay = day;
  // hand the sun over to the shadow-casting light near the ground
  shadowBlend = nearest ? 1 - smoothstep(1200, 3500, nearestAlt) : 0;
  if (nearest && shadowBlend > 0) sunDirCam.copy(nearest.sunDirLocal);
}

// ---- labels ---------------------------------------------------------------------
const labelItems = [];
function updateLabels() {
  labelItems.length = 0;
  const showLabels = (state === 'space' || state === 'flyto') && frameNo > 5;
  if (showLabels) {
    camera.updateMatrixWorld();
    const planets = universe.planets();
    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      _v.copy(p.posUniv).sub(nav.pos);
      const dist = _v.length();
      if (dist < p.R * 2.2) continue;                       // too close: label is noise
      _v2.set(0, 0, -1).applyQuaternion(nav.quat);
      if (_v.dot(_v2) < 0) continue;                        // behind us
      _v3.copy(p.posUniv).sub(nav.pos).multiplyScalar(1 / dist);
      _v.copy(_v3).multiplyScalar(100).applyMatrix4(camera.matrixWorldInverse);
      _v.applyMatrix4(camera.projectionMatrix);
      if (Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05) continue;
      // sit the label above the planet's disc, not on it
      const angR = Math.asin(Math.min(1, (p.R * 1.1) / dist));
      const pxR = Math.min(angR / (camera.fov * Math.PI / 360) * (window.innerHeight / 2), window.innerHeight * 0.45);
      labelItems.push({
        x: (_v.x * 0.5 + 0.5) * window.innerWidth,
        y: (-_v.y * 0.5 + 0.5) * window.innerHeight - 14 - pxR,
        name: p.name,
        sub: p.isMoon ? 'moon' : p.typeLabel.toLowerCase(),
        dim: dist > 2.5e7,
        key: i,
      });
    }
  }
  ui.updateLabels(labelItems);
}

// ---- main loop --------------------------------------------------------------------
const clock = new THREE.Clock();
let statAcc = 0;
let pauseFrameRendered = false;
let perfEmaMs = 16.7;
let dprAcc = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = clamp(clock.getDelta(), 0.0001, 0.05);
  frameNo++;
  // The map owns an opaque full-screen WebGL surface and its own RAF. Rendering
  // the universe underneath doubled GPU work for pixels nobody could see.
  if (starMap?.isOpen) return;
  if (paused) {
    if (pauseFrameRendered) return;
    pauseFrameRendered = true;
    renderer.info.reset();
    if (usePost) composer.render();
    else renderer.render(scene, camera);
    return;
  }
  pauseFrameRendered = false;

  // nearest body & altitude
  nearest = state === 'walk' && walkCtl.planet ? walkCtl.planet : null;
  if (!nearest) {
    let bestD = Infinity;
    for (const p of universe.planets()) {
      const d = _v.copy(nav.pos).sub(p.posUniv).length() - p.R;
      if (d < bestD) { bestD = d; nearest = p; }
    }
  }
  if (nearest) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    nearestAlt = nearest.altitudeAt(_v);
  } else nearestAlt = Infinity;

  // controls / state integration
  if (state === 'space') {
    const atmosphereFactor = nearest
      ? 1 - smoothstep(0.42, 1.12, nearestAlt / Math.max(nearest.atmoHeight, 1))
      : 0;
    spaceCtl.atmosphereFactor = atmosphereFactor;
    if (nearest) {
      // One continuous travel curve. The previous branch changed scale by an
      // order of magnitude at the atmosphere boundary, making orbit feel tiny
      // and the high-altitude descent inexplicably slow.
      const h = Math.max(nearest.atmoHeight, 1);
      const alt = Math.max(0, nearestAlt);
      const surfaceScale = clamp(38 + Math.pow(alt, 0.58) * 0.32, 38, 620);
      const orbitalScale = clamp(650 + alt * 0.018, 650, 120000);
      const orbitalBlend = smoothstep(0.72, 3.5, alt / h);
      spaceCtl.speedScale = lerp(surfaceScale, orbitalScale, orbitalBlend);
    } else {
      spaceCtl.speedScale = 120000;
    }
    const pulseAllowed = !nearest || nearestAlt > nearest.atmoHeight * 1.08;
    if (!pulseAllowed || pulseFuel <= 0.01) pulseEngaged = false;
    pulseActive = pulseEngaged && pulseFuel > 0.01 && pulseAllowed;
    spaceCtl.pulseDrive = pulseActive;
    if (pulseActive) {
      pulseFuel = Math.max(0, pulseFuel - dt * 6.5);
      pulseRechargeDelay = 1.4;
    }
    if (nearest) {
      // Planet approach is intentionally much slower than tangential flight.
      // A distance-shaped radial cap preserves the scale of the world and
      // guarantees a long high-altitude descent instead of crossing hundreds
      // of kilometres in a few frames. Clamp once BEFORE integration so a
      // velocity accumulated in deep space cannot cross the atmosphere in one
      // frame; the second clamp catches this frame's new boost impulse.
      _v.copy(nav.pos).sub(nearest.posUniv).normalize();
      const inwardSpeed = -nav.vel.dot(_v);
      const safeInward = (55 + Math.pow(Math.max(0, nearestAlt), 0.75) * 0.6)
        * (pulseActive ? 1.35 : 1);
      if (inwardSpeed > safeInward) nav.vel.addScaledVector(_v, inwardSpeed - safeInward);
    }
    spaceCtl.update(dt);
    if (nearest) {
      _v.copy(nav.pos).sub(nearest.posUniv).normalize();
      const inwardSpeed = -nav.vel.dot(_v);
      const safeInward = (55 + Math.pow(Math.max(0, nearestAlt), 0.75) * 0.6)
        * (pulseActive ? 1.35 : 1);
      if (inwardSpeed > safeInward) nav.vel.addScaledVector(_v, inwardSpeed - safeInward);
    }
    // never fly into the ground
    if (nearest && nearestAlt < 3) {
      _v.copy(nav.pos).sub(nearest.posUniv).normalize();
      const ground = nearest.surfaceRadius(_v);
      nav.pos.copy(nearest.posUniv).addScaledVector(_v, ground + 3);
      const inward = Math.min(0, nav.vel.dot(_v));
      nav.vel.addScaledVector(_v, -inward);
    }
  } else if (state === 'walk') {
    pulseActive = false;
    spaceCtl.pulseDrive = false;
    walkCtl.update(dt);
    nav.pos.copy(walkCtl.planet.posUniv).add(walkCtl.posLocal);
    nav.quat.copy(walkCtl.quat);
  }
  stepTweens(dt);

  // The ship reactor recharges pulse energy after a short thermal cooldown.
  // Recharge continues while landed so pulse fuel can never become a dead-end
  // resource that requires restarting the session.
  if (!pulseActive) {
    pulseRechargeDelay = Math.max(0, pulseRechargeDelay - dt);
    if (pulseRechargeDelay <= 0 && pulseFuel < 100) {
      pulseFuel = Math.min(100, pulseFuel + dt * 4.5);
    }
  }

  const weaponTrigger = state === 'space' && (spaceCtl.firing || spaceCtl.firePressed);
  weaponCooldown -= dt;
  if (weaponTrigger && weaponCooldown <= 0) {
    weapons.fire(nav, spaceCtl.speedScale, ship);
    audio.cue('fire');
    weaponCooldown = 0.13;
  } else if (!weaponTrigger) {
    weaponCooldown = Math.min(weaponCooldown, 0);
  }
  spaceCtl.firePressed = false;

  const boostTarget = state === 'space' && (spaceCtl.boosting || keys.ShiftLeft || keys.ShiftRight) ? 1 : 0;
  boostVisual += (boostTarget - boostVisual) * (1 - Math.exp(-dt * (boostTarget ? 7.5 : 8.5)));
  pulseVisual += ((pulseActive ? 1 : 0) - pulseVisual) * (1 - Math.exp(-dt * (pulseActive ? 4.5 : 7)));
  weaponVisual += ((weaponTrigger ? 1 : 0) - weaponVisual) * (1 - Math.exp(-dt * 16));
  if (state === 'space' && warpIntensity < 0.01) {
    camera.fov += ((BASE_FOV + boostVisual * 6.5 + pulseVisual * 14.0) - camera.fov)
      * (1 - Math.exp(-dt * 6.2));
    camera.updateProjectionMatrix();
  }
  pulseFx.style.opacity = (pulseVisual * 0.78).toFixed(3);
  pulseFx.style.transform = `scale(${(1.08 + pulseVisual * 0.06).toFixed(3)})`;
  document.body.classList.toggle('weapon-firing', weaponVisual > 0.12);

  // true frame velocity (a warp moves nav.pos directly, not via nav.vel)
  if (frameNo > 2) _velActual.copy(nav.pos).sub(prevNavPos).multiplyScalar(1 / dt);
  warpStreaks.update(dt, _velActual, warpIntensity, Math.max(boostVisual, pulseVisual * 1.8));
  // a deferred system (warp or manual approach) materializes one planet/frame
  if (universe.system && !universe.system.built) universe.system.buildNext();

  // world updates (proximity system swap allowed while free-flying)
  universe.update(nav.pos, state === 'space' || state === 'flyto');
  for (const p of universe.planets()) {
    _v.copy(nav.pos).sub(p.posUniv);
    p.update(_v, dt, p === nearest, FREEZE ? 0 : dt);
  }
  if (nearest) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    scatter.update(nearest, _v, nearestAlt);
    if (FARFLORA) farFlora.update(nearest, _v, nearestAlt);
  } else if (farFlora.planet) {
    farFlora.clear();
  }

  ambience();

  // land prompt
  const canLand = state === 'space' && nearest && nearestAlt < 420 && nav.vel.length() < 4000;
  ui.showLand(!!canLand, nearest && nearest.hasLiquid && nearest.liquid !== 'ice' &&
    _v.copy(nav.pos).sub(nearest.posUniv).length() < nearest.seaRadius + 2
    ? 'DIVE — walk the seabed' : 'LAND — walk the surface (L)');

  if (state === 'walk') {
    const shipDist = parkedShipDistance();
    if (shipDist <= BOARD_DISTANCE) {
      ui.setHint(`<b>E / T</b> 登上飞船 · 距离 ${Math.max(0, Math.round(shipDist))} m`, true);
    } else {
      ui.setHint(`飞船距离 ${Number.isFinite(shipDist) ? Math.round(shipDist) + ' m' : '未知'} · 按 <b>R</b> 召回`, true);
    }
  }

  // chunk builds: a per-frame millisecond budget (overridable for slow
  // software-rendered test environments via ?buildms=)
  const nearTerrain = nearest && nearestAlt < Math.max(nearest.atmoHeight * 2.4, 90000);
  const built = flushChunkQueue(BUILD_MS || (state === 'walk' ? 2.6 : nearTerrain ? 3.2 : 1.6));
  if (built > 0) lastBuildFrame = frameNo;

  // camera-relative placement
  universe.updateRelative(nav.pos);
  camera.position.set(0, 0, 0);
  camera.quaternion.copy(nav.quat);
  activeBolts = weapons.update(dt, nav, nearest);

  // sun → shadow-light crossfade (after updateRelative, which sets intensities)
  sunShadow.visible = shadowBlend > 0.02;
  if (sunShadow.visible) {
    const sysLight = universe.system.sunLight;
    sunShadow.intensity = sysLight.intensity * shadowBlend;
    sunShadow.color.copy(sysLight.color)
      .lerp(_warmC.setRGB(1, 0.45, 0.2), envSunset * 0.55);
    sunShadow.position.copy(sunDirCam).multiplyScalar(4000);
    sunShadow.target.position.set(0, 0, 0);
    sysLight.intensity *= 1 - shadowBlend;
    if (universe.fadingSystem) universe.fadingSystem.sunLight.intensity *= 1 - shadowBlend;
  }

  // Atmospheric buffeting is coherent, not per-frame random noise. Random
  // offsets made right-click acceleration read as a broken flight model.
  const trueSpd = _velActual.length();
  if (envInAtmo > 0.05 && trueSpd > 220 && (state === 'space' || state === 'flyto')) {
    const amp = Math.min(1, trueSpd / 3200) * envInAtmo * (0.16 + boostVisual * 0.08);
    const t = clock.elapsedTime;
    camera.position.set(
      Math.sin(t * 17.3) * amp,
      Math.sin(t * 21.7 + 1.2) * amp * 0.65,
      Math.sin(t * 13.1 + 2.4) * amp * 0.35,
    );
  }
  if (pulseVisual > 0.01 && state === 'space') {
    const t = clock.elapsedTime;
    camera.position.x += Math.sin(t * 29.0) * 0.045 * pulseVisual;
    camera.position.y += Math.sin(t * 37.0 + 0.8) * 0.028 * pulseVisual;
  }

  // the ship flies just ahead of the camera whenever we're in flight
  ship.update(dt, nav, state, trueSpd, warpIntensity, Math.max(boostVisual, pulseVisual * 1.3));
  audio.update({
    state,
    speed: trueSpd,
    atmosphere: envInAtmo,
    boosting: boostVisual > 0.12 || pulseVisual > 0.12,
    warp: warpIntensity,
    paused,
  });

  // HUD
  if (focusPlanet) ui.setTargetDist(nav.pos.distanceTo(focusPlanet.posUniv) - focusPlanet.R);
  else if (focusStar) ui.setTargetDist(nav.pos.distanceTo(focusStar.pos));
  const spd = state === 'walk' ? walkCtl.hSpeed.length()
    : state === 'space' ? nav.vel.length() : _velActual.length();
  ui.setAltitude(nearest && nearestAlt < 2e7 ? Math.max(0, nearestAlt) : null, spd);
  ui.setFlightTelemetry({
    speed: spd,
    speedLimit: spaceCtl.speedScale * (pulseActive
      ? 13.92 + (1 - spaceCtl.atmosphereFactor) * 8.12
      : 6.96 + (1 - spaceCtl.atmosphereFactor) * 4.06),
    boost: boostVisual,
    atmosphere: envInAtmo,
    pulse: pulseVisual,
    pulseFuel,
    pulseRecharging: !pulseActive && pulseRechargeDelay <= 0 && pulseFuel < 99.995,
  });
  _v.set(0, 0, -1).applyQuaternion(nav.quat);
  ui.setHeading(Math.atan2(_v.x, -_v.z) * 180 / Math.PI);
  updateLabels();

  if (volumePass) {
    const motion = clamp(trueSpd / Math.max(nearest?.R || 1, 60000) * 18 + boostVisual * 0.22, 0, 1);
    volumePass.setActivePlanet(nearest, nav.pos, motion);
  }
  foregroundPass.enabled = VOLUME_ENABLED && ['space', 'flyto', 'landing', 'takeoff', 'boarding'].includes(state);
  ambient.layers.enable(SHIP_FOREGROUND_LAYER);
  hemi.layers.enable(SHIP_FOREGROUND_LAYER);
  headlamp.layers.enable(SHIP_FOREGROUND_LAYER);
  sunShadow.layers.enable(SHIP_FOREGROUND_LAYER);
  universe.system?.sunLight?.layers.enable(SHIP_FOREGROUND_LAYER);
  universe.fadingSystem?.sunLight?.layers.enable(SHIP_FOREGROUND_LAYER);

  statAcc += dt;
  if (statAcc > 0.5) {
    statAcc = 0;
    const info = renderer.info.render;
    let chunks = 0;
    for (const p of universe.planets()) chunks += p.lod.countChunks();
    ui.setStats(`${(1 / dt).toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1e6).toFixed(2)} Mtri · ${chunks} chunks · ${pendingChunks()} queued · ${activeBolts} bolts · ${renderDpr.toFixed(2)}×`);
  }

  // Slow adaptation avoids reallocating render targets during momentary LOD
  // spikes. On a 5080 this stays at the quality ceiling; an iGPU degrades
  // gracefully instead of silently presenting a single-digit frame rate.
  perfEmaMs += (dt * 1000 - perfEmaMs) * 0.025;
  dprAcc += dt;
  if (dprAcc > 2.5 && !FREEZE) {
    dprAcc = 0;
    if (perfEmaMs > 20.5) setRenderDpr(renderDpr - 0.1);
    else if (perfEmaMs < 14.2) setRenderDpr(renderDpr + 0.05);
  }

  if (!FREEZE) tickShaders(dt);
  renderer.info.reset();
  if (usePost) composer.render();
  else renderer.render(scene, camera);
  prevNavPos.copy(nav.pos);
  if (frameNo === 3) ui.setLoading(false);
}

wireUniverse(universe);
spawn();
ui.setLoading(true, 'generating universe…');
const SHOW_HERO = qs.get('nohero') !== '1' && !window.NMS_NOLOCK;
ui.showHero(SHOW_HERO, '从轨道俯冲至地表，或打开银河星图选择下一次跃迁。');
if (SHOW_HERO) spaceCtl.enabled = false;
frame();

// ---- debug / test API (used by tools/screenshot.js) ----------------------------
window.NMS = {
  version: VERSION,
  _ff: farFlora,           // debug handle (headless diagnostics)
  _renderer: renderer,
  _THREE: THREE,
  get booted() { return frameNo > 3; },
  get state() { return state; },
  get paused() { return paused; },
  seed: () => SEED,
  frame: () => frameNo,
  idle() {
    return frameNo > 10 && pendingChunks() === 0 && farFlora.pending() === 0
      && frameNo - lastBuildFrame > 8;
  },
  stats() {
    const info = renderer.info.render;
    let chunks = 0;
    for (const p of universe.planets()) chunks += p.lod.countChunks();
    return {
      frame: frameNo, calls: info.calls, tris: info.triangles, chunks,
      pending: pendingChunks(), state, alt: nearestAlt,
      paused, boost: boostVisual, fov: camera.fov, audio: audio.ready,
      pulse: pulseActive, pulseFuel: Math.round(pulseFuel * 10) / 10,
      firing: spaceCtl.firing, bolts: activeBolts,
      gpu: gpuName, dpr: renderDpr,
      far: farFlora.meshes ? farFlora.meshes[0].count + farFlora.meshes[1].count : 0,
    };
  },
  planets() {
    return universe.system.planets.map((p, i) => ({
      i, name: p.name, type: p.type, R: Math.round(p.R), isMoon: !!p.isMoon,
      hasLiquid: p.hasLiquid, liquid: p.liquid,
      cloudAlt: p.cloudBands && p.cloudBands.length ? Math.round(p.cloudBands[0].r - p.R) : 0,
    }));
  },
  // place the camera near planet i at alt = R*altFactor, on the sunlit side
  teleport(i, altFactor = 2.5, opts = {}) {
    const p = universe.system.planets[i];
    if (!p) return false;
    tweens.length = 0;
    if (walkCtl.active) walkCtl.exit();
    setState('space');
    const sunDir = p.sunDirLocal.clone();
    let dir = opts.dir ? new THREE.Vector3(...opts.dir).normalize()
      : p.scenicDir(sunDir).lerp(sunDir, 0.55).normalize();
    nav.pos.copy(p.posUniv).addScaledVector(dir, p.R + p.R * altFactor);
    nav.vel.set(0, 0, 0);
    if (opts.horizon) {
      _v2.crossVectors(dir, sunDir).normalize();
      horizonQuat(dir, _v2, nav.quat);
      // negative pitch looks down at the terrain
      nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), opts.pitch ?? -0.18));
    } else {
      lookQuatAt(nav.pos, p.posUniv, nav.quat);
    }
    focusPlanet = p; spaceCtl.focus = p;
    ui.setTarget(p, nav.pos.distanceTo(p.posUniv));
    return true;
  },
  // hover low over a sunlit stretch of coastline, facing out to sea —
  // the water-depth-gradient showcase (a scenic dir is often inland)
  coast(i, alt = 1400) {
    const p = universe.system.planets[i];
    if (!p || !p.hasLiquid) return false;
    tweens.length = 0;
    if (walkCtl.active) walkCtl.exit();
    setState('space');
    const sunDir = p.sunDirLocal.clone();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), s = new THREE.Vector3();
    const cand = new THREE.Vector3(), seaward = new THREE.Vector3();
    let best = null, bestScore = -Infinity;
    const rr = 2500 / p.R;
    const ring = (u, cb) => {          // 8 samples 2.5 km around u
      if (Math.abs(u.y) < 0.93) e1.set(u.z, 0, -u.x).normalize();
      else e1.set(0, -u.z, u.y).normalize();
      e2.crossVectors(u, e1);
      for (let j = 0; j < 8; j++) {
        const a = (j / 8) * Math.PI * 2, cx = Math.cos(a), cy = Math.sin(a);
        s.copy(u).addScaledVector(e1, cx * rr).addScaledVector(e2, cy * rr).normalize();
        cb(p.height(s, 64) < p.seaLevel, cx, cy);
      }
    };
    for (let k = 0; k < 1400; k++) {
      const y = 1 - (2 * (k + 0.5)) / 1400;
      const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
      cand.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
      if (cand.dot(sunDir) < 0.2) continue;                 // day side only
      let wet = 0;
      ring(cand, (w) => { if (w) wet++; });
      const score = -Math.abs(wet - 4) * 1.5 + cand.dot(sunDir);
      if (score > bestScore) { bestScore = score; best = cand.clone(); }
    }
    if (!best || bestScore < -3.5) return false;
    seaward.set(0, 0, 0);
    ring(best, (w, cx, cy) => {        // e1/e2 are best's frame after this
      if (w) seaward.addScaledVector(e1, cx).addScaledVector(e2, cy);
    });
    if (seaward.lengthSq() < 0.01) seaward.copy(e1);
    nav.pos.copy(p.posUniv).addScaledVector(best, p.R + p.seaLevel + alt);
    nav.vel.set(0, 0, 0);
    horizonQuat(best, seaward, nav.quat);
    nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), -0.32));
    focusPlanet = p; spaceCtl.focus = p;
    ui.setTarget(p, nav.pos.distanceTo(p.posUniv));
    return true;
  },
  // instantly stand on planet i at its scenic spot (no pointer lock).
  // bias picks the lighting: 'sunset' lands on the terminator ring, 'night'
  // on the far side (headlamp comes on), 'meadow' seeks flat vegetated
  // ground facing the tree line, default lands in full daylight.
  land(i, yawDeg = 0, bias = null) {
    const p = universe.system.planets[i];
    if (!p) return false;
    window.NMS_NOLOCK = true;
    tweens.length = 0;
    const sunDir = p.sunDirLocal.clone();
    const meadow = bias === 'meadow';
    let prefer = sunDir, ring = null;
    if (bias === 'night') prefer = sunDir.clone().negate();
    else if (bias === 'sunset') { prefer = null; ring = sunDir; }
    const dir = p.scenicDir(prefer, ring);
    // scenicDir scores the REGION at km scale — it cannot see the cliff wall
    // 20 m from the spawn. Micro-refine within ~500 m: flat footing plus at
    // least one open view of sun-LIT faces (sun behind the shoulder), and
    // remember which yaw that was. At sunset the view is pinned into the sun.
    // Same frame convention as WalkControls: east = Y×up, north = up×east.
    const frame = (u, a, b) => {
      if (Math.abs(u.y) < 0.93) a.set(u.z, 0, -u.x).normalize();
      else a.set(0, -u.z, u.y).normalize();
      b.crossVectors(u, a);
    };
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const cand = new THREE.Vector3(), probe = new THREE.Vector3(), sunH = new THREE.Vector3();
    const bestSpot = dir.clone();
    let bestSpotScore = -Infinity, bestYaw = 0;
    // meadow: cast a much wider net — the scenic region often centres on a
    // scarp, and the nearest flat vegetated ground can be a km away
    const CANDS = meadow ? 48 : 24;
    for (let ci = 0; ci < CANDS; ci++) {
      const rr = (meadow ? 0.02 : 0.005) * Math.sqrt(ci / CANDS), ga = ci * 2.399963229728653;
      frame(dir, e1, e2);
      cand.copy(dir).addScaledVector(e1, Math.cos(ga) * rr).addScaledVector(e2, Math.sin(ga) * rr).normalize();
      const h = p.height(cand, 128);
      if (p.hasLiquid && h - p.seaLevel < 2) continue;
      frame(cand, e1, e2);
      sunH.copy(sunDir).addScaledVector(cand, -sunDir.dot(cand));
      if (sunH.lengthSq() > 1e-4) sunH.normalize(); else sunH.set(0, 0, 0);
      const st = 10 / p.R;
      const hx = p.height(probe.copy(cand).addScaledVector(e1, st).normalize(), 128);
      const hy = p.height(probe.copy(cand).addScaledVector(e2, st).normalize(), 128);
      let score = -(Math.abs(hx - h) + Math.abs(hy - h)) * (meadow ? 2.0 : 1.2);   // flat footing
      // don't spawn INSIDE a grove — trees are invisible to height probes;
      // clearing edges score naturally (view keeps the trees, feet stay free)
      p.extrasAt(cand, h, 128, _ex4);
      score -= _ex4.x * (meadow ? 2 : 14);
      if (meadow) {
        const b = p.biomeAt(cand, h);
        score += (b === 'grass' || b === 'forest' || b === 'dryland'
          || b === 'slime' || b === 'weird') ? 10 : -10;
      }
      const pinSun = bias === 'sunset' && sunH.lengthSq() > 0.5;
      let yawBest = 0, yawScore = -Infinity;
      for (let k = 0, kn = pinSun ? 1 : 8; k < kn; k++) {
        const yaw = pinSun ? Math.atan2(sunH.dot(e1), sunH.dot(e2)) : (k / 8) * Math.PI * 2;
        const fx = Math.cos(yaw), fy = Math.sin(yaw);
        let s = 0;
        if (pinSun) {
          // the sun sits at elevation ~0.11 — the SKYLINE toward it must stay
          // lower. Walk the whole ray: point probes miss ridges between them.
          let maxEl = -1;
          for (let dd = 250; dd <= 6000; dd += 250) {
            probe.copy(cand).addScaledVector(e2, fx * dd / p.R).addScaledVector(e1, fy * dd / p.R).normalize();
            const el = (p.height(probe, 128) - h) / dd;
            if (el > maxEl) maxEl = el;
          }
          s = -Math.max(0, maxEl - 0.06) * 400;
        } else {
          for (const dd of [120, 350, 900]) {
            probe.copy(cand).addScaledVector(e2, fx * dd / p.R).addScaledVector(e1, fy * dd / p.R).normalize();
            s += (h - p.height(probe, 128)) / dd;      // terrain falls away = open
          }
          s -= (fx * e2.dot(sunH) + fy * e1.dot(sunH)) * 1.9;   // lit faces ahead
          if (meadow) {
            // and face the vegetation: forest mask sampled a few steps out
            for (const dd of [70, 180]) {
              probe.copy(cand).addScaledVector(e2, fx * dd / p.R).addScaledVector(e1, fy * dd / p.R).normalize();
              p.extrasAt(probe, p.height(probe, 128), 128, _ex4);
              s += _ex4.x * 2.2;
            }
          }
        }
        if (s > yawScore) { yawScore = s; yawBest = yaw; }
      }
      score += yawScore * 8;   // the view matters more than the footing
      if (score > bestSpotScore) { bestSpotScore = score; bestSpot.copy(cand); bestYaw = yawBest; }
    }
    dir.copy(bestSpot);
    parkShipNear(p, dir);
    const ground = p.surfaceRadius(dir);
    _v2.copy(dir).multiplyScalar(ground + 1.7);
    _v3.crossVectors(sunDir, dir).normalize();
    if (_v3.lengthSq() < 0.1) _v3.set(1, 0, 0);
    walkCtl.enter(p, _v2, _v3);
    if (yawDeg === 0) {
      walkCtl.yaw = bestYaw;
      if (bias === 'sunset') walkCtl.pitch = 0.02;   // keep the low sun in frame
    }
    walkCtl.yaw += yawDeg * Math.PI / 180;
    walkCtl.update(0.001);
    nav.pos.copy(p.posUniv).add(walkCtl.posLocal);
    nav.quat.copy(walkCtl.quat);
    focusPlanet = p;
    spaceCtl.focus = p;
    ui.setTarget(p, 0);
    setState('walk');
    return true;
  },
  // stand on the seabed of planet i, eyes underwater (water-depth checks).
  // Picks a sunlit spot ~15 m down so light still reads through the surface.
  dive(i) {
    const p = universe.system.planets[i];
    if (!p || !p.hasLiquid || (p.liquid !== 'water' && p.liquid !== 'toxic')) return false;
    window.NMS_NOLOCK = true;
    tweens.length = 0;
    const sunDir = p.sunDirLocal.clone();
    const want = Math.max(12, Math.min(p.hAmp * 0.25, 18));
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 900; k++) {           // golden-spiral sphere sweep
      const y = 1 - (2 * (k + 0.5)) / 900;
      const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
      _v.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
      // FULL band: octaves past 128 move terrain by ±tens of metres, which
      // is the entire dive depth — coarse sampling kept surfacing us
      const depth = p.seaLevel - p.height(_v, p.fullMaxFreq);
      if (depth < 10) continue;
      const score = -Math.abs(depth - want) + _v.dot(sunDir) * 25;
      if (score > bestScore) { bestScore = score; best = _v.clone(); }
    }
    if (!best) return false;
    parkShipNear(p, best);
    const ground = p.surfaceRadius(best);
    _v2.copy(best).multiplyScalar(ground + 1.7);
    _v3.crossVectors(sunDir, best).normalize();
    if (_v3.lengthSq() < 0.1) _v3.set(1, 0, 0);
    walkCtl.enter(p, _v2, _v3);
    walkCtl.pitch = 0.3;                      // tilt up toward the surface glow
    walkCtl.update(0.001);
    nav.pos.copy(p.posUniv).add(walkCtl.posLocal);
    nav.quat.copy(walkCtl.quat);
    focusPlanet = p; spaceCtl.focus = p;
    ui.setTarget(p, 0);
    setState('walk');
    return true;
  },
  // aim the walker at the parked ship (testing the landing pad)
  faceShip() {
    if (state !== 'walk' || !ship.parkedPosUniv) return false;
    _v.copy(ship.parkedPosUniv).sub(nav.pos);
    _up.copy(nav.pos).sub(walkCtl.planet.posUniv).normalize();
    const e1 = new THREE.Vector3();
    if (Math.abs(_up.y) < 0.93) e1.set(_up.z, 0, -_up.x).normalize();
    else e1.set(0, -_up.z, _up.y).normalize();
    const e2 = new THREE.Vector3().crossVectors(_up, e1);
    walkCtl.yaw = Math.atan2(_v.dot(e1), _v.dot(e2));
    // pitch to where the ship actually IS — flat pads can sit well below
    // a scenic cliff-perch spawn (slightly above so it rides the lower third)
    const dh = Math.hypot(_v.dot(e1), _v.dot(e2));
    walkCtl.pitch = clamp(Math.atan2(_v.dot(_up), Math.max(dh, 1)) + 0.05, -0.9, 0.35);
    walkCtl.update(0.001);
    return true;
  },
  lookYaw(deg) {
    if (state === 'walk') { walkCtl.yaw += deg * Math.PI / 180; walkCtl.update(0.001); }
    else nav.quat.multiply(_q.setFromAxisAngle(_v3.set(0, 1, 0), -deg * Math.PI / 180));
  },
  lookPitch(deg) {
    if (state === 'walk') { walkCtl.pitch = clamp(walkCtl.pitch + deg * Math.PI / 180, -1.45, 1.45); walkCtl.update(0.001); }
    else nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), deg * Math.PI / 180));
  },
  flyTo: (i) => { const p = universe.system.planets[i]; if (p) { focusPlanet = p; spaceCtl.focus = p; flyToPlanet(p); } },
  tryLand, takeoff, boardShip, recallShip,
  shipDistance: () => parkedShipDistance(),
  nearStars: () => universe.nearStarsList
    .map((s) => ({ id: s.id, dist: Math.round(s.pos.distanceTo(nav.pos)), pos: s.pos.toArray() }))
    .sort((a, b) => a.dist - b.dist).slice(0, 50),
  starCount: () => universe.nearStarsList.length,
  system: () => ({
    id: universe.system.star.id,
    name: universe.system.name,
    planets: universe.system.planets.length,
    fading: universe.fadingSystem ? universe.fadingSystem.star.id : null,
  }),
  // park the camera anywhere in universe coords (testing manual flight)
  setPosition(x, y, z, lookX, lookY, lookZ) {
    tweens.length = 0;
    if (walkCtl.active) walkCtl.exit();
    setState('space');
    nav.pos.set(x, y, z);
    nav.vel.set(0, 0, 0);
    if (lookX !== undefined) lookQuatAt(nav.pos, _v.set(lookX, lookY, lookZ), nav.quat);
    return true;
  },
  warpToStar(id) {
    let s = id ? universe.nearStarsList.find((x) => x.id === id) : null;
    if (!s) {
      let best = Infinity;
      for (const st of universe.nearStarsList) {
        const d = st.pos.distanceTo(nav.pos);
        if (d < best) { best = d; s = st; }
      }
    }
    if (s) warpTo(s);
    return s ? s.id : null;
  },
  openStarMap: () => { openStarMap(); return true; },
  closeStarMap: () => { closeStarMap(false); return true; },
  get starMapOpen() { return !!starMap?.isOpen; },
  selectStarMapTarget(id) {
    const star = universe.nearStarsList.find((item) => item.id === id);
    if (!star || !starMap?.isOpen) return null;
    starMap.selectStar(star, false);
    return star.id;
  },
  setStarMapMode(mode) {
    if (!starMap?.isOpen || !['galaxy', 'system'].includes(mode)) return false;
    starMap.setMode(mode);
    return true;
  },
  setSeed: (s) => newUniverse(s),
  pos: () => nav.pos.toArray(),
  quat: () => nav.quat.toArray(),
  alt: () => nearestAlt,
  isTouch: IS_TOUCH,
  walkSpeed: () => walkCtl.hSpeed.length(),
  warp: () => warpIntensity,
  pulseFuel: () => pulseFuel,
  setPulse(active) {
    pulseEngaged = !!active && pulseFuel > 0.01
      && (!nearest || nearestAlt > nearest.atmoHeight * 1.08);
    return pulseEngaged;
  },
  fireWeapon() {
    if (state !== 'space') return false;
    weapons.fire(nav, spaceCtl.speedScale, ship);
    audio.cue('fire');
    return true;
  },
  // seam accounting: unmorphed LOD level changes with their apparent size
  lod: () => ({ ...lodStats }),
  lodReset: () => { lodStatsReset(); return true; },
  shipVisible(v) { ship.group.visible = v; return true; },
  // internals, for the headless diagnosis harness
  get _internals() { return { universe, scene, renderer, nav, camera }; },
};

// Reproducible visual-QA poses. These are opt-in URL states and never alter
// the normal campaign start.
if (qs.get('scene') === 'walk') {
  window.NMS.land(Number(qs.get('planet') || 0), Number(qs.get('yaw') || 0), qs.get('bias') || 'meadow');
  if (qs.get('face') === 'ship') window.NMS.faceShip();
}

if (qs.get('scene') === 'lowflight') {
  window.NMS.coast(Number(qs.get('planet') || 0), Number(qs.get('alt') || 800));
}

if (qs.get('scene') === 'orbit') {
  window.NMS.teleport(Number(qs.get('planet') || 0), Number(qs.get('factor') || 0.12));
}

if (qs.get('scene') === 'surfaceflight') {
  window.NMS.land(Number(qs.get('planet') || 0), Number(qs.get('yaw') || 0), qs.get('bias') || 'meadow');
  const p = walkCtl.planet;
  if (p) {
    const up = walkCtl.posLocal.clone().normalize();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quat)
      .projectOnPlane(up).normalize();
    walkCtl.exit();
    nav.pos.copy(p.posUniv).addScaledVector(up,
      p.surfaceRadius(up) + Number(qs.get('alt') || 18));
    horizonQuat(up, forward, nav.quat);
    nav.vel.set(0, 0, 0);
    setState('space');
  }
}
