// Cloud occupancy volume — empty-space skipping and per-ray band clipping
// (phase 3, D2 + D3).
//
// This is the module that fixes the measured root cause in
// docs/cloud-atmosphere-rewrite.md §1. Restating it, because every design
// choice here follows from it: the old marcher spread a fixed step budget over
// the whole 400–14000 m shell, so step length scaled with the ray's traversal
// length rather than with the cloud being resolved. At an 80 degree view angle
// a 1500 m deck received 0.9 samples. Sub-one-sample coverage is why clouds
// read as flat blocks and why they flickered in and out as the camera moved.
//
// Two mechanisms, both required:
//
//   1. Per-ray altitude-band clipping. Before marching, intersect the ray with
//      the altitude intervals actually occupied along it, not the full
//      envelope. A ray crossing only a marine stratus deck marches ~600 m of
//      shell, not 13600 m of mostly-empty air.
//
//   2. Empty-space skipping. A coarse occupancy grid lets a ray step over
//      unoccupied space without sampling density at all. This is what pays
//      for the higher in-cloud sample density that (1) demands, and is the
//      only reason requirement R1 (quality first, but performant) is
//      satisfiable from orbit, where most of the disk is a grazing ray.
//
// THE CONSTRAINT DIRECTION IS FLIPPED vs THE OLD TABLE (doc §4 phase 3c note)
//   With a FIXED step (derived from the thinnest species, not the shell), the
//   nadir ray is the sampling-gate-critical case — its path through a 400 m
//   deck is shortest — while the 88° grazing ray is the TOTAL-STEP-critical
//   case. So the grid walk below is an exact spherical DDA, not a fixed-stride
//   loop: grazing rays cross hundreds of kilometres and must skip empty cells
//   in O(cells), never O(metres).

import {
  CLOUD_SHELL_FLOOR_METERS,
} from './cloud-species.js';
import {
  BANDS_ATLAS_CHANNELS, FINE_BASE_JITTER_FRACTION,
  FINE_DEPTH_JITTER_FRACTION, JITTER_ATLAS_CHANNELS,
} from './cloud-density.js';

export const CLOUD_OCCUPANCY_VERSION = 2;

// Occupancy grid resolution. Longitude x latitude x altitude.
//
// Sized against the horizontal feature scales in cloud-species.js rather than
// picked for roundness: at a 6000 km radius, 128 longitude cells give ~295 km
// cells, which is coarser than any single cloud but finer than a synoptic
// system — the right granularity for "could there be cloud here at all".
// 32 altitude cells over a ~14 km envelope give ~440 m, comparable to the
// thinnest species' vertical feature (400 m), so a cell boundary cannot hide
// a whole deck.
//
// Phase 7 may retune these; phase 3 must not lower them to buy performance,
// because the sampling gate depends on the grid resolving thin decks.
export const OCCUPANCY_LONGITUDE = 128;
export const OCCUPANCY_LATITUDE = 64;
export const OCCUPANCY_ALTITUDE = 32;

// A voxel is empty only when its conservative density bound falls below this.
// False occupied costs a few wasted samples; false empty punches a visible
// hole in a deck — the error is allowed to go only one way.
export const OCCUPANCY_EPSILON = 0.01;

// A species counts as present in a column when the largest atlas weight in
// the column's texel window reaches this. Well below anything visible —
// density is linear in species weight, so a 0.001 cutoff keeps skipped voxels
// below ~0.1 % before profile, shape and erosion terms shrink it further.
export const OCCUPANCY_WEIGHT_PRESENT = 0.001;

// Sampling-gate constants (doc §4 phase 3 + §9.3):
//   MIN_SAMPLES_PER_FEATURE = 4 is the acceptance gate: the thinnest species
//     present on a ray must receive at least this many samples across its
//     vertical extent at every tested view angle.
//   STEP_DIVISOR = 5 is the implementation: step = minFeature / 5. T/4 is the
//     mathematical critical value that yields exactly 4 samples under the
//     worst starting phase; /5 leaves one notch of margin so the gate holds
//     with room to spare.
//   GRAZING_COS_FLOOR caps the view-angle relaxation at 85°: step length may
//     grow as 1/cos(zenith) because each step's VERTICAL rise is what the
//     gate counts, but past 85° the geometry relaxes no further.
//   HORIZONTAL_DIVISOR keeps grazing steps fine enough to resolve the
//     species' horizontal cells laterally (cirrocumulus granules are 400 m;
//     a 1 km step would still read as blocks — doc cloud-volume-node note 4).
export const MIN_SAMPLES_PER_FEATURE = 4;
export const STEP_DIVISOR = 5;
export const GRAZING_COS_FLOOR = Math.cos((85 * Math.PI) / 180);
export const HORIZONTAL_DIVISOR = 4;
export const MIN_STEP_METERS = 40;
export const MAX_STEP_METERS = 8000;

const TAU = Math.PI * 2;

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function attachOccupancyMethods(occupancy) {
  const {
    fields, groundR, shellFloor, shellTop, lonCount, latCount, altCount, data,
    terrain,
  } = occupancy;
  const voxelIndex = (i, j, k) => ((k * latCount + j) * lonCount + i) * 4;
  occupancy.voxelAt = (position) => {
    const radius = Math.hypot(position.x, position.y, position.z);
    const altitude = radius - groundR;
    if (altitude < shellFloor || altitude >= shellTop) return null;
    const direction = {
      x: position.x / radius, y: position.y / radius, z: position.z / radius,
    };
    const u = ((Math.atan2(direction.z, direction.x) / TAU) % 1 + 1) % 1;
    const v = clamp(Math.asin(clamp(direction.y, -1, 1)) / Math.PI + 0.5);
    const i = Math.min(lonCount - 1, Math.floor(u * lonCount));
    const j = Math.min(latCount - 1, Math.floor(v * latCount));
    const k = Math.floor(
      ((altitude - shellFloor) / (shellTop - shellFloor)) * altCount);
    const offset = voxelIndex(i, j, k);
    const speciesMask = Math.round(data[offset + 3]);
    let familyMask = 0;
    for (let layer = 0; layer < fields.shellSpecies.length; layer++) {
      if ((speciesMask & (1 << layer)) === 0) continue;
      const family = fields.shellSpecies[layer].family;
      familyMask |= family === 'low' ? 1 : family === 'mid' ? 2 : 4;
    }
    return {
      i, j, k,
      maxDensityBound: data[offset],
      minFeatureMeters: data[offset + 1],
      minHorizontalFeatureMeters: data[offset + 2],
      speciesMask,
      familyMask,
      occupied: data[offset] >= OCCUPANCY_EPSILON,
    };
  };
  occupancy.terrainAtCell = (i, j) => terrain[j * lonCount + i];
  return occupancy;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Bake the occupancy volume from a cloud-fields object.
//
// Each voxel stores, in raw fp32 (the same layout the GPU texture uses):
//   R: maxDensityBound — conservative upper bound of condensate fraction
//   G: minFeatureMeters — smallest vertical feature among species present
//   B: minHorizontalFeatureMeters — smallest horizontal feature present
//   A: speciesMask — one exact bit per shell species (14 bits are exactly
//      representable in fp32). The marcher uses it for real branch-level
//      species skipping; a three-bit family mask still forced every genus in
//      that family to evaluate at every occupied step.
//
// Conservative means: never report a cell empty when any part of it could
// contain cloud. Band intervals are expanded by the full fine-displacement
// amplitude plus a regional-jitter gradient margin before classification.
export function buildOccupancyVolume(fields, options = {}) {
  if (!fields || fields.kind !== 'cloud-fields') {
    throw new TypeError('buildOccupancyVolume() expects fields from createCloudFields()');
  }
  const lonCount = Math.max(16, Math.round(options.longitude ?? OCCUPANCY_LONGITUDE));
  const latCount = Math.max(8, Math.round(options.latitude ?? OCCUPANCY_LATITUDE));
  const altCount = Math.max(8, Math.round(options.altitude ?? OCCUPANCY_ALTITUDE));

  const shellFloor = CLOUD_SHELL_FLOOR_METERS;
  const shellTop = fields.shellTopMeters;
  const groundR = fields.groundR;
  const atlas = fields.bands;
  const jitter = fields.jitter;
  const shellSpecies = fields.shellSpecies;

  const data = new Float32Array(lonCount * latCount * altCount * 4);
  const terrain = new Float32Array(lonCount * latCount);

  const voxelIndex = (i, j, k) => ((k * latCount + j) * lonCount + i) * 4;

  // The renderer reads the bands ATLAS through bilinear sampling, so the
  // occupancy volume must be conservative against the atlas — not against a
  // fresh weather resolve. A band that only exists between texels (an
  // interpolation phantom) must still be contained. For each occupancy
  // column we therefore reduce the whole atlas texel window the bilinear
  // footprint can touch: max weight, min base, max top.
  //
  // sampleField2 reads texels floor(u * W - 0.5) and +1, so the window of
  // cell [c, c+1) is floor(c/N * W - 0.5) .. ceil((c+1)/N * W - 0.5).
  const windowAxis = (cell, cells, texels) => [
    Math.floor((cell / cells) * texels - 0.5),
    Math.ceil(((cell + 1) / cells) * texels - 0.5),
  ];

  for (let j = 0; j < latCount; j++) {
    const vLo = Math.max(0, windowAxis(j, latCount, atlas.height)[0]);
    const vHi = Math.min(atlas.height - 1, windowAxis(j, latCount, atlas.height)[1]);
    for (let i = 0; i < lonCount; i++) {
      const [uLo, uHi] = windowAxis(i, lonCount, atlas.width);

      // Terrain: the MIN over the window. The ray walk skips voxels that
      // are underground everywhere in the column, and the minimum is the
      // only safe direction for a skip decision.
      let terrainMin = Infinity;
      for (let v = vLo; v <= vHi; v++) {
        for (let u = uLo; u <= uHi; u++) {
          const uu = ((u % atlas.width) + atlas.width) % atlas.width;
          const t = jitter.data[(v * atlas.width + uu)
            * JITTER_ATLAS_CHANNELS + 2];
          if (t < terrainMin) terrainMin = t;
        }
      }
      terrain[j * lonCount + i] = (Number.isFinite(terrainMin) ? terrainMin : 0)
        * fields.maxTerrainMeters;

      // Per species: conservative [low, high] over the window. A texel has
      // geometry when its band top is non-zero — this includes texels the
      // atlas inpainted from neighbours (weight 0 but real base/top), which
      // is exactly what keeps bilinear phantom bands contained. Regional
      // jitter variation across the cell is captured by the min/max itself;
      // the margins only add what the atlas cannot see: the fine
      // displacement the density function applies from shape-texture lanes
      // 2/3, plus a numeric guard.
      const expanded = [];
      for (let layer = 0; layer < shellSpecies.length; layer++) {
        const species = shellSpecies[layer];
        let weightMax = 0;
        let minBase = Infinity;
        let maxTop = 0;
        for (let v = vLo; v <= vHi; v++) {
          for (let u = uLo; u <= uHi; u++) {
            const uu = ((u % atlas.width) + atlas.width) % atlas.width;
            const offset = ((layer * atlas.height + v) * atlas.width + uu)
              * BANDS_ATLAS_CHANNELS;
            if (atlas.data[offset + 2] <= 0) continue; // no geometry
            const weight = atlas.data[offset];
            if (weight > weightMax) weightMax = weight;
            const base = atlas.data[offset + 1];
            const top = atlas.data[offset + 2];
            if (base < minBase) minBase = base;
            if (top > maxTop) maxTop = top;
          }
        }
        if (weightMax < OCCUPANCY_WEIGHT_PRESENT) continue;
        const lowMargin = species.baseJitter * FINE_BASE_JITTER_FRACTION + 30;
        const highMargin = lowMargin
          + species.depthJitter * FINE_DEPTH_JITTER_FRACTION;
        expanded.push({
          layer,
          species,
          weight: weightMax,
          low: Math.max(shellFloor, minBase - lowMargin),
          high: Math.min(shellTop, maxTop + highMargin),
        });
      }

      for (let k = 0; k < altCount; k++) {
        const cellLow = shellFloor
          + ((shellTop - shellFloor) * k) / altCount;
        const cellHigh = shellFloor
          + ((shellTop - shellFloor) * (k + 1)) / altCount;
        let bound = 0;
        let minFeature = Infinity;
        let minHorizontal = Infinity;
        let speciesMask = 0;
        for (const band of expanded) {
          if (band.high < cellLow || band.low > cellHigh) continue;
          bound += band.weight;
          minFeature = Math.min(minFeature, band.species.minVerticalFeature);
          minHorizontal = Math.min(minHorizontal, band.species.horizontalFeature);
          speciesMask |= 1 << band.layer;
        }
        const offset = voxelIndex(i, j, k);
        data[offset] = clamp(bound);
        data[offset + 1] = Number.isFinite(minFeature) ? minFeature : 0;
        data[offset + 2] = Number.isFinite(minHorizontal) ? minHorizontal : 0;
        data[offset + 3] = speciesMask;
      }
    }
  }

  const occupancy = {
    kind: 'cloud-occupancy',
    version: CLOUD_OCCUPANCY_VERSION,
    fields,
    groundR,
    shellFloor,
    shellTop,
    lonCount,
    latCount,
    altCount,
    data,
    terrain,
    hours: fields.hours,
    cellAltitudeMeters: (shellTop - shellFloor) / altCount,
  };

  // Nearest-voxel lookup. Skipping decisions must never interpolate: a
  // bilinear read between an empty and an occupied voxel can report a value
  // below the epsilon inside a real deck, which is exactly the false-empty
  // direction this structure may never take.
  return attachOccupancyMethods(occupancy);
}

export function occupancyByteLength(occupancy) {
  if (!occupancy || occupancy.kind !== 'cloud-occupancy') {
    throw new TypeError('occupancyByteLength() expects a cloud occupancy volume');
  }
  return occupancy.data.byteLength + occupancy.terrain.byteLength;
}

export function serializeOccupancyVolume(occupancy) {
  if (!occupancy || occupancy.kind !== 'cloud-occupancy') {
    throw new TypeError('serializeOccupancyVolume() expects a cloud occupancy volume');
  }
  return {
    kind: occupancy.kind,
    version: occupancy.version,
    groundR: occupancy.groundR,
    shellFloor: occupancy.shellFloor,
    shellTop: occupancy.shellTop,
    lonCount: occupancy.lonCount,
    latCount: occupancy.latCount,
    altCount: occupancy.altCount,
    data: occupancy.data,
    terrain: occupancy.terrain,
    hours: occupancy.hours,
    cellAltitudeMeters: occupancy.cellAltitudeMeters,
  };
}

export function hydrateOccupancyVolume(payload, fields = null) {
  if (!payload || payload.kind !== 'cloud-occupancy') {
    throw new TypeError('hydrateOccupancyVolume() expects serialized occupancy data');
  }
  return attachOccupancyMethods({ ...payload, fields });
}

export function occupancyTransferables(occupancy) {
  return [occupancy.data.buffer, occupancy.terrain.buffer];
}

// ---------------------------------------------------------------------------
// Ray/shell geometry
// ---------------------------------------------------------------------------

function raySphere(origin, direction, radius) {
  const b = origin.x * direction.x + origin.y * direction.y
    + origin.z * direction.z;
  const c = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z
    - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  return { near: -b - root, far: -b + root };
}

// ---------------------------------------------------------------------------
// Per-ray clipping (D2) — exact spherical DDA over the occupancy grid
// ---------------------------------------------------------------------------

// Intersect a ray with the occupied intervals along it.
//
// Returns null when the ray crosses no occupied voxel (the whole point of
// the structure: clear-sky rays cost one walk, zero density samples).
// Otherwise returns the full span plus the occupied segments:
//   { tEnter, tExit, maxDensityBound, minFeatureMeters,
//     minHorizontalFeatureMeters,
//     segments: [{ t0, t1, minFeatureMeters, minHorizontalFeatureMeters,
//                  maxDensityBound }] }
// tEnter/tExit cover the first to the last occupied voxel; segments are the
// maximal runs of occupied cells between them (gaps are for skipping).
export function clipRayToOccupancy(occupancy, origin, direction) {
  const groundR = occupancy.groundR;
  const rIn = groundR + occupancy.shellFloor;
  const rOut = groundR + occupancy.shellTop;
  // Defensive: the solvers below assume a unit direction.
  const inv = 1 / Math.max(Math.hypot(direction.x, direction.y, direction.z), 1e-12);
  const dir = { x: direction.x * inv, y: direction.y * inv, z: direction.z * inv };

  const outer = raySphere(origin, dir, rOut);
  if (!outer || outer.far <= 0) return null;
  const inner = raySphere(origin, dir, rIn);
  const sea = raySphere(origin, dir, groundR);
  const originRadius = Math.hypot(origin.x, origin.y, origin.z);

  // Walk intervals inside the shell. A ray can produce TWO shell pieces when
  // it dips through the sub-floor layer (below the shell floor, above the
  // surface) and re-emerges — that second piece is genuinely visible just
  // above the horizon, so it is only cut when the ray actually strikes the
  // planet body (the sea-level sphere is a conservative lower bound: terrain
  // never goes below it).
  const intervals = [];
  if (originRadius >= rOut) {
    intervals.push([Math.max(outer.near, 0), inner ? Math.min(inner.near, outer.far) : outer.far]);
    if (inner && inner.far < outer.far) intervals.push([inner.far, outer.far]);
  } else if (originRadius >= rIn) {
    intervals.push([0, inner && inner.near > 0 ? Math.min(inner.near, outer.far) : outer.far]);
    if (inner && inner.near > 0 && inner.far < outer.far) {
      intervals.push([inner.far, outer.far]);
    }
  } else {
    // Below the shell floor (a surface observer): the shell starts where the
    // ray exits the inner sphere going up. A downward ray strikes the
    // surface first and is cut by the sea-level clip below.
    if (inner && inner.far > 0) intervals.push([inner.far, outer.far]);
  }
  if (sea && sea.near > 0) {
    for (const interval of intervals) interval[1] = Math.min(interval[1], sea.near);
  }

  const lonCount = occupancy.lonCount;
  const latCount = occupancy.latCount;
  const altCount = occupancy.altCount;
  const cellAlt = occupancy.cellAltitudeMeters;

  const positionAt = (t) => ({
    x: origin.x + dir.x * t,
    y: origin.y + dir.y * t,
    z: origin.z + dir.z * t,
  });

  // Distance along the ray to the next crossing of each grid family. All
  // three are analytic in spherical coordinates:
  //   altitude: concentric spheres  -> raySphere
  //   longitude: half-planes through the +Y axis -> linear in t
  //   latitude: cones y = sin(lat) * r  -> quadratic in t
  const nextAltitudeCrossing = (pos, kCurrent) => {
    const radius = Math.hypot(pos.x, pos.y, pos.z);
    const radialRate = (pos.x * dir.x + pos.y * dir.y + pos.z * dir.z)
      / Math.max(radius, 1e-9);
    const kTarget = radialRate > 0 ? kCurrent + 1 : kCurrent;
    const sphereR = groundR + occupancy.shellFloor + cellAlt * kTarget;
    const hit = raySphere(pos, dir, sphereR);
    if (!hit) return Infinity;
    const t = hit.near > 1e-6 ? hit.near : hit.far;
    return t > 1e-6 ? t : Infinity;
  };

  const nextLongitudeCrossing = (pos, iCurrent) => {
    const lonRate = pos.x * dir.z - pos.z * dir.x;
    if (Math.abs(lonRate) < 1e-12) return Infinity;
    const iBoundary = iCurrent + (lonRate > 0 ? 1 : 0);
    const lon = (iBoundary / lonCount) * TAU;
    // Plane through the Y axis with normal (-sin lon, 0, cos lon).
    const nx = -Math.sin(lon), nz = Math.cos(lon);
    const denom = dir.x * nx + dir.z * nz;
    if (Math.abs(denom) < 1e-12) return Infinity;
    const t = -(pos.x * nx + pos.z * nz) / denom;
    return t > 1e-6 ? t : Infinity;
  };

  const nextLatitudeCrossing = (pos, jCurrent) => {
    if (Math.abs(dir.y) < 1e-12) return Infinity;
    const jBoundary = jCurrent + (dir.y > 0 ? 1 : 0);
    const sinLat = Math.sin(((jBoundary / latCount) - 0.5) * Math.PI);
    // Solve (pos.y + t dir.y)^2 = sin^2(lat) * |pos + t dir|^2.
    const s2 = sinLat * sinLat;
    const a = dir.y * dir.y - s2;
    const b = 2 * (pos.y * dir.y - s2
      * (pos.x * dir.x + pos.y * dir.y + pos.z * dir.z));
    const c = pos.y * pos.y - s2
      * (pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
    if (Math.abs(a) < 1e-14) {
      if (Math.abs(b) < 1e-14) return Infinity;
      const t = -c / b;
      return t > 1e-6 ? t : Infinity;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const root = Math.sqrt(disc);
    const ta = (-b - root) / (2 * a);
    const tb = (-b + root) / (2 * a);
    if (ta > 1e-6 && tb > 1e-6) return Math.min(ta, tb);
    const t = Math.max(ta, tb);
    return t > 1e-6 ? t : Infinity;
  };

  // Walk one interval with an exact DDA: each iteration advances to the
  // nearest voxel-boundary crossing, so empty space costs one iteration per
  // CELL, never one per metre — this is what makes 88° grazing rays viable.
  // The voxel is re-derived from the new position after every crossing, so a
  // solver inaccuracy can cost an extra iteration but can never skip a cell.
  const segments = [];
  const maxSteps = (lonCount + latCount * 2 + altCount * 2) * 4;

  const walkInterval = (ta, tb) => {
    if (tb - ta < 1) return;
    let t = ta + 1e-3;
    let voxel = occupancy.voxelAt(positionAt(t));
    if (!voxel) return;
    let current = null;
    let guard = 0;
    while (t < tb - 1e-6 && guard++ < maxSteps) {
      const pos = positionAt(t);
      const advance = Math.min(
        nextAltitudeCrossing(pos, voxel.k),
        nextLongitudeCrossing(pos, voxel.i),
        nextLatitudeCrossing(pos, voxel.j),
        tb - t,
      );
      if (!(advance > 0)) break;
      // Underground voxels (inside a mountain column's bounding terrain) are
      // treated as empty and skipped: occupancy is a clip accelerator, not
      // the visibility authority — the scene depth limit owns opaque
      // occlusion in the real march (volume-depth-node.js).
      const radius = Math.hypot(pos.x, pos.y, pos.z);
      const blocked = radius - groundR
        < occupancy.terrainAtCell(voxel.i, voxel.j) - 1;
      if (voxel.occupied && !blocked) {
        if (current) {
          current.t1 = t + advance;
          current.minFeatureMeters = Math.min(
            current.minFeatureMeters, voxel.minFeatureMeters);
          current.minHorizontalFeatureMeters = Math.min(
            current.minHorizontalFeatureMeters, voxel.minHorizontalFeatureMeters);
          current.maxDensityBound = Math.max(
            current.maxDensityBound, voxel.maxDensityBound);
        } else {
          current = {
            t0: t,
            t1: t + advance,
            minFeatureMeters: voxel.minFeatureMeters,
            minHorizontalFeatureMeters: voxel.minHorizontalFeatureMeters,
            maxDensityBound: voxel.maxDensityBound,
          };
        }
      } else if (current) {
        segments.push(current);
        current = null;
      }
      t += advance + 1e-4; // epsilon lands just past the boundary
      const next = occupancy.voxelAt(positionAt(t));
      if (!next) break;
      voxel = next;
    }
    if (current) segments.push(current);
  };

  for (const [ta, tb] of intervals) walkInterval(ta, tb);

  if (segments.length === 0) return null;
  return {
    tEnter: segments[0].t0,
    tExit: segments[segments.length - 1].t1,
    maxDensityBound: segments.reduce(
      (m, s) => Math.max(m, s.maxDensityBound), 0),
    minFeatureMeters: segments.reduce(
      (m, s) => Math.min(m, s.minFeatureMeters), Infinity),
    minHorizontalFeatureMeters: segments.reduce(
      (m, s) => Math.min(m, s.minHorizontalFeatureMeters), Infinity),
    segments,
  };
}

// ---------------------------------------------------------------------------
// Step strategy (the repaired budget — doc §4 phase 3c)
// ---------------------------------------------------------------------------

// Step length for one occupied segment.
//
//   minFeatureMeters             smallest vertical feature present (the
//                                quantity the old implementation ignored)
//   cosZenith                    |dot(rayDir, localUp)| at the segment: the
//                                gate counts VERTICAL rise per step, so a
//                                grazing ray may take longer steps
//   minHorizontalFeatureMeters   smallest horizontal cell present: caps the
//                                relaxation so grazing rays still resolve
//                                cells laterally
//
// The vertical-rise invariant: rise = step * |cosZenith| <= minFeature / 5
// whenever |cosZenith| >= GRAZING_COS_FLOOR, and BELOW it past 85°. So every
// species with thickness >= its minVerticalFeature gets >= 4 samples at every
// view angle, worst phase included, and the nadir ray (shortest path) is the
// critical case — not 88°, which the old fixed-budget march starved.
export function stepLengthForSegment(minFeatureMeters, cosZenith,
  minHorizontalFeatureMeters = Infinity) {
  const relaxed = (minFeatureMeters / STEP_DIVISOR)
    / Math.max(Math.abs(cosZenith), GRAZING_COS_FLOOR);
  const horizontalCap = minHorizontalFeatureMeters / HORIZONTAL_DIVISOR;
  return clamp(Math.min(relaxed, horizontalCap),
    MIN_STEP_METERS, MAX_STEP_METERS);
}

// Turn a clip result into an executable march plan: fine fixed steps inside
// occupied segments, explicit skips across the gaps. The marcher (phase 4,
// GPU) and the sampling test (CPU) both consume exactly this plan, so the
// gate measures what will actually be rendered.
export function planRayMarch(clip, origin, direction) {
  if (!clip) return null;
  const groundRUp = (t) => {
    const px = origin.x + direction.x * t;
    const py = origin.y + direction.y * t;
    const pz = origin.z + direction.z * t;
    const radius = Math.max(Math.hypot(px, py, pz), 1e-9);
    return (direction.x * px + direction.y * py + direction.z * pz) / radius;
  };
  const segments = clip.segments.map((segment) => {
    const cosZenith = Math.abs(groundRUp((segment.t0 + segment.t1) * 0.5));
    return {
      t0: segment.t0,
      t1: segment.t1,
      cosZenith,
      stepMeters: stepLengthForSegment(segment.minFeatureMeters, cosZenith,
        segment.minHorizontalFeatureMeters),
      minFeatureMeters: segment.minFeatureMeters,
      minHorizontalFeatureMeters: segment.minHorizontalFeatureMeters,
      maxDensityBound: segment.maxDensityBound,
    };
  });
  const skips = [];
  for (let s = 1; s < segments.length; s++) {
    skips.push({ t0: segments[s - 1].t1, t1: segments[s].t0 });
  }
  return { segments, skips };
}
