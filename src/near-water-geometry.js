// Shared exact geometry producer for main-thread fallback and module worker.
// Vector math uses the same vendored implementation as browser rendering.
import { Vector3 } from '../vendor/three.core.js';
function tangentBasis(direction, tangent, bitangent) {
  tangent.crossVectors(direction,
    Math.abs(direction.y) < 0.92
      ? new Vector3(0, 1, 0)
      : new Vector3(1, 0, 0)).normalize();
  bitangent.crossVectors(direction, tangent).normalize();
}


export function waterGridCoordinate(grid, index) {
  const offset = index - grid.cells / 2;
  const distance = Math.abs(offset);
  const outer = Math.max(0, distance - grid.coreCells);
  const outerCells = grid.cells / 2 - grid.coreCells;
  // Fixed metre-scale core, C1 cubic tail, unchanged outer extent. Unlike
  // camera-dependent filtering, geometry remains fine while a build is pending.
  const extra = Math.max(0, grid.size / 2 - grid.cells / 2 * grid.cellSize);
  return Math.sign(offset) * (distance * grid.cellSize + extra * (outer / outerCells) ** 3);
}

export function createWaterGeometryJob(direction, cells, seaRadius, allocate = true) {
  const count = allocate ? (cells + 1) * (cells + 1) : 0;
  const centerDirection = direction.clone().normalize();
  const tangent = new Vector3();
  const bitangent = new Vector3();
  tangentBasis(centerDirection, tangent, bitangent);
  return {
    centerDirection,
    centerPosition: centerDirection.clone().multiplyScalar(seaRadius),
    tangent,
    bitangent,
    row: 0,
    column: 0,
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    local: new Float32Array(count * 3),
    depth: new Float32Array(count),
    waterCell: new Float32Array(count),
    positionDelta: new Float32Array(count * 3),
    normalDelta: new Float32Array(count * 3),
    depthDelta: new Float32Array(count),
  };
}

export function buildWaterGeometryRows(job, field, gridCoordinate, cells, budgetMs, rowsPerFrame) {
  if (budgetMs <= 0) return { rows: 0, milliseconds: 0 };
  const sample = job.sample ||= new Vector3();
  const direction = job.direction ||= new Vector3();
  const cellNeighbor = job.cellNeighbor ||= new Vector3();
  const stride = cells + 1;
  const startedAt = performance.now();
  const firstRow = job.row;
  const end = Math.min(stride, job.row + Math.max(1, rowsPerFrame));
  let units=0;
  rows: for (let y = firstRow; y < end; y++) {
    const z = gridCoordinate(y);
    for (let x = job.column; x < stride; x++) {
      const px = gridCoordinate(x);
      const index = y * stride + x;
      sample.copy(job.centerPosition)
        .addScaledVector(job.tangent, px)
        .addScaledVector(job.bitangent, z);
      direction.copy(sample).normalize();
      sample.copy(direction).multiplyScalar(field.seaRadius);
      const offset = index * 3;
      job.position[offset] = sample.x - job.centerPosition.x;
      job.position[offset + 1] = sample.y - job.centerPosition.y;
      job.position[offset + 2] = sample.z - job.centerPosition.z;
      job.normal[offset] = direction.x;
      job.normal[offset + 1] = direction.y;
      job.normal[offset + 2] = direction.z;
      job.local[offset] = sample.x;
      job.local[offset + 1] = sample.y;
      job.local[offset + 2] = sample.z;
      job.depth[index] = field.seaLevel
        - field.height(direction, field.fullMaxFreq);
      // Actual spherical row/column neighbour spacing, including the wider
      // cell on either side of a graded-grid vertex. Not distance from the
      // camera, average cell size, or the triangle's diagonal edge length.
      let cell = 0;
      for (let neighbor = 0; neighbor < 4; neighbor++) {
        const nx = x + (neighbor === 0 ? -1 : neighbor === 1 ? 1 : 0);
        const ny = y + (neighbor === 2 ? -1 : neighbor === 3 ? 1 : 0);
        if (nx < 0 || nx > cells || ny < 0 || ny > cells) continue;
        cellNeighbor.copy(job.centerPosition)
          .addScaledVector(job.tangent, gridCoordinate(nx))
          .addScaledVector(job.bitangent, gridCoordinate(ny))
          .normalize().multiplyScalar(field.seaRadius);
        cell = Math.max(cell, cellNeighbor.distanceTo(sample));
      }
      job.waterCell[index] = cell + 0.00001; // avoid downward Float32 rounding
      job.column=x+1;
      if(++units%8===0 && performance.now()-startedAt>=budgetMs) {
        if(job.column===stride) {job.row=y+1;job.column=0;}
        break rows;
      }
    }
    job.row = y + 1;job.column=0;
    // Preserve both row and column: one 513-vertex row can itself exceed
    // the entire scene generation budget on real procedural bathymetry.
    if (performance.now() - startedAt >= budgetMs) break;
  }
  return { rows: job.row-firstRow, milliseconds: performance.now()-startedAt };
}

export const WATER_GEOMETRY_ATTRIBUTES = ['position', 'normal', 'local', 'depth',
  'waterCell', 'positionDelta', 'normalDelta', 'depthDelta'];
