import { selectStellarOccluders } from './stellar-occlusion.js';
// Entry point: renderer, the state machine (space flight → fly-to → landing →
// walking → takeoff → warp), camera-relative rendering (the camera never
// leaves the origin — the universe moves around it, so float precision holds
// from interstellar space down to boot level), and the ambience pass
// (atmosphere, fog, day/night, star dimming).

import * as THREE from 'three';
import { StarSystem, Universe } from './galaxy.js';
import { computeBlackHoleBasis } from './black-hole.js';
import { flushChunkQueue, pendingChunks, setGridCells, lodStats, lodStatsReset, setPxPerRad,
  setTerrainScreenError } from './quadtree.js';
import { SpaceControls, WalkControls, guidePlanetApproach, keys,
  flightBoostSpeedLimit, pulseBurstDistance } from './controls.js';
import { PULSE_TIMING, emptyTransitChannels, pulseChannels, pulseChargeFromHold, pulseChargeScaling,
  pulseDisplacement, transitIntensity, warpSpeedFraction,
  warpApproachRemaining, warpChannels, warpDepartureTravel, warpPlan } from './transit.js';
import { setStarflowViewport, starflowUniforms } from './starflow.js';
import { Scatter } from './scatter.js';
import { FarFlora } from './farflora.js';
import { createSurfaceWarmupScene } from './surface-warmup.js';
import { compileRenderVariant, withSurfaceWarmupVariant } from './render-prewarm.js';
import { compilePrograms } from './program-preparation.js';
import { compileDestinationVariant, compileWorldPublicationVariant, worldPublicationRevision } from './destination-preparation.js';
import { captureWorldPublication } from './world-publication.js';
import { FrameWorkBudget } from './frame-work-budget.js';
import { PresentedFrameStats } from './presented-frame-stats.js';
import { AdaptiveQualityGovernor, FrameGpuTimer } from './adaptive-quality.js';
import { landingDescentProgress, SHIP_LANDING_PROFILE,
  SkyDome, Ship, ShipWeapons, SHIP_FOREGROUND_LAYER,
  SHIP_INTERIOR_LAYER } from './effects.js';
import { loadShipModel, loadShipProbes } from './halcyon/ship/model.js';
import { ShipAudio } from './halcyon/ship/ship-audio.js';
import { ShipView, SHIP_WALK_EYE_HEIGHT } from './ship-view.js';
import {
  GEAR_GROUND_Y,
  GEAR_PADS,
  evaluateTripodPad,
  findLandingSite,
  createLandingSequence,
  createHoverEntrySequence,
  findRecallSite,
  createRecallFlyInSequence,
  createAutoDepartSequence,
  createTakeoffSequence,
} from './ship-landing.js';
import { SkydiveController } from './skydive.js';
import { WEAPON_FOREGROUND_LAYER } from './render-layers.js';
import { setWeatherWind, tickShaders } from './shaders.js';
import { UI } from './ui.js';
import { clamp, lerp, smoothstep } from './noise.js';
import { makeWord } from './names.js';
import { CelestialClock, TIME_SCALE, eclipseFraction, generateSystemSpec, orbitalPosition } from './astronomy.js';
import { VERSION } from './version.js';
import { FlightAudio } from './audio.js';
import { BackgroundMusic } from './music.js';
import { StarMap } from './starmap.js';
import './walkdial.js';
import { SpacePortal, createPortalProfile } from './portal/space-portal.js';
import { WarpConduit } from './warp-conduit.js';
import { PortalView } from './portal/portal-view.js';
import { SurfaceWeapons, SURFACE_WEAPONS, isSoftwareWebGL } from './surface-weapons.js';
import { SurveyUnits } from './saltline/robots.js';
import { SurfaceGameplay } from './saltline/surface-gameplay.js';
import { buildFragGrenade } from './golden-hour/weapons-engine.js';
import { ACTIVE_GALAXY_ID, applySystemBodyTuning, getGalaxyConfig, resolveBodyTuning } from './world-config.js';
import { setVolumetricCloudsEnabled } from './planet.js';
import { resolveRendererPolicy } from './renderer-policy.js';
import { createGameRenderer, installDeviceRecovery } from './renderer-runtime.js';
import { GameLegacyPipeline } from './legacy-render-pipeline.js';
import { SurfaceShadowGrid } from './surface-shadow-grid.js';
import { chooseAutomaticQuality, isLowPowerGpu, rendererParamsForSettings, resolveGraphicsSettings,
  resolveQualityProfile, writeGraphicsSettings } from './graphics-settings.js';
import { createEnvironmentState, updateEnvironmentState } from './environment-state.js';
import { SceneRadianceState } from './scene-radiance.js';
import { waterInteraction } from './water-interaction.js';
import { oceanSeconds, oceanClockJumped } from './ocean-clock.js';
import { surfaceInteraction } from './surface-interaction.js';
import { vegetationDisturbance } from './vegetation/disturbance.js';
import { configureSurfaceMaterials, surfaceMaterialStatus } from './surface-materials.js';
import { WeatherEffects } from './weather-effects.js';
import {
  configureCloudResourceManager, getCloudResourceManager,
} from './cloud/cloud-resource-manager.js';

const qs = new URLSearchParams(location.search);
// The unified look is the production baseline. `renderlook=legacy` remains a
// deterministic developer A/B path, not a second player-facing renderer.
const RENDER_LOOK_NEXT = qs.get('renderlook') !== 'legacy';
const graphicsSettings = resolveGraphicsSettings({ params: qs });
const rendererPolicy = resolveRendererPolicy(rendererParamsForSettings(graphicsSettings, qs));

// ---- error surface (also read by the headless test harness) ---------------
const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
  errBox.classList.remove('hidden');
  errBox.textContent += `${e.message} @ ${e.filename}:${e.lineno}\n`;
});

document.body.classList.toggle('debug-hud', qs.get('debug') === '1');
const DEV_SERVER = window.__NMS_DEV_SERVER__ === true;
const IS_LOCAL_HOST = location.hostname === '127.0.0.1'
  || location.hostname === 'localhost'
  || location.hostname === '[::1]'
  || location.hostname === '::1';
const DEV_INFINITE_PULSE = DEV_SERVER
  && IS_LOCAL_HOST
  && window.__NMS_DEV_INFINITE_PULSE__ === true
  && qs.get('infinitePulse') !== '0';
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
function createUniverse(seed, { deferSecondaryHomeBodies = false } = {}) {
  const initialPlanetIdx = qs.has('planet') ? Math.max(0, Number(qs.get('planet')) || 0) : 0;
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
    renderer,
    spaceRadianceResolution: QUALITY_PROFILE.spaceRadianceResolution,
    renderLook: RENDER_LOOK_NEXT,
    deferSecondaryHomeBodies,
    initialHomeBodies: initialPlanetIdx + 1,
  });
}
window.NMS_NOLOCK = qs.get('nolock') === '1';
const BUILD_MS = Number(qs.get('buildms')) || 0;
let debugBuildBudgetMs = BUILD_MS;
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
let touchHints = IS_TOUCH && window.matchMedia('(pointer: coarse)').matches;
window.addEventListener('pointerdown', (event) => {
  pointerLockInput = event.pointerType !== 'touch';
  touchHints = !pointerLockInput;
}, true);
window.addEventListener('keydown', () => { touchHints = false; }, true);

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
const renderer = rendererRuntime.renderer;
renderer.debug.checkShaderErrors = qs.get('shaderchecks') === '1';
const actualRendererBackend = rendererRuntime.backend;
const gpuName = rendererRuntime.gpuName;
configureSurfaceMaterials(renderer);
const RECOMMENDED_QUALITY = chooseAutomaticQuality(gpuName, {
  width: window.innerWidth, height: window.innerHeight,
});
const LOW_POWER_GPU = isLowPowerGpu(gpuName);
const AUTO_LOW_GPU = graphicsSettings.quality === 'auto' && LOW_POWER_GPU;
const QUALITY_PROFILE = resolveQualityProfile(graphicsSettings, gpuName, {
  touch: IS_TOUCH, width: window.innerWidth, height: window.innerHeight,
});
const QUALITY_LOW = QUALITY_PROFILE.id === 'performance';
// Chunk vertex density is never a performance-tier casualty. The scheduler
// reduces distant screen error and effect ranges while the player's near field
// retains the authored highest LOD.
setGridCells(24);
setTerrainScreenError(QUALITY_PROFILE.terrainScreenError);
renderer.setSize(window.innerWidth, window.innerHeight);
const MAX_DPR = QUALITY_PROFILE.dprMax;
const DESKTOP_DPR_FLOOR = QUALITY_PROFILE.dprMin;
function computeCeilingDpr(width = window.innerWidth, height = window.innerHeight) {
  const base = Math.min(Math.max(window.devicePixelRatio || 1, QUALITY_PROFILE.dprTarget), MAX_DPR);
  if (!QUALITY_PROFILE.automatic) return base;
  // Cap automatic pixel budget near native QHD (~3.87M pixels) so HiDPI 2K/4K
  // panels stay sharp without silently multiplying 8 full-screen HDR passes.
  const maxAutoPixels = 2560 * 1440 * 1.05;
  const pixelCap = Math.sqrt(maxAutoPixels / Math.max(1, width * height));
  return clamp(Math.min(base, Math.max(1.0, pixelCap)), DESKTOP_DPR_FLOOR, MAX_DPR);
}
let renderDpr = computeCeilingDpr();
renderer.setPixelRatio(renderDpr);
// Physical water refraction needs the opaque scene buffer, but sampling it at
// full supersampled DPR would render a second 3200x1800 4x-MSAA scene at
// 1440p Ultra. The quality-profile scale keeps a 1280x720 source while
// wave-normal bicubic filtering hides sub-pixel loss in the refracted floor.
// Water can disable its transmission, but cockpit glass still needs a valid
// shared transmission target. Zero here creates a 0×0 framebuffer for glass.
renderer.transmissionResolutionScale = QUALITY_PROFILE.waterTransmissionScale || 0.5;
renderer.toneMapping = RENDER_LOOK_NEXT ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
// r183 aliases the removed PCFSoft path to PCF on the first shadow render.
// Selecting the effective mode up front keeps prewarmed and live hull shader
// keys identical instead of recompiling every PBR material on Hero start.
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app').appendChild(renderer.domElement);
console.info(`Renderer: ${renderer.constructor.name}/${actualRendererBackend}`, gpuName);

// WebGL context-loss safety net. The renderer auto-restores most GPU
// resources on the next render after restore, but without an explicit
// preventDefault the canvas stays black and silent. WebGPU loss reconstructs
// the deterministic scene after one guarded reload; WebGL 2 resumes in-place.
let contextLost = false;
installDeviceRecovery(renderer, (state, detail) => {
  contextLost = state === 'lost';
  if (state === 'lost') getCloudResourceManager()?.handleDeviceLost();
  const notice = document.getElementById('performance-notice');
  if (notice && state === 'lost') {
    notice.textContent = 'WebGL 2 图形上下文已丢失，等待恢复…';
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
const surfaceShadowGrid = new SurfaceShadowGrid();
sunShadow.castShadow = true;
// Keep sunShadow permanently visible (with intensity=0 and shadow.autoUpdate=false
// outside surface range) so orbit, approach, low flight and walking share one
// unified world shader program key instead of stalling ~3.5 s on first descent.
sunShadow.visible = true;
const SHADOW_MAP = QUALITY_PROFILE.shadowMap;
sunShadow.shadow.mapSize.set(4, 4);
sunShadow.shadow.autoUpdate = false;
sunShadow.shadow.needsUpdate = true;
sunShadow.shadow.camera.near = 100;
sunShadow.shadow.camera.far = 8500;
sunShadow.shadow.camera.left = sunShadow.shadow.camera.bottom = -QUALITY_PROFILE.shadowDistance;
sunShadow.shadow.camera.right = sunShadow.shadow.camera.top = QUALITY_PROFILE.shadowDistance;
sunShadow.shadow.bias = -0.0002;
sunShadow.shadow.normalBias = 2.0;
scene.add(sunShadow, sunShadow.target);
let shadowBlend = 0;
let activeShadowOctave = 1;
const sunDirCam = new THREE.Vector3(0, 1, 0);
let warmedSurfacePlanet = null;
let surfacePipelinesReady = true;
const surfaceBootstrapMeshes = [];
const surfaceBootstrapGroup = new THREE.Group();
let surfaceBootstrapPending = false;
const surfaceBootstrapTarget = new THREE.RenderTarget(2, 2, { depthBuffer: true });
let surfaceBootstrapStats=null;
let shipPipelinesWarmed = false;
let shipPipelineWarmPending = false;
let postPipelinesWarmPending = false;
let weaponPipelinesWarmPending = false;
let weaponPipelinesWarmed = false;
let heroTransitionActive = false;
let startupWarmStartedAt = performance.now();
const STARTUP_WARM_BUDGET_MS = QUALITY_LOW ? 1800 : 24000;
const STARTUP_SHADER_BUDGET_MS = isSoftwareWebGL(renderer) ? STARTUP_WARM_BUDGET_MS : 24000;
const startupCompile = new AbortController();
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
  // orbitLevelCap is a ceiling, not a minimum: at 1.72R screen-space error
  // naturally settles below orbitLevelCap once pending===0 and activeMorphs===0.
  const settled = (stats, forceMin = 0) => !stats
    || (stats.visibleMaxLevel >= forceMin
      && stats.activeMorphs === 0 && stats.pending === 0);
  return settled(terrain, planet.lod?._forceLevel ?? 0)
    && settled(water, planet.waterLod?._forceLevel ?? 0);
}

function disposeSurfaceBootstrap() {
  for (const mesh of surfaceBootstrapMeshes.splice(0)) {
    mesh.removeFromParent();
    if (mesh.isInstancedMesh) mesh.dispose();
    else mesh.geometry.dispose();
  }
  surfaceBootstrapGroup.removeFromParent();
  surfaceBootstrapTarget.dispose();
}

function releaseStartupPrewarm(reason) {
  if (startupPrewarmExpired) return;
  startupPrewarmExpired = true;
  startupCompile.abort();
  surfaceBootstrapPending = false;
  surfacePipelinesReady = true;
  postPipelinesWarmPending = false;
  weaponPipelinesWarmPending = false;
  for (const mesh of surfaceBootstrapMeshes) mesh.visible = false;
  surfaceBootstrapStats||={skipped:true,reason,cpuMs:0,calls:0,meshes:surfaceBootstrapMeshes.length};
  disposeSurfaceBootstrap();
  renderer.debug.checkShaderErrors = qs.get('shaderchecks') === '1';
  console.warn(`startup shader prewarm released: ${reason}`);
}

function finishSurfaceBootstrap() {
  if (!surfaceBootstrapPending || contextLost) return;
  if(loadingCleared) {releaseStartupPrewarm('loading mask already released');return;}
  surfaceBootstrapPending = false;
  const savedTarget = renderer.getRenderTarget();
  const savedFace=renderer.getActiveCubeFace(),savedMip=renderer.getActiveMipmapLevel();
  const savedAutoClear = renderer.autoClear;
  const warmup=createSurfaceWarmupScene(scene,surfaceBootstrapGroup,camera,sunShadow);
  const started=performance.now(),calls=renderer.info.render.calls;
  try {
    // All materials and attributes are production representatives; only the
    // warmup light maps and colour target are tiny. Never draw the whole live
    // scene here: that submitted every planet/asset and full-size shadow map.
    for (const mesh of surfaceBootstrapMeshes) mesh.visible = true;
    renderer.autoClear = true;
    renderer.setRenderTarget(surfaceBootstrapTarget);
    renderer.clear(true, true, false);
    withSurfaceWarmupVariant(surfaceBootstrapGroup, () => renderer.render(warmup.scene, camera));
  } catch (error) {
    console.warn('surface bootstrap render failed', error);
  } finally {
    for (const mesh of surfaceBootstrapMeshes) mesh.visible = false;
    surfaceBootstrapStats={cpuMs:performance.now()-started,
      calls:renderer.info.render.calls-calls,meshes:surfaceBootstrapMeshes.length,
      shadowMapSizes:warmup.lights.filter(l=>l.shadow).map(l=>l.shadow.mapSize.toArray()),
      privateScene:true};
    warmup.dispose();
    renderer.setRenderTarget(savedTarget,savedFace,savedMip);
    renderer.autoClear = savedAutoClear;
  }
  // Ship compilation takes ship.group and the world light list; it never
  // owns these representatives. Do not retain their geometry after warmup.
  disposeSurfaceBootstrap();
  // All startup shaders were checked while the loading mask was active.
  // Querying program logs for every later LOD/GLB variant forces ANGLE to
  // synchronously finish compilation on the flight frame.
  renderer.debug.checkShaderErrors = qs.get('shaderchecks') === '1';
  surfacePipelinesReady = true;
}

function prewarmSurfacePipelines(planet, extraPlanets = null) {
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
  if (!planet || warmedSurfacePlanet) return;
  // Serialize startup scene preparation; readiness itself owns program identities.
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
  scene.add(surfaceBootstrapGroup);

  const surfaceSources = new Map();
  const candidatePlanets = (extraPlanets?.length ? extraPlanets : [planet])
    .filter((body) => body && !body.isGasGiant && body.group);
  for (const body of candidatePlanets) {
    body.group.traverse((object) => {
      if (!object.isMesh || !object.geometry?.getAttribute?.('aLocal')
        || !object.material) return;
      const attributes = Object.entries(object.geometry.attributes)
        .map(([name, value]) => {
          const stride = value.isInterleavedBufferAttribute ? value.data.stride : value.itemSize;
          return `${name}:${value.itemSize}:${stride}`;
        })
        .sort()
        .join('|');
      const materials = Array.isArray(object.material)
        ? object.material : [object.material];
      for (const material of materials) {
        const topology = typeof material.customProgramCacheKey === 'function'
          ? material.customProgramCacheKey() : material.uuid;
        const key = `${material.type}|${topology}|${attributes}|${object.castShadow ? 1 : 0}|${material.transparent ? 1 : 0}`;
        if (!surfaceSources.has(key)) surfaceSources.set(key, { object, material });
      }
    });
  }
  for (const { object: source, material } of surfaceSources.values()) {
    const geometry = source.geometry.clone();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.lodMorph = 0;
    mesh.position.set(0, 0, 0);
    mesh.frustumCulled = false;
    mesh.castShadow = source.castShadow || !material.transparent;
    mesh.customDepthMaterial=source.customDepthMaterial;
    mesh.customDistanceMaterial=source.customDistanceMaterial;
    mesh.onBeforeRender=source.onBeforeRender;
    mesh.onBeforeShadow=source.onBeforeShadow;
    mesh.receiveShadow = source.receiveShadow;
    mesh.visible = false;
    surfaceBootstrapGroup.add(mesh);
    surfaceBootstrapMeshes.push(mesh);
  }
  const instancedSources = [
    ...Object.values(scatter.meshes),
    ...(farFlora.meshes || []),
  ];
  for (const source of instancedSources) {
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, 1);
    mesh.setMatrixAt(0, new THREE.Matrix4());
    if (source.instanceColor) mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.position.set(0, 0, 0);
    mesh.frustumCulled = false;
    mesh.castShadow = source.castShadow;
    mesh.customDepthMaterial=source.customDepthMaterial;
    mesh.customDistanceMaterial=source.customDistanceMaterial;
    mesh.receiveShadow=source.receiveShadow;
    mesh.onBeforeRender=source.onBeforeRender;
    mesh.onBeforeShadow=source.onBeforeShadow;
    mesh.visible = false;
    surfaceBootstrapGroup.add(mesh);
    surfaceBootstrapMeshes.push(mesh);
  }

  // compileAsync gathers programs synchronously, then lets ANGLE finish them
  // through KHR_parallel_shader_compile. Temporarily exposing the real shadow
  // light makes the cached surface variants match the eventual ground pass.
  const signal = startupCompile.signal;
  const compilation = nodePipeline.prepare(() => {
    const lightWasVisible = sunShadow.visible;
    const lightIntensity = sunShadow.intensity;
    const savedTarget = renderer.getRenderTarget();
    const savedFace = renderer.getActiveCubeFace(), savedMip = renderer.getActiveMipmapLevel();
    sunShadow.visible = true;
    sunShadow.intensity = 1e-7;
    try {
      // The private warm draw and the composer use linear offscreen programs.
      // A default-framebuffer compile prepares a different output/tone-map key.
      renderer.setRenderTarget(surfaceBootstrapTarget);
      return withSurfaceWarmupVariant(surfaceBootstrapGroup,
        () => compilePrograms(renderer, surfaceBootstrapGroup, camera, scene, {signal}));
    } finally {
      renderer.setRenderTarget(savedTarget, savedFace, savedMip);
      sunShadow.visible = lightWasVisible;
      sunShadow.intensity = lightIntensity;
    }
  }, { signal, label: 'startup-surface', isCurrent: () => !startupPrewarmExpired && !loadingCleared });

  // The private render also warms the native depth/distance variants using
  // each representative's production deformation materials and draw hooks.
  compilation.then(() => {
    if (!startupPrewarmExpired) surfaceBootstrapPending = true;
  }).catch((error) => {
    if (startupPrewarmExpired) return;
    surfacePipelinesReady = true;
    disposeSurfaceBootstrap();
    console.warn('surface pipeline prewarm failed', error);
  });
}

function prewarmLoadedShipPipelines() {
  if (ship.heroLoadFailed) { shipPipelinesWarmed = true;return; }
  if (!ship.heroLoaded || shipPipelinesWarmed || shipPipelineWarmPending || !surfacePipelinesReady) return;
  if (startupPrewarmExpired) { shipPipelinesWarmed = true;return; }
  shipPipelineWarmPending = true;
  surfacePipelinesReady = false;
  const signal = startupCompile.signal;
  const options = { signal, label: 'startup-ship', isCurrent: () => !startupPrewarmExpired };
  const compileLayer = (layer, buffer) => nodePipeline.prepare(() => {
    // Select the current buffers/light domains after admission, not while a
    // queued job could still be invalidated by resize or a later simulation.
    configureShipForegroundLightingLayers();
    const foreground = ship.foregroundOnly, sunVisible = sunShadow.visible;
    try {
      if (layer === 0) { ship.setForegroundOnly(false);sunShadow.visible = true; }
      return compileRenderVariant(renderer, ship.group, camera, scene, {
        layer, target: nodePipeline.composer[buffer], shadowLight: layer === 0 ? sunShadow : null, signal,
      });
    } finally { ship.setForegroundOnly(foreground);sunShadow.visible = sunVisible; }
  }, options);
  const prepare = async () => {
    await nodePipeline.prepare(() => {
      const textures = new Set();
      ship.group.traverse(object => {
        if (!object.isMesh) return;
        for (const material of [object.material].flat()) {
          for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
            if (material?.[slot]) textures.add(material[slot]);
          }
        }
      });
      for (const texture of textures) renderer.initTexture(texture);
    }, options);
    await compileLayer(SHIP_FOREGROUND_LAYER, 'readBuffer');
    if (RENDER_LOOK_NEXT) await compileLayer(SHIP_INTERIOR_LAYER, 'readBuffer');
    // Parked hull/interior need the production WORLD light and HDR families too.
    await compileLayer(0, 'writeBuffer');
    if (RENDER_LOOK_NEXT) await compileLayer(SHIP_INTERIOR_LAYER, 'writeBuffer');
  };
  void prepare().then(() => {
    if (!startupPrewarmExpired) {
      shipPipelinesWarmed = true;
      if (typeof prewarmWarpConduitWithShipLights === 'function') prewarmWarpConduitWithShipLights();
    }
  }).catch(error => {
    if (!startupPrewarmExpired) console.warn('ship pipeline prewarm failed', error);
  }).finally(() => {
    shipPipelineWarmPending = false;
    surfacePipelinesReady = true;
  });
}

function prewarmWeaponAndPostPipelines() {
  if (startupPrewarmExpired) return;
  const signal = startupCompile.signal;
  const isCurrent = () => !startupPrewarmExpired && !loadingCleared;
  postPipelinesWarmPending = true;
  void nodePipeline.prewarmPostPasses({ signal, isCurrent }).catch((error) => {
    if (!startupPrewarmExpired) console.warn('post-pass prewarm failed', error);
  }).finally(() => {
    postPipelinesWarmPending = false;
  });
  // The conduit programs are linked during loading, never on the
  // first frame of a warp or a pulse.
  prewarmWarpConduitWithShipLights(isCurrent);
  // Warm sky sprites and star/Milky Way backdrop on all tiers so spool camera
  // turns never link SpriteMaterial or backdrop shaders mid-frame.
  void nodePipeline.prepare(() => {
    const skyObjects = [universe.nebulas, universe.backdropMesh, universe.nearStarsMesh].filter(Boolean);
    if (!skyObjects.length) return;
    const sunVis = sunShadow.visible, sunInt = sunShadow.intensity;
    sunShadow.visible = true;
    sunShadow.intensity = 0;
    try {
      return Promise.all(skyObjects.map((obj) => compileRenderVariant(renderer, obj, camera, scene, {
        layer: 0, target: nodePipeline.composer.readBuffer, shadowLight: sunShadow, signal,
      })));
    } finally {
      sunShadow.visible = sunVis;
      sunShadow.intensity = sunInt;
    }
  }, { signal, label: 'startup-sky', isCurrent }).catch((error) => {
    if (!startupPrewarmExpired) console.warn('sky prewarm failed', error);
  });

  if (QUALITY_LOW) return;
  if (!weaponPipelinesWarmed && !weaponPipelinesWarmPending && surfaceWeapons?.rig) {
    weaponPipelinesWarmPending = true;
    void nodePipeline.prepare(() => {
      const rigVis = surfaceWeapons.rig.visible;
      const lightVis = surfaceWeapons.lighting?.root?.visible;
      try {
        surfaceWeapons.rig.visible = true;
        if (surfaceWeapons.lighting?.root) surfaceWeapons.lighting.root.visible = true;
        // Seed the outdoor weapon PMREM probe during startup so entering walk
        // mode on an atmospheric planet never blocks ~600 ms on PMREMGGXConvolution.
        surfaceWeapons.updateLighting(sceneRadiance,
          { day: 1, atmosphere: 1, skyIrradiance: 0.5, sunset: 0 }, new THREE.Vector3(0, 1, 0));
        surfaceWeapons.prepareLighting();
        surfaceWeapons.updateLighting(sceneRadiance, environmentState, new THREE.Vector3(0, 1, 0));
        return compileRenderVariant(renderer, surfaceWeapons.rig, camera, scene, {
          layer: WEAPON_FOREGROUND_LAYER, target: nodePipeline.composer.readBuffer, signal,
        });
      } finally {
        surfaceWeapons.rig.visible = rigVis;
        if (surfaceWeapons.lighting?.root && lightVis !== undefined) surfaceWeapons.lighting.root.visible = lightVis;
      }
    }, { signal, label: 'startup-weapons', isCurrent }).then(() => {
      if (!startupPrewarmExpired) weaponPipelinesWarmed = true;
    }).catch((error) => {
      if (!startupPrewarmExpired) console.warn('weapon prewarm failed', error);
    }).finally(() => {
      weaponPipelinesWarmPending = false;
    });
  }

  // Kick off ANGLE background FXC compilation for all ship pass variants right
  // alongside surface/post/weapon shaders so ship compilation never sits idle
  // behind startup-surface; prewarmLoadedShipPipelines() still runs its live
  // resource/readiness sequence afterwards, hitting warm cached programs.
  if (ship.heroLoaded && !shipPipelinesWarmed && !shipPipelineWarmPending) {
    const shipVariants = [
      [SHIP_FOREGROUND_LAYER, 'readBuffer'],
      ...(RENDER_LOOK_NEXT ? [[SHIP_INTERIOR_LAYER, 'readBuffer']] : []),
      [0, 'writeBuffer'],
      ...(RENDER_LOOK_NEXT ? [[SHIP_INTERIOR_LAYER, 'writeBuffer']] : []),
    ];
    for (const [layer, buffer] of shipVariants) {
      void nodePipeline.prepare(() => {
        configureShipForegroundLightingLayers();
        const foreground = ship.foregroundOnly, sunVisible = sunShadow.visible;
        try {
          if (layer === 0) { ship.setForegroundOnly(false); sunShadow.visible = true; }
          return compileRenderVariant(renderer, ship.group, camera, scene, {
            layer, target: nodePipeline.composer[buffer], shadowLight: layer === 0 ? sunShadow : null, signal,
          });
        } finally {
          ship.setForegroundOnly(foreground);
          sunShadow.visible = sunVisible;
        }
      }, { signal, label: 'startup-ship-parallel', isCurrent }).catch(() => {});
    }
  }
}

function prewarmWarpConduitWithShipLights(isCurrent = () => !startupPrewarmExpired) {
  if (startupPrewarmExpired) return;
  const signal = startupCompile.signal;
  void nodePipeline.prepare(() => {
    configureShipForegroundLightingLayers();
    const group = warpConduit.group;
    const visible = [group.visible, ...group.children.map((child) => child.visible)];
    const conduitCamera = camera.clone();
    conduitCamera.layers.set(SHIP_FOREGROUND_LAYER);
    group.visible = true;
    for (const child of group.children) child.visible = true;
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    try {
      renderer.setRenderTarget(nodePipeline.composer.readBuffer);
      const foreground = compilePrograms(renderer, group, conduitCamera, scene, { signal });
      if (!warpConduit.lowVolume) return foreground;
      renderer.setRenderTarget(warpConduit.fogTarget);
      return Promise.all([foreground, compilePrograms(renderer, warpConduit.lowVolume, conduitCamera, null, { signal })]);
    } finally {
      renderer.setRenderTarget(target, face, mip);
      group.visible = visible[0];
      group.children.forEach((child, i) => { child.visible = visible[i + 1]; });
    }
  }, { signal, label: 'warp-conduit', isCurrent }).catch((error) => {
    if (!startupPrewarmExpired) console.warn('warp conduit prewarm failed', error);
  });
}

function configureShipForegroundLightingLayers() {
  if (!RENDER_LOOK_NEXT) {
    for (const light of [ambient, hemi, headlamp, sunShadow]) {
      light.layers.enable(SHIP_FOREGROUND_LAYER);
    }
    for (const view of universe.system?.starViews || []) {
      view.light.layers.enable(SHIP_FOREGROUND_LAYER);
    }
    for (const view of universe.fadingSystem?.starViews || []) {
      view.light.layers.enable(SHIP_FOREGROUND_LAYER);
    }
    return;
  }
  // The ship owns a calibrated two-star exterior rig. Keeping world ambient,
  // terrain shadow lights or star points on its pass double-lights the hull
  // and, more importantly, makes those shadowless sources flood the cabin.
  for (const light of [ambient, hemi, headlamp]) {
    light.layers.enable(SHIP_FOREGROUND_LAYER);
    light.layers.disable(SHIP_INTERIOR_LAYER);
  }
  sunShadow.layers.disable(SHIP_FOREGROUND_LAYER);
  sunShadow.layers.disable(SHIP_INTERIOR_LAYER);
  for (const view of universe.system?.starViews || []) {
    view.light.layers.disable(SHIP_FOREGROUND_LAYER);
    view.light.layers.disable(SHIP_INTERIOR_LAYER);
  }
  for (const view of universe.fadingSystem?.starViews || []) {
    view.light.layers.disable(SHIP_FOREGROUND_LAYER);
    view.light.layers.disable(SHIP_INTERIOR_LAYER);
  }
}

// ---- renderer-specific post chain -------------------------------------------
// Clouds: the lite shell march is the default renderer. ?clouds=legacy brings
// back the retired production stack for comparison; ?vclouds=0 disables both.
const CLOUDS_ENABLED = qs.get('vclouds') !== '0';
const VOLUME_ENABLED = CLOUDS_ENABLED && qs.get('clouds') === 'legacy';
const LITE_CLOUDS = CLOUDS_ENABLED && !VOLUME_ENABLED;
const VOLUME_SCALE = QUALITY_PROFILE.volumeScale;
// Start at the actual orbital pixel budget. Constructing the pipeline at the
// generic 0.75 Ultra scale and shrinking it on the first live frame allocated
// two complete volume target sets during the cold-start shader storm.
const initialVolumePixels = Math.max(1,
  window.innerWidth * renderDpr * window.innerHeight * renderDpr);
const INITIAL_VOLUME_SCALE = Math.min(
  VOLUME_SCALE,
  0.46,
  Math.sqrt(1150000 / initialVolumePixels),
);
let effectiveVolumeScale = INITIAL_VOLUME_SCALE;
const PROFILE_CLOUD_STEPS = QUALITY_PROFILE.cloudSteps;
let effectiveCloudSteps = PROFILE_CLOUD_STEPS;
let effectiveCloudLightSteps = PROFILE_CLOUD_STEPS >= 44 ? 5
  : PROFILE_CLOUD_STEPS >= 30 ? 3 : 2;
let effectiveAtmosphereSteps = 20;
let localVolumeBudgetKey = '';
let effectiveWaterReflectionHz = QUALITY_PROFILE.waterReflectionHz;
let effectiveShadowDistance = QUALITY_PROFILE.shadowDistance;
setVolumetricCloudsEnabled(VOLUME_ENABLED, {
  quality: QUALITY_PROFILE.id,
  steps: PROFILE_CLOUD_STEPS,
});
const cloudResourceManager = configureCloudResourceManager({
  renderer,
  enabled: VOLUME_ENABLED,
  maxEntries: 2,
});
const CLOUD_FAR_SPLIT = qs.get('cloudsplit') !== '0';
const CLOUD_PROGRAM_PREP = qs.get('cloudprograms') !== '0';
const CLOUD_LIGHT_BATCHES = qs.get('cloudbatches') !== '0';
const TEMPORAL_AA_INITIAL = qs.get('taa') === '1';
const TEMPORAL_AA_DEBUG = qs.get('taadebug') || 'off';
const MAIN_PIPELINE_OPTIONS = Object.freeze({
  volume: VOLUME_ENABLED,
  liteClouds: LITE_CLOUDS,
  liteCloudOptions: QUALITY_PROFILE.liteClouds,
  cloudProgramPreparation: CLOUD_PROGRAM_PREP,
  cloudFarSplit: CLOUD_FAR_SPLIT,
  volumeScale: effectiveVolumeScale,
  bloomEnabled: qs.get('post') !== '0' && !QUALITY_LOW,
  bloomStrength: RENDER_LOOK_NEXT ? (IS_TOUCH ? 0.24 : 0.30) : (IS_TOUCH ? 0.35 : 0.5),
  bloomRadius: RENDER_LOOK_NEXT ? 0.22 : 0.4,
  bloomThreshold: RENDER_LOOK_NEXT ? 1.15 : 1.05,
  foregroundLayer: SHIP_FOREGROUND_LAYER,
  interiorLayer: RENDER_LOOK_NEXT ? SHIP_INTERIOR_LAYER : null,
  realisticGrade: RENDER_LOOK_NEXT,
  temporalAA: TEMPORAL_AA_INITIAL,
});
const nodePipeline = new GameLegacyPipeline(renderer, scene, camera, MAIN_PIPELINE_OPTIONS);
if (TEMPORAL_AA_DEBUG !== 'off') nodePipeline.temporalAA?.setDebugMode(TEMPORAL_AA_DEBUG);
const volumePass = nodePipeline.volumePass;
if (volumePass && CLOUD_LIGHT_BATCHES) {
  volumePass.setLightBatchesEnabled(true, {
    budgetBytes: 32 * 1024 * 1024,
    maxBatchTiles: 128,
    fusedDensity: false,
  });
}
const atmospherePass = nodePipeline.atmospherePass;
atmospherePass.setVisualEnabled(qs.get('atmosphere') !== '0');
const warpDrivePass = nodePipeline.warp;
const foregroundPass = nodePipeline.foregroundPass;
const parkedInteriorPass = nodePipeline.parkedInteriorPass;
const bloomPass = nodePipeline.bloom;
const gradePass_ = nodePipeline.grade;
let usePost = !QUALITY_LOW && (bloomPass.enabled || VOLUME_ENABLED);
let riftPortal = null;
let portalView = null;
let warpConduit = null;
let pipelineResizePending = false;
function pipelineResourcesBusy() {
  return shipPipelineWarmPending || postPipelinesWarmPending || weaponPipelinesWarmPending
    || heroTransitionActive || !surfacePipelinesReady;
}
function sizePost(force = false) {
  if (!force && pipelineResourcesBusy()) {
    pipelineResizePending = true;
    return false;
  }
  nodePipeline.setSize(window.innerWidth, window.innerHeight, renderDpr);
  setStarflowViewport(window.innerWidth * renderDpr, window.innerHeight * renderDpr);
  portalView?.setSize(window.innerWidth, window.innerHeight, renderDpr);
  warpConduit?.setSize(window.innerWidth * renderDpr, window.innerHeight * renderDpr, renderDpr);
  pipelineResizePending = false;
  return true;
}

sizePost(true);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizePost();
  portalView?.setSize(window.innerWidth, window.innerHeight, renderDpr);
  warpConduit?.setSize(window.innerWidth * renderDpr, window.innerHeight * renderDpr, renderDpr);
  updateStarProj();
});

function setRenderDpr(next) {
  // The hero ship is a high-frequency foreground asset; dropping below the
  // display's normal desktop scaling makes its wing silhouette visibly stair-
  // stepped even with post AA. Low quality remains an explicit opt-in.
  const qualityFloor = QUALITY_PROFILE.dprMin;
  const qualityCeiling = Math.max(qualityFloor, MAX_DPR);
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
let loadingCleared = false;
// Displayed loading bar progress (0..1). Only moves forward — driven by
// discrete startup milestones in tickLoading so the bar reflects real
// pipeline readiness instead of an infinite CSS sweep.
let loadingProgress = 0;
let paused = false;
let pointerLockRequest = null;
let timeWarp = null;
let photoMode = false;
let boostVisual = 0;
let pulseVisual = 0;
const PULSE_FUEL_MAX = 140;
const PULSE_FUEL_COST = 18;
let pulseFuel = PULSE_FUEL_MAX;
let pulseActive = false;
// The newest pulse owns the displacement; earlier pulses that were chained
// after their jump keep finishing their release visuals as echoes.
let pulseBurst = null;
const pulseEchoes = [];
let pulseRechargeDelay = 0;
// One transit timeline (pulse and/or warp) drives starflow, the transit pass,
// FOV, the camera kick and the hull light. See transit.js.
const transitChannels = emptyTransitChannels();
let transitFlow = 0;
let warpTransit = null;
let transitHold = null; // NMS.holdTransit visual lab
const transitAxisWorld = new THREE.Vector3(0, 0, -1);
const transitAxisView = new THREE.Vector3(0, 0, -1);
const transitAxisTarget = new THREE.Vector3(0, 0, -1);
const transitColorA = new THREE.Color(1, 0.92, 0.82);
const transitColorB = new THREE.Color(0.75, 0.85, 1);
const transitHullLight = new THREE.PointLight(0xbcd4ff, 0, 0, 0);
transitHullLight.layers.set(SHIP_FOREGROUND_LAYER);
scene.add(transitHullLight);
const transitHullAmbient = new THREE.HemisphereLight(0x5f86ff, 0x1a2a66, 0);
transitHullAmbient.layers.set(SHIP_FOREGROUND_LAYER);
scene.add(transitHullAmbient);
let weaponCooldown = 0;
let flightPower = {
  weapon: 1, navigation: 1, thermal: 1, gravity: 1, shield: 1, warp: 0,
};
let weaponVisual = 0;
let activeBolts = 0;
let starMap = null;
let pendingRoute = null;
let warpPreparedSystem = null;
let transferredPreparedDestination = null;
let warpPreparationToken = 0;
let warpCompile = new AbortController();
let warpPreparedWaterWarmState = 'idle';
let warpPreparedWaterWarmPlanet = null;
let warpPreparedWaterWarmMesh = null;
let warpPreparedWaterWarmError = null;
let warpPreparedLodWarmState = 'idle';
let warpPreparedLodWarmPlanet = null;
let warpPreparedLodWarmError = null;
let warpPreparedRiftStructureState = 'idle';
let warpPreparedRiftStructurePromise = null;
let warpPreparedRiftWarmState = 'idle';
let warpPreparedRiftWarmError = null;
let warpRevealBody = null;
let warpRevealCameraOffset = null;
let warpRevealActive = false;
let systemBuildResumeAt = 0;
let deferredSystemBuildActive = false;
let deferredWorldPublication = null;
let lastWorldPublicationSnapshot = null;
const deferredSystemWarmQueue = [];
let riftRoute = null;
let riftPreviewSystem = null;
let retiredRiftSystem = null;
let riftPreviewReady = false;
const PLANET_ARRIVAL_FACTOR = 1.68;
const INITIAL_ORBIT_FACTOR = 1.72;
// Full-page hero framing. The old 1.3R/0.72rad limb close-up yaws the planet
// almost entirely out of frame (angular radius 50° vs 41° yaw), leaving a
// dark sliver on the WebGL baseline — it read as a black start page. Frame
// like the standard orbit instead: planet owns the right two thirds at full
// brightness, menu owns the left.
const HERO_CLOSE_FACTOR = 1.72;
const HERO_PULLBACK_SECONDS = 2.8;
// Start-page framing: keep the planet's disc centred ~18° right of view so
// the lit side stays clearly visible while the menu owns the left column.
const HERO_YAW = 0.32;
const riftEntranceUniv = new THREE.Vector3();
const riftTargetUniv = new THREE.Vector3();
const riftPreviewOriginUniv = new THREE.Vector3();
const riftOrientation = new THREE.Quaternion();
const riftAssistQuat = new THREE.Quaternion();
let dialAcc = 0;
// Snow coverage at the player's current foot position, refreshed by the walk
// dial pass (~7 Hz). Consumed by the music director to switch to the alpine
// theme on habitable snowfields.
let currentWalkSnowWeight = 0;
function walkWeatherFor(planet, localUp, sunLocal) {
  if (!planet) return 'clear';
  const terrainHeight = planet.height(localUp, 64);
  const direction = planet.worldOffsetToLocal?.(localUp, new THREE.Vector3()).normalize()
    || localUp;
  const weather = planet.weatherAt?.(direction);
  if (weather) {
    if (weather.kind === 'storm') return 'storm';
    if (weather.precipitationKind === 'snow' && weather.precipitation > 0.14) return 'snow';
    if (weather.precipitationKind === 'rain' && weather.precipitation > 0.14) return 'rain';
    if (weather.kind === 'stratus' && weather.visibility < 0.62) return 'rain';
    return 'clear';
  }
  if (planet.type === 'ice' || planet.snowWeightAt?.(localUp, terrainHeight) > 0.32) return 'snow';
  return 'clear';
}

// ---- world ------------------------------------------------------------------
const fixedTime = qs.has('time') ? Number(qs.get('time')) : null;
let celestialClock = new CelestialClock(SEED, {
  initialHours: Number.isFinite(fixedTime) ? fixedTime : null,
  persist: !Number.isFinite(fixedTime),
  frozen: FREEZE,
});
let universe = createUniverse(SEED, { deferSecondaryHomeBodies: true });
universe.timeHours = celestialClock.hours;
universe.system.updateCelestial(celestialClock.hours);
const sceneRadiance = new SceneRadianceState(renderer, scene, universe, {
  enabled: RENDER_LOOK_NEXT,
  probeResolution: QUALITY_PROFILE.reflectionProbeResolution,
});
const sceneBuildBudget=new FrameWorkBudget();
const PLANT_STREAM_FLOOR_MS = 0.6;
const scatter = new Scatter({
  grassRadius: QUALITY_PROFILE.grassRadius,
  grassDensity: QUALITY_PROFILE.grassDensity,
  streamBudgetMs: QUALITY_LOW ? 1.15 : 1.8,
});
// far tier: proxy trees to the horizon (?farflora=0 spares SwiftShader tests)
const FARFLORA = qs.get('farflora') !== '0';
const farFlora = new FarFlora({
  density: QUALITY_PROFILE.treeDensity,
  streamBudgetMs: QUALITY_LOW ? 0.85 : 1.25,
});
const skyDome = new SkyDome(scene);
const weatherEffects = new WeatherEffects(scene);
// ?rain=0..1 forces surface rain intensity (captures and rain tuning).
const RAIN_OVERRIDE = qs.has('rain') ? THREE.MathUtils.clamp(Number(qs.get('rain')) || 0, 0, 1) : null;
const rainFrame = {
  dt: 0, camera, renderer, origin: new THREE.Vector3(), displacement: new THREE.Vector3(),
  sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(), ambient: new THREE.Color(),
  groundSampler: null,
};
const RAIN_GAIN = qs.has('rainGain') ? Number(qs.get('rainGain')) || 1 : 1;
const _rainAmbFallback = new THREE.Color(0.4, 0.45, 0.5);
const rainPrevLocal = new THREE.Vector3();
const _rainA = new THREE.Vector3(), _rainB = new THREE.Vector3(), _rainC = new THREE.Vector3();
let rainPrevBody = null;
let rainBody = null;
// Terrain height under a 7x7 grid around the walker, as local y relative to
// the eye, in the rain's tangent frame. Drives splash placement and lets drops
// stop at the ground instead of falling through it.
function sampleRainGround(side, up, forward, out, span, grid) {
  const p = rainBody;
  if (!p?.height || !p.worldOffsetToLocal) return false;
  const pos = walkCtl.posLocal, r0 = pos.length();
  p.worldOffsetToLocal(side, _rainA);
  p.worldOffsetToLocal(forward, _rainB);
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const x = (i / (grid - 1) * 2 - 1) * span, z = (j / (grid - 1) * 2 - 1) * span;
      _rainC.copy(pos).addScaledVector(_rainA, x).addScaledVector(_rainB, z).normalize();
      out[j * grid + i] = p.R + p.height(_rainC, p.fullMaxFreq) - r0;
    }
  }
  return true;
}
function prepareRainFrame(dt, body) {
  rainFrame.dt = dt;
  camera.getWorldPosition(rainFrame.origin);
  rainFrame.displacement.set(0, 0, 0);
  const walking = state === 'walk' && walkCtl.planet === body;
  if (walking) {
    // Walking moves the world past the camera; feed that displacement to the
    // rain so its field stays fixed in the world.
    if (rainPrevBody === body) {
      _rainA.copy(walkCtl.posLocal).sub(rainPrevLocal);
      if (_rainA.lengthSq() < 400) body.localOffsetToWorld(_rainA, rainFrame.displacement);
    }
    rainPrevLocal.copy(walkCtl.posLocal);
    rainPrevBody = body;
    rainBody = body;
    rainFrame.groundSampler = sampleRainGround;
  } else {
    rainPrevBody = null;
    rainFrame.groundSampler = null;
  }
  rainFrame.sunDir.copy(body?.sunDirWorld || _up);
  // Saltline lit its rain with a dusk harbour (ambient = fog x 0.15). Our
  // open daylight scenes are far brighter, so the drops take their ambient
  // from the live fog/sky colour at a higher gain to stay legible.
  const sunUp = THREE.MathUtils.clamp(rainFrame.sunDir.dot(_up) * 4 + 0.3, 0, 1);
  rainFrame.sunColor.setRGB(1, 0.93, 0.82).multiplyScalar(RAIN_GAIN * 5 * envDay * sunUp);
  rainFrame.ambient.copy(scene.fog?.color || _rainAmbFallback).multiplyScalar(RAIN_GAIN * 1.4)
    .addScalar(RAIN_GAIN * 0.03);
  return rainFrame;
}
const [shipModel, shipProbes] = await Promise.all([loadShipModel(), loadShipProbes(renderer)]);
const ship = new Ship(scene, {
  model: shipModel,
  probes: shipProbes,
  anisotropy: Math.min(16, renderer.getMaxAnisotropy?.()
    ?? renderer.capabilities?.getMaxAnisotropy?.()
    ?? 1),
  renderer,
  radiance: sceneRadiance,
});
const shipView = new ShipView(ship, camera);
shipView.onHint = (text) => { if (!paused && !starMap?.isOpen) ui.setHint(text, true); };
shipView.onStep = () => audio.cabinStep();
const skydiveCtl = new SkydiveController(renderer.domElement, scene, {
  onDeploy: () => {
    audio.cue('chute-open');
    if (IS_TOUCH) ui.els.btnJump.classList.add('hidden');
  },
  onLoad: () => audio.cue('chute-load'),
  onAadWarning: () => audio.cue('aad-warn'),
  onLand: ({ planet, posLocal, viewDir, carryHoriz, water }) => {
    audio.cue(water ? 'water-splash' : 'chute-land');
    walkCtl.enter(planet, posLocal, viewDir);
    walkCtl.hSpeed.copy(carryHoriz);
    walkCtl.grounded = !water;
    planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);
    setState('walk');
  },
});
riftPortal = new SpacePortal(createPortalProfile({
  shape: 'plane',
  harmonics: [
    { k: 2, amp: .095, phase: 1.49, speed: .018 },
    { k: 3, amp: .042, phase: .63, speed: -.085 },
    { k: 5, amp: .032, phase: 2.30, speed: .12 },
    { k: 9, amp: .024, phase: 4.10, speed: -.30 },
  ],
  halfWidth: 506,
  halfHeight: 308,
  openSeconds: 1.15,
  closeSeconds: 1.1,
  seamFraction: 0.26,
}));
// The warp conduit is real geometry on the ship's foreground layer: drawn
// after the world and its post effects, depth-tested against the hull.
warpConduit = new WarpConduit({ radius: 220, layer: SHIP_FOREGROUND_LAYER, quality: QUALITY_LOW ? 'low' : 'medium' });
scene.add(warpConduit.group);
warpConduit.setSize(window.innerWidth * renderDpr, window.innerHeight * renderDpr, renderDpr);
portalView = new PortalView({
  mainCamera: camera,
  // Full resolution: at the crossing the two views trade their cloud
  // reconstruction buffers, which only works when both are the same size.
  resolutionScale: 1,
  createPipeline: (viewCamera) => {
    // Same production chain and quality as the main view; the legacy volume
    // stack is never the far side's owner.
    const pipeline = new GameLegacyPipeline(renderer, scene, viewCamera,
      { ...MAIN_PIPELINE_OPTIONS, volume: false, temporalAA: false });
    if (pipeline.cloudPass && nodePipeline.cloudPass) pipeline.cloudPass.setQuality({ scale: nodePipeline.cloudPass.scale });
    return pipeline;
  },
});
portalView.setSize(window.innerWidth, window.innerHeight, renderDpr);
const weapons = new ShipWeapons(scene);
const audio = new FlightAudio();
const shipAudio = new ShipAudio(audio);
const music = new BackgroundMusic();
// Unlock the shared AudioContext on first user gesture, then bind the music
// bus to the same context (avoids opening a second AudioContext per tab).
function unlockAudio() {
  audio.unlock();
  if (audio.ctx && !music.ready) music.attach(audio.ctx);
}
const surfaceWeaponHud = document.getElementById('surface-weapon');
const surfaceWeapons = new SurfaceWeapons(scene, camera, renderer.domElement, {
  canUse: () => state === 'walk' && !paused && !starMap?.isOpen
    && (document.pointerLockElement === renderer.domElement || window.NMS_NOLOCK),
  onChange: ({ index, weapon, ammo, reloading, holstered }) => {
    if (!surfaceWeaponHud) return;
    surfaceWeaponHud.querySelector('[data-weapon-name]').textContent = weapon.name;
    const ammoReadout = surfaceWeaponHud.querySelector('[data-weapon-ammo]');
    ammoReadout.textContent = `${ammo} / ${weapon.magSize}`;
    ammoReadout.dataset.state = holstered ? 'HOLSTERED' : reloading ? 'RELOADING' : 'READY';
    surfaceWeaponHud.dataset.activeSlot = String(index + 1).padStart(2, '0');
    surfaceWeaponHud.classList.toggle('reloading', reloading);
    surfaceWeaponHud.classList.toggle('holstered', !!holstered);
    for (const item of surfaceWeaponHud.querySelectorAll('[data-weapon-slot]')) item.classList.toggle('active', Number(item.dataset.weaponSlot) === index);
  },
  // gunshot, reload foley and dry click are Saltline + Golden Hour synthesized sounds
  onEvent: (type, data, def) => audio.weaponEvent(type, data, def),
  renderer,
});
// HALCYON survey units (Saltline's robot dog and drone, patrol-only) share the
// weapon's Saltline material library; prewarmed in idle time (below).
const surveyUnits = new SurveyUnits({
  scene,
  materials: surfaceWeapons.materials,
  getSfx: () => (audio.ready ? audio.sfx : null),
  getEnvironment: () => ({
    texture: surfaceWeapons.lighting.environmentTexture,
    intensity: surfaceWeapons.lighting.reflectionScale ?? 1,
  }),
});
const surfaceGameplay = new SurfaceGameplay({
  scene,
  camera,
  materials: surfaceWeapons.materials,
  getAudio: () => audio,
  getEnvironment: () => ({
    texture: surfaceWeapons.lighting.environmentTexture,
    intensity: surfaceWeapons.lighting.reflectionScale ?? 1,
  }),
  grenadeFactory: () => buildFragGrenade(),
});
surfaceWeapons.shotResolver = (eye, dir, def) => surfaceGameplay.resolveShot(eye, dir, {
  planet: walkCtl.planet || nearest,
  navPos: nav.pos,
  surveyUnits,
  damage: def?.damage ?? 28,
  impulse: def?.impulse ?? 6,
  maxRange: 180,
});
surfaceWeapons.onGrenade = () => surfaceGameplay.throwGrenade({
  planet: walkCtl.planet || nearest,
  navPos: nav.pos,
  eyeWorld: camera.getWorldPosition(new THREE.Vector3()),
  dirWorld: camera.getWorldDirection(new THREE.Vector3()),
  playerVelLocal: walkCtl.hSpeed,
});
// Build the robots in idle time after startup on hardware GPUs so the first
// landing does not stall; software rasterizers (SwiftShader CI) skip eager
// background bakes and build lazily on deploy().
if (!isSoftwareWebGL(renderer)) {
  const scheduleSurveyPrewarm = (delayMs = 8000) => {
    setTimeout(() => {
      if (surveyUnits.fleet || surveyUnits.prewarming) return;
      const busy = () => !loadingCleared || paused || starMap?.isOpen || pendingRoute
        || state !== 'space' || transitHoldsQuality() || deferredSystemBuildActive;
      if (busy()) {
        scheduleSurveyPrewarm(2500);
        return;
      }
      const run = () => {
        if (busy()) {
          scheduleSurveyPrewarm(2500);
          return;
        }
        void surveyUnits.prewarm({
          renderer,
          camera,
          scene,
          target: nodePipeline.composer?.readBuffer || null,
          prepare: (work) => nodePipeline.prepare(work, {
            label: 'survey-robots',
            isCurrent: () => !busy(),
          }),
        });
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 }); else run();
    }, delayMs);
  };
  scheduleSurveyPrewarm(8000);
}
// Hands and optics sit closer than the world camera's 0.12 m near plane, so
// the weapon layer renders through the rig's own view camera.
foregroundPass.setLayerCamera(WEAPON_FOREGROUND_LAYER, surfaceWeapons.viewCamera);
let warpIntensity = 0;
let envInAtmo = 0;       // exported by the ambience pass for audio/effects
let envDay = 1;
let activeWeather = null;
let envUnderwater = false;
let underwaterPlanetKey = null;
let devHeadlampEnabled = true;
const environmentState = createEnvironmentState();
const prevNavPos = new THREE.Vector3();
const _velActual = new THREE.Vector3();

// ---- temps ------------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _shipUp = new THREE.Vector3();
const _shipFwd = new THREE.Vector3();
const _shipRight = new THREE.Vector3();
const _ex4 = new THREE.Vector4();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
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
let skyOvercast = 0;
let sunShaftDebug = { reason: 'not-updated', strength: 0 };
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
function addTween(dur, fn, onDone, { realTime = false, timeLimit = null } = {}) {
  tweens.push({
    t: 0,
    dur,
    fn,
    onDone,
    realTime,
    timeLimit,
    startedAt: realTime ? performance.now() : 0,
  });
}
function stepTweens(dt) {
  const now = performance.now();
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t = tw.realTime ? (now - tw.startedAt) / 1000 : tw.t + dt;
    if (tw.timeLimit) tw.t = Math.min(tw.t, tw.timeLimit());
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
const touchPickRaycaster = new THREE.Raycaster();
const touchPickNdc = new THREE.Vector2();
const touchPickSphere = new THREE.Sphere();

function touchPickPlanet(clientX, clientY) {
  if (state !== 'space' || paused || !universe?.system) return false;
  const rect = renderer.domElement.getBoundingClientRect();
  touchPickNdc.set(
    ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
  );
  camera.updateMatrixWorld(true);
  touchPickRaycaster.setFromCamera(touchPickNdc, camera);
  let target = null;
  let nearestHit = Infinity;
  for (const planet of universe.system.planets) {
    // Camera-relative rendering keeps each planet group's translation in the
    // same coordinate space as the camera ray. An analytic sphere avoids
    // raycasting thousands of procedural LOD triangles on a touch tap.
    touchPickSphere.center.copy(planet.group.position);
    touchPickSphere.radius = planet.R + Math.max(planet.hAmp || 0,
      planet.atmoHeight || 0, planet.cloudAlt || 0);
    const hit = touchPickRaycaster.ray.intersectSphere(touchPickSphere, _v);
    if (!hit) continue;
    const distance = hit.distanceTo(touchPickRaycaster.ray.origin);
    if (distance < nearestHit) {
      nearestHit = distance;
      target = planet;
    }
  }
  window.__lastClick = {
    x: clientX, y: clientY,
    bodyId: target?.bodyId || null,
    distance: Number.isFinite(nearestHit) ? nearestHit : null,
  };
  if (!target) return false;
  focusPlanet = target;
  spaceCtl.focus = target;
  flyToPlanet(target);
  return true;
}

const spaceCtl = new SpaceControls(renderer.domElement, nav, {
  onClick: (x, y) => touchPickPlanet(x, y),
});
spaceCtl.canSteer = () => !shipView.rmbLookActive();
spaceCtl.canMouseBoost = () => !shipView.rmbLookActive();
const walkCtl = new WalkControls(renderer.domElement, {
  lookScale: () => surfaceWeapons.lookScale,
  onLook: (movementX, movementY) => surfaceWeapons.onLookDelta(movementX, movementY),
  resolveCollision: (ctl, prev) => {
    resolveParkedShipCollision(ctl, prev);
    surfaceGameplay.resolveWalkCollision(ctl);
  },
  onStep: (info) => surfaceGameplay.onWalkStep({ ...info, planet: walkCtl.planet }),
  onJump: () => surfaceGameplay.onWalkJump(),
  onLand: (impact01) => surfaceGameplay.onWalkLand(impact01),
  onSlide: (phase) => surfaceGameplay.onWalkSlide(phase),
});

// Abort any pulse: finish its remaining displacement visuals as an echo, but
// never move the ship again (landing, rifts and pressure protection call this).
function cancelPulseBurst() {
  if (!pulseBurst) return;
  if (pulseBurst.charging) audio.pulseCharge?.(-1);
  pulseActive = false;
  if (pulseBurst.elapsed > PULSE_TIMING.jumpStart) pulseEchoes.push(pulseBurst);
  pulseBurst = null;
}

// Space press. A tap folds the base reach; holding parks the fold just
// before the jump and charges it (see transit.js), released in
// releasePulseCharge(). Debug/test callers pass hold=false for a plain tap.
function triggerPulse({ hold = false } = {}) {
  if (state !== 'space' || paused || riftRoute) return false;
  // Chaining is allowed once the previous jump has landed; its release keeps
  // playing as an echo so the new charge picks up from the current visuals.
  if (pulseBurst && pulseBurst.elapsed < PULSE_TIMING.retrigger) return false;
  if (!DEV_INFINITE_PULSE && pulseFuel + 1e-6 < PULSE_FUEL_COST) {
    ui.setHint(`脉冲燃料不足 · 需要 ${PULSE_FUEL_COST}`, false);
    return false;
  }
  if (pulseBurst) pulseEchoes.push(pulseBurst);
  pulseBurst = {
    elapsed: 0, progress: 0,
    direction: new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quat).normalize(),
    distance: pulseBurstDistance(spaceCtl.speedScale, nearestAlt, !!nearest),
    charging: hold, holdTime: 0, charge: 0, power: 1,
  };
  pulseActive = true;
  pulseRechargeDelay = DEV_INFINITE_PULSE ? 0 : 1.4 / Math.max(.1, flightPower.thermal);
  audio.pulseCharge?.(0);
  if (!hold) releasePulseCharge();
  return true;
}

// The most charge the remaining fuel can pay for.
function affordablePulseCharge() {
  if (DEV_INFINITE_PULSE) return 1;
  const scale = pulseFuel / PULSE_FUEL_COST;
  return clamp((scale - 1) / 1.5, 0, 1);
}

function releasePulseCharge() {
  const burst = pulseBurst;
  if (!burst || !burst.charging && burst.released) return;
  const charge = burst.charging ? Math.min(pulseChargeFromHold(burst.holdTime), affordablePulseCharge()) : 0;
  const scaling = pulseChargeScaling(charge);
  burst.charging = false;
  burst.released = true;
  burst.charge = charge;
  burst.power = scaling.power;
  // The fold goes where the nose points at release, as far as the charge reaches.
  burst.direction.set(0, 0, -1).applyQuaternion(nav.quat).normalize();
  burst.distance = pulseBurstDistance(spaceCtl.speedScale, nearestAlt, !!nearest) * scaling.distance;
  if (nearest && Number.isFinite(nearestAlt)) {
    // A charged fold never carries the ship deeper than a third of its
    // altitude toward terrain; the swept clearance probe handles the rest.
    const toward = Math.max(0, -burst.direction.dot(_v.copy(nav.pos).sub(nearest.posUniv).normalize()));
    if (toward > 0.05) burst.distance = Math.min(burst.distance, Math.max(80, nearestAlt * 0.33 / toward + 100));
  }
  if (DEV_INFINITE_PULSE) {
    pulseFuel = PULSE_FUEL_MAX;
    pulseRechargeDelay = 0;
  } else {
    pulseFuel = Math.max(0, pulseFuel - PULSE_FUEL_COST * scaling.fuel);
    pulseRechargeDelay = 1.4 / Math.max(.1, flightPower.thermal);
  }
  audio.pulseCharge?.(-1);
  audio.cue('pulse', { power: scaling.power });
}

const TRANSIT_REST = Object.freeze(emptyTransitChannels());
const transitInverseView = new THREE.Quaternion();
const transitEndColor = new THREE.Color();
const TRANSIT_COOL = new THREE.Color(0.55, 0.7, 1.0);

// Sample the pulse and warp timelines into one set of channels.
function updateTransitChannels(dt) {
  Object.assign(transitChannels, TRANSIT_REST);
  // Any path that abandons a warp tween (new universe, debug teleports) also
  // abandons its timeline.
  if (warpTransit && state !== 'warp') warpTransit = null;
  // Fold visuals belong to flight; landing, walking or the cabin end them.
  if (state !== 'space' && state !== 'warp') {
    pulseEchoes.length = 0;
    if (pulseBurst) cancelPulseBurst();
  }
  if (transitHold) {
    if (transitHold.kind === 'pulse') pulseChannels(transitHold.t, transitChannels, transitHold.pulse);
    else warpChannels(transitHold.t, transitHold.plan, transitChannels);
    pulseVisual = 0;
    warpIntensity = 0;
    transitFlow += transitChannels.flowSpeed * dt;
    transitAxisWorld.set(0, 0, -1).applyQuaternion(nav.quat);
    return;
  }
  for (let i = pulseEchoes.length - 1; i >= 0; i--) {
    const echo = pulseEchoes[i];
    echo.elapsed += dt;
    if (echo.elapsed >= PULSE_TIMING.total) pulseEchoes.splice(i, 1);
    else pulseChannels(echo.elapsed, transitChannels, echo);
  }
  if (pulseBurst) pulseChannels(pulseBurst.elapsed, transitChannels, pulseBurst);
  pulseVisual = transitIntensity(transitChannels);
  if (warpTransit) warpChannels(warpTransit.t, warpTransit.plan, transitChannels);
  warpIntensity = warpTransit
    ? clamp(Math.max(transitChannels.warp, transitChannels.tunnel), 0, 1) : 0;
  transitFlow += transitChannels.flowSpeed * dt;
  if (warpTransit) transitAxisTarget.copy(warpTransit.dir);
  else if (pulseBurst) transitAxisTarget.copy(pulseBurst.direction);
  else if (pulseEchoes.length) transitAxisTarget.copy(pulseEchoes.at(-1).direction);
  else transitAxisTarget.set(0, 0, -1).applyQuaternion(nav.quat);
  // A chained pulse after a turn swings the vanishing point over instead of
  // jumping it; a warp follows its heading closely.
  const axisRate = warpTransit ? 18 : 10;
  transitAxisWorld.lerp(transitAxisTarget, 1 - Math.exp(-dt * axisRate)).normalize();
}

// Push the channels into starflow, the transit pass and the hull light. Runs
// after the camera pose is final for this frame.
const conduitFrame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
const CONDUIT_FORWARD = new THREE.Vector3(0, 0, -1);
const conduitBend = new THREE.Vector2();

function applyTransitVisuals(dt = 1 / 60) {
  const ch = transitChannels;
  // Near-field streaks and the conduit. A pulse uses the streaks alone.
  const k = warpConduit.scale;
  const peak = 4000 * k;
  let flow = ch.warp || 0;
  let speed = (ch.speed || 0) * peak;
  if (!warpTransit && !transitHold?.plan?.duration) {
    flow = Math.min(1, ch.streak * 0.85);
    speed = warpSpeedFraction(flow) * peak * 0.5;
  } else if (transitHold?.kind === 'pulse') {
    flow = Math.min(1, ch.streak * 0.85);
    speed = warpSpeedFraction(flow) * peak * 0.5;
  }
  const clock_ = clock.elapsedTime;
  conduitBend.set(Math.sin(clock_ * 0.13) * 0.12 + Math.sin(clock_ * 0.051 + 1.3) * 0.05,
    Math.cos(clock_ * 0.11 + 0.4) * 0.09 + Math.sin(clock_ * 0.037) * 0.04);
  conduitFrame.position.copy(camera.position);
  conduitFrame.quaternion.setFromUnitVectors(CONDUIT_FORWARD, transitAxisWorld);
  const conduit = warpConduit.update(dt, conduitFrame, {
    enter: ch.conduitEnter || 0,
    exit: ch.conduitExit || 0,
    warp: flow,
    speed,
    streak: Math.min(speed * 0.16 + flow * flow * 700 * k, 1100 * k),
    bend: conduitBend,
  });
  starflowUniforms.uSky.value = ch.sky ?? 1;
  transitInverseView.copy(camera.quaternion).invert();
  transitAxisView.copy(transitAxisWorld).applyQuaternion(transitInverseView).normalize();
  starflowUniforms.uFlowAxis.value.copy(transitAxisView);
  starflowUniforms.uStreak.value = ch.streak;
  starflowUniforms.uAberr.value = ch.aberr;
  starflowUniforms.uDoppler.value = ch.doppler;

  transitEndColor.copy(transitColorA).lerp(transitColorB, ch.colorMix);
  // Both lights stay in the scene permanently (intensity 0 at rest): toggling
  // visibility would change the light count and recompile every hull program
  // on the first frame of a pulse or warp.
  transitHullLight.intensity = 0;
  transitHullAmbient.intensity = 0;
  if (ch.hull > 0.002 && (state === 'space' || state === 'warp')) {
    // Key from the conduit's far throat ahead, fill from its walls; the
    // ribs pulse light across the hull as they rush past.
    const key = (0.1 + 0.9 * conduit.enclosure) * conduit.glow * Math.min(1, (ch.conduitEnter || 0) * 3);
    transitHullLight.position.copy(ship.group.position).addScaledVector(transitAxisWorld, 40);
    transitHullLight.color.copy(TRANSIT_COOL).lerp(transitEndColor, 0.4);
    transitHullLight.intensity = Math.max(ch.hull * 0.9, key * 2.6);
    transitHullAmbient.color.setRGB(0.16, 0.26, 0.52).lerp(transitEndColor, 0.15);
    transitHullAmbient.intensity = conduit.enclosure * (0.35 + 0.2 * conduit.ribPulse) * 1.4;
    if (ship.sun) ship.sun.intensity *= 1 - 0.85 * ch.tunnel;
    if (ship.secondarySun) ship.secondarySun.intensity *= 1 - 0.85 * ch.tunnel;
  } else if (riftRoute && riftPortal?.isVisible && state === 'space') {
    // The far side's starlight spills through the open fold onto the hull,
    // brightest as the ship slips through, so the hull is already lit by the
    // destination when it crosses.
    const where = riftPortal.locate(_v.copy(nav.pos));
    const reach = Math.max(riftPortal.halfWidth, riftPortal.halfHeight) * 2.2;
    const near = Math.max(0, 1 - Math.abs(where.z) / reach) * Math.max(0, 1 - Math.max(0, where.radial - 1) * 2);
    const spill = riftPortal.openness * (0.25 + 0.75 * near * near);
    transitHullLight.position.copy(riftPortal.source.position).sub(nav.pos);
    const discharge = riftPortal.open.flash + .32 * riftPortal.open.tension;
    transitHullLight.color.copy(riftSpill).lerp(TRANSIT_COOL, Math.min(1, .2 + discharge));
    transitHullLight.intensity = spill * 2.2 + discharge * 2.8;
    transitHullAmbient.color.copy(riftSpill);
    transitHullAmbient.intensity = spill * near * 0.35;
  }

  const active = ch.blur > 0.002 || ch.fold > 0.002 || ch.shockAmp > 0.002
    || ch.flash > 0.002 || ch.tunnel > 0.002 || ch.exit < 1e3;
  warpDrivePass.enabled = active;
  if (!active) return;
  const u = warpDrivePass.uniforms;
  const time = clock.elapsedTime;
  const tanHalf = Math.tan(camera.fov * Math.PI / 360);
  u.uTime.value = time;
  u.uAspect.value = camera.aspect;
  u.uTanHalfFov.value = tanHalf;
  u.uAxis.value.copy(transitAxisView);
  if (transitAxisView.z < -0.05) {
    u.uCenter.value.set(
      clamp(0.5 + 0.5 * (transitAxisView.x / -transitAxisView.z) / (tanHalf * camera.aspect), 0, 1),
      clamp(0.5 + 0.5 * (transitAxisView.y / -transitAxisView.z) / tanHalf, 0, 1));
  } else {
    u.uCenter.value.set(0.5, 0.5);
  }
  u.uBlur.value = ch.blur;
  u.uFold.value = ch.fold;
  u.uShockR.value = ch.shockRadius;
  u.uShockAmp.value = ch.shockAmp;
  u.uFlash.value = ch.flash;
  u.uTunnel.value = 0;
  u.uMouth.value = ch.mouth;
  u.uExit.value = 1e4;
  u.uFlow.value = transitFlow;
  u.uEndGlow.value = ch.endGlow;
  // The passage wanders, so the far end is always just around a bend. It
  // straightens at the mouth and at the exit, where the vanishing point must
  // line up with the real sky (and the destination) behind it.
  const bendScale = clamp(1 - ch.mouth / 40, 0, 1) * (ch.exit < 1e3 ? clamp(ch.exit / 70, 0, 1) : 1);
  u.uBend.value.set(
    Math.sin(time * 0.13) * 0.26 + Math.sin(time * 0.051 + 1.3) * 0.12,
    Math.cos(time * 0.11 + 0.4) * 0.2 + Math.sin(time * 0.037) * 0.1).multiplyScalar(bendScale);
  u.uTwist.value = 1;
  u.uColorA.value.copy(transitColorA);
  u.uColorB.value.copy(transitColorB);
  u.uColorMix.value = ch.colorMix;
}

renderer.domElement.addEventListener('pointerdown', () => {
  unlockAudio();
  if ((state === 'walk' || state === 'skydive' || state === 'shipwalk' || state === 'landed') && !document.pointerLockElement
    && !window.NMS_NOLOCK && pointerLockInput) {
    renderer.domElement.requestPointerLock();
  }
});

window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (e.code === 'KeyM' || e.code === 'Tab') {
    e.preventDefault();
    if (starMap?.isOpen) closeStarMap();
    else if (!paused && !['warp', 'landing', 'takeoff', 'flyto', 'skydive'].includes(state)) openStarMap();
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
  if (!e.repeat && e.code === 'KeyL') tryLand({ hover: e.shiftKey });
  if (!e.repeat && e.code === 'Space' && state === 'space') {
    e.preventDefault();
    triggerPulse({ hold: true });
  }
  if (!e.repeat && e.code === 'Space' && state === 'landed' && !paused) {
    e.preventDefault();
    if (shipView.seatT >= 1) launchParkedShip();
  }
  if (!e.repeat && e.code === 'Space' && state === 'skydive' && !paused) {
    e.preventDefault();
    skydiveCtl.deployParachute({ automatic: false });
  }
  if (!e.repeat && e.code === 'KeyV'
    && (state === 'space' || state === 'warp' || state === 'landed' || state === 'takeoff') && !paused) {
    shipView.toggleView({ scriptedHull: state === 'landed' || state === 'takeoff' });
    nodePipeline.invalidateTemporalHistory('ship-view-cut');
    ui.setCockpitView(shipView.isCockpit());
    if (state === 'space') ui.setHint(spaceControlHint(), false);
  }
  if (!e.repeat && e.code === 'KeyF' && !paused) {
    if (state === 'space' && shipView.isCockpit()) {
      shipView.standUp(nav, { landed: false });
      setState('shipwalk');
    } else if (state === 'landed' && shipView.seatT >= 1) {
      if (shipView.standUp(nav, { landed: true })) setState('shipwalk');
    } else if (state === 'shipwalk') {
      shipView.interact(nav);
    } else if (state === 'skydive') {
      skydiveCtl.deployParachute({ automatic: false });
    } else if (state === 'walk' && isNearExteriorRamp()) {
      shipView.toggleRamp();
    }
  }
  if (!e.repeat && e.code === 'KeyX' && state === 'space' && !paused) {
    if (riftRoute && !riftRoute.arrived) cancelRiftRoute();
    else nav.vel.set(0, 0, 0);
  }
  if (!e.repeat && e.code === 'KeyE' && !paused) {
    if (state === 'walk' && isNearExteriorRamp()) shipView.toggleRamp();
    else if (state === 'shipwalk' && shipView.walkPos.z > 3.2) shipView.toggleRamp();
  }
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

window.addEventListener('cancel-fold-route', () => {
  if (riftRoute && !riftRoute.arrived) cancelRiftRoute();
  else if (pendingRoute) clearPendingRoute();
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
    const lockAttempt = requestGameplayPointerLock();
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
    await lockAttempt;
  },
  onLand: tryLand,
  onStarMap: () => starMap?.isOpen ? closeStarMap() : openStarMap(),
  onRouteWarp: () => beginSelectedWarp(),
  onRouteRift: () => beginSelectedRift(),
  onRouteCancel: () => clearPendingRoute(),
  onJoystick: (x, y) => {
    walkCtl.touchMove.x = x;
    walkCtl.touchMove.y = y;
    skydiveCtl.touchMove.set(x, y);
    shipView.touchMove.set(x, y);
  },
  onJump: (down) => {
    if (state === 'walk') walkCtl.touchJump = down;
    if (!down || paused) return;
    if (state === 'skydive') skydiveCtl.deployParachute();
    if (state === 'shipwalk') shipView.interact(nav);
    else if (state === 'landed' && shipView.seatT >= 1 && shipView.standUp(nav, { landed: true })) setState('shipwalk');
  },
  onTakeoff: () => boardShip(),
  onApplyGraphics: (settings) => {
    writeGraphicsSettings(settings);
    setTimeout(() => location.reload(), 180);
  },
});
// Surface a clickable low-power GPU hint on the hero start page and inside
// graphics settings regardless of manual quality preset, so the player can
// always discover the discrete-GPU setup tutorial when running on integrated
// or software graphics.
ui.setHeroPerfHint(LOW_POWER_GPU, gpuName, { quality: graphicsSettings.quality });
ui.setGraphicsSettings(graphicsSettings, QUALITY_PROFILE, {
  gpu: gpuName,
  lowPowerGpu: LOW_POWER_GPU,
  recommendedQuality: RECOMMENDED_QUALITY,
  requestedBackend: rendererPolicy.requested,
  actualBackend: actualRendererBackend,
  reason: rendererRuntime.reason,
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
const hoverButton = document.getElementById('pause-hover-btn');
document.getElementById('touch-flight-menu').addEventListener('click', () => {
  if (state === 'space' && !starMap?.isOpen) pauseGame();
});
hoverButton.addEventListener('click', async () => {
  if (paused && await resumeGame()) tryLand({ hover: true });
});

function nearbyBlackHole() {
  let closest = null;
  let distance = Infinity;
  for (const object of universe.system?.compactObjects || []) {
    const d = nav.pos.distanceTo(object.posUniv);
    if (d < distance) { closest = object; distance = d; }
  }
  return closest && distance < closest.spec.accretionRadius * 7 ? closest : null;
}

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
    presentedFrames.setPaused(false,performance.now());
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
    : (state === 'landed' || state === 'shipwalk') && ship.parkedPlanet === body && ship.parkedLocal
      ? ship.parkedLocal.clone().normalize()
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
    : (state === 'landed' || state === 'shipwalk') && ship.parkedPlanet === body && ship.parkedLocal
      ? ship.parkedLocal.clone().normalize()
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
  const body = walkCtl.planet || ship.parkedPlanet || nearest || focusPlanet;
  beginTimeWarp(kind, body, () => findNextSolarEvent(body, kind));
}

function waitForEclipse() {
  const body = walkCtl.planet || ship.parkedPlanet || nearest || focusPlanet;
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
  if (!starMap || starMap.isOpen || paused || riftRoute?.arrived || ['warp', 'landing', 'takeoff', 'flyto', 'skydive'].includes(state)) return;
  if (riftRoute) cancelRiftRoute();
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
  ui.setCrosshair(state === 'space' || state === 'walk' || state === 'skydive');
  if (restoreInput && !window.NMS_NOLOCK && pointerLockInput
    && ['space', 'walk', 'skydive', 'shipwalk', 'landed'].includes(state)) {
    try { await renderer.domElement.requestPointerLock(); } catch { /* next click can reacquire */ }
  }
}

window.addEventListener('ui-sound', (event) => audio.playUi?.(event.detail));

function pauseGame() {
  if (paused) return;
  // The start page owns the screen; opening the pause surface while it is
  // fading out (or still up) creates the two overlays stacked on top of each
  // other.  Wait until the hand-off to flight is complete.
  if (document.body.classList.contains('hero-active')) return;
  if (pulseBurst?.charging) cancelPulseBurst();
  cancelTimeWarp();
  paused = true;
  presentedFrames.setPaused(true,performance.now());
  spaceCtl.enabled = false;
  pauseOverlay.classList.remove('hidden');
  hoverButton.disabled = !canStartJumpHover();
  hoverButton.classList.toggle('hidden', hoverButton.disabled);
  ui.pauseMenu?.reset({ focus: true });
  pausePanel.classList.remove('is-acquiring');
  pauseStatus.textContent = '指针已释放 · 点击继续以重新接管视角';
  audio.setPaused(true);
  music.setPaused(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

function requestGameplayPointerLock() {
  if (window.NMS_NOLOCK || !pointerLockInput || !['space', 'walk', 'skydive', 'shipwalk', 'landed'].includes(state)) return Promise.resolve(true);
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
  if (locked && !window.NMS_NOLOCK && pointerLockInput && ['space', 'walk', 'skydive', 'shipwalk', 'landed'].includes(state)) {
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
  presentedFrames.setPaused(false,performance.now());
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
      && !paused && !starMap?.isOpen && !pendingRoute && !riftRoute
      && (state === 'space' || state === 'walk' || state === 'skydive' || state === 'shipwalk' || state === 'landed')) {
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
    if ((walkCtl.planet && sys.planets.includes(walkCtl.planet))
      || (ship.parkedPlanet && sys.planets.includes(ship.parkedPlanet))) return false; // not under our feet
    if (focusPlanet && sys.planets.includes(focusPlanet)) {
      focusPlanet = null;
      spaceCtl.focus = null;
    }
    if (scatter.planet && sys.planets.includes(scatter.planet)) scatter.clear();
    return true;
  };
  updateStarProj();
}

function spaceControlHint() {
  if (IS_TOUCH) return '<b>单指</b> 转向 · <b>双指缩放</b> 推进 · <b>M</b> 星图';
  const rmb = shipView.isCockpit() ? '<b>RMB</b> 自由环视 · <b>SHIFT</b> 加力' : '<b>RMB/SHIFT</b> 加力';
  return `<b>鼠标</b> 船头 · <b>W/S</b> 推进/制动 · <b>A/D</b> 侧推 · <b>LMB</b> 射击 · ${rmb} · <b>SPACE</b> 脉冲冲刺 · <b>V</b> 座舱视角 · <b>M/TAB</b> 星图`;
}

let landedRequireKeyRelease = false;
let takeoffEngineBoost = 0;
let recallInFlight = false;

function setState(s) {
  state = s;
  document.getElementById('touch-flight-menu').hidden = s !== 'space';
  if (s !== 'space' && riftRoute && !riftRoute.arrived) cancelRiftRoute();
  document.body.classList.toggle('walking', s === 'walk');
  if (s !== 'space') {
    cancelPulseBurst();
    spaceCtl.firing = false;
    spaceCtl.firePressed = false;
    spaceCtl.clearTransientInput();
  }
  spaceCtl.enabled = s === 'space' && !starMap?.isOpen;
  ui.setCrosshair(s === 'walk' || s === 'space');
  ui.showTouchUI(IS_TOUCH && ['walk', 'skydive', 'shipwalk', 'landed'].includes(s), s);
  walkDial?.setActive(s === 'walk');
  if (s === 'walk') dialAcc = 1;
  // Landing, parked cockpit/chase, cabin walk, warp and takeoff all preserve
  // whichever camera mode the pilot chose; only star-map fly-to forces chase.
  if (s === 'flyto') shipView.forceChase();
  ui.setCockpitView(shipView.isCockpit());
  if (s === 'walk') ui.setHudMode('walk');
  else if (s === 'skydive') ui.setHudMode('skydive');
  else if (s === 'shipwalk' || s === 'boarding') ui.setHudMode('shipwalk');
  else if (s === 'landing' && !shipView.isCockpit()) ui.setHudMode('cinematic-landing');
  else ui.setHudMode('space');

  // Any state that is not shipwalk means the camera is no longer a person
  // inside the hull — release the interior's ownership of nav so the
  // flight physics / cinematic tweens can write it freely.
  if (s !== 'shipwalk' && shipView.shipwalk) {
    shipView.shipwalk = false;
    shipView.seatT = 1;
  }
  if (s !== 'skydive' && skydiveCtl.active) skydiveCtl.exit();
  if (s !== 'shipwalk' && s !== 'landed' && s !== 'walk' && s !== 'skydive') ui.setInteractPrompt('');
  const landed = !!ship.parkedPosUniv && ship.parkAmt > 0.98;
  const jumpHint = ship.hoverMode === 'high'
    ? ' · 开启尾舱门后向前跃出跳伞'
    : (landed ? ' · 开启尾舱门后沿坡道走出' : '');
  const hints = IS_TOUCH ? {
    space: spaceControlHint(),
    flyto: '自动接近中…',
    landing: ship.hoverMode === 'high' ? '正在进入定高悬停…' : '正在平稳降落…',
    landed: '',
    skydive: '',
    walk: '<b>摇杆</b> 移动 · <b>拖动</b> 观察 · <b>空格</b> 跳跃 · 走至尾舱按 <b>F</b> 开门登舰',
    shipwalk: '<b>摇杆</b> 舱内移动 · <b>F</b> 坐入驾驶座 / 开关尾舱门' + jumpHint,
    boarding: '正在登船…',
    takeoff: '引擎点火升空中…',
    warp: '空间折叠中…',
  } : {
    space: spaceControlHint(),
    flyto: '自动接近中… <b>Esc</b> 中止',
    landing: ship.hoverMode === 'high'
      ? '正在进入定高悬停…'
      : (shipView.isCockpit() ? '第一人称着陆程序中… <b>RMB</b> 自由环视' : '自动着陆程序中…'),
    landed: '',
    skydive: '',
    walk: '<b>WASD</b> 移动 · <b>LMB</b> 射击 · <b>RMB</b> 瞄准 · <b>R</b> 换弹 · <b>G</b> 收枪 · <b>T</b> 召回飞船',
    shipwalk: '<b>WASD</b> 舱内移动 · <b>Shift</b> 疾行 · <b>F</b> 坐入驾驶座 / 开关尾舱门' + jumpHint,
    boarding: '正在登船…',
    takeoff: '引擎点火升空中… <b>V</b> 切换视角',
    warp: '空间折叠中…',
  };
  ui.setHint(hints[s] || '', !['space', 'walk', 'shipwalk', 'landed', 'skydive'].includes(s));
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
  if (recallInFlight || ship.orbitalStandby
      || controller.planet !== ship.parkedPlanet || !ship.parkedLocal
      || !ship.parkedLocalQuat || ship.parkAmt < 0.98) {
    ship.suppressHoverSway = false;
    return;
  }

  shipCollisionInverse.copy(ship.parkedLocalQuat).invert();
  shipCollisionCurrent.copy(controller.posLocal).sub(ship.parkedLocal)
    .applyQuaternion(shipCollisionInverse);
  shipCollisionPrevious.copy(previousPosition).sub(ship.parkedLocal)
    .applyQuaternion(shipCollisionInverse);

  const radius = 0.44;
  const eyeHeight = controller.eyeHeight;
  let resolved = false;
  const rampOpen = shipView.rampWalkable(true);
  const rampTip = shipView.rampTipLocal();
  ship.suppressHoverSway = ship.hoverMode === 'extract'
    && Math.abs(shipCollisionCurrent.x) < 2.6
    && shipCollisionCurrent.z > 2.5
    && shipCollisionCurrent.z < rampTip.z + 3.6;

  // Open cargo ramp: walkable sloped deck leading smoothly from the terrain (or
  // low-hover extraction lip) up into the cargo hold (y = 0 at z = 6.2).
  let onOpenRamp = false;
  if (rampOpen
      && Math.abs(shipCollisionCurrent.x) <= 1.56
      && shipCollisionCurrent.z >= 3.2
      && shipCollisionCurrent.z <= rampTip.z + 0.65) {
    const deckY = shipView.rampFloorY(shipCollisionCurrent.z);
    const prevDeckY = shipView.rampFloorY(shipCollisionPrevious.z);
    const feet = shipCollisionCurrent.y - eyeHeight;
    const prevFeet = shipCollisionPrevious.y - eyeHeight;
    const stepUpTolerance = ship.hoverMode === 'extract' ? 0.98 : 0.78;
    if (feet <= deckY + 0.85
        && prevFeet >= Math.min(prevDeckY, rampTip.y) - stepUpTolerance
        && controller.vR <= 0.85) {
      onOpenRamp = true;
      if (feet <= deckY + 0.22) {
        shipCollisionCurrent.y = deckY + eyeHeight;
        controller.vR = 0;
        controller.grounded = true;
        resolved = true;
      }
      if (shipCollisionCurrent.z < rampTip.z - 0.12 && Math.abs(shipCollisionCurrent.x) > 1.38) {
        shipCollisionCurrent.x = clamp(shipCollisionCurrent.x, -1.38, 1.38);
        resolved = true;
      }
    }
  }

  if (!onOpenRamp) {
    const closedRampCollider = !rampOpen
      ? [{ center: [0, 1.05, 7.35], half: [1.78, 1.28, 1.35] }]
      : [];
    for (const collider of [...closedRampCollider, ...SHIP_LANDING_PROFILE.colliders]) {
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
      if (controller.vR > 0 && mantleReach >= 0 && mantleReach <= 1.12) {
        shipCollisionCurrent.y = top + eyeHeight;
        controller.vR = 0;
        controller.grounded = true;
        resolved = true;
        break;
      }
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
  }

  if (!resolved) return;
  controller.posLocal.copy(shipCollisionCurrent.applyQuaternion(ship.parkedLocalQuat))
    .add(ship.parkedLocal);
}

// Set the ship down on flat, dry tripod-conforming ground ~22 m from where the
// player spawns (used by NMS.land deterministic surface fixtures).
function parkShipNear(planet, landDir) {
  const up = _v.copy(landDir);
  const e1 = new THREE.Vector3();
  if (Math.abs(up.y) < 0.93) e1.set(up.z, 0, -up.x).normalize();
  else e1.set(0, -up.z, up.y).normalize();
  const e2 = new THREE.Vector3().crossVectors(up, e1);
  const cand = new THREE.Vector3();
  const landH = planet.height(up, planet.fullMaxFreq);
  let bestEval = null, bestScore = Infinity;
  for (const rad of [22, 28, 34, 40]) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      cand.copy(up)
        .addScaledVector(e1, (Math.cos(a) * rad) / planet.R)
        .addScaledVector(e2, (Math.sin(a) * rad) / planet.R)
        .normalize();
      const candidateForward = cand.clone().sub(landDir).projectOnPlane(cand).normalize();
      if (candidateForward.lengthSq() < 1e-4) candidateForward.copy(e1);
      const evalRes = evaluateTripodPad(planet, cand, candidateForward, { horizonQuat });
      if (!evalRes) continue;
      const candH = evalRes.padLocal.length() - planet.R;
      const playerDistance = Math.hypot(rad, candH - landH);
      if (playerDistance > BOARD_DISTANCE - 3) continue;
      const score = evalRes.slopeDeg * 0.16 + rad * 0.03 + Math.abs(candH - landH) * 0.08 + evalRes.rampDelta * 0.35;
      if (score < bestScore) {
        bestScore = score;
        bestEval = evalRes;
      }
    }
    if (bestEval && bestScore < 1.3) break;
  }
  const dryFound = Boolean(bestEval);
  if (!bestEval) {
    cand.copy(up).addScaledVector(e1, 22 / planet.R).normalize();
    const candidateForward = cand.clone().sub(landDir).projectOnPlane(cand).normalize();
    if (candidateForward.lengthSq() < 1e-4) candidateForward.copy(e1);
    const bestQuat = horizonQuat(cand, candidateForward, new THREE.Quaternion());
    bestEval = findLandingSite(planet, cand.clone().multiplyScalar(planet.R + landH + 40), bestQuat, {
      horizonQuat,
      allowSubmerged: true,
      forceFallback: true,
    });
  }
  ship.orbitalStandby = false;
  ship.hoverMode = null;
  ship.gearOffsets = bestEval.gearOffsets || [0, 0, 0];
  ship.parkedPlanet = planet;
  ship.parkedLocal = bestEval.padLocal;
  ship.parkedLocalQuat = bestEval.parkedLocalQuat;
  ship.setParked(bestEval.padUniv, bestEval.parkedWorldQuat);
  ship.parkAmt = 1;
  vegetationDisturbance.setPlanet(planet.bodyId || planet.seed);
  const padGround = groundPointUnder(planet, bestEval.padLocal, new THREE.Vector3());
  const parkedScar = vegetationDisturbance.addScar(padGround, LANDING_SCAR_RADIUS);
  vegetationDisturbance.setFell(parkedScar, 1);
  return { ...bestEval, dryFound };
}

const LANDING_CLEARANCE_METERS = 420;

function canStartJumpHover() {
  if (state !== 'space' || !nearest || nearest.isGasGiant || nearest.landable === false
    || pulseBurst || riftRoute || starMap?.isOpen) return false;
  const agl = landingClearanceMeters(nearest);
  const datum = nav.pos.distanceTo(nearest.posUniv) - nearest.R;
  return agl >= 45 && (agl < LANDING_CLEARANCE_METERS || datum < nearest.atmoHeight);
}

function hasDiveableOcean(planet) {
  return Boolean(planet?.hasLiquid
    && (planet.liquid === 'water' || planet.liquid === 'toxic')
    && Number.isFinite(planet.seaRadius));
}

function landingClearanceMeters(planet, worldPos = nav.pos, terrainAlt = nearestAlt) {
  if (!planet || planet.isGasGiant || planet.landable === false) return Infinity;
  if (!hasDiveableOcean(planet)) return terrainAlt;
  const seaClearance = worldPos.distanceTo(planet.posUniv) - planet.seaRadius;
  return Math.min(terrainAlt, seaClearance);
}

let scriptedFlightSpd = 0;
let _landingProbeAt = -1;
let _landingProbeBody = null;
let _landingProbeLandable = true;
const _landingProbePos = new THREE.Vector3(Infinity, Infinity, Infinity);

function evaluateFlightLanding(planet, allowSubmerged = false) {
  const chaseLead = (1 - (shipView.viewBlend ?? 1)) * 30;
  const refWorld = _v4.copy(nav.pos);
  if (chaseLead > 0.1) {
    _v3.set(0, 0, -1).applyQuaternion(nav.quat);
    refWorld.addScaledVector(_v3, chaseLead);
  }
  const shipLocal = planet.worldPositionToLocal(refWorld, new THREE.Vector3());
  const shipLocalQuat = planet.frameOrientation.clone().invert()
    .multiply(nav.quat).normalize();
  return findLandingSite(planet, shipLocal, shipLocalQuat, {
    horizonQuat,
    allowSubmerged,
  });
}

function probeCanTripodLand(planet) {
  const now = performance.now();
  if (_landingProbeBody === planet
    && now - _landingProbeAt < 180
    && _landingProbePos.distanceToSquared(nav.pos) < 9) {
    return _landingProbeLandable;
  }
  _landingProbeAt = now;
  _landingProbeBody = planet;
  _landingProbePos.copy(nav.pos);
  const res = evaluateFlightLanding(planet, false);
  _landingProbeLandable = Boolean(res?.landable);
  return _landingProbeLandable;
}

function enterHighHover(planet, minClearance = 92) {
  skydiveCtl.prepareRig();
  shipView.closeRamp();
  ship.orbitalStandby = false;
  ship.hoverMode = 'high';
  ship.gearOffsets = [0, 0, 0];
  recallInFlight = false;

  const seq = createHoverEntrySequence({
    planet,
    ship,
    shipView,
    nav,
    camera,
    horizonQuat,
    minClearance,
    onCockpitReached: () => {
      ui.setCockpitView(true);
      ui.setHudMode('space');
    },
  });

  ship.parkedPlanet = planet;
  ship.parkedLocal = seq.hoverLocal;
  ship.parkedLocalQuat = seq.hoverLocalQuat;
  ship.setParked(seq.hoverUniv, seq.hoverWorldQuat);

  const entrySpd = clamp(nav.vel.length(), 35, 220);
  scriptedFlightSpd = entrySpd;
  seq.step(0);
  setState('landing');
  ui.showLand(false);
  nav.vel.set(0, 0, 0);
  addTween(seq.duration, (k) => {
    seq.step(k);
    scriptedFlightSpd = entrySpd * (1 - k);
  }, () => {
    scriptedFlightSpd = 0;
    ship.finishLanding();
    nodePipeline.cloudPass?.resetHistory();
    shipView.viewMode = 'cockpit';
    shipView.viewBlend = 1;
    shipView.parkedCamBlend = 1;
    shipView.freeYaw = 0;
    shipView.freePitch = 0;
    landedRequireKeyRelease = Boolean(keys.KeyW || keys.Space);
    setState('landed');
  });
}

// Seamless landing or atmospheric hover entry (zero camera cuts):
// - Below 420 m over landable terrain: 3-pad tripod landing into `landed`.
// - Below 420 m over steep/rugged terrain (> 15.5° or rocky): enters stationary
//   level hover (`hoverMode = 'high'`) so the pilot can open the rear ramp and skydive!
// - Above the landing band L arrests flight at the pilot's chosen altitude.
//   Shift+L (also in the pause menu) requests that same hover over a low pad.
function tryLand({ hover = false } = {}) {
  if (state !== 'space' || !nearest || nearest.isGasGiant || nearest.landable === false
    || paused || starMap?.isOpen || pulseBurst || riftRoute) return;
  const clearance = landingClearanceMeters(nearest, nav.pos, nearestAlt);
  const jump = hover || clearance >= LANDING_CLEARANCE_METERS;
  if (jump ? !canStartJumpHover() : nav.vel.length() >= 4000) return;

  const planet = nearest;
  if (!window.NMS_NOLOCK && pointerLockInput && !document.pointerLockElement) requestGameplayPointerLock();

  if (jump) {
    enterHighHover(planet, clearance);
    return;
  }

  const overOpenWater = Boolean(hasDiveableOcean(planet)
    && (waterSurfaceHeight < 2
      || (nav.pos.distanceTo(planet.posUniv) - planet.seaRadius) < nearestAlt - 1.5));

  const landing = evaluateFlightLanding(planet, overOpenWater);

  if (!landing.landable) {
    enterHighHover(planet, 92);
    return;
  }

  shipView.closeRamp();
  ship.orbitalStandby = false;
  ship.hoverMode = null;
  ship.gearOffsets = landing.gearOffsets || [0, 0, 0];
  recallInFlight = false;
  ship.parkedPlanet = planet;
  ship.parkedLocal = landing.padLocal;
  ship.parkedLocalQuat = landing.parkedLocalQuat;
  ship.setParked(landing.padUniv, landing.parkedWorldQuat);

  vegetationDisturbance.setPlanet(planet.bodyId || planet.seed);
  const padGround = groundPointUnder(planet, landing.padLocal, new THREE.Vector3());
  const landingScar = vegetationDisturbance.addScar(padGround, LANDING_SCAR_RADIUS);

  const seq = createLandingSequence({
    planet,
    ship,
    shipView,
    nav,
    camera,
    landing,
    allowSubmerged: overOpenWater,
    onTouchdown: () => audio.cue('touchdown'),
    onCockpitReached: () => {
      ui.setCockpitView(true);
      ui.setHudMode('space');
    },
  });

  const entrySpd = clamp(nav.vel.length(), 45, 220);
  scriptedFlightSpd = entrySpd;
  seq.step(0);
  setState('landing');
  ui.showLand(false);
  nav.vel.set(0, 0, 0);
  addTween(seq.duration, (k) => {
    const { descent } = seq.step(k);
    scriptedFlightSpd = entrySpd * (1 - descent);
    vegetationDisturbance.setFell(landingScar, (descent - 0.18) / 0.72);
    vegetationDisturbance.setDownwash(padGround, DOWNWASH_RADIUS, (0.35 + 0.65 * descent) * (1 - smoothstep(0.88, 1.0, k) * 0.75));
  }, () => {
    scriptedFlightSpd = 0;
    ship.finishLanding();
    nodePipeline.cloudPass?.resetHistory();
    shipView.viewMode = 'cockpit';
    shipView.viewBlend = 1;
    shipView.parkedCamBlend = 1;
    shipView.freeYaw = 0;
    shipView.freePitch = 0;
    landedRequireKeyRelease = Boolean(keys.KeyW || keys.Space);
    setState('landed');
  });
}

const BOARD_DISTANCE = 60;
const _rampLocalProbe = new THREE.Vector3();
const _rampInvQuat = new THREE.Quaternion();
const _rampEuler = new THREE.Euler();

function playerShipLocal(out = _rampLocalProbe) {
  if (!ship.parkedPlanet || !ship.parkedLocal || !ship.parkedLocalQuat) return null;
  if (state === 'walk' && walkCtl.planet === ship.parkedPlanet) {
    _rampInvQuat.copy(ship.parkedLocalQuat).invert();
    return out.copy(walkCtl.posLocal).sub(ship.parkedLocal).applyQuaternion(_rampInvQuat);
  }
  return null;
}

function isNearExteriorRamp() {
  if (state !== 'walk' || recallInFlight || ship.orbitalStandby || ship.parkAmt < 0.98) return false;
  const p = playerShipLocal();
  if (!p) return false;
  return Math.abs(p.x) < 3.4 && p.z > 5.2 && p.z < 14.2 && Math.abs(p.y) < 4.5;
}

function exteriorRampPrompt() {
  if (!isNearExteriorRamp()) return '';
  const p = _rampLocalProbe;
  if (shipView.rampTarget < 0.5) return '[F] 打开尾舱门';
  if (!shipView.rampWalkable(true)) return '正在开启尾舱门…';
  if (p.z > shipView.rampTipLocal().z - 0.35) {
    return ship.hoverMode === 'extract'
      ? '悬停接应就绪 · 沿尾舱门跑入飞船 · [F] 关闭尾舱门'
      : '沿坡道走入飞船 · [F] 关闭尾舱门';
  }
  return '';
}

// Continuous walk -> shipwalk handoff when walking up the open cargo ramp.
function tryEnterShipFromRamp() {
  if (state !== 'walk' || recallInFlight || ship.orbitalStandby
      || !walkCtl.planet || walkCtl.planet !== ship.parkedPlanet
      || !ship.parkedLocal || ship.parkAmt < 0.98 || !shipView.rampWalkable(true)) {
    return false;
  }
  const p = playerShipLocal();
  if (!p) return false;
  const tip = shipView.rampTipLocal();
  const deckY = shipView.rampFloorY(p.z);
  const feet = p.y - walkCtl.eyeHeight;
  if (Math.abs(p.x) > 1.48 || p.z > tip.z - 0.38 || p.z < 2.2 || Math.abs(feet - deckY) > 0.95) {
    return false;
  }
  const planet = walkCtl.planet;
  planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
  nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);

  _rampInvQuat.copy(ship.parkedQuat).invert();
  _q.copy(_rampInvQuat).multiply(nav.quat).normalize();
  _rampEuler.setFromQuaternion(_q, 'YXZ');
  const eyeOffset = p.y - (SHIP_WALK_EYE_HEIGHT + deckY);

  walkCtl.exit();
  shipView.enterFromRamp(ship.parkedPosUniv, ship.parkedQuat, {
    x: clamp(p.x, -1.36, 1.36),
    z: Math.max(2.6, p.z),
    yaw: _rampEuler.y,
    pitch: _rampEuler.x,
    roll: _rampEuler.z,
    eyeOffset,
  });
  setState('shipwalk');
  return true;
}

function scheduleHoverShipAutoDepart(planet) {
  let departed = false;
  addTween(1.8, () => {}, () => {
    if (departed || ship.hoverMode !== 'high' || ship.parkedPlanet !== planet) return;
    if (state === 'shipwalk' || state === 'landed' || state === 'landing') return;
    departed = true;
    ship.emit('ramp-close', [0, 1.2, 6.6]);
    const autoSeq = createAutoDepartSequence({ planet, ship, shipView });
    addTween(autoSeq.duration, (k) => {
      if (ship.hoverMode !== 'high' || recallInFlight) return;
      autoSeq.step(k);
    }, () => {
      if (ship.hoverMode !== 'high' || recallInFlight) return;
      ship.landingPose = null;
      ship.orbitalStandby = true;
      ship.hoverMode = null;
      ship.parkedLocal = null;
      ship.parkedLocalQuat = null;
      ship.parkedPosUniv = null;
      ship.parkAmt = 0;
    });
  });
}

// Continuous shipwalk -> walk (or skydive when hovering high!) handoff when
// stepping off the end of the open cargo ramp.
function handOffRampExitToSurface() {
  if (state !== 'shipwalk' || !shipView.pendingSurfaceExit || !ship.parkedPlanet) return false;
  shipView.pendingSurfaceExit = false;
  const planet = ship.parkedPlanet;
  const posLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const localCamQ = _q.copy(planet.frameOrientation).invert().multiply(nav.quat).normalize();
  const viewDir = new THREE.Vector3(0, 0, -1).applyQuaternion(localCamQ).normalize();

  const f = clamp((keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) + shipView.touchMove.y, -1, 1);
  const s = clamp((keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + shipView.touchMove.x, -1, 1);
  const run = keys.ShiftLeft || keys.ShiftRight;
  const spd = run ? 4.8 : 2.2;
  const dirX = Math.sin(shipView.walkYaw), dirZ = Math.cos(shipView.walkYaw);
  const carryLocal = new THREE.Vector3((-dirX * f + dirZ * s) * spd, 0, (-dirZ * f - dirX * s) * spd)
    .applyQuaternion(ship.parkedLocalQuat);

  const posR = posLocal.length();
  const upDir = _v2.copy(posLocal).multiplyScalar(1 / Math.max(posR, 1));
  const surfaceR = planet.hasLiquid && Number.isFinite(planet.seaRadius)
    ? Math.max(planet.surfaceRadius(upDir), planet.seaRadius)
    : planet.surfaceRadius(upDir);
  const dropClearance = posR - surfaceR - walkCtl.eyeHeight;

  if (ship.hoverMode === 'high' || dropClearance > 8.5) {
    // HALO / hover jump! Leap clear of the aft ramp lip into freefall.
    const aftPush = new THREE.Vector3(0, run ? 5.8 : 4.6, run ? 6.8 : 5.2).applyQuaternion(ship.parkedLocalQuat);
    carryLocal.add(aftPush);
    skydiveCtl.enter(planet, posLocal, viewDir, carryLocal);
    audio.cue('chute-exit');
    planet.localPositionToWorld(skydiveCtl.posLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(skydiveCtl.quat);
    setState('skydive');
    scheduleHoverShipAutoDepart(planet);
    return true;
  }

  walkCtl.enter(planet, posLocal, viewDir);
  walkCtl.hSpeed.copy(carryLocal);
  walkCtl.grounded = true;
  planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
  nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);
  setState('walk');
  return true;
}

function parkedShipDistance() {
  if (ship.orbitalStandby || !ship.parkedPosUniv) return Infinity;
  return ship.parkedPosUniv.distanceTo(nav.pos);
}

// Cinematic out-of-sight fly-in recall (`T`): relocates the ship outside the
// player's camera frustum, sweeps in tail-first toward the clearing the player
// is facing (or executes a low-altitude Hot Extraction hover with the open
// cargo ramp resting right above a steep slope when no flat ground exists),
// and automatically opens the rear cargo ramp so the player can run aboard!
function recallShip() {
  if (state !== 'walk' || !walkCtl.planet || recallInFlight) return false;
  const planet = walkCtl.planet;
  const up = _v.copy(walkCtl.posLocal).normalize();
  walkCtl.frame(up, _v2, _v3); // east in _v2, north in _v3
  const lookFwd = new THREE.Vector3()
    .copy(_v3).multiplyScalar(Math.cos(walkCtl.yaw))
    .addScaledVector(_v2, Math.sin(walkCtl.yaw))
    .normalize();

  const target = findRecallSite(planet, walkCtl.posLocal, lookFwd, {
    horizonQuat,
    rampTipAt: (t) => shipView.rampTipAt(t),
  });
  if (!target) return false;

  recallInFlight = true;
  surveyUnits.recall();
  ship.orbitalStandby = false;
  ship.hoverMode = target.mode === 'hover-extract' ? 'extract' : null;
  ship.gearOffsets = target.gearOffsets || [0, 0, 0];
  ship.parkedPlanet = planet;
  ship.parkedLocal = target.padLocal;
  ship.parkedLocalQuat = target.parkedLocalQuat;
  ship.setParked(target.padUniv, target.parkedWorldQuat);

  const flyIn = createRecallFlyInSequence({
    planet,
    ship,
    shipView,
    playerPosLocal: walkCtl.posLocal,
    playerLookFwd: lookFwd,
    target,
  });
  const padGround = groundPointUnder(planet, target.padLocal, new THREE.Vector3());
  vegetationDisturbance.setPlanet(planet.bodyId || planet.seed);
  const recallScar = target.mode === 'landed'
    ? vegetationDisturbance.addScar(padGround, LANDING_SCAR_RADIUS)
    : null;

  audio.cue('recall-flyin');
  ui.setHint(target.mode === 'hover-extract'
    ? '附近地形陡峭 · 飞船正飞来执行超低空悬停接应，尾舱门将自动打开'
    : '飞船正在进场着陆，尾舱门将朝着你自动打开', true);

  flyIn.step(0);
  addTween(flyIn.duration, (k) => {
    if (!recallInFlight) return;
    flyIn.step(k);
    if (recallScar) {
      vegetationDisturbance.setFell(recallScar, (k - 0.35) / 0.55);
    }
    if (k > 0.35) {
      vegetationDisturbance.setDownwash(padGround, DOWNWASH_RADIUS, smoothstep(0.35, 0.92, k) * 0.9);
    }
  }, () => {
    if (!recallInFlight) return;
    recallInFlight = false;
    ship.finishLanding();
    nodePipeline.cloudPass?.resetHistory();
    shipView.openRamp();
    shipView.rampMax = shipView.groundClampedRampMax();
    shipView.rampT = shipView.rampMax;
    if (target.mode === 'landed') audio.cue('touchdown');
  });
  return true;
}

// Assisted ramp boarding (touch UI button & NMS.board debug helper): opens the
// cargo ramp and glides into the hold.
function boardShip() {
  if (state !== 'walk' || !walkCtl.planet) return false;
  const dist = parkedShipDistance();
  if (dist > BOARD_DISTANCE) {
    ui.setHint(`飞船距离 ${Number.isFinite(dist) ? Math.round(dist) + ' m' : '未知'} · 按 <b>T</b> 召回飞船`, true);
    audio.cue('denied');
    return false;
  }
  const planet = walkCtl.planet;
  const startLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const startLocalQuat = planet._invFrame.clone().multiply(nav.quat);
  const spawnLocal = new THREE.Vector3(0, SHIP_WALK_EYE_HEIGHT, ship.def.dims.holdEndZ - 1.6);
  const targetLocal = ship.parkedLocal.clone()
    .add(spawnLocal.clone().applyQuaternion(ship.parkedLocalQuat));
  const targetLocalQuat = ship.parkedLocalQuat.clone();
  walkCtl.exit();
  nav.vel.set(0, 0, 0);
  setState('boarding');
  audio.cue('board');
  shipView.openRamp();
  addTween(0.9, (k) => {
    const e = easeInOut(k);
    planet.localPositionToWorld(_v.lerpVectors(startLocal, targetLocal, e), nav.pos);
    nav.quat.copy(planet.frameOrientation)
      .multiply(_q.copy(startLocalQuat).slerp(targetLocalQuat, e));
  }, () => {
    const anchorPos = planet.localPositionToWorld(ship.parkedLocal, new THREE.Vector3());
    const anchorQuat = planet.frameOrientation.clone().multiply(ship.parkedLocalQuat);
    shipView.enterShipwalk(anchorPos, anchorQuat, { z: spawnLocal.z, yaw: 0 });
    setState('shipwalk');
  });
  return true;
}

// Assisted exit helper (NMS.exitShip debug helper).
function exitShip() {
  if (state !== 'shipwalk' || !ship.parkedPosUniv) return false;
  const planet = ship.parkedPlanet;
  if (!planet || ship.parkAmt < 0.98) return false;
  if (shipView.walkPos.z < 3.2) {
    ui.setHint('请走到尾舱坡道处再离船', true);
    return false;
  }
  if (shipView.rampTarget < 0.5) shipView.toggleRamp();
  const startLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const startLocalQuat = planet._invFrame.clone().multiply(nav.quat);
  const exitShipLocal = new THREE.Vector3(0, -SHIP_LANDING_PROFILE.bounds.minY, ship.def.dims.rampTopZ + 2.6);
  const exitLocal = ship.parkedLocal.clone()
    .add(exitShipLocal.applyQuaternion(ship.parkedLocalQuat));
  const exitDir = exitLocal.clone().normalize();
  const groundRadius = planet.surfaceRadius(exitDir);
  exitLocal.copy(exitDir).multiplyScalar(groundRadius + walkCtl.eyeHeight);
  const exitLocalQuat = ship.parkedLocalQuat.clone();
  setState('boarding');
  shipView.shipwalk = false;
  audio.cue('board');
  addTween(0.8, (k) => {
    const e = easeInOut(k);
    planet.localPositionToWorld(_v.lerpVectors(startLocal, exitLocal, e), nav.pos);
    nav.quat.copy(planet.frameOrientation)
      .multiply(_q.copy(startLocalQuat).slerp(exitLocalQuat, e));
  }, () => {
    const toShip = _v.copy(ship.parkedLocal).sub(exitLocal)
      .projectOnPlane(exitDir).normalize();
    walkCtl.enter(planet, exitLocal.clone(), toShip);
    planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);
    setState('walk');
  });
  return true;
}

// Player-controlled liftoff from the pilot's seat of a parked ship (`landed`).
// Preserves whichever view (1st-person cockpit or 3rd-person chase) is active,
// seals the cargo ramp, retracts landing gear and hands off smoothly to `space`.
function launchParkedShip() {
  if (state !== 'landed' || !ship.parkedPlanet || !ship.parkedLocal) return false;
  const planet = ship.parkedPlanet;
  if (shipView.rampTarget > 0.5) {
    shipView.closeRamp();
    ship.emit('ramp-close', [0, 1.2, 6.6]);
  } else {
    shipView.closeRamp();
  }
  surveyUnits.recall();
  const launchGround = groundPointUnder(planet, ship.parkedLocal, new THREE.Vector3());
  const seq = createTakeoffSequence({ planet, ship, shipView, nav });
  let prevK = 0;
  seq.step(0, 1 / 60);
  takeoffEngineBoost = 0.25;
  scriptedFlightSpd = 4;
  setState('takeoff');
  addTween(seq.duration, (k) => {
    const stepDt = Math.max(1 / 240, (k - prevK) * seq.duration);
    prevK = k;
    seq.step(k, stepDt);
    takeoffEngineBoost = 0.35 + 0.65 * smoothstep(0, 0.6, k);
    scriptedFlightSpd = lerp(4, 195, smoothstep(0.04, 1.0, k));
    vegetationDisturbance.setDownwash(launchGround, DOWNWASH_RADIUS, (1 - k) * 0.95);
  }, () => {
    takeoffEngineBoost = 0;
    scriptedFlightSpd = 0;
    seq.finish();
    ship.landingPose = null;
    ship.hoverMode = null;
    ship.orbitalStandby = false;
    ship.gearOffsets = [0, 0, 0];
    ship.parkedPlanet = null;
    ship.parkedLocal = null;
    ship.parkedLocalQuat = null;
    ship.parkedPosUniv = null;
    ship.parkAmt = 0;
    setState('space');
  });
  return true;
}

// Debug/capture utility (NMS.takeoff, used by screenshot.js and seamtest.js):
// launches straight up from the camera's current position or parked ship.
function takeoff(planet = walkCtl.planet ?? skydiveCtl.planet ?? ship.parkedPlanet, launchPos = nav.pos.clone(), launchUp = null) {
  if (state === 'landed' && ship.parkedPlanet && !launchUp) return launchParkedShip();
  if (!planet) return false;
  if (walkCtl.active) walkCtl.exit();
  if (skydiveCtl.active) skydiveCtl.exit();
  shipView.closeRamp();
  surveyUnits.recall();
  recallInFlight = false;
  const startLocal = planet.worldPositionToLocal(launchPos, new THREE.Vector3());
  const upLocal = launchUp
    ? planet.worldOffsetToLocal(launchUp, new THREE.Vector3()).normalize()
    : startLocal.clone().normalize();
  const endLocal = startLocal.clone().addScaledVector(upLocal, 420);
  const localQuat = planet._invFrame.clone().multiply(nav.quat);
  planet.localPositionToWorld(startLocal, nav.pos);
  const launchGround = groundPointUnder(planet, startLocal, new THREE.Vector3());
  ship.landingPose = null;
  ship.hoverMode = null;
  ship.orbitalStandby = false;
  ship.gearOffsets = [0, 0, 0];
  ship.parkedPlanet = null;
  ship.parkedLocal = null;
  ship.parkedLocalQuat = null;
  ship.parkedPosUniv = null;
  ship.parkAmt = 0;
  setState('takeoff');
  addTween(1.5, (k) => {
    planet.localPositionToWorld(_v.lerpVectors(startLocal, endLocal, easeInOut(k)), nav.pos);
    vegetationDisturbance.setDownwash(launchGround, DOWNWASH_RADIUS, 1 - k);
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
    ? body.accretionRadius * 2.15
    : body.radius * PLANET_ARRIVAL_FACTOR;
}

function shapeBlackHoleApproachDirection(direction, spec) {
  const basis = computeBlackHoleBasis(spec);
  const planar = direction.clone().projectOnPlane(basis.normal);
  if (planar.lengthSq() < 1e-4) planar.copy(basis.forward);
  planar.normalize();
  const sign = direction.dot(basis.normal) < -0.05 ? -1 : 1;
  const elev = clamp(Math.abs(direction.dot(basis.normal)), 0.115, 0.155);
  return planar.multiplyScalar(Math.sqrt(1 - elev * elev))
    .addScaledVector(basis.normal, sign * elev)
    .normalize();
}

function approachBlackHole(blackHole) {
  const rawDir = nav.pos.clone().sub(blackHole.posUniv);
  if (rawDir.lengthSq() < 1) rawDir.set(0.28, 0.24, 1);
  const direction = shapeBlackHoleApproachDirection(rawDir.normalize(), blackHole.spec);
  nav.pos.copy(blackHole.posUniv).addScaledVector(direction, blackHoleArrivalDistance(blackHole.spec));
  nav.vel.set(0, 0, 0);
  lookQuatAt(nav.pos, blackHole.posUniv, nav.quat);
  focusPlanet = null;
  spaceCtl.focus = null;
  ui.setHint(`已抵达 ${blackHole.name} 安全观测距离`, true);
  return true;
}

function routeArrival(star, bodyId = null, forwardHint = null) {
  const systemSpec = applySystemBodyTuning(
    generateSystemSpec(SEED, star),
    (targetBodyId) => universe.bodyTuning?.(star.id, targetBodyId) || null,
  );
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
    if (body.type === 'blackHole') {
      approach.copy(shapeBlackHoleApproachDirection(approach, body));
    }
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
  prepareWarpDestination(pendingRoute);
}

function clearPreparedWaterWarmMesh() {
  if (warpPreparedWaterWarmMesh) scene.remove(warpPreparedWaterWarmMesh);
  warpPreparedWaterWarmMesh = null;
  warpPreparedWaterWarmPlanet = null;
}

function resetPreparedDestinationWarmState() {
  clearPreparedWaterWarmMesh();
  warpPreparedWaterWarmState = 'idle';
  warpPreparedWaterWarmError = null;
  warpPreparedLodWarmState = 'idle';
  warpPreparedLodWarmPlanet = null;
  warpPreparedLodWarmError = null;
  warpPreparedRiftStructureState = 'idle';
  warpPreparedRiftStructurePromise = null;
  warpPreparedRiftWarmState = 'idle';
  warpPreparedRiftWarmError = null;
}

function disposePreparedWarpSystem() {
  warpPreparationToken++;
  warpCompile.abort();warpCompile = new AbortController();
  transferredPreparedDestination = null;
  resetPreparedDestinationWarmState();
  if (!warpPreparedSystem) return;
  warpPreparedSystem.dispose();
  warpPreparedSystem = null;
}

function preparedDestinationIsActive(token, route, prepared) {
  if (token !== warpPreparationToken) return false;
  if (pendingRoute === route && warpPreparedSystem === prepared) return true;
  return transferredPreparedDestination?.token === token
    && transferredPreparedDestination.route === route
    && transferredPreparedDestination.system === prepared;
}

function takePreparedDestination(route, owner) {
  if (!route || warpPreparedSystem?.star.id !== route.star.id) return null;
  const prepared = warpPreparedSystem;
  warpPreparedSystem = null;
  // Transfer both the scene graph and its in-flight GPU preparation. Cancelling
  // the token here used to stop terrain/water compilation exactly when the rift
  // button was clicked, moving all cold production work to the crossing frame.
  transferredPreparedDestination = {
    token: warpPreparationToken,
    route,
    system: prepared,
    owner,
  };
  return prepared;
}

function primePreparedBodyTextures(body, system) {
  // Read the live texture references only after admission: weather replacement
  // can dispose an atlas while this upload waits behind the preceding frame.
  void nodePipeline.prepare(() => {
    for (const texture of [body?.cloudShadowTex, body?.cloudWeatherHiTex, body?.ringMesh?.material?.map]) {
      if (texture) renderer.initTexture(texture);
    }
  }, { label: 'destination-textures', isCurrent: () => !!system && (
    universe.system === system || warpPreparedSystem === system || riftPreviewSystem === system
    || transferredPreparedDestination?.system === system
  ) }).catch(error => {
    if (!['obsolete', 'aborted', 'context-lost', 'disposed'].includes(error?.code)) console.warn('Destination texture preparation failed:', error);
  });
}

function nearestPublishedBody(bodies, position) {
  let nearestBody = null, distance = Infinity;
  for (const body of bodies) {
    if (body.group?.visible === false) continue;
    const candidate = position.distanceTo(body.posUniv) - body.R;
    if (candidate < distance) { distance = candidate;nearestBody = body; }
  }
  return nearestBody;
}

function worldPublicationConfig(publication) {
  return { scene, camera, universeRoot: universe.group, ship,
    target: nodePipeline.composer.readBuffer, shadowLight: sunShadow, publication };
}

async function prepareWorldPublication(publication, system) {
  let revision = null;
  const signal = nodePipeline.programPreparation.signal;
  for (const shadows of [false, true]) {
    const observed = await nodePipeline.prepare(() => compileWorldPublicationVariant(renderer,
      { ...worldPublicationConfig(publication), shadows }, { signal }),
    { signal, label: 'world-publication', isCurrent: () => universe.system === system && state !== 'warp' && !contextLost });
    if (revision !== null && observed !== revision) {
      throw Object.assign(new Error('WORLD dependencies changed between preparation families'), { code: 'publication-stale' });
    }
    revision = observed;
  }
  return revision;
}

function finishDeferredSystemMaterialPreparation(publication, system) {
  deferredSystemBuildActive = false;
  if (universe.system !== system) return;
  const delay = publication?.state === 'pending' ? Math.min(2000, 120 * 2 ** Math.min(publication.attempts, 4)) : 120;
  systemBuildResumeAt = Math.max(systemBuildResumeAt, performance.now() + delay);
}

async function runDeferredSystemPublication(system, body = null) {
  if (deferredSystemBuildActive) return false;
  deferredSystemBuildActive = true;
  let publication;
  try {
    if (deferredWorldPublication && deferredWorldPublication.system !== system) {
      deferredWorldPublication.abandon();deferredWorldPublication = null;
    }
    publication = deferredWorldPublication || captureWorldPublication(system,
      { body, build: body ? null : () => system.buildNext() });
    deferredWorldPublication = publication;
    const committed = await publication.publish(() => prepareWorldPublication(publication, system), {
      isCurrent: () => universe.system === system,
      canPublish: () => state !== 'warp' && !contextLost,
      getRevision: () => worldPublicationRevision(renderer, worldPublicationConfig(publication)),
    });
    if ((committed || publication.state === 'obsolete') && deferredWorldPublication === publication) deferredWorldPublication = null;
    if (publication.state === 'build-failed' && universe.system === system) {
      console.error('Deferred WORLD construction failed:', publication.lastError);
    }
    return committed;
  } catch (error) {
    if (universe.system === system && !['obsolete', 'aborted', 'context-lost', 'publication-stale'].includes(error?.code)) {
      const message = `${error?.code || ''}:${String(error?.message || error)}`;
      if (!publication || publication.reportedError !== message) {
        if (publication) publication.reportedError = message;
        console.error('Deferred WORLD publication failed:', error);
      }
    }
    return false;
  } finally {
    if (universe.system === system && publication) lastWorldPublicationSnapshot = publication.snapshot();
    finishDeferredSystemMaterialPreparation(publication, system);
  }
}

// Unparented stations share Universe.group with every live/prepared system;
// their owning system must explicitly carry them across visibility boundaries.
function standaloneSiteGroups(system) {
  return (system?.artificialSites || []).filter(site => !site.parentBody && site.group).map(site => site.group);
}

// Terrain readiness and the destination warm frame both ask for the LOD
// upload; within one route preparation the two production families are
// compiled once. A new route (token) always starts its own upload.
const preparedLodUploads = new WeakMap();
function uploadPreparedLodMeshesOnce(targetBody, prepared, token, route) {
  const key = prepared || targetBody;
  if (!key) return uploadPreparedLodMeshes(targetBody, prepared, token, route);
  const cached = preparedLodUploads.get(key);
  if (cached && cached.token === token && cached.body === targetBody) return cached.job;
  const job = uploadPreparedLodMeshes(targetBody, prepared, token, route);
  const entry = { token, body: targetBody, job };
  preparedLodUploads.set(key, entry);
  job.catch(() => { if (preparedLodUploads.get(key) === entry) preparedLodUploads.delete(key); });
  return job;
}

async function uploadPreparedLodMeshes(targetBody, prepared, token, route) {
  if (!targetBody?.group) return;
  const signal = warpCompile.signal;
  // WORLD arrival and near-surface shadow lighting have different program keys.
  // Each family gets its own shared preparation slot and current HDR target.
  for (const shadows of [false, true]) await nodePipeline.prepare(() =>
    compileDestinationVariant(renderer, {
      scene, camera, universeRoot: universe.group, body: targetBody,
      destination: prepared, ship, shadowLight: sunShadow,
      target: nodePipeline.composer.readBuffer, shadows,
      exclude: [surfaceBootstrapGroup],
    }, { signal }),
  { signal, label: 'destination-lod', isCurrent: () => preparedDestinationIsActive(token, route, prepared) });
}

async function prewarmPreparedRiftStructure(token, route, prepared) {
  // The fold has no mesh or private shader family any more: its composite is
  // compiled with the startup post passes and its far side reuses the
  // production programs the destination warm frame already linked.
  if (preparedDestinationIsActive(token, route, prepared)) warpPreparedRiftStructureState = 'complete';
}


async function renderPreparedDestinationWarmFrame(targetBody, route, prepared, token) {
  if(!preparedDestinationIsActive(token,route,prepared))return false;
  const signal = warpCompile.signal;
  try {
    return await nodePipeline.prepare((draw) => {
      const visibility = [];
      const rememberVisibility = (object, visible) => {
        if (!object || visibility.some((state) => state.object === object)) return;
        visibility.push({ object, visible: object.visible });
        object.visible = visible;
      };
      for (const system of [universe.system, universe.fadingSystem]) {
        if (!system || system === prepared) continue;
        for (const view of system.starViews) {
          rememberVisibility(view.group, false);
          rememberVisibility(view.light, false);
        }
        for (const body of [...system.planets, ...system.compactObjects]) {
          rememberVisibility(body.group, false);
        }
        for (const group of standaloneSiteGroups(system)) rememberVisibility(group, false);
      }
      for (const view of prepared.starViews) {
        rememberVisibility(view.group, true);
        rememberVisibility(view.light, true);
      }
      for (const body of [...prepared.planets, ...prepared.compactObjects]) {
        rememberVisibility(body.group, body === targetBody);
      }
      for (const group of standaloneSiteGroups(prepared)) rememberVisibility(group, true);

      const cameraState = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        fov: camera.fov,
      };
      const shadowState = {
        visible: sunShadow.visible,
        intensity: sunShadow.intensity,
        autoUpdate: sunShadow.shadow?.autoUpdate,
      };
      const previousVolumePlanet = volumePass?.activePlanet || null;
      const previousAtmospherePlanet = atmospherePass.activePlanet || null;
      const oldTarget = renderer.getRenderTarget();
      const oldFace = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
      const oldMrt = renderer.getMRT?.();
      const presentationPasses = [nodePipeline.foregroundPass, nodePipeline.parkedInteriorPass,
        nodePipeline.warp, nodePipeline.bloom, nodePipeline.grade, nodePipeline.outputPass,
        nodePipeline.smaa, nodePipeline.temporalAA].filter(pass => pass?.enabled);
      const targetQuat = lookQuatAt(route.target.entry, route.target.center, new THREE.Quaternion());

      try {
        // This private frame only prepares the destination world. Running
        // display AA here links a different final-pass program for the HDR
        // buffer. The player only ever sees that pass on the display target.
        for (const pass of presentationPasses) pass.enabled = false;
        prepared.updateCelestial?.(celestialClock.hours);
        universe.relativizeSystem?.(prepared, route.target.entry);
        camera.quaternion.copy(targetQuat);
        camera.updateMatrixWorld(true);
        sunShadow.visible = true;
        sunShadow.intensity = 0;
        if (sunShadow.shadow) sunShadow.shadow.autoUpdate = false;
        volumePass?.setActivePlanet(targetBody, route.target.entry, 0);
        nodePipeline.setActiveAtmosphere(targetBody, route.target.entry);
        targetBody.syncAtmoMaterial?.();
        targetBody.syncVolCloudMaterial?.();
        nodePipeline.bindVolumeDepth?.(targetBody);
        renderer.setRenderTarget(surfaceBootstrapTarget);
        renderer.setMRT?.(null);
        // Program linking does not allocate the complete production attachments
        // or upload every binding. Exercise a real offscreen frame before entry.
        if(draw()===false)throw Error('Destination warm frame was not submitted');
      } finally {
        for (const pass of presentationPasses) pass.enabled = true;
        // That draw ran the production graph from the destination's arrival pose
        // into a private target with most of the scene masked out. Its pixels are a
        // valid warm-up for the GPU pipeline and complete nonsense as temporal
        // history for the frame the player actually sees next.
        nodePipeline.invalidateVolumeHistory('private-prewarm');
        try {
          renderer.setRenderTarget(oldTarget, oldFace, oldMip);
          renderer.setMRT?.(oldMrt);
          volumePass?.setActivePlanet(previousVolumePlanet, nav.pos, 0);
          nodePipeline.setActiveAtmosphere(previousAtmospherePlanet, nav.pos);
          previousVolumePlanet?.syncAtmoMaterial?.();
          previousVolumePlanet?.syncVolCloudMaterial?.();
          nodePipeline.bindVolumeDepth?.(previousVolumePlanet);
        } finally {
          camera.position.copy(cameraState.position);
          camera.quaternion.copy(cameraState.quaternion);
          camera.fov = cameraState.fov;
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld(true);
          sunShadow.visible = shadowState.visible;
          sunShadow.intensity = shadowState.intensity;
          if (sunShadow.shadow) sunShadow.shadow.autoUpdate = shadowState.autoUpdate;
          if (universe.system) universe.relativizeSystem?.(universe.system, nav.pos);
          for (const state of visibility) state.object.visible = state.visible;
        }
      }
      return true;
    }, { signal, label: 'destination-private-frame',
      isCurrent: () => preparedDestinationIsActive(token, route, prepared) });
  } catch (error) {
    if (!preparedDestinationIsActive(token, route, prepared)) return false;
    throw error;
  }
}

async function prewarmPreparedRiftPortal(targetBody, token, route, prepared) {
  if (!preparedDestinationIsActive(token, route, prepared)) return;
  if (warpPreparedRiftWarmState === 'compiling'
      || warpPreparedRiftWarmState === 'complete') return;
  if (!targetBody?.group || !route?.target?.entry) {
    if (preparedDestinationIsActive(token, route, prepared)) warpPreparedRiftWarmState = 'complete';
    return;
  }
  warpPreparedRiftWarmState = 'compiling';
  try {
    await uploadPreparedLodMeshesOnce(targetBody, prepared, token, route);
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    await renderPreparedDestinationWarmFrame(targetBody, route, prepared, token);
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    warpPreparedRiftWarmState = 'complete';
    warpPreparedRiftWarmError = null;
  } catch (error) {
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    warpPreparedRiftWarmState = 'failed';
    warpPreparedRiftWarmError = String(error?.message || error);
    console.error('Destination portal pipeline prewarm failed:', error);
  }
}


function prewarmPreparedLod(targetBody, token, route, prepared) {
  if (!preparedDestinationIsActive(token, route, prepared)) return;
  // Gas/ice giants expose a countChunks-only LOD facade for diagnostics, not
  // a terrain quadtree. They still need their destination portal prewarmed.
  if (typeof targetBody?.lod?.update !== 'function' || !route?.target?.entry) {
    warpPreparedLodWarmState = 'complete';
    void prewarmPreparedRiftPortal(targetBody, token, route, prepared);
    return;
  }

  const worldOffset = route.target.entry.clone().sub(targetBody.posUniv);
  const camLocal = targetBody.worldOffsetToLocal(worldOffset, new THREE.Vector3());
  const terrain = targetBody.lod;
  const water = targetBody.waterLod || null;
  const originalTerrainPriority = terrain.startupPriority;
  const originalWaterPriority = water?.startupPriority;
  const originalTerrainBuildPriority = terrain.buildPriority;
  const originalWaterBuildPriority = water?.buildPriority;
  let stablePasses = 0;
  let previousSignature = '';
  warpPreparedLodWarmPlanet = targetBody;
  warpPreparedLodWarmState = 'warming';
  warpPreparedLodWarmError = null;
  terrain.startupPriority = true;
  terrain.buildPriority = -1e6;
  if (water) {
    water.startupPriority = true;
    water.buildPriority = -1e6;
  }

  const restorePriority = () => {
    terrain.startupPriority = originalTerrainPriority;
    terrain.buildPriority = originalTerrainBuildPriority;
    if (water) {
      water.startupPriority = originalWaterPriority;
      water.buildPriority = originalWaterBuildPriority;
    }
  };
  const finish = (state, error = null) => {
    restorePriority();
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    warpPreparedLodWarmState = state;
    warpPreparedLodWarmError = error;
  };

  const step = () => {
    if (!preparedDestinationIsActive(token, route, prepared)) {
      restorePriority();
      return;
    }
    if (transferredPreparedDestination?.system === prepared
        && warpPreparedRiftWarmState === 'complete') {
      // Once the crossing-critical root set and exact production pipelines are
      // warm, return the remaining LOD work to the ordinary 1.6 ms frame
      // scheduler. Continuing 12–14 ms route slices made the visible opening
      // judder even though it no longer helped the hand-off.
      restorePriority();
      warpPreparedLodWarmState = 'deferred';
      return;
    }
    try {
      const sliceStartedAt = performance.now();
      do {
        // Drive the hidden destination from the exact arrival camera. Each
        // update exposes the next quadtree frontier; the bounded scheduler
        // slice builds it while route-choice UI still owns the screen.
        terrain.focused = true;
        terrain.update(camLocal, 1);
        if (water) {
          water.focused = true;
          water.update(camLocal, 1);
        }
        flushChunkQueue(QUALITY_LOW ? 2.5 : 4);
        terrain.update(camLocal, 1);
        water?.update(camLocal, 1);

        const terrainRootsReady = terrain.roots.every((root) => !!root.mesh);
        const waterRootsReady = !water || water.roots.every((root) => !!root.mesh);
        if (warpPreparedRiftWarmState === 'waiting'
            && terrainRootsReady && waterRootsReady) {
          // Root geometry is sufficient to establish every production shader
          // and render context. Continue refining deeper LODs in parallel while
          // the already-warm passage opens, instead of withholding control for
          // hundreds of high-orbit chunks.
          void prewarmPreparedRiftPortal(targetBody, token, route, prepared);
        }

        const terrainStats = terrain.debugStats();
        const waterStats = water?.debugStats() || null;
        const signature = JSON.stringify([
          terrainStats.visibleLevels,
          waterStats?.visibleLevels || null,
          terrainStats.pending,
          waterStats?.pending || 0,
        ]);
        const ready = terrainStats.pending === 0
          && terrainStats.activeMorphs === 0
          && (!waterStats || (waterStats.pending === 0 && waterStats.activeMorphs === 0));
        stablePasses = ready && signature === previousSignature ? stablePasses + 1 : 0;
        previousSignature = signature;
        if (stablePasses >= 2) {
          warpPreparedLodWarmState = 'uploading';
          uploadPreparedLodMeshesOnce(targetBody, prepared, token, route)
            .then(() => {
              finish('complete');
              if (preparedDestinationIsActive(token, route, prepared)
                  && warpPreparedRiftWarmState === 'waiting') {
                return prewarmPreparedRiftPortal(targetBody, token, route, prepared);
              }
              return null;
            })
            .catch((error) => {
              restorePriority();
              if (!preparedDestinationIsActive(token, route, prepared)) return;
              const message = String(error?.message || error);
              console.error('Destination terrain GPU upload failed:', error);
              finish('failed', message);
              if (preparedDestinationIsActive(token, route, prepared)) {
                warpPreparedRiftWarmState = 'failed';
                warpPreparedRiftWarmError = message;
              }
            });
          return;
        }
      } while (performance.now() - sliceStartedAt < (QUALITY_LOW ? 3 : 4.5));
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
      else setTimeout(step, 0);
    } catch (error) {
      const message = String(error?.message || error);
      console.error('Destination terrain LOD prewarm failed:', error);
      finish('failed', message);
      if (preparedDestinationIsActive(token, route, prepared)
          && warpPreparedRiftWarmState === 'waiting') {
        void prewarmPreparedRiftPortal(targetBody, token, route, prepared);
      }
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
  else setTimeout(step, 0);
}

async function prewarmPreparedWater(targetBody, token, route, prepared) {
  if (!preparedDestinationIsActive(token, route, prepared)) return;
  const signal = warpCompile.signal;
  warpPreparedWaterWarmState = 'compiling';
  try {
    await nodePipeline.prepare(() => {
      const source = targetBody?.waterLod?.roots?.find((root) => root.mesh)?.mesh || null;
      if (!source?.material) return;

      const mesh = new THREE.Mesh(source.geometry, source.material);
      mesh.name = 'Prepared destination water pipeline warmer';
      mesh.userData.lodMorph = source.userData.lodMorph ?? 0;
      mesh.layers.mask = source.layers.mask;
      mesh.frustumCulled = false;
      mesh.castShadow = source.castShadow;
      mesh.receiveShadow = source.receiveShadow;
      mesh.visible = true;
      // A later masked production frame executes real physical-water fragments.
      // Keep coverage tiny so the calibration draw cannot visibly alter the route
      // scene or monopolize fill rate after asynchronous pipeline compilation.
      mesh.position.set(0, 0, -8);
      mesh.scale.setScalar(2e-7);
      scene.add(mesh);
      warpPreparedWaterWarmMesh = mesh;
      warpPreparedWaterWarmPlanet = targetBody;
      warpPreparedWaterWarmState = 'compiling';

      const lightVisibility = new Map([...(universe.system?.starViews || []), ...prepared.starViews]
        .map(view => [view.light, view.light.visible]));
      const shadowWasVisible = sunShadow.visible;
      const savedTarget = renderer.getRenderTarget?.();
      const savedFace = renderer.getActiveCubeFace?.() ?? 0;
      const savedMip = renderer.getActiveMipmapLevel?.() ?? 0;
      let compilation;
      try {
        for (const view of universe.system?.starViews || []) view.light.visible = false;
        for (const view of prepared.starViews) view.light.visible = true;
        sunShadow.visible = true;
        if (renderer.setRenderTarget && nodePipeline.composer?.readBuffer) {
          renderer.setRenderTarget(nodePipeline.composer.readBuffer);
        }
        const runCompile = () => compilePrograms(renderer, mesh, camera, scene, {signal});
        compilation = typeof withSurfaceWarmupVariant === 'function'
          ? withSurfaceWarmupVariant(mesh, runCompile)
          : runCompile();
      } finally {
        if (renderer.setRenderTarget && nodePipeline.composer?.readBuffer) {
          renderer.setRenderTarget(savedTarget, savedFace, savedMip);
        }
        sunShadow.visible = shadowWasVisible;
        for (const [light, visible] of lightVisibility) light.visible = visible;
        mesh.removeFromParent();
      }
      return compilation;
    }, { signal, label: 'destination-water', isCurrent: () => preparedDestinationIsActive(token, route, prepared) });
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    clearPreparedWaterWarmMesh();
    warpPreparedWaterWarmState = 'complete';
    warpPreparedWaterWarmError = null;
  } catch (error) {
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    clearPreparedWaterWarmMesh();
    warpPreparedWaterWarmError = String(error?.message || error);
    warpPreparedWaterWarmState = 'failed';
    console.error('Destination water pipeline prewarm failed:', error);
  }
}

function prepareWarpDestination(route) {
  // Retire the previous rift source while the route protocol owns the screen,
  // never on a live flight or threshold frame.
  disposeRetiredRiftSystem();
  disposePreparedWarpSystem();
  if (!route?.star || route.star.id === universe.system?.star?.id) return;
  const token = warpPreparationToken;
  const prepared = new StarSystem(universe, route.star, {
    deferred: true,
    fadeInPlanets: false,
    deferRoots: true,
    timeHours: celestialClock.hours,
  });
  warpPreparedSystem = prepared;
  warpPreparedRiftWarmState = 'waiting';
  warpPreparedRiftWarmError = null;
  warpPreparedRiftStructurePromise = prewarmPreparedRiftStructure(
    token,
    route,
    prepared,
  );
  for (const view of prepared.starViews) {
    view.group.visible = false;
    view.light.visible = false;
  }
  const hideBuiltBodies = () => {
    for (const body of [...prepared.planets, ...prepared.compactObjects]) {
      body.group.visible = false;
    }
    for (const group of standaloneSiteGroups(prepared)) group.visible = false;
  };
  const step = () => {
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    if (route.bodyId && typeof prepared.buildBody === 'function') {
      const beforeIds = new Set(prepared.bodyById.keys());
      prepared.buildBody(route.bodyId, { deferRoots: true });
      for (const body of [...prepared.planets, ...prepared.compactObjects]) {
        if (!beforeIds.has(body.bodyId)) {
          body.deferWeatherStream = true;
          primePreparedBodyTextures(body, prepared);
        }
      }
      hideBuiltBodies();
    } else {
      const startedAt = performance.now();
      do {
        const previousBodyCount = prepared.planets.length + prepared.compactObjects.length;
        prepared.buildNext();
        const bodies = [...prepared.planets, ...prepared.compactObjects];
        if (bodies.length > previousBodyCount) {
          const newest = bodies.at(-1);
          if (newest) newest.deferWeatherStream = true;
          primePreparedBodyTextures(newest, prepared);
        }
        hideBuiltBodies();
        if (route.bodyId && prepared.bodyById.has(route.bodyId)) break;
        if (!route.bodyId) break;
      } while (!prepared.built && performance.now() - startedAt < 3.5);
    }
    if (!route.bodyId || prepared.bodyById.has(route.bodyId) || prepared.built) {
      const targetBody = route.bodyId ? prepared.bodyById.get(route.bodyId) : (prepared.planets[0] || null);
      if (targetBody && !targetBody.isGasGiant && targetBody.type !== 'artificialHabitat'
          && typeof atmospherePass !== 'undefined' && typeof warpCompile !== 'undefined') {
        void atmospherePass?.prewarmPlanetProfileAsync?.(targetBody, { signal: warpCompile.signal });
      }
      warpPreparedWaterWarmPlanet = targetBody;
      warpPreparedWaterWarmState = 'waiting';
      warpPreparedLodWarmPlanet = targetBody;
      warpPreparedLodWarmState = 'waiting';
      prewarmPreparedLod(targetBody, token, route, prepared);
      // Wait until water roots are built before capturing the water program,
      // reusing the warm HDR variant once ready.
      const scheduleWaterWarm = () => {
        if (!preparedDestinationIsActive(token, route, prepared)) return;
        const rootsPending = targetBody?.waterLod?.roots?.some((root) => !root.mesh);
        if (rootsPending && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(scheduleWaterWarm);
          return;
        }
        void prewarmPreparedWater(targetBody, token, route, prepared);
      };
      setTimeout(scheduleWaterWarm, 0);
      // An immediate Warp click is accepted as a queued launch while the route
      // screen constructs the selected body. Never move that synchronous
      // constructor into live starflow: a complex ocean/cloud planet can cost
      // hundreds of milliseconds even though unrelated bodies stay deferred.
      if (route.warpRequested) scheduleQueuedWarpLaunch(route, token, prepared);
      return;
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

function warpLaunchReady() {
  const settled = (state) => state === 'complete' || state === 'failed';
  return settled(warpPreparedRiftWarmState) && settled(warpPreparedWaterWarmState);
}

function scheduleQueuedWarpLaunch(route, token, prepared) {
  if (route.warpLaunchScheduled) return;
  route.warpLaunchScheduled = true;
  const check = () => {
    if (!preparedDestinationIsActive(token, route, prepared)
        || pendingRoute !== route || !route.warpRequested || state !== 'space') return;
    if (route.bodyId && !prepared.built && !prepared.bodyById.has(route.bodyId)) {
      setTimeout(check, 16);
      return;
    }
    // Present one fully live route frame after the last preparation slice.
    // Starting warp in the same callback would attribute that completed work
    // to the first cinematic RAF interval even though starflow had not begun.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pendingRoute === route && route.warpRequested && state === 'space') {
        beginSelectedWarp();
      }
    }));
  };
  setTimeout(check, 0);
}

function disposeRiftPreview() {
  if (!riftPreviewSystem) return;
  if (transferredPreparedDestination?.system === riftPreviewSystem) {
    warpPreparationToken++;
    warpCompile.abort();warpCompile = new AbortController();
    transferredPreparedDestination = null;
    resetPreparedDestinationWarmState();
  }
  riftPreviewSystem.dispose();
  riftPreviewSystem = null;
  riftPreviewReady = false;
}

function disposeRetiredRiftSystem() {
  if (!retiredRiftSystem) return;
  retiredRiftSystem.dispose();
  retiredRiftSystem = null;
}

function setRiftPreviewVisible(
  visible,
  previewSystem = riftPreviewSystem,
  targetBodyId = riftRoute?.arrival?.bodyId || null,
) {
  if (!previewSystem) return;
  for (const view of previewSystem.starViews) {
    view.group.visible = visible;
    view.light.visible = visible;
  }
  for (const body of [...previewSystem.planets, ...previewSystem.compactObjects]) {
    body.group.visible = visible && (!targetBodyId || body.bodyId === targetBodyId);
  }
  for (const group of standaloneSiteGroups(previewSystem)) group.visible = visible;
}

// ---- 弦界航道: a fold between two places ------------------------------------
// The far side is drawn by a second production pipeline (PortalView) from the
// camera mapped through the opening and composited per pixel into the main
// view (PortalCompositePass). Before the crossing the far side is the
// destination; after it, the departure system seen through the closing fold.
const riftCameraUniv = new THREE.Vector3();
const riftFarCameraUniv = new THREE.Vector3();
const riftFarQuat = new THREE.Quaternion();
const riftPrevCameraUniv = new THREE.Vector3();
const riftSpill = new THREE.Color();
let riftBackSystem = null;
let riftFarBodyId = null;

function riftFarSystem() {
  return riftRoute?.arrived ? riftBackSystem : riftPreviewSystem;
}

function nearestBodyOf(system, position, includeHidden = false) {
  let best = null, bestDistance = Infinity;
  for (const body of system?.planets || []) {
    if (!includeHidden && !body.group.visible) continue;
    const d = position.distanceTo(body.posUniv) - (body.R || 0);
    if (d < bestDistance) { bestDistance = d; best = body; }
  }
  return best;
}

// Hide the near world, reveal the far one, and place the shared sky and
// lights for the far camera. Returns the matching restore.
function setupRiftFarScene(pipeline, far, farCamera, focusBody) {
  const visibility = [];
  const starPositions = [];
  let fog = scene.fog;
  let fogTaken = false;
  const hide = (object, visible = false) => {
    if (!object) return;
    visibility.push(object, object.visible);
    object.visible = visible;
  };
  const restore = () => {
    for (let i = visibility.length - 2; i >= 0; i -= 2) visibility[i].visible = visibility[i + 1];
    visibility.length = 0;
    if (fogTaken) scene.fog = fog;
    for (const [mesh, position] of starPositions) mesh.position.copy(position);
    starPositions.length = 0;
    // The far view borrowed medium bindings; hand the near planet's back
    // before the main view consumes them.
    const live = atmospherePass?.activePlanet;
    live?.syncAtmoMaterial?.();
    live?.syncVolCloudMaterial?.();
  };
  try {
    for (const system of [universe.system, universe.fadingSystem]) {
      if (!system || system === far) continue;
      for (const view of system.starViews) { hide(view.group); hide(view.light); }
      for (const body of [...system.planets, ...system.compactObjects]) hide(body.group);
      for (const group of standaloneSiteGroups(system)) hide(group);
    }
    for (const view of far.starViews) { hide(view.group, true); hide(view.light, true); }
    for (const body of [...far.planets, ...far.compactObjects]) {
      hide(body.group, riftRoute?.arrived || body === focusBody);
    }
    for (const group of standaloneSiteGroups(far)) hide(group, true);
    for (const object of [ship.group, weapons.glowMesh, weapons.coreMesh, sunShadow, headlamp,
      skyDome.mesh, hemi, ambient]) hide(object);
    for (const mesh of Object.values(scatter?.meshes || {})) hide(mesh);
    hide(riftPortalAmbient, true);
    fog = scene.fog;
    fogTaken = true;
    scene.fog = null;
    for (const mesh of [universe.nearStarsMesh, universe.backdropMesh]) {
      if (!mesh) continue;
      starPositions.push([mesh, mesh.position.clone()]);
      mesh.position.copy(farCamera).negate();
    }
    pipeline.setActiveAtmosphere(focusBody?.isGasGiant || focusBody?.type === 'artificialHabitat'
      ? null : focusBody, farCamera);
    focusBody?.syncAtmoMaterial?.();
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

// Draw the far side from `farCamera` (universe position) and `farQuat`.
function renderRiftFarView(far, farCamera, farQuat, dt = 1 / 60) {
  portalView.syncCamera(farQuat);
  far.updateCelestial(celestialClock.hours);
  const focusBody = riftRoute?.arrived
    ? nearestBodyOf(far, farCamera, true)
    : far.bodyById.get(riftFarBodyId) || null;
  for (const planet of far.planets) {
    if (!planet.group.visible && planet !== focusBody && !riftRoute?.arrived) continue;
    _v.copy(farCamera).sub(planet.posUniv);
    planet.update(_v, dt, planet === focusBody, 0);
  }
  for (const object of far.compactObjects) object.updateVisual?.(performance.now() * 0.001);
  universe.relativizeSystem(far, farCamera);
  return portalView.render({
    origin: farCamera,
    context: far,
    timeEpoch: celestialClock.epoch,
    setup: (pipeline) => setupRiftFarScene(pipeline, far, farCamera, focusBody),
  });
}

function renderRiftPortal() {
  const composite = nodePipeline.portalComposite;
  if (!riftRoute && pendingRoute?.target && warpPreparedSystem && !pendingRoute.warpRequested
      && !pendingRoute.farPrograms && warpPreparedRiftWarmState === 'complete') {
    void prewarmRiftFarView(pendingRoute, warpPreparedSystem);
  }
  if (!riftRoute || !riftPortal.isVisible) {
    composite.enabled = false;
    return;
  }
  const far = riftFarSystem();
  if (!far) { composite.enabled = false; return; }
  if (!riftRoute.arrived) syncRiftDestination();
  riftCameraUniv.copy(nav.pos).add(camera.position);
  const eyeAcross = riftPortal.shape === 'plane' && riftPortal.crossing(nav.pos, riftCameraUniv) >= 0;
  if (riftRoute.arrived && !riftPortal.needsBackView(riftCameraUniv, camera, eyeAcross)) {
    composite.enabled = false;
    return;
  }
  riftPortal.mapPosition(riftCameraUniv, riftFarCameraUniv);
  riftPortal.mapQuaternion(camera.quaternion, riftFarQuat);
  let rendered = false;
  // Once the destination itself is warm, link the far view's programs off
  // the frame; the far image fades in when they are ready.
  if (!riftRoute.arrived && riftFarWarmState === 'idle' && riftDestinationPreparationReady()
    && (!riftFarBodyId || far.bodyById.has(riftFarBodyId))) {
    void prewarmRiftFarView(riftRoute, far);
  }
  const farWarm = riftFarWarmState === 'complete' || riftFarWarmState === 'failed';
  if ((riftPortal.open.y > 0.004 || riftPortal.open.x > 0.02)
      && (riftRoute.arrived || (farWarm && riftDestinationPreparationReady()))) {
    try {
      rendered = renderRiftFarView(far, riftFarCameraUniv, riftFarQuat);
      if (rendered) riftRoute.farDrawFailures = 0;
    } catch (error) {
      // A failed far draw must not take the flight loop with it: the lease has
      // already restored the near world, and the opening shows only its light.
      if (!riftRoute.farDrawFailures) console.error('Portal far view failed:', error);
      riftRoute.farDrawFailures = (riftRoute.farDrawFailures || 0) + 1;
    }
  }
  if (!riftRoute.arrived) {
    const target = riftFarBodyId ? far.bodyById.get(riftFarBodyId) : null;
    const targetPresent = !riftFarBodyId || Boolean(target) || Boolean(far.built);
    const rootsReady = !target?.lod?.roots?.length || target.lod.roots.every((root) => !!root.mesh);
    riftPreviewReady = rendered && targetPresent && rootsReady && riftDestinationPreparationReady();
  }
  riftPortal.writeComposite(composite.uniforms, nav.pos);
  composite.uniforms.tPortal.value = portalView.texture;
  composite.uniforms.uPortalReady.value = rendered ? 1 : 0;
  composite.uniforms.uEyeAcross.value = rendered && eyeAcross ? 1 : 0;
  composite.uniforms.uFarLight.value.copy(riftSpill);
  composite.enabled = true;
}

function clearPendingRoute(restoreInput = true, keepPreparedWarp = false) {
  const hadRoute = !!pendingRoute;
  pendingRoute = null;
  if (!keepPreparedWarp) disposePreparedWarpSystem();
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
  route.warpRequested = true;
  if (warpPreparedSystem?.star.id === route.star.id && route.bodyId
      && !warpPreparedSystem.built && !warpPreparedSystem.bodyById.has(route.bodyId)) {
    ui.setWarpPreparing(true);
    scheduleQueuedWarpLaunch(route, warpPreparationToken, warpPreparedSystem);
    return;
  }
  const prepared = takePreparedDestination(route, 'warp');
  requestGameplayPointerLock();
  emitFoldNav('clear', '');
  ui.beginTravel();
  clearPendingRoute(false, true);
  warpTo(route.star, route.bodyId, prepared, route.target);
}

let foldNavPhase = 'clear';
let foldNavLabel = '';
function emitFoldNav(phase, label = '') {
  const nextLabel = String(label || '');
  if (phase === foldNavPhase && nextLabel === foldNavLabel) return;
  foldNavPhase = phase;
  foldNavLabel = nextLabel;
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('fold-nav', {
      detail: { phase, label: nextLabel },
    }));
  }
}

function cancelRiftRoute(message = '弦界航道已取消') {
  if (!riftRoute || riftRoute.arrived) return false;
  disposeRiftPreview();
  if (riftBackSystem) { riftBackSystem.dispose(); riftBackSystem = null; }
  riftRoute = null;
  riftFarBodyId = null;
  riftPortal.phase = 'closed';
  riftPortal.open = { x: 0, y: 0, tension: 0, flash: 0 };
  nodePipeline.portalComposite.enabled = false;
  nodePipeline.portalComposite.uniforms.tPortal.value = null;
  portalView?.pipeline?.setActiveAtmosphere?.(null, nav.pos);
  portalView?.release?.();
  riftFarWarmToken++;
  riftFarWarmState = 'idle';
  ui.endTravel();
  if (state === 'space' && !paused) {
    spaceCtl.enabled = true;
    ui.setCrosshair(true);
  }
  emitFoldNav('clear', '');
  ui.setHint(message);
  return true;
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
  const prepared = takePreparedDestination(route, 'rift');
  requestGameplayPointerLock();
  clearPendingRoute(false, true);
  ui.endTravel();
  spaceCtl.enabled = true;
  ui.setCrosshair(true);
  // The lane forms ahead of the ship and scales with the active flight speed
  // scale so its angular size stays balanced from low orbit to deep space.
  const reach = clamp(spaceCtl.speedScale * 1.6, 2200, 80000);
  if (riftPortal.shape === 'sphere') {
    riftPortal.profile.radius = clamp(reach * 0.16, 300, 12000);
  } else {
    riftPortal.profile.halfWidth = reach * 0.23;
    riftPortal.profile.halfHeight = reach * 0.14;
  }
  riftRoute = {
    ...route,
    arrival,
    arrived: false,
    anchorLocked: false,
    previewPreloaded: !!prepared,
    previewBuildFrame: -1,
    openStarted: false,
    pendingCrossing: false,
    heldVelocity: null,
    closeAt: 0,
    reach,
  };
  riftFarBodyId = arrival.bodyId;
  riftOrientation.copy(nav.quat);
  riftEntranceUniv.copy(nav.pos).addScaledVector(forward, reach);
  if (riftPortal.shape === 'sphere') {
    const arrivalForward = new THREE.Vector3(0, 0, -1).applyQuaternion(arrival.quat);
    riftTargetUniv.copy(arrival.entry).addScaledVector(arrivalForward, -riftPortal.radius);
  } else {
    riftTargetUniv.copy(arrival.entry);
  }
  riftPreviewOriginUniv.copy(arrival.entry);
  riftPortal.setFrames(riftEntranceUniv, riftOrientation, riftTargetUniv, arrival.quat);
  cancelPulseBurst();
  spaceCtl.boosting = false;
  riftPreviewSystem = prepared || new StarSystem(universe, route.star, {
    deferred: true,
    fadeInPlanets: false,
    timeHours: celestialClock.hours,
  });
  for (const body of [...riftPreviewSystem.planets, ...riftPreviewSystem.compactObjects]) {
    if ('appear' in body && body.appear < 1) {
      body.appear = 1;
      body.applyAppear?.();
    }
  }
  riftPreviewReady = false;
  setRiftPreviewVisible(false);
  const farStar = riftPreviewSystem.starViews?.[0]?.light?.color;
  riftSpill.copy(farStar || route.star.color || new THREE.Color(1, 1, 1));
  const programsValid = route.farPrograms
    && route.farPrograms.system === riftPreviewSystem
    && (route.farPrograms.state === 'complete'
      || (route.farPrograms.state === 'compiling' && route.farPrograms.token === riftFarWarmToken));
  if (programsValid) {
    riftFarWarmState = route.farPrograms.state;
  } else {
    riftRoute.farPrograms = null;
    riftFarWarmState = 'idle';
  }
  emitFoldNav('sync', route.label || '');
  startRiftOpening();
  if (riftFarWarmState === 'idle' && riftDestinationPreparationReady()
      && (!riftFarBodyId || riftPreviewSystem.bodyById.has(riftFarBodyId))) {
    void prewarmRiftFarView(riftRoute, riftPreviewSystem);
  }
}

let riftFarWarmState = 'idle';
let riftFarWarmToken = 0;

// Link the far view's programs for the exact far scene while waiting to open:
// lease the destination exactly as the far draw will, collect its materials
// synchronously and let the driver compile them in parallel.
async function prewarmRiftFarView(route, prepared) {
  const token = ++riftFarWarmToken;
  const record = { state: 'compiling', token, system: prepared };
  route.farPrograms = record;
  if (riftRoute === route) riftFarWarmState = record.state;
  const signal = warpCompile.signal;
  const arrival = route.arrival || route.target;
  const current = () => token === riftFarWarmToken
    && ((pendingRoute === route && !route.warpRequested) || (riftRoute?.farPrograms === record && !riftRoute.arrived));
  try {
    const pipeline = portalView.ensure();
    await nodePipeline.prepare(() => {
      const quat = lookQuatAt(arrival.entry, arrival.center, new THREE.Quaternion());
      portalView.syncCamera(quat);
      prepared.updateCelestial(celestialClock.hours);
      universe.relativizeSystem(prepared, arrival.entry);
      const focusBody = prepared.bodyById.get(route.bodyId || arrival.bodyId) || null;
      const previousTarget = renderer.getRenderTarget();
      const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      const restore = setupRiftFarScene(pipeline, prepared, arrival.entry, focusBody);
      try {
        // Three's compile() visits materials in hidden subtrees as well.
        // Enumerate only the live far-side drawables, retaining their mesh
        // types and the exact lighting/environment of the leased scene.
        const meshes = [];
        scene.traverseVisible(object => {
          if (object.material && object.layers.test(portalView.camera.layers)) meshes.push(object);
        });
        const drawables = {
          traverse: visit => meshes.forEach(visit),
          traverseVisible() {}, // lights are gathered from the target scene
        };
        renderer.setRenderTarget(pipeline.composer.readBuffer);
        return compilePrograms(renderer, drawables, portalView.camera, scene, { signal });
      } finally {
        renderer.setRenderTarget(previousTarget, face, mip);
        restore();
      }
    }, { signal, label: 'portal-programs', isCurrent: current });
    if (current()) {
      record.state = 'complete';
      if (riftRoute?.farPrograms === record) riftFarWarmState = record.state;
    } else if (route.farPrograms === record && record.state === 'compiling') {
      record.state = 'idle';
      if (riftRoute?.farPrograms === record) riftFarWarmState = 'idle';
    }
  } catch (error) {
    if (!current()) {
      if (route.farPrograms === record && record.state === 'compiling') {
        record.state = 'idle';
        if (riftRoute?.farPrograms === record) riftFarWarmState = 'idle';
      }
      return;
    }
    record.state = 'failed';
    if (riftRoute?.farPrograms === record) riftFarWarmState = record.state;
    console.warn('Portal far-view preparation failed:', error);
  }
}

function startRiftOpening() {
  if (!riftRoute || riftRoute.arrived || riftRoute.openStarted) return;
  riftRoute.openStarted = true;
  riftPortal.beginOpening();
  audio.cue('rift-open');
  ui.setHint('');
}

function riftDestinationPreparationReady() {
  if (riftRoute && !riftRoute.previewPreloaded) {
    const target = riftFarBodyId ? riftPreviewSystem?.bodyById.get(riftFarBodyId) : null;
    return Boolean(!riftFarBodyId || target || riftPreviewSystem?.built);
  }
  const settled = (value) => value === 'complete' || value === 'failed';
  return settled(warpPreparedWaterWarmState)
    && settled(warpPreparedRiftWarmState);
}

function syncRiftDestination() {
  if (!riftRoute || !riftPreviewSystem || !riftRoute.arrival.bodyId) return;
  riftPreviewSystem.updateCelestial(celestialClock.hours);
  let body = riftPreviewSystem.bodyById.get(riftRoute.arrival.bodyId);
  if (!body && !riftPreviewSystem.built && riftRoute.previewBuildFrame !== frameNo) {
    riftRoute.previewBuildFrame = frameNo;
    const previousBodyCount = riftPreviewSystem.planets.length
      + riftPreviewSystem.compactObjects.length;
    riftPreviewSystem.buildNext();
    for (const group of standaloneSiteGroups(riftPreviewSystem)) group.visible = false;
    const bodies = [...riftPreviewSystem.planets, ...riftPreviewSystem.compactObjects];
    const builtBody = bodies.length > previousBodyCount ? bodies.at(-1) : null;
    if (builtBody) {
      builtBody.group.visible = false;
      if ('appear' in builtBody && builtBody.appear < 1) {
        builtBody.appear = 1;
        builtBody.applyAppear?.();
      }
      primePreparedBodyTextures(builtBody, riftPreviewSystem);
    }
    body = riftPreviewSystem.bodyById.get(riftRoute.arrival.bodyId);
  }
  if (!body) return;
  if ('appear' in body && body.appear < 1) {
    body.appear = 1;
    body.applyAppear?.();
  }
  if (typeof riftPreviewReady !== 'undefined' && !riftPreviewReady && typeof flushChunkQueue === 'function') {
    const terrainRootsMissing = body.lod?.roots?.some((root) => !root.mesh);
    const waterRootsMissing = body.waterLod?.roots?.some((root) => !root.mesh);
    if (terrainRootsMissing || waterRootsMissing) {
      const worldOffset = _v.copy(riftRoute.arrival.entry).sub(body.posUniv);
      const camLocal = body.worldOffsetToLocal?.(worldOffset, _v2) || worldOffset;
      if (terrainRootsMissing) {
        body.lod.focused = true;
        body.lod.update(camLocal, 1);
      }
      if (waterRootsMissing) {
        body.waterLod.focused = true;
        body.waterLod.update(camLocal, 1);
      }
      flushChunkQueue(12);
    }
  }
  riftRoute.arrival.center.copy(body.posUniv);
  riftRoute.arrival.entry.copy(body.posUniv).add(riftRoute.arrival.offset);
  if (typeof riftPortal !== 'undefined' && riftPortal?.shape === 'sphere') {
    const arrivalForward = _v2.set(0, 0, -1).applyQuaternion(riftRoute.arrival.quat);
    riftTargetUniv.copy(riftRoute.arrival.entry).addScaledVector(arrivalForward, -riftPortal.radius);
  } else {
    riftTargetUniv.copy(riftRoute.arrival.entry);
  }
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

function finishRiftCrossing() {
  const route = riftRoute;
  // Carry the exact camera pose through the opening: position, heading and
  // velocity are mapped, nothing is re-aimed or pulled onto the axis.
  const crossedFromPending = !!route.pendingCrossing;
  route.pendingCrossing = false;
  if (route.heldVelocity) {
    if (nav.vel.lengthSq() < route.heldVelocity.lengthSq()) nav.vel.copy(route.heldVelocity);
    route.heldVelocity = null;
  }
  if (crossedFromPending && riftPortal.profile.shape !== 'sphere') {
    const localBefore = riftPortal.toSourceLocal(nav.pos, _v);
    if (localBefore.z >= 0) {
      _v2.set(0, 0, -1).applyQuaternion(riftOrientation);
      nav.pos.addScaledVector(_v2, localBefore.z + 1);
    }
  }
  riftPortal.mapPosition(nav.pos, _v);
  nav.pos.copy(_v);
  riftPortal.mapPosition(prevNavPos, prevNavPos);
  riftPortal.mapQuaternion(nav.quat, riftAssistQuat);
  nav.quat.copy(riftAssistQuat);
  riftPortal.mapDirection(nav.vel, _v);
  nav.vel.copy(_v);
  if (typeof shipView !== 'undefined' && shipView) {
    if (shipView.prevQuat) {
      riftPortal.mapQuaternion(shipView.prevQuat, riftAssistQuat);
      shipView.prevQuat.copy(riftAssistQuat);
    }
    if (shipView.viewBlend < 1 && shipView.viewBlendFrom) {
      riftPortal.mapDirection(shipView.viewBlendFrom.p, shipView.viewBlendFrom.p);
      riftPortal.mapQuaternion(shipView.viewBlendFrom.q, riftAssistQuat);
      shipView.viewBlendFrom.q.copy(riftAssistQuat);
    }
    if (shipView.shipwalk && !(typeof ship !== 'undefined' && ship?.parkedPosUniv)) {
      riftPortal.mapPosition(shipView.anchorPos, shipView.anchorPos);
      riftPortal.mapQuaternion(shipView.anchorQuat, riftAssistQuat);
      shipView.anchorQuat.copy(riftAssistQuat);
    }
  }
  if (typeof transitAxisWorld !== 'undefined') {
    riftPortal.mapDirection(transitAxisWorld, transitAxisWorld);
  }
  if (typeof pulseEchoes !== 'undefined') {
    for (const echo of pulseEchoes) {
      if (echo?.direction) riftPortal.mapDirection(echo.direction, echo.direction);
    }
  }
  const destination = universe.adoptSystem(riftPreviewSystem);
  riftPreviewSystem = null;
  transferredPreparedDestination = null;
  // The departure system leaves the live universe but stays drawable: it is
  // what the closing fold now shows behind the ship.
  riftBackSystem = universe.fadingSystem;
  universe.fadingSystem = null;
  for (const view of riftBackSystem?.starViews || []) {
    view.group.visible = false;
    view.light.visible = false;
  }
  for (const body of [...(riftBackSystem?.planets || []), ...(riftBackSystem?.compactObjects || [])]) {
    body.group.visible = false;
  }
  for (const group of standaloneSiteGroups(riftBackSystem)) group.visible = false;
  destination.updateCelestial(celestialClock.hours);
  for (const view of destination.starViews) {
    view.group.visible = true;
    view.light.visible = true;
  }
  for (const group of standaloneSiteGroups(destination)) group.visible = true;
  const arrivalBody = destination.bodyById.get(route.arrival.bodyId) || null;
  deferredSystemWarmQueue.length = 0;
  for (const body of [...destination.planets, ...destination.compactObjects]) {
    const visibleAtHandoff = body === arrivalBody;
    body.group.visible = visibleAtHandoff;
    if (!visibleAtHandoff) deferredSystemWarmQueue.push({ system: destination, body });
  }
  systemBuildResumeAt = performance.now() + 1800;
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      if (universe.system === destination) {
        for (const p of destination.planets || []) p.deferWeatherStream = false;
      }
    }, 2000);
  }
  universe.relativizeSystem(destination, nav.pos);
  if (arrivalBody) {
    focusPlanet = arrivalBody;
    spaceCtl.focus = arrivalBody;
  }
  // This frame's reference body was resolved before the crossing; hand the
  // frame to the arrival body now so the medium is not rebound to the
  // departure planet and the swapped cloud history survives.
  nearest = typeof arrivalBody?.altitudeAt === 'function' ? arrivalBody : null;
  const mainAtmoBody = arrivalBody?.isGasGiant || arrivalBody?.type === 'artificialHabitat'
    ? null : arrivalBody;
  riftPortal.swapSides();
  // The two views trade worlds; the cloud reconstruction goes with them.
  const farPipeline = portalView?.pipeline;
  if (farPipeline) {
    // Trade first: the main view takes the far view's reconstruction of the
    // arrival planet, the far view takes the departure planet's. Binding the
    // media afterwards then finds each cloud pass already on its own planet.
    const backBody = nearestBodyOf(riftBackSystem, riftEntranceUniv, true);
    const farAtmoBody = backBody?.isGasGiant || backBody?.type === 'artificialHabitat'
      ? null : backBody;
    const backCamPos = riftPortal.mapPosition(nav.pos, _v3);
    nodePipeline.cloudPass?.exchangeTemporalState(farPipeline.cloudPass);
    for (const cp of [nodePipeline.cloudPass, farPipeline.cloudPass]) {
      if (!cp?.target?.textures) continue;
      const ru = cp.resolveMaterial?.uniforms;
      if (ru) {
        if (ru.tCurrent) ru.tCurrent.value = cp.target.textures[0];
        if (ru.tCurrentAux) ru.tCurrentAux.value = cp.target.textures[1];
      }
      const cu = cp.compositeMaterial?.uniforms;
      if (cu) {
        if (cu.tCloudAux) cu.tCloudAux.value = cp.target.textures[1];
        if (cu.tShaft) cu.tShaft.value = cp.target.textures[2];
      }
    }
    nodePipeline.setActiveAtmosphere(mainAtmoBody, nav.pos);
    farPipeline.setActiveAtmosphere(farAtmoBody, backCamPos);
  } else {
    nodePipeline.setActiveAtmosphere?.(mainAtmoBody, nav.pos);
  }
  // Reset frame correspondence / TAA / legacy volume across the fold jump
  // without calling invalidateTemporalHistory(), which would wipe the
  // swapped LiteCloudPass temporal history.
  nodePipeline.frameState?.invalidate?.('rift-handoff');
  nodePipeline.temporalAA?.resetHistory?.();
  nodePipeline.volumePass?.resetHistory?.();
  if (!farPipeline?.cloudPass) nodePipeline.cloudPass?.resetHistory?.();
  riftSpill.copy(riftBackSystem?.starViews?.[0]?.light?.color || new THREE.Color(1, 1, 1));
  route.arrived = true;
  route.closeAt = clock.elapsedTime + (riftPortal.profile.persistent ? Infinity : 0.65);
  if (typeof emitFoldNav === 'function') emitFoldNav('clear', '');
  audio.cue('rift-close');
  setState('space');
  ui.showArrival(arrivalBody?.name || destination.name, destination.name, '弦界抵达');
}

function riftThresholdCrossing(portal, prev, curr) {
  if (portal.isOpen) return portal.crossing(prev, curr);
  if (portal.profile.shape !== 'plane') return -1;
  const a = portal.toSourceLocal(prev, _v2);
  const b = portal.toSourceLocal(curr, _v3);
  if (a.z <= 0 || Math.sign(a.z) === Math.sign(b.z) || a.z === b.z) return -1;
  const t = a.z / (a.z - b.z);
  const x = (a.x + (b.x - a.x) * t) / Math.max(portal.halfWidth, 1e-3);
  const y = (a.y + (b.y - a.y) * t) / Math.max(portal.halfHeight, 1e-3);
  const inside = Math.hypot(x, y) <= portal.contour(Math.atan2(y, x)) * 0.985;
  return inside ? t : -1;
}

function updateRiftRoute(dt) {
  if (!riftRoute) return;
  if (!riftRoute.arrived) {
    if (riftRoute.farDrawFailures >= 3) {
      cancelRiftRoute('目的地视野未能建立 · 航道已关闭');
      return;
    }
    if (!riftRoute.openStarted && typeof startRiftOpening === 'function') {
      if (typeof emitFoldNav === 'function') emitFoldNav('sync', riftRoute.label || '');
      startRiftOpening();
    }
    syncRiftDestination();
    if (riftFarBodyId && riftPreviewSystem?.built && !riftPreviewSystem.bodyById.has(riftFarBodyId)) {
      cancelRiftRoute('未找到目的地坐标 · 航道已关闭');
      return;
    }
    if (riftFarWarmState === 'compiling') {
      const record = riftRoute.farPrograms;
      riftFarWarmState = record?.token === riftFarWarmToken ? record.state : 'idle';
    }
    if (riftFarWarmState === 'idle' && riftDestinationPreparationReady()
        && (!riftFarBodyId || riftPreviewSystem?.bodyById.has(riftFarBodyId))
        && typeof prewarmRiftFarView === 'function') {
      void prewarmRiftFarView(riftRoute, riftPreviewSystem);
    }
  }
  // Hold at the drawn glowing seam if the first far-view frame has not rendered
  // yet, so the opening never tears into a black aperture.
  let portalDt = dt;
  if (riftPortal.phase === 'opening' && !riftPreviewReady) {
    const seamCap = riftPortal.profile.openSeconds * (riftPortal.profile.seamFraction * 0.95);
    if (riftPortal.clock >= seamCap) portalDt = 0;
    else portalDt = Math.min(dt, Math.max(0, seamCap - riftPortal.clock));
  }
  const wasSlit = riftPortal.phase === 'opening' && riftPortal.openness < .04;
  riftPortal.update(portalDt, clock.elapsedTime);
  if (wasSlit && riftPortal.openness >= .04) audio.cue('rift-tear');
  if (!riftRoute.arrived) {
    // Keep the lane anchored in world/reference space from click onwards.
    riftPortal.setFrames(riftEntranceUniv, riftOrientation, riftTargetUniv, riftRoute.arrival.quat);
    const readyToCross = riftPortal.isOpen && riftPreviewReady;
    if (!riftRoute.anchorLocked) {
      if (!readyToCross) {
        const activity = riftPreviewReady ? '坐标锁定 · 展开裂口'
          : riftFarWarmState === 'compiling' ? '链接目的地视野' : '同步弦界坐标';
        ui.setFoldActivity?.(activity);
      }
      if (readyToCross) {
        riftRoute.anchorLocked = true;
        if (typeof emitFoldNav === 'function') emitFoldNav('open', riftRoute.label || '');
        ui.endTravel?.();
        if (state === 'space' && !paused) {
          spaceCtl.enabled = true;
          ui.setCrosshair?.(true);
        }
      }
    }
    const crossingT = typeof riftThresholdCrossing === 'function'
      ? riftThresholdCrossing(riftPortal, prevNavPos, nav.pos)
      : riftPortal.crossing(prevNavPos, nav.pos);
    if (crossingT >= 0) {
      if (readyToCross) {
        finishRiftCrossing();
        return;
      }
      // Support immediate forward input during load: save momentum and hold
      // just on the near side of the anchored portal so crossing cannot miss.
      if (!riftRoute.heldVelocity) riftRoute.heldVelocity = nav.vel.clone();
      else if (nav.vel.lengthSq() > riftRoute.heldVelocity.lengthSq()) riftRoute.heldVelocity.copy(nav.vel);
      riftRoute.pendingCrossing = true;
      _v.lerpVectors(prevNavPos, nav.pos, Math.max(0, crossingT * 0.98));
      nav.pos.copy(_v);
      const holdLocal = riftPortal.toSourceLocal(nav.pos, _v2);
      if (holdLocal.z < 1) {
        _v3.set(0, 0, 1).applyQuaternion(riftOrientation);
        nav.pos.addScaledVector(_v3, 1 - holdLocal.z);
      }
      nav.vel.set(0, 0, 0);
      ui.setHint(`${riftRoute.label} · 正在同步目的地 · 即将穿越`, true);
    } else if (riftRoute.pendingCrossing) {
      const loc = riftPortal.locate(nav.pos);
      if (loc.radial > .985 || loc.z > Math.max(50, riftRoute.reach * 0.05)) {
        riftRoute.pendingCrossing = false;
        riftRoute.heldVelocity = null;
      } else if (readyToCross) {
        finishRiftCrossing();
        return;
      } else if (loc.z < 1) {
        _v3.set(0, 0, 1).applyQuaternion(riftOrientation);
        nav.pos.addScaledVector(_v3, 1 - loc.z);
        nav.vel.set(0, 0, 0);
      }
    } else if (riftPortal.shape === 'plane' && riftPortal.locate(nav.pos).z < -.75 * riftRoute.reach) {
      // A pilot who went around the opening and kept flying has left it behind.
      cancelRiftRoute('已飞离弦界入口 · 航道已关闭');
    }
  } else if (clock.elapsedTime >= riftRoute.closeAt && riftPortal.isOpen) {
    riftPortal.beginClosing();
  } else if (!riftPortal.isVisible) {
    // The fold has healed: the departure world is no longer visible anywhere.
    retiredRiftSystem = riftBackSystem;
    riftBackSystem = null;
    nodePipeline.portalComposite.enabled = false;
    nodePipeline.portalComposite.uniforms.tPortal.value = null;
    portalView?.pipeline?.setActiveAtmosphere?.(null, nav.pos);
    portalView?.release?.();
    riftFarWarmState = 'idle';
    riftRoute = null;
    if (typeof emitFoldNav === 'function') emitFoldNav('clear', '');
  }
}


// A warp is one continuous shot in five phases (transit.js): the sky streaks
// and gathers forward while the ship spools, the streaks thicken into a long
// curving tunnel, the destination is swapped in out of sight, the tunnel's
// end light opens from the centre, and the ship brakes onto its target along
// a straight line it is already facing, so nothing snaps on arrival.
function warpTo(star, preferBodyId = null, preparedSystem = null, preparedArrival = null) {
  if (state !== 'space') return;
  ui.beginWarpPower();
  cancelPulseBurst();
  setState('warp');
  warpRevealBody = null;
  warpRevealCameraOffset = null;
  warpRevealActive = false;
  focusPlanet = null;
  spaceCtl.focus = null;
  const startPos = nav.pos.clone();
  const startQuat = nav.quat.clone();
  // Safe stellar arrival point; replaced by the hero body once the
  // destination system exists.
  const arriveDir = startPos.clone().sub(star.pos).normalize();
  const starArrivalDistance = Math.max(star.radius * 72, 1.4e9);
  const endPos = star.pos.clone().addScaledVector(arriveDir, starArrivalDistance);
  const lookTarget = star.pos.clone();
  const approachDir = arriveDir.clone();
  let approachDistance = starArrivalDistance * 14;
  const plan = warpPlan(startPos.distanceTo(endPos));
  const departDir = star.pos.clone().sub(startPos).normalize();
  const departQuat = lookQuatAt(startPos, star.pos, new THREE.Quaternion());
  // The spool covers real distance (nearby bodies visibly fall behind), but
  // never far enough to run into one.
  let spoolDistance = 6e6;
  for (const body of universe.planets()) {
    const toBody = body.posUniv.clone().sub(startPos);
    const along = toBody.dot(departDir);
    if (along <= 0) continue;
    const miss = toBody.addScaledVector(departDir, -along).length();
    const clearRadius = body.R + Math.max(body.atmoHeight || 0, body.hAmp || 0) * 1.5;
    if (miss < clearRadius * 1.2) {
      spoolDistance = Math.min(spoolDistance, Math.max(0, along - clearRadius * 1.3) * 0.5);
    }
  }
  // The tunnel's light drifts from the departure star's colour to the
  // destination star's colour.
  const departColor = universe.system?.star?.color || star.color;
  if (departColor) transitColorA.copy(departColor).lerp(TRANSIT_COOL, 0.25);
  if (star.color) transitColorB.copy(star.color).lerp(TRANSIT_COOL, 0.25);
  transitFlow = 0;
  warpTransit = { t: 0, plan, dir: departDir.clone() };
  nav.vel.set(0, 0, 0);
  audio.cue('warp-spool');
  let swapped = false;
  let enterCued = false;
  let exitCued = false;
  let arrivalPlanetName = null;
  let arrivalSystem = null, arrivalSpec = null;

  const swapDestination = () => {
    swapped = true;
    warpTransit.swapped = true;
    let destination;
    if (preparedSystem?.star.id === star.id) {
      for (const view of preparedSystem.starViews) {
        view.group.visible = true;
        view.light.visible = true;
      }
      for (const group of standaloneSiteGroups(preparedSystem)) group.visible = true;
      let revealBodyId = preferBodyId;
      const selectedSpec = revealBodyId
        ? preparedSystem._specs.find((spec) => spec.bodyId === revealBodyId)
        : null;
      if (selectedSpec?.isMoon) revealBodyId = selectedSpec.parentId;
      const preparedRevealBody = revealBodyId
        ? preparedSystem.bodyById.get(revealBodyId) || null
        : null;
      deferredSystemWarmQueue.length = 0;
      for (const body of [...preparedSystem.planets, ...preparedSystem.compactObjects]) {
        const visibleDuringWarp = !preparedRevealBody || body === preparedRevealBody;
        body.group.visible = visibleDuringWarp;
        if (!visibleDuringWarp) {
          deferredSystemWarmQueue.push({ system: preparedSystem, body });
        }
      }
      destination = universe.adoptSystem(preparedSystem);
      transferredPreparedDestination = null;
      // The tunnel hides both systems. Keeping the departure system as
      // Universe.fadingSystem would change the active light count and force
      // every destination PBR program to compile a combined-light variant on
      // the hand-off frame. Park it and dispose it under the next overlay.
      retiredRiftSystem = universe.fadingSystem;
      universe.fadingSystem = null;
      for (const view of retiredRiftSystem?.starViews || []) {
        view.group.visible = false;
        view.light.visible = false;
      }
      for (const body of [
        ...(retiredRiftSystem?.planets || []),
        ...(retiredRiftSystem?.compactObjects || []),
      ]) body.group.visible = false;
      for (const group of standaloneSiteGroups(retiredRiftSystem)) group.visible = false;
      preparedSystem = null;
    } else {
      destination = universe.setSystem(star, true, { fadeInPlanets: false, deferRoots: true });
    }
    // Route-choice idle time normally builds the selected body. A very fast
    // confirmation can still arrive first; build only the target body.
    if (preferBodyId && !destination.bodyById.has(preferBodyId) && typeof destination.buildBody === 'function') {
      destination.buildBody(preferBodyId, { deferRoots: true });
    } else {
      for (let guard = 0; preferBodyId && !destination.bodyById.has(preferBodyId) && !destination.built && guard < 64; guard++) {
        destination.buildNext();
      }
    }
    let hero = null;
    if (preferBodyId) {
      let picked = destination._specs.find((spec) => spec.bodyId === preferBodyId);
      if (picked?.isMoon) picked = destination._specs.find((spec) => spec.bodyId === picked.parentId);
      if (picked && !picked.isMoon) hero = picked;
    }
    if (hero) {
      const heroPos = destination.frames.get(hero.bodyId).position;
      warpRevealBody = destination.bodyById.get(hero.bodyId) || null;
      approachDir.copy(preparedArrival?.bodyId === hero.bodyId
        ? preparedArrival.entry.clone().sub(preparedArrival.center).normalize()
        : startPos.clone().sub(heroPos).normalize());
      arrivalSystem = destination;
      arrivalSpec = hero;
      const arrivalDistance = blackHoleArrivalDistance(hero);
      warpRevealCameraOffset = approachDir.clone().multiplyScalar(arrivalDistance);
      // The silhouette should already be legible through the first opening.
      // A shorter run-in also spreads its apparent growth across the exit.
      approachDistance = arrivalDistance * (hero.type === 'blackHole' ? 7 : 9);
      arrivalPlanetName = hero.name;
    }
    // The camera pose jumps across the galaxy while the tunnel is opaque;
    // temporal history from the departure frame must not be reprojected.
    nodePipeline.invalidateTemporalHistory?.('warp-handoff');
    nodePipeline.invalidateVolumeHistory?.('warp-handoff');
  };

  addTween(plan.total, (k) => {
    const t = k * plan.total;
    warpTransit.t = t;
    if (preparedSystem && preferBodyId && !preparedSystem.bodyById.has(preferBodyId)
        && !preparedSystem.built) {
      const beforeIds = new Set(preparedSystem.bodyById.keys());
      if (typeof preparedSystem.buildBody === 'function') {
        preparedSystem.buildBody(preferBodyId, { deferRoots: true });
      } else {
        preparedSystem.buildNext();
      }
      for (const group of standaloneSiteGroups(preparedSystem)) group.visible = false;
      for (const builtBody of [...preparedSystem.planets, ...preparedSystem.compactObjects]) {
        if (!beforeIds.has(builtBody.bodyId)) {
          builtBody.group.visible = false;
          builtBody.deferWeatherStream = true;
          primePreparedBodyTextures(builtBody, preparedSystem);
        }
      }
    }
    if (!enterCued && t >= plan.entryStart + 0.6) {
      enterCued = true;
      audio.cue('warp-enter');
    }
    if (t < plan.swapAt) {
      nav.quat.copy(startQuat).slerp(departQuat, smoothstep(0.05, 1.5, t));
      nav.pos.copy(startPos).addScaledVector(departDir, spoolDistance * warpDepartureTravel(t, plan));
      warpTransit.dir.copy(departDir);
      return;
    }
    if (!swapped) swapDestination();
    if (arrivalSpec) {
      const heroPos = arrivalSystem.frames.get(arrivalSpec.bodyId).position;
      lookTarget.copy(heroPos);
      endPos.copy(heroPos).add(warpRevealCameraOffset);
    }
    nav.pos.copy(endPos).addScaledVector(approachDir, approachDistance * warpApproachRemaining(t, plan));
    lookQuatAt(nav.pos, lookTarget, nav.quat);
    warpTransit.dir.copy(lookTarget).sub(nav.pos).normalize();
    // The destination's medium and ocean come alive inside the opaque tunnel,
    // well before the exit opens, so nothing pops while the planet grows.
    if (t >= plan.swapAt + 0.6 && warpRevealBody) warpRevealActive = true;
    if (!exitCued && t >= plan.exitStart - 0.2) {
      exitCued = true;
      audio.cue('warp-exit');
    }
  }, () => {
    warpTransit = null;
    warpIntensity = 0;
    camera.fov = BASE_FOV + shipView.fovOffset();
    camera.updateProjectionMatrix();
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
        // Already facing it: the approach ran along this exact line.
        focusPlanet = arrivalPlanet;
        spaceCtl.focus = arrivalPlanet;
        arrivalDisplayName = arrivalPlanet.name;
      }
    } else {
      ui.setHint(`已抵达 ${universe.system.name} · 星系安全入口`, true);
    }
    // Never complete unrelated bodies in this callback: constructors and their
    // root terrain meshes are synchronous and would hitch the first free frame.
    setState('space');
    // Water is withheld only while the transit owns the reveal.
    warpRevealBody?.waterLod?.setVisible(true);
    warpRevealBody = null;
    warpRevealCameraOffset = null;
    warpRevealActive = false;
    systemBuildResumeAt = performance.now() + 4500;
    const arrivedSys = universe.system;
    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        if (universe.system === arrivedSys) {
          for (const p of arrivedSys?.planets || []) p.deferWeatherStream = false;
        }
      }, 4200);
    }
    ui.endWarpPower();
    ui.showArrival(arrivalDisplayName, universe.system.name, '跃迁抵达');
  }, {
    // Continue advecting fog and lighting at cruise until the first destination
    // frame is ready. Release from this same timeline instant on the next tick.
    timeLimit: () => preparedSystem && transferredPreparedDestination?.system === preparedSystem && !warpLaunchReady()
      ? plan.swapAt - .01 : Infinity,
  });
}

// Drop every transit in flight (new universe, debug relocation).
// Debug relocations and resets abandon every transit in flight: timelines,
// cinematic UI, lens and an open fold.
function abortTransits() {
  resetTransitState();
  ui.endWarpPower(true);
  ui.endTravel();
  camera.fov = BASE_FOV + shipView.fovOffset();
  camera.updateProjectionMatrix();
  if (riftRoute) {
    disposeRiftPreview();
    if (riftBackSystem) { riftBackSystem.dispose(); riftBackSystem = null; }
    riftRoute = null;
    riftPortal.phase = 'closed';
    riftPortal.open = { x: 0, y: 0, tension: 0, flash: 0 };
    nodePipeline.portalComposite.enabled = false;
    nodePipeline.portalComposite.uniforms.tPortal.value = null;
    portalView?.pipeline?.setActiveAtmosphere?.(null, nav.pos);
    portalView?.release?.();
    riftFarWarmToken++;
    riftFarWarmState = 'idle';
  }
  emitFoldNav('clear', '');
  if (state === 'warp') setState('space');
}

function transitHoldsQuality() {
  return !!(warpTransit || pulseBurst || pulseEchoes.length || riftRoute || transitHold || state === 'warp');
}

function resetTransitState() {
  if (pulseBurst?.charging) audio.pulseCharge?.(-1);
  pulseBurst = null;
  pulseEchoes.length = 0;
  pulseActive = false;
  warpTransit = null;
  warpIntensity = 0;
  warpRevealBody?.waterLod?.setVisible(true);
  warpRevealBody = null;
  warpRevealCameraOffset = null;
  warpRevealActive = false;
}

function newUniverse(seed) {
  resetTransitState();
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
  riftPortal.phase = 'closed';
  riftPortal.open = { x: 0, y: 0, tension: 0, flash: 0 };
  nodePipeline.portalComposite.enabled = false;
  nodePipeline.portalComposite.uniforms.tPortal.value = null;
  portalView?.pipeline?.setActiveAtmosphere?.(null, nav.pos);
  portalView?.release?.();
  riftFarWarmToken++;
  riftFarWarmState = 'idle';
  emitFoldNav('clear', '');
  if (riftBackSystem) { riftBackSystem.dispose(); riftBackSystem = null; }
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
  sceneRadiance.setUniverse(universe);
  ship.setSpaceEnvironment(sceneRadiance.spaceEnvironment);
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
  if (hero) ship.introOffset?.set(110, -62, 48);
  ui.setSystem(sys.name, sys._specs?.length || sys.planets.length, SEED, sys.catalogId, WORLD_LAB);
  setState('space');
}

// Seamless one-shot: from the limb close-up back out to the full planet while
// the ship slides into formation. Runs inside the click gesture's call chain
// so pointer lock requested in onDone still counts as user-activated.
function startHeroPullBack(onDone) {
  heroTransitionActive = true;
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
    // Move from the first frame with zero start/end acceleration. The old
    // 40% dead interval made the ship appear to pause and then pop into motion.
    const sk = k * k * k * (k * (k * 6 - 15) + 10);
    ship.introOffset.set(110 * (1 - sk), -62 * (1 - sk), 48 * (1 - sk));
  }, () => {
    ship.introOffset.set(0, 0, 0);
    heroTransitionActive = false;
    onDone?.();
  }, { realTime: true });
}

// ---- ambience: atmosphere entry, sky color, fog, star dimming ------------------
function ambience(dt = 1 / 60) {
  let inAtmo = 0, day = 1, skyStrength = 0;
  const wasUnderwater = envUnderwater && underwaterPlanetKey === nearest?.seed;
  underwaterPlanetKey = nearest?.seed ?? null;
  envEclipse = 0;
  envUnderwater = false;
  activeWeather = null;
  scene.fog.density = 0;
  if (nearest) {
    const p = nearest;
    _up.copy(nav.pos).sub(p.posUniv).normalize();
    const sunDir = nearest.sunDirWorld || universe.system.sunDirFrom(nav.pos, _v);
    const blockers = universe.system.planets
      .filter((body) => body !== p)
      .map((body) => ({ position: body.posUniv, radius: body.R }));
    let totalFlux = 0, litFlux = 0, clearLitFlux = 0;
    for (const view of universe.system.starViews) {
      const delta = _v2.copy(view.positionUniv).sub(nav.pos);
      const flux = view.spec.luminositySolar / Math.max(1, delta.lengthSq());
      const directDay = smoothstep(-0.22, 0.28, _up.dot(delta.normalize()));
      const visibility = eclipseFraction(nav.pos, view.positionUniv, view.spec.radiusRender, blockers);
      totalFlux += flux;
      clearLitFlux += flux * directDay;
      litFlux += flux * directDay * (0.08 + visibility * 0.92);
    }
    day = totalFlux > 0 ? clamp(litFlux / totalFlux, 0, 1) : 0;
    envEclipse = clearLitFlux > 0 ? clamp(1 - litFlux / clearLitFlux, 0, 1) : 0;
    // Camera visibility drives exposure only. Passing it into the planet's
    // light field darkens every world point when the camera enters an umbra,
    // and applies eclipse extinction twice in shaders with local occlusion.
    p.setStellarLights?.(universe.system.stellarLightFieldFrom(p.posUniv));
    // Planet-wide eclipse lighting is evaluated at each surface sample. The
    // camera scalar above remains useful for exposure, but must never darken
    // the whole globe or masquerade as a screen-space satellite decal.
    const eclipseStar = universe.system.dominantStarFrom(p.posUniv);
    const eclipseStarOffset = _v3.copy(eclipseStar.positionUniv).sub(p.posUniv);
    const eclipseStarDistance = Math.max(1, eclipseStarOffset.length());
    const eclipseStarDirection = eclipseStarOffset.multiplyScalar(1 / eclipseStarDistance);
    const eclipseStarAngle = Math.asin(clamp(
      eclipseStar.spec.radiusRender / eclipseStarDistance, 0, 0.999999));
    let eclipseBody = null;
    let eclipseScore = Infinity;
    for (const body of universe.system.planets) {
      if (body === p) continue;
      const offset = _v2.copy(body.posUniv).sub(p.posUniv);
      const along = offset.dot(eclipseStarDirection);
      if (along <= body.R || along >= eclipseStarDistance) continue;
      const perpendicular = _v.copy(offset)
        .addScaledVector(eclipseStarDirection, -along).length();
      const reach = p.R + body.R + along * eclipseStarAngle;
      if (perpendicular > reach) continue;
      const score = (perpendicular - body.R - along * eclipseStarAngle) / p.R;
      if (score < eclipseScore) {
        eclipseScore = score;
        eclipseBody = {
          centerLocal: p.worldOffsetToLocal(offset, _v4),
          radius: body.R,
          starAngularRadius: eclipseStarAngle,
        };
      }
    }
    if (DEV_SERVER && p.devEclipseFixture) {
      const fixture = p.devEclipseFixture;
      const tangent = _v.copy(eclipseStarDirection)
        .cross(Math.abs(eclipseStarDirection.y) < 0.9
          ? _v5.set(0, 1, 0) : _v5.set(1, 0, 0)).normalize();
      const centerWorld = _v2.copy(eclipseStarDirection)
        .multiplyScalar(fixture.distance)
        .addScaledVector(tangent, fixture.offset || 0);
      eclipseBody = {
        centerLocal: p.worldOffsetToLocal(centerWorld, _v4),
        radius: fixture.radius,
        starAngularRadius: fixture.starAngularRadius ?? eclipseStarAngle,
      };
    }
    p.setEclipseOccluder?.(eclipseBody);
    p.setStellarOccluders?.(DEV_SERVER && p.devEclipseFixture ? [eclipseBody]
      : selectStellarOccluders(p, universe.system.planets, universe.system.starViews));
    const sunElev = _up.dot(sunDir);

    const transitOffset = _v2.copy(nav.pos).sub(p.posUniv);
    const transit = p.cloudTransit && Number.isFinite(transitOffset.lengthSq()) ? p.cloudTransit(transitOffset) : 0;
    const weatherDirection = p.worldOffsetToLocal?.(_up, _v3).normalize() || _up;
    activeWeather = p.weatherAt?.(weatherDirection) || null;
    const eyeWater = p.sampleWaterSurface?.(p.worldPositionToLocal(nav.pos, _v2),
      p.weatherHours, { normal: false });
    envUnderwater = !!eyeWater?.wet && eyeWater.clearance < (wasUnderwater ? 0.12 : -0.08);
    updateEnvironmentState(environmentState, {
      // The gas column is referenced to the body's datum, not the seabed.
      // Ground clearance made sea-level sunset radiance fade over deep ocean.
      cameraHeight: nav.pos.distanceTo(p.posUniv) - p.R,
      atmosphereHeight: p.atmoHeight,
      atmosphereDensity: p.atmoDensity,
      solarElevation: sunElev,
      eclipse: envEclipse,
      cloudDensity: transit,
      underwater: envUnderwater,
      dt,
    });
    inAtmo = environmentState.atmosphere;
    day = environmentState.day;
    envSunset = environmentState.sunset;
    skyOvercast = 0;

    // skyColor/liquidColor come from `new THREE.Color(hex)`, which already
    // decodes sRGB into the linear working space. The `Lin` copies exist only
    // so the per-frame path does not clone; they must not re-decode.
    if (!p.skyColorLin) p.skyColorLin = p.skyColor.clone();
    skyStrength = environmentState.skyIrradiance * 0.92;
    _sky.copy(p.skyColorLin).multiplyScalar(skyStrength);
    _sky.lerp(_warmA.setRGB(1.0, 0.14, 0.018)
      .multiplyScalar(Math.max(skyStrength, 0.14)), clamp(envSunset * 0.9, 0, 1));

    // Global FogExp2 no longer impersonates the atmosphere. The atmospheric
    // shells own transmittance + in-scattering; scene fog is strictly local.
    let fogDensity = 0;
    // Do not turn cloud proximity into global screen fog. The WebGPU volume
    // integrates extinction only along rays that actually cross vapour and
    // clips those rays against opaque scene depth. The old FogExp2 shortcut
    // was the abrupt blue/white pseudo-loading screen during descent.
    if (activeWeather && nearestAlt < p.atmoHeight * 0.24) {
      const surfaceAir = 1 - smoothstep(p.atmoHeight * 0.04, p.atmoHeight * 0.24,
        Math.max(0, nearestAlt));
      const weatherFog = (activeWeather.fog * 0.00022
        + activeWeather.precipitation * 0.00008) * surfaceAir;
      fogDensity = Math.max(fogDensity, weatherFog);
      const overcast = clamp(activeWeather.coverage * 0.42
        + activeWeather.precipitation * 0.36, 0, 0.72);
      skyOvercast = overcast;
      _sky.lerp(_cloudCol.setRGB(0.42, 0.48, 0.58)
        .multiplyScalar(0.16 + day * 0.52), overcast);
    }

    if (envUnderwater) {
      if (!p.liquidColorLin) p.liquidColorLin = p.liquidColor.clone();
      _sky.copy(p.liquidColorLin).multiplyScalar(0.25 + 0.55 * day);
      if (p.liquid === 'lava') _sky.set(1.2, 0.25, 0.02);
      fogDensity = p.liquid === 'lava' ? 0.2 : 0.03;
      skyStrength = 1;
    }

    scene.fog.color.copy(_sky);
    scene.fog.density = fogDensity;
    // Cloud ambient (uAmbC) intentionally stays at its construction-time value
    // (skyColor × 0.58). The rewrite-era per-frame override below darkened the
    // volume clouds toward black in orbit and night-side views; the legacy
    // WebGL contract keeps a fixed neutral skylight, matching 51c7c11.

    // valley mist tracks the live fog/sky tint (sunset mist comes free)
    const tsh = p.terrainMaterial.userData.shader;
    if (tsh && tsh.uniforms.uMistColor) {
      tsh.uniforms.uMistColor.value.copy(_sky).multiplyScalar(1.06);
    }

    // Cool sky irradiance preserves the silhouette on the night side without
    // washing the whole planet with a global ambient light.
    const clearSpace = 1 - Math.max(0, inAtmo);
    hemi.intensity = (0.055 + (1 - day) * 0.06) * clearSpace
      + Math.sqrt(Math.max(0, inAtmo)) * (0.018
        + day * environmentState.directTransmittance * 0.36
        + environmentState.skyIrradiance * 0.18
        + envSunset * 0.11);
    hemi.color.copy(p.skyColorLin || _sky)
      .lerp(_warmC.setRGB(0.72, 0.24, 0.16), envSunset * 0.42);
    hemi.groundColor.copy(p.pal.land[Math.min(2, p.pal.land.length - 1)].c);

    // the sky dome: horizon glow, deeper zenith, sun halo
    _horC.copy(p.skyColorLin).lerp(_warmB.setRGB(1.08, 0.105, 0.018),
      clamp(envSunset * 0.82, 0, 1));
    _c2.copy(p.skyColorLin).multiply(_zenithMul)
      .lerp(_warmA.setRGB(0.12, 0.018, 0.07), envSunset * 0.5);
    if (skyOvercast > 0.01) {
      _horC.lerp(_cloudCol.setRGB(0.24, 0.27, 0.33), skyOvercast * 0.72);
      _c2.lerp(_cloudCol.setRGB(0.09, 0.105, 0.14), skyOvercast * 0.82);
    }
    p.setWaterEnvironment?.(_c2, _horC, day, envSunset);
    // This dome only paints background pixels; it never overlays terrain.
    // The volume shell still owns aerial perspective and limb scattering,
    // while this low-frequency term restores a readable zenith below it.
    const altitudeFraction = nearestAlt / Math.max(p.atmoHeight, 1);
    const skyBackdrop = envUnderwater ? 0
      : clamp(Math.min(inAtmo, 1) * (0.08 + 0.92 * day) * 0.42
        + envSunset * 0.28, 0, 0.72);
    skyDome.update(_up, sunDir, _horC, _c2, skyBackdrop, envSunset,
      smoothstep(0.28, 0.72, altitudeFraction), p.stellarLightField);
  } else {
    hemi.intensity = 0.035;
    hemi.color.setRGB(0.18, 0.24, 0.38);
    hemi.groundColor.setRGB(0.035, 0.045, 0.07);
    envSunset = 0;
    skyOvercast = 0;
    updateEnvironmentState(environmentState, { dt });
    skyDome.update(_up, _up, _sky, _sky, 0, 0);
  }
  // Space is always the clear background. Sky colour is rendered only by
  // atmospheric scattering, so crossing a shell can never replace the whole
  // framebuffer with opaque blue.
  renderer.setClearColor(0x000000);
  renderer.setClearAlpha(0);
  universe.setStarDimming(clamp(inAtmo * day * 0.92, 0, 1));
  // a horizon sun seen through air dims and reddens — otherwise sunsets are
  // a white bloom explosion swallowing a third of the sky
  universe.setSunExtinction(nearest
    ? clamp(envSunset + (1 - environmentState.directTransmittance) * 0.18, 0, 1) : 0);
  // candela-scale: with physical decay, ~2 units of intensity is invisible —
  // a real lamp needs tens of candela to paint a pool on the ground
  headlamp.intensity = devHeadlampEnabled && state === 'walk' && day < 0.4
    ? (0.4 - day) * 80 : 0;
  const atmosphereRoot = Math.sqrt(Math.max(0, inAtmo));
  ambient.intensity = (0.045 + (1 - day) * 0.035) * (1 - atmosphereRoot)
    + atmosphereRoot * (0.012 + day * 0.153 + envSunset * 0.038);
  envInAtmo = inAtmo;
  envDay = day;
  // hand the sun over to the shadow-casting light near the ground
  const shadowSurfaceAlt = nearest?.hasLiquid
    ? Math.min(nearestAlt, Math.max(0, nav.pos.distanceTo(nearest.posUniv) - nearest.seaRadius))
    : nearestAlt;
  shadowBlend = nearest ? 1 - smoothstep(3200, 7200, shadowSurfaceAlt) : 0;
  if (nearest && shadowBlend > 0) sunDirCam.copy(nearest.sunDirWorld);
  if (RENDER_LOOK_NEXT) {
    const radianceMode = state === 'shipwalk' || shipView.shipwalk ? 'interior'
      : shipView.isCockpit() ? 'cockpit'
        : nearest ? 'planet' : 'space';
    const stellarField = nearest?.stellarLightField
      || universe.system.stellarLightFieldFrom(nav.pos);
    sceneRadiance.update(dt, {
      environment: environmentState,
      stellarField,
      mode: radianceMode,
    });
    // IBL now owns the low-frequency fill. Reduce the old unoccluded scene
    // lights so terrain and engineering assets keep form instead of receiving
    // the same flat blue pedestal from every direction.
    ambient.intensity *= 0.72;
    hemi.intensity *= 0.82;
    renderer.toneMappingExposure = sceneRadiance.exposure;
    ship.updateLighting(sceneRadiance);
    ship.updateAmbient(environmentState,
      nearest ? _v.copy(nav.pos).sub(nearest.posUniv).normalize() : null,
      nearest ? nearest.R / Math.max(nearest.R, nav.pos.distanceTo(nearest.posUniv)) : 0);
    surfaceWeapons.updateLighting(sceneRadiance, environmentState,
      nearest ? _v.copy(nav.pos).sub(nearest.posUniv).normalize() : null);
  } else {
    renderer.toneMappingExposure = environmentState.exposure;
    shipSunDir.copy(nearest?.sunDirWorld || universe.system.sunDirFrom(nav.pos, _v));
    ship.updateSun(shipSunDir, clamp(day + 0.08, 0, 1));
    surfaceWeapons.updateLighting({
      sources: [{ direction: shipSunDir, color: new THREE.Color(1, 0.94, 0.82), irradiance: 1 }],
      directScale: 1, environmentIntensity: 0,
    }, environmentState, nearest ? _v.copy(nav.pos).sub(nearest.posUniv).normalize() : null);
  }
  // DEV optical A/B owns only the output exposure while held. The normal
  // radiance controller continues updating above and resumes on release.
  if (DEV_SERVER && devWaterWakeFixture?.held
    && Number.isFinite(devWaterWakeFixture.heldExposure)) {
    renderer.toneMappingExposure = devWaterWakeFixture.heldExposure;
  }
}
const shipSunDir = new THREE.Vector3();

let waterWakeTimer = 0;
let previousWaterSeconds = null;
let footRippleTimer = 0;
let devWaterWakeFixture = null;
let waterContact = 0;
let waterSurfaceHeight = Infinity;
let waterTangentSpeed = 0;
const waterLocal = new THREE.Vector3();
const waterVelocity = new THREE.Vector3();
const waterWakePoint = new THREE.Vector3();
const waterShipCenter = new THREE.Vector3();
const waterShipWorld = new THREE.Vector3();
const waterWakeSide = new THREE.Vector3();

function updateDevWaterWakeFixture() {
  if (!DEV_SERVER || !devWaterWakeFixture) return;
  const fixture = devWaterWakeFixture;
  const elapsed = (performance.now() - fixture.startedAt) / 1000;
  if (elapsed > fixture.duration) {
    if (fixture.clockWasFrozen !== undefined) celestialClock.frozen = fixture.clockWasFrozen;
    devWaterWakeFixture = null;
    return;
  }
  const travelTime = Math.max(0, elapsed - fixture.settleTime);
  const movementSpeed = fixture.muted || fixture.held ? 0 : fixture.speed;
  fixture.direction.copy(fixture.origin)
    .addScaledVector(fixture.tangent, travelTime * movementSpeed / fixture.planet.R).normalize();
  fixture.motion.copy(fixture.tangent)
    .addScaledVector(fixture.direction, -fixture.tangent.dot(fixture.direction)).normalize();
  fixture.planet.localPositionToWorld(
    fixture.direction.clone().multiplyScalar(
      fixture.planet.seaRadius + fixture.height + (fixture.cameraToKeel || 0),
    ), nav.pos);
  fixture.planet.localOffsetToWorld(fixture.motion.clone()
    .multiplyScalar(travelTime > 0 || fixture.muted ? fixture.speed : 0), nav.vel);
  nav.quat.copy(fixture.planet.frameOrientation)
    .multiply(horizonQuat(fixture.direction, fixture.motion, fixture.rotation));
  // Keep enough horizon in the normal chase composition to show that the
  // pressure field begins at the stern and opens across the surface. The
  // former near-nadir fixture camera hid that attachment point behind the
  // foreground hull and turned both shoulders into unrelated white stamps.
  nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), fixture.height > 15 ? -0.22 : -0.34));
}

function updateWaterInteraction(dt) {
  const seconds = oceanSeconds(celestialClock.hours);
  if (oceanClockJumped(previousWaterSeconds, seconds, dt) || timeWarp) {
    waterInteraction.clear();
    waterWakeTimer = 0;
  }
  previousWaterSeconds = seconds;
  if (!devWaterWakeFixture?.held) waterInteraction.update(dt);
  waterContact = 0;
  waterSurfaceHeight = Infinity;
  waterTangentSpeed = 0;
  const p = nearest;
  if (!p?.hasLiquid || (p.liquid !== 'water' && p.liquid !== 'toxic')) {
    waterInteraction.setPlanet(null);
    return;
  }
  waterInteraction.setPlanet(p.seed);
  if (timeWarp) return;
  p.worldPositionToLocal(nav.pos, waterLocal);
  // The visible hull is a real camera-relative transform, not the camera
  // origin. Sample its centre and keel so wake contact agrees with the ship
  // the player sees skimming the surface.
  waterShipWorld.copy(nav.pos).add(ship.group.position);
  p.worldPositionToLocal(waterShipWorld, waterShipCenter);
  const hullSurface = p.sampleWaterSurface(waterShipCenter, p.weatherHours, { normal: false });
  const hullHeight = hullSurface?.wet ? hullSurface.clearance - 2.4 : Infinity;
  const waterHeight = (state === 'space' || state === 'flyto')
    ? hullHeight : (p.sampleWaterSurface(waterLocal, p.weatherHours, { normal: false })?.clearance ?? Infinity);
  waterSurfaceHeight = waterHeight;

  if ((state === 'space' || state === 'flyto') && waterHeight > -8 && waterHeight < 38) {
    p.worldOffsetToLocal(nav.vel, waterVelocity);
    _up.copy(waterShipCenter).normalize();
    waterVelocity.addScaledVector(_up, -waterVelocity.dot(_up));
    const tangentSpeed = waterVelocity.length();
    waterTangentSpeed = tangentSpeed;
    waterContact = smoothstep(18, 180, tangentSpeed) * (1 - smoothstep(4, 38, waterHeight));
    waterWakeTimer -= dt;
    if (waterContact > 0.03 && waterWakeTimer <= 0
      && !devWaterWakeFixture?.muted && !devWaterWakeFixture?.held) {
      waterWakeTimer = lerp(0.14, 0.045, clamp(tangentSpeed / 450, 0, 1));
      waterVelocity.normalize();
      // Pressure is deposited below the actual wet hull footprint, never at
      // a camera ray hit hundreds of metres away. Close skimming and the
      // diminishing low-flight propulsion downwash share this surface field;
      // clearance above the water is not claimed as physical keel contact.
      // Store its base-sphere coordinate because GLSL evaluates that same
      // undisplaced coordinate before applying the visible ocean surface.
      waterShipCenter.copy(hullSurface.direction).multiplyScalar(p.seaRadius);
      waterWakeSide.crossVectors(_up, waterVelocity).normalize();
      const strength = 0.25 + waterContact * 0.75;
      // One centreline pressure source per age produces the physical Kelvin
      // pair in the shader. The former two lateral sources each generated a
      // second mirrored pair, creating four thin luminous rails rather than a
      // coherent hull-width wake.
      waterWakePoint.copy(waterShipCenter)
        .addScaledVector(waterVelocity, 2.5)
        .normalize().multiplyScalar(p.seaRadius);
      waterInteraction.inject(waterWakePoint, {
        strength: strength * 0.82,
        speed: 7 + tangentSpeed * 0.012,
        foam: 0.34 + waterContact * 0.48,
        direction: waterVelocity,
        kind: 'wake',
      });
    }
  } else if (state === 'walk' && walkCtl.planet === p) {
    // posLocal is the eye, so subtract the controller's actual eye height.
    // The old hard-coded 1.45 m left the sampled "feet" 25 cm in the air and
    // made a 0.9 m wade report negative depth, suppressing every foot ripple.
    const feetRadius = walkCtl.posLocal.length() - walkCtl.eyeHeight + 0.08;
    const footSurface = p.sampleWaterSurface(walkCtl.posLocal, p.weatherHours, { normal: false });
    const waterDepth = footSurface?.wet ? footSurface.surfaceRadius - feetRadius : 0;
    const speed = walkCtl.hSpeed.length();
    const immersion = smoothstep(0.02, 0.3, waterDepth)
      * (1 - smoothstep(2.2, 4.5, waterDepth));
    const movingContact = immersion * smoothstep(0.02, 0.65, speed);
    waterContact = immersion;
    footRippleTimer -= dt;
    if (movingContact > 0.03 && footRippleTimer <= 0) {
      footRippleTimer = clamp(0.48 / Math.max(0.7, speed), 0.16, 0.48);
      _up.copy(walkCtl.posLocal).normalize();
      waterWakePoint.copy(_up).multiplyScalar(p.seaRadius);
      waterInteraction.inject(waterWakePoint,
        { strength: 0.22 + movingContact * 0.62, speed: 4.4 + speed, foam: movingContact * 0.55 });
    }
  }
}

let surfacePressureTimer = 0;
// metres: trees inside a landing scar are blown radially outward and cleared
// beneath the hull/ramp pad; grass leans ~1.6x further out.
const LANDING_SCAR_RADIUS = 26;
const DOWNWASH_RADIUS = 30;
const HOVER_DOWNWASH_ALT = 45;

function groundPointUnder(planet, local, out) {
  _up.copy(local).normalize();
  return out.copy(_up).multiplyScalar(planet.surfaceRadius(_up));
}

const downwashPoint = new THREE.Vector3();
function updateSurfaceInteraction(dt) {
  surfaceInteraction.update(dt);
  vegetationDisturbance.update(dt);
  const p = nearest;
  if (!p || p.isGasGiant || p.type === 'artificialHabitat') {
    surfaceInteraction.setPlanet(null);
    vegetationDisturbance.setPlanet(null);
    return;
  }
  surfaceInteraction.setPlanet(p.bodyId || p.seed);
  vegetationDisturbance.setPlanet(p.bodyId || p.seed);
  // a ship hovering low pushes everything beneath it away
  if (state === 'space' && nearestAlt < HOVER_DOWNWASH_ALT) {
    groundPointUnder(p, p.worldPositionToLocal(nav.pos, downwashPoint), downwashPoint);
    const k = 1 - nearestAlt / HOVER_DOWNWASH_ALT;
    vegetationDisturbance.setDownwash(downwashPoint, DOWNWASH_RADIUS, k * k);
  }
  surfacePressureTimer -= dt;
  if (surfacePressureTimer > 0) return;
  p.worldPositionToLocal(nav.pos, waterWakePoint);
  _up.copy(waterWakePoint).normalize();
  waterWakePoint.copy(_up).multiplyScalar(p.surfaceRadius(_up));
  if (state === 'walk' && walkCtl.hSpeed.length() > 0.18) {
    surfacePressureTimer = 0.11;
    surfaceInteraction.inject(waterWakePoint, 1.65, 0.9, 1.25);
  } else if (state === 'space' && nearestAlt < 24 && nav.vel.length() > 18) {
    surfacePressureTimer = 0.09;
    surfaceInteraction.inject(waterWakePoint, 8.5, 0.82, 0.72);
  }
}

// ---- main loop --------------------------------------------------------------------
const clock = new THREE.Clock();
let statAcc = 0;
let devFpsElapsed = 0;
let devFpsFrames = 0;
let perfEmaMs = 16.7;
let adaptiveStage = 0;
let adaptiveQualityLocked = false;
let adaptiveStableSince = 0;
const ADAPTIVE_TARGET_FRAME_MS = QUALITY_LOW ? 21.5 : QUALITY_PROFILE.id === 'balanced' ? 17.5 : 16.67;
const frameGpuTimer = new FrameGpuTimer(renderer);
const adaptiveGovernor = new AdaptiveQualityGovernor({
  targetFrameMs: ADAPTIVE_TARGET_FRAME_MS,
  maxStage: 5,
  initialNow: performance.now(),
});
const presentedFrames = new PresentedFrameStats({initialTime:performance.now()});
let latestRenderCalls = 0;
let latestRenderTriangles = 0;

function performanceSnapshot() {
  return presentedFrames.snapshot();
}

function resetPerformanceStats() {
  presentedFrames.reset(performance.now(),{paused});
  perfEmaMs = 16.7;
  return true;
}

function resetAdaptiveQuality() {
  const now = performance.now();
  adaptiveStableSince = now;
  frameGpuTimer.reset();
  adaptiveGovernor.reset(now);
  applyAdaptiveStage(0);
  setRenderDpr(computeCeilingDpr());
  return true;
}

function setShadowDistance(distance) {
  effectiveShadowDistance = distance;
  sunShadow.shadow.camera.left = sunShadow.shadow.camera.bottom = -distance;
  sunShadow.shadow.camera.right = sunShadow.shadow.camera.top = distance;
  sunShadow.shadow.camera.updateProjectionMatrix();
}

function applyAdaptiveStage(stage) {
  adaptiveStage = clamp(Math.round(stage), 0, 5);
  effectiveWaterReflectionHz = QUALITY_PROFILE.waterReflectionHz
    * (adaptiveStage >= 2 ? 0.5 : 1);
  // Scale internal cloud raymarch buffer without modifying MARCH_STEPS define
  // (avoids any mid-flight shader recompilation).
  if (nodePipeline.cloudPass && QUALITY_PROFILE.liteClouds) {
    const cloudScaleFactor = adaptiveStage >= 3 ? 0.76 : adaptiveStage >= 1 ? 0.88 : 1.0;
    const scale = QUALITY_PROFILE.liteClouds.scale * cloudScaleFactor;
    nodePipeline.cloudPass.setQuality({ scale });
    portalView?.pipeline?.cloudPass?.setQuality({ scale });
  }
  const adaptiveGrassScale = adaptiveStage >= 5 ? 0.52 : adaptiveStage >= 2 ? 0.76 : 1;
  scatter.setGrassDensity(QUALITY_PROFILE.grassDensity * adaptiveGrassScale);
  setShadowDistance(QUALITY_PROFILE.shadowDistance * (adaptiveStage >= 5 ? 0.62 : adaptiveStage >= 2 ? 0.80 : 1));
  farFlora.setDisplayDensity(adaptiveStage >= 5 ? 0.48 : adaptiveStage >= 3 ? 0.72 : 1);
  const ceilingDpr = computeCeilingDpr();
  if (adaptiveStage >= 5) {
    setRenderDpr(Math.max(0.85, QUALITY_PROFILE.dprMin));
  } else if (adaptiveStage >= 4) {
    setRenderDpr(Math.max(QUALITY_PROFILE.dprMin, ceilingDpr - 0.08));
  } else {
    setRenderDpr(ceilingDpr);
  }
}

// The simulation can advance while the previous GPU frame is in flight. Every
// ordinary auxiliary draw shares the main graph's admission and final fence.
// Startup may submit only its private warm draw, before the world graph is ready.
const rigidWorldObjects = new Map();
function renderWorldFrame() {
  let rendered = false;
  nodePipeline.submitFrame((draw) => {
    renderer.info.reset();
    surfaceWeapons.prepareLighting();
    renderRiftPortal();
    surfaceWeapons.renderScopeView(renderer);
    finishSurfaceBootstrap();
    if (pipelineResizePending && !pipelineResourcesBusy()) sizePost();
    if (!surfacePipelinesReady || shipPipelineWarmPending) {
      nodePipeline.primeCloudPrograms?.({ origin: nav.pos });
      return;
    }
    bloomPass.enabled = usePost && !QUALITY_LOW;
    if (gradePass_) {
      gradePass_.enabled = usePost && !QUALITY_LOW;
      gradePass_.uniforms.uTime.value = DEV_SERVER && devWaterWakeFixture?.held
        ? devWaterWakeFixture.heldGradeTime : clock.elapsedTime;
    }
    warpConduit.renderLowFog(renderer, camera);
    rigidWorldObjects.set(ship.group, ship.foregroundOnly ? foregroundPass : nodePipeline.renderPass);
    rendered = draw({ origin: nav.pos, context: universe.system, timeEpoch: celestialClock.epoch,
      rigidObjects: rigidWorldObjects });
  });
  return rendered;
}

function frame(rafTs) {
  requestAnimationFrame(frame);
  const frameCpuStart = performance.now();
  cloudResourceManager.tickFrame();
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
  // The map owns an opaque full-screen WebGL surface and its own RAF. Rendering
  // the universe underneath doubled GPU work for pixels nobody could see.
  if (starMap?.isOpen) {
    presentedFrames.suspend(performance.now());
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
    if (riftRoute && !riftRoute.arrived) {
      riftEntranceUniv.add(_v);
      prevNavPos.add(_v);
    }
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
        if (riftRoute && !riftRoute.arrived) {
          riftEntranceUniv.sub(referenceBody.posUniv).applyQuaternion(dq).add(referenceBody.posUniv);
          riftOrientation.premultiply(dq);
          prevNavPos.sub(referenceBody.posUniv).applyQuaternion(dq).add(referenceBody.posUniv);
        }
      }
    }
  }
  if (ship.parkedPlanet && universe.planets().includes(ship.parkedPlanet)
      && ship.parkedLocal && ship.parkedPosUniv && !ship.orbitalStandby) {
    ship.parkedPlanet.localPositionToWorld(ship.parkedLocal, ship.parkedPosUniv);
    ship.parkedQuat.copy(ship.parkedPlanet.frameOrientation).multiply(ship.parkedLocalQuat);
  }
  if (paused && state === 'walk' && walkCtl.planet && universe.planets().includes(walkCtl.planet)) {
    walkCtl.planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(walkCtl.planet.frameOrientation).multiply(walkCtl.quat);
  } else if (paused && state === 'skydive' && skydiveCtl.active && skydiveCtl.planet
      && universe.planets().includes(skydiveCtl.planet)) {
    skydiveCtl.planet.localPositionToWorld(skydiveCtl.posLocal, nav.pos);
    nav.quat.copy(skydiveCtl.planet.frameOrientation).multiply(skydiveCtl.quat);
  }

  // nearest body & altitude
  nearest = state === 'walk' && walkCtl.planet ? walkCtl.planet
    : state === 'skydive' && skydiveCtl.planet ? skydiveCtl.planet
    : (state === 'landed' || state === 'shipwalk' || state === 'landing' || state === 'takeoff')
      && ship.parkedPlanet && universe.planets().includes(ship.parkedPlanet)
      ? ship.parkedPlanet : null;
  // A black-hole destination is a compact object, not a planet: it has no
  // terrain frame and must never become the flight reference body.
  if (state === 'warp' && typeof warpRevealBody?.altitudeAt === 'function') nearest = warpRevealBody;
  if (!nearest) nearest = nearestPublishedBody(universe.planets(), nav.pos);
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
    // Planet approach cap. A pulse never injects velocity (it displaces the
    // ship and hands back the exact pre-pulse velocity), so the cap needs no
    // post-pulse settle window any more.
    const safeInwardBase = 55 + Math.pow(Math.max(0, nearestAlt), 0.75) * 0.6;
    const approachLimit = pulseBurst ? safeInwardBase * 1.18 : safeInwardBase;
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
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), approachLimit, 0);
    }
    flightStepStart.copy(nav.pos);
    spaceCtl.update(dt);
    if (pulseBurst?.charging) {
      // Holding: the fold waits just before the jump while the charge builds.
      pulseBurst.holdTime += dt;
      pulseBurst.elapsed = Math.min(PULSE_TIMING.hold, pulseBurst.elapsed + dt);
      pulseBurst.charge = Math.min(pulseChargeFromHold(pulseBurst.holdTime), affordablePulseCharge());
      audio.pulseCharge?.(pulseBurst.charge);
      if (!keys.Space) releasePulseCharge();
    } else if (pulseBurst) {
      // A fold, not a sprint: almost all of the distance is covered inside the
      // short window where the starflow is longest (see transit.js).
      pulseBurst.elapsed += dt;
      pulseBurst.charge = Math.max(0, pulseBurst.charge - dt * 4.5);
      const progress = pulseDisplacement(pulseBurst.elapsed);
      nav.pos.addScaledVector(pulseBurst.direction,
        pulseBurst.distance * Math.max(0, progress - pulseBurst.progress));
      pulseBurst.progress = progress;
      if (pulseBurst.elapsed >= PULSE_TIMING.total) pulseBurst = null;
      pulseActive = !!pulseBurst;
    }
    if (nearest) {
      _v.copy(nav.pos).sub(nearest.posUniv);
      const centerDistance = _v.length();
      const radialOut = _v.multiplyScalar(1 / Math.max(centerDistance, 1));
      const forward = _v2.set(0, 0, -1).applyQuaternion(nav.quat);
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), approachLimit, dt);
    }
    if (riftRoute && !riftRoute.anchorLocked && !riftRoute.arrived && riftPortal.shape === 'plane') {
      // Keep the opening in view on an early approach. Brake only the incoming
      // component, allowing the pilot to steer away or reverse at any time.
      const normal = _v2.set(0, 0, 1).applyQuaternion(riftOrientation);
      const startZ = _v.copy(flightStepStart).sub(riftEntranceUniv).dot(normal);
      const endZ = _v.copy(nav.pos).sub(riftEntranceUniv).dot(normal);
      const standOff = .48 * riftRoute.reach;
      if (endZ < startZ && startZ > 0 && endZ < standOff * 1.6) {
        const local = _v.subVectors(nav.pos, riftEntranceUniv).applyQuaternion(_q.copy(riftOrientation).invert());
        if (Math.hypot(local.x / riftPortal.halfWidth, local.y / riftPortal.halfHeight) < 1.2) {
          const allowed = Math.max(0, startZ - standOff) * (1 - Math.exp(-3*dt));
          const excess = Math.max(0, startZ - endZ - allowed);
          nav.pos.addScaledVector(normal, excess);
          nav.vel.addScaledVector(normal, Math.min(excess / Math.max(dt, .001), Math.max(0, -nav.vel.dot(normal))));
        }
      }
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
    const nearBh = nearbyBlackHole();
    if (nearBh) {
      _v.copy(nav.pos).sub(nearBh.posUniv);
      const bhDist = _v.length();
      const minSafeRadius = nearBh.R * 2.85;
      if (bhDist < minSafeRadius) {
        if (bhDist < 1) _v.set(0, 0.25, 1);
        _v.normalize();
        nav.pos.copy(nearBh.posUniv).addScaledVector(_v, minSafeRadius * 1.06);
        nav.vel.addScaledVector(_v, Math.max(1800, -nav.vel.dot(_v) + 1800));
        ui.setHint('时空曲率临界 · 引力护航强制脱离光子球', true);
        cancelPulseBurst();
      }
    }
  } else if (!paused && state === 'landed') {
    if (landedRequireKeyRelease && !keys.KeyW && !keys.Space) landedRequireKeyRelease = false;
    if (!landedRequireKeyRelease && shipView.seatT >= 1 && (keys.KeyW || keys.Space)) {
      launchParkedShip();
    }
  } else if (!paused && state === 'shipwalk') {
    // Interior walk: flight input is locked (spaceCtl disabled); while
    // airborne the hull keeps drifting on its standing velocity — the demo's
    // behaviour — and a parked hull stays put with the pad.
    shipView.integrateDrift(dt, nav);
  } else if (!paused && state === 'skydive') {
    cancelPulseBurst();
    skydiveCtl.update(dt);
    if (skydiveCtl.active && skydiveCtl.planet) {
      skydiveCtl.planet.localPositionToWorld(skydiveCtl.posLocal, nav.pos);
      nav.quat.copy(skydiveCtl.planet.frameOrientation).multiply(skydiveCtl.quat);
    }
  } else if (!paused && state === 'walk') {
    cancelPulseBurst();
    walkCtl.update(dt);
    walkCtl.planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(walkCtl.planet.frameOrientation).multiply(walkCtl.quat);
    tryEnterShipFromRamp();
  }
  // Export parked-seat and interior-walk nav BEFORE stepTweens, LOD, scatter,
  // farFlora and ambience read nav.pos; otherwise planetary orbital motion
  // (~300–650 m/frame at 60x cosmic time) leaves vegetation and terrain one
  // frame behind the rendered camera, misclassifying nearby trees into 8.5x
  // far foliage cards that slice through the cabin and dither-flicker with dt.
  const shipLanded = !ship.orbitalStandby && !!ship.parkedPosUniv && ship.parkAmt > 0.98;
  shipView.tick(paused ? 0 : dt, {
    nav,
    landed: shipLanded,
    seatedOnPad: state === 'landed',
    planet: ship.parkedPlanet,
  });
  if (!skydiveCtl.active && skydiveCtl.rig) {
    skydiveCtl.showRampPose(state === 'shipwalk' && shipView.shipwalk && shipView.seatT >= 1 && ship.hoverMode === 'high'
      ? shipView.rampPush : 0, ship.parkedPlanet, nav, nearestAlt);
  }
  if (state === 'shipwalk' && shipView.pendingSurfaceExit && !paused) {
    handOffRampExitToSurface();
  } else if (state === 'shipwalk' && !shipView.shipwalk && !paused) {
    if (shipLanded) {
      landedRequireKeyRelease = Boolean(keys.KeyW || keys.Space);
      setState('landed');
    } else {
      setState('space');
    }
  }
  // Gameplay/collision tweens use the bounded simulation delta. The title
  // pull-back is explicitly wall-clock driven, so a temporary shader/LOD long
  // frame cannot stretch a 2.8 s shot into a 13 s apparent freeze.
  stepTweens(dt);
  updateRiftRoute(dt);
  updateDestinationMarker();

  // The ship reactor recharges pulse energy after a short thermal cooldown.
  // Recharge continues while landed so pulse fuel can never become a dead-end
  // resource that requires restarting the session.
  if (DEV_INFINITE_PULSE) {
    pulseFuel = PULSE_FUEL_MAX;
    pulseRechargeDelay = 0;
  } else if (!pulseActive) {
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

  const boostTarget = state === 'space' && !shipView.rmbLookActive()
    && (spaceCtl.boosting || keys.ShiftLeft || keys.ShiftRight) ? 1 : 0;
  boostVisual += (boostTarget - boostVisual) * (1 - Math.exp(-dt * (boostTarget ? 7.5 : 8.5)));
  weaponVisual += ((weaponTrigger ? 1 : 0) - weaponVisual) * (1 - Math.exp(-dt * 16));
  updateTransitChannels(dt);
  if (state === 'warp') {
    // The warp timeline owns the lens outright; it is already continuous.
    camera.fov = BASE_FOV + shipView.fovOffset() + transitChannels.fov;
    camera.updateProjectionMatrix();
  } else if (state === 'skydive') {
    camera.fov += ((BASE_FOV + skydiveCtl.fovOffset()) - camera.fov) * (1 - Math.exp(-dt * 7.5));
    camera.updateProjectionMatrix();
  } else if (state === 'space' || state === 'shipwalk' || state === 'landed' || state === 'landing' || state === 'takeoff') {
    const riftFov = riftRoute && !riftRoute.arrived ? riftPortal.open.flash * 3.0 : 0;
    const fovResponse = pulseBurst || pulseEchoes.length ? 30 : 6.2;
    camera.fov += ((BASE_FOV + shipView.fovOffset() + boostVisual * 6.5 + transitChannels.fov + riftFov) - camera.fov)
      * (1 - Math.exp(-dt * fovResponse));
    camera.updateProjectionMatrix();
  }
  document.body.classList.toggle('weapon-firing', weaponVisual > 0.12);

  // Deterministic development fixture: keep a constant-altitude tangent run
  // long enough for terrain/water LODs and the wake lifecycle to settle.
  updateDevWaterWakeFixture();

  // Refresh altitude against the final post-control / post-tween nav.pos so
  // terrain LOD, scatter, farFlora and ambience never see pre-step coordinates.
  if (nearest) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    nearestAlt = nearest.altitudeAt(_v);
  } else nearestAlt = Infinity;

  // true frame velocity (a warp moves nav.pos directly, not via nav.vel)
  if (frameNo > 2) _velActual.copy(nav.pos).sub(prevNavPos).multiplyScalar(1 / dt);
  // Building may add a final planet, habitats and sites under existing bodies.
  // Keep that entire registered batch hidden until its future WORLD is ready.
  if (deferredWorldPublication && deferredWorldPublication.system !== universe.system) {
    deferredWorldPublication.abandon();deferredWorldPublication = null;lastWorldPublicationSnapshot = null;
  }
  if (state !== 'warp' && performance.now() >= systemBuildResumeAt
      && universe.system && !deferredSystemBuildActive) {
    const system = universe.system;
    while (deferredSystemWarmQueue.length
        && deferredSystemWarmQueue[0].system !== system) deferredSystemWarmQueue.shift();
    if (deferredWorldPublication?.state !== 'build-failed') {
      const queued = deferredWorldPublication ? null : deferredSystemWarmQueue.shift();
      if (deferredWorldPublication || queued || !system.built) void runDeferredSystemPublication(system, queued?.body || null);
    }
  }

  const nearTerrain = nearest && nearestAlt < Math.max(nearest.atmoHeight * 2.4, 90000);
  const heavySurfaceBacklog = nearTerrain && nearest?.lod && pendingChunks(nearest.lod) > 12;
  // In narrow coastal valleys a coarse land triangle can cross the entire
  // channel. Let the shoreline catch up during a high-quality descent.
  const shorelineBacklog = heavySurfaceBacklog && !QUALITY_LOW && nearest.hasLiquid && nearestAlt < 18000;
  const terrainBuildMs=debugBuildBudgetMs || (!loadingCleared
    ? QUALITY_LOW ? 5.5 : 110
    : shorelineBacklog ? 9 : heavySurfaceBacklog ? 4.2 : state === 'walk' ? 2.6 : nearTerrain ? 3.4 : 1.6);
  const waterBuildMs=nearest?.nearWaterPatch?.preferredBudget(nav.pos.distanceTo(nearest.posUniv)-nearest.seaRadius,dt)||0;
  sceneBuildBudget.begin(terrainBuildMs+waterBuildMs+scatter.streamBudgetMs+(FARFLORA?farFlora.streamBudgetMs:0),
    // plants are reserved like terrain: unreserved, a busy terrain frame left
    // them a zero grant and the forest stopped streaming in flight
    {terrain:terrainBuildMs,near:scatter.streamBudgetMs,far:FARFLORA?farFlora.streamBudgetMs:0});
  // Render adapters consume the already-updated simulation frames.
  for (const p of universe.planets()) {
    // While the tunnel owns the frame, only the selected reveal body may
    // request terrain or volume work. Other destination bodies remain valid
    // scene objects but cannot consume frame time merely because the spline
    // crosses their orbit on the way in. The reveal body itself waits for the
    // braking window; before then its full globe is hidden by starflow and even
    // coarse LOD work is wasted frame time.
    if (state === 'warp' && warpRevealBody
        && (p !== warpRevealBody || !warpRevealActive)) continue;
    if (state === 'warp' && p === warpRevealBody && warpRevealCameraOffset) {
      // The spline starts many astronomical units away and approaches from the
      // same authored reveal side. Driving LOD from the instantaneous spline
      // position merges the route-prewarmed shell, then rebuilds it during the
      // final seconds. Keep the selected planet on its exact arrival camera
      // until control is returned to the player.
      _v.copy(warpRevealCameraOffset);
    } else {
      _v.copy(nav.pos).sub(p.posUniv);
    }
    p.lod.startupPriority = !loadingCleared && p === nearest;
    if (p.waterLod) {
      p.waterLod.startupPriority = !loadingCleared && p === nearest;
    }
    // While the loading screen covers the canvas, settle finished LOD morphs
    // without waiting 0.7 s per level of invisible geomorph animation.
    const lodDt = !loadingCleared ? 2.0 : dt;
    p.update(_v, lodDt, p === nearest, FREEZE || photoMode ? 0 : dt,sceneBuildBudget);
    // The destination ocean's first WebGPU production draw can synchronously
    // specialize the full physical water pipeline for nearly a second. During
    // stellar warp the planet is still covered by starflow and atmospheric
    // reveal, so keep only water LOD hidden until the first ordinary space
    // frame. Terrain, atmosphere, clouds and rings remain visible throughout.
    if (state === 'warp' && p === warpRevealBody) p.waterLod?.setVisible(warpRevealActive);
  }
  if (nearest && !nearest.isGasGiant) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    nearest.worldOffsetToLocal(_v, _v);
    // Plant streams always get a small floor. A water-patch overrun on a
    // coastal frame used to leave them a zero grant frame after frame, so the
    // grass ring or the forest stopped filling in until the player stopped.
    sceneBuildBudget.run('near',scatter.streamBudgetMs,
      budget=>scatter.update(nearest?.type === 'artificialHabitat' ? null : nearest, _v, nearestAlt,
        Math.max(budget, PLANT_STREAM_FLOOR_MS)));
    if (scatter.planet) {
      prewarmSurfacePipelines(scatter.planet);
      if (!surfacePipelinesReady) {
        for (const mesh of Object.values(scatter.meshes)) mesh.visible = false;
      }
    }
    if (FARFLORA)sceneBuildBudget.run('far',farFlora.streamBudgetMs,
      budget=>farFlora.update(nearest?.type === 'artificialHabitat' ? null : nearest, _v, nearestAlt,
        Math.max(budget, PLANT_STREAM_FLOOR_MS)));
  } else {
    if (scatter.planet) scatter.clear();
    if (farFlora.planet) farFlora.clear();
  }

  ambience(dt);
  if (nearest && activeWeather && nearestAlt < nearest.atmoHeight * 0.22) {
    setWeatherWind(activeWeather.wind,
      clamp((activeWeather.wind?.speed || 0) / 18, 0.18, 1.8),
      activeWeather.gust || 0);
    const windLocal = _v2.set(
      activeWeather.wind?.x || 0,
      activeWeather.wind?.y || 0,
      activeWeather.wind?.z || 0,
    );
    nearest.localOffsetToWorld(windLocal, _v3);
    const surfaceWeather = envInAtmo * (1 - smoothstep(
      nearest.atmoHeight * 0.04,
      nearest.atmoHeight * 0.22,
      Math.max(0, nearestAlt),
    ));
    const fxWeather = RAIN_OVERRIDE !== null && activeWeather
      ? { ...activeWeather, precipitationKind: 'rain', precipitation: RAIN_OVERRIDE } : activeWeather;
    weatherEffects.update(fxWeather, _up, _v3, clock.elapsedTime, surfaceWeather,
      prepareRainFrame(dt, nearest));
  } else {
    setWeatherWind(null, 0.18, 0);
    weatherEffects.update(null, _up.set(0, 1, 0), _v3.set(1, 0, 0),
      clock.elapsedTime, 0);
  }
  surfaceWeapons.setWetness(weatherEffects.state.rainVisible ? weatherEffects.state.precipitation : 0, dt);
  // Rain is heard on foot; aboard the ship the hull shuts it out.
  audio.weather({
    rain: state === 'walk' && weatherEffects.state.rainVisible ? weatherEffects.state.precipitation : 0,
    lightning: state === 'walk' ? weatherEffects.state.lightning : 0,
  });
  updateSurfaceInteraction(dt);
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

  // land / hover / HALO skydive prompt
  const clearanceForLand = state === 'space' && nearest && !nearest.isGasGiant && nearest.landable !== false
    && nav.vel.length() < 4000
    ? landingClearanceMeters(nearest, nav.pos, nearestAlt)
    : Infinity;
  const overWaterColumn = Boolean(nearest && hasDiveableOcean(nearest)
    && (waterSurfaceHeight < 2
      || (nav.pos.distanceTo(nearest.posUniv) - nearest.seaRadius) < nearestAlt - 1.5));
  const inLowLandBand = clearanceForLand < LANDING_CLEARANCE_METERS && nav.vel.length() < 90;
  const overOpenWater = Boolean(inLowLandBand && overWaterColumn);
  let landPromptCode = 'LAND — walk the surface (L)';
  if (overOpenWater) landPromptCode = 'DIVE — walk the seabed (L)';
  else if (inLowLandBand && !probeCanTripodLand(nearest)) landPromptCode = 'HOVER_RUGGED';
  ui.showLand(!paused && inLowLandBand, landPromptCode);

  if (state === 'walk') {
    if (exteriorRampPrompt()) {
      ui.setHint('', false);
    } else if (recallInFlight) {
      // keep the active fly-in hint while the ship sweeps in overhead
    } else if (ship.orbitalStandby) {
      ui.setHint('飞船正在高空巡弋待命 · 面朝空地按 <b>T</b> 呼叫飞船进场接应', true);
    } else {
      const shipDist = parkedShipDistance();
      if (shipDist <= BOARD_DISTANCE) {
        const modeNote = ship.hoverMode === 'extract' ? '跑上悬停尾舱门登舰' : '走至飞船尾舱按 <b>F</b> 开启舱门登舰';
        ui.setHint(`${modeNote} · 距离 ${Math.max(0, Math.round(shipDist))} m`, true);
      } else {
        ui.setHint(`飞船距离 ${Number.isFinite(shipDist) ? Math.round(shipDist) + ' m' : '未知'} · 面朝空地按 <b>T</b> 呼叫飞船`, true);
      }
    }
  }

  // chunk builds: a per-frame millisecond budget (overridable for slow
  // software-rendered test environments via ?buildms=)
  // Build the opening planet behind the loading mask. Previously the mask was
  // released with only the six root faces present, so the player watched the
  // whole planet change shape for the first seconds of flight. This larger
  // startup budget is bounded by STARTUP_WARM_BUDGET_MS and never applies to
  // interactive frames.
  // High-tier devices can spend a larger slice while the loading mask is up;
  // this finishes the same final orbit mesh sooner instead of deferring work
  // into playable frames. Keep the low tier conservative for integrated GPUs.
  const built = sceneBuildBudget.run('terrain',terrainBuildMs,flushChunkQueue);
  if (built > 0) lastBuildFrame = frameNo;

  ship.updateInterior(paused ? 0 : dt, shipView, ship.telemetry);
  universe.updateRelative(nav.pos);
  camera.position.set(0, 0, 0);
  camera.quaternion.copy(nav.quat);
  // cockpit dressing (free look + throttle shake + rotational sway)
  if (state === 'space' || state === 'warp' || state === 'landed' || state === 'takeoff' || state === 'landing') {
    shipView.applyCockpitLook(camera,
      clamp(boostVisual + nav.vel.length() / 7e5, 0, 1), envInAtmo);
  }
  // Weapons stay cold while paused; surface weapons keep their pose but get no
  // trigger input because dt=0 and the fire state is disconnected upstream.
  activeBolts = paused ? activeBolts : weapons.update(dt, nav, nearest);
  const surfaceShotDistance = state === 'walk' ? surfaceBeamDistance(120) : 120;
  // Survey units patrol the parked ship while you are on its planet (on foot
  // or aboard, when actually landed on the ground); taking off or hovering recalls them.
  if (surveyUnits.materials && ship.parkedPlanet && ship.parkedLocal
    && !ship.hoverMode && !ship.orbitalStandby && !recallInFlight
    && (state === 'walk' || state === 'shipwalk' || state === 'landed')
    && (state !== 'walk' || walkCtl.planet === ship.parkedPlanet)) {
    surveyUnits.deploy(ship.parkedPlanet, ship.parkedLocal);
  } else if (surveyUnits.deployed
    && (!ship.parkedPlanet || ship.hoverMode || ship.orbitalStandby || recallInFlight
      || (state !== 'walk' && state !== 'shipwalk' && state !== 'landed'))) {
    surveyUnits.recall();
  }
  if (surveyUnits.deployed) {
    surveyUnits.update(dt, {
      navPos: nav.pos,
      cameraWorld: camera.getWorldPosition(_rainA),
      cameraQuat: camera.quaternion,
      paused,
    });
  }
  // Walking draws the rifle and leaving walk holsters it; pausing only freezes.
  surfaceWeapons.update(dt, state === 'walk', surfaceShotDistance, {
    paused,
    speed: walkCtl.hSpeed.length(),
    grounded: walkCtl.grounded,
    velY: walkCtl.vR,
    sprinting: walkCtl.running,
    crouching: walkCtl.crouching,
    move: walkCtl.moveInput,
  });
  surfaceGameplay.update(dt, {
    state,
    paused,
    planet: walkCtl.planet || nearest,
    navPos: nav.pos,
    walkCtl,
    ship,
    surfaceWeapons,
    weaponsList: SURFACE_WEAPONS,
    weather: activeWeather,
    rainWetness: surfaceWeapons.wetness,
    sunDirWorld: sunDirCam,
    sunColor: sunShadow.color,
    skyColor: environmentState.skyColor,
  });
  document.body.classList.toggle('surface-ads', state === 'walk' && surfaceWeapons.ads);

  // sun → shadow-light crossfade (after updateRelative, which sets intensities).
  // Keep sunShadow.visible = true at all altitudes so the world program key
  // never flips between orbit and surface; disable shadow.autoUpdate and zero
  // intensity outside surface range so orbit pays zero shadow draw/sample cost.
  sunShadow.visible = true;
  if (shadowBlend > 0.02) {
    if (sunShadow.shadow.mapSize.x !== SHADOW_MAP) {
      sunShadow.shadow.map?.dispose();
      sunShadow.shadow.map = null;
      sunShadow.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    }
    sunShadow.shadow.autoUpdate = true;
    const dominantView = universe.system.dominantStarFrom(nearest?.posUniv || nav.pos);
    const sysLight = dominantView.light;
    sunShadow.intensity = sysLight.intensity * shadowBlend;
    sunShadow.color.copy(sysLight.color);
    // Hysteresis-stabilized 2x octave shadow radius steps keep SurfaceShadowGrid's
    // sub-texel phase locked within each altitude band while covering 0..6.5 km flight.
    const shadowClearance = nearest?.hasLiquid
      ? Math.min(nearestAlt, Math.max(0, nav.pos.distanceTo(nearest.posUniv) - nearest.seaRadius))
      : nearestAlt;
    if (state === 'walk' || state === 'shipwalk' || state === 'landed' || shadowClearance < 115) activeShadowOctave = 1;
    else if (shadowClearance > 1850) activeShadowOctave = 8;
    else if (shadowClearance > 1450) activeShadowOctave = activeShadowOctave === 8 ? 8 : 4;
    else if (shadowClearance > 560) activeShadowOctave = 4;
    else if (shadowClearance > 440) activeShadowOctave = activeShadowOctave >= 4 ? 4 : 2;
    else if (shadowClearance > 145) activeShadowOctave = 2;
    else activeShadowOctave = activeShadowOctave >= 2 ? 2 : 1;
    const activeShadowRadius = Math.min(4800, effectiveShadowDistance * activeShadowOctave);
    const lightDist = Math.max(4000, activeShadowRadius * 2.5);
    const farDist = Math.max(8500, activeShadowRadius * 5.5);
    if (sunShadow.shadow.camera.far !== farDist) {
      sunShadow.shadow.camera.far = farDist;
      sunShadow.shadow.camera.updateProjectionMatrix();
    }
    sunShadow.shadow.normalBias = 2.0 * Math.sqrt(activeShadowOctave);
    sunShadow.position.copy(sunDirCam).multiplyScalar(lightDist);
    sunShadow.target.position.set(0, 0, 0);
    surfaceShadowGrid.update(sunShadow, nav.pos, nearest.posUniv,
      activeShadowRadius, renderer.capabilities.maxTextureSize);
    sysLight.intensity *= 1 - shadowBlend;
    if (universe.fadingSystem) universe.fadingSystem.sunLight.intensity *= 1 - shadowBlend;
  } else {
    sunShadow.intensity = 0;
    sunShadow.shadow.autoUpdate = false;
  }

  // Atmospheric buffeting is coherent, not per-frame random noise. Random
  // offsets made right-click acceleration read as a broken flight model.
  const trueSpd = _velActual.length();
  // Manual flight velocity is relative to the currently followed body. Using
  // absolute universe displacement here made a zero-speed hover inherit the
  // planet's rotation and falsely trigger continuous atmospheric buffeting.
  const flightSpd = state === 'space' ? nav.vel.length()
    : state === 'skydive' ? skydiveCtl.airspeed
    : (state === 'landed' || state === 'shipwalk' || state === 'walk') ? 0
    : (state === 'landing' || state === 'takeoff') ? scriptedFlightSpd
    : trueSpd;
  if (envInAtmo > 0.05 && flightSpd > 220 && (state === 'space' || state === 'flyto')) {
    const cockpitScale = shipView.isCockpit() ? 0.18 : 1;
    const amp = Math.min(1, flightSpd / 3200) * envInAtmo
      * (0.16 + boostVisual * 0.08) * cockpitScale;
    const t = clock.elapsedTime;
    camera.position.set(
      Math.sin(t * 17.3) * amp,
      Math.sin(t * 21.7 + 1.2) * amp * 0.65,
      Math.sin(t * 13.1 + 2.4) * amp * 0.35,
    );
  }


  const wasShipForeground = ship.foregroundOnly;
  // the ship flies just ahead of the camera whenever we're in flight
  ship.update(
    dt,
    nav,
    state,
    flightSpd,
    warpIntensity,
    Math.max(boostVisual, pulseVisual * 1.3, state === 'takeoff' ? takeoffEngineBoost : 0),
    {
      throttle: spaceCtl.throttleInput,
      strafe: spaceCtl.strafeInput,
      yaw: spaceCtl.lookInput.yaw,
      pitch: spaceCtl.lookInput.pitch,
    },
    camera,
  );
  if (DEV_SERVER && devWaterWakeFixture?.cameraLead) {
    devWaterWakeFixture.planet.localOffsetToWorld(devWaterWakeFixture.motion, _v).normalize();
    ship.group.position.addScaledVector(_v, devWaterWakeFixture.cameraLead);
  }
  // first-person modes re-place the hull around the camera
  shipView.applyShipPose(dt, nav, state);
  if (wasShipForeground && !ship.foregroundOnly) {
    nodePipeline.cloudPass?.resetHistory();
  }
  // Ground-effect hull clearance in 3rd-person low-altitude flight: nav.pos
  // sits 6.5 m above and 30 m behind the formation hull, so pitching down near
  // the ground would otherwise push the hull below terrain before pressing L.
  if (state === 'space' && shipView.viewBlend < 0.99 && nearest && !nearest.isGasGiant
      && !envUnderwater && nearestAlt < 85 && !(DEV_SERVER && devWaterWakeFixture)) {
    _v.copy(nav.pos).add(ship.group.position);
    nearest.worldPositionToLocal(_v, _v2);
    const rawHullR = _v2.length();
    _v3.copy(_v2).multiplyScalar(1 / Math.max(rawHullR, 1));
    const minHullR = nearest.surfaceRadius(_v3) - GEAR_GROUND_Y + 0.75;
    const skimT = 1 - smoothstep(minHullR, minHullR + 9.5, rawHullR);
    if (skimT > 0.001) {
      if (rawHullR < minHullR) {
        _v2.copy(_v3).multiplyScalar(minHullR);
        nearest.localPositionToWorld(_v2, _v);
        ship.group.position.copy(_v).sub(nav.pos);
      }
      const localQ = _q.copy(nearest._invFrame).multiply(ship.group.quaternion).normalize();
      const fwdLocal = _v4.set(0, 0, -1).applyQuaternion(localQ);
      if (fwdLocal.dot(_v3) < 0.04) {
        fwdLocal.addScaledVector(_v3, -fwdLocal.dot(_v3)).normalize();
        if (fwdLocal.lengthSq() > 0.5) {
          const levelLocalQ = horizonQuat(_v3, fwdLocal, _rampInvQuat);
          localQ.slerp(levelLocalQ, skimT * 0.88);
          ship.group.quaternion.copy(nearest.frameOrientation).multiply(localQ).normalize();
        }
      }
    }
  }
  // Transit kick: one low-frequency push back into the seat (cockpit) or away
  // from the hull (chase), applied after the hull is placed so it reads as
  // the ship surging, never as a shaking image.
  if (Math.abs(transitChannels.kick) > 1e-4 && (state === 'space' || state === 'warp')) {
    const kickScale = shipView.isCockpit() ? 0.14 : 1.8;
    camera.position.add(_v.set(0, 0, transitChannels.kick * kickScale).applyQuaternion(camera.quaternion));
  }
  applyTransitVisuals(dt);
  // contextual F/E prompt inside the hull, in the pilot's seat, skydiving, or at the exterior ramp
  const interactText = paused ? ''
    : state === 'skydive' ? skydiveCtl.interactPrompt(touchHints)
    : state === 'shipwalk' ? shipView.interactPrompt(shipLanded)
    : state === 'landed' && shipView.seatT >= 1
      ? (ship.hoverMode === 'high'
        ? '[F] 起身前往尾舱跳伞 · [SPACE / W] 恢复飞行 · [V] 切换视角'
        : '[SPACE / W] 点火起飞 · [F] 离开驾驶座 · [V] 切换视角')
    : state === 'walk' ? exteriorRampPrompt()
    : '';
  ui.setInteractPrompt(interactText);
  updateWaterInteraction(dt);
  nearest?.liquidMat?.userData?.syncWaterInteractionTexture?.();
  // DEV optical A/B: hide only the packed render count, never field state.
  if (DEV_SERVER && devWaterWakeFixture?.opticalHidden) {
    const count = nearest?.liquidMat?.userData?.waterUniforms?.uRippleCount;
    if (count) count.value = 0;
  }
  nearest?.liquidMat?.userData?.syncOceanField?.();
  prewarmLoadedShipPipelines();
  const jumpCloudPass = nodePipeline.cloudPass;
  if (jumpCloudPass) jumpCloudPass.sampleListener = skydiveCtl.active;
  skydiveCtl.cloud = skydiveCtl.active
    ? (jumpCloudPass?.enabled ? jumpCloudPass.listenerDensity : environmentState.cloudDensity) : 0;
  audio.update({
    state,
    speed: flightSpd,
    atmosphere: envInAtmo,
    canopy: skydiveCtl.active ? skydiveCtl.deployT : 0,
    cloud: skydiveCtl.cloud,
    brake: Math.max(skydiveCtl.brakeLeft || 0, skydiveCtl.brakeRight || 0),
    boosting: boostVisual > 0.12,
    warp: Math.max(warpIntensity, pulseVisual * 0.68),
    rift: riftRoute ? riftPortal.openness * (riftRoute.arrived ? 0.35 : 1) : 0,
    water: waterContact,
    underwater: envUnderwater,
    paused,
  });
  // the ship's own sounds: cabin bed while aboard, events placed in ship space
  {
    const seated = shipView.isCockpit() && !shipView.shipwalk;
    const inPilotFlow = state === 'space' || state === 'landed' || state === 'landing' || state === 'takeoff';
    const aboard = state === 'shipwalk' || (inPilotFlow && seated);
    let listener = { x: 0, z: ship.def.dims.eyeZ, yaw: 0 };
    if (shipView.shipwalk) {
      listener = { x: shipView.walkPos.x, z: shipView.walkPos.z, yaw: shipView.walkYaw };
    } else if (state === 'walk' && ship.parkedPosUniv) {
      const p = playerShipLocal();
      if (p) {
        _rampInvQuat.copy(ship.parkedQuat).invert();
        _q.copy(_rampInvQuat).multiply(nav.quat).normalize();
        _rampEuler.setFromQuaternion(_q, 'YXZ');
        listener = { x: p.x, z: p.z, yaw: _rampEuler.y };
      }
    }
    shipAudio.update({
      aboard,
      seated: seated && inPilotFlow,
      listener,
      cabin: ship.cabinLightT ?? 1,
      paused,
      events: ship.events,
    });
  }
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
  // 仅在脉冲进行中(pulseBurst 存在)虚高显示;脉冲不改 nav.vel,结束后读数
  // 直接回到玩家原本的巡航速度。
  const pulseDisplaySpeed = state === 'space' && pulseBurst
    ? lerp(nav.vel.length(), Math.max(_velActual.length(), boostSpeedLimit * (1 + pulseVisual * 1.8)),
      smoothstep(0, 0.15, pulseVisual))
    : 0;
  const spd = state === 'walk' ? walkCtl.hSpeed.length()
    : state === 'skydive' ? skydiveCtl.airspeed
    : state === 'landed' ? 0
    : (state === 'landing' || state === 'takeoff') ? scriptedFlightSpd
    : state === 'space' ? Math.max(nav.vel.length(), pulseDisplaySpeed)
    : _velActual.length();
  const telemetryBody = state === 'space' && focusPlanet ? focusPlanet : nearest;
  let telemetryAltitude = telemetryBody
    ? telemetryBody.altitudeAt(_v.copy(nav.pos).sub(telemetryBody.posUniv)) : Infinity;
  let altitudeReference = '地表高度';
  if (telemetryBody?.oceanSurface && telemetryAltitude < 100000) {
    const surface = telemetryBody.sampleWaterSurface(
      telemetryBody.worldPositionToLocal(nav.pos, _v), telemetryBody.weatherHours, { normal: false });
    if (surface?.wet) {
      altitudeReference = surface.clearance < 0 ? '水下深度' : '海面高度';
      telemetryAltitude = Math.abs(surface.clearance);
    }
  }
  ui.setAltitude(telemetryAltitude < 2e7 ? Math.max(0, telemetryAltitude) : null, spd, altitudeReference);
  ui.setFlightTelemetry({
    speed: spd,
    speedLimit: boostSpeedLimit,
    boost: boostVisual,
    atmosphere: envInAtmo,
    pulse: pulseVisual,
    pulseFuel,
    pulseFuelMax: PULSE_FUEL_MAX,
    pulseInfinite: DEV_INFINITE_PULSE,
    pulseRecharging: !pulseActive && pulseRechargeDelay <= 0 && pulseFuel < PULSE_FUEL_MAX - 0.005,
    shield: 100 * flightPower.shield,
    gun: 100 * flightPower.weapon,
  });
  const localHours = nearest ? localSolarTimeAt(nearest, nav.pos) : null;
  ui.setCosmicTime(celestialClock.hours, localHours, celestialClock.scale);
  _v.set(0, 0, -1).applyQuaternion(nav.quat);
  const headingDeg = Math.atan2(_v.x, -_v.z) * 180 / Math.PI;
  ui.setHeading(headingDeg);
  // cockpit displays read the same numbers the HUD shows
  {
    const t = ship.telemetry ??= {};
    t.speed = spd;
    t.alt = telemetryAltitude;
    t.heading = (headingDeg + 360) % 360;
    t.shield = flightPower.shield;
    t.gun = flightPower.weapon;
    t.fuel = PULSE_FUEL_MAX > 0 ? pulseFuel / PULSE_FUEL_MAX : 1;
    t.atmosphere = envInAtmo;
    if (nearest) {
      _shipUp.copy(nav.pos).sub(nearest.posUniv).normalize();
      _shipFwd.set(0, 0, -1).applyQuaternion(nav.quat);
      _shipRight.set(1, 0, 0).applyQuaternion(nav.quat);
      t.pitch = Math.asin(clamp(_shipFwd.dot(_shipUp), -1, 1));
      t.roll = Math.atan2(-_shipRight.dot(_shipUp), _shipFwd.set(0, 1, 0).applyQuaternion(nav.quat).dot(_shipUp));
    } else {
      t.pitch = 0;
      t.roll = 0;
    }
  }

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
  // Only the opaque tunnel between the system hand-off and the exit may drop
  // the local medium. During the spool the departure planet is still in full
  // view and must keep its atmosphere, ocean and clouds.
  const warpMediumHidden = state === 'warp' && !!warpTransit?.swapped && !warpRevealActive;
  const localAtmospherePlanet = warpMediumHidden ? null : nearest;
  nodePipeline.setActiveAtmosphere(localAtmospherePlanet?.isGasGiant
    || localAtmospherePlanet?.type === 'artificialHabitat'
    ? null : localAtmospherePlanet, nav.pos);
  if (volumePass) {
    const motion = clamp(trueSpd / Math.max(nearest?.R || 1, 60000) * 18 + boostVisual * 0.22, 0, 1);
    // The first two thirds of stellar warp are fully covered by starflow. Do
    // not activate a destination volume merely because it is the selected
    // navigation reference: that cold pipeline used to stop the tunnel for up
    // to a second while the planet was still invisible. Engage it only in the
    // authored braking/reveal window. The full graph waits for its required
    // cloud programs before any pass starts; there is no separate masked draw.
    const volumePlanet = warpMediumHidden ? null : nearest;
    volumePass.setActivePlanet(volumePlanet?.isGasGiant
      || volumePlanet?.type === 'artificialHabitat' ? null : volumePlanet, nav.pos, motion);
    nodePipeline.bindVolumeDepth?.(volumePass.activePlanet);
    // Local cloud ownership is exclusive. Refresh the active planet state just
    // before the single volume-layer draw so destination weather and lighting
    // are warm before the warp reveal.
    volumePass.activePlanet?.syncAtmoMaterial?.();
    volumePass.activePlanet?.syncVolCloudMaterial?.();
    // Only a successful production draw can publish history. The pipeline
    // captures the real camera/origin/body pose once for all temporal consumers.
  }
  // The cockpit hull and the first-person weapon rig share the depth-cleared
  // foreground layer. Walking parks the ship back in world space, but the gun
  // still owns this pass; tying it only to ship.foregroundOnly hid all four
  // weapon models after landing.
  foregroundPass.enabled = ship.foregroundOnly || surfaceWeapons.rig.visible || !!skydiveCtl.rig?.root.visible;
  // During scripted surface manoeuvres (recall fly-in, landing, liftoff, hover
  // departure) keep the ship on ForegroundPass AFTER LiteCloudPass so clouds
  // never paste over the moving hull, while retaining the opaque scene depth
  // buffer so mountains, ridges and trees still properly occlude the ship.
  const keepSceneDepthForShip = Boolean(ship.landingPose)
    && !nodePipeline.portalComposite.enabled
    && !nodePipeline.warp.enabled
    && (state === 'walk' || state === 'skydive' || !shipView.isCockpit());
  foregroundPass.clearDepth = !keepSceneDepthForShip;
  if (RENDER_LOOK_NEXT) {
    // The cabin is fully occluded by the hull in a settled chase view. Keeping
    // its independent light layer alive there paid for every cabin material
    // and fixture without contributing a pixel. Retain it across cockpit,
    // seat/walk, open-ramp fly-ins and view-blend frames so transitions stay continuous.
    const needsForegroundInterior = ship.foregroundOnly
      && (shipView.isCockpit() || shipView.shipwalk || shipView.viewBlend < 1 || shipView.rampT > 0.01);
    const foregroundLayers = needsForegroundInterior
      ? [SHIP_FOREGROUND_LAYER, SHIP_INTERIOR_LAYER]
      : [SHIP_FOREGROUND_LAYER];
    if (surfaceWeapons.rig.visible) foregroundLayers.push(WEAPON_FOREGROUND_LAYER);
    foregroundPass.setLayers(foregroundLayers);
  } else {
    foregroundPass.setLayers(surfaceWeapons.rig.visible
      ? [SHIP_FOREGROUND_LAYER, WEAPON_FOREGROUND_LAYER] : [SHIP_FOREGROUND_LAYER]);
  }
  if (parkedInteriorPass) parkedInteriorPass.enabled = !ship.foregroundOnly;
  configureShipForegroundLightingLayers();

  statAcc += dt;
  if (statAcc > 0.5) {
    statAcc = 0;
    // The detailed counter is hidden outside ?debug=1. Recursing through every
    // terrain and water node anyway caused a regular 2 Hz CPU spike that was
    // visible in 1% lows despite contributing no player-facing UI.
    if (document.body.classList.contains('debug-hud')) {
      const info = { calls: latestRenderCalls, triangles: latestRenderTriangles };
      let terrainChunks = 0, waterChunks = 0;
      let terrainPending = 0, waterPending = 0;
      for (const p of universe.planets()) {
        terrainChunks += p.lod.countChunks();
        terrainPending += pendingChunks(p.lod);
        if (p.waterLod) {
          waterChunks += p.waterLod.countChunks();
          waterPending += pendingChunks(p.waterLod);
        }
      }
      ui.setStats(`${performanceSnapshot().averageFps.toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1e6).toFixed(2)} Mtri · ${terrainChunks}/${waterChunks} terrain/water · ${terrainPending}/${waterPending} queued · ${activeBolts} bolts · ${renderDpr.toFixed(2)}×`);
    }
  }

  const adaptiveReady = loadingCleared
    && surfacePipelinesReady && !shipPipelineWarmPending
    && !postPipelinesWarmPending && !weaponPipelinesWarmPending
    && !heroTransitionActive && !FREEZE;
  if (!adaptiveReady) {
    adaptiveStableSince = performance.now();
    adaptiveGovernor.markNotReady(adaptiveStableSince);
  }

  if (!FREEZE && !photoMode && !(DEV_SERVER && devWaterWakeFixture?.held)) tickShaders(dt);
  if (QUALITY_LOW && !surfacePipelinesReady
    && performance.now() - startupWarmStartedAt >= STARTUP_SHADER_BUDGET_MS) {
    releaseStartupPrewarm('low-tier startup deadline exceeded');
  }
  // Skip the actual GPU work while the WebGL context is lost — Three.js
  // no-ops render() anyway, but skipping avoids noise from the post chain
  // trying to read stale render targets. The context-lost HUD hint is
  // surfaced from the listener.
  let worldRendered = false;
  if (!contextLost) {
    const startupDeferWorldDraw = !loadingCleared && (
      postPipelinesWarmPending || weaponPipelinesWarmPending
      || (!QUALITY_LOW && (!startupTerrainReady() || pendingChunks() > 0)
        && performance.now() - startupWarmStartedAt < STARTUP_WARM_BUDGET_MS + STARTUP_TERRAIN_GRACE_MS)
    );
    if (startupDeferWorldDraw) {
      nodePipeline.submitFrame(() => {
        finishSurfaceBootstrap();
        nodePipeline.primeCloudPrograms?.({ origin: nav.pos });
      });
    } else {
      worldRendered = frameGpuTimer.measure(() => renderWorldFrame(), {
        skip: Boolean(nodePipeline.profiler || VOLUME_ENABLED),
      });
    }
    if(worldRendered) {
      // A paced-out RAF is simulation time, not another presented frame.
      // Keep severe stalls and the full interval across skipped callbacks.
      const frameEndNow = performance.now();
      const timing=presentedFrames.present(frameEndNow);
      if(timing!==null) {
        if(timing.recorded) {
          perfEmaMs+=(Math.min(timing.activeMs,100)-perfEmaMs)*.025;
          const preFrameSpinMs = Number.isFinite(rafTs)
            ? clamp(frameCpuStart - rafTs, 0, Math.max(0, timing.activeMs - 1))
            : 0;
          const rawCpuBusyMs = preFrameSpinMs + Math.max(0, frameEndNow - frameCpuStart);
          const renderCpuMs = Math.max(0.2, rawCpuBusyMs - (sceneBuildBudget.spentMs || 0));
          const streamingActive = Boolean(
            (nearest?.lod && pendingChunks(nearest.lod) > 4)
            || (nearest?.waterLod && pendingChunks(nearest.waterLod) > 4)
            || nearest?.nearWaterPatch?.build
          );
          const decision = adaptiveGovernor.update({
            now: frameEndNow,
            ready: adaptiveReady,
            // A transit is a short covered cinematic: stepping quality inside it
            // would drop the nearby world's resolution in view of the camera
            // and reallocate every target mid-flight (a visible hitch).
            locked: adaptiveQualityLocked || transitHoldsQuality(),
            streaming: streamingActive,
            activeMs: timing.activeMs,
            cpuWorkMs: renderCpuMs,
            gpuWorkMs: frameGpuTimer.latestMs(),
            stage: adaptiveStage,
            renderDpr,
            ceilingDpr: computeCeilingDpr(),
            dprMin: QUALITY_PROFILE.dprMin,
          });
          if (decision.action === 'stage') applyAdaptiveStage(decision.stage);
          else if (decision.action === 'dpr') setRenderDpr(decision.dpr);
        }
        if(DEV_SERVER) {
          devFpsElapsed+=timing.elapsedMs/1000;devFpsFrames++;
          if(devFpsElapsed>=.45) {
            ui.setDevFps(devFpsFrames/devFpsElapsed);devFpsElapsed=0;devFpsFrames=0;
          }
        }
      }
      const info=renderer.info.render;
      latestRenderCalls=info.calls;latestRenderTriangles=info.triangles;
    }
  }
  prevNavPos.copy(nav.pos);
  const startupAssetsReady = ship.heroLoadSettled
    && (shipPipelinesWarmed || ship.heroLoadFailed);
  const startupTerrainTimedOut = performance.now() - startupWarmStartedAt
    >= STARTUP_WARM_BUDGET_MS + STARTUP_TERRAIN_GRACE_MS;
  const startupSystemReady = Boolean(universe.system?.built)
    && pendingChunks() === 0;
  const cloudPreparation = nodePipeline.cloudPrograms.snapshot();
  // High/Ultra never hands control over with an active opening-planet build
  // queue. The old timeout merely hid the loading screen while hundreds of
  // GPU uploads moved into the hero shot. Performance tier keeps a bounded
  // escape hatch for adapters where quality is explicitly secondary.
  const terrainReady = (startupTerrainReady() && startupSystemReady)
    || (QUALITY_LOW && startupTerrainTimedOut);
  if (!loadingCleared) {
    // Stage-weighted target — only moves forward. Each milestone contributes
    // a fixed slice so the bar reflects real pipeline readiness instead of an
    // infinite CSS sweep that resets to zero.
    let target = 0;
    if (frameNo >= 3) target += 0.15;
    if (surfacePipelinesReady) target += 0.3;
    if (startupAssetsReady) target += 0.2;
    if (terrainReady) target += 0.2;
    if (worldRendered) target += 0.15;
    if (loadingProgress < target) {
      loadingProgress += (target - loadingProgress) * Math.min(1, dt * 5);
      if (loadingProgress > target) loadingProgress = target;
    }
    ui.setLoadingProgress(loadingProgress);
    if (cloudPreparation.failed) ui.setLoading(true, '渲染准备失败，请刷新重试');
  }
  if (!loadingCleared && frameNo >= 3 && surfacePipelinesReady
    && !postPipelinesWarmPending && !weaponPipelinesWarmPending
    && startupAssetsReady && terrainReady && worldRendered) {
    if (!shipPipelinesWarmed) {
      for (const mesh of surfaceBootstrapMeshes.splice(0)) {
        mesh.removeFromParent();
        if (mesh.isInstancedMesh) mesh.dispose();
        else mesh.geometry.dispose();
      }
    }
    loadingProgress = 1;
    ui.setLoadingProgress(1);
    loadingCleared = true;
    ui.setLoading(false);
    for (const p of universe.system?.planets || []) p.deferWeatherStream = false;
  } else if (!loadingCleared && !cloudPreparation.blocked && Boolean(universe.system?.built)
    && performance.now() - startupWarmStartedAt
      > STARTUP_SHADER_BUDGET_MS + STARTUP_TERRAIN_GRACE_MS + 3000) {
    // Keep the older escape for unrelated startup stages, but never reveal an
    // empty canvas while a required cloud program still owns readiness. Its
    // own deadline/failure remains explicit; it is not a completed world draw.
    console.warn('loading mask forced clear by safety-net timeout');
    if(!surfacePipelinesReady||surfaceBootstrapPending||postPipelinesWarmPending||weaponPipelinesWarmPending)
      releaseStartupPrewarm('loading mask safety deadline exceeded');
    loadingProgress = 1;
    ui.setLoadingProgress(1);
    loadingCleared = true;
    ui.setLoading(false);
    for (const p of universe.system?.planets || []) p.deferWeatherStream = false;
  }
}

// Build up to planet-1 (pelagic ocean world) first so both terrestrial water
// topologies exist, compute full-system stellarOccluders from ephemeris frames
// so STELLAR_UNION_OCCLUSION matches the built system, then kick off all async
// ANGLE C++ FXC shader compiles BEFORE building the remaining secondary bodies!
while (universe.system && !universe.system.built && universe.system.planets.length < 3) {
  universe.system.buildNext();
}
for (let i = 1; i < (universe.system?.planets?.length || 0); i++) {
  universe.system.planets[i].deferWeatherStream = true;
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
if (SHOW_HERO) {
  spaceCtl.enabled = false;
  // The hero backdrop is the home world; its dossier balances the menu card.
  try {
    ui.setHeroDossier(starMap?.bodyDossier(universe.system.star, universe.system.planets[0]?.name) || null);
  } catch (error) {
    console.warn('[hero] dossier unavailable', error);
    ui.setHeroDossier(null);
  }
}
const bootstrapSurfacePlanet = universe.system.planets[0];
nearest = bootstrapSurfacePlanet || null;
if (nearest) {
  _v.copy(nav.pos).sub(nearest.posUniv);
  nearestAlt = nearest.altitudeAt(_v);
}
ambience(0);
if (bootstrapSurfacePlanet && universe.system?._specs?.length > universe.system.planets.length) {
  const ephemerisBodies = universe.system._specs.map((s) => (
    universe.system.bodyById.get(s.bodyId)
      || { posUniv: universe.system.frames.get(s.bodyId)?.position || new THREE.Vector3(), R: s.radius || 1000 }
  ));
  bootstrapSurfacePlanet.setStellarOccluders?.(
    selectStellarOccluders(bootstrapSurfacePlanet, ephemerisBodies, universe.system.starViews));
}
if (bootstrapSurfacePlanet && !bootstrapSurfacePlanet.isGasGiant) {
  nodePipeline.setActiveAtmosphere(bootstrapSurfacePlanet, nav.pos);
  scatter.setPlanet(bootstrapSurfacePlanet);
  for (const mesh of Object.values(scatter.meshes)) mesh.visible = false;
  if (FARFLORA) farFlora.setPlanet(bootstrapSurfacePlanet);
  if (farFlora.meshes) for (const mesh of farFlora.meshes) mesh.visible = false;
  if (QUALITY_LOW) {
    renderer.debug.checkShaderErrors = qs.get('shaderchecks') === '1';
  } else {
    prewarmSurfacePipelines(bootstrapSurfacePlanet, universe.system?.planets || null);
  }
}
if (volumePass && bootstrapSurfacePlanet) {
  volumePass.setActivePlanet(bootstrapSurfacePlanet.isGasGiant ? null : bootstrapSurfacePlanet, nav.pos, 0);
  nodePipeline.primeCloudPrograms?.({ origin: nav.pos });
}
prewarmWeaponAndPostPipelines();
prewarmLoadedShipPipelines();
// Submit all queued async shader compilations onto ANGLE C++ worker threads
// BEFORE building the remaining secondary bodies so JS and FXC run in parallel!
for (let pump = 0; pump < 24 && nodePipeline.preparations?.hasQueued; pump++) {
  nodePipeline.preparations.submit?.();
}
while (universe.system && !universe.system.built) {
  universe.system.buildNext();
  const latest = universe.system.planets.at(-1);
  if (latest && latest !== bootstrapSurfacePlanet) latest.deferWeatherStream = true;
}
wireUniverse(universe);
startupWarmStartedAt = performance.now();
frame();

// ---- debug / test API (used by tools/screenshot.js) ----------------------------

window.NMS = {
  version: VERSION,
  _ff: farFlora,           // debug handle (headless diagnostics)
  _renderer: renderer,
  _pipeline: nodePipeline,  // debug handle (headless diagnostics)
  _THREE: THREE,
  _planet(i = 0) {
    while (universe.system && !universe.system.built && universe.system.planets.length <= i) {
      universe.system.buildNext();
    }
    return universe.system?.planets[i] || null;
  },
  get booted() {
    return loadingCleared;
  },
  get state() { return state; },
  surfaceWarmupState() {return {ready:surfacePipelinesReady,pending:surfaceBootstrapPending,
    expired:startupPrewarmExpired,remainingMeshes:surfaceBootstrapMeshes.length,stats:surfaceBootstrapStats};},
  sceneBuildState() {return sceneBuildBudget.snapshot();},
  warpPreparationState() {
    const prepared = warpPreparedSystem || transferredPreparedDestination?.system || null;
    const route = pendingRoute || transferredPreparedDestination?.route || null;
    return {
      routeStarId: route?.star?.id || null,
      targetBodyId: route?.bodyId || null,
      preparedStarId: prepared?.star?.id || null,
      builtBodies: prepared?.bodyById?.size || 0,
      totalBodies: prepared?._specs?.length || 0,
      targetReady: !!(route?.bodyId && prepared?.bodyById?.has(route.bodyId)),
      lodWarmState: warpPreparedLodWarmState,
      lodReady: warpPreparedLodWarmState === 'complete'
        || warpPreparedLodWarmState === 'idle',
      lodWarmError: warpPreparedLodWarmError,
      terrain: warpPreparedLodWarmPlanet?.lod?.debugStats?.() || null,
      waterLod: warpPreparedLodWarmPlanet?.waterLod?.debugStats?.() || null,
      waterWarmState: warpPreparedWaterWarmState,
      waterReady: warpPreparedWaterWarmState === 'complete'
        || warpPreparedWaterWarmState === 'idle',
      waterWarmError: warpPreparedWaterWarmError,
      // Backward-compatible aliases for existing diagnostics. The state now
      // represents the confirmed water-pipeline root cause, not local volume.
      volumeWarmState: warpPreparedWaterWarmState,
      volumeReady: warpPreparedWaterWarmState === 'complete'
        || warpPreparedWaterWarmState === 'idle',
      riftStructureWarmState: warpPreparedRiftStructureState,
      riftWarmState: warpPreparedRiftWarmState,
      riftReady: riftDestinationPreparationReady(),
      riftWarmError: warpPreparedRiftWarmError,
      built: prepared?.built || false,
    };
  },
  resetPerformanceStats,
  resetAdaptiveQuality,
  setTemporalAA: (enabled, options = {}) => nodePipeline.setTemporalAAEnabled(enabled, options),
  temporalState: () => nodePipeline.temporalState(),
  setAdaptiveQualityLocked(value = true) {
    adaptiveQualityLocked = !!value;
    return adaptiveQualityLocked;
  },
  setHeadlampEnabled(value = true) {
    if (!DEV_SERVER) return null;
    devHeadlampEnabled = !!value;
    return devHeadlampEnabled;
  },
  setWeatherFixture(i, name = null) {
    if (!DEV_SERVER) return null;
    const planet = universe.system.planets[i];
    if (!planet?.setWeatherFixture) return null;
    planet.setWeatherFixture(name);
    return this.weatherState(i);
  },
  setEclipseFixture(i, fixture = null) {
    if (!DEV_SERVER) return null;
    const planet = universe.system.planets[i];
    if (!planet?.setEclipseOccluder) return null;
    planet.devEclipseFixture = fixture ? {
      distance: Math.max(planet.R * 1.05, Number(fixture.distance) || planet.R * 3.5),
      radius: Math.max(1, Number(fixture.radius) || planet.R * 0.18),
      offset: Number(fixture.offset) || 0,
      starAngularRadius: Number.isFinite(Number(fixture.starAngularRadius))
        ? Math.max(0, Number(fixture.starAngularRadius)) : undefined,
    } : null;
    return planet.devEclipseFixture;
  },
  weatherState(i = null, direction = null) {
    const planet = Number.isInteger(i) ? universe.system.planets[i] : nearest;
    if (!planet?.weatherAt) return null;
    let localDirection;
    if (direction) localDirection = new THREE.Vector3(...direction).normalize();
    else if (planet === nearest) {
      localDirection = planet.worldPositionToLocal(nav.pos, new THREE.Vector3()).normalize();
    } else localDirection = new THREE.Vector3(0, 1, 0);
    return {
      ...planet.weatherAt(localDirection),
      hours: planet.weatherHours,
      fingerprint: planet.weatherFingerprint?.(64),
      effects: planet === nearest ? { ...weatherEffects.state } : null,
    };
  },
  stellarState(i = null) {
    const planet = Number.isInteger(i) ? universe.system.planets[i] : nearest;
    const field = planet?.stellarLightField;
    if (!field) return null;
    return {
      count: field.sources.length,
      dominantIndex: field.dominantIndex,
      sources: field.sources.map((source) => ({
        id: source.id,
        direction: source.worldDirection.toArray(),
        localDirection: source.localDirection.toArray(),
        color: source.colorValue.toArray(),
        irradiance: source.irradianceFraction,
        visibility: source.visibility,
      })),
    };
  },
  atmosphereState() {
    const profile = atmospherePass.profileState?.profile || null;
    return {
      activeBodyId: atmospherePass.activePlanet?.bodyId || null,
      enabled: atmospherePass.visualEnabled,
      meshHidden: atmospherePass.activePlanet?.atmoMesh?.visible === false,
      opticalTop: profile?.topAltitudeMeters || 0,
      rayleighScaleHeight: profile?.rayleighScaleHeightMeters || 0,
      mieScaleHeight: profile?.mieScaleHeightMeters || 0,
      densityScale: atmospherePass.profileState?.densityScale || 0,
      depthReady: !!atmospherePass.material.uniforms.tSceneDepth.value,
    };
  },
  setAtmosphereVisible(value = true) {
    atmospherePass.setVisualEnabled(value);
    return atmospherePass.visualEnabled;
  },
  setCloudsVisible(value = true, i = 0) {
    const planet = universe.system.planets[i];
    if (!planet) return false;
    planet.cloudVisualEnabled = !!value;
    return planet.cloudVisualEnabled;
  },
  waterState(i = 0) {
    const planet = universe.system.planets[i];
    if (!planet?.waterLod) return null;
    const profile = planet.liquidMat?.userData?.waterProfile || null;
    return {
      global: planet.waterLod.debugStats(),
      near: planet.nearWaterPatch?.debugStats?.() || null,
      profile,
      ocean: planet.oceanAt(planet.worldPositionToLocal(nav.pos,
        new THREE.Vector3()).normalize()),
    };
  },
  surfaceState(i = null) {
    const planet = Number.isInteger(i) ? universe.system.planets[i] : nearest;
    if (!planet) return null;
    const localDirection = planet.worldPositionToLocal(nav.pos, new THREE.Vector3()).normalize();
    const height = planet.height(localDirection, planet.fullMaxFreq || 128);
    return {
      direction: localDirection.toArray(),
      height,
      hAmp: planet.hAmp,
      seaLevel: planet.seaLevel ?? null,
      snowLine: planet.pal?.snowLine ?? null,
      capLat: planet.pal?.capLat ?? null,
      biome: planet.biomeAt?.(localDirection, height) || null,
      snowWeight: planet.snowWeightAt?.(localDirection, height) || 0,
      terrainColor: planet.colorAt
        ? planet.colorAt(localDirection, height, 0, planet.fullMaxFreq || 128,
          new THREE.Color()).toArray()
        : null,
    };
  },
  lightingState() {
    return {
      ambient: ambient.intensity,
      hemisphere: hemi.intensity,
      headlamp: headlamp.intensity,
      sunShadow: sunShadow.intensity,
      stars: universe.system.starViews.map((view) => view.light.intensity),
    };
  },
  renderLookState() {
    let cabinBake = ship.int?.group?.userData?.interiorIrradiance || null;
    if (!cabinBake && ship.bakedLight && ship.int?.group) {
      cabinBake = ship.int.group.userData.offlineInteriorIrradiance;
      if (!cabinBake) {
        let meshes = 0, vertices = 0, litVertices = 0, maxIrradiance = 0;
        const boundMaterials = new Set();
        ship.int.group.traverse((object) => {
          if (!object.isMesh) return;
          const attr = object.geometry?.getAttribute?.('aCabinIrradiance');
          if (attr) {
            meshes++;
            vertices += attr.count;
            for (let i = 0; i < attr.count; i++) {
              const peak = Math.max(attr.getX(i), attr.getY(i), attr.getZ(i));
              if (peak > 1e-4) litVertices++;
              if (peak > maxIrradiance) maxIrradiance = peak;
            }
          }
          const mats = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const mat of mats) {
            if (mat?.userData?.interiorIrradiance) boundMaterials.add(mat);
          }
        });
        cabinBake = {
          offline: true,
          fixtures: ship.int.lights?.length || 0,
          meshes,
          vertices,
          litVertices,
          maxIrradiance: +maxIrradiance.toFixed(4),
          boundMaterials: boundMaterials.size,
        };
        ship.int.group.userData.offlineInteriorIrradiance = cabinBake;
      }
    }
    return {
      production: RENDER_LOOK_NEXT,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      grade: gradePass_ ? {
        aberration: gradePass_.uniforms.uAberration.value,
        vignette: gradePass_.uniforms.uVignette.value,
        grain: gradePass_.uniforms.uGrain.value,
      } : null,
      cabinBake,
      ...sceneRadiance.debugState(),
    };
  },
  setRenderLookIsolation(mode = 'all') {
    if (!DEV_SERVER || !RENDER_LOOK_NEXT) return null;
    return sceneRadiance.setIsolation(mode);
  },
  volumeState() {
    const planet = volumePass?.activePlanet || null;
    const uniforms = planet?.volCloudUniforms || planet?.volCloudMat?.uniforms;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      activeBodyId: planet?.bodyId || null,
      cloudDepthReady: uniforms?.uDepthReady?.value || 0,
      steps: uniforms?.uMaxSteps?.value || 0,
      maximumViewSteps: planet?.volCloudMat?.defines?.CLOUD_VIEW_MAX_STEPS || 124,
      cloudLightSteps: uniforms?.uCloudLightSteps?.value || 0,
      scale: effectiveVolumeScale,
      drawingBuffer: [size.x, size.y],
      weatherTime: planet?.weatherHours ?? null,
      productionShapeVersion:planet?.volCloudMat?.userData.productionShapeVersion ?? null,
      speciesMask:uniforms?.uSpeciesMask?.value ?? null,
      advectionPhase:uniforms?.uCloudAdvectionPhase?.value ?? null,
      committedWeatherTime: planet?.cloudSpeciesTex?.userData?.hours ?? null,
      weatherReady: planet?.weatherStream?.ready ?? false,
      columnsReady: uniforms?.uColumnsReady?.value || 0,
      sunlightCacheReady:uniforms?.uSunCacheReady?.value || 0,
      sunlightCacheMix:uniforms?.uSunCacheMix?.value ?? null,
      sunlightCacheFields:[...(planet?.cloudLightBank?.maps?.values() || [])]
        .map(cache=>({hours:cache.hours,ready:cache.ready,field:cache.field,layer:cache.layer,
          available:cache.available,margins:cache.interiorMargins})),
      columnGenerations: [...(planet?.cloudColumnMap?.maps?.values() || [])]
        .map(map=>({hours:map.generation,ready:map.ready,rows:map.row,totalRows:map.height})),
      representation: planet?.volCloudMesh?.material?.defines?.CLOUD_FAR_VIEW ? 'far-column' : 'near-volume',
      lightQuadratureSamples: uniforms?.uLightQuadratureSteps?.value ?? null,
      sunShaftStrength: nodePipeline.sunShafts?.uniforms?.uStrength?.value || 0,
      sunShaftUv: nodePipeline.sunShafts?.uniforms?.uSunUv?.value?.toArray?.() || null,
      sunShaftDebug: { ...sunShaftDebug },
    };
  },
  cloudResourceState(i = 0) {
    const planet = universe.system.planets[i];
    const telemetry = cloudResourceManager.telemetry();
    return {
      planet: planet ? {
        key: planet.cloudResource?.key || null,
        status: planet.cloudResourceStatus || 'idle',
        error: planet.cloudResourceError || null,
        cpuBytes: planet.cloudResource?.cpuBytes || 0,
        gpuBytes: planet.cloudResource?.gpuBytes || 0,
        shellTopMeters: planet.cloudResource?.fields?.shellTopMeters || null,
        occupancy: planet.cloudResource ? [
          planet.cloudResource.occupancy.lonCount,
          planet.cloudResource.occupancy.latCount,
          planet.cloudResource.occupancy.altCount,
        ] : null,
        timings: planet.cloudResource?.generationTimings || null,
      } : null,
      telemetry,
    };
  },
  setCloudSamples(samples = PROFILE_CLOUD_STEPS) {
    if (!DEV_SERVER) return null;
    const value = clamp(Math.round(Number(samples) || PROFILE_CLOUD_STEPS), 16, 124);
    for (const planet of universe.planets()) {
      const uniform = planet.volCloudUniforms?.uMaxSteps
        || planet.volCloudMat?.uniforms?.uMaxSteps;
      if (uniform) uniform.value = value;
    }
    effectiveCloudSteps = value;
    return value;
  },
  setBuildBudget(milliseconds = 0) {
    if (!DEV_SERVER) return null;
    debugBuildBudgetMs = clamp(Number(milliseconds) || 0, 0, 1000);
    return debugBuildBudgetMs;
  },
  get paused() { return paused; },
  seed: () => SEED,
  galaxy: () => ({ id: GALAXY_ID, name: GALAXY.name }),
  frame: () => frameNo,
  idle() {
    return frameNo > 10 && pendingChunks() === 0 && farFlora.pending() === 0
      && !nearest?.nearWaterPatch?.debugStats?.().pending
      && frameNo - lastBuildFrame > 8;
  },
  stats() {
    let terrainChunks = 0, waterChunks = 0;
    let terrainPending = 0, waterPending = 0;
    for (const p of universe.planets()) {
      terrainChunks += p.lod.countChunks();
      terrainPending += pendingChunks(p.lod);
      if (p.waterLod) {
        waterChunks += p.waterLod.countChunks();
        waterPending += pendingChunks(p.waterLod);
      }
    }
    const nearWater = nearest?.nearWaterPatch?.debugStats?.() || null;
    return {
      frame: frameNo, calls: latestRenderCalls, tris: latestRenderTriangles,
      chunks: terrainChunks + waterChunks,
      terrainChunks, waterChunks, terrainPending, waterPending,
      nearWater,
      pending: pendingChunks(), state, alt: nearestAlt,
      paused, boost: boostVisual, fov: camera.fov, audio: audio.ready,
      pulse: pulseActive, pulseVisual, pulseFuel: Math.round(pulseFuel * 10) / 10, pulseInfinite: DEV_INFINITE_PULSE,
      power: { ...flightPower },
      transit: warpTransit ? { t: warpTransit.t, total: warpTransit.plan.total } : null,
      transitChannels: { ...transitChannels },
      firing: spaceCtl.firing, bolts: activeBolts,
      cosmicHours: celestialClock.hours, timeScale: celestialClock.scale,
      dayLight: envDay, eclipse: envEclipse, environment: { ...environmentState },
      gpu: gpuName, dpr: renderDpr,
      rendererRequested: rendererPolicy.requested,
      rendererBackend: actualRendererBackend,
      rendererReason: rendererRuntime.reason,
      webgpuAvailable: rendererPolicy.webgpuAvailable,
      adapterInfo: null,
      quality: QUALITY_PROFILE.id,
      qualityRequested: graphicsSettings.quality,
      qualityAutomatic: QUALITY_PROFILE.automatic,
      volumeScale: effectiveVolumeScale,
      cloudSteps: effectiveCloudSteps,
      cloudLightSteps: effectiveCloudLightSteps,
      atmosphereSteps: effectiveAtmosphereSteps,
      localVolumeBudget: localVolumeBudgetKey,
      shadowMap: SHADOW_MAP,
      shadowDistance: effectiveShadowDistance,
      waterInteractionSize: QUALITY_PROFILE.waterInteractionSize,
      waterTransmissionScale: renderer.transmissionResolutionScale,
      waterReflectionHz: effectiveWaterReflectionHz,
      adaptiveStage,
      adaptiveGovernor: adaptiveGovernor.snapshot(),
      waterInteractions: waterInteraction.activeCount(),
      waterContact,
      waterSurfaceHeight,
      waterTangentSpeed,
      surfaceInteractions: surfaceInteraction.activeCount(),
      surfaceMaterials: surfaceMaterialStatus(),
      terrainQueue: pendingChunks(),
      grass: scatter.meshes ? Object.entries(scatter.meshes)
        .filter(([name]) => name.startsWith('grass'))
        .reduce((sum, [, mesh]) => sum + (mesh?.count || 0), 0) : 0,
      grassLods: scatter.meshes ? Object.fromEntries(Object.entries(scatter.meshes)
        .filter(([name]) => name.startsWith('grass'))
        .map(([name, mesh]) => [name, mesh?.count || 0])) : {},
      grassField: scatter.debugStats(),
      trees: scatter.meshes ? Object.entries(scatter.meshes)
        .filter(([name]) => name.startsWith('tree'))
        .reduce((sum, [, mesh]) => sum + (mesh?.count || 0), 0) : 0,
      ...performanceSnapshot(),
      renderPacing: nodePipeline.framePacer?.snapshot() || null,
      renderPreparation: nodePipeline.preparations.snapshot(),
      cloudPreparation: { enabled: nodePipeline.cloudProgramsEnabled, ...nodePipeline.cloudPrograms.snapshot() },
      worldPublication: deferredWorldPublication?.snapshot() || lastWorldPublicationSnapshot,
      far: farFlora.meshes ? farFlora.meshes[0].count + farFlora.meshes[1].count : 0,
    };
  },
  waterField() {
    if (!DEV_SERVER || !nearest?.hasLiquid) return [];
    const origin = nearest.worldPositionToLocal(nav.pos, new THREE.Vector3())
      .normalize().multiplyScalar(nearest.seaRadius);
    const forward = devWaterWakeFixture?.motion || new THREE.Vector3(0, 0, 0);
    const radial = origin.clone().normalize();
    const side = new THREE.Vector3().crossVectors(radial, forward).normalize();
    nearest.group.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    return waterInteraction.positions.map((position, i) => {
      const data = waterInteraction.data[i];
      const delta = position.clone().sub(origin);
      const screen = nearest.group.localToWorld(position.clone()).project(camera);
      return {
        active: data.z > 0.001,
        age: data.x,
        strength: data.z,
        foam: data.w,
        distance: delta.length(),
        forward: delta.dot(forward),
        side: delta.dot(side),
        screen: [screen.x, screen.y, screen.z],
      };
    }).filter((entry) => entry.active);
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
    abortTransits();
    nodePipeline.invalidateVolumeHistory('teleport');
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
    _landingProbeAt = -1;
    recallInFlight = false;
    ship.landingPose = null;
    ship.hoverMode = null;
    ship.orbitalStandby = false;
    ship.parkedPlanet = null;
    ship.parkedLocal = null;
    ship.parkedLocalQuat = null;
    ship.parkedPosUniv = null;
    ship.parkAmt = 0;
    ship.shipQuat?.copy(nav.quat);
    return true;
  },
  // hover low over a sunlit stretch of coastline, facing out to sea —
  // the water-depth-gradient showcase (a scenic dir is often inland)
  coast(i, alt = 1400) {
    const p = universe.system.planets[i];
    if (!p || !p.hasLiquid) return false;
    abortTransits();
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
    nodePipeline.invalidateVolumeHistory('teleport');
    p.localPositionToWorld(best.clone().multiplyScalar(p.R + p.seaLevel + alt), nav.pos);
    nav.vel.set(0, 0, 0);
    nav.quat.copy(p.frameOrientation).multiply(horizonQuat(best, seaward, new THREE.Quaternion()));
    nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), -0.32));
    focusPlanet = p; spaceCtl.focus = p;
    _landingProbeAt = -1;
    recallInFlight = false;
    ship.landingPose = null;
    ship.hoverMode = null;
    ship.orbitalStandby = false;
    ship.parkedPlanet = null;
    ship.parkedLocal = null;
    ship.parkedLocalQuat = null;
    ship.parkedPosUniv = null;
    ship.parkAmt = 0;
    ship.shipQuat?.copy(nav.quat);
    return true;
  },
  // instantly stand on planet i at its scenic spot (no pointer lock).
  // bias picks the lighting: 'sunset' lands on the terminator ring, 'night'
  // on the far side (headlamp comes on), 'meadow' seeks flat vegetated
  // ground facing the tree line, default lands in full daylight.
  land(i, yawDeg = 0, bias = null) {
    if (typeof yawDeg === 'string') { bias = yawDeg; yawDeg = 0; }
    if (!Number.isFinite(yawDeg)) yawDeg = 0;
    const p = universe.system.planets[i];
    if (!p || p.isGasGiant || p.landable === false) return false;
    abortTransits();
    nodePipeline.invalidateVolumeHistory('teleport');
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
    const avoidSnow = (meadow || bias === 'sunset') && p.type !== 'ice';
    let prefer = sunDir, ring = null;
    if (bias === 'night') prefer = sunDir.clone().negate();
    else if (bias === 'sunset') { prefer = null; ring = sunDir; }
    let dir = p.scenicDir(prefer, ring);
    if (avoidSnow && p.snowWeightAt(dir, p.height(dir, 128)) > 0.16) {
      let bestClear = null, bestClearScore = -Infinity;
      for (let k = 0; k < 1800; k++) {
        const y = 1 - (2 * (k + 0.5)) / 1800;
        const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
        _v.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
        const h = p.height(_v, 128);
        if ((p.hasLiquid && h < p.seaLevel + 4)
          || p.snowWeightAt(_v, h) > 0.12) continue;
        const lightScore = bias === 'sunset'
          ? 1 - Math.abs(_v.dot(sunDir))
          : Math.max(0, _v.dot(sunDir));
        const biome = p.biomeAt(_v, h);
        const biomeScore = ['grass', 'forest', 'dryland', 'slime', 'weird'].includes(biome)
          ? 1 : 0;
        const score = lightScore * 12 + biomeScore * 4 - Math.abs(h) / Math.max(p.hAmp, 1);
        if (score > bestClearScore) {
          bestClearScore = score;
          bestClear = _v.clone();
        }
      }
      if (bestClear) dir.copy(bestClear);
    }
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
      if (avoidSnow && p.snowWeightAt(cand, h) > 0.16) continue;
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
          let maxEl = -1, waterSteps = 0;
          for (let dd = 250; dd <= 6000; dd += 250) {
            probe.copy(cand).addScaledVector(e2, fx * dd / p.R).addScaledVector(e1, fy * dd / p.R).normalize();
            const probeHeight = p.height(probe, 128);
            const el = (probeHeight - h) / dd;
            if (el > maxEl) maxEl = el;
            if (p.hasLiquid && probeHeight < p.seaLevel + 3) waterSteps++;
          }
          s = -Math.max(0, maxEl - 0.06) * 400 - waterSteps * 0.55;
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
    shipView.closeRamp();
    shipView.rampT = 0;
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
    // The deterministic flight-wake fixture temporarily owns nav.pos. A
    // subsequent dive is a new camera fixture and must release that ownership,
    // otherwise the wake updater pulls the walker back above the sea.
    if (devWaterWakeFixture?.clockWasFrozen !== undefined) {
      celestialClock.frozen = devWaterWakeFixture.clockWasFrozen;
    }
    devWaterWakeFixture = null;
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
    const targetUniv = (recallInFlight && ship.landingPose?.posUniv)
      ? ship.landingPose.posUniv
      : ship.parkedPosUniv;
    if (state !== 'walk' || !targetUniv) return false;
    const p = walkCtl.planet;
    p.worldPositionToLocal(targetUniv, _v).sub(walkCtl.posLocal);
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
    else if (state === 'skydive') { skydiveCtl.yaw += deg * Math.PI / 180; skydiveCtl.updateQuat(); }
    else if (state === 'shipwalk') shipView.walkYaw += deg * Math.PI / 180;
    else nav.quat.multiply(_q.setFromAxisAngle(_v3.set(0, 1, 0), -deg * Math.PI / 180));
  },
  lookPitch(deg) {
    if (state === 'walk') { walkCtl.pitch = clamp(walkCtl.pitch + deg * Math.PI / 180, -1.45, 1.45); walkCtl.update(0.001); }
    else if (state === 'skydive') { skydiveCtl.pitch = clamp(skydiveCtl.pitch + deg * Math.PI / 180, -1.48, 1.46); skydiveCtl.updateQuat(); }
    else if (state === 'shipwalk') shipView.walkPitch = clamp(
      shipView.walkPitch + deg * Math.PI / 180, -1.4, 1.4);
    else nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), deg * Math.PI / 180));
  },
  flyTo: (i) => { const p = universe.system.planets[i]; if (p) { focusPlanet = p; spaceCtl.focus = p; flyToPlanet(p); } },
  tryLand, takeoff, boardShip, recallShip,
  launch: () => launchParkedShip(),
  board: () => boardShip(),
  exitShip: () => exitShip(),
  shipDistance: () => parkedShipDistance(),
  skydiveState: () => ({
    active: skydiveCtl.active,
    phase: skydiveCtl.phase,
    agl: +skydiveCtl.agl.toFixed(2),
    airspeed: +skydiveCtl.airspeed.toFixed(2),
    deployT: +skydiveCtl.deployT.toFixed(3),
    canopyVisible: !!skydiveCtl.rig?.canopy.visible && skydiveCtl.active,
    handsVisible: !!skydiveCtl.rig?.root.visible,
    sinkRate: skydiveCtl.sinkRate || 0,
    brakeLeft: skydiveCtl.brakeLeft || 0,
    brakeRight: skydiveCtl.brakeRight || 0,
    cloud: skydiveCtl.cloud || 0,
    aadTriggered: skydiveCtl.aadTriggered,
  }),
  shipLandingState: () => {
    const padGaps = [];
    if (ship.parkedPlanet && ship.parkedLocal && ship.parkedLocalQuat && !ship.hoverMode && !ship.orbitalStandby) {
      for (let i = 0; i < GEAR_PADS.length; i++) {
        const [px, pz] = GEAR_PADS[i];
        const padY = GEAR_GROUND_Y + (ship.gearOffsets?.[i] || 0);
        const worldPt = _v.set(px, padY, pz).applyQuaternion(ship.parkedLocalQuat).add(ship.parkedLocal);
        const r = worldPt.length();
        const dir = worldPt.multiplyScalar(1 / Math.max(r, 1));
        padGaps.push(+(r - ship.parkedPlanet.surfaceRadius(dir)).toFixed(4));
      }
    }
    return {
      hoverMode: ship.hoverMode,
      orbitalStandby: ship.orbitalStandby,
      recallInFlight,
      gearOffsets: [...(ship.gearOffsets || [0, 0, 0])].map((v) => +v.toFixed(4)),
      padGaps,
      gearT: +(ship.gearT ?? 0).toFixed(3),
      parkAmt: +ship.parkAmt.toFixed(3),
    };
  },
  // HALCYON first-person layer: exposed for the playtest harness.
  shipViewState: () => ({
    viewMode: shipView.viewMode,
    viewBlend: +shipView.viewBlend.toFixed(3),
    parkedCamBlend: +shipView.parkedCamBlend.toFixed(3),
    shipwalk: shipView.shipwalk,
    walkPos: shipView.walkPos.toArray(),
    walkYaw: shipView.walkYaw,
    rampT: +shipView.rampT.toFixed(3),
    rampTarget: shipView.rampTarget,
    rampWalkable: shipView.rampWalkable(!!ship.parkedPosUniv && ship.parkAmt > 0.98),
    seatT: +shipView.seatT.toFixed(3),
  }),
  shipViewDebug: {
    setViewMode(m) {
      if (state === 'space' || state === 'landed' || state === 'takeoff') {
        shipView.viewMode = m;
        shipView.viewBlend = 1;
        shipView.parkedCamBlend = 1;
        ui.setCockpitView(shipView.isCockpit());
      }
      return shipView.viewMode;
    },
    teleportNearSeat() {
      if (shipView.shipwalk) {
        shipView.walkPos.set(0, 0, ship.def.dims.seatZ + 1.15);
        shipView.walkYaw = Math.PI;
      }
    },
    teleportNearRamp() {
      if (shipView.shipwalk) {
        shipView.walkPos.set(0, 0, ship.def.dims.holdEndZ - 1.4);
        shipView.walkYaw = Math.PI;
      }
    },
    toggleRamp() { shipView.rampTarget = shipView.rampTarget > 0.5 ? 0 : 1; },
  },
  nearStars: () => universe.nearStarsList
    .map((s) => ({ id: s.id, dist: Math.round(s.pos.distanceTo(nav.pos)), pos: s.pos.toArray() }))
    .sort((a, b) => a.dist - b.dist).slice(0, 50),
  starCount: () => universe.nearStarsList.length,
  time: () => celestialClock.snapshot(),
  setTimeFrozen(value = true) {
    if (!DEV_SERVER) return false;
    celestialClock.frozen = !!value;
    return celestialClock.snapshot();
  },
  setTime(hours) {
    waterInteraction.clear();
    celestialClock.set(hours);
    universe.update(nav.pos, false, celestialClock.hours);
    universe.updateRelative(nav.pos);
    return celestialClock.snapshot();
  },
  setSunAltitude(i, degrees, { faceSun = false } = {}) {
    if (!DEV_SERVER) return null;
    const p = universe.system.planets[i];
    if (!p || p.isGasGiant) return null;
    if (!walkCtl.active || walkCtl.planet !== p) this.land(i, 0, 'sunset');
    const target = Math.sin(clamp(Number(degrees) || 0, -89, 89) * Math.PI / 180);
    const start = celestialClock.hours;
    const period = Math.max(1, p.spec?.rotationPeriodHours || 24);
    let bestTime = start, bestError = Infinity, bestElevation = 0;
    for (let sample = 0; sample <= 720; sample++) {
      const hours = start + period * sample / 720;
      celestialClock.set(hours);
      universe.update(nav.pos, false, hours);
      const localUp = walkCtl.posLocal.clone().normalize();
      const elevation = localUp.dot(p.sunDirLocal);
      const error = Math.abs(elevation - target);
      if (error < bestError) {
        bestError = error;
        bestTime = hours;
        bestElevation = elevation;
      }
    }
    celestialClock.set(bestTime);
    universe.update(nav.pos, false, bestTime);
    if (faceSun) {
      const localUp = walkCtl.posLocal.clone().normalize();
      const sunHorizon = p.sunDirLocal.clone()
        .addScaledVector(localUp, -p.sunDirLocal.dot(localUp));
      if (sunHorizon.lengthSq() > 1e-4) {
        walkCtl.enter(p, walkCtl.posLocal, sunHorizon.normalize());
        walkCtl.pitch = 0.02;
        walkCtl.update(0.001);
      }
    }
    p.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
    universe.updateRelative(nav.pos);
    return {
      hours: bestTime,
      requestedDegrees: degrees,
      actualDegrees: Math.asin(clamp(bestElevation, -1, 1)) * 180 / Math.PI,
      faceSun,
    };
  },
  setLocalSunAltitude(i, degrees, {
    faceSun = false,
    azimuthHint = null,
    framingOffsetDegrees = 0,
  } = {}) {
    if (!DEV_SERVER) return null;
    const p = universe.system.planets[i];
    if (!p || p.isGasGiant) return null;
    // Change the light for a visual A/B without silently choosing a different
    // beach. Preserve camera position and orientation in the rotating body
    // frame while searching one local day for the requested solar elevation.
    const localPosition = p.worldPositionToLocal(nav.pos, new THREE.Vector3());
    const localOrientation = p.frameOrientation.clone().invert().multiply(nav.quat);
    const localUp = localPosition.clone().normalize();
    const target = Math.sin(clamp(Number(degrees) || 0, -89, 89) * Math.PI / 180);
    const start = celestialClock.hours;
    const period = Math.max(1, p.spec?.rotationPeriodHours || 24);
    const preferredAzimuth = Array.isArray(azimuthHint)
      ? new THREE.Vector3(...azimuthHint).addScaledVector(localUp,
        -new THREE.Vector3(...azimuthHint).dot(localUp)).normalize() : null;
    let bestTime = start, bestError = Infinity, bestElevation = 0;
    let alignedTime = start, alignedError = Infinity, alignedElevation = 0;
    for (let sample = 0; sample <= 720; sample++) {
      const hours = start + period * sample / 720;
      celestialClock.set(hours);
      universe.update(nav.pos, false, hours);
      const elevation = localUp.dot(p.sunDirLocal);
      const error = Math.abs(elevation - target);
      if (error < bestError) {
        bestError = error;
        bestTime = hours;
        bestElevation = elevation;
      }
      if (preferredAzimuth) {
        const sunHorizon = p.sunDirLocal.clone()
          .addScaledVector(localUp, -elevation);
        if (sunHorizon.lengthSq() > 1e-5
          && sunHorizon.normalize().dot(preferredAzimuth) > 0
          && error < alignedError) {
          alignedError = error;
          alignedTime = hours;
          alignedElevation = elevation;
        }
      }
    }
    if (alignedError < Infinity) {
      bestTime = alignedTime;
      bestError = alignedError;
      bestElevation = alignedElevation;
    }
    celestialClock.set(bestTime);
    universe.update(nav.pos, false, bestTime);
    p.localPositionToWorld(localPosition, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(localOrientation);
    if (faceSun) {
      const sunHorizon = p.sunDirLocal.clone()
        .addScaledVector(localUp, -p.sunDirLocal.dot(localUp));
      if (sunHorizon.lengthSq() > 1e-4) {
        sunHorizon.normalize().applyAxisAngle(localUp,
          clamp(Number(framingOffsetDegrees) || 0, -24, 24) * Math.PI / 180);
        const targetLocal = localPosition.clone()
          .addScaledVector(sunHorizon, 18000)
          .addScaledVector(localUp, -120);
        const targetWorld = p.localPositionToWorld(targetLocal, new THREE.Vector3());
        lookQuatAt(nav.pos, targetWorld, nav.quat,
          p.localOffsetToWorld(localUp, new THREE.Vector3()).normalize());
      }
    }
    nav.vel.set(0, 0, 0);
    universe.updateRelative(nav.pos);
    focusPlanet = p;
    spaceCtl.focus = p;
    // The next render's moving-frame assist must see this as the new baseline;
    // otherwise it applies the entire orbital time jump a second time.
    referenceBody = p;
    referenceBodyPos.copy(p.posUniv);
    referenceBodyFramePrev.copy(p.frameOrientation);
    referenceBodyFrameValid = true;
    return {
      hours: bestTime,
      requestedDegrees: degrees,
      actualDegrees: Math.asin(clamp(bestElevation, -1, 1)) * 180 / Math.PI,
      faceSun,
      azimuthAligned: alignedError < Infinity,
    };
  },
  setAtmosphereAltitude(i, metres, opts = {}) {
    if (!DEV_SERVER) return false;
    const p = universe.system.planets[i];
    return p ? this.teleport(i, Math.max(0, Number(metres) || 0) / p.R,
      { horizon: true, pitch: -0.12, ...opts }) : false;
  },
  setContinuousAtmosphereAltitude(i, metres, opts = {}) {
    if (!DEV_SERVER) return null;
    const p = universe.system.planets[i];
    if (!p || p.isGasGiant) return null;
    // A deterministic continuous-flight fixture: unlike teleport(), this does
    // not clear control state, reset LOD telemetry, or replace the scene. The
    // browser playtest calls it once per animation frame so the ordinary
    // render/update/chunk scheduler sees every intermediate altitude with the
    // normal HUD and post stack still active.
    const localDir = opts.dir
      ? new THREE.Vector3(...opts.dir).normalize()
      : p.worldPositionToLocal(nav.pos, new THREE.Vector3()).normalize();
    const altitude = Number.isFinite(opts.clearance)
      ? Math.max(p.height(localDir, p.fullMaxFreq), p.hasLiquid ? p.seaLevel : -Infinity) + Math.max(0, opts.clearance)
      : Math.max(0, Number(metres) || 0);
    p.localPositionToWorld(localDir.clone().multiplyScalar(p.R + altitude), nav.pos);
    nav.vel.set(0, 0, 0);
    const sunDir = p.sunDirLocal.clone();
    const forward = opts.forward
      ? new THREE.Vector3(...opts.forward)
        .addScaledVector(localDir, -new THREE.Vector3(...opts.forward).dot(localDir))
      : new THREE.Vector3().crossVectors(localDir, sunDir);
    if (forward.lengthSq() < 1e-5) {
      forward.crossVectors(localDir,
        Math.abs(localDir.y) < 0.9 ? _v2.set(0, 1, 0) : _v2.set(1, 0, 0));
    }
    forward.normalize();
    if (opts.surfaceTargetDirection || opts.surfaceTarget) {
      // The continuous visual gate needs to follow an actual coast rather than
      // a signed pitch convention. Aim at a point on the authored surface a
      // distance ahead that shrinks with altitude: orbital frames still read
      // as a globe, while the final kilometres retain water, shore and inland
      // relief together in the ordinary flight camera.
      let targetDir;
      if (opts.surfaceTargetDirection) {
        // Absolute authored target used by the oblique descent gate. The
        // camera may traverse hundreds of kilometres laterally while every
        // frame continues to look at the exact same coastal landmark.
        targetDir = new THREE.Vector3(...opts.surfaceTargetDirection).normalize();
      } else {
        const surfaceForward = new THREE.Vector3(...opts.surfaceTarget)
          .addScaledVector(localDir, -new THREE.Vector3(...opts.surfaceTarget).dot(localDir));
        if (surfaceForward.lengthSq() < 1e-5) surfaceForward.copy(forward);
        surfaceForward.normalize();
        const lookAhead = clamp(Number(opts.surfaceTargetDistance) || 5200, 1800, 52000);
        targetDir = localDir.clone()
          .addScaledVector(surfaceForward, lookAhead / p.R).normalize();
      }
      const targetLocal = targetDir.clone().multiplyScalar(p.surfaceRadius(targetDir) + 45);
      const targetWorld = p.localPositionToWorld(targetLocal, new THREE.Vector3());
      const cameraUpWorld = p.localOffsetToWorld(localDir, new THREE.Vector3()).normalize();
      lookQuatAt(nav.pos, targetWorld, nav.quat, cameraUpWorld);
    } else {
      nav.quat.copy(p.frameOrientation)
        .multiply(horizonQuat(localDir, forward, new THREE.Quaternion()));
      nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), opts.pitch ?? -0.18));
    }
    focusPlanet = p;
    spaceCtl.focus = p;
    return { altitude, dir: localDir.toArray(), forward: forward.toArray() };
  },
  setWaterWake(i, { height = 8, speed = 180 } = {}) {
    if (DEV_SERVER && devWaterWakeFixture?.clockWasFrozen !== undefined) {
      celestialClock.frozen = devWaterWakeFixture.clockWasFrozen;
    }
    if (!DEV_SERVER || !this.coast(i, height)) return false;
    const p = universe.system.planets[i];
    const local = p.worldPositionToLocal(nav.pos, new THREE.Vector3());
    const up = local.normalize();
    const axisA = new THREE.Vector3().crossVectors(up,
      Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const axisB = new THREE.Vector3().crossVectors(up, axisA);
    const candidate = new THREE.Vector3();
    let waterDir = null;
    let bestWaterDepth = 0;
    waterSearch: for (let radius = 360; radius <= 18000; radius += 360) {
      for (let sample = 0; sample < 48; sample++) {
        const angle = sample / 48 * Math.PI * 2;
        candidate.copy(up)
          .addScaledVector(axisA, Math.cos(angle) * radius / p.R)
          .addScaledVector(axisB, Math.sin(angle) * radius / p.R).normalize();
        const candidateDepth = p.seaLevel - p.height(candidate, p.fullMaxFreq);
        if (candidateDepth > bestWaterDepth) {
          bestWaterDepth = candidateDepth;
          waterDir = candidate.clone();
          if (candidateDepth >= 55) break waterSearch;
        }
      }
    }
    if (!waterDir || bestWaterDepth < 5) return false;
    // `height` is the requested visible keel clearance. The camera/control
    // origin sits above and behind the foreground hull, so place that origin
    // high enough for the actual formation transform to skim rather than
    // letting a depth-independent foreground ship pass through the sea.
    const cameraToKeel = 15.25;
    p.localPositionToWorld(
      waterDir.multiplyScalar(p.seaRadius + height + cameraToKeel), nav.pos,
    );
    up.copy(waterDir).normalize();
    const tangentA = new THREE.Vector3().crossVectors(up,
      Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    let tangent = tangentA.clone();
    const tangentB = new THREE.Vector3().crossVectors(up, tangentA).normalize();
    let safestDepth = -Infinity;
    for (let heading = 0; heading < 24; heading++) {
      const angle = heading / 24 * Math.PI * 2;
      const direction = new THREE.Vector3().copy(tangentA).multiplyScalar(Math.cos(angle))
        .addScaledVector(tangentB, Math.sin(angle)).normalize();
      let pathDepth = Infinity;
      for (let distance = 120; distance <= 1200; distance += 120) {
        candidate.copy(up).addScaledVector(direction, distance / p.R).normalize();
        pathDepth = Math.min(pathDepth, p.seaLevel - p.height(candidate, p.fullMaxFreq));
      }
      if (pathDepth > safestDepth) {
        safestDepth = pathDepth;
        tangent = direction;
      }
    }
    nav.quat.copy(p.frameOrientation).multiply(horizonQuat(up, tangent, new THREE.Quaternion()));
    nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), height > 15 ? -0.22 : -0.34));
    const wakeCenter = up.clone().multiplyScalar(p.seaRadius).addScaledVector(tangent, 47.5);
    waterInteraction.setPlanet(p.seed);
    waterInteraction.inject(wakeCenter, {
      strength: 0.82,
      speed: 8.5,
      foam: 0.5,
      direction: tangent,
      kind: 'wake',
    });
    // Give the deterministic capture a small radial lift so the ship remains
    // above the surface long enough to observe the generated wake. Normal
    // gameplay still uses the actual flight controller and gravity.
    p.localOffsetToWorld(_v2.copy(tangent).multiplyScalar(speed).addScaledVector(up, 82), nav.vel);
    devWaterWakeFixture = {
      planet: p,
      origin: up.clone(),
      tangent: tangent.clone().normalize(),
      direction: up.clone(),
      motion: tangent.clone().normalize(),
      rotation: new THREE.Quaternion(),
      height,
      cameraToKeel,
      // Pull the deterministic chase camera farther astern so the Kelvin
      // shoulders remain between camera and hull instead of crossing behind
      // the camera within 0.2 s at 150 m/s. Ordinary flight keeps the authored
      // 30 m formation; this offset exists only while the DEV_SERVER fixture
      // owns the trajectory.
      cameraLead: 35,
      speed,
      startedAt: performance.now(),
      // Hold still while the deterministic fixture's terrain and 32 m near
      // patch finish streaming. The art gate explicitly releases motion;
      // letting an eight-second timer run during LOD settlement meant the
      // ship had already stopped and every wake impulse had decayed before
      // the first evidence frame was captured.
      settleTime: Infinity,
      duration: Infinity,
    };
    return true;
  },
  startWaterWake() {
    if (!DEV_SERVER || !devWaterWakeFixture) return false;
    if (devWaterWakeFixture.clockWasFrozen !== undefined) {
      celestialClock.frozen = devWaterWakeFixture.clockWasFrozen;
      delete devWaterWakeFixture.clockWasFrozen;
    }
    devWaterWakeFixture.opticalHidden = false;
    delete devWaterWakeFixture.heldExposure;
    devWaterWakeFixture.origin.copy(devWaterWakeFixture.direction);
    devWaterWakeFixture.startedAt = performance.now();
    devWaterWakeFixture.settleTime = 0;
    devWaterWakeFixture.duration = 12;
    devWaterWakeFixture.muted = false;
    devWaterWakeFixture.held = false;
    waterInteraction.clear();
    waterWakeTimer = 0;
    return true;
  },
  holdWaterWake() {
    if (!DEV_SERVER || !devWaterWakeFixture) return false;
    if (!devWaterWakeFixture.held) {
      devWaterWakeFixture.heldExposure = renderer.toneMappingExposure;
      devWaterWakeFixture.heldGradeTime = gradePass_?.uniforms.uTime.value ?? clock.elapsedTime;
    }
    // Freeze the simulation snapshot before an optical A/B capture. Muting
    // only after taking the on-frame lets the moving camera see different
    // water, which overwhelms the wake signal with unrelated surface motion.
    devWaterWakeFixture.origin.copy(devWaterWakeFixture.direction);
    devWaterWakeFixture.startedAt = performance.now();
    devWaterWakeFixture.held = true;
    devWaterWakeFixture.duration = Infinity;
    if (devWaterWakeFixture.clockWasFrozen === undefined) {
      devWaterWakeFixture.clockWasFrozen = celestialClock.frozen;
    }
    celestialClock.frozen = true;
    return true;
  },
  muteWaterWake(muted = true) {
    if (!DEV_SERVER || !devWaterWakeFixture) return false;
    // Require an explicit held packet; optical toggles cannot alter trajectory,
    // clock, injection, contents, or age as a side effect.
    if (!devWaterWakeFixture.held) return false;
    devWaterWakeFixture.opticalHidden = !!muted;
    return true;
  },
  advanceWaterWake(seconds) {
    if (!DEV_SERVER || !devWaterWakeFixture?.held
      || !Number.isFinite(seconds) || seconds < 0 || seconds > 8) return false;
    waterInteraction.update(seconds);
    return true;
  },
  waterWakeDebug() {
    if (!DEV_SERVER || !devWaterWakeFixture) return null;
    return {
      held: !!devWaterWakeFixture.held,
      opticalHidden: !!devWaterWakeFixture.opticalHidden,
      hours: celestialClock.hours,
      oceanSeconds: devWaterWakeFixture.planet.liquidMat?.userData?.waterUniforms?.uOceanTime?.value,
      position: nav.pos.toArray(), quaternion: nav.quat.toArray(),
      cameraPosition: camera.position.toArray(), cameraQuaternion: camera.quaternion.toArray(),
      exposure: renderer.toneMappingExposure,
      gradeTime: gradePass_?.uniforms.uTime.value,
      cursor: waterInteraction.cursor,
      field: waterInteraction.positions.map((position, i) => ({
        position: position.toArray(), data: waterInteraction.data[i].toArray(),
        direction: waterInteraction.directions[i].toArray(),
      })),
    };
  },
  setWade(i, {
    depth = 0.9,
    overview = false,
    overviewHeight = 64,
    look = 'land',
  } = {}) {
    if (!DEV_SERVER) return false;
    const p = universe.system.planets[i];
    if (!p || !p.hasLiquid || (p.liquid !== 'water' && p.liquid !== 'toxic')) return false;
    if (devWaterWakeFixture?.clockWasFrozen !== undefined) {
      celestialClock.frozen = devWaterWakeFixture.clockWasFrozen;
    }
    devWaterWakeFixture = null;
    window.NMS_NOLOCK = true;
    tweens.length = 0;
    const targetDepth = clamp(Number(depth) || 0.9, 0.45, 2);
    const center = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const axisA = new THREE.Vector3();
    const axisB = new THREE.Vector3();
    const gradientProbe = new THREE.Vector3();
    let best = null, bestLand = null, bestError = Infinity, bestScore = -Infinity;
    let bestCurvature = 0;
    let bestLandHeight = 0, bestSeaDepth = 0;
    let bestLandRelief = 0, bestHinterlandRelief = 0;
    // A 900 km body leaves tens of kilometres between global Fibonacci
    // samples, so looking for an exact one-metre depth by chance is not a
    // shoreline solver. Find a local segment that brackets the requested
    // depth, then bisect it on the sphere.
    for (let k = 0; k < 1800; k++) {
      const y = 1 - (2 * (k + 0.5)) / 1800;
      const r = Math.sqrt(1 - y * y), ga = k * 2.399963229728653;
      center.set(Math.cos(ga) * r, y, Math.sin(ga) * r);
      const centerDepth = p.seaLevel - p.height(center, p.fullMaxFreq);
      axisA.crossVectors(center,
        Math.abs(center.y) < 0.9 ? _v2.set(0, 1, 0) : _v2.set(1, 0, 0)).normalize();
      axisB.crossVectors(center, axisA).normalize();
      for (let sample = 0; sample < 12; sample++) {
        const angle = sample / 12 * Math.PI * 2;
        edge.copy(center)
          .addScaledVector(axisA, Math.cos(angle) * 24000 / p.R)
          .addScaledVector(axisB, Math.sin(angle) * 24000 / p.R).normalize();
        let edgeDepth = p.seaLevel - p.height(edge, p.fullMaxFreq);
        if ((centerDepth - targetDepth) * (edgeDepth - targetDepth) > 0) continue;
        // Preserve the coarse bracketing endpoint on the landward side. The
        // final bisection endpoints are centimetres apart and cannot provide
        // a stable QA camera heading.
        const landAnchor = (centerDepth < edgeDepth ? center : edge).clone();
        let a = center.clone(), b = edge.clone();
        let aDepth = centerDepth;
        for (let step = 0; step < 24; step++) {
          mid.copy(a).add(b).normalize();
          const midDepth = p.seaLevel - p.height(mid, p.fullMaxFreq);
          if ((aDepth - targetDepth) * (midDepth - targetDepth) <= 0) {
            b.copy(mid);
            edgeDepth = midDepth;
          } else {
            a.copy(mid);
            aDepth = midDepth;
          }
        }
        const actualDepth = p.seaLevel - p.height(mid, p.fullMaxFreq);
        const error = Math.abs(actualDepth - targetDepth);
        const sunlight = mid.dot(p.sunDirLocal);
        const weather = p.weatherAt?.(mid);
        // Production clouds remain enabled in every final capture, but the
        // deterministic coast should not intentionally descend through the
        // opaque core of a weather cell. Prefer a naturally open interval so
        // the same bay and hinterland remain readable from orbit to shore.
        const cloudObscuration = clamp((weather?.coverage || 0) * 0.72
          + (weather?.lowMask || 0) * 0.18
          + (weather?.stratusMask || 0) * 0.24, 0, 1);
        // A valid one-metre contour can still be kilometres of ruler-straight
        // beach. Sample along its local tangent and prefer a coastline whose
        // zero contour bends within the overview footprint. This changes only
        // deterministic QA placement; it does not author a fake test coast.
        const candidateLandward = landAnchor.clone()
          .addScaledVector(mid, -landAnchor.dot(mid)).normalize();
        const candidateTangent = new THREE.Vector3()
          .crossVectors(mid, candidateLandward).normalize();
        let curvature = 0;
        for (const distance of [-900, -450, 450, 900]) {
          gradientProbe.copy(mid)
            .addScaledVector(candidateTangent, distance / p.R).normalize();
          curvature += Math.abs((p.seaLevel
            - p.height(gradientProbe, p.fullMaxFreq)) - targetDepth);
        }
        curvature *= 0.25;
        gradientProbe.copy(mid)
          .addScaledVector(candidateLandward, 320 / p.R).normalize();
        const landHeight = p.height(gradientProbe, p.fullMaxFreq) - p.seaLevel;
        gradientProbe.copy(mid)
          .addScaledVector(candidateLandward, -320 / p.R).normalize();
        const seaDepth = p.seaLevel - p.height(gradientProbe, p.fullMaxFreq);
        gradientProbe.copy(mid)
          .addScaledVector(candidateLandward, 1400 / p.R).normalize();
        const landRelief = p.height(gradientProbe, p.fullMaxFreq) - p.seaLevel;
        gradientProbe.copy(mid)
          .addScaledVector(candidateLandward, 3600 / p.R).normalize();
        const hinterlandRelief = p.height(gradientProbe, p.fullMaxFreq) - p.seaLevel;
        const shelfRead = smoothstep(1.5, 7.0, Math.min(landHeight, seaDepth))
          * (1 - smoothstep(28, 65, Math.max(landHeight, seaDepth)));
        const latitudeFit = 1 - smoothstep(0.48, 0.76, Math.abs(mid.y));
        const readableRelief = smoothstep(7, 18, landHeight)
          * (1 - smoothstep(46, 78, landHeight));
        const scenicRelief = smoothstep(180, 950,
          Math.max(landRelief, hinterlandRelief));
        const coastRead = overview
          ? Math.min(curvature / 14, 1) * 0.9 + shelfRead * 0.65
            + latitudeFit * 0.42 + readableRelief * 0.38 + scenicRelief * 2.8 : 0;
        const score = sunlight * (overview ? 0.35 : 1) + coastRead - error * 4
          - cloudObscuration * (overview ? 2.7 : 0.35)
          - Math.max(0, landHeight - 68) * 0.018;
        if (score > bestScore) {
          bestScore = score;
          bestError = error;
          bestCurvature = curvature;
          bestLandHeight = landHeight;
          bestSeaDepth = seaDepth;
          bestLandRelief = landRelief;
          bestHinterlandRelief = hinterlandRelief;
          best = mid.clone();
          bestLand = landAnchor;
        }
        if (!overview && bestError < 0.015 && sunlight > 0.55
          && (!overview || (bestCurvature > 5 && shelfRead > 0.72
            && Math.abs(mid.y) < 0.62))) break;
      }
      if (!overview && bestError < 0.015 && bestScore > 0.55
        && (!overview || (bestCurvature > 5 && Math.abs(best.y) < 0.62
          && bestLandHeight > 1.5 && bestLandHeight < 42
          && bestSeaDepth > 1.5 && bestSeaDepth < 42))) break;
    }
    if (!best) return false;
    // Resolve the *local* uphill direction. The 24 km bracket endpoint only
    // tells us which side eventually reaches land; a non-monotonic coast can
    // cross that segment several times, so it is not a reliable camera axis.
    axisA.crossVectors(best,
      Math.abs(best.y) < 0.9 ? _v2.set(0, 1, 0) : _v2.set(1, 0, 0)).normalize();
    axisB.crossVectors(best, axisA).normalize();
    const gradientStep = 80 / p.R;
    const hAp = p.height(gradientProbe.copy(best).addScaledVector(axisA, gradientStep).normalize(),
      p.fullMaxFreq);
    const hAn = p.height(gradientProbe.copy(best).addScaledVector(axisA, -gradientStep).normalize(),
      p.fullMaxFreq);
    const hBp = p.height(gradientProbe.copy(best).addScaledVector(axisB, gradientStep).normalize(),
      p.fullMaxFreq);
    const hBn = p.height(gradientProbe.copy(best).addScaledVector(axisB, -gradientStep).normalize(),
      p.fullMaxFreq);
    const landward = axisA.clone().multiplyScalar(hAp - hAn)
      .addScaledVector(axisB, hBp - hBn);
    if (landward.lengthSq() < 1e-6) {
      landward.copy(bestLand).addScaledVector(best, -bestLand.dot(best));
    }
    landward.normalize();
    if (overview) {
      // Visual QA needs a readable patch of both materials. A real wading eye
      // is less than a metre above the water and collapses the entire shore
      // transition to the horizon, so provide a stationary oblique drone view
      // over the exact same solved coastline. The lateral offset is deliberate:
      // looking exactly along the beach normal reduced a curved procedural
      // coast to a horizontal colour strip and hid the wet/swash structure.
      if (walkCtl.active) walkCtl.exit();
      setState('space');
      const lateral = new THREE.Vector3().crossVectors(best, landward).normalize();
      const cameraDir = best.clone()
        .addScaledVector(landward, -260 / p.R)
        .addScaledVector(lateral, -520 / p.R).normalize();
      const targetDir = best.clone()
        .addScaledVector(landward, 360 / p.R)
        .addScaledVector(lateral, 80 / p.R).normalize();
      const resolvedOverviewHeight = clamp(Number(overviewHeight) || 64, 24, 120);
      const cameraLocal = cameraDir.clone().multiplyScalar(
        p.seaRadius + resolvedOverviewHeight,
      );
      p.localPositionToWorld(cameraLocal, nav.pos);
      nav.vel.set(0, 0, 0);
      const targetLocal = targetDir.clone().multiplyScalar(p.surfaceRadius(targetDir) + 2);
      const targetWorld = p.localPositionToWorld(targetLocal, new THREE.Vector3());
      // Aim at the solved land point directly. Reconstructing this with a
      // horizon quaternion plus a signed pitch inverted on some rotating
      // frames and put the camera under the terrain instead of over the coast.
      lookQuatAt(nav.pos, targetWorld, nav.quat);
      focusPlanet = p;
      spaceCtl.focus = p;
      return {
        requestedDepth: targetDepth,
        actualDepth: p.seaLevel - p.height(best, p.fullMaxFreq),
        overview: true,
        overviewHeight: resolvedOverviewHeight,
        direction: best.toArray(),
        landward: landward.toArray(),
        cameraDepth: p.seaLevel - p.height(cameraDir, p.fullMaxFreq),
        targetHeight: p.height(targetDir, p.fullMaxFreq) - p.seaLevel,
        shoreCurvature: bestCurvature,
        latitude: Math.asin(clamp(best.y, -1, 1)),
        landHeight320: bestLandHeight,
        seaDepth320: bestSeaDepth,
        landHeight1400: bestLandRelief,
        landHeight3600: bestHinterlandRelief,
      };
    }
    _v2.copy(best).multiplyScalar(p.surfaceRadius(best) + 1.7);
    // Face the resolved coast so the fixture demonstrates the wet band and
    // shore break instead of placing both outside the screenshot.
    _v3.copy(landward);
    if (look === 'sea') _v3.negate();
    if (_v3.lengthSq() < 0.1) _v3.crossVectors(p.sunDirLocal, best).normalize();
    if (_v3.lengthSq() < 0.1) _v3.set(1, 0, 0);
    walkCtl.enter(p, _v2, _v3);
    // The sea-facing fixture deliberately includes the close shelf below the
    // player's boots as well as the horizon. A purely grazing view is almost
    // all aerial perspective and cannot demonstrate shallow-water depth,
    // caustic breakup or the terrain visible through the water column.
    walkCtl.pitch = look === 'land' ? -0.38 : -0.34;
    walkCtl.update(0.001);
    p.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
    focusPlanet = p;
    spaceCtl.focus = p;
    setState('walk');
    // Entering the solved shallows displaces water even before the first full
    // stride; this also gives the ripple field a stable initial condition.
    waterInteraction.setPlanet(p.seed);
    waterInteraction.inject(best.clone().multiplyScalar(p.seaRadius),
      { strength: 0.38, speed: 4.8, foam: 0.28 });
    return {
      requestedDepth: targetDepth,
      actualDepth: p.seaLevel - p.height(best, p.fullMaxFreq),
      overview: false,
      direction: best.toArray(),
      landward: landward.toArray(),
      look,
    };
  },
  setWalkDirection(direction) {
    if (!DEV_SERVER || state !== 'walk' || !walkCtl.planet || !Array.isArray(direction)) return false;
    const p = walkCtl.planet;
    const dir = new THREE.Vector3().fromArray(direction).normalize();
    walkCtl.posLocal.copy(dir).multiplyScalar(p.surfaceRadius(dir) + walkCtl.eyeHeight);
    walkCtl.previousPosLocal.copy(walkCtl.posLocal);
    walkCtl.hSpeed.set(0, 0, 0);
    walkCtl.vR = 0;
    walkCtl.grounded = true;
    walkCtl.updateQuat();
    p.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(p.frameOrientation).multiply(walkCtl.quat);
    return true;
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
    abortTransits();
    nodePipeline.invalidateVolumeHistory('teleport');
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
  beginPreparedWarp() {
    beginSelectedWarp();
    return state === 'warp';
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
    anchorLocked: !!riftRoute?.anchorLocked,
    openStarted: !!riftRoute?.openStarted,
    pendingCrossing: !!riftRoute?.pendingCrossing,
    phase: riftPortal.phase,
    shape: riftPortal.shape,
    halfWidth: riftPortal.halfWidth,
    halfHeight: riftPortal.halfHeight,
    radius: riftPortal.radius,
    reach: riftRoute?.reach ?? null,
    open: riftPortal.openness,
    seam: riftPortal.open.x,
    tension: riftPortal.open.tension,
    burst: riftPortal.open.flash,
    visible: riftPortal.isVisible,
    composite: nodePipeline.portalComposite.enabled,
    farRendered: !!portalView.rendered,
    farWarmState: riftFarWarmState,
    foldNavPhase,
    audioCue: audio.lastCue,
    // metres in front of the opening (+) along its normal; null after crossing
    distanceToThreshold: riftRoute && !riftRoute.arrived ? riftPortal.locate(nav.pos).z : null,
    destinationLight: riftPreviewSystem?.starViews.map((view) => view.light.intensity)
      || universe.system?.starViews.map((view) => view.light.intensity) || [],
    previewVolume: (() => {
      const target = riftPreviewSystem?.bodyById.get(riftRoute?.arrival?.bodyId);
      if (!target) return null;
      return {
        bodyId: target.bodyId,
        preloaded: !!riftRoute?.previewPreloaded,
        ready: riftPreviewReady,
        preparation: warpPreparedRiftWarmState,
        radius: target.R || 0,
        cloudCoverage: target.cloudCoverage || 0,
        farAtmosphereBody: portalView.pipeline?.atmospherePass.activePlanet?.bodyId || null,
        farCloudBody: portalView.pipeline?.cloudPass?.activePlanet?.bodyId || null,
      };
    })(),
  }),
  approachRift(distance = 38, offsetOrX = 0, offsetY = 0) {
    if (!riftRoute || riftRoute.arrived || !riftRoute.anchorLocked) return false;
    const opts = typeof offsetOrX === 'object' && offsetOrX !== null
      ? offsetOrX : { x: Number(offsetOrX) || 0, y: Number(offsetY) || 0 };
    // distance is measured from the mouth's surface (0 for plane, radius for sphere)
    const surface = riftPortal.shape === 'sphere' ? riftPortal.radius : 0;
    nav.pos.set(Number(opts.x) || 0, Number(opts.y) || 0, surface + Number(distance))
      .applyQuaternion(riftOrientation).add(riftEntranceUniv);
    if (opts.yaw || opts.pitch || opts.roll) {
      nav.quat.copy(riftOrientation).multiply(_q.setFromEuler(
        new THREE.Euler(Number(opts.pitch) || 0, Number(opts.yaw) || 0, Number(opts.roll) || 0, 'YXZ'),
      ));
    }
    nav.vel.set(0, 0, 0);
    return true;
  },
  cancelRift() {
    return cancelRiftRoute();
  },
  setPulse(active) {
    return !!active && triggerPulse();
  },
  // Visual lab: freeze the transit look at one timeline instant without
  // moving the ship (fixed-camera captures of every phase).
  holdTransit(kind = 'warp', t = 0, distance = 5e12) {
    if (!['pulse', 'warp'].includes(kind)) return false;
    transitHold = { kind, t: Number(t), plan: warpPlan(typeof distance === 'number' ? distance : 5e12),
      pulse: typeof distance === 'object' ? distance : {} };
    return { kind, t: transitHold.t, total: kind === 'pulse' ? PULSE_TIMING.total : transitHold.plan.total,
      plan: kind === 'warp' ? { ...transitHold.plan } : null };
  },
  releaseTransit() {
    transitHold = null;
    return true;
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
  throwGrenade: () => surfaceGameplay.throwGrenade({
    planet: walkCtl.planet || nearest,
    navPos: nav.pos,
    eyeWorld: camera.getWorldPosition(new THREE.Vector3()),
    dirWorld: camera.getWorldDirection(new THREE.Vector3()),
    playerVelLocal: walkCtl.hSpeed,
  }),
  spawnCombatEncounter: (opts = {}) => surfaceGameplay.spawnCombatEncounter({
    planet: walkCtl.planet || nearest,
    playerLocal: walkCtl.posLocal,
    ...opts,
  }),
  surfaceGameplayState: () => surfaceGameplay.stats(),
  surfaceWeaponState: () => {
    const activeModel = surfaceWeapons.ensureModel(surfaceWeapons.index);
    return {
      index: surfaceWeapons.index,
      weaponId: SURFACE_WEAPONS[surfaceWeapons.index].id,
      weaponName: SURFACE_WEAPONS[surfaceWeapons.index].name,
      weaponCount: SURFACE_WEAPONS.length,
      ammo: activeModel.ammo,
      rendered: surfaceWeapons.rig.visible
        && activeModel.group.visible
        && foregroundPass.enabled,
      assetLoaded: true,
      reloading: surfaceWeapons.reloadT > 0,
      reloadProgress: surfaceWeapons.reloadDuration > 0
        ? 1 - surfaceWeapons.reloadT / surfaceWeapons.reloadDuration : 0,
      magazine: activeModel.magazine?.position.toArray() || null,
      ads: surfaceWeapons.ads,
      equip: activeModel.viewmodel.equipState(),
      stance: walkCtl.stance,
      crouching: walkCtl.crouching,
      sliding: walkCtl.sliding,
      grenades: surfaceGameplay.grenadeCount,
      scopeEyeBox: activeModel.opticGlass?.material?.uniforms?.eyeBox?.value ?? null,
    };
  },
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
  get _internals() {
    return {
      universe,
      warpConduit,
      nodePipeline,
      portalView,
      riftPortal,
      scene,
      renderer,
      nav,
      camera,
      ship,
      shipView,
      sceneRadiance,
      spaceCtl,
      starMap,
      riftPreviewSystem,
      walkCtl,
      weatherEffects,
      audio,
      surveyUnits,
      surfaceGameplay,
      surfaceWeapons,
    };
  },
};

// Reproducible visual-QA poses. These are opt-in URL states and never alter
// the normal campaign start.
if (qs.get('scene') === 'walk') {
  window.NMS.land(Number(qs.get('planet') || 0), Number(qs.get('yaw') || 0), qs.get('bias') || 'meadow');
  if (qs.get('face') === 'ship') window.NMS.faceShip();
}

if (DEV_SERVER && qs.get('scene') === 'bay-approach') {
  const { coastalApproach } = await import('./coastal-approach.js');
  const course = coastalApproach(universe.system.planets[0]);
  const pose = course.pose(17000, 0, 8500, -0.54, 0);
  window.NMS.teleport(0, 0.01, pose);
  window.NMS.setLocalSunAltitude(0, 26, { azimuthHint: course.along });
  window.NMS.setContinuousAtmosphereAltitude(0, 0, pose);
}

if (DEV_SERVER && qs.get('scene') === 'river-approach' && universe.system.planets[0]?.coastalDrainage) {
  const { riverApproach } = await import('./coastal-approach.js');
  const course = riverApproach(universe.system.planets[0]);
  const pose = course.pose(-6500, 800, 5200, -0.30, 0);
  window.NMS.teleport(0, 0.01, pose);
  window.NMS.setLocalSunAltitude(0, 32, { azimuthHint: course.along });
  window.NMS.setContinuousAtmosphereAltitude(0, 0, pose);
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
