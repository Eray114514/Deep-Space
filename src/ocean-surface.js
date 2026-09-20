import { createOceanWaveField, sampleOceanWaveField } from './ocean-wave-field.js';
import { createOceanTidalEvent, sampleOceanTidalEvent } from './ocean-tidal-event.js';
import { oceanSeconds } from './ocean-clock.js';

export const OCEAN_CONTACT_FOOTPRINT = 4;
export const OCEAN_SURFACE_BIAS = 0.18;
export const OCEAN_SHOAL_RATIO = 0.62;
const unit = (p) => {
  const length = Math.hypot(p.x, p.y, p.z);
  if (!Number.isFinite(length) || length <= 0) throw new RangeError('Water position must be finite and nonzero.');
  return { x: p.x / length, y: p.y / length, z: p.z / length };
};
const scale = (p, s) => ({ x: p.x * s, y: p.y * s, z: p.z * s });

// Logical state only: no renderer, camera anchor, mesh LOD, or frame counter.
// sampleRegion(direction, hours) owns geographically stable offshore Hs and
// signed baseline bathymetry. It must not read the observer's local climate.
export function createOceanSurface(seed, {
  radius, gravity = 9.81, period = 10, event = null, sampleRegion,
} = {}) {
  if (!(Number.isFinite(radius) && radius > 0) || typeof sampleRegion !== 'function') {
    throw new RangeError('Water surface needs a positive radius and regional sampler.');
  }
  return {
    radius, sampleRegion,
    waveField: createOceanWaveField(seed, { gravity, period }),
    tidalField: event ? createOceanTidalEvent(event, { radius, gravity }) : null,
  };
}

function evaluate(surface, direction, hours, seconds) {
  const region = surface.sampleRegion(direction, hours);
  const depth = region.depth;
  const significantHeight = region.offshoreSignificantHeight;
  if (!Number.isFinite(depth) || !Number.isFinite(significantHeight) || significantHeight < 0) {
    throw new RangeError('Water region must provide finite depth and nonnegative offshore Hs.');
  }
  const position = scale(direction, surface.radius);
  const shoal = Math.min(1, Math.max(0, depth) * OCEAN_SHOAL_RATIO / Math.max(significantHeight, 0.001));
  const waveHeight = sampleOceanWaveField(surface.waveField, position, seconds,
    { significantHeight, footprint: OCEAN_CONTACT_FOOTPRINT }).height * shoal;
  const tidalHeight = surface.tidalField
    ? sampleOceanTidalEvent(surface.tidalField, position, seconds, { depth }).height : 0;
  return { height: waveHeight + tidalHeight + OCEAN_SURFACE_BIAS,
    waveHeight, tidalHeight, depth, significantHeight };
}

// Height is radial displacement above the baseline seaRadius, not altitude
// above terrain. Clearance is signed radial eye/keel distance from that surface.
// Normals differentiate the WHOLE regional/depth-limited surface, including the
// depth gradient omitted by the elementary analytic wave/tidal samplers.
export function sampleOceanSurface(surface, localPosition, hours, { normal: computeNormal = true } = {}) {
  const seconds = oceanSeconds(hours);
  const up = unit(localPosition);
  const result = evaluate(surface, up, hours, seconds);
  const radius = surface.radius + result.height;
  const base = { ...result, surfaceRadius: radius,
    clearance: Math.hypot(localPosition.x, localPosition.y, localPosition.z) - radius,
    direction: up, waterDepth: Math.max(0, result.depth + result.height),
    wet: result.depth > 0, seconds };
  if (!computeNormal) return { ...base, normal: null };
  const tangent = unit(Math.abs(up.y) < 0.9
    ? { x: up.z, y: 0, z: -up.x } : { x: 0, y: -up.z, z: up.y });
  const side = { x: up.y * tangent.z - up.z * tangent.y,
    y: up.z * tangent.x - up.x * tangent.z, z: up.x * tangent.y - up.y * tangent.x };
  // Sub-metre central differences keep shoreline climate and terrain derivatives
  // in the normal without tying contact to tessellation. Five region samples.
  const epsilon = 0.5;
  const derivative = (axis) => {
    const offset = (sign) => unit({ x: up.x + axis.x * sign * epsilon / surface.radius,
      y: up.y + axis.y * sign * epsilon / surface.radius,
      z: up.z + axis.z * sign * epsilon / surface.radius });
    return (evaluate(surface, offset(1), hours, seconds).height
      - evaluate(surface, offset(-1), hours, seconds).height) / (2 * epsilon);
  };
  const a = derivative(tangent) * surface.radius / radius;
  const b = derivative(side) * surface.radius / radius;
  const normal = unit({ x: up.x - tangent.x * a - side.x * b,
    y: up.y - tangent.y * a - side.y * b, z: up.z - tangent.z * a - side.z * b });
  return { ...base, normal };
}

// Near-field contact ray, NOT a planet-wide terrain visibility query. At most
// ceil(maxDistance / stepSize) + 1 + maxIterations regional evaluations (149
// by default). A 4 m step is one quarter of the shortest retained wavelength.
// As with any finite sign-bracketing search, an exactly tangent touch or two
// crossings within a step is not guaranteed; null is safer than a guessed hit.
// Larger ranges require an explicit matching budget, never a coarser stride.
export function raycastOceanSurface(surface, origin, direction, hours, {
  maxDistance = 512, stepSize = 4, maxSteps = 256, maxIterations = 20,
  tolerance = 0.005,
} = {}) {
  const ray = unit(direction);
  const originUp = unit(origin);
  oceanSeconds(hours);
  if (!(Number.isFinite(maxDistance) && maxDistance > 0)
    || !(Number.isFinite(stepSize) && stepSize > 0 && stepSize <= 4)
    || !(Number.isInteger(maxSteps) && maxSteps > 0 && maxSteps <= 2048)
    || !(Number.isInteger(maxIterations) && maxIterations > 0 && maxIterations <= 32)
    || !(Number.isFinite(tolerance) && tolerance > 0 && tolerance <= 0.05)
    || Math.ceil(maxDistance / stepSize) > maxSteps) {
    throw new RangeError('Water ray range/stride must fit its finite sampling budget.');
  }
  let evaluations = 0;
  const at = (distance) => {
    const position = { x: origin.x + ray.x * distance,
      y: origin.y + ray.y * distance, z: origin.z + ray.z * distance };
    // Never search through the centre or reinterpret an antipodal exit as the
    // visible near-side contact. This also keeps normalization well-defined.
    if (position.x * originUp.x + position.y * originUp.y + position.z * originUp.z <= 0) return null;
    evaluations++;
    return { position, distance, sample: sampleOceanSurface(surface, position, hours, { normal: false }) };
  };
  const hit = (value) => value.sample.wet ? {
    position: value.position, direction: value.sample.direction,
    basePosition: scale(value.sample.direction, surface.radius),
    distance: value.distance, clearance: value.sample.clearance, evaluations,
  } : null;
  let previous = at(0);
  if (Math.abs(previous.sample.clearance) <= tolerance) return hit(previous);
  const steps = Math.ceil(maxDistance / stepSize);
  for (let i = 1; i <= steps; i++) {
    let next = at(Math.min(maxDistance, i * stepSize));
    if (!next) return null;
    if (Math.abs(next.sample.clearance) <= tolerance) return hit(next);
    if ((previous.sample.clearance < 0) !== (next.sample.clearance < 0)) {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const middle = at((previous.distance + next.distance) * 0.5);
        if (Math.abs(middle.sample.clearance) <= tolerance) return hit(middle);
        if ((previous.sample.clearance < 0) === (middle.sample.clearance < 0)) previous = middle;
        else next = middle;
      }
      // Exhaustion must not silently turn an unresolved bracket into a hit.
      return null;
    }
    previous = next;
  }
  return null;
}
