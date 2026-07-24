// Entry point: renderer, the state machine (space flight → fly-to → landing →
// walking → takeoff → warp), camera-relative rendering (the camera never
// leaves the origin — the universe moves around it, so float precision holds
// from interstellar space down to boot level), and the ambience pass
// (atmosphere, fog, day/night, star dimming).

import { StarSystem, Universe } from './galaxy.js';
import { flushChunkQueue, pendingChunks, setGridCells, lodStats, lodStatsReset, setPxPerRad } from './quadtree.js';
import { SpaceControls, WalkControls, guidePlanetApproach, keys,
  flightBoostSpeedLimit, pulseBurstDistance, pulseBurstProgress } from './controls.js';
import { Scatter } from './scatter.js';
import { FarFlora } from './farflora.js';
import { createWarpDriveNode, landingDescentProgress, SHIP_LANDING_PROFILE,
  warpTravelProgress, SkyDome, Ship, ShipWeapons, SHIP_FOREGROUND_LAYER } from './effects.js';
import { tickShaders } from './shaders.js';
import { UI } from './ui.js';
import { clamp, lerp, smoothstep } from './noise.js';
import { makeWord } from './names.js';
import { CelestialClock, TIME_SCALE, eclipseFraction, generateSystemSpec, orbitalPosition } from './astronomy.js';
import { VERSION } from './version.js';
import { FlightAudio } from './audio.js';
import { BackgroundMusic } from './music.js';
import { StarMap } from './starmap.js';
import './walkdial.js';
import { VolumetricPass } from './volumetric-pass.js';
import { createRiftDistortionNode, SpatialRift } from './spatial-rift.js';
import { SurfaceWeapons, SURFACE_WEAPONS } from './surface-weapons.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning } from './world-config.js';
import { setVolumetricCloudsEnabled } from './planet.js';
import { resolveRendererPolicy } from './renderer-policy.js';
import { createGameRenderer, installDeviceRecovery } from './renderer-runtime.js';
import { GameNodePipeline } from './node-render-pipeline.js';
import { GameNodePipelineV2 } from './render-pipeline-v2.js';
import { GameLegacyPipeline } from './legacy-render-pipeline.js';
import { isLowPowerGpu, resolveGraphicsSettings, resolveQualityProfile, writeGraphicsSettings } from './graphics-settings.js';

const qs = new URLSearchParams(location.search);
const graphicsSettings = resolveGraphicsSettings({ params: qs });
const rendererPolicy = resolveRendererPolicy(qs);
const BOOT_USE_NODE = rendererPolicy.useNodeMaterials;
const BOOT_USE_WEBGPU = rendererPolicy.backend === 'webgpu';
const THREE = await import(BOOT_USE_NODE ? 'three/webgpu' : 'three');

// ---- error surface (also read by the headless test harness) ---------------
const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
  errBox.classList.remove('hidden');
  errBox.textContent += `${e.message} @ ${e.filename}:${e.lineno}\n`;
});

document.body.classList.toggle('debug-hud', qs.get('debug') === '1');
const DEV_SERVER = window.__NMS_DEV_SERVER__ === true;
const WORLD_LAB = DEV_SERVER && qs.get('worldlab') === '1';
const GALAXY = getGalaxyConfig(WORLD_LAB ? qs.get('galaxy') || ACTIVE_GALAXY_ID : ACTIVE_GALAXY_ID);
const GALAXY_ID = GALAXY.id;
const CANONICAL_WORLD_SEED = GALAXY.seed;
document.body.classList.toggle('dev-runtime', DEV_SERVER);
let SEED = WORLD_LAB && qs.get('seed') ? qs.get('seed') : CANONICAL_WORLD_SEED;
if (!WORLD_LAB && qs.has('seed')) {
  const canonicalUrl = new URL(location.href);
  canonicalUrl.searchParams.delete('seed');
  history.replaceState(null, '', canonicalUrl);
}
function createUniverse(seed) {
  return new Universe(seed, scene, {
    galaxyId: GALAXY_ID,
    blackHoleSystem: GALAXY.blackHoleSystem,
    bodyTuning: (systemId, bodyId) => resolveBodyTuning({
      galaxyId: GALAXY_ID,
      seed,
      systemId,
      bodyId,
      worldLabParams: WORLD_LAB ? qs : null,
    }),
  });
}
window.NMS_NOLOCK = qs.get('nolock') === '1';
const BUILD_MS = Number(qs.get('buildms')) || 0;
// ?freeze=1: stop scenery-in-motion (waves, sway, cloud drift) so the seam
// test can pixel-compare static frames — any residual change is LOD activity
const FREEZE = qs.get('freeze') === '1';
document.getElementById('version').textContent = 'v' + VERSION;
console.info(`深空 v${VERSION}`);

// touch-first device? (gestures replace wheel/keys, virtual stick for walking)
const IS_TOUCH = qs.get('desktop') !== '1'
  && (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
// Hybrid Windows devices can report touch support while the player is using a
// mouse. Pointer Lock follows the active input modality, not hardware support.
let pointerLockInput = !IS_TOUCH;
window.addEventListener('pointerdown', (event) => {
  pointerLockInput = event.pointerType !== 'touch';
}, true);

// ---- renderer ---------------------------------------------------------------
const rendererOptions = {
  antialias: graphicsSettings.quality !== 'performance',
  // Layer passes share the renderer clear state. A transparent drawing buffer
  // gives the volume/foreground passes a zero-alpha background so compositing
  // them cannot replace the main scene with an opaque black rectangle.
  alpha: true,
  logarithmicDepthBuffer: true,
  powerPreference: qs.get('gpu') === 'low' ? 'low-power' : 'high-performance',
};
const rendererRuntime = await createGameRenderer(rendererPolicy, rendererOptions);
if (qs.get('renderer-recovery') === 'device-lost') {
  // Clean the recovery params from the URL so a refresh does not stick on WebGL.
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('renderer');
  cleanUrl.searchParams.delete('renderer-recovery');
  history.replaceState(null, '', cleanUrl);
}
const renderer = rendererRuntime.renderer;
const actualRendererBackend = rendererRuntime.backend;
const webgpuAdapterInfo = rendererRuntime.adapterInfo;
const gpuName = rendererRuntime.gpuName;
const QUALITY_PROFILE = resolveQualityProfile(graphicsSettings, gpuName, {
  touch: IS_TOUCH, width: window.innerWidth, height: window.innerHeight,
});
const QUALITY_LOW = QUALITY_PROFILE.id === 'performance';
// Near-field terrain density is never a performance-tier casualty.
setGridCells(QUALITY_PROFILE.gridCells);
renderer.setSize(window.innerWidth, window.innerHeight);
// DPR 以 devicePixelRatio 为基准:1.0 = 点对点,>1.0 = 超采样。floor 永不低于点对点,
// 避免升采样糊与纹理锯齿;省性能靠阴影/体积/网格密度。
const DPR_BASE = window.devicePixelRatio || 1;
const DPR_FLOOR = DPR_BASE * QUALITY_PROFILE.dprFloorMult;
const DPR_CEILING = DPR_BASE * QUALITY_PROFILE.dprCeilingMult;
let renderDpr = Math.min(Math.max(DPR_BASE * QUALITY_PROFILE.dprTargetMult, DPR_FLOOR), DPR_CEILING);
// 高 DPR + 高分辨率显示器(如 4K@2x)会让 render target 超过 WebGPU 的
// maxTextureDimension2D(典型 8192),导致全黑。按能力上限裁剪,保持 floor
// 不低于 devicePixelRatio 的点对点承诺。
const maxTexSize = renderer.capabilities?.maxTextureSize || 8192;
renderDpr = Math.min(renderDpr,
  maxTexSize / Math.max(1, window.innerWidth),
  maxTexSize / Math.max(1, window.innerHeight));
renderer.setPixelRatio(renderDpr);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);
console.info(`Renderer: ${renderer.constructor.name}/${actualRendererBackend}`, gpuName);

// WebGL context-loss safety net. The renderer auto-restores most GPU
// resources on the next render after restore, but without an explicit
// preventDefault the canvas stays black and silent. WebGPU loss reconstructs
// the deterministic scene after one guarded reload; WebGL 2 resumes in-place.
let contextLost = false;
installDeviceRecovery(renderer, (state, detail) => {
  contextLost = state === 'lost';
  const notice = document.getElementById('performance-notice');
  if (notice && state === 'lost') {
    notice.textContent = actualRendererBackend === 'webgpu'
      ? 'WebGPU 设备已重置，正在恢复图形资源…'
      : 'WebGL 2 图形上下文已丢失，等待恢复…';
    notice.classList.remove('hidden');
  }
  if (notice && state === 'restored') notice.classList.add('hidden');
  console.info(`graphics device ${state}`, detail || '');
});

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.0);
const BASE_FOV = 62;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.12, 1.2e11);
scene.add(camera);

const ambient = new THREE.AmbientLight(0x506080, 0.09);
const hemi = new THREE.HemisphereLight(0x88aaff, 0x223311, 0);
// Portal renders temporarily hide the live environment lights. This neutral
// space fill exactly matches ambience() outside an atmosphere, so the same
// destination mesh keeps the same light response on both sides of the seam.
const riftPortalAmbient = new THREE.AmbientLight(0x506080, 0.025);
riftPortalAmbient.visible = false;
scene.add(riftPortalAmbient);
const headlamp = new THREE.PointLight(0xffeed0, 0, 110, 1.4);
scene.add(ambient, hemi, headlamp);

// near a surface the (shadowless) point sun crossfades into this
// shadow-casting directional light that follows the camera
const sunShadow = new THREE.DirectionalLight(0xffffff, 0);
sunShadow.castShadow = true;
sunShadow.visible = false;
const SHADOW_MAP = QUALITY_PROFILE.shadowMap;
sunShadow.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sunShadow.shadow.camera.near = 100;
sunShadow.shadow.camera.far = 8500;
sunShadow.shadow.camera.left = sunShadow.shadow.camera.bottom = -QUALITY_PROFILE.shadowDistance;
sunShadow.shadow.camera.right = sunShadow.shadow.camera.top = QUALITY_PROFILE.shadowDistance;
sunShadow.shadow.bias = -0.0002;
sunShadow.shadow.normalBias = 2.0;
scene.add(sunShadow, sunShadow.target);
let shadowBlend = 0;
const sunDirCam = new THREE.Vector3(0, 1, 0);
let warmedSurfacePlanet = null;
let surfacePipelinesReady = true;
const surfaceBootstrapMeshes = [];
let surfaceBootstrapPending = false;
const surfaceBootstrapTarget = new THREE.RenderTarget(2, 2, { depthBuffer: true });
let shipPipelinesWarmed = false;
const warmedVolumePlanets = new Set();
let volumePrewarmInProgress = false;
const startupWarmStartedAt = performance.now();
const STARTUP_WARM_BUDGET_MS = QUALITY_LOW ? 1800 : 9000;
// Shader compilation may consume most of the general warm-up deadline on a
// cold browser profile.  Give the visible terrain/water LOD a separate,
// bounded settling window so control is not handed over during a morph.  The
// low tier remains tightly capped to avoid trapping integrated GPUs on the
// loading screen.
const STARTUP_TERRAIN_GRACE_MS = QUALITY_LOW ? 650 : 3500;
let startupPrewarmExpired = false;

function startupTerrainReady() {
  const planet = universe?.system?.planets?.[0];
  if (!planet || planet.isGasGiant) return true;
  const terrain = planet.lod?.debugStats?.();
  const water = planet.waterLod?.debugStats?.() || null;
  const settled = (stats, targetLevel) => !stats
    || (stats.visibleMaxLevel >= targetLevel
      && stats.activeMorphs === 0 && stats.pending === 0);
  return settled(terrain, planet.lod.planet.orbitLevelCap)
    && settled(water, planet.waterLod?.planet?.orbitLevelCap ?? 0);
}

function releaseStartupPrewarm(reason) {
  if (startupPrewarmExpired) return;
  startupPrewarmExpired = true;
  surfaceBootstrapPending = false;
  surfacePipelinesReady = true;
  for (const mesh of surfaceBootstrapMeshes) mesh.visible = false;
  renderer.debug.checkShaderErrors = qs.get('shaderchecks') === '1';
  console.warn(`startup shader prewarm released: ${reason}`);
}

function finishSurfaceBootstrap() {
  if (!surfaceBootstrapPending || contextLost) return;
  surfaceBootstrapPending = false;
  const savedTarget = renderer.getRenderTarget();
  const savedAutoClear = renderer.autoClear;
  const savedLight = {
    visible: sunShadow.visible,
    intensity: sunShadow.intensity,
    position: sunShadow.position.clone(),
    target: sunShadow.target.position.clone(),
  };
  try {
    // Seed the actual shadow-map programs in a private 2×2 target. The old
    // bootstrap temporarily replaced the live sun with a near-zero test light
    // and then presented that frame, which could expose a completely black
    // surface on the high-quality path.
    sunShadow.visible = true;
    sunShadow.intensity = 1;
    sunShadow.position.set(0, 4000, 0);
    sunShadow.target.position.set(0, 0, 0);
    sunShadow.updateMatrixWorld(true);
    sunShadow.target.updateMatrixWorld(true);
    for (const mesh of surfaceBootstrapMeshes) mesh.visible = true;
    renderer.autoClear = true;
    renderer.setRenderTarget(surfaceBootstrapTarget);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
  } catch (error) {
    console.warn('surface bootstrap render failed', error);
  } finally {
    for (const mesh of surfaceBootstrapMeshes) mesh.visible = false;
    sunShadow.visible = savedLight.visible;
    sunShadow.intensity = savedLight.intensity;
    sunShadow.position.copy(savedLight.position);
    sunShadow.target.position.copy(savedLight.target);
    sunShadow.updateMatrixWorld(true);
    sunShadow.target.updateMatrixWorld(true);
    renderer.setRenderTarget(savedTarget);
    renderer.autoClear = savedAutoClear;
  }
  if (shipPipelinesWarmed) {
    for (const mesh of surfaceBootstrapMeshes.splice(0)) {
      scene.remove(mesh);
      if (mesh.isInstancedMesh) mesh.dispose();
      else mesh.geometry.dispose();
    }
    surfaceBootstrapTarget.dispose();
  }
  // All startup shaders were checked while the loading mask was active.
  // Querying program logs for every later LOD/GLB variant forces ANGLE to
  // synchronously finish compilation on the flight frame.
  renderer.debug.checkShaderErrors = qs.get('shaderchecks') === '1';
  surfacePipelinesReady = true;
}

function prewarmPlanetVolumePipelines(planet) {
  // Avoid a 3000-4000 m hitch when the player descends through the atmosphere
  // of a planet other than the one that was warmed during startup.  The shared
  // topology is the same, but each planet owns its own atmosphere/cloud
  // material instance, so the first visible frame on a new body can still
  // trigger an on-demand compile.
  if (QUALITY_LOW || !planet || planet.isGasGiant || volumePrewarmInProgress
    || typeof renderer.compileAsync !== 'function') return;
  if (warmedVolumePlanets.has(planet)) return;
  const meshes = [planet.atmoMesh, planet.volCloudMesh].filter(Boolean);
  if (meshes.length === 0) {
    warmedVolumePlanets.add(planet);
    return;
  }
  const wereVisible = meshes.map((m) => m.visible);
  for (const mesh of meshes) mesh.visible = true;
  volumePrewarmInProgress = true;
  nodePipeline.compileAsync().then(() => {
    for (let i = 0; i < meshes.length; i++) meshes[i].visible = wereVisible[i];
    warmedVolumePlanets.add(planet);
    volumePrewarmInProgress = false;
  }).catch((error) => {
    for (let i = 0; i < meshes.length; i++) meshes[i].visible = wereVisible[i];
    volumePrewarmInProgress = false;
    console.warn('planet volume prewarm failed', error);
  });
}

function prewarmSurfacePipelines(planet) {
  // The low tier intentionally skips the expensive asynchronous surface
  // warm-up.  Mark the shared topology as accounted for so the regular frame
  // loop does not start that compile one frame later and recreate the same
  // renderer/program race on integrated GPUs.
  if (QUALITY_LOW) {
    if (planet && !warmedSurfacePlanet) warmedSurfacePlanet = planet;
    return;
  }
  // Terrain/water/prop shader topology is shared between terrestrial bodies;
  // uniforms and generated textures carry the per-planet variation.  One
  // representative warm-up is therefore enough.  Recompiling when a nearby
  // moon briefly becomes the closest body can overlap the live frame and
  // leave Three.js without a currentProgram while it polls isReady().
  if (!planet || warmedSurfacePlanet || typeof renderer.compileAsync !== 'function') return;
  // compileAsync is not re-entrant for a shared renderer/material registry.
  // A scripted teleport (or a very close moon) can change the nearest body
  // while the opening planet is still compiling; starting a second compile
  // then leaves one material without currentProgram and crashes isReady().
  if (!surfacePipelinesReady) return;
  // The private target is a startup-only cache warmer. Once the first playable
  // frame has been released (or its budget expired), later planets compile on
  // demand; re-entering this path would wait on an already-disposed target and
  // could hide surface props forever on a slow adapter.
  if (loadingCleared || startupPrewarmExpired) {
    warmedSurfacePlanet = planet;
    surfacePipelinesReady = true;
    return;
  }
  warmedSurfacePlanet = planet;
  surfacePipelinesReady = false;

  const terrainSource = planet.group.children.find((object) => object.isMesh
    && object.geometry?.getAttribute?.('aLocal'));
  if (terrainSource) {
    const geometry = terrainSource.geometry.clone();
    if (!geometry.morphAttributes.position?.length) {
      const count = geometry.getAttribute('position').count;
      geometry.morphAttributes.position = [new THREE.BufferAttribute(new Float32Array(count * 3), 3)];
      geometry.morphAttributes.normal = [new THREE.BufferAttribute(new Float32Array(count * 3), 3)];
      geometry.morphTargetsRelative = true;
    }
    const mesh = new THREE.Mesh(geometry, planet.terrainMaterial);
    mesh.position.set(0, 0, 0);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    surfaceBootstrapMeshes.push(mesh);
  }
  const instancedSources = [
    ...Object.values(scatter.meshes),
    ...(farFlora.meshes || []),
  ];
  for (const source of instancedSources) {
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, 1);
    mesh.setMatrixAt(0, new THREE.Matrix4());
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.position.set(0, 0, 0);
    mesh.frustumCulled = false;
    mesh.castShadow = source.castShadow;
    mesh.visible = false;
    scene.add(mesh);
    surfaceBootstrapMeshes.push(mesh);
  }

  // Prewarm the actual render pipeline (RenderPipeline on WebGPU, EffectComposer
  // on WebGL). renderer.compileAsync(scene, camera) only compiles materials for
  // the legacy path; it does not build the volume-pass node that first executes
  // when the cloud shell becomes visible, which caused a multi-second hitch at
  // 3000-3400 m. Briefly expose volume shells and the real shadow light so the
  // compiled variants match the live frame.
  const volumeMeshesToPrewarm = [];
  for (const mesh of [planet.atmoMesh, planet.volCloudMesh]) {
    if (mesh && !mesh.visible) {
      volumeMeshesToPrewarm.push(mesh);
      mesh.visible = true;
    }
  }

  const lightWasVisible = sunShadow.visible;
  const lightIntensity = sunShadow.intensity;
  sunShadow.visible = true;
  sunShadow.intensity = 1e-7;
  const tasks = [nodePipeline.compileAsync()];
  sunShadow.visible = lightWasVisible;
  sunShadow.intensity = lightIntensity;

  // WebGPURenderer derives backend-specific shadow materials from the node
  // surface graph. The private 2×2 bootstrap render below warms those real
  // variants without injecting an incompatible legacy MeshDepthMaterial.
  Promise.all(tasks).then(() => {
    for (const mesh of volumeMeshesToPrewarm) mesh.visible = false;
    if (planet) warmedVolumePlanets.add(planet);
    if (!startupPrewarmExpired) surfaceBootstrapPending = true;
  }).catch((error) => {
    for (const mesh of volumeMeshesToPrewarm) mesh.visible = false;
    surfacePipelinesReady = true;
    console.warn('surface pipeline prewarm failed', error);
  });
}

function prewarmLoadedShipPipelines() {
  if (startupPrewarmExpired) {
    shipPipelinesWarmed = true;
    return;
  }
  if (QUALITY_LOW) {
    shipPipelinesWarmed = true;
    return;
  }
  if (!ship.heroLoaded || shipPipelinesWarmed || !surfacePipelinesReady
    || typeof renderer.compileAsync !== 'function') return;
  shipPipelinesWarmed = true;
  surfacePipelinesReady = false;
  const lightWasVisible = sunShadow.visible;
  const lightIntensity = sunShadow.intensity;
  sunShadow.visible = true;
  sunShadow.intensity = 1e-7;
  renderer.compileAsync(scene, camera).then(() => {
    if (!startupPrewarmExpired) surfaceBootstrapPending = true;
  }).catch((error) => {
    surfacePipelinesReady = true;
    console.warn('ship pipeline prewarm failed', error);
  });
  sunShadow.visible = lightWasVisible;
  sunShadow.intensity = lightIntensity;
}

// ---- renderer-specific post chain -------------------------------------------
const VOLUME_ENABLED = qs.get('vclouds') !== '0';
const VOLUME_SCALE = QUALITY_PROFILE.volumeScale;
setVolumetricCloudsEnabled(VOLUME_ENABLED, QUALITY_LOW ? 'low' : 'high');
const nodeVolumePass = BOOT_USE_NODE && VOLUME_ENABLED
  ? new VolumetricPass()
  : null;
const Pipeline = BOOT_USE_NODE ? GameNodePipelineV2 : GameLegacyPipeline;
const _executedComputeNodes = new WeakSet();
const nodePipeline = new Pipeline(renderer, scene, camera, {
  volume: VOLUME_ENABLED,
  volumeScale: VOLUME_SCALE,
  bloomEnabled: qs.get('post') !== '0' && !QUALITY_LOW,
  bloomStrength: IS_TOUCH ? 0.35 : 0.5,
  bloomRadius: 0.4,
  bloomThreshold: 1.05,
  foregroundLayer: SHIP_FOREGROUND_LAYER,
  createWarpDriveNode,
  createRiftDistortionNode,
});
const volumePass = BOOT_USE_NODE
  ? nodeVolumePass
  : nodePipeline.volumePass;
const warpDrivePass = nodePipeline.warp;
const foregroundPass = nodePipeline.foregroundPass;
const riftDistortionPass = nodePipeline.rift;
const bloomPass = nodePipeline.bloom;
let usePost = !QUALITY_LOW && (bloomPass.enabled || VOLUME_ENABLED);
let spatialRift = null;
function sizePost() {
  nodePipeline.setSize(window.innerWidth, window.innerHeight, renderDpr);
}
sizePost();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizePost();
  spatialRift?.resize(window.innerWidth, window.innerHeight, renderDpr);
  updateStarProj();
});

function setRenderDpr(next) {
  // 自适应 DPR 在档位 [floor, ceiling] 区间内微调;性能档 floor=ceiling=点对点,
  // 实际不波动,保证低画质也不糊。同时不能超过 GPU 最大纹理尺寸,否则黑屏。
  const maxTexSize = renderer.capabilities?.maxTextureSize || 8192;
  const dpr = Math.min(clamp(next, DPR_FLOOR, DPR_CEILING),
    maxTexSize / Math.max(1, window.innerWidth),
    maxTexSize / Math.max(1, window.innerHeight));
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
let loadingCleared = false;
// Displayed loading bar progress (0..1). Only moves forward — driven by
// discrete startup milestones in tickLoading so the bar reflects real
// pipeline readiness instead of an infinite CSS sweep.
let loadingProgress = 0;
let paused = false;
let blackHoleObservatoryOpen = false;
let pointerLockRequest = null;
let timeWarp = null;
let photoMode = false;
let boostVisual = 0;
let pulseVisual = 0;
const PULSE_FUEL_MAX = 140;
const PULSE_FUEL_COST = 18;
const PULSE_DURATION = 0.56;
let pulseFuel = PULSE_FUEL_MAX;
let pulseActive = false;
let pulseBurst = null;
let pulseRechargeDelay = 0;
let weaponCooldown = 0;
let flightPower = {
  weapon: 1, navigation: 1, thermal: 1, gravity: 1, shield: 1, warp: 0,
};
let weaponVisual = 0;
let activeBolts = 0;
let starMap = null;
let pendingRoute = null;
let riftRoute = null;
let riftPreviewSystem = null;
let riftForcedPost = false;
let riftBloomState = null;
const RIFT_SPAWN_DISTANCE = 780;
const RIFT_CAPTURE_DISTANCE = 1900;
const PLANET_ARRIVAL_FACTOR = 1.68;
const INITIAL_ORBIT_FACTOR = 1.72;
// Full-page hero: the camera opens on the home planet's limb so its arc
// and terminator fill the right half of the screen, then pulls back to the
// standard orbit when the player commits. Tuned alongside setHeroCamera().
const HERO_CLOSE_FACTOR = 1.3;
const HERO_PULLBACK_SECONDS = 2.8;
// Start-page framing: yaw the camera right until the planet's arc owns the
// right third of the screen (0.95 pushed it too far; ~0.72 keeps the limb and
// terminator clearly visible without leaving the frame).
const HERO_YAW = 0.72;
const riftEntranceUniv = new THREE.Vector3();
const riftTargetUniv = new THREE.Vector3();
const riftPreviewOriginUniv = new THREE.Vector3();
const riftOrientation = new THREE.Quaternion();
const riftLocalPos = new THREE.Vector3();
const riftLocalVel = new THREE.Vector3();
const riftInverse = new THREE.Quaternion();
const riftAssistQuat = new THREE.Quaternion();
const riftPortalClearColor = new THREE.Color();
const riftPortalVisibility = [];
const riftPortalDepthState = [];
let riftPortalClearAlpha = 1;
let riftPortalFog = null;
let riftPortalToneMapping = THREE.ACESFilmicToneMapping;
let dialAcc = 0;
// Snow coverage at the player's current foot position, refreshed by the walk
// dial pass (~7 Hz). Consumed by the music director to switch to the alpine
// theme on habitable snowfields.
let currentWalkSnowWeight = 0;
function walkWeatherFor(planet, localUp, sunLocal) {
  if (!planet) return 'clear';
  const terrainHeight = planet.height(localUp, 64);
  if (planet.type === 'ice' || planet.snowWeightAt?.(localUp, terrainHeight) > 0.32) return 'snow';
  const coverage = Number(planet.cloudCoverage) || 0;
  if (coverage < 0.48) return 'clear';
  if (planet.type === 'toxic' || planet.type === 'lava') return 'storm';
  // A cloud deck is only precipitation locally when the surface is beneath
  // the lit, moisture-bearing side; clear skies remain the default elsewhere.
  const sunAltitude = localUp.dot(sunLocal);
  return sunAltitude > -0.35 && coverage > 0.62 ? 'rain' : 'clear';
}

// ---- world ------------------------------------------------------------------
const fixedTime = qs.has('time') ? Number(qs.get('time')) : null;
let celestialClock = new CelestialClock(SEED, {
  initialHours: Number.isFinite(fixedTime) ? fixedTime : null,
  persist: !Number.isFinite(fixedTime),
  frozen: FREEZE,
});
let universe = createUniverse(SEED);
universe.timeHours = celestialClock.hours;
universe.system.updateCelestial(celestialClock.hours);
const scatter = new Scatter();
// far tier: proxy trees to the horizon (?farflora=0 spares SwiftShader tests)
const FARFLORA = qs.get('farflora') !== '0';
const farFlora = new FarFlora();
const skyDome = new SkyDome(scene);
const ship = new Ship(scene, {
  anisotropy: Math.min(16, renderer.getMaxAnisotropy?.()
    ?? renderer.capabilities?.getMaxAnisotropy?.()
    ?? 1),
});
spatialRift = new SpatialRift({
  scene,
  renderer,
  mainCamera: camera,
  profile: {
    width: 1025,
    height: 720,
    depth: 108,
    edgeThickness: 1.08,
    renderScale: 1,
  },
});
spatialRift.resize(window.innerWidth, window.innerHeight, renderDpr);
const weapons = new ShipWeapons(scene);
const audio = new FlightAudio();
const music = new BackgroundMusic();
// Unlock the shared AudioContext on first user gesture, then bind the music
// bus to the same context (avoids opening a second AudioContext per tab).
function unlockAudio() {
  audio.unlock();
  if (audio.ctx && !music.ready) music.attach(audio.ctx);
}
const surfaceWeaponHud = document.getElementById('surface-weapon');
const surfaceWeapons = new SurfaceWeapons(scene, camera, renderer.domElement, {
  canUse: () => state === 'walk' && (document.pointerLockElement === renderer.domElement || window.NMS_NOLOCK),
  onChange: ({ index, weapon, ammo, reloading }) => {
    if (!surfaceWeaponHud) return;
    surfaceWeaponHud.querySelector('[data-weapon-name]').textContent = weapon.name;
    const ammoReadout = surfaceWeaponHud.querySelector('[data-weapon-ammo]');
    ammoReadout.textContent = weapon.kind === 'laser' ? '∞' : `${ammo} / ${weapon.magSize}`;
    ammoReadout.dataset.state = reloading ? 'RELOADING' : weapon.kind === 'laser' ? 'MINING BEAM' : 'READY';
    surfaceWeaponHud.dataset.activeSlot = String(index + 1).padStart(2, '0');
    surfaceWeaponHud.classList.toggle('reloading', reloading);
    surfaceWeaponHud.classList.toggle('mining-laser', weapon.kind === 'laser');
    for (const item of surfaceWeaponHud.querySelectorAll('[data-weapon-slot]')) item.classList.toggle('active', Number(item.dataset.weaponSlot) === index);
  },
  onShot: () => audio.cue('fire'),
});
let warpIntensity = 0;
let warpArrival = 0;
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
const flightStepStart = new THREE.Vector3();
const flightProbeWorld = new THREE.Vector3();
const flightProbeLocal = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const shipCollisionCurrent = new THREE.Vector3();
const shipCollisionPrevious = new THREE.Vector3();
const shipCollisionInverse = new THREE.Quaternion();
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
  const d = window.__diag ||= {};
  d.tweenCalls = (d.tweenCalls || 0) + 1;
  d.tweenCount = tweens.length;
  d.lastDt = dt;
  if (d.tweenCalls % 30 === 0) console.log('[diag] stepTweens', { dt, count: tweens.length, calls: d.tweenCalls });
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
const walkCtl = new WalkControls(renderer.domElement, {
  lookScale: () => surfaceWeapons.lookScale,
  onLook: (movementX, movementY) => surfaceWeapons.onLookDelta(movementX, movementY),
  resolveCollision: resolveParkedShipCollision,
});

function cancelPulseBurst() {
  pulseBurst = null;
  pulseActive = false;
}

function triggerPulse() {
  if (state !== 'space' || paused || riftRoute || pulseBurst) return false;
  if (pulseFuel + 1e-6 < PULSE_FUEL_COST) {
    ui.setHint(`脉冲燃料不足 · 需要 ${PULSE_FUEL_COST}`, false);
    return false;
  }
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quat).normalize();
  const distance = pulseBurstDistance(spaceCtl.speedScale, nearestAlt, !!nearest);
  pulseFuel = Math.max(0, pulseFuel - PULSE_FUEL_COST);
  pulseRechargeDelay = 1.4 / Math.max(.1, flightPower.thermal);
  pulseBurst = { elapsed: 0, progress: 0, direction, distance };
  pulseActive = true;
  return true;
}

renderer.domElement.addEventListener('pointerdown', () => {
  unlockAudio();
  if (state === 'walk' && !document.pointerLockElement && !window.NMS_NOLOCK && pointerLockInput) {
    renderer.domElement.requestPointerLock();
  }
});

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (blackHoleObservatoryOpen) {
    if (e.code === 'Escape' || e.code === 'KeyO') closeBlackHoleObservatory();
    e.preventDefault();
    return;
  }
  if (e.code === 'KeyM' || e.code === 'Tab') {
    e.preventDefault();
    if (starMap?.isOpen) closeStarMap();
    else if (!paused && !['warp', 'landing', 'takeoff', 'flyto'].includes(state)) openStarMap();
    return;
  }
  if (starMap?.isOpen) {
    starMap.handleKey(e);
    e.preventDefault();
    return;
  }
  if (pendingRoute && state === 'space' && (e.code === 'Digit1' || e.code === 'Numpad1')) {
    e.preventDefault();
    beginSelectedWarp();
    return;
  }
  if (pendingRoute && state === 'space' && (e.code === 'Digit2' || e.code === 'Numpad2')) {
    e.preventDefault();
    beginSelectedRift();
    return;
  }
  if (e.code === 'KeyL') tryLand();
  if (!e.repeat && e.code === 'KeyO') {
    const blackHole = nearbyBlackHole();
    if (blackHole) openBlackHoleObservatory(blackHole);
  }
  if (!e.repeat && e.code === 'Space' && state === 'space') {
    e.preventDefault();
    triggerPulse();
  }
  if (!e.repeat && e.code === 'KeyE' && state === 'walk') boardShip();
  if (!e.repeat && e.code === 'KeyT' && state === 'walk') recallShip();
  if (e.code === 'KeyH') {
    photoMode = !photoMode;
    document.body.classList.toggle('hide-hud', photoMode);
  }
  if (e.code === 'KeyB') usePost = !usePost;                           // bloom toggle
  if (e.code === 'Escape') {
    if (pendingRoute && state === 'space') {
      clearPendingRoute();
    } else if (state === 'flyto') {
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
  worldLab: WORLD_LAB,
  galaxyName: GALAXY.name,
  onEnterHero: () => {
    // The splash "点击进入" click is the first user gesture — unlock audio
    // here so the hero start page already has sound, and the later "开始游戏"
    // click only needs to handle pointer lock + the pull-back cinematic.
    unlockAudio();
    audio.setPaused(false);
    music.setPaused(false);
  },
  onStart: async () => {
    // Pointer Lock must be requested in the original click gesture. Audio
    // was already unlocked when the player entered the hero start page.
    console.log('[diag] onStart entered');
    try {
      const lockAttempt = requestGameplayPointerLock();
      console.log('[diag] requestGameplayPointerLock returned, calling startHeroPullBack');
      // One-shot cinematic: pull the camera back from the home planet's limb to
      // the full-orbit spawn frame while the ship slides into formation.
      startHeroPullBack(() => {
        // A denied initial request falls back to the next canvas click; controls
        // must be enabled so that click can actually reach SpaceControls.
        spaceCtl.enabled = state === 'space';
        // The ship has slid into formation — fade cockpit chrome in now instead
        // of snapping it on at the start of the pull-back.
        ui.revealChrome();
      });
      console.log('[diag] startHeroPullBack returned, tweenCount=', window.__diag?.tweenCount, 'heroStarted=', window.__diag?.heroStarted);
      await lockAttempt;
    } catch (e) {
      console.error('[diag] onStart THREW:', e);
    }
  },
  onLand: tryLand,
  onStarMap: () => starMap?.isOpen ? closeStarMap() : openStarMap(),
  onRouteWarp: () => beginSelectedWarp(),
  onRouteRift: () => beginSelectedRift(),
  onRouteCancel: () => clearPendingRoute(),
  onJoystick: (x, y) => { walkCtl.touchMove.x = x; walkCtl.touchMove.y = y; },
  onApplyGraphics: (settings) => {
    writeGraphicsSettings(settings);
    setTimeout(() => location.reload(), 180);
  },
});
// Surface a clickable low-power GPU hint on the hero start page before the
// first frame, so the player can switch the browser to its discrete GPU.
ui.setHeroPerfHint(graphicsSettings.quality === 'auto' && isLowPowerGpu(gpuName), gpuName);
ui.setGraphicsSettings(graphicsSettings, QUALITY_PROFILE, {
  gpu: gpuName, actualBackend: actualRendererBackend, reason: rendererRuntime.reason,
});
starMap = new StarMap({
  getUniverse: () => universe,
  getNav: () => nav,
  getSeed: () => SEED,
  getState: () => state,
  getTime: () => celestialClock.hours,
  onRequestClose: () => closeStarMap(),
  onWarpTarget: (star, bodyId = null) => {
    closeStarMap(false);
    if (star.id === universe.system.star.id) {
      const target = universe.system.bodyById.get(bodyId);
      if (target) {
        if (target.isBlackHole) {
          approachBlackHole(target);
          return;
        }
        focusPlanet = target;
        spaceCtl.focus = target;
        flyToPlanet(target);
        ui.setHint(`自动导航 · ${target.name}`, true);
      }
      return;
    }
    setPendingRoute(star, bodyId);
  },
});
const walkDial = document.getElementById('walk-dial');
const pauseOverlay = document.getElementById('pause-overlay');
const pausePanel = pauseOverlay.querySelector('.pause-panel');
const pauseStatus = document.getElementById('pause-status');
const resumeButton = document.getElementById('resume-btn');
const blackHoleObservatory = document.getElementById('black-hole-observatory');
const blackHoleFrame = document.getElementById('black-hole-frame');
const blackHoleClose = document.getElementById('black-hole-close');
const blackHoleSlingshot = document.getElementById('black-hole-slingshot');
const blackHoleTitle = document.getElementById('black-hole-title');
const blackHoleRadius = document.getElementById('black-hole-radius');
const blackHoleDistance = document.getElementById('black-hole-distance');
const blackHoleSpeed = document.getElementById('black-hole-speed');
const blackHoleTime = document.getElementById('black-hole-time');
let blackHoleStatsTimer = null;
let observedBlackHole = null;

function nearbyBlackHole() {
  let closest = null;
  let distance = Infinity;
  for (const object of universe.system?.compactObjects || []) {
    const d = nav.pos.distanceTo(object.posUniv);
    if (d < distance) { closest = object; distance = d; }
  }
  return closest && distance < closest.spec.accretionRadius * 7 ? closest : null;
}

function updateBlackHoleReadouts() {
  const stats = blackHoleFrame.contentWindow?.BlackHoleSlingshotObservatory?.getStats?.();
  if (!stats) return;
  blackHoleRadius.textContent = `${stats.radiusKm.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} km`;
  blackHoleDistance.textContent = `${stats.distanceKm.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} km`;
  blackHoleSpeed.textContent = `${stats.speedC.toFixed(3)} c`;
  blackHoleTime.textContent = `${stats.timeDilation.toFixed(3)}×`;
}

function applyBlackHoleScene(index = 0, play = true) {
  const bridge = blackHoleFrame.contentWindow?.BlackHoleSlingshotObservatory;
  if (!bridge) return false;
  bridge.applyScene(index, observedBlackHole?.spec?.blackHole?.massSolar);
  if (play) bridge.play();
  else bridge.pause();
  updateBlackHoleReadouts();
  return true;
}

function openBlackHoleObservatory(blackHole = nearbyBlackHole()) {
  if (!blackHole || blackHoleObservatoryOpen) return false;
  blackHoleObservatoryOpen = true;
  observedBlackHole = blackHole;
  clearFlightInput();
  spaceCtl.enabled = false;
  if (document.pointerLockElement) document.exitPointerLock();
  blackHoleTitle.textContent = `${blackHole.name} · 引力弹弓观测`;
  blackHoleObservatory.classList.remove('hidden');
  document.body.classList.add('black-hole-mode');
  if (!blackHoleFrame.getAttribute('src')) blackHoleFrame.src = '/assets/vendor/black-hole/demo.html';
  clearInterval(blackHoleStatsTimer);
  blackHoleStatsTimer = setInterval(updateBlackHoleReadouts, 350);
  if (!applyBlackHoleScene(0, true)) {
    const retry = setInterval(() => {
      if (applyBlackHoleScene(0, true) || !blackHoleObservatoryOpen) clearInterval(retry);
    }, 250);
  }
  return true;
}

function closeBlackHoleObservatory() {
  if (!blackHoleObservatoryOpen) return false;
  blackHoleObservatoryOpen = false;
  observedBlackHole = null;
  clearInterval(blackHoleStatsTimer);
  blackHoleStatsTimer = null;
  blackHoleFrame.contentWindow?.BlackHoleSlingshotObservatory?.pause?.();
  blackHoleObservatory.classList.add('hidden');
  document.body.classList.remove('black-hole-mode');
  spaceCtl.enabled = state === 'space';
  ui.setHint('已返回驾驶舱 · 点击画面重新接管视角 · O 再次观测', true);
  return true;
}

blackHoleClose.addEventListener('click', closeBlackHoleObservatory);
blackHoleSlingshot.addEventListener('click', () => applyBlackHoleScene(6, true));
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== blackHoleFrame.contentWindow) return;
  if (event.data?.type === 'black-hole-observatory:bridge-ready'
      || event.data?.type === 'black-hole-observatory:ready') applyBlackHoleScene(0, true);
});
resumeButton.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !paused) return;
  // Pointer Lock can cancel the click that follows pointerdown. Complete the
  // whole resume transaction from the trusted pointer gesture so the cursor
  // can never be captured while the pause surface remains open.
  resumeGame();
});

// Camera-relative mining ray against the deterministic procedural surface.
// It intentionally reports only the contact distance for now; a future mining
// system can use the same value to select deposits and apply extraction work.
function surfaceBeamDistance(maxDistance = 72) {
  const planet = walkCtl.planet;
  if (state !== 'walk' || !planet) return maxDistance;
  _v.set(0, 0, -1).applyQuaternion(nav.quat);
  planet.worldOffsetToLocal(_v, _v2).normalize();
  for (let distance = 1.5; distance <= maxDistance; distance += 1.5) {
    _v3.copy(walkCtl.posLocal).addScaledVector(_v2, distance);
    const radius = _v3.length();
    _up.copy(_v3).multiplyScalar(1 / Math.max(radius, 1));
    if (radius <= planet.surfaceRadius(_up)) return distance;
  }
  return maxDistance;
}
resumeButton.addEventListener('click', (event) => {
  // Keyboard activation has no pointerdown and reports detail === 0.
  if (event.detail === 0) resumeGame();
});
document.getElementById('pause-map-btn').addEventListener('click', async () => {
  if (paused) {
    paused = false;
    pauseOverlay.classList.add('hidden');
    audio.setPaused(true);
    // Opening the star map from the pause menu should restore BGM (which was
    // paused by pauseGame) and let the director switch to the starmap theme.
    music.setPaused(false);
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
  beginTimeWarp(kind, body, () => findNextSolarEvent(body, kind));
}

function waitForEclipse() {
  const body = walkCtl.planet || nearest || focusPlanet;
  beginTimeWarp('eclipse', body, () => findNextEclipse(body));
}

document.getElementById('wait-sunrise-btn').addEventListener('click', () => waitForSolarEvent('sunrise'));
document.getElementById('wait-sunset-btn').addEventListener('click', () => waitForSolarEvent('sunset'));
document.getElementById('wait-eclipse-btn').addEventListener('click', waitForEclipse);

function clearFlightInput() {
  for (const code in keys) keys[code] = false;
  spaceCtl.boosting = false;
  spaceCtl.firing = false;
  spaceCtl.firePressed = false;
  spaceCtl.clearTransientInput();
  cancelPulseBurst();
  spaceCtl.wheelImpulse = 0;
  nav.vel.set(0, 0, 0);
  walkCtl.hSpeed.set(0, 0, 0);
}

function openStarMap() {
  if (!starMap || starMap.isOpen || paused || riftRoute || ['warp', 'landing', 'takeoff', 'flyto'].includes(state)) return;
  cancelTimeWarp();
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
  if (restoreInput && !window.NMS_NOLOCK && pointerLockInput && (state === 'space' || state === 'walk')) {
    try { await renderer.domElement.requestPointerLock(); } catch { /* next click can reacquire */ }
  }
}

function pauseGame() {
  if (paused) return;
  // The start page owns the screen; opening the pause surface while it is
  // fading out (or still up) creates the two overlays stacked on top of each
  // other.  Wait until the hand-off to flight is complete.
  if (document.body.classList.contains('hero-active')) return;
  cancelTimeWarp();
  paused = true;
  spaceCtl.enabled = false;
  pauseOverlay.classList.remove('hidden');
  pausePanel.classList.remove('is-acquiring');
  pauseStatus.textContent = '指针已释放 · 点击继续以重新接管视角';
  audio.setPaused(true);
  music.setPaused(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

function requestGameplayPointerLock() {
  if (window.NMS_NOLOCK || !pointerLockInput || !['space', 'walk'].includes(state)) return Promise.resolve(true);
  if (document.pointerLockElement === renderer.domElement) return Promise.resolve(true);
  if (pointerLockRequest) return pointerLockRequest;
  pausePanel.classList.add('is-acquiring');
  pauseStatus.textContent = '正在接管视角控制…';
  pointerLockRequest = new Promise((resolve) => {
    let settled = false;
    const finish = (locked) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      document.removeEventListener('pointerlockchange', onChange);
      document.removeEventListener('pointerlockerror', onError);
      pointerLockRequest = null;
      resolve(locked);
    };
    const onChange = () => {
      if (document.pointerLockElement === renderer.domElement) finish(true);
    };
    const onError = () => finish(false);
    const timeout = setTimeout(() => finish(document.pointerLockElement === renderer.domElement), 1800);
    document.addEventListener('pointerlockchange', onChange);
    document.addEventListener('pointerlockerror', onError, { once: true });
    try {
      const request = renderer.domElement.requestPointerLock();
      request?.catch(onError);
    } catch { onError(); }
  });
  return pointerLockRequest;
}

async function resumeGame() {
  if (!paused) return true;
  let locked = await requestGameplayPointerLock();
  if (locked && !window.NMS_NOLOCK && pointerLockInput && ['space', 'walk'].includes(state)) {
    // Some Chromium builds briefly report a successful lock and release it in
    // the following rendering task. Keep the game paused until ownership is
    // stable, so cursor-hidden/controller-disabled can never leak to play.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    locked = document.pointerLockElement === renderer.domElement;
  }
  pausePanel.classList.remove('is-acquiring');
  if (!locked) {
    pauseStatus.textContent = '未能取得视角控制 · 请再次点击继续';
    return false;
  }
  paused = false;
  spaceCtl.enabled = state === 'space';
  pauseOverlay.classList.add('hidden');
  audio.setPaused(false);
  music.setPaused(false);
  unlockAudio();
  return true;
}

const TIME_WARP_LABELS = {
  sunrise: '下一次日出',
  sunset: '下一次日落',
  eclipse: '下一次食象',
};

async function beginTimeWarp(kind, body, findTarget) {
  if (!body) {
    pauseStatus.textContent = '当前没有可用于星历计算的目标天体';
    return;
  }
  pauseStatus.textContent = '正在解算星历窗口…';
  const target = findTarget();
  if (target == null) {
    pauseStatus.textContent = kind === 'eclipse'
      ? '近期轨道窗口内没有可见食象'
      : '当前目标没有可计算的地平日照事件';
    return;
  }
  const resumed = await resumeGame();
  if (!resumed) return;
  const start = celestialClock.hours;
  const delta = Math.max(0.001, target - start);
  const duration = clamp(delta * 0.4, 1.8, 7);
  const scale = Math.max(600, delta * 3600 / duration);
  celestialClock.scale = scale;
  timeWarp = { kind, start, target, scale, label: TIME_WARP_LABELS[kind] };
  ui.setTimeWarp(true, { label: timeWarp.label, progress: 0, scale });
  ui.setHint(`星历快进 · ${timeWarp.label}`, true);
}

function cancelTimeWarp(message = '') {
  if (!timeWarp) return;
  timeWarp = null;
  celestialClock.scale = TIME_SCALE;
  ui.setTimeWarp(false);
  if (message) ui.setHint(message, true);
}

function updateTimeWarp() {
  if (!timeWarp) return;
  const span = Math.max(1e-6, timeWarp.target - timeWarp.start);
  const progress = clamp((celestialClock.hours - timeWarp.start) / span, 0, 1);
  if (celestialClock.hours >= timeWarp.target) {
    const completed = timeWarp;
    celestialClock.set(completed.target);
    timeWarp = null;
    celestialClock.scale = TIME_SCALE;
    ui.setTimeWarp(false);
    ui.setHint(`已抵达${completed.label.replace('下一次', '')} · 星历倍率恢复`, true);
    return;
  }
  ui.setTimeWarp(true, { label: timeWarp.label, progress, scale: timeWarp.scale });
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === renderer.domElement && !paused && !starMap?.isOpen) {
    spaceCtl.enabled = state === 'space';
    return;
  }
  if (!window.NMS_NOLOCK && pointerLockInput && !document.pointerLockElement
      && !paused && !blackHoleObservatoryOpen && !starMap?.isOpen && !pendingRoute && !riftRoute
      && (state === 'space' || state === 'walk')) {
    pauseGame();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Minimizing or resizing a browser window can transiently mark the page
    // hidden.  The star map is already an input-gated, audio-paused mode, so
    // closing it and opening the flight pause screen destroys the player's
    // navigation context for no safety benefit.
    if (starMap?.isOpen) {
      clearFlightInput();
      return;
    }
    if (!paused && !['warp', 'landing', 'takeoff'].includes(state)) pauseGame();
    return;
  }
  if (starMap?.isOpen) requestAnimationFrame(() => starMap.resize());
});

// universe → app notifications (system handoffs during warp / manual flight)
function wireUniverse(u) {
  u.onSystemChange = (sys) => ui.setSystem(sys.name, sys._specs.length, SEED, sys.catalogId, WORLD_LAB);
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
    cancelPulseBurst();
    spaceCtl.firing = false;
    spaceCtl.firePressed = false;
    spaceCtl.clearTransientInput();
  }
  spaceCtl.enabled = s === 'space' && !starMap?.isOpen;
  ui.setCrosshair(s === 'walk' || s === 'space');
  ui.showTouchUI(IS_TOUCH && s === 'walk');
  walkDial?.setActive(s === 'walk');
  if (s === 'walk') dialAcc = 1;
  const hints = IS_TOUCH ? {
    space: '<b>单指</b> 转向 · <b>双指缩放</b> 推进 · <b>M</b> 星图',
    flyto: '自动接近中…',
    landing: '正在执行降落程序…',
    walk: '<b>摇杆</b> 移动 · <b>拖动</b> 观察 · <b>空格</b> 跳跃 · 靠近飞船按 <b>E</b>',
    boarding: '正在登船…',
    takeoff: '垂直起飞中…',
    warp: '空间折叠中…',
  } : {
    space: '<b>鼠标</b> 船头 · <b>W/S</b> 推进/制动 · <b>A/D</b> 侧推 · <b>LMB</b> 射击 · <b>RMB/SHIFT</b> 加力 · <b>SPACE</b> 脉冲冲刺 · <b>M/TAB</b> 星图',
    flyto: '自动接近中… <b>Esc</b> 中止',
    landing: '正在执行降落程序…',
    walk: '<b>WASD</b> 移动 · <b>R</b> 换弹 · <b>RMB</b> 瞄准 · <b>T</b> 召回飞船 · 靠近飞船按 <b>E</b>',
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

function shipFootprintRange(planet, centerDir, localQuat) {
  const center = centerDir.clone().multiplyScalar(planet.R);
  const offset = new THREE.Vector3();
  const sampleDir = new THREE.Vector3();
  let min = Infinity;
  let max = -Infinity;
  for (const [x, z] of SHIP_LANDING_PROFILE.footprint) {
    offset.set(x, 0, z).applyQuaternion(localQuat);
    sampleDir.copy(center).add(offset).normalize();
    const height = planet.height(sampleDir, planet.fullMaxFreq);
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return { min, max };
}

function resolveParkedShipCollision(controller, previousPosition) {
  if (controller.planet !== ship.parkedPlanet || !ship.parkedLocal
      || !ship.parkedLocalQuat || ship.parkAmt < 0.98) return;

  shipCollisionInverse.copy(ship.parkedLocalQuat).invert();
  shipCollisionCurrent.copy(controller.posLocal).sub(ship.parkedLocal)
    .applyQuaternion(shipCollisionInverse);
  shipCollisionPrevious.copy(previousPosition).sub(ship.parkedLocal)
    .applyQuaternion(shipCollisionInverse);

  const radius = 0.44;
  const eyeHeight = controller.eyeHeight;
  let resolved = false;
  for (const collider of SHIP_LANDING_PROFILE.colliders) {
    const [cx, cy, cz] = collider.center;
    const [hx, hy, hz] = collider.half;
    const minX = cx - hx - radius;
    const maxX = cx + hx + radius;
    const minZ = cz - hz - radius;
    const maxZ = cz + hz + radius;
    const bottom = cy - hy;
    const top = cy + hy;
    const inside = shipCollisionCurrent.x >= minX && shipCollisionCurrent.x <= maxX
      && shipCollisionCurrent.z >= minZ && shipCollisionCurrent.z <= maxZ;
    if (!inside) continue;

    const feet = shipCollisionCurrent.y - eyeHeight;
    const previousFeet = shipCollisionPrevious.y - eyeHeight;
    const mantleReach = top - feet;
    // A normal jump can mantle the lower wing deck. Without this small ledge
    // assist the collider would be physically correct but the parked ship's
    // ~2.5 m deck would be unreachable from the deliberately short jump arc.
    if (controller.vR > 0 && mantleReach >= 0 && mantleReach <= 1.12) {
      shipCollisionCurrent.y = top + eyeHeight;
      controller.vR = 0;
      controller.grounded = true;
      resolved = true;
      break;
    }
    // Crossing a top face while falling creates a stable walkable deck. A
    // small tolerance avoids losing contact as the curved planet frame moves.
    if (controller.vR <= 0 && previousFeet >= top - 0.18 && feet <= top + 0.28) {
      shipCollisionCurrent.y = top + eyeHeight;
      controller.vR = 0;
      controller.grounded = true;
      resolved = true;
      break;
    }

    const bodyOverlaps = shipCollisionCurrent.y > bottom
      && feet < top - 0.03;
    if (!bodyOverlaps) continue;

    // Capsule-vs-OBB side response. Preserve the axis that remains tangent to
    // the hull so the player slides along a wing instead of stopping dead.
    const previousInsideX = shipCollisionPrevious.x >= minX && shipCollisionPrevious.x <= maxX;
    const previousInsideZ = shipCollisionPrevious.z >= minZ && shipCollisionPrevious.z <= maxZ;
    if (!previousInsideX) shipCollisionCurrent.x = shipCollisionPrevious.x;
    if (!previousInsideZ) shipCollisionCurrent.z = shipCollisionPrevious.z;
    if (previousInsideX && previousInsideZ) {
      const distances = [
        [Math.abs(shipCollisionCurrent.x - minX), minX, 'x'],
        [Math.abs(maxX - shipCollisionCurrent.x), maxX, 'x'],
        [Math.abs(shipCollisionCurrent.z - minZ), minZ, 'z'],
        [Math.abs(maxZ - shipCollisionCurrent.z), maxZ, 'z'],
      ].sort((a, b) => a[0] - b[0]);
      shipCollisionCurrent[distances[0][2]] = distances[0][1];
    }
    resolved = true;
  }

  if (!resolved) return;
  controller.posLocal.copy(shipCollisionCurrent.applyQuaternion(ship.parkedLocalQuat))
    .add(ship.parkedLocal);
}

// Set the ship down on flat, dry ground ~22 m from where the player lands.
// The complete rendered footprint is sampled, so a ridge beneath the far wing
// raises the landing origin instead of cutting through the hull.
function parkShipNear(planet, landDir) {
  const up = _v.copy(landDir);
  const e1 = new THREE.Vector3();
  if (Math.abs(up.y) < 0.93) e1.set(up.z, 0, -up.x).normalize();
  else e1.set(0, -up.z, up.y).normalize();
  const e2 = new THREE.Vector3().crossVectors(up, e1);
  const cand = new THREE.Vector3();
  // scenic landings favour cliff perches — hunt outward until the ground is
  // genuinely FLAT, or the ship sits level on a slope with its nose in the air
  const landH = planet.height(up, planet.fullMaxFreq);
  let best = null, bestH = 0, bestQuat = null, bestScore = Infinity;
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
      const candidateForward = landDir.clone().sub(cand).normalize();
      const candidateQuat = horizonQuat(cand, candidateForward, new THREE.Quaternion());
      const footprint = shipFootprintRange(planet, cand, candidateQuat);
      const slope = (footprint.max - footprint.min)
        / (SHIP_LANDING_PROFILE.bounds.halfZ * 2);
      const clearH = footprint.max;
      const playerDistance = Math.hypot(rad, clearH - landH);
      if (playerDistance > BOARD_DISTANCE - 3) continue;
      const score = slope * 24 + rad * 0.03 + Math.abs(clearH - landH) * 0.08;
      if (score < bestScore) {
        bestScore = score; best = cand.clone();
        bestH = clearH - SHIP_LANDING_PROFILE.bounds.minY
          + SHIP_LANDING_PROFILE.groundClearance;
        bestQuat = candidateQuat;
      }
    }
    if (best && bestScore < 1.4) break;            // flat enough, stop early
  }
  if (!best) {   // everything around is wet/steep — keep the ship reachable
    cand.copy(up).addScaledVector(e1, 22 / planet.R).normalize();
    best = cand.clone();
    const candidateForward = landDir.clone().sub(cand).normalize();
    bestQuat = horizonQuat(cand, candidateForward, new THREE.Quaternion());
    const footprint = shipFootprintRange(planet, cand, bestQuat);
    bestH = clamp(footprint.max, landH - 28, landH + 28)
      - SHIP_LANDING_PROFILE.bounds.minY + SHIP_LANDING_PROFILE.groundClearance;
  }
  const padLocal = best.clone().multiplyScalar(planet.R + bestH);
  const padUniv = planet.localPositionToWorld(padLocal, new THREE.Vector3());
  const parkedLocalQuat = bestQuat;
  const parkedWorldQuat = planet.frameOrientation.clone().multiply(parkedLocalQuat);
  ship.parkedPlanet = planet; ship.parkedLocal = padLocal; ship.parkedLocalQuat = parkedLocalQuat;
  ship.setParked(padUniv, parkedWorldQuat);
  return { padLocal, padUniv, parkedLocalQuat, parkedWorldQuat };
}

function tryLand() {
  if (state !== 'space' || !nearest || nearest.isGasGiant || nearest.landable === false || nearestAlt > 420) return;
  const planet = nearest;
  const startLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const dirLocal = startLocal.clone().normalize();
  const ground = planet.surfaceRadius(dirLocal);
  const endLocal = dirLocal.clone().multiplyScalar(ground + 1.7);
  if (!window.NMS_NOLOCK && pointerLockInput) renderer.domElement.requestPointerLock();
  const landing = parkShipNear(planet, dirLocal);
  const upLocal = landing.padLocal.clone().normalize();
  const forwardLocal = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(landing.parkedLocalQuat).normalize();
  const rightLocal = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(landing.parkedLocalQuat).normalize();
  const approachLocal = landing.padLocal.clone()
    .addScaledVector(upLocal, 54)
    .addScaledVector(forwardLocal, -14);
  const cameraStartLocal = landing.padLocal.clone()
    .addScaledVector(rightLocal, 27)
    .addScaledVector(forwardLocal, 23)
    .addScaledVector(upLocal, 17);
  const cameraEndLocal = landing.padLocal.clone()
    .addScaledVector(rightLocal, 21)
    .addScaledVector(forwardLocal, 16)
    .addScaledVector(upLocal, 9);
  const approachQuat = landing.parkedLocalQuat.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.09));
  const shipLocal = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();
  const shipLocalQuat = new THREE.Quaternion();
  const shipWorldQuat = new THREE.Quaternion();
  const cameraLocal = new THREE.Vector3();
  const focusWorld = new THREE.Vector3();
  const worldUp = new THREE.Vector3();
  planet.localPositionToWorld(approachLocal, shipWorld);
  ship.setLandingPose(shipWorld,
    shipWorldQuat.copy(planet.frameOrientation).multiply(approachQuat), 0);
  setState('landing');
  ui.showLand(false);
  nav.vel.set(0, 0, 0);
  addTween(3.6, (k) => {
    const descent = landingDescentProgress(k);
    shipLocal.lerpVectors(approachLocal, landing.padLocal, descent);
    shipLocalQuat.copy(approachQuat).slerp(landing.parkedLocalQuat, descent);
    planet.localPositionToWorld(shipLocal, shipWorld);
    shipWorldQuat.copy(planet.frameOrientation).multiply(shipLocalQuat);
    ship.setLandingPose(shipWorld, shipWorldQuat, descent);

    cameraLocal.lerpVectors(cameraStartLocal, cameraEndLocal, easeInOut(k));
    planet.localPositionToWorld(cameraLocal, nav.pos);
    planet.localPositionToWorld(
      focusWorld.copy(shipLocal).addScaledVector(upLocal, 0.8), focusWorld);
    planet.localOffsetToWorld(upLocal, worldUp).normalize();
    lookQuatAt(nav.pos, focusWorld, nav.quat, worldUp);
  }, () => {
    ship.finishLanding();
    const exitView = landing.padLocal.clone().sub(endLocal).projectOnPlane(dirLocal).normalize();
    walkCtl.enter(planet, endLocal, exitView);
    planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);
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

function selectRouteBody(systemSpec, bodyId = null) {
  const systemBodies = [...systemSpec.bodies, ...(systemSpec.compactObjects || [])];
  const bodies = new Map(systemBodies.map((body) => [body.bodyId, body]));
  let body = bodyId ? bodies.get(bodyId) : null;
  if (body?.isMoon) body = bodies.get(body.parentId) || body;
  if (body) return body;

  const typePriority = { lush: 7, ocean: 6, desert: 4, ice: 3, barren: 2, exotic: 2, toxic: 1, lava: 0 };
  const primaries = systemBodies.filter((candidate) => !candidate.isMoon);
  const landable = primaries.filter((candidate) => candidate.landable !== false);
  const candidates = landable.length ? landable : primaries;
  return candidates.reduce((best, candidate) => {
    if (!best) return candidate;
    const candidateScore = (typePriority[candidate.type] ?? 1) * 1e7 + candidate.radius;
    const bestScore = (typePriority[best.type] ?? 1) * 1e7 + best.radius;
    return candidateScore > bestScore ? candidate : best;
  }, null);
}

function blackHoleArrivalDistance(body) {
  return body.type === 'blackHole'
    ? body.accretionRadius * 2.75
    : body.radius * PLANET_ARRIVAL_FACTOR;
}

function approachBlackHole(blackHole) {
  const direction = nav.pos.clone().sub(blackHole.posUniv);
  if (direction.lengthSq() < 1) direction.set(0.28, 0.12, 1);
  direction.normalize();
  nav.pos.copy(blackHole.posUniv).addScaledVector(direction, blackHole.spec.accretionRadius * 2.75);
  nav.vel.set(0, 0, 0);
  lookQuatAt(nav.pos, blackHole.posUniv, nav.quat);
  focusPlanet = null;
  spaceCtl.focus = null;
  ui.setHint(`已抵达 ${blackHole.name} 安全观测距离 · O 进入相对论弹弓实验`, true);
  return true;
}

function routeArrival(star, bodyId = null, forwardHint = null) {
  const systemSpec = generateSystemSpec(SEED, star);
  const systemBodies = [...systemSpec.bodies, ...(systemSpec.compactObjects || [])];
  const bodies = new Map(systemBodies.map((body) => [body.bodyId, body]));
  const body = selectRouteBody(systemSpec, bodyId);
  const center = star.pos.clone();
  if (body) {
    const resolvePosition = (spec, out = new THREE.Vector3()) => {
      orbitalPosition(spec.orbit, celestialClock.hours, out);
      if (spec.parentId) out.add(resolvePosition(bodies.get(spec.parentId)));
      else out.add(star.pos);
      return out;
    };
    resolvePosition(body, center);
  }
  let approach;
  if (body) {
    // Enter from the star-facing hemisphere. A technically correct nightside
    // insertion turned the destination into a planet-sized black silhouette,
    // which read as a failed traversal. A small polar bias keeps a readable
    // horizon without sacrificing the physically lit approach.
    approach = star.pos.clone().sub(center);
    if (approach.lengthSq() < 1) {
      approach = forwardHint
        ? forwardHint.clone().normalize().negate()
        : nav.pos.clone().sub(center).normalize();
    }
    approach.normalize();
    const polarBias = new THREE.Vector3(0, 1, 0).projectOnPlane(approach);
    if (polarBias.lengthSq() < 0.01) polarBias.set(1, 0, 0).projectOnPlane(approach);
    approach.addScaledVector(polarBias.normalize(), 0.16).normalize();
  } else {
    approach = forwardHint
      ? forwardHint.clone().normalize().negate()
      : nav.pos.clone().sub(center).normalize();
  }
  if (approach.lengthSq() < 0.5) approach.set(0, 0, 1);
  const clearance = body ? blackHoleArrivalDistance(body) : Math.max(star.radius * 72, 1.4e9);
  return {
    center,
    entry: center.clone().addScaledVector(approach, clearance),
    bodyId: body?.bodyId || null,
    bodyName: body?.name || null,
    bodyRadius: body?.type === 'blackHole' ? body.accretionRadius : body?.radius || null,
  };
}

function formatRouteDistance(distance) {
  if (distance >= 1e9) return `${(distance / 1e9).toFixed(2)} Gm`;
  if (distance >= 1e6) return `${(distance / 1e6).toFixed(1)} Mm`;
  if (distance >= 1e3) return `${(distance / 1e3).toFixed(1)} km`;
  return `${Math.round(distance)} m`;
}

function setPendingRoute(star, bodyId = null) {
  clearPendingRoute(false);
  const target = routeArrival(star, bodyId);
  pendingRoute = { star, bodyId: target.bodyId };
  pendingRoute.target = target;
  const label = target.bodyName ? `${target.bodyName} · ${generateSystemSpec(SEED, star).name}`
    : generateSystemSpec(SEED, star).name;
  pendingRoute.label = label;
  spaceCtl.enabled = false;
  ui.setCrosshair(false);
  ui.showRouteChoice(true, label);
  ui.setHint('航线已锁定 · 选择恒星跃迁或弦界航道', true);
}

function disposeRiftPreview() {
  if (!riftPreviewSystem) return;
  riftPreviewSystem.dispose();
  riftPreviewSystem = null;
}

function setRiftPreviewVisible(visible) {
  if (!riftPreviewSystem) return;
  for (const view of riftPreviewSystem.starViews) {
    view.group.visible = visible;
    view.light.visible = visible;
  }
  for (const body of [...riftPreviewSystem.planets, ...riftPreviewSystem.compactObjects]) body.group.visible = visible;
}

function addRiftPortalHidden(object) {
  if (!object || riftPortalVisibility.includes(object)) return;
  riftPortalVisibility.push(object, object.visible);
  object.visible = false;
}

function hideSystemForRiftPortal(system) {
  if (!system || system === riftPreviewSystem) return;
  for (const view of system.starViews) {
    addRiftPortalHidden(view.group);
    addRiftPortalHidden(view.light);
  }
  for (const body of [...system.planets, ...system.compactObjects]) addRiftPortalHidden(body.group);
}

function beginRiftPortalScene() {
  riftPortalVisibility.length = 0;
  riftPortalDepthState.length = 0;
  hideSystemForRiftPortal(universe.system);
  hideSystemForRiftPortal(universe.fadingSystem);
  for (const object of [
    skyDome.mesh,
    ship.group,
    weapons.glowMesh,
    weapons.coreMesh,
    sunShadow,
    hemi,
    ambient,
    headlamp,
  ]) addRiftPortalHidden(object);
  riftPortalFog = scene.fog;
  scene.fog = null;
  renderer.getClearColor(riftPortalClearColor);
  riftPortalClearAlpha = renderer.getClearAlpha();
  riftPortalToneMapping = renderer.toneMapping;
  // Keep the offscreen destination in linear HDR. The visible portal then
  // flows through the same node output transform exactly once, just like
  // the adopted destination on the next frame.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000006, 1);
  riftPortalAmbient.visible = true;
  setRiftPreviewVisible(true);
  // The production volume graph renders participating media into a separate
  // target without the opaque scene depth buffer, then composites it over the
  // planet. The portal draws both layers directly into one target; leaving
  // depth testing enabled makes each BackSide volume shell sit behind the
  // terrain and disappear. Preserve the materials and mirror the graph's
  // compositing rule only for this offscreen render.
  for (const planet of riftPreviewSystem?.planets || []) {
    for (const material of [planet.atmoMesh?.material, planet.volCloudMat]) {
      if (!material) continue;
      riftPortalDepthState.push(material, material.depthTest);
      material.depthTest = false;
    }
  }
}

function endRiftPortalScene() {
  setRiftPreviewVisible(false);
  riftPortalAmbient.visible = false;
  for (let i = 0; i < riftPortalDepthState.length; i += 2) {
    riftPortalDepthState[i].depthTest = riftPortalDepthState[i + 1];
  }
  riftPortalDepthState.length = 0;
  for (let i = 0; i < riftPortalVisibility.length; i += 2) {
    riftPortalVisibility[i].visible = riftPortalVisibility[i + 1];
  }
  riftPortalVisibility.length = 0;
  scene.fog = riftPortalFog;
  renderer.toneMapping = riftPortalToneMapping;
  renderer.setClearColor(riftPortalClearColor, riftPortalClearAlpha);
}

function clearPendingRoute(restoreInput = true) {
  const hadRoute = !!pendingRoute;
  pendingRoute = null;
  ui.showRouteChoice(false);
  ui.setDestinationMarker({ show: false });
  if (hadRoute && restoreInput && state === 'space') {
    spaceCtl.enabled = true;
    ui.setCrosshair(true);
    requestGameplayPointerLock();
  }
}

function beginSelectedWarp() {
  if (!pendingRoute || state !== 'space') return;
  const route = pendingRoute;
  requestGameplayPointerLock();
  ui.beginTravel();
  clearPendingRoute(false);
  warpTo(route.star, route.bodyId);
}

function enableRiftEffects() {
  if (!riftBloomState) {
    riftBloomState = {
      enabled: bloomPass.enabled,
      strength: bloomPass.strength,
      radius: bloomPass.radius,
      threshold: bloomPass.threshold,
    };
  }
  bloomPass.enabled = true;
  // Keep the energy concentrated on the rim. A broad low-threshold bloom
  // spread white light across the portal texture and made the destination
  // planet appear washed out until the instant the rim moved behind us.
  bloomPass.strength = 0.92;
  bloomPass.radius = 0.24;
  bloomPass.threshold = 0.88;
  riftDistortionPass.enabled = true;
  riftForcedPost = !usePost;
  usePost = true;
}

function restoreRiftEffects() {
  if (riftBloomState) {
    bloomPass.enabled = riftBloomState.enabled;
    bloomPass.strength = riftBloomState.strength;
    bloomPass.radius = riftBloomState.radius;
    bloomPass.threshold = riftBloomState.threshold;
    riftBloomState = null;
  }
  if (riftForcedPost) usePost = false;
  riftForcedPost = false;
  riftDistortionPass.enabled = false;
}

function beginSelectedRift() {
  if (!pendingRoute || state !== 'space' || riftRoute) return;
  // The route can be chosen entirely through DOM buttons, without ever
  // touching the flight canvas or keyboard. Unlock inside this trusted click
  // path so both the opening tear and post-crossing seal are always audible.
  unlockAudio();
  const route = pendingRoute;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quat).normalize();
  const arrival = routeArrival(route.star, route.bodyId, forward);
  arrival.offset = arrival.entry.clone().sub(arrival.center);
  arrival.quat = lookQuatAt(arrival.entry, arrival.center, new THREE.Quaternion());
  requestGameplayPointerLock();
  ui.beginTravel();
  clearPendingRoute(false);
  spaceCtl.enabled = true;
  ui.setCrosshair(true);
  riftRoute = { ...route, arrival, arrived: false, anchorLocked: false, lastHintBand: -1 };
  riftEntranceUniv.copy(nav.pos).addScaledVector(forward, RIFT_SPAWN_DISTANCE);
  riftTargetUniv.copy(arrival.entry);
  riftPreviewOriginUniv.copy(arrival.entry);
  riftOrientation.copy(nav.quat);
  cancelPulseBurst();
  spaceCtl.boosting = false;
  if (nav.vel.length() > 18) nav.vel.setLength(18);
  riftPreviewSystem = new StarSystem(universe, route.star, {
    deferred: true,
    fadeInPlanets: false,
    timeHours: celestialClock.hours,
  });
  // Build only far enough to include the selected body. Rift previews are
  // immediately opaque: unlike a live system handoff, this isolated system is
  // not part of the normal per-frame planet fade update.
  if (route.bodyId) {
    while (!riftPreviewSystem.bodyById.has(route.bodyId) && riftPreviewSystem.buildNext());
  }
  setRiftPreviewVisible(false);
  spatialRift.setTransform(
    riftEntranceUniv.clone().sub(nav.pos),
    riftOrientation,
    _v3.set(0, 0, 0),
    arrival.quat,
  );
  spatialRift.openPassage();
  enableRiftEffects();
  audio.cue('rift-open');
  ui.setHint('弦界坐标钉定 · 航道正在船头展开', true);
}

function syncRiftDestination() {
  if (!riftRoute || !riftPreviewSystem || !riftRoute.arrival.bodyId) return;
  riftPreviewSystem.updateCelestial(celestialClock.hours);
  const body = riftPreviewSystem.bodyById.get(riftRoute.arrival.bodyId);
  if (!body) return;
  riftRoute.arrival.center.copy(body.posUniv);
  riftRoute.arrival.entry.copy(body.posUniv).add(riftRoute.arrival.offset);
  riftTargetUniv.copy(riftRoute.arrival.entry);
  riftPreviewOriginUniv.copy(riftRoute.arrival.entry);
}

function updateDestinationMarker() {
  if (!pendingRoute || state !== 'space') {
    ui.setDestinationMarker({ show: false });
    return;
  }
  const direction = pendingRoute.target.center.clone().sub(nav.pos);
  const distance = direction.length();
  if (distance < 1) {
    ui.setDestinationMarker({ show: false });
    return;
  }
  direction.normalize().multiplyScalar(1000).applyQuaternion(nav.quat.clone().invert());
  const behind = direction.z > -0.01;
  const z = behind ? Math.max(0.01, direction.z) : -direction.z;
  let nx = direction.x / (z * Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
  let ny = direction.y / (z * Math.tan(camera.fov * Math.PI / 360));
  if (behind) { nx = -nx; ny = -ny; }
  nx = clamp(nx, -0.82, 0.82);
  ny = clamp(ny, -0.72, 0.72);
  ui.setDestinationMarker({
    show: true,
    name: pendingRoute.label,
    distance: formatRouteDistance(distance),
    x: (nx * 0.5 + 0.5) * window.innerWidth,
    y: (-ny * 0.5 + 0.5) * window.innerHeight,
    behind,
  });
}

function updateRiftRoute(dt) {
  if (!riftRoute) return;
  if (!riftRoute.arrived) syncRiftDestination();
  spatialRift.update(dt, clock.elapsedTime);
  if (!riftRoute.arrived) {
    if (!riftRoute.anchorLocked) {
      cancelPulseBurst();
      spaceCtl.boosting = false;
      nav.vel.multiplyScalar(Math.exp(-dt * 6.5));
      if (nav.vel.length() > 24) nav.vel.setLength(24);
      riftOrientation.copy(nav.quat);
      _v2.set(0, 0, -1).applyQuaternion(riftOrientation).normalize();
      riftEntranceUniv.copy(nav.pos).addScaledVector(_v2, RIFT_SPAWN_DISTANCE);
      if (spatialRift.open >= 0.995 && !spatialRift.animating) {
        riftRoute.anchorLocked = true;
        riftRoute.lastHintBand = -1;
      } else {
        const band = Math.min(9, Math.floor(spatialRift.open * 10));
        if (band !== riftRoute.lastHintBand) {
          riftRoute.lastHintBand = band;
          ui.setHint(`弦界张力 ${Math.round(spatialRift.open * 100)}% · 航道坐标锁定中`, true);
        }
      }
    } else {
      riftInverse.copy(riftOrientation).invert();
      riftLocalPos.copy(nav.pos).sub(riftEntranceUniv).applyQuaternion(riftInverse);
      const normalizedRadial = Math.hypot(
        riftLocalPos.x / (spatialRift.width * 0.56),
        riftLocalPos.y / (spatialRift.height * 0.56),
      );
      const inCapture = riftLocalPos.z < RIFT_CAPTURE_DISTANCE
        && riftLocalPos.z > -spatialRift.depth - 260
        && normalizedRadial < 1;
      const speedCap = inCapture
        ? riftLocalPos.z > 560 ? 145 : riftLocalPos.z > 110 ? 105 : 76
        : 145;
      if (nav.vel.length() > speedCap) nav.vel.setLength(speedCap);
      if (inCapture) {
        cancelPulseBurst();
        spaceCtl.boosting = false;
        riftLocalVel.copy(nav.vel).applyQuaternion(riftInverse);
        if (riftLocalVel.length() > speedCap) riftLocalVel.setLength(speedCap);
        const centerStrength = 1 - Math.exp(-dt * (riftLocalPos.z > 110 ? 1.35 : 2.6));
        riftLocalVel.x = lerp(riftLocalVel.x, clamp(-riftLocalPos.x * 0.24, -42, 42), centerStrength);
        riftLocalVel.y = lerp(riftLocalVel.y, clamp(-riftLocalPos.y * 0.24, -42, 42), centerStrength);
        nav.vel.copy(riftLocalVel.applyQuaternion(riftOrientation));
        if (nav.quat.angleTo(riftOrientation) < 1.05) {
          riftAssistQuat.copy(riftOrientation);
          nav.quat.slerp(riftAssistQuat, 1 - Math.exp(-dt * 1.15));
        }
        const band = riftLocalPos.z > 560 ? 10 : riftLocalPos.z > 110 ? 11 : 12;
        if (band !== riftRoute.lastHintBand) {
          riftRoute.lastHintBand = band;
          ui.setHint(`航道已稳定 · ${riftRoute.label} · 限速 ${speedCap} m/s · W 推进 / S 制动`, true);
        }
      } else if (riftRoute.lastHintBand !== 13) {
        riftRoute.lastHintBand = 13;
        ui.setHint(`${riftRoute.label} · 航速锁定 145 m/s · 将船头对准发光入口`, true);
      }
    }
  }
  const entranceRender = riftEntranceUniv.clone().sub(nav.pos);
  // The portal render owns a destination-local coordinate system whose entry
  // point is the origin. The actual universe position remains in
  // riftTargetUniv and is applied only when the ship crosses the threshold.
  // Before crossing this is the source aperture; afterwards the remaining
  // collapse belongs wholly to the destination frame. Reapplying the old
  // source quaternion on the next frame could rotate a wide rim through the
  // camera and flash a folded fragment in front of the arrived planet.
  const passageOrientation = riftRoute.arrived ? riftRoute.arrival.quat : riftOrientation;
  spatialRift.setTransform(entranceRender, passageOrientation, _v3.set(0, 0, 0), riftRoute.arrival.quat);
  if (!riftRoute.arrived) {
    const previousRender = prevNavPos.clone().sub(nav.pos);
    if (spatialRift.crossed(previousRender, _v3.set(0, 0, 0))) {
      nav.pos.copy(riftRoute.arrival.entry);
      riftAssistQuat.copy(riftRoute.arrival.quat).multiply(riftOrientation.clone().invert());
      nav.quat.premultiply(riftAssistQuat);
      nav.vel.applyQuaternion(riftAssistQuat);
      const destination = universe.adoptSystem(riftPreviewSystem);
      riftPreviewSystem = null;
      destination.updateCelestial(celestialClock.hours);
      for (const view of destination.starViews) {
        view.group.visible = true;
        view.light.visible = true;
      }
      for (const body of [...destination.planets, ...destination.compactObjects]) body.group.visible = true;
      universe.relativizeSystem(destination, nav.pos);
      const arrivalBody = destination.bodyById.get(riftRoute.arrival.bodyId) || null;
      if (arrivalBody) {
        focusPlanet = arrivalBody;
        spaceCtl.focus = arrivalBody;
      }
      _v2.set(0, 0, -1).applyQuaternion(riftRoute.arrival.quat).normalize();
      riftEntranceUniv.copy(nav.pos).addScaledVector(_v2, -(spatialRift.depth + 90));
      spatialRift.setTransform(
        riftEntranceUniv.clone().sub(nav.pos),
        riftRoute.arrival.quat,
        _v3.set(0, 0, 0),
        riftRoute.arrival.quat,
      );
      spatialRift.markTraversed();
      audio.cue('rift-close');
      riftRoute.arrived = true;
      setState('space');
      ui.showArrival(arrivalBody?.name || destination.name, destination.name, '弦界抵达');
    }
  } else if (!spatialRift.group.visible) {
    restoreRiftEffects();
    riftRoute = null;
  }
}

function renderRiftPortal() {
  if (!riftRoute || riftRoute.arrived || !riftPreviewSystem) return;
  syncRiftDestination();
  // The preview system is deliberately excluded from the live universe update.
  // Prime its planet LODs from the virtual destination camera so their root
  // chunks are visible inside the portal instead of leaving only a starfield.
  for (const planet of riftPreviewSystem.planets) {
    _v.copy(riftPreviewOriginUniv).sub(planet.posUniv);
    planet.update(_v, 1 / 60, planet.bodyId === riftRoute.arrival.bodyId, 0);
  }
  for (const object of riftPreviewSystem.compactObjects) object.updateVisual?.(performance.now() * 0.001);
  // Use the exact camera-relative placement, stellar attenuation and sun glow
  // that the adopted destination will use on the first post-crossing frame.
  universe.relativizeSystem(riftPreviewSystem, riftPreviewOriginUniv);
  spatialRift.renderPortal({
    beforeRender: beginRiftPortalScene,
    afterRender: endRiftPortalScene,
  });
}

// A warp is a flight, not a teleport: align with the target, spool up, then
// cross real space at ferocious speed — every star in the sky parallaxes past,
// the destination sun grows from a dot — and decelerate into the new system.
function warpTo(star, preferBodyId = null) {
  if (state !== 'space') return;
  ui.beginWarpPower();
  setState('warp');
  warpArrival = 0;
  focusPlanet = null;
  spaceCtl.focus = null;
  const startPos = nav.pos.clone();
  const startQuat = nav.quat.clone();
  // Begin with a safe stellar-system arrival point. Once the destination
  // system exists, the trajectory is redirected toward its hero planet.
  const arriveDir = startPos.clone().sub(star.pos).normalize();
  let endPos = star.pos.clone().addScaledVector(arriveDir, Math.max(star.radius * 72, 1.4e9));
  const dist = startPos.distanceTo(endPos);
  const dur = clamp(8.5 + dist / 8e8, 10, 18);
  let targetQuat = lookQuatAt(startPos, star.pos, new THREE.Quaternion());
  const SPOOL = 0.12;
  let swapped = false;
  let arrivalPlanetName = null;
  let arrivalSystem = null, arrivalSpec = null, revealDirection = null;
  nav.vel.set(0, 0, 0);

  addTween(dur, (k) => {
    if (k < SPOOL) {
      // turn toward the target and charge the jump
      nav.quat.copy(startQuat).slerp(targetQuat, smoothstep(0, 1, k / SPOOL));
      camera.fov = BASE_FOV - 4 * (k / SPOOL);
    } else {
      const kf = (k - SPOOL) / (1 - SPOOL);
      const s = warpTravelProgress(kf);
      if (arrivalSpec) {
        const heroPos = arrivalSystem.frames.get(arrivalSpec.bodyId).position;
        endPos.copy(heroPos).addScaledVector(revealDirection, blackHoleArrivalDistance(arrivalSpec));
        targetQuat = lookQuatAt(nav.pos, heroPos, targetQuat);
      }
      nav.pos.lerpVectors(startPos, endPos, s);
      nav.quat.copy(targetQuat);
      // Keep the tunnel at full authority until the destination is close,
      // then make the braking phase legible: streaks collapse, FOV compresses
      // briefly below neutral, and rebounds as the real system is revealed.
      const ramp = smoothstep(0, 0.075, kf) * (1 - smoothstep(0.86, 0.95, kf));
      const brakeIn = smoothstep(0.78, 0.9, kf);
      const brakeOut = 1 - smoothstep(0.9, 1, kf);
      warpArrival = brakeIn * brakeOut;
      camera.fov = BASE_FOV - 4 + 34 * ramp - 7.5 * warpArrival;
      warpIntensity = ramp;
      if (kf >= 0.04 && !swapped) {
        // Swap early enough that the real destination can materialise during
        // the tunnel, then converge on a large planet for the exit reveal.
        swapped = true;
        const destination = universe.setSystem(star, true);
        if (preferBodyId) {
          while (!destination.bodyById.has(preferBodyId) && destination.buildNext());
        }
        // a planet chosen in the system preview becomes the arrival reveal
        let hero = null;
        if (preferBodyId) {
          let picked = destination._specs.find((spec) => spec.bodyId === preferBodyId);
          if (picked?.isMoon) picked = destination._specs.find((spec) => spec.bodyId === picked.parentId);
          if (picked && !picked.isMoon) hero = picked;
        }
        if (hero) {
          const heroPos = destination.frames.get(hero.bodyId).position;
          revealDirection = startPos.clone().sub(heroPos).normalize();
          arrivalSystem = destination; arrivalSpec = hero;
          endPos = heroPos.clone().addScaledVector(revealDirection, blackHoleArrivalDistance(hero));
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
    warpArrival = 0;
    let arrivalDisplayName = universe.system.name;
    if (arrivalSpec?.type === 'blackHole') {
      const blackHole = universe.system.bodyById.get(arrivalSpec.bodyId);
      if (blackHole) {
        approachBlackHole(blackHole);
        arrivalDisplayName = blackHole.name;
      }
    } else if (arrivalPlanetName) {
      const arrivalPlanet = universe.system.planets.find((planet) => planet.name === arrivalPlanetName);
      if (arrivalPlanet) {
        focusPlanet = arrivalPlanet;
        spaceCtl.focus = arrivalPlanet;
        lookQuatAt(nav.pos, arrivalPlanet.posUniv, nav.quat);
        arrivalDisplayName = arrivalPlanet.name;
      }
    } else {
      ui.setHint(`已抵达 ${universe.system.name} · 星系安全入口`, true);
    }
    setState('space');
    ui.endWarpPower();
    ui.showArrival(arrivalDisplayName, universe.system.name, '跃迁抵达');
  });
}

function newUniverse(seed) {
  if (!WORLD_LAB) return false;
  const requestedSeed = String(seed || '').trim();
  SEED = requestedSeed || (makeWord(Math.random, 2, 3).toUpperCase() + '-' + ((Math.random() * 999) | 0));
  const url = new URL(location.href);
  url.searchParams.set('seed', SEED);
  history.replaceState(null, '', url);
  if (walkCtl.active) walkCtl.exit();
  if (document.pointerLockElement) document.exitPointerLock();
  tweens.length = 0;
  clearPendingRoute(false);
  ui.endTravel();
  ui.endWarpPower(true);
  riftPortalAmbient.visible = false;
  disposeRiftPreview();
  riftRoute = null;
  spatialRift.group.visible = false;
  spatialRift.open = 0;
  spatialRift.targetOpen = 0;
  restoreRiftEffects();
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
  universe = createUniverse(SEED);
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
  return SEED;
}

// ---- spawn --------------------------------------------------------------------
// hero=true parks the camera tight on the home planet's limb: the planet fills
// the right half of the frame behind the start page, its arc and terminator
// visible. startHeroPullBack() then eases the camera out to the standard orbit.
function spawn(hero = false) {
  const sys = universe.system;
  const planet = sys.planets[0];
  const sunDir = sys.sunDirFrom(planet.posUniv, _v).clone();
  const side = _v2.crossVectors(sunDir, _v3.set(0, 1, 0)).normalize();
  const dir = sunDir.clone().addScaledVector(side, 0.85).normalize();
  const factor = hero ? HERO_CLOSE_FACTOR : INITIAL_ORBIT_FACTOR;
  nav.pos.copy(planet.posUniv).addScaledVector(dir, planet.R * factor);
  lookQuatAt(nav.pos, planet.posUniv, nav.quat);
  // Hero framing: yaw right so the planet's arc owns the right half of the
  // screen and the menu owns the left. Too small a yaw parks the planet dead
  // centre behind the buttons; too large pushes it out of frame.
  nav.quat.multiply(_q.setFromAxisAngle(_v3.set(0, 1, 0), hero ? HERO_YAW : 0.18));
  nav.vel.set(0, 0, 0);
  focusPlanet = planet;
  spaceCtl.focus = planet;
  // The ship waits off-screen during the start page; startHeroPullBack slides
  // it into formation as the camera pulls back.
  if (hero) ship.introOffset?.set(160, -110, 60);
  ui.setSystem(sys.name, sys.planets.length, SEED, sys.catalogId, WORLD_LAB);
  setState('space');
}

// Seamless one-shot: from the limb close-up back out to the full planet while
// the ship slides into formation. Runs inside the click gesture's call chain
// so pointer lock requested in onDone still counts as user-activated.
function startHeroPullBack(onDone) {
  (window.__diag ||= {}).heroStarted = true;
  console.log('[diag] startHeroPullBack called');
  const planet = universe.system.planets[0];
  const startPos = nav.pos.clone();
  const startQuat = nav.quat.clone();
  const dir = _v.copy(startPos).sub(planet.posUniv).normalize().clone();
  const endPos = planet.posUniv.clone().addScaledVector(dir, planet.R * INITIAL_ORBIT_FACTOR);
  const endQuat = lookQuatAt(endPos, planet.posUniv, new THREE.Quaternion())
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.18));
  const lastCenter = planet.posUniv.clone();
  // The ship was parked off-screen by spawn(hero); the pull-back slides it in.
  addTween(HERO_PULLBACK_SECONDS, (k) => {
    // Keep the shot anchored on the live planet (it drifts on its ephemeris).
    const shift = planet.posUniv.clone().sub(lastCenter);
    startPos.add(shift); endPos.add(shift); lastCenter.copy(planet.posUniv);
    const e = easeInOut(k);
    nav.pos.lerpVectors(startPos, endPos, e);
    nav.quat.copy(startQuat).slerp(endQuat, e);
    if (Math.floor(k * 20) !== Math.floor((k - 0.001) * 20)) console.log(`[diag] heroTween k=${k.toFixed(2)} navPos=${nav.pos.toArray().map(v=>v.toFixed(1)).join(',')}`);
    // Ship enters frame during the second half of the pull-back.
    const sk = smoothstep(0.4, 1, k);
    ship.introOffset.set(160 * (1 - sk), -110 * (1 - sk), 60 * (1 - sk));
  }, () => {
    console.log('[diag] heroTween DONE onDone fired');
    ship.introOffset.set(0, 0, 0);
    onDone?.();
  });
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
  renderer.setClearAlpha(0);
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
let perfEmaMs = 16.7;
let dprAcc = 0;

function frame() {
  requestAnimationFrame(frame);
  const d0 = window.__diag ||= {};
  d0.frameNo = (d0.frameNo || 0) + 1;
  d0.state = state;
  d0.paused = paused;
  d0.nearestName = nearest?.bodyId || nearest?.name || null;
  d0.navPos = [nav.pos.x, nav.pos.y, nav.pos.z];
  if (d0.frameNo % 60 === 0) console.log('[diag] frame', d0.frameNo, { paused, state, navPos: nav.pos.toArray().map(v=>v.toFixed(1)) });
  const realDt = clock.getDelta();
  // Paused: the full-page pause surface floats over a LIVE world. Simulation
  // time freezes (dt=0) but the render pipeline runs exactly as in play, so
  // clouds/bloom/engine glow stay alive behind the blur and nothing diverges
  // (the hand-rolled paused branch drifted lighting state = the black flicker).
  const rawDt = paused ? 0 : realDt;
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
  if (starMap?.isOpen) {
    // Even though the 3D universe is skipped while the star map covers the
    // screen, the BGM director must still run so it can switch to the starmap
    // theme (and back when the map closes).
    music.update({
      state,
      planetType: null,
      snowWeight: 0,
      nearBlackHole: false,
      starmapOpen: true,
    });
    return;
  }

  // Advance the persistent universe clock only during active play. The world
  // is updated before controls so a walker remains attached to the moving body.
  celestialClock.update(rawDt, !photoMode);
  updateTimeWarp();
  const followFrame = state === 'space' && referenceBody
    && nav.pos.distanceTo(referenceBodyPos) < Math.max(referenceBody.R * 10, referenceBody.atmoHeight * 5);
  universe.update(nav.pos, state === 'space' || state === 'flyto', celestialClock.hours);
  if (followFrame && universe.planets().includes(referenceBody)) {
    _v.copy(referenceBody.posUniv).sub(referenceBodyPos);
    nav.pos.add(_v);
    if (riftRoute && !riftRoute.arrived && riftRoute.anchorLocked) riftEntranceUniv.add(_v);
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
        // nav.vel is body-relative while this assist is active. Rotate it with
        // the local frame so a held strafe/approach direction does not drift as
        // the ground turns underneath the ship.
        nav.vel.applyQuaternion(dq);
        if (riftRoute && !riftRoute.arrived && riftRoute.anchorLocked) {
          riftEntranceUniv.sub(referenceBody.posUniv).applyQuaternion(dq).add(referenceBody.posUniv);
          riftOrientation.premultiply(dq);
        }
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
  // Start warming the new planet's atmosphere/cloud materials as soon as it
  // becomes the nearest body, so descent through its cloud layer is smooth.
  if (nearest && nearest !== prevRef) prewarmPlanetVolumePipelines(nearest);

  // controls / state integration — skipped while paused so player input and
  // any dt-driven drift stay disconnected from the frozen simulation.
  flightPower = ui.getPowerEffects();
  spaceCtl.gravityPower = flightPower.gravity;
  spaceCtl.navigationPower = flightPower.navigation;
  if (!paused && state === 'space') {
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
    pulseActive = !!pulseBurst;
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
        * (pulseActive ? 1.18 : 1);
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), safeInward, 0);
    }
    flightStepStart.copy(nav.pos);
    spaceCtl.update(dt);
    if (pulseBurst) {
      pulseBurst.elapsed = Math.min(PULSE_DURATION, pulseBurst.elapsed + dt);
      const progress = pulseBurstProgress(pulseBurst.elapsed / PULSE_DURATION);
      nav.pos.addScaledVector(pulseBurst.direction,
        pulseBurst.distance * Math.max(0, progress - pulseBurst.progress));
      pulseBurst.progress = progress;
      if (pulseBurst.elapsed >= PULSE_DURATION) cancelPulseBurst();
    }
    if (nearest) {
      _v.copy(nav.pos).sub(nearest.posUniv);
      const centerDistance = _v.length();
      const radialOut = _v.multiplyScalar(1 / Math.max(centerDistance, 1));
      const forward = _v2.set(0, 0, -1).applyQuaternion(nav.quat);
      const safeInward = (55 + Math.pow(Math.max(0, nearestAlt), 0.75) * 0.6)
        * (pulseActive ? 1.18 : 1);
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), safeInward, dt);
    }
    // Sweep the camera's whole frame step against procedural terrain. Checking
    // only last frame's altitude allowed a low-FPS step to enter or cross a
    // narrow ridge before the next correction.
    if (nearest && !nearest.isGasGiant) {
      const travel = flightStepStart.distanceTo(nav.pos);
      const steps = Math.min(12, Math.max(1, Math.ceil(travel / 3)));
      for (let i = 1; i <= steps; i++) {
        flightProbeWorld.lerpVectors(flightStepStart, nav.pos, i / steps);
        nearest.worldPositionToLocal(flightProbeWorld, flightProbeLocal);
        const radius = flightProbeLocal.length();
        _up.copy(flightProbeLocal).multiplyScalar(1 / Math.max(radius, 1));
        const groundRadius = nearest.surfaceRadius(_up);
        const clearance = radius - groundRadius;
        if (i === steps) nearestAlt = clearance;
        if (clearance >= 3) continue;
        const safeRadius = groundRadius + 3;
        nearest.localPositionToWorld(_up.multiplyScalar(safeRadius), nav.pos);
        nearest.localOffsetToWorld(_up.normalize(), _v);
        const inward = Math.min(0, nav.vel.dot(_v));
        nav.vel.addScaledVector(_v, -inward);
        nearestAlt = 3;
        break;
      }
    }
    if (nearest?.isGasGiant && nearestAlt < -nearest.R * 0.1) {
      // Pressure-protection autopilot: no death loop, but the cloud dive has a
      // strong physical consequence and temporarily takes the controls.
      _v.copy(nav.pos).sub(nearest.posUniv).normalize();
      nav.pos.copy(nearest.posUniv).addScaledVector(_v, nearest.R * 0.92);
      nav.vel.addScaledVector(_v, Math.max(900, -nav.vel.dot(_v) + 900));
      ui.setHint('压力临界 · 自动驾驶强制拉升', true);
      cancelPulseBurst();
    }
  } else if (!paused && state === 'walk') {
    cancelPulseBurst();
    walkCtl.update(dt);
    walkCtl.planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(walkCtl.planet.frameOrientation).multiply(walkCtl.quat);
  }
  // While paused, stepTweens(dt=0) is a no-op and the camera/world stay put.
  stepTweens(dt);
  updateRiftRoute(dt);
  updateDestinationMarker();

  // The ship reactor recharges pulse energy after a short thermal cooldown.
  // Recharge continues while landed so pulse fuel can never become a dead-end
  // resource that requires restarting the session.
  if (!pulseActive) {
    pulseRechargeDelay = Math.max(0, pulseRechargeDelay - dt);
    if (pulseRechargeDelay <= 0 && pulseFuel < PULSE_FUEL_MAX) {
      pulseFuel = Math.min(PULSE_FUEL_MAX, pulseFuel + dt * 7.0 * flightPower.thermal);
    }
  }

  const weaponTrigger = state === 'space' && (spaceCtl.firing || spaceCtl.firePressed);
  weaponCooldown -= dt;
  if (weaponTrigger && weaponCooldown <= 0 && flightPower.weapon > 0) {
    weapons.fire(nav, spaceCtl.speedScale, ship, flightPower.weapon);
    audio.cue('fire');
    weaponCooldown = 0.13 / flightPower.weapon;
  } else if (!weaponTrigger) {
    weaponCooldown = Math.min(weaponCooldown, 0);
  }
  spaceCtl.firePressed = false;

  const boostTarget = state === 'space' && (spaceCtl.boosting || keys.ShiftLeft || keys.ShiftRight) ? 1 : 0;
  boostVisual += (boostTarget - boostVisual) * (1 - Math.exp(-dt * (boostTarget ? 7.5 : 8.5)));
  const pulseK = pulseBurst ? clamp(pulseBurst.elapsed / PULSE_DURATION, 0, 1) : 1;
  const pulseTarget = pulseBurst
    ? smoothstep(0, 0.04, pulseK) * (1 - smoothstep(0.55, 1, pulseK))
    : 0;
  pulseVisual = pulseTarget > pulseVisual
    ? pulseTarget
    : pulseVisual + (pulseTarget - pulseVisual) * (1 - Math.exp(-dt * 14));
  weaponVisual += ((weaponTrigger ? 1 : 0) - weaponVisual) * (1 - Math.exp(-dt * 16));
  if (state === 'space' && warpIntensity < 0.01) {
    const riftFov = riftRoute && !riftRoute.arrived ? spatialRift.burst * 9.5 : 0;
    const fovResponse = pulseTarget > pulseVisual ? 14 : 6.2;
    camera.fov += ((BASE_FOV + boostVisual * 6.5 + pulseVisual * 19.0 + riftFov) - camera.fov)
      * (1 - Math.exp(-dt * fovResponse));
    camera.updateProjectionMatrix();
  }
  document.body.classList.toggle('weapon-firing', weaponVisual > 0.12);

  // One WebGL pass now owns both interstellar warp and the discrete local
  // pulse. It runs before the foreground ship pass, so rays never float over
  // the hull as a separate screen layer.
  warpDrivePass.enabled = Math.max(warpIntensity, pulseVisual, warpArrival) > 0.005;
  warpDrivePass.uniforms.time.value = clock.elapsedTime;
  warpDrivePass.uniforms.warp.value = warpIntensity;
  warpDrivePass.uniforms.pulse.value = pulseVisual;
  warpDrivePass.uniforms.arrival.value = warpArrival;
  warpDrivePass.uniforms.aspect.value = camera.aspect;

  // true frame velocity (a warp moves nav.pos directly, not via nav.vel)
  if (frameNo > 2) _velActual.copy(nav.pos).sub(prevNavPos).multiplyScalar(1 / dt);
  // a deferred system (warp or manual approach) materializes one planet/frame
  if (universe.system && !universe.system.built) universe.system.buildNext();

  // Render adapters consume the already-updated simulation frames.
  for (const p of universe.planets()) {
    _v.copy(nav.pos).sub(p.posUniv);
    p.lod.startupPriority = !loadingCleared && p === nearest;
    if (p.waterLod) p.waterLod.startupPriority = !loadingCleared && p === nearest;
    p.update(_v, dt, p === nearest, FREEZE || photoMode ? 0 : dt);
  }
  if (nearest && !nearest.isGasGiant) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    nearest.worldOffsetToLocal(_v, _v);
    scatter.update(nearest?.type === 'artificialHabitat' ? null : nearest, _v, nearestAlt);
    if (scatter.planet) {
      prewarmSurfacePipelines(scatter.planet);
      if (!surfacePipelinesReady) {
        for (const mesh of Object.values(scatter.meshes)) mesh.visible = false;
      }
    }
    if (FARFLORA) farFlora.update(nearest?.type === 'artificialHabitat' ? null : nearest, _v, nearestAlt);
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
  // Build the opening planet behind the loading mask. Previously the mask was
  // released with only the six root faces present, so the player watched the
  // whole planet change shape for the first seconds of flight. This larger
  // startup budget is bounded by STARTUP_WARM_BUDGET_MS and never applies to
  // interactive frames.
  // High-tier devices can spend a larger slice while the loading mask is up;
  // this finishes the same final orbit mesh sooner instead of deferring work
  // into playable frames. Keep the low tier conservative for integrated GPUs.
  const startupBuildMs = QUALITY_LOW ? 5.5 : 42;
  const built = flushChunkQueue(BUILD_MS || (!loadingCleared
    ? startupBuildMs
    : state === 'walk' ? 2.6 : nearTerrain ? 3.2 : 1.6));
  if (built > 0) lastBuildFrame = frameNo;

  // camera-relative placement
  universe.updateRelative(nav.pos);
  camera.position.set(0, 0, 0);
  camera.quaternion.copy(nav.quat);
  // Weapons stay cold while paused; surface weapons keep their pose but get no
  // trigger input because dt=0 and the fire state is disconnected upstream.
  activeBolts = paused ? activeBolts : weapons.update(dt, nav, nearest);
  const surfaceShotDistance = state === 'walk' ? surfaceBeamDistance(120) : 120;
  surfaceWeapons.update(dt, state === 'walk' && !paused, surfaceShotDistance, {
    speed: walkCtl.hSpeed.length(),
    grounded: walkCtl.grounded,
  });
  document.body.classList.toggle('surface-ads', state === 'walk' && surfaceWeapons.ads);

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
  // Manual flight velocity is relative to the currently followed body. Using
  // absolute universe displacement here made a zero-speed hover inherit the
  // planet's rotation and falsely trigger continuous atmospheric buffeting.
  const flightSpd = state === 'space' ? nav.vel.length() : trueSpd;
  if (envInAtmo > 0.05 && flightSpd > 220 && (state === 'space' || state === 'flyto')) {
    const amp = Math.min(1, flightSpd / 3200) * envInAtmo * (0.16 + boostVisual * 0.08);
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
  if (riftRoute && !riftRoute.arrived && spatialRift.burst > 0.01) {
    const t = clock.elapsedTime;
    const impact = spatialRift.burst * 0.72;
    camera.position.x += Math.sin(t * 43.0) * impact;
    camera.position.y += Math.sin(t * 37.0 + 1.1) * impact * 0.72;
  }

  // the ship flies just ahead of the camera whenever we're in flight
  ship.update(dt, nav, state, flightSpd, warpIntensity, Math.max(boostVisual, pulseVisual * 1.3), {
    throttle: spaceCtl.throttleInput,
    strafe: spaceCtl.strafeInput,
    yaw: spaceCtl.lookInput.yaw,
    pitch: spaceCtl.lookInput.pitch,
  });
  prewarmLoadedShipPipelines();
  audio.update({
    state,
    speed: flightSpd,
    atmosphere: envInAtmo,
    boosting: boostVisual > 0.12 || pulseVisual > 0.12,
    warp: Math.max(warpIntensity, pulseVisual * 0.68),
    rift: riftRoute ? spatialRift.open * (spatialRift.handoffActive ? 0.35 : 1) : 0,
    paused,
  });
  // Background music director: pickTrack decides what should be playing based
  // on state, planet biome, snow coverage, black-hole vicinity and star-map
  // open state. Only switches when the target changes.
  music.update({
    state,
    planetType: (state === 'walk' && walkCtl.planet?.type) || null,
    snowWeight: state === 'walk' ? currentWalkSnowWeight : 0,
    nearBlackHole: !!nearbyBlackHole(),
    starmapOpen: !!starMap?.isOpen,
  });

  // HUD
  const boostSpeedLimit = flightBoostSpeedLimit(
    spaceCtl.speedScale,
    spaceCtl.atmosphereFactor,
    flightPower.gravity,
  );
  // Manual cruise uses the RMB-governed velocity. A pulse moves nav.pos
  // directly and may be terrain-capped, so its cockpit value is expressed as
  // full boost speed plus the pulse envelope, while still honoring a larger
  // true frame displacement. The pointer itself remains capped at full boost.
  const pulseDisplaySpeed = state === 'space' && (pulseActive || pulseVisual > 0.01)
    ? Math.max(_velActual.length(), boostSpeedLimit * (1 + pulseVisual * 1.8))
    : 0;
  const spd = state === 'walk' ? walkCtl.hSpeed.length()
    : state === 'space' ? Math.max(nav.vel.length(), pulseDisplaySpeed) : _velActual.length();
  ui.setAltitude(nearest && nearestAlt < 2e7 ? Math.max(0, nearestAlt) : null, spd);
  ui.setFlightTelemetry({
    speed: spd,
    speedLimit: boostSpeedLimit,
    boost: boostVisual,
    atmosphere: envInAtmo,
    pulse: pulseVisual,
    pulseFuel,
    pulseFuelMax: PULSE_FUEL_MAX,
    pulseRecharging: !pulseActive && pulseRechargeDelay <= 0 && pulseFuel < PULSE_FUEL_MAX - 0.005,
    shield: 100 * flightPower.shield,
    gun: 100 * flightPower.weapon,
  });
  const localHours = nearest ? localSolarTimeAt(nearest, nav.pos) : null;
  ui.setCosmicTime(celestialClock.hours, localHours, celestialClock.scale);
  _v.set(0, 0, -1).applyQuaternion(nav.quat);
  const headingDeg = Math.atan2(_v.x, -_v.z) * 180 / Math.PI;
  ui.setHeading(headingDeg);

  // the survey watch owns the bottom-left corner while on foot: local solar
  // time, day/night terminator, local atmospheric pressure / cell charge and
  // a true spherical bearing home to the parked ship
  if (state === 'walk' && walkCtl.planet) {
    dialAcc += dt;
    if (dialAcc >= 0.15) {
      dialAcc = 0;
      const p = walkCtl.planet;
      _up.copy(walkCtl.posLocal).normalize();
      // Reproduce WalkControls' local east/north basis, including its polar
      // fallback. This keeps heading and ship bearing correct anywhere.
      if (Math.abs(_up.y) < 0.93) _v3.crossVectors(_v.set(0, 1, 0), _up).normalize();
      else _v3.crossVectors(_v.set(1, 0, 0), _up).normalize();
      _v.crossVectors(_up, _v3).normalize();
      let bearing = null;
      if (ship.parkedPosUniv) {
        p.worldPositionToLocal(ship.parkedPosUniv, _v2).sub(walkCtl.posLocal).projectOnPlane(_up);
        if (_v2.lengthSq() > 4) bearing = Math.atan2(_v2.dot(_v3), _v2.dot(_v)) * 180 / Math.PI;
      }
      const sunLocal = p.sunDirLocal || _up;
      const pressure = Math.max(0, Number(p.atmosphere?.pressureBar) || 0);
      const missionSol = Math.floor(celestialClock.hours / 24);
      walkDial?.setState({
        time: { seconds: (localHours ?? 12) * 3600 },
        date: { day: 'SOL', month: 'UT', date: missionSol },
        planet: {
          name: p.name,
          phase: clamp(_up.dot(sunLocal), -0.98, 0.98),
          rotation: p.rotationPeriodHours ? (celestialClock.hours / p.rotationPeriodHours) * Math.PI * 2 : 0,
          lightTilt: Math.atan2(sunLocal.dot(_v), sunLocal.dot(_v3)),
          selected: true,
        },
        ap: pressure / (pressure + 1),
        battery: clamp(pulseFuel / PULSE_FUEL_MAX, 0, 1),
        heading: walkCtl.yaw * 180 / Math.PI,
        destinationBearing: bearing,
        weather: walkWeatherFor(p, _up, sunLocal),
      });
      // Refresh snow coverage for the music director. Alpine theme is only
      // eligible on habitable worlds (handled in pickTrack); on other types we
      // keep the value at 0 so their own ambience takes precedence.
      currentWalkSnowWeight = (p.type === 'lush' || p.type === 'ocean')
        ? Math.max(0, p.snowWeightAt?.(_up, p.height(_up, 64)) || 0)
        : 0;
    }
  }
  if (volumePass) {
    const motion = clamp(trueSpd / Math.max(nearest?.R || 1, 60000) * 18 + boostVisual * 0.22, 0, 1);
    volumePass.setActivePlanet(nearest?.isGasGiant || nearest?.type === 'artificialHabitat' ? null : nearest, nav.pos, motion);
  }
  // The cockpit hull and the first-person weapon rig share the depth-cleared
  // foreground layer. Walking parks the ship back in world space, but the gun
  // still owns this pass; tying it only to ship.foregroundOnly hid all four
  // weapon models after landing.
  foregroundPass.enabled = ship.foregroundOnly || surfaceWeapons.rig.visible;
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
  const adaptInterval = perfEmaMs > 28 ? 0.8 : QUALITY_LOW ? 1.5 : 2.5;
  if (dprAcc > adaptInterval && !FREEZE) {
    dprAcc = 0;
    if (perfEmaMs > 28) setRenderDpr(renderDpr - 0.15);
    else if (QUALITY_LOW && perfEmaMs > 17.2) setRenderDpr(renderDpr - 0.05);
    else if (perfEmaMs > 20.5) setRenderDpr(renderDpr - 0.1);
    else if (perfEmaMs < (QUALITY_LOW ? 15.2 : 14.2)) setRenderDpr(renderDpr + 0.05);
  }

  if (!FREEZE && !photoMode) tickShaders(dt);
  renderRiftPortal();
  spatialRift.updateDistortion(riftDistortionPass);
  surfaceWeapons.renderScopeView(renderer);
  if (!surfacePipelinesReady
    && performance.now() - startupWarmStartedAt >= STARTUP_WARM_BUDGET_MS) {
    releaseStartupPrewarm('deadline exceeded; continuing in background');
  }
  finishSurfaceBootstrap();
  renderer.info.reset();
  // Skip the actual GPU work while the WebGL context is lost — Three.js
  // no-ops render() anyway, but skipping avoids noise from the post chain
  // trying to read stale render targets. The context-lost HUD hint is
  // surfaced from the listener.
  if (!contextLost) {
    // V2 compute shader scheduling: cloud noise bakes once on first frame.
    // (ocean v6 uses noise texture, no compute; atmosphere v2 is pure TSL.)
    if (BOOT_USE_WEBGPU) {
      scene.traverse((obj) => {
        const cn = obj.isMesh && obj.material?.userData?.computeNode;
        if (!cn || _executedComputeNodes.has(cn)) return;
        renderer.compute(cn);
        _executedComputeNodes.add(cn);
      });
    }
    // The same RenderPipeline executes on WebGPU and WebGL 2. Disabling post
    // only zeros optional effect uniforms; it never swaps renderer families.
    bloomPass.enabled = usePost && !QUALITY_LOW;
    const d = window.__diag ||= {};
    d.renderCalls = (d.renderCalls || 0) + 1;
    try {
      nodePipeline.render();
      d.renderOk = (d.renderOk || 0) + 1;
    } catch (e) {
      d.renderErr = (d.renderErr || 0) + 1;
      if (d.renderErr <= 3) console.error('[diag] nodePipeline.render threw:', e);
    }
  }
  prevNavPos.copy(nav.pos);
  const startupAssetsReady = shipPipelinesWarmed || startupPrewarmExpired
    || performance.now() - startupWarmStartedAt > 6000;
  const startupTerrainTimedOut = performance.now() - startupWarmStartedAt
    >= STARTUP_WARM_BUDGET_MS + STARTUP_TERRAIN_GRACE_MS;
  const terrainReady = startupTerrainReady() || startupTerrainTimedOut;
  if (!loadingCleared) {
    // Stage-weighted target — only moves forward. Each milestone contributes
    // a fixed slice so the bar reflects real pipeline readiness instead of an
    // infinite CSS sweep that resets to zero.
    let target = 0;
    if (frameNo >= 3) target += 0.15;
    if (surfacePipelinesReady) target += 0.35;
    if (startupAssetsReady) target += 0.25;
    if (terrainReady) target += 0.25;
    if (loadingProgress < target) {
      loadingProgress += (target - loadingProgress) * Math.min(1, dt * 5);
      if (loadingProgress > target) loadingProgress = target;
    }
    ui.setLoadingProgress(loadingProgress);
  }
  if (!loadingCleared && frameNo >= 3 && surfacePipelinesReady
    && startupAssetsReady && terrainReady) {
    if (!shipPipelinesWarmed) {
      for (const mesh of surfaceBootstrapMeshes.splice(0)) {
        scene.remove(mesh);
        if (mesh.isInstancedMesh) mesh.dispose();
        else mesh.geometry.dispose();
      }
    }
    loadingProgress = 1;
    ui.setLoadingProgress(1);
    loadingCleared = true;
    ui.setLoading(false);
  } else if (!loadingCleared
    && performance.now() - startupWarmStartedAt
      > STARTUP_WARM_BUDGET_MS + STARTUP_TERRAIN_GRACE_MS + 3000) {
    // Safety net: every individual stage has its own timeout, but if some
    // unforeseen interaction (driver reset, missed rAF, extension blocking
    // compileAsync) leaves the mask up past the worst-case budget, force it
    // down so the player is never stranded on the loading screen.
    console.warn('loading mask forced clear by safety-net timeout');
    loadingProgress = 1;
    ui.setLoadingProgress(1);
    loadingCleared = true;
    ui.setLoading(false);
  }
}

wireUniverse(universe);
const SHOW_HERO = qs.get('nohero') !== '1' && !window.NMS_NOLOCK;
// Hero opens tight on the home planet's limb behind the start page; the
// nohero/test path keeps the classic spawn orbit so captures stay stable.
spawn(SHOW_HERO);
ui.setLoading(true, '加载中');
// Bootstrap shows the pre-hero splash (clean "Deep Space" title card) behind
// the loading veil; a click dissolves into the full hero start page.
ui.showSplash(SHOW_HERO);
if (SHOW_HERO) spaceCtl.enabled = false;
const bootstrapSurfacePlanet = universe.system.planets[0];
if (bootstrapSurfacePlanet && !bootstrapSurfacePlanet.isGasGiant) {
  scatter.setPlanet(bootstrapSurfacePlanet);
  for (const mesh of Object.values(scatter.meshes)) mesh.visible = false;
  if (FARFLORA) farFlora.setPlanet(bootstrapSurfacePlanet);
  if (farFlora.meshes) for (const mesh of farFlora.meshes) mesh.visible = false;
  if (QUALITY_LOW) {
    shipPipelinesWarmed = true;
    renderer.debug.checkShaderErrors = qs.get('shaderchecks') === '1';
  } else {
    prewarmSurfacePipelines(bootstrapSurfacePlanet);
  }
}
frame();

// ---- debug / test API (used by tools/screenshot.js) ----------------------------
function riftExitDepthRange() {
  if (!riftRoute?.arrived || !spatialRift.group.visible) return null;
  spatialRift.visual.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const depths = [];
  for (const z of [24, -spatialRift.depth - 24]) {
    for (const x of [-spatialRift.width * 0.62, spatialRift.width * 0.62]) {
      for (const y of [-spatialRift.height * 0.62, spatialRift.height * 0.62]) {
        const point = new THREE.Vector3(x, y, z);
        spatialRift.visual.localToWorld(point);
        camera.worldToLocal(point);
        depths.push(point.z);
      }
    }
  }
  return { min: Math.min(...depths), max: Math.max(...depths) };
}

window.NMS = {
  version: VERSION,
  _ff: farFlora,           // debug handle (headless diagnostics)
  _renderer: renderer,
  _THREE: THREE,
  get booted() {
    return loadingCleared;
  },
  get state() { return state; },
  get paused() { return paused; },
  seed: () => SEED,
  galaxy: () => ({ id: GALAXY_ID, name: GALAXY.name }),
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
      pulse: pulseActive, pulseVisual, pulseFuel: Math.round(pulseFuel * 10) / 10,
      power: { ...flightPower },
      warpArrival,
      firing: spaceCtl.firing, bolts: activeBolts,
      cosmicHours: celestialClock.hours, timeScale: celestialClock.scale,
      dayLight: envDay, eclipse: envEclipse,
      gpu: gpuName, dpr: renderDpr,
      rendererRequested: rendererPolicy.requested,
      rendererBackend: actualRendererBackend,
      rendererReason: rendererRuntime.reason,
      webgpuAvailable: rendererPolicy.webgpuAvailable,
      adapterInfo: webgpuAdapterInfo,
      quality: (QUALITY_PROFILE.automatic ? 'auto-' : '') + QUALITY_PROFILE.id,
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
      magnetosphere: p.spec?.magnetosphere ?? null,
      clouds: p.spec?.clouds ?? null,
      seaLevel: p.hasLiquid ? p.seaLevel : null,
      cloudCoverage: p.cloudCoverage || 0,
      tuning: p.tuning ? { ...p.tuning } : {},
      localSolarTime: localSolarTimeAt(p, p === nearest ? nav.pos : null),
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
    if (p.type === 'artificialHabitat') {
      const dir = p.scenicDir();
      parkShipNear(p, dir);
      const local = dir.clone().multiplyScalar(p.surfaceRadius(dir) + 1.7);
      const forward = new THREE.Vector3().crossVectors(p.sunDirLocal, dir).normalize();
      if (forward.lengthSq() < 0.1) forward.set(1, 0, 0);
      walkCtl.enter(p, local, forward);
      walkCtl.yaw += yawDeg * Math.PI / 180;
      walkCtl.update(0.001);
      p.localPositionToWorld(walkCtl.posLocal, nav.pos);
      nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
      focusPlanet = p; spaceCtl.focus = p;
      setState('walk');
      return true;
    }
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
    isBlackHoleSystem: !!universe.system.spec.isBlackHoleSystem,
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
      magnetosphere: body.magnetosphere, clouds: body.clouds,
      rotationPeriodHours: body.rotationPeriodHours, axialTilt: body.axialTilt,
      orbit: { ...body.orbit },
      position: universe.system.positionAt(body.bodyId, celestialClock.hours).toArray(),
      velocity: universe.system.velocityAt(body.bodyId, celestialClock.hours).toArray(),
    })),
    compactObjects: (universe.system.spec.compactObjects || []).map((body) => ({
      bodyId: body.bodyId, name: body.name, catalogName: body.catalogName,
      type: body.type, radius: body.radius, accretionRadius: body.accretionRadius,
      blackHole: body.blackHole, orbit: { ...body.orbit },
      position: universe.system.positionAt(body.bodyId, celestialClock.hours).toArray(),
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
    let s = id ? [...universe.nearStarsList, ...universe.specialDestinations].find((x) => x.id === id) : null;
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
    const star = [...universe.nearStarsList, ...universe.specialDestinations].find((item) => item.id === id);
    if (!star || !starMap?.isOpen) return null;
    starMap.selectStar(star, false);
    return star.id;
  },
  blackHoleDestination: () => universe.specialDestinations[0]
    ? { id: universe.specialDestinations[0].id, name: universe.specialDestinations[0].name, position: universe.specialDestinations[0].pos.toArray() }
    : null,
  warpToBlackHole() {
    const destination = universe.specialDestinations[0];
    if (!destination) return false;
    warpTo(destination, 'black-hole-0');
    return true;
  },
  openBlackHoleObservatory: () => openBlackHoleObservatory(),
  closeBlackHoleObservatory: () => closeBlackHoleObservatory(),
  get blackHoleObservatoryOpen() { return blackHoleObservatoryOpen; },
  setStarMapMode(mode) {
    if (!starMap?.isOpen || !['galaxy', 'system'].includes(mode)) return false;
    starMap.setMode(mode);
    return true;
  },
  ...(WORLD_LAB ? {
    setSeed: (seed) => newUniverse(seed),
    randomizeWorld: () => newUniverse(),
  } : {}),
  pos: () => nav.pos.toArray(),
  quat: () => nav.quat.toArray(),
  alt: () => nearestAlt,
  isTouch: IS_TOUCH,
  walkSpeed: () => walkCtl.hSpeed.length(),
  warp: () => warpIntensity,
  pulseFuel: () => pulseFuel,
  power: () => ({ state: ui.getPowerState(), effects: ui.getPowerEffects() }),
  riftState: () => ({
    active: !!riftRoute,
    arrived: !!riftRoute?.arrived,
    open: spatialRift.open,
    tension: spatialRift.tension,
    burst: spatialRift.burst,
    handoff: spatialRift.handoffFade,
    visible: spatialRift.group.visible,
    audioCue: audio.lastCue,
    exitDepth: riftExitDepthRange(),
    distanceToThreshold: riftRoute && !riftRoute.arrived
      ? new THREE.Vector3().copy(nav.pos).sub(riftEntranceUniv)
        .applyQuaternion(new THREE.Quaternion().copy(riftOrientation).invert()).z + spatialRift.depth
      : null,
    destinationLight: riftPreviewSystem?.starViews.map((view) => view.light.intensity)
      || universe.system?.starViews.map((view) => view.light.intensity) || [],
    previewVolume: (() => {
      const target = riftPreviewSystem?.bodyById.get(riftRoute?.arrival?.bodyId);
      if (!target) return null;
      return {
        cloudCoverage: target.cloudCoverage || 0,
        atmosphereVisible: !!target.atmoMesh?.visible,
        volumeCloudVisible: !!target.volCloudMesh?.visible,
        analyticCloudVisible: !!target.cloudMesh?.visible,
        portalVolumeLayerRendered: spatialRift.portalVolumeLayerRendered,
      };
    })(),
  }),
  approachRift(distance = 38) {
    if (!riftRoute || riftRoute.arrived || !riftRoute.anchorLocked) return false;
    nav.pos.set(0, 0, -spatialRift.depth + Number(distance))
      .applyQuaternion(riftOrientation).add(riftEntranceUniv);
    nav.vel.set(0, 0, 0);
    return true;
  },
  setPulse(active) {
    return !!active && triggerPulse();
  },
  fireWeapon() {
    if (state !== 'space' || flightPower.weapon <= 0) return false;
    weapons.fire(nav, spaceCtl.speedScale, ship, flightPower.weapon);
    audio.cue('fire');
    return true;
  },
  surfaceWeapon(index) {
    surfaceWeapons.select(Number(index));
    return true;
  },
  surfaceReload: () => surfaceWeapons.reload(),
  surfaceWeaponState: () => ({
    index: surfaceWeapons.index,
    ammo: surfaceWeapons.models[surfaceWeapons.index].ammo,
    rendered: surfaceWeapons.rig.visible
      && surfaceWeapons.models[surfaceWeapons.index].group.visible
      && foregroundPass.enabled,
    assetLoaded: SURFACE_WEAPONS[surfaceWeapons.index].kind !== 'laser'
      || surfaceWeapons.models[surfaceWeapons.index].group.userData.loaded === true,
    reloading: surfaceWeapons.reloadT > 0,
    reloadProgress: surfaceWeapons.reloadDuration > 0
      ? 1 - surfaceWeapons.reloadT / surfaceWeapons.reloadDuration : 0,
    magazine: surfaceWeapons.models[surfaceWeapons.index].magazine?.position.toArray() || null,
    ads: surfaceWeapons.ads,
    scopeEyeBox: surfaceWeapons.models[surfaceWeapons.index].opticGlass?.material?.uniforms?.eyeBox?.value ?? null,
  }),
  surfaceScopeSample() {
    if (!SURFACE_WEAPONS[surfaceWeapons.index].hasScope) return null;
    const size = 16;
    const pixels = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(
      surfaceWeapons.scopeTarget,
      (surfaceWeapons.scopeTarget.width - size) / 2,
      (surfaceWeapons.scopeTarget.height - size) / 2,
      size,
      size,
      pixels,
    );
    let luminance = 0;
    let litPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const value = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
      luminance += value;
      if (value > 4) litPixels++;
    }
    return { luminance: luminance / (size * size), litPixels, totalPixels: size * size };
  },
  // seam accounting: unmorphed LOD level changes with their apparent size
  lod: () => ({ ...lodStats }),
  lodReset: () => { lodStatsReset(); return true; },
  shipVisible(v) { ship.group.visible = v; return true; },
  // internals, for the headless diagnosis harness
  get _internals() { return { universe, scene, renderer, nav, camera, starMap }; },
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
