import * as THREE from 'three';

export const RiftDistortionShader = {
  uniforms: {
    tDiffuse: { value: null },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uRadius: { value: new THREE.Vector2(0.15, 0.15) },
    uOpen: { value: 0 },
    uTime: { value: 0 },
    uStrength: { value: 1 },
    uTension: { value: 0 },
    uBurst: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uCenter;
    uniform vec2 uRadius;
    uniform float uOpen;
    uniform float uTime;
    uniform float uStrength;
    uniform float uTension;
    uniform float uBurst;
    varying vec2 vUv;
    float boundary(float a) {
      return 1.0
        + .100 * sin(a * 3.0 + .72)
        + .052 * sin(a * 5.0 - 1.18)
        + .030 * sin(a * 11.0 + 2.16)
        + .020 * sin(a * 17.0 - .45)
        + .030 * pow(max(0.0, sin(a * 7.0 + 1.7)), 8.0)
        + uOpen * (
          .030 * sin(a * 4.0 - uTime * .72 + .8)
          + .018 * sin(a * 9.0 + uTime * 1.18 - 1.6)
          + .010 * sin(a * 23.0 - uTime * 2.05)
          + .006 * sin(a * 47.0 + uTime * 3.4)
        );
    }
    void main() {
      vec2 safeR = max(uRadius, vec2(.0001));
      vec2 q = (vUv - uCenter) / safeR;
      float a = atan(q.y, q.x);
      float d = length(q);
      float b = boundary(a);
      float band = exp(-pow((d - b) / .082, 2.0));
      float outer = exp(-pow((d - b) / .21, 2.0));
      float tear = exp(-pow((d - b) / .030, 2.0));
      vec2 dir = normalize(q + vec2(1e-5));
      float pulse = .72 + .28 * sin(uTime * 2.1 + a * 9.0);
      float strainPulse = .82 + .18 * sin(uTime * 10.5 + a * 17.0);
      float fold = uOpen + uTension * .72 + uBurst * .32;
      vec2 pull = -dir * safeR * (.050 * band + .012 * outer) * fold * uStrength * pulse;
      pull += -dir * safeR * (.024 * outer + .018 * band) * uTension * strainPulse;
      vec2 tangent = vec2(-dir.y, dir.x);
      pull += tangent * safeR * (.010 * band * sin(a * 13.0 - uTime * 1.7)) * fold;
      pull += tangent * safeR * (.014 * outer * sin(a * 23.0 + uTime * 6.0)) * uTension;
      pull += tangent * safeR * .018 * tear * sin(a * 41.0 - uTime * 4.2) * uOpen;
      vec2 uv = vUv + pull;
      float split = (.0007 + .0032 * band + .0065 * tear) * fold * uStrength
        + uBurst * band * .0065;
      float r = texture2D(tDiffuse, uv + dir * split).r;
      float g = texture2D(tDiffuse, uv).g;
      float bcol = texture2D(tDiffuse, uv - dir * split).b;
      vec3 col = vec3(r, g, bcol);
      col += vec3(.02, .05, .09) * band * uOpen;
      col += vec3(.12, .34, .92) * tear * uOpen * (.48 + .32 * sin(a * 29.0 - uTime * 3.1));
      col += vec3(.08, .20, .48) * band * uTension * .55;
      col += vec3(.55, .30, .82) * band * uBurst * .28;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
