// Saltline industrial prop & port megastructure library for Deep Space.
//
// Wraps the 36 procedural harbor/outpost props (`$g`) plus 5 standalone port
// megastructures (`Eb`: `port_crane`, `rtg_crane`, `cargo_ship`, `rigid_boat`,
// `comms_tower`). Works both with a live GPU-baked `createSaltlineMaterials`
// instance in WebGL2 and in pure Node (`materials = null`), with support for
// `'industrial'`, `'frontier'`, and `'halcyon'` color palettes.

import * as THREE from 'three';
import {
  ENGINE_PROP_SIZES,
  createPropEngine,
  disposePropEngineCaches,
} from './props-engine.js';

export const SALTLINE_PROP_SIZES = Object.freeze(
  Object.fromEntries(
    Object.entries(ENGINE_PROP_SIZES).map(([name, spec]) => [name, Object.freeze([...spec])]),
  ),
);

const VALID_SURFACES = new Set(['metal', 'concrete', 'wood', 'rubber', 'dirt']);

// Physically-plausible base PBR recipes matching Saltline's `MATERIALS` table
// when `materials = null` (pure Node tests or unbaked fallback).
const FALLBACK_MATERIALS = {
  asphalt: { color: 0x2a2b2d, roughness: 0.88, metalness: 0.0 },
  concrete: { color: 0x87857d, roughness: 0.86, metalness: 0.0 },
  concrete_dirty: { color: 0x737068, roughness: 0.9, metalness: 0.0 },
  concrete_painted: { color: 0x8e9296, roughness: 0.72, metalness: 0.0 },
  brick: { color: 0x7d4433, roughness: 0.88, metalness: 0.0 },
  floor_epoxy: { color: 0x697270, roughness: 0.36, metalness: 0.0 },
  paint_red: { color: 0x7d2219, roughness: 0.46, metalness: 0.08 },
  paint_blue: { color: 0x1f3f66, roughness: 0.46, metalness: 0.08 },
  paint_green: { color: 0x2c5a34, roughness: 0.46, metalness: 0.08 },
  paint_yellow: { color: 0xb98a1c, roughness: 0.44, metalness: 0.08 },
  paint_orange: { color: 0xb3521a, roughness: 0.44, metalness: 0.08 },
  paint_white: { color: 0xb9bcbe, roughness: 0.46, metalness: 0.06 },
  paint_grey: { color: 0x5a6068, roughness: 0.48, metalness: 0.1 },
  paint_teal: { color: 0x1f5d63, roughness: 0.46, metalness: 0.08 },
  steel_galv: { color: 0x9aa0a6, roughness: 0.48, metalness: 0.82 },
  steel_dark: { color: 0x3d4146, roughness: 0.56, metalness: 0.78 },
  steel_worn: { color: 0x8a8e92, roughness: 0.45, metalness: 0.85 },
  steel_bare: { color: 0xb4b8bb, roughness: 0.34, metalness: 0.92 },
  steel_rust: { color: 0x5d3b28, roughness: 0.88, metalness: 0.25 },
  diamond_plate: { color: 0x8d9298, roughness: 0.46, metalness: 0.84 },
  corrugated_roof: { color: 0x888d92, roughness: 0.52, metalness: 0.78 },
  chainlink: { color: 0x92989e, roughness: 0.5, metalness: 0.8, doubleSide: true, transparent: true, opacity: 0.55 },
  aluminium: { color: 0xc4c8cb, roughness: 0.38, metalness: 0.9 },
  brass: { color: 0xc29a55, roughness: 0.34, metalness: 0.92 },
  hazard_stripes: { color: 0xc6961a, roughness: 0.5, metalness: 0.06 },
  gunmetal: { color: 0x2a2d31, roughness: 0.42, metalness: 0.88 },
  anodized_black: { color: 0x121416, roughness: 0.36, metalness: 0.88 },
  polymer_black: { color: 0x17181a, roughness: 0.58, metalness: 0.02 },
  polymer_tan: { color: 0x6f6048, roughness: 0.58, metalness: 0.02 },
  rubber: { color: 0x101010, roughness: 0.86, metalness: 0.0 },
  carbon: { color: 0x1a1c1f, roughness: 0.35, metalness: 0.15 },
  glove_fabric: { color: 0x23262a, roughness: 0.84, metalness: 0.0 },
  armor_white: { color: 0xaeb3b8, roughness: 0.42, metalness: 0.12 },
  armor_orange: { color: 0xc1551a, roughness: 0.42, metalness: 0.12 },
  wood_pallet: { color: 0xa8875c, roughness: 0.84, metalness: 0.0 },
  wood_dark: { color: 0x6b5238, roughness: 0.86, metalness: 0.0 },
  plastic_blue: { color: 0x1d4c86, roughness: 0.38, metalness: 0.0 },
  plastic_red: { color: 0x8e1f1a, roughness: 0.38, metalness: 0.0 },
  plastic_grey: { color: 0x4b4f54, roughness: 0.42, metalness: 0.0 },
  tarp: { color: 0x3b4a4a, roughness: 0.62, metalness: 0.0 },
  cardboard: { color: 0x9c7e58, roughness: 0.88, metalness: 0.0 },
  rope: { color: 0x9e8964, roughness: 0.92, metalness: 0.0 },
  tire: { color: 0x18191b, roughness: 0.86, metalness: 0.0 },
  glass: { color: 0x8ca4b0, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.38 },
  glass_dirty: { color: 0x9aa4a0, roughness: 0.28, metalness: 0.05, transparent: true, opacity: 0.46 },
  hull_paint: { color: 0x1b222b, roughness: 0.5, metalness: 0.15 },
  hull_red: { color: 0x5f1f18, roughness: 0.54, metalness: 0.12 },
};

// Palette color overrides applied to painted/polymer/hull materials.
export const SALTLINE_PROP_PALETTES = Object.freeze({
  industrial: Object.freeze({}),
  frontier: Object.freeze({
    paint_red: 0x9e4724,
    paint_blue: 0x2d4152,
    paint_green: 0x44524a,
    paint_yellow: 0xc88422,
    paint_orange: 0xc46820,
    paint_white: 0xc2c5c8,
    paint_grey: 0x3d4650,
    paint_teal: 0x2f535c,
    plastic_red: 0xa84820,
    plastic_blue: 0x344b5e,
    tarp: 0x4a524e,
    hull_paint: 0x222d38,
    hull_red: 0x6b3226,
  }),
  halcyon: Object.freeze({
    paint_red: 0xd4581e,
    paint_blue: 0x323842,
    paint_green: 0x6e737b,
    paint_yellow: 0xd49524,
    paint_orange: 0xd9621f,
    paint_white: 0xdcdad4,
    paint_grey: 0x2b2e34,
    paint_teal: 0x435664,
    plastic_red: 0xc8521b,
    plastic_blue: 0x2d333c,
    tarp: 0x82878e,
    hull_paint: 0x242830,
    hull_red: 0xc8521b,
  }),
});

const FALLBACK_DECALS = {
  arrow: { color: 0x1e2022, aspect: 1, opacity: 0.8 },
  berth4: { color: 0xd8d6ce, aspect: 2.2, opacity: 0.85 },
  caution_stripes: { color: 0xc8961e, aspect: 4, opacity: 0.9 },
  csc_plate: { color: 0xb8bcc0, aspect: 1.6, opacity: 0.9 },
  grime_streak: { color: 0x24211d, aspect: 0.45, opacity: 0.25 },
  hazard_flammable: { color: 0xc43022, aspect: 1, opacity: 0.9 },
  hazard_general: { color: 0xd49b1a, aspect: 1, opacity: 0.9 },
  hazard_voltage: { color: 0xd8a31a, aspect: 1, opacity: 0.9 },
  leak_stain: { color: 0x1d1a16, aspect: 0.55, opacity: 0.28 },
  logo_a: { color: 0xd8dce0, aspect: 2.8, opacity: 0.85 },
  logo_b: { color: 0xd4882a, aspect: 2.4, opacity: 0.85 },
  logo_c: { color: 0xc8d0d4, aspect: 2.2, opacity: 0.85 },
  logo_d: { color: 0xd04a24, aspect: 2.0, opacity: 0.85 },
  no_entry: { color: 0xb8241e, aspect: 1, opacity: 0.9 },
  numbers_0_9: { color: 0x202224, aspect: 2.5, opacity: 0.85 },
  rust_run: { color: 0x5c331e, aspect: 0.4, opacity: 0.28 },
  scorch: { color: 0x141210, aspect: 1, opacity: 0.35 },
};

const LABEL_COLORS = {
  white: 0xe6e8ea,
  black: 0x1c1e20,
  yellow: 0xd8a020,
  red: 0xc43222,
  orange: 0xd4621e,
};

function createPaletteMaterialAdapter(liveMaterials, paletteName, ownedMaterials) {
  const paletteOverrides = SALTLINE_PROP_PALETTES[paletteName] || SALTLINE_PROP_PALETTES.industrial;
  const localCache = new Map();
  const decalCache = new Map();
  const hasDomCanvas = typeof document !== 'undefined' && typeof document.createElement === 'function';

  function get(name, opts = {}) {
    const paletteColor = opts.color !== undefined ? opts.color : paletteOverrides[name];
    if (liveMaterials && typeof liveMaterials.get === 'function') {
      const forwarded = paletteColor !== undefined ? { ...opts, color: paletteColor } : opts;
      return liveMaterials.get(name, forwarded);
    }

    const key = [
      name,
      opts.vertexColors ? 'v' : '',
      opts.doubleSide ? 'd' : '',
      paletteColor !== undefined ? `c${paletteColor}` : '',
    ].join('|');
    let mat = localCache.get(key);
    if (mat) return mat;

    const spec = FALLBACK_MATERIALS[name] || { color: 0x7a7e82, roughness: 0.55, metalness: 0.5 };
    mat = new THREE.MeshStandardMaterial({
      color: paletteColor !== undefined ? paletteColor : spec.color,
      roughness: spec.roughness,
      metalness: spec.metalness,
      vertexColors: Boolean(opts.vertexColors),
    });
    if (opts.doubleSide || spec.doubleSide) mat.side = THREE.DoubleSide;
    if (spec.transparent) {
      mat.transparent = true;
      mat.opacity = spec.opacity ?? 0.5;
      mat.depthWrite = false;
    }
    mat.name = `${name}_${paletteName}`;
    localCache.set(key, mat);
    ownedMaterials.add(mat);
    return mat;
  }

  function emissive(colorHex = 0xffffff, intensity = 4) {
    if (liveMaterials && typeof liveMaterials.emissive === 'function') {
      return liveMaterials.emissive(colorHex, intensity);
    }
    const key = `em|${colorHex}|${intensity}`;
    let mat = localCache.get(key);
    if (mat) return mat;
    mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex).multiplyScalar(intensity),
      toneMapped: true,
    });
    mat.name = 'emissive';
    localCache.set(key, mat);
    ownedMaterials.add(mat);
    return mat;
  }

  function fallbackDecalEntry(cacheKey, color, aspect, opacity = 0.85) {
    let entry = decalCache.get(cacheKey);
    if (entry) return entry;
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.68,
      metalness: 0.04,
      transparent: opacity < 0.99,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mat.name = cacheKey;
    ownedMaterials.add(mat);
    entry = { material: mat, aspect };
    decalCache.set(cacheKey, entry);
    return entry;
  }

  function decal(name) {
    if (liveMaterials && typeof liveMaterials.decal === 'function' && hasDomCanvas) {
      try {
        const res = liveMaterials.decal(name);
        if (res && res.material) return res;
      } catch {
        // Fall through to Node-safe fallback decal
      }
    }
    const info = FALLBACK_DECALS[name] || { color: 0xc8ccd0, aspect: 1, opacity: 0.8 };
    return fallbackDecalEntry(`decal:${name}`, info.color, info.aspect, info.opacity);
  }

  function label(text, opts = {}) {
    const str = String(text ?? '').trim() || ' ';
    if (liveMaterials && typeof liveMaterials.label === 'function' && hasDomCanvas) {
      try {
        const res = liveMaterials.label(str, opts);
        if (res && res.material) return res;
      } catch {
        // Fall through to Node-safe fallback label
      }
    }
    const colHex = LABEL_COLORS[opts.color] ?? LABEL_COLORS.white;
    const aspect = Math.max(1.2, Math.min(12, str.length * 0.58));
    return fallbackDecalEntry(`label:${opts.color || 'white'}:${aspect.toFixed(1)}`, colHex, aspect, 0.75);
  }

  function number(value, opts = {}) {
    if (liveMaterials && typeof liveMaterials.number === 'function' && hasDomCanvas) {
      try {
        const res = liveMaterials.number(value, opts);
        if (res && res.material) return res;
      } catch {
        // Fall through to Node-safe fallback number
      }
    }
    return label(String(value ?? '0'), opts);
  }

  return { get, emissive, decal, label, number };
}

export function createSaltlineProps({ materials = null, palette = 'industrial' } = {}) {
  const defaultPalette = SALTLINE_PROP_PALETTES[palette] ? palette : 'industrial';
  const names = Object.freeze(Object.keys(SALTLINE_PROP_SIZES).sort());
  const ownedMaterials = new Set();
  const createdGeometries = new Set();
  const enginesByPalette = new Map();

  function getEngineForPalette(paletteName) {
    const key = SALTLINE_PROP_PALETTES[paletteName] ? paletteName : defaultPalette;
    let entry = enginesByPalette.get(key);
    if (!entry) {
      const mats = createPaletteMaterialAdapter(materials, key, ownedMaterials);
      const engine = createPropEngine({ mats });
      entry = { mats, engine, palette: key };
      enginesByPalette.set(key, entry);
    }
    return entry;
  }

  function create(name, options = {}) {
    const {
      seed = 1,
      palette: requestedPalette,
      scale = 1,
      ...builderOpts
    } = options || {};

    const activePalette = requestedPalette
      ? (SALTLINE_PROP_PALETTES[requestedPalette] ? requestedPalette : defaultPalette)
      : defaultPalette;
    const { engine } = getEngineForPalette(activePalette);
    const spec = SALTLINE_PROP_SIZES[name] || [1, 1, 1, 'concrete', 'concrete'];
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;

    const group = engine.build(name, { ...builderOpts, seed });
    if (s !== 1) {
      group.scale.setScalar(s);
    }

    const baseSize = Array.isArray(group.userData.size) && group.userData.size.length === 3
      ? group.userData.size
      : [spec[0], spec[1], spec[2]];
    group.userData.propName = name;
    group.userData.prop = name;
    group.userData.palette = activePalette;
    group.userData.size = [baseSize[0] * s, baseSize[1] * s, baseSize[2] * s];

    const rawSurface = spec[4];
    group.userData.surface = VALID_SURFACES.has(rawSurface) ? rawSurface : 'metal';

    if (s !== 1 && Array.isArray(group.userData.colliders)) {
      group.userData.colliders = group.userData.colliders.map((c) => ({
        ...c,
        min: [c.min[0] * s, c.min[1] * s, c.min[2] * s],
        max: [c.max[0] * s, c.max[1] * s, c.max[2] * s],
      }));
    }

    group.castShadow = true;
    group.receiveShadow = true;
    group.name = name;

    group.traverse((obj) => {
      if (obj.isMesh && obj.geometry) {
        createdGeometries.add(obj.geometry);
      }
    });

    return group;
  }

  function dispose() {
    for (const { mats } of enginesByPalette.values()) {
      disposePropEngineCaches(mats);
    }
    enginesByPalette.clear();
    for (const geo of createdGeometries) {
      geo.dispose();
    }
    createdGeometries.clear();
    for (const mat of ownedMaterials) {
      mat.dispose();
    }
    ownedMaterials.clear();
  }

  return {
    names,
    sizes: SALTLINE_PROP_SIZES,
    has: (name) => Boolean(SALTLINE_PROP_SIZES[name]),
    create,
    dispose,
  };
}
