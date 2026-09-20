import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ChunkedLOD } from '../src/quadtree.js';

// Exercise the real builder without constructing an unrelated whole globe.
const N = 4;
const planet = { R: 6000000, hAmp: 1, gridCells: N, noSkirt: false,
  pal: { slopeLo: 0, slopeHi: 1 },
  skirtDrop: 0.081, terrainMaterial: new THREE.MeshBasicMaterial(), group: new THREE.Group(),
  freqAtLevel: (level) => level,
  height: (dir, level) => 0.137 + Math.sin(dir.y * 19000) * 0.017 + level * 0.0031 };
const lod = Object.create(ChunkedLOD.prototype);
lod.planet = planet;
const node = (u0, v0, span, level, parent = null, childX = 0, childY = 0) => {
  const center = new THREE.Vector3(1, v0 + span / 2, -(u0 + span / 2)).normalize();
  return { face: 0, u0, v0, u1: u0 + span, v1: v0 + span, level, parent,
    childX, childY, ix: 0, iy: 0, morph: 0, centerPos: center.multiplyScalar(planet.R) };
};
const parent = node(0.13, -0.17, 2 / 8192, 13);
lod.buildNodeMesh(parent);
const parentPosition = parent.mesh.geometry.getAttribute('position');
const parentLocal = parent.mesh.geometry.getAttribute('aLocal');
const parentHeight = parent.mesh.geometry.getAttribute('aSurfaceHeight');
assert.equal(parentHeight.itemSize, 2);
assert.ok(parentPosition.array instanceof Float32Array, 'GPU render attribute remains Float32.');
let worstPositionError = 0;
let oldQuantizationError = 0;
for (let j = 0; j <= N; j++) {
  for (let i = 0; i <= N; i++) {
    const index = j * (N + 1) + i;
    const dir = new THREE.Vector3(1, parent.v0 + (parent.v1 - parent.v0) * j / N,
      -(parent.u0 + (parent.u1 - parent.u0) * i / N)).normalize();
    const expected = dir.clone().multiplyScalar(planet.R + planet.height(dir, parent.level));
    assert.ok(Math.abs(parentHeight.getX(index) - planet.height(dir, parent.level)) < 1e-7,
      'Centimetre-scale authored height survives the 6 Mm radius.');
    assert.ok(Math.abs(parentHeight.getX(index) + parentHeight.getY(index)
      - planet.height(dir, parent.level - 1)) < 1e-7, 'Bootstrap fallback uses authored parent height.');
    const actual = new THREE.Vector3().fromBufferAttribute(parentPosition, index).add(parent.mesh.position);
    worstPositionError = Math.max(worstPositionError, actual.distanceTo(expected));
    oldQuantizationError = Math.max(oldQuantizationError,
      new THREE.Vector3(Math.fround(expected.x), Math.fround(expected.y), Math.fround(expected.z)).distanceTo(expected));
  }
}
assert.ok(worstPositionError < 0.0001, `Sub-millimetre rebase accuracy: ${worstPositionError}`);
assert.ok(oldQuantizationError > 0.05, 'Fixture must expose original pre-rebase Float32 loss.');

// Shader-only aLocal must NOT own the morph endpoint. Poison it independently
// of the actual parent rendered position to catch accidental future reuse.
for (let i = 0; i < parentLocal.count; i++) parentLocal.setXYZ(i,
  parentLocal.getX(i) + 32, parentLocal.getY(i) - 64, parentLocal.getZ(i) + 96);
let worstMorphError = 0;
let worstSkirtError = 0;
let worstHeightEndpointError = 0;
for (const childX of [0, 1]) for (const childY of [0, 1]) {
  const span = (parent.u1 - parent.u0) / 2;
  const child = node(parent.u0 + childX * span, parent.v0 + childY * span,
    span, 14, parent, childX, childY);
  lod.buildNodeMesh(child);
  const geometry = child.mesh.geometry;
  const position = geometry.getAttribute('position');
  const delta = geometry.getAttribute('aPositionDelta');
  const height = geometry.getAttribute('aSurfaceHeight');
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const gx = (childX + i / N) * N / 2;
    const gy = (childY + j / N) * N / 2;
    const x = Math.min(N - 1, Math.floor(gx));
    const y = Math.min(N - 1, Math.floor(gy));
    const tx = gx - x, ty = gy - y;
    const a = y * (N + 1) + x, b = a + 1, c = a + N + 1, d = c + 1;
    const indices = tx + ty <= 1 ? [a, b, c] : [b, d, c];
    const weights = tx + ty <= 1 ? [1 - tx - ty, tx, ty] : [1 - ty, tx + ty - 1, 1 - tx];
    const expected = parent.mesh.position.clone();
    for (let k = 0; k < 3; k++) expected.addScaledVector(
      new THREE.Vector3().fromBufferAttribute(parentPosition, indices[k]), weights[k]);
    const index = j * (N + 1) + i;
    const expectedHeight = indices.reduce((sum, vertex, k) => sum + parentHeight.getX(vertex) * weights[k], 0);
    worstHeightEndpointError = Math.max(worstHeightEndpointError,
      Math.abs(Math.fround(height.getX(index) + height.getY(index)) - expectedHeight));
    // Emulate the actual Float32 position + morph delta shader endpoint.
    const actual = new THREE.Vector3(
      Math.fround(position.getX(index) + delta.getX(index)),
      Math.fround(position.getY(index) + delta.getY(index)),
      Math.fround(position.getZ(index) + delta.getZ(index))).add(child.mesh.position);
    worstMorphError = Math.max(worstMorphError, actual.distanceTo(expected));
  }
  const gridCount = (N + 1) ** 2;
  for (let i = 0; i <= N; i++) {
    const top = new THREE.Vector3().fromBufferAttribute(position, i).add(child.mesh.position);
    const bottom = new THREE.Vector3().fromBufferAttribute(position, gridCount + i).add(child.mesh.position);
    worstSkirtError = Math.max(worstSkirtError, Math.abs(top.length() - bottom.length() - planet.skirtDrop));
    assert.ok(Math.abs(height.getX(i) - height.getX(gridCount + i) - planet.skirtDrop) < 1e-7,
      'Skirt scalar height is lowered by its actual radial drop.');
    assert.equal(height.getY(i), height.getY(gridCount + i), 'Skirt scalar morph follows its top.');
  }
  assert.equal(geometry.index.count, N * N * 6 + 4 * N * 12);
  assert.ok(geometry.boundingSphere.radius > 0);
  geometry.dispose();
}
assert.ok(worstMorphError < 0.0001, `Actual parent triangle endpoint: ${worstMorphError}`);
assert.ok(worstSkirtError < 0.0001, `Skirt drop survives rebase: ${worstSkirtError}`);
assert.ok(worstHeightEndpointError < 1e-7, `Parent scalar triangle endpoint: ${worstHeightEndpointError}`);
// Liquid proxy geometry does not spend an attribute slot on terrain palettes.
delete planet.pal;
const liquidNode = node(0.13, -0.17, 2 / 8192, 13);
lod.buildNodeMesh(liquidNode);
assert.equal(liquidNode.mesh.geometry.getAttribute('aSurfaceHeight'), undefined);
liquidNode.mesh.geometry.dispose();
parent.mesh.geometry.dispose(); planet.terrainMaterial.dispose();
console.log(JSON.stringify({ status: 'pass', worstPositionError, oldQuantizationError, worstMorphError, worstSkirtError, worstHeightEndpointError }));
