// Tree species for one planet. The ez-tree generator grows each species'
// skeleton once; this module meshes it at four silhouette-locked levels of
// detail that share that exact skeleton and deterministic per-leaf colours,
// so a tree never morphs, changes silhouette, or shifts tint as you approach:
//
//   near      full branch and leaf detail + subtle sloped-ground root flare
//   mid       smooth curved limbs + spatially stratified 34% foliage (1.5x)
//   far       trunk & primary limbs + nested stratified 12% foliage (2.25x)
//   horizon   crossed dome-lit silhouettes and an overhead crown projection
//
// Every level is one indexed geometry (bark u<0.5 and foliage u>=0.5 merged,
// vertex colours for species tint) so the tree field instances it in one draw.

import * as THREE from 'three';
import { Tree } from '../../vendor/ez-tree/tree.js';
import { Billboard } from '../../vendor/ez-tree/enums.js';
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

// Gentle, silhouette-locked LOD parameters.
// `mid` keeps curved boughs (sectionStride 2) and 34% of leaves at 1.52x
// via 3D spatial-envelope stratification (no periodic branch skipping or 3x
// balloon leaves). `far` takes a nested subset of the same priority order.
const LOD_SPECS = {
  near: { sectionStride: 1, segmentFactor: 1.0,  minBranchFrac: 0.0,  leafKeep: 1.0,  leafScale: 1.0,  grid: 0,  billboard: null },
  mid:  { sectionStride: 2, segmentFactor: 0.50, minBranchFrac: 0.10, leafKeep: 0.28, leafScale: 1.62, grid: 10, billboard: null },
  far:  { sectionStride: 6, segmentFactor: 0.25, minBranchFrac: 0.24, leafKeep: 0.15, leafScale: 2.32, grid: 7,  billboard: Billboard.Single },
  bush: { sectionStride: 2, segmentFactor: 0.40, minBranchFrac: 0.25, leafKeep: 0.42, leafScale: 1.72, grid: 8,  billboard: null },
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler();

function leafHash(seed, index, salt = 0) {
  let h = (Math.imul(index | 0, 374761393) ^ Math.imul((seed | 0) + (salt | 0), 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Mesh skeleton branches directly with exact base-radius culling (cleanly keeps
// trunk and primary limbs without leaving torn triangles) plus a subtle flared
// root collar extending -0.45 m below y=0 so trunks stay grounded on slopes.
function meshSkeletonBranches(skeletonBranches, { sectionStride, segmentFactor, minRadius, scale, rootSkirt }) {
  const verts = [], normals = [], uvs = [], indices = [];
  for (let bIndex = 0; bIndex < skeletonBranches.length; bIndex++) {
    const branch = skeletonBranches[bIndex];
    if (bIndex > 0 && branch.baseRadius < minRadius) continue;
    const { sections, segmentCount } = branch;
    if (!sections || sections.length < 2) continue;
    const segments = Math.max(3, Math.round(segmentCount * segmentFactor));
    const sampled = [];
    if (bIndex === 0 && rootSkirt > 0) {
      const s0 = sections[0];
      sampled.push({
        origin: new THREE.Vector3(s0.origin.x, s0.origin.y - rootSkirt / scale, s0.origin.z),
        orientation: s0.orientation,
        radius: s0.radius * 1.24,
      });
    }
    for (let i = 0; i < sections.length; i += sectionStride) sampled.push(sections[i]);
    if ((sections.length - 1) % sectionStride !== 0) sampled.push(sections[sections.length - 1]);

    const indexOffset = verts.length / 3;
    for (let k = 0; k < sampled.length; k++) {
      const section = sampled[k];
      let firstVertex = null, firstNormal = null;
      for (let j = 0; j < segments; j++) {
        const angle = (Math.PI * 2 * j) / segments;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const vertex = new THREE.Vector3(ca, 0, sa)
          .multiplyScalar(section.radius)
          .applyEuler(section.orientation)
          .add(section.origin);
        const normal = new THREE.Vector3(ca, 0, sa)
          .applyEuler(section.orientation)
          .normalize();
        if (j === 0) { firstVertex = vertex; firstNormal = normal; }
        verts.push(vertex.x, vertex.y, vertex.z);
        normals.push(normal.x, normal.y, normal.z);
        uvs.push(j / segments, (k % 2) === 0 ? 0 : 1);
      }
      // seam duplicate
      verts.push(firstVertex.x, firstVertex.y, firstVertex.z);
      normals.push(firstNormal.x, firstNormal.y, firstNormal.z);
      uvs.push(1, (k % 2) === 0 ? 0 : 1);
    }
    const stride = segments + 1;
    for (let k = 0; k < sampled.length - 1; k++) {
      for (let j = 0; j < segments; j++) {
        const v1 = indexOffset + k * stride + j;
        const v2 = indexOffset + k * stride + (j + 1);
        const v3 = v1 + stride;
        const v4 = v2 + stride;
        indices.push(v1, v3, v2, v2, v3, v4);
      }
    }
  }
  return { verts, normals, uvs, indices };
}

// Select a spatially uniform, silhouette-preserving subset of skeleton leaves.
// Every occupied 3D crown voxel first contributes its outermost leaf (locking
// pine branch tips and broadleaf crown lobes across all LODs); remaining quota
// is filled uniformly across voxels so no branch is ever skipped periodically.
function selectStratifiedLeafIndices(leaves, keepRatio, gridRes, crownCenterUnscaled, leafBox, seed) {
  const total = leaves.length;
  if (keepRatio >= 0.999 || total === 0) {
    const all = new Int32Array(total);
    for (let i = 0; i < total; i++) all[i] = i;
    return all;
  }
  const target = Math.max(8, Math.round(total * keepRatio));
  const min = leafBox.min, max = leafBox.max;
  const dx = Math.max(1e-3, max.x - min.x);
  const dy = Math.max(1e-3, max.y - min.y);
  const dz = Math.max(1e-3, max.z - min.z);
  const buckets = new Map();
  for (let i = 0; i < total; i++) {
    const o = leaves[i].origin;
    const gx = Math.min(gridRes - 1, Math.max(0, Math.floor(((o.x - min.x) / dx) * gridRes)));
    const gy = Math.min(gridRes - 1, Math.max(0, Math.floor(((o.y - min.y) / dy) * gridRes)));
    const gz = Math.min(gridRes - 1, Math.max(0, Math.floor(((o.z - min.z) / dz) * gridRes)));
    const key = (gx * gridRes + gy) * gridRes + gz;
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    const distSq = (o.x - crownCenterUnscaled.x) ** 2
      + ((o.y - crownCenterUnscaled.y) * 0.85) ** 2
      + (o.z - crownCenterUnscaled.z) ** 2;
    list.push({ i, distSq, h: leafHash(seed, i, 71) });
  }
  // Sort each voxel outermost-first so round 0 locks the outer silhouette.
  const orderedBuckets = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => {
      list.sort((a, b) => (b.distSq - a.distSq) || (a.h - b.h));
      return list;
    });
  // Round-robin across voxels (ordered by outermost radius on round 0)
  const chosen = [];
  let round = 0;
  while (chosen.length < target) {
    const roundCandidates = [];
    for (let b = 0; b < orderedBuckets.length; b++) {
      if (round < orderedBuckets[b].length) roundCandidates.push(orderedBuckets[b][round]);
    }
    if (!roundCandidates.length) break;
    if (round === 0) {
      // Prioritize outer silhouette voxels first if target < occupied voxel count
      roundCandidates.sort((a, b) => (b.distSq - a.distSq) || (a.h - b.h));
    } else {
      // Quasi-random uniform fill across interior voxels
      roundCandidates.sort((a, b) => a.h - b.h);
    }
    for (let k = 0; k < roundCandidates.length && chosen.length < target; k++) {
      chosen.push(roundCandidates[k].i);
    }
    round++;
  }
  chosen.sort((a, b) => a - b);
  return Int32Array.from(chosen);
}

// Build merged branch + leaf BufferGeometry using exact skeleton leaf indices so
// per-leaf colours are strictly identical across near, mid, and far LODs.
function buildMergedLod({
  skeleton, spec, trunkRadius, scale, barkColor, leafColor, cell,
  crownCenter, crownCenterUnscaled, leafBox, billboard, seed, rootSkirt,
}) {
  const b = meshSkeletonBranches(skeleton.branches, {
    sectionStride: spec.sectionStride,
    segmentFactor: spec.segmentFactor,
    minRadius: trunkRadius * spec.minBranchFrac,
    scale,
    rootSkirt,
  });
  const keptLeaves = selectStratifiedLeafIndices(
    skeleton.leaves, spec.leafKeep, spec.grid || 10, crownCenterUnscaled, leafBox, seed,
  );
  const effectiveBillboard = spec.billboard || billboard;
  const quadsPerLeaf = effectiveBillboard === Billboard.Double ? 2 : 1;
  const bVerts = b.verts.length / 3;
  const lVerts = keptLeaves.length * quadsPerLeaf * 4;
  const totalVerts = bVerts + lVerts;
  const position = new Float32Array(totalVerts * 3);
  const normal = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);
  const color = new Float32Array(totalVerts * 3);
  const rect = cellRect(cell);

  for (let i = 0; i < bVerts; i++) {
    const bx = b.verts[i * 3] * scale;
    const by = b.verts[i * 3 + 1] * scale;
    const bz = b.verts[i * 3 + 2] * scale;
    position[i * 3] = bx; position[i * 3 + 1] = by; position[i * 3 + 2] = bz;
    normal[i * 3] = b.normals[i * 3];
    normal[i * 3 + 1] = b.normals[i * 3 + 1];
    normal[i * 3 + 2] = b.normals[i * 3 + 2];
    uv[i * 2] = BARK_RECT.u0 + Math.min(1, Math.max(0, b.uvs[i * 2])) * (BARK_RECT.u1 - BARK_RECT.u0);
    uv[i * 2 + 1] = b.uvs[i * 2 + 1] * 0.5;
    // Contact AO darkening at ground & root collar
    const ground = 0.56 + 0.44 * Math.min(1, Math.max(0, (by + 0.35) / 2.8));
    color[i * 3] = barkColor.r * ground;
    color[i * 3 + 1] = barkColor.g * ground;
    color[i * 3 + 2] = barkColor.b * ground;
  }

  const leafMinY = leafBox.min.y * scale;
  const leafSpanY = Math.max(0.5, (leafBox.max.y - leafBox.min.y) * scale);
  const lIdxCount = keptLeaves.length * quadsPerLeaf * 6;
  const index = new Uint32Array(b.indices.length + lIdxCount);
  index.set(b.indices, 0);

  let vWrite = bVerts;
  let iWrite = b.indices.length;
  const rotations = effectiveBillboard === Billboard.Double ? [0, Math.PI * 0.5] : [0];
  const quadCorners = [
    [-0.5, 1, 0, 0, 1],
    [-0.5, 0, 0, 0, 0],
    [0.5, 0, 0, 1, 0],
    [0.5, 1, 0, 1, 1],
  ];

  for (let idx = 0; idx < keptLeaves.length; idx++) {
    const leafIdx = keptLeaves[idx];
    const leaf = skeleton.leaves[leafIdx];
    const size = leaf.size * spec.leafScale;
    // Keep enlarged mid/far cards centred on the original leaf midpoint rather
    // than growing outward past the twig tip, preventing crown inflation across LODs.
    const yBase = 0.5 * (leaf.size - size);
    // Pure function of (seed, skeleton leaf index) so the same leaf keeps the
    // exact same tint and warmth in near, mid, and far meshes.
    const tint = 0.80 + leafHash(seed, leafIdx, 13) * 0.38;
    const hue = (leafHash(seed, leafIdx, 37) - 0.5) * 0.14;
    const baseNormal = _v2.set(0, 0, 1).applyEuler(leaf.orientation);

    for (let r = 0; r < rotations.length; r++) {
      _e.set(0, rotations[r], 0);
      const quadBase = vWrite;
      for (let k = 0; k < 4; k++) {
        const [cx, cy, cz, lu, lv] = quadCorners[k];
        _v.set(cx * size, yBase + cy * size, cz)
          .applyEuler(_e)
          .applyEuler(leaf.orientation)
          .add(leaf.origin);
        const x = _v.x * scale, y = _v.y * scale, z = _v.z * scale;
        position[vWrite * 3] = x;
        position[vWrite * 3 + 1] = y;
        position[vWrite * 3 + 2] = z;

        // Smooth spherical crown normal blended with leaf facing for volumetric shading
        _v.set(x - crownCenter.x, (y - crownCenter.y) * 0.8, z - crownCenter.z).normalize()
          .multiplyScalar(0.76)
          .addScaledVector(baseNormal, 0.24)
          .add({ x: 0, y: 0.18, z: 0 })
          .normalize();
        normal[vWrite * 3] = _v.x;
        normal[vWrite * 3 + 1] = _v.y;
        normal[vWrite * 3 + 2] = _v.z;

        uv[vWrite * 2] = rect.u0 + lu * (rect.u1 - rect.u0);
        uv[vWrite * 2 + 1] = rect.v0 + lv * (rect.v1 - rect.v0);

        const radial = Math.min(1, Math.hypot(x - crownCenter.x, y - crownCenter.y, z - crownCenter.z) / crownCenter.radius);
        const heightK = Math.min(1, Math.max(0, (y - leafMinY) / leafSpanY));
        const ao = 0.64 + 0.22 * radial + 0.16 * heightK;
        color[vWrite * 3] = leafColor.r * tint * ao * (1 + hue);
        color[vWrite * 3 + 1] = leafColor.g * tint * ao;
        color[vWrite * 3 + 2] = leafColor.b * tint * ao * (1 - hue);
        vWrite++;
      }
      index[iWrite++] = quadBase;
      index[iWrite++] = quadBase + 1;
      index[iWrite++] = quadBase + 2;
      index[iWrite++] = quadBase;
      index[iWrite++] = quadBase + 2;
      index[iWrite++] = quadBase + 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return { geometry, keptLeaves };
}

function horizonCard(width, height, cell, leafColor, crownHeight, footprint) {
  const rect = cellRect(cell);
  const position = [], normal = [], uv = [], color = [], index = [];
  for (let k = 0; k < 2; k++) {
    const ax = k === 0 ? 1 : 0, az = k === 0 ? 0 : 1;
    const base = position.length / 3;
    for (const [sx, sy] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]) {
      position.push(sx * width * ax, sy * height, sx * width * az);
      // Outward-tilted rounded dome normals match the volumetric shading of far
      // crowns across all sun altitudes instead of flashing flat under low light.
      const nx = sx * ax * 0.75;
      const ny = sy > 0.5 ? 0.92 : 0.72;
      const nz = sx * az * 0.75;
      const inv = 1 / Math.hypot(nx, ny, nz);
      normal.push(nx * inv, ny * inv, nz * inv);
      const half = (rect.u1 - rect.u0) * 0.5;
      uv.push(rect.u0 + k * half + (sx + 0.5) * half, rect.v0 + sy * (rect.v1 - rect.v0));
      const vShade = sy > 0.5 ? 1.06 : 0.84;
      color.push(leafColor.r * vShade, leafColor.g * vShade, leafColor.b * vShade);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const top = crownTopRect(cell - CELL_IMPOSTOR_0);
  const base = position.length / 3;
  for (const [x, z] of [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]]) {
    position.push((footprint.x - 0.5 + x * footprint.span) * width, crownHeight,
      (footprint.z + z * footprint.span) * width);
    const inv = 1 / Math.hypot(x * 0.55, 0.95, z * 0.55);
    normal.push(x * 0.55 * inv, 0.95 * inv, z * 0.55 * inv);
    uv.push(top.u0 + (x + 0.5) * (top.u1 - top.u0), top.v0 + (z + 0.5) * (top.v1 - top.v0));
    color.push(leafColor.r * 0.98, leafColor.g * 0.98, leafColor.b * 0.98);
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

  // Compute canonical bounding boxes from the full generated tree
  tree.leavesMesh.geometry.computeBoundingBox();
  tree.branchesMesh.geometry.computeBoundingBox();
  const leafBox = tree.leavesMesh.geometry.boundingBox.clone();
  const box = leafBox.clone().union(tree.branchesMesh.geometry.boundingBox);
  const height = archetype.height[0] + rng() * (archetype.height[1] - archetype.height[0]);
  const scale = height / Math.max(1e-3, box.max.y);
  const crownCenterUnscaled = {
    x: (leafBox.min.x + leafBox.max.x) * 0.5,
    y: (leafBox.min.y + leafBox.max.y) * 0.5,
    z: (leafBox.min.z + leafBox.max.z) * 0.5,
  };
  const crownCenter = {
    x: crownCenterUnscaled.x * scale,
    y: crownCenterUnscaled.y * scale,
    z: crownCenterUnscaled.z * scale,
    radius: Math.max(0.5, Math.hypot(leafBox.max.x - leafBox.min.x, leafBox.max.y - leafBox.min.y, leafBox.max.z - leafBox.min.z) * 0.5 * scale),
  };

  const bush = archetypeName === 'bush';
  const cell = CARD_CELL[archetype.card];
  const trunkRadius = o.branch.radius[0];
  const rootSkirt = bush ? 0.14 : 0.45;
  const shared = {
    skeleton: tree.skeleton,
    trunkRadius,
    scale,
    barkColor: colors.bark,
    leafColor: colors.leaf,
    cell,
    crownCenter,
    crownCenterUnscaled,
    leafBox,
    billboard: o.leaves.billboard,
    seed: o.seed,
    rootSkirt,
  };

  const nearBuilt = buildMergedLod({ ...shared, spec: LOD_SPECS.near });
  const midBuilt = buildMergedLod({ ...shared, spec: bush ? LOD_SPECS.bush : LOD_SPECS.mid });
  const farBuilt = buildMergedLod({ ...shared, spec: LOD_SPECS.far });

  const geometries = {
    near: nearBuilt.geometry,
    mid: midBuilt.geometry,
    far: farBuilt.geometry,
  };

  // Project the actual stratified mid-detail foliage into both side views and
  // overhead using the real mid leaf size so horizon impostors match far crowns.
  const width = 2.2 * scale * Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
  const clumps = [];
  const impostorLeafScale = bush ? LOD_SPECS.bush.leafScale : LOD_SPECS.mid.leafScale;
  for (let i = 0; i < midBuilt.keptLeaves.length; i++) {
    const leaf = tree.skeleton.leaves[midBuilt.keptLeaves[i]];
    // Leaf card centre sits half a leaf length along its local +Y axis
    _v.set(0, leaf.size * impostorLeafScale * 0.45, 0)
      .applyEuler(leaf.orientation)
      .add(leaf.origin);
    const x = _v.x * scale, y = _v.y * scale, z = _v.z * scale;
    clumps.push({
      x: 0.5 + x / width,
      y: Math.min(0.96, Math.max(0.04, y / height)),
      z,
      r: Math.min(0.11, (leaf.size * impostorLeafScale * scale * 0.52) / width),
      light: Math.min(1, Math.max(0, 0.45 + 0.5 * (y / height) + z / width)),
    });
  }
  const minX = Math.min(...clumps.map(c => c.x - c.r * 1.22));
  const maxX = Math.max(...clumps.map(c => c.x + c.r * 1.22));
  const minZ = Math.min(...clumps.map(c => c.z / width - c.r * 1.22));
  const maxZ = Math.max(...clumps.map(c => c.z / width + c.r * 1.22));
  // Fit leaning crowns around their own centre and leave a transparent
  // apron on every side for the overhead atlas mips.
  const footprint = {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    span: Math.max(maxX - minX, maxZ - minZ, 0.1) * 1.16,
  };
  const impostor = {
    clumps, footprint,
    trunk: {
      top: Math.min(0.9, (leafBox.min.y * scale) / height + 0.25),
      halfWidth: Math.max(0.006, (trunkRadius * scale) / width * 0.6),
    },
  };
  // Dome-lit crossed cards shade darker than flat up-lit cards; 0.66 matches far crowns.
  geometries.horizon = horizonCard(width, height, CELL_IMPOSTOR_0 + slot,
    colors.leaf.clone().multiplyScalar(0.66), crownCenter.y, footprint);

  tree.branchesMesh.geometry.dispose();
  tree.leavesMesh.geometry.dispose();
  return {
    name: archetypeName, height, width, geometries, card: archetype.card, bark: archetype.bark,
    impostor, leafColor: colors.leaf,
  };
}

// Everything is a pure function of the planet seed.
export function buildTreeSpecies(planet, palette) {
  const rng = makeRng(planet.seed + ':trees-v1');
  const options = TYPE_TREES[planet.type] || DEFAULT_TREES;
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const names = [pick(options[0]), pick(options[1])];
  if (names[1] === names[0]) names[1] = options[1].find((name) => name !== names[0]) || names[1];
  // Palette colours are authored for ground seen from orbit and are far too
  // dark for a sunlit leaf. Keep the hue and bring the reflectance to that of
  // real foliage (about 0.17 in the green) and bark (about 0.11).
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
