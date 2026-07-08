// Entry point: renderer, the state machine (space flight → fly-to → landing →
// walking → takeoff → warp), camera-relative rendering (the camera never
// leaves the origin — the universe moves around it, so float precision holds
// from interstellar space down to boot level), and the ambience pass
// (atmosphere, fog, day/night, star dimming).

import * as THREE from 'three';
import { Universe } from './galaxy.js';
import { flushChunkQueue, pendingChunks, setGridCells } from './quadtree.js';
import { SpaceControls, WalkControls, keys } from './controls.js';
import { Scatter } from './scatter.js';
import { WarpStreaks, SkyDome, Ship } from './effects.js';
import { tickShaders } from './shaders.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';
import { UI } from './ui.js';
import { clamp, lerp, smoothstep } from './noise.js';
import { makeWord, systemName } from './names.js';
import { makeRng } from './rng.js';
import { VERSION } from './version.js';

// ---- error surface (also read by the headless test harness) ---------------
const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
  errBox.classList.remove('hidden');
  errBox.textContent += `${e.message} @ ${e.filename}:${e.lineno}\n`;
});

const qs = new URLSearchParams(location.search);
let SEED = qs.get('seed') || 'EUCLID';
window.NMS_NOLOCK = qs.get('nolock') === '1';
const BUILD_MS = Number(qs.get('buildms')) || 0;
// ?quality=low for integrated GPUs: coarser grids, no bloom, lower res
const QUALITY_LOW = qs.get('quality') === 'low';
if (QUALITY_LOW) setGridCells(18);

document.getElementById('version').textContent = 'v' + VERSION;
console.info(`No Man's Sky three.js v${VERSION}`);

// touch-first device? (gestures replace wheel/keys, virtual stick for walking)
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

// ---- renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_LOW ? 1.25 : IS_TOUCH ? 1.7 : 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.0);
const BASE_FOV = 62;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.12, 3.2e9);
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
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
  samples: IS_TOUCH ? 2 : 4, type: THREE.HalfFloatType,
}));
composer.addPass(new RenderPass(scene, camera));
// threshold above 1.0: only genuinely HDR pixels bloom (sun, lava, engines,
// specular glints) — daytime sky must NOT veil the terrain
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), IS_TOUCH ? 0.35 : 0.5, 0.4, 1.05);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
let usePost = qs.get('post') !== '0' && !QUALITY_LOW;
renderer.info.autoReset = false;   // accumulate across composer passes
function sizePost() {
  composer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.7 : 2));
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

// star sprites need the projection factor to match suns' true angular size
function updateStarProj() {
  if (universe.starMaterial) {
    universe.starMaterial.uniforms.uProj.value =
      window.innerHeight / (2 * Math.tan(BASE_FOV * Math.PI / 360));
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

// ---- world ------------------------------------------------------------------
let universe = new Universe(SEED, scene);
const scatter = new Scatter();
const warpStreaks = new WarpStreaks(scene);
const skyDome = new SkyDome(scene);
const ship = new Ship(scene);
let warpIntensity = 0;
let envInAtmo = 0;       // exported by the ambience pass for audio/effects
let envDay = 1;
let envUnderwater = false;
const prevNavPos = new THREE.Vector3();
const _velActual = new THREE.Vector3();

// ---- temps ------------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
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
  if (state === 'walk' && !document.pointerLockElement && !window.NMS_NOLOCK && !IS_TOUCH) {
    renderer.domElement.requestPointerLock();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyL') tryLand();
  if (e.code === 'KeyT') takeoff();
  if (e.code === 'KeyH') document.body.classList.toggle('hide-hud');   // photo mode
  if (e.code === 'KeyB') usePost = !usePost;                           // bloom toggle
  if (e.code === 'Escape' && state === 'flyto') {
    tweens.length = 0;
    setState('space');
  }
});

// ---- UI ---------------------------------------------------------------------
const ui = new UI({
  onLand: tryLand,
  onNewUniverse: () => newUniverse(),
  onLabelClick: (idx) => {
    const p = universe.planets()[idx];
    if (p) clickPlanet(p);
  },
  onJoystick: (x, y) => { walkCtl.touchMove.x = x; walkCtl.touchMove.y = y; },
  onJump: (down) => { walkCtl.touchJump = down; },
  onTakeoff: () => takeoff(),
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
  spaceCtl.enabled = s === 'space';
  ui.setCrosshair(s === 'walk');
  ui.showTouchUI(IS_TOUCH && s === 'walk');
  const hints = IS_TOUCH ? {
    space: '<b>drag</b> look · <b>pinch</b> fly · <b>tap</b> a planet or a far star · <b>two-finger drag</b> orbit',
    flyto: 'travelling…',
    landing: 'descending…',
    walk: '<b>stick</b> move (push far to run) · <b>drag</b> look · <b>⤊</b> jump · <b>🚀</b> take off',
    takeoff: 'lifting off…',
    warp: 'warping…',
  } : {
    space: '<b>scroll</b> fly · <b>drag</b> look · <b>click</b> a planet or a far star · <b>right-drag</b> orbit',
    flyto: 'travelling… <b>Esc</b> to abort',
    landing: 'descending…',
    walk: '<b>WASD</b> move · <b>shift</b> run · <b>space</b> jump · <b>T</b> take off',
    takeoff: 'lifting off…',
    warp: 'warping…',
  };
  ui.setHint(hints[s] || '');
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
      const score = slope * 30 + rad * 0.012;      // flat beats near
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

function takeoff() {
  if (state !== 'walk') return;
  const planet = walkCtl.planet;
  walkCtl.exit();
  if (document.pointerLockElement) document.exitPointerLock();
  const startPos = nav.pos.clone();
  const up = _v.copy(startPos).sub(planet.posUniv).normalize().clone();
  const endPos = startPos.clone().addScaledVector(up, 420);
  setState('takeoff');
  addTween(1.5, (k) => {
    nav.pos.lerpVectors(startPos, endPos, easeInOut(k));
  }, () => {
    setState('space');
    nav.vel.copy(up).multiplyScalar(140);
  });
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
  // arrive outside the outermost orbit (capped at 480 km), aimed at the sun
  const arriveDir = startPos.clone().sub(star.pos).normalize();
  const endPos = star.pos.clone().addScaledVector(arriveDir, Math.max(star.radius * 35, 1.55e7));
  const dist = startPos.distanceTo(endPos);
  const dur = clamp(5.5 + dist / 4e7, 6.5, 12);
  const targetQuat = lookQuatAt(startPos, star.pos, new THREE.Quaternion());
  const SPOOL = 0.07;
  let swapped = false;
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
      if (kf >= 0.32 && !swapped) {
        // swap systems mid-flight; the new planets build one per frame
        swapped = true;
        universe.setSystem(star, true);
      }
    }
    camera.updateProjectionMatrix();
  }, () => {
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
    warpIntensity = 0;
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
  nav.pos.copy(planet.posUniv).addScaledVector(dir, planet.R * 3.6);
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
    const x = clamp(nearestAlt / (p.atmoHeight * 2.4), 0, 1);
    inAtmo = (1 - smoothstep(0.25, 1, x)) * p.atmoDensity;
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
  headlamp.intensity = state === 'walk' && day < 0.4 ? (0.4 - day) * 6 : 0;
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

function frame() {
  requestAnimationFrame(frame);
  const dt = clamp(clock.getDelta(), 0.0001, 0.05);
  frameNo++;

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
    spaceCtl.speedScale = clamp(nearestAlt * 0.55, 4, 3e6);
    spaceCtl.update(dt);
    // never fly into the ground
    if (nearest && nearestAlt < 3) {
      _v.copy(nav.pos).sub(nearest.posUniv).normalize();
      const ground = nearest.surfaceRadius(_v);
      nav.pos.copy(nearest.posUniv).addScaledVector(_v, ground + 3);
      const inward = Math.min(0, nav.vel.dot(_v));
      nav.vel.addScaledVector(_v, -inward);
    }
  } else if (state === 'walk') {
    walkCtl.update(dt);
    nav.pos.copy(walkCtl.planet.posUniv).add(walkCtl.posLocal);
    nav.quat.copy(walkCtl.quat);
  }
  stepTweens(dt);

  // true frame velocity (a warp moves nav.pos directly, not via nav.vel)
  if (frameNo > 2) _velActual.copy(nav.pos).sub(prevNavPos).multiplyScalar(1 / dt);
  warpStreaks.update(dt, _velActual, warpIntensity);
  // a deferred system (warp or manual approach) materializes one planet/frame
  if (universe.system && !universe.system.built) universe.system.buildNext();

  // world updates (proximity system swap allowed while free-flying)
  universe.update(nav.pos, state === 'space' || state === 'flyto');
  for (const p of universe.planets()) {
    _v.copy(nav.pos).sub(p.posUniv);
    p.update(_v, dt, p === nearest);
  }
  if (nearest) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    scatter.update(nearest, _v, nearestAlt);
  }

  ambience();

  // land prompt
  const canLand = state === 'space' && nearest && nearestAlt < 420 && nav.vel.length() < 4000;
  ui.showLand(!!canLand, nearest && nearest.hasLiquid && nearest.liquid !== 'ice' &&
    _v.copy(nav.pos).sub(nearest.posUniv).length() < nearest.seaRadius + 2
    ? 'DIVE — walk the seabed' : 'LAND — walk the surface (L)');

  // chunk builds: a per-frame millisecond budget (overridable for slow
  // software-rendered test environments via ?buildms=)
  const built = flushChunkQueue(BUILD_MS || (state === 'walk' ? 6 : 9));
  if (built > 0) lastBuildFrame = frameNo;

  // camera-relative placement
  universe.updateRelative(nav.pos);
  camera.position.set(0, 0, 0);
  camera.quaternion.copy(nav.quat);

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

  // atmospheric buffeting: fast flight through air rattles the camera
  const trueSpd = _velActual.length();
  if (envInAtmo > 0.05 && trueSpd > 220 && (state === 'space' || state === 'flyto')) {
    const amp = Math.min(1, trueSpd / 3200) * envInAtmo * 0.45;
    camera.position.set(
      (Math.random() - 0.5) * amp,
      (Math.random() - 0.5) * amp,
      (Math.random() - 0.5) * amp,
    );
  }

  // the ship flies just ahead of the camera whenever we're in flight
  ship.update(dt, nav, state, trueSpd, warpIntensity);

  // HUD
  if (focusPlanet) ui.setTargetDist(nav.pos.distanceTo(focusPlanet.posUniv) - focusPlanet.R);
  else if (focusStar) ui.setTargetDist(nav.pos.distanceTo(focusStar.pos));
  const spd = state === 'walk' ? walkCtl.hSpeed.length()
    : state === 'space' ? nav.vel.length() : _velActual.length();
  ui.setAltitude(nearest && nearestAlt < 2e7 ? Math.max(0, nearestAlt) : null, spd);
  updateLabels();

  statAcc += dt;
  if (statAcc > 0.5) {
    statAcc = 0;
    const info = renderer.info.render;
    let chunks = 0;
    for (const p of universe.planets()) chunks += p.lod.countChunks();
    ui.setStats(`${(1 / dt).toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1e6).toFixed(2)} Mtri · ${chunks} chunks · ${pendingChunks()} queued`);
  }

  tickShaders(dt);
  renderer.info.reset();
  if (usePost) composer.render();
  else renderer.render(scene, camera);
  prevNavPos.copy(nav.pos);
  if (frameNo === 3) ui.setLoading(false);
}

wireUniverse(universe);
spawn();
ui.setLoading(true, 'generating universe…');
frame();

// ---- debug / test API (used by tools/screenshot.js) ----------------------------
window.NMS = {
  version: VERSION,
  get booted() { return frameNo > 3; },
  get state() { return state; },
  seed: () => SEED,
  frame: () => frameNo,
  idle() {
    return frameNo > 10 && pendingChunks() === 0 && frameNo - lastBuildFrame > 8;
  },
  stats() {
    const info = renderer.info.render;
    let chunks = 0;
    for (const p of universe.planets()) chunks += p.lod.countChunks();
    return { frame: frameNo, calls: info.calls, tris: info.triangles, chunks, pending: pendingChunks(), state, alt: nearestAlt };
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
  // on the far side (headlamp comes on), default lands in full daylight.
  land(i, yawDeg = 0, bias = null) {
    const p = universe.system.planets[i];
    if (!p) return false;
    window.NMS_NOLOCK = true;
    tweens.length = 0;
    const sunDir = p.sunDirLocal.clone();
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
    for (let ci = 0; ci < 24; ci++) {
      const rr = 0.005 * Math.sqrt(ci / 24), ga = ci * 2.399963229728653;
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
      let score = -(Math.abs(hx - h) + Math.abs(hy - h)) * 1.2;   // flat footing
      const pinSun = bias === 'sunset' && sunH.lengthSq() > 0.5;
      let yawBest = 0, yawScore = -Infinity;
      for (let k = 0, kn = pinSun ? 1 : 8; k < kn; k++) {
        const yaw = pinSun ? Math.atan2(sunH.dot(e1), sunH.dot(e2)) : (k / 8) * Math.PI * 2;
        const fx = Math.cos(yaw), fy = Math.sin(yaw);
        let s = 0;
        // toward a horizon sun, probe FAR too — a 2 km ridge eats the sunset
        for (const dd of (pinSun ? [120, 350, 900, 2600, 6000] : [120, 350, 900])) {
          probe.copy(cand).addScaledVector(e2, fx * dd / p.R).addScaledVector(e1, fy * dd / p.R).normalize();
          s += (h - p.height(probe, 128)) / dd;        // terrain falls away = open
        }
        s -= (fx * e2.dot(sunH) + fy * e1.dot(sunH)) * 1.9;   // lit faces ahead
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
      // fine-ish band: the coarse field can sit metres below the real seabed
      const depth = p.seaLevel - p.height(_v, 128);
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
    walkCtl.pitch = -0.04;
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
  tryLand, takeoff,
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
  setSeed: (s) => newUniverse(s),
  pos: () => nav.pos.toArray(),
  quat: () => nav.quat.toArray(),
  alt: () => nearestAlt,
  isTouch: IS_TOUCH,
  walkSpeed: () => walkCtl.hSpeed.length(),
  warp: () => warpIntensity,
  // internals, for the headless diagnosis harness
  get _internals() { return { universe, scene, renderer, nav, camera }; },
};
