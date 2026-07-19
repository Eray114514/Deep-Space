// Entry point: renderer, the state machine (space flight → fly-to → landing →
// walking → takeoff → warp), camera-relative rendering (the camera never
// leaves the origin — the universe moves around it, so float precision holds
// from interstellar space down to boot level), and the ambience pass
// (atmosphere, fog, day/night, star dimming).

import * as THREE from 'three';
import { Universe } from './galaxy.js';
import { flushChunkQueue, pendingChunks, setGridCells, lodStats, lodStatsReset, setPxPerRad } from './quadtree.js';
import { SpaceControls, WalkControls, guidePlanetApproach, keys } from './controls.js';
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
import { makeWord } from './names.js';
import { CelestialClock, eclipseFraction } from './astronomy.js';
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
const DEV_SERVER = window.__NMS_DEV_SERVER__ === true;
document.body.classList.toggle('dev-runtime', DEV_SERVER);
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
console.info(`深空 v${VERSION}`);

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
let nearest = null;
let nearestAlt = Infinity;
let referenceBody = null;
const referenceBodyPos = new THREE.Vector3();
// 上一帧 referenceBody 的本体系朝向，用于低空悬停时把飞船挂靠到行星
// 自转坐标系。referenceBodyFrameValid 在连续跟踪同一颗天体时为真，
// 切换目标的下一帧跳过一次增量以避免方向突变。
const referenceBodyFramePrev = new THREE.Quaternion();
let referenceBodyFrameValid = false;
let frameNo = 0;
let lastBuildFrame = 0;
let paused = false;
let photoMode = false;
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
const fixedTime = qs.has('time') ? Number(qs.get('time')) : null;
let celestialClock = new CelestialClock(SEED, {
  initialHours: Number.isFinite(fixedTime) ? fixedTime : null,
  persist: !Number.isFinite(fixedTime),
  frozen: FREEZE,
});
let universe = new Universe(SEED, scene);
universe.timeHours = celestialClock.hours;
universe.system.updateCelestial(celestialClock.hours);
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
let envEclipse = 0;

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
const spaceCtl = new SpaceControls(renderer.domElement, nav);
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
  if (e.code === 'KeyH') {
    photoMode = !photoMode;
    document.body.classList.toggle('hide-hud', photoMode);
  }
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
  onJoystick: (x, y) => { walkCtl.touchMove.x = x; walkCtl.touchMove.y = y; },
});
starMap = new StarMap({
  getUniverse: () => universe,
  getNav: () => nav,
  getSeed: () => SEED,
  getState: () => state,
  getTime: () => celestialClock.hours,
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

function findNextSolarEvent(body, kind, commit = false) {
  if (!body || body.isGasGiant) return null;
  const localUp = state === 'walk' && walkCtl.planet === body
    ? walkCtl.posLocal.clone().normalize()
    : body.worldPositionToLocal(nav.pos, new THREE.Vector3()).normalize();
  const start = celestialClock.hours;
  const step = Math.max(0.08, Math.min(0.5, body.rotationPeriodHours / 160));
  const limit = Math.min(240, body.rotationPeriodHours * 2.2);
  universe.system.updateCelestial(start);
  let previous = localUp.clone().applyQuaternion(body.frameOrientation).dot(body.sunDirWorld);
  let found = null;
  for (let dtHours = step; dtHours <= limit; dtHours += step) {
    const t = start + dtHours;
    universe.system.updateCelestial(t);
    const value = localUp.clone().applyQuaternion(body.frameOrientation).dot(body.sunDirWorld);
    const crossed = kind === 'sunrise' ? previous < 0 && value >= 0 : previous >= 0 && value < 0;
    if (crossed) { found = t; break; }
    previous = value;
  }
  universe.system.updateCelestial(commit && found != null ? found : start);
  if (commit && found != null) celestialClock.set(found);
  return found;
}

function localSolarTimeAt(body, worldPosition = null) {
  if (!body) return null;
  const surface = worldPosition
    ? body.worldPositionToLocal(worldPosition, new THREE.Vector3()).normalize()
    : new THREE.Vector3(1, 0, 0);
  const sun = body.sunDirLocal.clone();
  surface.y = 0; sun.y = 0;
  if (surface.lengthSq() < 1e-7 || sun.lengthSq() < 1e-7) return body.sunDirLocal.y >= 0 ? 12 : 0;
  surface.normalize(); sun.normalize();
  const angle = Math.atan2(new THREE.Vector3().crossVectors(sun, surface).y, sun.dot(surface));
  return ((12 + angle * 12 / Math.PI) % 24 + 24) % 24;
}

function findNextEclipse(body, commit = false) {
  if (!body) return null;
  const system = universe.system;
  const start = celestialClock.hours;
  const localUp = state === 'walk' && walkCtl.planet === body
    ? walkCtl.posLocal.clone().normalize()
    : new THREE.Vector3(0, 1, 0);
  const observer = new THREE.Vector3();
  const visibilityAt = (time) => {
    system.updateCelestial(time);
    body.localPositionToWorld(localUp.clone().multiplyScalar(body.R + 2), observer);
    let visibility = 1;
    for (const star of system.starViews) {
      const blockers = system.planets.filter((p) => p !== body)
        .map((p) => ({ position: p.posUniv, radius: p.R }));
      visibility = Math.min(visibility, eclipseFraction(
        observer, star.positionUniv, star.spec.radiusRender, blockers));
    }
    return visibility;
  };
  let previous = visibilityAt(start);
  let found = null;
  const longestOrbit = Math.max(240, ...system.spec.bodies.map((b) => b.orbit.periodHours));
  const step = Math.max(0.25, Math.min(3, longestOrbit / 5000));
  const limit = Math.min(longestOrbit * 1.2, 12000);
  for (let elapsed = step; elapsed <= limit; elapsed += step) {
    const visible = visibilityAt(start + elapsed);
    if (previous > 0.985 && visible <= 0.985) { found = start + elapsed; break; }
    previous = visible;
  }
  system.updateCelestial(commit && found != null ? found : start);
  if (commit && found != null) celestialClock.set(found);
  return found;
}

function waitForSolarEvent(kind) {
  const body = walkCtl.planet || nearest || focusPlanet;
  const found = findNextSolarEvent(body, kind, true);
  ui.setHint(found == null ? '当前目标没有可计算的地表日照事件' : kind === 'sunrise' ? '宇宙时钟已推进至日出' : '宇宙时钟已推进至日落', true);
}

function waitForEclipse() {
  const body = walkCtl.planet || nearest || focusPlanet;
  const found = findNextEclipse(body, true);
  ui.setHint(found == null ? '近期轨道窗口内没有可见食象' : '宇宙时钟已推进至下一次食象', true);
}

document.getElementById('wait-sunrise-btn').addEventListener('click', () => waitForSolarEvent('sunrise'));
document.getElementById('wait-sunset-btn').addEventListener('click', () => waitForSolarEvent('sunset'));
document.getElementById('wait-eclipse-btn').addEventListener('click', waitForEclipse);

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
  u.onSystemChange = (sys) => ui.setSystem(sys.name, sys._specs.length, SEED, sys.catalogId);
  u.onBeforeSystemDispose = (sys) => {
    if (walkCtl.planet && sys.planets.includes(walkCtl.planet)) return false; // not under our feet
    if (focusPlanet && sys.planets.includes(focusPlanet)) {
      focusPlanet = null;
      spaceCtl.focus = null;
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
    space: '<b>单指</b> 转向 · <b>双指缩放</b> 推进 · <b>M</b> 星图',
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
function flyToPlanet(planet) {
  if (state !== 'space') return;
  const startPos = nav.pos.clone();
  const startQuat = nav.quat.clone();
  const sunDir = planet.sunDirWorld.clone();
  const fromDir = _v2.copy(startPos).sub(planet.posUniv).normalize();
  // arrive on the sunlit side, offset from straight-in for a nicer reveal
  const targetDir = fromDir.add(sunDir.multiplyScalar(1.1)).normalize();
  const endPos = planet.posUniv.clone().addScaledVector(targetDir, planet.R * 3.1);
  const lastCenter = planet.posUniv.clone();
  const dur = clamp(startPos.distanceTo(endPos) / 65000 + 1.4, 1.8, 7);
  setState('flyto');
  nav.vel.set(0, 0, 0);
  addTween(dur, (k) => {
    const shift = planet.posUniv.clone().sub(lastCenter);
    startPos.add(shift); endPos.add(shift); lastCenter.copy(planet.posUniv);
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
  const landH = planet.height(up, planet.fullMaxFreq);
  let best = null, bestH = 0, bestScore = Infinity;
  // Boarding is part of the landing contract: stay within a short walk even
  // when a scenic perch has dramatic relief around it.
  for (const rad of [22, 28, 34, 38]) {
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
      const clearH = Math.max(h, ha, hb);
      const playerDistance = Math.hypot(rad, clearH - landH);
      if (playerDistance > BOARD_DISTANCE - 3) continue;
      const score = slope * 24 + rad * 0.03 + Math.abs(clearH - landH) * 0.08;
      if (score < bestScore) {
        bestScore = score; best = cand.clone();
        bestH = clearH;                            // clear the whole footprint
      }
    }
    if (best && bestScore < 1.4) break;            // flat enough, stop early
  }
  if (!best) {   // everything around is wet/steep — keep the ship reachable
    cand.copy(up).addScaledVector(e1, 22 / planet.R).normalize();
    best = cand.clone();
    bestH = clamp(planet.height(cand, planet.fullMaxFreq), landH - 28, landH + 28);
  }
  const padLocal = best.clone().multiplyScalar(planet.R + bestH + 1.3);
  const padUniv = planet.localPositionToWorld(padLocal, new THREE.Vector3());
  // nose pointed at the player
  _v2.copy(landDir).sub(best).normalize();
  const parkedLocalQuat = horizonQuat(best, _v2, new THREE.Quaternion());
  const parkedWorldQuat = planet.frameOrientation.clone().multiply(parkedLocalQuat);
  ship.parkedPlanet = planet; ship.parkedLocal = padLocal; ship.parkedLocalQuat = parkedLocalQuat;
  ship.setParked(padUniv, parkedWorldQuat);
}

function tryLand() {
  if (state !== 'space' || !nearest || nearest.isGasGiant || nearest.landable === false || nearestAlt > 420) return;
  const planet = nearest;
  const startLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const startLocalQuat = planet._invFrame.clone().multiply(nav.quat);
  const dirLocal = startLocal.clone().normalize();
  const ground = planet.surfaceRadius(dirLocal);
  const endLocal = dirLocal.clone().multiplyScalar(ground + 1.7);
  const viewLocal = _v2.set(0, 0, -1).applyQuaternion(startLocalQuat);
  const endLocalQuat = horizonQuat(dirLocal, viewLocal, new THREE.Quaternion());
  if (!window.NMS_NOLOCK && !IS_TOUCH) renderer.domElement.requestPointerLock();
  parkShipNear(planet, dirLocal);
  setState('landing');
  ui.showLand(false);
  nav.vel.set(0, 0, 0);
  addTween(1.9, (k) => {
    const e = easeInOut(k);
    planet.localPositionToWorld(_v.lerpVectors(startLocal, endLocal, e), nav.pos);
    nav.quat.copy(planet.frameOrientation)
      .multiply(_q.copy(startLocalQuat).slerp(endLocalQuat, e));
  }, () => {
    planet.worldPositionToLocal(nav.pos, _v);
    _v2.set(0, 0, -1).applyQuaternion(nav.quat).applyQuaternion(planet._invFrame);
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
  const playerDir = planet.worldPositionToLocal(nav.pos, _v).normalize().clone();
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
  const startLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const upLocal = ship.parkedLocal.clone().normalize();
  const targetLocal = ship.parkedLocal.clone().addScaledVector(upLocal, 2.2);
  const startLocalQuat = planet._invFrame.clone().multiply(nav.quat);
  const targetLocalQuat = ship.parkedLocalQuat.clone();
  walkCtl.exit();
  nav.vel.set(0, 0, 0);
  setState('boarding');
  audio.cue('board');
  addTween(0.72, (k) => {
    const e = easeInOut(k);
    planet.localPositionToWorld(_v.lerpVectors(startLocal, targetLocal, e), nav.pos);
    nav.quat.copy(planet.frameOrientation)
      .multiply(_q.copy(startLocalQuat).slerp(targetLocalQuat, e));
  }, () => takeoff(planet,
    planet.localPositionToWorld(targetLocal, new THREE.Vector3()),
    planet.localOffsetToWorld(upLocal, new THREE.Vector3())));
  return true;
}

function takeoff(planet = walkCtl.planet, launchPos = nav.pos.clone(), launchUp = null) {
  if (!planet) return false;
  if (walkCtl.active) walkCtl.exit();
  // Keep pointer lock across boarding/takeoff. Re-acquiring it at the end of
  // an async tween is no longer inside the user's gesture and browsers reject
  // the request, leaving the ship apparently unable to steer after launch.
  const startLocal = planet.worldPositionToLocal(launchPos, new THREE.Vector3());
  const upLocal = launchUp
    ? planet.worldOffsetToLocal(launchUp, new THREE.Vector3()).normalize()
    : startLocal.clone().normalize();
  const endLocal = startLocal.clone().addScaledVector(upLocal, 420);
  const localQuat = planet._invFrame.clone().multiply(nav.quat);
  planet.localPositionToWorld(startLocal, nav.pos);
  setState('takeoff');
  addTween(1.5, (k) => {
    planet.localPositionToWorld(_v.lerpVectors(startLocal, endLocal, easeInOut(k)), nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(localQuat);
  }, () => {
    setState('space');
    planet.localOffsetToWorld(upLocal, nav.vel).multiplyScalar(140);
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
  spaceCtl.focus = null;
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
  let arrivalSystem = null, arrivalSpec = null, revealDirection = null;
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
      if (arrivalSpec) {
        const heroPos = arrivalSystem.frames.get(arrivalSpec.bodyId).position;
        endPos.copy(heroPos).addScaledVector(revealDirection, arrivalSpec.radius * 2.55);
        targetQuat = lookQuatAt(nav.pos, heroPos, targetQuat);
      }
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
          const heroPos = destination.frames.get(hero.bodyId).position;
          revealDirection = startPos.clone().sub(heroPos).normalize();
          arrivalSystem = destination; arrivalSpec = hero;
          endPos = heroPos.clone().addScaledVector(revealDirection, hero.radius * 2.55);
          targetQuat = lookQuatAt(startPos, heroPos, new THREE.Quaternion());
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
  ship.parkedPlanet = null;
  ship.parkedLocal = null;
  ship.parkedPosUniv = null;
  celestialClock.save();
  celestialClock = new CelestialClock(SEED, {
    initialHours: Number.isFinite(fixedTime) ? fixedTime : null,
    persist: !Number.isFinite(fixedTime),
    frozen: FREEZE,
  });
  universe = new Universe(SEED, scene);
  universe.timeHours = celestialClock.hours;
  universe.system.updateCelestial(celestialClock.hours);
  wireUniverse(universe);
  focusPlanet = null;
  spaceCtl.focus = null;
  warpIntensity = 0;
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
  setState('space');
  spawn();
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
  ui.setSystem(sys.name, sys.planets.length, SEED, sys.catalogId);
  setState('space');
}

// ---- ambience: atmosphere entry, sky color, fog, star dimming ------------------
function ambience() {
  let inAtmo = 0, day = 1, skyStrength = 0;
  envEclipse = 0;
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
    const sunDir = nearest.sunDirWorld || universe.system.sunDirFrom(nav.pos, _v);
    const blockers = universe.system.planets
      .filter((body) => body !== p)
      .map((body) => ({ position: body.posUniv, radius: body.R }));
    let totalFlux = 0, litFlux = 0, clearLitFlux = 0;
    for (const view of universe.system.starViews) {
      const delta = _v2.copy(view.positionUniv).sub(nav.pos);
      const flux = view.spec.luminositySolar / Math.max(1, delta.lengthSq());
      const directDay = smoothstep(-0.22, 0.28, _up.dot(delta.normalize()));
      const visibility = inAtmo > 0.02
        ? eclipseFraction(nav.pos, view.positionUniv, view.spec.radiusRender, blockers)
        : 1;
      totalFlux += flux;
      clearLitFlux += flux * directDay;
      litFlux += flux * directDay * (0.08 + visibility * 0.92);
    }
    day = totalFlux > 0 ? clamp(litFlux / totalFlux, 0, 1) : 0;
    envEclipse = clearLitFlux > 0 ? clamp(1 - litFlux / clearLitFlux, 0, 1) : 0;

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

    hemi.intensity = inAtmo * 1.08 * (0.025 + 0.975 * day);
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
  ambient.intensity = 0.025 + inAtmo * (0.035 + day * 0.16);
  envInAtmo = inAtmo;
  envDay = day;
  // hand the sun over to the shadow-casting light near the ground
  shadowBlend = nearest ? 1 - smoothstep(1200, 3500, nearestAlt) : 0;
  if (nearest && shadowBlend > 0) sunDirCam.copy(nearest.sunDirWorld);
}

// ---- main loop --------------------------------------------------------------------
const clock = new THREE.Clock();
let statAcc = 0;
let devFpsElapsed = 0;
let devFpsFrames = 0;
let pauseFrameRendered = false;
let perfEmaMs = 16.7;
let dprAcc = 0;

function frame() {
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  // Keep slow-frame input responsive without allowing a tab-resume spike to
  // tunnel through terrain. A 100 ms ceiling still gives stable collision at
  // the browser game's supported low-quality floor.
  const dt = clamp(rawDt, 0.0001, 0.1);
  frameNo++;
  if (DEV_SERVER) {
    devFpsElapsed += rawDt;
    devFpsFrames++;
    if (devFpsElapsed >= 0.45) {
      ui.setDevFps(devFpsFrames / devFpsElapsed);
      devFpsElapsed = 0;
      devFpsFrames = 0;
    }
  }
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

  // Advance the persistent universe clock only during active play. The world
  // is updated before controls so a walker remains attached to the moving body.
  celestialClock.update(rawDt, !photoMode);
  const followFrame = state === 'space' && referenceBody
    && nav.pos.distanceTo(referenceBodyPos) < Math.max(referenceBody.R * 10, referenceBody.atmoHeight * 5);
  universe.update(nav.pos, state === 'space' || state === 'flyto', celestialClock.hours);
  if (followFrame && universe.planets().includes(referenceBody)) {
    nav.pos.add(_v.copy(referenceBody.posUniv).sub(referenceBodyPos));
    // 低空范围内让飞船挂靠行星自转：每帧把 nav.pos / nav.quat 同步应用
    // frameOrientation 的本帧增量，否则悬停找落点时地面疯狂转动、落点
    // 追不上。仅当连续跟踪同一颗 referenceBody 时启用，避免切换目标时
    // 一次性大旋转。
    if (referenceBodyFrameValid) {
      const lowOrbit = nav.pos.distanceTo(referenceBody.posUniv) - referenceBody.R
        < Math.max(referenceBody.atmoHeight * 1.5, referenceBody.R * 1.05);
      if (lowOrbit) {
        const dq = _q.copy(referenceBody.frameOrientation).multiply(referenceBodyFramePrev.invert());
        nav.pos.sub(referenceBody.posUniv).applyQuaternion(dq).add(referenceBody.posUniv);
        nav.quat.premultiply(dq);
      }
    }
  }
  if (ship.parkedPlanet && universe.planets().includes(ship.parkedPlanet) && ship.parkedLocal) {
    ship.parkedPlanet.localPositionToWorld(ship.parkedLocal, ship.parkedPosUniv);
    ship.parkedQuat.copy(ship.parkedPlanet.frameOrientation).multiply(ship.parkedLocalQuat);
  }

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
  const prevRef = referenceBody;
  referenceBody = nearest;
  if (nearest) {
    referenceBodyPos.copy(nearest.posUniv);
    referenceBodyFramePrev.copy(nearest.frameOrientation);
  }
  // 仅在连续跟踪同一颗天体时启用自转跟随，目标切换的本帧跳过增量。
  referenceBodyFrameValid = !!nearest && nearest === prevRef;

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
      spaceCtl.surfaceUp.copy(nav.pos).sub(nearest.posUniv).normalize();
      // Blend in across the atmosphere and become firm near terrain. This is
      // a roll-only correction; pitch and heading remain player-controlled.
      spaceCtl.horizonAssist = 1 - smoothstep(0.16, 0.95, alt / h);
      const surfaceScale = clamp(38 + Math.pow(alt, 0.58) * 0.32, 38, 620);
      const orbitalScale = clamp(650 + alt * 0.018, 650, 120000);
      const orbitalBlend = smoothstep(0.72, 3.5, alt / h);
      spaceCtl.speedScale = lerp(surfaceScale, orbitalScale, orbitalBlend);
    } else {
      spaceCtl.speedScale = 120000;
      spaceCtl.horizonAssist = 0;
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
      // frame. Scaling every component preserves the path instead of adding
      // an outward kick that turns oblique/polar entries into fly-bys.
      _v.copy(nav.pos).sub(nearest.posUniv);
      const centerDistance = _v.length();
      const radialOut = _v.multiplyScalar(1 / Math.max(centerDistance, 1));
      const forward = _v2.set(0, 0, -1).applyQuaternion(nav.quat);
      const safeInward = (55 + Math.pow(Math.max(0, nearestAlt), 0.75) * 0.6)
        * (pulseActive ? 1.35 : 1);
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), safeInward, 0);
    }
    spaceCtl.update(dt);
    if (nearest) {
      _v.copy(nav.pos).sub(nearest.posUniv);
      const centerDistance = _v.length();
      const radialOut = _v.multiplyScalar(1 / Math.max(centerDistance, 1));
      const forward = _v2.set(0, 0, -1).applyQuaternion(nav.quat);
      const safeInward = (55 + Math.pow(Math.max(0, nearestAlt), 0.75) * 0.6)
        * (pulseActive ? 1.35 : 1);
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), safeInward, dt);
    }
    // never fly into the ground
    if (nearest && !nearest.isGasGiant && nearestAlt < 3) {
      _v.copy(nav.pos).sub(nearest.posUniv).normalize();
      const localDir = nearest.worldOffsetToLocal(_v, _v2).normalize();
      const localGround = localDir.multiplyScalar(nearest.surfaceRadius(localDir) + 3);
      nearest.localPositionToWorld(localGround, nav.pos);
      const inward = Math.min(0, nav.vel.dot(_v));
      nav.vel.addScaledVector(_v, -inward);
    }
    if (nearest?.isGasGiant && nearestAlt < -nearest.R * 0.1) {
      // Pressure-protection autopilot: no death loop, but the cloud dive has a
      // strong physical consequence and temporarily takes the controls.
      _v.copy(nav.pos).sub(nearest.posUniv).normalize();
      nav.pos.copy(nearest.posUniv).addScaledVector(_v, nearest.R * 0.92);
      nav.vel.addScaledVector(_v, Math.max(900, -nav.vel.dot(_v) + 900));
      ui.setHint('压力临界 · 自动驾驶强制拉升', true);
      pulseEngaged = false;
    }
  } else if (state === 'walk') {
    pulseActive = false;
    spaceCtl.pulseDrive = false;
    walkCtl.update(dt);
    walkCtl.planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(walkCtl.planet.frameOrientation).multiply(walkCtl.quat);
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

  // Render adapters consume the already-updated simulation frames.
  for (const p of universe.planets()) {
    _v.copy(nav.pos).sub(p.posUniv);
    p.update(_v, dt, p === nearest, FREEZE || photoMode ? 0 : dt);
  }
  if (nearest && !nearest.isGasGiant) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    nearest.worldOffsetToLocal(_v, _v);
    scatter.update(nearest, _v, nearestAlt);
    if (FARFLORA) farFlora.update(nearest, _v, nearestAlt);
  } else {
    if (scatter.planet) scatter.clear();
    if (farFlora.planet) farFlora.clear();
  }

  ambience();
  if (nearest?.isGasGiant && nearestAlt < nearest.atmoHeight) {
    const depth = clamp(-nearestAlt / (nearest.R * 0.1), 0, 1);
    const pressure = 1 + depth * depth * 340;
    const temperature = nearest.type === 'iceGiant' ? 95 + depth * 520 : 145 + depth * 1250;
    const wind = 90 + (1 - clamp(nearestAlt / nearest.atmoHeight, 0, 1)) * 520;
    if (state === 'space') {
      _up.copy(nav.pos).sub(nearest.posUniv).normalize();
      _v3.set(Math.sin(celestialClock.hours * 8.1), 0.37, Math.cos(celestialClock.hours * 6.7))
        .projectOnPlane(_up).normalize();
      nav.vel.addScaledVector(_v3, wind * (0.08 + depth * 0.32) * dt);
    }
    document.body.classList.toggle('gas-danger', depth > 0.35);
    ui.setHint(`巨行星云层 · 风切 ${wind.toFixed(0)} m/s · ${temperature.toFixed(0)} K · 压力 ${pressure.toFixed(1)} bar · ${depth > 0.35 ? '立即拉升' : '无固体表面'}`, true);
  } else {
    document.body.classList.remove('gas-danger');
  }

  // land prompt
  const canLand = state === 'space' && nearest && !nearest.isGasGiant && nearest.landable !== false
    && nearestAlt < 420 && nav.vel.length() < 4000;
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
    const dominantView = universe.system.dominantStarFrom(nearest?.posUniv || nav.pos);
    const sysLight = dominantView.light;
    sunShadow.intensity = sysLight.intensity * shadowBlend * (1 - envEclipse * 0.92);
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
  const localHours = nearest ? localSolarTimeAt(nearest, nav.pos) : null;
  ui.setCosmicTime(celestialClock.hours, localHours);
  _v.set(0, 0, -1).applyQuaternion(nav.quat);
  ui.setHeading(Math.atan2(_v.x, -_v.z) * 180 / Math.PI);
  if (volumePass) {
    const motion = clamp(trueSpd / Math.max(nearest?.R || 1, 60000) * 18 + boostVisual * 0.22, 0, 1);
    volumePass.setActivePlanet(nearest?.isGasGiant ? null : nearest, nav.pos, motion);
  }
  foregroundPass.enabled = VOLUME_ENABLED && ['space', 'flyto', 'landing', 'takeoff', 'boarding'].includes(state);
  ambient.layers.enable(SHIP_FOREGROUND_LAYER);
  hemi.layers.enable(SHIP_FOREGROUND_LAYER);
  headlamp.layers.enable(SHIP_FOREGROUND_LAYER);
  sunShadow.layers.enable(SHIP_FOREGROUND_LAYER);
  for (const view of universe.system?.starViews || []) view.light.layers.enable(SHIP_FOREGROUND_LAYER);
  for (const view of universe.fadingSystem?.starViews || []) view.light.layers.enable(SHIP_FOREGROUND_LAYER);

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

  if (!FREEZE && !photoMode) tickShaders(dt);
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
      cosmicHours: celestialClock.hours, timeScale: celestialClock.scale,
      dayLight: envDay, eclipse: envEclipse,
      gpu: gpuName, dpr: renderDpr,
      far: farFlora.meshes ? farFlora.meshes[0].count + farFlora.meshes[1].count : 0,
    };
  },
  planets() {
    return universe.system.planets.map((p, i) => ({
      i, bodyId: p.bodyId, name: p.name, catalogName: p.catalogName,
      type: p.type, typeLabel: p.typeLabel, R: Math.round(p.R), isMoon: !!p.isMoon,
      isGasGiant: !!p.isGasGiant, landable: p.landable !== false && !p.isGasGiant,
      rotationPeriodHours: p.spec?.rotationPeriodHours ?? null,
      orbitPeriodHours: p.spec?.orbit?.periodHours ?? null,
      axialTiltDeg: p.spec ? p.spec.axialTilt * 180 / Math.PI : null,
      equilibriumK: p.spec?.equilibriumK ?? null,
      atmosphere: p.spec?.atmosphere ?? null,
      localSolarTime: localSolarTimeAt(p, p === nearest ? nav.pos : null),
      hasLiquid: p.hasLiquid, liquid: p.liquid,
      cloudAlt: p.cloudBands && p.cloudBands.length ? Math.round(p.cloudBands[0].r - p.R) : 0,
      cloudCoverage: p.cloudCoverage || 0,
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
      : p.isGasGiant
        ? sunDir.clone().add(new THREE.Vector3(0.31, 0.13, 0.19)).normalize()
        : p.scenicDir(sunDir).lerp(sunDir, 0.55).normalize();
    p.localPositionToWorld(dir.clone().multiplyScalar(p.R + p.R * altFactor), nav.pos);
    nav.vel.set(0, 0, 0);
    if (opts.horizon) {
      _v2.crossVectors(dir, sunDir).normalize();
      nav.quat.copy(p.frameOrientation).multiply(horizonQuat(dir, _v2, new THREE.Quaternion()));
      // negative pitch looks down at the terrain
      nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), opts.pitch ?? -0.18));
    } else {
      lookQuatAt(nav.pos, p.posUniv, nav.quat);
    }
    focusPlanet = p; spaceCtl.focus = p;
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
    p.localPositionToWorld(best.clone().multiplyScalar(p.R + p.seaLevel + alt), nav.pos);
    nav.vel.set(0, 0, 0);
    nav.quat.copy(p.frameOrientation).multiply(horizonQuat(best, seaward, new THREE.Quaternion()));
    nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), -0.32));
    focusPlanet = p; spaceCtl.focus = p;
    return true;
  },
  // instantly stand on planet i at its scenic spot (no pointer lock).
  // bias picks the lighting: 'sunset' lands on the terminator ring, 'night'
  // on the far side (headlamp comes on), 'meadow' seeks flat vegetated
  // ground facing the tree line, default lands in full daylight.
  land(i, yawDeg = 0, bias = null) {
    const p = universe.system.planets[i];
    if (!p || p.isGasGiant || p.landable === false) return false;
    window.NMS_NOLOCK = true;
    tweens.length = 0;
    const sunDir = p.sunDirLocal.clone();
    const meadow = bias === 'meadow';
    const snowy = bias === 'snow';
    let prefer = sunDir, ring = null;
    if (bias === 'night') prefer = sunDir.clone().negate();
    else if (bias === 'sunset') { prefer = null; ring = sunDir; }
    let dir = p.scenicDir(prefer, ring);
    if (snowy) {
      let bestSnow = null, bestSnowScore = -Infinity;
      const snowProbe = new THREE.Vector3(), snowTangent = new THREE.Vector3();
      for (let k = 0; k < 1800; k++) {
        const y = 1 - (2 * (k + 0.5)) / 1800;
        const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
        _v.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
        const h = p.height(_v, p.fullMaxFreq);
        if (p.snowWeightAt(_v, h) <= 0.35 || (p.hasLiquid && h < p.seaLevel + 2)) continue;
        if (Math.abs(_v.y) < 0.93) snowTangent.set(_v.z, 0, -_v.x).normalize();
        else snowTangent.set(0, -_v.z, _v.y).normalize();
        const nearH = p.height(snowProbe.copy(_v).addScaledVector(snowTangent, 18 / p.R).normalize(), p.fullMaxFreq);
        const slopePenalty = Math.abs(nearH - h) / 18;
        const score = _v.dot(sunDir) * 4 - Math.abs(h) / Math.max(p.hAmp, 1) - slopePenalty * 8;
        if (score > bestSnowScore) { bestSnowScore = score; bestSnow = _v.clone(); }
      }
      if (bestSnow) dir = bestSnow;
    }
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
      const sampleFreq = snowy ? p.fullMaxFreq : 128;
      const h = p.height(cand, sampleFreq);
      if (p.hasLiquid && h - p.seaLevel < 2) continue;
      if (snowy && p.snowWeightAt(cand, h) <= 0.28) continue;
      frame(cand, e1, e2);
      sunH.copy(sunDir).addScaledVector(cand, -sunDir.dot(cand));
      if (sunH.lengthSq() > 1e-4) sunH.normalize(); else sunH.set(0, 0, 0);
      const st = 10 / p.R;
      const hx = p.height(probe.copy(cand).addScaledVector(e1, st).normalize(), sampleFreq);
      const hy = p.height(probe.copy(cand).addScaledVector(e2, st).normalize(), sampleFreq);
      const hnx = p.height(probe.copy(cand).addScaledVector(e1, -st).normalize(), sampleFreq);
      const hny = p.height(probe.copy(cand).addScaledVector(e2, -st).normalize(), sampleFreq);
      let score = -(Math.abs(hx - h) + Math.abs(hy - h) + Math.abs(hnx - h) + Math.abs(hny - h))
        * (snowy ? 4.5 : meadow ? 2.0 : 1.2);   // flat footing
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
      score += yawScore * (snowy ? 1.25 : 8);   // snow QA favours safe footing over drama
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
    p.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
    focusPlanet = p;
    spaceCtl.focus = p;
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
    p.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
    focusPlanet = p; spaceCtl.focus = p;
    setState('walk');
    return true;
  },
  // aim the walker at the parked ship (testing the landing pad)
  faceShip() {
    if (state !== 'walk' || !ship.parkedPosUniv) return false;
    const p = walkCtl.planet;
    p.worldPositionToLocal(ship.parkedPosUniv, _v).sub(walkCtl.posLocal);
    _up.copy(walkCtl.posLocal).normalize();
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
  time: () => celestialClock.snapshot(),
  setTime(hours) {
    celestialClock.set(hours);
    universe.update(nav.pos, false, celestialClock.hours);
    universe.updateRelative(nav.pos);
    return celestialClock.snapshot();
  },
  advanceTime(hours) {
    celestialClock.advance(hours);
    universe.update(nav.pos, false, celestialClock.hours);
    universe.updateRelative(nav.pos);
    return celestialClock.snapshot();
  },
  referenceState() {
    const p = walkCtl.active ? walkCtl.planet : nearest;
    if (!p) return null;
    const playerLocal = p.worldPositionToLocal(nav.pos, new THREE.Vector3());
    const playerDir = playerLocal.clone().normalize();
    const terrainRadius = p.surfaceRadius(playerDir);
    scene.updateMatrixWorld(true);
    const downWorld = playerDir.clone().applyQuaternion(p.frameOrientation).negate();
    const terrainMeshes = p.group.children.filter((object) => object.isMesh
      && object.visible && object.geometry?.getAttribute('aLocal'));
    const ray = new THREE.Raycaster(camera.position, downWorld, 0, 20);
    const hit = ray.intersectObjects(terrainMeshes, false)[0] || null;
    return {
      bodyId: p.bodyId,
      state,
      playerLocal: playerLocal.toArray(),
      playerWorld: nav.pos.toArray(),
      eyeClearance: playerLocal.length() - terrainRadius,
      renderedEyeClearance: hit?.distance ?? null,
      terrainRadius,
      frameOrientation: p.frameOrientation.toArray(),
      shipLocal: ship.parkedPlanet === p && ship.parkedLocal ? ship.parkedLocal.toArray() : null,
      shipWorld: ship.parkedPlanet === p && ship.parkedPosUniv ? ship.parkedPosUniv.toArray() : null,
      shipDistance: parkedShipDistance(),
      pending: pendingChunks(),
      lod: p.lod.debugStats(),
    };
  },
  nextEvent(bodyId, kind = 'sunrise') {
    const body = universe.system.planets.find((p) => p.bodyId === bodyId || p.name === bodyId);
    if (!body || !['sunrise', 'sunset', 'eclipse'].includes(kind)) return null;
    if (kind === 'eclipse') return findNextEclipse(body);
    return findNextSolarEvent(body, kind, false);
  },
  system: () => ({
    id: universe.system.star.id,
    name: universe.system.name,
    properName: universe.system.spec.properName,
    catalogId: universe.system.spec.catalogId,
    generationVersion: universe.system.spec.generationVersion,
    habitableZoneAU: universe.system.spec.habitableZoneAU,
    snowLineAU: universe.system.spec.snowLineAU,
    stars: universe.system.spec.stars.map((star, index) => ({
      starId: star.starId, name: star.displayName, component: star.component,
      spectralClass: star.spectralClass, massSolar: star.massSolar,
      radiusSolar: star.radiusSolar, radiusRender: star.radiusRender, temperatureK: star.temperatureK,
      luminositySolar: star.luminositySolar,
      position: universe.system.starViews[index].positionUniv.toArray(),
    })),
    bodies: universe.system.spec.bodies.map((body) => ({
      bodyId: body.bodyId, parentId: body.parentId, name: body.name,
      catalogName: body.catalogName, type: body.type, radius: body.radius,
      landable: body.landable, equilibriumK: body.equilibriumK,
      atmosphere: body.atmosphere,
      rotationPeriodHours: body.rotationPeriodHours, axialTilt: body.axialTilt,
      orbit: { ...body.orbit },
      position: universe.system.positionAt(body.bodyId, celestialClock.hours).toArray(),
      velocity: universe.system.velocityAt(body.bodyId, celestialClock.hours).toArray(),
    })),
    planets: universe.system.planets.length,
    fading: universe.fadingSystem ? universe.fadingSystem.star.id : null,
  }),
  snowAudit(i, samples = 1200) {
    const p = universe.system.planets[i];
    if (!p || p.isGasGiant) return null;
    let snow = 0, violations = 0, treePotential = 0;
    const d = new THREE.Vector3(), ex = new THREE.Vector4();
    for (let k = 0; k < samples; k++) {
      const y = 1 - (2 * (k + 0.5)) / samples;
      const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
      d.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
      const h = p.height(d, 128), snowy = p.snowWeightAt(d, h) > 0.28;
      if (!snowy) continue;
      snow++;
      const biome = p.biomeAt(d, h);
      if (biome !== 'snow' && biome !== 'ice' && biome !== 'lava' && biome !== 'rock') violations++;
      p.extrasAt(d, h, 128, ex);
      if (biome === 'snow' && ex.x > 0) treePotential++;
    }
    return { samples, snow, violations, treePotential };
  },
  cloudAudit(i, samples = 4096) {
    const p = universe.system.planets[i];
    return p?.cloudAudit ? p.cloudAudit(samples) : null;
  },
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
      .applyQuaternion(p.frameOrientation.clone().invert()).projectOnPlane(up).normalize();
    walkCtl.exit();
    p.localPositionToWorld(up.clone().multiplyScalar(
      p.surfaceRadius(up) + Number(qs.get('alt') || 18)), nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(horizonQuat(up, forward, new THREE.Quaternion()));
    nav.vel.set(0, 0, 0);
    setState('space');
  }
}
