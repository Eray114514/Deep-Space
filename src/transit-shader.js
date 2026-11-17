import * as THREE from 'three';

// Camera-space lens pass shared by the pulse, the warp and the wormhole
// throat. The tunnel itself is 3D geometry (warp-conduit.js).
// It runs on the lit scene before the foreground ship pass, so the hull is
// never covered and is instead lit by the transit (see main.js hull light).
//
//   - radial motion blur of the real scene toward the vanishing point
//   - pulse: space pinched into the vanishing point, then a refractive ring
//   - warp: a long, gently curving tunnel solved per pixel as a ray/tube
//     intersection. Its mouth sweeps outward from the centre on entry and its
//     exit opens from the centre on arrival, because both are depth planes in
//     the tube: nothing ever cross-fades between unrelated layers.
export const TransitShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uTanHalfFov: { value: Math.tan(Math.PI / 6) },
    uAxis: { value: new THREE.Vector3(0, 0, -1) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uBlur: { value: 0 },
    uFold: { value: 0 },
    uShockR: { value: 0 },
    uShockAmp: { value: 0 },
    uFlash: { value: 0 },
    uTunnel: { value: 0 },
    uMouth: { value: 1e4 },
    uExit: { value: 1e4 },
    uFlow: { value: 0 },
    uEndGlow: { value: 0 },
    uBend: { value: new THREE.Vector2(0, 0) },
    uTwist: { value: 0 },
    uColorA: { value: new THREE.Color(1, 0.92, 0.82) },
    uColorB: { value: new THREE.Color(0.75, 0.85, 1) },
    uColorMix: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform float uTanHalfFov;
    uniform vec3 uAxis;
    uniform vec2 uCenter;
    uniform float uBlur;
    uniform float uFold;
    uniform float uShockR;
    uniform float uShockAmp;
    uniform float uFlash;
    uniform float uTunnel;
    uniform float uMouth;
    uniform float uExit;
    uniform float uFlow;
    uniform float uEndGlow;
    uniform vec2 uBend;
    uniform float uTwist;
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform float uColorMix;
    varying vec2 vUv;

    const float TAU = 6.28318530718;
    const float BEND_LENGTH = 22.0;
    const float MAX_DEPTH = 3000.0;

    float hash13(vec3 p) {
      p = fract(p * .1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }
    float hash12(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * .1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }
    float noise3(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
      float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
      float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
      float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
      return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
        mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float v = 0.0, a = .5;
      for (int i = 0; i < 4; i++) {
        v += a * noise3(p);
        p = p * 2.03 + vec3(1.7, 9.2, 4.1);
        a *= .5;
      }
      return v / .9375;
    }

    vec3 sceneSample(vec2 uv) { return texture2D(tDiffuse, clamp(uv, vec2(.001), vec2(.999))).rgb; }

    void main() {
      vec2 p = (vUv - uCenter) * vec2(uAspect, 1.0);
      float r = length(p);
      vec2 dir = p / max(r, 1e-4);

      // ---- space distortion: fold (pinch into the vanishing point) + shock ring
      // Strongest around the vanishing point and zero at the frame edge, so the
      // pinch never samples (and smears) pixels from outside the image.
      float fold = uFold * .30 * exp(-r * r * 7.0) * smoothstep(.0, .06, r);
      float g = (r - uShockR) / .065;
      float edgeGuard = smoothstep(.0, .05, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
      float ring = uShockAmp * .032 * g * exp(-g * g) * edgeGuard;
      vec2 baseUv = uCenter + (vUv - uCenter) * (1.0 + fold) + dir * ring / vec2(uAspect, 1.0);
      // Lens-like dispersion stays a hint: strongest on the refractive ring.
      float chroma = abs(ring) * .22 + uFold * .0016 * r + uBlur * .0018 * r;
      vec2 cd = dir / vec2(uAspect, 1.0) * chroma;

      // ---- radial motion blur of the lit scene
      vec3 scene;
      if (uBlur > .002) {
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        float reach = uBlur * .11 * smoothstep(.015, .55, r);
        for (int i = 0; i < 12; i++) {
          float k = float(i) / 11.0;
          vec2 uv = uCenter + (baseUv - uCenter) * (1.0 - reach * k);
          float w = 1.0 - k * .55;
          acc += vec3(sceneSample(uv + cd).r, sceneSample(uv).g, sceneSample(uv - cd).b) * w;
          wsum += w;
        }
        scene = acc / wsum;
      } else {
        scene = vec3(sceneSample(baseUv + cd).r, sceneSample(baseUv).g, sceneSample(baseUv - cd).b);
      }
      vec3 hot = vec3(1.0, .98, .95);
      vec3 star = mix(uColorA, uColorB, uColorMix);
      scene *= 1.0 + uFlash * 1.4 * exp(-r * r * 5.0);
      scene += mix(star, hot, .5) * uFlash * .35 * exp(-r * r * 40.0);
      scene += vec3(.35, .55, 1.0) * ring * ring * 30.0 * uShockAmp;

      gl_FragColor = vec4(scene, 1.0);
    }
  `,
};
