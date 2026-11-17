// Ground rain-wetness and expanding concentric rain-drop ripple shader patch,
// ported from Saltline (`TR / AR / RR` in statement #637, see docs/saltline-reuse.md).
//
// Zero RNG mutation: all puddle masks and rain-ring ripples are pure analytical
// hashes evaluated in local/tangent coordinates. Works on both standard +Y-up
// MeshStandardMaterials and Deep Space's spherical planet terrain shaders.

export const RAIN_WET_UNIFORMS = {
  uRainWet: { value: 0 },
  uRainTime: { value: 0 },
};

export function createRainWetUniforms({ wet = 0, time = 0 } = {}) {
  return {
    uRainWet: { value: wet },
    uRainTime: { value: time },
  };
}

export const RAIN_RIPPLE_GLSL = /* glsl */`
vec3 rainHash3(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

float rainHash1(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float rainValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(rainHash1(i), rainHash1(i + vec2(1.0, 0.0)), f.x),
    mix(rainHash1(i + vec2(0.0, 1.0)), rainHash1(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// One sparse layer of rain rings (ported from Saltline): every cell gets a new
// drop (position, size, strength) each cycle, with a thin soft crest that
// fades as it expands. Returns a tangent-plane (x, y) slope contribution.
vec2 rainRippleLayer(vec2 p, float t, float cell, float seed, float rainAmount) {
  vec2 q = p / cell + seed * 17.3;
  vec2 id = floor(q);
  vec2 f = fract(q);
  vec3 h0 = rainHash3(id + seed);
  float tt = t * (0.5 + 0.55 * h0.x) + h0.y * 9.0;
  float cyc = floor(tt);
  float life = fract(tt);
  vec3 h = rainHash3(id + seed + cyc * 7.31);
  vec3 hc = rainHash3(id.yx + cyc * 3.71 + seed * 5.0);
  float on = step(h.z, 0.16 + 0.5 * clamp(rainAmount, 0.0, 1.0));
  float rmax = mix(0.1, 0.36, h.x * h.x);
  vec2 c = mix(vec2(rmax + 0.05), vec2(0.95 - rmax), hc.xy);
  vec2 dv = (f - c) * cell;
  float d = length(dv);
  float r = life * rmax * cell;
  float w = 0.005 + 0.02 * life;
  float x = (d - r) / w;
  float ring = x * exp(-x * x) * 2.3;
  float amp = 1.0 - life;
  amp = amp * amp * on * mix(0.3, 1.0, h.y) * smoothstep(0.0, 0.06, life);
  return (dv / max(d, 1e-4)) * ring * amp;
}

vec2 rainRippleSlope(vec2 uv, float time, float strength) {
  float s = clamp(strength, 0.0, 1.0);
  if (s <= 0.001) return vec2(0.0);
  vec2 gp2 = vec2(0.8 * uv.x - 0.6 * uv.y, 0.6 * uv.x + 0.8 * uv.y);
  vec2 r1 = rainRippleLayer(uv, time, 0.83, 1.0, s);
  vec2 r2 = rainRippleLayer(gp2, time * 0.87, 1.31, 2.0, s);
  vec2 r3 = rainRippleLayer(uv.yx, time * 1.13, 0.57, 3.0, s).yx;
  vec2 rip = r1 + vec2(0.8 * r2.x + 0.6 * r2.y, -0.6 * r2.x + 0.8 * r2.y) * 0.9 + r3 * 0.6;
  return rip * (0.3 + 0.7 * s) * 0.3;
}
`;

export function patchShaderWithRainWetness(shader, uniforms = RAIN_WET_UNIFORMS) {
  if (!shader || typeof shader.vertexShader !== 'string' || typeof shader.fragmentShader !== 'string') {
    throw new TypeError('patchShaderWithRainWetness expects a Three.js onBeforeCompile shader object');
  }
  shader.uniforms = shader.uniforms || {};
  shader.uniforms.uRainWet = uniforms?.uRainWet || RAIN_WET_UNIFORMS.uRainWet;
  shader.uniforms.uRainTime = uniforms?.uRainTime || RAIN_WET_UNIFORMS.uRainTime;
  if (uniforms?.uRainUp) shader.uniforms.uRainUp = uniforms.uRainUp;
  if (uniforms?.uRainOffset) shader.uniforms.uRainOffset = uniforms.uRainOffset;

  // Idempotency guard if called more than once on the same shader instance.
  if (shader.fragmentShader.includes('rainRippleSlope')) {
    return shader;
  }

  const hasPlanetLocal = /varying\s+vec3\s+vLocalPos\b/.test(shader.fragmentShader);
  const hasPlanetLocalNrm = /varying\s+vec3\s+vLocalNrm\b/.test(shader.fragmentShader);
  const hasRadialView = /varying\s+vec3\s+vRadialView\b/.test(shader.fragmentShader);
  const hasTerrainDetailPos = /\bterrainDetailPosition\s*\(/.test(shader.fragmentShader);
  const hasRainUpUniform = Boolean(uniforms?.uRainUp);
  const hasRainOffsetUniform = Boolean(uniforms?.uRainOffset);

  const vertPars = hasPlanetLocal ? '' : /* glsl */`
varying vec3 vSlRainWorldPos;
`;
  const vertMain = hasPlanetLocal ? '' : /* glsl */`
  {
    vec4 slRainWp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      slRainWp = instanceMatrix * slRainWp;
    #endif
    vSlRainWorldPos = (modelMatrix * slRainWp).xyz;
  }
`;

  if (!hasPlanetLocal) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertPars}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${vertMain}`);
  }

  const extraUniformDecls = [
    hasRainUpUniform ? 'uniform vec3 uRainUp;' : '',
    hasRainOffsetUniform ? 'uniform vec3 uRainOffset;' : '',
  ].filter(Boolean).join('\n');

  const upExpr = hasPlanetLocal
    ? 'slRainUp = normalize(vLocalPos);'
    : (hasRainUpUniform ? 'slRainUp = normalize(uRainUp);' : 'slRainUp = vec3(0.0, 1.0, 0.0);');

  const upDotExpr = (hasPlanetLocal && hasPlanetLocalNrm)
    ? 'float slUpDot = clamp(dot(normalize(vLocalNrm), slRainUp), 0.0, 1.0);'
    : 'vec3 slRainWN = inverseTransformDirection(slRainVN, viewMatrix);\n    float slUpDot = clamp(dot(slRainWN, slRainUp), 0.0, 1.0);';

  const coordExpr = hasTerrainDetailPos
    ? 'terrainDetailPosition()'
    : (hasPlanetLocal
      ? 'vLocalPos'
      : (hasRainOffsetUniform ? '(vSlRainWorldPos + uRainOffset)' : 'vSlRainWorldPos'));

  const viewBasisExpr = hasPlanetLocal
    ? `${hasRadialView ? 'vec3 slViewUp = normalize(vRadialView);' : 'vec3 slViewUp = normalize((modelViewMatrix * vec4(slRainUp, 0.0)).xyz);'}
    vec3 slViewT = normalize((modelViewMatrix * vec4(slRainTang, 0.0)).xyz);
    vec3 slViewB = normalize((modelViewMatrix * vec4(slRainBitn, 0.0)).xyz);`
    : `vec3 slViewUp = normalize((viewMatrix * vec4(slRainUp, 0.0)).xyz);
    vec3 slViewT = normalize((viewMatrix * vec4(slRainTang, 0.0)).xyz);
    vec3 slViewB = normalize((viewMatrix * vec4(slRainBitn, 0.0)).xyz);`;

  const fragPars = /* glsl */`
uniform float uRainWet;
uniform float uRainTime;
${extraUniformDecls}
${hasPlanetLocal ? '' : 'varying vec3 vSlRainWorldPos;'}
float slRainWet = 0.0;
float slRainPuddle = 0.0;
float slRainDist = 0.0;
vec2 slRainUv = vec2(0.0);
vec3 slRainUp = vec3(0.0, 1.0, 0.0);
vec3 slRainTang = vec3(1.0, 0.0, 0.0);
vec3 slRainBitn = vec3(0.0, 0.0, 1.0);
${RAIN_RIPPLE_GLSL}
`;

  const fragColorPatch = /* glsl */`
  if (uRainWet > 0.001) {
    #ifdef FLAT_SHADED
      vec3 slRainVN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    #else
      vec3 slRainVN = normalize(vNormal);
      #ifdef DOUBLE_SIDED
        slRainVN *= gl_FrontFacing ? 1.0 : -1.0;
      #endif
    #endif
    ${upExpr}
    ${upDotExpr}
    slRainTang = normalize(abs(slRainUp.y) > 0.9
      ? cross(slRainUp, vec3(1.0, 0.0, 0.0))
      : cross(vec3(0.0, 1.0, 0.0), slRainUp));
    slRainBitn = cross(slRainUp, slRainTang);
    vec3 slRainCoord = ${coordExpr};
    slRainUv = vec2(dot(slRainCoord, slRainTang), dot(slRainCoord, slRainBitn));
    slRainDist = length(vViewPosition);
    float slFlat = smoothstep(0.76, 0.96, slUpDot);
    float slN1 = rainValueNoise(slRainUv * 0.14 + 3.1);
    float slN2 = rainValueNoise(slRainUv * 0.53 + 17.7);
    float slN3 = rainValueNoise(slRainUv * 2.1 + 9.3);
    float slField = slN1 * 0.52 + slN2 * 0.31 + slN3 * 0.17;
    float wet = clamp(uRainWet * mix(0.42, 1.0, smoothstep(0.1, 0.85, slUpDot)) * (0.82 + 0.36 * slN1), 0.0, 1.0);
    float slDepth = slField - (0.64 - 0.24 * clamp(uRainWet, 0.0, 1.0));
    float puddle = smoothstep(0.0, 0.08, slDepth) * slFlat * smoothstep(0.08, 0.65, uRainWet);
    slRainWet = wet;
    slRainPuddle = puddle;
    float slLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(vec3(slLum), diffuseColor.rgb, 1.0 + 0.16 * wet);
    diffuseColor.rgb *= mix(1.0, 0.58, wet);
    diffuseColor.rgb *= mix(1.0, 0.82, puddle);
  }
`;

  const fragRoughnessPatch = /* glsl */`
  if (uRainWet > 0.001) {
    float puddle = slRainPuddle;
    roughnessFactor = mix(roughnessFactor, min(roughnessFactor, 0.38), slRainWet * 0.65);
    roughnessFactor = mix(roughnessFactor, 0.08, puddle);
  }
`;

  const fragNormalPatch = /* glsl */`
  if (uRainWet > 0.001 && slRainPuddle > 0.002) {
    ${viewBasisExpr}
    normal = normalize(mix(normal, slViewUp, slRainPuddle * 0.88));
    float slRipFade = 1.0 - smoothstep(10.0, 34.0, slRainDist);
    if (slRipFade > 0.001) {
      vec2 slRip = rainRippleSlope(slRainUv, uRainTime, uRainWet) * (slRipFade * slRainPuddle);
      normal = normalize(normal - slViewT * slRip.x - slViewB * slRip.y);
    }
  }
`;

  let frag = shader.fragmentShader.replace('#include <common>', `#include <common>\n${fragPars}`);

  if (frag.includes('#include <alphamap_fragment>')) {
    frag = frag.replace('#include <alphamap_fragment>', `${fragColorPatch}\n#include <alphamap_fragment>`);
  } else if (frag.includes('#include <color_fragment>')) {
    frag = frag.replace('#include <color_fragment>', `#include <color_fragment>\n${fragColorPatch}`);
  } else {
    frag = frag.replace('#include <map_fragment>', `#include <map_fragment>\n${fragColorPatch}`);
  }

  if (frag.includes('#include <metalnessmap_fragment>')) {
    frag = frag.replace('#include <metalnessmap_fragment>', `${fragRoughnessPatch}\n#include <metalnessmap_fragment>`);
  } else {
    frag = frag.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${fragRoughnessPatch}`);
  }

  if (frag.includes('#include <normal_fragment_maps>')) {
    frag = frag.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragNormalPatch}`);
  } else {
    frag = frag.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${fragNormalPatch}`);
  }

  shader.fragmentShader = frag;
  return shader;
}
