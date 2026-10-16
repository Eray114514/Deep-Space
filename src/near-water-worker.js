import { Vector3 } from '../vendor/three.core.js';
import { TerrainHeightField } from './terrain-height-field.js';
import { createWaterGeometryJob, buildWaterGeometryRows, waterGridCoordinate,
  WATER_GEOMETRY_ATTRIBUTES } from './near-water-geometry.js';

let field, active = null;
// One job, bounded slices, no speculative queued patches. Yield between slices
// so cancellation can be handled even without terminating the worker.
function advance(request) {
  if (active !== request) return;
  try {
    const { job, grid, token } = request;
    const result = buildWaterGeometryRows(job, field, i => waterGridCoordinate(grid, i), grid.cells, 8, 64);
    request.cpuMs += result.milliseconds;
    if (job.row < grid.cells + 1) { setTimeout(() => advance(request), 0); return; }
    active = null;
    const attributes = Object.fromEntries(WATER_GEOMETRY_ATTRIBUTES.map(key => [key, job[key]]));
    self.postMessage({ token, attributes, cpuMs: request.cpuMs,
      wallMs: performance.now()-request.started }, Object.values(attributes).map(array => array.buffer));
  } catch (error) {
    active = null;
    self.postMessage({ token: request.token, error: String(error.stack || error) });
  }
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') { field = TerrainHeightField.fromSnapshot(data.snapshot); return; }
    if (data.type === 'cancel') { active = null; return; }
    if (active) throw new Error('Near-water worker already owns a job');
    active = { token: data.token, grid: data.grid, cpuMs: 0, started: performance.now(),
      job: createWaterGeometryJob(new Vector3(...data.direction), data.grid.cells, field.seaRadius) };
    advance(active);
  } catch (error) { self.postMessage({ token: data.token, error: String(error.stack || error) }); }
};
