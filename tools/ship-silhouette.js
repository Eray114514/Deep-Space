// Extract the top-down outer contour of the shipped Asterion GLB as an SVG
// path. The HUD deliberately stores the resulting path instead of loading the
// full 7 MB model a second time just to draw a 110 px status silhouette.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const asset = process.argv[2] || 'assets/asterion-s9-rebuilt-20260716.glb';
const resolution = 480;
const padding = 5;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const document = await io.read(asset);
const nodes = document.getRoot().listNodes().filter((node) => (
  node.getMesh() && !/Gear|LANDING|Ramp/i.test(node.getName())
));

const triangles = [];
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (const node of nodes) {
  const matrix = node.getWorldMatrix();
  for (const primitive of node.getMesh().listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    const indices = primitive.getIndices()?.getArray();
    const vertices = [];
    const point = [];
    for (let index = 0; index < position.getCount(); index++) {
      position.getElement(index, point);
      const [x, y, z] = point;
      const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      // effects.js rotates the hero 180 degrees around Y. In the HUD the
      // flight-forward -Z axis points toward the top of the display.
      const projected = [-worldX, -worldZ];
      vertices.push(projected);
      minX = Math.min(minX, projected[0]);
      minY = Math.min(minY, projected[1]);
      maxX = Math.max(maxX, projected[0]);
      maxY = Math.max(maxY, projected[1]);
    }
    const count = indices ? indices.length : vertices.length;
    for (let index = 0; index < count; index += 3) {
      triangles.push([
        vertices[indices ? indices[index] : index],
        vertices[indices ? indices[index + 1] : index + 1],
        vertices[indices ? indices[index + 2] : index + 2],
      ]);
    }
  }
}

const scale = Math.min(
  (resolution - padding * 2) / (maxX - minX),
  (resolution - padding * 2) / (maxY - minY),
);
const offsetX = padding - minX * scale;
const offsetY = padding - minY * scale;
const mask = new Uint8Array(resolution * resolution);
const edge = (a, b, x, y) => (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);

for (const triangle of triangles) {
  const points = triangle.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]);
  const signedArea = edge(points[0], points[1], points[2][0], points[2][1]);
  if (Math.abs(signedArea) < 1e-6) continue;
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))));
  const right = Math.min(resolution - 1, Math.ceil(Math.max(...points.map((point) => point[0]))));
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  const bottom = Math.min(resolution - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const a = edge(points[0], points[1], x + .5, y + .5);
      const b = edge(points[1], points[2], x + .5, y + .5);
      const c = edge(points[2], points[0], x + .5, y + .5);
      if ((a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)) {
        mask[y * resolution + x] = 1;
      }
    }
  }
}

// Close sub-pixel cracks left by quantization before tracing the exterior.
for (let pass = 0; pass < 2; pass++) {
  const next = mask.slice();
  for (let y = 1; y < resolution - 1; y++) {
    for (let x = 1; x < resolution - 1; x++) {
      if (mask[y * resolution + x]) continue;
      const neighbors = mask[(y - 1) * resolution + x] + mask[(y + 1) * resolution + x]
        + mask[y * resolution + x - 1] + mask[y * resolution + x + 1]
        + mask[(y - 1) * resolution + x - 1] + mask[(y - 1) * resolution + x + 1]
        + mask[(y + 1) * resolution + x - 1] + mask[(y + 1) * resolution + x + 1];
      if (neighbors >= 6) next[y * resolution + x] = 1;
    }
  }
  mask.set(next);
}

const edges = new Map();
const addEdge = (x1, y1, x2, y2) => {
  const key = `${x1},${y1}`;
  if (!edges.has(key)) edges.set(key, []);
  edges.get(key).push([x2, y2]);
};
for (let y = 0; y < resolution; y++) {
  for (let x = 0; x < resolution; x++) {
    if (!mask[y * resolution + x]) continue;
    if (y === 0 || !mask[(y - 1) * resolution + x]) addEdge(x, y, x + 1, y);
    if (x === resolution - 1 || !mask[y * resolution + x + 1]) addEdge(x + 1, y, x + 1, y + 1);
    if (y === resolution - 1 || !mask[(y + 1) * resolution + x]) addEdge(x + 1, y + 1, x, y + 1);
    if (x === 0 || !mask[y * resolution + x - 1]) addEdge(x, y + 1, x, y);
  }
}

const used = new Set();
const loops = [];
for (const [start, outgoing] of edges) {
  for (const first of outgoing) {
    const firstKey = `${start}>${first.join(',')}`;
    if (used.has(firstKey)) continue;
    used.add(firstKey);
    const points = [start.split(',').map(Number)];
    let current = first;
    for (let guard = 0; guard < 100000; guard++) {
      points.push(current);
      const key = current.join(',');
      if (key === start) break;
      const next = (edges.get(key) || []).find((candidate) => {
        const candidateKey = `${key}>${candidate.join(',')}`;
        if (used.has(candidateKey)) return false;
        used.add(candidateKey);
        return true;
      });
      if (!next) break;
      current = next;
    }
    if (points.length > 8 && points.at(-1).join(',') === start) loops.push(points);
  }
}

const polygonArea = (points) => Math.abs(points.slice(0, -1).reduce((sum, point, index) => {
  const next = points[(index + 1) % (points.length - 1)];
  return sum + point[0] * next[1] - next[0] * point[1];
}, 0) / 2);
loops.sort((a, b) => polygonArea(b) - polygonArea(a));
let outline = loops[0].slice(0, -1);

const distanceToSegment = (point, start, end) => {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (!dx && !dy) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
};
const simplify = (points, tolerance) => {
  if (points.length < 3) return points;
  let furthest = 0;
  let furthestIndex = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const distance = distanceToSegment(points[index], points[0], points.at(-1));
    if (distance > furthest) {
      furthest = distance;
      furthestIndex = index;
    }
  }
  if (furthest <= tolerance) return [points[0], points.at(-1)];
  const left = simplify(points.slice(0, furthestIndex + 1), tolerance);
  const right = simplify(points.slice(furthestIndex), tolerance);
  return left.slice(0, -1).concat(right);
};

let noseIndex = 0;
for (let index = 1; index < outline.length; index++) {
  if (outline[index][1] < outline[noseIndex][1]) noseIndex = index;
}
outline = outline.slice(noseIndex).concat(outline.slice(0, noseIndex), [outline[noseIndex]]);
outline = simplify(outline, 2.15);
outline.pop();
const centerX = (Math.min(...outline.map((point) => point[0])) + Math.max(...outline.map((point) => point[0]))) / 2;
const centerY = (Math.min(...outline.map((point) => point[1])) + Math.max(...outline.map((point) => point[1]))) / 2;
const radius = Math.max(...outline.map((point) => Math.hypot(point[0] - centerX, point[1] - centerY)));
const outputScale = 55 / radius;
const output = outline.map((point) => [
  (point[0] - centerX) * outputScale,
  (point[1] - centerY) * outputScale,
]);
const path = `${output.map((point, index) => (
  `${index ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`
)).join(' ')} Z`;

console.log(`asset: ${asset}`);
console.log(`meshes: ${nodes.map((node) => node.getName()).join(', ')}`);
console.log(`triangles: ${triangles.length}; contour points: ${output.length}`);
console.log(path);
