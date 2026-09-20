// A bounded phenomenological pressure packet, not a hydrodynamic solver.
// along/lateral are metres relative to ONE deposited source; along is positive
// toward hull travel. Continuous injection, not a pre-drawn long V, builds the
// moving trail. The Kelvin slope stays fixed while each shoulder propagates.
export const OCEAN_WAKE_LIFETIME = 8;
export const OCEAN_WAKE_KELVIN_SLOPE = 0.354;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function smooth(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function lobe(coordinate) {
  const q = Math.abs(coordinate);
  return Math.exp(-0.5 * q * q) * (1 - smooth(2, 3, q));
}

// Envelopes are density-like: integrating either arm or core over along and
// lateral gives a constant times energy. Width/length growth cannot manufacture
// foam energy. Sum the two normalized shoulders (do not use nearest-arm max).
export function sampleOceanWakePacket({ along, lateral, age, speed, strength = 1 }) {
  if (![along, lateral, age, speed, strength].every(Number.isFinite)) {
    throw new RangeError('Wake coordinates, age, speed and strength must be finite.');
  }
  const t = clamp(age, 0, OCEAN_WAKE_LIFETIME);
  const velocity = clamp(speed, 0, 60);
  const expansion = Math.sqrt(1 + t * 1.8);
  const width = 1.8 * expansion;
  const coreWidth = 0.55 * expansion;
  const length = 6 + velocity * 0.22 * t;
  const centerAlong = -velocity * 0.45 * t;
  const trailDistance = Math.max(0, -along);
  const propagation = (0.65 + velocity * 0.09) * t;
  const armCenter = 3.4 + trailDistance * OCEAN_WAKE_KELVIN_SLOPE + propagation;
  const armDistance = Math.abs(Math.abs(lateral) - armCenter);
  const longitudinal = lobe((along - centerAlong) / length);
  const lifetime = 1 - smooth(6, OCEAN_WAKE_LIFETIME, t);
  const energy = Math.max(0, strength) * Math.exp(-0.32 * t) * lifetime;
  const envelope = longitudinal * energy * 6 / length;
  const shoulders = (span) => 0.5 * (lobe((lateral - armCenter) / span)
    + lobe((lateral + armCenter) / span));
  return { envelope, longitudinal, energy, armCenter, armDistance, width, coreWidth,
    length, centerAlong, propagation, trailDistance,
    armEnvelope: envelope * shoulders(width) * 1.8 / width,
    coreEnvelope: envelope * shoulders(coreWidth) * 0.55 / coreWidth,
    centerEnvelope: envelope * lobe(lateral / width) * 1.8 / width };
}

// Same constants, profile and area normalization as the CPU implementation.
// Foam and normal consumers should share this sample and only add their own
// high-frequency breakup/oscillation, not reimplement its support or ageing.
export const oceanWakePacketGLSL = /* glsl */ `
struct OceanWakePacket {
  float envelope; float longitudinal; float energy;
  float armCenter; float armDistance; float width; float coreWidth;
  float length; float centerAlong; float propagation; float trailDistance;
  float armEnvelope; float coreEnvelope; float centerEnvelope;
};
float oceanWakeLobe(float coordinate) {
  float q = abs(coordinate);
  return exp(-0.5 * q * q) * (1.0 - smoothstep(2.0, 3.0, q));
}
bool oceanWakeAlongSupport(float along, float age, float speed) {
  float t = clamp(age, 0.0, 8.0);
  float velocity = clamp(speed, 0.0, 60.0);
  return t < 8.0 && abs(along + velocity * 0.45 * t)
    < 3.0 * (6.0 + velocity * 0.22 * t);
}
OceanWakePacket oceanWakePacket(float along, float lateral, float age,
  float speed, float strength) {
  OceanWakePacket p;
  float t = clamp(age, 0.0, 8.0);
  float velocity = clamp(speed, 0.0, 60.0);
  float expansion = sqrt(1.0 + t * 1.8);
  p.width = 1.8 * expansion;
  p.coreWidth = 0.55 * expansion;
  p.length = 6.0 + velocity * 0.22 * t;
  p.centerAlong = -velocity * 0.45 * t;
  p.trailDistance = max(0.0, -along);
  p.propagation = (0.65 + velocity * 0.09) * t;
  p.armCenter = 3.4 + p.trailDistance * 0.354 + p.propagation;
  p.armDistance = abs(abs(lateral) - p.armCenter);
  p.longitudinal = oceanWakeLobe((along - p.centerAlong) / p.length);
  p.energy = max(0.0, strength) * exp(-0.32 * t) * (1.0 - smoothstep(6.0, 8.0, t));
  p.envelope = p.longitudinal * p.energy * 6.0 / p.length;
  p.armEnvelope = p.envelope * 0.5
    * (oceanWakeLobe((lateral - p.armCenter) / p.width)
      + oceanWakeLobe((lateral + p.armCenter) / p.width)) * 1.8 / p.width;
  p.coreEnvelope = p.envelope * 0.5
    * (oceanWakeLobe((lateral - p.armCenter) / p.coreWidth)
      + oceanWakeLobe((lateral + p.armCenter) / p.coreWidth)) * 0.55 / p.coreWidth;
  p.centerEnvelope = p.envelope * oceanWakeLobe(lateral / p.width) * 1.8 / p.width;
  return p;
}
`;
