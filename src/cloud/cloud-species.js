// Cloud species table — the authoritative vertical/optical/morphological
// contract for every cloud genus the renderer can produce.
//
// This module is DELIBERATELY dependency-free pure data. Design decision D1
// ("one density function") requires the CPU density evaluator, a future GLSL
// consumer, the occupancy baker and the weather system to agree on every constant.
// The moment this file imports THREE or TSL it can no longer be read by the CPU
// path, and the two implementations start to drift — which is exactly how the
// previous implementation ended up with CPU transit fog disagreeing with the
// rendered deck. Keep it importable from anywhere, including tests.
//
// This table is CPU input data, not proof that production draws these species.
// See docs/cloud-weather-contract.md and docs/cloud-atmosphere-rewrite.md.

// Cloud-base reference frame.
//
// 'lcl'      — base tracks the per-point lifting condensation level. Every low
//              cloud does this in reality: the deck forms exactly where rising
//              surface air reaches saturation, so its altitude follows local
//              humidity and temperature. This is requirement S1(b)/D5, and the
//              reason the old global constant base read as a ceiling.
// 'absolute' — base sits at a fixed altitude set by mid/upper-troposphere
//              moisture, independent of surface conditions (D5 applies only to
//              the low family).
export const BASE_REFERENCE = Object.freeze({
  LCL: 'lcl',
  ABSOLUTE: 'absolute',
});

// Morphology drives how the shared noise cascade is shaped into a genus. These
// are not cosmetic labels: each one selects a different density transfer curve
// in the density function, so a stratus sheet cannot come out looking like a
// cumulus tower even at identical coverage.
export const MORPHOLOGY = Object.freeze({
  SHEET: 'sheet',              // featureless stratiform layer
  CELLULAR: 'cellular',        // regular closed/open cells with gaps
  CAULIFLOWER: 'cauliflower',  // convective billows, hard sunlit tops
  TOWER: 'tower',              // deep vertical development, sheared top
  WISPY: 'wispy',              // fibrous ice streaks, strongly shear-aligned
  LENS: 'lens',                // smooth standing-wave lens, no erosion
  VEIL: 'veil',                // near-uniform translucent ice veil
});

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// Extinction coefficients are quoted per kilometre at unit density fraction.
// Anchors from atmospheric optics literature: liquid water stratus and cumulus
// run roughly 20-60 /km (optical depth 10-40 for a 600 m deck, i.e. opaque),
// while cirrus ice is 0.2-2 /km (optical depth well under 3, i.e. translucent).
// The density fraction produced by the noise cascade multiplies these, so a
// partially-filled voxel is correspondingly thinner.
//
// Two properties matter for the phase 3 sampling gate:
//   minVerticalFeature — the thinnest vertical structure that MUST be resolved.
//                        The step budget is derived from the minimum of this
//                        across the species present on a ray. This is the
//                        replacement for the shell-thickness-percentage stride
//                        that caused sub-one-sample decks (§0/§1).
//   horizontalFeature  — characteristic horizontal cell/lobe size in metres.
//                        Sets the occupancy volume resolution and the detail
//                        noise frequency.
const SPECIES = [
  // ---- Low family: base tracks the per-point LCL (S1b, D5) -----------------
  {
    id: 'stratus',
    name: 'Stratus',
    nameZh: '层云',
    family: 'low',
    baseReference: BASE_REFERENCE.LCL,
    baseOffset: 0,
    depth: 600,
    // Per-point perturbation (C4): the same genus must NOT sit at one altitude
    // planet-wide. Amplitudes are absolute metres, and the two axes are
    // deliberately independent quantities:
    //
    //   baseJitter  — shifts the WHOLE deck up/down coherently. Base and top
    //                 move together, so the deck changes altitude, not
    //                 thickness. This is the C4 axis.
    //   depthJitter — varies thickness about `depth`, independent of altitude.
    //
    // Jittering base and top independently (the first attempt) was wrong: it
    // let a 600 m deck resolve to 330 m, thinner than the minVerticalFeature
    // that phase 3 derives its step budget from. A deck must move without
    // silently becoming unresolvable. `depth - depthJitter` must therefore stay
    // >= minVerticalFeature for every species; cloudspeciestest asserts it.
    baseJitter: 120,
    depthJitter: 150,
    minVerticalFeature: 400,
    horizontalFeature: 40000,
    extinctionPerKm: 25,
    morphology: MORPHOLOGY.SHEET,
    // Formation triggers, evaluated against the weather sample. Each entry is
    // a [min, max] acceptance window; the weather system converts these into a
    // species weight. Ranges are normalized 0..1 unless noted.
    triggers: {
      humidity: [0.72, 1.0],
      convective: [0.0, 0.22],
      stability: [0.55, 1.0],
    },
    precipitation: 'none',
  },
  {
    id: 'stratocumulus',
    name: 'Stratocumulus',
    nameZh: '层积云',
    family: 'low',
    baseReference: BASE_REFERENCE.LCL,
    baseOffset: 200,
    depth: 2000,
    baseJitter: 180,
    depthJitter: 320,
    minVerticalFeature: 700,
    horizontalFeature: 2200,
    extinctionPerKm: 30,
    morphology: MORPHOLOGY.CELLULAR,
    triggers: {
      humidity: [0.5, 0.9],
      convective: [0.12, 0.45],
      stability: [0.35, 0.85],
      // Marine boundary layers are where stratocumulus dominates on Earth;
      // the largest persistent decks sit over cold eastern-ocean upwelling.
      oceanic: [0.45, 1.0],
    },
    precipitation: 'drizzle',
  },
  {
    id: 'cumulusHumilis',
    name: 'Cumulus humilis',
    nameZh: '碎积云',
    family: 'low',
    baseReference: BASE_REFERENCE.LCL,
    baseOffset: 0,
    depth: 1200,
    baseJitter: 200,
    depthJitter: 260,
    // Within one genus, stronger thermals build a deeper cloud. Species
    // selection alone is not enough for D6: two cumulus-humilis cells in
    // different air columns must not share one authored ceiling.
    convectiveDepthScale: [0.78, 1.18],
    minVerticalFeature: 600,
    horizontalFeature: 800,
    extinctionPerKm: 30,
    morphology: MORPHOLOGY.CAULIFLOWER,
    triggers: {
      humidity: [0.3, 0.7],
      convective: [0.18, 0.42],
      stability: [0.3, 0.75],
    },
    precipitation: 'none',
  },
  {
    id: 'cumulusMediocris',
    name: 'Cumulus mediocris',
    nameZh: '中积云',
    family: 'low',
    baseReference: BASE_REFERENCE.LCL,
    baseOffset: 0,
    depth: 2500,
    baseJitter: 220,
    depthJitter: 520,
    convectiveDepthScale: [0.74, 1.24],
    minVerticalFeature: 800,
    horizontalFeature: 1500,
    extinctionPerKm: 40,
    morphology: MORPHOLOGY.CAULIFLOWER,
    triggers: {
      humidity: [0.4, 0.85],
      convective: [0.38, 0.66],
      stability: [0.15, 0.6],
    },
    precipitation: 'none',
  },
  {
    id: 'cumulusCongestus',
    name: 'Cumulus congestus',
    nameZh: '浓积云',
    family: 'low',
    baseReference: BASE_REFERENCE.LCL,
    baseOffset: 0,
    depth: 6000,
    baseJitter: 240,
    depthJitter: 1100,
    convectiveDepthScale: [0.70, 1.30],
    minVerticalFeature: 1000,
    horizontalFeature: 3200,
    extinctionPerKm: 55,
    morphology: MORPHOLOGY.TOWER,
    triggers: {
      humidity: [0.5, 1.0],
      convective: [0.6, 0.85],
      stability: [0.0, 0.42],
    },
    precipitation: 'shower',
  },
  {
    id: 'cumulonimbus',
    name: 'Cumulonimbus',
    nameZh: '积雨云',
    family: 'low',
    baseReference: BASE_REFERENCE.LCL,
    baseOffset: 0,
    // Absolute top: a mature storm is capped by the tropopause, not by a
    // fixed depth above its own base.
    topAbsolute: 13000,
    baseJitter: 260,
    depthJitter: 900,
    // A mature tower approaches the tropopause as CAPE rises; using a fixed
    // 13 km lid for every cumulonimbus made same-genus towers identical.
    convectiveTopRange: [9800, 13000],
    minVerticalFeature: 1200,
    horizontalFeature: 12000,
    extinctionPerKm: 80,
    morphology: MORPHOLOGY.TOWER,
    triggers: {
      humidity: [0.62, 1.0],
      convective: [0.8, 1.0],
      stability: [0.0, 0.25],
    },
    precipitation: 'storm',
    // Reaching the tropopause spreads an ice anvil downwind. The weather
    // system uses this to co-activate the anvil species.
    spawnsAnvil: true,
  },
  {
    id: 'nimbostratus',
    name: 'Nimbostratus',
    nameZh: '雨层云',
    family: 'low',
    baseReference: BASE_REFERENCE.LCL,
    baseOffset: 0,
    depth: 4500,
    baseJitter: 200,
    depthJitter: 700,
    minVerticalFeature: 1400,
    horizontalFeature: 90000,
    extinctionPerKm: 45,
    morphology: MORPHOLOGY.SHEET,
    triggers: {
      humidity: [0.78, 1.0],
      convective: [0.05, 0.4],
      stability: [0.4, 0.9],
      // Nimbostratus is a frontal cloud: it needs large-scale ascent, not
      // local convection. frontProximity is 1 at a front, 0 far from one.
      frontProximity: [0.55, 1.0],
    },
    precipitation: 'rain',
  },

  // ---- Mid family: absolute altitudes, decoupled from surface LCL ---------
  {
    id: 'altocumulus',
    name: 'Altocumulus',
    nameZh: '高积云',
    family: 'mid',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 4000,
    depth: 2500,
    baseJitter: 800,
    depthJitter: 600,
    convectiveDepthScale: [0.86, 1.14],
    minVerticalFeature: 500,
    horizontalFeature: 1200,
    extinctionPerKm: 12,
    morphology: MORPHOLOGY.CELLULAR,
    triggers: {
      midHumidity: [0.45, 0.9],
      convective: [0.1, 0.5],
      stability: [0.2, 0.7],
    },
    precipitation: 'none',
  },
  {
    id: 'altostratus',
    name: 'Altostratus',
    nameZh: '高层云',
    family: 'mid',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 3500,
    depth: 2500,
    baseJitter: 600,
    depthJitter: 800,
    minVerticalFeature: 900,
    horizontalFeature: 120000,
    extinctionPerKm: 10,
    morphology: MORPHOLOGY.VEIL,
    triggers: {
      midHumidity: [0.55, 1.0],
      convective: [0.0, 0.3],
      stability: [0.5, 1.0],
      frontProximity: [0.4, 0.95],
    },
    precipitation: 'none',
  },
  {
    id: 'lenticular',
    name: 'Lenticularis',
    nameZh: '荚状云',
    family: 'mid',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 5000,
    depth: 1200,
    baseJitter: 700,
    depthJitter: 400,
    // A standing-wave lens is genuinely thin. It sets the tightest vertical
    // sampling requirement of any mid cloud and is a useful stress case for
    // the phase 3 gate.
    minVerticalFeature: 400,
    horizontalFeature: 6000,
    extinctionPerKm: 15,
    morphology: MORPHOLOGY.LENS,
    triggers: {
      midHumidity: [0.35, 0.8],
      convective: [0.0, 0.25],
      stability: [0.6, 1.0],
      // Orographic standing waves require both relief and wind across it.
      orographicLift: [0.5, 1.0],
      windSpeed: [0.45, 1.0],
    },
    precipitation: 'none',
    // Lens clouds are locked to the terrain wave, not advected with the wind.
    terrainLocked: true,
  },

  // ---- High family: ice, absolute altitudes -------------------------------
  {
    id: 'cirrus',
    name: 'Cirrus',
    nameZh: '卷云',
    family: 'high',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 8000,
    depth: 4000,
    baseJitter: 1200,
    depthJitter: 1000,
    minVerticalFeature: 600,
    horizontalFeature: 30000,
    // Ice cloud: optical depth of a 4 km deck stays near 1.6 at unit density,
    // i.e. translucent, which is what makes real cirrus read as veil over
    // terrain rather than as white paint.
    extinctionPerKm: 0.4,
    morphology: MORPHOLOGY.WISPY,
    triggers: {
      highHumidity: [0.4, 1.0],
      shear: [0.4, 1.0],
    },
    precipitation: 'none',
  },
  {
    id: 'cirrocumulus',
    name: 'Cirrocumulus',
    nameZh: '卷积云',
    family: 'high',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 9500,
    depth: 3300,
    baseJitter: 800,
    depthJitter: 700,
    convectiveDepthScale: [0.84, 1.16],
    minVerticalFeature: 450,
    // Cirrocumulus granules are the finest horizontal structure in the table.
    horizontalFeature: 400,
    extinctionPerKm: 0.5,
    morphology: MORPHOLOGY.CELLULAR,
    triggers: {
      highHumidity: [0.45, 0.95],
      convective: [0.15, 0.55],
      shear: [0.0, 0.5],
    },
    precipitation: 'none',
  },
  {
    id: 'cirrostratus',
    name: 'Cirrostratus',
    nameZh: '卷层云',
    family: 'high',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 7500,
    depth: 3500,
    baseJitter: 900,
    depthJitter: 900,
    minVerticalFeature: 800,
    horizontalFeature: 200000,
    extinctionPerKm: 0.3,
    morphology: MORPHOLOGY.VEIL,
    triggers: {
      highHumidity: [0.5, 1.0],
      // The leading edge of a warm front, hundreds of km ahead of the surface
      // front. This is what produces haloes before a system arrives.
      frontProximity: [0.2, 0.7],
      shear: [0.2, 0.8],
    },
    precipitation: 'none',
  },
  {
    id: 'anvil',
    name: 'Incus',
    nameZh: '砧状云',
    family: 'high',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 9000,
    topAbsolute: 13000,
    baseJitter: 700,
    depthJitter: 800,
    convectiveTopRange: [10800, 13000],
    minVerticalFeature: 900,
    horizontalFeature: 45000,
    extinctionPerKm: 8,
    morphology: MORPHOLOGY.VEIL,
    triggers: {
      convective: [0.75, 1.0],
      highHumidity: [0.25, 1.0],
    },
    precipitation: 'none',
    // Only produced downwind of a tropopause-reaching tower.
    requiresParent: 'cumulonimbus',
  },

  // ---- Special ------------------------------------------------------------
  {
    id: 'noctilucent',
    name: 'Noctilucent',
    nameZh: '夜光云',
    family: 'special',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 76000,
    topAbsolute: 85000,
    baseJitter: 1500,
    depthJitter: 1500,
    minVerticalFeature: 1500,
    horizontalFeature: 60000,
    extinctionPerKm: 0.02,
    morphology: MORPHOLOGY.WISPY,
    // Mesospheric: 76-85 km is nearly six times the troposphere shell's top.
    // Including it in the shared volume would make that shell 6x taller and
    // almost entirely empty, so it renders in its own thin pass and is excluded
    // from the shell's step budget.
    volumeShell: false,
    triggers: {
      // Mesospheric ice: only at high latitude, and only visible when the
      // observer is in darkness while the cloud is still lit.
      absLatitude: [0.55, 1.0],
      nightSide: [0.5, 1.0],
    },
    precipitation: 'none',
  },
  {
    id: 'fog',
    name: 'Radiation fog',
    nameZh: '辐射雾',
    family: 'special',
    baseReference: BASE_REFERENCE.ABSOLUTE,
    baseAbsolute: 0,
    // Fog is capped by the LCL rather than by a fixed depth: it is cloud whose
    // base has reached the ground.
    topReference: BASE_REFERENCE.LCL,
    depth: 0,
    baseJitter: 0,
    depthJitter: 60,
    minVerticalFeature: 150,
    horizontalFeature: 15000,
    extinctionPerKm: 20,
    morphology: MORPHOLOGY.SHEET,
    // Ground-anchored and only ever resolved near the camera, where the ray
    // enters it directly. Its 150 m feature is four times finer than any deck in
    // the shell; letting it set the shell-wide step budget would quadruple the
    // orbital march cost to resolve something not visible from orbit.
    volumeShell: false,
    triggers: {
      humidity: [0.85, 1.0],
      windSpeed: [0.0, 0.22],
      nightSide: [0.4, 1.0],
      // Cold air pools in valleys, which is why river valleys fog first.
      terrainConcavity: [0.4, 1.0],
    },
    precipitation: 'none',
  },
];

export const CLOUD_SPECIES = Object.freeze(
  SPECIES.map((species) => Object.freeze({
    ...species,
    triggers: Object.freeze({ ...species.triggers }),
  })),
);

export const CLOUD_SPECIES_IDS = Object.freeze(
  CLOUD_SPECIES.map((species) => species.id));

const BY_ID = new Map(CLOUD_SPECIES.map((species) => [species.id, species]));

export function cloudSpecies(id) {
  const species = BY_ID.get(id);
  if (!species) throw new Error(`unknown cloud species: ${id}`);
  return species;
}

export function cloudSpeciesByFamily(family) {
  return CLOUD_SPECIES.filter((species) => species.family === family);
}

// Resolve a species' vertical extent at one point, in absolute metres above
// the reference surface.
//
// `lclMeters` is the per-point lifting condensation level and `jitter01` is a
// deterministic per-point value in [0,1) (two independent lanes) that
// implements C4: the same genus must not sit at one altitude planet-wide.
// Callers must derive jitter from position so the result is stable frame to
// frame — a time-varying jitter would make cloud decks visibly breathe.
export function speciesAltitudeBand(species, lclMeters, jitterBase = 0.5,
  jitterDepth = 0.5, environment = null) {
  const definition = typeof species === 'string' ? cloudSpecies(species) : species;
  const baseAnchor = definition.baseReference === BASE_REFERENCE.LCL
    ? lclMeters + (definition.baseOffset || 0)
    : (definition.baseAbsolute || 0);
  // Map [0,1) jitter onto a symmetric +/-amplitude offset. This shift moves the
  // ENTIRE deck, so altitude varies per point (C4) without the deck thinning.
  const shift = (jitterBase * 2 - 1) * (definition.baseJitter || 0);
  const base = Math.max(0, baseAnchor + shift);
  const floor = definition.minVerticalFeature || 60;
  // Depth varies about the authored nominal, independent of the altitude shift.
  const depthOffset = (jitterDepth * 2 - 1) * (definition.depthJitter || 0);
  // Normalize CAPE within the formation window for this genus. This keeps the
  // response physically causal without letting an unrelated global 0..1 knob
  // flatten the useful range of a species whose trigger window is narrow.
  const convectiveWindow = definition.triggers?.convective || [0, 1];
  const convective = Number.isFinite(environment?.convective)
    ? clamp01(environment.convective)
    : (convectiveWindow[0] + convectiveWindow[1]) * 0.5;
  const convectiveSpan = Math.max(1e-6,
    convectiveWindow[1] - convectiveWindow[0]);
  const convective01 = clamp01(
    (convective - convectiveWindow[0]) / convectiveSpan);
  if (definition.topReference === BASE_REFERENCE.LCL) {
    // Ground-anchored species whose ceiling is the condensation level: fog
    // fills from the surface up to where the air would saturate anyway.
    return { base, top: Math.max(lclMeters + depthOffset, base + floor) };
  }
  if (typeof definition.topAbsolute === 'number') {
    // Tropopause-pinned species. The lid is a real physical boundary, so the
    // top stays put and depth follows from wherever the base landed — a tower
    // over a humid ocean is genuinely deeper than one over a dry plateau.
    const authoredTop = Array.isArray(definition.convectiveTopRange)
      ? mix(definition.convectiveTopRange[0],
        definition.convectiveTopRange[1], convective01)
      : definition.topAbsolute;
    return { base, top: Math.max(authoredTop + depthOffset, base + floor) };
  }
  const depthScale = Array.isArray(definition.convectiveDepthScale)
    ? mix(definition.convectiveDepthScale[0],
      definition.convectiveDepthScale[1], convective01)
    : 1;
  const depth = Math.max(floor,
    ((definition.depth || 0) + depthOffset) * depthScale);
  return { base, top: base + depth };
}

// Species carried by the troposphere volume shell. Fog (ground-anchored) and
// noctilucent (mesospheric) are excluded: they occupy their own render paths, so
// they must not inflate the shell's extent or its step budget.
export const CLOUD_SHELL_SPECIES = Object.freeze(
  CLOUD_SPECIES.filter((species) => species.volumeShell !== false));

// The tightest vertical feature any SHELL species requires, in metres. Phase 3's
// step budget is derived from this: the marcher must place at least
// CLOUD_MIN_SAMPLES_PER_FEATURE samples across it. This replaces the
// shell-thickness-percentage stride that produced 0.9 samples per deck at 80
// degrees (docs/cloud-atmosphere-rewrite.md §1).
//
// This is the FLOOR on step length, not the step length everywhere. Phase 3
// derives its per-segment budget from the species actually present in that
// segment, so a segment containing only cirrus (600 m feature) steps coarser
// than one containing stratus. Using this global minimum unconditionally would
// pay the thinnest species' cost across the entire ray.
export const CLOUD_MIN_VERTICAL_FEATURE = CLOUD_SHELL_SPECIES
  .reduce((smallest, species) =>
    Math.min(smallest, species.minVerticalFeature), Infinity);

// Sampling gate constant. Four samples across the thinnest resolved feature is
// the minimum that yields interior structure rather than a flat slab; the old
// implementation delivered less than one.
export const CLOUD_MIN_SAMPLES_PER_FEATURE = 4;

// Authoritative lifting-condensation-level range, in metres. Every LCL-based
// species in this table is authored against it, so it lives here rather than in
// the weather system: the shell extent below must be computable from this file
// alone, and a weather implementation that returned an LCL outside this range
// would silently push cloud bases through the shell floor or ceiling.
//
// Physical anchors: saturated marine air condenses a few hundred metres up,
// while a hot dry continental interior can lift its condensation level past
// 4 km. Espy's approximation LCL ~ 125 * (T - Td) reaches 4200 m at a 34 K
// dewpoint depression, which is about as dry as an inhabited surface gets.
export const CLOUD_LCL_MIN_METERS = 350;
export const CLOUD_LCL_MAX_METERS = 4200;

// Worst-case ceiling of one species, over the whole LCL range and both jitter
// extremes. Taking the authored nominal instead would clip the very jitter that
// C4 requires: an LCL-based top at maximum LCL plus maximum depth jitter sits
// well above its own table row.
function speciesCeiling(species) {
  let highest = 0;
  for (const lcl of [CLOUD_LCL_MIN_METERS, CLOUD_LCL_MAX_METERS]) {
    for (const jitterBase of [0, 1]) {
      for (const jitterDepth of [0, 1]) {
        highest = Math.max(highest,
          speciesAltitudeBand(species, lcl, jitterBase, jitterDepth,
            { convective: 1 }).top);
      }
    }
  }
  return highest;
}

// Top of the volume shell, in metres above the reference surface. Sized so no
// shell species can ever be clipped by it, INCLUDING its per-point jitter.
// Phase 3 sizes the occupancy volume and the ray's altitude-band clip from this.
export const CLOUD_TROPOSPHERE_TOP_METERS = Math.ceil(
  CLOUD_SHELL_SPECIES.reduce(
    (highest, species) => Math.max(highest, speciesCeiling(species)), 0));

// Bottom of the volume shell. The lowest a shell species' base can reach is the
// minimum LCL minus that species' coherent altitude shift; fog is excluded (it
// is ground-anchored and owned by a separate near-camera path), so the shell
// floor stays well above the surface and the marcher never wastes samples on
// the clear layer requirement C3 deliberately preserves.
export const CLOUD_SHELL_FLOOR_METERS = Math.floor(
  CLOUD_SHELL_SPECIES.reduce((lowest, species) => Math.min(lowest,
    speciesAltitudeBand(species, CLOUD_LCL_MIN_METERS, 0, 0).base), Infinity));

// Full vertical extent including mesospheric species. Only the sky-dome and
// noctilucent paths need this; the troposphere shell must NOT be sized from it,
// or 85 km of near-vacuum would join the march.
export const CLOUD_ABSOLUTE_TOP_METERS = Math.ceil(CLOUD_SPECIES
  .reduce((highest, species) => Math.max(highest, speciesCeiling(species)), 0));
