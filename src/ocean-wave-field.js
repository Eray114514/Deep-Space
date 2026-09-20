import { makeRng } from './rng.js';

const TAU = Math.PI * 2;
const MODE_COUNT = 12;
const HARMONIC = 0.22;
const modulo = (phase) => ((phase % TAU) + TAU) % TAU;

// Fade each frequency separately: even the second harmonic must have at
// least four cells per wavelength. Eight cells gives its full amplitude.
function waveFilter(k, footprint) {
  const t = Math.max(0, Math.min(1, (Math.max(0, footprint) * k / TAU - 0.125) * 8));
  return 1 - t * t * (3 - 2 * t);
}

export function createOceanWaveField(seed, { gravity = 9.81, period = 10 } = {}) {
  if (!(Number.isFinite(gravity) && gravity > 0 && Number.isFinite(period) && period > 0)) {
    throw new RangeError('Ocean gravity and period must be finite and positive.');
  }
  const random = makeRng(`${seed}:ocean-wave-field:v1`);
  const dominantK = (TAU / period) ** 2 / gravity;
  const modes = [];
  let variance = 0;
  for (let i = 0; i < MODE_COUNT; i++) {
    const z = random() * 2 - 1;
    const azimuth = random() * TAU;
    const radius = Math.sqrt(Math.max(0, 1 - z * z));
    const axis = [radius * Math.cos(azimuth), radius * Math.sin(azimuth), z];
    const logScale = -1 + (i + random()) / MODE_COUNT * 2.8;
    const k = dominantK * Math.exp(logScale);
    const weight = Math.exp(-0.5 * (logScale / 0.8) ** 2);
    modes.push({ axis, k, omega: Math.sqrt(gravity * k), weight, phase: random() * TAU });
    variance += weight * weight * 0.5 * (1 + HARMONIC * HARMONIC);
  }
  // Hs = 4 sigma for decorrelated phases before geometric filtering. Filtering
  // removes unresolved energy; deliberately do not renormalize distant water.
  return { modes, normalization: 1 / (4 * Math.sqrt(variance)) };
}

export function oceanWavePhases(field, center, seconds) {
  return field.modes.map(({ axis, k, omega, weight, phase }) => [
    modulo(k * (center.x * axis[0] + center.y * axis[1] + center.z * axis[2])
      - omega * seconds + phase),
    weight,
  ]);
}

// Ambient Cartesian gradient in the planet's stable local frame. Consumers
// project it onto their local tangent plane when constructing a surface normal.
export function sampleOceanWaveField(field, position, seconds, {
  significantHeight = 1, footprint = 0,
} = {}) {
  const phases = oceanWavePhases(field, position, seconds);
  const scale = Math.max(0, significantHeight) * field.normalization;
  let height = 0;
  const gradient = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < field.modes.length; i++) {
    const { axis, k, weight } = field.modes[i];
    const phase = phases[i][0];
    const fundamental = waveFilter(k, footprint);
    const harmonic = HARMONIC * waveFilter(2 * k, footprint);
    height += weight * (fundamental * Math.sin(phase) + harmonic * Math.sin(2 * phase));
    const slope = scale * weight * k
      * (fundamental * Math.cos(phase) + 2 * harmonic * Math.cos(2 * phase));
    gradient.x += axis[0] * slope;
    gradient.y += axis[1] * slope;
    gradient.z += axis[2] * slope;
  }
  return { height: height * scale, gradient };
}

// The draw owner supplies phases reduced on the CPU at its mesh-local centre.
// relativePosition must be relative to that SAME centre, in the same axes as
// the modes. This keeps metre-scale waves stable on million-metre planets.
export const oceanWaveGLSL = /* glsl */ `
uniform vec4 uOceanModes[12];
uniform vec2 uOceanPhases[12];
uniform float uOceanHeight;
uniform float uOceanNormalization;
float oceanWaveFilter(float k, float footprint) {
  float t = clamp((max(0.0, footprint) * k / 6.283185307179586 - 0.125) * 8.0, 0.0, 1.0);
  return 1.0 - t * t * (3.0 - 2.0 * t);
}
vec4 oceanWaveField(vec3 relativePosition, float footprint) {
  vec4 result = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    vec4 mode = uOceanModes[i];
    float phase = mode.w * dot(relativePosition, mode.xyz) + uOceanPhases[i].x;
    float fundamental = oceanWaveFilter(mode.w, footprint);
    float harmonic = 0.22 * oceanWaveFilter(2.0 * mode.w, footprint);
    float height = fundamental * sin(phase) + harmonic * sin(2.0 * phase);
    float slope = mode.w * (fundamental * cos(phase) + 2.0 * harmonic * cos(2.0 * phase));
    result += vec4(height, mode.xyz * slope) * uOceanPhases[i].y;
  }
  return result * max(0.0, uOceanHeight) * uOceanNormalization;
}
`;
