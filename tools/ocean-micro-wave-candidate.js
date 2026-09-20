// Experimental optical spectrum, deliberately not wired into src. Height is
// an analytic reference for NORMALS, not a second collision/geometry surface.
import { makeRng } from '../src/rng.js';

const TAU = Math.PI * 2;
const mod = (x) => ((x % TAU) + TAU) % TAU;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dot = (axis, p) => axis[0] * p.x + axis[1] * p.y + axis[2] * p.z;
export function microWaveFilter(k, footprint) {
  const t = clamp((Math.max(0, footprint) * k / TAU - 0.125) * 8, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

export function createOceanMicroCandidate(seed, {
  gravity = 9.81, count = 10, minWavelength = 0.7, maxWavelength = 20, rmsSlope = 0.14,
} = {}) {
  if (!(Number.isInteger(count) && count >= 8 && count <= 12
    && Number.isFinite(gravity) && gravity > 0
    && Number.isFinite(minWavelength) && minWavelength > 0
    && Number.isFinite(maxWavelength) && maxWavelength > minWavelength
    && Number.isFinite(rmsSlope) && rmsSlope >= 0)) throw new RangeError('Invalid micro spectrum.');
  const rng = makeRng(`${seed}:ocean-optical-micro:v1`);
  const modes = [];
  let slopeVariance = 0;
  for (let i = 0; i < count; i++) {
    const z = rng() * 2 - 1, azimuth = TAU * rng();
    const radius = Math.sqrt(1 - z * z);
    const axis = [radius * Math.cos(azimuth), radius * Math.sin(azimuth), z];
    // Stratified log spectrum: each scale exists without a camera-oriented
    // wave basis. The max can be capped below the main spectrum's shortest
    // resolved wavelength by the future integration owner.
    const wavelength = minWavelength * (maxWavelength / minWavelength) ** ((i + rng()) / count);
    const k = TAU / wavelength;
    const weight = 0.8 + rng() * 0.4;
    modes.push({ axis, k, omega: Math.sqrt(gravity * k), phase: rng() * TAU, amplitude: weight / k });
    slopeVariance += weight * weight * 0.5;
  }
  const normalization = rmsSlope / Math.sqrt(slopeVariance);
  for (const mode of modes) mode.amplitude *= normalization;
  return { modes, gravity, rmsSlope, minWavelength, maxWavelength,
    heightBound: modes.reduce((sum, m) => sum + m.amplitude, 0),
    slopeBound: modes.reduce((sum, m) => sum + m.amplitude * m.k, 0) };
}

export function oceanMicroCandidatePhases(field, anchor, seconds) {
  if (![anchor.x, anchor.y, anchor.z, seconds].every(Number.isFinite)) throw new RangeError('Invalid micro phase input.');
  return field.modes.map((m) => [mod(dot(m.axis, anchor) * m.k - seconds * m.omega + m.phase), m.amplitude]);
}

// compression is the convergence trace of a hypothetical horizontal
// displacement -a*sin(phase)*tangentAxis. No horizontal vertices are displaced,
// so this is NOT a measured Gerstner Jacobian or proof of physical breaking.
// It has the useful property of favoring positive crests over steep troughs.
export function sampleOceanMicroCandidate(field, relativePosition, phases, {
  footprint = 0, up = { x: 0, y: 1, z: 0 }, strength = 1,
} = {}) {
  const gradient = { x: 0, y: 0, z: 0 };
  let height = 0, compression = 0;
  const upLength = Math.hypot(up.x, up.y, up.z);
  if (!(upLength > 0 && Number.isFinite(strength) && strength >= 0
    && Number.isFinite(footprint) && phases.length === field.modes.length)) throw new RangeError('Invalid micro sample.');
  const normal = { x: up.x / upLength, y: up.y / upLength, z: up.z / upLength };
  for (let i = 0; i < field.modes.length; i++) {
    const m = field.modes[i];
    const filter = microWaveFilter(m.k, footprint);
    const phase = dot(m.axis, relativePosition) * m.k + phases[i][0];
    const a = phases[i][1] * filter * strength;
    const h = a * Math.cos(phase), slope = -a * m.k * Math.sin(phase);
    height += h;
    gradient.x += m.axis[0] * slope; gradient.y += m.axis[1] * slope; gradient.z += m.axis[2] * slope;
    compression += h * m.k * Math.max(0, 1 - dot(m.axis, normal) ** 2);
  }
  // Do not normalize by the surviving spectrum: unresolved energy disappears
  // continuously rather than turning the last remaining octave into a crest.
  return { height, gradient, compression,
    crest: Math.max(0, height) / Math.max(field.heightBound, 1e-12) };
}

export function oceanMicroCandidateGLSL(field) {
  const count = field.modes.length;
  return /* glsl */ `
uniform vec4 uMicroModes[${count}]; // xyz fixed planet-local axis, w wave number
uniform vec2 uMicroPhases[${count}]; // x CPU-reduced phase, y amplitude metres
uniform float uMicroStrength;
struct OceanMicroSample { float height; vec3 gradient; float compression; float crest; };
float oceanMicroFilter(float k, float footprint) {
  float t = clamp((max(0.0, footprint) * k / 6.283185307179586 - 0.125) * 8.0, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}
OceanMicroSample oceanMicroSample(vec3 relativePosition, vec3 radialUp, float footprint) {
  OceanMicroSample result = OceanMicroSample(0.0, vec3(0.0), 0.0, 0.0);
  for (int i = 0; i < ${count}; i++) {
    vec4 mode = uMicroModes[i];
    float weight = oceanMicroFilter(mode.w, footprint);
    if (weight <= 0.0) continue;
    float phase = dot(mode.xyz, relativePosition) * mode.w + uMicroPhases[i].x;
    float amplitude = uMicroPhases[i].y * max(0.0, uMicroStrength) * weight;
    float height = amplitude * cos(phase);
    result.height += height;
    result.gradient -= mode.xyz * (amplitude * mode.w * sin(phase));
    float radial = dot(mode.xyz, normalize(radialUp));
    result.compression += height * mode.w * max(0.0, 1.0 - radial * radial);
  }
  result.crest = max(0.0, result.height) / ${Math.max(field.heightBound, 1e-12).toPrecision(17)};
  return result;
}
`;
}
