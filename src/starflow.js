// Starflow: the real catalogue and backdrop stars, drawn as capsules that can
// stretch along the direction of travel. At rest every capsule degenerates to
// the exact round point the old THREE.Points sprites drew. During a pulse or a
// warp the head of each capsule is the star's relativistically aberrated
// direction and the tail is the same star at a higher β, so stars gather
// toward the vanishing point and streak outward from it - the sky itself
// becomes the jump-to-lightspeed effect, not a screen overlay of lines.

import * as THREE from 'three';

// One set of uniform objects shared by every starflow material, so the game
// loop sets transit state once per frame.
export const starflowUniforms = {
  uFlowAxis: { value: new THREE.Vector3(0, 0, -1) }, // view-space travel direction
  uStreak: { value: 0 },
  uAberr: { value: 0 },
  uDoppler: { value: 0 },
  uViewport: { value: new THREE.Vector2(1920, 1080) }, // drawing-buffer pixels
};

export function setStarflowViewport(width, height) {
  starflowUniforms.uViewport.value.set(Math.max(1, width), Math.max(1, height));
}

// Converts a point cloud's attributes into an instanced capsule geometry.
// `attributes` maps the source attribute names to instanced copies.
export function buildStarflowGeometry(positions, attributes) {
  const geometry = new THREE.InstancedBufferGeometry();
  // corner.x: 0 tail .. 1 head, corner.y: -1 .. 1 across
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aStar', new THREE.InstancedBufferAttribute(positions, 3));
  for (const [name, { array, itemSize }] of Object.entries(attributes)) {
    geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, itemSize));
  }
  geometry.instanceCount = positions.length / 3;
  return geometry;
}

// Shared vertex-shader core. `starSize` (pixels) and `starView` (view-space
// position) must be declared by the caller before `starflowVertex()`.
const STARFLOW_VERTEX_CORE = /* glsl */`
  uniform vec3 uFlowAxis;
  uniform float uStreak;
  uniform float uAberr;
  uniform float uDoppler;
  uniform vec2 uViewport;
  varying vec2 vSeg;      // x: pixels along from the tail (caps included), y: across
  varying float vLen;     // capsule core length in pixels
  varying float vHalf;    // capsule radius in pixels
  varying float vEnergy;  // brightness compensation for streaked light
  varying float vShift;   // -1 red .. +1 blue

  float starHash(vec3 p) {
    p = fract(p * vec3(.1031, .1030, .0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  // Relativistic aberration of a unit view direction for speed b along the axis.
  vec3 aberrate(vec3 d, float b) {
    float c = dot(d, uFlowAxis);
    vec3 perp = d - c * uFlowAxis;
    float pl = length(perp);
    if (pl < 1e-6) return d;
    float c2 = clamp((c + b) / (1.0 + b * c), -1.0, 1.0);
    return uFlowAxis * c2 + perp / pl * sqrt(max(0.0, 1.0 - c2 * c2));
  }

  void starflowVertex(vec3 starView, float starSize, vec3 seed) {
    float dist = length(starView);
    vec3 d = starView / max(dist, 1e-6);
    float rnd = starHash(seed);
    float beta = clamp(uAberr, -0.6, 0.94);
    float tailBeta = clamp(beta + uStreak * mix(0.30, 0.95, rnd) * 0.9, -0.6, 0.985);
    vec3 head = aberrate(d, beta);
    vec3 tail = aberrate(d, tailBeta);
    float range = dist;
    vec4 headClip = projectionMatrix * vec4(head * range, 1.0);
    vec4 tailClip = projectionMatrix * vec4(tail * range, 1.0);
    vShift = dot(d, uFlowAxis) * uDoppler;
    if (headClip.w <= 1e-4) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vSeg = vec2(0.0); vLen = 0.0; vHalf = 1.0; vEnergy = 0.0;
      return;
    }
    if (tailClip.w <= 1e-4) tailClip = headClip;
    vec2 halfVp = 0.5 * uViewport;
    vec2 hp = headClip.xy / headClip.w * halfVp;
    vec2 tp = tailClip.xy / tailClip.w * halfVp;
    vec2 axis = hp - tp;
    float len = length(axis);
    // Cap absurd lengths from stars sweeping across the frame edge.
    len = min(len, max(uViewport.x, uViewport.y) * 0.75);
    vec2 u = len > 1e-3 ? axis / max(length(axis), 1e-3) : vec2(1.0, 0.0);
    tp = hp - u * len;
    vec2 n = vec2(-u.y, u.x);
    float h = max(starSize * 0.5, 0.5);
    float along = position.x * (len + 2.0 * h) - h;
    vec2 pixel = tp + u * along + n * position.y * h;
    gl_Position = vec4(pixel / halfVp * headClip.w, headClip.z, headClip.w);
    vSeg = vec2(along, position.y * h);
    vLen = len;
    vHalf = h;
    // A streak spreads the same light over a longer path; keep it readable
    // without letting long trails turn into flat bars.
    vEnergy = inversesqrt(1.0 + len / (2.0 * h)) * (1.0 + 0.6 * uStreak);
  }
`;

const STARFLOW_FRAGMENT_CORE = /* glsl */`
  varying vec2 vSeg;
  varying float vLen;
  varying float vHalf;
  varying float vEnergy;
  varying float vShift;

  // Same profile as the former round point sprite, swept along the segment.
  float starflowRadius() {
    float dx = max(0.0, max(-vSeg.x, vSeg.x - vLen));
    return length(vec2(dx, vSeg.y)) / vHalf;
  }

  vec3 starflowShift(vec3 color) {
    vec3 blue = color * vec3(0.72, 0.92, 1.38) + vec3(0.02, 0.05, 0.12);
    vec3 red = color * vec3(1.25, 0.78, 0.55);
    return vShift >= 0.0 ? mix(color, blue, clamp(vShift, 0.0, 1.0))
      : mix(color, red, clamp(-vShift, 0.0, 1.0));
  }
`;

// Catalogue stars: apparent size and brightness fall off with true distance.
export function makeStarflowStarMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...starflowUniforms,
      uDim: { value: 0 },
      uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2) },
      uProj: { value: 600 },
    },
    vertexShader: /* glsl */`
      uniform float uPixelRatio;
      uniform float uProj;
      attribute vec3 aStar;
      attribute vec3 aColor;
      attribute float aSize;
      varying vec3 vColor;
      varying float vBright;
      ${STARFLOW_VERTEX_CORE}
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(aStar, 1.0);
        float dist = length(mv.xyz);
        float discPx = 1.2e7 * aSize * uProj / max(dist, 1.0);
        float size = clamp(max(1.8 + aSize * 0.55, discPx), 1.8, 28.0) * uPixelRatio;
        vBright = clamp(2.2e10 / max(dist, 1.0), 0.42, 1.0)
          * (1.0 - smoothstep(7.5e10, 9.2e10, dist));
        starflowVertex(mv.xyz, size, aStar * 1e-9);
      }`,
    fragmentShader: /* glsl */`
      uniform float uDim;
      varying vec3 vColor;
      varying float vBright;
      ${STARFLOW_FRAGMENT_CORE}
      void main() {
        float r = starflowRadius();
        if (r >= 1.0) discard;
        float a = smoothstep(1.0, 0.15, r);
        vec3 c = starflowShift(vColor) * (1.0 + 0.5 * (1.0 - r));
        gl_FragColor = vec4(c, 1.0) * a * vBright * vEnergy * (1.0 - uDim * 0.97);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// Galactic backdrop: fixed pixel sizes and per-star alpha.
export function makeStarflowBackdropMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...starflowUniforms,
      uDim: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aStar;
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      ${STARFLOW_VERTEX_CORE}
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(aStar, 1.0);
        starflowVertex(mv.xyz, aSize, aStar * 3.7e-8);
      }`,
    fragmentShader: /* glsl */`
      uniform float uDim;
      varying vec3 vColor;
      varying float vAlpha;
      ${STARFLOW_FRAGMENT_CORE}
      void main() {
        float r = starflowRadius();
        if (r >= 1.0) discard;
        float a = smoothstep(1.0, 0.1, r);
        gl_FragColor = vec4(starflowShift(vColor) * 0.78,
          a * vAlpha * pow(vEnergy, 1.8) * (1.0 - uDim * 0.985));
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
