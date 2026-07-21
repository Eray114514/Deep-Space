import * as THREE from 'three';

export const WarpDriveShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uWarp: { value: 0 },
    uPulse: { value: 0 },
    uArrival: { value: 0 },
    uAspect: { value: 1 },
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
    uniform float uWarp;
    uniform float uPulse;
    uniform float uArrival;
    uniform float uAspect;
    varying vec2 vUv;

    const float TAU = 6.28318530718;

    float hash11(float p) {
      p = fract(p * .1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    float hash21(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float noise21(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
    }

    float flowNoise(vec2 p) {
      return noise21(p) * .57 + noise21(p * 2.07 + 7.3) * .29
        + noise21(p * 4.13 - 3.7) * .14;
    }

    vec3 spectrum(float h) {
      vec3 rainbow = .56 + .44 * cos(TAU * (h + vec3(0.00, .69, .37)));
      vec3 ion = mix(vec3(.18, .80, 1.35), vec3(1.25, .26, 1.10), step(.56, h));
      return mix(ion, rainbow * 1.25, .68);
    }

    vec3 rayLayer(vec2 p, float bins, float radialScale, float speed, float seed) {
      float radius = length(p);
      float angle = atan(p.y, p.x);
      float bend = sin(radius * mix(5.0, 9.0, seed) - uTime * .22 + seed * 17.0)
        * mix(.0012, .0042, smoothstep(.08, .8, radius));
      float wedge = (angle / TAU + .5 + bend) * bins;
      float id = floor(wedge);
      float rnd = hash11(id + seed * 71.7);
      float fine = hash11(id * 5.31 + seed * 19.1);
      float width = mix(.012, .044, rnd * rnd) * mix(.68, 1.1, smoothstep(.04, .76, radius));
      float across = abs(fract(wedge) - .5);
      float core = exp(-pow(across / max(width, .001), 2.0) * 2.4);
      float glow = exp(-pow(across / max(width * 3.2, .001), 2.0) * 1.35);
      float phase = fract(radius * radialScale - uTime * speed * mix(.72, 1.4, rnd) + fine);
      float segment = smoothstep(.025, .13, phase) * (1.0 - smoothstep(.58, .96, phase));
      float taper = mix(.42, 1.0, smoothstep(.04, .42, phase));
      float gate = step(.43, fine) * smoothstep(.018, .105, radius);
      float flare = mix(.32, 1.34, smoothstep(.055, .92, radius));
      vec3 cool = mix(vec3(.24, .72, 1.12), vec3(.74, .94, 1.08), rnd);
      float accentAmount = smoothstep(.58, .92, hash11(id * 2.73 + seed * 31.0));
      vec3 tint = mix(cool, spectrum(fract(rnd * .74 + seed * .29)), accentAmount * .72);
      vec3 hotCore = mix(tint, vec3(1.12, 1.16, 1.18), .46);
      return (tint * glow * .19 + hotCore * core * taper) * segment * gate * flare;
    }

    void main() {
      float strength = clamp(max(uWarp, uPulse), 0.0, 1.0);
      vec2 p = vUv - .5;
      p.x *= uAspect;
      float radius = length(p);
      vec2 direction = p / max(radius, .0001);
      float stretch = strength * (.0015 + uWarp * .0065 + uPulse * .0035)
        * smoothstep(.035, .82, radius);
      vec2 shift = vec2(direction.x / uAspect, direction.y) * stretch;
      vec2 uvR = clamp(vUv - shift * .72, vec2(.001), vec2(.999));
      vec2 uvG = clamp(vUv - shift * .24, vec2(.001), vec2(.999));
      vec2 uvB = clamp(vUv + shift * .2, vec2(.001), vec2(.999));
      vec3 original = texture2D(tDiffuse, vUv).rgb;
      vec3 dispersed = vec3(
        texture2D(tDiffuse, uvR).r,
        texture2D(tDiffuse, uvG).g,
        texture2D(tDiffuse, uvB).b
      );
      vec3 scene = mix(original, dispersed, strength * (.14 + uWarp * .12));

      float rayStrength = strength * mix(.62, 1.0, strength) * smoothstep(.025, .14, radius);
      vec3 rays = rayLayer(p, 61.0, 1.38, .86 + uPulse * 1.18, .13);
      rays += rayLayer(p * 1.07, 97.0, 2.17, 1.33 + uPulse * 1.42, .47) * .68;
      rays += rayLayer(p * .94, 139.0, 3.28, 1.82 + uPulse * 1.68, .81) * .34;
      float coreFade = smoothstep(.012, .082, radius);
      float edgeFade = 1.0 - smoothstep(.78, 1.02, radius);
      rays *= rayStrength * coreFade * edgeFade * (1.0 + uWarp * .22);

      float tunnel = smoothstep(.08, .92, radius) * (1.0 - smoothstep(.88, 1.14, radius));
      float turbulence = flowNoise(p * 3.7 + direction * (uTime * .075));
      vec3 haze = mix(vec3(.012, .036, .075), vec3(.025, .115, .21), turbulence)
        * (.12 + tunnel * .88) * strength * (uWarp * .64 + uPulse * .22);
      vec3 arrival = vec3(.06, .19, .42) * exp(-radius * radius * 14.0) * uArrival * .52;
      float centerFlash = exp(-radius * radius * 110.0) * uArrival;
      arrival += vec3(.68, .84, 1.04) * centerFlash * .68;

      gl_FragColor = vec4(scene * (1.0 - strength * .028) + haze + rays + arrival, 1.0);
    }
  `,
};


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


