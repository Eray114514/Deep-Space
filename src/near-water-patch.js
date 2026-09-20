import * as THREE from 'three';

const DEFAULT_CELLS = 512;
const DEFAULT_SIZE = 16384;
const DEFAULT_CENTER_CELL_SIZE = 4;
const DEFAULT_REBUILD_DISTANCE = 1024;
const DEFAULT_LOW_REBUILD_DISTANCE = 256;
const DEFAULT_BUILD_BUDGET_MS = 2;
const DEFAULT_ROWS_PER_FRAME = 64; // safety cap, not a mandatory batch size

function buildIndices(cells) {
  const indices = new Uint32Array(cells * cells * 6);
  let cursor = 0;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const a = y * (cells + 1) + x;
      const b = a + 1;
      const c = a + cells + 1;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = d;
      indices[cursor++] = c;
    }
  }
  return new THREE.BufferAttribute(indices, 1);
}

function tangentBasis(direction, tangent, bitangent) {
  tangent.crossVectors(direction,
    Math.abs(direction.y) < 0.92
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0)).normalize();
  bitangent.crossVectors(direction, tangent).normalize();
}

/**
 * A small, camera-following spherical water patch.
 *
 * The whole-planet water quadtree owns the horizon, orbit silhouette and
 * bathymetric colour at distance. Refining that closed shell until it can
 * sample metre-scale waves costs millions of triangles all the way to the
 * horizon. This patch spends that geometry only inside the player's optical
 * near field: 4 m centre cells resolve shallow bathymetry and the 88–680 m
 * gravity-wave cascade while cubic grading lets the outer shell stay coarse.
 *
 * Bathymetry is rebuilt incrementally from the same deterministic height()
 * authority as terrain. The old patch remains live until the replacement is
 * complete, so recentering never exposes an empty loading square.
 */
export class NearWaterPatch {
  constructor(planet, material, {
    cells = DEFAULT_CELLS,
    size = DEFAULT_SIZE,
    centerCellSize = DEFAULT_CENTER_CELL_SIZE,
    coreRadius = null,
    rebuildDistance = DEFAULT_REBUILD_DISTANCE,
    lowRebuildDistance = DEFAULT_LOW_REBUILD_DISTANCE,
    lowAltitude = 100,
    buildBudgetMs = null,
    adaptiveLowBudget = buildBudgetMs == null,
    rowsPerFrame = DEFAULT_ROWS_PER_FRAME,
  } = {}) {
    this.planet = planet;
    this.material = material;
    this.cells = cells;
    this.size = size;
    this.averageCellSize = size / cells;
    centerCellSize = Math.min(centerCellSize, this.averageCellSize);
    this.cellSize = centerCellSize;
    this.coreCells = Math.floor((coreRadius ?? cells * 0.390625 * centerCellSize) / centerCellSize);
    this.coreCells = Math.max(0, Math.min(Math.floor(cells / 2) - 1,
      Math.floor(size * 0.49 / centerCellSize), this.coreCells));
    this.coreRadius = this.coreCells * centerCellSize;
    const outerCells = cells / 2 - this.coreCells;
    this.edgeCellSize = centerCellSize + 3 * Math.max(0,
      size / 2 - this.coreRadius - outerCells * centerCellSize) / outerCells;
    this.radius = size * 0.49;
    this.rebuildDistance = rebuildDistance;
    this.lowRebuildDistance = lowRebuildDistance;
    this.lowAltitude = lowAltitude;
    this.buildBudgetMs = Math.max(0, Number.isFinite(buildBudgetMs) ? buildBudgetMs : DEFAULT_BUILD_BUDGET_MS);
    this.baseBuildBudgetMs = this.buildBudgetMs;
    this.adaptiveLowBudget = adaptiveLowBudget;
    this.rowsPerFrame = rowsPerFrame;
    this.lastBuildMs = 0;
    this.lastBuildRows = 0;
    this.lastCommitMs = 0;
    this.effectiveRebuildDistance = rebuildDistance;
    this.anchorDistance = 0;
    this.centerDirection = null;
    this.build = null;
    this.rebuilds = 0;
    this._tangent = new THREE.Vector3();
    this._bitangent = new THREE.Vector3();
    this._sample = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._cameraDirection = new THREE.Vector3();
    this._centerPosition = new THREE.Vector3();
    this._cellNeighbor = new THREE.Vector3();
    this._indices = buildIndices(cells);

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = `near-water:${planet.name}`;
    this.mesh.visible = false;
    // The patch follows the camera on a six-million-metre sphere. Culling its
    // small relative geometry against a concurrently rebased planet matrix can
    // reject the whole optical near field for a frame (or permanently in a
    // fixed fixture), so its explicit altitude/ownership gate is authoritative.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.mesh.userData.lodMorph = 0;
    this.mesh.userData.nearWaterPatch = true;
    planet.group.add(this.mesh);
  }

  _gridCoordinate(index) {
    const offset = index - this.cells / 2;
    const distance = Math.abs(offset);
    const outer = Math.max(0, distance - this.coreCells);
    const outerCells = this.cells / 2 - this.coreCells;
    // Fixed metre-scale core, C1 cubic tail, unchanged outer extent. Unlike
    // camera-dependent filtering, geometry remains fine while a build is pending.
    const extra = Math.max(0, this.size / 2 - this.cells / 2 * this.cellSize);
    return Math.sign(offset) * (distance * this.cellSize + extra * (outer / outerCells) ** 3);
  }

  _begin(direction) {
    const count = (this.cells + 1) * (this.cells + 1);
    const centerDirection = direction.clone().normalize();
    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();
    tangentBasis(centerDirection, tangent, bitangent);
    this.build = {
      centerDirection,
      centerPosition: centerDirection.clone().multiplyScalar(this.planet.seaRadius),
      tangent,
      bitangent,
      row: 0,
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

  _buildRows() {
    const job = this.build;
    if (!job) return;
    const stride = this.cells + 1;
    const startedAt = performance.now();
    const firstRow = job.row;
    const end = Math.min(stride, job.row + Math.max(1, this.rowsPerFrame));
    for (let y = firstRow; y < end; y++) {
      const z = this._gridCoordinate(y);
      for (let x = 0; x < stride; x++) {
        const px = this._gridCoordinate(x);
        const index = y * stride + x;
        this._sample.copy(job.centerPosition)
          .addScaledVector(job.tangent, px)
          .addScaledVector(job.bitangent, z);
        this._direction.copy(this._sample).normalize();
        this._sample.copy(this._direction).multiplyScalar(this.planet.seaRadius);
        const offset = index * 3;
        job.position[offset] = this._sample.x - job.centerPosition.x;
        job.position[offset + 1] = this._sample.y - job.centerPosition.y;
        job.position[offset + 2] = this._sample.z - job.centerPosition.z;
        job.normal[offset] = this._direction.x;
        job.normal[offset + 1] = this._direction.y;
        job.normal[offset + 2] = this._direction.z;
        job.local[offset] = this._sample.x;
        job.local[offset + 1] = this._sample.y;
        job.local[offset + 2] = this._sample.z;
        job.depth[index] = this.planet.seaLevel
          - this.planet.height(this._direction, this.planet.fullMaxFreq);
        // Actual spherical row/column neighbour spacing, including the wider
        // cell on either side of a graded-grid vertex. Not distance from the
        // camera, average cell size, or the triangle's diagonal edge length.
        let cell = 0;
        for (let neighbor = 0; neighbor < 4; neighbor++) {
          const nx = x + (neighbor === 0 ? -1 : neighbor === 1 ? 1 : 0);
          const ny = y + (neighbor === 2 ? -1 : neighbor === 3 ? 1 : 0);
          if (nx < 0 || nx > this.cells || ny < 0 || ny > this.cells) continue;
          this._cellNeighbor.copy(job.centerPosition)
            .addScaledVector(job.tangent, this._gridCoordinate(nx))
            .addScaledVector(job.bitangent, this._gridCoordinate(ny))
            .normalize().multiplyScalar(this.planet.seaRadius);
          cell = Math.max(cell, this._cellNeighbor.distanceTo(this._sample));
        }
        job.waterCell[index] = cell + 0.00001; // avoid downward Float32 rounding
      }
      job.row = y + 1;
      // One whole row is the minimum progress unit, even under severe load.
      // Never restart an in-flight build: a fast observer must not starve it.
      if (performance.now() - startedAt >= this.buildBudgetMs) break;
    }
    this.lastBuildRows = job.row - firstRow;
    this.lastBuildMs = performance.now() - startedAt;
    if (job.row >= stride) this._commit();
  }

  _commit() {
    const job = this.build;
    if (!job) return;
    const startedAt = performance.now();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(job.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(job.normal, 3));
    geometry.setAttribute('aLocal', new THREE.BufferAttribute(job.local, 3));
    geometry.setAttribute('aDepth', new THREE.BufferAttribute(job.depth, 1));
    geometry.setAttribute('aWaterCell', new THREE.BufferAttribute(job.waterCell, 1));
    geometry.setAttribute('aPositionDelta', new THREE.BufferAttribute(job.positionDelta, 3));
    geometry.setAttribute('aNormalDelta', new THREE.BufferAttribute(job.normalDelta, 3));
    geometry.setAttribute('aDepthDelta', new THREE.BufferAttribute(job.depthDelta, 1));
    geometry.setAttribute('aLodMorph', new THREE.BufferAttribute(new Float32Array(job.depth.length), 1));
    geometry.setAttribute('aNearPatchPass',
      new THREE.BufferAttribute(new Float32Array(job.depth.length).fill(1), 1));
    geometry.setIndex(this._indices);
    // Radial projection of the tangent square cannot increase its distance
    // from the centre. Avoid a full vertex scan in the atomic commit frame.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.size / Math.sqrt(2) + 24);

    const previous = this.mesh.geometry;
    this.mesh.geometry = geometry;
    this.mesh.position.copy(job.centerPosition);
    this.centerDirection = job.centerDirection;
    this._centerPosition.copy(job.centerPosition);
    this.mesh.visible = true;
    this.rebuilds++;
    this.build = null;
    previous.dispose();

    const uniforms = this.material?.userData?.waterUniforms
      || this.material?.userData?.shader?.uniforms;
    if (uniforms?.uNearPatchCenter) uniforms.uNearPatchCenter.value.copy(job.centerPosition);
    if (uniforms?.uNearPatchRadius) uniforms.uNearPatchRadius.value = this.radius;
    this.lastCommitMs = performance.now() - startedAt;
  }

  update(cameraLocal, focused, dt = 1 / 60) {
    const altitude = cameraLocal.length() - this.planet.seaRadius;
    const shouldShow = focused && altitude < 18000 && altitude > -1200;
    if (!shouldShow) {
      this.mesh.visible = false;
      // A hidden surface cannot advance row work. Retain its committed mesh,
      // but do not leave idle()/pending observers waiting for an orphaned job.
      this.build = null;
      const uniforms = this.material?.userData?.waterUniforms
        || this.material?.userData?.shader?.uniforms;
      if (uniforms?.uNearPatchRadius) uniforms.uNearPatchRadius.value = 0;
      return;
    }

    const direction = this._cameraDirection.copy(cameraLocal).normalize();
    this.effectiveRebuildDistance = altitude < this.lowAltitude
      ? this.lowRebuildDistance : this.rebuildDistance;
    this.buildBudgetMs = this.adaptiveLowBudget && altitude < this.lowAltitude
      ? THREE.MathUtils.clamp(240 * (Number.isFinite(dt) && dt > 0 ? dt : 1 / 60), 4, 8)
      : this.baseBuildBudgetMs;
    if (!this.centerDirection && !this.build) this._begin(direction);
    if (this.centerDirection && !this.build) {
      const angular = Math.acos(THREE.MathUtils.clamp(
        this.centerDirection.dot(direction), -1, 1,
      ));
      this.anchorDistance = angular * this.planet.seaRadius;
      if (this.anchorDistance > this.effectiveRebuildDistance) this._begin(direction);
    }
    if (this.centerDirection && this.build) {
      this.anchorDistance = Math.acos(THREE.MathUtils.clamp(
        this.centerDirection.dot(direction), -1, 1)) * this.planet.seaRadius;
    }
    this._buildRows();
    if (this.centerDirection) {
      this.anchorDistance = Math.acos(THREE.MathUtils.clamp(
        this.centerDirection.dot(direction), -1, 1)) * this.planet.seaRadius;
      this.mesh.visible = true;
      const uniforms = this.material?.userData?.waterUniforms
        || this.material?.userData?.shader?.uniforms;
      if (uniforms?.uNearPatchCenter) uniforms.uNearPatchCenter.value.copy(this._centerPosition);
      if (uniforms?.uNearPatchRadius) uniforms.uNearPatchRadius.value = this.radius;
    }
  }

  debugStats() {
    return {
      visible: this.mesh.visible,
      pending: !!this.build,
      row: this.build?.row ?? null,
      cells: this.cells,
      cellSize: this.cellSize,
      coreRadius: this.coreRadius,
      averageCellSize: this.averageCellSize,
      edgeCellSize: this.edgeCellSize,
      size: this.size,
      radius: this.radius,
      triangles: this.cells * this.cells * 2,
      rebuilds: this.rebuilds,
      rebuildDistance: this.effectiveRebuildDistance,
      anchorDistance: this.anchorDistance,
      buildBudgetMs: this.buildBudgetMs,
      lastBuildRows: this.lastBuildRows,
      lastBuildMs: this.lastBuildMs,
      lastCommitMs: this.lastCommitMs,
    };
  }

  dispose() {
    this.planet.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.build = null;
  }
}
