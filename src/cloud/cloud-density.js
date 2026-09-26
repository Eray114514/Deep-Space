// Cloud density — CPU candidate/reference toolbox (phase 3, D1).
// Production clouds-webgl.js does not yet consume these fields. B4 chooses
// which parts to migrate; this file is not the current render authority.
//
// One intended contract, one data path:
//   cloudDensityCPU(...)  plain JS — transit fog, CPU cloud tests, consistency
//                         checks, and anything gameplay needs to know about
//                         cloud occupancy without a GPU readback.
// (A TSL node-graph counterpart existed for the shelved WebGPU volume march;
// it was removed with that line — see git history.)
//
// WHY SHARED BAKED DATA REDUCES (BUT DOES NOT DISCHARGE) THE GPU GATE
// -----------------------------------------------------------------
// The first draft of this phase had both sides evaluate the same analytic
// noise; keeping two floating-point hash/permutation implementations bit-
// aligned well enough to stay inside 1% was the gate's only real risk. The
// accepted alternative: the CPU bakes every stochastic input ONCE into
// textures, and the GPU only ever samples those textures:
//
//   shape/detail noise  -> periodic 3D fields (this file, baked on CPU)
//   per-species bands   -> bands atlas (weight, base, top per direction)
//   regional jitter     -> baked INTO the bands atlas (never recomputed GPU)
//   fine jitter         -> a lane of the same shape texture both sides read
//
// Sharing bytes removes stochastic-source drift. Coordinates, interpolation,
// species mixing and extinction math can still differ in a GLSL translation,
// so any B4 migration must compare real WebGL2 readback against this reference.
// `tools/cloudsamplingtest.js` only pins CPU fp32 sensitivity and bake fidelity;
// it is a prerequisite for, not a substitute for, that hardware gate.
//
// DETERMINISM
// Everything here derives from the weather system's seed through hash3i /
// makeRng. No Math.random, no Date, no per-frame state. The same fields bake
// feeds the occupancy volume (cloud-occupancy.js), so "space sees no cloud ->
// fly there -> no cloud" (C1) is one data pipeline, not two agreements.

import { hash3i, hashFloat, strHash32 } from '../rng.js';
import {
  BASE_REFERENCE, CLOUD_SHELL_SPECIES, CLOUD_SPECIES,
  CLOUD_TROPOSPHERE_TOP_METERS, MORPHOLOGY, speciesAltitudeBand,
} from './cloud-species.js';
import { sampleWeather } from './weather-system.js';

export const CLOUD_DENSITY_VERSION = 2;

const TAU = Math.PI * 2;

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function smoothstep(low, high, value) {
  if (high === low) return value >= high ? 1 : 0;
  const t = clamp((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ---------------------------------------------------------------------------
// Periodic lattice noise — tileable by CONSTRUCTION, not by luck.
//
// The baked 3D fields are sampled in a wrapping local coordinate frame, so the
// source noise must be exactly periodic or cloud cells would tear at the tile
// boundary. Simplex (noise.js) skews its lattice and is not periodic in any
// axis; instead we run classic Perlin-style gradient noise and Worley F1 on a
// modulo lattice, where hash3i(cell mod period) makes periodicity exact.
// These are baked once and only ever sampled afterwards, so their cost model
// is irrelevant to the renderer.
// ---------------------------------------------------------------------------

function periodicGradient3(seed, period) {
  const wrap = (i) => ((i % period) + period) % period;
  const gradient = (ix, iy, iz) => {
    const h = hash3i(wrap(ix), wrap(iy), wrap(iz), seed);
    // Two hash lanes pick a pseudo-random gradient direction on the sphere.
    const z = hashFloat(h, 0) * 2 - 1;
    const phi = hashFloat(h, 1) * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y, z) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const fx = x - x0, fy = y - y0, fz = z - z0;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    let accum = 0;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const g = gradient(x0 + dx, y0 + dy, z0 + dz);
          const contribution = g.x * (fx - dx) + g.y * (fy - dy) + g.z * (fz - dz);
          const weight = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
          accum += contribution * weight;
        }
      }
    }
    // Gradient noise lands in roughly [-0.7, 0.7]; rescale to [-1, 1].
    return clamp(accum * 1.42, -1, 1);
  };
}

function periodicFbm3(seed, basePeriod, octaves, gain = 0.5) {
  const layers = [];
  for (let octave = 0; octave < octaves; octave++) {
    layers.push(periodicGradient3(seed + octave * 101, basePeriod << octave));
  }
  return (x, y, z) => {
    let sum = 0, amplitude = 1, norm = 0;
    for (let octave = 0; octave < octaves; octave++) {
      const scale = 1 << octave;
      sum += amplitude * layers[octave](x * scale, y * scale, z * scale);
      norm += amplitude;
      amplitude *= gain;
    }
    return clamp(sum / Math.max(norm, 1e-9) * 0.5 + 0.5);
  };
}

// Worley F1 on the same modulo lattice. Returns distance to the nearest
// jittered feature point, in [0, ~1.5]; callers invert as needed.
function periodicWorley3(seed, period) {
  const wrap = (i) => ((i % period) + period) % period;
  return (x, y, z) => {
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    let best = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const h = hash3i(wrap(cx + dx), wrap(cy + dy), wrap(cz + dz), seed);
          const ddx = x - (cx + dx + hashFloat(h, 0));
          const ddy = y - (cy + dy + hashFloat(h, 1));
          const ddz = z - (cz + dz + hashFloat(h, 2));
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  };
}

// ---------------------------------------------------------------------------
// Baked field containers + samplers
//
// Every sampler takes an `fp32` flag. With it set, texel fetches and every
// lerp are rounded through Math.fround, emulating what the GPU's fp32
// sampling arithmetic will produce from the SAME uploaded arrays. That is
// the entire CPU/GPU consistency story; the test asserts it stays under 1%.
// ---------------------------------------------------------------------------

function makeField3(size, channels) {
  return {
    kind: 'cloud-field3',
    size,
    channels,
    data: new Float32Array(size * size * size * channels),
  };
}

// Periodic trilinear (3D fields wrap on every axis). Coordinates are in
// tile units: any real value is accepted and taken mod 1 per axis.
export function sampleField3(field, x, y, z, channel = 0, fp32 = false) {
  const size = field.size;
  const channels = field.channels;
  const data = field.data;
  const round = fp32 ? Math.fround : (v) => v;
  const wrap = (value) => {
    const t = value - Math.floor(value);
    return round(t * size - 0.5);
  };
  const gx = wrap(x), gy = wrap(y), gz = wrap(z);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
  const fx = round(gx - x0), fy = round(gy - y0), fz = round(gz - z0);
  const idx = (ix, iy, iz) => {
    const wx = ((ix % size) + size) % size;
    const wy = ((iy % size) + size) % size;
    const wz = ((iz % size) + size) % size;
    return round(data[((wz * size + wy) * size + wx) * channels + channel]);
  };
  const c00 = lerp(idx(x0, y0, z0), idx(x0 + 1, y0, z0), fx);
  const c10 = lerp(idx(x0, y0 + 1, z0), idx(x0 + 1, y0 + 1, z0), fx);
  const c01 = lerp(idx(x0, y0, z0 + 1), idx(x0 + 1, y0, z0 + 1), fx);
  const c11 = lerp(idx(x0, y0 + 1, z0 + 1), idx(x0 + 1, y0 + 1, z0 + 1), fx);
  return round(lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz));
}

function makeField2(width, height, channels) {
  return {
    kind: 'cloud-field2',
    width,
    height,
    channels,
    data: new Float32Array(width * height * channels),
  };
}

function attachCloudFieldMethods(fields) {
  fields.sampleRegionalJitter = (direction) => ({
    base01: sampleField2(fields.jitter, direction, 0),
    depth01: sampleField2(fields.jitter, direction, 1),
  });
  fields.terrainMeters = (direction, fp32 = false) =>
    sampleField2(fields.jitter, direction, 2, fp32) * fields.maxTerrainMeters;
  return fields;
}

// Equirect sphere <-> atlas UV. Longitude wraps, latitude clamps at the
// poles (the polar singularity only compresses low-frequency fields, which
// is acceptable for weather data).
export function directionToAtlasUV(direction) {
  const u = ((Math.atan2(direction.z, direction.x) / TAU) % 1 + 1) % 1;
  const v = clamp(Math.asin(clamp(direction.y, -1, 1)) / Math.PI + 0.5);
  return { u, v };
}

export function atlasTexelDirection(width, height, i, j) {
  const lon = ((i + 0.5) / width) * TAU;
  const lat = ((j + 0.5) / height - 0.5) * Math.PI;
  const r = Math.cos(lat);
  return { x: Math.cos(lon) * r, y: Math.sin(lat), z: Math.sin(lon) * r };
}

// Bilinear sphere-atlas sample. Wraps in u, clamps in v.
export function sampleField2(field, direction, channel = 0, fp32 = false) {
  const { width, height, channels, data } = field;
  const round = fp32 ? Math.fround : (v) => v;
  const { u, v } = directionToAtlasUV(direction);
  const gx = round(u * width - 0.5);
  const gy = round(v * height - 0.5);
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = round(gx - x0), fy = round(gy - y0);
  const idx = (ix, iy) => {
    const wx = ((ix % width) + width) % width;
    const wy = clamp(iy, 0, height - 1);
    return round(data[(wy * width + wx) * channels + channel]);
  };
  return round(lerp(
    lerp(idx(x0, y0), idx(x0 + 1, y0), fx),
    lerp(idx(x0, y0 + 1), idx(x0 + 1, y0 + 1), fx),
    fy,
  ));
}

// ---------------------------------------------------------------------------
// Morphology shaping — pure data + pure functions, shared byte-for-byte
// between the CPU evaluator and (phase 4) the TSL graph as uniform params.
// ---------------------------------------------------------------------------

// Vertical condensate profile per morphology: t in [0,1] from band base to
// band top. These encode where in a deck the water sits (cumulus cores are
// top-heavy, lenses are mid-loaded, veils are uniform).
const VERTICAL_PROFILES = Object.freeze({
  [MORPHOLOGY.SHEET]: (t) => smoothstep(0, 0.18, t) * (1 - smoothstep(0.82, 1, t)),
  [MORPHOLOGY.CELLULAR]: (t) => smoothstep(0, 0.22, t)
    * (1 - smoothstep(0.75, 1, t)) * (0.75 + 0.25 * t),
  // Convective clouds condense more as the thermal rises: top-loaded core,
  // hard cap near the summit.
  [MORPHOLOGY.CAULIFLOWER]: (t) => (0.35 + 0.65 * t)
    * smoothstep(0, 0.15, t) * (1 - smoothstep(0.8, 1, t)),
  [MORPHOLOGY.TOWER]: (t) => (0.25 + 0.75 * t)
    * smoothstep(0, 0.1, t) * (1 - smoothstep(0.85, 1, t)),
  [MORPHOLOGY.WISPY]: (t) => 0.45 + 0.4
    * smoothstep(0, 0.3, t) * (1 - smoothstep(0.7, 1, t)),
  [MORPHOLOGY.LENS]: (t) => Math.pow(Math.sin(Math.PI * clamp(t)), 1.2),
  [MORPHOLOGY.VEIL]: (t) => 0.55
    * smoothstep(0, 0.12, t) * (1 - smoothstep(0.88, 1, t)),
});

// Per-morphology shaping constants:
//   noiseMix    0 = pure fbm billow, 1 = pure worley cells
//   vStretch    multiplier on the altitude coordinate of the shape lookup.
//               < 1 stretches features vertically (towers), > 1 flattens
//               them (sheets). This is anisotropy, not scaling.
//   erosion     how hard the detail field eats thin edges
//   peak        maximum condensate fraction this morphology can reach
export const MORPHOLOGY_PARAMS = Object.freeze({
  [MORPHOLOGY.SHEET]: Object.freeze({
    noiseMix: 0.15, vStretch: 2.5, erosion: 0.18, peak: 0.95,
  }),
  [MORPHOLOGY.CELLULAR]: Object.freeze({
    noiseMix: 0.85, vStretch: 1.0, erosion: 0.3, peak: 0.9,
  }),
  [MORPHOLOGY.CAULIFLOWER]: Object.freeze({
    noiseMix: 0.35, vStretch: 0.8, erosion: 0.45, peak: 0.95,
  }),
  [MORPHOLOGY.TOWER]: Object.freeze({
    noiseMix: 0.3, vStretch: 0.45, erosion: 0.5, peak: 1.0,
  }),
  [MORPHOLOGY.WISPY]: Object.freeze({
    noiseMix: 0.5, vStretch: 0.6, erosion: 0.25, peak: 0.55,
  }),
  [MORPHOLOGY.LENS]: Object.freeze({
    noiseMix: 0.1, vStretch: 1.6, erosion: 0.05, peak: 0.8,
  }),
  [MORPHOLOGY.VEIL]: Object.freeze({
    noiseMix: 0.2, vStretch: 2.0, erosion: 0.1, peak: 0.5,
  }),
});

// Noise texture tile span: one texture tile covers this many characteristic
// horizontal features per axis. Small enough that fbm octaves resolve a
// feature, large enough that tiling repetition is not visible at feature
// scale (the weather masks modulate tile-to-tile amplitude anyway).
export const NOISE_TILE_FEATURES = 6;

// Fine per-patch band displacement (S1a / C4): individual clouds of one
// genus must sit at different heights WITHIN one region. The displacement
// comes from the shape texture itself (lanes 2/3), sampled at the species'
// patch scale, so CPU and GPU read the same values — no hash to keep
// bit-aligned. Amplitudes are fractions of the species' authored jitters;
// the occupancy baker expands bands by the same total amount, keeping the
// skip structure conservative.
export const FINE_BASE_JITTER_FRACTION = 0.5;
export const FINE_DEPTH_JITTER_FRACTION = 0.5;

// Below this weight a species contributes nothing measurable; used by both
// the density loop (skip) and the occupancy baker (empty classification).
// resolveSpeciesBands emits everything down to 1e-4 so coverage boundaries
// are CONTINUOUS: a hard cutoff would let the atlas bilinear path and the
// direct path disagree by a whole cutoff-step at system edges.
export const SPECIES_WEIGHT_EPSILON = 0.02;
export const SPECIES_WEIGHT_EMIT_FLOOR = 1e-4;

// Weather already thresholds the synoptic potential into an AREA mask. Shape
// noise must therefore describe structure inside that area, not threshold the
// same coverage a second time. These bounds leave both cloudy cores and eroded
// gaps in the morphology while species weight controls condensate amount.
export const SHAPE_FORMATION_LOW = 0.16;
export const SHAPE_FORMATION_HIGH = 0.72;
export const FAMILY_CONDENSATE_LOW = 0.12;
export const FAMILY_CONDENSATE_HIGH = 0.68;

// Bands-atlas channel layout (the CPU/GPU shared contract):
//   layer = shell species index (order of CLOUD_SHELL_SPECIES)
//   R = species weight at this direction (0..1)
//   G = band base altitude in metres above the reference surface
//   B = band top altitude in metres above the reference surface
// Raw metres avoid silently clipping terrain-lifted decks against a global
// Earth-like shell constant. Float16 can still represent the supported range;
// production uses float32 while the GPU contract is first established.
//   A = 1 (unused; reserved for phase 4 optical data)
export const BANDS_ATLAS_CHANNELS = 4;

// Jitter/context atlas channels:
//   R = regional base-jitter lane (smooth, ~1000 km features)
//   G = regional depth-jitter lane
//   B = terrain elevation / fields.maxTerrainMeters
//   A = unused
export const JITTER_ATLAS_CHANNELS = 4;

// ---------------------------------------------------------------------------
// Field baking
// ---------------------------------------------------------------------------

// Bake every stochastic input the density contract needs, once, from the
// weather system's seed. The returned object is plain data (Float32Array)
// plus samplers — the renderer uploads the same arrays as Data3DTexture /
// DataTexture and the GPU never recomputes any of it.
//
// Expensive: O(atlas) full weather samples + O(size^3) noise. Sizes are
// options so tests can shrink them; the renderer uses the defaults.
export function createCloudFields(system, options = {}) {
  if (system?.kind !== 'weather-system') {
    throw new TypeError('createCloudFields() expects a system from createWeatherSystem()');
  }
  const noiseSize = Math.max(16, Math.round(options.noiseSize ?? 128));
  const detailSize = Math.max(8, Math.round(options.detailSize ?? 64));
  const atlasWidth = Math.max(32, Math.round(options.atlasWidth ?? 256));
  const atlasHeight = Math.max(16, Math.round(options.atlasHeight ?? 128));
  const hours = Number.isFinite(options.hours) ? options.hours : 0;
  const groundR = Number.isFinite(options.groundR)
    ? options.groundR : system.radiusMeters;
  const maxTerrainMeters = Number.isFinite(options.maxTerrainMeters)
    ? options.maxTerrainMeters : 8000;
  const seed = strHash32(`${system.namespace}:cloud-density:v${CLOUD_DENSITY_VERSION}`);

  // -- 3D noise fields -------------------------------------------------------
  // shape RGBA: [0] fbm billow, [1] worley cells (1 - F1), [2]/[3] fine
  // jitter lanes. detail R: high-frequency erosion fbm.
  const shape = makeField3(noiseSize, 4);
  const shapeFbm = periodicFbm3(seed ^ 0x9e37, 4, 4, 0.52);
  const shapeWorley = periodicWorley3(seed ^ 0x51f7, 5);
  const jitterLaneA = periodicFbm3(seed ^ 0x2b81, 3, 2, 0.55);
  const jitterLaneB = periodicFbm3(seed ^ 0x74cd, 3, 2, 0.55);
  for (let z = 0; z < noiseSize; z++) {
    for (let y = 0; y < noiseSize; y++) {
      for (let x = 0; x < noiseSize; x++) {
        // Sample in lattice units so the integer lattice period is exact.
        const lx = (x / noiseSize) * 4;
        const ly = (y / noiseSize) * 4;
        const lz = (z / noiseSize) * 4;
        const offset = ((z * noiseSize + y) * noiseSize + x) * 4;
        shape.data[offset] = shapeFbm(lx, ly, lz);
        shape.data[offset + 1] = clamp(1 - shapeWorley(
          (x / noiseSize) * 5, (y / noiseSize) * 5, (z / noiseSize) * 5) * 1.25);
        shape.data[offset + 2] = jitterLaneA(lx, ly, lz);
        shape.data[offset + 3] = jitterLaneB(lx, ly, lz);
      }
    }
  }

  const detail = makeField3(detailSize, 1);
  const detailFbm = periodicFbm3(seed ^ 0x1f3d, 4, 4, 0.55);
  for (let z = 0; z < detailSize; z++) {
    for (let y = 0; y < detailSize; y++) {
      for (let x = 0; x < detailSize; x++) {
        detail.data[(z * detailSize + y) * detailSize + x] = detailFbm(
          (x / detailSize) * 4, (y / detailSize) * 4, (z / detailSize) * 4);
      }
    }
  }

  // -- regional jitter + terrain atlas ----------------------------------------
  // Regional lanes are very low frequency (a handful of cells around the
  // globe): this is the S1(b) "每个区域的底层云高度也不一样" axis, distinct
  // from the per-patch fine displacement above.
  const jitter = makeField2(atlasWidth, atlasHeight, JITTER_ATLAS_CHANNELS);
  const regionalA = periodicFbm3(seed ^ 0x63a9, 4, 2, 0.5);
  const regionalB = periodicFbm3(seed ^ 0x3d1f, 4, 2, 0.5);

  // -- bands atlas -------------------------------------------------------------
  const shellSpecies = CLOUD_SHELL_SPECIES;
  const bands = {
    kind: 'cloud-bands-atlas',
    width: atlasWidth,
    height: atlasHeight,
    layers: shellSpecies.length,
    channels: BANDS_ATLAS_CHANNELS,
    data: new Float32Array(
      atlasWidth * atlasHeight * shellSpecies.length * BANDS_ATLAS_CHANNELS),
  };

  const fields = attachCloudFieldMethods({
    kind: 'cloud-fields',
    version: CLOUD_DENSITY_VERSION,
    seed,
    system,
    hours,
    groundR,
    maxTerrainMeters,
    shellTopMeters: CLOUD_TROPOSPHERE_TOP_METERS,
    shape,
    detail,
    jitter,
    bands,
    shellSpecies,
  });

  let highestBakedTop = CLOUD_TROPOSPHERE_TOP_METERS;

  for (let j = 0; j < atlasHeight; j++) {
    for (let i = 0; i < atlasWidth; i++) {
      const direction = atlasTexelDirection(atlasWidth, atlasHeight, i, j);
      // Regional jitter lanes are smooth 2D noise over the sphere.
      const { u, v } = directionToAtlasUV(direction);
      const jr = regionalA(u * 4, v * 2, 0.37);
      const jd = regionalB(u * 4, v * 2, 0.71);
      const weather = sampleWeather(system, direction, hours);
      const texel = (j * atlasWidth + i) * JITTER_ATLAS_CHANNELS;
      jitter.data[texel] = jr;
      jitter.data[texel + 1] = jd;
      jitter.data[texel + 2] = clamp(weather.elevationMeters / maxTerrainMeters);
      jitter.data[texel + 3] = 0;
      const resolved = resolveSpeciesBands(weather, { base01: jr, depth01: jd });
      for (const band of resolved) {
        const layer = shellSpecies.indexOf(band.species);
        if (layer < 0) continue; // special family: own render path, not in shell
        const offset = ((layer * atlasHeight + j) * atlasWidth + i)
          * BANDS_ATLAS_CHANNELS;
        bands.data[offset] = band.weight;
        bands.data[offset + 1] = band.baseMeters;
        bands.data[offset + 2] = band.topMeters;
        bands.data[offset + 3] = 1;
        highestBakedTop = Math.max(highestBakedTop, band.topMeters);
      }
    }
  }

  // Inpaint absent texels with a present neighbour's band geometry (weight
  // stays 0). Without this, bilinear sampling between a present texel
  // (base 3000 m) and an absent one (base 0) invents a phantom band around
  // 1500 m just inside the coverage boundary — a hole between the density
  // function and the occupancy volume, i.e. a C1 break at texel scale.
  // One 8-neighbour diffusion pass is exact: the bilinear footprint is the
  // 4 surrounding texels, so geometry only ever needs to travel one texel.
  inpaintBandsAtlas(bands);
  const fineTopGuard = shellSpecies.reduce((largest, species) => Math.max(largest,
    species.baseJitter * FINE_BASE_JITTER_FRACTION
      + species.depthJitter * FINE_DEPTH_JITTER_FRACTION), 0);
  fields.shellTopMeters = Math.ceil(highestBakedTop + fineTopGuard + 30);
  return fields;
}

export function cloudFieldByteLength(fields) {
  if (!fields || fields.kind !== 'cloud-fields') {
    throw new TypeError('cloudFieldByteLength() expects cloud fields');
  }
  return ['shape', 'detail', 'jitter', 'bands']
    .reduce((bytes, key) => bytes + fields[key].data.byteLength, 0);
}

// Workers cannot structured-clone the sampler closures attached to a cloud
// field. Transfer the byte-owning records and restore the tiny deterministic
// sampling surface on the receiving thread instead. The arrays themselves are
// transferred, not copied, so a production 40+ MiB field never exists twice.
export function serializeCloudFields(fields) {
  if (!fields || fields.kind !== 'cloud-fields') {
    throw new TypeError('serializeCloudFields() expects cloud fields');
  }
  return {
    kind: fields.kind,
    version: fields.version,
    seed: fields.seed,
    hours: fields.hours,
    groundR: fields.groundR,
    maxTerrainMeters: fields.maxTerrainMeters,
    shellTopMeters: fields.shellTopMeters,
    shape: fields.shape,
    detail: fields.detail,
    jitter: fields.jitter,
    bands: fields.bands,
    shellSpeciesIds: fields.shellSpecies.map((species) => species.id),
  };
}

export function hydrateCloudFields(payload) {
  if (!payload || payload.kind !== 'cloud-fields') {
    throw new TypeError('hydrateCloudFields() expects serialized cloud fields');
  }
  const byId = new Map(CLOUD_SHELL_SPECIES.map((species) => [species.id, species]));
  const shellSpecies = (payload.shellSpeciesIds || [])
    .map((id) => byId.get(id)).filter(Boolean);
  if (shellSpecies.length !== CLOUD_SHELL_SPECIES.length) {
    throw new Error('hydrateCloudFields(): shell species contract mismatch');
  }
  return attachCloudFieldMethods({
    ...payload,
    shellSpecies,
    system: null,
  });
}

export function cloudFieldTransferables(fields) {
  return [fields.shape, fields.detail, fields.jitter, fields.bands]
    .map((field) => field.data.buffer);
}

function inpaintBandsAtlas(bands) {
  const { width, height, layers, channels, data } = bands;
  const at = (layer, x, y, channel) => {
    const wx = ((x % width) + width) % width;
    const wy = clamp(y, 0, height - 1);
    return data[((layer * height + wy) * width + wx) * channels + channel];
  };
  for (let layer = 0; layer < layers; layer++) {
    const fill = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (at(layer, x, y, 0) > 0) continue;
        let base = 0, top = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (at(layer, x + dx, y + dy, 0) > 0) {
              base += at(layer, x + dx, y + dy, 1);
              top += at(layer, x + dx, y + dy, 2);
              count++;
            }
          }
        }
        if (count > 0) fill.push([x, y, base / count, top / count]);
      }
    }
    for (const [x, y, base, top] of fill) {
      const offset = ((layer * height + y) * width + x) * channels;
      data[offset + 1] = base;
      data[offset + 2] = top;
      data[offset + 3] = 1;
    }
  }
}

// Sample the bands atlas for one direction: the GPU read path. Returns the
// same array shape as resolveSpeciesBands (species, baseMeters, topMeters,
// weight) so downstream code cannot tell which path produced it.
export function sampleBandsAtlas(fields, direction, fp32 = false) {
  const { bands } = fields;
  const { width, height, layers, channels, data } = bands;
  const round = fp32 ? Math.fround : (v) => v;
  const { u, v } = directionToAtlasUV(direction);
  const gx = round(u * width - 0.5);
  const gy = round(v * height - 0.5);
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = round(gx - x0), fy = round(gy - y0);
  const out = [];
  for (let layer = 0; layer < layers; layer++) {
    const idx = (ix, iy, channel) => {
      const wx = ((ix % width) + width) % width;
      const wy = clamp(iy, 0, height - 1);
      return round(data[((layer * height + wy) * width + wx) * channels + channel]);
    };
    const sample = (channel) => round(lerp(
      lerp(idx(x0, y0, channel), idx(x0 + 1, y0, channel), fx),
      lerp(idx(x0, y0 + 1, channel), idx(x0 + 1, y0 + 1, channel), fx),
      fy,
    ));
    const weight = sample(0);
    if (weight < SPECIES_WEIGHT_EPSILON * 0.5) continue;
    out.push({
      species: fields.shellSpecies[layer],
      weight,
      baseMeters: sample(1),
      topMeters: sample(2),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Band resolution (D5/D6/C4)
// ---------------------------------------------------------------------------

// Resolve which species occupy which altitude band at one point.
//
// `weather` is a sampleWeather() result; `jitter` is { base01, depth01 } in
// [0,1), the REGIONAL jitter lanes (fields.sampleRegionalJitter). Altitudes
// are absolute metres above the reference surface, terrain-inclusive: an
// LCL-referenced genus forms above the LOCAL ground, so a plateau's deck
// sits kilometres above the marine one (S1b), and orographic species track
// the relief that forces them.
//
// Returns [{ species, baseMeters, topMeters, weight }] — phase 3's per-ray
// altitude-band clipping (D2) and the bands-atlas baker both consume this.
export function resolveSpeciesBands(weather, jitter = null) {
  if (!weather || weather.kind !== 'weather-sample') {
    throw new TypeError('resolveSpeciesBands() needs a sampleWeather() result');
  }
  const base01 = clamp(jitter?.base01 ?? 0.5);
  const depth01 = clamp(jitter?.depth01 ?? 0.5);
  const terrain = Math.max(0, weather.elevationMeters || 0);
  const out = [];
  for (const species of CLOUD_SPECIES) {
    const weight = weather.speciesWeights?.[species.id] ?? 0;
    if (weight < SPECIES_WEIGHT_EMIT_FLOOR) continue;
    const band = speciesAltitudeBand(
      species, weather.lclMeters, base01, depth01,
      { convective: weather.convective });
    // LCL is measured above the LOCAL surface (that is what makes a cloud
    // base a property of the air column, D5); absolute-referenced genera
    // keep their sea-level frame.
    const lift = species.baseReference === BASE_REFERENCE.LCL ? terrain : 0;
    const baseMeters = band.base + lift;
    // A tropopause-pinned top is absolute: mountains raise the cloud base, not
    // the tropopause itself. Ordinary LCL-relative decks move as one air column.
    const topMeters = typeof species.topAbsolute === 'number'
      ? Math.max(band.top, baseMeters + species.minVerticalFeature)
      : band.top + lift;
    out.push({
      species,
      baseMeters,
      topMeters,
      weight,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The density function (D1)
// ---------------------------------------------------------------------------

// Convert a planet-local position into a seamless 3D texture coordinate whose
// vertical axis follows the local radial direction. Sampling the raw radial
// vector against a local tangent basis is invalid: that projection is exactly
// zero at every point on a sphere. Scaling the radial displacement instead
// keeps horizontal movement continuous across longitude/poles while retaining
// the morphology's authored vertical stretch.
function stableNoiseCoordinates(direction, groundR, altitude,
  horizontalFeature, verticalStretch = 1) {
  const scale = 1 / (horizontalFeature * NOISE_TILE_FEATURES);
  const shapedRadius = groundR + altitude * verticalStretch;
  return {
    x: direction.x * shapedRadius * scale,
    y: direction.y * shapedRadius * scale,
    z: direction.z * shapedRadius * scale,
  };
}

export function cloudNoiseCoordinates(position, groundR, horizontalFeature,
  verticalStretch = 1) {
  const radius = Math.max(Math.hypot(position.x, position.y, position.z), 1e-9);
  const direction = {
    x: position.x / radius, y: position.y / radius, z: position.z / radius,
  };
  return stableNoiseCoordinates(direction, groundR, radius - groundR,
    horizontalFeature, verticalStretch);
}

const EMPTY_CLOUD_MEDIUM = Object.freeze({
  density: 0,
  extinctionPerMeter: 0,
  dominantSpeciesId: null,
  familyMask: 0,
  components: null,
});

function emptyCloudMedium(options) {
  return options.collectComponents
    ? { ...EMPTY_CLOUD_MEDIUM, components: [] }
    : EMPTY_CLOUD_MEDIUM;
}

// Full local participating-medium sample. Phase 4 needs more than a scalar
// density: cirrus and cumulonimbus at the same condensate fraction have very
// different extinction. Keeping that information here prevents the marcher
// from reconstructing optical properties through a second species decision.
export function cloudMediumCPU(position, weather, groundR, options = {}) {
  const fields = options.fields;
  if (!fields || fields.kind !== 'cloud-fields') {
    throw new TypeError('cloudMediumCPU() needs options.fields from createCloudFields()');
  }
  const fp32 = options.fp32 === true;
  const radius = Math.hypot(position.x, position.y, position.z);
  const altitude = radius - groundR;
  if (altitude < 0 || altitude > fields.shellTopMeters + 2000) {
    return emptyCloudMedium(options);
  }
  const direction = {
    x: position.x / radius, y: position.y / radius, z: position.z / radius,
  };
  if (altitude < fields.terrainMeters(direction, fp32) - 1) {
    return emptyCloudMedium(options);
  }

  const bands = options.directBands
    ? resolveSpeciesBands(weather, fields.sampleRegionalJitter(direction))
    : sampleBandsAtlas(fields, direction, fp32);

  const familyAmounts = new Map();
  for (const band of bands) {
    familyAmounts.set(band.species.family,
      (familyAmounts.get(band.species.family) || 0) + band.weight);
  }

  let transmittance = 1;
  let extinctionPerMeter = 0;
  let dominantSpeciesId = null;
  let dominantScore = 0;
  let familyMask = 0;
  const components = options.collectComponents ? [] : null;
  for (const band of bands) {
    if (options.speciesMask && band.species.id !== options.speciesMask) continue;
    const species = band.species;
    const params = MORPHOLOGY_PARAMS[species.morphology];

    // Fine per-patch displacement (S1a): use the same planet-stable 3D frame as
    // the shape field so neighbouring surface points genuinely sample different
    // cloud cells without longitude seams or pole singularities.
    const jitterCoord = stableNoiseCoordinates(direction, groundR, altitude,
      species.horizontalFeature, 0.31);
    const fineBase = (sampleField3(fields.shape,
      jitterCoord.x + 0.13, jitterCoord.y, jitterCoord.z, 2, fp32)
      * 2 - 1) * species.baseJitter * FINE_BASE_JITTER_FRACTION;
    const fineDepth = (sampleField3(fields.shape,
      jitterCoord.x, jitterCoord.y + 0.57, jitterCoord.z, 3, fp32)
      * 2 - 1) * species.depthJitter * FINE_DEPTH_JITTER_FRACTION;
    const base = Math.max(0, band.baseMeters + fineBase);
    let top = band.topMeters + fineBase + fineDepth;
    top = Math.max(top, base + species.minVerticalFeature * 0.75);
    if (altitude < base || altitude > top) continue;

    const t = clamp((altitude - base) / Math.max(top - base, 1));
    const profile = VERTICAL_PROFILES[species.morphology](t);
    if (profile <= 1e-3) continue;

    const shapeCoord = stableNoiseCoordinates(direction, groundR, altitude,
      species.horizontalFeature, params.vStretch);
    const fbm = sampleField3(fields.shape,
      shapeCoord.x, shapeCoord.y, shapeCoord.z, 0, fp32);
    const worley = sampleField3(fields.shape,
      shapeCoord.x + 0.31, shapeCoord.y, shapeCoord.z + 0.17, 1, fp32);
    const shapeNoise = lerp(fbm, worley, params.noiseMix);

    const familyAmount = clamp(familyAmounts.get(species.family) || 0);
    const speciesShare = clamp(band.weight / Math.max(familyAmount, 1e-6));
    // Synoptic masks have a soft transition zone. Turn that into condensate as
    // a FAMILY before splitting it among genera: a 10% mask is boundary haze,
    // not an optically thick low cloud merely because extinction is high.
    const speciesAmount = smoothstep(
      FAMILY_CONDENSATE_LOW, FAMILY_CONDENSATE_HIGH, familyAmount)
      * speciesShare;
    const shaped = smoothstep(
      SHAPE_FORMATION_LOW, SHAPE_FORMATION_HIGH, shapeNoise) * speciesAmount;
    if (shaped <= 1e-3) continue;

    let density = shaped * profile;
    const detailCoord = stableNoiseCoordinates(direction, groundR, altitude,
      species.horizontalFeature / 3.7, params.vStretch);
    const detail = sampleField3(fields.detail,
      detailCoord.x + 0.11, detailCoord.y, detailCoord.z, 0, fp32);
    density = clamp(density - detail * params.erosion * (1 - density)
      * (1 - 0.5 * profile));

    const condensate = density * params.peak;
    if (condensate <= 1e-6) continue;
    transmittance *= 1 - condensate;
    const localExtinction = condensate * species.extinctionPerKm / 1000;
    extinctionPerMeter += localExtinction;
    if (localExtinction > dominantScore) {
      dominantScore = localExtinction;
      dominantSpeciesId = species.id;
    }
    familyMask |= species.family === 'low' ? 1
      : species.family === 'mid' ? 2 : species.family === 'high' ? 4 : 8;
    if (components) components.push({
      speciesId: species.id,
      family: species.family,
      density: condensate,
      extinctionPerMeter: localExtinction,
    });
  }
  return {
    density: clamp(1 - transmittance),
    extinctionPerMeter,
    dominantSpeciesId,
    familyMask,
    components,
  };
}

// Density-only compatibility surface used by CPU fog and existing tests.
// Optical consumers should call cloudMediumCPU() so species extinction is not
// thrown away before lighting.
//
// Density at a planet-local position, in [0,1] occupied condensate fraction.
//
//   position   planet-local metres (origin = planet centre)
//   weather    a sampleWeather() result for normalize(position). Required
//              only when options.directBands is set; the default path reads
//              the baked bands atlas (exactly what the GPU samples), so the
//              render path and CPU consumers cannot disagree about weather.
//   groundR    metres from centre to ground/sea reference
//   options    { fields, speciesMask, lod, directBands, fp32 }
//              fields (from createCloudFields) is required. speciesMask
//              restricts evaluation to one species id (the sampling test
//              uses it to measure a single deck). directBands bypasses the
//              atlas and resolves bands live from `weather` (used by the
//              atlas-fidelity assertion in tools/cloudsamplingtest.js).
//              fp32 rounds all texture reads through Math.fround to emulate
//              GPU sampling arithmetic.
//
// Coverage lives in the weather system (D7); by the time a ray asks for
// density here, "is there weather at this direction" is already settled in
// the band weights.
export function cloudDensityCPU(position, weather, groundR, options = {}) {
  return cloudMediumCPU(position, weather, groundR, options).density;
}

// Equal-area optical coverage of the FINAL CPU medium, not the weather proxy.
// tau >= ln(2) means at least half of the surface radiance is obscured, matching
// weather-system's orbital definition. This is deliberately reusable by tests,
// curation and the future cloud-shadow/gameplay consumers.
export function measureCloudFieldCoverage(fields, options = {}) {
  if (!fields || fields.kind !== 'cloud-fields') {
    throw new TypeError('measureCloudFieldCoverage() expects cloud fields');
  }
  const requestedSamples = Number(options.samples ?? 512);
  const samples = Number.isFinite(requestedSamples)
    ? Math.max(64, Math.round(requestedSamples)) : 512;
  const requestedStep = Number(options.verticalStepMeters ?? 200);
  const verticalStepMeters = Number.isFinite(requestedStep)
    ? Math.max(25, requestedStep) : 200;
  const requestedThreshold = Number(
    options.opticalDepthThreshold ?? Math.log(2));
  const opticalDepthThreshold = Number.isFinite(requestedThreshold)
    ? Math.max(0, requestedThreshold) : Math.log(2);
  const golden = Math.PI * (3 - Math.sqrt(5));
  let covered = 0;
  let opticalDepthSum = 0;
  for (let index = 0; index < samples; index++) {
    const y = 1 - 2 * (index + 0.5) / samples;
    const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * golden;
    const direction = {
      x: Math.cos(angle) * horizontal,
      y,
      z: Math.sin(angle) * horizontal,
    };
    let opticalDepth = 0;
    const terrain = fields.terrainMeters(direction);
    for (let altitude = terrain + verticalStepMeters * 0.5;
      altitude < fields.shellTopMeters; altitude += verticalStepMeters) {
      const radius = fields.groundR + altitude;
      const medium = cloudMediumCPU({
        x: direction.x * radius,
        y: direction.y * radius,
        z: direction.z * radius,
      }, null, fields.groundR, { fields });
      opticalDepth += medium.extinctionPerMeter * verticalStepMeters;
    }
    opticalDepthSum += opticalDepth;
    if (opticalDepth >= opticalDepthThreshold) covered++;
  }
  return {
    coverage: covered / samples,
    covered,
    samples,
    meanOpticalDepth: opticalDepthSum / samples,
    opticalDepthThreshold,
    verticalStepMeters,
  };
}
