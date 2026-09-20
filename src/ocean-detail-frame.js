const TAU = Math.PI * 2;
const fract = (x) => x - Math.floor(x);
const unit = (a) => a.map((v) => v / Math.hypot(...a));
const axesA = [unit([0.707, 0.203, -0.677]), unit([-0.319, 0.911, 0.262])];
const axesB = [unit([-0.528, 0.411, 0.743]), unit([0.637, 0.758, 0.141])];
const dot = (a, p) => a[0] * p.x + a[1] * p.y + a[2] * p.z;

// Fixed planet-local projections, never the camera/patch tangent. Every final
// texture lookup gets its OWN CPU-reduced phase: reducing an intermediate
// coordinate before an incommensurate rotation/scale does not preserve phase.
export function createOceanDetailFrame(authoredScale = 0.04) {
  if (!Number.isFinite(authoredScale) || authoredScale <= 0) throw new RangeError('Invalid detail scale.');
  const channels = [
    ['DetailA', axesA, authoredScale], ['DetailB', axesB, authoredScale * 1.83],
    ['CausticWarp', axesA, 0.021], ['Caustic', axesA, 0.071],
    ['Shore', axesA, 0.013], ['Glitter', axesB, 0.087],
  ].map(([name, axes, scale]) => ({ name, axes, scale, kind: 'fbm' }));
  channels.push({ name: 'Capillary', axes: axesA, scale: 0.53, kind: 'texture' });
  channels.push({ name: 'ShorePhase', axes: axesA, scale: [0.027 / TAU, 0.019 / TAU], kind: 'phase' });
  return { channels };
}

function project(channel, position) {
  const scales = Array.isArray(channel.scale) ? channel.scale : [channel.scale, channel.scale];
  return channel.axes.map((axis, i) => dot(axis, position) * scales[i]);
}

function textureCoordinates(channel, p) {
  return channel.kind === 'fbm'
    ? [p[0] * 0.04, p[1] * 0.04,
      (0.8 * p[0] + 0.6 * p[1]) * 0.067 + 0.37,
      (-0.6 * p[0] + 0.8 * p[1]) * 0.067 + 0.19]
    : [p[0], p[1], 0, 0];
}

export function oceanDetailOffsets(frame, anchor) {
  if (![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) throw new RangeError('Invalid detail anchor.');
  return frame.channels.map((channel) => textureCoordinates(channel, project(channel, anchor)).map(fract));
}

// CPU oracle for continuous coordinates; shaders deliberately DO NOT fract UVs
// before texture2D, preserving implicit derivatives and mip selection at wraps.
export function oceanDetailCoordinates(frame, index, relative, offsets, drift = [0, 0]) {
  const channel = frame.channels[index];
  const p = project(channel, relative).map((v, i) => v + drift[i]);
  const uv = textureCoordinates(channel, p);
  if (channel.kind === 'fbm') { uv[2] -= 0.37; uv[3] -= 0.19; }
  return uv.map((v, i) => v + offsets[index][i]);
}

const scalar = (n) => Number(n).toPrecision(17);
const vector = (a) => `vec3(${a.map(scalar).join(', ')})`;

// Eight vec4 uniforms (128 bytes), fixed axes/frequencies compiled as literals.
// Drift is in the OLD waterFbm2 input units, after the authored spatial scale.
// The caller owns uDetailTex (RepeatWrapping with mipmaps), the same anchor as
// vOceanRelative, and propagating offsets to every material shader variant.
export function oceanDetailGLSL(frame) {
  return `uniform vec4 uOceanDetailOffsets[${frame.channels.length}];\n` + frame.channels.map((channel, index) => {
    const scales = Array.isArray(channel.scale) ? channel.scale : [channel.scale, channel.scale];
    const projection = `vec2(dot(relativePosition, ${vector(channel.axes[0])}) * ${scalar(scales[0])}, dot(relativePosition, ${vector(channel.axes[1])}) * ${scalar(scales[1])})`;
    if (channel.kind === 'fbm') return `
float ocean${channel.name}(vec3 relativePosition, vec2 drift) {
  vec2 p = ${projection} + drift;
  vec4 offset = uOceanDetailOffsets[${index}];
  float a = texture2D(uDetailTex, p * 0.04 + offset.xy).r;
  float b = texture2D(uDetailTex, mat2(0.8, -0.6, 0.6, 0.8) * p * 0.067 + offset.zw).g;
  return clamp(0.5 + ((a * 0.65 + b * 0.35) - 0.5) * 2.0, 0.0, 1.0);
}`;
    return `
vec2 ocean${channel.name}(vec3 relativePosition, vec2 drift) {
  return ${projection} + drift + uOceanDetailOffsets[${index}].xy;
}`;
  }).join('\n');
}
