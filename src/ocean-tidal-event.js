const FRONT = 0.32;
const BACK = 1.65;
const DRAWDOWN = 0.08;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(a) {
  if (a.length !== 3) throw new RangeError('Tidal direction must have three components.');
  const length = Math.hypot(...a);
  if (!Number.isFinite(length) || length <= 0) throw new RangeError('Tidal direction must be finite and nonzero.');
  return a.map((value) => value / length);
}
function smooth(x, lo, hi) {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return [t * t * (3 - 2 * t), 6 * t * (1 - t) / (hi - lo)];
}
function support(x, lo, hi) {
  const [value, derivative] = smooth(Math.abs(x), lo, hi);
  return [1 - value, -Math.sign(x) * derivative];
}

// event.normal identifies a fixed planet-local surface region, not an observer
// position. A stable tangent determines travel; a bounded packet passes through
// that region once per period. This is an authored tidal event, not a tsunami
// fluid solver. No displacement is applied to the antipodal ocean.
export function createOceanTidalEvent(event, { radius = 6000000, gravity = 9.81 } = {}) {
  const height = event?.height ?? 0;
  const period = event?.period ?? 300;
  const epoch = event?.epoch ?? 0;
  if (![radius, gravity, period].every((value) => Number.isFinite(value) && value > 0)
    || !Number.isFinite(height) || height < 0 || !Number.isFinite(epoch)) {
    throw new RangeError('Tidal event dimensions and clock must be finite and valid.');
  }
  const up = unit(Array.from(event?.normal || [0, 1, 0]));
  const axis = unit(cross(Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], up));
  const side = unit(cross(up, axis));
  const width = Math.max(80, height * 1.8);
  return { up, axis, side, height, period, epoch, radius, width,
    lateralWidth: width * 8, speed: Math.sqrt(gravity * Math.max(height, 1)) * 0.5,
    depthRatio: 0.62 };
}

// All large projection/subtraction happens in CPU double precision. The shader
// receives only residual coordinates and never subtracts two rounded 6 Mm points.
export function oceanTidalEventUniforms(field, anchor, seconds) {
  if (!Number.isFinite(seconds)) throw new RangeError('Tidal time must be finite.');
  const phase = (((seconds - field.epoch) % field.period) + field.period) % field.period / field.period;
  const travel = (phase - 0.5) * field.period * field.speed;
  // Value and first derivative vanish at either side of the periodic wrap.
  const life = Math.sin(Math.PI * phase) ** 4;
  const p = [anchor.x, anchor.y, anchor.z];
  if (!p.every(Number.isFinite)) throw new RangeError('Tidal anchor must be finite.');
  return {
    axis: field.axis, side: field.side, up: field.up,
    offset: [dot(p, field.axis) - travel, dot(p, field.side), dot(p, field.up)],
    shape: [field.height * life, field.width, field.lateralWidth, field.radius],
    depthRatio: field.depthRatio,
  };
}

// Gradient is with respect to position at fixed depth. A consumer differentiating
// a spatial depth field must additionally account for that field's derivative.
export function sampleOceanTidalRelative(uniforms, relativePosition, { depth = Infinity } = {}) {
  const p = [relativePosition.x, relativePosition.y, relativePosition.z];
  if (!p.every(Number.isFinite) || !(Number.isFinite(depth) || depth === Infinity)) {
    throw new RangeError('Tidal sample position and depth must be valid.');
  }
  const [amplitude, width, lateralWidth, radius] = uniforms.shape;
  const heightScale = Math.min(amplitude, Math.max(0, depth) * uniforms.depthRatio);
  const s = dot(p, uniforms.axis) + uniforms.offset[0];
  const v = dot(p, uniforms.side) + uniforms.offset[1];
  const radial = (dot(p, uniforms.up) + uniforms.offset[2]) / radius;
  const empty = { height: 0, gradient: { x: 0, y: 0, z: 0 } };
  if (heightScale <= 0 || Math.abs(s) >= width * 6
    || Math.abs(v) >= lateralWidth * 3 || radial <= 0.5) return empty;
  const localWidth = width * (s > 0 ? FRONT : BACK);
  const u = s / localWidth;
  // sech squared via exponentials is supported equally by JS and GLSL ES.
  const exponential = Math.exp(-2 * Math.abs(u));
  const crest = 4 * exponential / ((1 + exponential) ** 2);
  const tanh = Math.sign(u) * (1 - exponential) / (1 + exponential);
  const draw = (s - width * 2.5) / (width * 1.2);
  const trough = Math.exp(-draw * draw);
  const profile = crest - DRAWDOWN * trough;
  const derivative = -2 * crest * tanh / localWidth
    + DRAWDOWN * trough * 2 * draw / (width * 1.2);
  const [alongMask, alongDerivative] = support(s, width * 5, width * 6);
  const [sideMask, sideDerivative] = support(v, lateralWidth * 2, lateralWidth * 3);
  const gaussian = Math.exp(-0.5 * (v / lateralWidth) ** 2);
  const lateral = gaussian * sideMask;
  const lateralDerivative = gaussian * (sideDerivative - v / (lateralWidth ** 2) * sideMask);
  const [facing, facingDerivative] = smooth(radial, 0.5, 0.75);
  const h = profile * alongMask * lateral * facing;
  const ds = (derivative * alongMask + profile * alongDerivative) * lateral * facing;
  const dv = profile * alongMask * lateralDerivative * facing;
  const dr = profile * alongMask * lateral * facingDerivative / radius;
  const gradient = uniforms.axis.map((value, i) => heightScale
    * (value * ds + uniforms.side[i] * dv + uniforms.up[i] * dr));
  return { height: h * heightScale, gradient: { x: gradient[0], y: gradient[1], z: gradient[2] } };
}

export function sampleOceanTidalEvent(field, position, seconds, options = {}) {
  return sampleOceanTidalRelative(oceanTidalEventUniforms(field, position, seconds),
    { x: 0, y: 0, z: 0 }, options);
}

// vec4(height, gradient.xyz), in the same stable planet-local frame as the CPU.
// Bind the returned uniforms using the corresponding axis/side/up/offset/shape
// properties. A large positive depth represents unconstrained open water.
export const oceanTidalEventGLSL = /* glsl */ `
uniform vec3 uTidalAxis;
uniform vec3 uTidalSide;
uniform vec3 uTidalUp;
uniform vec3 uTidalOffset;
uniform vec4 uTidalShape;
uniform float uTidalDepthRatio;
vec2 tidalSmooth(float x, float lo, float hi) {
  float t = clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return vec2(t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) / (hi - lo));
}
vec2 tidalSupport(float x, float lo, float hi) {
  vec2 sampleValue = tidalSmooth(abs(x), lo, hi);
  return vec2(1.0 - sampleValue.x, -sign(x) * sampleValue.y);
}
vec4 oceanTidalEvent(vec3 relativePosition, float depth) {
  float width = uTidalShape.y;
  float lateralWidth = uTidalShape.z;
  float heightScale = min(uTidalShape.x, max(0.0, depth) * uTidalDepthRatio);
  float s = dot(relativePosition, uTidalAxis) + uTidalOffset.x;
  float v = dot(relativePosition, uTidalSide) + uTidalOffset.y;
  float radial = (dot(relativePosition, uTidalUp) + uTidalOffset.z) / uTidalShape.w;
  if (heightScale <= 0.0 || abs(s) >= width * 6.0
    || abs(v) >= lateralWidth * 3.0 || radial <= 0.5) return vec4(0.0);
  float localWidth = width * (s > 0.0 ? ${FRONT} : ${BACK});
  float u = s / localWidth;
  float exponential = exp(-2.0 * abs(u));
  float crest = 4.0 * exponential / ((1.0 + exponential) * (1.0 + exponential));
  float tanhValue = sign(u) * (1.0 - exponential) / (1.0 + exponential);
  float draw = (s - width * 2.5) / (width * 1.2);
  float trough = exp(-draw * draw);
  float profile = crest - ${DRAWDOWN} * trough;
  float derivative = -2.0 * crest * tanhValue / localWidth
    + ${DRAWDOWN} * trough * 2.0 * draw / (width * 1.2);
  vec2 alongMask = tidalSupport(s, width * 5.0, width * 6.0);
  vec2 sideMask = tidalSupport(v, lateralWidth * 2.0, lateralWidth * 3.0);
  float gaussian = exp(-0.5 * (v / lateralWidth) * (v / lateralWidth));
  float lateral = gaussian * sideMask.x;
  float lateralDerivative = gaussian * (sideMask.y - v / (lateralWidth * lateralWidth) * sideMask.x);
  vec2 facing = tidalSmooth(radial, 0.5, 0.75);
  float h = profile * alongMask.x * lateral * facing.x;
  float ds = (derivative * alongMask.x + profile * alongMask.y) * lateral * facing.x;
  float dv = profile * alongMask.x * lateralDerivative * facing.x;
  float dr = profile * alongMask.x * lateral * facing.y / uTidalShape.w;
  return vec4(h, uTidalAxis * ds + uTidalSide * dv + uTidalUp * dr) * heightScale;
}
`;
