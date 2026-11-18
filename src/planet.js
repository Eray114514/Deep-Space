import { bindStellarOcclusion } from './stellar-occlusion.js';
// Planet: a fully procedural world defined by ONE seeded height function and
// ONE color function over unit-sphere directions. Terrain chunks at every LOD,
// the walking controller, the landing logic and the scatter system all sample
// these same functions — which is what keeps a planet consistent whether it is
// a dot across the system or the ground under your feet.

import * as THREE from 'three';
import { makeRng, strHash32 } from './rng.js';
import { createOceanClimate, sampleOceanClimate, placeOceanTidalEvent } from './ocean-climate.js';
import { oceanSeconds } from './ocean-clock.js';
import { createOceanSurface, sampleOceanSurface } from './ocean-surface.js';
import { clamp, frequencyBlend, lerp, smoothstep } from './noise.js';
import { TerrainSimplex } from './terrain-noise.js';
import { TerrainHeightField } from './terrain-height-field.js';
import { buildCoastalDrainage } from './coastal-drainage.js';
import { ChunkedLOD, GRID_CELLS } from './quadtree.js';
import { NearWaterPatch } from './near-water-patch.js';
import {
  applyTerrainDetail, applyWaterWaves, applyCloudField,
  cloudBaseDensityCPU, cloudDensityCPU, detailTexture,
} from './shaders.js';
import { makeCloudVolumeMaterial } from './clouds.js';
import { getCloudResourceManager } from './cloud/cloud-resource-manager.js';
import { sampleWeatherAtlas, decodeSynopticCoverage } from './cloud/weather-atlas.js';
import { createPlanetWeatherField } from './cloud/planet-weather.js';
import { PlanetWeatherStream } from './cloud/planet-weather-stream.js';
import { buildProductionBands, CANDIDATE_WIDTH, CANDIDATE_HEIGHT, CANDIDATE_LAYERS } from './cloud/production-bands.js';
import { sampleProductionMedium } from './cloud/production-shape.js';
import { nearProductionCloudGLSL, productionCloudGLSL } from './cloud/production-medium-glsl.js';
import { CLOUD_TROPOSPHERE_TOP_METERS } from './cloud/cloud-species.js';
import { VOLUME_LAYER } from './volumetric-pass.js';
import { WORLD_LAYER } from './render-layers.js';
import { floraPalette } from './flora.js';
import { makeAtmosphereMaterialWebGL } from './atmosphere-webgl.js';
import {
  LCL_MAX_METERS, LCL_MIN_METERS,
  advanceWeatherField, createWeatherField, sampleWeatherField,
  weatherFieldFingerprint,
} from './weather-field.js';

const rendererParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
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

export class Planet extends TerrainHeightField {
  constructor({ seed, name, posUniv, type, isMoon = false, radius = null, atmosphere = null, clouds = null, fadeIn = false, deferRoots = false, sunDir = null, tuning = null, formation = null, ringSystem = null }) {
    super();
    this.appear = fadeIn ? 0 : 1;   // planets born mid-flight fade in, never pop
    this.deferRoots = Boolean(deferRoots);
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
    this.nA = new TerrainSimplex(makeRng(seed + ':A'));
    this.nB = new TerrainSimplex(makeRng(seed + ':B'));
    this.nC = new TerrainSimplex(makeRng(seed + ':C'));
    this.nD = new TerrainSimplex(makeRng(seed + ':D'));
    this.nOceanBasin = this.tuning.oceanProfile
      ? new TerrainSimplex(makeRng(seed + ':ocean-bathymetry:v1'))
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
    this.tidalCoast = this.liquid === 'water';
    this.oceanClimate = ['water', 'toxic'].includes(this.liquid)
      ? createOceanClimate(seed, { type, gravity: this.gravity,
        oceanClass: this.tuning.oceanClass || this.tuning.oceanProfile }) : null;
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

    // ---- generator v2: relief in physical wavelengths ---------------------
    // Own RNG namespace: the v1 draws above are untouched. A wavelength in
    // metres becomes a unit-sphere frequency through the body's radius, so a
    // small moon gets small mountains instead of a scaled-down continent.
    {
      const v2 = makeRng(seed + ':terrain-v2');
      const frequencyOf = (wavelength) => this.R / wavelength;
      const tectonic = this.mountAmp / (this.hAmp * 0.775);
      const roughK = { barren: 1.3, lava: 1.4, exotic: 1.2, ice: 0.6, desert: 0.85 }[type] ?? 1;
      this.landDatum = this.hasLiquid ? this.naturalSeaLevel : -this.contAmp * 0.25;
      this.landRise = 0.07 + v2() * 0.05;
      this.rangeFreq = frequencyOf(clamp(this.R * 0.2, 30000, 260000) * (0.8 + v2() * 0.4));
      this.rangeBias = 0.4 + (v2() - 0.5) * 0.1;
      const ridgeLength = clamp(this.R * 0.03, 5000, 36000) * (0.8 + v2() * 0.4);
      this.ridgeFreq = frequencyOf(ridgeLength);
      this.ridgeAmp = Math.min(this.hAmp * 0.42 * tectonic, ridgeLength * 0.17);
      const hillLength = clamp(this.R * 0.006, 900, 7000) * (0.8 + v2() * 0.4);
      this.hillFreq = frequencyOf(hillLength);
      this.hillAmp = Math.min(this.hAmp * 0.04, hillLength * 0.075);
      const roughLength = clamp(this.R * 0.0004, 120, 420);
      this.roughFreq = frequencyOf(roughLength);
      this.roughAmp = roughLength * 0.065 * roughK;
      this.microFreq = frequencyOf(11);
      this.microAmp = 0.45 * roughK;
    }

    // Wide chunks preserve the exact finest sampling density while replacing
    // each former 2×2 child set with one submission. Collision and gameplay
    // keep the canonical frequency cap; only the renderer's grouping changes.
    const canonicalGridCells = GRID_CELLS;
    this.canonicalGridCells = canonicalGridCells;
    const rootCell = (Math.PI / 2) * this.R / canonicalGridCells;
    // Aim at the authored metre-scale canonical ground spacing, with a level
    // 16 safety ceiling on large worlds (1.2 m on the 1,200 km homeworld,
    // 6 m on an Earth-scale 6,000 km body).
    this.canonicalMaxLevel = clamp(Math.ceil(Math.log2(rootCell / 1.5)), 4, 16);
    this.canonicalFreqAtLevel = (lvl) => 0.4 * canonicalGridCells * Math.pow(2, lvl) / (Math.PI / 2);
    this.fullMaxFreq = this.canonicalFreqAtLevel(this.canonicalMaxLevel);
    if (this.tidalCoast && this.tuning.estuarySite) {
      this.coastalDrainage = buildCoastalDrainage(this, this.tuning.estuarySite);
    }
    // Terrain noise, formation and sea-level inputs are complete before the
    // optional event reads them; placement never consumes the terrain RNG.
    if (this.oceanClimate?.event) this.oceanClimate.event = placeOceanTidalEvent(this.oceanClimate.event, {
      seed, radius: this.seaRadius, gravity: this.gravity,
      depthAt: (direction) => this.seaLevel - this.height(direction, this.fullMaxFreq),
    });
    this.oceanSurface = this.oceanClimate ? createOceanSurface(seed, {
      radius: this.seaRadius, gravity: this.gravity, period: this.oceanClimate.swellPeriod,
      event: this.oceanClimate.event,
      sampleRegion: (direction, hours) => {
        const depth = this.seaLevel - this.height(direction, this.fullMaxFreq);
        const climate = sampleOceanClimate(this.oceanClimate, direction, {
          seconds: hours * 3600, waveSeconds: oceanSeconds(hours), depth: Math.max(0, depth),
          weather: this.weatherAt(direction, hours),
        });
        return { depth, offshoreSignificantHeight: climate.offshoreSignificantHeight };
      },
    }) : null;
    // Grouping reduces draw overhead. Collision/noise retains the canonical
    // content cap while geometry stops once its cells are below the reviewed
    // display footprint; material micro-relief carries the final texture band.
    const lowTierGrouping = canonicalGridCells <= 18;
    // Keep cheap 32×32 roots, then switch high-tier terrain to 64×64 at level
    // three. One wide level replaces the next 2×2 set of narrow chunks at the
    // same final vertex spacing, cutting stable draw submissions by roughly
    // four without making planet construction synchronously build six huge
    // roots. Parent interpolation already supports different grid widths.
    const baseGroupFactor = lowTierGrouping ? 4 : (4 / 3);
    this.gridCells = Math.round(canonicalGridCells * baseGroupFactor);
    this.gridCellsAtLevel = (level) => (!lowTierGrouping && level >= 4
      ? this.gridCells * 2
      : this.gridCells);
    // Terrain chunk boundaries stay on the continuous planet surface. Forcing
    // every child edge down to the parent chord created a low-frequency trench
    // around every square; radial skirts then rendered those trenches as dark
    // dotted walls. Mixed-level ownership is handled by keeping the parent
    // visible until its complete child set is ready and by geomorphing the
    // child surface, not by modifying permanent fine-level boundary vertices.
    this.noSkirt = true;
    this.maxCellPixels = 3.0;
    // Terrain face boundaries are synchronized by the quadtree itself.
    // Radial skirts turn the shared edge into a shaded wall and recreate the
    // black ink line they were meant to conceal.
    this.faceBoundarySkirts = false;
    // Bound rendered geometry by both the canonical sampling cap and a
    // physical vertex-spacing target (~3.6 m high-tier, ~7.2 m low-tier).
    // On the 1,200 km homeworld this stops at level 13 (3.6 m) instead of
    // spending 4x the walk-mode triangles on 1.8 m cells inside PBR texture range.
    const terrainFineRootCell = (Math.PI / 2) * this.R
      / (lowTierGrouping ? this.gridCells : this.gridCells * 2);
    const terrainTargetCell = lowTierGrouping ? 7.2 : 3.6;
    this.maxLevel = Math.max(3, Math.min(
      this.canonicalMaxLevel - (lowTierGrouping ? 3 : 2),
      Math.ceil(Math.log2(terrainFineRootCell / terrainTargetCell)),
    ));
    // Full-disk spawn at 1.72R resolves ~3–9 km per terrain cell across planet
    // scales. Level 3 on the 1,200 km homeworld gives 3.68 km cells (~90 visible
    // chunks vs ~405 at level 4, saving ~10 s of startup chunk generation), while
    // 6,000 km worlds use level 4 (9.2 km) and approach thresholds add levels 4..7
    // continuously below 1.35R.
    const highOrbitCap = clamp(Math.ceil(Math.log2(terrainFineRootCell / 9500)), 3, 4);
    this.orbitLevelCap = Math.min(this.maxLevel, lowTierGrouping ? Math.min(3, highOrbitCap) : highOrbitCap);
    this.orbitApproachLevelThresholds = this.orbitLevelCap <= 3
      ? [1.35, 1.16, 1.06, 1.025]
      : [1.20, 1.08, 1.03];
    this.orbitPrewarmRadiusRatio = 1.75;
    this.freqAtLevel = (lvl) => Math.min(this.fullMaxFreq,
      0.4 * this.gridCellsAtLevel(lvl) * Math.pow(2, lvl) / (Math.PI / 2));
    // Keep the 3.6–9 m centre ladder, while bounding off-axis near-field rings
    // (< ~110 m cells) to the 62-degree flight view. Scaling the mid-altitude
    // cutoff by physical cell size (~110 m: level 8 on 1,200 km, level 10 on
    // 6,000 km) prevents refining hundreds of 64×64 chunks behind the chase camera.
    const lodScreenScale = lowTierGrouping ? 0.25 : 0.38;
    const midAltitudeScreenScale = lowTierGrouping ? lodScreenScale : 0.62;
    const midAltitudeMaxLevel = Math.max(3, Math.floor(Math.log2(terrainFineRootCell / 110)));
    this.lodDistanceScale = (canonicalGridCells / this.gridCells) * lodScreenScale;
    this.lodDistanceScaleAtLevel = (lvl) => (canonicalGridCells / this.gridCellsAtLevel(lvl))
      * (lvl <= midAltitudeMaxLevel ? midAltitudeScreenScale : lodScreenScale);
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
    const pushFade = (mat, base = 1) => {
      if (mat) this._fades.push({ mat, base, transparent: Boolean(mat.transparent) });
    };
    this._fades = [];
    pushFade(this.terrainMaterial, 1);
    if (this.liquidMat) pushFade(this.liquidMat, this.liquidMat.opacity);
    if (this.cloudMesh) pushFade(this.cloudMesh.material, this.cloudMesh.material.opacity);
    if (this.cloudMesh2) pushFade(this.cloudMesh2.material, this.cloudMesh2.material.opacity);
    if (this.cloudMeshNoctilucent) {
      pushFade(this.cloudMeshNoctilucent.material, this.cloudMeshNoctilucent.material.opacity);
    }
    if (this.ringMesh) pushFade(this.ringMesh.material, this.ringMesh.material.opacity);
    this._atmoBaseDensity = this.atmoMesh
      ? (this.atmoUniforms || this.atmoMesh.material.uniforms).density.value : 0;
    if (this.appear < 1) this.applyAppear();
  }

  applyAppear() {
    const a = this.appear;
    for (const f of this._fades) {
      f.mat.opacity = f.base * a;
      if (f.mat.userData.opacityNodeUniform) f.mat.userData.opacityNodeUniform.value = f.base * a;
      f.mat.transparent = a < 1 || f.transparent || f.base < 1;
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
      const depth = clamp((this.seaLevel - h) / (this.hAmp * 0.04), 0, 1);
      sampleStops(p.sea, 1 - depth, out);
    } else {
      const tl = this.landT(h);
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

  // Where a land elevation falls on the palette, 0..1. Land is compressed
  // toward the datum (plains a few hundred metres up, peaks a few kilometres),
  // so a straight ramp would paint every lowland with the beach stop. The
  // shader evaluates the same curve through uT0 / uTSpan / uTCurve.
  landT(h) {
    const t0 = this.palU ? this.palU.t0 : (this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85);
    const lin = clamp((h - t0) / (this.hAmp * 1.15 - t0), 0, 1);
    return Math.pow(lin, this.landTCurve);
  }

  // Low-frequency tint masks baked per-vertex (they're smooth, so vertex
  // resolution is fine): x=forest tint, y=blotch, z=stripe phase, w=woodland
  // occupancy on living worlds or ember/crevasse/strata on other worlds.
  extrasAt(dir, h, maxFreq, out) {
    out.set(0, 0, 0, 0);
    const p = this.pal;
    if (this.hasLiquid && h < this.seaLevel && this.liquid !== 'lava') return out;
    const x = dir.x, y = dir.y, z = dir.z;
    const tl = this.landT(h);

    if (p.forest && tl < 0.6) {
      const moist = this.landMoisture(dir, maxFreq);
      out.x = smoothstep(0.05, 0.3, moist) * smoothstep(0.04, 0.1, tl)
        * (1 - smoothstep(0.4, 0.55, tl)) * 0.85;
      if (this.snowWeightAt(dir, h) > 0.28) out.x = 0;
      else if (!this.hasLiquid || h >= this.seaLevel + 1.5) {
        out.w = this.woodlandCover(dir, tl, moist, maxFreq);
      }
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
    this.landTCurve = this.hasLiquid ? 0.5 : 0.75;
    // vivid types can drift far; living worlds keep believable hues
    const hueSpan = (this.type === 'lush' || this.type === 'ocean') ? 0.05 : 0.13;
    const dh = (rand() - 0.5) * hueSpan;
    const ds = 0.82 + rand() * 0.45;
    const dl = 0.88 + rand() * 0.26;
    const J = (hex) => jitterColor(col(hex), rand, dh, ds, dl);

    const p = { slopeLo: 0.08, slopeHi: 0.24, snow: null, snowLine: 1e9, capLat: 0 };
    switch (this.type) {
      case 'lush':
        // remote-sensing greens: olive, sage, moss — never crayon
        p.sea = stops([[0, J('#050f26')], [0.45, J('#0a2f55')], [0.8, J('#175a75')], [1, J('#4e8f83')]]);
        p.land = stops([[0, J('#b3a478')], [0.06, J('#8f9459')], [0.22, J('#5f7a42')], [0.45, J('#4a5f38')],
                        [0.62, J('#6b6a48')], [0.78, J('#77695a')], [1, J('#877e6f')]]);
        p.forest = J('#2e4527'); p.rock = J('#6b6156');
        p.snow = J('#dce5ed'); p.snowLine = this.hAmp * (0.68 + rand() * 0.14) * 0.5; p.capLat = 0.86;
        break;
      case 'ocean':
        p.sea = stops([[0, J('#041124')], [0.5, J('#082c52')], [0.82, J('#135273')], [1, J('#3f8f88')]]);
        p.land = stops([[0, J('#c2b183')], [0.12, J('#a29a62')], [0.3, J('#657e49')], [0.6, J('#4c5f3d')], [1, J('#6c6b56')]]);
        p.forest = J('#2f4a2c'); p.rock = J('#6f685c');
        p.snow = J('#d9e4ed'); p.snowLine = this.hAmp * 0.76 * 0.5; p.capLat = 0.82;
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
        p.slopeLo = 0.16; p.slopeHi = 0.4;
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
    // [2026-11-15] Vegetated land was authored as display colours and shaded
    // as albedo: the home world's land averaged (0.18, 0.23, 0.07), the
    // brightness of a dry savanna. Under the same sun as the clouds that left
    // a 2:1 cloud-to-ground contrast and a milky globe from orbit (Earth is
    // nearer 6:1). Living land keeps its hues at a plant albedo; the beach
    // stop and bare rock stay as authored.
    if (this.type === 'lush' || this.type === 'ocean') {
      for (let i = 1; i < p.land.length; i++) p.land[i].c.multiplyScalar(0.68);
      p.forest.multiplyScalar(0.72);
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
      tCurve: this.landTCurve,
      // shelves are a few hundred metres deep; the open ocean is all "deep"
      seaDepthSpan: this.hAmp * 0.04,
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

  landMoisture(dir, maxFreq = 64) {
    return this.nC.fbm(dir.x + 11.3, dir.y - 4.1, dir.z + 7.7, 2.4, 3, 0.5, 2.15, maxFreq);
  }

  woodlandCover(dir, landT, moisture, maxFreq) {
    const margin = Math.min((landT - 0.05) / 0.03, (0.45 - landT) / 0.045, (moisture - 0.14) / 0.075);
    const broad = this.R / 640, fine = this.R / 155;
    const broadWeight = frequencyBlend(broad, maxFreq), fineWeight = frequencyBlend(fine, maxFreq);
    const patch = (broadWeight ? this.nD.noise(dir.x * broad + 17, dir.y * broad, dir.z * broad) * broadWeight * 0.72 : 0)
      + (fineWeight ? this.nC.noise(dir.z * fine, dir.x * fine - 29, dir.y * fine) * fineWeight * 0.28 : 0);
    const forest = smoothstep(-1.05, 1.0, margin + patch * 2.2);
    const pocket = smoothstep(-0.04, 0.52, patch);
    const meadow = (0.008 + 0.70 * pocket * pocket) * smoothstep(-0.42, 0.06, moisture);
    const cover = lerp(meadow, 0.77 + 0.23 * pocket, forest);
    return cover * (1 - smoothstep(0.46, 0.60, landT));
  }

  biomeAt(dir, h, sampledMoisture) {
    if ((this.type === 'lush' || this.type === 'ocean') && this.snowWeightAt(dir, h) > 0.28) return 'snow';
    if (this.hasLiquid && h < this.seaLevel + 1.5) return 'shore';
    switch (this.type) {
      case 'lush': case 'ocean': {
        const tl = this.landT(h);
        if (tl > 0.6) return 'rock';                 // olive-brown high country: bare
        const moist = sampledMoisture ?? this.landMoisture(dir);
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
          color: this.liquidColor, transparent: true, opacity: 1,
          roughness: 0.21, metalness: 0.0, side: THREE.DoubleSide, depthWrite: true,
          // The water shader owns colour, reflection and depth-dependent
          // optical coverage. Engine transmission is deliberately disabled:
          // Three's extra opaque-scene pass erased the surface and introduced
          // stable screen-space seams when rendered below viewport scale.
          transmission: 0, ior: 1.333, thickness: 1.0,
          attenuationDistance: 18.0,
          attenuationColor: this.liquidColor.clone().lerp(new THREE.Color(1, 1, 1), 0.42),
        });
        // Transparent DoubleSide materials default to a front/back two-pass
        // path. The closed water shell is depth-writing and has an explicit
        // dry mask, so one double-sided pass is both correct and half the
        // submissions; it also keeps underwater views available.
        mat.forceSinglePass = true;
        mat.polygonOffset = false;
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
      // Wide 64-cell water chunks replace each former 2x2 32-cell child set at
      // identical vertex spacing. The near camera used to expose almost 1,900
      // visible water chunks (and >1,200 draw calls) even though its spectral
      // micro-waves are shader-driven; grouping restores the same silhouette
      // and bathymetry sampling at roughly one quarter of the submissions.
      const waterCanonicalGrid = 16;
      const lowTierGrouping = this.canonicalGridCells <= 18;
      const waterGroupFactor = 4;
      const waterGridCells = waterCanonicalGrid * waterGroupFactor;
      const waterGridCellsAtLevel = () => waterGridCells;
      // Calibrate the global ocean shell by physical cell spacing (~80–155 m)
      // rather than a fixed level integer so every planet radius (1,200 km
      // homeworld -> level 8 / 115 m, 560 km ocean world -> level 7 / 107 m,
      // 6,000 km -> level 10 / 144 m) hands off cleanly to NearWaterPatch's
      // ~88 m outer graded ring without subdividing discarded inner chunks.
      const waterRootCell = (Math.PI / 2) * this.R / waterGridCells;
      const waterMaxLevel = clamp(Math.ceil(Math.log2(waterRootCell / 155)), 2, 10);
      const waterCanonicalMaxLevel = waterMaxLevel + 1;
      const waterScreenScale = lowTierGrouping ? 0.2 : 0.25;
      const waterMidAltitudeScreenScale = lowTierGrouping ? waterScreenScale : 0.42;
      this.waterLod = new ChunkedLOD({
        // At ~110 m cells the spherical chord sag is a few millimetres.
        // A 2.5 m skirt was vastly larger than the gap and exposed dark walls
        // whenever the water was translucent. Dense adjacent shells therefore
        // meet directly; the coast overlap handles the independent land edge.
        R: this.seaRadius, hAmp: (this.oceanClimate?.event?.height || 0) + 2,
        noMorph: false, noSkirt: true,
        faceBoundarySkirts: false,
        noShadow: true,
        deferRoots: this.deferRoots,
        // Terrain collision and silhouette detail must reach the player first
        // after a teleport/landing. The local patch already supplies nearby
        // water geometry, so far-water shell jobs may safely yield to terrain
        // whenever both queues contend for the same frame budget.
        buildPriority: 24,
        maxCellPixels: 3.35,
        gridCells: waterGridCells,
        gridCellsAtLevel: waterGridCellsAtLevel,
        maxLevel: waterMaxLevel,
        orbitLevelCap: clamp(Math.ceil(Math.log2(waterRootCell / 12000)), 2, 3),
        orbitPrewarmRadiusRatio: 1.75,
        // A smooth water sphere does not need terrain's two extra
        // approach levels. Add curvature detail only as its kilometre-scale
        // cells become resolvable, while spectral waves remain shader-driven.
        orbitApproachLevelThresholds: [1.12, 1.06, 1.025],
        lodDistanceScale: (waterCanonicalGrid / waterGridCells) * waterScreenScale,
        lodDistanceScaleAtLevel: (lvl) => (waterCanonicalGrid / waterGridCellsAtLevel(lvl))
          * (lvl < waterMaxLevel ? waterMidAltitudeScreenScale : waterScreenScale),
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
          // Preserve signed bathymetry. Clamping dry vertices to zero made a
          // triangle with one wet corner interpolate positive water across
          // most of the beach; the fragment shader now cuts the exact zero
          // contour and the opaque terrain owns every inland sample.
          ? (dir) => this.seaLevel - this.height(dir, this.fullMaxFreq)
          : null,
        group: this.group,
        terrainMaterial: mat,
        underlayMaterial: this.waterUnderlayMaterial,
      });
      if (this.liquid === 'water' || this.liquid === 'toxic') {
        this.nearWaterPatch = new NearWaterPatch(this, mat);
      }
    }

    if (this.atmoDensity > 0.05) {
      // Authored atmosphere height remains the gameplay/weather envelope. The
      // physical atmosphere pass derives an independent optical top and scale
      // heights, so this value must never stretch molecular density.
      const authoredAtmoHeight = Number(this.tuning.atmosphereHeightMeters);
      const atmoHeight = Number.isFinite(authoredAtmoHeight)
        ? clamp(authoredAtmoHeight, 30000, 1000000)
        : Math.max(this.hAmp * 3.2, R * this.atmoFraction);
      const atmoR = R + atmoHeight;
      this.atmoMesh = new THREE.Mesh(
        new THREE.SphereGeometry(atmoR, 96, 64),
        makeAtmosphereMaterial(this, this.atmoColor, this.atmoDensity, R, atmoR),
      );
      // This mesh is the thin fallback limb for distant bodies and portal
      // views. The active planet is hidden by the full-resolution physical
      // atmosphere pass before clouds composite independently.
      this.atmoMesh.renderOrder = 1;
      // Distant-body atmosphere belongs to the world pass so ordinary depth
      // naturally occludes it.
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
          : this.tuning.weatherStyle === 'temperate-synoptic' ? 0.58
          : this.type === 'toxic' ? 0.72 : 0.4,
        highClouds: this.tuning.weatherStyle === 'temperate-synoptic'
          ? 0.64 : coverage > 0.45 ? 0.48 : 0.2,
        fogginess: this.tuning.weatherStyle === 'temperate-synoptic'
          ? 0.22 : this.hasLiquid ? 0.34 : 0.16,
        windSpeed: 8 + (this.waterStyle?.swell || 0.6) * 13,
        weatherSpeed: 6,
        temperatureK: this.type === 'ice' ? 258 : this.type === 'lava' ? 430 : 286,
      };
      this.weatherField = createPlanetWeatherField(this, {
        profile: this.weatherProfile,
        fixture: DEV_WEATHER_FIXTURE || undefined,
      });
      // Low/high weather plus a stationary, regionally smoothed surface
      // altitude share the existing two atlas allocations.
      // The new atlas carries synoptic structure, not metre-scale density.
      // Keep its content resolution fixed across rendering quality tiers.
      // Small moons and <400 km outer bodies resolve 3–12 km per texel at 128×64
      // (finer than 256×128 on the 1,200 km homeworld) at 1/4 the startup CPU cost.
      this.cloudAtlasWidth = this.weatherField.synoptic
        ? (R < 400000 && !volumetricCloudsEnabled ? 128 : 256)
        : clamp(2 ** Math.ceil(Math.log2(
          Math.max(1, (Math.PI * 2 * R) / 8000),
        )), 256, 512);
      const weatherAtlases = makeCloudTextures(
        this.nD, coverage, o1, this.weatherField, this.cloudAtlasWidth, volumetricCloudsEnabled);
      this.cloudShadowTex = weatherAtlases.low;
      this.cloudWeatherHiTex = weatherAtlases.high;
      this.cloudSpeciesTex = weatherAtlases.bands;
      this.cloudBoundsTex = weatherAtlases.bounds;
      this.cloudCandidatesTex = weatherAtlases.candidates;
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
      // cloudLayer is a compatibility/gameplay envelope, not render geometry.
      // The optical volume keeps the mature weather field but receives its
      // own layer: high enough to clear relief, deep enough for orbit-scale
      // towers, and far below the old 230–420 km second-planet shell.
      const authoredRenderLayer = this.tuning.cloudRenderLayer || null;
      const naturalCloudBaseAlt = clamp(this.hAmp * 1.12 + 1400, 12000, 22000);
      const cloudShellBaseAlt = this.weatherField.synoptic
        ? Math.min(250, this.weatherField.surfaceBoundsMeters[0])
        : Number.isFinite(authoredRenderLayer?.minAltitudeMeters)
        ? clamp(authoredRenderLayer.minAltitudeMeters, 8000, 30000)
        : naturalCloudBaseAlt;
      const cloudR = R + cloudShellBaseAlt;
      // Cloud thickness must stay subordinate to the planet. A fixed
      // 50--88 km shell looked plausible on the 6,000 km homeworld but became
      // 9--16% of a 560 km pelagic body, making its limb read like a fuzzy toy
      // globe. Keep storm systems deep, then cap that depth by body scale.
      const weatherCloudDepth = clamp(
        26000 + this.weatherProfile.storminess * 18000
          + this.weatherProfile.highClouds * 8000
          + (this.type === 'toxic' ? 6000 : 0)
          - (this.type === 'ice' ? 4000 : 0),
        22000,
        56000,
      );
      const naturalCloudDepth = Math.min(
        weatherCloudDepth,
        Math.max(6000, R * 0.035),
      );
      const authoredCloudTop = Number(authoredRenderLayer?.maxAltitudeMeters);
      const cloudShellTopAlt = this.weatherField.synoptic
        ? Math.max(CLOUD_TROPOSPHERE_TOP_METERS,
          this.weatherField.surfaceBoundsMeters[1] + CLOUD_TROPOSPHERE_TOP_METERS)
        : Number.isFinite(authoredCloudTop)
        ? clamp(authoredCloudTop, cloudShellBaseAlt + 45000, 105000)
        : cloudShellBaseAlt + naturalCloudDepth;
      const thick = cloudShellTopAlt - cloudShellBaseAlt;
      this.cloudRenderLayer = {
        minAltitudeMeters: cloudShellBaseAlt,
        maxAltitudeMeters: cloudShellTopAlt,
      };
      const cmat = new THREE.MeshBasicMaterial({
        color: this.type === 'toxic' ? 0xc8e890 : 0xffffff,
        transparent: true, depthWrite: false, opacity: 0.88,
        // The analytic deck is the low-GPU fallback both from orbit and from
        // beneath the cloud base. FrontSide alone disappears for a surface
        // camera because it is looking at the inside of the sphere.
        side: THREE.DoubleSide,
      });
      cmat.forceSinglePass = true;
      // The analytic deck is a distant/fallback silhouette, not the whole
      // vertical volume extruded at every vertex. Using ~100% of the layer
      // depth made an 80 km weather band become 80 km triangular spikes on
      // smaller ocean worlds. Keep readable towers while bounding their
      // apparent relief to a planetary-scale cloud fraction.
      const analyticRelief = Math.min(thick * 0.18, R * 0.006);
      const cloudMat = applyCloudField(cmat, coverage, o1[0], o1[1], o1[2],
        analyticRelief, this.cloudShadowTex, this.weatherField.synoptic ? {
          surfaceAtlas: this.cloudWeatherHiTex,
          surfaceRange: this.weatherField.surfaceRangeMeters,
          baseAltitude: cloudShellBaseAlt,
        } : null);
      this.cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(cloudR, 256, 160), cloudMat);
      this.cloudMesh.renderOrder = 2;
      this.group.add(this.cloudMesh);
      this.cloudBands.push({
        r: cloudR, mesh: this.cloudMesh, opacity: 0.88,
        halfThickness: thick * 0.5,
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
          localWeather: !!this.weatherField.synoptic,
          cov0: 0.55 - coverage * 0.24, cov1: 0.86 - coverage * 0.14,
          ox: o1[0], oy: o1[1], oz: o1[2],
          tint: this.type === 'toxic' ? 0xc8e890 : 0xffffff,
        };
        this.volCloudMat = makeCloudVolumeMaterial(
          this, band, detailTexture(), this.cloudShadowTex,
          this.cloudWeatherHiTex,
          {...volumetricCloudProfile,nearEmptyRuns:true});
        this.volCloudUniforms ||= this.volCloudMat.uniforms;
        this.volCloudBand ||= band;
        this.volCloudFarMat=this.volCloudMat.clone();
        this.volCloudFarMat.fragmentShader=this.volCloudMat.fragmentShader.replace(nearProductionCloudGLSL,productionCloudGLSL);
        this.volCloudFarMat.defines.CLOUD_FAR_VIEW=1;
        this.volCloudFarMat.uniforms=this.volCloudMat.uniforms;
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
          o2[0], o2[1], o2[2], Math.min(thick * 0.08, R * 0.003),
          this.cloudWeatherHiTex, this.weatherField.synoptic ? {
            surfaceAtlas: this.cloudWeatherHiTex,
            surfaceRange: this.weatherField.surfaceRangeMeters,
            baseAltitude: cloudShellBaseAlt + thick * 0.38,
            high: true,
          } : null);
        const upperR = cloudR + thick * 0.38;
        this.cloudMesh2 = new THREE.Mesh(
          new THREE.SphereGeometry(upperR, 192, 128), upperCloudMat);
        this.cloudMesh2.renderOrder = 2;
        this.group.add(this.cloudMesh2);
        this.cloudSpin2 = o2[3];
        this.cloudBands.push({
          r: upperR, mesh: this.cloudMesh2, opacity: 0.28,
          halfThickness: Math.max(1400, thick * 0.18),
          thickness: thick * 0.32,
          cov0: 0.55 - coverage * 0.42 * 0.24, cov1: 0.86 - coverage * 0.42 * 0.14,
          ox: o2[0], oy: o2[1], oz: o2[2],
        });
      }
      // WebGL currently has no noctilucent density-field shader. The previous
      // identity fallback rendered the source material unchanged, turning this
      // feature into a complete translucent blue DoubleSide sphere: literally
      // the shield shell seen around every cloudy planet. Keep the mesospheric
      // species in weather data, but do not instantiate render geometry until
      // it has a sparse, sun/terminator-gated WebGL implementation.
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
    if (water?.uSunColor) water.uSunColor.value.copy(primary.colorValue);
    if (water?.uSunEnergy) {
      water.uSunEnergy.value = primary.irradianceFraction ?? 1;
    }
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
      clouds.uSunDir?.value.copy(primary.localDirection);
      clouds.uSunC?.value.copy(primary.colorValue);
      if (clouds.uSunEnergy) {
        clouds.uSunEnergy.value = primary.irradianceFraction ?? 1;
      }
      if (clouds.uStellarRadianceScale) clouds.uStellarRadianceScale.value = field.radianceScale ?? 3.2;
      clouds.uSecondarySunDir?.value.copy(secondary?.localDirection || primary.localDirection);
      clouds.uSecondarySunC?.value.copy(secondary?.colorValue || primary.colorValue);
      if (clouds.uSecondarySunEnergy) {
        clouds.uSecondarySunEnergy.value = secondary?.irradianceFraction ?? 0;
      }
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
    for (const uniforms of [this.volCloudMat?.uniforms, this.terrainMaterial?.userData?.shader?.uniforms,
      this.liquidMat?.userData?.shader?.uniforms]) bindStellarOcclusion(uniforms, this);
    return this.stellarLightField;
  }

  setStellarOccluders(occluders) {
    this.stellarOccluders = occluders.map((b) => ({ ...b, centerLocal: b.centerLocal.clone() }));
    for (const uniforms of [this.volCloudMat?.uniforms, this.terrainMaterial?.userData?.shader?.uniforms,
      this.liquidMat?.userData?.shader?.uniforms]) bindStellarOcclusion(uniforms, this);
    for (const material of [this.volCloudMat, this.terrainMaterial, this.liquidMat]) {
      if (material) bindStellarOcclusion(material.uniforms || material.userData?.shader?.uniforms, this, material);
    }
  }

  setEclipseOccluder(occluder = null) {
    this.eclipseOccluder = occluder ? {
      centerLocal: occluder.centerLocal.clone(),
      radius: Math.max(1, occluder.radius || 1),
      starAngularRadius: Math.max(0, occluder.starAngularRadius || 0),
    } : null;
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

  getDirectCloudMaterial() {
    const near = this.volCloudMat;
    if (!near) return null;
    // Direct views bypass the volume pass and use the original candidate mask.
    if (!this.volCloudDirectMat) {
      this.volCloudDirectMat = near.clone();
      this.volCloudDirectMat.uniforms = near.uniforms;
      this.volCloudDirectMat.fragmentShader = near.fragmentShader.replace(nearProductionCloudGLSL, productionCloudGLSL);
    }
    const direct = this.volCloudDirectMat;
    if (this.volCloudDirectVersion !== near.version) {
      this.volCloudDirectVersion = near.version;
      direct.defines = { ...near.defines };
      direct.needsUpdate = true;
    }
    return direct;
  }

  setWeatherTime(hours) {
    if (!Number.isFinite(hours)) return this.weatherState;
    this.weatherHours = Number(hours);
    if (this.weatherField?.synoptic && this.cloudShadowTex && typeof Worker !== 'undefined'
        && !this.deferWeatherStream) {
      this.weatherStream ||= new PlanetWeatherStream(this);
      this.weatherStream.update(this.weatherHours);
    }
    this.weatherState = advanceWeatherField(this.weatherField, this.weatherHours);
    const uniforms = this.volCloudUniforms || this.volCloudMat?.uniforms;
    if (uniforms?.uWeatherTime) uniforms.uWeatherTime.value = this.weatherHours;
    return this.weatherState;
  }

  cloudResourceDescriptor() {
    return {
      seed: this.seed,
      weatherOptions: {
        targetCoverage: this.cloudCoverage || 0.5,
        radiusMeters: this.R,
        temperatureK: this.weatherProfile?.temperatureK || 286,
        windSpeed: this.weatherProfile?.windSpeed || 15,
        weatherSpeed: this.weatherProfile?.weatherSpeed || 1,
        rotationPeriodHours: this.rotationPeriodHours || 24,
        sunDirection: {
          x: this.sunDirLocal.x,
          y: this.sunDirLocal.y,
          z: this.sunDirLocal.z,
        },
      },
      fieldOptions: {
        hours: 0,
        groundR: this.R,
        maxTerrainMeters: Math.max(1000, Math.ceil(this.hAmp * 1.15)),
      },
      occupancyOptions: {},
    };
  }

  ensureCloudResources() {
    if (this.volCloudState?.rewrite !== 'phase4-A') return null;
    if (this.cloudResourceLease) return this.cloudResourceLease.promise;
    const manager = getCloudResourceManager();
    if (!manager?.enabled) return null;
    const key = `${this.seed}:cloud-rewrite-v2`;
    const lease = manager.acquire(key, this.cloudResourceDescriptor());
    if (!lease) return null;
    this.cloudResourceLease = lease;
    this.cloudResourceStatus = 'generating';
    this.cloudResourceUnsubscribe = lease.onCommit((resource) => {
      if (this.cloudResourceLease !== lease || !resource?.textures) return;
      this.cloudResource = resource;
      this.cloudResourceStatus = 'ready';
      const state = this.volCloudState;
      state.bindResource(resource);
      const actualOuterRadius = this.R + resource.occupancy.shellTop + 500;
      state.band.rIn = this.R + resource.occupancy.shellFloor;
      state.band.rOut = actualOuterRadius;
      this.volCloudBand = state.band;
      const currentRadius = this.volCloudMesh?.geometry?.parameters?.radius || 0;
      if (this.volCloudMesh && Math.abs(currentRadius - actualOuterRadius) > 1) {
        const previous = this.volCloudMesh.geometry;
        this.volCloudMesh.geometry = new THREE.SphereGeometry(actualOuterRadius, 192, 128);
        previous.dispose();
      }
      this.syncVolCloudMaterial?.();
    });
    lease.promise.catch((error) => {
      if (this.cloudResourceLease !== lease) return;
      this.cloudResourceStatus = 'failed';
      this.cloudResourceError = String(error?.message || error);
    });
    return lease.promise;
  }

  weatherAt(localDirection, hours = this.weatherHours) {
    const weather = sampleWeatherField(this.weatherField, localDirection, hours);
    const atlas = this.cloudShadowTex?.userData.weatherAtlas;
    if (!atlas || this.weatherField.synoptic) return weather;
    const spin = hours * (this.weatherField.windRadiansPerHour ?? 0);
    const lo = sampleWeatherAtlas(atlas, localDirection, spin);
    // Coverage is now the same spatial input the volume/deck/shadows consume.
    // Local precipitation cannot survive inside the shared clear-sky mask.
    const precipitation = weather.precipitation * smoothstep(0.05, 0.3, lo[0]);
    return { ...weather, coverage: lo[0], cloudType: lo[1], stratusMask: lo[2],
      humidity: lo[3], precipitation,
      precipitationKind: precipitation > 0.02 ? weather.precipitationKind : 'none' };
  }

  oceanAt(localDirection, hours = this.weatherHours) {
    if (!this.oceanClimate) return null;
    return sampleOceanClimate(this.oceanClimate, localDirection, {
      seconds: hours * 3600,
      waveSeconds: oceanSeconds(hours),
      depth: Math.max(0, this.seaLevel - this.height(localDirection, this.fullMaxFreq)),
      weather: this.weatherAt(localDirection, hours),
    });
  }

  sampleWaterSurface(localPosition, hours = this.weatherHours, options) {
    return this.oceanSurface ? sampleOceanSurface(this.oceanSurface, localPosition, hours, options) : null;
  }

  setWeatherFixture(name = null) {
    this.weatherStream?.dispose(); this.weatherStream = null;
    this.macroReliefTex?.dispose(); this.macroReliefTex = null;
    this.cloudWeatherPublication = null;
    this.cloudColumnMap?.dispose(); this.cloudColumnMap = null;
    this.cloudSpeciesTex?.dispose();
    this.cloudBoundsTex?.dispose();
    this.cloudCandidatesTex?.dispose();
    this.weatherField = createPlanetWeatherField(this, {
      profile: this.weatherProfile,
      fixture: name || undefined,
    });
    if (this.cloudShadowTex && this.cloudOffsets) {
      const previous = this.cloudShadowTex;
      const previousHi = this.cloudWeatherHiTex;
      const weatherAtlases = makeCloudTextures(
        this.nD, this.cloudCoverage || 0.5, this.cloudOffsets,
        this.weatherField, this.cloudAtlasWidth || 512, volumetricCloudsEnabled);
      this.cloudShadowTex = weatherAtlases.low;
      this.cloudWeatherHiTex = weatherAtlases.high;
      this.cloudSpeciesTex = weatherAtlases.bands;
      this.cloudBoundsTex = weatherAtlases.bounds;
      this.cloudCandidatesTex = weatherAtlases.candidates;
      this.cloudCoverageStats = weatherAtlases.stats;
      const terrainNode = this.terrainMaterial.userData.cloudShadowTextureNode;
      if (terrainNode) terrainNode.value = this.cloudShadowTex;
      for (const material of [this.terrainMaterial, this.liquidMat]) {
        const u = material?.userData?.shader?.uniforms?.uCloudSynoptic;
        if (u) u.value = this.weatherField.synoptic ? 1 : 0;
        if(material)material.needsUpdate=true;
      }
      if (this.liquidMat?.userData.waterCloudTexture) {
        this.liquidMat.userData.waterCloudTexture.value = this.cloudShadowTex;
      }
      for (const [material, textureValue] of [
        [this.cloudMesh?.material, this.cloudShadowTex],
        [this.cloudMesh2?.material, this.cloudWeatherHiTex],
      ]) {
        const weatherNode = material?.userData.weatherSystemTextureNode;
        if (weatherNode) weatherNode.value = textureValue;
        const surfaceNode = material?.userData.surfaceSystemTextureNode;
        if (surfaceNode) surfaceNode.value = this.cloudWeatherHiTex;
        if (material?.userData) material.userData.weatherSystemTexture = textureValue;
        const uniforms = material?.userData.shader?.uniforms;
        if (uniforms?.uLocalLayer) uniforms.uLocalLayer.value = this.weatherField.synoptic ? 1 : 0;
        if (uniforms?.uSurfaceRange) {
          uniforms.uSurfaceRange.value = this.weatherField.surfaceRangeMeters || 1;
        }
      }
      const volumeState = this.volCloudState;
      const volumeLoNode = volumeState?.weatherLoTextureNode
        || this.volCloudMat?.userData.weatherLoTextureNode;
      const volumeHiNode = volumeState?.weatherHiTextureNode
        || this.volCloudMat?.userData.weatherHiTextureNode;
      if (volumeLoNode) volumeLoNode.value = this.cloudShadowTex;
      if (volumeHiNode) volumeHiNode.value = this.cloudWeatherHiTex;
      if (this.volCloudMat?.uniforms.uWeatherMap) {
        this.volCloudMat.uniforms.uWeatherMap.value = this.cloudShadowTex;
        this.volCloudMat.uniforms.uWeatherMapHi.value = this.cloudWeatherHiTex;
        this.volCloudMat.uniforms.uSpeciesMap.value = this.cloudSpeciesTex;
        this.volCloudMat.uniforms.uBandBounds.value = this.cloudBoundsTex;
        this.volCloudMat.uniforms.uBandCandidates.value = this.cloudCandidatesTex;
        this.volCloudMat.uniforms.uCandidatesReady.value = this.cloudCandidatesTex ? 1 : 0;
        this.volCloudMat.uniforms.uBandsReady.value = this.cloudSpeciesTex ? 1 : 0;
        this.volCloudMat.uniforms.uColumnsReady.value = 0;
        this.volCloudMat.uniforms.uLocalBands.value = this.weatherField.synoptic ? 1 : 0;
        this.volCloudMat.defines.PRODUCTION_CLOUD_MEDIUM = this.weatherField.synoptic ? 1 : 0;
        this.volCloudMat.needsUpdate = true;
        if(this.volCloudFarMat) {
          this.volCloudFarMat.defines.PRODUCTION_CLOUD_MEDIUM=this.weatherField.synoptic?1:0;
          this.volCloudFarMat.needsUpdate=true;
        }
        this.volCloudMat.uniforms.uSurfaceRange.value = this.weatherField.surfaceRangeMeters || 1;
      }
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
    const altitude = camR - this.R;
    if (this.weatherField?.synoptic && camR > 0) {
      if(this.cloudSpeciesTex) return clamp(sampleProductionMedium(this,camLocal).density,0,1);
      _dir.copy(camLocal).multiplyScalar(1 / camR);
      const weather = this.weatherAt(_dir);
      if (weather.coverage < 0.01 && weather.highMask < 0.01) return 0;
      const surface = this.weatherField.surfaceAt(_dir);
      const base = Math.max(250, surface + weather.cloudBaseMeters + 200);
      const depth = 2000 + weather.cloudType * 1500;
      const lowH = (altitude - base) / depth;
      const highH = (altitude - 8500) / 6000;
      if ((lowH < 0 || lowH > 1) && (highH < 0 || highH > 1)) return 0;
      // Gameplay uses a cheap column estimate. The rendered 3D erosion and
      // solar optical path remain authoritative for the visible cloud.
      const low = weather.coverage
        * smoothstep(0, 0.17, lowH) * (1 - smoothstep(0.66, 1, lowH));
      const high = weather.highMask * 0.12
        * smoothstep(0, 0.18, highH) * (1 - smoothstep(0.73, 1, highH));
      return clamp(Math.max(low, high), 0, 1);
    }
    let t = 0;
    for (const b of this.cloudBands) {
      const thickness = Math.max(1, b.thickness || (b.halfThickness || 1800) * 2);
      const height = (camR - b.r) / thickness;
      if (height <= 0 || height >= 1) continue;
      _dir.copy(camLocal).multiplyScalar(1 / camR)
        .applyQuaternion(_q2.copy(b.mesh.quaternion).invert());
      // weatherAt owns time advection; do not apply the deck rotation twice.
      const liveWeather = this.weatherAt?.(camLocal) || {};
      if ((liveWeather.coverage || 0) < 0.01 && (liveWeather.highMask || 0) < 0.01) continue;
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
      const stratus = smoothstep(1800, 2200, altitude)
        * smoothstep(4300, 3200, altitude) * stratusMask;
      const cumulusBase = lerp(2200, 3000, cloudType);
      const cumulusTop = lerp(5800, 8200, cloudType);
      const cumulusHeight = (altitude - cumulusBase)
        / Math.max(1, cumulusTop - cumulusBase);
      const cumulus = smoothstep(0, 0.065, cumulusHeight)
        * smoothstep(1.02, 0.58, cumulusHeight)
        * (1 - stratusMask * 0.72);
      const alto = smoothstep(5200, 5700, altitude)
        * smoothstep(8500, 7600, altitude) * highMask * (1 - highType);
      const cirrus = smoothstep(9000, 9600, altitude)
        * smoothstep(15800, 14300, altitude) * highMask
        * (0.42 + highType * 0.58);
      const anvil = smoothstep(7800, 9000, altitude)
        * smoothstep(15800, 14000, altitude) * convective * cloudType;
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

  ensureMacroReliefTexture() {
    if (this.macroReliefTex || (this.weatherField?.synoptic && this.cloudWeatherHiTex)) return;
    if (typeof document === 'undefined' || !(this.hAmp > 20)) return;
    const width = 128, height = 64;
    const elevations = new Float32Array(width * height);
    let minSurface = Infinity, maxSurface = -Infinity;
    const floor = this.hasLiquid && Number.isFinite(this.seaLevel) ? this.seaLevel : -1e9;
    const dir = { x: 0, y: 0, z: 0 };
    for (let y = 0; y < height; y++) {
      const phi = ((y + 0.5) / height - 0.5) * Math.PI;
      const cy = Math.sin(phi), cr = Math.cos(phi);
      for (let x = 0; x < width; x++) {
        const th = ((x + 0.5) / width) * Math.PI * 2;
        dir.x = Math.cos(th) * cr; dir.y = cy; dir.z = Math.sin(th) * cr;
        const h = Math.max(this.height(dir, 64), floor);
        elevations[y * width + x] = h;
        if (h < minSurface) minSurface = h;
        if (h > maxSurface) maxSurface = h;
      }
    }
    const range = Math.max(1000, this.hAmp || 0, Math.abs(minSurface), Math.abs(maxSurface));
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const dstRow = (height - 1 - y) * width * 4;
      for (let x = 0; x < width; x++) {
        const g = Math.round(clamp(0.5 + elevations[y * width + x] / (2 * range), 0, 1) * 255);
        const k = dstRow + x * 4;
        data[k + 1] = g;
        data[k + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.macroReliefTex = tex;
    this.macroReliefRange = range;
  }

  // camLocal: camera position in planet-local coords (f64 Vector3).
  // animDt drives scenery-in-motion (cloud drift); the seam test freezes it
  // to zero so static frames are pixel-comparable — LOD morphs keep dt.
  update(camLocal, dt, focused, animDt = dt, buildBudget=null) {
    if (focused && !this.macroReliefTex && !(this.weatherField?.synoptic && this.cloudWeatherHiTex)) {
      this.ensureMacroReliefTexture();
    }
    if (focused && this.volumeActive && this.volCloudState?.rewrite === 'phase4-A') {
      this.ensureCloudResources();
    }
    camLocal = this.worldOffsetToLocal(camLocal, _msp);
    const camR = camLocal.length();
    this.lod.focused = focused;
    this.lod.update(camLocal, dt);
    if (this.waterLod) {
      this.waterLod.focused = focused;
      this.waterLod.update(camLocal, dt);
      if(this.nearWaterPatch) {
        const patch=this.nearWaterPatch;
        if(buildBudget&&focused)buildBudget.run('water',patch.preferredBudget(camLocal.length()-this.seaRadius,dt),
          budget=>patch.update(camLocal,focused,dt,budget));
        else patch.update(camLocal,focused,dt,buildBudget?0:null);
      }
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
        + this.weatherHours * (this.weatherField?.windRadiansPerHour ?? 0.05);
      // Planet local Y is already the physical rotation axis. Applying the
      // decorative ring tilt a second time rotated visible clouds away from
      // CPU weather, rain and the shadow atlas. Cloud decks therefore advect
      // only around the body-frame axis.
      this.cloudMesh.quaternion.setFromAxisAngle(_yAxis, this.cloudSpin);
      const deckShader = this.cloudMesh.material.userData.shader;
      if (deckShader?.uniforms.uSurfaceSpin) {
        _m4.makeRotationFromQuaternion(this.cloudMesh.quaternion);
        deckShader.uniforms.uSurfaceSpin.value.setFromMatrix4(_m4);
      }
      // keep terrain cloud-shadows tracking the drifting deck
      _m4.makeRotationFromQuaternion(_q2.copy(this.cloudMesh.quaternion).invert());
      const sh = this.terrainMaterial.userData.shader;
      if (sh) sh.uniforms.uCloudMat.value.setFromMatrix4(_m4);
      const waterShader = this.liquidMat?.userData.shader;
      if (waterShader?.uniforms.uCloudMat) {
        waterShader.uniforms.uCloudMat.value.setFromMatrix4(_m4);
      }
      if (this.volCloudMesh) {
        // Legacy WebGL keeps the pre-rewrite contract: the raymarched shell is
        // the primary cloud image for the focused planet at EVERY viewing
        // distance; the analytic deck is strictly a distant-body LOD. The
        // 720–1050 km proximity gate below belongs to the shelved WebGPU
        // rewrite world — on the 6,000 km curated homeworld it silenced the
        // volume from orbit and left only the analytic texture deck. The
        // legacy chain also never sets volumeActive (that flag belongs to the
        // node-graph pass), so it must not gate the legacy shell.
        const band = this.volCloudBand || this.volCloudMat.userData.band;
        let target;
        let meshGate;
        if (this.volCloudState?.rewrite === 'phase4-A') {
          // S4's authored camera is ~2.2R from the centre. The new occupancy
          // march is the space-view implementation too; falling back to the
          // legacy analytic deck at that distance would reintroduce a second
          // cloud authority and break space-to-surface consistency.
          const distanceToShell = camR < band.rIn
            ? band.rIn - camR
            : camR > band.rOut ? camR - band.rOut : 0;
          const volumeProximity = 1 - smoothstep(Math.max(720000, this.R * 1.3),
            Math.max(1050000, this.R * 1.65), distanceToShell);
          const resourceReady
            = this.volCloudState.nodes.uResourceReady.value > 0.5;
          target = focused && this.volumeActive && resourceReady
            ? volumeProximity : 0;
          meshGate = this.volumeActive && resourceReady;
        } else {
          target = focused ? 1 : 0;
          meshGate = true;
        }
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
        u.uCloudAdvectionPhase.value=this.weatherHours*this.weatherField.windRadiansPerHour;
        u.uFrame.value = (u.uFrame.value + 1) % 4096;
        // The legacy volume material lights clouds from the live planet-local
        // sun direction. Losing this copy (during the WebGPU rewrite) left the
        // uniform at its (0,1,0) default — every cloud shaded from the wrong
        // side, reading as dead black from orbit.
        if (this.sunDirLocal) u.uSunDir.value.copy(this.sunDirLocal);
        // Distance-adaptive cloud morphology: 1 while individual billows are
        // resolvable, 0 once they are sub-pixel. Matches the span-adaptive
        // step stride in the volume ray so far frames stay cheap without the
        // limb collapsing to the old locked 20-sample budget.
        if (u.uCamProx) u.uCamProx.value = 1 - smoothstep(2.0, 5.0, camR / band.rOut);
        if (u.uWeatherTime) u.uWeatherTime.value = this.weatherHours;
        this.volCloudMesh.visible = meshGate && e > 0.01;
        this.cloudMesh.material.opacity = 0.88 * (1 - e);
        if (this.cloudMesh.material.userData.opacityNodeUniform) {
          this.cloudMesh.material.userData.opacityNodeUniform.value = this.cloudMesh.material.opacity;
        }
        this.cloudMesh.visible = this.cloudMesh.material.opacity > 0.005;
      }
    }
    if (this.cloudMesh2) {
      this.cloudSpin2 = this.cloudSpin2Base
        + this.weatherHours * (this.weatherField?.windRadiansPerHour ?? 0.05);
      this.cloudMesh2.quaternion.setFromAxisAngle(_yAxis, this.cloudSpin2);
      const upperDeckShader = this.cloudMesh2.material.userData.shader;
      if (upperDeckShader?.uniforms.uSurfaceSpin) {
        _m4.makeRotationFromQuaternion(this.cloudMesh2.quaternion);
        upperDeckShader.uniforms.uSurfaceSpin.value.setFromMatrix4(_m4);
      }
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
    // The lite cloud pass draws the active planet's clouds itself.
    if (this.cloudVisualEnabled === false || this.liteCloudActive) {
      for (const mesh of [this.cloudMesh, this.cloudMesh2,
        this.cloudMeshNoctilucent, this.volCloudMesh]) {
        if (mesh) mesh.visible = false;
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
    this.cloudResourceUnsubscribe?.();
    this.cloudResourceLease?.release?.();
    this.cloudResourceUnsubscribe = null;
    this.cloudResourceLease = null;
    this.cloudResource = null;
    this.lod.dispose();
    if (this.waterLod) this.waterLod.dispose();
    this.nearWaterPatch?.dispose();
    this.liquidMat?.userData?.waterInteractionTexture?.dispose?.();
    this.liquidMat?.dispose();
    this.waterUnderlayMaterial?.dispose();
    this.weatherStream?.dispose();
    this.cloudColumnMap?.dispose();
    if (this.cloudShadowTex) this.cloudShadowTex.dispose();
    if (this.cloudWeatherHiTex) this.cloudWeatherHiTex.dispose();
    this.macroReliefTex?.dispose();
    this.cloudSpeciesTex?.dispose();
    this.cloudBoundsTex?.dispose();
    this.cloudCandidatesTex?.dispose();
    this.volCloudMat?.dispose();
    this.volCloudFarMat?.dispose();
    this.volCloudDirectMat?.dispose();
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
        if (o.material.userData.weatherSystemTextureOwned) o.material.userData.weatherSystemTexture?.dispose();
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

function makeAtmosphereMaterial(planet, color, density, groundR, atmoR) {
  return makeAtmosphereMaterialWebGL(color, density, groundR, atmoR);
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

function cloudAtlasTexture(data, width, height) {
  // RGBA are four independent weather values; A is LCL/humidity, NOT opacity.
  // Canvas premultiplication/blur corrupts RGB at low A (and erases it at A=0).
  // Upload bytes directly, reversing south-first rows for the shared UV map.
  const uploaded = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    uploaded.set(data.subarray(y * width * 4, (y + 1) * width * 4),
      (height - 1 - y) * width * 4);
  }
  const tex = new THREE.DataTexture(uploaded, width, height, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.userData.weatherAtlas = { width, height, data };
  tex.userData.weatherAtlas.hours=0;
  tex.needsUpdate = true;
  return tex;
}

function makeCloudTextures(simplex, coverage, offsets = [0, 0, 0],
  weatherField = null, width = 512, includeProductionBands = true) {
  // 256–512×half-width preserves the authored 20–60 km structures at each
  // body's physical scale. The volume shader adds its own fine 3D erosion;
  // larger fixed atlases spent millions of noise evaluations on sub-pixel
  // detail during route preparation.
  const W = clamp(Math.round(width), 128, 512), H = Math.round(W / 2);
  if (typeof document === 'undefined') return { low: null, high: null, stats: null };
  const lowData = new Uint8Array(W * H * 4);
  const highData = new Uint8Array(W * H * 4);
  const lowRaw = new Float32Array(W * H);
  const highRaw = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const phi = ((j + 0.5) / H - 0.5) * Math.PI;
    const cy = Math.sin(phi), cr = Math.cos(phi);
    for (let i = 0; i < W; i++) {
      const th = ((i + 0.5) / W) * Math.PI * 2;
      const cx = Math.cos(th) * cr, cz = Math.sin(th) * cr;
      // The exact same deterministic weather function drives CPU transit fog
      // and GPU rendering. Fine seeded noise only erodes the shared density;
      // it never creates an independent camera-facing cloud pattern.
      const dir = { x: cx, y: cy, z: cz };
      if (weatherField?.synoptic) {
        // Sample the native weather model directly rather than allocating
        // gameplay wind/morphology wrapper objects 32,768 times per planet.
        const w = (weatherField.sampleAtlas || weatherField.sampleRaw).call(weatherField, dir, 0), index = j * W + i, k = index * 4;
        lowRaw[index] = clamp(0.5 + w.lowPotential / 4);
        highRaw[index] = clamp(0.5 + w.highPotential / 4);
        lowData[k + 1] = Math.round(w.convective * 255);
        lowData[k + 2] = Math.round(w.stability * (1 - w.convective) * 255);
        lowData[k + 3] = Math.round(w.humidity * 255);
        // Hi.G is a stationary regional surface column. Weather channels
        // rotate with wind; this one is always sampled without uSpin.
        highData[k + 1] = Math.round(clamp(0.5 + weatherField.surfaceAt(dir)
          / (2 * weatherField.surfaceRangeMeters)) * 255);
        highData[k + 2] = Math.round(w.convective * 255);
        highData[k + 3] = Math.round(clamp((w.lclMeters - LCL_MIN_METERS)
          / (LCL_MAX_METERS - LCL_MIN_METERS)) * 255);
        continue;
      }
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
      // Hi.A carries the lifting condensation level, normalized over the
      // authored LCL_RANGE_METERS span. Multiple scattering used to live here,
      // but the shader can reconstruct that from coverage and highMask, whereas
      // a per-point cloud base cannot be derived from anything else — and
      // without it every cloud family shared one global base altitude.
      highData[k + 3] = Math.round(clamp(
        ((weather?.cloudBaseMeters ?? LCL_MIN_METERS) - LCL_MIN_METERS)
        / (LCL_MAX_METERS - LCL_MIN_METERS), 0, 1) * 255);
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
    const lowValue = weatherField?.synoptic ? lowRaw[index] : lowSupport
      * (0.2 + 0.8 * Math.pow(lowRelief, 0.72));
    const highSupport = smoothstep(
      highFloor, Math.min(1, highCutoff + 0.012), highRaw[index]);
    const highRelief = clamp(
      (highRaw[index] - highFloor) / Math.max(1e-5, 1 - highFloor), 0, 1);
    const highValue = weatherField?.synoptic ? highRaw[index] : highSupport
      * (0.12 + 0.88 * Math.pow(highRelief, 0.82));
    lowData[index * 4] = Math.round(lowValue * 255);
    highData[index * 4] = Math.round(highValue * 255);
    const lowAmount = weatherField?.synoptic ? decodeSynopticCoverage(lowValue) : lowValue;
    const highAmount = weatherField?.synoptic ? decodeSynopticCoverage(highValue, 0.14) : highValue;
    lowMean += lowAmount;
    highMean += highAmount;
    if (lowAmount >= 0.125) lowOccupied++;
    if (highAmount >= 0.08) highOccupied++;
  }
  const count = lowRaw.length;
  const stats = Object.freeze({
    requested: coverage,
    fixtureRequested: Number.isFinite(fixtureCoverage) ? fixtureCoverage : null,
    representation: weatherField?.synoptic ? 'synoptic-potential-snapshot-v2' : 'legacy-fixture',
    lowTarget: weatherField?.synoptic ? null : lowTarget,
    highTarget: weatherField?.synoptic ? null : highTarget,
    lowOccupied: lowOccupied / count,
    highOccupied: highOccupied / count,
    lowMean: lowMean / count,
    highMean: highMean / count,
    lowCutoff: weatherField?.synoptic ? null : lowCutoff,
    highCutoff: weatherField?.synoptic ? null : highCutoff,
  });
  const low = cloudAtlasTexture(lowData, W, H);
  const high = cloudAtlasTexture(highData, W, H);
  weatherField?.bindAtlases?.(low.userData.weatherAtlas, high.userData.weatherAtlas);
  low.userData.coverageStats = stats;
  high.userData.coverageStats = stats;
  let bands = null,bounds=null,candidates=null;
  if (weatherField?.synoptic && includeProductionBands) {
    const packed=buildProductionBands(d=>weatherField.sampleRaw(d,0),128,weatherField.streamDescriptor.terrain);
    bands = new THREE.DataArrayTexture(packed.data, packed.width, packed.height, packed.layers);
    bands.format = THREE.RGBAFormat; bands.type = THREE.FloatType;
    bands.minFilter = bands.magFilter = THREE.LinearFilter;
    bands.wrapS = THREE.RepeatWrapping; bands.wrapT = THREE.ClampToEdgeWrapping;
    bands.colorSpace = THREE.NoColorSpace; bands.needsUpdate = true;
    bounds=new THREE.DataTexture(packed.bounds,packed.width,packed.height,THREE.RGBAFormat,THREE.FloatType);
    bounds.wrapS=THREE.RepeatWrapping;bounds.minFilter=bounds.magFilter=THREE.NearestFilter;
    bounds.colorSpace=THREE.NoColorSpace;bounds.needsUpdate=true;
    candidates=new THREE.DataArrayTexture(packed.candidates,CANDIDATE_WIDTH,CANDIDATE_HEIGHT,CANDIDATE_LAYERS);
    candidates.format=THREE.RedIntegerFormat;candidates.type=THREE.UnsignedShortType;
    candidates.internalFormat='R16UI';candidates.minFilter=candidates.magFilter=THREE.NearestFilter;
    candidates.needsUpdate=true;
  }
  return { low, high, bands, bounds, candidates, stats };
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
