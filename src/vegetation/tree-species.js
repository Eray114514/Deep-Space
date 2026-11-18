// Tree species for one planet. The ez-tree generator grows each species'
// skeleton once; this module meshes it at four levels of detail that all share
// that skeleton, so a tree keeps its silhouette from arm's length to the
// horizon:
//
//   near      full branch and leaf detail
//   mid       thinned rings and leaves (larger leaf cards keep the coverage)
//   far       trunk and main limbs, a few dozen big foliage cards
//   horizon   crossed silhouettes and an overhead projection of the crown
//
// Every level is one indexed geometry (bark and foliage merged, atlas uvs,
// vertex colours for the species tint) so the tree field can instance it with
// a single material.

import * as THREE from 'three';
import { Tree } from '../../vendor/ez-tree/tree.js';
import { makeRng } from '../rng.js';
import {
  BARK_RECT, CELL_BROADLEAF, CELL_BUSH, CELL_FROND, CELL_IMPOSTOR_0, CELL_NEEDLE,
  buildTreeAtlas, cellRect, crownTopRect,
} from './tree-atlas.js';

// archetypes: an ez-tree preset, the foliage card it wears and a target height
const ARCHETYPES = {
  oak:   { preset: 'Oak Medium',   card: 'broadleaf', bark: 'furrowed', height: [10, 15], leaf: 1.15 },
  ash:   { preset: 'Ash Medium',   card: 'broadleaf', bark: 'furrowed', height: [13, 19], leaf: 1.1 },
  aspen: { preset: 'Aspen Medium', card: 'round',     bark: 'smooth',   height: [11, 16], leaf: 1.5 },
  pine:  { preset: 'Pine Medium',  card: 'needle',    bark: 'furrowed', height: [14, 22], leaf: 1.5 },
  bush:  { preset: 'Bush 1',       card: 'round',     bark: 'furrowed', height: [1.6, 2.6], leaf: 1.2 },
  frond: { preset: 'Ash Small',    card: 'frond',     bark: 'smooth',   height: [7, 12], leaf: 1.9 },
};
const CARD_CELL = { broadleaf: CELL_BROADLEAF, needle: CELL_NEEDLE, round: CELL_BUSH, frond: CELL_FROND };

// which two tree species a world of each type grows
const TYPE_TREES = {
  lush: [['oak', 'ash', 'aspen'], ['pine', 'aspen', 'ash']],
  ocean: [['ash', 'aspen', 'frond'], ['frond', 'oak', 'pine']],
  toxic: [['frond', 'aspen'], ['frond', 'ash']],
  exotic: [['frond', 'aspen'], ['pine', 'frond']],
};
const DEFAULT_TREES = [['oak', 'aspen'], ['pine', 'ash']];

const DETAIL = {
  near: {},
  mid: { sectionStride: 5, segmentFactor: 0.4, leafStride: 10, leafScale: 3.0 },
  far: { sectionStride: 99, segmentFactor: 0.01, leafStride: 40, leafScale: 5.3 },
};

const _v = new THREE.Vector3();

// With segmentFactor near zero every ring is three vertices plus its seam
// duplicate. Dropping the rings thinner than `minRadius` removes the twigs
// (hundreds of triangles nobody can see past 200 m) and keeps trunk and limbs.
function limbTriangles(branches, minRadius) {
  const position = branches.getAttribute('position');
  const index = branches.index.array;
  const ringCount = Math.floor(position.count / 4);
  const radius = new Float32Array(ringCount);
  for (let ring = 0; ring < ringCount; ring++) {
    const a = ring * 4;
    const cx = (position.getX(a) + position.getX(a + 1) + position.getX(a + 2)) / 3;
    const cy = (position.getY(a) + position.getY(a + 1) + position.getY(a + 2)) / 3;
    const cz = (position.getZ(a) + position.getZ(a + 1) + position.getZ(a + 2)) / 3;
    radius[ring] = Math.hypot(position.getX(a) - cx, position.getY(a) - cy, position.getZ(a) - cz);
  }
  const kept = [];
  for (let i = 0; i < index.length; i += 3) {
    const r = Math.max(radius[index[i] >> 2], radius[index[i + 1] >> 2], radius[index[i + 2] >> 2]);
    if (r >= minRadius) kept.push(index[i], index[i + 1], index[i + 2]);
  }
  return kept;
}

function mergeTree({ branches, leaves }, { scale, barkColor, leafColor, cell, crownCenter, branchIndex = null, rng }) {
  const bp = branches.getAttribute('position'), bn = branches.getAttribute('normal'), bu = branches.getAttribute('uv');
  const lp = leaves.getAttribute('position'), ln = leaves.getAttribute('normal'), lu = leaves.getAttribute('uv');
  const bi = branchIndex || branches.index.array, li = leaves.index.array;
  const count = bp.count + lp.count;
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2), color = new Float32Array(count * 3);
  const rect = cellRect(cell);

  for (let i = 0; i < bp.count; i++) {
    position[i * 3] = bp.getX(i) * scale; position[i * 3 + 1] = bp.getY(i) * scale; position[i * 3 + 2] = bp.getZ(i) * scale;
    normal[i * 3] = bn.getX(i); normal[i * 3 + 1] = bn.getY(i); normal[i * 3 + 2] = bn.getZ(i);
    uv[i * 2] = BARK_RECT.u0 + Math.min(1, Math.max(0, bu.getX(i))) * (BARK_RECT.u1 - BARK_RECT.u0);
    // one bark tile per ~1.4 m of trunk, mirrored ring to ring by the mesher
    uv[i * 2 + 1] = bu.getY(i) * 0.5;
    // darker toward the ground: the cheapest contact shadow there is
    const ground = 0.62 + 0.38 * Math.min(1, (bp.getY(i) * scale) / 2.5);
    color[i * 3] = barkColor.r * ground; color[i * 3 + 1] = barkColor.g * ground; color[i * 3 + 2] = barkColor.b * ground;
  }
  for (let q = 0; q < lp.count; q += 4) {
    // one tint per card: sun-bleached outside, deep green in the crown's core
    const tint = 0.78 + rng() * 0.42;
    const hue = (rng() - 0.5) * 0.16;
    for (let k = 0; k < 4; k++) {
      const i = bp.count + q + k, s = q + k;
      const x = lp.getX(s) * scale, y = lp.getY(s) * scale, z = lp.getZ(s) * scale;
      position[i * 3] = x; position[i * 3 + 1] = y; position[i * 3 + 2] = z;
      // light the crown as one rounded volume instead of a pile of planes
      _v.set(x - crownCenter.x, (y - crownCenter.y) * 0.8, z - crownCenter.z).normalize()
        .multiplyScalar(0.75).add({ x: ln.getX(s) * 0.25, y: ln.getY(s) * 0.25 + 0.2, z: ln.getZ(s) * 0.25 }).normalize();
      normal[i * 3] = _v.x; normal[i * 3 + 1] = _v.y; normal[i * 3 + 2] = _v.z;
      uv[i * 2] = rect.u0 + lu.getX(s) * (rect.u1 - rect.u0);
      uv[i * 2 + 1] = rect.v0 + lu.getY(s) * (rect.v1 - rect.v0);
      const depth = 0.72 + 0.28 * Math.min(1, Math.hypot(x - crownCenter.x, y - crownCenter.y, z - crownCenter.z) / crownCenter.radius);
      color[i * 3] = leafColor.r * tint * depth * (1 + hue);
      color[i * 3 + 1] = leafColor.g * tint * depth;
      color[i * 3 + 2] = leafColor.b * tint * depth * (1 - hue);
    }
  }
  const index = new Uint32Array(bi.length + li.length);
  index.set(bi, 0);
  for (let i = 0; i < li.length; i++) index[bi.length + i] = li[i] + bp.count;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function horizonCard(width, height, cell, leafColor, crownHeight, footprint) {
  const rect = cellRect(cell);
  const position = [], normal = [], uv = [], color = [], index = [];
  for (let k = 0; k < 2; k++) {
    const ax = k === 0 ? 1 : 0, az = k === 0 ? 0 : 1;
    const base = position.length / 3;
    for (const [sx, sy] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]) {
      position.push(sx * width * ax, sy * height, sx * width * az);
      // lit like the canopy it stands for: mostly from above
      normal.push(0, 1, 0);
      const half = (rect.u1 - rect.u0) * 0.5;
      uv.push(rect.u0 + k * half + (sx + 0.5) * half, rect.v0 + sy * (rect.v1 - rect.v0));
      color.push(leafColor.r, leafColor.g, leafColor.b);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const top = crownTopRect(cell - CELL_IMPOSTOR_0);
  const base = position.length / 3;
  for (const [x, z] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]]) {
    position.push((footprint.x - 0.5 + x * footprint.span) * width, crownHeight,
      (footprint.z + z * footprint.span) * width);
    normal.push(0, 1, 0);
    uv.push(top.u0 + (x + 0.5) * (top.u1 - top.u0), top.v0 + (z + 0.5) * (top.v1 - top.v0));
    color.push(leafColor.r, leafColor.g, leafColor.b);
  }
  index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

function growSpecies(archetypeName, rng, colors, slot) {
  const archetype = ARCHETYPES[archetypeName];
  const tree = new Tree();
  tree.loadPreset(archetype.preset);
  const o = tree.options;
  o.seed = Math.floor(rng() * 60000);
  // one bark wrap around every branch: the atlas half cannot tile in u
  o.bark.textureScale.x = 0;
  // each planet bends the archetype a little: its own species, not a clone
  const vary = (value, amount) => value * (1 + (rng() - 0.5) * amount);
  for (const level of Object.keys(o.branch.length)) o.branch.length[level] = vary(o.branch.length[level], 0.3);
  for (const level of Object.keys(o.branch.angle)) o.branch.angle[level] = vary(o.branch.angle[level], 0.25);
  for (const level of Object.keys(o.branch.gnarliness)) o.branch.gnarliness[level] += (rng() - 0.5) * 0.08;
  o.leaves.size = vary(o.leaves.size * archetype.leaf, 0.2);
  o.leaves.roundedNormals = false;
  tree.generate();

  const full = tree.createGeometry(DETAIL.near);
  full.leaves.computeBoundingBox();
  full.branches.computeBoundingBox();
  const box = full.leaves.boundingBox.clone().union(full.branches.boundingBox);
  const height = archetype.height[0] + rng() * (archetype.height[1] - archetype.height[0]);
  const scale = height / Math.max(1e-3, box.max.y);
  const leafBox = full.leaves.boundingBox;
  const crownCenter = {
    x: (leafBox.min.x + leafBox.max.x) * 0.5 * scale,
    y: (leafBox.min.y + leafBox.max.y) * 0.5 * scale,
    z: (leafBox.min.z + leafBox.max.z) * 0.5 * scale,
    radius: Math.max(0.5, Math.hypot(leafBox.max.x - leafBox.min.x, leafBox.max.y - leafBox.min.y, leafBox.max.z - leafBox.min.z) * 0.5 * scale),
  };
  const cell = CARD_CELL[archetype.card];
  const shared = { scale, barkColor: colors.bark, leafColor: colors.leaf, cell, crownCenter };

  const bush = archetypeName === 'bush';
  // Shrubs are scattered by the hundred: keep denser enlarged leaf cards so
  // distant mipmaps never cull every leaf and expose bare dark twigs.
  const mid = tree.createGeometry(bush
    ? { sectionStride: 3, segmentFactor: 0.01, leafStride: 3, leafScale: 2.35 } : DETAIL.mid);
  const far = tree.createGeometry(DETAIL.far);
  const trunkRadius = o.branch.radius[0];
  const geometries = {
    near: mergeTree(full, { ...shared, rng: makeRng('near' + o.seed) }),
    mid: mergeTree(mid, { ...shared, rng: makeRng('mid' + o.seed),
      branchIndex: bush ? limbTriangles(mid.branches, trunkRadius * 0.35) : null }),
    far: mergeTree(far, { ...shared, rng: makeRng('far' + o.seed), branchIndex: limbTriangles(far.branches, trunkRadius * 0.3) }),
  };

  // Project the actual mid-detail foliage in both side views and overhead.
  // Centre the footprint on the trunk and leave room for asymmetric branches.
  const width = 2.2 * scale * Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
  const leaves = mid.leaves.getAttribute('position');
  const clumps = [];
  for (let q = 0; q < leaves.count; q += 4) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) { x += leaves.getX(q + k); y += leaves.getY(q + k); z += leaves.getZ(q + k); }
    x *= 0.25 * scale; y *= 0.25 * scale; z *= 0.25 * scale;
    clumps.push({
      x: 0.5 + x / width, y: Math.min(0.96, y / height), z,
      r: Math.min(0.13, (o.leaves.size * DETAIL.mid.leafScale * scale * 0.47) / width),
      light: Math.min(1, Math.max(0, 0.45 + 0.5 * (y / height) + z / width)),
    });
  }
  const minX = Math.min(...clumps.map(c => c.x - c.r * 1.22));
  const maxX = Math.max(...clumps.map(c => c.x + c.r * 1.22));
  const minZ = Math.min(...clumps.map(c => c.z / width - c.r * 1.22));
  const maxZ = Math.max(...clumps.map(c => c.z / width + c.r * 1.22));
  // Fit leaning crowns around their own centre and leave a transparent
  // apron on every side for the overhead atlas mips.
  const footprint = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2,
    span: Math.max(maxX - minX, maxZ - minZ, 0.1) * 1.16 };
  const impostor = {
    clumps, footprint,
    trunk: { top: Math.min(0.9, (leafBox.min.y * scale) / height + 0.25), halfWidth: Math.max(0.006, (trunkRadius * scale) / width * 0.6) },
  };
  // an up-lit flat card reads brighter than the self-shadowing crown it replaces
  geometries.horizon = horizonCard(width, height, CELL_IMPOSTOR_0 + slot, colors.leaf.clone().multiplyScalar(0.50), crownCenter.y, footprint);
  full.branches.dispose(); full.leaves.dispose();
  mid.branches.dispose(); mid.leaves.dispose();
  far.branches.dispose(); far.leaves.dispose();
  tree.branchesMesh.geometry.dispose(); tree.leavesMesh.geometry.dispose();
  return { name: archetypeName, height, width, geometries, card: archetype.card, bark: archetype.bark, impostor,
    leafColor: colors.leaf };
}

// Everything is a pure function of the planet seed.
export function buildTreeSpecies(planet, palette) {
  const rng = makeRng(planet.seed + ':trees-v1');
  const options = TYPE_TREES[planet.type] || DEFAULT_TREES;
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const names = [pick(options[0]), pick(options[1])];
  if (names[1] === names[0]) names[1] = options[1].find((name) => name !== names[0]) || names[1];
  // Atlas luminance averages about 0.8 and foliage self-shadows, so the tint
  // is lifted to land back on the palette's canopy colour.
  // Palette colours are authored for ground seen from orbit and are far too
  // dark for a sunlit leaf. Keep the hue and bring the reflectance to that of
  // real foliage (about 0.16 in the green) and bark (about 0.12).
  const lift = (color, target) => {
    const lum = Math.max(1e-3, 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b);
    return color.clone().multiplyScalar(target / lum);
  };
  const leafColors = [lift(palette.canopy, 0.17), lift(palette.canopy2, 0.15)];
  const bark = lift(palette.trunk, 0.11);
  const species = names.map((name, slot) => growSpecies(name, rng, { bark, leaf: leafColors[slot] }, slot));
  const shrub = growSpecies('bush', rng, {
    bark, leaf: lift(palette.canopy.clone().lerp(palette.canopy2, 0.35), 0.16),
  }, 2);
  const atlas = buildTreeAtlas(planet.intSeed | 0, rng, [...species, shrub]);
  return { species, shrub, atlas };
}

export function disposeTreeSpecies(trees) {
  if (!trees) return;
  for (const entry of [...trees.species, trees.shrub]) {
    for (const geometry of Object.values(entry.geometries)) geometry.dispose();
  }
  trees.atlas.dispose();
}
