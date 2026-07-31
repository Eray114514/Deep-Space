// Planet: a fully procedural world defined by ONE seeded height function and
// ONE color function over unit-sphere directions. Terrain chunks at every LOD,
// the walking controller, the landing logic and the scatter system all sample
// these same functions — which is what keeps a planet consistent whether it is
// a dot across the system or the ground under your feet.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  dot, exp, float, Fn, If, Loop, mix, positionLocal, positionView, pow,
  sqrt, smoothstep as nodeSmoothstep, texture, uniform, vec3, vec4,
} from 'three/tsl';
import { makeRng, strHash32 } from './rng.js';
import { Simplex, worley3, clamp, frequencyBlend, lerp, smoothstep } from './noise.js';
import { ChunkedLOD, GRID_CELLS } from './quadtree.js';
import {
  applyTerrainDetail, applyWaterWaves, applyCloudField, applyNoctilucentField,
  cloudBaseDensityCPU, cloudDensityCPU, detailTexture,
} from './shaders.js';
import { makeCloudVolumeMaterial } from './clouds.js';
import { VOLUME_LAYER } from './volumetric-pass.js';
import { WORLD_LAYER } from './render-layers.js';
import { floraPalette } from './flora.js';
import { makeAtmosphereMaterialWebGL } from './atmosphere-webgl.js';
import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';
import {
  advanceWeatherField, createWeatherField, sampleWeatherField,
  weatherFieldFingerprint,
} from './weather-field.js';
import { sceneRayLimit } from './volume-depth-node.js';

const rendererParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const rendererSettings = resolveGraphicsSettings({ params: rendererParams });
const USE_NODE_MATERIALS = resolveRendererPolicy(
  rendererParamsForSettings(rendererSettings, rendererParams)).backend === 'webgpu';
const DEV_WEATHER_FIXTURE = typeof window !== 'undefined' && window.__NMS_DEV_SERVER__ === true
  ? rendererParams.get('weather') : null;

// Volumetric clouds are the primary cloud representation in every runtime
// quality tier. Low quality changes only the ray budget and volume-buffer
// resolution; it never swaps to a different flat weather rendering.
let volumetricCloudsEnabled = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('vclouds') !== '0';
let sharedLocalAtmosphereMaterial = null;
let volumetricCloudProfile = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('quality') === 'low'
  ? { quality: 'performance', steps: 48 } : { quality: 'ultra', steps: 124 };

// GPU auto-tiering happens after the WebGL renderer identifies the adapter,
// but before the first Universe is constructed. Keeping this as a runtime
// capability (rather than URL-only constants) also covers the auto-low iGPU
// path selected after renderer creation.
export function setVolumetricCloudsEnabled(enabled, profile = volumetricCloudProfile) {
  volumetricCloudsEnabled = !!enabled;
  volumetricCloudProfile = typeof profile === 'string'
    ? { quality: profile === 'low' ? 'performance' : 'ultra', steps: profile === 'low' ? 48 : 124 }
    : { quality: profile.quality || 'balanced', steps: Math.max(8, Math.min(124, profile.steps || 80)) };
}

export const TYPES = {
  lush:   { label: '繁茂', weight: 3.0, relief: 0.034, liquid: 'water', seaQ: -0.05, atmo: 0x69b4ff, sky: 0x7fc3ff, atmoDensity: 1.0, clouds: 0.62 },
  ocean:  { label: '海洋', weight: 2.0, relief: 0.020, liquid: 'water', seaQ: 0.30,  atmo: 0x55aaff, sky: 0x6fb9ff, atmoDensity: 1.0, clouds: 0.7 },
  desert: { label: '荒漠', weight: 2.0, relief: 0.040, liquid: null,    seaQ: null,  atmo: 0xffc380, sky: 0xf7c089, atmoDensity: 0.85, clouds: 0.15 },
  ice:    { label: '冰封', weight: 2.0, relief: 0.030, liquid: 'ice',   seaQ: 0.05,  atmo: 0xbfdfff, sky: 0xcfe5ff, atmoDensity: 0.9, clouds: 0.3 },
  lava:   { label: '火山', weight: 1.4, relief: 0.038, liquid: 'lava',  seaQ: -0.42, atmo: 0xff8a50, sky: 0xb96a4a, atmoDensity: 0.7, clouds: 0 },
  barren: { label: '荒芜', weight: 1.8, relief: 0.042, liquid: null,    seaQ: null,  atmo: 0x9aa3a8, sky: 0x6f7a80, atmoDensity: 0.25, clouds: 0 },
  toxic:  { label: '剧毒', weight: 1.4, relief: 0.032, liquid: 'toxic', seaQ: 0.02,  atmo: 0xa9e84e, sky: 0x9fd455, atmoDensity: 0.95, clouds: 0.3 },
  exotic: { label: '异相', weight: 1.0, relief: 0.046, liquid: null,    seaQ: null,  atmo: 0xe87ae8, sky: 0xd98ae0, atmoDensity: 0.8, clouds: 0.12 },
};

const _c = new THREE.Color();

function col(hex) { return new THREE.Color(hex); }

function jitterColor(c, rand, dh, ds, dl) {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(
    (hsl.h + dh + 1) % 1,
    clamp(hsl.s * ds, 0, 1),
    clamp(hsl.l * dl, 0.02, 0.98),
  );
  return c;
}

function stops(arr) {
  // arr: [[t, hexOrColor], ...] -> sorted stop list with THREE.Color
  return arr.map(([t, c]) => ({ t, c: c instanceof THREE.Color ? c : col(c) }));
}

function sampleStops(st, t, out) {
  if (t <= st[0].t) return out.copy(st[0].c);
  for (let i = 1; i < st.length; i++) {
    if (t <= st[i].t) {
      const a = st[i - 1], b = st[i];
      return out.copy(a.c).lerp(b.c, (t - a.t) / Math.max(1e-6, b.t - a.t));
    }
  }
  return out.copy(st[st.length - 1].c);
}

export class Planet {
  constructor({ seed, name, posUniv, type, isMoon = false, radius = null, atmosphere = null, clouds = null, fadeIn = false, sunDir = null, tuning = null, formation = null, ringSystem = null }) {
    this.appear = fadeIn ? 0 : 1;   // planets born mid-flight fade in, never pop
    // known at construction so even the root chunks bake sun shadows
    this.sunDirWorld = sunDir ? sunDir.clone() : new THREE.Vector3(0, 1, 0);
    this.sunDirLocal = this.sunDirWorld.clone();
    this.frameOrientation = new THREE.Quaternion();
    this._invFrame = new THREE.Quaternion();
    this.seed = seed;
    this.name = name;
    this.isMoon = isMoon;
    this.posUniv = posUniv.clone();
    const rand = makeRng(seed);
    this.rand = rand;
    this.intSeed = strHash32(seed);

    this.type = type;
    this.cfg = TYPES[type];
    this.atmosphere = atmosphere;
    this.cloudProfile = clouds;
    this.formation = formation;
    this.ringSystem = ringSystem;
    this.tuning = tuning ? { ...tuning } : {};

    // ---- dimensions: compressed planetary worlds, not gameplay marbles ----
    // Main planets are hundreds of kilometres in radius. This keeps low flight
    // visually flat while altitude-scaled controls preserve a short approach.
    const baseR = isMoon ? 28000 + rand() * 72000 : 160000 + rand() * 240000;
    this.R = Number.isFinite(this.tuning.radiusMeters)
      ? Math.max(1000, this.tuning.radiusMeters)
      : (radius || baseR);
    // Relief grows with the world and can form kilometre-scale mountain belts.
    this.hAmp = Math.min(this.R * this.cfg.relief * (0.85 + rand() * 0.5), 7000 + rand() * 6000);
    this.gravity = 9.81 * clamp(this.R / 250000, 0.55, 1.5);
    const pressureScale = atmosphere?.pressureBar == null ? 1 : clamp(Math.pow(atmosphere.pressureBar, 0.22), 0.08, 1.55);
    this.atmoDensity = this.cfg.atmoDensity * (0.7 + rand() * 0.6) * pressureScale;
    this.atmoFraction = (isMoon ? 0.055 : 0.09) + rand() * (isMoon ? 0.025 : 0.045);
    this.cloudBaseFraction = (isMoon ? 0.022 : 0.035) + rand() * (isMoon ? 0.016 : 0.025);
    this.cloudThicknessFraction = (isMoon ? 0.008 : 0.012) + rand() * (isMoon ? 0.008 : 0.016);

    // ---- noise fields -----------------------------------------------------
    this.nA = new Simplex(makeRng(seed + ':A'));
    this.nB = new Simplex(makeRng(seed + ':B'));
    this.nC = new Simplex(makeRng(seed + ':C'));
    this.nD = new Simplex(makeRng(seed + ':D'));
    this.nOceanBasin = this.tuning.oceanProfile
      ? new Simplex(makeRng(seed + ':ocean-bathymetry:v1'))
      : null;

    // ---- terrain parameters ----------------------------------------------
    this.contFreq = 1.1 + rand() * 1.5;
    this.contAmp = this.hAmp * 0.62;
    this.mountFreq = 4.5 + rand() * 4.0;
    this.mountAmp = this.hAmp * (0.55 + rand() * 0.45);
    this.detailFreq = 16 + rand() * 10;
    this.detailAmp = this.hAmp * 0.16;

    // ---- regional personality: planets are NOT the same everywhere -------
    // a very low-frequency field divides the world into provinces; each
    // landform reads it differently, so one hemisphere can be an alpine
    // belt while another is plains or terraced mesa country
    this.regFreq = 0.7 + rand() * 0.9;
    this.beltBias = (rand() - 0.5) * 0.5;           // how much of the world is rugged
    this.plainsCalm = 0.45 + rand() * 0.45;          // how flat the calm provinces are
    this.warpAmp = 0.22 + rand() * 0.5;              // domain warp breaks noise blobbiness
    this.warpFreq = 1.3 + rand() * 1.9;
    const mesaProne = type === 'desert' || type === 'barren' || type === 'exotic';
    this.plateauAmt = mesaProne ? 0.55 + rand() * 0.45 : (rand() < 0.3 ? 0.3 + rand() * 0.4 : 0);
    this.plateauH = this.hAmp * (0.22 + rand() * 0.2);

    // liquids
    this.liquid = this.cfg.liquid;
    this.hasLiquid = this.liquid !== null;
    this.waterStyle = this.tuning.oceanProfile === 'pelagic-storm'
      ? { swell: 2.05, clarity: 0.74, foam: 1.35 }
      : type === 'ocean'
        ? { swell: 1.65, clarity: 0.82, foam: 1.18 }
      : type === 'toxic'
        ? { swell: 0.72, clarity: 0.48, foam: 0.72 }
        : { swell: 1, clarity: 1, foam: 1 };
    const seaLevelOffset = Number.isFinite(this.tuning.seaLevelOffset) ? this.tuning.seaLevelOffset : 0;
    // Water-level curation must not rewrite the selected terrain. Mountain
    // placement was historically derived from the generated shoreline, so
    // retain that reference while moving only the rendered liquid surface.
    this.naturalSeaLevel = this.hasLiquid
      ? this.cfg.seaQ * this.contAmp + (rand() - 0.5) * 0.1 * this.contAmp
      : -1e9;
    this.seaLevel = this.hasLiquid ? this.naturalSeaLevel + seaLevelOffset : -1e9;
    this.seaRadius = this.hasLiquid ? this.R + this.seaLevel : 0;
    // mountains grow from terrain above the waterline
    const seaC = this.hasLiquid ? this.naturalSeaLevel / this.contAmp : -0.25;
    this.mountMaskLo = seaC + 0.05;
    this.mountMaskHi = seaC + 0.45;

    // type extras
    this.craterAmp = 0; this.duneAmp = 0; this.canyonAmp = 0;
    this.blobAmp = 0; this.spikeAmp = 0;
    if (type === 'barren') { this.craterAmp = this.hAmp * 0.55; this.craterFreq = 5 + rand() * 3; }
    if (type === 'ice' && rand() < 0.5) { this.craterAmp = this.hAmp * 0.2; this.craterFreq = 7 + rand() * 4; }
    if (type === 'desert') {
      this.duneAmp = 2.2 + rand() * 2.5; this.duneFreq = 320 + rand() * 260;
      this.duneAxis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
      this.canyonAmp = this.hAmp * 0.5; this.canyonFreq = 2.6 + rand() * 1.6; this.canyonWidth = 0.07 + rand() * 0.05;
    }
    if (type === 'lush' || type === 'ocean' || type === 'toxic') {
      // rivers: channels carved below the waterline so they flood
      this.canyonAmp = this.hAmp * 0.42; this.canyonFreq = 3.0 + rand() * 1.8; this.canyonWidth = 0.05 + rand() * 0.035;
    }
    if (type === 'toxic') { this.blobAmp = this.hAmp * 0.3; this.blobFreq = 14 + rand() * 10; }
    if (type === 'exotic') {
      this.blobAmp = this.hAmp * 0.35; this.blobFreq = 9 + rand() * 7;
      this.spikeAmp = this.hAmp * (1.1 + rand() * 0.9); this.spikeFreq = 22 + rand() * 16;
      this.stripeFreq = 14 + rand() * 22;
      this.stripeAxis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    }
    // Formation history now modulates the existing world function instead of
    // layering a disconnected orbit texture over it.  The same tectonic,
    // impact, volcanic and erosion profile therefore survives orbital LOD,
    // low flight, walking collision and the compatibility sentinels.
    if (formation) {
      this.mountAmp *= 0.72 + formation.tectonicActivity * 0.7;
      this.plateauAmt = clamp(this.plateauAmt + formation.volcanicActivity * 0.24, 0, 1);
      if (formation.impactRate > 0.18) {
        this.craterAmp = Math.max(this.craterAmp, this.hAmp * formation.impactRate * 0.34);
        this.craterFreq ||= 4.4 + rand() * 4.6;
      }
      if (this.canyonAmp > 0) this.canyonAmp *= 0.58 + formation.erosion * 0.88;
      if (this.duneAmp > 0) this.duneAmp *= 0.72 + (1 - formation.waterInventory) * 0.58;
    }

    // Wide chunks preserve the exact finest sampling density while replacing
    // each former 2×2 child set with one submission. Collision and gameplay
    // keep the canonical frequency cap; only the renderer's grouping changes.
    const canonicalGridCells = GRID_CELLS;
    this.canonicalGridCells = canonicalGridCells;
    const rootCell = (Math.PI / 2) * this.R / canonicalGridCells;
    // Honour the authored ~1.5 m canonical ground spacing on large worlds.
    // The old level-13 ceiling left the 900 km home planet at ~7.2 m cells
    // (5.4 m after wide-chunk grouping), visibly faceting near-ground ridges.
    this.canonicalMaxLevel = clamp(Math.ceil(Math.log2(rootCell / 1.5)), 4, 16);
    this.canonicalFreqAtLevel = (lvl) => 0.4 * canonicalGridCells * Math.pow(2, lvl) / (Math.PI / 2);
    this.fullMaxFreq = this.canonicalFreqAtLevel(this.canonicalMaxLevel);
    // Grouping reduces draw overhead. The last canonical octave is retained by
    // collision/noise and the material micro-relief, while geometry stops at
    // ~2.7 m cells on the 900 km world. Trying to tessellate the final
    // sub-metre octave queued hundreds of chunks for minutes at 70 m altitude
    // even though its relief is below a pixel.
    const lowTierGrouping = canonicalGridCells <= 18;
    // Keep cheap 32×32 roots, then switch high-tier terrain to 64×64 at level
    // three. One wide level replaces the next 2×2 set of narrow chunks at the
    // same final vertex spacing, cutting stable draw submissions by roughly
    // four without making planet construction synchronously build six huge
    // roots. Parent interpolation already supports different grid widths.
    const baseGroupFactor = lowTierGrouping ? 4 : (4 / 3);
    this.gridCells = Math.round(canonicalGridCells * baseGroupFactor);
    this.gridCellsAtLevel = (level) => (!lowTierGrouping && level >= 3
      ? this.gridCells * 2
      : this.gridCells);
    // Terrain chunk boundaries stay on the continuous planet surface. Forcing
    // every child edge down to the parent chord created a low-frequency trench
    // around every square; radial skirts then rendered those trenches as dark
    // dotted walls. Mixed-level ownership is handled by keeping the parent
    // visible until its complete child set is ready and by geomorphing the
    // child surface, not by modifying permanent fine-level boundary vertices.
    this.noSkirt = true;
    // Terrain face boundaries are synchronized by the quadtree itself.
    // Radial skirts turn the shared edge into a shaded wall and recreate the
    // black ink line they were meant to conceal.
    this.faceBoundarySkirts = false;
    // The low-power tier targets a 0.5-DPR 3D buffer. One fewer finest level
    // matches that screen-space resolution (≈3 m cells) instead of spending
    // four times the triangles on sub-pixel relief.
    this.maxLevel = Math.max(3, this.canonicalMaxLevel - 3);
    // A cap of level 1/2 left 7–14 km triangles on the 900 km home world,
    // visibly polygonal at 52–140 km and even in a full-disk 2K view. Keep
    // enough orbital geometry for the actual display Nyquist rate; noise
    // frequency still follows each level, so this is not fake micro-detail.
    this.orbitLevelCap = Math.min(this.maxLevel, 3);
    this.orbitPrewarmRadiusRatio = 1.75;
    this.freqAtLevel = (lvl) => Math.min(this.fullMaxFreq,
      0.4 * this.gridCellsAtLevel(lvl) * Math.pow(2, lvl) / (Math.PI / 2));
    const lodScreenScale = lowTierGrouping ? 0.25 : 1;
    this.lodDistanceScale = (canonicalGridCells / this.gridCells) * lodScreenScale;
    this.lodDistanceScaleAtLevel = (lvl) => (canonicalGridCells / this.gridCellsAtLevel(lvl)) * lodScreenScale;
    this.lodLevelForCanonical = (canonicalLevel) => {
      for (let level = 0; level <= this.maxLevel; level++) {
        const effective = level + Math.log2(this.gridCellsAtLevel(level) / canonicalGridCells);
        if (effective >= canonicalLevel) return level;
      }
      return this.maxLevel;
    };

    // ---- palette ----------------------------------------------------------
    this.buildPalette(rand);

    // axis tilt (rings, clouds, stripes)
    this.axisQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((rand() - 0.5) * 0.9, rand() * Math.PI * 2, (rand() - 0.5) * 0.9));

    // ---- scene objects ----------------------------------------------------
    this.group = new THREE.Group();
    this.group.name = 'planet:' + name;
    // no vertex colors: the palette is evaluated per-pixel in the shader
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      roughness: 1.0, metalness: 0.0,
    });
    // close-up grain (albedo + micro-normals): rocky worlds get more of it;
    // living worlds get stronger continental tint drift (dry-brown swathes)
    const detailK = { desert: 0.3, barren: 0.34, lava: 0.3, exotic: 0.26, ice: 0.18 }[type] ?? 0.22;
    const macroK = { lush: 0.5, ocean: 0.45, ice: 0.2, toxic: 0.35 }[type] ?? 0.3;
    this.terrainMaterial = applyTerrainDetail(this.terrainMaterial, this, detailK, macroK);
    this.lod = new ChunkedLOD(this);
    this.buildEffects(rand);
    this.cloudSpin = rand() * Math.PI * 2;
    // The legacy phase draw remains consumed for universe compatibility, but
    // atlas orientation is already authored into WeatherField at hour zero.
    this.cloudSpinBase = 0;
    this.cloudSpin2Base = 0;
    this.weatherHours = 0;
    this.weatherProfile ||= {
      cloudiness: clamp(this.cloudCoverage || 0, 0.04, 0.96),
      humidity: this.hasLiquid ? 0.72 : this.type === 'ice' ? 0.62 : 0.28,
      storminess: this.tuning.weatherStyle === 'pelagic-storm'
        || this.tuning.oceanClass === 'pelagic-storm' ? 0.9
        : this.type === 'toxic' ? 0.72 : 0.4,
      highClouds: this.cloudCoverage > 0.45 ? 0.48 : 0.2,
      fogginess: this.hasLiquid ? 0.34 : 0.16,
      windSpeed: 8 + (this.waterStyle?.swell || 0.6) * 13,
      weatherSpeed: 6,
      temperatureK: this.equilibriumK || 286,
    };
    this.weatherField ||= createWeatherField(this.seed, {
      profile: this.weatherProfile,
      fixture: DEV_WEATHER_FIXTURE || undefined,
    });
    this.weatherState = advanceWeatherField(this.weatherField, 0);

    // materials touched by the fade-in
    this._fades = [{ mat: this.terrainMaterial, base: 1 }];
    if (this.liquidMat) this._fades.push({ mat: this.liquidMat, base: this.liquidMat.opacity });
    if (this.cloudMesh) this._fades.push({ mat: this.cloudMesh.material, base: this.cloudMesh.material.opacity });
    if (this.cloudMesh2) this._fades.push({ mat: this.cloudMesh2.material, base: this.cloudMesh2.material.opacity });
    if (this.cloudMeshNoctilucent) {
      this._fades.push({
        mat: this.cloudMeshNoctilucent.material,
        base: this.cloudMeshNoctilucent.material.opacity,
      });
    }
    if (this.ringMesh) this._fades.push({ mat: this.ringMesh.material, base: this.ringMesh.material.opacity });
    this._atmoBaseDensity = this.atmoMesh
      ? (this.atmoUniforms || this.atmoMesh.material.uniforms).density.value : 0;
    if (this.appear < 1) this.applyAppear();
  }

  applyAppear() {
    const a = this.appear;
    for (const f of this._fades) {
      f.mat.opacity = f.base * a;
      if (f.mat.userData.opacityNodeUniform) f.mat.userData.opacityNodeUniform.value = f.base * a;
      f.mat.transparent = a < 1 || f.base < 1;
    }
    if (this.atmoMesh) {
      (this.atmoUniforms || this.atmoMesh.material.uniforms).density.value
        = this._atmoBaseDensity * a;
    }
  }

  // ======================================================================
  // THE height function. dir must be a unit vector (planet-local).
  // maxFreq caps angular detail for LOD; features finer than the sampling
  // grid are skipped, everything coarser is identical at every LOD.
  // Returns meters relative to base radius R.
  // ======================================================================
  height(dir, maxFreq = 1e9) {
    const x = dir.x, y = dir.y, z = dir.z;

    // provinces: a very low-frequency field that decides the character of
    // each region (rugged belt vs calm plains). Constant across LODs.
    const reg = this.nD.fbm(x + 53.1, y - 17.7, z + 29.3, this.regFreq, 2, 0.5, 2.1, maxFreq);
    const belt = smoothstep(-0.32 + this.beltBias, 0.34 + this.beltBias, reg);

    // continents are sampled through a warped domain — kills the uniform
    // "simplex blob" look and gives coastlines real character
    const wf = this.warpFreq, wa = this.warpAmp;
    const ax = x + this.nB.noise(x * wf + 31.4, y * wf, z * wf) * wa;
    const ay = y + this.nB.noise(x * wf, y * wf + 47.2, z * wf) * wa;
    const az = z + this.nB.noise(x * wf, y * wf, z * wf + 71.7) * wa;
    const c = this.nA.fbm(ax, ay, az, this.contFreq, 4, 0.52, 2.05, maxFreq);
    let h = c * this.contAmp;

    // mountains/detail keep their first octave at every LOD (fractals cut
    // octaves internally) so the mean elevation never jumps between levels.
    // Ranges cluster into the rugged provinces instead of covering the globe.
    // Mountain provinces used to exclude 61.7% of the globe and vary their
    // amplitude by 8.3×, producing isolated "mountain islands" separated by
    // featureless plains. Broaden the continental foothill mask and keep a
    // meaningful ruggedness floor so ranges form connected regional chains.
    const foothills = smoothstep(this.mountMaskLo - 0.18, this.mountMaskHi, c);
    const mMask = foothills * (0.34 + 0.66 * belt);
    const m = this.nB.ridged(x, y, z, this.mountFreq, 6, 0.55, 2.1, maxFreq);
    h += m * this.mountAmp * mMask;

    {
      // eroded hillsides: rugged crests, smooth carved flanks —
      // rough in the belts, long calm plains elsewhere
      const d = this.nC.fbmEroded(x, y, z, this.detailFreq, 6, 0.5, 2.2, maxFreq, 3.2);
      h += d * this.detailAmp * 1.25 * (0.45 + 0.55 * mMask) * (1 - this.plainsCalm * (1 - belt));
    }

    // mesa country: whole provinces terraced into flat-topped plateaus
    if (this.plateauAmt > 0) {
      const pz = smoothstep(0.12, 0.5,
        this.nC.fbm(x - 91.7, y + 33.3, z - 57.9, this.regFreq * 1.4, 2, 0.5, 2.1, maxFreq));
      if (pz > 0.01) {
        const base = this.hasLiquid ? this.seaLevel + 2 : -this.contAmp * 0.4;
        const land = smoothstep(base, base + this.hAmp * 0.12, h);
        if (land > 0.01) {
          const t = h / this.plateauH;
          const f = Math.floor(t);
          // cliff sharpness is LOD-gated: coarse levels see gentle ramps,
          // close up the mesa edges crispen
          const w = Math.min(0.5, 0.2 + 10 / maxFreq);
          const terraced = (f + smoothstep(0.5 - w, 0.5 + w, t - f)) * this.plateauH;
          h = lerp(h, terraced, this.plateauAmt * pz * land);
        }
      }
    }

    if (this.canyonAmp > 0) {
      const cv = this.nD.fbm(x, y, z, this.canyonFreq, 4, 0.5, 2.3, maxFreq);
      if (this.hasLiquid) {
        const band = smoothstep(this.seaLevel - this.hAmp * 0.45, this.seaLevel + 4, h)
          * (1 - smoothstep(this.seaLevel + this.hAmp * 0.30,
            this.seaLevel + this.hAmp * 0.7, h));
        // A river is a broad alluvial valley with a much narrower wet
        // channel. The old single profile drove the entire strip directly to
        // sea level; from orbit its steep banks became dotted black ink lines.
        // Both widths expand at coarse LOD so the carved volume remains
        // resolvable and converges continuously during approach.
        const valleyWidth = Math.max(this.canyonWidth * 2.5, 4 / maxFreq);
        const valleyT = 1 - Math.abs(cv) / valleyWidth;
        if (valleyT > 0) {
          const valleyShape = valleyT * valleyT * (3 - 2 * valleyT);
          const valleyDepth = this.hAmp * 0.035
            + Math.max(0, h - this.seaLevel) * 0.16;
          h -= valleyShape * valleyDepth * band;
        }
        const channelWidth = Math.max(this.canyonWidth * 0.72, 2.5 / maxFreq);
        const channelT = 1 - Math.abs(cv) / channelWidth;
        if (channelT > 0) {
          const channelShape = channelT * channelT * (3 - 2 * channelT);
          const channelTarget = this.seaLevel - this.hAmp * 0.018;
          h = lerp(h, Math.min(h, channelTarget), channelShape * band * 0.9);
        }
      } else {
        // Dry slot canyons retain their sharper geology.
        const cw = Math.max(this.canyonWidth, 2.5 / maxFreq);
        const depthScale = this.canyonWidth / cw;
        const t = 1 - Math.abs(cv) / cw;
        if (t > 0) {
          const tt = t * t * (3 - 2 * t) * depthScale;
          // dry slot canyons through the midlands
          const band = smoothstep(-this.hAmp * 0.3, 0, h)
            * (1 - smoothstep(this.hAmp * 0.45, this.hAmp * 0.8, h));
          h -= tt * this.canyonAmp * band;
        }
      }

      // tributaries: a finer branching carve feeding the main channels,
      // so valleys form dendritic drainage networks like real watersheds
      const cv2 = this.nD.fbm(x + 7.7, y - 3.3, z + 1.1, this.canyonFreq * 3.1, 3, 0.5, 2.25, maxFreq);
      const cw2 = Math.max(this.canyonWidth * (this.hasLiquid ? 0.82 : 0.55),
        2.5 / maxFreq);
      const t2 = 1 - Math.abs(cv2) / cw2;
      if (t2 > 0) {
        const tt2 = t2 * t2 * (3 - 2 * t2) * (this.canyonWidth * 0.55 / cw2);
        if (this.hasLiquid) {
          const band2 = smoothstep(this.seaLevel - this.hAmp * 0.35, this.seaLevel + 3, h) *
                        (1 - smoothstep(this.seaLevel + this.hAmp * 0.22, this.seaLevel + this.hAmp * 0.5, h));
          const tributaryTarget = this.seaLevel - this.hAmp * 0.008;
          const floodplain = Math.max(0, h - this.seaLevel) * 0.1 + this.hAmp * 0.012;
          h -= tt2 * floodplain * band2;
          h = lerp(h, Math.min(h, tributaryTarget), tt2 * band2 * 0.68);
        } else {
          const band2 = smoothstep(-this.hAmp * 0.25, 0, h) * (1 - smoothstep(this.hAmp * 0.4, this.hAmp * 0.7, h));
          h -= tt2 * this.canyonAmp * 0.4 * band2;
        }
      }
    }

    if (this.craterAmp > 0) {
      const craterBlend = frequencyBlend(this.craterFreq * 2, maxFreq);
      if (craterBlend > 0) {
        h += this.craters(x, y, z, this.craterFreq, this.craterAmp, 0) * craterBlend;
      }
      const craterDetailBlend = frequencyBlend(this.craterFreq * 8, maxFreq);
      if (craterDetailBlend > 0) {
        h += this.craters(x, y, z, this.craterFreq * 4.7, this.craterAmp * 0.3, 1)
          * craterDetailBlend;
      }
    }

    const blobBlend = this.blobAmp > 0 ? frequencyBlend(this.blobFreq, maxFreq) : 0;
    if (blobBlend > 0) {
      const b = this.nD.billow(x + 31, y, z, this.blobFreq, 4, 0.5, 2.1, maxFreq);
      h += Math.max(0, b) * this.blobAmp * blobBlend;
    }

    const duneBlend = this.duneAmp > 0 ? frequencyBlend(this.duneFreq / 1.5, maxFreq) : 0;
    if (duneBlend > 0) {
      const wob = this.nC.noise(x * 9, y * 9, z * 9) * 2.5;
      const tdt = (x * this.duneAxis.x + y * this.duneAxis.y + z * this.duneAxis.z) * this.duneFreq + wob;
      const flat = 1 - smoothstep(this.hAmp * 0.25, this.hAmp * 0.6, Math.abs(h));
      h += (1 - Math.abs(Math.sin(tdt))) * this.duneAmp * flat * duneBlend;
    }

    const spikeBlend = this.spikeAmp > 0 ? frequencyBlend(this.spikeFreq * 3, maxFreq) : 0;
    if (spikeBlend > 0) {
      const w = worley3(x * this.spikeFreq, y * this.spikeFreq, z * this.spikeFreq, (this.intSeed ^ 0x51ce) | 0);
      const sp = Math.max(0, 1 - w.d * 1.45);
      if ((w.h & 7) < 3) {
        h += sp * sp * sp * this.spikeAmp * (0.4 + (w.h % 97) / 97 * 0.6) * spikeBlend;
      }
    }

    if (this.nOceanBasin && this.hasLiquid && h < this.seaLevel) {
      // The curated pelagic world is water-dominated but deliberately not a
      // kilometres-deep featureless bowl. An independent namespace lifts broad
      // continental shelves while leaving rarer basins/trenches, preserving
      // the exact shoreline and the small island fraction selected above.
      const basin = this.nOceanBasin.fbm(
        x + 18.7, y - 41.2, z + 7.9, 1.35, 4, 0.52, 2.08, maxFreq);
      const basinWeight = smoothstep(-0.28, 0.48, basin);
      const baseScale = Number.isFinite(this.tuning.bathymetryScale)
        ? clamp(this.tuning.bathymetryScale, 0.08, 0.7)
        : 0.24;
      const depthScale = lerp(baseScale * 0.55, baseScale * 1.55, basinWeight);
      h = this.seaLevel - (this.seaLevel - h) * depthScale;
    }

    return h;
  }

  craters(x, y, z, freq, amp, lane) {
    const w = worley3(x * freq, y * freq, z * freq, this.intSeed + lane * 7919);
    const rc = 0.16 + ((w.h >>> 4) % 64) / 64 * 0.26;
    const cAmp = amp * (0.35 + ((w.h >>> 10) % 64) / 64 * 0.65);
    const t = w.d / rc;
    if (t < 1) return (t * t * 1.35 - 1) * cAmp;          // bowl, raised rim at edge
    if (t < 1.6) return 0.35 * (1 - (t - 1) / 0.6) * cAmp; // rim falloff
    return 0;
  }

  surfaceRadius(dir, maxFreq = this.fullMaxFreq) {
    return this.R + this.height(dir, maxFreq);
  }

  // ======================================================================
  // THE color function. Same contract as height(): unit dir + the LOD
  // frequency cap. `h` is the already-computed height, slope is 1-dot(n,up).
  // ======================================================================
  colorAt(dir, h, slope, maxFreq, out) {
    const x = dir.x, y = dir.y, z = dir.z;
    const p = this.pal;

    if (this.hasLiquid && h < this.seaLevel && this.liquid !== 'lava') {
      const depth = clamp((this.seaLevel - h) / (this.hAmp * 0.85), 0, 1);
      sampleStops(p.sea, 1 - depth, out);
    } else {
      const t0 = this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85;
      const tl = clamp((h - t0) / (this.hAmp * 1.15 - t0), 0, 1);
      sampleStops(p.land, tl, out);

      const moist = this.nC.fbm(x + 11.3, y - 4.1, z + 7.7, 2.4, 3, 0.5, 2.15, maxFreq);

      if (p.forest && tl > 0.04 && tl < 0.55) {
        const f = smoothstep(0.05, 0.3, moist) * smoothstep(0.04, 0.1, tl) * (1 - smoothstep(0.4, 0.55, tl));
        out.lerp(p.forest, f * 0.85);
      }
      if (p.blotch) {
        const b = this.nD.billow(x - 17, y + 5, z, 5.5, 3, 0.5, 2.1, maxFreq);
        out.lerp(p.blotch, smoothstep(0.18, 0.5, b) * 0.7);
      }
      if (p.strata) {
        const s = Math.sin(h * 0.55 + moist * 2.0);
        const m = 1 + s * 0.09;
        out.r *= m; out.g *= m; out.b *= m;
      }
      if (p.crevasse) {
        const r = this.nB.ridged(x, y, z, 11, 3, 0.55, 2.1, maxFreq);
        out.lerp(p.crevasse, smoothstep(0.52, 0.8, r) * 0.6);
      }
      if (p.stripes) {
        const d = x * this.stripeAxis.x + y * this.stripeAxis.y + z * this.stripeAxis.z;
        const s = Math.sin(d * this.stripeFreq + this.nA.noise(x * 4, y * 4, z * 4) * 1.9) * 0.5 + 0.5;
        sampleStops(p.stripes, s, _c);
        out.lerp(_c, 0.55);
      }
      if (this.liquid === 'lava') {
        const f = 1 - smoothstep(this.seaLevel + 2, this.seaLevel + this.hAmp * 0.22, h);
        if (f > 0) out.lerp(p.ember, f * f);
      }

      // steep ground turns to bare rock
      out.lerp(p.rock, smoothstep(p.slopeLo, p.slopeHi, slope));

      // NOTE: the snowline is applied per-FRAGMENT in the terrain shader
      // (see shaders.js) — per-vertex snow quantized into visible blocks
      // at orbital LODs. Same formula, evaluated per-pixel.
    }

    // fine tonal speckle, LOD-gated like everything else
    if (maxFreq >= 230) {
      const v = this.nB.noise(x * 230, y * 230, z * 230);
      const m = 1 + v * 0.06;
      out.r *= m; out.g *= m; out.b *= m;
    }
    return out;
  }

  // Low-frequency tint masks baked per-vertex (they're smooth, so vertex
  // resolution is fine): x=forest, y=blotch, z=stripe phase, w=ember/
  // crevasse/strata. The fragment shader applies the actual colors.
  extrasAt(dir, h, maxFreq, out) {
    out.set(0, 0, 0, 0);
    const p = this.pal;
    if (this.hasLiquid && h < this.seaLevel && this.liquid !== 'lava') return out;
    const x = dir.x, y = dir.y, z = dir.z;
    const t0 = this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85;
    const tl = clamp((h - t0) / (this.hAmp * 1.15 - t0), 0, 1);

    if (p.forest && tl > 0.04 && tl < 0.55) {
      const moist = this.nC.fbm(x + 11.3, y - 4.1, z + 7.7, 2.4, 3, 0.5, 2.15, maxFreq);
      out.x = smoothstep(0.05, 0.3, moist) * smoothstep(0.04, 0.1, tl)
        * (1 - smoothstep(0.4, 0.55, tl)) * 0.85;
      if (this.snowWeightAt(dir, h) > 0.28) out.x = 0;
    }
    if (p.blotch) {
      const b = this.nD.billow(x - 17, y + 5, z, 5.5, 3, 0.5, 2.1, maxFreq);
      out.y = smoothstep(0.18, 0.5, b) * 0.7;
    }
    if (p.stripes) {
      const d = x * this.stripeAxis.x + y * this.stripeAxis.y + z * this.stripeAxis.z;
      out.z = Math.sin(d * this.stripeFreq + this.nA.noise(x * 4, y * 4, z * 4) * 1.9) * 0.5 + 0.5;
    }
    if (this.liquid === 'lava') {
      const f = 1 - smoothstep(this.seaLevel + 2, this.seaLevel + this.hAmp * 0.22, h);
      out.w = f * f;
    } else if (p.crevasse) {
      out.w = smoothstep(0.52, 0.8, this.nB.ridged(x, y, z, 11, 3, 0.55, 2.1, maxFreq)) * 0.6;
    } else if (p.strata) {
      const moist = this.nC.fbm(x + 11.3, y - 4.1, z + 7.7, 2.4, 3, 0.5, 2.15, maxFreq);
      out.w = Math.sin(h * 0.55 + moist * 2.0) * 0.5 + 0.5;
    }
    return out;
  }

  buildPalette(rand) {
    // vivid types can drift far; living worlds keep believable hues
    const hueSpan = (this.type === 'lush' || this.type === 'ocean') ? 0.05 : 0.13;
    const dh = (rand() - 0.5) * hueSpan;
    const ds = 0.82 + rand() * 0.45;
    const dl = 0.88 + rand() * 0.26;
    const J = (hex) => jitterColor(col(hex), rand, dh, ds, dl);

    const p = { slopeLo: 0.22, slopeHi: 0.5, snow: null, snowLine: 1e9, capLat: 0 };
    switch (this.type) {
      case 'lush':
        // remote-sensing greens: olive, sage, moss — never crayon
        p.sea = stops([[0, J('#050f26')], [0.45, J('#0a2f55')], [0.8, J('#175a75')], [1, J('#4e8f83')]]);
        p.land = stops([[0, J('#b3a478')], [0.06, J('#8f9459')], [0.22, J('#5f7a42')], [0.45, J('#4a5f38')],
                        [0.62, J('#6b6a48')], [0.78, J('#77695a')], [1, J('#877e6f')]]);
        p.forest = J('#2e4527'); p.rock = J('#6b6156');
        p.snow = J('#dce5ed'); p.snowLine = this.hAmp * (0.68 + rand() * 0.14); p.capLat = 0.86;
        break;
      case 'ocean':
        p.sea = stops([[0, J('#041124')], [0.5, J('#082c52')], [0.82, J('#135273')], [1, J('#3f8f88')]]);
        p.land = stops([[0, J('#c2b183')], [0.12, J('#a29a62')], [0.3, J('#657e49')], [0.6, J('#4c5f3d')], [1, J('#6c6b56')]]);
        p.forest = J('#2f4a2c'); p.rock = J('#6f685c');
        p.snow = J('#d9e4ed'); p.snowLine = this.hAmp * 0.76; p.capLat = 0.82;
        break;
      case 'desert':
        p.land = stops([[0, J('#d8b069')], [0.2, J('#cf9a52')], [0.42, J('#bd7d40')], [0.6, J('#a26035')],
                        [0.8, J('#84502e')], [1, J('#6e4226')]]);
        p.rock = J('#7c4e2c'); p.strata = true;
        break;
      case 'ice':
        p.sea = stops([[0, J('#9cc2dd')], [0.6, J('#b9d8ec')], [1, J('#d8ecf8')]]);
        p.land = stops([[0, J('#cfe2f0')], [0.35, J('#ddeefa')], [0.65, J('#c4dcf0')], [1, J('#f0f8ff')]]);
        p.rock = J('#5d6b7a'); p.crevasse = J('#7fa8d8');
        p.slopeLo = 0.3; p.slopeHi = 0.6;
        break;
      case 'lava':
        p.land = stops([[0, J('#221b1d')], [0.3, J('#392c2e')], [0.6, J('#4a3a36')], [1, J('#5d4a40')]]);
        p.rock = J('#2b2225'); p.ember = col('#ff5a16');
        break;
      case 'barren':
        p.land = stops([[0, J('#8f8b84')], [0.35, J('#79746d')], [0.65, J('#99948b')], [1, J('#67625b')]]);
        p.rock = J('#57534d');
        break;
      case 'toxic':
        p.sea = stops([[0, J('#274d11')], [0.6, J('#4d7a1c')], [1, J('#7fb52e')]]);
        p.land = stops([[0, J('#5d7c30')], [0.28, J('#6f9437')], [0.52, J('#4e6f2a')], [0.78, J('#665a85')], [1, J('#7a6a9a')]]);
        p.blotch = J('#8a4aa0'); p.rock = J('#46552f');
        break;
      case 'exotic': {
        const h1 = rand(), h2 = (h1 + 0.33 + rand() * 0.2) % 1;
        const c1 = new THREE.Color().setHSL(h1, 0.75, 0.55);
        const c2 = new THREE.Color().setHSL(h2, 0.7, 0.45);
        const c3 = new THREE.Color().setHSL((h1 + 0.5) % 1, 0.5, 0.7);
        p.land = stops([[0, c1.clone().multiplyScalar(0.5)], [0.4, c1], [0.75, c2], [1, c3]]);
        p.stripes = stops([[0, c2.clone().multiplyScalar(0.7)], [1, c3]]);
        p.rock = c1.clone().multiplyScalar(0.35);
        break;
      }
    }
    // Colors are authored as sRGB hex and shaded in linear — and that
    // conversion has ALREADY happened. `col()` is `new THREE.Color(hex)`, and
    // with THREE.ColorManagement enabled (the r155+ default, and this project
    // never disables it) the hex constructor decodes sRGB into the linear
    // working space. `setHSL` in the exotic branch likewise writes linear.
    // An explicit `convertSRGBToLinear()` here used to run the decode a SECOND
    // time, crushing every authored colour: sand #b3a478 shaded as #7d6a2e,
    // and deep sea #050f26 as #00010a — black. That is the arithmetic behind
    // the "one flat cheap blue ocean" report: with the water body colour at
    // zero, the only thing left on screen was the shader's constant sky wash.
    // See docs/optimization-roadmap.md 2.3.
    this.pal = p;

    // each world's species tint its forests: a planet covered in purple
    // trees reads purple from ORBIT, not generic green. The flora palette
    // derives from the pre-blend forest colour and is cached here so the
    // species colours stay stable (own rng stream — planet rng untouched).
    this.flora = null;    // species geometries, built lazily on approach
    this.floraPal = floraPalette(this, makeRng(this.seed + ':flora'));
    // 0.3: enough to colour forests from orbit, while trees stay brighter
    // than the ground they stand on (full-strength blending camouflaged them)
    if (p.forest) p.forest = p.forest.clone().lerp(this.floraPal.canopy, 0.3);

    // the palette as shader uniforms: the terrain fragment shader evaluates
    // the full gradient per-PIXEL, so coastlines and rock bands stay crisp
    // from orbit and colors can't pop between LODs
    const MAXS = 7;
    const pad = (stops) => {
      const t = new Array(MAXS).fill(1);
      const c = [];
      for (let i = 0; i < MAXS; i++) {
        const s = stops[Math.min(i, stops.length - 1)];
        t[i] = s.t;
        c.push(s.c);
      }
      return { t, c, n: stops.length };
    };
    const landU = pad(p.land);
    const seaU = pad(p.sea || p.land);
    const black = new THREE.Color(0, 0, 0);
    this.palU = {
      landT: landU.t, landC: landU.c, landN: landU.n,
      seaT: seaU.t, seaC: seaU.c, seaN: seaU.n,
      hasSea: this.hasLiquid && this.liquid !== 'lava' ? 1 : 0,
      rock: p.rock,
      slopeLo: p.slopeLo, slopeHi: p.slopeHi,
      t0: this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85,
      tSpan: this.hAmp * 1.15 - (this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85),
      seaDepthSpan: this.hAmp * 0.85,
      forest: p.forest || black,
      blotch: p.blotch || black,
      stripeA: p.stripes ? p.stripes[0].c : black,
      stripeB: p.stripes ? p.stripes[p.stripes.length - 1].c : black,
      stripeK: p.stripes ? 0.55 : 0,
      extraC: this.liquid === 'lava' ? p.ember : (p.crevasse || black),
      extraMode: this.liquid === 'lava' || p.crevasse ? 1 : (p.strata ? 3 : 0),
    };

    // liquid & atmosphere colors
    // `col()` already decoded sRGB → linear; a second decode was crushing it.
    this.atmoColor = col(this.cfg.atmo);
    this.skyColor = col(this.cfg.sky);
    switch (this.liquid) {
      case 'water': this.liquidColor = col('#15527e'); this.liquidOpacity = 0.66; break;
      case 'toxic': this.liquidColor = col('#6fcc22'); this.liquidOpacity = 0.82; break;
      case 'ice':   this.liquidColor = col('#cfe6f5'); this.liquidOpacity = 1.0; break;
      case 'lava':  this.liquidColor = col('#3a1404'); this.liquidOpacity = 1.0; break;
    }
  }

  // Biome classification for the prop scatter system. CRITICAL: this must
  // mirror the same elevation/moisture bands that colorAt paints, or the
  // ground you see from orbit lies about what grows on it up close.
  snowWeightAt(dir, h) {
    if (!this.pal.snow || this.pal.snowLine >= 1e8) return 0;
    // CPU counterpart of the shader snow mask. The same altitude and polar-cap
    // logic is now authoritative for flora suitability as well as colour.
    const lat = Math.abs(dir.y) + this.nD.noise(dir.x * 2, dir.y * 2, dir.z * 2) * 0.06;
    const sl = this.pal.snowLine * (1 - 0.65 * smoothstep(0.45, 0.95, lat));
    return Math.max(smoothstep(sl, sl + Math.max(18, this.hAmp * 0.2), h),
      smoothstep(this.pal.capLat, this.pal.capLat + 0.085, lat));
  }

  biomeAt(dir, h) {
    if ((this.type === 'lush' || this.type === 'ocean') && this.snowWeightAt(dir, h) > 0.28) return 'snow';
    if (this.hasLiquid && h < this.seaLevel + 1.5) return 'shore';
    switch (this.type) {
      case 'lush': case 'ocean': {
        const t0 = this.seaLevel;
        const tl = clamp((h - t0) / (this.hAmp * 1.15 - t0), 0, 1);
        if (tl > 0.6) return 'rock';                 // olive-brown high country: bare
        const moist = this.nC.fbm(dir.x + 11.3, dir.y - 4.1, dir.z + 7.7, 2.4, 3, 0.5, 2.15, 64);
        if (tl > 0.45) return moist > 0.25 ? 'grass' : 'rock';
        // forests only where the palette actually darkens green
        if (moist > 0.14 && tl > 0.05) return 'forest';
        return moist > -0.12 ? 'grass' : 'dryland';  // tan zones get dry tufts
      }
      case 'desert': {
        const tl = h + this.contAmp * 0.85;
        return tl > this.hAmp * 1.1 ? 'rock' : 'sand';
      }
      case 'ice': return 'ice';
      case 'lava': return h < this.seaLevel + this.hAmp * 0.2 ? 'ember' : 'ash';
      case 'barren': return 'regolith';
      case 'toxic': return 'slime';
      case 'exotic': return 'weird';
    }
    return 'rock';
  }

  // ---- visual extras ------------------------------------------------------
  buildEffects(rand) {
    const R = this.R;

    if (this.hasLiquid) {
      let mat;
      if (this.liquid === 'lava') {
        mat = new THREE.MeshStandardMaterial({
          color: this.liquidColor, emissive: col('#ff4d0a'), emissiveIntensity: 1.5, roughness: 0.55,
        });
      } else if (this.liquid === 'ice') {
        mat = new THREE.MeshStandardMaterial({ color: this.liquidColor, roughness: 0.32, metalness: 0.05 });
      } else {
        mat = new THREE.MeshPhysicalMaterial({
          color: this.liquidColor, transparent: true, opacity: this.liquidOpacity,
          roughness: 0.13, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false,
        });
      }
      if (this.liquid === 'water' || this.liquid === 'toxic') mat = applyWaterWaves(mat, this);
      this.liquidMat = mat;
      // A former coplanar blue underlay hid clear-colour fringe, but it also
      // flattened transmission and could reveal chunk triangles through the
      // physical surface. The swash overlap in the water vertex shader now
      // closes the coast itself, so there is deliberately no visual backing.
      this.waterUnderlayMaterial = null;
      // Seas use the same parent-triangle geomorph contract as terrain.
      // Geometry is nominally spherical, but bathymetry, shore foam and
      // absorption are not: swapping their vertex fields per chunk exposed
      // rectangular depth bands even when the water silhouette looked smooth.
      // Geometric swell bottoms out at 146 m wavelength. The former
      // 24-vertex, level-7 near field left ~460 m cells on the 900 km home
      // world, so those waves could only exist in the normal shader. Keep at
      // least five samples across the shortest swell in the closest LOD.
      const waterCanonicalGrid = 16;
      const lowTierGrouping = this.canonicalGridCells <= 18;
      const waterGroupFactor = lowTierGrouping ? 4 : 2;
      const waterGridCells = waterCanonicalGrid * waterGroupFactor;
      const waterGridCellsAtLevel = () => waterGridCells;
      const waterCanonicalMaxLevel = Math.min(this.canonicalMaxLevel - 3, 11);
      this.waterLod = new ChunkedLOD({
        // At the finest ~29 m cells the spherical chord sag is sub-millimetre.
        // A 2.5 m skirt was vastly larger than the gap and exposed dark walls
        // whenever the water was translucent. Dense adjacent shells therefore
        // meet directly; the coast overlap handles the independent land edge.
        R: this.seaRadius, hAmp: 2, noMorph: false, noSkirt: true,
        faceBoundarySkirts: false,
        noShadow: true,
        gridCells: waterGridCells,
        gridCellsAtLevel: waterGridCellsAtLevel,
        maxLevel: Math.max(2, waterCanonicalMaxLevel - (lowTierGrouping ? 3 : 0)),
        orbitLevelCap: lowTierGrouping ? 3 : 4,
        orbitPrewarmRadiusRatio: 1.75,
        // A smooth water sphere does not need terrain's two extra 136 km
        // approach levels. Add curvature detail only as its kilometre-scale
        // cells become resolvable, while spectral waves remain shader-driven.
        orbitApproachLevelThresholds: [1.12, 1.06, 1.025],
        lodDistanceScale: (waterCanonicalGrid / waterGridCells) * (lowTierGrouping ? 0.25 : 1),
        lodDistanceScaleAtLevel: (lvl) => (waterCanonicalGrid / waterGridCellsAtLevel(lvl))
          * (lowTierGrouping ? 0.25 : 1),
        lodLevelForCanonical: (canonicalLevel) => {
          for (let level = 0; level <= waterCanonicalMaxLevel; level++) {
            const effective = level + Math.log2(waterGridCellsAtLevel(level) / waterCanonicalGrid);
            if (effective >= canonicalLevel) return level;
          }
          return waterCanonicalMaxLevel;
        },
        freqAtLevel: this.canonicalFreqAtLevel,
        height: () => 0,
        colorAt: (dir, h, slope, f, out) => out.setRGB(1, 1, 1),
        // water knows how deep the terrain lies beneath every vertex —
        // the shader turns that into Beer–Lambert absorption
        bakeDepth: (this.liquid === 'water' || this.liquid === 'toxic')
          ? (dir) => Math.max(0, this.seaLevel - this.height(dir, this.fullMaxFreq))
          : null,
        group: this.group,
        terrainMaterial: mat,
        underlayMaterial: this.waterUnderlayMaterial,
      });
    }

    if (this.atmoDensity > 0.05) {
      const atmoR = R + Math.max(this.hAmp * 3.2, R * this.atmoFraction);
      this.atmoMesh = new THREE.Mesh(
        new THREE.SphereGeometry(atmoR, 96, 64),
        makeAtmosphereMaterial(this, this.atmoColor, this.atmoDensity, R, atmoR),
      );
      // Atmosphere is the first participating-medium layer; clouds composite
      // over it in the shared half-resolution volume pass.
      this.atmoMesh.renderOrder = 1;
      // Distant-body atmosphere belongs to the world pass so ordinary depth
      // naturally occludes it. VolumetricPass moves only the active planet to
      // VOLUME_LAYER and binds opaque scene depth for local integration.
      this.atmoMesh.layers.set(WORLD_LAYER);
      this.atmoMesh.material.fog = false;
      this.atmoMesh.frustumCulled = false;
      this.group.add(this.atmoMesh);
      this.atmoHeight = atmoR - R;
    } else {
      this.atmoHeight = Math.max(this.hAmp * 3.2, R * this.atmoFraction * 0.72);
    }

    // Cloud coverage is part of the astronomy dossier. It is derived from
    // pressure, temperature and condensates instead of being rerolled here.
    this.cloudBands = [];
    this.cloudCoverage = 0;
    // Consume the legacy cloud roll even when an astronomy profile or authored
    // override owns the result. Effects later in this constructor historically
    // shared this stream; skipping these draws made curated planets gain rings
    // merely because cloud metadata was introduced.
    const legacyHasClouds = this.cfg.clouds > 0.05 && rand() < this.cfg.clouds;
    const legacyCloudCoverage = legacyHasClouds ? 0.3 + rand() * 0.55 : 0;
    const naturalCloudCoverage = Number.isFinite(this.cloudProfile?.coverage)
      ? clamp(this.cloudProfile.coverage, 0, 0.85)
      : legacyCloudCoverage;
    const tunedCloudCoverage = Number.isFinite(this.tuning.cloudCoverage)
      ? clamp(this.tuning.cloudCoverage, 0, 0.85)
      : null;
    const coverage = tunedCloudCoverage ?? naturalCloudCoverage;
    if (coverage > 0.05) {
      this.cloudCoverage = coverage;
      const o1 = [rand() * 7, rand() * 7, rand() * 7];
      this.cloudOffsets = o1;
      this.weatherProfile = {
        cloudiness: clamp(coverage, 0.04, 0.96),
        humidity: this.hasLiquid ? 0.72 : this.type === 'ice' ? 0.62 : 0.28,
        storminess: this.tuning.weatherStyle === 'pelagic-storm'
          || this.tuning.oceanClass === 'pelagic-storm' ? 0.9
          : this.type === 'toxic' ? 0.72 : 0.4,
        highClouds: coverage > 0.45 ? 0.48 : 0.2,
        fogginess: this.hasLiquid ? 0.34 : 0.16,
        windSpeed: 8 + (this.waterStyle?.swell || 0.6) * 13,
        weatherSpeed: 6,
        temperatureK: this.type === 'ice' ? 258 : this.type === 'lava' ? 430 : 286,
      };
      this.weatherField = createWeatherField(this.seed, {
        profile: this.weatherProfile,
        fixture: DEV_WEATHER_FIXTURE || undefined,
      });
      // The meteorological authority is split into the same Lo/Hi contract
      // used by the volume shader. Keeping cloud type and stratus in Lo and
      // high-deck type/multiple scattering in Hi avoids throwing away entire
      // cloud families merely to fit one RGBA atlas.
      const weatherAtlases = makeCloudTextures(
        this.nD, coverage, o1, this.weatherField);
      this.cloudShadowTex = weatherAtlases.low;
      this.cloudWeatherHiTex = weatherAtlases.high;
      this.cloudCoverageStats = weatherAtlases.stats;
      const terrainCloudNode = this.terrainMaterial.userData.cloudShadowTextureNode;
      if (terrainCloudNode) terrainCloudNode.value = this.cloudShadowTex;
      const terrainShader = this.terrainMaterial.userData.shader;
      if (terrainShader?.uniforms.uCloudK) terrainShader.uniforms.uCloudK.value = 0.42;
      if (this.liquidMat?.userData.waterCloudTexture) {
        this.liquidMat.userData.waterCloudTexture.value = this.cloudShadowTex;
      }
      const waterShader = this.liquidMat?.userData.shader;
      if (waterShader?.uniforms.uCloudK) waterShader.uniforms.uCloudK.value = 0.72;
      // A single physical volume spans the tropospheric families. Density
      // profiles inside it place stratus/cumulus low, alto clouds mid-level
      // and cirrus/anvils high. The previous mountain-scaled cloud base could
      // start tens of kilometres above sea level and read as a white crust.
      const cloudBaseAlt = Math.min(
        Math.max(650, this.hAmp * 0.045),
        this.atmoHeight * 0.08,
      );
      const cloudR = R + cloudBaseAlt;
      const thick = Math.min(
        Math.max(14000, this.hAmp * 1.15),
        this.atmoHeight * 0.24,
      );
      const cmat = new THREE.MeshBasicMaterial({
        color: this.type === 'toxic' ? 0xc8e890 : 0xffffff,
        transparent: true, depthWrite: false, opacity: 0.88,
        // The analytic deck is the low-GPU fallback both from orbit and from
        // beneath the cloud base. FrontSide alone disappears for a surface
        // camera because it is looking at the inside of the sphere.
        side: THREE.DoubleSide,
      });
      cmat.forceSinglePass = true;
      const cloudMat = applyCloudField(cmat, coverage, o1[0], o1[1], o1[2],
        thick * 0.96, this.cloudShadowTex);
      this.cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(cloudR, 256, 160), cloudMat);
      this.cloudMesh.renderOrder = 2;
      this.group.add(this.cloudMesh);
      this.cloudBands.push({
        r: cloudR, mesh: this.cloudMesh, opacity: 0.88,
        halfThickness: Math.max(this.hAmp * 0.8, R * this.cloudThicknessFraction * 0.5, 1800),
        thickness: thick,
        cov0: 0.55 - coverage * 0.24, cov1: 0.86 - coverage * 0.14,
        ox: o1[0], oy: o1[1], oz: o1[2],
      });
      // the second deck's dice roll ALWAYS happens (the rng stream must not
      // depend on render flags), but with volumetrics on we spend it there
      const o2 = coverage > 0.45
        ? [rand() * 7, rand() * 7, rand() * 7, rand() * Math.PI * 2] : null;
      if (volumetricCloudsEnabled) {
        // The far deck supplies global weather; deterministic spatial cloud
        // clusters supply close parallax and real separation through the
        // atmosphere without a screen-space raymarch curtain.
        const band = {
          rIn: cloudR, rOut: cloudR + thick,
          cov0: 0.55 - coverage * 0.24, cov1: 0.86 - coverage * 0.14,
          ox: o1[0], oy: o1[1], oz: o1[2],
          tint: this.type === 'toxic' ? 0xc8e890 : 0xffffff,
        };
        this.volCloudMat = makeCloudVolumeMaterial(
          this, band, detailTexture(), this.cloudShadowTex,
          this.cloudWeatherHiTex,
          volumetricCloudProfile);
        // WebGPU cloud shells share one live NodeMaterial; the per-planet state
        // remains independent here. The WebGL compatibility implementation
        // still exposes ordinary material uniforms and enters the same API.
        this.volCloudUniforms ||= this.volCloudMat.uniforms;
        this.volCloudBand ||= band;
        this.volCloudUniforms.uAmbC.value
          .copy(this.skyColor).multiplyScalar(0.58);
        this.volCloudMesh = new THREE.Mesh(
          new THREE.SphereGeometry(band.rOut, 192, 128), this.volCloudMat);
        this.volCloudMesh.renderOrder = 2;
        this.volCloudMesh.layers.set(VOLUME_LAYER);
        this.volCloudMesh.frustumCulled = false;
        this.volCloudMesh.visible = false;
        this.group.add(this.volCloudMesh);
      }
      if (o2) {
        // A physically separate upper deck remains visible from space. Its
        // offset pattern and altitude make cloud edges parallax against the
        // lower weather layer instead of reading as one painted film.
        const cmat2 = new THREE.MeshBasicMaterial({
          color: this.type === 'toxic' ? 0xd4efaa : 0xf4f8ff,
          transparent: true, depthWrite: false, opacity: 0.28,
          side: THREE.DoubleSide,
        });
        cmat2.forceSinglePass = true;
        const upperCloudMat = applyCloudField(cmat2, coverage * 0.42,
          o2[0], o2[1], o2[2], thick * 0.32, this.cloudWeatherHiTex, 'high');
        const upperR = cloudR + thick * 0.38;
        this.cloudMesh2 = new THREE.Mesh(
          new THREE.SphereGeometry(upperR, 192, 128), upperCloudMat);
        this.cloudMesh2.renderOrder = 2;
        this.group.add(this.cloudMesh2);
        this.cloudSpin2 = o2[3];
        this.cloudBands.push({
          r: upperR, mesh: this.cloudMesh2, opacity: 0.28,
          halfThickness: Math.max(this.hAmp * 0.65, R * this.cloudThicknessFraction * 0.42, 1400),
          cov0: 0.55 - coverage * 0.42 * 0.24, cov1: 0.86 - coverage * 0.42 * 0.14,
          ox: o2[0], oy: o2[1], oz: o2[2],
        });
      }
      // Noctilucent ice belongs near the mesopause, not in the tropospheric
      // volume. A very thin, terminator-only shell gives orbit the authentic
      // silver-blue hairline without contaminating daytime surface views.
      if (this.atmoHeight > 30000 && coverage > 0.18) {
        const noctilucentAltitude = Math.min(82000, this.atmoHeight * 0.86);
        const noctilucentSource = new THREE.MeshBasicMaterial({
          color: 0xaadfff,
          transparent: true,
          depthWrite: false,
          opacity: 0.12,
          side: THREE.DoubleSide,
        });
        const noctilucentMat = applyNoctilucentField(noctilucentSource,
          clamp(coverage * 0.62, 0.08, 0.5), o1[0], o1[1], o1[2],
          this.cloudWeatherHiTex);
        this.cloudMeshNoctilucent = new THREE.Mesh(
          new THREE.SphereGeometry(R + noctilucentAltitude, 192, 128),
          noctilucentMat);
        this.cloudMeshNoctilucent.renderOrder = 2;
        this.cloudMeshNoctilucent.frustumCulled = false;
        this.group.add(this.cloudMeshNoctilucent);
      }
    }

    const ringSystem = this.ringSystem;
    const ringPresent = ringSystem ? ringSystem.present : (!this.isMoon && rand() < 0.24);
    if (!this.isMoon && ringPresent) {
      const inner = R * (ringSystem?.innerRadiusRatio || (1.55 + rand() * 0.4));
      const outer = R * (ringSystem?.outerRadiusRatio || (inner / R + 0.5 + rand() * 0.7));
      const geo = new THREE.RingGeometry(inner, outer, 160, 1);
      // map UV.x to radius for the band texture
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        uv.setXY(i, (r - inner) / (outer - inner), 0.5);
      }
      const ringTint = this.pal.land[Math.min(2, this.pal.land.length - 1)].c;
      this.ringMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: makeRingTexture(makeRng(this.seed + ':ring'), ringTint),
        transparent: true, side: THREE.DoubleSide, depthWrite: false,
        opacity: ringSystem?.opticalDepth ? Math.min(0.92, 0.28 + ringSystem.opticalDepth * 0.68) : 0.85,
      }));
      this.ringMesh.quaternion.copy(this.axisQuat);
      this.ringMesh.rotateX(Math.PI / 2);
      this.ringMesh.renderOrder = 2;
      this.group.add(this.ringMesh);
    }
  }

  setSunDir(dirLocal) {
    this.sunDirWorld.copy(dirLocal);
    this.sunDirLocal.copy(dirLocal).applyQuaternion(this._invFrame);
    if (this.atmoMesh) {
      const uniforms = this.atmoUniforms || this.atmoMesh.material.uniforms;
      (uniforms.sunDir || uniforms.uStellarDirections0)?.value.copy(this.sunDirLocal);
    }
    const waterShader = this.liquidMat?.userData.shader;
    if (waterShader?.uniforms.uSunDir) waterShader.uniforms.uSunDir.value.copy(this.sunDirLocal);
  }

  setStellarLights(field) {
    if (!field?.sources?.length) return this.setSunDir(this.sunDirWorld);
    const ordered = [...field.sources];
    const dominant = Math.max(0, Math.min(ordered.length - 1, field.dominantIndex ?? 0));
    if (dominant !== 0) [ordered[0], ordered[dominant]] = [ordered[dominant], ordered[0]];
    this.stellarLightField = {
      ...field,
      sources: ordered.map((source) => ({
        ...source,
        worldDirection: new THREE.Vector3().fromArray(source.direction).normalize(),
        localDirection: new THREE.Vector3().fromArray(source.direction)
          .applyQuaternion(this._invFrame).normalize(),
        colorValue: new THREE.Color().fromArray(source.color || [1, 1, 1]),
      })),
      dominantIndex: 0,
    };
    const primary = this.stellarLightField.sources[0];
    const secondary = this.stellarLightField.sources[1] || null;
    this.sunDirWorld.copy(primary.worldDirection);
    this.sunDirLocal.copy(primary.localDirection);
    const terrainEclipse = this.terrainMaterial?.userData?.shader?.uniforms;
    if (terrainEclipse?.uEclipseSunDir) {
      terrainEclipse.uEclipseSunDir.value.copy(primary.localDirection);
    }
    const atmo = this.atmoUniforms || this.atmoMesh?.material?.uniforms;
    if (atmo) {
      (atmo.uStellarDirections0 || atmo.sunDir)?.value.copy(primary.localDirection);
      atmo.uStellarRadiance0?.value.copy(primary.colorValue);
      if (atmo.uStarIrradiance0) atmo.uStarIrradiance0.value = primary.irradianceFraction ?? 1;
      if (secondary) {
        atmo.uStellarDirections1?.value.copy(secondary.localDirection);
        atmo.uStellarRadiance1?.value.copy(secondary.colorValue);
        if (atmo.uStarIrradiance1) {
          atmo.uStarIrradiance1.value = secondary.irradianceFraction ?? 0;
        }
      } else if (atmo.uStarIrradiance1) {
        atmo.uStarIrradiance1.value = 0;
      }
    }
    const water = this.liquidMat?.userData.shader?.uniforms;
    if (water?.uSunDir) water.uSunDir.value.copy(primary.localDirection);
    if (water?.uSecondarySunDir) {
      water.uSecondarySunDir.value.copy(secondary?.localDirection || primary.localDirection);
    }
    if (water?.uSecondarySunColor) {
      water.uSecondarySunColor.value.copy(secondary?.colorValue || primary.colorValue);
    }
    if (water?.uSecondarySunEnergy) {
      water.uSecondarySunEnergy.value = secondary?.irradianceFraction ?? 0;
    }
    const clouds = this.volCloudUniforms || this.volCloudMat?.uniforms;
    if (clouds) {
      clouds.uStellarDirections0?.value.copy(primary.localDirection);
      clouds.uStellarRadiance0?.value.copy(primary.colorValue);
      if (clouds.uStarIrradiance0) {
        clouds.uStarIrradiance0.value = primary.irradianceFraction ?? 1;
      }
      if (secondary) {
        clouds.uStellarDirections1?.value.copy(secondary.localDirection);
        clouds.uStellarRadiance1?.value.copy(secondary.colorValue);
        if (clouds.uStarIrradiance1) {
          clouds.uStarIrradiance1.value = secondary.irradianceFraction ?? 0;
        }
      } else if (clouds.uStarIrradiance1) {
        clouds.uStarIrradiance1.value = 0;
      }
    }
    return this.stellarLightField;
  }

  setEclipseOccluder(occluder = null) {
    const targets = [
      this.terrainMaterial?.userData?.shader?.uniforms,
      this.liquidMat?.userData?.shader?.uniforms,
      this.atmoUniforms || this.atmoMesh?.material?.uniforms,
      this.volCloudUniforms || this.volCloudMat?.uniforms,
    ];
    for (const uniforms of targets) {
      if (!uniforms?.uEclipseEnabled) continue;
      if (!occluder) {
        uniforms.uEclipseEnabled.value = 0;
        continue;
      }
      uniforms.uEclipseCenter.value.copy(occluder.centerLocal);
      uniforms.uEclipseRadius.value = Math.max(1, occluder.radius || 1);
      uniforms.uEclipseStarAngle.value = Math.max(0, occluder.starAngularRadius || 0);
      uniforms.uEclipseEnabled.value = 1;
    }
  }

  setStellarField(field) {
    return this.setStellarLights(field);
  }

  setWeatherTime(hours) {
    if (!Number.isFinite(hours)) return this.weatherState;
    this.weatherHours = Number(hours);
    this.weatherState = advanceWeatherField(this.weatherField, this.weatherHours);
    const uniforms = this.volCloudUniforms || this.volCloudMat?.uniforms;
    if (uniforms?.uWeatherTime) uniforms.uWeatherTime.value = this.weatherHours;
    return this.weatherState;
  }

  weatherAt(localDirection, hours = this.weatherHours) {
    return sampleWeatherField(this.weatherField, localDirection, hours);
  }

  setWeatherFixture(name = null) {
    this.weatherField = createWeatherField(this.seed, {
      profile: this.weatherProfile,
      fixture: name || undefined,
    });
    if (this.cloudShadowTex && this.cloudOffsets) {
      const previous = this.cloudShadowTex;
      const previousHi = this.cloudWeatherHiTex;
      const weatherAtlases = makeCloudTextures(
        this.nD, this.cloudCoverage || 0.5, this.cloudOffsets,
        this.weatherField);
      this.cloudShadowTex = weatherAtlases.low;
      this.cloudWeatherHiTex = weatherAtlases.high;
      this.cloudCoverageStats = weatherAtlases.stats;
      const terrainNode = this.terrainMaterial.userData.cloudShadowTextureNode;
      if (terrainNode) terrainNode.value = this.cloudShadowTex;
      if (this.liquidMat?.userData.waterCloudTexture) {
        this.liquidMat.userData.waterCloudTexture.value = this.cloudShadowTex;
      }
      for (const [material, textureValue] of [
        [this.cloudMesh?.material, this.cloudShadowTex],
        [this.cloudMesh2?.material, this.cloudWeatherHiTex],
      ]) {
        const weatherNode = material?.userData.weatherSystemTextureNode;
        if (weatherNode) weatherNode.value = textureValue;
        if (material?.userData) material.userData.weatherSystemTexture = textureValue;
      }
      const volumeState = this.volCloudState;
      const volumeLoNode = volumeState?.weatherLoTextureNode
        || this.volCloudMat?.userData.weatherLoTextureNode;
      const volumeHiNode = volumeState?.weatherHiTextureNode
        || this.volCloudMat?.userData.weatherHiTextureNode;
      if (volumeLoNode) volumeLoNode.value = this.cloudShadowTex;
      if (volumeHiNode) volumeHiNode.value = this.cloudWeatherHiTex;
      if (volumeState) {
        volumeState.weatherLoMap = this.cloudShadowTex;
        volumeState.weatherHiMap = this.cloudWeatherHiTex;
      } else if (this.volCloudMat?.userData) {
        this.volCloudMat.userData.weatherLoTexture = this.cloudShadowTex;
        this.volCloudMat.userData.weatherHiTexture = this.cloudWeatherHiTex;
      }
      previous.dispose();
      previousHi?.dispose();
    }
    return this.setWeatherTime(this.weatherHours);
  }

  weatherFingerprint(samples = 96) {
    return weatherFieldFingerprint(this.weatherState, this.weatherHours, samples);
  }

  setFrame(orientation) {
    this.frameOrientation.copy(orientation);
    this._invFrame.copy(orientation).invert();
    this.group.quaternion.copy(orientation);
    // Re-express the live stellar direction in the rotating body frame.
    this.sunDirLocal.copy(this.sunDirWorld).applyQuaternion(this._invFrame);
    if (this.stellarLightField?.sources) {
      for (const source of this.stellarLightField.sources) {
        source.localDirection.copy(source.worldDirection).applyQuaternion(this._invFrame);
      }
      this.setStellarLights(this.stellarLightField);
    } else if (this.atmoMesh) {
      const uniforms = this.atmoUniforms || this.atmoMesh.material.uniforms;
      (uniforms.uStellarDirections0 || uniforms.sunDir)?.value.copy(this.sunDirLocal);
    }
    const waterShader = this.liquidMat?.userData.shader;
    if (waterShader?.uniforms.uSunDir) waterShader.uniforms.uSunDir.value.copy(this.sunDirLocal);
  }

  setWaterEnvironment(zenith, horizon, day = 1, sunset = 0) {
    const uniforms = this.liquidMat?.userData.shader?.uniforms;
    if (!uniforms?.uSkyZenith) return;
    uniforms.uSkyZenith.value.copy(zenith);
    uniforms.uSkyHorizon.value.copy(horizon);
    uniforms.uDay.value = clamp(day, 0, 1);
    uniforms.uSunset.value = clamp(sunset, 0, 1);
  }

  worldOffsetToLocal(worldOffset, out = new THREE.Vector3()) {
    return out.copy(worldOffset).applyQuaternion(this._invFrame);
  }

  localOffsetToWorld(localOffset, out = new THREE.Vector3()) {
    return out.copy(localOffset).applyQuaternion(this.frameOrientation);
  }

  localPositionToWorld(localPosition, out = new THREE.Vector3()) {
    return this.localOffsetToWorld(localPosition, out).add(this.posUniv);
  }

  worldPositionToLocal(worldPosition, out = new THREE.Vector3()) {
    return out.copy(worldPosition).sub(this.posUniv).applyQuaternion(this._invFrame);
  }

  // How deep in a cloud the camera is (0..1). This is simulation state for
  // weather/audio only; visible extinction belongs to the depth-aware volume
  // itself. The retired path used raw weather *coverage* here and then fed it
  // to global FogExp2, so entering nominally clear air could replace the whole
  // frame with blue/white before the player reached a real cloud.
  cloudTransit(camLocal) {
    if (!this.cloudBands.length) return 0;
    camLocal = this.worldOffsetToLocal(camLocal, _msp);
    const camR = camLocal.length();
    let t = 0;
    for (const b of this.cloudBands) {
      const thickness = Math.max(1, b.thickness || (b.halfThickness || 1800) * 2);
      const height = (camR - b.r) / thickness;
      if (height <= 0 || height >= 1) continue;
      _dir.copy(camLocal).multiplyScalar(1 / camR)
        .applyQuaternion(_q2.copy(b.mesh.quaternion).invert());
      const liveWeather = this.weatherAt?.(_dir) || {};
      const base = cloudDensityCPU(_dir, b.cov0, b.cov1, b.ox, b.oy, b.oz);
      const coverage = clamp(liveWeather.coverage || 0, 0, 1);
      const cloudType = clamp(liveWeather.cloudType || 0, 0, 1);
      const stratusMask = clamp(liveWeather.stratusMask || 0, 0, 1);
      const highMask = clamp(liveWeather.highMask || 0, 0, 1);
      const highType = clamp(liveWeather.highType || 0, 0, 1);
      const convective = clamp(liveWeather.convective || 0, 0, 1);
      const weatherRaw = clamp(base * (0.4 + coverage * 0.5) * 0.8
        + coverage * (0.18 + base * 0.2), 0, 1);
      const threshold = lerp(0.36, 0.22, cloudType);
      const formed = smoothstep(threshold, threshold + 0.42, weatherRaw);
      const stratus = smoothstep(0.015, 0.055, height)
        * smoothstep(0.25, 0.13, height) * stratusMask;
      const cumulusTop = clamp(lerp(0.34, 0.78, cloudType)
        + convective * 0.16, 0.3, 0.94);
      const cumulus = smoothstep(0.025, 0.09, height)
        * smoothstep(cumulusTop, cumulusTop - 0.18, height)
        * (1 - stratusMask * 0.72);
      const alto = smoothstep(0.27, 0.39, height)
        * smoothstep(0.62, 0.49, height) * highMask * (1 - highType);
      const cirrus = smoothstep(0.62, 0.72, height)
        * smoothstep(0.99, 0.88, height) * highMask * (0.42 + highType * 0.58);
      const anvil = smoothstep(0.57, 0.66, height)
        * smoothstep(0.88, 0.78, height) * convective * cloudType;
      const density = Math.max(formed * Math.max(stratus, cumulus),
        highMask * Math.max(alto, cirrus, anvil));
      t = Math.max(t, density * b.opacity);
    }
    return t;
  }

  cloudAudit(samples = 4096) {
    const band = this.cloudBands[0];
    if (!band) return { samples, baseCloud: 0, enhancedCloud: 0, gained: 0, lost: 0 };
    const d = new THREE.Vector3();
    let baseCloud = 0, enhancedCloud = 0, gained = 0, lost = 0;
    for (let k = 0; k < samples; k++) {
      const y = 1 - (2 * (k + 0.5)) / samples;
      const r = Math.sqrt(1 - y * y), angle = k * 2.399963229728653;
      d.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
      const base = cloudBaseDensityCPU(d, band.cov0, band.cov1, band.ox, band.oy, band.oz);
      const enhanced = cloudDensityCPU(d, band.cov0, band.cov1, band.ox, band.oy, band.oz);
      if (base > 0.08) baseCloud++;
      if (enhanced > 0.08) enhancedCloud++;
      if (enhanced > base + 0.04) gained++;
      if (enhanced + 1e-7 < base) lost++;
    }
    return { samples, baseCloud, enhancedCloud, gained, lost };
  }

  // camLocal: camera position in planet-local coords (f64 Vector3).
  // animDt drives scenery-in-motion (cloud drift); the seam test freezes it
  // to zero so static frames are pixel-comparable — LOD morphs keep dt.
  update(camLocal, dt, focused, animDt = dt) {
    camLocal = this.worldOffsetToLocal(camLocal, _msp);
    const camR = camLocal.length();
    this.lod.focused = focused;
    this.lod.update(camLocal, dt);
    if (this.waterLod) {
      this.waterLod.focused = focused;
      this.waterLod.update(camLocal, dt);
      const waterShader = this.liquidMat?.userData.shader;
      if (waterShader?.uniforms.uCameraLocal) {
        waterShader.uniforms.uCameraLocal.value.copy(camLocal);
      }
    }
    if (this.atmoMesh) {
      const au = this.atmoUniforms || this.atmoMesh.material.uniforms;
      if (au.uCameraLocal) au.uCameraLocal.value.copy(camLocal);
    }
    // shells vanish near their own altitude so you fly through, not pop through;
    // each deck also gets the sun direction in its own rotating frame
    if (this.cloudBands.length) {
      const surfaceView = smoothstep(1.8, 1.08, camR / this.R);
      for (const b of this.cloudBands) {
        const sh = b.mesh.material.userData.shader;
        if (sh) {
          const fadeWidth = Math.max(1800, (b.halfThickness || 1800) * 1.35);
          const x = Math.min(1, Math.max(0, (Math.abs(camR - b.r) - 250) / fadeWidth));
          sh.uniforms.uCamProx.value = x * x * (3 - 2 * x);
          if (sh.uniforms.uSurfaceView) sh.uniforms.uSurfaceView.value = surfaceView;
          if (this.sunDirLocal) {
            sh.uniforms.uCSun.value.copy(this.sunDirLocal)
              .applyQuaternion(_q2.copy(b.mesh.quaternion).invert());
          }
        }
      }
    }
    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + dt / 1.2);
      this.applyAppear();
    }
    if (this.cloudMesh) {
      this.cloudSpin = this.cloudSpinBase
        + this.weatherHours * (this.weatherField?.windRadiansPerHour || 0.05);
      // Planet local Y is already the physical rotation axis. Applying the
      // decorative ring tilt a second time rotated visible clouds away from
      // CPU weather, rain and the shadow atlas. Cloud decks therefore advect
      // only around the body-frame axis.
      this.cloudMesh.quaternion.setFromAxisAngle(_yAxis, this.cloudSpin);
      // keep terrain cloud-shadows tracking the drifting deck
      _m4.makeRotationFromQuaternion(_q2.copy(this.cloudMesh.quaternion).invert());
      const sh = this.terrainMaterial.userData.shader;
      if (sh) sh.uniforms.uCloudMat.value.setFromMatrix4(_m4);
      const waterShader = this.liquidMat?.userData.shader;
      if (waterShader?.uniforms.uCloudMat) {
        waterShader.uniforms.uCloudMat.value.setFromMatrix4(_m4);
      }
      if (this.volCloudMesh) {
        // The focused planet keeps the physical shell through normal orbit.
        // The former 24–56 km switch rendered every space view as a displaced
        // alpha sphere — exactly the painted-film failure visible in player
        // captures. At orbital distance the volume pass is already pixel
        // budgeted and uses the low step tier, so genuine thickness, internal
        // extinction and limb parallax remain cheaper than a second opaque
        // world pass while preserving the visual contract.
        const band = this.volCloudBand || this.volCloudMat.userData.band;
        const distanceToShell = camR < band.rIn
          ? band.rIn - camR
          : camR > band.rOut ? camR - band.rOut : 0;
        const volumeProximity = 1 - smoothstep(720000, 1050000, distanceToShell);
        const target = focused && this.volumeActive ? volumeProximity : 0;
        // Initialize directly in the correct ownership state. Fading from the
        // analytic deck after the first controllable frame exposed a visible
        // flat-to-volume cloud replacement during startup.
        if (this.volumeBlend === undefined) this.volumeBlend = target;
        else this.volumeBlend += (target - this.volumeBlend) * (1 - Math.exp(-dt * 5));
        const e = clamp(this.volumeBlend, 0, 1);
        const u = this.volCloudUniforms || this.volCloudMat.uniforms;
        u.uEngage.value = e;
        u.uCameraLocal.value.copy(camLocal);
        u.uSpin.value.setFromMatrix4(_m4);
        u.uFrame.value = (u.uFrame.value + 1) % 4096;
        if (u.uWeatherTime) u.uWeatherTime.value = this.weatherHours;
        this.volCloudMesh.visible = this.volumeActive && e > 0.01;
        this.cloudMesh.material.opacity = 0.88 * (1 - e);
        if (this.cloudMesh.material.userData.opacityNodeUniform) {
          this.cloudMesh.material.userData.opacityNodeUniform.value = this.cloudMesh.material.opacity;
        }
        this.cloudMesh.visible = this.cloudMesh.material.opacity > 0.005;
      }
    }
    if (this.cloudMesh2) {
      this.cloudSpin2 = this.cloudSpin2Base
        + this.weatherHours * (this.weatherField?.windRadiansPerHour || 0.05) * 1.47;
      this.cloudMesh2.quaternion.setFromAxisAngle(_yAxis, this.cloudSpin2);
      if (this.volCloudMesh) {
        const e = clamp(this.volumeBlend || 0, 0, 1);
        this.cloudMesh2.material.opacity = 0.28 * (1 - e);
        if (this.cloudMesh2.material.userData.opacityNodeUniform) {
          this.cloudMesh2.material.userData.opacityNodeUniform.value = this.cloudMesh2.material.opacity;
        }
        this.cloudMesh2.visible = this.cloudMesh2.material.opacity > 0.005;
      } else {
        // Headless generation and explicit ?vclouds=0 retain the analytic
        // deck; runtime high/low quality both construct the shared volume.
        this.cloudMesh2.material.opacity = 0.28;
        this.cloudMesh2.visible = true;
      }
    }
    if (this.cloudMeshNoctilucent) {
      this.cloudMeshNoctilucent.quaternion.setFromAxisAngle(
        _yAxis, this.cloudSpin * 1.18);
      const noctilucentShader = this.cloudMeshNoctilucent.material.userData.shader;
      if (noctilucentShader?.uniforms.uSunDir) {
        noctilucentShader.uniforms.uSunDir.value.copy(this.sunDirLocal)
          .applyQuaternion(_q2.copy(this.cloudMeshNoctilucent.quaternion).invert());
      }
    }
  }

  altitudeAt(camLocal) {
    camLocal = this.worldOffsetToLocal(camLocal, _msp);
    const r = camLocal.length();
    _dir.copy(camLocal).multiplyScalar(1 / r);
    return r - this.surfaceRadius(_dir);
  }

  get typeLabel() { return this.cfg.label; }

  // a pleasant landing spot: dry, gentle ground, daylight if preferDir is
  // given (the sun direction), and ideally a view — relief or a shoreline.
  // ringDir pins the spot to sun-elevation ≈ 4° above the horizon instead —
  // maximizing dot with a perpendicular is far too sloppy for golden hour.
  scenicDir(preferDir = null, ringDir = null) {
    const rand = makeRng(this.seed + ':scenic');
    let best = null, bestScore = -1e9;
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), s = new THREE.Vector3();
    const sunH = new THREE.Vector3();
    for (let i = 0; i < 200; i++) {
      _dir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (_dir.lengthSq() < 0.05 || _dir.lengthSq() > 1) continue;
      _dir.normalize();
      const h = this.height(_dir, 64);
      let score = 0;
      if (this.hasLiquid) {
        const above = h - this.seaLevel;
        if (above < 2) { continue; }                              // underwater: no
        score -= Math.abs(above - this.hAmp * 0.15) * 1.5;        // low ground…
        score += Math.max(0, 1 - above / (this.hAmp * 0.5)) * this.hAmp * 0.8; // …near the shore
      } else {
        score -= Math.abs(h) * 0.5;
      }
      // nearby relief = something to look at
      if (Math.abs(_dir.y) < 0.93) e1.set(-_dir.z, 0, _dir.x).normalize();
      else e1.set(1, 0, 0).projectOnPlane(_dir).normalize();
      e2.crossVectors(_dir, e1);
      let hMin = h, hMax = h;
      for (let k = 0; k < 4; k++) {
        s.copy(_dir).addScaledVector(k < 2 ? e1 : e2, (k % 2 ? 1 : -1) * 0.06).normalize();
        const hs = this.height(s, 64);
        hMin = Math.min(hMin, hs); hMax = Math.max(hMax, hs);
      }
      score += (hMax - hMin) * 1.4;
      score -= Math.abs(_dir.y) * this.hAmp * 0.3;                // temperate latitudes
      if (preferDir) score += _dir.dot(preferDir) * this.hAmp * 3.0; // land in daylight
      if (ringDir) {
        score -= Math.abs(_dir.dot(ringDir) - 0.11) * this.hAmp * 9.0;
        // …and the sun must actually CLEAR the skyline from this REGION —
        // a fine scan around a blocked spot can't escape a 2 km ridge
        sunH.copy(ringDir).addScaledVector(_dir, -ringDir.dot(_dir));
        if (sunH.lengthSq() > 1e-4) {
          sunH.normalize();
          let maxEl = -1;
          for (let dd = 400; dd <= 6000; dd += 700) {
            s.copy(_dir).addScaledVector(sunH, dd / this.R).normalize();
            const el = (this.height(s, 64) - h) / dd;
            if (el > maxEl) maxEl = el;
          }
          score -= Math.max(0, maxEl - 0.05) * this.hAmp * 30.0;
        }
      }
      if (score > bestScore) { bestScore = score; best = _dir.clone(); }
    }
    return best || new THREE.Vector3(1, 0, 0);
  }

  dispose() {
    this.lod.dispose();
    if (this.waterLod) this.waterLod.dispose();
    this.liquidMat?.dispose();
    this.waterUnderlayMaterial?.dispose();
    if (this.cloudShadowTex) this.cloudShadowTex.dispose();
    if (this.cloudWeatherHiTex) this.cloudWeatherHiTex.dispose();
    if (this.cloudShadowTex2) this.cloudShadowTex2.dispose();
    if (this.flora) {
      for (const k in this.flora) if (this.flora[k] && this.flora[k].dispose) this.flora[k].dispose();
      this.flora = null;
    }
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        if (o.material.alphaMap) o.material.alphaMap.dispose();
        if (o.material.userData.weatherSystemTexture) o.material.userData.weatherSystemTexture.dispose();
        // The WebGPU local cloud shell is a process-wide material shared by all
        // planets. Disposing one cancelled preview must not invalidate the live
        // system's warmed RenderObject/pipeline.
        if (!o.material.userData.sharedLocalVolume) o.material.dispose();
      }
    });
    this.terrainMaterial.dispose();
  }
}

const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _mp = new THREE.Vector3();
const _msp = new THREE.Vector3();
const _msd = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

function analyticMediaEclipseVisibility(localPosition, sunDirection, nodes) {
  const normalizedSun = sunDirection.normalize();
  const toOccluder = nodes.uEclipseCenter.sub(localPosition);
  const along = dot(toOccluder, normalizedSun).max(0);
  const perpendicular = sqrt(dot(toOccluder, toOccluder)
    .sub(along.mul(along)).max(0));
  const penumbra = along.mul(nodes.uEclipseStarAngle).max(0.5);
  const visibility = nodeSmoothstep(nodes.uEclipseRadius.sub(penumbra),
    nodes.uEclipseRadius.add(penumbra), perpendicular);
  const inFront = dot(toOccluder, normalizedSun).greaterThan(0);
  return mix(float(1), inFront.select(visibility, float(1)),
    nodes.uEclipseEnabled.clamp(0, 1));
}

function makeAtmosphereMaterial(planet, color, density, groundR, atmoR) {
  if (!USE_NODE_MATERIALS) {
    return makeAtmosphereMaterialWebGL(color, density, groundR, atmoR);
  }
  const nodes = {
    atmoColor: uniform(color), density: uniform(density),
    uStellarDirections0: uniform(new THREE.Vector3(0, 1, 0)),
    uStellarRadiance0: uniform(new THREE.Color(1, 0.98, 0.94)),
    uStarIrradiance0: uniform(1),
    uStellarDirections1: uniform(new THREE.Vector3(0, -1, 0)),
    uStellarRadiance1: uniform(new THREE.Color(1, 0.98, 0.94)),
    uStarIrradiance1: uniform(0),
    uEclipseCenter: uniform(new THREE.Vector3()),
    uEclipseRadius: uniform(1),
    uEclipseStarAngle: uniform(0),
    uEclipseEnabled: uniform(0),
    uCameraLocal: uniform(new THREE.Vector3()),
    uGroundR: uniform(groundR), uAtmoR: uniform(atmoR),
    uMaxSteps: uniform(20),
    tSceneDepth: texture(new THREE.Texture()), uDepthReady: uniform(0),
    uDepthReversed: uniform(0), uCameraNear: uniform(0.12), uCameraFar: uniform(1.2e11),
    uVolumeSize: uniform(new THREE.Vector2(1, 1)),
  };
  planet.atmoUniforms = nodes;
  if (sharedLocalAtmosphereMaterial) {
    planet.syncAtmoMaterial = () => {
      const shared = sharedLocalAtmosphereMaterial.uniforms;
      for (const [name, sourceNode] of Object.entries(nodes)) {
        if (shared[name] && sourceNode && 'value' in sourceNode) {
          shared[name].value = sourceNode.value;
        }
      }
    };
    return sharedLocalAtmosphereMaterial;
  }
  // Meter-scaled TSL participating medium. The gameplay atmosphere keeps its
  // broad entry envelope, while optical density falls on physical scale
  // heights so the visible limb does not inflate a 900 km planet.
  const atmosphere = Fn(() => {
    const origin = nodes.uCameraLocal;
    const ray = positionLocal.sub(origin).normalize();
    const bOuter = dot(origin, ray);
    const discOuter = bOuter.mul(bOuter).sub(dot(origin, origin)).add(nodes.uAtmoR.mul(nodes.uAtmoR));
    const outerRoot = sqrt(discOuter.max(0));
    const t0 = bOuter.negate().sub(outerRoot).max(0).toVar();
    const t1 = bOuter.negate().add(outerRoot).toVar();

    const bGround = dot(origin, ray);
    const discGround = bGround.mul(bGround).sub(dot(origin, origin)).add(nodes.uGroundR.mul(nodes.uGroundR));
    const groundNear = bGround.negate().sub(sqrt(discGround.max(0)));
    const clipsGround = discGround.greaterThan(0).and(groundNear.greaterThan(t0));
    t1.assign(clipsGround.select(groundNear.min(t1), t1));
    const forwardCos = positionView.normalize().z.negate().max(0.035);
    const sceneDepth = sceneRayLimit(nodes, forwardCos, 0.35);
    t1.assign(sceneDepth.hasOpaqueDepth.select(t1.min(sceneDepth.rayDistance), t1));
    const span = t1.sub(t0).max(0);
    const stepCount = nodes.uMaxSteps.clamp(8, 20).toVar();
    const stepLength = span.div(stepCount);
    const t = t0.add(stepLength.mul(0.5)).toVar();

    const sun1 = nodes.uStellarDirections0.normalize();
    const sun2 = nodes.uStellarDirections1.normalize();
    const mu1 = dot(ray, sun1);
    const mu2 = dot(ray, sun2);
    const rayleighPhase1 = float(0.05968).mul(float(1).add(mu1.mul(mu1)));
    const rayleighPhase2 = float(0.05968).mul(float(1).add(mu2.mul(mu2)));
    const g = float(0.76);
    const miePhase1 = float(0.07958).mul(float(1).sub(g.mul(g)))
      .div(float(1).add(g.mul(g)).sub(g.mul(mu1).mul(2)).max(0.04).pow(1.5));
    const miePhase2 = float(0.07958).mul(float(1).sub(g.mul(g)))
      .div(float(1).add(g.mul(g)).sub(g.mul(mu2).mul(2)).max(0.04).pow(1.5));
    // RGB coefficients are inverse metres (680/550/440 nm), matching the CPU
    // reference model. The previous normalized colours were accidentally
    // multiplied by metre-long ray steps as if they were coefficients; even
    // a clear vertical column then reached alpha≈1 and blacked out the world.
    const rayleighBeta = vec3(5.78e-6, 13.56e-6, 33.10e-6)
      .mul(mix(vec3(1), nodes.atmoColor.max(vec3(0.08)), 0.08));
    const mieScatterBeta = vec3(4.72e-6, 4.00e-6, 3.34e-6);
    const mieExtinctionBeta = vec3(5.20e-6, 4.40e-6, 3.68e-6);
    const integrated = vec3(0).toVar();
    const transmission = vec3(1).toVar();
    Loop(20, ({ i }) => {
      If(i.lessThan(stepCount), () => {
        const samplePosition = origin.add(ray.mul(t));
        const radius = samplePosition.length();
        const altitude = radius.sub(nodes.uGroundR).max(0);
        const height = altitude.div(nodes.uAtmoR.sub(nodes.uGroundR).max(1)).clamp(0, 1);
        const rhoR = exp(altitude.div(-8000)).mul(nodes.density);
        const rhoM = exp(altitude.div(-1200)).mul(nodes.density).mul(0.85);
        const radial = samplePosition.div(radius.max(1));
        const sunMu1 = dot(radial, sun1);
        const sunMu2 = dot(radial, sun2);
        const horizon1 = nodeSmoothstep(-0.11, 0.035, sunMu1);
        const horizon2 = nodeSmoothstep(-0.11, 0.035, sunMu2);
        const eclipseVisibility = analyticMediaEclipseVisibility(
          samplePosition, sun1, nodes);
        // Near the horizon the optical air mass rises far faster than 1/cos
        // with the former +0.28 clamp. This bounded Kasten-like approximation
        // reaches ~18 air masses at zero elevation, naturally removing blue
        // light and producing the red/orange golden-hour band.
        const slant1 = float(1).div(sunMu1.add(0.055).max(0.028));
        const slant2 = float(1).div(sunMu2.add(0.055).max(0.028));
        const optical = rayleighBeta.mul(rhoR).add(mieExtinctionBeta.mul(rhoM));
        const sunOptical = rayleighBeta.mul(rhoR).mul(8000)
          .add(mieExtinctionBeta.mul(rhoM).mul(1200));
        const sunTransmission1 = exp(sunOptical.mul(slant1).negate()).mul(horizon1);
        const sunTransmission2 = exp(sunOptical.mul(slant2).negate()).mul(horizon2);
        const scatter1 = rayleighBeta.mul(rhoR).mul(rayleighPhase1)
          .add(mieScatterBeta.mul(rhoM).mul(miePhase1))
          .mul(sunTransmission1).mul(nodes.uStellarRadiance0)
          .mul(nodes.uStarIrradiance0).mul(eclipseVisibility);
        const scatter2 = rayleighBeta.mul(rhoR).mul(rayleighPhase2)
          .add(mieScatterBeta.mul(rhoM).mul(miePhase2))
          .mul(sunTransmission2).mul(nodes.uStellarRadiance1).mul(nodes.uStarIrradiance1);
        const multiScatter = nodes.uStellarRadiance0.mul(nodes.uStarIrradiance0)
          .mul(horizon1).mul(eclipseVisibility)
          .add(nodes.uStellarRadiance1.mul(nodes.uStarIrradiance1).mul(horizon2))
          .mul(rayleighBeta).mul(rhoR).mul(float(1).sub(height)).mul(0.08);
        const stepOptical = optical.mul(stepLength);
        const alphaStep = vec3(1).sub(exp(stepOptical.negate()));
        integrated.addAssign(scatter1.add(scatter2).add(multiScatter)
          .mul(transmission).mul(stepLength).mul(2.4));
        transmission.mulAssign(vec3(1).sub(alphaStep));
        t.addAssign(stepLength);
      });
    });
    const valid = discOuter.greaterThan(0).and(t1.greaterThan(t0));
    const meanTransmission = dot(transmission, vec3(0.333333));
    const alpha = valid.select(float(1).sub(meanTransmission).clamp(0, 0.985), float(0));
    return vec4(integrated, alpha);
  })();
  const material = new MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
  });
  // The integration accumulator is premultiplied.  NodeMaterial's
  // premultiplied-alpha output stage performs the actual multiplication, so
  // feed it straight RGB to avoid the WebGPU-only alpha-squared haze loss.
  material.colorNode = atmosphere.rgb.div(atmosphere.a.max(0.0001));
  material.opacityNode = atmosphere.a;
  material.uniforms = nodes;
  material.userData.sharedLocalVolume = true;
  sharedLocalAtmosphereMaterial = material;
  planet.syncAtmoMaterial = () => {};
  return material;
}

function coverageCutoff(values, targetCoverage) {
  const bins = new Uint32Array(512);
  for (let index = 0; index < values.length; index++) {
    const bin = Math.min(bins.length - 1,
      Math.max(0, Math.floor(values[index] * (bins.length - 1))));
    bins[bin]++;
  }
  const targetCount = Math.round(values.length * clamp(targetCoverage, 0, 1));
  let accumulated = 0;
  for (let bin = bins.length - 1; bin >= 0; bin--) {
    accumulated += bins[bin];
    if (accumulated >= targetCount) return bin / (bins.length - 1);
  }
  return 1;
}

function cloudAtlasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function makeCloudTextures(simplex, coverage, offsets = [0, 0, 0],
  weatherField = null) {
  // 512×256 preserves the authored 20–60 km weather structures while cutting
  // the synchronous route-time atlas bake to one quarter of the samples. The
  // volume shader adds its own fine 3D erosion; a 1024-wide CPU atlas spent
  // millions of noise evaluations on detail that was sub-pixel from orbit.
  const W = 512, H = 256;
  const lowCanvas = (typeof document !== 'undefined')
    ? document.createElement('canvas') : null;
  if (!lowCanvas) return { low: null, high: null, stats: null };
  const highCanvas = document.createElement('canvas');
  lowCanvas.width = highCanvas.width = W;
  lowCanvas.height = highCanvas.height = H;
  const lowContext = lowCanvas.getContext('2d');
  const highContext = highCanvas.getContext('2d');
  const lowImage = lowContext.createImageData(W, H);
  const highImage = highContext.createImageData(W, H);
  const lowData = lowImage.data;
  const highData = highImage.data;
  const lowRaw = new Float32Array(W * H);
  const highRaw = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const phi = (j / H - 0.5) * Math.PI;
    const cy = Math.sin(phi), cr = Math.cos(phi);
    for (let i = 0; i < W; i++) {
      const th = (i / W) * Math.PI * 2;
      const cx = Math.cos(th) * cr, cz = Math.sin(th) * cr;
      // The exact same deterministic weather function drives CPU transit fog
      // and GPU rendering. Fine seeded noise only erodes the shared density;
      // it never creates an independent camera-facing cloud pattern.
      const dir = { x: cx, y: cy, z: cz };
      const legacyDensity = cloudDensityCPU(dir,
        0.55 - coverage * 0.24, 0.86 - coverage * 0.14,
        offsets[0], offsets[1], offsets[2]);
      const macroErosion = simplex.fbm(
        cx + 5, cy + 5, cz - 5, 11, 4, 0.54, 2.2, 38,
      ) * 0.5 + 0.5;
      const cloudletErosion = simplex.fbm(
        cx - 13, cy + 19, cz + 7, 118, 4, 0.5, 2.13, 17,
      ) * 0.5 + 0.5;
      // Two seeded bands resolve roughly 20–60 km cloudlets inside
      // hundred-kilometre systems. They are baked once for both Lo and Hi,
      // avoiding the former duplicate million-sample weather evaluation at
      // startup.
      const erosion = macroErosion * 0.38 + cloudletErosion * 0.62;
      const weather = weatherField ? sampleWeatherField(weatherField, dir, 0) : null;
      const weatherCoverage = weather?.coverage || 0;
      const stratusMask = weather?.stratusMask || 0;
      const brokenForm = 0.04 + smoothstep(0.24, 0.76, erosion) * 0.96;
      const sheetForm = 0.28 + macroErosion * 0.5 + cloudletErosion * 0.22;
      const weatherForm = brokenForm
        + (sheetForm - brokenForm) * stratusMask * 0.82;
      const index = j * W + i;
      const lowDensity = weatherField
        ? weatherCoverage * weatherForm
          * (0.86 + (weather?.cloudType || 0) * 0.14)
        : legacyDensity;
      lowRaw[index] = clamp(lowDensity, 0, 1);
      const cirrusErosion = simplex.fbm(
        cx * 3.4 + 17, cy * 0.7 - 11, cz * 3.4 + 3,
        5.1, 3, 0.56, 2.1, 29,
      ) * 0.5 + 0.5;
      highRaw[index] = clamp((weather?.highMask || 0)
        * (0.08 + cirrusErosion * 0.82)
        * (0.7 + (weather?.highType || 0) * 0.3), 0, 1);
      const k = index * 4;
      lowData[k + 1] = ((weather?.cloudType || 0) * 255) | 0;
      lowData[k + 2] = ((weather?.stratusMask || 0) * 255) | 0;
      lowData[k + 3] = ((weather?.humidity ?? lowDensity) * 255) | 0;
      highData[k + 1] = ((weather?.highType || 0) * 255) | 0;
      highData[k + 2] = ((weather?.convective || weather?.precipitation || 0) * 255) | 0;
      highData[k + 3] = ((weather?.multipleScatter ?? lowDensity) * 255) | 0;
    }
  }
  // The astronomy dossier's coverage is an areal contract. Calibrate the
  // occupancy threshold to that contract instead of multiplying coverage by
  // erosion and then thresholding it a second time in the shader. The latter
  // made the 42% home-world deck render as scattered sub-10% white stains.
  const fixtureCoverage = Number(weatherField?.fixture?.coverage);
  const requestedCoverage = Number.isFinite(fixtureCoverage)
    ? fixtureCoverage : coverage;
  const lowTarget = clamp(requestedCoverage * 0.9, 0.015, 0.84);
  const highTarget = clamp(requestedCoverage * 0.34, 0.008, 0.36);
  const lowCutoff = coverageCutoff(lowRaw, lowTarget);
  const highCutoff = coverageCutoff(highRaw, highTarget);
  let lowOccupied = 0;
  let highOccupied = 0;
  let lowMean = 0;
  let highMean = 0;
  for (let index = 0; index < lowRaw.length; index++) {
    const lowFloor = Math.max(0, lowCutoff - 0.075);
    const highFloor = Math.max(0, highCutoff - 0.055);
    // Coverage and condensate depth are separate quantities. A broad
    // smoothstep made most occupied systems saturate at 1, turning fronts
    // into featureless white shields. The support mask still honors the
    // authored areal coverage, while relief retains the unsaturated density
    // range required for cloud-top lighting and self-shadow.
    const lowSupport = smoothstep(
      lowFloor, Math.min(1, lowCutoff + 0.018), lowRaw[index]);
    const lowRelief = clamp(
      (lowRaw[index] - lowFloor) / Math.max(1e-5, 1 - lowFloor), 0, 1);
    const lowValue = lowSupport
      * (0.2 + 0.8 * Math.pow(lowRelief, 0.72));
    const highSupport = smoothstep(
      highFloor, Math.min(1, highCutoff + 0.012), highRaw[index]);
    const highRelief = clamp(
      (highRaw[index] - highFloor) / Math.max(1e-5, 1 - highFloor), 0, 1);
    const highValue = highSupport
      * (0.12 + 0.88 * Math.pow(highRelief, 0.82));
    lowData[index * 4] = Math.round(lowValue * 255);
    highData[index * 4] = Math.round(highValue * 255);
    lowMean += lowValue;
    highMean += highValue;
    if (lowValue >= 0.125) lowOccupied++;
    if (highValue >= 0.08) highOccupied++;
  }
  lowContext.putImageData(lowImage, 0, 0);
  highContext.putImageData(highImage, 0, 0);
  // A sub-pixel blur only removes atlas stair-steps. It must not erase the
  // 20–60 km cloudlets that establish scale in orbital photography.
  for (const [context, canvas] of [
    [lowContext, lowCanvas], [highContext, highCanvas],
  ]) {
    context.filter = 'blur(0.45px)';
    context.drawImage(canvas, 0, 0);
    context.filter = 'none';
  }
  const count = lowRaw.length;
  const stats = Object.freeze({
    requested: coverage,
    fixtureRequested: Number.isFinite(fixtureCoverage) ? fixtureCoverage : null,
    lowTarget,
    highTarget,
    lowOccupied: lowOccupied / count,
    highOccupied: highOccupied / count,
    lowMean: lowMean / count,
    highMean: highMean / count,
    lowCutoff,
    highCutoff,
  });
  const low = cloudAtlasTexture(lowCanvas);
  const high = cloudAtlasTexture(highCanvas);
  low.userData.coverageStats = stats;
  high.userData.coverageStats = stats;
  return { low, high, stats };
}

function makeRingTexture(rand, tint) {
  if (typeof document === 'undefined') return null;
  const W = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, 1);
  const d = img.data;
  const r = tint.r * 255, g = tint.g * 255, b = tint.b * 255;
  let a = 0;
  for (let i = 0; i < W; i++) {
    if (i % 8 === 0) a = rand() * rand();
    const edge = smoothstep(0, 0.08, i / W) * (1 - smoothstep(0.85, 1, i / W));
    d[i * 4] = lerp(200, r, 0.5);
    d[i * 4 + 1] = lerp(190, g, 0.5);
    d[i * 4 + 2] = lerp(180, b, 0.5);
    d[i * 4 + 3] = a * edge * 200;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(canvas);
}
