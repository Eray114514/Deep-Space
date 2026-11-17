import * as THREE from 'three';
import { createWaterGeometryJob, buildWaterGeometryRows, waterGridCoordinate,
  WATER_GEOMETRY_ATTRIBUTES } from './near-water-geometry.js';

const defaultWorkerFactory = typeof Worker === 'undefined' ? null : () => {
  const url = new URL('./near-water-worker.js', import.meta.url);
  url.search = new URL(import.meta.url).search;
  return new Worker(url, { type: 'module' });
};

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
    workerFactory = defaultWorkerFactory,
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
    this.workerFactory = workerFactory;
    this.worker = null;
    this.workerToken = 0;
    this.workerError = null;
    this.workerUnavailable = false;
    this.workerTimedOut = false;
    this.disposed = false;
    this.lastWorkerCpuMs = 0;
    this.lastWorkerWallMs = 0;
    this._cameraDirection = new THREE.Vector3();
    this._centerPosition = new THREE.Vector3();
    this._indices = buildIndices(cells);
    this._surveyGrid = cells >= 256 ? { cells: 64, size, coreCells: 20,
      cellSize: Math.min(size / 64, centerCellSize * cells / 64) } : null;
    this._surveyIndices = this._surveyGrid ? buildIndices(64) : null;
    this._showingSurvey = false;

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

  _gridCoordinate(index) { return waterGridCoordinate(this, index); }

  _begin(direction) {
    if (this.disposed) return;
    if (!this.worker && this.workerFactory && !this.workerUnavailable && this.planet.createTerrainSnapshot) {
      try {
        const worker = this.workerFactory();
        this.worker = worker;
        worker.onmessage = ({ data }) => {
          if (this.disposed || this.worker !== worker || !this.build?.worker
            || data.token !== this.workerToken) return;
          if (data.error) { this._workerFailed(data.error); return; }
          if (Number.isInteger(data.progress) && data.progress >= 0 && data.progress <= this.cells) {
            if (!this.build.ready && data.progress > this.build.workerProgress) {
              this.build.workerProgress = data.progress;
              this.build.workerLastCheck = performance.now();
              this.build.workerObservedMs = 0;
            }
            return;
          }
          const count = (this.build.grid.cells + 1) ** 2;
          if (!WATER_GEOMETRY_ATTRIBUTES.every(key => data.attributes?.[key] instanceof Float32Array
            && data.attributes[key].length === count * (['depth', 'waterCell', 'depthDelta'].includes(key) ? 1 : 3))) {
            this._workerFailed('Invalid near-water worker attributes'); return;
          }
          // Completion does not mutate a live mesh or uniforms. Only update's
          // renewed scene grant can publish all attributes together.
          Object.assign(this.build, data.attributes, { ready: true });
          this.lastWorkerCpuMs = data.cpuMs;
          this.lastWorkerWallMs = data.wallMs;
          this.workerError = null;
          this.workerTimedOut = false;
        };
        worker.onerror = event => { if (this.worker === worker) this._workerFailed(event.message); };
        worker.onmessageerror = () => { if (this.worker === worker) this._workerFailed('Near-water message decoding failed'); };
        worker.postMessage({ type: 'init', snapshot: this.planet.createTerrainSnapshot() });
      } catch (error) { this._workerFailed(String(error)); }
    }
    // A dense optical patch can take longer to build than a ship takes to
    // cross an inlet. Publish a first depth survey over the same footprint,
    // then replace it atomically with the full graded wave mesh.
    const usableRadius = this.radius * (this._showingSurvey ? 0.24 : 0.72);
    const outside = !this.centerDirection || this.centerDirection.angleTo(direction) * this.planet.seaRadius > usableRadius;
    const grid = this.worker && outside && this._surveyGrid
      ? this._surveyGrid : { cells: this.cells, size: this.size, coreCells: this.coreCells, cellSize: this.cellSize };
    this.build = createWaterGeometryJob(direction, grid.cells, this.planet.seaRadius, !this.worker);
    this.build.grid = grid;
    if (this.worker) {
      this.build.worker = true;
      this.build.workerProgress = -1;
      this.build.workerLastCheck = performance.now();
      this.build.workerObservedMs = 0;
      this.workerToken++;
      try {
        this.worker.postMessage({ type: 'build', token: this.workerToken, direction: direction.toArray(),
          grid });
      } catch (error) { this._workerFailed(String(error)); }
    }
  }

  _stopWorker() {
    this.workerToken++;
    this.worker?.terminate();
    this.worker = null;
  }

  _workerFailed(error, retry = false) {
    this.workerError = String(error);
    this.workerUnavailable = !retry;
    this._stopWorker();
    if (this.build?.worker) {
      const job = this.build;
      this.build = createWaterGeometryJob(job.centerDirection, job.grid.cells, this.planet.seaRadius);
      this.build.grid = job.grid;
      for (const key of ['centerDirection', 'centerPosition', 'tangent', 'bitangent']) this.build[key] = job[key];
    }
  }

  _buildRows(budgetMs = this.buildBudgetMs) {
    const job = this.build;
    if (!job || budgetMs <= 0) { this.lastBuildRows=0; this.lastBuildMs=0; return; }
    if (job.worker) {
      this.lastBuildRows=0; this.lastBuildMs=0;
      if (job.ready) { this._commit(); return; }
      const now = performance.now();
      // A blocked/hidden main thread cannot dispatch a completed worker's
      // message. Do not charge an entire driver stall or suspension as worker
      // inactivity and kill the response before its event can be delivered.
      job.workerObservedMs += Math.min(250, Math.max(0, now-job.workerLastCheck));
      job.workerLastCheck = now;
      if (job.workerObservedMs > 30000) {
        const retry = !this.workerTimedOut;
        this.workerTimedOut = true;
        this._workerFailed('Near-water worker exceeded 30 s of observed frame wait', retry);
        return;
      }
      return;
    }
    const grid = job.grid;
    const result = buildWaterGeometryRows(job, this.planet, i => waterGridCoordinate(grid, i),
      grid.cells, budgetMs, this.rowsPerFrame);
    this.lastBuildRows=result.rows; this.lastBuildMs=result.milliseconds;
    if (job.row >= grid.cells+1) this._commit();
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
    this._showingSurvey = job.grid === this._surveyGrid;
    geometry.setIndex(this._showingSurvey ? this._surveyIndices : this._indices);
    // Radial projection of the tangent square cannot increase its distance
    // from the centre. Avoid a full vertex scan in the atomic commit frame.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.size / Math.sqrt(2) + 24);

    let maxDepth = -Infinity;
    for (let i = 0; i < job.depth.length; i++) {
      if (job.depth[i] > maxDepth) maxDepth = job.depth[i];
    }
    this.hasWetVertices = maxDepth > -1.0;

    const previous = this.mesh.geometry;
    this.mesh.geometry = geometry;
    this.mesh.position.copy(job.centerPosition);
    this.centerDirection = job.centerDirection;
    this._centerPosition.copy(job.centerPosition);
    this.mesh.visible = this.hasWetVertices;
    if (!this._showingSurvey) this.rebuilds++;
    this.build = null;
    previous.dispose();

    const uniforms = this.material?.userData?.waterUniforms
      || this.material?.userData?.shader?.uniforms;
    if (uniforms?.uNearPatchCenter) uniforms.uNearPatchCenter.value.copy(job.centerPosition);
    if (uniforms?.uNearPatchRadius) uniforms.uNearPatchRadius.value = this.hasWetVertices ? this.radius : 0;
    this.lastCommitMs = performance.now() - startedAt;
  }

  preferredBudget(altitude,dt=1/60) {
    return this.adaptiveLowBudget && altitude<this.lowAltitude
      ? THREE.MathUtils.clamp(240*(Number.isFinite(dt)&&dt>0?dt:1/60),4,8)
      : this.baseBuildBudgetMs;
  }

  update(cameraLocal, focused, dt = 1 / 60, budgetMs=null) {
    const altitude = cameraLocal.length() - this.planet.seaRadius;
    const shouldShow = focused && altitude < 18000 && altitude > -1200;
    if (!shouldShow) {
      this.mesh.visible = false;
      // A hidden surface cannot advance row work. Retain its committed mesh,
      // but do not leave idle()/pending observers waiting for an orphaned job.
      this.build = null;
      this._stopWorker();
      const uniforms = this.material?.userData?.waterUniforms
        || this.material?.userData?.shader?.uniforms;
      if (uniforms?.uNearPatchRadius) uniforms.uNearPatchRadius.value = 0;
      return;
    }

    const direction = this._cameraDirection.copy(cameraLocal).normalize();
    // The graded survey has large triangles at its outer edge. In fast
    // flight recenter it before the pilot reaches that edge. Keep the old
    // mesh visible and give completed detail priority over a survey.
    const staleRadius = this.build?.worker && !this.build.ready && this._showingSurvey
      && this.build.grid !== this._surveyGrid ? this.radius * 0.24 : this.radius;
    if (this.build && this.build.centerDirection.angleTo(direction) * this.planet.seaRadius > staleRadius) {
      this.build = null;
      this._stopWorker();
    }
    this.effectiveRebuildDistance = altitude < this.lowAltitude
      ? this.lowRebuildDistance : this.rebuildDistance;
    this.buildBudgetMs=budgetMs??this.preferredBudget(altitude,dt);
    if (!this.centerDirection && !this.build && this.buildBudgetMs>0) this._begin(direction);
    if (this.centerDirection && !this.build && this.buildBudgetMs>0) {
      const angular = Math.acos(THREE.MathUtils.clamp(
        this.centerDirection.dot(direction), -1, 1,
      ));
      this.anchorDistance = angular * this.planet.seaRadius;
      if (this._showingSurvey || this.anchorDistance > this.effectiveRebuildDistance) this._begin(direction);
    }
    if (this.centerDirection && this.build) {
      this.anchorDistance = Math.acos(THREE.MathUtils.clamp(
        this.centerDirection.dot(direction), -1, 1)) * this.planet.seaRadius;
    }
    this._buildRows();
    if (this.centerDirection) {
      this.anchorDistance = Math.acos(THREE.MathUtils.clamp(
        this.centerDirection.dot(direction), -1, 1)) * this.planet.seaRadius;
      const wet = this.hasWetVertices !== false;
      this.mesh.visible = wet;
      const uniforms = this.material?.userData?.waterUniforms
        || this.material?.userData?.shader?.uniforms;
      if (uniforms?.uNearPatchCenter) uniforms.uNearPatchCenter.value.copy(this._centerPosition);
      if (uniforms?.uNearPatchRadius) uniforms.uNearPatchRadius.value = wet ? this.radius : 0;
    }
  }

  debugStats() {
    return {
      visible: this.mesh.visible,
      pending: !!this.build || (this.mesh.visible && this._showingSurvey),
      survey: this._showingSurvey,
      row: this.build?.row ?? null,
      column: this.build?.column ?? null,
      cells: this.cells,
      cellSize: this.cellSize,
      coreRadius: this.coreRadius,
      averageCellSize: this.averageCellSize,
      edgeCellSize: this.edgeCellSize,
      size: this.size,
      radius: this.radius,
      triangles: this.mesh.geometry.index ? this.mesh.geometry.index.count / 3 : 0,
      rebuilds: this.rebuilds,
      rebuildDistance: this.effectiveRebuildDistance,
      anchorDistance: this.anchorDistance,
      buildBudgetMs: this.buildBudgetMs,
      lastBuildRows: this.lastBuildRows,
      lastBuildMs: this.lastBuildMs,
      lastCommitMs: this.lastCommitMs,
      worker: !!this.worker,
      workerReady: !!this.build?.ready,
      workerProgress: this.build?.workerProgress ?? null,
      workerError: this.workerError,
      lastWorkerCpuMs: this.lastWorkerCpuMs,
      lastWorkerWallMs: this.lastWorkerWallMs,
    };
  }

  dispose() {
    this.disposed = true;
    this._stopWorker();
    this.planet.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.build = null;
  }
}
