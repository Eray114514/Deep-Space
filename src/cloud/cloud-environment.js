// B4 query boundary. This resolves coordinates/terrain, not weather or density.
// The production renderer still uses weather-field.js until B4's migration.
export const CLOUD_ENVIRONMENT_VERSION = 1;

function finite(value, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function directionOf(value) {
  const x = finite(value?.x, 'local x');
  const y = finite(value?.y, 'local y');
  const z = finite(value?.z, 'local z');
  const radius = Math.hypot(x, y, z);
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new RangeError('Cloud query needs a nonzero finite body-local vector');
  }
  return { direction: { x: x / radius, y: y / radius, z: z / radius }, radius };
}

// A direction is attached to the rotating body (+Y pole), not to the camera.
// Planet.fullMaxFreq is the canonical terrain cutoff, independent of mesh LOD.
// Mean liquid height is used here; wave crests must not move a cloud base.
export function sampleCloudColumn(body, localDirection) {
  if (!(finite(body?.R, 'body radius') > 0)
    || !(finite(body?.fullMaxFreq, 'canonical terrain frequency') > 0)
    || typeof body?.height !== 'function') {
    throw new TypeError('Cloud queries require a solid Planet terrain source');
  }
  const { direction } = directionOf(localDirection);
  const terrainAltitudeMeters = finite(
    body.height(direction, body.fullMaxFreq), 'terrain altitude');
  const seaAltitudeMeters = body.hasLiquid
    ? finite(body.seaLevel, 'mean liquid altitude') : null;
  const surfaceIsLiquid = seaAltitudeMeters !== null
    && seaAltitudeMeters > terrainAltitudeMeters;
  const surfaceAltitudeMeters = surfaceIsLiquid
    ? seaAltitudeMeters : terrainAltitudeMeters;
  return {
    direction,
    terrainAltitudeMeters,
    seaAltitudeMeters,
    surfaceAltitudeMeters,
    surfaceIsLiquid,
  };
}

// Callers convert universal positions with Planet.worldPositionToLocal first.
// Render-relative positions require restoring their origin before that step.
// Time is CelestialClock.hours: no elapsed render seconds, modulo or dt sum.
export function sampleCloudEnvironment(body, bodyLocalMeters, absoluteHours) {
  finite(absoluteHours, 'absolute celestial hours');
  const absoluteSeconds = finite(absoluteHours * 3600, 'absolute seconds');
  const { direction, radius } = directionOf(bodyLocalMeters);
  const column = sampleCloudColumn(body, direction);
  const altitudeMeters = radius - body.R;
  return {
    contractVersion: CLOUD_ENVIRONMENT_VERSION,
    absoluteHours,
    absoluteSeconds,
    ...column,
    altitudeMeters,
    terrainClearanceMeters: altitudeMeters - column.terrainAltitudeMeters,
    surfaceClearanceMeters: altitudeMeters - column.surfaceAltitudeMeters,
  };
}
