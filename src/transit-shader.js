import * as THREE from 'three';

// Camera-space transit pass shared by the pulse and the interstellar warp.
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

    vec2 bendAt(float z) {
      float q = max(z, 0.0) / BEND_LENGTH;
      return uBend * BEND_LENGTH * q * q / (1.0 + q);
    }

    // First wall crossing of a ray from the camera (on the tube axis) with a
    // tube of radius R whose centre line bends by bendAt(z). Coarse geometric
    // search for the first sign change, then bisection: robust for rays that
    // look straight down a bent passage, where a fixed-point solve diverges.
    float tubeField(float s, float a, vec2 pv, float R) {
      return length(s * pv - bendAt(s * a)) - R;
    }
    vec3 tubeHit(vec3 ray, vec3 e1, vec3 e2, float R) {
      float a = dot(ray, uAxis);
      vec2 pv = vec2(dot(ray, e1), dot(ray, e2));
      float sMax = a > 1e-3 ? MAX_DEPTH / a : 4.0 * R / max(length(pv), 1e-3) + 4.0;
      float lo = 0.0, hi = sMax;
      bool found = false;
      float prev = 0.0;
      for (int i = 1; i <= 14; i++) {
        float s = .03 * R * pow(sMax / (.03 * R), float(i) / 14.0);
        if (tubeField(s, a, pv, R) >= 0.0) { lo = prev; hi = s; found = true; break; }
        prev = s;
      }
      float s = sMax;
      if (found) {
        for (int i = 0; i < 12; i++) {
          float mid = .5 * (lo + hi);
          if (tubeField(mid, a, pv, R) >= 0.0) hi = mid; else lo = mid;
        }
        s = hi;
      }
      float z = s * a;
      vec2 local = s * pv - bendAt(z);
      return vec3(s, z, atan(local.y, local.x));
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

      if (uTunnel < .002 && uExit > 1e3) {
        gl_FragColor = vec4(scene, 1.0);
        return;
      }

      // ---- the tunnel
      vec2 ndc = vUv * 2.0 - 1.0;
      vec3 ray = normalize(vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0));
      vec3 up = abs(uAxis.y) < .95 ? vec3(0, 1, 0) : vec3(1, 0, 0);
      vec3 e1 = normalize(cross(uAxis, up));
      vec3 e2 = cross(e1, uAxis);

      vec3 wallHit = tubeHit(ray, e1, e2, 1.0);
      float z = wallHit.y;
      float zc = max(z, 0.0);
      float w = z - uFlow;
      // The passage turns slowly about its own axis; its filaments are wound
      // helically, so perspective draws them as spiral arms - a vortex rather
      // than a bundle of radial speed lines.
      float phi = wallHit.z + uTime * .06;
      vec2 cs = vec2(cos(phi + uTwist * zc * .05), sin(phi + uTwist * zc * .05));
      float phiH = phi + uTwist * zc * .16;
      vec2 csH = vec2(cos(phiH), sin(phiH));

      // Palette: deep indigo near the camera, electric blue mid-tube, and a
      // white core tinted by the destination star - the Doppler gradient of
      // the starflow continued as light. A few filaments run warm.
      float depthT = 1.0 - exp(-zc / 120.0);
      vec3 nearCol = vec3(.04, .06, .24);
      vec3 midCol = vec3(.20, .50, 1.0);
      vec3 coreCol = mix(vec3(.80, .92, 1.0), star, .35);
      vec3 grad = depthT < .4 ? mix(nearCol, midCol, depthT / .4)
        : mix(midCol, coreCol, (depthT - .4) / .6);

      // Luminous plasma clouds carry most of the energy. Every structure is a
      // few radii long, so it is seen approaching and rushing past.
      float plasma = fbm(vec3(cs * 2.2, w * .09));
      float clouds = .025 + 1.5 * pow(plasma, 3.4);
      float filaments = fbm(vec3(csH * 5.0, w * .06 + 3.0));
      float strands = pow(smoothstep(.6, .92, filaments), 2.2);
      float fine = noise3(vec3(csH * 24.0, w * .3 + 9.0));
      float sparks = pow(smoothstep(.8, .98, fine), 5.0);
      float warm = smoothstep(.62, .78, fbm(vec3(cs * 2.6, w * .03 + 40.0)));
      vec3 strandCol = mix(mix(grad, vec3(1.0), .35), vec3(1.0, .62, .32), warm * .75);
      // Gravitational ripples: broken, uneven rings that rush past - they give
      // the passage readable depth segments.
      float ringPhase = fract(w * .022 + .18 * noise3(vec3(cs * 1.6, floor(w * .022) * 3.1)));
      float ripple = exp(-pow((ringPhase - .5) * 11.0, 2.0)) * smoothstep(.25, .7, plasma + .2);
      vec3 wall = grad * clouds * (1.0 + ripple * 1.4)
        + strandCol * strands * (.75 + ripple)
        + mix(grad, vec3(1.0), .6) * sparks * .6;
      wall *= mix(.55, 1.5, depthT);
      // the far wall dissolves into the exit light
      float far = 1.0 - exp(-zc / 420.0);
      vec3 endColor = mix(coreCol, hot, .55);
      wall = mix(wall, endColor * (.3 + 1.1 * uEndGlow), far * far);

      // translucent inner veil: a parallax layer that sells depth and speed
      vec3 veilHit = tubeHit(ray, e1, e2, .55);
      float vz = veilHit.y;
      float vphi = veilHit.z + uTwist * max(vz, 0.0) * .09 - uTime * .09;
      float veil = fbm(vec3(cos(vphi) * 2.6, sin(vphi) * 2.6, (vz - uFlow * 1.2) * .06 + 11.0));
      float veilA = smoothstep(.6, .88, veil) * .30 * (1.0 - smoothstep(30.0, 260.0, vz)) * step(0.0, vz);
      float veilDepth = 1.0 - exp(-max(vz, 0.0) / 120.0);
      vec3 veilCol = mix(midCol, coreCol, veilDepth) * (.3 + 1.1 * veil);

      // debris streaks: the starflow continues inside the tube
      vec3 dustHit = tubeHit(ray, e1, e2, .8);
      float dz = dustHit.y;
      vec2 cell = vec2((dustHit.z / TAU + .5) * 180.0, (dz - uFlow * 1.1) * .22);
      vec2 id = floor(cell), f = fract(cell);
      float on = step(.965, hash12(id));
      float across = abs(f.x - .5);
      float dust = on * exp(-across * across * 300.0) * smoothstep(0.0, .25, f.y) * (1.0 - smoothstep(.45, .9, f.y))
        * (1.0 - smoothstep(20.0, 160.0, dz)) * step(0.0, dz);
      vec3 dustColor = mix(midCol, vec3(1.0), .55) * dust * .8;

      // Mouth and exit are depth planes in the tube: the mouth sweeps outward
      // from the vanishing point as the ship enters, the exit opens from it.
      float mouthSoft = max(2.0, uMouth * .6);
      float zIn = smoothstep(uMouth - mouthSoft, uMouth, z);
      float exitSoft = max(.8, uExit * .25);
      float zOut = 1.0 - smoothstep(uExit - exitSoft, uExit, z);
      float density = smoothstep(.15, 1.0, uTunnel);
      float wallA = density * zIn * zOut;
      float dustA = smoothstep(.0, .4, uTunnel) * smoothstep(uMouth - mouthSoft, uMouth, dz)
        * (1.0 - smoothstep(uExit - exitSoft, uExit, dz));

      vec3 tunnel = mix(wall, veilCol, veilA);
      vec3 col = mix(scene, tunnel, wallA);
      col += dustColor * dustA;

      // a thin incandescent lip where the exit opens, and the end light
      float rimW = .5 + uExit * .04;
      float rim = exp(-pow((z - uExit) / rimW, 2.0)) * step(uExit, 1e3) * density;
      col += endColor * rim * uEndGlow * .7;
      float farZ = 900.0;
      vec2 fc = bendAt(farZ);
      vec3 endDir = normalize(uAxis * farZ + e1 * fc.x + e2 * fc.y);
      float ang = acos(clamp(dot(ray, endDir), -1.0, 1.0));
      float endLight = (exp(-ang * ang * 3200.0) * 2.4 + exp(-ang * 16.0) * .25) * uEndGlow;
      col += endColor * endLight * wallA;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
