// Seeded procedural flora: per-planet hue palette, ez-tree species & bushes
// (built via tree-species.js), and multi-blade meadow patches. Old low-poly
// geometric placeholder flora has been retired cleanly.

import * as THREE from 'three';
import { makeRng } from './rng.js';
import { buildTreeSpecies, disposeTreeSpecies } from './vegetation/tree-species.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// paint a solid (slightly dithered) vertex color onto a geometry
function paint(geo, color, rng, jitter = 0.08) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = 1 + (rng() - 0.5) * jitter * 2;
    arr[i * 3] = color.r * k; arr[i * 3 + 1] = color.g * k; arr[i * 3 + 2] = color.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function place(geo, x, y, z, quat = null, s = 1) {
  _m.compose(_v.set(x, y, z), quat || _q.identity(),
    typeof s === 'number' ? new THREE.Vector3(s, s, s) : s);
  geo.applyMatrix4(_m);
  return geo;
}

// merge geometries (indexed or triangle-soup) that all carry position+color
function mergeGeos(list) {
  let vTotal = 0, iTotal = 0;
  for (const g of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const idx = new Uint32Array(iTotal);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    const n = g.attributes.position.count;
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < n; i++) idx[io + i] = i + vo;
      io += n;
    }
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeVertexNormals();
  return out;
}

// A meadow patch: many fine blades of nearly even height spread over a
// ~0.75 m disc, so neighbouring patches knit into continuous sward. (A tight
// clump of mixed-height blades, the previous design, reads as weeds however
// densely it is planted.) Coarser levels carry fewer, wider blades.
function buildMeadowPatch(rng, blades, rows, widthScale, spread = 0.38) {
  const white = new THREE.Color(1, 1, 1);
  const parts = [];
  for (let i = 0; i < blades; i++) {
    const r = Math.sqrt(rng()) * spread, a = rng() * Math.PI * 2;
    // even sward with the odd seed stem standing above it
    const len = rng() < 0.04 ? 0.58 + rng() * 0.2 : 0.26 + rng() * 0.2;
    const f = new THREE.PlaneGeometry(0.02 * widthScale * (0.8 + rng() * 0.4), len, 1, rows);
    f.translate(0, len / 2, 0);
    const fp = f.attributes.position;
    const curl = 0.6 + rng() * 0.6;
    for (let v = 0; v < fp.count; v++) {
      const t = Math.max(0, Math.min(1, fp.getY(v) / len));
      fp.setX(v, fp.getX(v) * (1 - t * 0.85));
      fp.setZ(v, Math.sin(t * curl) * len * 0.3);
    }
    paint(f, white, rng, 0.06);
    const pos = f.attributes.position, col = f.attributes.color;
    // live green with gentle variation; an occasional sun-bleached blade
    const dry = rng() < 0.05;
    const shade = 0.88 + rng() * 0.24;
    const tint = dry ? [1.3, 1.18, 0.72] : [shade * 0.95, shade, shade * 0.88];
    for (let v = 0; v < pos.count; v++) {
      const t = Math.max(0, Math.min(1, pos.getY(v) / len));
      // deep shade inside the sward, light at the tips
      const k = (0.32 + 0.78 * Math.pow(t, 0.7));
      col.setXYZ(v, col.getX(v) * tint[0] * k, col.getY(v) * tint[1] * k, col.getZ(v) * tint[2] * k);
    }
    _q.setFromAxisAngle(Y, rng() * Math.PI * 2).multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.1 + rng() * 0.28));
    parts.push(place(f, Math.cos(a) * r, 0, Math.sin(a) * r, _q.clone()));
  }
  const g = mergeGeos(parts);
  // normals mostly up so the sward shades with the field, with a little of
  // each blade's own facing for depth
  const nrm = g.attributes.normal;
  for (let i = 0; i < nrm.count; i++) {
    const x = nrm.getX(i) * 0.3, z = nrm.getZ(i) * 0.3;
    const l = Math.hypot(x, 1, z);
    nrm.setXYZ(i, x / l, 1 / l, z / l);
  }
  return g;
}

// planet.js caches this at construction (planet.floraPal) so the terrain
// palette can borrow the canopy colour BEFORE it gets blended — deriving it
// twice from a mutated base would drift the species colours
export function floraPalette(planet, rng) {
  const base = (planet.pal.forest || planet.pal.land[Math.min(2, planet.pal.land.length - 1)].c).clone();
  // alien hue drift: exotic/toxic worlds shift hard, lush worlds sometimes
  // drift only inside a natural green range.  Keep the two historical RNG
  // draws on ordinary worlds so later authored species remain deterministic.
  let shift;
  if (planet.type === 'exotic') shift = 0.15 + rng() * 0.5;
  else if (planet.type === 'toxic') shift = 0.1 + rng() * 0.3;
  else {
    const variant = rng();
    const hue = rng();
    shift = (hue - 0.5) * (variant < 0.12 ? 0.1 : 0.035);
  }
  const alien = planet.type === 'exotic' || planet.type === 'toxic';
  const canopy = base.clone().offsetHSL(shift, alien ? 0.18 : 0.08, alien ? 0.06 : 0.025);
  const secondHue = rng();
  const canopy2 = canopy.clone().offsetHSL(alien ? 0.3 + secondHue * 0.35 : (secondHue - 0.5) * 0.055,
    alien ? 0.05 : -0.025, (rng() - 0.5) * (alien ? 0.1 : 0.025));
  const trunk = (planet.pal.rock || base).clone()
    .lerp(new THREE.Color(0.24, 0.15, 0.1), 0.45 + rng() * 0.3);
  const accent = new THREE.Color().setHSL(rng(), 0.85, 0.58);
  return { canopy, canopy2, trunk, accent };
}

// every geometry here is a pure function of the planet seed
export function buildFlora(planet) {
  const rng = makeRng(planet.seed + ':flora');
  const pal = planet.floraPal || floraPalette(planet, rng);
  // Trees and shrubs: grown by src/vegetation/tree-species.js, drawn by the
  // tree field (farflora.js) and near scatter (scatter.js). `dispose` lets
  // the planet's generic flora teardown release the species geometry and atlas.
  const trees = buildTreeSpecies(planet, pal);
  trees.dispose = () => disposeTreeSpecies(trees);
  return {
    trees,
    shrub: trees.shrub.geometries.mid,
    // The three meshes share the same deterministic placement field. Only
    // their blade complexity changes with distance: a dense meadow therefore
    // keeps its silhouette without paying near-blade cost at the far rim.
    grass: buildMeadowPatch(makeRng(planet.seed + ':meadow-near'), 44, 3, 1),
    grassMid: buildMeadowPatch(makeRng(planet.seed + ':meadow-mid'), 16, 2, 1.7),
    grassFar: buildMeadowPatch(makeRng(planet.seed + ':meadow-far'), 7, 1, 2.8),
    // meadows lean toward the planet's canopy colour instead of bare dirt —
    // the ground tint alone made grass vanish on dark soils
    grassTint: pal.canopy.clone().offsetHSL(0, 0.08, 0.025),
  };
}
