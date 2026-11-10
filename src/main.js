import { selectStellarOccluders } from './stellar-occlusion.js';
// Entry point: renderer, the state machine (space flight → fly-to → landing →
// walking → takeoff → warp), camera-relative rendering (the camera never
// leaves the origin — the universe moves around it, so float precision holds
// from interstellar space down to boot level), and the ambience pass
// (atmosphere, fog, day/night, star dimming).

import * as THREE from 'three';
import { StarSystem, Universe } from './galaxy.js';
import { flushChunkQueue, pendingChunks, setGridCells, lodStats, lodStatsReset, setPxPerRad,
  setTerrainScreenError } from './quadtree.js';
import { SpaceControls, WalkControls, guidePlanetApproach, keys,
  flightBoostSpeedLimit, pulseBurstDistance, pulseBurstProgress } from './controls.js';
import { Scatter } from './scatter.js';
import { FarFlora } from './farflora.js';
import { createSurfaceWarmupScene } from './surface-warmup.js';
import { compileRenderVariant, withSurfaceWarmupVariant } from './render-prewarm.js';
import { compilePrograms } from './program-preparation.js';
import { compileDestinationVariant, compileWorldPublicationVariant, worldPublicationRevision } from './destination-preparation.js';
import { captureWorldPublication } from './world-publication.js';
import { FrameWorkBudget } from './frame-work-budget.js';
import { PresentedFrameStats } from './presented-frame-stats.js';
import { landingDescentProgress, SHIP_LANDING_PROFILE,
  warpTravelProgress, SkyDome, Ship, ShipWeapons, SHIP_FOREGROUND_LAYER,
  SHIP_INTERIOR_LAYER } from './effects.js';
import { ShipView } from './ship-view.js';
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
import { SpatialRift } from './spatial-rift.js';
import { SurfaceWeapons, SURFACE_WEAPONS } from './surface-weapons.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning } from './world-config.js';
import { setVolumetricCloudsEnabled } from './planet.js';
import { resolveRendererPolicy } from './renderer-policy.js';
import { createGameRenderer, installDeviceRecovery } from './renderer-runtime.js';
import { GameLegacyPipeline } from './legacy-render-pipeline.js';
import { SurfaceShadowGrid } from './surface-shadow-grid.js';
import { isLowPowerGpu, rendererParamsForSettings, resolveGraphicsSettings,
  resolveQualityProfile, writeGraphicsSettings } from './graphics-settings.js';
import { createEnvironmentState, updateEnvironmentState } from './environment-state.js';
import { SceneRadianceState } from './scene-radiance.js';
import { waterInteraction } from './water-interaction.js';
import { oceanSeconds, oceanClockJumped } from './ocean-clock.js';
import { surfaceInteraction } from './surface-interaction.js';
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
    renderer,
    spaceRadianceResolution: QUALITY_PROFILE.spaceRadianceResolution,
    renderLook: RENDER_LOOK_NEXT,
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
const renderer = rendererRuntime.renderer;
const actualRendererBackend = rendererRuntime.backend;
const gpuName = rendererRuntime.gpuName;
configureSurfaceMaterials(renderer);
const AUTO_LOW_GPU = graphicsSettings.quality === 'auto' && isLowPowerGpu(gpuName);
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
// Mild supersampling on <=1440p desktop protects the hero ship even when the
// OS reports DPR 1. Very high-resolution displays stay at native scale.
const DESKTOP_DPR_FLOOR = QUALITY_PROFILE.dprMin;
let renderDpr = Math.min(Math.max(window.devicePixelRatio, QUALITY_PROFILE.dprTarget), MAX_DPR);
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
const surfaceBootstrapGroup = new THREE.Group();
let surfaceBootstrapPending = false;
const surfaceBootstrapTarget = new THREE.RenderTarget(2, 2, { depthBuffer: true });
let surfaceBootstrapStats=null;
let shipPipelinesWarmed = false;
let shipPipelineWarmPending = false;
let heroTransitionActive = false;
const startupWarmStartedAt = performance.now();
const STARTUP_WARM_BUDGET_MS = QUALITY_LOW ? 1800 : 9000;
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
  const settled = (stats, targetLevel) => !stats
    || (stats.visibleMaxLevel >= targetLevel
      && stats.activeMorphs === 0 && stats.pending === 0);
  return settled(terrain, planet.lod.planet.orbitLevelCap)
    && settled(water, planet.waterLod?.planet?.orbitLevelCap ?? 0);
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
  planet.group.traverse((object) => {
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
      const key = `${material.uuid}|${attributes}|${object.castShadow ? 1 : 0}`;
      if (!surfaceSources.has(key)) surfaceSources.set(key, { object, material });
    }
  });
  for (const { object: source, material } of surfaceSources.values()) {
    const geometry = source.geometry.clone();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.lodMorph = 0;
    mesh.position.set(0, 0, 0);
    mesh.frustumCulled = false;
    mesh.castShadow = source.castShadow;
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
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
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
    if (!startupPrewarmExpired) shipPipelinesWarmed = true;
  }).catch(error => {
    if (!startupPrewarmExpired) console.warn('ship pipeline prewarm failed', error);
  }).finally(() => {
    // Expiry already releases these flags; a late completion never changes the
    // bootstrap mesh set or returns a saved scene state over a later frame.
    shipPipelineWarmPending = false;
    surfacePipelinesReady = true;
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
const VOLUME_ENABLED = qs.get('vclouds') !== '0';
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
const nodePipeline = new GameLegacyPipeline(renderer, scene, camera, {
  volume: VOLUME_ENABLED,
  cloudProgramPreparation: qs.get('cloudprograms') === '1',
  cloudFarSplit: qs.get('cloudsplit') === '1',
  volumeScale: effectiveVolumeScale,
  bloomEnabled: qs.get('post') !== '0' && !QUALITY_LOW,
  bloomStrength: RENDER_LOOK_NEXT ? (IS_TOUCH ? 0.24 : 0.30) : (IS_TOUCH ? 0.35 : 0.5),
  bloomRadius: RENDER_LOOK_NEXT ? 0.22 : 0.4,
  bloomThreshold: RENDER_LOOK_NEXT ? 1.15 : 1.05,
  foregroundLayer: SHIP_FOREGROUND_LAYER,
  interiorLayer: RENDER_LOOK_NEXT ? SHIP_INTERIOR_LAYER : null,
  realisticGrade: RENDER_LOOK_NEXT,
});
const volumePass = nodePipeline.volumePass;
const atmospherePass = nodePipeline.atmospherePass;
atmospherePass.setVisualEnabled(qs.get('atmosphere') !== '0');
const warpDrivePass = nodePipeline.warp;
const foregroundPass = nodePipeline.foregroundPass;
const parkedInteriorPass = nodePipeline.parkedInteriorPass;
const riftDistortionPass = nodePipeline.rift;
const bloomPass = nodePipeline.bloom;
const gradePass_ = nodePipeline.grade;
let usePost = !QUALITY_LOW && (bloomPass.enabled || VOLUME_ENABLED);
let spatialRift = null;
let pipelineResizePending = false;
function pipelineResourcesBusy() {
  return shipPipelineWarmPending || heroTransitionActive || !surfacePipelinesReady;
}
function sizePost(force = false) {
  if (!force && pipelineResourcesBusy()) {
    pipelineResizePending = true;
    return false;
  }
  nodePipeline.setSize(window.innerWidth, window.innerHeight, renderDpr);
  pipelineResizePending = false;
  return true;
}

sizePost(true);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizePost();
  spatialRift?.resize(window.innerWidth, window.innerHeight, renderDpr);
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
const PULSE_DURATION = 0.56;
let pulseFuel = PULSE_FUEL_MAX;
let pulseActive = false;
let pulseBurst = null;
let pulseRechargeDelay = 0;
// 脉冲结束后行星接近限速不能硬切回普通档,否则向内速度会从脉冲延续值
// (boostLimit 量级)瞬间被砍到 safeInward(~55-几百),体感骤降。settle
// 期间 approachLimit 从 boostLimit 平滑收紧到 safeInwardBase,nav.vel
// 随之渐进被限,避免硬切跳变。
let pulseSettle = 0;
const PULSE_SETTLE_SECONDS = 0.8;
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
let riftForcedPost = false;
let riftBloomState = null;
const RIFT_SPAWN_DISTANCE = 780;
const RIFT_CAPTURE_DISTANCE = 1900;
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
const riftLocalPos = new THREE.Vector3();
const riftLocalVel = new THREE.Vector3();
const riftInverse = new THREE.Quaternion();
const riftAssistQuat = new THREE.Quaternion();
const riftPortalClearColor = new THREE.Color();
const riftPortalVisibility = [];
const riftPortalLayerState = [];
const riftPortalCloudState = [];
const RIFT_PORTAL_LAYER = 5;
let riftPortalClearAlpha = 1;
let riftPortalFog = null;
let riftPortalToneMapping = THREE.ACESFilmicToneMapping;
let riftPortalSceneActive = false;
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
let universe = createUniverse(SEED);
universe.timeHours = celestialClock.hours;
universe.system.updateCelestial(celestialClock.hours);
const sceneRadiance = new SceneRadianceState(renderer, scene, universe, {
  enabled: RENDER_LOOK_NEXT,
  probeResolution: QUALITY_PROFILE.reflectionProbeResolution,
});
const sceneBuildBudget=new FrameWorkBudget();
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
const ship = new Ship(scene, {
  anisotropy: Math.min(16, renderer.getMaxAnisotropy?.()
    ?? renderer.capabilities?.getMaxAnisotropy?.()
    ?? 1),
  renderer,
  radiance: sceneRadiance,
});
const shipView = new ShipView(ship, camera);
shipView.onHint = (text) => { if (!paused && !starMap?.isOpen) ui.setHint(text, true); };
spatialRift = new SpatialRift({
  scene,
  renderer,
  mainCamera: camera,
  portalScale: QUALITY_LOW ? 0.66 : 0.72,
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
function addTween(dur, fn, onDone, { realTime = false } = {}) {
  tweens.push({
    t: 0,
    dur,
    fn,
    onDone,
    realTime,
    startedAt: realTime ? performance.now() : 0,
  });
}
function stepTweens(dt) {
  const now = performance.now();
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t = tw.realTime ? (now - tw.startedAt) / 1000 : tw.t + dt;
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
  resolveCollision: resolveParkedShipCollision,
});

function cancelPulseBurst() {
  pulseBurst = null;
  // 启动 settle 窗口:让 approachLimit 从 boostLimit 平滑收紧到
  // safeInwardBase,避免脉冲结束注入的 nav.vel 被行星限速硬切跳变。
  if (pulseSettle <= 0) pulseSettle = PULSE_SETTLE_SECONDS;
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
  // 新脉冲开始:清掉上次脉冲的 settle,避免 cancelPulseBurst 因 pulseSettle
  // 仍 >0 而不重启 settle 窗口。
  pulseSettle = 0;
  return true;
}

renderer.domElement.addEventListener('pointerdown', () => {
  unlockAudio();
  if ((state === 'walk' || state === 'shipwalk') && !document.pointerLockElement
    && !window.NMS_NOLOCK && pointerLockInput) {
    renderer.domElement.requestPointerLock();
  }
});

window.addEventListener('keydown', (e) => {
  unlockAudio();
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
  if (!e.repeat && e.code === 'Space' && state === 'space') {
    e.preventDefault();
    triggerPulse();
  }
  if (!e.repeat && e.code === 'KeyV' && state === 'space' && !paused) {
    shipView.toggleView();
    ui.setCockpitView(shipView.isCockpit());
    ui.setHint(spaceControlHint(), false);
  }
  if (!e.repeat && e.code === 'KeyF') {
    if (state === 'space' && shipView.isCockpit() && !paused) {
      shipView.standUp(nav);
      setState('shipwalk');
    } else if (state === 'shipwalk' && !paused) {
      shipView.interact(nav);
    }
  }
  if (!e.repeat && e.code === 'KeyX' && state === 'space') nav.vel.set(0, 0, 0);
  if (!e.repeat && e.code === 'KeyE' && state === 'walk') boardShip();
  if (!e.repeat && e.code === 'KeyE' && state === 'shipwalk' && !paused) exitShip();
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
  onJoystick: (x, y) => { walkCtl.touchMove.x = x; walkCtl.touchMove.y = y; },
  onJump: (down) => { walkCtl.touchJump = down; },
  onTakeoff: () => boardShip(),
  onApplyGraphics: (settings) => {
    writeGraphicsSettings(settings);
    setTimeout(() => location.reload(), 180);
  },
});
// Surface a clickable low-power GPU hint on the hero start page before the
// first frame, so the player can switch the browser to its discrete GPU.
ui.setHeroPerfHint(AUTO_LOW_GPU, gpuName);
ui.setGraphicsSettings(graphicsSettings, QUALITY_PROFILE, {
  gpu: gpuName,
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
  if (restoreInput && !window.NMS_NOLOCK && pointerLockInput
    && ['space', 'walk', 'shipwalk'].includes(state)) {
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
  presentedFrames.setPaused(true,performance.now());
  spaceCtl.enabled = false;
  pauseOverlay.classList.remove('hidden');
  pausePanel.classList.remove('is-acquiring');
  pauseStatus.textContent = '指针已释放 · 点击继续以重新接管视角';
  audio.setPaused(true);
  music.setPaused(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

function requestGameplayPointerLock() {
  if (window.NMS_NOLOCK || !pointerLockInput || !['space', 'walk', 'shipwalk'].includes(state)) return Promise.resolve(true);
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
  if (locked && !window.NMS_NOLOCK && pointerLockInput && ['space', 'walk', 'shipwalk'].includes(state)) {
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
      && (state === 'space' || state === 'walk' || state === 'shipwalk')) {
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

function spaceControlHint() {
  if (IS_TOUCH) return '<b>单指</b> 转向 · <b>双指缩放</b> 推进 · <b>M</b> 星图';
  const rmb = shipView.isCockpit() ? '<b>RMB</b> 自由环视 · <b>SHIFT</b> 加力' : '<b>RMB/SHIFT</b> 加力';
  return `<b>鼠标</b> 船头 · <b>W/S</b> 推进/制动 · <b>A/D</b> 侧推 · <b>LMB</b> 射击 · ${rmb} · <b>SPACE</b> 脉冲冲刺 · <b>V</b> 座舱视角 · <b>M/TAB</b> 星图`;
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
  // cinematics own the camera; the cockpit view never survives them
  if (['landing', 'warp', 'takeoff', 'flyto', 'boarding'].includes(s)) shipView.forceChase();
  ui.setCockpitView(shipView.isCockpit());
  // Any state that is not shipwalk means the camera is no longer a person
  // inside the hull — release the interior's ownership of nav so the
  // flight physics / cinematic tweens can write it freely.
  if (s !== 'shipwalk' && shipView.shipwalk) {
    shipView.shipwalk = false;
    shipView.seatT = 1;
  }
  if (s !== 'shipwalk') ui.setInteractPrompt('');
  const landed = !!ship.parkedPosUniv && ship.parkAmt > 0.98;
  const hints = IS_TOUCH ? {
    space: spaceControlHint(),
    flyto: '自动接近中…',
    landing: '正在执行降落程序…',
    walk: '<b>摇杆</b> 移动 · <b>拖动</b> 观察 · <b>空格</b> 跳跃 · 靠近飞船按 <b>E</b>',
    shipwalk: '<b>摇杆</b> 舱内移动 · <b>F</b> 坐入驾驶座 / 开关尾舱门' + (landed ? ' · <b>E</b> 离船' : ''),
    boarding: '正在登船…',
    takeoff: '垂直起飞中…',
    warp: '空间折叠中…',
  } : {
    space: spaceControlHint(),
    flyto: '自动接近中… <b>Esc</b> 中止',
    landing: '正在执行降落程序…',
    walk: '<b>WASD</b> 移动 · <b>R</b> 换弹 · <b>RMB</b> 瞄准 · <b>T</b> 召回飞船 · 靠近飞船按 <b>E</b>',
    shipwalk: '<b>WASD</b> 舱内移动 · <b>Shift</b> 疾行 · <b>F</b> 坐入驾驶座 / 开关尾舱门' + (landed ? ' · <b>E</b> 离船' : ''),
    boarding: '正在登船…',
    takeoff: '垂直起飞中…',
    warp: '空间折叠中…',
  };
  ui.setHint(hints[s] || '', !['space', 'walk', 'shipwalk'].includes(s));
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
  // a landing always seals the hull first
  shipView.closeRamp();
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

const BOARD_DISTANCE = 60;

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

// Walk up the ramp: the boarding tween carries the camera from the surface
// into the hold, the cargo ramp opens during the move, and the interior walk
// takes over at the ramp threshold. Take-off is manual — sit down (F), throttle up.
function boardShip() {
  if (state !== 'walk' || !walkCtl.planet) return false;
  const dist = parkedShipDistance();
  if (dist > BOARD_DISTANCE) {
    ui.setHint(`飞船距离 ${Number.isFinite(dist) ? Math.round(dist) + ' m' : '未知'} · 按 <b>R</b> 召回飞船`, true);
    audio.cue('denied');
    return false;
  }
  const planet = walkCtl.planet;
  // planet-local start pose
  const startLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const startLocalQuat = planet._invFrame.clone().multiply(nav.quat);
  // target: standing in the hold just forward of the ramp threshold, facing
  // the cockpit — the same stance enterShipwalk hands over
  const spawnLocal = new THREE.Vector3(0, 1.68, ship.def.dims.holdEndZ - 1.6);
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
    // planet-local interpolation tracks the planet's rotation
    planet.localPositionToWorld(_v.lerpVectors(startLocal, targetLocal, e), nav.pos);
    nav.quat.copy(planet.frameOrientation)
      .multiply(_q.copy(startLocalQuat).slerp(targetLocalQuat, e));
  }, () => {
    // hand the camera to the interior at the parked anchor
    const anchorPos = planet.localPositionToWorld(ship.parkedLocal, new THREE.Vector3());
    const anchorQuat = planet.frameOrientation.clone().multiply(ship.parkedLocalQuat);
    shipView.enterShipwalk(anchorPos, anchorQuat, { z: spawnLocal.z, yaw: 0 });
    setState('shipwalk');
  });
  return true;
}

// Leave the ship while parked: tween the camera out through the ramp mouth
// to the surface beside it, then hand back to the planet walk.
function exitShip() {
  if (state !== 'shipwalk' || !ship.parkedPosUniv) return false;
  const planet = ship.parkedPlanet;
  if (!planet || ship.parkAmt < 0.98) return false;
  // only from the ramp area
  if (shipView.walkPos.z < 3.4) {
    ui.setHint('请走到尾舱坡道处再离船', true);
    return false;
  }
  // start: current camera pose, planet-local
  const startLocal = planet.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const startLocalQuat = planet._invFrame.clone().multiply(nav.quat);
  // target: ground beside the ramp mouth, facing the hull
  const exitShipLocal = new THREE.Vector3(0, -SHIP_LANDING_PROFILE.bounds.minY, ship.def.dims.rampTopZ + 2.6);
  const exitLocal = ship.parkedLocal.clone()
    .add(exitShipLocal.applyQuaternion(ship.parkedLocalQuat));
  // settle onto the terrain under the exit point
  const exitDir = exitLocal.clone().normalize();
  const groundRadius = planet.surfaceRadius(exitDir);
  exitLocal.copy(exitDir).multiplyScalar(groundRadius + walkCtl.eyeHeight * 0.9);
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
    // face the hull on arrival
    const toShip = _v.copy(ship.parkedLocal).sub(exitLocal)
      .projectOnPlane(exitDir).normalize();
    walkCtl.enter(planet, exitLocal.clone(), toShip);
    planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(walkCtl.quat);
    setState('walk');
  });
  return true;
}

// Debug/capture utility (NMS.takeoff, used by screenshot.js and seamtest.js):
// launches straight up from the camera's current position. Player-facing
// departures go through boardShip → sit down → throttle up.
function takeoff(planet = walkCtl.planet ?? ship.parkedPlanet, launchPos = nav.pos.clone(), launchUp = null) {
  if (!planet) return false;
  if (walkCtl.active) walkCtl.exit();
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
  ui.setHint(`已抵达 ${blackHole.name} 安全观测距离`, true);
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
  if (!preparedDestinationIsActive(token, route, prepared)) return;
  warpPreparedRiftStructureState = 'compiling';
  const signal = warpCompile.signal;
  try {
    await nodePipeline.prepare(() => {
      const groupVisible = spatialRift.group.visible, portalVisible = spatialRift.portalSurface.visible;
      try {
        spatialRift.group.visible = true;spatialRift.portalSurface.visible = true;
        return compilePrograms(renderer, spatialRift.group, camera, null, {signal});
      } finally {
        spatialRift.group.visible = groupVisible;spatialRift.portalSurface.visible = portalVisible;
      }
    }, { signal, label: 'rift-structure', isCurrent: () => preparedDestinationIsActive(token, route, prepared) });
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    warpPreparedRiftStructureState = 'complete';
  } catch (error) {
    if (!preparedDestinationIsActive(token, route, prepared)) return;
    warpPreparedRiftStructureState = 'failed';
    warpPreparedRiftWarmError = String(error?.message || error);
    console.error('Spatial-rift structure prewarm failed:', error);
  }
}

async function renderPreparedDestinationWarmFrame(targetBody, route, prepared, token) {
  if(!preparedDestinationIsActive(token,route,prepared)||route?.warpRequested)return false;
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
      rememberVisibility(spatialRift.group, false);

      const cameraState = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        fov: camera.fov,
      };
      const shadowState = {
        visible: sunShadow.visible,
        intensity: sunShadow.intensity,
      };
      const previousVolumePlanet = volumePass?.activePlanet || null;
      const previousAtmospherePlanet = atmospherePass.activePlanet || null;
      const oldTarget = renderer.getRenderTarget();
      const oldFace = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
      const oldMrt = renderer.getMRT?.();
      const targetQuat = lookQuatAt(route.target.entry, route.target.center, new THREE.Quaternion());

      try {
        camera.quaternion.copy(targetQuat);
        camera.updateMatrixWorld(true);
        sunShadow.visible = false;
        sunShadow.intensity = 0;
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
          for (const state of visibility) state.object.visible = state.visible;
        }
      }
      return true;
    }, { signal, label: 'destination-private-frame',
      isCurrent: () => preparedDestinationIsActive(token, route, prepared) && !route?.warpRequested });
  } catch (error) {
    if (!preparedDestinationIsActive(token, route, prepared) || route?.warpRequested) return false;
    throw error;
  }
}

async function prewarmPreparedRiftPortal(targetBody, token, route, prepared) {
  if (!preparedDestinationIsActive(token, route, prepared) || route?.warpRequested) return;
  if (warpPreparedRiftWarmState === 'compiling'
      || warpPreparedRiftWarmState === 'complete') return;
  if (!targetBody?.group || !route?.target?.entry) {
    if (preparedDestinationIsActive(token, route, prepared)) {
      warpPreparedRiftWarmState = 'complete';
    }
    return;
  }
  warpPreparedRiftWarmState = 'compiling';
  try {
    await warpPreparedRiftStructurePromise;
    if (!preparedDestinationIsActive(token, route, prepared) || route.warpRequested) return;
    await uploadPreparedLodMeshes(targetBody, prepared, token, route);
    if (!preparedDestinationIsActive(token, route, prepared) || route.warpRequested) return;

    const signal = warpCompile.signal;
    await nodePipeline.prepare(() => {
      prepared.updateCelestial(celestialClock.hours);
      const cameraOffset = route.target.entry.clone().sub(targetBody.posUniv);
      targetBody.volumeActive = true;
      targetBody.volumeBlend = 1;
      targetBody.update(cameraOffset, 1 / 60, true, 0);
      if (targetBody.volCloudMesh) targetBody.volCloudMesh.visible = true;
      universe.relativizeSystem(prepared, route.target.entry);

      const sourceQuat = nav.quat.clone();
      const sourceForward = new THREE.Vector3(0, 0, -1).applyQuaternion(sourceQuat).normalize();
      const sourcePosition = nav.pos.clone().addScaledVector(sourceForward, RIFT_SPAWN_DISTANCE);
      const targetQuat = lookQuatAt(route.target.entry, route.target.center, new THREE.Quaternion());
      spatialRift.setTransform(
        sourcePosition.sub(nav.pos),
        sourceQuat,
        new THREE.Vector3(),
        targetQuat,
      );
      // The direct portal has its own camera/layer/output family. Exercise its
      // actual target while the passage is hidden; the private main graph below
      // cannot prove that this separate view drew or allocated its attachments.
      const rendered = renderRiftDestinationPortal({
        force: true,
        previewSystem: prepared,
        targetBodyId: route.bodyId,
        previewOrigin: route.target.entry,
      });
      if (rendered !== true) throw Error('Destination portal warm frame was not submitted');
    }, { signal, label: 'destination-portal',
      isCurrent: () => preparedDestinationIsActive(token, route, prepared) && !route.warpRequested });
    if (!preparedDestinationIsActive(token, route, prepared) || route.warpRequested) return;
    await renderPreparedDestinationWarmFrame(targetBody, route, prepared, token);
    if (!preparedDestinationIsActive(token, route, prepared) || route.warpRequested) return;
    warpPreparedRiftWarmState = 'complete';
    warpPreparedRiftWarmError = null;
  } catch (error) {
    if (!preparedDestinationIsActive(token, route, prepared) || route.warpRequested) return;
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
    if (transferredPreparedDestination?.owner === 'rift'
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
        flushChunkQueue(QUALITY_LOW ? 4 : 12);
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
          uploadPreparedLodMeshes(targetBody, prepared, token, route)
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
      } while (performance.now() - sliceStartedAt < (QUALITY_LOW ? 5 : 14));
      setTimeout(step, 0);
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
  setTimeout(step, 0);
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
      let compilation;
      try {
        for (const view of universe.system?.starViews || []) view.light.visible = false;
        for (const view of prepared.starViews) view.light.visible = true;
        compilation = compilePrograms(renderer, mesh, camera, scene, {signal});
      } finally {
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
    fadeInPlanets: true,
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
    const startedAt = performance.now();
    do {
      const previousBodyCount = prepared.planets.length + prepared.compactObjects.length;
      prepared.buildNext();
      const bodies = [...prepared.planets, ...prepared.compactObjects];
      if (bodies.length > previousBodyCount) primePreparedBodyTextures(bodies.at(-1), prepared);
      hideBuiltBodies();
      if (route.bodyId && prepared.bodyById.has(route.bodyId)) break;
    } while (!prepared.built && performance.now() - startedAt < 3.5);
    if ((route.bodyId && prepared.bodyById.has(route.bodyId)) || prepared.built) {
      const targetBody = route.bodyId ? prepared.bodyById.get(route.bodyId) : null;
      warpPreparedWaterWarmPlanet = targetBody;
      warpPreparedWaterWarmState = 'waiting';
      warpPreparedLodWarmPlanet = targetBody;
      warpPreparedLodWarmState = 'waiting';
      prewarmPreparedLod(targetBody, token, route, prepared);
      // Do not put planet construction and WebGL program capture in one event
      // loop turn. Each is bounded on its own, but together they previously
      // formed the single half-second route/warp frame seen by the player.
      setTimeout(() => {
        if (preparedDestinationIsActive(token, route, prepared)) {
          void prewarmPreparedWater(targetBody, token, route, prepared);
        }
      }, 0);
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

function scheduleQueuedWarpLaunch(route, token, prepared) {
  if (route.warpLaunchScheduled) return;
  route.warpLaunchScheduled = true;
  const check = () => {
    if (!preparedDestinationIsActive(token, route, prepared)
        || pendingRoute !== route || !route.warpRequested || state !== 'space') return;
    const lodDone = ['complete', 'failed'].includes(warpPreparedLodWarmState);
    const waterDone = ['complete', 'failed'].includes(warpPreparedWaterWarmState);
    if (!lodDone || !waterDone) {
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
  spatialRift?.setPortalReadiness?.(0, true);
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
    // The aperture is a focused arrival view, not a second full-system camera.
    // Earlier deferred bodies can sit in camera-relative source coordinates
    // until adoption and appeared as a second giant sphere around the target.
    body.group.visible = visible && (!targetBodyId || body.bodyId === targetBodyId);
  }
  for (const group of standaloneSiteGroups(previewSystem)) group.visible = visible;
}

function addRiftPortalHidden(object) {
  if (!object || riftPortalVisibility.includes(object)) return;
  riftPortalVisibility.push(object, object.visible);
  object.visible = false;
}

function moveToRiftPortalLayer(object) {
  if (!object) return;
  object.traverse((child) => {
    riftPortalLayerState.push(child, child.layers.mask);
    child.layers.set(RIFT_PORTAL_LAYER);
  });
}

function hideSystemForRiftPortal(system, previewSystem = riftPreviewSystem) {
  if (!system || system === previewSystem) return;
  for (const view of system.starViews) {
    addRiftPortalHidden(view.group);
    addRiftPortalHidden(view.light);
  }
  for (const body of [...system.planets, ...system.compactObjects]) addRiftPortalHidden(body.group);
  for (const group of standaloneSiteGroups(system)) addRiftPortalHidden(group);
}

function beginRiftPortalScene(
  portalCamera,
  previewSystem = riftPreviewSystem,
  targetBodyId = riftRoute?.arrival?.bodyId || null,
) {
  riftPortalVisibility.length = 0;
  riftPortalLayerState.length = 0;
  riftPortalCloudState.length = 0;
  riftPortalFog = scene.fog;
  renderer.getClearColor(riftPortalClearColor);
  riftPortalClearAlpha = renderer.getClearAlpha();
  riftPortalToneMapping = renderer.toneMapping;
  riftPortalSceneActive = true;
  hideSystemForRiftPortal(universe.system, previewSystem);
  hideSystemForRiftPortal(universe.fadingSystem, previewSystem);
  for (const object of [
    ship.group,
    weapons.glowMesh,
    weapons.coreMesh,
    sunShadow,
    headlamp,
    skyDome.mesh,
    hemi,
    ambient,
  ]) addRiftPortalHidden(object);
  scene.fog = null;
  // Keep the offscreen destination in linear HDR. The visible portal then
  // flows through the same node output transform exactly once, just like
  // the adopted destination on the next frame.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000006, 1);
  // Remember authored visibility even for a partially entered/throwing view.
  for (const object of [riftPortalAmbient,
    ...(previewSystem?.starViews || []).flatMap(view => [view.group, view.light]),
    ...[...(previewSystem?.planets || []), ...(previewSystem?.compactObjects || [])].map(body => body.group),
    ...standaloneSiteGroups(previewSystem),
  ]) {
    if (object && !riftPortalVisibility.includes(object)) riftPortalVisibility.push(object, object.visible);
  }
  riftPortalAmbient.visible = true;
  setRiftPreviewVisible(true, previewSystem, targetBodyId);
  // Direct rendering needs an exclusive camera layer so source planets,
  // keepalive meshes and cockpit objects cannot enter the target.
  portalCamera.layers.set(RIFT_PORTAL_LAYER);
  moveToRiftPortalLayer(riftPortalAmbient);
  for (const view of previewSystem?.starViews || []) {
    moveToRiftPortalLayer(view.group);
    moveToRiftPortalLayer(view.light);
  }
  for (const body of [
    ...(previewSystem?.planets || []),
    ...(previewSystem?.compactObjects || []),
  ]) moveToRiftPortalLayer(body.group);
  for (const group of standaloneSiteGroups(previewSystem)) moveToRiftPortalLayer(group);
  for (const planet of previewSystem?.planets || []) {
    // A direct target has no separate depth-readable volume pass.
    const mesh = planet.volCloudMesh;
    if (!mesh?.visible || !planet.group.visible || mesh.material !== planet.volCloudMat) continue;
    const material = planet.getDirectCloudMaterial();
    riftPortalCloudState.push({ mesh, previous: mesh.material, material, depthTest: material.depthTest });
    mesh.material = material;
    material.depthTest = false;
  }
}

function endRiftPortalScene(
  previewSystem = riftPreviewSystem,
  targetBodyId = riftRoute?.arrival?.bodyId || null,
) {
  if (!riftPortalSceneActive) return;
  riftPortalSceneActive = false;
  for (let i = 0; i < riftPortalLayerState.length; i += 2) {
    riftPortalLayerState[i].layers.mask = riftPortalLayerState[i + 1];
  }
  riftPortalLayerState.length = 0;
  for (const { mesh, previous, material, depthTest } of riftPortalCloudState) {
    mesh.material = previous;
    material.depthTest = depthTest;
  }
  riftPortalCloudState.length = 0;
  for (let i = 0; i < riftPortalVisibility.length; i += 2) {
    riftPortalVisibility[i].visible = riftPortalVisibility[i + 1];
  }
  riftPortalVisibility.length = 0;
  scene.fog = riftPortalFog;
  renderer.toneMapping = riftPortalToneMapping;
  renderer.setClearColor(riftPortalClearColor, riftPortalClearAlpha);
}

function renderRiftDestinationPortal({
  force = false,
  previewSystem = riftPreviewSystem,
  targetBodyId = riftRoute?.arrival?.bodyId || null,
} = {}) {
  return spatialRift.renderPortal({
    force,
    beforeRender: (portalCamera) => {
      beginRiftPortalScene(portalCamera, previewSystem, targetBodyId);
    },
    afterRender: () => endRiftPortalScene(previewSystem, targetBodyId),
  });
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
  if (route.bodyId && warpPreparedSystem?.star.id === route.star.id
      && !warpPreparedSystem.bodyById.has(route.bodyId)) {
    ui.setHint('正在构建目的地实景 · 跃迁将在就绪后立即开始', true);
    return;
  }
  const prepared = takePreparedDestination(route, 'warp');
  requestGameplayPointerLock();
  ui.beginTravel();
  clearPendingRoute(false, true);
  warpTo(route.star, route.bodyId, prepared, route.target);
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
  bloomPass.strength = 0.76;
  bloomPass.radius = 0.20;
  bloomPass.threshold = 1.02;
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
  const prepared = takePreparedDestination(route, 'rift');
  requestGameplayPointerLock();
  clearPendingRoute(false, true);
  spaceCtl.enabled = true;
  ui.setCrosshair(true);
  riftRoute = {
    ...route,
    arrival,
    arrived: false,
    anchorLocked: false,
    lastHintBand: -1,
    previewPreloaded: !!prepared,
    previewBuildFrame: -1,
    openStarted: false,
  };
  riftEntranceUniv.copy(nav.pos).addScaledVector(forward, RIFT_SPAWN_DISTANCE);
  riftTargetUniv.copy(arrival.entry);
  riftPreviewOriginUniv.copy(arrival.entry);
  riftOrientation.copy(nav.quat);
  cancelPulseBurst();
  spaceCtl.boosting = false;
  if (nav.vel.length() > 18) nav.vel.setLength(18);
  riftPreviewSystem = prepared || new StarSystem(universe, route.star, {
    deferred: true,
    fadeInPlanets: false,
    timeHours: celestialClock.hours,
  });
  // The opening animation now owns the final few deferred builds when a player
  // confirms instantly. Usually the route-choice interval has already prepared
  // this exact scene graph; either way, no second destination is constructed.
  for (const body of [...riftPreviewSystem.planets, ...riftPreviewSystem.compactObjects]) {
    if ('appear' in body && body.appear < 1) {
      body.appear = 1;
      body.applyAppear?.();
    }
  }
  riftPreviewReady = false;
  spatialRift.setPortalReadiness?.(0, true);
  setRiftPreviewVisible(false);
  spatialRift.setTransform(
    riftEntranceUniv.clone().sub(nav.pos),
    riftOrientation,
    _v3.set(0, 0, 0),
    arrival.quat,
  );
  spatialRift.group.visible = false;
  if (riftDestinationPreparationReady()) {
    startRiftOpening();
  } else {
    ui.setHint('弦界坐标已锁定 · 正在预载目标世界与航道结构', true);
  }
}

function startRiftOpening() {
  if (!riftRoute || riftRoute.arrived || riftRoute.openStarted) return;
  riftRoute.openStarted = true;
  // Keep flight UI and the loading hint visible until the passage can open.
  ui.beginTravel();
  spatialRift.openPassage();
  enableRiftEffects();
  audio.cue('rift-open');
  ui.setHint('弦界坐标钉定 · 航道正在船头展开', true);
}

function riftDestinationPreparationReady() {
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
  if (!riftRoute.arrived && !riftRoute.openStarted
      && riftDestinationPreparationReady()) {
    startRiftOpening();
  }
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
      if (spatialRift.open >= 0.995 && !spatialRift.animating && riftPreviewReady) {
        riftRoute.anchorLocked = true;
        riftRoute.lastHintBand = -1;
      } else if (spatialRift.open >= 0.995 && !spatialRift.animating
          && riftRoute.lastHintBand !== 14) {
        riftRoute.lastHintBand = 14;
        ui.setHint('航道结构已展开 · 正在完成目标世界 GPU 接管', true);
      } else if (riftRoute.openStarted) {
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
    if (riftPreviewReady && spatialRift.crossed(previousRender, _v3.set(0, 0, 0))) {
      nav.pos.copy(riftRoute.arrival.entry);
      riftAssistQuat.copy(riftRoute.arrival.quat).multiply(riftOrientation.clone().invert());
      nav.quat.premultiply(riftAssistQuat);
      nav.vel.applyQuaternion(riftAssistQuat);
      const destination = universe.adoptSystem(riftPreviewSystem);
      riftPreviewSystem = null;
      // Route-time LOD refinement has served its purpose. Let the ordinary
      // frame-budgeted quadtree own any remaining detail after adoption;
      // otherwise its 14 ms preparation slices continue beside the live world
      // and cold-render hundreds of newly minted chunks during the hand-off.
      transferredPreparedDestination = null;
      // A rift is discontinuous; the source system must not participate in the
      // destination frame's light layout. Keeping it as Universe.fadingSystem
      // produced one combined-light pipeline wave, then another target-only
      // wave when the next update disposed it. Hide and park it now, then
      // release its resources under the next route overlay.
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
      destination.updateCelestial(celestialClock.hours);
      for (const view of destination.starViews) {
        view.group.visible = true;
        view.light.visible = true;
      }
      for (const group of standaloneSiteGroups(destination)) group.visible = true;
      const arrivalBody = destination.bodyById.get(riftRoute.arrival.bodyId) || null;
      deferredSystemWarmQueue.length = 0;
      for (const body of [...destination.planets, ...destination.compactObjects]) {
        const visibleAtHandoff = body === arrivalBody;
        body.group.visible = visibleAtHandoff;
        if (!visibleAtHandoff) deferredSystemWarmQueue.push({ system: destination, body });
      }
      systemBuildResumeAt = performance.now() + 1800;
      universe.relativizeSystem(destination, nav.pos);
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
  // The route selector owns exact production-context compilation. Do not issue
  // a cold full-resolution destination draw during the visible tear animation;
  // its first shader/texture wave was the apparent "flash, then portal" stall.
  if (warpPreparedRiftWarmState !== 'complete'
      && warpPreparedRiftWarmState !== 'failed') {
    riftPreviewReady = false;
    spatialRift.setPortalReadiness?.(0);
    return;
  }
  // The preview system is deliberately excluded from the live universe update.
  // Prime its planet LODs from the virtual destination camera so their root
  // chunks are visible inside the portal instead of leaving only a starfield.
  for (const planet of riftPreviewSystem.planets) {
    _v.copy(riftPreviewOriginUniv).sub(planet.posUniv);
    const isTarget = planet.bodyId === riftRoute.arrival.bodyId;
    if (isTarget) {
      // The portal is a second live view of the body that will own the very
      // next frame after crossing. Give it the same physical atmosphere/cloud
      // state now, and keep that state through adoption, instead of revealing
      // the volume layer only after the teleport.
      planet.volumeActive = true;
      planet.volumeBlend = 1;
    }
    planet.update(_v, 1 / 60, isTarget, 0);
    if (isTarget && planet.volCloudMesh) planet.volCloudMesh.visible = true;
  }
  for (const object of riftPreviewSystem.compactObjects) object.updateVisual?.(performance.now() * 0.001);
  // Use the exact camera-relative placement, stellar attenuation and sun glow
  // that the adopted destination will use on the first post-crossing frame.
  universe.relativizeSystem(riftPreviewSystem, riftPreviewOriginUniv);
  const target = riftPreviewSystem.bodyById.get(riftRoute.arrival.bodyId);
  if (target) {
    const terrainReady = !target.lod?.roots?.length
      || target.lod.roots.every((root) => !!root.mesh);
    riftPreviewReady = terrainReady && riftDestinationPreparationReady();
    spatialRift.setPortalReadiness?.(riftPreviewReady ? 1 : 0);
    for (const uniforms of [
      target.atmoUniforms || target.atmoMesh?.material?.uniforms,
      target.volCloudUniforms || target.volCloudMat?.uniforms,
    ]) {
      if (uniforms?.uDepthReady) uniforms.uDepthReady.value = 0;
    }
    target.syncAtmoMaterial?.();
    target.syncVolCloudMaterial?.();
  }
  let failed = false;
  try { renderRiftDestinationPortal(); }
  catch (error) { failed = true;throw error; }
  finally {
    // The destination view borrows medium bindings. Return them even if an
    // offscreen draw throws, before any later main view can consume them.
    const liveVolumePlanet = volumePass?.activePlanet;
    try {
      liveVolumePlanet?.syncAtmoMaterial?.();
      liveVolumePlanet?.syncVolCloudMaterial?.();
      nodePipeline.bindVolumeDepth?.(liveVolumePlanet);
    } catch (error) { if (!failed) throw error; }
  }
}

// A warp is a flight, not a teleport: align with the target, spool up, then
// cross real space at ferocious speed — every star in the sky parallaxes past,
// the destination sun grows from a dot — and decelerate into the new system.
function warpTo(star, preferBodyId = null, preparedSystem = null, preparedArrival = null) {
  if (state !== 'space') return;
  ui.beginWarpPower();
  setState('warp');
  warpArrival = 0;
  warpRevealBody = null;
  warpRevealCameraOffset = null;
  warpRevealActive = false;
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
    if (preparedSystem && preferBodyId && !preparedSystem.bodyById.has(preferBodyId)
        && !preparedSystem.built) {
      const previousBodyCount = preparedSystem.planets.length + preparedSystem.compactObjects.length;
      preparedSystem.buildNext();
      for (const group of standaloneSiteGroups(preparedSystem)) group.visible = false;
      const bodies = [...preparedSystem.planets, ...preparedSystem.compactObjects];
      const builtBody = bodies.length > previousBodyCount ? bodies.at(-1) : null;
      if (builtBody) {
        builtBody.group.visible = false;
        primePreparedBodyTextures(builtBody, preparedSystem);
      }
    }
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
      if (warpRevealBody && warpArrival > 0.02) warpRevealActive = true;
      camera.fov = BASE_FOV - 4 + 34 * ramp - 7.5 * warpArrival;
      warpIntensity = ramp;
      if (kf >= 0.04 && !swapped) {
        // Swap early enough that the real destination can materialise during
        // the tunnel, then converge on a large planet for the exit reveal.
        swapped = true;
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
          // A stellar warp is already millions of kilometres beyond the source
          // when the destination graph is adopted. Keeping the departure system
          // as Universe.fadingSystem cannot contribute a visible pixel behind
          // starflow, but it changes the active light count and forces every
          // destination PBR program to compile a combined-light variant on the
          // hand-off frame. Park it exactly like the spatial-rift hand-off and
          // dispose it under the next route overlay.
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
          destination = universe.setSystem(star, true);
        }
        // Route-choice idle time normally builds the selected body. A very fast
        // confirmation can still arrive first; build at most one body in this
        // frame and let the arrival guard handle an exceptionally early click.
        if (preferBodyId && !destination.bodyById.has(preferBodyId)) destination.buildNext();
        // A selected planet exclusively owns the destination reveal. Letting the
        // generic nearest-body scan jump across every orbital intersection made
        // hidden planets allocate terrain, volume pipelines and textures while
        // the starflow was supposed to remain uninterrupted.
        let hero = null;
        if (preferBodyId) {
          let picked = destination._specs.find((spec) => spec.bodyId === preferBodyId);
          if (picked?.isMoon) picked = destination._specs.find((spec) => spec.bodyId === picked.parentId);
          if (picked && !picked.isMoon) hero = picked;
        }
        if (hero) {
          const heroPos = destination.frames.get(hero.bodyId).position;
          warpRevealBody = destination.bodyById.get(hero.bodyId) || null;
          revealDirection = preparedArrival?.bodyId === hero.bodyId
            ? preparedArrival.entry.clone().sub(preparedArrival.center).normalize()
            : startPos.clone().sub(heroPos).normalize();
          arrivalSystem = destination; arrivalSpec = hero;
          warpRevealCameraOffset = revealDirection.clone()
            .multiplyScalar(blackHoleArrivalDistance(hero));
          endPos = heroPos.clone().add(warpRevealCameraOffset);
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
    // The route preloader normally guarantees the selected reveal body. Never
    // complete unrelated bodies in this arrival callback: constructors and
    // their root terrain meshes are synchronous and would freeze the last
    // tunnel frame. Resume one-body-per-frame background completion only after
    // the first stable post-arrival frames have been presented.
    setState('space');
    // Water is deliberately withheld only while starflow owns the reveal.
    // Restore the selected ocean before dropping the warp reference so normal
    // orbital/walking LOD updates cannot inherit the hidden state.
    warpRevealBody?.waterLod?.setVisible(true);
    warpRevealBody = null;
    warpRevealCameraOffset = null;
    warpRevealActive = false;
    systemBuildResumeAt = performance.now() + 900;
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
  ui.setSystem(sys.name, sys.planets.length, SEED, sys.catalogId, WORLD_LAB);
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

    const transit = p.cloudTransit ? p.cloudTransit(_v2.copy(nav.pos).sub(p.posUniv)) : 0;
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
  shadowBlend = nearest ? 1 - smoothstep(1200, 3500, nearestAlt) : 0;
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
function updateSurfaceInteraction(dt) {
  surfaceInteraction.update(dt);
  const p = nearest;
  if (!p || p.isGasGiant || p.type === 'artificialHabitat') {
    surfaceInteraction.setPlanet(null);
    return;
  }
  surfaceInteraction.setPlanet(p.bodyId || p.seed);
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
let dprAcc = 0;
let adaptiveStage = 0;
let adaptiveQualityLocked = false;
let adaptiveStableSince = 0;
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
  adaptiveStableSince = performance.now();
  applyAdaptiveStage(0);
  setRenderDpr(QUALITY_PROFILE.dprTarget);
  return true;
}

function setShadowDistance(distance) {
  effectiveShadowDistance = distance;
  sunShadow.shadow.camera.left = sunShadow.shadow.camera.bottom = -distance;
  sunShadow.shadow.camera.right = sunShadow.shadow.camera.top = distance;
  sunShadow.shadow.camera.updateProjectionMatrix();
}

function applyAdaptiveStage(stage) {
  adaptiveStage = clamp(Math.round(stage), 0, 7);
  effectiveWaterReflectionHz = QUALITY_PROFILE.waterReflectionHz
    * (adaptiveStage >= 3 ? 0.5 : 1);
  const adaptiveGrassScale = adaptiveStage >= 7 ? 0.5 : (adaptiveStage >= 4 ? 0.72 : 1);
  scatter.setGrassDensity(QUALITY_PROFILE.grassDensity * adaptiveGrassScale);
  setShadowDistance(QUALITY_PROFILE.shadowDistance * (adaptiveStage >= 5 ? 0.65 : 1));
  farFlora.setDisplayDensity(adaptiveStage >= 7 ? 0.45 : (adaptiveStage >= 6 ? 0.68 : 1));
  if (adaptiveStage < 7) {
    setRenderDpr(Math.max(renderDpr, QUALITY_PROFILE.dprTarget));
  } else {
    // DPR is the final adaptive lever, after volume, water cadence, foliage
    // and shadow distance have all been exhausted. Apply its reviewed floor in
    // one resize instead of waiting through another five-second stability gate
    // for each 0.05 step; at 1440p Ultra this still renders above native.
    setRenderDpr(Math.min(renderDpr, QUALITY_PROFILE.dprMin));
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
    if (!surfacePipelinesReady || shipPipelineWarmPending) return;
    bloomPass.enabled = usePost && !QUALITY_LOW;
    if (gradePass_) {
      gradePass_.enabled = usePost && !QUALITY_LOW;
      gradePass_.uniforms.uTime.value = DEV_SERVER && devWaterWakeFixture?.held
        ? devWaterWakeFixture.heldGradeTime : clock.elapsedTime;
    }
    rigidWorldObjects.set(ship.group, ship.foregroundOnly ? foregroundPass : nodePipeline.renderPass);
    rendered = draw({ origin: nav.pos, context: universe.system, timeEpoch: celestialClock.epoch,
      rigidObjects: rigidWorldObjects });
  });
  return rendered;
}

function frame() {
  requestAnimationFrame(frame);
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
  if (state === 'warp' && warpRevealBody) nearest = warpRevealBody;
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
    if (pulseSettle > 0 && !pulseBurst) {
      pulseSettle = Math.max(0, pulseSettle - dt);
    }
    // 行星接近限速目标。脉冲期间沿用原 1.18 放大;settle 期间从 boostLimit
    // 平滑收紧到 safeInwardBase,让脉冲结束注入的 nav.vel 不会被硬切,
    // 而是随 settle 进度渐进被限;正常飞行用 safeInwardBase。
    const safeInwardBase = 55 + Math.pow(Math.max(0, nearestAlt), 0.75) * 0.6;
    const boostLimitForApproach = flightBoostSpeedLimit(
      spaceCtl.speedScale, spaceCtl.atmosphereFactor, spaceCtl.gravityPower);
    let approachLimit;
    if (pulseBurst) {
      approachLimit = safeInwardBase * 1.18;
    } else if (pulseSettle > 0) {
      const settleProgress = 1 - pulseSettle / PULSE_SETTLE_SECONDS;
      approachLimit = lerp(boostLimitForApproach, safeInwardBase, settleProgress);
    } else {
      approachLimit = safeInwardBase;
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
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), approachLimit, 0);
    }
    flightStepStart.copy(nav.pos);
    spaceCtl.update(dt);
    if (pulseBurst) {
      pulseBurst.elapsed = Math.min(PULSE_DURATION, pulseBurst.elapsed + dt);
      const progress = pulseBurstProgress(pulseBurst.elapsed / PULSE_DURATION);
      nav.pos.addScaledVector(pulseBurst.direction,
        pulseBurst.distance * Math.max(0, progress - pulseBurst.progress));
      pulseBurst.progress = progress;
      if (pulseBurst.elapsed >= PULSE_DURATION) {
        // 脉冲末段 pulseVisual≈0,HUD 显示 ≈ boostLimit(加力上限)。
        // 但 nav.vel 在脉冲期间被 drag 衰减到接近 0;脉冲结束瞬间
        // pulseDisplaySpeed 归零,显示从 boostLimit 暴跌到 nav.vel,体感
        // “超快减速”。沿脉冲方向把 nav.vel 补到加力上限(不超限),
        // 让显示速度连续,之后由 drag 平滑接管减速。
        const boostLimit = flightBoostSpeedLimit(
          spaceCtl.speedScale, spaceCtl.atmosphereFactor, spaceCtl.gravityPower);
        const currentAlong = nav.vel.dot(pulseBurst.direction);
        if (currentAlong < boostLimit) {
          nav.vel.addScaledVector(pulseBurst.direction, boostLimit - currentAlong);
        }
        cancelPulseBurst();
      }
    }
    if (nearest) {
      _v.copy(nav.pos).sub(nearest.posUniv);
      const centerDistance = _v.length();
      const radialOut = _v.multiplyScalar(1 / Math.max(centerDistance, 1));
      const forward = _v2.set(0, 0, -1).applyQuaternion(nav.quat);
      guidePlanetApproach(nav.vel, forward, radialOut, centerDistance,
        nearest.R + Math.max(nearest.atmoHeight * 0.28, nearest.hAmp), approachLimit, dt);
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
  } else if (!paused && state === 'shipwalk') {
    // Interior walk: flight input is locked (spaceCtl disabled); while
    // airborne the hull keeps drifting on its standing velocity — the demo's
    // behaviour — and a parked hull stays put with the pad.
    shipView.integrateDrift(dt, nav);
  } else if (!paused && state === 'walk') {
    cancelPulseBurst();
    walkCtl.update(dt);
    walkCtl.planet.localPositionToWorld(walkCtl.posLocal, nav.pos);
    nav.quat.copy(walkCtl.planet.frameOrientation).multiply(walkCtl.quat);
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

  const boostTarget = state === 'space' && !shipView.rmbLookActive()
    && (spaceCtl.boosting || keys.ShiftLeft || keys.ShiftRight) ? 1 : 0;
  boostVisual += (boostTarget - boostVisual) * (1 - Math.exp(-dt * (boostTarget ? 7.5 : 8.5)));
  const pulseK = pulseBurst ? clamp(pulseBurst.elapsed / PULSE_DURATION, 0, 1) : 1;
  const pulseTarget = pulseBurst
    ? smoothstep(0, 0.04, pulseK) * (1 - smoothstep(0.55, 1, pulseK))
    : 0;
  pulseVisual = pulseTarget > pulseVisual
    ? pulseTarget
    : pulseVisual + (pulseTarget - pulseVisual) * (1 - Math.exp(-dt * 14));
  weaponVisual += ((weaponTrigger ? 1 : 0) - weaponVisual) * (1 - Math.exp(-dt * 16));
  if ((state === 'space' || state === 'shipwalk') && warpIntensity < 0.01) {
    const riftFov = riftRoute && !riftRoute.arrived ? spatialRift.burst * 4.0 : 0;
    const fovResponse = pulseTarget > pulseVisual ? 14 : 6.2;
    camera.fov += ((BASE_FOV + shipView.fovOffset() + boostVisual * 6.5 + pulseVisual * 19.0 + riftFov) - camera.fov)
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

  // Deterministic development fixture: keep a constant-altitude tangent run
  // long enough for terrain/water LODs and the wake lifecycle to settle.
  updateDevWaterWakeFixture();

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
  const terrainBuildMs=debugBuildBudgetMs || (!loadingCleared
    ? QUALITY_LOW ? 5.5 : 42
    : state === 'walk' ? 2.6 : nearTerrain ? 3.2 : 1.6);
  const waterBuildMs=nearest?.nearWaterPatch?.preferredBudget(nav.pos.distanceTo(nearest.posUniv)-nearest.seaRadius,dt)||0;
  sceneBuildBudget.begin(terrainBuildMs+waterBuildMs+scatter.streamBudgetMs+(FARFLORA?farFlora.streamBudgetMs:0),
    {terrain:terrainBuildMs,near:scatter.streamBudgetMs});
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
    const localRadius = _v.length();
    const nearSurfacePriority = p === nearest && nearestAlt < 1200;
    p.lod.startupPriority = (!loadingCleared && p === nearest) || nearSurfacePriority;
    if (p.waterLod) {
      const nearWater = p === nearest && Math.abs(localRadius - p.seaRadius) < 520;
      p.waterLod.startupPriority = (!loadingCleared && p === nearest) || nearWater;
    }
    p.update(_v, dt, p === nearest, FREEZE || photoMode ? 0 : dt,sceneBuildBudget);
    // The destination ocean's first WebGPU production draw can synchronously
    // specialize the full physical water pipeline for nearly a second. During
    // stellar warp the planet is still covered by starflow and atmospheric
    // reveal, so keep only water LOD hidden until the first ordinary space
    // frame. Terrain, atmosphere, clouds and rings remain visible throughout.
    if (state === 'warp' && p === warpRevealBody) p.waterLod?.setVisible(false);
  }
  if (nearest && !nearest.isGasGiant) {
    _v.copy(nav.pos).sub(nearest.posUniv);
    nearest.worldOffsetToLocal(_v, _v);
    sceneBuildBudget.run('near',scatter.streamBudgetMs,
      budget=>scatter.update(nearest?.type === 'artificialHabitat' ? null : nearest, _v, nearestAlt,budget));
    if (scatter.planet) {
      prewarmSurfacePipelines(scatter.planet);
      if (!surfacePipelinesReady) {
        for (const mesh of Object.values(scatter.meshes)) mesh.visible = false;
      }
    }
    if (FARFLORA)sceneBuildBudget.run('far',farFlora.streamBudgetMs,
      budget=>farFlora.update(nearest?.type === 'artificialHabitat' ? null : nearest, _v, nearestAlt,budget));
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
    weatherEffects.update(activeWeather, _up, _v3, clock.elapsedTime, surfaceWeather);
  } else {
    setWeatherWind(null, 0.18, 0);
    weatherEffects.update(null, _up.set(0, 1, 0), _v3.set(1, 0, 0),
      clock.elapsedTime, 0);
  }
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

  // land prompt
  const canLand = state === 'space' && nearest && !nearest.isGasGiant && nearest.landable !== false
    && nearestAlt < 420 && nav.vel.length() < 4000;
  ui.showLand(!!canLand, nearest && nearest.hasLiquid && nearest.liquid !== 'ice' &&
    waterSurfaceHeight < 2
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

  // camera-relative placement. shipView.tick runs first: while the interior
  // owns the camera it exports nav (the walk stance) before anything reads it.
  shipView.tick(dt, { nav, landed: !!ship.parkedPosUniv && ship.parkAmt > 0.98 });
  // sitting back down returns the camera to flight (cockpit view, state space)
  if (state === 'shipwalk' && !shipView.shipwalk && !paused) setState('space');
  universe.updateRelative(nav.pos);
  camera.position.set(0, 0, 0);
  camera.quaternion.copy(nav.quat);
  // cockpit dressing (free look + throttle shake + rotational sway)
  shipView.applyCockpitLook(camera,
    clamp(boostVisual + nav.vel.length() / 7e5, 0, 1), envInAtmo);
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
  // Surface shaders evaluate the solar horizon at each fragment, not at the camera.
  sunShadow.visible = shadowBlend > 0.02;
  if (sunShadow.visible) {
    const dominantView = universe.system.dominantStarFrom(nearest?.posUniv || nav.pos);
    const sysLight = dominantView.light;
    sunShadow.intensity = sysLight.intensity * shadowBlend;
    sunShadow.color.copy(sysLight.color);
    sunShadow.position.copy(sunDirCam).multiplyScalar(4000);
    sunShadow.target.position.set(0, 0, 0);
    surfaceShadowGrid.update(sunShadow, nav.pos, nearest.posUniv,
      effectiveShadowDistance, renderer.capabilities.maxTextureSize);
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
  }, camera);
  if (DEV_SERVER && devWaterWakeFixture?.cameraLead) {
    devWaterWakeFixture.planet.localOffsetToWorld(devWaterWakeFixture.motion, _v).normalize();
    ship.group.position.addScaledVector(_v, devWaterWakeFixture.cameraLead);
  }
  // first-person modes re-place the hull around the camera
  shipView.applyShipPose(dt, nav);
  // contextual F/E prompt inside the hull
  ui.setInteractPrompt(state === 'shipwalk' && !paused
    ? shipView.interactPrompt(!!ship.parkedPosUniv && ship.parkAmt > 0.98) : '');
  updateWaterInteraction(dt);
  nearest?.liquidMat?.userData?.syncWaterInteractionTexture?.();
  // DEV optical A/B: hide only the packed render count, never field state.
  if (DEV_SERVER && devWaterWakeFixture?.opticalHidden) {
    const count = nearest?.liquidMat?.userData?.waterUniforms?.uRippleCount;
    if (count) count.value = 0;
  }
  nearest?.liquidMat?.userData?.syncOceanField?.();
  prewarmLoadedShipPipelines();
  audio.update({
    state,
    speed: flightSpd,
    atmosphere: envInAtmo,
    boosting: boostVisual > 0.12 || pulseVisual > 0.12,
    warp: Math.max(warpIntensity, pulseVisual * 0.68),
    rift: riftRoute ? spatialRift.open * (spatialRift.handoffActive ? 0.35 : 1) : 0,
    water: waterContact,
    underwater: envUnderwater,
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
  // 仅在脉冲进行中(pulseBurst 存在)虚高显示;settle 期间交由 nav.vel 真实
  // 值(被 approachLimit 平滑限速)驱动指针,避免脉冲结束显示硬切跳变。
  const pulseDisplaySpeed = state === 'space' && pulseBurst
    ? Math.max(_velActual.length(), boostSpeedLimit * (1 + pulseVisual * 1.8))
    : 0;
  const spd = state === 'walk' ? walkCtl.hSpeed.length()
    : state === 'space' ? Math.max(nav.vel.length(), pulseDisplaySpeed) : _velActual.length();
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
  const localAtmospherePlanet = state === 'warp' && !warpRevealActive
    ? null : nearest;
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
    const volumePlanet = state === 'warp' && !warpRevealActive ? null : nearest;
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
  foregroundPass.enabled = ship.foregroundOnly || surfaceWeapons.rig.visible;
  if (RENDER_LOOK_NEXT) {
    // The cabin is fully occluded by the hull in a settled chase view. Keeping
    // its independent light layer alive there paid for every cabin material
    // and fixture without contributing a pixel. Retain it across cockpit,
    // seat/walk and view-blend frames so camera transitions stay continuous.
    const needsForegroundInterior = ship.foregroundOnly
      && (shipView.isCockpit() || shipView.shipwalk || shipView.viewBlend < 1);
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

  // Slow adaptation avoids reallocating render targets during momentary LOD
  // spikes. On a 5080 this stays at the quality ceiling; an iGPU degrades
  // gracefully instead of silently presenting a single-digit frame rate.
  dprAcc += dt;
  const targetFrameMs = QUALITY_LOW ? 21.5 : QUALITY_PROFILE.id === 'balanced' ? 17.5 : 16.2;
  const adaptInterval = perfEmaMs > targetFrameMs * 1.35 ? 1.2 : 3.5;
  const terrainVisualReady = !nearest
    || ((nearest.lod?.debugStats?.().activeMorphs || 0) === 0
      && (nearest.waterLod?.debugStats?.().activeMorphs || 0) === 0);
  const adaptiveReady = loadingCleared && terrainVisualReady
    && pendingChunks() === 0
    && (!FARFLORA || farFlora.pending() === 0)
    && surfacePipelinesReady && !shipPipelineWarmPending
    && !heroTransitionActive;
  if (!adaptiveReady) adaptiveStableSince = performance.now();
  if (dprAcc > adaptInterval && !FREEZE && !adaptiveQualityLocked && adaptiveReady
    && performance.now() - adaptiveStableSince > 5000) {
    dprAcc = 0;
    if (perfEmaMs > targetFrameMs * 1.08 && adaptiveStage < 7) {
      applyAdaptiveStage(adaptiveStage + 1);
    } else if (adaptiveStage >= 7 && perfEmaMs > targetFrameMs * 1.08) {
      setRenderDpr(renderDpr - (perfEmaMs > targetFrameMs * 1.5 ? 0.12 : 0.05));
    } else if (perfEmaMs < targetFrameMs * 0.72) {
      if (renderDpr < QUALITY_PROFILE.dprTarget - 0.04) setRenderDpr(renderDpr + 0.05);
      else if (adaptiveStage > 0) applyAdaptiveStage(adaptiveStage - 1);
    }
  }

  if (!FREEZE && !photoMode && !(DEV_SERVER && devWaterWakeFixture?.held)) tickShaders(dt);
  spatialRift.updateDistortion(riftDistortionPass);
  if (QUALITY_LOW && !surfacePipelinesReady
    && performance.now() - startupWarmStartedAt >= STARTUP_WARM_BUDGET_MS) {
    releaseStartupPrewarm('low-tier startup deadline exceeded');
  }
  // Skip the actual GPU work while the WebGL context is lost — Three.js
  // no-ops render() anyway, but skipping avoids noise from the post chain
  // trying to read stale render targets. The context-lost HUD hint is
  // surfaced from the listener.
  let worldRendered = false;
  if (!contextLost) {
    worldRendered = renderWorldFrame();
    if(worldRendered) {
      // A paced-out RAF is simulation time, not another presented frame.
      // Keep severe stalls and the full interval across skipped callbacks.
      const timing=presentedFrames.present(performance.now());
      if(timing!==null) {
        if(timing.recorded)perfEmaMs+=(Math.min(timing.activeMs,100)-perfEmaMs)*.025;
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
  } else if (!loadingCleared && !cloudPreparation.blocked
    && performance.now() - startupWarmStartedAt
      > STARTUP_WARM_BUDGET_MS + STARTUP_TERRAIN_GRACE_MS + 3000) {
    // Keep the older escape for unrelated startup stages, but never reveal an
    // empty canvas while a required cloud program still owns readiness. Its
    // own deadline/failure remains explicit; it is not a completed world draw.
    console.warn('loading mask forced clear by safety-net timeout');
    if(!surfacePipelinesReady||surfaceBootstrapPending)
      releaseStartupPrewarm('loading mask safety deadline exceeded');
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
    // The procedural hero hull compiles ~80 shader programs across two light
    // sets (foreground pass + landed main pass). Skipping the prewarm on the
    // low tier used to be free with the old GLB; now it would stall the first
    // landed frame for seconds, so the warm runs on every tier.
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
  _pipeline: nodePipeline,  // debug handle (headless diagnostics)
  _THREE: THREE,
  _planet(i = 0) { return universe.system.planets[i] || null; },
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
    return {
      production: RENDER_LOOK_NEXT,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      grade: gradePass_ ? {
        aberration: gradePass_.uniforms.uAberration.value,
        vignette: gradePass_.uniforms.uVignette.value,
        grain: gradePass_.uniforms.uGrain.value,
      } : null,
      cabinBake: ship.int?.group?.userData?.interiorIrradiance || null,
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
      pulse: pulseActive, pulseVisual, pulseFuel: Math.round(pulseFuel * 10) / 10,
      power: { ...flightPower },
      warpArrival,
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
    nodePipeline.invalidateVolumeHistory('teleport');
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
    else if (state === 'shipwalk') shipView.walkYaw += deg * Math.PI / 180;
    else nav.quat.multiply(_q.setFromAxisAngle(_v3.set(0, 1, 0), -deg * Math.PI / 180));
  },
  lookPitch(deg) {
    if (state === 'walk') { walkCtl.pitch = clamp(walkCtl.pitch + deg * Math.PI / 180, -1.45, 1.45); walkCtl.update(0.001); }
    else if (state === 'shipwalk') shipView.walkPitch = clamp(
      shipView.walkPitch + deg * Math.PI / 180, -1.4, 1.4);
    else nav.quat.multiply(_q.setFromAxisAngle(_v3.set(1, 0, 0), deg * Math.PI / 180));
  },
  flyTo: (i) => { const p = universe.system.planets[i]; if (p) { focusPlanet = p; spaceCtl.focus = p; flyToPlanet(p); } },
  tryLand, takeoff, boardShip, recallShip,
  board: () => boardShip(),
  exitShip: () => exitShip(),
  shipDistance: () => parkedShipDistance(),
  // HALCYON first-person layer: exposed for the playtest harness.
  shipViewState: () => ({
    viewMode: shipView.viewMode,
    viewBlend: +shipView.viewBlend.toFixed(3),
    shipwalk: shipView.shipwalk,
    walkPos: shipView.walkPos.toArray(),
    walkYaw: shipView.walkYaw,
    rampT: +shipView.rampT.toFixed(3),
    rampTarget: shipView.rampTarget,
    seatT: +shipView.seatT.toFixed(3),
  }),
  shipViewDebug: {
    setViewMode(m) { if (state === 'space') { shipView.viewMode = m; } return shipView.viewMode; },
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
    const altitude = Math.max(0, Number(metres) || 0);
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
        bodyId: target.bodyId,
        preloaded: !!riftRoute?.previewPreloaded,
        ready: riftPreviewReady,
        preparation: warpPreparedRiftWarmState,
        portalReadiness: spatialRift.portalReadiness ?? 1,
        radius: target.R || 0,
        atmosphereRadius: target.atmoMesh?.geometry?.parameters?.radius || 0,
        cloudRadius: target.cloudMesh?.geometry?.parameters?.radius || 0,
        volumeCloudRadius: target.volCloudMesh?.geometry?.parameters?.radius || 0,
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
  get _internals() {
    return {
      universe,
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
    };
  },
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
